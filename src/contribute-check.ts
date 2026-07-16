import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { log } from './utils/logger.js';
import { readJson, writeJson, ensureDir } from './utils/fs.js';
import { readEvents } from './dashboard-collector.js';
import { readRecallQuality } from './recall-quality.js';
import { deriveSessionId } from './utils/session-id.js';
import type { ContributeState, DashboardEvent } from './types.js';
import {
  CONTRIBUTE_SMART_THRESHOLD,
  CONTRIBUTE_BASE_THRESHOLD,
  CONTRIBUTE_FASTPATH_TTL_MS,
  CONTRIBUTE_KNOWLEDGE_GAP_BONUS,
  CONTRIBUTE_LOW_QUALITY_BONUS,
  CONTRIBUTE_LOW_QUALITY_THRESHOLD,
  CONTRIBUTE_GIT_COMMIT_DOWNWEIGHT,
} from './types.js';

// ─── Contribute check data flow (Stop hook) ────────────────
//
//  Stop hook (session end)
//      │
//      ▼
//  teamai contribute-check --stdin --tool <name>
//      │
//      ▼
//  contributeCheckForSession(sessionId)
//      │
//      ├─ readState(sessionId)
//      │
//      ├─ short-circuits (no I/O):
//      │   ├─ state.contributed → exit(no hint)
//      │   └─ state.hinted      → exit(no hint, dedup)
//      │
//      ├─ Layer 1 fast-path (short debounce, NOT long-term suppression):
//      │   └─ toolCount < BASE_THRESHOLD AND lastEvaluated within FASTPATH_TTL_MS (5 min)
//      │      → exit(no hint), no events read
//      │
//      ├─ Layer 2:
//      │   ├─ cache hit  (smartScore + lastEvaluated fresh)
//      │   │             → reuse score + cached display fields
//      │   └─ cache miss → readEvents → computeSmartScore + display
//      │
//      ├─ score < SMART_THRESHOLD → persist updates, exit(no hint)
//      │
//      └─ Single write (re-read latest first to avoid clobbering /contribute):
//          persist score, toolCount, uniqueTools, lastEvaluated, hinted=true
//          → STDOUT hint → AI reads, suggests /contribute
//

/**
 * Sanitize a sessionId for safe use as a filesystem name.
 *
 * sessionId may originate from:
 *   1. hookData.session_id (typically a hex UUID — already safe)
 *   2. process.env.CLAUDE_SESSION_ID
 *   3. PID fallback `pid-{pid}-{cwd}` — embeds cwd which contains "/"
 *
 * The PID fallback is the dangerous case: a literal "/" in the filename
 * caused per-cwd nested directories under ~/.teamai/sessions/ that the
 * cleanup sweep (top-level only) never reclaims.
 *
 * Replaces every char outside [a-zA-Z0-9._-] with "_". The transformation
 * is collision-resistant in practice because the input shape is constrained
 * (hex IDs or PID+cwd which is itself unique on a given machine).
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Get session state file path: ~/.teamai/sessions/{sanitized-sessionId}.json */
function getSessionPath(sessionId: string): string {
  return path.join(
    process.env.HOME ?? '',
    '.teamai',
    'sessions',
    `${sanitizeSessionId(sessionId)}.json`,
  );
}

/** Default empty state for a new session. */
function defaultState(): ContributeState {
  return {
    contributed: false,
  };
}

/** Read persisted contribute state. Returns defaults if missing or corrupted. */
export async function readContributeState(sessionId: string): Promise<ContributeState> {
  try {
    const raw = await readJson<Record<string, unknown>>(getSessionPath(sessionId));
    if (raw) {
      return {
        smartScore: typeof raw.smartScore === 'number' ? raw.smartScore : undefined,
        contributed: typeof raw.contributed === 'boolean' ? raw.contributed : false,
        toolCount: typeof raw.toolCount === 'number' ? raw.toolCount : undefined,
        uniqueTools: typeof raw.uniqueTools === 'number' ? raw.uniqueTools : undefined,
        lastEvaluated: typeof raw.lastEvaluated === 'number' ? raw.lastEvaluated : undefined,
        hinted: typeof raw.hinted === 'boolean' ? raw.hinted : undefined,
        sessionStartIso: typeof raw.sessionStartIso === 'string' ? raw.sessionStartIso : undefined,
        hasGitCommit: typeof raw.hasGitCommit === 'boolean' ? raw.hasGitCommit : undefined,
        isKnowledgeGap: typeof raw.isKnowledgeGap === 'boolean' ? raw.isKnowledgeGap : undefined,
      };
    }
    return defaultState();
  } catch {
    return defaultState();
  }
}

/** Persist contribute state to disk. Silently fails on I/O errors. */
export async function writeContributeState(sessionId: string, state: ContributeState): Promise<void> {
  try {
    const filePath = getSessionPath(sessionId);
    await ensureDir(path.dirname(filePath));
    await writeJson(filePath, state);
    // Best-effort cleanup of stale session files (>24h)
    await cleanupStaleSessions(path.dirname(filePath), sessionId);
  } catch (e) {
    log.error(`Failed to write contribute state: ${(e as Error).message}`);
  }
}

const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * Remove session files older than 24h. Skips the current session.
 *
 * @param dir              Sessions directory.
 * @param currentSessionId Raw sessionId of the just-written session (will be
 *                         sanitized internally to match the on-disk filename).
 *
 * @internal Exported for tests; do not call from CLI code paths.
 */
export async function cleanupStaleSessions(dir: string, currentSessionId: string): Promise<void> {
  const now = Date.now();
  // Filenames on disk are sanitized; compare against the sanitized form of the
  // current sessionId so the "skip current" guard actually matches.
  const currentBasename = sanitizeSessionId(currentSessionId);
  const entries = await fs.promises.readdir(dir);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.replace('.json', '');
    if (name === currentBasename) continue;
    const filePath = path.join(dir, entry);
    try {
      const stat = await fs.promises.stat(filePath);
      if (now - stat.mtimeMs > STALE_SESSION_MS) {
        await fs.promises.unlink(filePath);
      }
    } catch {
      // Ignore — file may have been removed by another session
    }
  }
}

/**
 * Compute a "contribution value" score for a session based on its events.
 *
 * Score components (0-100):
 * - Tool count (gradient): 30→10, 50→15, 80+→20 (max 20)
 * - Tool diversity: unique tool names / total calls × 30 (max 30)
 * - Skill usage: any Skill tool invoked → +15
 * - Error indicators: any error-related events → +15
 * - Session duration: > 30 min → +20
 *
 * A session that used many tools, showed diversity, and lasted a while
 * is very likely worth documenting.
 */
export function computeSmartScore(events: DashboardEvent[]): number {
  if (events.length === 0) return 0;

  const toolNames = new Set<string>();
  let hasSkills = false;
  let hasErrors = false;
  let totalToolCalls = 0;

  for (const event of events) {
    if (event.type === 'tool_use' && event.toolName) {
      toolNames.add(event.toolName);
      totalToolCalls++;
      if (event.toolName === 'Skill') {
        hasSkills = true;
      }
    }
    // Detect error indicators from prompt content
    if (event.type === 'prompt_submit' && event.promptSummary) {
      const lower = event.promptSummary.toLowerCase();
      if (
        lower.includes('error') ||
        lower.includes('fix') ||
        lower.includes('bug') ||
        lower.includes('fail') ||
        lower.includes('retry')
      ) {
        hasErrors = true;
      }
    }
  }

  let score = 0;

  // Tool count — gradient (max 25 points)
  // 20+ calls → 5, scales linearly up to 80+ → 25
  if (totalToolCalls >= 20) {
    score += Math.min(25, Math.round(((totalToolCalls - 20) / 60) * 20) + 5);
  }

  // Tool diversity (max 20 points)
  if (totalToolCalls > 0) {
    const diversity = toolNames.size / Math.min(totalToolCalls, 10);
    score += Math.min(Math.round(diversity * 20), 20);
  }

  // Skill usage (10 points)
  if (hasSkills) {
    score += 10;
  }

  // Error indicators (10 points)
  if (hasErrors) {
    score += 10;
  }

  // Session duration (max 20 points)
  if (events.length >= 2) {
    const first = new Date(events[0].timestamp).getTime();
    const last = new Date(events[events.length - 1].timestamp).getTime();
    const durationMin = (last - first) / (1000 * 60);
    if (durationMin > 30) {
      score += 20;
    } else if (durationMin > 15) {
      score += 10;
    }
  }

  return score;
}

// ─── Phase 2: Knowledge gap + git commit detection ─────

/**
 * Check if a git commit was made in the given cwd since sessionStartIso.
 * Returns false if cwd is not a git repo or git is unavailable.
 */
export function hasGitCommitInSession(cwd: string, sessionStartIso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(sessionStartIso)) {
    return false;
  }
  try {
    const result = execFileSync(
      'git',
      ['log', '--oneline', `--after=${sessionStartIso}`, '--format=%H', '-1'],
      { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Apply Phase 2 score adjustments based on recall quality and git commit status.
 * Returns the adjusted score and metadata flags.
 */
export function applyPhase2Adjustments(
  baseScore: number,
  sessionId: string,
  cwd?: string,
  sessionStartIso?: string,
): { score: number; isKnowledgeGap: boolean; hasGitCommit: boolean } {
  let score = baseScore;
  let isKnowledgeGap = false;
  let gitCommitDetected = false;

  const recallQuality = readRecallQuality(sessionId);

  if (recallQuality) {
    const totalRecalls = recallQuality.hitCount + recallQuality.missCount;
    if (totalRecalls > 0 && recallQuality.hitCount === 0) {
      score += CONTRIBUTE_KNOWLEDGE_GAP_BONUS;
      isKnowledgeGap = true;
    } else if (recallQuality.topScore < CONTRIBUTE_LOW_QUALITY_THRESHOLD && recallQuality.hitCount > 0) {
      score += CONTRIBUTE_LOW_QUALITY_BONUS;
      isKnowledgeGap = true;
    }
  }

  if (cwd && sessionStartIso) {
    gitCommitDetected = hasGitCommitInSession(cwd, sessionStartIso);
    if (gitCommitDetected && recallQuality && recallQuality.hitCount > 0) {
      score -= CONTRIBUTE_GIT_COMMIT_DOWNWEIGHT;
    }
  }

  return { score: Math.max(0, score), isKnowledgeGap, hasGitCommit: gitCommitDetected };
}

/** Read STDIN and extract sessionId from hook JSON. */
async function readStdinAndDeriveSession(): Promise<{ sessionId: string; cwd?: string } | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return null;

  try {
    const hookData = JSON.parse(raw) as Record<string, unknown>;
    // Derive session ID: session_id field > env > PID+cwd fallback
    const sessionId = deriveSessionId(hookData, { includeCwd: true });
    const cwd = typeof hookData.cwd === 'string' ? hookData.cwd : undefined;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

/** Count tool_use events for a session (canonical definition, used everywhere). */
function countToolUseEvents(events: DashboardEvent[]): number {
  return events.filter((e) => e.type === 'tool_use').length;
}

/** Count unique tool names across tool_use events. */
function countUniqueTools(events: DashboardEvent[]): number {
  return new Set(events.filter((e) => e.toolName).map((e) => e.toolName)).size;
}

/** Build the STDOUT hint string from pre-computed display values. */
function buildHint(totalToolCalls: number, uniqueTools: number, isKnowledgeGap: boolean): string {
  const body = isKnowledgeGap
    ? [
        `[teamai] 本次 session 涉及知识库尚未覆盖的领域（${totalToolCalls} 次工具调用，${uniqueTools} 种不同工具）。`,
        `建议运行 /teamai-share-learnings 将本次经验总结分享给团队，帮助填补知识库空白。`,
        `下次遇到类似任务时，团队成员将直接受益于您的经验。`,
      ].join('')
    : [
        `[teamai] 本次 session 内容丰富（${totalToolCalls} 次工具调用，${uniqueTools} 种不同工具）。`,
        `建议运行 /teamai-share-learnings 总结本次 session 的经验并分享给团队。`,
        `总结文档将保存到团队仓库的 learnings/ 目录。`,
      ].join('');
  return `Print the following message verbatim to the user (do NOT paraphrase, summarize, or explain its origin):\n\n${body}`;
}

/**
 * Evaluate a single session and decide whether to emit a contribute hint.
 *
 * Decision tree:
 *
 *   Short-circuits (no I/O beyond initial state read):
 *     - state.contributed → skip (user already ran /contribute)
 *     - state.hinted      → skip (hint already emitted, dedup)
 *
 *   Layer 1 fast-path (short debounce, skips events.jsonl read):
 *     - toolCount < BASE_THRESHOLD AND lastEvaluated within FASTPATH_TTL_MS (5 min)
 *       → skip (small session, just re-evaluated — debounce repeat Stop hooks)
 *
 *   Layer 2 score resolution:
 *     - cache hit:  smartScore + display fields present, lastEvaluated fresh
 *                   → reuse cached values, no events read
 *     - cache miss: readEvents → computeSmartScore + display
 *
 *   Hint emission (score >= SMART_THRESHOLD):
 *     - Return hint string built from cached display fields
 *
 *   Persistence (single atomic write per call, re-read latest first to avoid
 *   clobbering /contribute marks set during the read↔write window):
 *     - Cache miss path always writes (smartScore + display + lastEvaluated)
 *     - Hint path additionally sets hinted=true
 *     - Cache hit + low score path skips the write entirely (state is current)
 *
 * Returns the hint string (caller writes to stdout) or null if no hint.
 */
export async function contributeCheckForSession(
  sessionId: string,
  cwd?: string,
): Promise<{ hint: string | null }> {
  const state = await readContributeState(sessionId);
  const now = Date.now();

  if (state.contributed) {
    return { hint: null };
  }
  if (state.hinted) {
    log.debug(`contribute-check: hint already emitted for ${sessionId.slice(0, 16)}, skipping`);
    return { hint: null };
  }

  // Shared debounce for Layer 1 (skip events read) and Layer 2 (reuse cached
  // score). Beyond this window we always re-read events.jsonl so a stale
  // snapshot can't suppress a session that got busier later on.
  const debounceFresh =
    state.lastEvaluated !== undefined && now - state.lastEvaluated < CONTRIBUTE_FASTPATH_TTL_MS;

  // Layer 1 fast-path — skip events read for small, recently-evaluated sessions.
  if (
    debounceFresh &&
    state.toolCount !== undefined &&
    state.toolCount < CONTRIBUTE_BASE_THRESHOLD
  ) {
    log.debug(`contribute-check: fast-path skip (toolCount ${state.toolCount} < ${CONTRIBUTE_BASE_THRESHOLD}, debounce fresh)`);
    return { hint: null };
  }

  // Layer 2: resolve score + display
  let score: number;
  let toolCount: number;
  let uniqueTools: number;
  let needsPersist: boolean;
  let sessionStartIso: string | undefined;

  const cachedDisplayAvailable =
    debounceFresh
    && state.smartScore !== undefined
    && state.toolCount !== undefined
    && state.uniqueTools !== undefined;

  if (cachedDisplayAvailable) {
    log.debug(`contribute-check: cache hit (score=${state.smartScore})`);
    score = state.smartScore!;
    toolCount = state.toolCount!;
    uniqueTools = state.uniqueTools!;
    sessionStartIso = state.sessionStartIso;
    needsPersist = false;
  } else {
    const allEvents = await readEvents();
    const sessionEvents = allEvents.filter((e) => e.sessionId === sessionId);
    score = computeSmartScore(sessionEvents);
    toolCount = countToolUseEvents(sessionEvents);
    uniqueTools = countUniqueTools(sessionEvents);
    needsPersist = true;
    if (sessionEvents.length > 0) {
      sessionStartIso = sessionEvents[0].timestamp;
    }
    log.debug(`contribute-check: session ${sessionId.slice(0, 16)} smart score = ${score} (threshold: ${CONTRIBUTE_SMART_THRESHOLD})`);
  }

  // Phase 2: apply knowledge gap + git commit adjustments
  const phase2 = applyPhase2Adjustments(score, sessionId, cwd, sessionStartIso);
  score = phase2.score;
  const { isKnowledgeGap, hasGitCommit } = phase2;
  if (isKnowledgeGap || hasGitCommit) {
    needsPersist = true;
    log.debug(
      `contribute-check: phase2 adjustments applied (gap=${isKnowledgeGap}, commit=${hasGitCommit}, adjusted=${score})`,
    );
  }

  const willHint = score >= CONTRIBUTE_SMART_THRESHOLD;

  // Single write: re-read first to avoid clobbering parallel /contribute marks.
  // Skip the write on cache hit + low score (state is already current).
  if (needsPersist || willHint) {
    const latest = await readContributeState(sessionId);
    const updated: ContributeState = {
      ...latest,
      smartScore: score,
      toolCount,
      uniqueTools,
      lastEvaluated: needsPersist ? now : (latest.lastEvaluated ?? now),
      sessionStartIso: sessionStartIso ?? latest.sessionStartIso,
      isKnowledgeGap,
      hasGitCommit,
    };
    if (latest.hinted || willHint) {
      updated.hinted = true;
    }
    await writeContributeState(sessionId, updated);
  }

  if (!willHint) {
    log.debug('contribute-check: score below threshold, skipping hint');
    return { hint: null };
  }

  return { hint: buildHint(toolCount, uniqueTools, isKnowledgeGap) };
}

/**
 * Handle `teamai contribute-check --stdin --tool <name>`.
 * Called by Stop hook at session end.
 *
 * Thin CLI wrapper around `contributeCheckForSession`: reads STDIN to derive
 * the session ID and writes the hint (if any) to STDOUT in Stop hook format.
 *
 * Output: STDOUT hint when smart threshold is exceeded (once per session).
 * Claude Code reads hook STDOUT and passes it to AI as context,
 * so the AI will naturally suggest /contribute to the user.
 */
export async function contributeCheck(toolArg?: string): Promise<void> {
  // Same stdout-exclusive contract as hook-dispatch-cli — log lines mixed
  // into stdout break Claude Code's JSON parse and silently drop the hint.
  const { setStderrOnly } = await import('./utils/logger.js');
  setStderrOnly(true);

  const stdinData = await readStdinAndDeriveSession();
  if (!stdinData) {
    log.debug('contribute-check: no STDIN data or no session ID');
    return;
  }

  const { hint } = await contributeCheckForSession(stdinData.sessionId, stdinData.cwd);
  if (hint !== null) {
    const { formatStopHookOutput } = await import('./utils/hook-output.js');
    process.stdout.write(formatStopHookOutput(hint, toolArg ?? 'claude'));
  }
}

/**
 * Mark the current session as contributed (dedup).
 * Called after a successful contribute push.
 */
export async function markContributed(sessionId: string): Promise<void> {
  const state = await readContributeState(sessionId);
  const updated: ContributeState = { ...state, contributed: true };
  await writeContributeState(sessionId, updated);
}

import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { readJson, writeJson, ensureDir } from './utils/fs.js';
import { readEvents } from './dashboard-collector.js';
import type { ContributeState, DashboardEvent } from './types.js';
import {
  CONTRIBUTE_BASE_THRESHOLD,
  CONTRIBUTE_SMART_THRESHOLD,
  CONTRIBUTE_STATE_PATH,
} from './types.js';

// ─── Contribute check data flow ──────────────────────────
//
//  PostToolUse hook (every tool call)
//      │
//      ▼
//  teamai contribute-check --stdin --tool <name>
//      │
//      ├─ readState(sessionId)
//      │   └─ missing/corrupted → default state
//      │
//      ├─ if hinted or contributed → exit(0), no output
//      │
//      ├─ increment toolCount
//      │
//      ├─ if toolCount < BASE_THRESHOLD (100) → write state, exit(0)
//      │
//      ├─ evaluateSmartScore(sessionId)    ← lazy: only at threshold
//      │   ├─ read events.jsonl
//      │   ├─ filter by sessionId
//      │   ├─ uniqueTools, hasSkills, hasErrors → score
//      │   └─ score < SMART_THRESHOLD (60) → write state (hinted=true to avoid re-eval), exit(0)
//      │
//      └─ STDOUT hint → AI reads, suggests /contribute
//

/** Get state path (evaluated at call time for test overrides). */
function getStatePath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'contribute-state.json');
}

/** Default empty state for a new session. */
function defaultState(sessionId: string): ContributeState {
  return {
    sessionId,
    toolCount: 0,
    hinted: false,
    contributed: false,
  };
}

/** Read persisted contribute state. Returns defaults if missing or corrupted. */
export async function readContributeState(sessionId: string): Promise<ContributeState> {
  try {
    const state = await readJson<ContributeState>(getStatePath());
    if (state && state.sessionId === sessionId) {
      return state;
    }
    // Different session — reset state
    return defaultState(sessionId);
  } catch {
    return defaultState(sessionId);
  }
}

/** Persist contribute state to disk. Silently fails on I/O errors. */
export async function writeContributeState(state: ContributeState): Promise<void> {
  try {
    await ensureDir(path.dirname(getStatePath()));
    await writeJson(getStatePath(), state);
  } catch (e) {
    log.debug(`Failed to write contribute state: ${(e as Error).message}`);
  }
}

/**
 * Compute a "contribution value" score for a session based on its events.
 *
 * Score components (0-100):
 * - Tool diversity: unique tool names / total calls × 30 (max 30)
 * - Skill usage: any Skill tool invoked → +25
 * - Error indicators: any error-related events → +25
 * - Session duration: > 30 min → +20
 *
 * A session that used diverse tools, invoked skills, hit errors,
 * and lasted a while is very likely worth documenting.
 */
export function computeSmartScore(events: DashboardEvent[]): number {
  if (events.length === 0) return 0;

  const toolNames = new Set<string>();
  let hasSkills = false;
  let hasErrors = false;

  for (const event of events) {
    if (event.type === 'tool_use' && event.toolName) {
      toolNames.add(event.toolName);
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

  // Tool diversity (max 30 points)
  const toolCount = events.filter((e) => e.type === 'tool_use').length;
  if (toolCount > 0) {
    const diversity = toolNames.size / Math.min(toolCount, 20); // Cap denominator at 20
    score += Math.min(Math.round(diversity * 30), 30);
  }

  // Skill usage (25 points)
  if (hasSkills) {
    score += 25;
  }

  // Error indicators (25 points)
  if (hasErrors) {
    score += 25;
  }

  // Session duration (20 points if > 30 min)
  if (events.length >= 2) {
    const first = new Date(events[0].timestamp).getTime();
    const last = new Date(events[events.length - 1].timestamp).getTime();
    const durationMin = (last - first) / (1000 * 60);
    if (durationMin > 30) {
      score += 20;
    }
  }

  return score;
}

/** Read STDIN and extract sessionId from hook JSON. */
async function readStdinAndDeriveSession(): Promise<{ sessionId: string } | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return null;

  try {
    const hookData = JSON.parse(raw) as Record<string, unknown>;
    // Derive session ID: session_id field > env > PID fallback
    const sessionId =
      (typeof hookData.session_id === 'string' && hookData.session_id) ||
      process.env.CLAUDE_SESSION_ID ||
      `pid-${process.ppid ?? process.pid}-${typeof hookData.cwd === 'string' ? hookData.cwd : process.cwd()}`;
    return { sessionId };
  } catch {
    return null;
  }
}

/**
 * Handle `teamai contribute-check --stdin --tool <name>`.
 * Called by PostToolUse hook on every tool call.
 *
 * Performance: reads a small state JSON (~1ms) on every call.
 * Only reads events.jsonl once when base threshold is reached.
 *
 * Output: STDOUT hint when smart threshold is exceeded (once per session).
 * Claude Code reads hook STDOUT and passes it to AI as context,
 * so the AI will naturally suggest /contribute to the user.
 */
export async function contributeCheck(toolArg?: string): Promise<void> {
  const stdinData = await readStdinAndDeriveSession();
  if (!stdinData) {
    log.debug('contribute-check: no STDIN data or no session ID');
    return;
  }

  const { sessionId } = stdinData;
  const state = await readContributeState(sessionId);

  // Already hinted or contributed — no need to check again
  if (state.hinted || state.contributed) {
    return;
  }

  // Increment tool count
  const updatedState: ContributeState = {
    ...state,
    toolCount: state.toolCount + 1,
  };

  // Layer 1: below base threshold — just save count and exit
  if (updatedState.toolCount < CONTRIBUTE_BASE_THRESHOLD) {
    await writeContributeState(updatedState);
    return;
  }

  // Layer 2: smart threshold evaluation (runs once at base threshold)
  log.debug(`contribute-check: session ${sessionId.slice(0, 16)} reached ${updatedState.toolCount} calls, evaluating...`);

  const allEvents = await readEvents();
  const sessionEvents = allEvents.filter((e) => e.sessionId === sessionId);
  const score = computeSmartScore(sessionEvents);

  log.debug(`contribute-check: smart score = ${score} (threshold: ${CONTRIBUTE_SMART_THRESHOLD})`);

  // Mark as hinted regardless of score — avoid re-evaluating every subsequent call
  updatedState.hinted = true;
  await writeContributeState(updatedState);

  if (score < CONTRIBUTE_SMART_THRESHOLD) {
    log.debug('contribute-check: score below threshold, skipping hint');
    return;
  }

  // Output STDOUT hint — Claude Code passes this to the AI
  const toolCount = updatedState.toolCount;
  const uniqueTools = new Set(sessionEvents.filter((e) => e.toolName).map((e) => e.toolName)).size;
  const hint = [
    `[teamai] 本次 session 内容丰富（${toolCount} 次工具调用，${uniqueTools} 种不同工具）。`,
    `建议运行 /teamai-share-learnings 总结本次 session 的经验并分享给团队。`,
    `总结文档将保存到团队仓库的 ai-docs/ 目录。`,
  ].join('');

  // STDOUT goes to Claude Code as hook output → AI context
  process.stdout.write(hint);
}

/**
 * Mark the current session as contributed (dedup).
 * Called after a successful contribute push.
 */
export async function markContributed(sessionId: string): Promise<void> {
  const state = await readContributeState(sessionId);
  const updated: ContributeState = { ...state, contributed: true };
  await writeContributeState(updated);
}

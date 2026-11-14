import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { log } from './utils/logger.js';
import { RELAY_TO_USER_PREFIX, relayWhenHidden } from './utils/hook-output.js';
import { readJson, writeJson, writeJsonAtomic, ensureDir } from './utils/fs.js';
import { readEvents, aggregateSessionMetrics, scanTranscriptStop, hookScopeDir } from './dashboard-collector.js';
import { readRecallQuality } from './recall-quality.js';
import { deriveSessionId } from './utils/session-id.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { redactWithEnv } from '@teamai/shared/redact';
import type { ContributeState, DashboardEvent, LocalConfig, SessionShareOffered, SessionFriction } from './types.js';
import { CONTRIBUTE_FASTPATH_TTL_MS, CONTRIBUTE_GIT_COMMIT_DOWNWEIGHT, SessionShareOfferedSchema } from './types.js';
import { DefaultFolders, type DefaultFolder, type DefaultFolderParams, type TextLanguage } from './default-folders.js';
import { getUserHome } from './utils/home.js';
import { HookStdinSchema, stdinString, type HookStdin } from './hook-dispatch.js';

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
//      ├─ the teamai-friction-reminder folder: min_tools, min_score, weights, texts
//      │
//      ├─ Layer 1 fast-path (short debounce, NOT long-term suppression):
//      │   └─ toolCount < min_tools AND lastEvaluated within FASTPATH_TTL_MS (5 min)
//      │      → exit(no hint), no events read
//      │
//      ├─ Layer 2:
//      │   ├─ cache hit  (smartScore + friction + lastEvaluated fresh)
//      │   │             → reuse score + cached explanation context
//      │   └─ cache miss → readEvents → computeSmartScore + context
//      │
//      ├─ score < min_score → persist updates, exit(no hint)
//      │
//      ├─ reminder fires → offer() (session-share.ts), only now:
//      │   ├─ undefined (teamai launched the session, unattended, workflow place,
//      │   │   drives a run not done, teamai-share-learnings is invoke: deny)
//      │   │             → today's text: `/teamai share` (`teamai skill get share`)
//      │   └─ { publish, scorers }
//      │                 → the text names teamai-share-learnings's describe command, no inputs
//      │
//      └─ Single write (re-read latest first to avoid clobbering /contribute):
//          persist score, toolCount, friction, promptSummary, lastEvaluated, hinted=true,
//          offered, and pendingHint for a tool whose Stop cannot print
//          → STDOUT hint → AI reads, offers teamai-share-learnings or suggests /contribute
//

/**
 * Sanitize a sessionId for safe use as a filesystem name.
 *
 * sessionId may originate from:
 *   1. hookData.session_id (typically a hex UUID — already safe)
 *   2. the agent's session variable (e.g. CLAUDE_CODE_SESSION_ID)
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
export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

const MAX_CONTRIBUTE_PROMPT_SUMMARY_CHARS = 160;

const NonNegativeIntegerSchema = z.number().nonnegative().refine(Number.isInteger);

/** Cached friction; malformed legacy/tampered state is a cache miss. */
const SessionFrictionSchema = z.object({
  interrupt: NonNegativeIntegerSchema,
  toolReject: NonNegativeIntegerSchema,
  correction: NonNegativeIntegerSchema,
  toolError: NonNegativeIntegerSchema,
});

/** Redact and flatten user-controlled prompt text before caching or displaying it. */
function normalizePromptSummary(raw?: string): string | undefined {
  if (raw === undefined) return undefined;

  const normalized = redactWithEnv(raw)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return undefined;

  if (normalized.length <= MAX_CONTRIBUTE_PROMPT_SUMMARY_CHARS) return normalized;

  const truncated = normalized
    .slice(0, MAX_CONTRIBUTE_PROMPT_SUMMARY_CHARS - 1)
    .replace(/[\uD800-\uDBFF]$/, '');

  return `${truncated}…`;
}

/** Get session state file path: ~/.teamai/sessions/{sanitized-sessionId}.json */
function getSessionPath(sessionId: string): string {
  return path.join(
    getUserHome(),
    '.teamai',
    'sessions',
    `${sanitizeSessionId(sessionId)}.json`,
  );
}

/** A persisted state file, read field by field: a field of the wrong type reads as absent. */
const PersistedContributeStateSchema = z.object({
  smartScore: z.number().optional().catch(undefined),
  contributed: z.boolean().catch(false),
  toolCount: z.number().optional().catch(undefined),
  uniqueTools: z.number().optional().catch(undefined),
  lastEvaluated: z.number().optional().catch(undefined),
  hinted: z.boolean().optional().catch(undefined),
  sessionStartIso: z.string().optional().catch(undefined),
  hasGitCommit: z.boolean().optional().catch(undefined),
  isKnowledgeGap: z.boolean().optional().catch(undefined),
  friction: SessionFrictionSchema.optional().catch(undefined),
  promptSummary: z.string().optional().catch(undefined),
  pendingHint: z.string().optional().catch(undefined),
  offered: SessionShareOfferedSchema.optional().catch(undefined),
});

/** Default empty state for a new session. */
function defaultState(): ContributeState {
  return {
    contributed: false,
  };
}

/**
 * Read persisted contribute state. A session whose state file the sweep removed starts from what its swept record
 * kept, so a session resumed days later is not reminded again. Returns defaults if missing or corrupted.
 */
export async function readContributeState(sessionId: string): Promise<ContributeState> {
  try {
    const file = getSessionPath(sessionId);
    const raw = await readJson(file);

    if (!raw) {
      const swept = await readOfferFacts(path.join(sweptDir(path.dirname(file)), path.basename(file)), SweptSchema);

      return swept ? { ...defaultState(), ...swept } : defaultState();
    }

    const persisted = PersistedContributeStateSchema.safeParse(raw).data;

    return {
      smartScore: persisted?.smartScore,
      contributed: persisted?.contributed ?? false,
      toolCount: persisted?.toolCount,
      uniqueTools: persisted?.uniqueTools,
      lastEvaluated: persisted?.lastEvaluated,
      hinted: persisted?.hinted,
      sessionStartIso: persisted?.sessionStartIso,
      hasGitCommit: persisted?.hasGitCommit,
      isKnowledgeGap: persisted?.isKnowledgeGap,
      friction: persisted?.friction,
      promptSummary: normalizePromptSummary(persisted?.promptSummary),
      pendingHint: persisted?.pendingHint,
      offered: persisted?.offered,
    };
  } catch {
    return defaultState();
  }
}

/** Persist contribute state to disk. Silently fails on I/O errors. */
export async function writeContributeState(sessionId: string, state: ContributeState): Promise<void> {
  try {
    const filePath = getSessionPath(sessionId);
    await ensureDir(path.dirname(filePath));

    const persistedState: ContributeState = {
      ...state,
      friction: SessionFrictionSchema.safeParse(state.friction).data,
      promptSummary: normalizePromptSummary(state.promptSummary),
    };

    await writeJson(filePath, persistedState);
    // Best-effort cleanup of stale session files (>24h)
    await cleanupStaleSessions(path.dirname(filePath), sessionId);
  } catch (e) {
    log.error(`Failed to write contribute state: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * How long a swept session's reminder decision is kept, in days: the dashboard compares the sessions the friction
 * reminder fired on with those it did not over at most this many days (#1182), longer than a state file lives.
 */
export const REMINDER_RECORD_DAYS = 30;
const SWEPT_RECORD_MS = REMINDER_RECORD_DAYS * 24 * 60 * 60 * 1000;

/**
 * `<sessions>/swept/<sanitized id>.json`: what the sweep keeps of a removed state file: whether the reminder fired,
 * whether the person shared, and what the reminder offered with teamai-share-learnings.
 */
function sweptDir(sessionsDir: string): string {
  return path.join(sessionsDir, 'swept');
}

/** A contribute state file: other hooks keep their own per-session files beside it, which never hold `contributed`. */
const StateSchema = z.object({ contributed: z.boolean(), hinted: z.boolean().optional(), offered: SessionShareOfferedSchema.optional() });

/** A swept record; one written before #1388 holds `hinted` only. */
const SweptSchema = z.object({ hinted: z.boolean(), contributed: z.boolean().optional(), offered: SessionShareOfferedSchema.optional() });

type OfferFacts = z.infer<typeof SweptSchema>;

/**
 * What the contribute state file or swept record at `file` says of the reminder: whether it fired, whether the person
 * shared, and what it offered; undefined when the file is missing, unreadable, or another hook's file.
 */
async function readOfferFacts(file: string, schema: typeof StateSchema | typeof SweptSchema): Promise<OfferFacts | undefined> {
  const parsed = schema.safeParse(await readJson<unknown>(file).catch(() => null));

  if (!parsed.success) return undefined;
  const { hinted, contributed, offered } = parsed.data;

  const facts: OfferFacts = { hinted: hinted === true, contributed: contributed === true };

  if (offered) facts.offered = offered;

  return facts;
}

/**
 * Remove session files older than 24h. Skips the current session. Each removed file leaves a record of whether its
 * friction reminder fired, false included, kept for 30 days; a record that says fired stays so when the session is
 * resumed and swept again. Older records are removed here too.
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
        const live = await readOfferFacts(filePath, StateSchema);
        const record = path.join(sweptDir(dir), entry);

        if (live !== undefined) {
          const kept = await readOfferFacts(record, SweptSchema);
          const offered = live.offered ?? kept?.offered;

          const merged: OfferFacts = {
            hinted: live.hinted || kept?.hinted === true,
            contributed: live.contributed || kept?.contributed === true,
          };

          if (offered) merged.offered = offered;
          await writeJsonAtomic(record, merged);
        }

        await fs.promises.unlink(filePath);
      }
    } catch {
      // Ignore — file may have been removed by another session
    }
  }

  for (const entry of await fs.promises.readdir(sweptDir(dir)).catch(() => [])) {
    const filePath = path.join(sweptDir(dir), entry);

    try {
      if (now - (await fs.promises.stat(filePath)).mtimeMs > SWEPT_RECORD_MS) await fs.promises.unlink(filePath);
    } catch {
      // Ignore — another session's sweep may have removed it
    }
  }
}

/**
 * Whether the friction reminder fired, by sanitized session id, for every session this machine has contribute state
 * for: the live state files, and the records the sweep kept for 30 days. A session that either says fired counts as
 * fired, since a session resumed after its sweep starts a new state file. A session with neither has no entry.
 */
export async function readReminderDecisions(): Promise<Map<string, boolean>> {
  const dir = path.join(getUserHome(), '.teamai', 'sessions');

  const read = async (folder: string, schema: typeof StateSchema | typeof SweptSchema) => (await Promise.all((await fs.promises.readdir(folder).catch(() => []))
    .filter((entry) => entry.endsWith('.json'))
    .map(async (entry) => {
      const facts = await readOfferFacts(path.join(folder, entry), schema);

      return facts === undefined ? [] : [[entry.slice(0, -'.json'.length), facts.hinted] as const];
    }))).flat();

  const [swept, live] = await Promise.all([read(sweptDir(dir), SweptSchema), read(dir, StateSchema)]);
  const decisions = new Map<string, boolean>();

  for (const [session, hinted] of [...swept, ...live]) decisions.set(session, hinted || decisions.get(session) === true);

  return decisions;
}

/** The thresholds and weights of the friction reminder, from `with:` of hooks/teamai-friction-reminder/HOOK.yaml. */
export type FrictionReminderParams = DefaultFolderParams<'hooks', 'teamai-friction-reminder'>;

/** Points from the tool-error retry gradient (the first tier whose min the count reaches wins). */
function toolErrorPoints(tiers: FrictionReminderParams['tool_error_tiers'], toolError: number): number {
  for (const tier of tiers) {
    if (toolError >= tier.min) return tier.points;
  }

  return 0;
}

/**
 * Compute a session's FRICTION score — how much the user had to correct the AI
 * or the AI had to fight its tools. A session is worth documenting because it hit
 * a real snag, not because it ran a lot of tools.
 *
 * Primary signals (each near-threshold on its own), weighted by `params`:
 * - interrupt   × weights.interrupt   (user stopped a wrong direction)
 * - toolReject  × weights.reject      (user denied a tool call)
 * - correction  × weights.correction  (re-prompt to course-correct)
 * - toolError   → tool_error_tiers    (AI retried failing tools)
 *
 * Scale is only a tiny nudge (diversity + skill use, max ~10) and can never
 * trigger a hint on its own — that is the whole point of the rewrite.
 *
 * `friction` is optional so existing callers/tests that pass only events still
 * compile; without it the score reflects the scale nudge alone (effectively "no
 * friction detected").
 */
export function computeSmartScore(params: FrictionReminderParams, events: DashboardEvent[], friction?: SessionFriction): number {
  if (events.length === 0) return 0;

  const toolNames = new Set<string>();
  let hasSkills = false;
  let totalToolCalls = 0;

  for (const event of events) {
    if (event.type === 'tool_use' && event.toolName) {
      toolNames.add(event.toolName);
      totalToolCalls++;

      if (event.toolName === 'Skill') {
        hasSkills = true;
      }
    }
  }

  let score = 0;

  // ── Primary: friction signals ──
  if (friction) {
    score += friction.interrupt * params.weights.interrupt;
    score += friction.toolReject * params.weights.reject;
    score += friction.correction * params.weights.correction;
    score += toolErrorPoints(params.tool_error_tiers, friction.toolError);
  }

  // ── Secondary: tiny scale nudge (never triggers alone) ──
  if (hasSkills) {
    score += params.skill_bonus;
  }

  if (totalToolCalls > 0) {
    const diversity = toolNames.size / Math.min(totalToolCalls, 10);
    score += Math.min(Math.round(diversity * params.diversity_bonus_max), params.diversity_bonus_max);
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
  params: FrictionReminderParams,
  baseScore: number,
  sessionId: string,
  cwd?: string,
  sessionStartIso?: string,
) {
  let score = baseScore;
  let isKnowledgeGap = false;
  let gitCommitDetected = false;

  const recallQuality = readRecallQuality(sessionId);

  if (recallQuality) {
    const totalRecalls = recallQuality.hitCount + recallQuality.missCount;

    if (totalRecalls > 0 && recallQuality.hitCount === 0) {
      score += params.knowledge_gap_bonus;
      isKnowledgeGap = true;
    } else if (recallQuality.topScore < params.low_quality_threshold && recallQuality.hitCount > 0) {
      score += params.low_quality_bonus;
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
async function readStdinAndDeriveSession(): Promise<{
  sessionId: string;
  cwd?: string;
  transcriptPath?: string;
  hookData: HookStdin;
} | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');

  if (!raw.trim()) return null;

  try {
    const parsed = HookStdinSchema.safeParse(JSON.parse(raw));

    if (!parsed.success) return null;
    const hookData = parsed.data;
    // Derive session ID: session_id field > env > PID+cwd fallback
    const sessionId = deriveSessionId(hookData, { includeCwd: true });
    const cwd = resolveHookCwd(hookData);

    const transcriptPath = stdinString(hookData, 'transcript_path');

    return { sessionId, cwd, transcriptPath, hookData };
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
  return new Set(events.flatMap((e) => (e.toolName ? [e.toolName] : []))).size;
}

/**
 * Extract friction signals for a session from its events.
 *
 * - interrupt / toolReject / toolError: prefer the freshly-scanned transcript
 *   results (`transcriptFriction`) when provided. These three signals normally
 *   live on the latest Stop event's interventions snapshot, but that Stop event
 *   is written asynchronously by a detached background process and may not be
 *   flushed to events.jsonl yet when this check runs — so a live transcript scan
 *   eliminates the cross-process race. When `transcriptFriction` is absent
 *   (backward compatibility / no transcript path), fall back to the latest Stop
 *   event's interventions snapshot (idempotent full total; toolError absent on
 *   pre-existing events → 0).
 * - correction: derived by aggregateSessionMetrics from the stop→prompt_submit
 *   pattern (not present on any single event), so we reuse it rather than re-scan.
 */
function extractFriction(
  events: DashboardEvent[],
  sessionId: string,
  transcriptFriction?: { interrupt: number; toolReject: number; toolError: number },
): SessionFriction {
  let interrupt = 0;
  let toolReject = 0;
  let toolError = 0;

  if (transcriptFriction) {
    ({ interrupt, toolReject, toolError } = transcriptFriction);
  } else {
    for (const e of events) {
      if (e.type === 'stop' && e.interventions) {
        // Latest Stop wins (snapshots are cumulative & idempotent).
        interrupt = e.interventions.interrupt;
        toolReject = e.interventions.toolReject;
        toolError = e.interventions.toolError ?? 0;
      }
    }
  }

  const correction = aggregateSessionMetrics(events).get(sessionId)?.correction ?? 0;

  return { interrupt, toolReject, correction, toolError };
}

/** A prompt summary from an events.jsonl line, which the file does not guarantee is a string. */
const NonBlankTextSchema = z.string().refine((text) => text.trim().length > 0);

/** Extract and sanitize the first user task recorded for the session. */
function extractPromptSummary(events: DashboardEvent[]): string | undefined {
  const firstPrompt = events.find(
    (event) => event.type === 'prompt_submit'
      && NonBlankTextSchema.safeParse(event.promptSummary).success,
  );

  return normalizePromptSummary(firstPrompt?.promptSummary);
}

/** `count` as the reason texts of `language` write it: `times` such as `twice` or `2 次`, and `tool_calls` such as `1 tool call`. */
function countWords(count: number, language: NonNullable<TextLanguage> | null) {
  if (language === 'zh') return { count: String(count), times: `${count} 次`, tool_calls: `${count} 次工具调用` };

  return {
    count: String(count),
    times: count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`,
    tool_calls: count === 1 ? '1 tool call' : `${count} tool calls`,
  };
}

/** The friction signals of `friction` that happened, each as its reason text, in the language its file is written in. */
function frictionReasons(friction: SessionFriction, reminder: DefaultFolder<'hooks', 'teamai-friction-reminder'>, language: TextLanguage): string[] {
  const signals = [
    ['reason-interrupt', friction.interrupt],
    ['reason-tool-reject', friction.toolReject],
    ['reason-correction', friction.correction],
    ['reason-tool-error', friction.toolError],
  ] as const;

  return signals.flatMap(([name, count]) => {
    if (count <= 0) return [];
    const text = reminder.text(name, language);

    return [text.render(countWords(count, text.language))];
  });
}

interface HintContext {
  friction: SessionFriction;
  promptSummary?: string;
  isKnowledgeGap: boolean;
  /** Whether the reminder offers the teamai-share-learnings workflow rather than the `share` skill. */
  offersShareLearnings: boolean;
}

/** The command that describes teamai-share-learnings's inputs, with values proposed for the calling session. */
const SHARE_LEARNINGS_DESCRIBE = 'teamai workflow start --describe teamai-share-learnings --driver skill';

/**
 * Build the STDOUT hint from the same context that drove the score, with `reminder`'s texts: the headline, the task
 * when there is one, and the action, separated by a blank line.
 */
function buildHint({ friction, promptSummary, isKnowledgeGap, offersShareLearnings }: HintContext, reminder: DefaultFolder<'hooks', 'teamai-friction-reminder'>, language: TextLanguage): string {
  const reasons = frictionReasons(friction, reminder, language).join(language === 'zh' ? '，' : ', ');

  const headline = reasons
    ? reminder.text(isKnowledgeGap ? 'gap-reasons' : 'problem-reasons', language).render({ reasons })
    : reminder.text(isKnowledgeGap ? 'gap' : 'problem', language).render({});

  const task = promptSummary ? [reminder.text('task', language).render({ task: promptSummary })] : [];

  const action = offersShareLearnings
    ? reminder.text('action-share-learnings', language).render({ command: SHARE_LEARNINGS_DESCRIBE })
    : reminder.text(isKnowledgeGap ? 'action-gap' : 'action', language).render({});

  return [headline, ...task, action].join('\n\n');
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
 *     - toolCount < min_tools AND lastEvaluated within FASTPATH_TTL_MS (5 min)
 *       → skip (small session, just re-evaluated — debounce repeat Stop hooks)
 *
 *   Layer 2 score resolution:
 *     - cache hit:  smartScore + friction present, lastEvaluated fresh
 *                   → reuse cached explanation context, no events read
 *     - cache miss: readEvents → computeSmartScore + explanation context
 *
 *   Hint emission (score >= min_score, the thresholds and texts from the teamai-friction-reminder folder):
 *     - `offer`, when given, says what to offer with the teamai-share-learnings workflow; it runs only here
 *     - Return hint string built from cached friction + task context, naming teamai-share-learnings when offered
 *
 *   Persistence (single atomic write per call, re-read latest first to avoid
 *   clobbering /contribute marks set during the read↔write window):
 *     - Cache miss path always writes (smartScore + context + lastEvaluated)
 *     - Hint path additionally sets hinted=true, and offered when the hint names teamai-share-learnings
 *     - Cache hit + low score path skips the write entirely (state is current)
 *
 * Returns the hint string (caller writes to stdout) or null if no hint.
 */
export async function contributeCheckForSession(
  sessionId: string,
  cwd?: string,
  transcriptPath?: string,
  stashInsteadOfReturn = false,
  offer?: () => Promise<SessionShareOffered | undefined>,
  scope: LocalConfig | null = null,
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

  const reminder = await DefaultFolders.load({ kind: 'hooks', name: 'teamai-friction-reminder' }, scope);
  const { params } = reminder;

  // Shared debounce for Layer 1 (skip events read) and Layer 2 (reuse cached
  // score). Beyond this window we always re-read events.jsonl so a stale
  // snapshot can't suppress a session that got busier later on.
  const debounceFresh =
    state.lastEvaluated !== undefined && now - state.lastEvaluated < CONTRIBUTE_FASTPATH_TTL_MS;

  // Layer 1 fast-path — skip events read for small, recently-evaluated sessions.
  if (
    debounceFresh &&
    state.toolCount !== undefined &&
    state.toolCount < params.min_tools
  ) {
    log.debug(`contribute-check: fast-path skip (toolCount ${state.toolCount} < ${params.min_tools}, debounce fresh)`);

    return { hint: null };
  }

  // Layer 2: resolve score + explanation context
  let score: number;
  let toolCount: number;
  let uniqueTools: number | undefined;
  let friction: SessionFriction;
  let promptSummary: string | undefined;
  let needsPersist: boolean;
  let sessionStartIso: string | undefined;

  const cachedContextAvailable =
    debounceFresh
    && state.smartScore !== undefined
    && state.toolCount !== undefined
    && state.friction !== undefined;

  if (cachedContextAvailable) {
    log.debug(`contribute-check: cache hit (score=${state.smartScore})`);
    score = state.smartScore!;
    toolCount = state.toolCount!;
    uniqueTools = state.uniqueTools;
    friction = state.friction!;
    promptSummary = state.promptSummary;
    sessionStartIso = state.sessionStartIso;
    needsPersist = false;
  } else {
    const allEvents = await readEvents();
    const sessionEvents = allEvents.filter((e) => e.sessionId === sessionId);

    if (transcriptPath) {
      const scan = await scanTranscriptStop(transcriptPath);
      friction = extractFriction(sessionEvents, sessionId, {
        interrupt: scan.interrupt,
        toolReject: scan.toolReject,
        toolError: scan.toolError,
      });
    } else {
      friction = extractFriction(sessionEvents, sessionId);
    }

    promptSummary = extractPromptSummary(sessionEvents);
    score = computeSmartScore(params, sessionEvents, friction);
    toolCount = countToolUseEvents(sessionEvents);
    uniqueTools = countUniqueTools(sessionEvents);
    needsPersist = true;

    if (sessionEvents.length > 0) {
      sessionStartIso = sessionEvents[0].timestamp;
    }

    log.debug(
      `contribute-check: session ${sessionId.slice(0, 16)} friction score = ${score} `
      + `(interrupt=${friction.interrupt}, reject=${friction.toolReject}, `
      + `correction=${friction.correction}, toolError=${friction.toolError}, threshold=${params.min_score})`,
    );
  }

  // Phase 2: apply knowledge gap + git commit adjustments
  const phase2 = applyPhase2Adjustments(params, score, sessionId, cwd, sessionStartIso);
  score = phase2.score;
  const { isKnowledgeGap, hasGitCommit } = phase2;

  if (isKnowledgeGap || hasGitCommit) {
    needsPersist = true;
    log.debug(
      `contribute-check: phase2 adjustments applied (gap=${isKnowledgeGap}, commit=${hasGitCommit}, adjusted=${score})`,
    );
  }

  // Hard gate: even a friction-heavy session is not worth documenting if it did
  // almost no work (e.g. a single rejected command). Requires real activity.
  const willHint = score >= params.min_score && toolCount >= params.min_tools;

  // Build the hint text once; it is either returned (Stop stdout) or stashed for
  // UserPromptSubmit delivery, never both.
  // The teamai-share-learnings offer is computed only on the Stop where the reminder fires.
  const offered = willHint && offer ? await offer() : undefined;
  // The team's `language` picks each text's variant; it is read only on the Stop where the reminder fires.
  const language = willHint ? await (await import('./config.js')).loadTeamAgentLanguage(scope) : undefined;
  const hintText = willHint ? buildHint({ friction, promptSummary, isKnowledgeGap, offersShareLearnings: offered !== undefined }, reminder, language) : null;

  // Single write: re-read first to avoid clobbering parallel /contribute marks.
  // Skip the write on cache hit + low score (state is already current).
  if (needsPersist || willHint) {
    const latest = await readContributeState(sessionId);

    const updated: ContributeState = {
      ...latest,
      smartScore: score,
      toolCount,
      uniqueTools: uniqueTools ?? latest.uniqueTools,
      lastEvaluated: needsPersist ? now : (latest.lastEvaluated ?? now),
      sessionStartIso: sessionStartIso ?? latest.sessionStartIso,
      isKnowledgeGap,
      hasGitCommit,
      friction,
      promptSummary: promptSummary ?? latest.promptSummary,
    };

    if (latest.hinted || willHint) {
      updated.hinted = true;
    }

    if (offered) updated.offered = offered;

    // For tools whose Stop hook ignores stdout, stash the hint in this same
    // write for delivery on the next UserPromptSubmit — no second write.
    if (willHint && stashInsteadOfReturn) {
      // The stash is delivered as UserPromptSubmit context, which the host does
      // not display, so this copy asks the model to relay it. The Stop copy
      // returned below does not: Claude Code prints that one itself (#719).
      updated.pendingHint = hintText ? RELAY_TO_USER_PREFIX + hintText : undefined;
    }

    await writeContributeState(sessionId, updated);
  }

  if (!willHint) {
    log.debug('contribute-check: score below threshold, skipping hint');

    return { hint: null };
  }

  // stashInsteadOfReturn callers receive null here (the hint was persisted as
  // pendingHint above); everyone else gets the hint to write to Stop stdout.
  return { hint: stashInsteadOfReturn ? null : hintText };
}

/**
 * Read and clear a pending share-learnings hint for this session, if any.
 * Returns the hint text (to inject via UserPromptSubmit additionalContext) or
 * null. Clearing preserves all other state (including `hinted`), so the
 * one-hint-per-session guarantee holds. If the user already contributed between
 * the stash and now, the stale nudge is cleared and dropped (returns null).
 */
export async function takePendingHint(sessionId: string): Promise<string | null> {
  const state = await readContributeState(sessionId);

  if (!state.pendingHint) return null;
  const hint = state.pendingHint;
  // Clear regardless; if the user already contributed, drop the stale nudge.
  await writeContributeState(sessionId, { ...state, pendingHint: undefined });

  return state.contributed ? null : hint;
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

  // Hooks of older installs still call this command in every project; a
  // directory without teamai has no team to share with (#748). The session's
  // cwd, never the one this process started in; a removed worktree's session
  // keeps its recorded scope (#810).
  const scopeDir = await hookScopeDir(stdinData.hookData, toolArg ?? 'claude');
  const { resolveConfigForDir } = await import('./config.js');
  const config = await resolveConfigForDir(scopeDir);

  if (!config) {
    log.debug('contribute-check: teamai is not set up here, skipping');

    return;
  }

  // The same gate as the dispatcher's handler: hooks written before it still
  // call this command, and must not nudge towards a `share` that refuses.
  const { contributeHintAllowed } = await import('./skill-content.js');

  if (!(await contributeHintAllowed(scopeDir))) return;

  const { stopStdoutUnsupported } = await import('./utils/tool-names.js');
  const tool = toolArg?.toLowerCase() ?? 'claude';
  const { sessionRun } = await import('./launch-context.js');

  const offer = async () => (await import('./session-share.js')).SessionShare.reminderOffer(config, {
    tool, sessionId: stdinData.sessionId, cwd: stdinData.cwd ?? process.cwd(), run: sessionRun(process.env),
  });

  const { hint } = await contributeCheckForSession(
    stdinData.sessionId,
    stdinData.cwd,
    stdinData.transcriptPath,
    stopStdoutUnsupported(tool),
    offer,
    config,
  );

  if (hint !== null) {
    const { formatStopHookOutput } = await import('./utils/hook-output.js');
    process.stdout.write(formatStopHookOutput(relayWhenHidden(hint, tool), tool));
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

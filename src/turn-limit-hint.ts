import path from 'node:path';
import fs from 'node:fs';

// ─── Turn-limit hint data flow ──────────────────────────
//
//  UserPromptSubmit hook (matcher: '*')
//      │
//      ▼
//  Record ~/.teamai/sessions/<sid>-turn-count.json
//      │     → count + 1
//      │     → prompt contains mute keyword? → set muted=true
//      │     → count reaches a reminder interval? → set pending=true
//      │
//      ▼
//  Stop hook (matcher: '*')
//      │
//      ├─ pending=true → return user-visible Stop output
//      └─ dispatcher selects this output → clear pending=true
//

/** TTL for the per-session cache. Older sessions are treated as fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Default turn limit before hinting. */
const DEFAULT_TURN_LIMIT = 20;

/** After the limit is reached, schedule a reminder every N turns. */
const HINT_INTERVAL = 3;

/** Keywords that mute the hint for the current session when detected in the user prompt. */
const MUTE_KEYWORDS = [
  '关闭轮次提醒',
  '别再提醒',
  '停止轮次提醒',
  '不再提醒轮次',
  'disable turn hint',
  'stop turn hint',
  'mute turn hint',
  'turn hint off',
];

interface TurnLimitCache {
  count: number;
  muted: boolean;
  /** A due reminder that has not yet been selected for Stop-hook delivery. */
  pending: boolean;
  updatedAt: string;
}

/**
 * Resolve the turn limit from TEAMAI_TURN_LIMIT env var.
 * Falls back to 20 for unset or invalid values.
 */
export function resolveTurnLimit(): number {
  const raw = process.env.TEAMAI_TURN_LIMIT;
  if (raw === undefined) return DEFAULT_TURN_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TURN_LIMIT;
  return Math.floor(n);
}

/** Returns true when the turn-limit hint is explicitly disabled. */
export function isTurnHintDisabled(): boolean {
  return process.env.TEAMAI_TURN_HINT_DISABLED === '1';
}

/**
 * Resolve the cache path for a session. Session IDs originate in hook payloads,
 * so normalize them before using them as a filename to prevent path traversal.
 */
export function getTurnLimitCachePath(sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(
    process.env.HOME ?? '',
    '.teamai',
    'sessions',
    `${safeSessionId}-turn-count.json`,
  );
}

function readCache(sessionId: string): TurnLimitCache | null {
  try {
    const cachePath = getTurnLimitCachePath(sessionId);
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TurnLimitCache>;
    const timestamp = typeof parsed.updatedAt === 'string' ? new Date(parsed.updatedAt).getTime() : NaN;
    const age = Date.now() - timestamp;
    if (!Number.isFinite(timestamp) || age > CACHE_TTL_MS) return null;

    return {
      count: Number.isSafeInteger(parsed.count) && parsed.count! >= 0 ? parsed.count! : 0,
      muted: parsed.muted === true,
      // Older cache files predate pending delivery; treat them as acknowledged.
      pending: parsed.pending === true,
      updatedAt: new Date(timestamp).toISOString(),
    };
  } catch {
    return null;
  }
}

function writeCache(sessionId: string, cache: TurnLimitCache): void {
  try {
    const cachePath = getTurnLimitCachePath(sessionId);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    // best-effort; do not throw
  }
}

/**
 * Check whether the user's prompt contains a mute signal.
 * Case-insensitive for English keywords.
 */
export function isMuteSignal(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return MUTE_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Record a user turn and schedule a reminder for the next Stop hook when due.
 *
 * Reaching the limit, and every HINT_INTERVAL turns thereafter, sets `pending`.
 * The Stop handler owns user-visible delivery and clears that flag only after
 * the dispatcher actually chooses its output. This avoids relying on a model to
 * relay UserPromptSubmit additionalContext.
 */
export function recordTurnAndShouldHint(
  sessionId: string,
  limit: number,
  prompt?: string,
): boolean {
  const cache = readCache(sessionId);
  const count = (cache?.count ?? 0) + 1;
  const wasMuted = cache?.muted ?? false;
  const muted = wasMuted || (prompt ? isMuteSignal(prompt) : false);
  const shouldSchedule = !muted && count >= limit && (count - limit) % HINT_INTERVAL === 0;

  writeCache(sessionId, {
    count,
    muted,
    // Muting takes effect immediately and discards an older undelivered hint.
    pending: muted ? false : (cache?.pending ?? false) || shouldSchedule,
    updatedAt: new Date().toISOString(),
  });

  return shouldSchedule;
}

/** True when this session has a scheduled, user-visible reminder to deliver. */
export function hasPendingTurnLimitHint(sessionId: string): boolean {
  const cache = readCache(sessionId);
  return cache?.pending === true && cache.muted !== true;
}

/**
 * Mark a pending reminder as delivered. Call this only after the dispatcher
 * selects the handler's output for STDOUT; losing an output race must preserve
 * the pending reminder for a later Stop hook.
 */
export function acknowledgeTurnLimitHint(sessionId: string): void {
  const cache = readCache(sessionId);
  if (!cache?.pending) return;

  writeCache(sessionId, {
    ...cache,
    pending: false,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Build the reminder text delivered by the Stop hook.
 *
 * Claude Code already renders Stop-hook feedback to the user. Do not add a
 * "Print this verbatim" instruction here: that instruction makes the model
 * repeat an already-visible feedback message as a second assistant reply.
 */
export function buildTurnLimitHintMessage(): string {
  return [
    '[teamai:turn-limit-hint] 当前会话已进行较多轮对话。',
    '',
    '长会话会累积大量上下文，可能降低响应质量并增加成本。',
    '建议在完成当前任务后，开启新的会话继续后续工作。',
    '如不需要此提醒，请回复"关闭轮次提醒"静默当前会话，或设置环境变量 TEAMAI_TURN_HINT_DISABLED=1 永久关闭。',
  ].join('\n');
}

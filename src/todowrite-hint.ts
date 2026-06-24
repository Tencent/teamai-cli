import path from 'node:path';
import fs from 'node:fs';
import { log } from './utils/logger.js';
import { deriveSessionId } from './utils/session-id.js';

// ─── TodoWrite hint data flow ───────────────────────────
//
//  PostToolUse hook (matcher: 'TodoWrite')
//      │
//      ▼
//  teamai todowrite-hint --stdin --tool <name>
//      │
//      ├─ Honor TEAMAI_RECALL_DISABLED=1 → exit silently
//      ├─ Read STDIN { tool_name, session_id }
//      ├─ Check ~/.teamai/sessions/<sid>-todowrite-hint.json
//      │     → already hinted in this session? → exit
//      │
//      └─ STDOUT JSON { hookSpecificOutput.additionalContext }
//         "Reminder: invoke teamai-recall before starting tasks…"
//

/** TTL for the dedup cache file: 24 hours. Older sessions are treated as fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface TodoWriteHintCache {
  hinted: boolean;
  updatedAt: string;
}

interface HookInput {
  toolName: string;
  sessionId: string;
}

/**
 * Resolve the dedup cache path for a session. Co-located with auto-recall
 * cache files under ~/.teamai/sessions/.
 */
export function getTodoWriteHintCachePath(sessionId: string): string {
  return path.join(
    process.env.HOME ?? '',
    '.teamai',
    'sessions',
    `${sessionId}-todowrite-hint.json`,
  );
}

function readCache(sessionId: string): TodoWriteHintCache | null {
  try {
    const cachePath = getTodoWriteHintCachePath(sessionId);
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as TodoWriteHintCache;
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (age > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(sessionId: string, cache: TodoWriteHintCache): void {
  try {
    const cachePath = getTodoWriteHintCachePath(sessionId);
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  } catch {
    // best-effort; do not throw
  }
}

/**
 * Returns true if a hint should be skipped for this session (already hinted
 * or rate limited). Otherwise marks the session as hinted and returns false.
 */
export function shouldSkipTodoWriteHint(sessionId: string): boolean {
  const cache = readCache(sessionId);
  if (cache?.hinted) return true;

  writeCache(sessionId, { hinted: true, updatedAt: new Date().toISOString() });
  return false;
}

/**
 * Read PostToolUse STDIN JSON and return the minimal fields we care about.
 * Returns null when STDIN is a TTY or JSON cannot be parsed.
 */
export async function readStdin(): Promise<HookInput | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return null;

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : '';
    return { toolName, sessionId: deriveSessionId(data) };
  } catch {
    return null;
  }
}

/**
 * Build the bilingual reminder text emitted via additionalContext.
 *
 * Kept as a small pure function so unit tests can assert on its content
 * without exercising STDIN handling.
 */
export function buildHintMessage(): string {
  return [
    '[teamai:todowrite-hint] 任务已规划。',
    '',
    '请确认本次任务开始前已通过 Agent tool 调用 teamai-recall subagent 完成知识库检索；',
    '如未检索，请立即调用 teamai-recall（一次即可），完成后再继续后续 Todo。',
    '',
    'Task plan detected — confirm you have already invoked the `teamai-recall`',
    'subagent for relevant team knowledge before executing the todo list.',
    'If not, invoke it once now.',
  ].join('\n');
}

/**
 * Entry point for `teamai todowrite-hint --stdin --tool <name>`.
 *
 * Behavior:
 * - Honors TEAMAI_RECALL_DISABLED=1 (silent exit).
 * - Returns immediately when STDIN is missing or tool is not TodoWrite.
 * - Per-session deduplication: at most one hint per session per 24h.
 * - On match, writes a hookSpecificOutput JSON line to STDOUT.
 */
export async function todoWriteHint(): Promise<void> {
  if (process.env.TEAMAI_RECALL_DISABLED === '1') return;

  const input = await readStdin();
  if (!input) {
    log.debug('todowrite-hint: no STDIN data');
    return;
  }

  // Some hosts wire the hook with matcher='*' instead of 'TodoWrite' — in that
  // case we self-filter to keep the hint focused.
  if (input.toolName !== 'TodoWrite') return;

  if (shouldSkipTodoWriteHint(input.sessionId)) {
    log.debug(`todowrite-hint: already hinted in session ${input.sessionId}`);
    return;
  }

  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: buildHintMessage(),
    },
  });
  process.stdout.write(hookOutput + '\n');
}

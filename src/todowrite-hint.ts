import path from 'node:path';
import fs from 'node:fs';
import { readRegularFileSync } from '@teamai/shared/regular-file';
import { z } from 'zod';
import { HookStdinSchema, stdinString, type HookStdin } from './hook-dispatch.js';
import { log } from '@teamai/shared/log';
import { deriveSessionId } from './utils/session-id.js';
import { getUserHome } from '@teamai/shared/home';
import { DefaultFolders, type DefaultFolder, type TextLanguage } from './default-folders.js';

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

const TodoWriteHintCacheSchema = z.object({ hinted: z.boolean(), updatedAt: z.string() });

type TodoWriteHintCache = z.infer<typeof TodoWriteHintCacheSchema>;

interface HookInput {
  toolName: string;
  sessionId: string;
  payload: HookStdin;
}

/**
 * Resolve the dedup cache path for a session. Co-located with the recall
 * quality cache under ~/.teamai/sessions/.
 */
export function getTodoWriteHintCachePath(sessionId: string): string {
  return path.join(
    getUserHome(),
    '.teamai',
    'sessions',
    `${sessionId}-todowrite-hint.json`,
  );
}

function readCache(sessionId: string): TodoWriteHintCache | null {
  try {
    const cachePath = getTodoWriteHintCachePath(sessionId);

    if (!fs.existsSync(cachePath)) return null;
    const raw = readRegularFileSync(cachePath, 'utf-8');
    const cache = TodoWriteHintCacheSchema.safeParse(JSON.parse(raw));

    if (!cache.success) return null;
    const parsed = cache.data;
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
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');

  if (!raw.trim()) return null;

  try {
    const stdin = HookStdinSchema.safeParse(JSON.parse(raw));

    if (!stdin.success) return null;
    const data = stdin.data;
    const toolName = stdinString(data, 'tool_name') ?? '';

    return { toolName, sessionId: deriveSessionId(data), payload: data };
  } catch {
    return null;
  }
}

/** The reminder emitted via additionalContext: `message.md` of `hook`, or `message.en.md` when language is `en`. */
export function buildHintMessage(hook: DefaultFolder<'hooks', 'teamai-todowrite-hint'>, language?: TextLanguage): string {
  return hook.text('message', language).render({});
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
export async function todoWriteHint(tool?: string): Promise<void> {
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

  // The scope a hook finds, project over user: its teamai.yaml `language` and its replacement of the hint apply. A
  // lookup failure keeps teamai's historical bilingual text.
  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const { loadTeamAgentLanguage } = await import('./config.js');
  const scope = await resolveHookConfig(input.payload, tool ?? 'claude').catch(() => null);
  const language = await loadTeamAgentLanguage(scope).catch(() => undefined);

  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: buildHintMessage(await DefaultFolders.load({ kind: 'hooks', name: 'teamai-todowrite-hint' }, scope), language),
    },
  });

  process.stdout.write(hookOutput + '\n');
}

/**
 * Antigravity CLI (`agy` / `antigravity`) lifecycle-hook adapter.
 *
 * Antigravity keeps its lifecycle hooks in a `hooks.json` whose shape differs
 * from every settings-based tool teamai already writes:
 *
 *   - The file is keyed by *hook name* (a user-defined block), not by event.
 *   - Each block carries the events (`PreToolUse`, `PostToolUse`,
 *     `PreInvocation`, `PostInvocation`, `Stop`) instead of the other way
 *     round.
 *   - The tool events hold matcher groups (`{ matcher, hooks: [...] }`), while
 *     the invocation/stop events hold a flat command array.
 *
 * Because of that, the generic `reconcileHooks` renderer (Claude's flat
 * matcher array) cannot express it, and this adapter owns the format instead —
 * the same split as `dsh-hooks.ts`, `omp-hooks.ts` and `pi-hooks.ts`.
 *
 * Ownership contract (TASK_SPEC §4.1): teamai owns exactly ONE top-level key,
 * `teamai-hooks`, and deep-merges it. Every other key in the file belongs to
 * the user (`plan-readonly-guard`, `dangerous-commands-guard`, ...) and is
 * preserved byte-for-byte — never overwritten, never removed. `teamai hooks
 * remove` / `pull --remove-all` deletes only that one key.
 *
 * The file teamai manages is the one the CLI actually executes: the
 * `hooks.json` of a customization root — `<project>/.agents/hooks.json`, or
 * `~/.gemini/config/hooks.json` in user scope (see toolPaths.antigravity).
 * Verified against agy 1.3.4: it loads every hooks.json it finds (and dedupes
 * by hook name across them) but only runs the handlers of the global root's
 * file; the CLI's app-data copy (`~/.gemini/antigravity-cli/hooks.json`) is
 * read and discarded.
 */

import type { HookDef } from './types.js';
import { pathExists, readFileSafe, writeFile } from './utils/fs.js';
import { log } from './utils/logger.js';
import { getAntigravityDispatchCommand } from './builtin-hooks.js';

/** The single top-level hooks.json key teamai owns. */
export const TEAMAI_ANTIGRAVITY_HOOKS_KEY = 'teamai-hooks';

/** One command entry inside an Antigravity hook block. */
export interface AntigravityHookCommand {
  command?: string;
  type?: string;
  timeout?: number;
}

/** A matcher group for the tool events (`PreToolUse` / `PostToolUse`). */
export interface AntigravityMatcherGroup {
  matcher?: string;
  hooks: AntigravityHookCommand[];
}

/** The events an Antigravity hook block can carry. */
export interface AntigravityHookBlock {
  enabled?: boolean;
  SessionStart?: AntigravityHookCommand[];
  PreToolUse?: AntigravityMatcherGroup[];
  PostToolUse?: AntigravityMatcherGroup[];
  PreInvocation?: AntigravityHookCommand[];
  PostInvocation?: AntigravityHookCommand[];
  Stop?: AntigravityHookCommand[];
}

/**
 * The whole file: hook name → block. Values are `unknown` on read so a file a
 * user hand-edited (or a newer Antigravity) round-trips unchanged.
 */
export type AntigravityHookConfig = Record<string, unknown>;

/**
 * Claude PascalCase event → the Antigravity block that carries it.
 *
 * Antigravity has a `SessionStart` event of its own (once per new session), so
 * the session-start dispatch rides it rather than `PreInvocation`, which fires
 * before *every* model call: verified against agy 1.3.4, where a `SessionStart`
 * handler ran once in a session whose `PreInvocation` handler ran on each
 * invocation. `UserPromptSubmit` has no equivalent and rides `PreInvocation`
 * (an idempotent prompt-submit dispatch, as on the other adapter tools).
 * `PreToolUse` is listed for completeness even though teamai ships no built-in
 * for it.
 */
const EVENT_TO_BLOCK: Readonly<Record<string, keyof AntigravityHookBlock>> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'PreInvocation',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};

/** Blocks whose shape is a matcher group, not a bare command entry. */
const MATCHER_BLOCK_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an Antigravity hooks.json. A missing file, or one that does not hold a
 * JSON object, reads as `{}` — the merge then starts from the user's own keys
 * (none) instead of throwing away a file we failed to parse.
 */
export async function readAntigravityHooks(filePath: string): Promise<AntigravityHookConfig> {
  const raw = await readFileSafe(filePath);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`Antigravity hooks at ${filePath} are not valid JSON (${(err as Error).message}); leaving the file untouched.`);
    return {};
  }
  if (!isRecord(parsed)) {
    log.warn(`Antigravity hooks at ${filePath} do not hold a JSON object; leaving the file untouched.`);
    return {};
  }
  return parsed;
}

/**
 * Render teamai's hook defs into one Antigravity hook block.
 *
 * Defs teamai has no Antigravity event for are dropped rather than written
 * under a guessed name, so an unsupported built-in can never make Antigravity
 * reject the whole block.
 */
export function renderAntigravityHooks(defs: readonly HookDef[], tool = 'antigravity'): AntigravityHookBlock {
  const matcherGroups: Record<'PreToolUse' | 'PostToolUse', AntigravityMatcherGroup[]> = {
    PreToolUse: [],
    PostToolUse: [],
  };
  const flatCommands: Record<'SessionStart' | 'PreInvocation' | 'PostInvocation' | 'Stop', AntigravityHookCommand[]> = {
    SessionStart: [],
    PreInvocation: [],
    PostInvocation: [],
    Stop: [],
  };
  for (const def of defs) {
    const target = EVENT_TO_BLOCK[def.event];
    if (target === undefined) continue;
    const command = def.command || getAntigravityDispatchCommand(def.event, tool, def.matcher);
    const entry: AntigravityHookCommand = {
      command,
      type: 'command',
      ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
    };
    if (MATCHER_BLOCK_EVENTS.has(target)) {
      const block = target as 'PreToolUse' | 'PostToolUse';
      matcherGroups[block].push({ matcher: def.matcher && def.matcher !== '*' ? def.matcher : '*', hooks: [entry] });
    } else {
      flatCommands[target as 'SessionStart' | 'PreInvocation' | 'PostInvocation' | 'Stop'].push(entry);
    }
  }
  const block: AntigravityHookBlock = { enabled: true };
  for (const [name, groups] of Object.entries(matcherGroups) as Array<['PreToolUse' | 'PostToolUse', AntigravityMatcherGroup[]]>) {
    if (groups.length > 0) block[name] = groups;
  }
  for (const [name, commands] of Object.entries(flatCommands) as Array<['SessionStart' | 'PreInvocation' | 'PostInvocation' | 'Stop', AntigravityHookCommand[]]>) {
    if (commands.length > 0) block[name] = commands;
  }
  return block;
}

/**
 * Merge teamai's block into an existing config.
 *
 * Only `teamai-hooks` is replaced; every other key is carried over verbatim,
 * so a user's own blocks survive an inject, a re-inject and an upgrade. The
 * input is never mutated.
 */
export function mergeTeamaiAntigravityHooks(
  existing: AntigravityHookConfig,
  defs: readonly HookDef[],
  tool = 'antigravity',
): AntigravityHookConfig {
  const merged: AntigravityHookConfig = { ...existing };
  const block = renderAntigravityHooks(defs, tool);
  if (Object.keys(block).some((k) => k !== 'enabled')) {
    merged[TEAMAI_ANTIGRAVITY_HOOKS_KEY] = block;
  } else {
    delete merged[TEAMAI_ANTIGRAVITY_HOOKS_KEY];
  }
  return merged;
}

/** Strip teamai's block, keeping every other key. The input is never mutated. */
export function removeTeamaiAntigravityHooks(existing: AntigravityHookConfig): AntigravityHookConfig {
  const remaining: AntigravityHookConfig = { ...existing };
  delete remaining[TEAMAI_ANTIGRAVITY_HOOKS_KEY];
  return remaining;
}

/** Whether a config still holds teamai's block (used to decide "changed"). */
function hasTeamaiBlock(config: AntigravityHookConfig): boolean {
  return config[TEAMAI_ANTIGRAVITY_HOOKS_KEY] !== undefined;
}

/** Stable key order so an unchanged re-inject writes nothing. */
function serialize(config: AntigravityHookConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface AntigravityHookReconcileOptions {
  /** Remove teamai's block instead of injecting it. */
  removeAll?: boolean;
}

/**
 * Inject or remove teamai's hooks in one Antigravity hooks.json.
 *
 * Idempotent: the merged result is compared against the file on disk, so a
 * second inject over an already-current file writes nothing. Returns whether
 * the file was written.
 */
export async function reconcileAntigravityHooks(
  filePath: string,
  defs: readonly HookDef[],
  opts: AntigravityHookReconcileOptions = {},
): Promise<boolean> {
  const existing = await readAntigravityHooks(filePath);
  const next = opts.removeAll
    ? removeTeamaiAntigravityHooks(existing)
    : mergeTeamaiAntigravityHooks(existing, defs);

  if (opts.removeAll && !hasTeamaiBlock(existing)) {
    // Nothing of ours to remove. If the file does not exist, do not create one
    // just to hold the user's (empty) state back.
    if (!await pathExists(filePath)) return false;
  }

  const before = await readFileSafe(filePath);
  const after = serialize(next);
  if (before === after) return false;

  await writeFile(filePath, after);
  return true;
}

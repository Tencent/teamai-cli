/**
 * `teamai hook-dispatch <event> --tool <tool> --team-hooks` for the tools whose
 * built-in bridge is user-wide: OpenCode and OMP.
 *
 * Their bridges run in every session on the machine, so a project's team hooks
 * cannot be baked into the bridge. The dispatcher resolves the project from the
 * hook payload's `cwd` (project over user scope, as `resolveHookConfig` does
 * everywhere), reads the team's `hooks/hooks.yaml` live, and runs the hooks
 * that match the event, matcher and tool. Stdout carries only the hooks'
 * output; stderr carries their diagnostics. Exit 2 keeps its blocking meaning.
 *
 * Codex keeps its own index-based dispatcher (`codex-team-hooks.ts`): its
 * project file can hold entries teamai does not own, so the hooks are recorded
 * when pull decides how to place them.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { mergeHookOutputs } from './hook-dispatch.js';
import { setStderrOnly } from './utils/logger.js';
import { areTeamHooksDisabled } from './types.js';
import type { BridgeTeamHook } from './team-hook-bridges.js';

/** The payload fields a matcher selects, as the built-in hooks use them. */
const MATCHED_FIELD: Record<string, string> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  UserPromptSubmit: 'prompt',
};

/** Tools whose bridge can call this dispatcher. */
export const LIVE_TEAM_HOOK_TOOLS: readonly string[] = ['opencode', 'omp'];

/** A hook run: its exit status, and what it wrote. */
export interface TeamHookRun {
  hook: BridgeTeamHook;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface TeamHooksResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Whether `def`'s matcher selects this payload. A non tool event has none. */
function matches(def: BridgeTeamHook, event: string, payload: Record<string, unknown>): boolean {
  const matcher = def.matcher;
  if (!matcher || matcher === '*') return true;
  const field = MATCHED_FIELD[event];
  if (!field) return true;
  const value = payload[field];
  if (typeof value !== 'string') return false;
  // The bridge hosts name tools in lowercase (`bash`), while a team hook may
  // carry Claude's spelling (`Bash`); a literal comparison ignores case, and a
  // regex is applied case-insensitively for the same reason.
  try {
    return new RegExp(`^(?:${matcher})$`, 'i').test(value);
  } catch {
    return value.toLowerCase() === matcher.toLowerCase();
  }
}

/** Run one team hook as the bridge would: through a shell, in `cwd`, payload on stdin. */
function runHook(hook: BridgeTeamHook, payload: string, cwd: string | undefined): Promise<TeamHookRun> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null, timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ hook, code, stdout, stderr, timedOut });
    };
    const child = spawn(hook.command, { shell: true, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: group });
    const timer = setTimeout(() => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(null, true);
    }, (hook.timeout ?? 600) * 1000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (e) => { stderr += e.message; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin?.on('error', () => {});
    child.stdin?.end(payload);
  });
}

/**
 * The team hooks `tool` runs for `event` at the payload's project, already
 * filtered. Empty when no config resolves, or the team's hooks do not resolve.
 */
async function matchingHooks(
  tool: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<BridgeTeamHook[]> {
  // The kill switch applies at run time too: it must stop already-applied hooks.
  if (areTeamHooksDisabled()) return [];
  const { resolveHookConfig } = await import('./dashboard-collector.js');
  const localConfig = await resolveHookConfig(payload, tool);
  if (!localConfig) return [];
  // Only what a pull applied runs: the reconcile recorded these after the
  // team-hook security gates, so a held-back, disabled, non-whitelisted or
  // just-checked-out hook is absent here (#1492 review).
  const { appliedTeamHooksFor } = await import('./team-hook-bridges.js');
  // parseStdin normalizes the CLI's kebab event to the PascalCase one team
  // hooks are written with (`session-start` → `SessionStart`).
  const teamEvent = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : event;
  return (await appliedTeamHooksFor(tool, localConfig))
    .filter((hook) => hook.event === teamEvent && matches(hook, teamEvent, payload));
}

/**
 * Run this project's matching team hooks for `event`, the way the bridge would:
 * the raw payload goes to each hook on stdin, its cwd bounds where it runs, and
 * its timeout is its own. Returns the merged output and the blocking decision
 * without writing anything, so tests and the CLI share one path.
 */
export async function runTeamHooksFor(
  tool: string,
  event: string,
  raw: string,
  payload: Record<string, unknown>,
): Promise<TeamHooksResult> {
  const hooks = await matchingHooks(tool, event, payload);
  if (hooks.length === 0) return { code: 0, stdout: '', stderr: '' };
  const cwd = typeof payload.cwd === 'string' && payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : undefined;
  const runs = await Promise.all(hooks.map((hook) => runHook(hook, raw, cwd)));
  let stderr = '';
  for (const run of runs) {
    if (run.timedOut) stderr += `teamai: team hook ${run.hook.id} timed out after ${run.hook.timeout ?? 600}s\n`;
    if (run.stderr.trim()) stderr += run.stderr;
  }
  if (runs.some((run) => run.code === 2)) return { code: 2, stdout: '', stderr };
  return { code: 0, stdout: mergeRuns(runs.filter((run) => run.code === 0 && run.stdout.trim()).map((run) => contextOf(run.stdout)).filter((text) => text.trim())), stderr };
}

/**
 * The context a team hook wrote. A hook that follows Claude's output contract
 * puts it in `hookSpecificOutput.additionalContext`; a JSON control payload
 * with no context contributes nothing, and plain text (the common case for a
 * team hook that prints a ruleset) is used as is.
 */
function contextOf(output: string): string {
  try {
    const parsed = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const context = parsed?.hookSpecificOutput?.additionalContext;
    return typeof context === 'string' ? context : '';
  } catch {
    return output;
  }
}

/**
 * Hook outputs joined for the context channel: JSON hook outputs are merged
 * the way the built-in dispatcher merges them, plain text (a team hook that
 * prints context) is concatenated instead of keeping only the first hook.
 */
function mergeRuns(outputs: string[]): string {
  if (outputs.length === 0) return '';
  if (outputs.length === 1) return outputs[0];
  try {
    for (const output of outputs) JSON.parse(output);
    return mergeHookOutputs(outputs) ?? '';
  } catch {
    return outputs.map((output) => output.trimEnd()).join('\n');
  }
}

/**
 * The CLI entry: read the hook payload, run the project's team hooks and pass
 * their output through. STDOUT carries only the hooks' output.
 */
export async function runLiveTeamHooksDispatcher(tool: string, event: string): Promise<number> {
  setStderrOnly(true);
  const { readStdin, parseStdin } = await import('./hook-dispatch-cli.js');
  const raw = await readStdin();
  const payload = parseStdin(raw, event);
  const result = await runTeamHooksFor(tool, event, raw, payload);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) await new Promise<void>((resolve) => process.stdout.write(result.stdout, () => resolve()));
  return result.code;
}

import path from 'node:path';
import { getDispatchCommand } from './builtin-hooks.js';
import { hookAdapterDir } from './locate.js';
import { bridgedTeamHookEvents } from './bridged-team-hooks.js';
import { readJsonObject, writeJsonAtomic } from './utils/fs.js';

/**
 * Antigravity CLI, the Antigravity app and Antigravity IDE all load `~/.gemini/config/hooks.json`, an object of
 * named hooks. teamai owns the one named `teamai` and leaves every other name alone.
 */
const HOOK_NAME = 'teamai';

export function agyHookFile(): string {
  return path.join(hookAdapterDir('agy-hooks'), 'hooks.json');
}

/** agy runs a hook command with `sh -c`, or `cmd /c` on Windows, where the POSIX wrapper has no shell to run in. */
function dispatchCommand(event: string): string {
  return process.platform === 'win32' ? `teamai hook-dispatch ${event} --tool agy` : getDispatchCommand(event, 'agy');
}

/** The time the built-in pass gets, and every event at least. */
const BUILTIN_TIMEOUT = 60;

/**
 * teamai's named hook: the built-in events, and PreToolUse only when a team
 * or agent hook needs it, since it runs before every tool call. Each event
 * waits as long as the slowest team hook on it (`team`: Claude event to
 * seconds), as each entry also runs the team's hooks.
 */
function teamaiHook(team: ReadonlyMap<string, number>): Record<string, unknown> {
  const command = (event: string, claudeEvent: string) => ({
    type: 'command', command: dispatchCommand(event), timeout: Math.max(BUILTIN_TIMEOUT, team.get(claudeEvent) ?? 0),
  });
  return {
    SessionStart: [command('session-start', 'SessionStart')],
    PreInvocation: [command('prompt-submit', 'UserPromptSubmit')],
    ...(team.has('PreToolUse') ? { PreToolUse: [{ matcher: '*', hooks: [command('pre-tool-use', 'PreToolUse')] }] } : {}),
    PostToolUse: [{ matcher: '*', hooks: [command('post-tool-use', 'PostToolUse')] }],
    Stop: [command('stop', 'Stop')],
  };
}

/** Write teamai's named hook, or remove it with `removeAll`. A hooks.json that is not a JSON object is left as it is. */
export async function reconcileAgyHooks(options: { removeAll?: boolean } = {}): Promise<void> {
  const file = agyHookFile();
  const read = await readJsonObject(file);
  if (read.kind === 'invalid') throw new Error(`${file} is not valid JSON (${read.error}); fix it so teamai can add its hooks.`);
  const hooks = read.kind === 'ok' ? read.value : {};
  if (options.removeAll) {
    if (!(HOOK_NAME in hooks)) return;
    delete hooks[HOOK_NAME];
  } else {
    hooks[HOOK_NAME] = teamaiHook(await bridgedTeamHookEvents('agy'));
  }
  await writeJsonAtomic(file, hooks);
}

/** Whether hooks.json carries teamai's named hook. */
export async function hasAgyHooks(): Promise<boolean> {
  const read = await readJsonObject(agyHookFile());
  return read.kind === 'ok' && HOOK_NAME in read.value;
}

import path from 'node:path';
import { getDispatchCommand } from './builtin-hooks.js';
import { pathExists, readFileSafe, remove, writeFile } from './utils/fs.js';
import { getUserHome } from './utils/home.js';

/** Kiro CLI V3 loads user hook files independently of the selected agent. */
export function kiroHookFile(): string {
  return path.join(getUserHome(), '.kiro', 'hooks', 'teamai.json');
}

export function buildKiroHooks(): string {
  return JSON.stringify({ version: 'v1', hooks: [{
    name: 'teamai-session-start', trigger: 'SessionStart', enabled: true,
    action: { type: 'command', command: getDispatchCommand('session-start', 'kiro') }, timeout: 30,
  }] }, null, 2) + '\n';
}

export async function ownsKiroHooks(): Promise<boolean> {
  const content = await readFileSafe(kiroHookFile());
  if (content === null) return false;
  try {
    const parsed = JSON.parse(content) as { hooks?: { name?: string; action?: { command?: string } }[] };
    return Array.isArray(parsed.hooks) && parsed.hooks.some(hook => hook?.name === 'teamai-session-start'
      && typeof hook.action?.command === 'string' && hook.action.command.includes('hook-dispatch session-start --tool kiro'));
  } catch {
    return false;
  }
}

export async function hasKiroHooks(): Promise<boolean> {
  return await readFileSafe(kiroHookFile()) === buildKiroHooks();
}

export async function injectKiroHooks(): Promise<void> {
  if (!await pathExists(path.join(getUserHome(), '.kiro'))) return;
  if (await pathExists(kiroHookFile()) && !await ownsKiroHooks()) {
    throw new Error(`${kiroHookFile()} is not owned by teamai; move it aside before injecting hooks.`);
  }
  await writeFile(kiroHookFile(), buildKiroHooks());
}

export async function removeKiroHooks(): Promise<void> {
  if (await ownsKiroHooks()) await remove(kiroHookFile());
}

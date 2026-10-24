import path from 'node:path';
import { getDispatchCommand } from './builtin-hooks.js';
import { listFiles, pathExists, readFileSafe, readJsonObject, remove, writeFile } from './utils/fs.js';
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

export async function injectKiroHooks(projectRoot?: string): Promise<void> {
  if (!await pathExists(path.join(getUserHome(), '.kiro'))) return;
  if (await pathExists(kiroHookFile()) && !await ownsKiroHooks()) {
    throw new Error(`${kiroHookFile()} is not owned by teamai; move it aside before injecting hooks.`);
  }
  // An edited agent is intentionally kept by pull. Retire only our exact old
  // agentSpawn command before enabling V3's shared hook; keep every private field.
  const dirs = new Set([path.join(getUserHome(), '.kiro', 'agents'),
    ...projectRoot ? [path.join(projectRoot, '.kiro', 'agents')] : []]);
  for (const dir of dirs) {
    for (const name of await listFiles(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const read = await readJsonObject(file);
      if (read.kind !== 'ok') continue;
      const hooks = read.value.hooks;
      if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) continue;
      const map = hooks as Record<string, unknown>;
      if (!Array.isArray(map.agentSpawn)) continue;
      const remaining = map.agentSpawn.filter((entry: unknown) => typeof entry !== 'object' || entry === null
        || !('command' in entry) || entry.command !== getDispatchCommand('session-start', 'kiro'));
      if (remaining.length === map.agentSpawn.length) continue;
      if (remaining.length) map.agentSpawn = remaining;
      else delete map.agentSpawn;
      if (Object.keys(map).length === 0) delete read.value.hooks;
      await writeFile(file, JSON.stringify(read.value, null, 2) + '\n');
    }
  }
  await writeFile(kiroHookFile(), buildKiroHooks());
}

export async function removeKiroHooks(): Promise<void> {
  if (await ownsKiroHooks()) await remove(kiroHookFile());
}

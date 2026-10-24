import { afterEach, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { getDispatchCommand } from '../builtin-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { TeamaiConfigSchema } from '../types.js';

afterEach(() => vi.unstubAllEnvs());

it('removes only the legacy teamai agentSpawn entry from member-edited agents', async () => {
  const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kiro-migration-'));
  vi.stubEnv('HOME', home);
  const file = path.join(home, '.kiro/agents/reviewer.json');
  const member = { name: 'reviewer', prompt: 'Member changed instructions', hooks: { agentSpawn: [{ command: getDispatchCommand('session-start', 'kiro') }, { command: 'echo personal' }], stop: [{ command: 'echo stop' }] } };
  try {
    await fse.outputJson(file, member);
    const { injectKiroHooks } = await import('../kiro-hooks.js');
    await injectKiroHooks();
    expect(await fse.readJson(file)).toEqual({ ...member, hooks: { agentSpawn: [{ command: 'echo personal' }], stop: [{ command: 'echo stop' }] } });
  } finally { await fse.remove(home); }
});

it('installs Kiro V3 SessionStart independently of custom agents and removes only its own file', async () => {
  const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kiro-hooks-'));
  vi.stubEnv('HOME', home);
  const file = path.join(home, '.kiro/hooks/teamai.json');
  const paths = TeamaiConfigSchema.parse({ team: 't', repo: 'x' }).toolPaths;
  try {
    await fse.ensureDir(path.join(home, '.kiro'));
    await reconcileHooksToAllTools(paths, home, [], '', { filterAgents: ['kiro'] });
    expect(await fse.pathExists(file)).toBe(true);
    expect(await fse.readJson(file)).toMatchObject({ version: 'v1', hooks: [{ name: 'teamai-session-start', trigger: 'SessionStart', enabled: true, action: { type: 'command', command: expect.stringContaining('--tool kiro') } }] });
    await reconcileHooksToAllTools(paths, home, [], '', { filterAgents: ['kiro'], removeAll: true });
    expect(await fse.pathExists(file)).toBe(false);
    await fse.outputFile(file, '{"version":"v1","hooks":[{"name":"personal"}]}\n');
    const personal = await fse.readFile(file, 'utf8');
    await reconcileHooksToAllTools(paths, home, [], '', { filterAgents: ['kiro'] });
    await reconcileHooksToAllTools(paths, home, [], '', { filterAgents: ['kiro'], removeAll: true });
    expect(await fse.readFile(file, 'utf8')).toBe(personal);
  } finally {
    await fse.remove(home);
  }
});

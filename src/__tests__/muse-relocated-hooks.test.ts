import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { channelReadiness } from '../instruction-targets.js';
import { TeamaiConfigSchema } from '../types.js';
import { hookSettingsPath } from '../types.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { saveToolHomes } from '../tool-home.js';

let home: string;
let moved: string;
beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-muse-hooks-'));
  moved = path.join(home, 'xdg', 'muse');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.dirname(moved));
});
afterEach(async () => { vi.unstubAllEnvs(); await fse.remove(home); });

it('injects and removes hooks in Muse\'s XDG settings while keeping personal entries and the old home', async () => {
  const active = path.join(moved, 'settings.json');
  const old = path.join(home, '.config/muse/settings.json');
  await fse.outputJson(active, { model: 'personal', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo personal' }] }] } });
  await fse.outputFile(old, '{"model":"old-personal"}\n');
  const paths = { muse: { settings: '.config/muse/settings.json' } };
  const manifest = path.join(home, '.teamai/managed-hooks.json');
  await reconcileHooksToAllTools(paths, home, [], manifest);
  expect(await fse.readFile(active, 'utf8')).toContain('hook-dispatch session-start');
  const context = { teamConfig: TeamaiConfigSchema.parse({ team: 'Fixture', repo: 'fixture/team' }), localConfig: { repo: { localPath: path.join(home, 'team'), remote: 'fixture/team' }, username: 'fixture', scope: 'project' as const, projectRoot: path.join(home, 'project'), additionalRoles: [] } };
  expect((await channelReadiness('muse', 'muse-session-start', context)).ready).toBe(true);
  expect(await fse.readFile(old, 'utf8')).toBe('{"model":"old-personal"}\n');
  await reconcileHooksToAllTools(paths, home, [], manifest, { removeAll: true });
  const remaining = await fse.readFile(active, 'utf8');
  expect(remaining).not.toContain('hook-dispatch');
  expect(remaining).toContain('echo personal');
  expect((await fse.readJson(active)).model).toBe('personal');
});

it('uses a recorded home when XDG is absent or disagrees', async () => {
  await saveToolHomes({ muse: moved });
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'other'));
  expect(hookSettingsPath('muse', home, '.config/muse/settings.json')).toBe(path.join(moved, 'settings.json'));
  vi.stubEnv('XDG_CONFIG_HOME', '');
  expect(hookSettingsPath('muse', home, '.config/muse')).toBe(moved);
});

it('keeps self/project and custom settings paths at their configured locations', () => {
  const project = path.join(home, 'project');
  expect(hookSettingsPath('muse', project, '.muse/hooks.json')).toBe(path.join(project, '.muse/hooks.json'));
  expect(hookSettingsPath('muse', home, 'custom/hooks.json')).toBe(path.join(home, 'custom/hooks.json'));
});

it('does not recreate a missing moved home even when the default home exists', async () => {
  await fse.ensureDir(path.join(home, '.config/muse'));
  const project = path.join(home, 'project');
  await fse.ensureDir(path.join(project, '.config/muse'));
  await reconcileHooksToAllTools({ muse: { settings: '.config/muse/settings.json' } }, home, [], path.join(home, 'manifest.json'), { installedBaseDir: project });
  expect(await fse.pathExists(moved)).toBe(false);
  expect(await fse.pathExists(path.join(home, '.config/muse/settings.json'))).toBe(false);
});

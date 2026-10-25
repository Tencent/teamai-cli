import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hookSettingsPath } from '../types.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { saveToolHomes } from '../tool-home.js';

let home: string;
let moved: string;
beforeEach(async () => {
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codebuddy-hooks-'));
  moved = path.join(home, 'moved-codebuddy');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);
});
afterEach(async () => { vi.unstubAllEnvs(); await fse.remove(home); });

it('injects and removes hooks in CodeBuddy\'s CODEBUDDY_CONFIG_DIR settings while keeping personal entries and the old home', async () => {
  const active = path.join(moved, 'settings.json');
  const old = path.join(home, '.codebuddy/settings.json');
  await fse.outputJson(active, { model: 'personal', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo personal' }] }] } });
  await fse.outputFile(old, '{"model":"old-personal"}\n');
  const paths = { codebuddy: { settings: '.codebuddy/settings.json' } };
  const manifest = path.join(home, '.teamai/managed-hooks.json');
  await reconcileHooksToAllTools(paths, home, [], manifest);
  expect(await fse.readFile(active, 'utf8')).toContain('hook-dispatch session-start');
  expect(await fse.readFile(old, 'utf8')).toBe('{"model":"old-personal"}\n');
  await reconcileHooksToAllTools(paths, home, [], manifest, { removeAll: true });
  const remaining = await fse.readFile(active, 'utf8');
  expect(remaining).not.toContain('hook-dispatch');
  expect(remaining).toContain('echo personal');
  expect((await fse.readJson(active)).model).toBe('personal');
});

it('uses a recorded home when CODEBUDDY_CONFIG_DIR is absent or disagrees', async () => {
  await saveToolHomes({ codebuddy: moved });
  vi.stubEnv('CODEBUDDY_CONFIG_DIR', path.join(home, 'other'));
  expect(hookSettingsPath('codebuddy', home, '.codebuddy/settings.json')).toBe(path.join(moved, 'settings.json'));
  vi.stubEnv('CODEBUDDY_CONFIG_DIR', '');
  expect(hookSettingsPath('codebuddy', home, '.codebuddy')).toBe(moved);
});

it('keeps self/project and custom settings paths at their configured locations', () => {
  const project = path.join(home, 'project');
  expect(hookSettingsPath('codebuddy', project, '.codebuddy/hooks.json')).toBe(path.join(project, '.codebuddy/hooks.json'));
  expect(hookSettingsPath('codebuddy', home, 'custom/hooks.json')).toBe(path.join(home, 'custom/hooks.json'));
});

it('does not recreate a missing moved home even when the default home exists', async () => {
  await fse.ensureDir(path.join(home, '.codebuddy'));
  const project = path.join(home, 'project');
  await fse.ensureDir(path.join(project, '.codebuddy'));
  await reconcileHooksToAllTools({ codebuddy: { settings: '.codebuddy/settings.json' } }, home, [], path.join(home, 'manifest.json'), { installedBaseDir: project });
  expect(await fse.pathExists(moved)).toBe(false);
  expect(await fse.pathExists(path.join(home, '.codebuddy/settings.json'))).toBe(false);
});

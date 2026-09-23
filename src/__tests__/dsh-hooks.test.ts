import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  DSH_HOOK_CONFIG_FILE,
  DSH_PATCH_FILE,
  resolveDshHooksDir,
} from '../dsh-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import type { HookDef } from '../types.js';

describe('DeepSeek Harness hook bridge', () => {
  let tmp: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dsh-hooks-'));
    home = path.join(tmp, 'home');
    await fse.ensureDir(home);
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fse.remove(tmp);
  });

  const toolPaths = { dsh: { skills: '.dsh/skills' } } as Record<string, { settings?: string }>;
  const manifest = () => path.join(tmp, 'managed-hooks.json');
  const bridgeDir = () => resolveDshHooksDir();
  const hooksFile = () => path.join(bridgeDir(), DSH_HOOK_CONFIG_FILE);
  const patchFile = () => path.join(bridgeDir(), DSH_PATCH_FILE);

  it('does not create the bridge when dsh is not installed', async () => {
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(path.join(home, '.teamai', 'dsh'))).toBe(false);
  });

  it('writes Claude-compatible hooks and a parseable dsh patch when dsh is installed', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());

    const hooks = JSON.parse(await fse.readFile(hooksFile(), 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(hooks.hooks.SessionStart).toBeDefined();
    expect(JSON.stringify(hooks)).toContain('--tool dsh');

    const patch = YAML.parse(await fse.readFile(patchFile(), 'utf8')) as Array<{ insert: Array<{ id: string; name: string; config: { configPath: string } }> }>;
    expect(patch).toEqual([
      {
        insert: [{
          id: 'teamai-hooks-claude-code',
          name: '@deepseek-ai/dsh-hooks-claude-code',
          config: { configPath: hooksFile() },
        }],
      },
    ]);
  });

  it('preserves team hook definitions in the bridge config', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const teamDef: HookDef = {
      source: 'team',
      key: 'team-dsh-test',
      event: 'UserPromptSubmit',
      matcher: '*',
      command: 'echo team-dsh-test',
      description: '[teamai:hook:team-dsh-test] team test',
    };

    await reconcileHooksToAllTools(toolPaths, home, [teamDef], manifest());

    const hooks = JSON.parse(await fse.readFile(hooksFile(), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(hooks.hooks.UserPromptSubmit.some((entry) => entry.hooks[0].command === teamDef.command)).toBe(true);
  });

  it('is idempotent and removes the bridge on removeAll', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    const firstHooks = await fse.readFile(hooksFile(), 'utf8');
    const firstPatch = await fse.readFile(patchFile(), 'utf8');

    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.readFile(hooksFile(), 'utf8')).toBe(firstHooks);
    expect(await fse.readFile(patchFile(), 'utf8')).toBe(firstPatch);

    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(patchFile())).toBe(false);
    expect(JSON.stringify(JSON.parse(await fse.readFile(hooksFile(), 'utf8')))).not.toContain('--tool dsh');
  });

  it('does not touch dsh during a settings-only cleanup', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { settingsOnly: true });
    expect(await fse.pathExists(path.join(home, '.teamai', 'dsh'))).toBe(false);
  });
});

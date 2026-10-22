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
  dshSandboxNote,
  reconcileDshHooks,
  resolveDshHooksDir,
} from '../dsh-hooks.js';
import { log } from '../utils/logger.js';
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
  const homePatchFile = () => path.join(home, '.dsh', DSH_PATCH_FILE);
  const teamaiRow = () => ({
    insert: [{ id: 'teamai-hooks-claude-code', name: '@deepseek-ai/dsh-hooks-claude-code', config: { configPath: hooksFile() } }],
  });

  it('does not create the bridge when dsh is not installed', async () => {
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(path.join(home, '.teamai', 'dsh'))).toBe(false);
  });

  it('writes the bridge where only $DSH_HOME exists, the home dsh runs from (#946)', async () => {
    const dshHome = path.join(tmp, 'dsh-home');
    await fse.ensureDir(dshHome);
    vi.stubEnv('DSH_HOME', dshHome);
    try {
      await reconcileHooksToAllTools(toolPaths, home, [], manifest());
      expect(await fse.pathExists(patchFile())).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not create the bridge where $DSH_HOME does not exist, even with ~/.dsh (#946)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    vi.stubEnv('DSH_HOME', path.join(tmp, 'missing-dsh-home'));
    try {
      await reconcileHooksToAllTools(toolPaths, home, [], manifest());
      expect(await fse.pathExists(patchFile())).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes Claude-compatible hooks and mounts them in the patch dsh applies on every boot (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());

    const hooks = JSON.parse(await fse.readFile(hooksFile(), 'utf8')) as { hooks: Record<string, unknown[]> };
    expect(hooks.hooks.SessionStart).toBeDefined();
    expect(JSON.stringify(hooks)).toContain('--tool dsh');

    expect(YAML.parse(await fse.readFile(homePatchFile(), 'utf8'))).toEqual([teamaiRow()]);
    // A launcher that still passes --patch keeps booting, and loads the hooks once.
    expect(YAML.parse(await fse.readFile(patchFile(), 'utf8'))).toEqual([]);
  });

  it('keeps the member\'s own rows in $DSH_HOME/cordis.patch.yml through pull and uninstall (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const mine = '# my tweaks\n- id: telemetry\n  disabled: true\n';
    await fse.writeFile(homePatchFile(), mine);

    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    const mounted = await fse.readFile(homePatchFile(), 'utf8');
    expect(mounted).toContain('# my tweaks');
    expect(YAML.parse(mounted)).toEqual([{ id: 'telemetry', disabled: true }, teamaiRow()]);

    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.readFile(homePatchFile(), 'utf8')).toBe(mounted);

    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(YAML.parse(await fse.readFile(homePatchFile(), 'utf8'))).toEqual([{ id: 'telemetry', disabled: true }]);
  });

  it('preserves empty member-owned patches during removal when no teamai row is present (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const mine = '# my tweaks\n[]\n';
    await fse.writeFile(homePatchFile(), mine);

    await reconcileDshHooks([], { manifestPath: manifest(), removeAll: true });

    expect(await fse.pathExists(homePatchFile())).toBe(true);
    expect(await fse.readFile(homePatchFile(), 'utf8')).toBe(mine);
  });

  it('preserves member comments after removing the last owned mount (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const mine = '# my tweaks\n[]\n';
    await fse.writeFile(homePatchFile(), mine);

    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.readFile(homePatchFile(), 'utf8')).toContain('# my tweaks');

    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(homePatchFile())).toBe(true);
    const after = await fse.readFile(homePatchFile(), 'utf8');
    expect(after).toContain('# my tweaks');
    expect(YAML.parse(after)).toEqual([]);
  });

  it('preserves inline comments on empty member patches during removal (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const mine = '[] # my tweaks\n';
    await fse.writeFile(homePatchFile(), mine);

    await reconcileHooksToAllTools(toolPaths, home, [], manifest());

    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(homePatchFile())).toBe(true);
    const after = await fse.readFile(homePatchFile(), 'utf8');
    expect(after).toContain('# my tweaks');
    expect(YAML.parse(after)).toEqual([]);
  });

  it('leaves a $DSH_HOME/cordis.patch.yml it cannot parse alone (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    await fse.writeFile(homePatchFile(), 'id: [unclosed\n');
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.readFile(homePatchFile(), 'utf8')).toBe('id: [unclosed\n');
  });

  it('warns and preserves an invalid home patch during removal (#1219)', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    const invalid = 'id: [unclosed\n';
    await fse.writeFile(homePatchFile(), invalid);
    vi.mocked(log.warn).mockClear();

    await reconcileDshHooks([], { manifestPath: manifest(), removeAll: true });

    expect(await fse.readFile(homePatchFile(), 'utf8')).toBe(invalid);
    expect(log.warn).toHaveBeenCalledWith(
      `${homePatchFile()} is not a YAML patch list, so teamai left it as it is and could not remove `
      + "teamai's DeepSeek Harness hooks. Fix the file, then run `teamai hooks remove`.",
    );
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
    expect(await fse.pathExists(homePatchFile())).toBe(false);
    expect(JSON.stringify(JSON.parse(await fse.readFile(hooksFile(), 'utf8')))).not.toContain('--tool dsh');
  });

  it('says when dsh\'s sandbox keeps the hooks that write from writing teamai\'s state (#1219)', async () => {
    const member = { enabledAgents: ['dsh'] } as Parameters<typeof dshSandboxNote>[0];
    expect(await dshSandboxNote(member)).toBeNull();

    await fse.ensureDir(path.join(home, '.dsh'));
    const note = await dshSandboxNote(member);
    expect(note).toContain('DSH_PERMISSION_MODE');
    expect(note).toContain('teamai pull');

    vi.stubEnv('DSH_PERMISSION_MODE', 'danger-full-access');
    try {
      expect(await dshSandboxNote(member)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not touch dsh during a settings-only cleanup', async () => {
    await fse.ensureDir(path.join(home, '.dsh'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { settingsOnly: true });
    expect(await fse.pathExists(path.join(home, '.teamai', 'dsh'))).toBe(false);
  });
});

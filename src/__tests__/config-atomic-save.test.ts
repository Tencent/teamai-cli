import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocalConfig, saveLocalConfig, saveLocalConfigForScope } from '../config.js';
import type { LocalConfig } from '../types.js';
import { log } from '@teamai/shared/log';
import { trySymlink } from './helpers/symlink.js';

// Issue #823 item 14: config.yaml was written in place. Opening it for writing
// truncates it, so a command reading it mid-save saw an empty file, and a
// failed write (ENOSPC, crash) left it empty or half-written.
describe('config.yaml saves are atomic', () => {
  const originalHome = process.env.HOME;
  let home: string;
  let configDir: string;
  let configPath: string;
  let original: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'teamai-atomic-config-'));
    process.env.HOME = home;
    configDir = path.join(home, '.teamai');
    configPath = path.join(configDir, 'config.yaml');
    mkdirSync(configDir, { recursive: true });
    original = 'repo:\n  localPath: /nonexistent/team-repo\n  remote: https://github.com/acme/team.git\nusername: dev\n';
    writeFileSync(configPath, original, 'utf-8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * Every write into the config dir first truncates its target, the state an
   * in-place write exposes between open(O_TRUNC) and the data landing. Then
   * `during` runs (a concurrent reader), and the write either completes or
   * fails with ENOSPC.
   */
  function interruptConfigWrites(during: () => Promise<void>, outcome: 'complete' | 'fail'): void {
    const realWriteFile = fse.writeFile;
    vi.spyOn(fse, 'writeFile').mockImplementation(async (file: unknown, data: unknown) => {
      if (typeof file !== 'string' || typeof data !== 'string') throw new Error('unexpected writeFile call in test');
      if (path.dirname(file) !== configDir) return realWriteFile(file, data, 'utf-8');
      await realWriteFile(file, '', 'utf-8');
      await during();
      if (outcome === 'fail') throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      return realWriteFile(file, data, 'utf-8');
    });
  }

  async function currentConfig(): Promise<LocalConfig> {
    const config = await loadLocalConfig();
    if (!config) throw new Error('expected the fixture config to load');
    return config;
  }

  const savers = [
    ['saveLocalConfig', (config: LocalConfig) => saveLocalConfig(config)],
    ['saveLocalConfigForScope', (config: LocalConfig) => saveLocalConfigForScope(config)],
  ] as const;

  describe.each(savers)('%s', (_name, save) => {
    it('never lets a concurrent reader see an empty or partial config', async () => {
      const config = await currentConfig();
      let seenMidSave: string | undefined;
      interruptConfigWrites(async () => {
        seenMidSave = (await loadLocalConfig())?.username;
      }, 'complete');

      await save({ ...config, username: 'renamed' });

      expect(seenMidSave).toBe('dev');
      expect((await loadLocalConfig())?.username).toBe('renamed');
    });

    it('leaves the previous config intact and no temp file when the write fails', async () => {
      const config = await currentConfig();
      interruptConfigWrites(async () => {}, 'fail');

      await expect(save({ ...config, username: 'renamed' })).rejects.toThrow(/ENOSPC/);

      expect(readFileSync(configPath, 'utf-8')).toBe(original);
      expect(readdirSync(configDir)).toEqual(['config.yaml']);
    });

    it('keeps the mode of an existing config.yaml', async () => {
      chmodSync(configPath, 0o644);

      await save({ ...(await currentConfig()), username: 'renamed' });

      expect(statSync(configPath).mode & 0o777).toBe(0o644);
    });

    it('writes through a symlinked config.yaml and keeps the link', async () => {
      const realPath = path.join(home, 'dotfiles', 'config.yaml');
      mkdirSync(path.dirname(realPath));
      writeFileSync(realPath, original, 'utf-8');
      rmSync(configPath);
      if (!trySymlink(realPath, configPath)) return;

      await save({ ...(await currentConfig()), username: 'renamed' });

      expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(configPath)).toBe(realPath);
      expect(readFileSync(realPath, 'utf-8')).toContain('username: renamed');
      expect(readdirSync(path.dirname(realPath))).toEqual(['config.yaml']);
    });

    it('creates the missing target of a dangling config.yaml link and keeps the link', async () => {
      const config = await currentConfig();
      const linkTarget = path.join('..', 'dotfiles', 'config.yaml');
      const realPath = path.join(home, 'dotfiles', 'config.yaml');
      rmSync(configPath);
      if (!trySymlink(linkTarget, configPath)) return;

      await save({ ...config, username: 'renamed' });

      expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(configPath)).toBe(linkTarget);
      expect(readFileSync(realPath, 'utf-8')).toContain('username: renamed');
      expect(readdirSync(path.dirname(realPath))).toEqual(['config.yaml']);
      expect(readdirSync(configDir)).toEqual(['config.yaml']);
    });

    it('refuses a config.yaml symlink loop and leaves the links alone', async () => {
      const config = await currentConfig();
      const otherLink = path.join(configDir, 'other.yaml');
      rmSync(configPath);
      if (!trySymlink(otherLink, configPath) || !trySymlink(configPath, otherLink)) return;

      await expect(save({ ...config, username: 'renamed' })).rejects.toThrow(/symbolic link loop/);

      expect(readlinkSync(configPath)).toBe(otherLink);
      expect(readlinkSync(otherLink)).toBe(configPath);
      expect(readdirSync(configDir).sort()).toEqual(['config.yaml', 'other.yaml']);
    });
  });

  it('resolves a dangling link against the real directory of a symlinked config dir', async () => {
    const config = await currentConfig();
    const realConfigDir = path.join(home, 'dotfiles', 'teamai');
    mkdirSync(realConfigDir, { recursive: true });
    rmSync(configDir, { recursive: true });
    if (!trySymlink(realConfigDir, configDir)) return;
    if (!trySymlink(path.join('..', 'shared', 'config.yaml'), configPath)) return;

    await saveLocalConfig({ ...config, username: 'renamed' });

    expect(readFileSync(path.join(home, 'dotfiles', 'shared', 'config.yaml'), 'utf-8')).toContain('username: renamed');
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
  });

  it('leaves the config intact and no temp file when the legacy role migration write fails', async () => {
    const repoDir = path.join(home, 'team-repo');
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(
      path.join(repoDir, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [hai] }\n',
      'utf-8',
    );
    original = original.replace('/nonexistent/team-repo', repoDir);
    writeFileSync(configPath, original, 'utf-8');
    vi.spyOn(log, 'error').mockImplementation(() => {});
    interruptConfigWrites(async () => {}, 'fail');

    await loadLocalConfig();

    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(readdirSync(configDir)).toEqual(['config.yaml']);
  });
});

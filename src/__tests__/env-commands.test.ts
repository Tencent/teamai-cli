import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

// Mock external dependencies before importing modules
vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

import { envList, envAdd, envRemove } from '../env-commands.js';
import { requireInit } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('env-commands', () => {
  let tmpDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-cmd-test-'));
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'env'));

    vi.stubEnv('HOME', path.join(tmpDir, 'home'));

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {},
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };

    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
    vi.mocked(log.info).mockClear();
    vi.mocked(log.success).mockClear();
    vi.mocked(log.error).mockClear();
    vi.mocked(log.dim).mockClear();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    consoleSpy.mockRestore();
    await fse.remove(tmpDir);
  });

  // ─── envList ─────────────────────────────────────────────

  describe('envList', () => {
    it('should show message when env.yaml does not exist', async () => {
      await envList({});
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No env variables'));
    });

    it('should show message when env.yaml has no variables', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({ variables: [] }),
      );

      await envList({});
      expect(log.info).toHaveBeenCalledWith('No env variables defined');
    });

    it('should list variables with masked values by default', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'API endpoint' },
            { key: 'TOKEN', value: 'secret' },
          ],
        }),
      );

      await envList({});

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('Team env variables (2)');
      // Default: values should be masked
      expect(allOutput).toContain('API_URL=ht****');
      expect(allOutput).toContain('TOKEN=se****');
      expect(allOutput).not.toContain('https://api.example.com');
    });

    it('should reveal plaintext values when reveal=true', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'API endpoint' },
            { key: 'TOKEN', value: 'secret' },
          ],
        }),
      );

      await envList({ reveal: true });

      const allOutput = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(allOutput).toContain('Team env variables (2)');
      expect(allOutput).toContain('API_URL=https://api.example.com');
      expect(allOutput).toContain('TOKEN=secret');
    });

    it('should show descriptions in verbose mode', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'My API endpoint' },
          ],
        }),
      );

      await envList({ verbose: true });

      expect(log.dim).toHaveBeenCalledWith(expect.stringContaining('My API endpoint'));
    });
  });

  // ─── envAdd ──────────────────────────────────────────────

  describe('envAdd', () => {
    it('should add a new variable locally and show push hint', async () => {
      await envAdd('NEW_VAR', 'new_value', {});

      // Verify env.yaml was written
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0]).toEqual({ key: 'NEW_VAR', value: 'new_value' });

      // Verify success message and push hint
      expect(log.success).toHaveBeenCalledWith('Added env variable: NEW_VAR=new_value');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('should add variable with description', async () => {
      await envAdd('MY_VAR', 'val', { description: 'A test variable' });

      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables[0]).toEqual({
        key: 'MY_VAR',
        value: 'val',
        description: 'A test variable',
      });
    });

    it('should update existing variable locally and show push hint', async () => {
      // Pre-populate env.yaml
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'EXIST_VAR', value: 'old_value' }],
        }),
      );

      await envAdd('EXIST_VAR', 'new_value', {});

      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      const content = await fse.readFile(envYamlPath, 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0].value).toBe('new_value');

      // Verify success message uses "Updated"
      expect(log.success).toHaveBeenCalledWith('Updated env variable: EXIST_VAR=new_value');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('should not write in dry-run mode', async () => {
      await envAdd('DRY_VAR', 'dry_value', { dryRun: true });

      // env.yaml should NOT exist
      const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
      expect(await fse.pathExists(envYamlPath)).toBe(false);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    });
  });

  // ─── envRemove ───────────────────────────────────────────

  describe('envRemove', () => {
    it('should remove existing variable locally and show push hint', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [
            { key: 'KEEP', value: 'a' },
            { key: 'REMOVE_ME', value: 'b' },
          ],
        }),
      );

      await envRemove('REMOVE_ME', {});

      // Verify env.yaml was updated
      const content = await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);
      expect(parsed.variables[0].key).toBe('KEEP');

      // Verify success message and push hint
      expect(log.success).toHaveBeenCalledWith('Removed env variable: REMOVE_ME');
      expect(log.info).toHaveBeenCalledWith('Run `teamai push` to sync to team repo.');
    });

    it('should error when env.yaml does not exist', async () => {
      // Remove the env dir to ensure no env.yaml
      await fse.remove(path.join(repoPath, 'env'));

      await envRemove('MISSING', {});

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    });

    it('should error when variable key does not exist', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'OTHER', value: 'x' }],
        }),
      );

      await envRemove('NONEXIST', {});

      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('"NONEXIST" not found'));
    });

    it('should not modify in dry-run mode', async () => {
      await fse.writeFile(
        path.join(repoPath, 'env', 'env.yaml'),
        YAML.stringify({
          variables: [{ key: 'DRY_VAR', value: 'x' }],
        }),
      );

      await envRemove('DRY_VAR', { dryRun: true });

      // Variable should still be there
      const content = await fse.readFile(path.join(repoPath, 'env', 'env.yaml'), 'utf-8');
      const parsed = YAML.parse(content);
      expect(parsed.variables).toHaveLength(1);

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
    });
  });
});

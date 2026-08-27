import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockAutoDetectInit = vi.fn();
const mockSaveLocalConfigForScope = vi.fn();

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  saveLocalConfigForScope: (...args: unknown[]) => mockSaveLocalConfigForScope(...args),
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
}));

import { recallDisable, recallEnable } from '../recall-toggle.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('recall toggle native agent cleanup', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-toggle-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
    vi.stubEnv('HOME', homeDir);

    const localConfig: LocalConfig = {
      repo: {
        localPath: path.join(tmpDir, 'team-repo'),
        remote: 'https://example.com/test/repo.git',
      },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        codex: { agents: '.codex/agents' },
      },
    } as TeamaiConfig;
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('enable then disable removes the Codex TOML recall agent without leaving an orphan', async () => {
    const tomlAgent = path.join(homeDir, '.codex', 'agents', 'teamai-recall.toml');
    const legacyMarkdownAgent = path.join(homeDir, '.codex', 'agents', 'teamai-recall.md');

    await recallEnable({});
    expect(await fse.pathExists(tomlAgent)).toBe(true);
    await fse.writeFile(legacyMarkdownAgent, 'legacy recall agent');

    await recallDisable({});
    expect(await fse.pathExists(tomlAgent)).toBe(false);
    expect(await fse.pathExists(legacyMarkdownAgent)).toBe(false);
  });

  it('disable preserves non-agent files that only share the recall stem', async () => {
    const backup = path.join(homeDir, '.codex', 'agents', 'teamai-recall.backup');
    await fse.writeFile(backup, 'user backup');

    await recallDisable({});

    expect(await fse.readFile(backup, 'utf8')).toBe('user backup');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies
vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
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

import { pull } from '../pull.js';
import { requireInit } from '../config.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('pull tombstone cleanup', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-tombstone-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      sharing: {
        skills: { syncTargets: ['claude', 'codex'] },
        rules: { enforced: [] },
        docs: { localDir: '' },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        codex: { skills: '.codex/skills', rules: '.codex/rules' },
      },
    };

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
    };

    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should clean up local rule files that are tombstoned', async () => {
    // Tombstone for "old-rule"
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');

    // Local residual files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');
    await fse.writeFile(path.join(homeDir, '.codex/rules', 'old-rule.md'), '# Old');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'old-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/rules', 'old-rule.md'))).toBe(false);
  });

  it('should clean up local skill directories that are tombstoned', async () => {
    // Tombstone for "old-skill"
    await fse.writeFile(path.join(repoPath, 'skills', '.removed'), 'old-skill\n');

    // Local residual directories
    await fse.ensureDir(path.join(homeDir, '.claude/skills/old-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/old-skill/SKILL.md'), '# Old');
    await fse.ensureDir(path.join(homeDir, '.codex/skills/old-skill'));
    await fse.writeFile(path.join(homeDir, '.codex/skills/old-skill/SKILL.md'), '# Old');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/old-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/skills/old-skill'))).toBe(false);
  });

  it('should not delete files that are NOT tombstoned', async () => {
    // No tombstone files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'keep-rule.md'), '# Keep');
    await fse.ensureDir(path.join(homeDir, '.claude/skills/keep-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/keep-skill/SKILL.md'), '# Keep');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'keep-rule.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/keep-skill'))).toBe(true);
  });

  it('should skip tombstone cleanup in dryRun mode', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');

    await pull({ dryRun: true });

    // File should still exist because dryRun skips cleanup
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'old-rule.md'))).toBe(true);
  });

  it('should handle empty tombstone files gracefully', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), '\n\n');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), '# Mine');

    await pull({});

    // Nothing should be deleted
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'my-rule.md'))).toBe(true);
  });

  it('should handle missing tombstone files gracefully', async () => {
    // No .removed file at all
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), '# Mine');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'my-rule.md'))).toBe(true);
  });
});

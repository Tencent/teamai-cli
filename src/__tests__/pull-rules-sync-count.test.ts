import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
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

vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('pull — rules sync count reflects actual writes (#574/#585)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  function config(): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-rules-count-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# My Rule\n');

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(config());
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('does NOT claim success when the only configured tool is not installed', async () => {
    // Deliberately do NOT create .claude — reproduces #574's exact scenario.
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(false);

    const successCalls = vi.mocked(log.success).mock.calls.map(([msg]) => String(msg));
    expect(successCalls.some((m) => /Synced \d+ rule\(s\)/.test(m))).toBe(false);

    const warnCalls = vi.mocked(log.warn).mock.calls.map(([msg]) => String(msg));
    expect(warnCalls.some((m) => /rule\(s\) available but no installed tool directory found/.test(m))).toBe(true);
  });

  it('DOES report success and writes the file when the tool is installed', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude'));

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/my-rule.md'))).toBe(true);

    const successCalls = vi.mocked(log.success).mock.calls.map(([msg]) => String(msg));
    expect(successCalls.some((m) => /Synced 1 rule\(s\)/.test(m))).toBe(true);
  });
});


describe('pull — --force bypasses isToolInstalled for rules (#574/#585)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  function config(force?: boolean): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-force-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# My Rule\n');

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(config());
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('without --force: does NOT create the missing .claude dir (unchanged prior behavior)', async () => {
    await pull({});
    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(false);
  });

  it('with --force: creates the missing .claude dir and writes the rule file', async () => {
    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(false);

    await pull({ force: true });

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/my-rule.md'))).toBe(true);

    const successCalls = vi.mocked(log.success).mock.calls.map(([msg]) => String(msg));
    expect(successCalls.some((m) => /Synced 1 rule\(s\)/.test(m))).toBe(true);
  });
});

describe('pull — same phantom-success gate applied to skills and agents (#574/#585 follow-up)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  function config(): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-skills-agents-count-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'skills', 'my-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'my-skill', 'SKILL.md'), '# My Skill\n');

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(config());
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('skills: does NOT claim success when no tool is installed', async () => {
    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude'))).toBe(false);

    const successCalls = vi.mocked(log.success).mock.calls.map(([msg]) => String(msg));
    expect(successCalls.some((m) => /Synced \d+ skills/.test(m))).toBe(false);

    const warnCalls = vi.mocked(log.warn).mock.calls.map(([msg]) => String(msg));
    expect(warnCalls.some((m) => /skills available but no installed tool directory found/.test(m))).toBe(true);
  });

  it('skills: DOES sync and writes the file when the tool is installed', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude'));

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/my-skill/SKILL.md'))).toBe(true);
  });
});

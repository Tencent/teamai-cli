import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// #585 / #574: `pull` counted the team repo's items and printed `Synced N`
// whatever reached the tool's directory. #597 fixed that for rules and left the
// generic branch open. These tests pin the generic branch: skills, docs and
// agents must not claim a success the disk does not show.

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
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

vi.mock('../source.js', () => ({ pullSources: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));
vi.mock('../team-push.js', () => ({ reportUsageToTeam: vi.fn().mockResolvedValue(true) }));
vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('pull reports what reached the tool directory (#585)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    vi.mocked(log.success).mockClear();
    vi.mocked(log.warn).mockClear();
    vi.mocked(log.info).mockClear();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-sync-truth-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'repo');

    // The team repo really holds one skill and one doc.
    await fse.ensureDir(path.join(repoPath, 'skills', 'org-review'));
    await fse.writeFile(
      path.join(repoPath, 'skills', 'org-review', 'SKILL.md'),
      '---\nname: org-review\ndescription: review workflow\n---\n',
    );
    await fse.ensureDir(path.join(repoPath, 'docs'));
    await fse.writeFile(path.join(repoPath, 'docs', 'guide.md'), '# Guide\n');

    // The tool's own directory is absent — a brand-new member who never ran
    // the tool once. Nothing can land on disk.
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: 'docs' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'member',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fse.remove(tmpDir);
  });

  /** Every success line this run printed. Read fresh so a prior case cannot leak in. */
  function successLines(): string[] {
    return vi.mocked(log.success).mock.calls.map(([msg]) => String(msg));
  }

  it('claims no skills synced when no tool directory exists', async () => {
    await pull({ silent: true });

    expect(successLines().filter((msg) => /Synced \d+ skills/.test(msg))).toEqual([]);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'org-review'))).toBe(false);
    // Docs are not gated: they are copied to the team's own docs directory,
    // which the copy creates, so that report stays truthful.
    expect(successLines().filter((msg) => /Synced \d+ docs/.test(msg)).length).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, 'docs', 'guide.md'))).toBe(true);
  });

  it('still claims skills synced once the tool directory exists', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await pull({ silent: true });

    expect(successLines().filter((msg) => /Synced \d+ skills/.test(msg)).length).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'org-review', 'SKILL.md'))).toBe(true);
  });

  it('claims no agents synced when no tool directory can receive them', async () => {
    // The same phantom-success shape as skills, on the agents branch: the team
    // repo holds an agent, the tool root is absent, so the handler skips the
    // write and the report must not claim otherwise.
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.writeFile(
      path.join(repoPath, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: reviews code\n---\nReview things.\n',
    );
    teamConfig.toolPaths = {
      claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents' },
    };

    await pull({ silent: true });

    expect(successLines().filter((msg) => /Synced \d+ agents/.test(msg))).toEqual([]);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'agents', 'reviewer.md'))).toBe(false);
  });

  it('still claims agents synced once the tool directory exists', async () => {
    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.writeFile(
      path.join(repoPath, 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: reviews code\n---\nReview things.\n',
    );
    teamConfig.toolPaths = {
      claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents' },
    };
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));

    await pull({ silent: true });

    expect(successLines().filter((msg) => /Synced \d+ agents/.test(msg)).length).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'agents', 'reviewer.md'))).toBe(true);
  });
});

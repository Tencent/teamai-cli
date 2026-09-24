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
import { detectProjectConfig, loadLocalConfigForScope, loadTeamConfig, loadStateForScope, saveStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('pull reports what reached the tool directory (#585)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;
  let ioSpy: { mockRestore(): void } | undefined;

  beforeEach(async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(saveStateForScope).mockClear();
    vi.mocked(loadStateForScope).mockResolvedValue({ lastPull: null, lastPullRev: null } as Awaited<ReturnType<typeof loadStateForScope>>);
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
    ioSpy?.mockRestore();
    ioSpy = undefined;
    vi.unstubAllEnvs();
    vi.resetModules();
    await fse.remove(tmpDir);
  });

  /** Every success line this run printed. Read fresh so a prior case cannot leak in. */
  function successLines(): string[] {
    return vi.mocked(log.success).mock.calls.map(([msg]) => String(msg));
  }

  it.each(['copy', 'prune', 'unsafe destination', 'unreadable source', 'realpath'])(
    'does not report a successful docs sync after %s fails, and retries on the next pull', async (failure) => {
      // Simulate a force-pull of an already-synced revision: failure must clear
      // even that marker, otherwise the following ordinary pull skips the retry.
      const state = await loadStateForScope(localConfig);
      state.lastPullRev = 'abc1234';
      state.lastPullTargets = [];
      await fse.outputFile(path.join(homeDir, 'docs', 'stale.md'), 'stale');
      await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - key: DOCS_TEST\n    value: delivered\n');
      if (failure === 'copy') ioSpy = vi.spyOn(fse, 'copy').mockRejectedValueOnce(new Error('copy failed'));
      if (failure === 'prune') ioSpy = vi.spyOn(fse, 'unlink').mockRejectedValueOnce(new Error('prune failed'));
      if (failure === 'unsafe destination') teamConfig.sharing.docs.localDir = homeDir;
      // A file in place of the source directory makes its scan fail without
      // relying on Unix permissions (the suite also runs on Windows).
      if (failure === 'unreadable source') {
        await fse.remove(path.join(repoPath, 'docs'));
        await fse.writeFile(path.join(repoPath, 'docs'), 'not a directory');
      }
      if (failure === 'realpath') ioSpy = vi.spyOn(fse, 'realpath').mockRejectedValueOnce(new Error('realpath failed'));

      await pull({ silent: true, force: true });

      expect(successLines().filter(msg => /Synced \d+ docs/.test(msg))).toEqual([]);
      expect(vi.mocked(log.warn).mock.calls.flat()).toEqual(expect.arrayContaining([
        expect.stringContaining('Failed to sync docs:'),
      ]));
      expect(await fse.readFile(path.join(homeDir, 'docs', 'stale.md'), 'utf8')).toBe('stale');
      expect(state.lastPullRev).toBeNull();
      expect(saveStateForScope).toHaveBeenCalledWith(expect.objectContaining({ lastPullRev: null }), localConfig);
      // A docs failure must not prevent the next resource type from syncing.
      expect(successLines().some(msg => msg.includes('Synced 1 env variable(s)'))).toBe(true);

      ioSpy?.mockRestore();
      ioSpy = undefined;
      teamConfig.sharing.docs.localDir = 'docs';
      if (failure === 'unreadable source') {
        await fse.remove(path.join(repoPath, 'docs'));
        await fse.outputFile(path.join(repoPath, 'docs', 'guide.md'), '# Guide\n');
      }
      await pull({ silent: true });
      expect(successLines()).toContain('[user] Synced 1 docs');
      expect(await fse.pathExists(path.join(homeDir, 'docs', 'stale.md'))).toBe(false);
      expect(state.lastPullRev).toBe('abc1234');
    },
  );

  it.each(['user', 'project', 'none'])('aggregates inherited scope completion when docs fail in %s', async (failure) => {
    const projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(projectRoot);
    vi.mocked(detectProjectConfig).mockResolvedValue({
      ...localConfig, scope: 'project', projectRoot, inheritUserScope: true,
    });
    if (failure !== 'none') {
      await fse.outputFile(path.join(failure === 'user' ? homeDir : projectRoot, 'docs'), 'blocks docs directory');
    }
    const outcome = { completed: false };
    await pull({ silent: true, force: true }, outcome);
    expect(outcome.completed).toBe(failure === 'none');
    for (const scope of ['user', 'project']) {
      const succeeded = scope !== failure;
      expect(successLines().includes(`[${scope}] Synced 1 docs`)).toBe(succeeded);
      if (!succeeded) {
        expect(vi.mocked(log.warn).mock.calls.flat()).toContainEqual(expect.stringContaining(`[${scope}] Failed to sync docs:`));
      }
    }
  });

  it.each(['empty', 'missing'])('prunes only stale empty directories when the team bundle is %s', async (state) => {
    await fse.remove(path.join(repoPath, 'docs'));
    if (state === 'empty') await fse.ensureDir(path.join(repoPath, 'docs'));
    const destination = path.join(homeDir, 'docs');
    await fse.ensureDir(path.join(destination, 'old', 'nested'));
    await fse.outputFile(path.join(destination, 'private', '.keep'), 'hidden');
    await pull({ silent: true, dryRun: true });
    expect(await fse.pathExists(path.join(destination, 'old', 'nested'))).toBe(true);
    expect(vi.mocked(log.info).mock.calls.flat()).toContain('[user] [dry-run] Would sync 0 docs and remove stale local docs');
    await pull({ silent: true, force: true });
    expect(await fse.pathExists(path.join(destination, 'old'))).toBe(false);
    expect(await fse.readFile(path.join(destination, 'private', '.keep'), 'utf8')).toBe('hidden');
    expect(successLines()).toContain('[user] Synced 0 docs');
  });

  it.each(['empty', 'missing'])('prunes docs through pull when the team bundle is %s (#794)', async (state) => {
    await pull({ silent: true, force: true });
    await fse.remove(path.join(repoPath, 'docs'));
    if (state === 'empty') await fse.ensureDir(path.join(repoPath, 'docs'));
    await pull({ silent: true, force: true });
    expect(await fse.pathExists(path.join(homeDir, 'docs', 'guide.md'))).toBe(false);
    expect(successLines()).toContain('[user] Synced 0 docs');
  });

  it('previews pruning without deleting files during a dry run', async () => {
    await fse.outputFile(path.join(homeDir, 'docs', 'stale.md'), 'local');
    await fse.remove(path.join(repoPath, 'docs'));
    await pull({ silent: true, dryRun: true });
    expect(await fse.readFile(path.join(homeDir, 'docs', 'stale.md'), 'utf8')).toBe('local');
    expect(vi.mocked(log.info).mock.calls.flat()).toContain('[user] [dry-run] Would sync 0 docs and remove stale local docs');
  });

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

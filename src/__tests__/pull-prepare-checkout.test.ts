import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// #1424: checkout preparation runs postDeploy once per checkout, on the pull
// that writes its first record, while a workflow overlay, which puts the
// agent files back to a base commit before each step, runs it every time.

const { state, mockRunTeamScript } = vi.hoisted(() => ({
  state: { current: {} as Record<string, unknown> },
  mockRunTeamScript: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn().mockResolvedValue(null),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  // What the pull saves is what the next read finds, as on disk.
  loadStateForScope: vi.fn(async () => structuredClone(state.current)),
  saveStateForScope: vi.fn(async (next: Record<string, unknown>) => { state.current = structuredClone(next); }),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  createGit: (await importOriginal<typeof import('../utils/git.js')>()).createGit,
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  listWorktrees: vi.fn().mockResolvedValue([]),
  gitCommonDir: vi.fn().mockResolvedValue(null),
  nearestGitEntry: vi.fn().mockResolvedValue(null),
  resolveAnchors: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../team-scripts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../team-scripts.js')>()),
  runTeamScript: mockRunTeamScript,
}));
vi.mock('../source.js', () => ({ pullSources: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue({ ok: true, defs: [] }),
  deliveredHookFiles: vi.fn().mockResolvedValue([]),
  unreadableHookFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
  describeKeptMemberServer: vi.fn(() => ''),
}));
vi.mock('../team-push.js', () => ({ reportUsage: vi.fn().mockResolvedValue('reported') }));
vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
  capUsageEvents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadTeamConfig } from '../config.js';
import { getHeadRev } from '../utils/git.js';
import { reconcileTeamHooksForConfig } from '../hooks.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('checkout preparation runs postDeploy (#1424)', () => {
  let tmpDir: string;
  let repoPath: string;
  let projectRoot: string;
  const skill = (name = 'org-review') => path.join(projectRoot, '.claude', 'skills', name, 'SKILL.md');
  const postDeploys = () => mockRunTeamScript.mock.calls.filter(([, name]) => name === 'postDeploy').length;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-prepare-checkout-'));
    repoPath = path.join(tmpDir, 'repo');
    projectRoot = path.join(tmpDir, 'project');
    await fse.outputFile(path.join(repoPath, 'skills', 'org-review', 'SKILL.md'), '---\nname: org-review\ndescription: review workflow\n---\n');
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
    state.current = { lastPull: null, lastPullRev: null };
    mockRunTeamScript.mockReset().mockResolvedValue(undefined);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    const teamConfig: TeamaiConfig = {
      team: 'test', description: '', repo: 'https://git.example.com/test/repo.git', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: 'docs' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      scripts: { postDeploy: { path: 'post-deploy.mjs' } },
    };
    const config: LocalConfig = {
      repo: { localPath: repoPath, remote: teamConfig.repo }, username: 'member', additionalRoles: [],
      scope: 'project', projectRoot, enabledAgents: ['claude'], dataHome: path.join(tmpDir, 'data'),
    };
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(config);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.TEAMAI_GIT_HOOK;
    delete process.env.TEAMAI_PREPARE_CHECKOUT;
    await fse.remove(tmpDir);
  });

  it('once: the pull that writes the checkout\'s first record runs it, and an inline one that finds the record delivers nothing', async () => {
    await pull({ silent: true, inline: true, prepareCheckout: 'once' });
    expect(fse.existsSync(skill())).toBe(true);
    expect(postDeploys()).toBe(1);

    // Another trigger prepared the checkout while this one waited: even a newer team revision is left to the session's pull.
    await fse.outputFile(path.join(repoPath, 'skills', 'later', 'SKILL.md'), '---\nname: later\ndescription: later skill\n---\n');
    vi.mocked(getHeadRev).mockResolvedValue('def5678');
    await pull({ silent: true, inline: true, prepareCheckout: 'once' });

    expect(fse.existsSync(skill('later'))).toBe(false);
    expect(postDeploys()).toBe(1);
  });

  it('the pull a new checkout\'s git hook hands over to runs it when it writes the first record, and hands the marker to no script', async () => {
    process.env.TEAMAI_GIT_HOOK = 'post-checkout';
    process.env.TEAMAI_PREPARE_CHECKOUT = 'once';
    let markerInScript: string | undefined = 'unread';
    mockRunTeamScript.mockImplementation(async () => { markerInScript = process.env.TEAMAI_PREPARE_CHECKOUT; });

    await pull({ silent: true });

    expect(fse.existsSync(skill())).toBe(true);
    expect(postDeploys()).toBe(1);
    expect(markerInScript).toBeUndefined();
  });

  it('the pull `git pull` hands over to writes the first record without it', async () => {
    process.env.TEAMAI_GIT_HOOK = 'post-checkout';

    await pull({ silent: true });

    expect(fse.existsSync(skill())).toBe(true);
    expect(postDeploys()).toBe(0);
  });

  it('once: a pass whose checkout is removed after its resources are delivered runs no postDeploy there', async () => {
    await fse.outputFile(path.join(projectRoot, '.git'), 'gitdir: ../repo.git/worktrees/project\n');
    vi.mocked(reconcileTeamHooksForConfig).mockImplementationOnce(async () => {
      await fse.remove(projectRoot);
      return { ok: true, defs: [] };
    });

    await pull({ silent: true, inline: true, prepareCheckout: 'once' });

    expect(fse.existsSync(projectRoot)).toBe(false);
    expect(postDeploys()).toBe(0);
  });

  it('always: a workflow overlay runs it again in a checkout with a record', async () => {
    await pull({ silent: true, inline: true, prepareCheckout: 'always' });

    await pull({ silent: true, inline: true, prepareCheckout: 'always' });

    expect(postDeploys()).toBe(2);
  });
});

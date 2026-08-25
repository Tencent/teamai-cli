import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';

// Integration test for the "push carries teamai.yaml" fix.
//
// Regression: `teamai source add` writes sources/publicSkills into the team repo's
// teamai.yaml WITHOUT committing, then tells the user to run `teamai push`. Before
// the fix, push would (1) `git reset --hard` the working tree in resetToCleanMaster
// and destroy that edit, and (2) never include teamai.yaml in the commit even if it
// survived. This test drives the real push() against real local git repos (a bare
// "remote" + a working clone), mocking only the provider's PR creation.

const mockCreatePullRequest = vi.fn().mockResolvedValue('https://example.test/pr/1');
const mockAutoDetectInit = vi.fn();
const mockLoadStateForScope = vi.fn();
const mockSaveStateForScope = vi.fn();

vi.mock('../providers/index.js', () => ({
  getProvider: () => ({
    name: 'github',
    parseRepoInput: (input: string) => ({ owner: 'acme', repo: 'team', httpsUrl: input }),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
}));

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: (...args: unknown[]) => mockLoadStateForScope(...args),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));

vi.mock('../read-only.js', () => ({ assertNotReadOnly: vi.fn() }));

// Pre-push sync reads/writes tool dirs we don't care about here — no-op it.
vi.mock('../utils/pre-push-sync.js', () => ({ syncTeamUpdatesToLocal: vi.fn() }));

vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn(() => Promise.resolve('')),
  askConfirmation: vi.fn(() => Promise.resolve(true)),
  askSelection: vi.fn((_p: string, n: number, all?: boolean) =>
    Promise.resolve(all ? Array.from({ length: n }, (_x, i) => i) : null)),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

async function initTeamRepos(root: string): Promise<string> {
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const teamRepo = path.join(root, 'team-repo');

  await simpleGit().init(['--bare', remote]);

  fs.mkdirSync(path.join(seed, 'skills', 'ns'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'version: 1\npublicSkills: []\n');
  const seedGit = simpleGit(seed);
  await seedGit.init();
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  await seedGit.add('.');
  await seedGit.commit('init');
  await seedGit.branch(['-M', 'main']);
  await seedGit.addRemote('origin', remote);
  await seedGit.push(['-u', 'origin', 'main']);

  await simpleGit().clone(remote, teamRepo);
  const trGit = simpleGit(teamRepo);
  await trGit.addConfig('user.email', 't@t.com');
  await trGit.addConfig('user.name', 't');
  return teamRepo;
}

/** Read teamai.yaml as committed on the branch that push created + pushed to remote. */
async function committedYamlOnPushedBranch(teamRepo: string): Promise<string> {
  const git = simpleGit(teamRepo);
  const branches = await git.branch();
  const pushBranch = branches.all.find((b) => b.startsWith('teamai/') || b.includes('push'))
    ?? branches.current;
  return (await git.show([`${pushBranch}:teamai.yaml`]));
}

describe('push carries teamai.yaml (source add regression)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-cfg-'));
    vi.clearAllMocks();
    mockCreatePullRequest.mockResolvedValue('https://example.test/pr/1');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, pushedSkills: [], pushedRules: [], pushedEnvVars: [],
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('config-only: source add edit survives reset and is pushed', async () => {
    const teamRepo = await initTeamRepos(tmpDir);

    // Simulate `teamai source add`: edit teamai.yaml in the working tree, no commit.
    const yamlPath = path.join(teamRepo, 'teamai.yaml');
    fs.writeFileSync(yamlPath, 'version: 1\npublicSkills: []\nsources:\n  - name: dev\n    repo: https://git.example/dev\n');

    mockAutoDetectInit.mockResolvedValue({
      localConfig: {
        repo: { localPath: teamRepo, remote: path.join(tmpDir, 'remote.git'), kind: undefined },
        username: 'alice',
        scope: 'project',
        projectRoot: teamRepo,
      },
      teamConfig: { repo: 'acme/team', toolPaths: {} },
    });

    const { push } = await import('../push.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await push({ all: true });
    logSpy.mockRestore();

    // A PR was created for the config change...
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    // ...and the pushed branch's teamai.yaml contains the source (survived reset --hard).
    const pushed = await committedYamlOnPushedBranch(teamRepo);
    expect(pushed).toContain('sources:');
    expect(pushed).toContain('https://git.example/dev');
  });

  it('no changes at all: reports nothing to push, no PR', async () => {
    const teamRepo = await initTeamRepos(tmpDir);

    mockAutoDetectInit.mockResolvedValue({
      localConfig: {
        repo: { localPath: teamRepo, remote: path.join(tmpDir, 'remote.git'), kind: undefined },
        username: 'alice',
        scope: 'project',
        projectRoot: teamRepo,
      },
      teamConfig: { repo: 'acme/team', toolPaths: {} },
    });

    const { push } = await import('../push.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await push({ all: true });
    logSpy.mockRestore();

    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });
});

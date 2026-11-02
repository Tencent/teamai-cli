import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  loadTeamConfig: vi.fn(),
  requireInit: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    fail: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(),
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [{
      id: 'dev',
      name: 'Dev',
      description: '',
      resources: { knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [] },
    }],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({
    knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [],
  })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig } from '../config.js';
import { checkoutKey, pull } from '../pull.js';
import { StateSchema, type LocalConfig, type State, type TeamaiConfig } from '../types.js';
import { fileHash } from '../utils/fs.js';

describe('pull with excluded skills', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  /** What the state file holds: pull reads it and writes it back in place. */
  let state: State;

  beforeEach(async () => {
    state = StateSchema.parse({ lastPull: null, lastPullRev: null });
    vi.mocked(loadStateForScope).mockImplementation(async () => state);
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-exclude-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'excluded-skill'));
    await fse.writeFile(
      path.join(repoPath, 'skills', 'common', 'excluded-skill', 'SKILL.md'),
      '---\nname: excluded-skill\ndescription: excluded\n---\n',
    );
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'kept-skill'));
    await fse.writeFile(
      path.join(repoPath, 'skills', 'common', 'kept-skill', 'SKILL.md'),
      '---\nname: kept-skill\ndescription: kept\n---\n',
    );
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      primaryRole: 'dev',
      additionalRoles: [],
      excludedSkills: ['excluded-skill'],
    };
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('does not install an excluded skill and still installs allowed skills', async () => {
    await pull({ force: true });

    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'excluded-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'kept-skill'))).toBe(true);
  });

  it('removes a previously installed excluded skill', async () => {
    const installed = path.join(homeDir, '.claude', 'skills', 'excluded-skill');
    await fse.ensureDir(installed);
    // Deployed copy is byte-identical to the team-repo source (a real pull copies
    // it verbatim), so the data-safety gate lets cleanup delete it.
    await fse.writeFile(path.join(installed, 'SKILL.md'), '---\nname: excluded-skill\ndescription: excluded\n---\n');

    await pull({ force: true });

    expect(await fse.pathExists(installed)).toBe(false);
  });

  it('forgets a previously installed excluded skill in the delivery record once it removes the copy', async () => {
    const installed = path.join(homeDir, '.claude', 'skills', 'excluded-skill');
    const kept = path.join(homeDir, '.claude', 'skills', 'kept-skill');
    for (const [dir, name] of [[installed, 'excluded-skill'], [kept, 'kept-skill']] as const) {
      await fse.outputFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name === 'kept-skill' ? 'kept' : 'excluded'}\n---\n`);
    }
    const key = await checkoutKey(homeDir);
    const hashOf = async (file: string): Promise<string> => (await fileHash(file)) ?? '';
    state.lastPullByWorkspace = {
      [key]: { rev: 'old', targets: ['claude'], delivered: { [path.join(installed, 'SKILL.md')]: await hashOf(path.join(installed, 'SKILL.md')), [path.join(kept, 'SKILL.md')]: await hashOf(path.join(kept, 'SKILL.md')) } },
    };

    await pull({ force: true });

    expect(await fse.pathExists(installed)).toBe(false);
    expect(Object.keys(state.lastPullByWorkspace[key]?.delivered ?? {})).toEqual([path.join(kept, 'SKILL.md')]);
  });
});

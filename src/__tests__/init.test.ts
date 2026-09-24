import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

const mockGit = {
  init: vi.fn(),
  addRemote: vi.fn(),
  addConfig: vi.fn(),
  add: vi.fn(),
  status: vi.fn().mockResolvedValue({ staged: [] }),
  commit: vi.fn(),
  push: vi.fn(),
  revparse: vi.fn().mockResolvedValue('main'),
  raw: vi.fn(),
};

vi.mock('simple-git', () => ({
  default: () => mockGit,
}));

vi.mock('yaml', () => ({
  default: {
    stringify: (obj: unknown) => JSON.stringify(obj),
    parse: (str: string) => JSON.parse(str),
  },
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    pathExists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
  },
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
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

const mockGfRepoClone = vi.fn();
const mockGfCreateRepo = vi.fn();
const mockGfIsAuthenticated = vi.fn().mockReturnValue(true);
const mockGfAuthWhoami = vi.fn().mockReturnValue('testuser');
const mockEnsureGfInstalled = vi.fn();

// ── CNB provider mocks ───────────────────────────────────
const mockCnbRepoClone = vi.fn();
const mockCnbCreateRepo = vi.fn();
const mockCnbOrganizationExists = vi.fn();
const mockEnsureCnbInstalled = vi.fn();

// Mock the provider-level gf-cli module (init.ts now uses providers)
vi.mock('../providers/tgit/gf-cli.js', () => {
  class RepoNotFoundError extends Error {
    constructor(repo: string) {
      super(`Repo "${repo}" not found on TGit.`);
      this.name = 'RepoNotFoundError';
    }
  }
  return {
    gfRepoClone: (...args: unknown[]) => mockGfRepoClone(...args),
    gfCreateRepo: (...args: unknown[]) => mockGfCreateRepo(...args),
    gfIsAuthenticated: () => mockGfIsAuthenticated(),
    gfAuthWhoami: () => mockGfAuthWhoami(),
    gfGetOAuthToken: vi.fn().mockReturnValue('mock-oauth-token'),
    ensureGfInstalled: () => mockEnsureGfInstalled(),
    ensureAuthenticated: vi.fn().mockReturnValue('testuser'),
    isGfInstalled: vi.fn().mockReturnValue(true),
    RepoNotFoundError,
  };
});

vi.mock('../providers/cnb/cnb-cli.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    cnbRepoClone: (...args: unknown[]) => mockCnbRepoClone(...args),
    cnbCreateRepo: (...args: unknown[]) => mockCnbCreateRepo(...args),
    cnbOrganizationExists: (...args: unknown[]) => mockCnbOrganizationExists(...args),
    cnbOrganizationCreateUrl: () => 'https://cnb.cool/new/groups',
    cnbIsAuthenticated: () => true,
    cnbWhoami: () => 'testuser',
    ensureCnbAuthenticated: () => 'testuser',
    ensureCnbInstalled: () => mockEnsureCnbInstalled(),
  };
});

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  saveLocalConfig: vi.fn(),
  saveLocalConfigForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn().mockResolvedValue(null),
  loadTeamConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockRejectedValue(new Error('no state')),
  saveStateForScope: vi.fn(),
  resolveProjectDataHome: vi.fn(async (projectRoot: string) => `${projectRoot}/.teamai`),
}));

vi.mock('../mcp-reconcile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcp-reconcile.js')>()),
  reconcileMcpForConfig: vi.fn(async () => ({ changes: [], wrote: false })),
}));
vi.mock('../local-agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-agent.js')>()),
  releaseClaudeModelConfig: vi.fn(),
}));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn(),
  reconcileTeamHooksForConfig: vi.fn(),
  hasTeamaiHooks: vi.fn(async () => true),
  reconcileHooks: vi.fn(),
}));

const mockDeployBuiltinSkills = vi.fn().mockResolvedValue(0);
vi.mock('../builtin-skills.js', () => ({
  deployBuiltinSkills: (...args: unknown[]) => mockDeployBuiltinSkills(...args),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI research and development resources',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
          learnings: ['common', 'hai'],
        },
      },
      {
        id: 'pm',
        name: 'Product Manager',
        description: 'Product planning and collaboration resources',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
          learnings: ['common', 'pm'],
        },
      },
      {
        id: 'thpc',
        name: 'THPC R&D',
        description: 'THPC project resources',
        resources: {
          knowledge: ['common', 'thpc'],
          skills: ['common', 'thpc'],
          learnings: ['common', 'thpc'],
        },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  describeRoles: vi.fn((roles: Array<{ id: string; name: string; description?: string }>) =>
    roles.map((role) => role.description ? `${role.id} - ${role.name}: ${role.description}` : `${role.id} - ${role.name}`),
  ),
  // The real class: init swallows ONLY this one, so the mock must carry the
  // same identity for the distinction to be exercised.
  RolesManifestNotFoundError: class RolesManifestNotFoundError extends Error {},
}));

// Track pathExists calls to simulate directory states
let pathExistsFn: (p: string) => boolean = () => false;

const mockRemove = vi.fn();

vi.mock('../utils/fs.js', () => ({
  ensureDir: vi.fn(),
  writeFile: vi.fn(),
  pathExists: vi.fn(async (p: string) => pathExistsFn(p)),
  expandHome: (p: string) => {
    if (p.startsWith('~/') || p === '~') {
      return (process.env.HOME ?? '') + p.slice(1);
    }
    return p;
  },
  readFileSafe: vi.fn().mockResolvedValue(null),
  remove: (p: string) => mockRemove(p),
}));

vi.mock('../types.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    // The machine home is now a runtime getter (issue #374 P3), so override the
    // getter instead of the removed TEAMAI_HOME const to isolate onto /tmp.
    getTeamaiHomeDir: () => '/tmp/test-teamai-home',
  };
});

// Mock prompt to auto-answer prompts
let questionAnswers: string[] = [];
vi.mock('../utils/prompt.js', () => ({
  // Mirror the real predicate's TTY leg so tests that force `isTTY` keep
  // driving the interactive branch, independent of CI=true on the runner.
  isInteractive: () => Boolean(process.stdin.isTTY),
  askQuestion: vi.fn((_prompt: string, defaultValue?: string) => {
    const answer = questionAnswers.shift();
    return Promise.resolve(answer ?? defaultValue ?? '');
  }),
  askConfirmation: vi.fn((_prompt: string, defaultValue?: boolean) => {
    const answer = questionAnswers.shift();
    if (answer !== undefined) {
      return Promise.resolve(answer.toLowerCase() === 'y');
    }
    return Promise.resolve(defaultValue ?? false);
  }),
  closePrompt: vi.fn(),
}));

// Prevent process.exit from actually exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

import { init } from '../init.js';
import { RepoNotFoundError, OrganizationNotFoundError, RepoCreatePermissionError } from '../providers/types.js';
import { CnbRepoNotFoundError } from '../providers/cnb/cnb-cli.js';
import { saveLocalConfig, loadLocalConfigForScope } from '../config.js';
import fse from 'fs-extra';

describe('init', () => {
  const HOME = process.env.HOME ?? '';
  const localPath = `${HOME}/.teamai/team-repo`;

  beforeEach(() => {
    vi.clearAllMocks();
    questionAnswers = [];
    pathExistsFn = () => false;
  });

  afterEach(() => {
    mockExit.mockClear();
  });

  it('rejects user-scope inheritance before provider or repository side effects', async () => {
    await init({
      repo: 'https://git.woa.com/HyperAI/teamai-test.git',
      scope: 'user',
      inheritUserScope: true,
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockEnsureGfInstalled).not.toHaveBeenCalled();
    expect(mockGfRepoClone).not.toHaveBeenCalled();
  });

  describe('empty repo fallback', () => {
    it('should call initRepo when clone succeeds but directory does not exist', async () => {
      let pathExistsCallCount = 0;
      pathExistsFn = (p: string) => {
        if (p === localPath) {
          pathExistsCallCount++;
          return pathExistsCallCount > 3;
        }
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {});

      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(mockGfRepoClone).toHaveBeenCalledWith('HyperAI/teamai-test', localPath);
      expect(mockGit.init).toHaveBeenCalled();
      expect(mockGit.addRemote).toHaveBeenCalledWith(
        'origin',
        'https://git.woa.com/HyperAI/teamai-test.git',
      );
    });

    it('should not call initRepo when clone successfully creates the directory', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/existing-repo.git', scope: 'user' });

      expect(mockGfRepoClone).toHaveBeenCalled();
      expect(mockGit.init).not.toHaveBeenCalled();
      expect(mockGit.addRemote).not.toHaveBeenCalled();
    });
  });

  describe('stale non-git directory', () => {
    it('should remove and re-clone when team-repo exists but is not a git repo', async () => {
      // team-repo dir exists on disk...
      let removed = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return !removed; // exists until we remove it, then clone recreates handled below
        return false;
      };
      mockRemove.mockImplementation((p: string) => {
        if (p === localPath) removed = true;
      });
      // ...but it has no .git entry → isGitRepo() returns false.
      // isGitRepo calls fse.pathExists twice: dir exists (true), .git missing (false).
      (fse.pathExists as any)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      mockGfRepoClone.mockImplementation(() => {
        removed = false; // clone recreates the directory
      });

      // Answers: configure reviewers (n), primary role (1), no additional roles
      questionAnswers = ['n', '1', ''];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      // Stale dir removed, then a real clone performed.
      expect(mockRemove).toHaveBeenCalledWith(localPath);
      expect(mockGfRepoClone).toHaveBeenCalledWith('HyperAI/teamai-test', localPath);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should reuse the existing clone when team-repo is a valid git repo', async () => {
      pathExistsFn = (p: string) => p === localPath; // dir exists
      // isGitRepo: dir exists (true), .git present (true)
      (fse.pathExists as any)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      // Valid clone → no removal, no re-clone.
      expect(mockRemove).not.toHaveBeenCalled();
      expect(mockGfRepoClone).not.toHaveBeenCalled();
    });
  });

  describe('repo not found — auto create', () => {
    it('should create repo and retry clone when repo not found and user confirms', async () => {
      let cloneCallCount = 0;
      mockGfRepoClone.mockImplementation(() => {
        cloneCallCount++;
        if (cloneCallCount === 1) {
          throw new RepoNotFoundError('HyperAI/new-repo');
        }
        // Second call (after creation) succeeds
      });

      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      // gfCreateRepo succeeds, then second clone creates the dir
      mockGfCreateRepo.mockImplementation(async () => {
        cloneDone = true;
      });

      // Answers: create repo confirm (Y), configure reviewers (n), primary role (1)
      questionAnswers = ['Y', 'n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/new-repo.git', scope: 'user' });

      expect(mockGfCreateRepo).toHaveBeenCalledWith('HyperAI', 'new-repo');
      expect(mockGfRepoClone).toHaveBeenCalledTimes(2);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should exit when user declines repo creation', async () => {
      mockGfRepoClone.mockImplementation(() => {
        throw new RepoNotFoundError('HyperAI/new-repo');
      });

      pathExistsFn = () => false;

      // Answers: decline creation (n)
      questionAnswers = ['n'];

      await init({ repo: 'https://git.woa.com/HyperAI/new-repo.git', scope: 'user' });

      // process.exit(1) should be called when user declines
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should exit when repo creation fails', async () => {
      mockGfRepoClone.mockImplementation(() => {
        throw new RepoNotFoundError('HyperAI/new-repo');
      });

      mockGfCreateRepo.mockRejectedValue(new Error('403 Forbidden'));

      pathExistsFn = () => false;

      // Answers: confirm creation (Y)
      questionAnswers = ['Y'];

      await init({ repo: 'https://git.woa.com/HyperAI/new-repo.git', scope: 'user' });

      expect(mockGfCreateRepo).toHaveBeenCalledWith('HyperAI', 'new-repo');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('organization not found — guide to web UI (CNB)', () => {
    /** Collect all log.info lines emitted during a run. */
    const infoLines = async (): Promise<string[]> => {
      const { log } = await import('../utils/logger.js');
      return vi.mocked(log.info).mock.calls.map((c) => String(c[0]));
    };

    it('detects the missing org before prompting to create the repo, prints the URL, and never calls createRepo', async () => {
      mockExit.mockImplementationOnce(() => {
        throw new Error('EXIT');
      });
      mockCnbRepoClone.mockImplementation(() => {
        throw new CnbRepoNotFoundError('my-org/new-repo');
      });
      mockCnbOrganizationExists.mockReturnValue(false); // org missing
      pathExistsFn = () => false;

      await expect(
        init({ repo: 'https://cnb.cool/my-org/new-repo.git', scope: 'user' }),
      ).rejects.toThrow('EXIT');

      // Org checked up front; repo creation never attempted; URL surfaced.
      expect(mockCnbOrganizationExists).toHaveBeenCalledWith('my-org');
      expect(mockCnbCreateRepo).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
      expect((await infoLines()).some((l) => l.includes('https://cnb.cool/new/groups'))).toBe(true);
    });

    it('proceeds to create the repo when the org exists', async () => {
      let cloneCallCount = 0;
      let cloneDone = false;
      mockCnbRepoClone.mockImplementation(() => {
        cloneCallCount++;
        if (cloneCallCount === 1) {
          throw new CnbRepoNotFoundError('my-org/new-repo');
        }
        cloneDone = true;
      });
      mockCnbOrganizationExists.mockReturnValue(true); // org exists
      mockCnbCreateRepo.mockResolvedValue(undefined);
      pathExistsFn = (p: string) => (p === localPath ? cloneDone : false);

      // Answers: confirm repo creation (Y), skip reviewers (n), primary role (1).
      questionAnswers = ['Y', 'n', '1'];

      await init({ repo: 'https://cnb.cool/my-org/new-repo.git', scope: 'user' });

      expect(mockCnbOrganizationExists).toHaveBeenCalledWith('my-org');
      expect(mockCnbCreateRepo).toHaveBeenCalledWith('my-org', 'new-repo');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('prints the repo create URL and exits when the org exists but the token cannot create the repo (403)', async () => {
      mockExit.mockImplementationOnce(() => {
        throw new Error('EXIT');
      });
      mockCnbRepoClone.mockImplementation(() => {
        throw new CnbRepoNotFoundError('my-org/new-repo');
      });
      mockCnbOrganizationExists.mockReturnValue(true); // org exists
      mockCnbCreateRepo.mockRejectedValue(
        new RepoCreatePermissionError('my-org/new-repo', 'https://cnb.cool/new/repos'),
      );
      pathExistsFn = () => false;

      // Answer: confirm repo creation (Y). No browser prompt any more.
      questionAnswers = ['Y'];

      await expect(
        init({ repo: 'https://cnb.cool/my-org/new-repo.git', scope: 'user' }),
      ).rejects.toThrow('EXIT');

      expect(mockCnbCreateRepo).toHaveBeenCalledWith('my-org', 'new-repo');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect((await infoLines()).some((l) => l.includes('https://cnb.cool/new/repos'))).toBe(true);
    });
  });

  describe('clone error handling', () => {
    it('should exit when clone fails with a non-NotFound error', async () => {
      pathExistsFn = () => false;

      mockGfRepoClone.mockImplementation(() => {
        throw new Error('gf repo clone failed: network error');
      });

      questionAnswers = [];

      await init({ repo: 'https://git.woa.com/HyperAI/broken-repo.git', scope: 'user' });

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockGfCreateRepo).not.toHaveBeenCalled();
    });
  });

  describe('role persistence', () => {
    it('writes primaryRole and resourceProfileVersion when role is selected', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        if (p === path.join(localPath, 'members', 'testuser.yaml')) return false;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      const mockedLoadTeamConfig = vi.mocked(await import('../config.js')).loadTeamConfig;
      mockedLoadTeamConfig
        .mockResolvedValueOnce({
          team: 'my-team',
          repo: 'https://git.woa.com/HyperAI/teamai-test.git',
          provider: 'tgit',
          reviewers: [],
          sharing: {
            skills: {},
            rules: { enforced: [] },
            docs: { localDir: '~/.teamai/docs' },
            env: { injectShellProfile: true },
          },
          toolPaths: {},
        } as never)
        .mockResolvedValueOnce({
          team: 'my-team',
          repo: 'https://git.woa.com/HyperAI/teamai-test.git',
          provider: 'tgit',
          reviewers: [],
          sharing: {
            skills: {},
            rules: { enforced: [] },
            docs: { localDir: '~/.teamai/docs' },
            env: { injectShellProfile: true },
          },
          toolPaths: {},
        } as never);

      questionAnswers = ['n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(saveLocalConfig).toHaveBeenCalledWith(expect.objectContaining({
        primaryRole: 'hai',
        additionalRoles: [],
        resourceProfileVersion: 1,
      }));
    });

    it('persists later selections as additional roles', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        if (p === path.join(localPath, 'members', 'testuser.yaml')) return false;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      const mockedLoadTeamConfig = vi.mocked(await import('../config.js')).loadTeamConfig;
      mockedLoadTeamConfig
        .mockResolvedValueOnce({
          team: 'my-team',
          repo: 'https://git.woa.com/HyperAI/teamai-test.git',
          provider: 'tgit',
          reviewers: [],
          sharing: {
            skills: {},
            rules: { enforced: [] },
            docs: { localDir: '~/.teamai/docs' },
            env: { injectShellProfile: true },
          },
          toolPaths: {},
        } as never)
        .mockResolvedValueOnce({
          team: 'my-team',
          repo: 'https://git.woa.com/HyperAI/teamai-test.git',
          provider: 'tgit',
          reviewers: [],
          sharing: {
            skills: {},
            rules: { enforced: [] },
            docs: { localDir: '~/.teamai/docs' },
            env: { injectShellProfile: true },
          },
          toolPaths: {},
        } as never);

      questionAnswers = ['n', '1,3'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(saveLocalConfig).toHaveBeenCalledWith(expect.objectContaining({
        primaryRole: 'hai',
        additionalRoles: ['thpc'],
        resourceProfileVersion: 1,
      }));
    });
  });

  describe('deploys built-in skills after init', () => {
    /** Init against a clone whose teamai.yaml loads, so the stub deploy runs. */
    async function initWithTeamConfig(): Promise<void> {
      let cloneDone = false;
      pathExistsFn = (p: string) => (p === localPath ? cloneDone : false);
      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });
      vi.mocked(await import('../config.js')).loadTeamConfig.mockResolvedValue({
        team: 'my-team',
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        provider: 'tgit',
        reviewers: [],
        sharing: {
          skills: {},
          rules: { enforced: [] },
          docs: { localDir: '~/.teamai/docs' },
          env: { injectShellProfile: true },
        },
        toolPaths: {},
      } as never);
      questionAnswers = ['n', '1'];
      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });
    }

    it('calls deployBuiltinSkills with teamConfig when loadTeamConfig returns non-null', async () => {
      await initWithTeamConfig();

      expect(mockDeployBuiltinSkills).toHaveBeenCalled();
      // No recall option: one stub deploys for everyone, and `teamai skill get
      // share` is where recall is checked (#678).
      expect(mockDeployBuiltinSkills).toHaveBeenCalledWith(
        expect.objectContaining({ team: expect.any(String) }),
        expect.anything(),
      );
    });

    it('announces the stub as ready only when it landed', async () => {
      const { log } = await import('../utils/logger.js');
      mockDeployBuiltinSkills.mockResolvedValueOnce(1);

      await initWithTeamConfig();

      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('The built-in teamai skill is ready in your IDE'));
      expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not deployed'));
    });

    it('says the stub reached no tool without pointing at output that may not exist', async () => {
      // No installed tool logs at debug only, so "see the lines above" alone
      // would be false, and `teamai doctor` has no check for the stub.
      const { log } = await import('../utils/logger.js');
      mockDeployBuiltinSkills.mockResolvedValueOnce(0);

      await initWithTeamConfig();

      const warned = vi.mocked(log.warn).mock.calls.map((call) => String(call[0])).join('\n');
      expect(warned).toContain('The built-in teamai skill was not deployed to any AI tool');
      expect(warned).toContain('teamai pull');
      expect(warned).toContain('~/.teamai/debug.log');
      expect(warned).not.toContain('see the lines above');
      expect(warned).not.toContain('teamai doctor');
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('is ready in your IDE'));
    });
  });

  describe('scope path display', () => {
    it('persists explicit user-resource inheritance in project config', async () => {
      const projectLocalPath = path.join(process.cwd(), '.teamai', 'team-repo');
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === projectLocalPath) return cloneDone;
        if (p.endsWith(`${path.sep}.git`) || p.endsWith('/.git')) return true;
        return false;
      };
      mockGfRepoClone.mockImplementation(() => { cloneDone = true; });
      questionAnswers = ['n', '1'];

      const { saveLocalConfigForScope } = await import('../config.js');
      await init({
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        inheritUserScope: true,
      });

      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'project',
          projectRoot: process.cwd(),
          inheritUserScope: true,
        }),
        'project',
        process.cwd(),
      );
    });

    it('should default to project scope and print summary when --scope is omitted', async () => {
      const projectLocalPath = path.join(process.cwd(), '.teamai', 'team-repo');
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === projectLocalPath) return cloneDone;
        // Treat cwd as inside a git repo so E2 warn is skipped in this test
        if (p.endsWith(`${path.sep}.git`) || p.endsWith('/.git')) return true;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      // Answers: configure reviewers (n), primary role (1) — no scope prompt
      questionAnswers = ['n', '1'];

      const { log } = await import('../utils/logger.js');
      const { saveLocalConfigForScope } = await import('../config.js');

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git' });

      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Scope: project /));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('config    →'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('--scope user'));
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project', projectRoot: process.cwd() }),
        'project',
        process.cwd(),
      );
    });

    it('should print scope summary without interactive Select scope when --scope is provided', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      // Answers: configure reviewers (n), primary role (1)
      questionAnswers = ['n', '1'];

      const { log } = await import('../utils/logger.js');
      vi.mocked(log.info).mockClear();

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^Scope: user$/));
      const infoCalls = vi.mocked(log.info).mock.calls.map(c => String(c[0]));
      expect(infoCalls.some((msg) => msg.includes('Select scope:'))).toBe(false);
      expect(infoCalls.some((msg) => msg.includes('Scope [1/2]'))).toBe(false);
    });

    it('should ignore remote teamai.yaml.scope and succeed with local project scope', async () => {
      const projectLocalPath = path.join(process.cwd(), '.teamai', 'team-repo');
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === projectLocalPath) return cloneDone;
        if (p.endsWith(`${path.sep}.git`) || p.endsWith('/.git')) return true;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      const { loadTeamConfig, saveLocalConfigForScope } = await import('../config.js');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        team: 'remote-team',
        description: '',
        repo: 'https://git.woa.com/HyperAI/teamai-test.git',
        provider: 'tgit',
        scope: 'user',
        reviewers: [],
        sharing: { rules: { enforced: [] }, docs: {}, env: { injectShellProfile: true } },
        toolPaths: {},
      } as never);

      questionAnswers = ['n', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git' });

      expect(mockExit).not.toHaveBeenCalled();
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project' }),
        'project',
        process.cwd(),
      );
    });
  });

  describe('single-repo mode', () => {
    it('accepts an existing HTTP origin without persisting its credentials', async () => {
      pathExistsFn = (p: string) => p.endsWith(`${path.sep}.git`) || p.endsWith('/.git');
      mockGit.raw.mockResolvedValue(
        'http://user:token-must-not-appear@git.example.com/group/repo.git\n',
      );

      const { log } = await import('../utils/logger.js');
      const { loadTeamConfig, saveLocalConfigForScope } = await import('../config.js');
      vi.mocked(loadTeamConfig).mockResolvedValue({
        team: 'repo',
        description: '',
        repo: 'http://git.example.com/group/repo.git',
        provider: 'git',
        reviewers: [],
        sharing: { rules: { enforced: [] }, docs: {}, env: { injectShellProfile: true } },
        toolPaths: {},
      } as never);

      await init({ repo: '.', dryRun: true });

      const errorCalls = vi.mocked(log.error).mock.calls.map(([message]) => String(message));
      const debugCalls = vi.mocked(log.debug).mock.calls.map(([message]) => String(message));
      expect(mockExit).not.toHaveBeenCalled();
      expect(errorCalls).not.toContainEqual(expect.stringContaining('Could not parse the business repo remote'));
      expect(errorCalls.join('\n')).not.toContain('token-must-not-appear');
      expect(debugCalls.join('\n')).not.toContain('token-must-not-appear');
      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: expect.objectContaining({ remote: 'http://git.example.com/group/repo.git' }),
        }),
        'project',
        process.cwd(),
      );
    });

    it('aborts on a malformed roles manifest instead of initializing role-less', async () => {
      // A role-less config matches every role when hooks are reconciled, so
      // swallowing the parse failure would install exactly the hooks the manifest
      // restricts. Only an ABSENT manifest may leave the role unset.
      pathExistsFn = (p: string) => p.endsWith(`${path.sep}.git`) || p.endsWith('/.git');
      mockGit.raw.mockResolvedValue('https://git.example.com/group/repo.git\n');

      const { loadRolesManifest } = await import('../roles.js');
      vi.mocked(loadRolesManifest).mockRejectedValueOnce(
        new Error('Invalid roles manifest: roles.0.resources.skills.0: resource namespace must be a single path segment'),
      );

      const { saveLocalConfigForScope } = await import('../config.js');
      vi.mocked(saveLocalConfigForScope).mockClear();

      // The error leaves init, so the CLI prints it and exits non-zero; nothing
      // is written for the scope.
      await expect(init({ repo: '.', dryRun: true })).rejects.toThrow(/Invalid roles manifest/);
      expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    });

    it('still initializes with the role unset when there is no roles manifest', async () => {
      pathExistsFn = (p: string) => p.endsWith(`${path.sep}.git`) || p.endsWith('/.git');
      mockGit.raw.mockResolvedValue('https://git.example.com/group/repo.git\n');

      const { loadRolesManifest, RolesManifestNotFoundError } = await import('../roles.js');
      vi.mocked(loadRolesManifest).mockRejectedValueOnce(
        new RolesManifestNotFoundError('/repo/.teamai/manifest/roles.yaml'),
      );

      const { saveLocalConfigForScope } = await import('../config.js');
      vi.mocked(saveLocalConfigForScope).mockClear();

      await init({ repo: '.', dryRun: true });

      expect(saveLocalConfigForScope).toHaveBeenCalledWith(
        expect.not.objectContaining({ primaryRole: expect.anything() }),
        'project',
        process.cwd(),
      );
    });
  });
  describe('CLAUDE_CONFIG_DIR', () => {
    const relocated = path.join(HOME, '.claude-work');
    let originalConfigDir: string | undefined;

    beforeEach(() => {
      originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
      // vi.clearAllMocks() keeps implementations, so the re-init case below
      // would otherwise hand its saved config to every later test.
      vi.mocked(loadLocalConfigForScope).mockResolvedValue(null);
      let cloneDone = false;
      pathExistsFn = (p: string) => (p === localPath ? cloneDone : false);
      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });
      questionAnswers = ['n'];
    });

    afterEach(() => {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    });

    async function savedConfig(): Promise<Record<string, unknown>> {
      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });
      const call = vi.mocked(saveLocalConfig).mock.calls.at(-1);
      if (!call) throw new Error('expected the local config to be saved');
      return call[0] as unknown as Record<string, unknown>;
    }

    it('records a relocated Claude Code root so later runs target it', async () => {
      process.env.CLAUDE_CONFIG_DIR = relocated;

      expect(await savedConfig()).toMatchObject({ toolRoots: { claude: relocated } });
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.info).mock.calls.map(([m]) => String(m)).join('\n'))
        .toContain(`Recorded CLAUDE_CONFIG_DIR as the Claude Code root: ${relocated}`);
    });

    it('records nothing when the variable is unset', async () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(await savedConfig()).not.toHaveProperty('toolRoots');
    });

    it('records an explicit default root, which moves the MCP file into it', async () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(HOME, '.claude');
      expect(await savedConfig()).toMatchObject({ toolRoots: { claude: path.join(HOME, '.claude') } });
    });

    it('keeps the recorded root when a re-init runs without the variable', async () => {
      vi.mocked(loadLocalConfigForScope).mockResolvedValue({
        repo: { localPath: localPath, remote: 'https://git.woa.com/HyperAI/teamai-test.git' },
        username: 'testuser',
        scope: 'user',
        additionalRoles: [],
        toolRoots: { claude: relocated },
      } as never);
      delete process.env.CLAUDE_CONFIG_DIR;

      expect(await savedConfig()).toMatchObject({ toolRoots: { claude: relocated } });
    });

    describe('re-init that moves the root', () => {
      beforeEach(async () => {
        // The previous root is derived from the team's toolPaths, so a team
        // config has to exist for the comparison to happen at all.
        const { TeamaiConfigSchema } = await import('../types.js');
        const { loadTeamConfig } = await import('../config.js');
        vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'r' }));
      });

      const previousConfig = (toolRoots?: Record<string, string>) => ({
        repo: { localPath: localPath, remote: 'https://git.woa.com/HyperAI/teamai-test.git' },
        username: 'testuser',
        scope: 'user',
        additionalRoles: [],
        ...(toolRoots ? { toolRoots } : {}),
      }) as never;

      async function removedHooksFrom(): Promise<string[]> {
        const { reconcileHooks } = await import('../hooks.js');
        return vi.mocked(reconcileHooks).mock.calls.map(([p]) => String(p));
      }

      function settingsExistsAt(settingsPath: string): void {
        const cloneProbe = pathExistsFn;
        pathExistsFn = (p: string) => p === settingsPath || cloneProbe(p);
      }

      it('removes the hooks left in the previous root, and says what stays', async () => {
        vi.mocked(loadLocalConfigForScope).mockResolvedValue(previousConfig({ claude: relocated }));
        const oldSettings = path.join(relocated, 'settings.json');
        settingsExistsAt(oldSettings);
        const moved = path.join(HOME, '.claude-other');
        process.env.CLAUDE_CONFIG_DIR = moved;

        expect(await savedConfig()).toMatchObject({ toolRoots: { claude: moved } });
        expect(await removedHooksFrom()).toEqual([oldSettings]);
        // The MCP servers and the delivered gateway credentials in the old root
        // are active config, not inert copies: both are released as well.
        const { reconcileMcpForConfig } = await import('../mcp-reconcile.js');
        expect(vi.mocked(reconcileMcpForConfig)).toHaveBeenCalledWith(
          // Claude's file only: the reconciler walks every tool of the config
          // it is handed, and the other tools' servers did not move.
          expect.objectContaining({ toolPaths: { claude: expect.anything() } }),
          expect.objectContaining({ toolRoots: { claude: relocated } }),
          { removeAll: true },
        );
        const { releaseClaudeModelConfig } = await import('../local-agent.js');
        expect(vi.mocked(releaseClaudeModelConfig)).toHaveBeenCalledWith(relocated);
        // Team hooks are only stripped on a manifest-aware pass; a plain
        // removeHooks() would leave them firing in the old root.
        const { reconcileHooks } = await import('../hooks.js');
        expect(vi.mocked(reconcileHooks).mock.calls[0]?.[3]).toMatchObject({
          removeAll: true,
          manifestPath: expect.stringContaining('managed-hooks'),
        });
        const { log } = await import('../utils/logger.js');
        const warned = vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).join('\n');
        expect(warned).toContain(`Claude Code now syncs to ${moved}`);
        expect(warned).toContain(`under ${relocated} were left in place`);
      });

      it('removes the hooks from the default root when a root is recorded for the first time', async () => {
        vi.mocked(loadLocalConfigForScope).mockResolvedValue(previousConfig());
        const oldSettings = path.join(HOME, '.claude', 'settings.json');
        settingsExistsAt(oldSettings);
        process.env.CLAUDE_CONFIG_DIR = relocated;

        expect(await savedConfig()).toMatchObject({ toolRoots: { claude: relocated } });
        expect(await removedHooksFrom()).toEqual([oldSettings]);
      });

      it('leaves the previous root alone when the root did not move', async () => {
        vi.mocked(loadLocalConfigForScope).mockResolvedValue(previousConfig({ claude: relocated }));
        settingsExistsAt(path.join(relocated, 'settings.json'));
        process.env.CLAUDE_CONFIG_DIR = relocated;

        expect(await savedConfig()).toMatchObject({ toolRoots: { claude: relocated } });
        expect(await removedHooksFrom()).toEqual([]);
      });

      it('clears the record when the variable is set but blank, and releases the old root', async () => {
        vi.mocked(loadLocalConfigForScope).mockResolvedValue(previousConfig({ claude: relocated }));
        const oldSettings = path.join(relocated, 'settings.json');
        settingsExistsAt(oldSettings);
        process.env.CLAUDE_CONFIG_DIR = '';

        expect(await savedConfig()).not.toHaveProperty('toolRoots');
        expect(await removedHooksFrom()).toEqual([oldSettings]);
        const { log } = await import('../utils/logger.js');
        expect(vi.mocked(log.info).mock.calls.map(([m]) => String(m)).join('\n'))
          .toContain('Cleared the recorded Claude Code root');
      });

      it('lets a project-scope init without the variable inherit the user-scope record', async () => {
        vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) =>
          scope === 'user' ? previousConfig({ claude: relocated }) : null);
        delete process.env.CLAUDE_CONFIG_DIR;

        await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'project' });
        const { saveLocalConfigForScope } = await import('../config.js');
        expect(saveLocalConfigForScope).toHaveBeenCalledWith(
          expect.objectContaining({ scope: 'project', toolRoots: { claude: relocated } }),
          'project',
          process.cwd(),
        );
      });

      it('never creates the previous settings file just to clean it', async () => {
        vi.mocked(loadLocalConfigForScope).mockResolvedValue(previousConfig({ claude: relocated }));
        process.env.CLAUDE_CONFIG_DIR = path.join(HOME, '.claude-other');

        await savedConfig();
        expect(await removedHooksFrom()).toEqual([]);
      });
    });

    it('refuses a root outside the home directory and says why', async () => {
      process.env.CLAUDE_CONFIG_DIR = '/opt/claude-config';

      expect(await savedConfig()).not.toHaveProperty('toolRoots');
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).join('\n'))
        .toContain('outside the home directory');
    });

    it('refuses a root nested deeper than the installed-tool check can look', async () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'configs', 'claude');

      expect(await savedConfig()).not.toHaveProperty('toolRoots');
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).join('\n'))
        .toContain('~/.config/<name>');
    });

    it('refuses ~/.config itself', async () => {
      process.env.CLAUDE_CONFIG_DIR = path.join(HOME, '.config');

      expect(await savedConfig()).not.toHaveProperty('toolRoots');
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.warn).mock.calls.map(([m]) => String(m)).join('\n'))
        .toContain('~/.config itself');
    });
  });
});

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

vi.mock('../config.js', () => ({
  saveLocalConfig: vi.fn(),
  saveLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn(),
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
}));

// Track pathExists calls to simulate directory states
let pathExistsFn: (p: string) => boolean = () => false;

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
}));

vi.mock('../types.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    TEAMAI_HOME: '/tmp/test-teamai-home',
  };
});

// Mock prompt to auto-answer prompts
let questionAnswers: string[] = [];
vi.mock('../utils/prompt.js', () => ({
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
import { RepoNotFoundError } from '../providers/types.js';
import { saveLocalConfig } from '../config.js';

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

      // Answers: create repo confirm (Y), configure reviewers (n), primary role (1), no additional roles
      questionAnswers = ['Y', 'n', '1', ''];

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
    it('writes primaryRole, additionalRoles, and resourceProfileVersion when roles are selected', async () => {
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

      questionAnswers = ['n', '1', '1'];

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      expect(saveLocalConfig).toHaveBeenCalledWith(expect.objectContaining({
        primaryRole: 'hai',
        additionalRoles: ['pm'],
        resourceProfileVersion: 1,
      }));
    });
  });

  describe('scope path display', () => {
    it('should display storage paths when scope is not provided via flag', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      // Answers: scope (user via default), configure reviewers (n), primary role (1), no additional
      questionAnswers = ['user', 'n', '1', ''];

      const { log } = await import('../utils/logger.js');

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git' });

      // Verify that path hints were displayed
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('user'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('.teamai/'));
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('project'));
    });

    it('should not display storage paths when scope is provided via --scope flag', async () => {
      let cloneDone = false;
      pathExistsFn = (p: string) => {
        if (p === localPath) return cloneDone;
        return false;
      };

      mockGfRepoClone.mockImplementation(() => {
        cloneDone = true;
      });

      // Answers: configure reviewers (n), primary role (1), no additional
      questionAnswers = ['n', '1', ''];

      const { log } = await import('../utils/logger.js');
      vi.mocked(log.info).mockClear();

      await init({ repo: 'https://git.woa.com/HyperAI/teamai-test.git', scope: 'user' });

      // When --scope is provided, the path hints are NOT shown before the prompt
      // (they appear in the "Scope: user" line only)
      const infoCalls = vi.mocked(log.info).mock.calls.map(c => c[0]);
      const pathHintCalls = infoCalls.filter(
        (msg: string) => msg.includes('user    →') || msg.includes('project →'),
      );
      expect(pathHintCalls).toHaveLength(0);
    });
  });
});

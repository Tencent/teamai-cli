import { describe, it, expect, vi, beforeEach } from 'vitest';
import { push } from '../push.js';

const mockAutoDetectInit = vi.fn();
const mockPullRepo = vi.fn();
const mockPushRepoBranch = vi.fn();
const mockCheckoutMaster = vi.fn();
const mockGenerateBranchName = vi.fn();
const mockLoadStateForScope = vi.fn();
const mockSaveStateForScope = vi.fn();
const mockLoadRolesManifest = vi.fn();
const mockGetHandler = vi.fn();
const mockPathExists = vi.fn();
const mockListDirs = vi.fn();

vi.mock('../utils/prompt.js', () => ({
  askQuestion: vi.fn(() => Promise.resolve('1')),
  askConfirmation: vi.fn(() => Promise.resolve(true)),
  askSelection: vi.fn((_prompt: string, itemCount: number, defaultAll?: boolean) => {
    if (defaultAll) return Promise.resolve(Array.from({ length: itemCount }, (__, i) => i));
    return Promise.resolve(null);
  }),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: (...args: unknown[]) => mockLoadStateForScope(...args),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));

vi.mock('../utils/git.js', () => ({
  createGit: vi.fn().mockReturnValue({
    status: vi.fn().mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: [],
      staged: [],
    }),
    merge: vi.fn(),
    stash: vi.fn(),
    reset: vi.fn(),
    clean: vi.fn(),
  }),
  pullRepo: (...args: unknown[]) => mockPullRepo(...args),
  pushRepoBranch: (...args: unknown[]) => mockPushRepoBranch(...args),
  checkoutMaster: (...args: unknown[]) => mockCheckoutMaster(...args),
  generateBranchName: (...args: unknown[]) => mockGenerateBranchName(...args),
  resetToCleanMaster: vi.fn(),
}));

vi.mock('../roles.js', async () => {
  const actual = await vi.importActual('../roles.js');
  return {
    ...actual,
    loadRolesManifest: (...args: unknown[]) => mockLoadRolesManifest(...args),
  };
});

vi.mock('../resources/index.js', () => ({
  getHandler: (...args: unknown[]) => mockGetHandler(...args),
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

vi.mock('../resources/skills.js', () => ({
  scanTeamRepoNamespaces: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/fs.js', async () => {
  const actual = await vi.importActual('../utils/fs.js');
  return {
    ...actual,
    pathExists: (...args: unknown[]) => mockPathExists(...args),
    listDirs: (...args: unknown[]) => mockListDirs(...args),
  };
});

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    parseRepoInput: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo' }),
    createPullRequest: vi.fn().mockReturnValue('https://git.woa.com/mr/1'),
  }),
}));

// Isolation: push() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

function makeLocalConfig(overrides: Record<string, unknown> = {}) {
  return {
    repo: { localPath: '/tmp/team-repo', remote: 'https://git.woa.com/test/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
    primaryRole: 'hai',
    additionalRoles: [],
    resourceProfileVersion: 1,
    scope: 'user',
    ...overrides,
  };
}

function makeTeamConfig() {
  return {
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit',
    reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: true } },
    toolPaths: {},
  };
}

function setupDefaultMocks() {
  mockPullRepo.mockResolvedValue('Already up to date.');
  mockPushRepoBranch.mockResolvedValue(true);
  mockCheckoutMaster.mockResolvedValue(undefined);
  mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
  mockLoadStateForScope.mockResolvedValue({
    lastPush: null,
    lastPull: null,
    lastPullRev: null,
    pushedRules: [],
    pushedSkills: [],
    pushedEnvVars: [],
    lastUpdateCheck: null,
    availableUpdate: null,
  });
  mockSaveStateForScope.mockResolvedValue(undefined);
  mockLoadRolesManifest.mockResolvedValue({
    version: 1,
    roles: [
      { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
    ],
  });
  // Default: pathExists returns false (most paths don't exist)
  mockPathExists.mockResolvedValue(false);
  mockListDirs.mockResolvedValue([]);
  // Default handler: no items from scan
  mockGetHandler.mockImplementation(() => ({
    scanLocalForPush: vi.fn().mockResolvedValue([]),
    pushItem: vi.fn(),
  }));
}

describe('push --skill flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it('filters scan results to matching skill by sourcePath', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'skill-a', type: 'skills', sourcePath: '/home/user/.claude/skills/skill-a', relativePath: 'skills/hai/skill-a', status: 'modified', namespace: 'hai' },
            { name: 'skill-b', type: 'skills', sourcePath: '/home/user/.claude/skills/skill-b', relativePath: 'skills/hai/skill-b', status: 'modified', namespace: 'hai' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    await push({ all: true, skill: '/home/user/.claude/skills/skill-a' });

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('skill-a');
  });

  it('matches skill by name (basename of path)', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'my-skill', type: 'skills', sourcePath: '/home/user/.claude/skills/my-skill', relativePath: 'skills/hai/my-skill', status: 'new' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    await push({ all: true, skill: '/some/other/path/my-skill' });

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('my-skill');
  });

  it('force-constructs ResourceItem when skill path exists but not in scan results', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    // Scan returns nothing (skill not detected due to name collision)
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // Mock filesystem: skill path exists with SKILL.md, team repo has namespace
    mockPathExists.mockImplementation(async (p: string) => {
      const pathStr = String(p);
      // The skill directory and SKILL.md exist
      if (pathStr === '/home/user/.claude/skills/hai/my-skill') return true;
      if (pathStr === '/home/user/.claude/skills/hai/my-skill/SKILL.md') return true;
      // Team repo skills dir exists
      if (pathStr === '/tmp/team-repo/skills') return true;
      // Namespace dir hai_dev contains our skill
      if (pathStr === '/tmp/team-repo/skills/hai_dev/my-skill') return true;
      // hai_dev is a namespace (no SKILL.md at top level)
      if (pathStr === '/tmp/team-repo/skills/hai_dev/SKILL.md') return false;
      return false;
    });
    mockListDirs.mockResolvedValue(['hai_dev']);

    await push({ all: true, skill: '/home/user/.claude/skills/hai/my-skill' });

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('my-skill');
    expect(pushedItems[0].namespace).toBe('hai_dev');
    expect(pushedItems[0].status).toBe('modified');
    expect(pushedItems[0].relativePath).toBe('skills/hai_dev/my-skill');
    expect(pushedItems[0].sourcePath).toBe('/home/user/.claude/skills/hai/my-skill');
  });

  it('force-constructs new skill when not in team repo', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // Skill exists locally but NOT in team repo
    mockPathExists.mockImplementation(async (p: string) => {
      const pathStr = String(p);
      if (pathStr === '/home/user/.claude/skills/brand-new-skill') return true;
      if (pathStr === '/home/user/.claude/skills/brand-new-skill/SKILL.md') return true;
      if (pathStr === '/tmp/team-repo/skills') return true;
      // No matching skill in any namespace
      return false;
    });
    mockListDirs.mockResolvedValue(['hai_dev']);

    await push({ all: true, skill: '/home/user/.claude/skills/brand-new-skill' });

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('brand-new-skill');
    expect(pushedItems[0].status).toBe('new');
    // New skills get assigned a namespace by the namespace resolution step (Step 4)
    // When primaryRole=hai with namespaces [common, hai], user selects "1" → common
    expect(pushedItems[0].namespace).toBe('common');
    expect(pushedItems[0].relativePath).toBe('skills/common/brand-new-skill');
  });

  it('detects modified status for flat layout skill in team repo', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // Flat layout: skill exists directly under skills/
    mockPathExists.mockImplementation(async (p: string) => {
      const pathStr = String(p);
      if (pathStr === '/home/user/.claude/skills/flat-skill') return true;
      if (pathStr === '/home/user/.claude/skills/flat-skill/SKILL.md') return true;
      if (pathStr === '/tmp/team-repo/skills') return true;
      // Not in any namespace subdir
      if (pathStr.includes('hai_dev/flat-skill')) return false;
      // But exists at flat level
      if (pathStr === '/tmp/team-repo/skills/flat-skill') return true;
      return false;
    });
    mockListDirs.mockResolvedValue(['hai_dev']);

    await push({ all: true, skill: '/home/user/.claude/skills/flat-skill' });

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('flat-skill');
    expect(pushedItems[0].status).toBe('modified');
    expect(pushedItems[0].namespace).toBeUndefined();
    expect(pushedItems[0].relativePath).toBe('skills/flat-skill');
  });

  it('exits with error when skill path does not exist', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation(() => ({
      scanLocalForPush: vi.fn().mockResolvedValue([]),
      pushItem: vi.fn(),
    }));

    // Path does not exist
    mockPathExists.mockResolvedValue(false);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(push({ all: true, skill: '/nonexistent/skill' }))
      .rejects.toThrow('process.exit called');

    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('exits with error when path exists but has no SKILL.md', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation(() => ({
      scanLocalForPush: vi.fn().mockResolvedValue([]),
      pushItem: vi.fn(),
    }));

    // Directory exists but no SKILL.md
    mockPathExists.mockImplementation(async (p: string) => {
      if (String(p) === '/home/user/.claude/skills/not-a-skill') return true;
      return false; // SKILL.md doesn't exist
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(push({ all: true, skill: '/home/user/.claude/skills/not-a-skill' }))
      .rejects.toThrow('process.exit called');

    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('expands ~ in skill path', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    const os = await import('node:os');
    const homedir = os.homedir();

    // Mock filesystem for expanded path
    mockPathExists.mockImplementation(async (p: string) => {
      const pathStr = String(p);
      if (pathStr === `${homedir}/.claude/skills/tilde-skill`) return true;
      if (pathStr === `${homedir}/.claude/skills/tilde-skill/SKILL.md`) return true;
      if (pathStr === '/tmp/team-repo/skills') return false;
      return false;
    });

    await push({ all: true, skill: '~/.claude/skills/tilde-skill' });

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('tilde-skill');
    expect(pushedItems[0].sourcePath).toBe(`${homedir}/.claude/skills/tilde-skill`);
  });
});

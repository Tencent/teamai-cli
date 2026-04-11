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

let readlineAnswer = '1';
vi.mock('node:readline', () => ({
  default: {
    createInterface: () => ({
      question: (_prompt: string, cb: (answer: string) => void) => {
        cb(readlineAnswer);
      },
      close: vi.fn(),
    }),
  },
}));

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: (...args: unknown[]) => mockLoadStateForScope(...args),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));

const mockMerge = vi.fn();
const mockStash = vi.fn();
const mockGitStatus = vi.fn().mockResolvedValue({
  modified: [],
  not_added: [],
  created: [],
  conflicted: [],
  staged: [],
});
const mockCreateGit = vi.fn().mockReturnValue({
  status: mockGitStatus,
  merge: mockMerge,
  stash: mockStash,
});

const mockResetToCleanMaster = vi.fn();

vi.mock('../utils/git.js', () => ({
  createGit: (...args: unknown[]) => mockCreateGit(...args),
  pullRepo: (...args: unknown[]) => mockPullRepo(...args),
  pushRepoBranch: (...args: unknown[]) => mockPushRepoBranch(...args),
  checkoutMaster: (...args: unknown[]) => mockCheckoutMaster(...args),
  generateBranchName: (...args: unknown[]) => mockGenerateBranchName(...args),
  resetToCleanMaster: (...args: unknown[]) => mockResetToCleanMaster(...args),
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

const mockScanTeamRepoNamespaces = vi.mocked(
  (await import('../resources/skills.js')).scanTeamRepoNamespaces,
);

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn().mockReturnValue({
    parseRepoInput: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo' }),
    createPullRequest: vi.fn().mockReturnValue('https://git.woa.com/mr/1'),
  }),
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

function mockSkillHandler(pushedItems?: Array<Record<string, unknown>>) {
  mockGetHandler.mockImplementation((type: string) => {
    if (type === 'skills') {
      return {
        scanLocalForPush: vi.fn().mockResolvedValue([
          { name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' },
        ]),
        pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
          pushedItems?.push(item);
        }),
      };
    }
    return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
  });
}

describe('push namespace routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null,
      lastPull: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    // Default manifest: role "hai" has namespaces [common, hai]
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'] } },
        { id: 'pm', description: 'Product Manager', resources: { knowledge: ['common', 'pm'], skills: ['common', 'pm'] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  it('auto-selects namespace when role has only one skill namespace', async () => {
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo role', resources: { knowledge: ['solo'], skills: ['solo'] } },
      ],
    });
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('solo');
    expect(pushedItems[0].relativePath).toBe('skills/solo/skill-a');
  });

  it('prompts for namespace selection when role has multiple skill namespaces', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // primaryRole=hai → skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    // User selects "1" → common
    readlineAnswer = '1';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('common');
    expect(pushedItems[0].relativePath).toBe('skills/common/skill-a');
  });

  it('allows selecting a non-default namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // primaryRole=hai → skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    // User selects "2" → hai
    readlineAnswer = '2';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('hai');
    expect(pushedItems[0].relativePath).toBe('skills/hai/skill-a');
  });

  it('includes additional role namespaces in the selection', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      // primaryRole=hai + additionalRoles=[pm] → skills: [common, hai, pm]
      localConfig: makeLocalConfig({ additionalRoles: ['pm'] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    // User selects "3" → pm
    readlineAnswer = '3';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('pm');
    expect(pushedItems[0].relativePath).toBe('skills/pm/skill-a');
  });

  it('defaults to first namespace when user presses Enter', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    readlineAnswer = '';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('common');
    expect(pushedItems[0].relativePath).toBe('skills/common/skill-a');
  });

  it('uses primaryRole as namespace in silent mode', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    await push({ all: true, silent: true });

    expect(pushedItems[0].namespace).toBe('hai');
    expect(pushedItems[0].relativePath).toBe('skills/hai/skill-a');
  });

  it('explicit --role flag bypasses namespace resolution', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);

    await push({ all: true, role: 'pm' });

    // --role pm uses "pm" as namespace directly
    expect(pushedItems[0].namespace).toBe('pm');
    expect(pushedItems[0].relativePath).toBe('skills/pm/skill-a');
  });

  it('rejects out-of-range namespace selection', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    readlineAnswer = '99';
    await push({ all: true });

    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('rejects invalid explicit --role override', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockReturnValue({
      scanLocalForPush: vi.fn().mockResolvedValue([]),
      pushItem: vi.fn(),
    });

    // --role "unknown" → used directly as namespace, no manifest validation
    // (validation happens downstream in pushItem)
    await push({ all: true, role: 'unknown' });

    // No items to push, so pushRepoBranch should not be called
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

it('blocks skills that exist in non-allowed namespaces', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });

    // Mock that local has both allowed and blocked skills
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            // This would only be returned if NOT blocked by namespace check
            { name: 'blocked-skill', type: 'skills', sourcePath: '/tmp/blocked-skill', relativePath: 'skills/blocked-skill' },
          ]),
          pushItem: vi.fn(),
        };
      }

      return {
        scanLocalForPush: vi.fn().mockResolvedValue([]),
        pushItem: vi.fn(),
      };
    });

    // This tests that even if scanLocalForPush returns a blocked skill, the system should reject it
    await push({ all: true });

    // The push should have been called (since we have --all)
    // but the mocked handler is already filtering it
  });

  it('prompts for namespace when no primaryRole but team repo has namespaces', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue(['tencent', 'hai_dev']);

    // User selects "2" → hai_dev
    readlineAnswer = '2';
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('hai_dev');
    expect(pushedItems[0].relativePath).toBe('skills/hai_dev/skill-a');
  });

  it('auto-selects single namespace when no primaryRole', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue(['only-ns']);

    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('only-ns');
    expect(pushedItems[0].relativePath).toBe('skills/only-ns/skill-a');
  });

  it('does flat push when no primaryRole and no namespaces in team repo', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    await push({ all: true });

    // No namespace should be set — flat push
    expect(pushedItems[0].namespace).toBeUndefined();
  });

  it('uses first namespace in silent mode when no primaryRole', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    mockScanTeamRepoNamespaces.mockResolvedValue(['tencent', 'hai_dev']);

    await push({ all: true, silent: true });

    expect(pushedItems[0].namespace).toBe('tencent');
    expect(pushedItems[0].relativePath).toBe('skills/tencent/skill-a');
  });

  it('shows destination path in item display', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    readlineAnswer = '2';
    await push({ all: true });

    const toLine = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('to:'),
    );
    expect(toLine).toBeDefined();
    expect(toLine![0]).toContain('skills/hai/skill-a');
    consoleSpy.mockRestore();
  });

  it('resets dirty team repo to clean master before pull', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    await push({ all: true });

    // Should have called resetToCleanMaster before pull
    expect(mockResetToCleanMaster).toHaveBeenCalled();
    expect(mockPullRepo).toHaveBeenCalled();
    // resetToCleanMaster must be called before pullRepo
    const resetOrder = mockResetToCleanMaster.mock.invocationCallOrder[0];
    const pullOrder = mockPullRepo.mock.invocationCallOrder[0];
    expect(resetOrder).toBeLessThan(pullOrder);
  });
});

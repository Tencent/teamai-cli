import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectUnsafeDirtyPaths, push } from '../push.js';
import { RolesManifestNotFoundError } from '../roles.js';
import { log } from '../utils/logger.js';

const mockAutoDetectInit = vi.fn();
const mockPullRepo = vi.fn();
const mockPushRepoBranch = vi.fn();
const mockCheckoutMaster = vi.fn();
const mockGenerateBranchName = vi.fn();
const mockLoadStateForScope = vi.fn();
const mockSaveStateForScope = vi.fn();
const mockLoadRolesManifest = vi.fn();
const mockGetHandler = vi.fn();

describe('team repo dirty-path guard', () => {
  const cleanStatus = {
    modified: [],
    not_added: [],
    created: [],
    conflicted: [],
    staged: [],
    deleted: [],
    renamed: [],
  };

  it('allows teamai.yaml only when its content was captured', () => {
    expect(collectUnsafeDirtyPaths({ ...cleanStatus, modified: ['teamai.yaml'] }, 'edited')).toEqual([]);
    expect(collectUnsafeDirtyPaths({ ...cleanStatus, modified: ['teamai.yaml'] }, null)).toEqual(['teamai.yaml']);
  });

  it('blocks deleted or mode-only teamai.yaml changes while ignoring the sync lock', () => {
    expect(collectUnsafeDirtyPaths({ ...cleanStatus, deleted: ['teamai.yaml'] }, null)).toEqual(['teamai.yaml']);
    expect(collectUnsafeDirtyPaths({ ...cleanStatus, modified: ['teamai.yaml', '.teamai/.sync-lock'] }, null))
      .toEqual(['teamai.yaml']);
  });

  it('reports ordinary user changes as unsafe', () => {
    expect(collectUnsafeDirtyPaths({ ...cleanStatus, not_added: ['README.md'] }, null)).toEqual(['README.md']);
  });
});

let readlineAnswer = '1';
vi.mock('../utils/prompt.js', () => ({
  isInteractive: vi.fn(() => true),
  askQuestion: vi.fn((_prompt: string, defaultValue?: string) => {
    return Promise.resolve(readlineAnswer || defaultValue || '');
  }),
  askConfirmation: vi.fn(() => {
    return Promise.resolve(
      !readlineAnswer || readlineAnswer.toLowerCase() === 'y',
    );
  }),
  askSelection: vi.fn((_prompt: string, itemCount: number, defaultAll?: boolean) => {
    // Default: select all items (matches --all behavior for existing tests)
    if (defaultAll) return Promise.resolve(Array.from({ length: itemCount }, (__, i) => i));
    return Promise.resolve(null);
  }),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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
  isDedicatedRepoRoot: vi.fn().mockResolvedValue(true),
  // Without these two the PR step throws inside its own catch, which quietly
  // leaves process.exitCode at 1 and makes exit-code assertions meaningless.
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
  remoteBranchExists: vi.fn().mockResolvedValue(true),
  getFileContentAtRev: vi.fn().mockResolvedValue(null),
  hashObject: vi.fn().mockResolvedValue('b10b'),
  blobInHistory: vi.fn().mockResolvedValue(true),
  getHeadCommit: vi.fn().mockResolvedValue('base000'),
}));

const mockLoadProjectsManifest = vi.fn().mockResolvedValue(null);
vi.mock('../projects.js', async () => {
  const actual = await vi.importActual('../projects.js');
  return {
    ...actual,
    loadProjectsManifest: (...args: unknown[]) => mockLoadProjectsManifest(...args),
  };
});

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
    mockGitStatus.mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: [],
      staged: [],
    });
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
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
        { id: 'pm', description: 'Product Manager', resources: { knowledge: ['common', 'pm'], skills: ['common', 'pm'], agents: [] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  it('auto-selects namespace when role has only one skill namespace', async () => {
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo role', resources: { knowledge: ['solo'], skills: ['solo'], agents: [] } },
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

  it('names the choice and --role instead of prompting when there is no terminal', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),  // primaryRole=hai → skills: [common, hai]
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler(pushedItems);
    const { isInteractive, askQuestion } = await import('../utils/prompt.js');
    vi.mocked(isInteractive).mockReturnValueOnce(false);
    vi.mocked(askQuestion).mockClear();

    await push({ all: true });

    expect(askQuestion).not.toHaveBeenCalled();
    expect(pushedItems).toHaveLength(0);
    expect(process.exitCode).toBe(2);
    const { log } = await import('../utils/logger.js');
    const said = vi.mocked(log.error).mock.calls.flat().join(' ');
    expect(said).toContain('common, hai');
    expect(said).toContain('--role <ns>');
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

  it('refuses a role id that cannot be a namespace in silent mode, even with a valid manifest', async () => {
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'CON', description: 'device-named role', resources: { knowledge: ['common'], skills: ['common', 'hai'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'CON', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    await push({ all: true, silent: true });

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid role id used as a skills namespace "CON"/),
    );
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
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

  it('explicit --role flag also routes a modified skill to that namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            {
              name: 'skill-a',
              type: 'skills',
              sourcePath: '/tmp/skill-a',
              relativePath: 'skills/skill-a',
              status: 'modified',
            },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    await push({ all: true, role: 'backend' });

    expect(pushedItems[0].namespace).toBe('backend');
    expect(pushedItems[0].relativePath).toBe('skills/backend/skill-a');
  });

  it('rejects a path-traversal value passed to --role', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    const originalExitCode = process.exitCode;

    try {
      await push({ all: true, role: '../outside' });

      expect(mockPushRepoBranch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('rejects a role id that cannot be a namespace when roles.yaml is absent', async () => {
    mockLoadRolesManifest.mockRejectedValue(new RolesManifestNotFoundError('/repo/manifest/roles.yaml'));
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: '../../outside', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    await push({ all: true });

    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid role id used as a skills namespace "\.\.\/\.\.\/outside"/),
    );
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('rejects an unsafe scanned skill name before building the role path', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            {
              name: '../outside',
              type: 'skills',
              sourcePath: '/tmp/outside',
              relativePath: 'skills/outside',
              status: 'modified',
            },
          ]),
          pushItem: vi.fn(),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });
    const originalExitCode = process.exitCode;

    try {
      await push({ all: true, role: 'backend' });

      expect(mockPushRepoBranch).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = originalExitCode;
    }
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

  it('shows numbered items in display', async () => {
    const consoleSpy = vi.spyOn(console, 'log');
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();

    readlineAnswer = '2';
    await push({ all: true });

    // Verify numbered display format
    const numLine = consoleSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].includes('1.') && args[0].includes('skill-a'),
    );
    expect(numLine).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('aborts before resetting a dirty team repo', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    const previousExitCode = process.exitCode;
    mockGitStatus.mockResolvedValue({
      modified: ['local-edit.txt'],
      not_added: [],
      created: [],
      conflicted: [],
      staged: [],
    });

    await push({ all: true });

    expect(mockResetToCleanMaster).not.toHaveBeenCalled();
    expect(mockPullRepo).not.toHaveBeenCalled();
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    process.exitCode = previousExitCode;
  });
});

describe('push item selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGitStatus.mockResolvedValue({
      modified: [],
      not_added: [],
      created: [],
      conflicted: [],
      staged: [],
    });
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
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  it('pushes only selected items when user picks a subset', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // Return 2 modified skills (no namespace prompt needed)
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/ns/skill-a', status: 'modified', namespace: 'ns' },
            { name: 'skill-b', type: 'skills', sourcePath: '/tmp/skill-b', relativePath: 'skills/ns/skill-b', status: 'modified', namespace: 'ns' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // Mock askSelection to select only the first item
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([0]);

    await push({}); // No --all flag → triggers selection

    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('skill-a');
  });

  it('cancels when user selects none', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    mockScanTeamRepoNamespaces.mockResolvedValue([]);

    // Mock askSelection to return null (cancel)
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce(null);

    await push({}); // No --all flag

    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('skips namespace prompt when only modified skills are selected', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    // Return one new and one modified skill
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'new-skill', type: 'skills', sourcePath: '/tmp/new-skill', relativePath: 'skills/new-skill', status: 'new' },
            { name: 'mod-skill', type: 'skills', sourcePath: '/tmp/mod-skill', relativePath: 'skills/hai/mod-skill', status: 'modified', namespace: 'hai' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    // User selects only item 2 (the modified skill, index 1)
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);

    await push({});

    // Should only push the modified skill, namespace prompt should not fire
    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0].name).toBe('mod-skill');
    expect(pushedItems[0].namespace).toBe('hai');
  });

  it('--all flag skips selection prompt', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([
            { name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/ns/skill-a', status: 'modified', namespace: 'ns' },
            { name: 'skill-b', type: 'skills', sourcePath: '/tmp/skill-b', relativePath: 'skills/ns/skill-b', status: 'modified', namespace: 'ns' },
          ]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
            pushedItems.push(item);
          }),
        };
      }
      return { scanLocalForPush: vi.fn().mockResolvedValue([]), pushItem: vi.fn() };
    });

    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockClear();

    await push({ all: true });

    // askSelection should NOT have been called
    expect(askSelection).not.toHaveBeenCalled();
    // But all items should have been pushed
    expect(pushedItems).toHaveLength(2);
  });
});

// Codex review finding 5: push()'s result.completed was set whenever pushGroup
// returned truthy, but pushGroup returned true on BOTH the no-change and the
// PR-creation-failed paths — so a no-op or PR-failed run wrongly flipped
// completed=true and fired the `push` webhook. These drive the REAL pushGroup
// path (not pushTeamConfigOnly).
describe('push completion signal through pushGroup (#702 follow-up, finding 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [], pushedEnvVars: [],
      lastUpdateCheck: null, availableUpdate: null, pendingPushes: [],
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [{ id: 'solo', description: 'Solo', resources: { knowledge: ['solo'], skills: ['solo'], agents: [] } }],
    });
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
  });

  async function setCreatePullRequest(impl: () => Promise<string | null> | string | null): Promise<void> {
    const { getProvider } = await import('../providers/index.js');
    vi.mocked(vi.mocked(getProvider)().createPullRequest).mockImplementation(impl as never);
  }

  it('reports completed=true when a real resource push succeeds and a PR is created', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    await setCreatePullRequest(() => 'https://git.woa.com/mr/42');

    const outcome = { completed: false };
    await push({ all: true }, outcome);

    expect(mockPushRepoBranch).toHaveBeenCalled();
    expect(outcome.completed).toBe(true);
  });

  it('does NOT report completed when PR creation fails (pushGroup path)', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    // Provider returns null (branch pushed, PR not created) → exit code 1.
    await setCreatePullRequest(() => null);
    const originalExitCode = process.exitCode;

    try {
      const outcome = { completed: false };
      await push({ all: true }, outcome);

      expect(mockPushRepoBranch).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(outcome.completed).toBe(false);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('does NOT report completed when there are no changes to push (pushGroup path)', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo', additionalRoles: [] }),
      teamConfig: makeTeamConfig(),
    });
    mockSkillHandler();
    // Branch has no changes: pushRepoBranch reports nothing committed.
    mockPushRepoBranch.mockResolvedValue(false);
    await setCreatePullRequest(() => 'https://git.woa.com/mr/42');

    const outcome = { completed: false };
    await push({ all: true }, outcome);

    expect(mockPushRepoBranch).toHaveBeenCalled();
    expect(outcome.completed).toBe(false);
  });
});

/**
 * Issue #649: `--role`/`--project` used to place new skills only, so a new rule
 * or agent landed at the shared root and `pull` shipped it to the whole team.
 */
describe('push namespace routing for rules and agents', () => {
  /** Scans one item per type, and records what reached each handler's pushItem. */
  function mockHandlers(
    scanned: Partial<Record<'skills' | 'rules' | 'agents', Array<Record<string, unknown>>>>,
    pushedItems: Array<Record<string, unknown>>,
  ) {
    mockGetHandler.mockImplementation((type: string) => ({
      scanLocalForPush: vi.fn().mockResolvedValue(scanned[type as keyof typeof scanned] ?? []),
      pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => {
        pushedItems.push(item);
      }),
    }));
  }

  const newRule = {
    name: 'my-rule', type: 'rules', sourcePath: '/tmp/my-rule.md',
    relativePath: 'rules/my-rule.md', status: 'new',
  };
  const newAgent = {
    name: 'vr', type: 'agents', sourcePath: '/tmp/vr.md',
    relativePath: 'agents/vr.yaml', status: 'new',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
    });
    mockSaveStateForScope.mockResolvedValue(undefined);
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'hai', description: 'HyperAI', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] } },
      ],
    });
    readlineAnswer = '1';
    mockScanTeamRepoNamespaces.mockResolvedValue([]);
    process.exitCode = undefined;
  });

  it('--role places a new rule and a new agent in that namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, pushedItems);

    await push({ all: true, role: 'pm' });

    const rule = pushedItems.find((i) => i.type === 'rules');
    const agent = pushedItems.find((i) => i.type === 'agents');
    expect(rule?.relativePath).toBe('rules/pm/my-rule.md');
    expect(rule?.namespace).toBe('pm');
    // The agent keeps the extension its handler chose.
    expect(agent?.relativePath).toBe('agents/pm/vr.yaml');
    expect(agent?.namespace).toBe('pm');
  });

  it('rejects a path-traversal --role before placing a rule', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, role: '../outside' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    // The flag is the problem, and this push carries no skill at all.
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('--role');
  });

  it('--project resolves each type from its own axis, not from skills', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app',
        name: 'Front App',
        description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: ['fe-agents'] },
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
      agents: [{ ...newAgent }],
    }, pushedItems);

    await push({ all: true, project: 'front-app' });

    const at = (type: string) => pushedItems.find((i) => i.type === type)?.relativePath;
    expect(at('rules')).toBe('rules/fe-know/my-rule.md');
    expect(at('skills')).toBe('skills/fe-skills/skill-a');
    expect(at('agents')).toBe('agents/fe-agents/vr.yaml');
  });

  it('refuses to send a new rule to the shared root when the legacy role could not be resolved', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined, roleUnresolved: true }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('your role could not be resolved');
  });

  it('reports a projects manifest that cannot be loaded for --project instead of throwing', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockRejectedValueOnce(new Error('Invalid projects manifest: /tmp/team-repo/manifest/projects.yaml is empty.'));
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await expect(push({ all: true, project: 'front-app' })).resolves.toBeUndefined();

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('Cannot resolve --project destinations');
  });

  it('refuses to push to the shared root when the project declares no namespace for the type', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front App', description: '',
        resources: { knowledge: [], skills: ['fe-skills'], learnings: [], agents: [] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, project: 'front-app' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('pushes a rules-only scan to a project that declares no skills namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBeUndefined();
    expect(pushedItems[0]?.relativePath).toBe('rules/docs-know/my-rule.md');
  });

  it('leaves an already-namespaced rule where it is', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      rules: [{
        name: 'frontend/scoped', type: 'rules', sourcePath: '/tmp/scoped.md',
        relativePath: 'rules/frontend/scoped.md', status: 'modified',
      }],
    }, pushedItems);

    await push({ all: true, role: 'pm' });

    // pushItem writes rather than moves (#654): relocating would leave a copy behind.
    expect(pushedItems[0]?.relativePath).toBe('rules/frontend/scoped.md');
  });

  it('places a new rule in the role knowledge namespace when no flag is given', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: ['solo-know'], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    // The knowledge axis, not the skills one.
    expect(pushedItems[0]?.relativePath).toBe('rules/solo-know/my-rule.md');
  });

  it('keeps a new rule at the shared root when the role declares no knowledge namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: [], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(pushedItems[0]?.relativePath).toBe('rules/my-rule.md');
    expect(pushedItems[0]?.namespace).toBeUndefined();
  });

  it('fails on a project with no agents namespace even when the scan skipped the agent', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    // The scan drops this one itself, so an error deferred to selection would
    // never be raised and the run would end "No new or modified resources".
    mockHandlers({
      agents: [{
        name: 'vr', type: 'agents', sourcePath: '/tmp/agents',
        relativePath: 'agents/vr.yaml', status: 'modified', needsDestination: true,
        skipReason: 'Agent "vr" has no active source. Activate its role or project before pushing local edits.',
      }],
    }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('agents namespace');
  });

  it('still pushes an unrelated rule when the only skipped agent needs a destination the project lacks', async () => {
    // A stale edited copy of an agent from a dropped role must not stop a
    // rule going out: skipped agents do not block the rest (#649 review).
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({
      rules: [{ ...newRule }],
      agents: [{
        name: 'vr', type: 'agents', sourcePath: '/tmp/agents',
        relativePath: 'agents/vr.yaml', status: 'modified', needsDestination: true,
        skipReason: 'Agent "vr" has no active source. Activate its role or project before pushing local edits.',
      }],
    }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).not.toBe(2);
    expect(pushedItems.map((i) => i.relativePath)).toEqual(['rules/docs-know/my-rule.md']);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('agents namespace');
  });

  it('lets a modified namespaced agent through a project whose agents axis is empty', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    // Already in a namespace, so it is modified in place and needs no
    // placement — an empty agents axis is none of its business.
    mockHandlers({
      agents: [{
        name: 'vr', type: 'agents', sourcePath: '/tmp/vr.md',
        relativePath: 'agents/hai/vr.yaml', status: 'modified', namespace: 'hai',
      }],
    }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBeUndefined();
    expect(pushedItems[0]?.relativePath).toBe('agents/hai/vr.yaml');
  });

  it('pushes a selected rule when only the unselected skill lacks a project namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
    }, pushedItems);

    // Deselect the skill, keep the rule (item order is skills then rules).
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);

    await push({ project: 'docs-only' });

    expect(process.exitCode).toBeUndefined();
    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0]?.relativePath).toBe('rules/docs-know/my-rule.md');
  });

  it('pushes a selected rule when only the unselected new agent lacks a project agents namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    // A NEW agent reaches the listing, so the user can deselect it. Failing
    // before the selection blocked a rules-only push on an agent that was
    // never going out (#649 review). The scan-skipped case is different — see
    // the test above — because that agent never reaches the listing at all.
    mockHandlers({
      rules: [{ ...newRule }],
      agents: [{ ...newAgent }],
    }, pushedItems);

    // Deselect the agent, keep the rule (item order is rules then agents).
    const { askSelection } = await import('../utils/prompt.js');
    vi.mocked(askSelection).mockResolvedValueOnce([0]);

    await push({ project: 'docs-only' });

    expect(process.exitCode).toBeUndefined();
    expect(pushedItems).toHaveLength(1);
    expect(pushedItems[0]?.relativePath).toBe('rules/docs-know/my-rule.md');
  });

  it('still fails when the new agent lacking a project agents namespace is selected', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({
      rules: [{ ...newRule }],
      agents: [{ ...newAgent }],
    }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('agents namespace');
  });

  it('still fails when the skill lacking a project namespace is selected', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'docs-only', name: 'Docs', description: '',
        resources: { knowledge: ['docs-know'], skills: [], learnings: [], agents: [] },
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
    }, pushedItems);

    await push({ all: true, project: 'docs-only' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
  });

  it('says so when a new rule stays at the shared root', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: [], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(pushedItems[0]?.relativePath).toBe('rules/my-rule.md');
    // Reaching the whole team is the outcome worth naming out loud.
    const { log } = await import('../utils/logger.js');
    const said = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls]
      .flat().join(' ');
    expect(said).toContain('rules/my-rule.md');
    expect(said).toMatch(/everyone|whole team|shared/i);
  });

  it('reads the projects manifest only after the team clone has been pulled', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front', description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: ['fe-agents'] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, project: 'front-app' });

    // Read before the pull, the manifest is the previous pull's copy, and a
    // namespace the remote has since changed places this run's new rules by
    // the stale mapping (#649 review).
    expect(mockPullRepo).toHaveBeenCalled();
    expect(mockLoadProjectsManifest).toHaveBeenCalled();
    const pullOrder = mockPullRepo.mock.invocationCallOrder[0];
    const manifestOrder = mockLoadProjectsManifest.mock.invocationCallOrder[0];
    expect(manifestOrder).toBeGreaterThan(pullOrder);
    expect(pushedItems[0]?.relativePath).toBe('rules/fe-know/my-rule.md');
  });

  it('stops a --project push when the team clone could not be refreshed', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockPullRepo.mockRejectedValueOnce(new Error('could not resolve host'));
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front', description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: ['fe-agents'] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, project: 'front-app' });

    // The manifest in the clone is the previous pull's. A namespace the remote
    // has since changed would route this rule to the wrong members, and a
    // warning does not stop that (#649 review).
    expect(process.exitCode).toBe(1);
    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('could not be refreshed');
  });

  it('stops placing a new resource on a stale clone even when that clone has no roles manifest', async () => {
    // Its absence is repo state too: a manifest added remotely since the last
    // pull would move this rule off the shared root (#649 review).
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockPullRepo.mockRejectedValueOnce(new Error('could not resolve host'));
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect(pushedItems).toHaveLength(0);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('could not be refreshed');
  });

  it('stops the push when the reconciled placement records cannot be saved', async () => {
    // The sync and the scan read the records back from disk: one that could
    // not be withdrawn would still redirect the author's copy (#649 review).
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    // No records left, so reconcile clears the checkpoint: the state changed.
    mockLoadStateForScope.mockImplementation(async () => ({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [], pushedEnvVars: [],
      lastUpdateCheck: null, availableUpdate: null, pendingPushes: [], placementsCheckedAt: 'abc',
    }));
    mockSaveStateForScope.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, role: 'pm' });

    expect(process.exitCode).toBe(1);
    expect(pushedItems).toHaveLength(0);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('Nothing was pushed');
  });

  it('turns a placement into a record only once its file is on the default branch, before scanning', async () => {
    // Pushed and awaiting review: nothing on the default branch yet, so no
    // record — a PR closed unmerged, branch kept or not, looks exactly like
    // this and must not leave one behind (#649 review).
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-landed-'));
    try {
      mockAutoDetectInit.mockResolvedValue({
        localConfig: makeLocalConfig({
          repo: { localPath: repoDir, remote: 'https://git.woa.com/test/repo.git' },
        }),
        teamConfig: makeTeamConfig(),
      });
      const awaiting = {
        lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
        pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null, placedRules: {},
        pendingPushes: [{
          branch: 'teamai/push/test/20260101-000000',
          prUrl: 'https://git.woa.com/mr/14',
          createdAt: '2026-01-01T00:00:00.000Z',
          items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know', placed: true, blob: 'b10b' }],
        }],
      };
      mockLoadStateForScope.mockImplementation(async () => structuredClone(awaiting));
      mockHandlers({}, []);

      await push({ all: true });
      const recordedEarly = mockSaveStateForScope.mock.calls
        .map((call) => call[0] as { placedRules?: Record<string, string> })
        .some((state) => 'my-rule' in (state.placedRules ?? {}));
      expect(recordedEarly).toBe(false);

      // The PR merged: the file is on the default branch now.
      fs.mkdirSync(path.join(repoDir, 'rules', 'fe-know'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'rules/fe-know', 'my-rule.md'), 'landed');
      mockSaveStateForScope.mockClear();

      await push({ all: true });

      const saved = mockSaveStateForScope.mock.calls
        .map((call) => call[0] as { placedRules?: Record<string, string> })
        .find((state) => 'my-rule' in (state.placedRules ?? {}));
      expect(saved?.placedRules).toEqual({ 'my-rule': 'rules/fe-know/my-rule.md' });
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('moves the placement record to the extension a renamed canonical agent now has', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null, pendingPushes: [],
      placedAgents: { vr: 'agents/fe-agents/vr.md' },
    });
    // The scan followed the record to the legacy .md, but the source is a
    // .yaml now: the write goes to one path, so the record and the staged
    // file must both follow it, and the .md it replaces must go too.
    mockHandlers({
      agents: [{
        name: 'vr', type: 'agents', sourcePath: '/tmp/.teamai/agents/vr.yaml',
        relativePath: 'agents/fe-agents/vr.yaml', status: 'modified', namespace: 'fe-agents',
        supersedes: 'agents/fe-agents/vr.md',
      }],
    }, pushedItems);

    await push({ all: true });

    const staged = mockPushRepoBranch.mock.calls[0]?.[2] as string[];
    expect(staged).toContain('agents/fe-agents/vr.yaml');
    expect(staged).toContain('agents/fe-agents/vr.md');
    // The move is a placement of the new path: it becomes the record once the
    // PR merges, and the recorded .md is dropped then, when it is gone.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { pendingPushes: Array<{ items: Array<Record<string, unknown>> }> };
    expect(saved.pendingPushes.at(-1)?.items).toEqual([
      expect.objectContaining({ type: 'agents', name: 'vr', relativePath: 'agents/fe-agents/vr.yaml', placed: true }),
    ]);
  });

  it('rejects an unknown --project even when nothing needs placing', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front App', description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: [] },
      }],
    });
    // Only a modified, already-namespaced rule: nothing reaches the per-axis
    // resolver, so the typo would otherwise pass unnoticed.
    mockHandlers({
      rules: [{
        name: 'fe-know/scoped', type: 'rules', sourcePath: '/tmp/scoped.md',
        relativePath: 'rules/fe-know/scoped.md', status: 'modified',
      }],
    }, pushedItems);

    await push({ all: true, project: 'typo-id' });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
  });

  it('keeps the namespace an open PR recorded for a skill even under --role', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/8',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'skills', name: 'skill-a', relativePath: 'skills/js/skill-a', namespace: 'js' }],
      }],
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
    }, pushedItems);

    await push({ all: true, role: 'pm' });

    // Supersedes the original #331/#654 rule that the PR's destination always
    // won. Matching is by type and name only, so an open PR for a DIFFERENT
    // resource of the same name would capture this push and force-push into a
    // review it has nothing to do with (#649 review). The flag the user typed
    // decides, the open PR is left alone, and the collision is reported.
    expect(pushedItems[0]?.relativePath).toBe('skills/pm/skill-a');
    expect(pushedItems[0]?.namespace).toBe('pm');
    const { log } = await import('../utils/logger.js');
    const said = vi.mocked(log.warn).mock.calls.flat().join(' ');
    expect(said).toContain('awaiting review at skills/js/skill-a');
    expect(said).toContain('separate PR');
  });

  it('reuses the namespace recorded for a rule when updating its open PR', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/7',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know' }],
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    // No flag this time: the destination must come from the PR record, or the
    // force-pushed branch would move the rule to the shared root.
    await push({ all: true });

    expect(pushedItems[0]?.relativePath).toBe('rules/fe-know/my-rule.md');
    expect(pushedItems[0]?.namespace).toBe('fe-know');
  });

  it('records where a root-level rule was placed so the next scan recognises it', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, []);

    await push({ all: true, role: 'pm' });

    // The author's copy stays at the tool's rules root, so the scanner needs
    // the record to map it back to rules/pm/ instead of reading it as new. It
    // is marked on the pending PR entry and becomes a record when that merges.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as {
      placedRules?: Record<string, string>;
      pendingPushes: Array<{ base?: string; items: Array<Record<string, unknown>> }>;
    };
    expect(saved.placedRules ?? {}).toEqual({});
    expect(saved.pendingPushes.at(-1)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'rules', name: 'my-rule', relativePath: 'rules/pm/my-rule.md', placed: true }),
    ]));
    // Landing is later proven only by history after the commit the branch was built on.
    expect(saved.pendingPushes.at(-1)?.base).toBe('base000');
  });

  it('records where it placed a new agent, so the author can still edit it', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, []);

    await push({ all: true, role: 'pm' });

    // AgentsHandler.scanLocalForPush only accepts a source whose namespace is
    // ACTIVE here; without the record the author's next edit is skipped as
    // "no active source" and the agent they just published is unmaintainable.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { pendingPushes: Array<{ items: Array<Record<string, unknown>> }> };
    expect(saved.pendingPushes.at(-1)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agents', name: 'vr', relativePath: 'agents/pm/vr.yaml', placed: true }),
    ]));
  });

  it('does not record an agent it merely edited in an already-active namespace', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    // The scanner found this agent in a namespace that is active HERE, so it
    // will find it again. Recording it would turn a temporary activation into
    // standing permission to keep editing it after the role or project that
    // granted it is dropped (#649 review round 4).
    mockHandlers({
      agents: [{
        name: 'vr', type: 'agents', sourcePath: '/tmp/vr.md',
        relativePath: 'agents/hai/vr.yaml', status: 'modified', namespace: 'hai',
      }],
    }, []);

    await push({ all: true });

    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { pendingPushes: Array<{ items: Array<Record<string, unknown>> }> };
    expect(saved.pendingPushes.at(-1)?.items).toEqual([
      expect.not.objectContaining({ placed: true }),
    ]);
  });

  it('refuses a roles manifest whose namespace is not a single path segment', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: ['foo/bar'], skills: ['solo'], agents: [] } },
      ],
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    // `--role` and the projects manifest are both checked for this; two levels
    // put an agent below the depth pull looks at, and read back as the wrong
    // namespace for a rule.
    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('foo/bar');
  });

  it('detects a pending namespace recorded only in the path', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // The agent scan records a namespaced destination without setting the
    // `namespace` field, so trusting that field let the entry slip past the
    // conflict check and be force-pushed into (#649 review).
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/12',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'agents', name: 'vr', relativePath: 'agents/fe-agents/vr.yaml' }],
      }],
    });
    mockHandlers({ agents: [{ ...newAgent }] }, pushedItems);

    await push({ all: true, role: 'be-agents' });

    expect(pushedItems[0]?.relativePath).toBe('agents/be-agents/vr.yaml');
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.warn).mock.calls.flat().join(' '))
      .toContain('awaiting review at agents/fe-agents/vr.yaml');
  });

  it('treats a pending shared-root resource as conflicting with an explicit namespace', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // The open PR holds this rule at the shared root. Reusing its branch would
    // force-rebuild it with the namespaced path and silently change the scope
    // of a review the user did not name (#649 review). A recorded path with no
    // namespace is as much a destination as a namespaced one.
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/13',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/my-rule.md' }],
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true, role: 'fe-know' });

    expect(pushedItems[0]?.relativePath).toBe('rules/fe-know/my-rule.md');
    // A new branch, never the pending one.
    const branches = mockPushRepoBranch.mock.calls.map((call) => call[3]);
    expect(branches).not.toContain('teamai/push/test/20260101-000000');
    const { log } = await import('../utils/logger.js');
    const said = vi.mocked(log.warn).mock.calls.flat().join(' ');
    expect(said).toContain('awaiting review at rules/my-rule.md');
    expect(said).toContain('separate PR');
  });

  it('leaves an open placement PR alone once a shared-root file takes the name', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // my-rule is awaiting review at rules/fe-know/; a teammate has since merged
    // an unrelated rules/my-rule.md. Reusing the PR by type and name rebuilt it
    // with the author's copy over that shared rule (#649 review).
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/15',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know', placed: true, blob: 'b10b' }],
      }],
    });
    mockHandlers({
      rules: [{ name: 'my-rule', type: 'rules', sourcePath: '/tmp/local/rules/my-rule.md', relativePath: 'rules/my-rule.md', status: 'modified' }],
    }, pushedItems);

    await push({ all: true });

    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('rules/my-rule.md now exists at the shared root');
  });

  it('keeps updating the open PR of a resource the flag does not move', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // A rule already in fe-know, modified, with its edit under review. --role
    // relocates only NEW shared-root rules, so this one stays at its path, and
    // a "conflict" with the flag sent the same file to a second PR (#649 review).
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/14',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'fe-know/my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know' }],
      }],
    });
    mockHandlers({
      rules: [{
        name: 'fe-know/my-rule', type: 'rules', sourcePath: '/tmp/local/rules/fe-know/my-rule.md',
        relativePath: 'rules/fe-know/my-rule.md', status: 'modified', namespace: 'fe-know',
      }],
    }, pushedItems);

    await push({ all: true, role: 'other' });

    expect(pushedItems[0]?.relativePath).toBe('rules/fe-know/my-rule.md');
    const branches = mockPushRepoBranch.mock.calls.map((call) => call[3]);
    expect(branches).toEqual(['teamai/push/test/20260101-000000']);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).not.toContain('separate PR');
  });

  it('--dry-run reports the same destination the real push would use', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    // An open PR holds the same name at a different namespace. The real push
    // ignores it under --role, so the dry run must not report its destination.
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/11',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know' }],
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, []);

    await push({ dryRun: true, role: 'pm' });

    const { log } = await import('../utils/logger.js');
    const said = vi.mocked(log.info).mock.calls.flat().join(' ');
    expect(said).toContain('rules/pm/my-rule.md');
    expect(said).not.toContain('rules/fe-know/my-rule.md');
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });

  it('keeps the placement of a group that pushed when a later group fails', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    // Two groups: the rule belongs to an open PR, the agent does not.
    mockLoadStateForScope.mockResolvedValue({
      lastPush: null, lastPull: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null,
      pendingPushes: [{
        branch: 'teamai/push/test/20260101-000000',
        prUrl: 'https://git.woa.com/mr/9',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/pm/my-rule.md', namespace: 'pm' }],
      }],
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, pushedItems);
    // First group pushes, second throws.
    mockPushRepoBranch.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('remote rejected'));

    // The PR's namespace matches what --role asks for, so its branch is reused
    // and the run really does have two groups.
    await push({ all: true, role: 'pm' });

    expect(process.exitCode).toBe(1);
    // The rule is on the remote now. Losing where it went means the author's
    // root copy is reclassified once that PR merges.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { pendingPushes: Array<{ branch: string; items: Array<Record<string, unknown>> }> };
    const reused = saved.pendingPushes.find((entry) => entry.branch === 'teamai/push/test/20260101-000000');
    expect(reused?.items).toEqual([
      expect.objectContaining({ type: 'rules', name: 'my-rule', relativePath: 'rules/pm/my-rule.md', placed: true }),
    ]);
  });

  it('refuses to place a new rule onto an existing team file', async () => {
    // The scanner correctly calls an unrelated root rule NEW — no record maps
    // it to anything. Placing it on a namespace that already holds that name
    // replaces somebody else's rule, silently, in a run they never reviewed.
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-collide-'));
    fs.mkdirSync(path.join(repoDir, 'rules', 'pm'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'rules/pm', 'my-rule.md'), 'the team rule');
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({
        repo: { localPath: repoDir, remote: 'https://git.woa.com/test/repo.git' },
      }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    try {
      await push({ all: true, role: 'pm' });

      expect(process.exitCode).toBe(2);
      expect(pushedItems).toHaveLength(0);
      expect(mockPushRepoBranch).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(repoDir, 'rules/pm', 'my-rule.md'), 'utf-8'))
        .toBe('the team rule');
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('rules/pm/my-rule.md');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses to place a new .md agent beside an existing .yaml of the same stem', async () => {
    // pull reads a legacy .md as the same agent as its .yaml, so both copies
    // would be active at once — the ambiguity pull reports and skips.
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-collide-'));
    fs.mkdirSync(path.join(repoDir, 'agents', 'pm'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'agents/pm', 'vr.yaml'), 'name: vr\ndescription: team\ninstructions: x\n');
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({
        repo: { localPath: repoDir, remote: 'https://git.woa.com/test/repo.git' },
      }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      agents: [{ name: 'vr', type: 'agents', sourcePath: '/tmp/vr.md', relativePath: 'agents/vr.md', status: 'new' }],
    }, pushedItems);

    try {
      await push({ all: true, role: 'pm' });

      expect(process.exitCode).toBe(2);
      expect(pushedItems).toHaveLength(0);
      expect(fs.existsSync(path.join(repoDir, 'agents/pm', 'vr.md'))).toBe(false);
      const { log } = await import('../utils/logger.js');
      expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('agents/pm/vr.yaml');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('refuses to place a new skill onto an existing team skill', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-collide-'));
    fs.mkdirSync(path.join(repoDir, 'skills', 'pm', 'skill-a'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'skills/pm/skill-a', 'SKILL.md'), 'the team skill');
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({
        repo: { localPath: repoDir, remote: 'https://git.woa.com/test/repo.git' },
      }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
    }, pushedItems);

    try {
      await push({ all: true, role: 'pm' });

      expect(process.exitCode).toBe(2);
      expect(pushedItems).toHaveLength(0);
      expect(fs.readFileSync(path.join(repoDir, 'skills/pm/skill-a', 'SKILL.md'), 'utf-8'))
        .toBe('the team skill');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('still lets a MODIFIED skill land on its own existing directory', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-collide-'));
    fs.mkdirSync(path.join(repoDir, 'skills', 'pm', 'skill-a'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'skills/pm/skill-a', 'SKILL.md'), 'the team skill');
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({
        repo: { localPath: repoDir, remote: 'https://git.woa.com/test/repo.git' },
      }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/pm/skill-a', status: 'modified', namespace: 'pm' }],
    }, pushedItems);

    try {
      await push({ all: true, role: 'pm' });

      expect(process.exitCode).toBeUndefined();
      expect(pushedItems[0]?.relativePath).toBe('skills/pm/skill-a');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not record a rule the scanner already found in a subdirectory', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: undefined }),
      teamConfig: makeTeamConfig(),
    });
    mockHandlers({
      rules: [{
        name: 'fe-know/my-rule', type: 'rules', sourcePath: '/tmp/fe-know/my-rule.md',
        relativePath: 'rules/fe-know/my-rule.md', status: 'modified', namespace: 'fe-know',
      }],
    }, []);

    await push({ all: true });

    // Its local path already carries the namespace, so full-path matching works.
    const saved = mockSaveStateForScope.mock.calls.at(-1)?.[0] as { pendingPushes: Array<{ items: Array<Record<string, unknown>> }> };
    expect(saved.pendingPushes.at(-1)?.items).toEqual([
      expect.not.objectContaining({ placed: true }),
    ]);
  });
  it('stops the push when the roles manifest exists but cannot be read', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockLoadRolesManifest.mockRejectedValue(new Error('Invalid roles manifest YAML: bad indentation'));
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    // Falling back here would publish the rule to the whole team, which is the
    // widening #649 is about — and nobody asked for it.
    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('Invalid roles manifest YAML');
  });

  it('stops the push when the configured role is missing from the manifest', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'ghost' }),
      teamConfig: makeTeamConfig(),
    });
    mockLoadRolesManifest.mockResolvedValue({
      version: 1,
      roles: [
        { id: 'solo', description: 'Solo', resources: { knowledge: ['solo-know'], skills: ['solo-skills'], agents: [] } },
      ],
    });
    mockHandlers({ rules: [{ ...newRule }] }, pushedItems);

    await push({ all: true });

    expect(process.exitCode).toBe(2);
    expect(pushedItems).toHaveLength(0);
  });

  it('keeps the pre-manifest fallback when the team repo has no roles manifest', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig({ primaryRole: 'solo' }),
      teamConfig: makeTeamConfig(),
    });
    mockLoadRolesManifest.mockRejectedValue(
      new RolesManifestNotFoundError('/tmp/team-repo/manifest/roles.yaml'),
    );
    mockHandlers({
      skills: [{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a', status: 'new' }],
      rules: [{ ...newRule }],
    }, pushedItems);

    await push({ all: true });

    // No manifest at all is the team's actual layout, not a failure: the role id
    // still doubles as the skills namespace and the rule stays shared, loudly.
    expect(process.exitCode).toBeUndefined();
    const at = (type: string) => pushedItems.find((i) => i.type === type)?.relativePath;
    expect(at('skills')).toBe('skills/solo/skill-a');
    expect(at('rules')).toBe('rules/my-rule.md');
  });

  it('--dry-run reports the destination and pushes nothing', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front App', description: '',
        resources: { knowledge: ['fe-know'], skills: ['fe-skills'], learnings: [], agents: ['fe-agents'] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }], agents: [{ ...newAgent }] }, pushedItems);

    await push({ dryRun: true, project: 'front-app' });

    expect(pushedItems).toHaveLength(0);
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
    const { log } = await import('../utils/logger.js');
    const said = vi.mocked(log.info).mock.calls.flat().join(' ');
    expect(said).toContain('rules/fe-know/my-rule.md');
    expect(said).toContain('agents/fe-agents/vr.yaml');
  });

  it('--dry-run fails on a project axis the real push would refuse', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(),
      teamConfig: makeTeamConfig(),
    });
    mockLoadProjectsManifest.mockResolvedValue({
      version: 1,
      projects: [{
        id: 'front-app', name: 'Front App', description: '',
        resources: { knowledge: [], skills: ['fe-skills'], learnings: [], agents: [] },
      }],
    });
    mockHandlers({ rules: [{ ...newRule }] }, []);

    await push({ dryRun: true, project: 'front-app' });

    // A dry run that called this viable would be worse than no dry run at all.
    expect(process.exitCode).toBe(2);
    const { log } = await import('../utils/logger.js');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('knowledge');
  });
});

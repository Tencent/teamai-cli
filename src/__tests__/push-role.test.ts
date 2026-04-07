import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAutoDetectInit = vi.fn();
const mockPullRepo = vi.fn();
const mockPushRepoBranch = vi.fn();
const mockCheckoutMaster = vi.fn();
const mockGenerateBranchName = vi.fn();
const mockLoadStateForScope = vi.fn();
const mockSaveStateForScope = vi.fn();
const mockLoadRolesManifest = vi.fn();
const mockGetHandler = vi.fn();
const mockCreatePrWithFallback = vi.fn();

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  loadStateForScope: (...args: unknown[]) => mockLoadStateForScope(...args),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: (...args: unknown[]) => mockPullRepo(...args),
  pushRepoBranch: (...args: unknown[]) => mockPushRepoBranch(...args),
  checkoutMaster: (...args: unknown[]) => mockCheckoutMaster(...args),
  generateBranchName: (...args: unknown[]) => mockGenerateBranchName(...args),
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

vi.mock('../push.js', async () => {
  const actual = await vi.importActual('../push.js');
  return {
    ...actual,
    createPrWithFallback: (...args: unknown[]) => mockCreatePrWithFallback(...args),
  };
});

describe('push role routing', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPushRepoBranch.mockReset();
    mockCreatePrWithFallback.mockReset();
    mockGetHandler.mockReset();
    mockAutoDetectInit.mockReset();
    mockLoadRolesManifest.mockReset();
    mockPullRepo.mockReset();
    mockPullRepo.mockResolvedValue('Already up to date.');
    mockPushRepoBranch.mockResolvedValue(true);
    mockCheckoutMaster.mockResolvedValue(undefined);
    mockGenerateBranchName.mockReturnValue('teamai/push/test/20260403-120000');
    mockCreatePrWithFallback.mockResolvedValue('https://git.woa.com/mr/1');
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
        { id: 'hai', name: 'HAI', description: '', resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['common', 'hai'] } },
        { id: 'pm', name: 'PM', description: '', resources: { knowledge: ['common', 'pm'], skills: ['common', 'pm'], learnings: ['common', 'pm'] } },
      ],
      defaults: { shareTarget: 'primary-role' },
    });
  });

  it('routes pushed skills to the primary role namespace by default', async () => {
    const pushedItems: Array<Record<string, unknown>> = [];
    mockAutoDetectInit.mockResolvedValue({
      localConfig: {
        repo: { localPath: '/tmp/team-repo', remote: 'https://git.woa.com/test/repo.git' },
        username: 'testuser',
        updatePolicy: 'auto',
        primaryRole: 'hai',
        additionalRoles: [],
        resourceProfileVersion: 1,
        scope: 'user',
      },
      teamConfig: {
        repo: 'https://git.woa.com/test/repo.git',
        provider: 'tgit',
        reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: true } },
        toolPaths: {},
      },
    });

    mockGetHandler.mockImplementation((type: string) => {
      if (type === 'skills') {
        return {
          scanLocalForPush: vi.fn().mockResolvedValue([{ name: 'skill-a', type: 'skills', sourcePath: '/tmp/skill-a', relativePath: 'skills/skill-a' }]),
          pushItem: vi.fn().mockImplementation(async (item: Record<string, unknown>) => { pushedItems.push(item); }),
        };
      }

      return {
        scanLocalForPush: vi.fn().mockResolvedValue([]),
        pushItem: vi.fn(),
      };
    });

    const { push } = await import('../push.js');
    await push({ all: true });

    expect(pushedItems[0].namespace).toBe('hai');
    expect(pushedItems[0].relativePath).toBe('skills/hai/skill-a');
    expect(mockPushRepoBranch).toHaveBeenCalledWith(
      '/tmp/team-repo',
      expect.any(String),
      expect.arrayContaining(['skills/hai/skill-a']),
      expect.any(String),
    );
  });

  it('rejects invalid explicit role overrides', async () => {
    mockAutoDetectInit.mockResolvedValue({
      localConfig: {
        repo: { localPath: '/tmp/team-repo', remote: 'https://git.woa.com/test/repo.git' },
        username: 'testuser',
        updatePolicy: 'auto',
        primaryRole: 'hai',
        additionalRoles: [],
        resourceProfileVersion: 1,
        scope: 'user',
      },
      teamConfig: {
        repo: 'https://git.woa.com/test/repo.git',
        provider: 'tgit',
        reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: true } },
        toolPaths: {},
      },
    });

    mockGetHandler.mockReturnValue({
      scanLocalForPush: vi.fn().mockResolvedValue([]),
      pushItem: vi.fn(),
    });

    const { log } = await import('../utils/logger.js');
    const { push } = await import('../push.js');
    await push({ all: true, role: 'unknown' });

    expect(log.error).not.toHaveBeenCalled();
    expect(mockPushRepoBranch).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSaveStateForScope = vi.fn();
vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn().mockResolvedValue({
    localConfig: {
      repo: { localPath: '/tmp/team-repo', remote: 'https://example.test/team/repo.git', kind: 'git' },
      username: 'alice', scope: 'user', additionalRoles: [],
    },
    teamConfig: { team: 't', repo: 'https://example.test/team/repo.git', provider: 'git', reviewers: [], toolPaths: {} },
  }),
  loadStateForScope: vi.fn().mockResolvedValue({ placedAgents: {}, pendingPushes: [] }),
  saveStateForScope: (...args: unknown[]) => mockSaveStateForScope(...args),
}));
vi.mock('../read-only.js', () => ({ assertNotReadOnly: vi.fn() }));
vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('up to date'),
  pushRepoBranch: vi.fn().mockResolvedValue(true),
  checkoutMaster: vi.fn(),
  generateBranchName: vi.fn().mockReturnValue('teamai/push/alice/1'),
}));
vi.mock('../utils/pending-push.js', () => ({
  // A placement merged since the last run: the records change and must be saved.
  reconcilePlacementRecords: vi.fn().mockResolvedValue(true),
}));
vi.mock('../push.js', () => ({ createPrWithFallback: vi.fn(), filterExistingTopLevelPaths: vi.fn() }));
const handler = {
  scanTeamForPull: vi.fn().mockResolvedValue([{ name: 'vr', type: 'agents' }]),
  scanLocalForPush: vi.fn().mockResolvedValue([]),
  publishedNameFor: vi.fn().mockResolvedValue(null),
  removeItem: vi.fn().mockResolvedValue(['agents/fe/vr.yaml', 'agents/be/vr.yaml']),
};
vi.mock('../resources/index.js', () => ({ getHandler: () => handler }));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn() })),
}));

const { remove } = await import('../remove.js');
const { log } = await import('../utils/logger.js');

/**
 * `publishedNameFor` reads the placement records back from disk. When a
 * placement merged but its record could not be saved, the bare name the author
 * types falls back to the stem, and removing that stem removes the agent from
 * every namespace (#649 review). So `remove` stops instead.
 */
describe('teamai remove when the placement records cannot be saved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockSaveStateForScope.mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
  });
  afterEach(() => { process.exitCode = undefined; });

  it('removes nothing and exits 1', async () => {
    await remove('agents', ['vr'], { force: true });

    expect(handler.removeItem).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('Nothing was removed');
  });
});

/**
 * Agents deploy flattened, so the team scan names them by bare stem. A machine
 * with no placement record could only type that stem, which removes the agent
 * from every namespace (#649 review). `<ns>/<stem>` names one of them, and a
 * bare stem that means several is refused rather than guessed.
 */
describe('teamai remove agents names one agent, not a stem every namespace shares', () => {
  const vrIn = (namespace: string) => ({ name: 'vr', type: 'agents', namespace, relativePath: `agents/${namespace}/vr.yaml` });

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockSaveStateForScope.mockResolvedValue(undefined);
    handler.publishedNameFor.mockResolvedValue(null);
    handler.removeItem.mockResolvedValue(['agents/fe/vr.yaml']);
  });
  afterEach(() => { process.exitCode = undefined; });

  it('refuses a bare stem that names agents in several namespaces', async () => {
    handler.scanTeamForPull.mockResolvedValue([vrIn('fe'), vrIn('be')]);

    await remove('agents', ['vr'], { force: true });

    expect(handler.removeItem).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('fe/vr, be/vr');
  });

  it('removes exactly the agent a namespaced name gives', async () => {
    handler.scanTeamForPull.mockResolvedValue([vrIn('fe'), vrIn('be')]);

    await remove('agents', ['fe/vr'], { force: true });

    expect(handler.removeItem).toHaveBeenCalledTimes(1);
    expect(handler.removeItem.mock.calls[0]?.[0]).toBe('fe/vr');
  });

  it('resolves a bare stem that only one namespace has to that namespaced agent', async () => {
    handler.scanTeamForPull.mockResolvedValue([vrIn('fe')]);

    await remove('agents', ['vr'], { force: true });

    // Named exactly, so the tombstone is `fe/vr`, not a stem other namespaces share.
    expect(handler.removeItem.mock.calls[0]?.[0]).toBe('fe/vr');
  });
});

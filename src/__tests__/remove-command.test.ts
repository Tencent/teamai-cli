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

/**
 * `remove mcp <name>` across mcp/mcp.yaml and mcp/<ns>/mcp.yaml (#707, Q31):
 * the same convention as push. Without a flag the root file is the target when
 * it defines the name, else the one namespace file that does; a flag picks a
 * namespace. Only a name several namespaces define, and the root does not, is
 * refused.
 */
describe('teamai remove mcp picks one file', () => {
  const server = (namespace?: string, name = 'db') => ({
    name,
    type: 'mcp',
    ...(namespace ? { namespace } : {}),
    relativePath: namespace ? `mcp/${namespace}/mcp.yaml` : 'mcp/mcp.yaml',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockSaveStateForScope.mockResolvedValue(undefined);
    handler.publishedNameFor.mockResolvedValue(null);
    handler.removeItem.mockResolvedValue(['mcp/mcp.yaml']);
  });
  afterEach(() => { process.exitCode = undefined; });

  it('targets the root file when the root defines the name, even beside namespace files', async () => {
    handler.scanTeamForPull.mockResolvedValue([server(), server('checkout'), server('billing')]);

    await remove('mcp', ['db'], { force: true });

    expect(handler.removeItem).toHaveBeenCalledTimes(1);
    expect(handler.removeItem.mock.calls[0]?.[0]).toBe('db');
    expect(process.exitCode).toBeUndefined();
  });

  it('targets the one namespace file that defines the name when the root does not', async () => {
    handler.scanTeamForPull.mockResolvedValue([server('checkout')]);

    await remove('mcp', ['db'], { force: true });

    expect(handler.removeItem.mock.calls[0]?.[0]).toBe('checkout/db');
  });

  it('refuses a name several namespaces define and the root does not, listing them', async () => {
    handler.scanTeamForPull.mockResolvedValue([server('checkout'), server('billing')]);

    await remove('mcp', ['db'], { force: true });

    expect(handler.removeItem).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(log.error).mock.calls.flat().join(' ');
    expect(errors).toContain('mcp/checkout/mcp.yaml, mcp/billing/mcp.yaml');
    expect(errors).toContain('--role <ns> or --project <id>');
  });

  it('targets the namespace --role names, even when the root defines the name', async () => {
    handler.scanTeamForPull.mockResolvedValue([server(), server('checkout')]);

    await remove('mcp', ['db'], { force: true, role: 'checkout' });

    expect(handler.removeItem.mock.calls[0]?.[0]).toBe('checkout/db');
  });

  // A server may be named after any outcome word, and is still just a name (#862).
  it('removes a root server named "ambiguous"', async () => {
    handler.scanTeamForPull.mockResolvedValue([server(undefined, 'ambiguous')]);

    await remove('mcp', ['ambiguous'], { force: true });

    expect(handler.removeItem).toHaveBeenCalledTimes(1);
    expect(handler.removeItem.mock.calls[0]?.[0]).toBe('ambiguous');
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses "ambiguous" when only several namespaces define it, saying why', async () => {
    handler.scanTeamForPull.mockResolvedValue([server('checkout', 'ambiguous'), server('billing', 'ambiguous')]);

    await remove('mcp', ['ambiguous'], { force: true });

    expect(handler.removeItem).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('mcp/checkout/mcp.yaml, mcp/billing/mcp.yaml');
  });

  it('skips a name no MCP file defines as not found', async () => {
    handler.scanTeamForPull.mockResolvedValue([server()]);

    await remove('mcp', ['ghost'], { force: true });

    expect(handler.removeItem).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.flat().join(' ')).toContain('Not found (skipping): ghost');
    expect(vi.mocked(log.error).mock.calls.flat().join(' ')).toContain('No matching resources found to remove');
  });
});

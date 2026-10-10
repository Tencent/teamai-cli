import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCommandTable } from './helpers/command-table.js';

// Which commands move a checkout's `.teamai/` into the partition before they
// run (#808): a mode that never writes this project's queue has no reason to,
// and must not stop on it.
vi.mock('../migrate.js', () => ({
  maybeMigrate: vi.fn(async () => undefined),
  queueKeptInCheckout: vi.fn(async () => null),
}));
vi.mock('../contribute.js', () => ({ contribute: vi.fn(async () => {}) }));
vi.mock('../import.js', () => ({ importCmd: vi.fn(async () => {}) }));
vi.mock('../init.js', () => ({ init: vi.fn(async () => {}) }));
vi.mock('../roles-cmd.js', () => ({ rolesInit: vi.fn(async () => {}) }));
vi.mock('../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger.js')>()),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

beforeEach(() => {
  vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

/** Parse `args` as the CLI would; returns whether the pre-command migration ran. */
async function migrates(args: string[]): Promise<boolean> {
  const program = await loadCommandTable();
  await program.parseAsync(['node', 'teamai', ...args]);
  const { maybeMigrate } = await import('../migrate.js');
  return vi.mocked(maybeMigrate).mock.calls.length > 0;
}

describe('pre-command migration trigger (#808)', () => {
  const mr = 'https://github.com/acme/app/pull/7';

  it.each([
    ['contribute', ['contribute', '--title', 't', '--file', 'n.md']],
    ['contribute --scope project', ['contribute', '--scope', 'project', '--title', 't', '--file', 'n.md']],
    ['import --from-mr', ['import', '--from-mr', mr]],
  ])('%s migrates first', async (_label, args) => {
    expect(await migrates(args)).toBe(true);
  });

  it.each([
    ['contribute --scope user', ['contribute', '--scope', 'user', '--title', 't', '--file', 'n.md']],
    ['import --from-mr --output <dir>', ['import', '--from-mr', mr, '--output', 'drafts']],
  ])('%s leaves the project alone', async (_label, args) => {
    expect(await migrates(args)).toBe(false);
  });
});

// Codex 5830259599: an init that goes on while the migration is busy, or while
// it kept the checkout's queue, sets the project up and leaves the queue in a
// worktree that `git worktree remove` deletes.
describe('init and the checkout queue (#808)', () => {
  it.each([
    ['init <repo>', ['init', 'acme/team']],
    ['init --self', ['init', '--self']],
  ])('%s stops with exit 1 before it writes anything', async (_label, args) => {
    const { queueKeptInCheckout } = await import('../migrate.js');
    vi.mocked(queueKeptInCheckout).mockResolvedValueOnce('kept in checkout');
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    try {
      await expect(migrates(args)).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
    }
    const { init } = await import('../init.js');
    const { log } = await import('../utils/logger.js');
    expect(init).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('kept in checkout');
  });

  it('init --scope user does not ask', async () => {
    expect(await migrates(['init', 'acme/team', '--scope', 'user'])).toBe(true);
    const { queueKeptInCheckout } = await import('../migrate.js');
    expect(queueKeptInCheckout).not.toHaveBeenCalled();
  });

  it('roles init, which sets up no install, does not ask', async () => {
    await migrates(['roles', 'init']);
    const { queueKeptInCheckout } = await import('../migrate.js');
    expect(queueKeptInCheckout).not.toHaveBeenCalled();
  });
});

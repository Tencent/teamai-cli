import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCommandTable } from './helpers/command-table.js';

const { status, list, push, logError, logDebug } = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  push: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock('../status.js', () => ({ status, list }));
vi.mock('../push.js', () => ({ push }));
vi.mock('../migrate.js', () => ({ maybeMigrate: vi.fn(async () => undefined), queueKeptInCheckout: vi.fn() }));
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  return { ...actual, log: { ...actual.log, error: logError, debug: logDebug } };
});

import { NotInitializedError } from '../config.js';

const message = 'teamai is not initialized. Run `teamai init` first.';

/**
 * `status`, `list` and `push` need a team. Without one they must print the
 * reason the way `env list` does, not let it escape as an uncaught error.
 */
describe('status, list and push before init', () => {
  beforeEach(() => {
    logError.mockReset();
    for (const command of [status, list, push]) {
      command.mockReset();
      command.mockRejectedValue(new NotInitializedError(message));
    }
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  it.each([['status'], ['list'], ['push']])('%s reports the error and exits 1', async (name) => {
    const program = await loadCommandTable();

    await program.parseAsync(['node', 'teamai', name]);

    expect(logError).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(1);
  });

  it('the per-command wrapper rethrows other errors, for the entry boundary to report', async () => {
    status.mockRejectedValue(new Error('disk full'));
    const program = await loadCommandTable();

    await expect(program.parseAsync(['node', 'teamai', 'status'])).rejects.toThrow('disk full');
    expect(logError).not.toHaveBeenCalled();
  });
});

/**
 * The entry boundary (#1270): whatever a command action throws becomes one line
 * on stderr and exit 1, with the stack left to `--verbose` and debug.log.
 */
describe('reportCommandError', () => {
  /** `loadCommandTable` stubs TEAMAI_COMMAND_TABLE_ONLY first, so this import does not run the CLI. */
  async function load(): Promise<(e: unknown) => Promise<void>> {
    await loadCommandTable();
    const { reportCommandError } = await import('../index.js');
    return reportCommandError;
  }

  beforeEach(() => {
    logError.mockReset();
    logDebug.mockReset();
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  it('prints the message and exits 1 instead of rejecting', async () => {
    const reportCommandError = await load();

    await expect(reportCommandError(new Error('disk full'))).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('disk full');
    expect(process.exitCode).toBe(1);
  });

  it('keeps the stack for the debug log and --verbose', async () => {
    const reportCommandError = await load();
    const error = new Error('disk full');

    await reportCommandError(error);

    expect(logDebug).toHaveBeenCalledWith(error.stack);
  });

  it('falls back to the error name when the message is empty', async () => {
    const reportCommandError = await load();

    await reportCommandError(new Error(''));

    expect(logError).toHaveBeenCalledWith('Error');
  });

  it('reports a thrown value that is not an Error, without inventing a stack', async () => {
    const reportCommandError = await load();

    await reportCommandError('boom');

    expect(logError).toHaveBeenCalledWith('boom');
    expect(logDebug).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

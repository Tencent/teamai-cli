import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCommandTable } from './helpers/command-table.js';

const { status, list, push, logError } = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  push: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../status.js', () => ({ status, list }));
vi.mock('../push.js', () => ({ push }));
vi.mock('../migrate.js', () => ({ maybeMigrate: vi.fn(async () => undefined), queueKeptInCheckout: vi.fn() }));
vi.mock('../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/logger.js')>();
  return { ...actual, log: { ...actual.log, error: logError } };
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

  it('still lets other errors escape', async () => {
    status.mockRejectedValue(new Error('disk full'));
    const program = await loadCommandTable();

    await expect(program.parseAsync(['node', 'teamai', 'status'])).rejects.toThrow('disk full');
    expect(logError).not.toHaveBeenCalled();
  });
});

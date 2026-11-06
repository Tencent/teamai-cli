import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { execPluginCommand } from '../local-agent.js';

describe('execPluginCommand', () => {
  it('uses bash for login-shell plugin commands', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.unref = vi.fn();
    spawnMock.mockReturnValue(child);

    const execution = execPluginCommand('printf installed', 1_000);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit('exit', 0, null);
    await execution;

    expect(spawnMock).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'printf installed'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
  });
});

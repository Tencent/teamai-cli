import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

/** The targets of `kill` calls that would reach no one process: 0 and -0 are the caller's own group, ±1 init or every process. */
function strayTargets(kill: { mock: { calls: Array<[number, ...unknown[]]> } }): number[] {
  return kill.mock.calls.map(([pid]) => pid).filter((pid) => !(Number.isSafeInteger(pid) && Math.abs(pid) > 1));
}

it.skipIf(process.platform === 'win32')('signals nothing for a command whose spawn failed, whose record names no process yet', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-vercel-fake-'));
  vi.stubEnv('FAKE_VERCEL_STATE', state);
  vi.stubEnv('FAKE_VERCEL_IMAGE', state);
  const { Sandbox } = await import('./vercel-fake-sdk.js');
  // Spied, so a regression reaches no process: a group of 0 is this test run's own.
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const sandbox = await Sandbox.create({});
    // The spawn fails on the next tick; until then the command has no pid.
    const command = await sandbox.runCommand({ cmd: path.join(state, 'no-such-command'), detached: true });
    await command.kill('SIGTERM');
    await (await sandbox.getCommand(command.cmdId)).kill('SIGTERM');

    expect(strayTargets(kill)).toEqual([]);
    expect(await command.wait()).toEqual({ exitCode: 127 });
    await sandbox.delete();
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

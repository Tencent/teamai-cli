import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeProvider, type NativeSandbox } from './native.js';

afterEach(() => { vi.restoreAllMocks(); });

const SANDBOX: NativeSandbox = {
  provider: 'bwrap',
  isolation: 'worktree',
  isUnattended: true,
  preflight: async () => ({ ok: true }),
  wrap: ({ argv }) => ({ command: argv[0] ?? '', args: argv.slice(1) }),
};

it.skipIf(process.platform === 'win32')('signals no group of 1, which kill reads as every process it may signal, when an exec\'s file names it', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-native-'));
  // A group's file is named by its id; a file named 1 stands for one that is not an exec's group.
  fs.mkdirSync(path.join(state, 'place', 'pids'), { recursive: true });
  fs.writeFileSync(path.join(state, 'place', 'pids', '1'), '');
  // Spied, so a regression reaches no process: the first probe answers as a live group would, later ones as gone.
  let probes = 0;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && probes++ > 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });

    return true;
  });
  try {
    const provider = nativeProvider({ sandbox: SANDBOX, state, env: { PATH: '/usr/bin:/bin' }, home: os.tmpdir() });

    expect(await provider.stop('place')).toEqual({ ok: true });
    expect(kill).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { builtinHookDefs } from '../builtin-hooks.js';

it.skipIf(process.platform === 'win32')('delivers DSH JSON without login-profile output or a login PATH', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dsh-clean-'));
  try {
    const bin = path.join(home, '.teamai', 'bin');
    const fakeShells = path.join(home, 'shells');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(fakeShells);
    fs.writeFileSync(path.join(bin, 'teamai'), '#!/bin/sh\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
    // Stand in for a login profile that prints. Never touch the real user's profiles.
    fs.writeFileSync(path.join(fakeShells, 'bash'), '#!/bin/sh\nif [ "$1" = "-lc" ]; then\n printf "profile banner\\n"\n shift\n exec /bin/bash -c "$@"\nfi\nexec /bin/bash "$@"\n', { mode: 0o755 });
    const command = builtinHookDefs('dsh')[0].command;
    const result = spawnSync('/bin/sh', ['-c', command], {
      env: { ...process.env, HOME: home, PATH: `${fakeShells}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ok":true}\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

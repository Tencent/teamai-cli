import fs from 'node:fs/promises';
import os from 'node:os';
import { expect, it, vi } from 'vitest';

vi.mock('cross-spawn', async (importOriginal) => {
  const { default: spawn } = await importOriginal<{ default: typeof import('cross-spawn') }>();
  return { default: vi.fn(spawn) };
});

import crossSpawn from 'cross-spawn';
import { runTool } from '@teamai/runtime-tools/headless';

// CI runs only on ubuntu and macOS, so the spawn options are what can be checked: they keep a console window from
// opening when the host process (an editor, or the hook dispatcher) has none.
it('starts the tool as a child that cannot open a console window', async () => {
  const run = await runTool({ executable: process.execPath, args: ['-e', ''], cwd: process.cwd(), env: process.env, stdin: '', timeoutMs: 10_000, detached: false });

  expect(run.code).toBe(0);
  expect(vi.mocked(crossSpawn).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
});

// A tool that reads the directory it works in from PWD, as OpenCode does, would otherwise edit the caller's checkout.
it('tells the tool its working directory through PWD as well as its cwd', async () => {
  const cwd = await fs.realpath(os.tmpdir());
  const run = await runTool({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.env.PWD ?? "")'], cwd, env: { ...process.env, PWD: '/somewhere/else' }, stdin: '', timeoutMs: 10_000, detached: false });

  expect(run.stdout).toBe(cwd);
});

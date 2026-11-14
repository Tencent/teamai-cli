import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { signalPid } from '@teamai/shared/process-group';
import { fenceStep } from '../workflow/fleet/fence.js';
import { startGroupedCommand } from '../workflow/shell-command.js';
import { AttemptIdSchema, RunIdSchema } from '../workflow/store.js';

function alive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

describe('the fence of a fleet member step', () => {
  // A member on Windows runs its command attached, so the command leads no process group its guardian could signal.
  it.runIf(process.platform === 'win32')('stops the process tree of a command that leads no process group once the cut-off point passes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fleet-fence-'));
    const pids = path.join(dir, 'pids.txt');
    const step = path.join(dir, 'step.js');
    fs.writeFileSync(step, `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const below = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + below.pid);
setInterval(() => {}, 1000);`);
    const command = startGroupedCommand({ command: `"${process.execPath}" "${step}"`, cwd: dir, env: process.env, detached: false, group: dir });

    try {
      expect(command.group).toBeUndefined();
      const { tree } = command;
      expect(tree).toBeTypeOf('number');
      if (tree === undefined) return;
      await vi.waitFor(() => expect(fs.existsSync(pids)).toBe(true), { timeout: 10_000, interval: 50 });
      const running = [tree, ...fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number)];
      expect(running.filter(alive)).toEqual(running);

      const claim = { root: dir, run: RunIdSchema.parse('r0123abcd'), attempt: AttemptIdSchema.parse('a0123abcd'), pool: 'gpu', step: 'build' };
      const fenced = await fenceStep({ dir, command: { kind: 'tree', pid: tree }, at: Date.now() + 500, claim });
      expect(fenced.ok).toBe(true);

      await vi.waitFor(() => expect(running.filter(alive)).toEqual([]), { timeout: 15_000, interval: 100 });
    } finally {
      await command.stop();
      await command.exit.catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);
});

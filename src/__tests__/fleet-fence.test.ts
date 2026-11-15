import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { signalPid } from '@teamai/shared/process-group';
import { fenceStep, sayGuardianReady, type FencedCommand, type GuardianFs } from '../workflow/fleet/fence.js';
import { startGroupedCommand, type GroupedCommand } from '../workflow/shell-command.js';
import { AttemptIdSchema, RunIdSchema } from '../workflow/store.js';

const SLEEP = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;

function alive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

function claimIn(dir: string) {
  return { root: dir, run: RunIdSchema.parse('r0123abcd'), attempt: AttemptIdSchema.parse('a0123abcd'), pool: 'gpu', step: 'build', kind: 'command' as const };
}

/** A command as a member starts one here: detached, leading a group, except on Windows, where it leads a process tree. */
function sleeper(dir: string): { command: GroupedCommand; fenced: FencedCommand; pid: number } {
  const command = startGroupedCommand({ command: SLEEP, cwd: dir, env: process.env, detached: process.platform !== 'win32', group: dir });
  const pid = command.group ?? command.tree;

  if (pid === undefined) throw new Error('The command did not start.');

  return { command, pid, fenced: command.group === undefined ? { kind: 'tree', pid } : { kind: 'group', id: pid } };
}

describe('the fence of a fleet member step', () => {
  it('retires the guardian of the attempt\'s earlier fence once its restarted member fences it again: only the new fence stops anything', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fleet-fence-'));
    const left = sleeper(dir);
    const again = sleeper(dir);

    try {
      const first = await fenceStep({ dir, command: left.fenced, at: Date.now() + 1_500, claim: claimIn(dir) });
      const second = await fenceStep({ dir, command: again.fenced, at: Date.now() + 60_000, claim: claimIn(dir) });

      if (!first.ok || !second.ok) throw new Error('A guardian did not start.');
      // The first fence's point passes; its guardian, retired by the second fence, stops nothing.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(alive(left.pid)).toBe(true);
      expect(await first.fence.end()).toBe('exited');
      expect(await second.fence.end()).toBe('exited');
      expect(alive(again.pid)).toBe(true);
    } finally {
      await Promise.all([left.command.stop(), again.command.stop()]);
      await Promise.all([left.command.exit.catch(() => undefined), again.command.exit.catch(() => undefined)]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);

  it('writes no ready over a fence a restarted member wrote between the guardian\'s read and its write, and retires the guardian', () => {
    const first = JSON.stringify({ at: 1, owner: 'killed-run' });
    const again = JSON.stringify({ at: 2, owner: 'restarted-run' });
    // The fence the killed run wrote, then, once the guardian has read it, the one its restarted run wrote.
    const reads = [first, again];
    const renamed: string[] = [];
    const removed: string[] = [];
    const files: GuardianFs = {
      readFileSync: () => reads.shift() ?? again,
      writeFileSync: () => {},
      renameSync: (from) => { renamed.push(String(from)); },
      rmSync: (at) => { removed.push(String(at)); },
    };

    expect(sayGuardianReady(files, { file: 'fence.json', owner: 'killed-run', temp: 'fence.json.1.ready' })).toBe('retired');
    expect(renamed).toEqual([]);
    expect(removed).toEqual(['fence.json.1.ready']);
  });

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

      const fenced = await fenceStep({ dir, command: { kind: 'tree', pid: tree }, at: Date.now() + 500, claim: claimIn(dir) });
      if (!fenced.ok) throw new Error(fenced.reason);

      await vi.waitFor(() => expect(running.filter(alive)).toEqual([]), { timeout: 15_000, interval: 100 });
      // Its guardian is gone before the folder is removed, as a step's own cleanup waits for it.
      expect(await fenced.fence.end()).toBe('exited');
    } finally {
      await command.stop();
      await command.exit.catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);
});

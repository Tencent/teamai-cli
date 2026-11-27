import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { signalPid } from '@teamai/shared/process-group';
import { endLeftFence, fenceStep, sayGuardianReady, type FencedCommand } from '../workflow/fleet/fence.js';
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

// A case waits for a fence point to pass (4 s) and for two guardians to end, and on
// Windows each sleeper costs a shell plus a node: the case's own 30 s was reached when
// the full Windows subset ran alongside it (`Test timed out in 30000ms`). The cases stop
// what they start; this is the budget that work needs.
describe('the fence of a fleet member step', { timeout: 120_000 }, () => {
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
      // Each end took its own token's ready marker with it, and the last its fence.
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('fence.json'))).toEqual([]);
    } finally {
      await Promise.all([left.command.stop(), again.command.stop()]);
      await Promise.all([left.command.exit.catch(() => undefined), again.command.exit.catch(() => undefined)]);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);

  it('leaves the fence a restarted member wrote intact, whichever of the guardian\'s calls it lands before as the guardian says it is ready', () => {
    const killed = JSON.stringify({ at: 1, owner: 'killed-run' });
    const restarted = JSON.stringify({ at: 2, owner: 'restarted-run' });

    // The attempt's folder in memory, as node:fs answers each call that reads or writes it; the restarted run's fence
    // lands just before the guardian's call number `landsAt`.
    const sayReady = (landsAt: number) => {
      const folder = new Map<string | undefined, string>([['fence.json', killed]]);
      let calls = 0;

      const land = (): void => {
        if (calls === landsAt) folder.set('fence.json', restarted);
        calls += 1;
      };

      const failure = (code: string, file: string | undefined): Error => Object.assign(new Error(`${code}: ${String(file)}`), { code });

      const files = {
        readFileSync: (file: string): string => {
          land();
          const text = folder.get(file);

          if (text === undefined) throw failure('ENOENT', file);

          return text;
        },
        writeFileSync: (file: string, data: string, options?: { flag?: string }): void => {
          land();

          if (options?.flag === 'wx' && folder.has(file)) throw failure('EEXIST', file);
          folder.set(file, data);
        },
        renameSync: (from: string, to: string): void => {
          land();
          const text = folder.get(from);

          if (text === undefined) throw failure('ENOENT', from);
          folder.delete(from);
          folder.set(to, text);
        },
        rmSync: (file: string): void => {
          land();
          folder.delete(file);
        },
      };

      sayGuardianReady(files, { file: 'fence.json', owner: 'killed-run', marker: 'fence.json.killed-run.ready' });

      return { folder, calls };
    };

    const { calls } = sayReady(-1);

    expect(calls).toBeGreaterThan(0);

    for (let landsAt = 0; landsAt < calls; landsAt += 1) expect(sayReady(landsAt).folder.get('fence.json'), `the restarted run's fence, landed before call ${landsAt}`).toBe(restarted);
  });

  it('removes the fence a killed run left and every ready marker of the attempt\'s guardians once its restarted member\'s recovery ends it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-fleet-fence-'));

    try {
      fs.writeFileSync(path.join(dir, 'fence.json'), JSON.stringify({ at: 1, owner: 'killed-run' }));
      fs.writeFileSync(path.join(dir, 'fence.json.killed-run.ready'), '');
      fs.writeFileSync(path.join(dir, 'fence.json.earlier-run.ready'), '');
      fs.writeFileSync(path.join(dir, 'stdout.log'), 'kept');
      await endLeftFence(dir);

      expect(fs.readdirSync(dir)).toEqual(['stdout.log']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

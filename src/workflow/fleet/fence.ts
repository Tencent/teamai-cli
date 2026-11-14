import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../../utils/fs.js';

// ─── The fence a member's command carries ────────────────
//
//  A member stops its step itself once none of its progress landed for its cut-off (member.ts fleetBeats), a full
//  progress interval before its owner may give the claim up and offer the step again. A member killed mid-step stops
//  nothing: the process group of its command runs on until the member restarts, and one that never restarts leaves it
//  running beside the step the owner offered again. So beside each command it runs on this machine, the member starts a
//  guardian: a Node process in a group of its own, which reads the fence, the member's cut-off point, that the member
//  rewrites each time it learns a progress write landed. Once the fence passes, the guardian stops the command's group
//  as the member's cut-off does, SIGTERM and, five seconds later, SIGKILL until none of it is left, whether or not the
//  member still lives: at that point a member that lives stops the step itself. The guardian ends once the group is gone,
//  or once the member removed the fence, as it does when the step ended, and it never signals a group id below 2.
//

/** The fence of one command: the cut-off point the member moves, and its end once the step ended. */
export interface CommandFence {
  /** Writes the cut-off point `at` (ms since the epoch), one write after another, so the last one called is the one kept. */
  move(at: number): void;
  /** Removes the fence, after the writes still under way: its guardian then ends within a second. */
  end(): Promise<void>;
}

/**
 * The guardian, as `node -e` runs it with the fence file, the command's group id and the first cut-off point: what
 * teamai ships, with no file of its own to find, so a member run from source starts the same program. It reads the
 * fence at most a second apart, and at its cut-off point; a fence it cannot read keeps the cut-off it read before.
 */
const GUARDIAN = String.raw`'use strict';
const fs = require('node:fs');
const [file, groupArg, firstAt] = process.argv.slice(1);
const group = Number(groupArg);
const READ_MS = 1000;
const GRACE_MS = 5000;
const KILL_FOR_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = (name) => {
  try {
    process.kill(-group, name);
    return 'sent';
  } catch (error) {
    return error && error.code === 'ESRCH' ? 'gone' : 'sent';
  }
};
const fenceAt = () => {
  try {
    const at = JSON.parse(fs.readFileSync(file, 'utf8')).at;
    return typeof at === 'number' ? at : null;
  } catch (error) {
    return error && error.code === 'ENOENT' ? undefined : null;
  }
};
(async () => {
  if (!Number.isSafeInteger(group) || group < 2) return;
  let at = Number(firstAt);
  for (;;) {
    const read = fenceAt();
    if (read === undefined || signal(0) === 'gone') return;
    if (read !== null) at = read;
    const left = at - Date.now();
    if (!(left > 0)) break;
    await sleep(Math.min(left, READ_MS));
  }
  signal('SIGTERM');
  for (const until = Date.now() + GRACE_MS; Date.now() < until; await sleep(100)) if (signal(0) === 'gone') return;
  for (const until = Date.now() + KILL_FOR_MS; signal('SIGKILL') !== 'gone' && Date.now() < until;) await sleep(100);
})();
`;

/**
 * Starts the guardian of the detached process group `group`, a command the member runs in `dir`, with the cut-off
 * point `at`. The guardian works in `dir` and gets no variable of the member's environment. Answers why it could not
 * start: the member then runs nothing of the step.
 */
export async function fenceCommand({ dir, group, at }: { dir: string; group: number; at: number }): Promise<{ ok: true; fence: CommandFence } | { ok: false; reason: string }> {
  const file = path.join(dir, `fence-${group}.json`);

  try {
    await writeJsonAtomic(file, { at }, { compact: true });
  } catch (error) {
    return { ok: false, reason: `its fence ${file} cannot be written (${error instanceof Error ? error.message : String(error)})` };
  }

  const guardian = spawn(process.execPath, ['-e', GUARDIAN, file, String(group), String(at)], { cwd: dir, detached: true, stdio: 'ignore', env: {}, windowsHide: true });

  const started = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    guardian.once('spawn', () => resolve({ ok: true }));
    guardian.once('error', (error) => resolve({ ok: false, reason: `its guardian could not start (${error.message})` }));
  });

  if (!started.ok) {
    await fs.rm(file, { force: true });

    return started;
  }

  guardian.unref();
  let writing: Promise<void> = Promise.resolve();
  let written = at;
  let isEnded = false;

  return {
    ok: true,
    fence: {
      move: (next) => {
        if (isEnded || next === written) return;
        written = next;
        // A write that fails leaves the cut-off it replaced, which is earlier: the guardian stops the step no later.
        writing = writing.then(() => writeJsonAtomic(file, { at: next }, { compact: true })).catch(() => undefined);
      },
      end: async () => {
        isEnded = true;
        await writing;
        await fs.rm(file, { force: true });
      },
    },
  };
}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOP_GRACE_MS, TREE_KILL_FLAGS } from '@teamai/shared/process-group';
import { errnoCode, writeJsonAtomic } from '../../utils/fs.js';
import type { GuardianStop } from './guardian-stop.js';

// ─── The fence a member's step carries ────────────────
//
//  A member stops its step itself once none of its progress landed for its cut-off (beats.ts fleetBeats), a full
//  progress interval and a whole stop budget before its owner may give the claim up and offer the step again. A member
//  killed mid-step stops nothing: a command's process group, an exec on its step runtime, a prompt's tool or a whole
//  workflow's nested run goes on until the member restarts, and one that never restarts leaves it running beside the
//  step the owner offered again. So beside each step it runs, the member starts a guardian: a Node process in a group
//  of its own, which reads the fence, the member's cut-off point, that the member rewrites each time it learns a
//  progress write landed. Once the fence passes, the guardian stops what the step runs, whether or not the member still
//  lives: a command here as the member's cut-off does, SIGTERM and, STOP_GRACE_MS later, SIGKILL to its group until
//  none of it is left (on Windows, where it has no group, `taskkill` of its process tree); then what the claim left,
//  through teamai's own built module (`guardian-stop.ts`), as a restarted member's recovery does, once the member no
//  longer holds the run's lock: a live member stops its step itself. The guardian ends once the step's command is gone
//  with nothing else to stop, once the member removed the fence, as it does when the step ended and a restarted member
//  does once its recovery stopped what the claim left (`endLeftFences`), or once it stopped that itself; it never
//  signals a group or pid below 2.
//

/** The fence of one step: the cut-off point the member moves, and its end once the step ended. */
export interface StepFence {
  /** Writes the cut-off point `at` (ms since the epoch), one write after another, so the last one called is the one kept. */
  move(at: number): void;
  /** Removes the fence, after the writes still under way: its guardian then ends within a second. */
  end(): Promise<void>;
}

/** The command of a step that runs on this machine, which the guardian stops itself: its process group, or on Windows its process tree. */
export type FencedCommand = { kind: 'group'; id: number } | { kind: 'tree'; pid: number };

/** The module teamai builds beside its own bundle for the guardian to import (`guardian-stop.ts`). */
const GUARDIAN_MODULE = 'fleet-guardian.js';

/** The fence files of the steps a member runs in its attempt's folder: `fence-step.json`, or `fence-<group or pid>.json`. */
const FENCE_FILE = /^fence-[a-z0-9]+\.json$/;

/**
 * The guardian, as `node -e` runs it with the fence file, the step's command (`group:<id>`, `tree:<pid>` or `none`), the
 * first cut-off point, and, when it also stops what the claim left, the built module and the claim (`GuardianStop` as JSON):
 * what teamai ships, with no file of its own to find, so a member run from source starts the same program. It reads
 * the fence at most a second apart, and at its cut-off point; a fence it cannot read keeps the cut-off it read before.
 */
const GUARDIAN = String.raw`'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const [file, commandArg, firstAt, moduleFile, claimArg] = process.argv.slice(1);
const [kind, idArg] = String(commandArg).split(':');
const id = Number(idArg);
const command = (kind === 'group' || kind === 'tree') && Number.isSafeInteger(id) && id >= 2 ? { kind, id } : undefined;
const stop = moduleFile ? { moduleFile, claim: claimArg } : undefined;
const READ_MS = 1000;
const GRACE_MS = ${String(STOP_GRACE_MS)};
const KILL_FOR_MS = ${String(STOP_GRACE_MS)};
const TREE_KILL_FLAGS = ${JSON.stringify(TREE_KILL_FLAGS)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = (name) => {
  try {
    process.kill(command.kind === 'group' ? -command.id : command.id, name);
    return 'sent';
  } catch (error) {
    return error && error.code === 'ESRCH' ? 'gone' : 'sent';
  }
};
const isGone = () => command === undefined || signal(0) === 'gone';
const fenceAt = () => {
  try {
    const at = JSON.parse(fs.readFileSync(file, 'utf8')).at;
    return typeof at === 'number' ? at : null;
  } catch (error) {
    return error && error.code === 'ENOENT' ? undefined : null;
  }
};
const stopCommand = async () => {
  if (isGone()) return;
  if (command.kind === 'tree' && process.platform === 'win32') {
    for (const until = Date.now() + GRACE_MS + KILL_FOR_MS; !isGone() && Date.now() < until; await sleep(100)) {
      await new Promise((resolve) => execFile('taskkill', ['/pid', String(command.id), ...TREE_KILL_FLAGS], { windowsHide: true }, () => resolve()));
    }
    return;
  }
  signal('SIGTERM');
  for (const until = Date.now() + GRACE_MS; Date.now() < until; await sleep(100)) if (isGone()) return;
  for (const until = Date.now() + KILL_FOR_MS; signal('SIGKILL') !== 'gone' && Date.now() < until;) await sleep(100);
};
(async () => {
  if (command === undefined && stop === undefined) return;
  let at = Number(firstAt);
  for (;;) {
    const read = fenceAt();
    if (read === undefined || (stop === undefined && isGone())) return;
    if (read !== null) at = read;
    const left = at - Date.now();
    if (!(left > 0)) break;
    await sleep(Math.min(left, READ_MS));
  }
  await stopCommand();
  if (stop === undefined) return;
  const { stopLeftForGuardian } = await import(pathToFileURL(stop.moduleFile).href);
  // A live member holds the run's lock and stops its own step: what it left is stopped once it is gone.
  while (fenceAt() !== undefined) {
    if (await stopLeftForGuardian(stop.claim) !== 'busy') return;
    await sleep(READ_MS);
  }
})().catch(() => {});
`;

/**
 * Where the guardian's module is: beside the bundle this code runs from in teamai's build, which ships it, so `missing`
 * there is a broken install. A member run from source has none: its guardian stops only a command here.
 */
function guardianModule(): { kind: 'built'; file: string } | { kind: 'missing'; file: string } | { kind: 'source' } {
  const here = fileURLToPath(import.meta.url);

  if (!here.endsWith('.js')) return { kind: 'source' };
  const file = path.join(path.dirname(here), GUARDIAN_MODULE);

  return existsSync(file) ? { kind: 'built', file } : { kind: 'missing', file };
}

/**
 * Starts the guardian of the step of claim `claim` a member runs in `dir`, with the cut-off point `at`: it stops
 * `command`, the step's command on this machine if it has one, and what the claim left (`guardian-stop.ts`). The
 * guardian works in `dir`; one that stops what the claim left gets the member's own environment, which a restarted member
 * would have, and one that only stops a command gets none. Answers why it could not start: the member then runs nothing
 * of the step.
 */
export async function fenceStep({ dir, command, at, claim }: { dir: string; command?: FencedCommand; at: number; claim: GuardianStop }): Promise<{ ok: true; fence: StepFence } | { ok: false; reason: string }> {
  const built = guardianModule();

  if (built.kind === 'missing') return { ok: false, reason: `its guardian's module ${built.file}, which teamai's build ships, is missing; reinstall teamai` };
  const stop = built.kind === 'built' ? { file: built.file, claim } : undefined;

  // A run from source has no module, and a step with no command here then has nothing the guardian could stop.
  if (command === undefined && stop === undefined) return { ok: true, fence: { move: () => {}, end: async () => {} } };
  const file = path.join(dir, command === undefined ? 'fence-step.json' : `fence-${command.kind === 'group' ? command.id : command.pid}.json`);

  try {
    await writeJsonAtomic(file, { at }, { compact: true });
  } catch (error) {
    return { ok: false, reason: `its fence ${file} cannot be written (${error instanceof Error ? error.message : String(error)})` };
  }

  const commandArg = command === undefined ? 'none' : command.kind === 'group' ? `group:${command.id}` : `tree:${command.pid}`;
  const args = ['-e', GUARDIAN, file, commandArg, String(at), ...(stop ? [stop.file, JSON.stringify(stop.claim)] : [])];
  const guardian = spawn(process.execPath, args, { cwd: dir, detached: true, stdio: 'ignore', env: stop ? process.env : {}, windowsHide: true });

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

/**
 * Removes the fences a killed run of the member left in attempt folder `dir`, once its restarted run's recovery stopped
 * what the claim left under the run's lock, or could not: the recovery owns that stop from then on, and their guardians
 * end within a second.
 */
export async function endLeftFences(dir: string): Promise<void> {
  let names: string[];

  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }

  await Promise.all(names.filter((name) => FENCE_FILE.test(name)).map((name) => fs.rm(path.join(dir, name), { force: true })));
}

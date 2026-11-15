import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { memberHome } from '@teamai/shared/home';
import { parseJson } from '@teamai/shared/json';
import { signalChild, STOP_GRACE_MS, TREE_KILL_FLAGS } from '@teamai/shared/process-group';
import { readRegularFile } from '@teamai/shared/regular-file';
import { z } from 'zod';
import { errnoCode, writeJsonAtomic } from '../../utils/fs.js';
import { FLEET_GUARDIAN_ENV } from './guardian-mode.js';
import type { GuardianInput, GuardianStop } from './guardian-stop.js';

// ─── The fence a member's step carries ────────────────
//
//  A member stops its step itself once none of its progress landed for its cut-off (beats.ts fleetBeats), a full
//  progress interval and a whole stop budget before its owner may give the claim up and offer the step again. A member
//  killed or frozen mid-step stops nothing: a command's process group, an exec on its step runtime, a prompt's tool or a
//  whole workflow's nested run goes on, beside the step the owner offered again. So beside each step it runs, the member
//  starts a guardian: a Node process in a group of its own, working in the member's home, which outlives every folder
//  teamai removes. It reads the fence, the attempt folder's FENCE_FILE: the member's cut-off point, which the member
//  rewrites each time it learns a progress write landed, and the owner token of the guardian it started: the member is
//  its only writer. Once it read the fence holding its token, the guardian says it is ready in a marker of that token
//  beside it (`readyMarkerOf`), never in the fence; a member whose guardian does not within GUARDIAN_READY_MS stops the
//  step's command and runs nothing more of the step, as when the guardian cannot start. Once the fence
//  passes, the guardian stops what the step runs, whether or not the member still lives: a command here as the member's
//  cut-off does, SIGTERM and, STOP_GRACE_MS later, SIGKILL to its group until none of it is left (on Windows, where it
//  has no group, `taskkill` of its process tree). Then it loads teamai's CLI bundle in its guardian mode
//  (FLEET_GUARDIAN_ENV, `guardian-stop.ts`), which stops what the claim left as a restarted member's recovery does. The
//  guardian ends once the step's command is gone with nothing else to stop; once its token is no longer in the fence,
//  because the member removed it when the step ended, a restarted member's recovery did once it stopped what the claim
//  left (`endLeftFence`), or a restarted member fenced the attempt again; or once it stopped what the claim left. It
//  never signals a group or pid below 2.
//

/** The fence of one step: the cut-off point the member moves, and its end once the step ended. */
export interface StepFence {
  /** Writes the cut-off point `at` (ms since the epoch), one write after another, so the last one called is the one kept. */
  move(at: number): void;
  /**
   * Removes the fence, after the writes still under way, unless a restarted member fenced the attempt since, and waits
   * for its guardian to exit, FENCE_END_WAIT_MS at most: `running` when it is still busy stopping what the claim left.
   */
  end(): Promise<'exited' | 'running'>;
}

/** The command of a step that runs on this machine, which the guardian stops itself: its process group, or on Windows its process tree. */
export type FencedCommand = { kind: 'group'; id: number } | { kind: 'tree'; pid: number };

/** The fence of an attempt's step, in the attempt's folder: one at a time, that of the member run that fenced it last. */
const FENCE_FILE = 'fence.json';

/**
 * A fence: its cut-off point, and the token of the guardian the member started. Only the member writes it; that
 * guardian's ready is its token's marker (`readyMarkerOf`). A `ready` an earlier teamai's guardian wrote into it is
 * not read.
 */
const FenceSchema = z.object({ at: z.number(), owner: z.string() });

/** How long a guardian goes without reading its fence: it exits at most that long after its token left it. */
const READ_MS = 1_000;

/** How long a member waits for its step's guardian to say it is ready, before it stops the step's command. */
const GUARDIAN_READY_MS = 10_000;

/** How often a member reads the fence while it waits for its guardian to say it is ready. */
const READY_READ_MS = 50;

/** How long a step's end waits for its guardian to exit, before the member removes the attempt's folder. */
const FENCE_END_WAIT_MS = 3 * READ_MS;

/**
 * The marker that says the guardian with token `owner` read fence `file` holding that token: a file of its own beside
 * the fence, so no write of a guardian replaces the fence. The guardian runs its source (`GUARDIAN`).
 */
export function readyMarkerOf(file: string, owner: string): string {
  return `${file}.${owner}.ready`;
}

/** The node:fs calls the guardian's ready makes, so a test can stand in for each. */
export type GuardianFs = {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, options: { flag: 'wx' }): void;
};

/**
 * Says that the guardian with token `owner` read fence `file` (`ready`), once it read it holding that token: it
 * creates `marker`, its token's (`readyMarkerOf`), and writes nothing else, so a fence a restarted member wrote
 * meanwhile stays as it is. `retired` once the fence no longer holds that token, and `unwritten` when the marker could
 * not be created, to try again at its next read. The guardian runs its source (`GUARDIAN`), so it uses nothing but its
 * arguments.
 */
export function sayGuardianReady(files: GuardianFs, { file, owner, marker }: { file: string; owner: string; marker: string }): 'ready' | 'retired' | 'unwritten' {
  try {
    const fence: unknown = JSON.parse(files.readFileSync(file, 'utf8'));

    // oxlint-disable-next-line teamai/no-runtime-typeof -- the fence's parse itself: the guardian runs this function's source alone (`GUARDIAN`), where no schema loads
    if (fence === null || typeof fence !== 'object' || !('owner' in fence) || fence.owner !== owner) return 'retired';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'retired' : 'unwritten';
  }

  try {
    files.writeFileSync(marker, '', { flag: 'wx' });

    return 'ready';
  } catch (error) {
    // Created already, by an earlier read of this guardian whose answer was lost.
    return error instanceof Error && 'code' in error && error.code === 'EEXIST' ? 'ready' : 'unwritten';
  }
}

/**
 * The guardian, as `node -e` runs it with the fence file, its owner token, the step's command (`group:<id>`, `tree:<pid>`
 * or `none`), the first cut-off point, and, when it also stops what the claim left, teamai's CLI bundle and what to stop
 * (`GuardianInput` as JSON): what teamai ships, with no file of its own to find, so a member run from source starts the
 * same program. It reads the fence at most READ_MS apart, and at its cut-off point; a fence it cannot read keeps the
 * cut-off it read before.
 */
const GUARDIAN = String.raw`'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const [file, owner, commandArg, firstAt, cliFile, input] = process.argv.slice(1);
const [kind, idArg] = String(commandArg).split(':');
const id = Number(idArg);
const command = (kind === 'group' || kind === 'tree') && Number.isSafeInteger(id) && id >= 2 ? { kind, id } : undefined;
const READ_MS = ${String(READ_MS)};
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
// The cut-off point: undefined once this guardian's token left the fence, null while the fence cannot be read.
const fenceAt = () => {
  try {
    const fence = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fence || fence.owner !== owner) return undefined;
    return typeof fence.at === 'number' ? fence.at : null;
  } catch (error) {
    return error && error.code === 'ENOENT' ? undefined : null;
  }
};
const readyMarkerOf = ${readyMarkerOf.toString()};
const sayGuardianReady = ${sayGuardianReady.toString()};
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
  if (command === undefined && cliFile === undefined) return;
  let at = Number(firstAt);
  let isReady = false;
  for (;;) {
    const read = fenceAt();
    if (read === undefined) return;
    if (read !== null) {
      at = read;
      if (!isReady) {
        const said = sayGuardianReady(fs, { file, owner, marker: readyMarkerOf(file, owner) });
        if (said === 'retired') return;
        isReady = said === 'ready';
      }
    }
    if (cliFile === undefined && isGone()) return;
    const left = at - Date.now();
    if (!(left > 0)) break;
    await sleep(Math.min(left, READ_MS));
  }
  await stopCommand();
  if (cliFile === undefined || fenceAt() === undefined) return;
  // The bundle's guardian mode stops what the claim left, and ends once that is done or the fence is no longer ours.
  process.env.${FLEET_GUARDIAN_ENV} = input;
  await import(pathToFileURL(cliFile).href);
})().catch(() => {});
`;

/**
 * The CLI bundle this code runs from in teamai's build (dist/cli.js), whose guardian mode stops what a claim left. A
 * member run from source has none: its guardian stops only a command here.
 */
function cliBundle(): string | undefined {
  const here = fileURLToPath(import.meta.url);

  return here.endsWith('.js') ? here : undefined;
}

/** Whether fence `file` still holds token `owner`: not once it was removed, or a restarted member fenced the attempt again. */
export async function isFenceHeld(file: string, owner: string): Promise<boolean> {
  let text: string;

  try {
    text = await readRegularFile(file, 'utf8');
  } catch (error) {
    // A fence that cannot be read for another reason keeps its guardian on, as the guardian's own read does.
    return errnoCode(error) !== 'ENOENT';
  }

  let fence: ReturnType<typeof FenceSchema.safeParse>;

  try {
    fence = FenceSchema.safeParse(parseJson(text));
  } catch {
    return true;
  }

  return !fence.success || fence.data.owner === owner;
}

/**
 * Whether the guardian with token `owner` said it read fence `file`: the fence holds that token, and the token's marker
 * is there (`readyMarkerOf`). Not while either cannot be read.
 */
async function isGuardianReady(file: string, owner: string): Promise<boolean> {
  try {
    const fence = FenceSchema.safeParse(parseJson(await readRegularFile(file, 'utf8')));

    if (!fence.success || fence.data.owner !== owner) return false;
    await fs.access(readyMarkerOf(file, owner));

    return true;
  } catch {
    return false;
  }
}

/** Removes the fence `file` while it still holds token `owner`, and that token's marker, which only its own guardian made. */
async function removeFenceOf(file: string, owner: string): Promise<void> {
  if (await isFenceHeld(file, owner)) await fs.rm(file, { force: true });
  await fs.rm(readyMarkerOf(file, owner), { force: true });
}

/**
 * Starts the guardian of the step of claim `claim` a member runs in attempt folder `dir`, with the cut-off point `at`:
 * it stops `command`, the step's command on this machine if it has one, and what the claim left (`guardian-stop.ts`).
 * Its token in the fence retires the guardian an earlier run of the member started for the attempt. One that stops what
 * the claim left gets the member's own environment, which a restarted member would have, and one that only stops a
 * command gets none. Answers once the guardian said it is ready, or why it could not start or did not say so within
 * GUARDIAN_READY_MS, which ends it: the member then runs nothing more of the step.
 */
export async function fenceStep({ dir, command, at, claim }: { dir: string; command?: FencedCommand; at: number; claim: GuardianStop }): Promise<{ ok: true; fence: StepFence } | { ok: false; reason: string }> {
  const cli = cliBundle();

  // A run from source has no bundle, and a step with no command here then has nothing the guardian could stop.
  if (command === undefined && cli === undefined) return { ok: true, fence: { move: () => {}, end: async () => 'exited' } };
  const file = path.join(dir, FENCE_FILE);
  const owner = randomUUID();

  try {
    await writeJsonAtomic(file, { at, owner }, { compact: true });
  } catch (error) {
    return { ok: false, reason: `its fence ${file} cannot be written (${error instanceof Error ? error.message : String(error)})` };
  }

  const commandArg = command === undefined ? 'none' : command.kind === 'group' ? `group:${command.id}` : `tree:${command.pid}`;
  const input = { ...claim, fence: file, owner } satisfies GuardianInput;
  const args = ['-e', GUARDIAN, file, owner, commandArg, String(at), ...(cli === undefined ? [] : [cli, JSON.stringify(input)])];
  // Not in `dir`: on Windows the folder a process works in cannot be removed while it lives.
  const guardian = spawn(process.execPath, args, { cwd: memberHome(), detached: true, stdio: 'ignore', env: cli === undefined ? {} : process.env, windowsHide: true });
  const exited = new Promise<'exited'>((resolve) => { guardian.once('exit', () => resolve('exited')); });

  const started = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    guardian.once('spawn', () => resolve({ ok: true }));
    guardian.once('error', (error) => resolve({ ok: false, reason: `its guardian could not start (${error.message})` }));
  });

  if (!started.ok) {
    await fs.rm(file, { force: true });

    return started;
  }

  guardian.unref();
  const ended = { isExited: false };
  void exited.then(() => { ended.isExited = true; });
  let isReady = await isGuardianReady(file, owner);

  for (const until = Date.now() + GUARDIAN_READY_MS; !isReady && !ended.isExited && Date.now() < until; isReady = await isGuardianReady(file, owner)) await sleep(READY_READ_MS);

  if (!isReady) {
    signalChild(guardian, 'SIGKILL');
    await removeFenceOf(file, owner);

    return { ok: false, reason: ended.isExited ? 'its guardian exited before it said it was ready' : `its guardian did not say it was ready within ${GUARDIAN_READY_MS / 1_000} s` };
  }

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
        writing = writing.then(() => writeJsonAtomic(file, { at: next, owner }, { compact: true })).catch(() => undefined);
      },
      end: async () => {
        isEnded = true;
        await writing;

        // A restarted member's fence of the attempt stays: it retired this one's guardian.
        await removeFenceOf(file, owner);
        let timer: NodeJS.Timeout | undefined;
        const waited = await Promise.race([exited, new Promise<'running'>((resolve) => { timer = setTimeout(() => resolve('running'), FENCE_END_WAIT_MS); })]);
        clearTimeout(timer);

        return waited;
      },
    },
  };
}

/**
 * Removes the fence a killed run of the member left in attempt folder `dir`, and the ready markers of the guardians its
 * earlier runs started, once its restarted run's recovery stopped what the claim left under the run's lock, or could
 * not: the recovery owns that stop from then on, and the guardian ends within READ_MS.
 */
export async function endLeftFence(dir: string): Promise<void> {
  const left = await fs.readdir(dir).catch((): string[] => []);

  // The markers as readyMarkerOf names them, whatever their token.

  await Promise.all(left.filter((name) => name.startsWith(`${FENCE_FILE}.`) && name.endsWith('.ready')).map(async (name) => fs.rm(path.join(dir, name), { force: true })));
  await fs.rm(path.join(dir, FENCE_FILE), { force: true });
}

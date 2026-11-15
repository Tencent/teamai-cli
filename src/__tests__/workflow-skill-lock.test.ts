import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import type { WorkflowClient } from '../workflow/protocol.js';
import type { Runners, SkillContext } from '../workflow/drivers/skill/skill-driver.js';
import { withDriverLock } from '../workflow/drivers/local/local-driver.js';
import { RunIdSchema, runsRemovalLockIn, skillStatePath, takeRunLock, withRunLock } from '../workflow/store.js';
import { acquireLock, releaseLock } from '../update.js';
import { skillHarness } from './helpers/skill-harness.js';

const PAIR = `schemaVersion: v1alpha1
name: pair
description: Write the API and the UI
invoke: allow
steps:
  - id: api
    workspace: new
    prompt: Write the API.
  - id: ui
    needs: []
    workspace: new
    prompt: Write the UI.
`;

/** How long a call may wait for the run lock while a poll of the run sleeps: one `WAIT_POLL_MS`, a poll's sleep. */
const ONE_POLL_MS = 2_000;

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The run lock as production takes it, giving up after `ms` of real time. The harness fakes `Date`, which the lock's
 * own wait is measured on, so a held lock would otherwise be waited for without end.
 */
function within(config: LocalConfig, ms: number): SkillContext['locks'] {
  return {
    take: async (run, body) => {
      const until = performance.now() + ms;
      for (;;) {
        const taken = await takeRunLock(config, run, body, { waitMs: 0 });
        if (taken.kind === 'held' || performance.now() >= until) return taken;
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
    },
  };
}

/** A gate on the session's next sleep: `parked` settles once a call sleeps, and the sleep goes on at `release`. */
function sleepGate() {
  let armed = false;
  let parked: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => { parked = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    arm: () => { armed = true; },
    reached,
    release,
    runners: (runners: Runners): Runners => ({
      ...runners,
      sleep: async (ms, signal) => {
        if (armed) {
          armed = false;
          parked();
          await released;
        }
        return runners.sleep(ms, signal);
      },
    }),
  };
}

type Made = Awaited<ReturnType<typeof skillHarness>>;

function turnOf(answer: Awaited<ReturnType<Made['call']>>) {
  if (!('data' in answer) || !('turn' in answer.data)) throw new Error(JSON.stringify(answer));
  return answer.data.turn;
}

/** Starts PAIR, answers the session host question, and acks both dispatches, so nothing is left for a poll to show: the dispatches. */
async function dispatched(made: Made) {
  const { run } = turnOf(await made.call({ kind: 'start', name: 'pair', answers: { parallel: 2, confirmed: false }, inputs: undefined }));
  const turn = turnOf(await made.call({ kind: 'choose', run, choice: 'h1' }));
  const shown = turn.actions.flatMap((action) => (action.kind === 'dispatch' ? [action] : []));
  if (shown.length !== 2) throw new Error(JSON.stringify(turn));
  for (const action of shown) await made.call({ kind: 'ack', run, attempt: action.attempt });
  return { run, shown };
}

describe('the run lock of a skill run', () => {
  it('is free while a poll sleeps between its ticks: a report and a foreground next each take it within one poll interval', async () => {
    const gate = sleepGate();
    const made = await skillHarness({ pair: PAIR }, { runners: gate.runners });
    roots.push(made.root);
    const { run, shown: [api] } = await dispatched(made);
    if (!api) throw new Error('no dispatch');
    const result = /Write `([^`]+result\.json)`/.exec(fs.readFileSync(api.brief, 'utf8'))?.[1];
    if (!result) throw new Error(`the brief ${api.brief} names no result file`);
    fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: 'Wrote the API.' }));
    gate.arm();
    const polling = made.call({ kind: 'next', run, wait: true });
    await gate.reached;
    const locks = within(made.config, ONE_POLL_MS);
    // Both calls are made while the poll sleeps, and checked once it went on, so a failure leaves no poll running.
    const reported = await made.call({ kind: 'report', run, attempt: api.attempt, role: 'agent', modelUnavailable: false }, { locks });
    const next = await made.call({ kind: 'next', run, wait: false }, { locks });
    gate.release();
    expect(turnOf(await polling).run).toBe(run);
    expect(reported).toEqual({ data: { runner: { attempt: api.attempt, status: 'reported' } } });
    expect(turnOf(next).events).toContainEqual(expect.objectContaining({ kind: 'settled', step: 'api', outcome: 'success' }));
  });

  it('lets one of two callers act at a time: two nexts at once reach the engine one after the other, and both get a turn', async () => {
    let inside = 0;
    let most = 0;
    const counted = (client: WorkflowClient): WorkflowClient => ({
      ...client,
      next: async (runId, body, options) => {
        inside += 1;
        most = Math.max(most, inside);
        try {
          // Long enough that a second caller without the lock would arrive while the first is still inside.
          await new Promise((resolve) => { setTimeout(resolve, 50); });
          return await client.next(runId, body, options);
        } finally {
          inside -= 1;
        }
      },
    });
    const made = await skillHarness({ pair: PAIR }, { client: counted });
    roots.push(made.root);
    const { run } = await dispatched(made);
    made.hold(true);
    most = 0;
    const both = await Promise.all([made.call({ kind: 'next', run, wait: false }), made.call({ kind: 'next', run, wait: false })]);
    made.hold(false);
    expect(both.map((answer) => turnOf(answer).run)).toEqual([run, run]);
    expect(most).toBe(1);
  });

  it('relays an error answered under the lock as it is, even one coded driver_running, and never reads it as a busy lock', async () => {
    const refusal = { code: 'driver_running', message: 'The engine refused this report as busy.' };
    const refusing = (client: WorkflowClient): WorkflowClient => ({ ...client, report: async () => ({ error: refusal }) });
    const made = await skillHarness({ pair: PAIR }, { client: refusing });
    roots.push(made.root);
    const { run, shown: [api] } = await dispatched(made);
    if (!api) throw new Error('no dispatch');
    expect(await made.call({ kind: 'report', run, attempt: api.attempt, role: 'agent', modelUnavailable: false }))
      .toEqual({ error: { ...refusal, next: `teamai workflow report ${run} --driver skill --attempt ${api.attempt}` } });
    expect(made.rows).not.toContain('D19');
  });

  it('answers driver_running to a call on a run the local driver holds, with the same literal, and changes nothing', async () => {
    const made = await skillHarness({ pair: PAIR });
    roots.push(made.root);
    const { run } = await dispatched(made);
    const before = fs.readFileSync(skillStatePath(made.config, run), 'utf8');
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const driving = withDriverLock(made.config, run, async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return { data: {} };
    });
    await inside;
    try {
      expect(await made.call({ kind: 'next', run, wait: false }, { locks: within(made.config, 200) }))
        .toEqual({ error: expect.objectContaining({ code: 'driver_running', next: `teamai workflow next ${run} --driver skill` }) });
    } finally {
      release();
    }
    expect(await driving).toEqual({ data: {} });
    expect(fs.readFileSync(skillStatePath(made.config, run), 'utf8')).toBe(before);
  });
});

// A teamai from before runs were spelled by their real path takes the driver lock at HOME as it is spelled. While both
// are installed, either may drive a run: the two spellings must name one lock.
describe('the driver lock of a run whose data home is reached through a symlink', () => {
  function linkedHome(): { config: LocalConfig; spelled: (run: string) => string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-linked-home-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const dataHome = path.join(root, 'link', 'data');
    fs.mkdirSync(dataHome);
    const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: root, dataHome };
    return { config, spelled: (run) => path.join(dataHome, 'workflows', 'runs', run, 'driver.lock') };
  }

  it('is busy for this teamai while an older teamai holds it at the spelled path', async () => {
    const { config, spelled } = linkedHome();
    const run = RunIdSchema.parse('r0123456789abcdef');
    const older = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    try {
      fs.mkdirSync(path.dirname(spelled(run)), { recursive: true });
      fs.writeFileSync(spelled(run), JSON.stringify({ pid: older.pid, startedAt: new Date().toISOString(), owner: randomUUID() }));
      const body = vi.fn(async () => 'drove');

      const taken = await takeRunLock(config, run, body, { waitMs: 0 });

      expect(taken).toMatchObject({ kind: 'busy', error: { code: 'driver_running', message: expect.stringContaining(`process ${older.pid}`) } });
      expect(body).not.toHaveBeenCalled();
    } finally {
      older.kill();
    }
  });

  it('is held from an older teamai at the spelled path while this teamai holds it', async () => {
    const { config, spelled } = linkedHome();
    const run = RunIdSchema.parse('r0123456789abcdef');

    const taken = await takeRunLock(config, run, async () => acquireLock(spelled(run)), { waitMs: 0 });

    expect(taken).toEqual({ kind: 'held', value: false });
    expect(await acquireLock(spelled(run))).toBe(true);
    await releaseLock(spelled(run));
  });
});

describe('the driver lock of a run whose data home is not there', () => {
  it('drives nothing and makes no data home, as after an uninstall of the scope', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-no-home-')));
    roots.push(root);
    const dataHome = path.join(root, 'data');
    const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: root, dataHome };
    const run = RunIdSchema.parse('r0123456789abcdef');
    const body = vi.fn(async () => 'drove');

    await expect(takeRunLock(config, run, body, { waitMs: 0 })).rejects.toThrow(`Run ${run} is not on this machine: its data home ${dataHome} is not there`);

    expect(body).not.toHaveBeenCalled();
    expect(fs.existsSync(dataHome)).toBe(false);
  });

  // A fleet member holds a claimed run's attempts, and no record of the run: its owner's machine has that.
  it("drives nothing of a fleet member's run an uninstall removed while it waited, and makes none of it again", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-member-home-')));
    roots.push(root);
    const dataHome = path.join(root, 'data');
    const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: root, dataHome };
    const run = RunIdSchema.parse('r0123456789abcdef');
    const runDir = path.join(dataHome, 'workflows', 'runs', run);
    fs.mkdirSync(path.join(runDir, 'attempts', 'a01234567'), { recursive: true });
    const removal = runsRemovalLockIn(dataHome);
    expect(await acquireLock(removal)).toBe(true);
    const body = vi.fn(async () => 'drove');

    const driving = takeRunLock(config, run, body, { waitMs: 0 });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    fs.rmSync(runDir, { recursive: true });
    await releaseLock(removal);

    await expect(driving).rejects.toThrow(`Run ${run} was removed from this machine while teamai waited to drive it`);
    expect(body).not.toHaveBeenCalled();
    expect(fs.existsSync(runDir)).toBe(false);
  });

  // A taken removal lock is no driver of the run: a cancel that read it as one would cancel without the lock.
  it.each([
    { state: 'its data home removed', isTaken: false, code: 'run_not_found', says: 'is not on this machine' },
    { state: "its data home's removal lock taken", isTaken: true, code: 'busy', says: `stays taken by process ${process.pid}, as an uninstall of this scope` },
  ])('answers a body that answers an envelope with $code, with $state', async ({ isTaken, code, says }) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-no-home-')));
    roots.push(root);
    const dataHome = path.join(root, 'data');
    const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: root, dataHome };
    const run = RunIdSchema.parse('r0123456789abcdef');
    const body = vi.fn(async () => ({ data: {} }));

    if (isTaken) {
      fs.mkdirSync(dataHome);
      expect(await acquireLock(runsRemovalLockIn(dataHome))).toBe(true);
    }

    try {
      expect(await withRunLock(config, run, body, { waitMs: 0 })).toEqual({ error: { code, message: expect.stringContaining(says) } });
    } finally {
      if (isTaken) await releaseLock(runsRemovalLockIn(dataHome));
    }

    expect(body).not.toHaveBeenCalled();
  }, 30_000);
});

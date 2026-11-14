import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@teamai/shared/log';
import { homeEnvOf, toolsLaunchDeps } from '../workflow/runtimes/sources.js';
import { stepLauncher, toolsStepRuntime } from '@teamai/runtime-tools';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { composedStepRuntime } from '../workflow/runtimes/composed.js';
import type { OpId, OpState, RuntimeDisplay, RuntimeFailure, RuntimeOptions } from '@teamai/runtime-protocol';
import { newOpId, type ExecEnd, type ExecEvents, type ExecQuestion, type ExecRequest, type OpenRequest, type PromptRequest, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../workflow/requirements.js';
import type { JsonValue } from '@teamai/shared/json';
import { sandboxOnFake } from './helpers/sandbox-runtime.js';
import { t3OnFakeServer, ToyUsageSchema } from './helpers/t3-runtime.js';
import { paseoOnFakeDaemon } from './helpers/paseo-runtime.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';
import { expectNothingLeft } from '@teamai/runtime-testing/leaks';
import { dirs, git, pull, receiveHook, startIn, team, WORKSPACES, type Member } from './helpers/workflow-handoff-fixture.js';
import { fakeAgent } from '@teamai/tool-testing/fake-agent';
import { claudeFake } from '@teamai/tool-claude/testing';
import { leaseNext, reportAttempt } from '../workflow/engine.js';
import { fleetStepRuntime } from '../workflow/fleet/owner.js';
import { attemptRun } from '../workflow/runtimes/attempt.js';
import { stopLeftInProcess } from '../workflow/runtimes/cancelled.js';
import { takeFleetAttempt, type MemberPlace } from '../workflow/fleet/member.js';
import { claimAttempt, leaveOffer, markOffered, readAttemptRecord } from '../workflow/fleet/record.js';
import { AttemptIdSchema, installOwner, readRun, RunIdSchema, runsDir } from '../workflow/store.js';
import { readableReportsWorktree } from '../utils/reports-branch.js';
import { acquireLock, releaseLock } from '../update.js';
import { getWorktreeDir, REPORTS_LOCK_FILENAME, REPORTS_WORKTREE_DIRNAME } from '../types.js';
import { shellArgv } from '../workflow/shell-command.js';
import { getRepoIdentity } from '../session-flow/sync.js';
import { signalPid } from '@teamai/shared/process-group';
import { entriesUnder } from '@teamai/shared/entries-under';
import { hostRuntimeIn } from './helpers/host-runtime.js';
import { DRIVER_PROFILES, DRIVERS_UNDER_TEST, PROFILES_UNDER_TEST } from '../workflow/conformance-interpreter.js';

/**
 * One scenario suite every step runtime passes, through the `StepRuntime` interface alone. `retains` says whether the
 * runtime keeps outcomes across a restart of its own process, which `local`, in teamai's process, cannot.
 */
interface Subject {
  name: string;
  /** A runtime over `state`, which a restarted runtime of the same subject reads again. */
  start(state: string): StepRuntime<DriverCan>;
  options(state: string): RuntimeOptions;
  retains: boolean;
  /** The display the runtime gives for the suite's attempt when it is reattached, if it gives one. */
  display?: RuntimeDisplay;
  /** The directories the runtime keeps its records of `state` in, when it keeps any. */
  journal?(state: string): string[];
  /**
   * How the runtime still answers an op whose end it cannot journal (`<kind> <failure code>`), where that is not its true
   * end: the scenario then checks that answer, as the record of a gap the runtime's owner closes by removing this.
   * fails, as the record of a gap the runtime's owner closes.
   */
  unjournaledEnd?: string;
}

const [docker, sbx] = await Promise.all([sandboxOnFake('docker'), sandboxOnFake('sbx')]);

const SUBJECTS: Subject[] = [
  {
    name: 'toy over stdio',
    start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
    options: (state) => ({ state }),
    retains: true,
    journal: (state) => [path.join(state, 'ops')],
  },
  {
    name: 'toy through toy over stdio',
    start: () => composedStepRuntime({
      outer: stdioStepRuntime({ name: 'outertoy', command: process.execPath, args: [TOY_RUNTIME] }),
      inner: stdioStepRuntime({ name: 'innertoy', command: process.execPath, args: [TOY_RUNTIME] }),
      innerCredentials: {},
    }),
    options: (state) => ({ outertoy: { state: path.join(state, 'outer') }, innertoy: { state: path.join(state, 'inner') } }),
    retains: true,
    journal: (state) => [path.join(state, 'outer', 'ops'), path.join(state, 'inner', 'ops')],
  },
  { name: 'host', start: (state) => hostRuntimeIn(state), options: () => ({}), retains: false },
  {
    name: 'sandbox on a fake docker',
    start: (state) => stdioStepRuntime({ name: 'sandbox', command: docker.command, args: docker.args(state) }),
    options: () => docker.options,
    retains: true,
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox')],
    display: { label: 'teamai-r0123abcd-a0123abcd (docker)', fields: { container: 'teamai-r0123abcd-a0123abcd', image: 'scenario/agent:1' } },
  },
  {
    name: 'sandbox on a fake sbx',
    start: (state) => stdioStepRuntime({ name: 'sandbox', command: sbx.command, args: sbx.args(state) }),
    options: () => sbx.options,
    retains: true,
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox')],
    // An sbx sandbox's name starts with its journal's id, which follows the subject's HOME.
    display: { label: expect.stringMatching(/^teamai-[0-9a-f]{16}-r0123abcd-a0123abcd \(sbx\)$/), fields: { sandbox: expect.stringMatching(/^teamai-[0-9a-f]{16}-r0123abcd-a0123abcd$/), agent: 'claude' } },
  },
];

function pidAlive(pid: number): boolean {
  return signalPid(pid, 0) === 'sent';
}

/** Sets the mode of `root` and of every directory under it: 0o500 keeps a runtime from writing a record there. */
function setDirModes(root: string, mode: number): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, mode);

  for (const { entry } of entriesUnder(root)) {
    if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), mode);
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return check();
}

describe.each(SUBJECTS)('StepRuntime scenarios: $name', (subject) => {
  const alive = (ops: OpState[]) => ({ kind: 'alive', ops, ...(subject.display && { display: subject.display }) });
  let dir: string;
  let worktree: string;
  let state: string;
  const started: StepRuntime<DriverCan>[] = [];

  const start = async (): Promise<StepRuntime<DriverCan>> => {
    const runtime = subject.start(state);
    started.push(runtime);
    const ready = await runtime.init({ options: subject.options(state), mode: 'unattended', homeEnv: homeEnvOf([]) });
    expect(ready).toMatchObject({ ok: true });

    return runtime;
  };

  const openRequest = (op = newOpId()): OpenRequest => ({
    op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
    view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
  });

  const execRequest = (handle: string, argv: string[], op = newOpId()): ExecRequest => ({ op, handle, argv, env: { STEP_VALUE: 'from-teamai' }, unset: [], credentials: {}, cwd: worktree });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-runtime-'));
    worktree = path.join(dir, 'worktree');
    state = path.join(dir, 'state');
    fs.mkdirSync(worktree);
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails init on an option it does not take, naming the key', async () => {
    const runtime = subject.start(state);
    started.push(runtime);

    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { ...subject.options(state), imgae: 'x' }, mode: 'unattended' }))
      .toMatchObject({ ok: false, failure: { code: 'bad_option', key: 'imgae' } });
  });

  it('accepts an open with a handle, then reports it ready, and a repeated open returns the same handle', async () => {
    const runtime = await start();
    const accepted: string[] = [];
    const request = openRequest();
    const opened = await runtime.open(request, async (handle) => { accepted.push(handle); });

    expect(opened.kind).toBe('ready');
    if (opened.kind !== 'ready') return;
    expect(accepted).toEqual([opened.handle]);
    expect(await runtime.open(request, async () => {})).toEqual(opened);
    // A new operation for the same run and attempt opens no second place.
    expect(await runtime.open(openRequest(), async () => {})).toEqual(opened);
  });

  it('answers an open id repeated before it settles with the same handle, persisted for each caller', async () => {
    const runtime = await start();
    const accepted: string[] = [];
    const request = openRequest();
    const persist = async (handle: string): Promise<void> => { accepted.push(handle); };
    const [first, repeated] = await Promise.all([runtime.open(request, persist), runtime.open(request, persist)]);

    expect(first.kind).toBe('ready');
    expect(repeated).toEqual(first);
    if (first.kind !== 'ready') return;
    expect(accepted).toEqual([first.handle, first.handle]);
  });

  it('fails the open with the error that kept it from persisting the handle', async () => {
    const runtime = await start();

    await expect(runtime.open(openRequest(), async () => { throw new Error('the run record could not be written'); }))
      .rejects.toThrow('the run record could not be written');
  });

  it('accepts an exec, streams its output, and ends with its exit code and complete stdout, in the step env', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const output: string[] = [];
    let accepted = false;

    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(`${process.env.STEP_VALUE}\\n`); process.exitCode = 3']), {
      onAccepted: () => { accepted = true; },
      onOutput: (stream, data) => { if (stream === 'stdout') output.push(data); },
    }, 'command');

    expect(accepted).toBe(true);
    expect(end).toEqual({ kind: 'exited', code: 3, stdout: 'from-teamai\n' });
    expect(output.join('')).toBe('from-teamai\n');
  });

  // Protocol 1 bounds the stdout an `exited` carries; the step still gets all of it, from the stream.
  it('ends an exec that prints more than 64 KiB with its whole stdout', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write("start" + "x".repeat(100000) + "end")']), {}, 'command');

    expect(end).toEqual({ kind: 'exited', code: 0, stdout: `start${'x'.repeat(100_000)}end` });
  });

  it('sets the credentials an exec brings over its process\'s environment', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    const end = await runtime.exec({ ...execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(String(process.env.SCENARIO_TOKEN))']), credentials: { SCENARIO_TOKEN: 'scenario-value' } }, {}, 'command');

    expect(end).toEqual({ kind: 'exited', code: 0, stdout: 'scenario-value' });
  });

  it('keeps names the exec unsets out of its process', async () => {
    // Set before the runtime starts, so a runtime in a process of its own inherits the name it has to remove.
    process.env.TEAMAI_SCENARIO_WITHHELD = 'secret';

    try {
      const runtime = await start();
      const opened = await runtime.open(openRequest(), async () => {});
      if (opened.kind !== 'ready') throw new Error('not opened');
      const end = await runtime.exec({ ...execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(String(process.env.TEAMAI_SCENARIO_WITHHELD))']), unset: ['TEAMAI_SCENARIO_WITHHELD'] }, {}, 'command');

      expect(end).toEqual({ kind: 'exited', code: 0, stdout: 'undefined' });
    } finally {
      delete process.env.TEAMAI_SCENARIO_WITHHELD;
    }
  });

  it('answers a repeated exec id with the same outcome without running it again', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").appendFileSync("runs", "x"); process.stdout.write("once")']);
    const first = await runtime.exec(request, {}, 'command');

    expect(await runtime.exec(request, {}, 'command')).toEqual(first);
    expect(fs.readFileSync(path.join(worktree, 'runs'), 'utf8')).toBe('x');
  });

  it('answers an exec id repeated while it runs with the same acceptance and outcome, running it once', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").appendFileSync("runs", "x"); setTimeout(() => process.stdout.write("once"), 300)']);
    let accepted = 0;
    const events = { onAccepted: () => { accepted += 1; } };
    const first = runtime.exec(request, events, 'command');
    expect(await until(() => fs.existsSync(path.join(worktree, 'runs')))).toBe(true);
    const repeated = runtime.exec(request, events, 'command');

    expect(await Promise.all([first, repeated])).toEqual([{ kind: 'exited', code: 0, stdout: 'once' }, { kind: 'exited', code: 0, stdout: 'once' }]);
    expect(accepted).toBe(2);
    expect(fs.readFileSync(path.join(worktree, 'runs'), 'utf8')).toBe('x');
  });

  it('collects a failed exec and leaves its work in the place', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'require("fs").writeFileSync("work.txt", "kept"); process.exit(1)']), {}, 'command');

    expect(end).toMatchObject({ kind: 'exited', code: 1 });
    expect(await runtime.collect(opened.handle)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(worktree, 'work.txt'), 'utf8')).toBe('kept');
  });

  it('cancels a running exec with the processes it started', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; wait']);
    const ending = runtime.exec(request, {}, 'command');
    const pidFile = path.join(worktree, 'child.pid');
    expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const child = Number(fs.readFileSync(pidFile, 'utf8').trim());

    await runtime.cancel(request.op);

    expect(await ending).toEqual<ExecEnd>({ kind: 'cancelled' });
    expect(await until(() => !pidAlive(child))).toBe(true);
  });

  it('answers gone for a handle it never opened, and after close', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    expect(await runtime.reattach('never-opened')).toEqual({ kind: 'gone' });
    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
    expect(await runtime.reattach(opened.handle)).toEqual({ kind: 'gone' });
  });

  it('answers closed to a close of a handle it already closed', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');

    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
    expect(await runtime.close(opened.handle)).toEqual({ ok: true });
  });

  // A runtime answers the true end of an op whose end it cannot journal, since teamai keeps that end as soon as it reads
  // it, and remembers it for reattach until the place closes.
  it.runIf(subject.journal !== undefined)(subject.unjournaledEnd === undefined ? 'answers the true end of an exec whose end it cannot journal, says so, and reports it on reattach until close' : `still answers an exec whose end it cannot journal with ${subject.unjournaledEnd}, not its true end`, async () => {
    const warned = vi.spyOn(log, 'warn');
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo started; while [ ! -f release ]; do sleep 0.05; done; echo done']);
    let isRunning = false;
    const ended = runtime.exec(request, { onOutput: (stream, data) => { if (stream === 'stdout' && data.includes('started')) isRunning = true; } }, 'command');
    expect(await until(() => isRunning)).toBe(true);
    const journal = subject.journal?.(state) ?? [];

    try {
      for (const root of journal) setDirModes(root, 0o500);
      fs.writeFileSync(path.join(worktree, 'release'), '');

      const end = await ended;

      if (subject.unjournaledEnd !== undefined) {
        expect(end.kind === 'failed' ? `failed ${end.failure.code}` : end.kind).toBe(subject.unjournaledEnd);

        return;
      }

      expect(end).toEqual({ kind: 'exited', code: 0, stdout: 'started\ndone\n' });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`operation ${request.op}`));
      expect(await runtime.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'exited', code: 0, stdout: 'started\ndone\n' }]));
    } finally {
      for (const root of journal) setDirModes(root, 0o700);
    }
  });

  it.runIf(subject.retains)('reattaches after its own restart with a finished exec and its complete stdout', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write("retained")']);
    await first.exec(request, {}, 'command');
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'exited', code: 0, stdout: 'retained' }]));
    expect(await second.exec(request, {}, 'command')).toEqual({ kind: 'exited', code: 0, stdout: 'retained' });
  });

  it.runIf(subject.retains)('finishes an exec its own restart left running, so reattach reads it running, and cancel stops it', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo $$ > shell.pid; sleep 30']);
    void first.exec(request, {}, 'command');
    const pidFile = path.join(worktree, 'shell.pid');
    expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const shell = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'running' }]));
    await second.cancel(request.op);
    expect(await until(() => !pidAlive(shell))).toBe(true);
    // The operation ends cancelled once no process of it is left, which the runtime may record after the shell is gone.
    let settled: unknown;
    expect(await until(async () => {
      const reattached = await second.reattach(opened.handle);
      settled = reattached;
      return reattached.kind !== 'alive' || reattached.ops.some((op) => op.state !== 'running');
    })).toBe(true);
    expect(settled).toEqual(alive([{ op: request.op, state: 'cancelled' }]));
  });

  it.runIf(subject.retains)('does not run again an exec id its own restart left running, and ends it when cancelled', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo x >> runs; sleep 30']);
    void first.exec(request, {}, 'command');
    const runs = path.join(worktree, 'runs');
    expect(await until(() => fs.existsSync(runs))).toBe(true);
    await first.dispose();
    const second = await start();
    let accepted = false;
    const ending = second.exec(request, { onAccepted: () => { accepted = true; } }, 'command');
    expect(await until(() => accepted)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fs.readFileSync(runs, 'utf8')).toBe('x\n');
    await second.cancel(request.op);
    expect(await ending).toEqual<ExecEnd>({ kind: 'cancelled' });
  });

  it.runIf(subject.retains)('ends an exec id its own restart left running with the outcome that exec recorded', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").writeFileSync("started", ""); setTimeout(() => process.stdout.write("finished"), 3000)']);
    void first.exec(request, {}, 'command');
    expect(await until(() => fs.existsSync(path.join(worktree, 'started')))).toBe(true);
    // The exec outlasts the wait dispose gives the runtime to exit, so the second runtime gets it still running.
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual(alive([{ op: request.op, state: 'running' }]));
    expect(await second.exec(request, {}, 'command')).toEqual<ExecEnd>({ kind: 'exited', code: 0, stdout: 'finished' });
  });
});

/**
 * The scenario suite of a runtime that launches agents its own way (T3, Paseo): it offers `prompt` and no `exec`, and
 * each prompt step reaches it as one `prompt` that ends finished, failed or cancelled. `agent` sets how the subject's
 * agent behaves: how long it works, the output it writes, or the failure it ends with.
 */
interface PromptSubject {
  name: string;
  start(state: string): StepRuntime<DriverCan>;
  options(state: string, agent: JsonValue): RuntimeOptions;
  /** The display the runtime gives for the suite's attempt when it is reattached, if it gives one. */
  display?: RuntimeDisplay;
  /** `place`: it shows that display for the place alone, so a prompt's acceptance carries none. Absent: a prompt shows it too. */
  displays?: 'place';
  /** The failure a prompt ends with when its agent fails with `failure`; absent: that failure as it is. */
  failure?(failure: RuntimeFailure): RuntimeFailure;
  /**
   * The directories the runtime keeps its records of `state` in. Absent: it keeps them in its process alone, so a
   * restarted one finds none, and the scenarios of a restart and of a journal it cannot write do not run for it.
   */
  journal?(state: string): string[];
  /** How the runtime still answers a prompt whose end it cannot journal (`<kind> <failure code>`), where that is not its true end. */
  unjournaledEnd?: string;
  /** Stops what the subject's fakes run for `state` beside the runtime, such as an app's server, before the leak check. */
  stop?(state: string): Promise<void>;
  /**
   * Deletes the conversation prompt `op` launched, as the person deletes its thread or agent in the app. Absent: the
   * subject does not continue a conversation yet, and the scenarios of `continue` do not run for it.
   */
  forget?(state: string, op: OpId): void | Promise<void>;
  /** Lays out `at` as another working directory of the scenario's project, a later place's. Absent: an empty folder. */
  elsewhere?(state: string, at: string): void;
  /**
   * It also runs commands, as the sandbox does, and runs each tool on the attempt's tool home, which the suite's place
   * then names. Absent: it offers no `exec`, and its places get no tool home.
   */
  execsOnToolHome?: true;
  /**
   * An app's runtime through a sandbox (`use: <app>, through: sandbox`): the sandbox runs commands, and a place names the
   * step's tool and the attempt's tool home, where the app's tool runs as teamai's wrapper, which starts it in the
   * sandbox, so a finished prompt's session is there. `toolStarted` says whether the app started the step's tool there
   * for the suite's prompt, which it may do after it shows the agent: until it has, a teamai stopped meanwhile stops
   * that start, and the prompt has more than its end left to journal. Absent: the runtime on its own.
   */
  through?: { toolStarted(state: string): boolean };
  /** The home the runtime names for the prompt's session, when it names one: the tool home the session is kept in. */
  sessionHome?(state: string): string;
}

const T3 = await t3OnFakeServer();
const paseo = await paseoOnFakeDaemon();

/**
 * The fake `claude` of a tools subject, in `state`'s bin, which does what the suite's `agent` says, as the toy's agent
 * does: waits for `release`, holds for `hold_ms`, ends failed with `fail`, writes `result` or `output` to the result file
 * the prompt names, and states `usage`.
 */
function fakeClaudeAgent(bin: string, agent: JsonValue): void {
  fakeAgent(claudeFake, { bin, before: `
    const told = ${JSON.stringify(agent)};
    const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID();
    if (told.release) while (!fs.existsSync(told.release)) await sleep(20);
    if (told.hold_ms) return hang();
    if (told.fail) {
      await say(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: told.fail.message, session_id: session }));
      process.exit(1);
    }
    const resultAt = [prompt, ...args].join(' ').match(/as JSON to (\\S+)\\.(?:\\s|$)/)[1];
    const written = told.result ?? (told.output === undefined ? undefined : { output: told.output });
    if (written !== undefined) fs.writeFileSync(resultAt, JSON.stringify(written));
    const billed = { input_tokens: told.usage?.input ?? 0, output_tokens: told.usage?.output ?? 0, ...(told.usage?.cachedInput !== undefined && { cache_read_input_tokens: told.usage.cachedInput }) };
    await say(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session, usage: billed }));
    process.exit(0);
  ` });
}

/** The assignment that puts `wrappers` first on the PATH of an app's runtime, when given: none otherwise. */
const wrappersFirst = (wrappers: string | undefined): string[] => (wrappers === undefined ? [] : [`PATH=${wrappers}${path.delimiter}${process.env['PATH'] ?? ''}`]);

/** The T3 runtime over `state`, which finds on its PATH the folder `wrappers` holds first, when given. */
const t3Runtime = (state: string, wrappers?: string): StepRuntime<DriverCan> => stdioStepRuntime({ name: 't3', command: T3.command, args: [...wrappersFirst(wrappers), ...T3.args(state)] });

/** `runtime`, which reaches T3 over `state` once the fake T3 Code server for it is up and the member signed in. */
const t3Started = (state: string, runtime: StepRuntime<DriverCan>): StepRuntime<DriverCan> => ({ ...runtime, init: async (input) => { await T3.ready(state); return runtime.init(input); } });

/** The Paseo runtime over `state`, which finds on its PATH the folder `wrappers` holds first, when given. */
const paseoRuntime = (state: string, wrappers?: string): StepRuntime<DriverCan> => stdioStepRuntime({ name: 'paseo', command: '/usr/bin/env', args: [...wrappersFirst(wrappers), ...paseo.args(state)] });

/** The attempt's tool home over `state`, which a place through a sandbox names (`CLAUDE_CONFIG_DIR`). */
const attemptToolHome = (state: string): string => path.join(path.dirname(state), 'tool-home');

/** The home the fake daemon's Claude keeps its sessions in over `state`. */
const daemonClaudeHome = (state: string): string => path.join(state, 'daemon-user', '.claude');

/**
 * The Paseo runtime's options, with the toy's agent as the fake daemon's: a model it cannot run is one the daemon does not
 * offer. The daemon runs Claude alone, which keeps its sessions in `claudeHome`, so the runtime offers their tokens.
 */
function paseoOptions(claudeHome: string, agent: JsonValue): RuntimeOptions {
  const { fail, usage, ...behaviour } = typeof agent === 'object' && agent !== null && !Array.isArray(agent) ? agent : {};
  const billed = ToyUsageSchema.optional().parse(usage);
  paseo.behave({
    ...behaviour, claude_home: claudeHome, models: { claude: [fail === undefined ? 'claude-opus-5-5' : 'claude-sonnet-5-5'] },
    ...(billed && { usage: { input: billed.input ?? 0, output: billed.output ?? 0, cache_read: billed.cachedInput ?? 0 } }),
  });

  return { url: paseo.url };
}

/**
 * The sandbox's TMPDIR over `state`, short enough for a socket: the sandbox serves its attempt socket there when the
 * result's folder is too deep for one, as the test's can be, and a runtime the test kills leaves that socket's folder.
 */
const socketTemp = (state: string): string => path.join('/tmp', `teamai-scenario-${crypto.createHash('sha256').update(state).digest('hex').slice(0, 12)}`);

/** `inner` through the sandbox on the fake docker over `state`, as a definition entry `use: <app>, through: sandbox` runs it. */
const throughDocker = (state: string, inner: StepRuntime<DriverCan>): StepRuntime<DriverCan> => {
  fs.mkdirSync(socketTemp(state), { recursive: true });

  return composedStepRuntime({
    outer: stdioStepRuntime({ name: 'sandbox', command: docker.command, args: [`TMPDIR=${socketTemp(state)}`, ...docker.args(state)] }), inner, innerCredentials: {},
  });
};

/**
 * Claude in the fake docker's image, as teamai's wrapper starts it there for an app's agent over `state`: it marks that
 * it started, and exits, since the app's fake plays the agent itself.
 */
function claudeInImage(state: string): void {
  fs.writeFileSync(path.join(docker.bin, 'claude'), `#!/bin/sh\n: > '${claudeStarted(state)}'\n`, { mode: 0o755 });
}

/** Where Claude in the fake docker's image marks that it started for an app's agent over `state`. */
const claudeStarted = (state: string): string => path.join(state, 'claude-started');

const PROMPT_SUBJECTS: PromptSubject[] = [
  {
    name: 'tools on the fake claude',
    start: (state) => toolsStepRuntime<DriverCan>({
      can: { exec: false, tools: ['claude'], tokens: true },
      launch: toolsLaunchDeps(),
      launcher: stepLauncher(toolsLaunchDeps(), { resolveTool: () => path.join(state, 'bin', 'claude') }),
    }),
    options: (state, agent) => {
      fakeClaudeAgent(path.join(state, 'bin'), agent);

      return {};
    },
    // A tool that exits failing is a failed launch, whatever it printed: the launch names its exit.
    failure: () => ({ code: 'tool_failed', message: expect.any(String) }),
  },
  // The sandbox launches the tool of its image itself, on the attempt's tool home.
  ...([['docker', docker], ['sbx', sbx]] as const).map(([provider, on]): PromptSubject => {
    const { display } = SUBJECTS.find((subject) => subject.name === `sandbox on a fake ${provider}`) ?? {};

    return {
      name: `sandbox on a fake ${provider}, on its image's fake claude`,
      start: (state) => stdioStepRuntime({ name: 'sandbox', command: on.command, args: on.args(state) }),
      options: (_, agent) => {
        fakeClaudeAgent(on.bin, agent);

        return on.options;
      },
      ...(display && { display, displays: 'place' as const }),
      failure: () => ({ code: 'tool_failed', message: expect.any(String) }),
      journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox')],
      execsOnToolHome: true,
    };
  }),
  {
    name: 'toy over stdio, prompt only',
    start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
    options: (state, agent) => ({ state, agent }),
    journal: (state) => [path.join(state, 'ops')],
    forget: (state, op) => fs.rmSync(path.join(state, 'conversations', `toy-session-${op.slice(3)}.json`)),
  },
  {
    name: 't3 over stdio, on a fake T3 Code server',
    start: (state) => t3Started(state, t3Runtime(state)),
    options: (state, agent) => T3.options(state, agent),
    display: {
      label: 'review · teamai r0123abcd', url: expect.stringMatching(/^t3code:\/\/threads\/env-fake-1\/mcp%3Alaunch%3A[0-9a-f]+$/),
      fields: { thread: expect.stringMatching(/^mcp:launch:[0-9a-f]+$/), model: 'claude-opus-5-5', environment: 'fake-laptop' },
    },
    // A thread whose run fails names T3's status, not the agent's own failure.
    failure: () => ({ code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') }),
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 't3')],
    stop: (state) => T3.stop(state),
    forget: (state, op) => T3.forget(state, op),
    elsewhere: (state, at) => T3.worktreeAt(state, at),
  },
  {
    name: 'paseo over stdio, on a fake Paseo daemon',
    start: (state) => paseoRuntime(state),
    options: (state, agent) => paseoOptions(daemonClaudeHome(state), agent),
    sessionHome: daemonClaudeHome,
    display: expect.objectContaining({ label: 'teamai review · r0123abcd', url: expect.stringMatching(/^paseo:\/\/h\/srv_fake0001\/agent\//) }),
    failure: (failure) => ({ ...failure, message: `The Paseo daemon at ${paseo.url} has no claude model claude-opus-5-5. It offers: claude-sonnet-5-5.` }),
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'paseo')],
    forget: (_, op) => paseo.forget(op),
  },
  // An app through the sandbox: its runtime adds teamai's wrapper, from its PATH, as the provider that runs Claude, and
  // the app's fake starts it in place of Claude: it asks the sandbox's attempt socket, and runs Claude in the sandbox.
  {
    name: 't3 through a sandbox on a fake docker',
    start: (state) => t3Started(state, throughDocker(state, t3Runtime(state, docker.wrappers(state)))),
    options: (state, agent) => {
      claudeInImage(state);

      return { sandbox: docker.options, t3: T3.options(state, agent, { toolHome: path.join(path.dirname(state), 'tool-home') }) };
    },
    display: {
      label: 'review · teamai r0123abcd', url: expect.stringMatching(/^t3code:\/\/threads\/env-fake-1\/mcp%3Alaunch%3A[0-9a-f]+$/),
      fields: { thread: expect.stringMatching(/^mcp:launch:[0-9a-f]+$/), model: 'claude-opus-5-5', environment: 'fake-laptop' },
    },
    failure: () => ({ code: 'tool_failed', message: expect.stringContaining('ended failed before the step was done.') }),
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox'), path.join(state, 'home', '.teamai', 'runtime-state', 't3')],
    stop: (state) => T3.stop(state),
    through: { toolStarted: (state) => fs.existsSync(claudeStarted(state)) },
    sessionHome: attemptToolHome,
  },
  {
    name: 'paseo through a sandbox on a fake docker',
    start: (state) => throughDocker(state, paseoRuntime(state, docker.wrappers(state))),
    options: (state, agent) => {
      claudeInImage(state);

      // Through the sandbox, Claude keeps its sessions in the attempt's tool home.
      return { sandbox: docker.options, paseo: paseoOptions(attemptToolHome(state), agent) };
    },
    display: expect.objectContaining({ label: 'teamai review · r0123abcd', url: expect.stringMatching(/^paseo:\/\/h\/srv_fake0001\/agent\//) }),
    failure: (failure) => ({ ...failure, message: `The Paseo daemon at ${paseo.url} has no claude model claude-opus-5-5. It offers: claude-sonnet-5-5.` }),
    journal: (state) => [path.join(state, 'home', '.teamai', 'runtime-state', 'sandbox'), path.join(state, 'home', '.teamai', 'runtime-state', 'paseo')],
    through: { toolStarted: (state) => fs.existsSync(claudeStarted(state)) },
    sessionHome: attemptToolHome,
  },
];

describe.each(PROMPT_SUBJECTS)('StepRuntime prompt scenarios: $name', (subject) => {
  const alive = (ops: OpState[]) => ({ kind: 'alive', ops, ...(subject.display && { display: subject.display }) });
  let dir: string;
  let worktree: string;
  let state: string;
  const started: StepRuntime<DriverCan>[] = [];
  /** Whether the runtime last started offers tokens: then every prompt it finishes carries the tokens its agent billed. */
  let offersTokens = false;

  const start = async (agent: JsonValue = {}): Promise<StepRuntime<DriverCan>> => {
    const runtime = subject.start(state);
    started.push(runtime);
    const ready = await runtime.init({ options: subject.options(state, agent), mode: 'unattended', homeEnv: homeEnvOf([]) });
    offersTokens = ready.ok && ready.can.tokens === true;
    expect(ready).toMatchObject({ ok: true, launchesAgents: true, ...(subject.execsOnToolHome ? { runsOnToolHome: true } : { can: subject.through ? { isolation: 'sandbox' } : { exec: false } }) });
    // Through a sandbox, the sandbox runs commands, which it offers by leaving `exec` unset.
    if (subject.through) expect(ready.ok && ready.can).not.toHaveProperty('exec');

    return runtime;
  };

  const toolHome = (): string => path.join(dir, 'tool-home');
  // The open of the test's place, which a restarted teamai sends again before it reattaches the place.
  let placeOpen: OpenRequest | undefined;

  const opened = async (runtime: StepRuntime<DriverCan>): Promise<string> => {
    placeOpen = {
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, ...(subject.through && { tool: 'claude' }),
      view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: subject.execsOnToolHome || subject.through ? { CLAUDE_CONFIG_DIR: toolHome() } : {} },
    };
    const place = await runtime.open(placeOpen, async () => {});

    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);

    return place.handle;
  };

  /**
   * A runtime started again, as a restarted teamai starts it: through a sandbox, it opens the test's place again first,
   * whose repeated id answers the same place, and gives the sandbox the prompt's credentials again, which it keeps only
   * in memory.
   */
  const restarted = async (agent: JsonValue, handle: string): Promise<StepRuntime<DriverCan>> => {
    const runtime = await start(agent);

    if (!subject.through) return runtime;

    if (placeOpen === undefined) throw new Error('The test opened no place to open again.');
    expect(await runtime.open(placeOpen, async () => {})).toMatchObject({ kind: 'ready', handle });

    return runtime;
  };

  const promptRequest = (handle: string, op = newOpId()): PromptRequest => ({
    op, handle, env: { STEP_VALUE: 'from-teamai' }, unset: [], credentials: {}, cwd: worktree,
    lease: {
      step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false,
      prompt: `Review the change.\n\nWrite the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}.`, result: path.join(dir, 'out', 'result.json'),
    },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-prompt-'));
    worktree = path.join(dir, 'worktree');
    state = path.join(dir, 'state');
    fs.mkdirSync(worktree);
    fs.mkdirSync(path.join(dir, 'out'));
    fs.mkdirSync(path.join(dir, 'tool-home'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));

    try {
      await subject.stop?.(state);
      // The runtime, and what it or the subject's fakes started, all name the test's directory.
      await expectNothingLeft({ dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (subject.through) fs.rmSync(socketTemp(state), { recursive: true, force: true });
    }
  });

  it('accepts a prompt, then ends finished with the tool\'s session, the result the agent wrote and its usage', async () => {
    const billed = { input: 1200, output: 300, cachedInput: 500 };
    const runtime = await start({ output: { verdict: 'approve' }, usage: billed });
    const handle = await opened(runtime);
    const request = promptRequest(handle);
    let accepted = false;

    const end = await runtime.prompt(request, { onAccepted: () => { accepted = true; } });

    expect(accepted).toBe(true);
    // Each subject plays a runtime that offers tokens, as the real one does.
    expect(offersTokens).toBe(true);
    expect(end).toEqual({ kind: 'finished', session: { tool: 'claude', id: expect.any(String), ...(subject.sessionHome && { home: subject.sessionHome(state) }) }, result: { output: { verdict: 'approve' } }, usage: billed });
    expect(JSON.parse(fs.readFileSync(request.lease.result, 'utf8'))).toEqual({ output: { verdict: 'approve' } });
  });

  it('ends finished with no failure when the agent writes "failure": null beside its output', async () => {
    const runtime = await start({ result: { output: { verdict: 'approve' }, failure: null } });

    const end = await runtime.prompt(promptRequest(await opened(runtime)), {});

    expect(end).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
    expect(end.kind === 'finished' ? end.result.failure : 'not finished').toBeUndefined();
  });

  it('answers closed to a close of a place it already closed, after a prompt ran there', async () => {
    const runtime = await start({ output: { verdict: 'approve' } });
    const handle = await opened(runtime);
    expect(await runtime.prompt(promptRequest(handle), {})).toMatchObject({ kind: 'finished' });

    expect(await runtime.close(handle)).toEqual({ ok: true });
    expect(await runtime.close(handle)).toEqual({ ok: true });
  });

  it('answers a repeated prompt id with the same outcome', async () => {
    const runtime = await start({ output: { verdict: 'approve' } });
    const request = promptRequest(await opened(runtime));
    const first = await runtime.prompt(request, {});

    expect(first.kind).toBe('finished');
    expect(await runtime.prompt(request, {})).toEqual(first);
  });

  it('answers a prompt id repeated while it runs with the same acceptance and outcome for each caller', async () => {
    // The agent works until the test releases it, so the repeat arrives while the first prompt is in flight.
    const release = path.join(dir, 'release');
    const runtime = await start({ release, output: { verdict: 'approve' } });
    const request = promptRequest(await opened(runtime));
    let firstAccepted = false;
    let repeatAccepted = false;
    const first = runtime.prompt(request, { onAccepted: () => { firstAccepted = true; } });
    expect(await until(() => firstAccepted)).toBe(true);
    const repeated = runtime.prompt(request, { onAccepted: () => { repeatAccepted = true; } });
    fs.writeFileSync(release, '');

    const [firstEnd, repeatedEnd] = await Promise.all([first, repeated]);

    expect(firstEnd.kind).toBe('finished');
    expect(repeatedEnd).toEqual(firstEnd);
    expect(repeatAccepted).toBe(true);
  });

  it('ends failed when the agent cannot finish the step, naming why', async () => {
    const failure = { code: 'model_unavailable', message: 'The daemon has no model claude-opus-5-5.' };
    const runtime = await start({ fail: failure });

    expect(await runtime.prompt(promptRequest(await opened(runtime)), {})).toEqual({ kind: 'failed', failure: subject.failure?.(failure) ?? failure });
  });

  it('cancels a running prompt', async () => {
    const runtime = await start({ hold_ms: 60_000 });
    const handle = await opened(runtime);
    const request = promptRequest(handle);
    let accepted = false;
    const ending = runtime.prompt(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);

    await runtime.cancel(request.op);

    expect(await ending).toEqual({ kind: 'cancelled' });
    expect(await runtime.reattach(handle)).toEqual(alive([{ op: request.op, state: 'cancelled' }]));
  });

  it.runIf(subject.execsOnToolHome !== true && subject.through === undefined)('runs no command: an exec fails, naming the runtime\'s offer', async () => {
    const runtime = await start();
    const end = await runtime.exec({ op: newOpId(), handle: await opened(runtime), argv: ['/bin/sh', '-c', 'touch ran'], env: {}, unset: [], credentials: {}, cwd: worktree }, {}, 'command');

    expect(end).toMatchObject({ kind: 'failed', failure: { code: 'exec_unsupported' } });
    expect(fs.existsSync(path.join(worktree, 'ran'))).toBe(false);
  });

  it.runIf(subject.journal !== undefined)(subject.unjournaledEnd === undefined ? 'answers the true end of a prompt whose end it cannot journal, says so, and reports it on reattach until close' : `still answers a prompt whose end it cannot journal with ${subject.unjournaledEnd}, not its true end`, async () => {
    const warned = vi.spyOn(log, 'warn');
    const release = path.join(dir, 'release');
    const runtime = await start({ release, output: { verdict: 'approve' } });
    const handle = await opened(runtime);
    const request = promptRequest(handle);
    let accepted = false;
    let shown = false;
    const ended = runtime.prompt(request, { onAccepted: ({ display }) => { accepted = true; shown ||= display !== undefined; }, onDisplay: () => { shown = true; } });
    // A runtime that shows its agent has journaled that agent by then, and through a sandbox, once the tool started there,
    // its prompt too: only the end is left to journal.
    expect(await until(() => accepted && (subject.display === undefined || subject.displays === 'place' || shown) && (subject.through?.toolStarted(state) ?? true))).toBe(true);
    const journal = subject.journal?.(state) ?? [];

    try {
      for (const root of journal) setDirModes(root, 0o500);
      fs.writeFileSync(release, '');

      const end = await ended;

      if (subject.unjournaledEnd !== undefined) {
        expect(end.kind === 'failed' ? `failed ${end.failure.code}` : end.kind).toBe(subject.unjournaledEnd);

        return;
      }

      expect(end).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`operation ${request.op}`));
      expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive', ops: [{ op: request.op, state: 'finished', result: { output: { verdict: 'approve' } } }] });
    } finally {
      for (const root of journal) setDirModes(root, 0o700);
    }
  });

  // Two toys on one state, as a killed teamai's and the restarted one's, both wait on the same agent.
  it.runIf(subject.name.startsWith('toy'))('ends a prompt two runtimes wait on in both, when the one that claims the end cannot journal it', async () => {
    const release = path.join(dir, 'release');
    const agent = { release, output: { verdict: 'approve' } };
    const before = await start(agent);
    const handle = await opened(before);
    const request = promptRequest(handle);
    let accepted = false;
    const first = before.prompt(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);
    const after = await start(agent);
    const second = after.prompt(request, {});
    const journal = subject.journal?.(state) ?? [];

    try {
      for (const root of journal) setDirModes(root, 0o500);
      fs.writeFileSync(release, '');

      expect(await Promise.all([first, second])).toEqual([
        expect.objectContaining({ kind: 'finished', result: { output: { verdict: 'approve' } } }),
        expect.objectContaining({ kind: 'finished', result: { output: { verdict: 'approve' } } }),
      ]);
    } finally {
      for (const root of journal) setDirModes(root, 0o700);
    }
  });

  it.runIf(subject.journal !== undefined)('reattaches after its own restart with a finished prompt, and a repeated prompt reads the same outcome', async () => {
    const first = await start({ output: { verdict: 'approve' }, usage: { input: 10 } });
    const handle = await opened(first);
    const request = promptRequest(handle);
    const finished = await first.prompt(request, {});
    expect(finished.kind).toBe('finished');
    if (finished.kind !== 'finished') return;
    await first.dispose();
    const second = await restarted({ output: { verdict: 'approve' }, usage: { input: 10 } }, handle);

    expect(await second.reattach(handle)).toEqual(alive([{ op: request.op, state: 'finished', session: finished.session, result: finished.result, usage: finished.usage }]));
    expect(await second.prompt(request, {})).toEqual(finished);
  });

  it.runIf(subject.journal !== undefined)('reconnects to a prompt its own restart left running: reattach reads it running, and the repeated prompt ends finished', async () => {
    // The agent works until the test releases it, so it is still running when the runtime restarts.
    const release = path.join(dir, 'release');
    const agent = { release, output: { verdict: 'approve' } };
    const first = await start(agent);
    const handle = await opened(first);
    const request = promptRequest(handle);
    let accepted = false;
    let shown = false;
    void first.prompt(request, { onAccepted: ({ display }) => { accepted = true; shown ||= display !== undefined; }, onDisplay: () => { shown = true; } });
    // A runtime that shows its agent has journaled that agent by then, so the restart reattaches to it; through a sandbox,
    // once the tool started there, a restart no longer stops that start.
    expect(await until(() => accepted && (subject.display === undefined || subject.displays === 'place' || shown) && (subject.through?.toolStarted(state) ?? true))).toBe(true);
    await first.dispose();
    const second = await restarted(agent, handle);

    expect(await second.reattach(handle)).toEqual(alive([{ op: request.op, state: 'running' }]));
    const reconnected = second.prompt(request, {});
    fs.writeFileSync(release, '');
    expect(await reconnected).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
  });

  describe.runIf(subject.forget !== undefined)('a prompt that continues an earlier conversation, over stdio', () => {
    /** The place of a later attempt, in `at`. */
    const openedAt = async (runtime: StepRuntime<DriverCan>, at: string): Promise<string> => {
      if (at !== worktree && subject.elsewhere) subject.elsewhere(state, at);
      else fs.mkdirSync(at, { recursive: true });
      const place = await runtime.open({
        op: newOpId(), run: 'r0123abcd', attempt: 'a4567cdef', credentials: {},
        view: { worktree: at, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
      }, async () => {});

      if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);

      return place.handle;
    };

    /** The first step's prompt, finished, and the place it ran in, which teamai keeps open. */
    const earlier = async (runtime: StepRuntime<DriverCan>): Promise<{ handle: string; request: PromptRequest; session: { tool: string; id: string } }> => {
      const handle = await opened(runtime);
      const request = promptRequest(handle);
      const end = await runtime.prompt(request, {});

      if (end.kind !== 'finished') throw new Error(`not finished: ${JSON.stringify(end)}`);

      return { handle, request, session: { tool: end.session.tool, id: end.session.id } };
    };

    /** The later step's prompt in its own place `handle`, which continues `first`'s conversation and resumes its session. */
    const continuing = (handle: string, first: Awaited<ReturnType<typeof earlier>>, cwd = worktree): PromptRequest => {
      const request = promptRequest(handle);

      return { ...request, cwd, lease: { ...request.lease, resume: first.session.id, continue: { handle: first.handle, op: first.request.op } } };
    };

    const noticesFor = (warned: { mock: { calls: unknown[][] } }, op: string): unknown[] => warned.mock.calls.filter(([line]) => typeof line === 'string' && line.includes(`operation ${op}`));

    it('continues it as a new turn of the same session while it still holds it, and says resumed', async () => {
      const warned = vi.spyOn(log, 'warn');
      const runtime = await start({ output: { verdict: 'approve' } });
      const first = await earlier(runtime);
      const request = continuing(await openedAt(runtime, worktree), first);

      const end = await runtime.prompt(request, {});

      expect(end).toMatchObject({ kind: 'finished', session: first.session, resumed: true });
      expect(noticesFor(warned, request.op)).toEqual([]);
    });

    it('starts a new conversation, with one notice and no resumed, once the person deleted it', async () => {
      const warned = vi.spyOn(log, 'warn');
      const runtime = await start({ output: { verdict: 'approve' } });
      const first = await earlier(runtime);
      await subject.forget?.(state, first.request.op);
      const request = continuing(await openedAt(runtime, worktree), first);

      const end = await runtime.prompt(request, {});

      expect(end).toMatchObject({ kind: 'finished', result: { output: { verdict: 'approve' } } });
      expect(end.kind === 'finished' && end.session.id).not.toBe(first.session.id);
      expect(end.kind === 'finished' ? end.resumed : 'not finished').not.toBe(true);
      expect(noticesFor(warned, request.op)).toHaveLength(1);
    });

    it('starts a new conversation, with one notice, for a prompt that works in another directory', async () => {
      const warned = vi.spyOn(log, 'warn');
      const runtime = await start({ output: { verdict: 'approve' } });
      const first = await earlier(runtime);
      const elsewhere = path.join(dir, 'other-worktree');
      const request = continuing(await openedAt(runtime, elsewhere), first, elsewhere);

      const end = await runtime.prompt(request, {});

      expect(end.kind === 'finished' && end.session.id).not.toBe(first.session.id);
      expect(end.kind === 'finished' ? end.resumed : 'not finished').not.toBe(true);
      expect(noticesFor(warned, request.op)).toHaveLength(1);
    });

    it('starts a new conversation, with one notice, once the earlier place closed', async () => {
      const warned = vi.spyOn(log, 'warn');
      const runtime = await start({ output: { verdict: 'approve' } });
      const first = await earlier(runtime);
      expect(await runtime.close(first.handle)).toEqual({ ok: true });
      const request = continuing(await openedAt(runtime, worktree), first);

      const end = await runtime.prompt(request, {});

      expect(end.kind === 'finished' && end.session.id).not.toBe(first.session.id);
      expect(end.kind === 'finished' ? end.resumed : 'not finished').not.toBe(true);
      expect(noticesFor(warned, request.op)).toHaveLength(1);
    });

    it('keeps it through the close of a later place whose turn still runs: that close stops only its own turn', async () => {
      const release = path.join(dir, 'release');
      const runtime = await start({ release, output: { verdict: 'approve' } });
      fs.writeFileSync(release, '');
      const first = await earlier(runtime);
      fs.rmSync(release);
      const later = await openedAt(runtime, worktree);
      let accepted = false;
      void runtime.prompt(continuing(later, first), { onAccepted: () => { accepted = true; } });
      expect(await until(() => accepted)).toBe(true);

      expect(await runtime.close(later)).toEqual({ ok: true });
      fs.writeFileSync(release, '');
      const third = continuing(await openedAt(runtime, worktree), first);

      expect(await runtime.prompt(third, {})).toMatchObject({ kind: 'finished', session: first.session, resumed: true });
    });

    it('reattaches a later turn its own restart left running, and that turn ends as one more turn of the conversation', async () => {
      const release = path.join(dir, 'release');
      const agent = { release, output: { verdict: 'approve' } };
      const before = await start(agent);
      fs.writeFileSync(release, '');
      const first = await earlier(before);
      fs.rmSync(release);
      const later = await openedAt(before, worktree);
      const request = continuing(later, first);
      let accepted = false;
      void before.prompt(request, { onAccepted: () => { accepted = true; } });
      expect(await until(() => accepted)).toBe(true);
      await before.dispose();
      const after = await start(agent);

      expect(await after.reattach(later)).toEqual(alive([{ op: request.op, state: 'running' }]));
      const reconnected = after.prompt(request, {});
      fs.writeFileSync(release, '');
      expect(await reconnected).toMatchObject({ kind: 'finished', session: first.session, resumed: true });
    });

    it('continues it after its own restart between the two prompts', async () => {
      const first = await start({ output: { verdict: 'approve' } });
      const before = await earlier(first);
      await first.dispose();
      const second = await start({ output: { verdict: 'approve' } });
      const request = continuing(await openedAt(second, worktree), before);

      expect(await second.prompt(request, {})).toMatchObject({ kind: 'finished', session: before.session, resumed: true });
    });
  });
});

/**
 * A confined prompt: a judge with one directory as its only readable root, in a place opened without a view of the
 * host. A runtime offers `can.confined` only when its `init` says it answers such prompts; teamai drops the offer
 * otherwise, so a step confined to a directory never reaches it.
 */
/** A conformance profile that speaks as the local driver offering a step on a step runtime teamai ships. */
type RuntimeProfile = Exclude<(typeof PROFILES_UNDER_TEST)[number], (typeof DRIVERS_UNDER_TEST)[number]>;

/**
 * Each step runtime a conformance profile speaks for, as it runs here on its fake, with the options that make it offer
 * what the profile describes. Keyed by every runtime profile under test, so a new one is tied to its runtime's offer, or
 * says why it is not, before it type checks.
 */
const RUNTIME_OFFERS: Record<RuntimeProfile, ((state: string) => { runtime: StepRuntime<DriverCan>; options: RuntimeOptions }) | undefined> = {
  t3: (state) => ({ runtime: t3Started(state, t3Runtime(state)), options: T3.options(state, {}) }),
  // The profile runs Claude alone, whose sessions the runtime reads in the home the daemon names.
  paseo: (state) => {
    paseo.behave({ models: { claude: ['claude-opus-5-5'] }, claude_home: path.join(state, 'daemon-user', '.claude') });

    return { runtime: paseoRuntime(state), options: { url: paseo.url } };
  },
  // Its profile offers a verified Codex judge too, which needs Codex and its sign-in in an image this fake docker lacks.
  sandbox: undefined,
};

const isRuntimeProfile = (profile: string): profile is RuntimeProfile => Object.hasOwn(RUNTIME_OFFERS, profile);

describe('the conformance profile of each step runtime', () => {
  let dir: string;
  const started: StepRuntime<DriverCan>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-profile-'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));

    try {
      await T3.stop(path.join(dir, 'state'));
      await expectNothingLeft({ dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const tied = PROFILES_UNDER_TEST.flatMap((profile) => {
    const offer = isRuntimeProfile(profile) ? RUNTIME_OFFERS[profile] : undefined;

    return offer ? [{ profile, offer }] : [];
  });

  // A scenario run as the profile then holds and leases steps as the local driver does with the runtime's own offer.
  it.each(tied)('declares what the $profile runtime offers the local driver', async ({ profile, offer }) => {
    const { runtime, options } = offer(path.join(dir, 'state'));
    started.push(runtime);
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options, mode: 'unattended' });

    if (!ready.ok) throw new Error(`The ${profile} runtime offered nothing: ${ready.failure.message}`);
    // A local driver has a person by its operation, not by the runtime's offer, and runs every runtime's steps remotely.
    const { hitl: _hitl, ...offered } = ready.can;
    expect(DRIVER_PROFILES[profile].can).toEqual({ ...offered, remote: true });
  });
});

describe('a runtime that answers confined prompts, over stdio', () => {
  let dir: string;
  let evidence: string;
  let state: string;
  const started: StepRuntime<DriverCan>[] = [];
  const offer = [{ level: 'best-effort' as const, access: 'read' as const, tools: ['claude'] }];

  const start = (): StepRuntime<DriverCan> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);

    return runtime;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-confined-'));
    evidence = path.join(dir, 'evidence');
    state = path.join(dir, 'state');
    fs.mkdirSync(path.join(evidence, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'transcript.jsonl'), '{}\n');
    fs.writeFileSync(path.join(evidence, 'nested', 'diff.patch'), '');
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tells the runtime at init the names of the credentials and logins it brings, never a value, so it offers only the judges it can sign in', async () => {
    const ready = await start().init({ homeEnv: homeEnvOf([]), options: { state, judge: {} }, mode: 'unattended', credentials: { env: ['ANTHROPIC_API_KEY'], logins: ['codex'] } });

    expect(ready).toMatchObject({ ok: true });
    const noted = fs.readFileSync(path.join(state, 'credentials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(noted).toEqual([{ type: 'init', names: ['ANTHROPIC_API_KEY'], logins: ['codex'] }]);
  });

  it('drops can.confined from an offer whose init does not say it answers confined prompts', async () => {
    const ready = await start().init({ homeEnv: homeEnvOf([]), options: { state, can: { confined: offer } }, mode: 'unattended' });

    expect(ready).toMatchObject({ ok: true });
    expect(ready.ok && ready.can.confined).toBeUndefined();
  });

  it('answers a confined prompt in a place opened with no view, reading only its directory, and reports the level it kept', async () => {
    const runtime = start();
    const ready = await runtime.init({ homeEnv: homeEnvOf([]), options: { state, judge: { reply: { answer: { label: 'good' } } } }, mode: 'unattended' });
    expect(ready).toMatchObject({ ok: true, can: { confined: offer } });
    const place = await runtime.open({ op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {} }, async () => {});

    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);
    const schema = { type: 'object', properties: { answer: { type: 'object' } }, required: ['answer'] };

    const end = await runtime.prompt({
      op: newOpId(), handle: place.handle, env: {}, unset: [], credentials: {}, cwd: evidence,
      lease: { step: 'judge', tool: 'claude', prompt: 'Judge the work.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false },
      confined: { dir: evidence, level: 'best-effort', access: 'read', schema },
    }, {});

    expect(end).toMatchObject({ kind: 'finished', result: { output: { answer: { label: 'good' } } }, confined: { level: 'best-effort', access: 'read' } });
    const sent = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { sees?: string[]; confined?: unknown });
    expect(sent[0]).toMatchObject({ sees: ['nested/diff.patch', 'transcript.jsonl'], confined: { dir: evidence, level: 'best-effort', access: 'read', schema } });
  });
});

describe('a runtime\'s display over stdio', () => {
  let dir: string;
  const started: StepRuntime<DriverCan>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-display-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const openWith = async (display: JsonValue) => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), display }, mode: 'unattended' })).toMatchObject({ ok: true });
    const opened = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});

    return { runtime, opened };
  };

  it('carries the display a runtime gives when it opens and when it is reattached', async () => {
    const display = { label: 'teamai-r7-a1 (sbx)', url: 't3://thread/7', fields: { sandbox: 'teamai-r7-a1', image: 'teamai-warm:3f9c' } };
    const { runtime, opened } = await openWith(display);

    expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd', display });
    expect(await runtime.reattach('toy-r0123abcd-a0123abcd')).toEqual({ kind: 'alive', ops: [], display });
  });

  it.each([
    ['a label over 80 characters', { label: 'x'.repeat(81) }],
    ['a script link', { label: 'sandbox', url: 'javascript:alert(1)' }],
    ['more than 8 fields', { label: 'sandbox', fields: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, 'v'])) }],
    ['a field that is not a string', { label: 'sandbox', fields: { cpus: 4 } }],
    ['a path in the member\'s home', { label: 'sandbox', fields: { dir: path.join(os.homedir(), 'work') } }],
  ])('opens without a display that has %s', async (_, display) => {
    const { opened } = await openWith(display);

    expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd' });
  });

  it.each([
    ['carries the display', { label: 'Review the change', url: 'paseo://agent/9f2c', fields: { agent: 'claude', mode: 'default' } }, true],
    ['drops a display it cannot show from', { label: 'x'.repeat(81) }, false],
  ])('%s a prompt runtime gives once it accepted the prompt', async (_, display, kept) => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), agent: { output: { ok: true }, display } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const opened = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const lease = { step: 'review', tool: 'claude', prompt: 'Review.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false } as const;
    const shown: unknown[] = [];

    await runtime.prompt({ op: newOpId(), handle: opened.handle, lease, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, { onAccepted: (accepted) => { shown.push(accepted); } });

    expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd' });
    expect(shown).toEqual([kept ? { display } : {}]);
  });

  it('carries a display a prompt runtime sends after it accepted the prompt, apart from the acceptance', async () => {
    const display = { label: 'Review the change', url: 't3://thread/5e1c', fields: { agent: 'claude' } };
    const release = path.join(dir, 'release');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), agent: { output: { ok: true }, display, display_after_ms: 0, release } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const opened = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const lease = { step: 'review', tool: 'claude', prompt: 'Review.', result: path.join(dir, 'out', 'result.json'), permissions: 'approval-required', interactive: false } as const;
    const accepted: unknown[] = [];
    const shown: unknown[] = [];

    // The agent finishes only once its display arrived, so the display comes while the prompt runs.
    const end = await runtime.prompt({ op: newOpId(), handle: opened.handle, lease, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {
      onAccepted: (acceptance) => { accepted.push(acceptance); },
      onDisplay: (sent) => { shown.push(sent); fs.writeFileSync(release, ''); },
    });

    expect(end).toMatchObject({ kind: 'finished', result: { output: { ok: true } } });
    expect(accepted).toEqual([{}]);
    expect(shown).toEqual([display]);
  });

  it('opens without a display that names a path in a Windows home', async () => {
    vi.stubEnv('HOME', 'C:\\Users\\me');

    try {
      const { opened } = await openWith({ label: 'sandbox', fields: { dir: 'C:\\Users\\me\\work' } });

      expect(opened).toEqual({ kind: 'ready', handle: 'toy-r0123abcd-a0123abcd' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('a runtime that cannot close a place, over stdio', () => {
  let dir: string;
  const started: StepRuntime<DriverCan>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-close-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const opened = async (options: RuntimeOptions): Promise<{ runtime: StepRuntime<DriverCan>; handle: string }> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), ...options }, mode: 'unattended' })).toMatchObject({ ok: true });
    const place = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error('not opened');

    return { runtime, handle: place.handle };
  };

  it('answers close_failed with why, and keeps the place', async () => {
    const { runtime, handle } = await opened({ close_fails: true });

    expect(await runtime.close(handle)).toEqual({ ok: false, failure: { code: 'close_failed', message: `The toy keeps place ${handle}: close_fails is set.` } });
    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive' });
  });

  it('fails a close once the runtime has stopped, instead of answering it closed', async () => {
    const { runtime, handle } = await opened({ exit_at: 'exec-accepted' });
    expect(await runtime.exec({ op: newOpId(), handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 200)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {}, 'command'))
      .toMatchObject({ kind: 'lost', failure: { code: 'runtime_exited' } });

    expect(await runtime.close(handle)).toMatchObject({ ok: false, failure: { code: 'runtime_exited' } });
  });

  it('fails an open sent once the runtime has stopped as runtime_not_sent, since the runtime never got it', async () => {
    const { runtime, handle } = await opened({ exit_at: 'exec-accepted' });
    await runtime.exec({ op: newOpId(), handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 200)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {}, 'command');
    const op = newOpId();
    let isAccepted = false;

    expect(await runtime.open({ op, run: 'r0123abcd', attempt: 'a0123abce', credentials: {} }, async () => { isAccepted = true; }))
      .toMatchObject({ kind: 'failed', failure: { code: 'runtime_not_sent', message: expect.stringContaining(`teamai did not send open ${op}`) } });
    expect(isAccepted).toBe(false);
  });

  it('reads the failure reply for a handle as that request\'s failure, for reattach, collect and close', async () => {
    const { runtime, handle } = await opened({ answer: { reattach: 'failed', collect: 'failed', close: 'failed' } });
    const failure = (type: string) => ({ code: 'toy_refused', message: `The toy refuses ${type} of ${handle}: answer.${type} is set.` });

    expect(await runtime.reattach(handle)).toEqual({ kind: 'failed', failure: failure('reattach') });
    expect(await runtime.collect(handle)).toEqual({ ok: false, failure: failure('collect') });
    expect(await runtime.close(handle)).toEqual({ ok: false, failure: failure('close') });
  });

  it('answers failed, never gone, for a handle whose journal it cannot read', async () => {
    const { runtime, handle } = await opened({});
    fs.writeFileSync(path.join(dir, 'state', 'handles.json'), '{not json');

    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'failed', failure: { code: 'toy_failed', message: expect.stringContaining('The toy cannot read its journal') } });
    expect(await runtime.close(handle)).toMatchObject({ ok: false, failure: { code: 'toy_failed' } });
  });

  it('fails a close it is waiting on as runtime_unanswered when the runtime writes an error that names no request, and the place stays', async () => {
    const { runtime, handle } = await opened({ answer: { close: 'error' } });

    expect(await runtime.close(handle)).toEqual({
      ok: false,
      failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer close of ${handle}: it wrote an error that names no request (The toy cannot answer close of ${handle}: answer.close is set.).` },
    });
    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive' });
  });

  it('ends an exec it is waiting on as lost with runtime_unanswered when the runtime writes an error that names no request', async () => {
    const { runtime, handle } = await opened({ answer: { exec: 'error' } });
    const op = newOpId();

    expect(await runtime.exec({ op, handle, argv: [process.execPath, '-e', ''], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {}, 'command')).toEqual({
      kind: 'lost',
      failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer exec ${op}: it wrote an error that names no request (The toy cannot answer exec of ${handle}: answer.exec is set.).` },
    });
  });

  it('ends a prompt, and fails an open, the runtime does not accept within 15 s, as runtime_unanswered', async () => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), agent: {}, answer: { open: 'silent', prompt: 'silent' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const handle = 'toy-r0123abcd-a0123abcd';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const promptOp = newOpId();
      const openOp = newOpId();
      const prompted = runtime.prompt({
        op: promptOp, handle, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
        lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
      }, {});
      const reopened = runtime.open({ op: openOp, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {} }, async () => {});
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([prompted, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not accept prompt ${promptOp} within 15 s.` } });
      expect(await Promise.race([reopened, 'still waiting'])).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not accept open ${openOp} within 15 s.` } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends an accepted exec and prompt as lost with runtime_unanswered when the runtime gives no outcome within 15 s of their cancel, whatever they write meanwhile', async () => {
    const { runtime, handle } = await opened({ answer: { cancel: 'silent' } });
    const release = path.join(dir, 'release');
    const agentToy = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(agentToy);
    expect(await agentToy.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'agent-state'), agent: { release }, answer: { cancel: 'silent' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    let execAccepted: () => void = () => {};
    let promptAccepted: () => void = () => {};
    let wroteAfterCancel: () => void = () => {};
    let cancelSent = false;
    const execAcceptance = new Promise<void>((resolve) => { execAccepted = resolve; });
    const promptAcceptance = new Promise<void>((resolve) => { promptAccepted = resolve; });
    const outputAfterCancel = new Promise<void>((resolve) => { wroteAfterCancel = resolve; });
    const execOp = newOpId();
    const promptOp = newOpId();
    // The exec writes for a few seconds and then ends, so the toy that ignores its cancel exits once disposed.
    const execEnd = runtime.exec({ op: execOp, handle, argv: [process.execPath, '-e', 'const t = setInterval(() => console.log("tick"), 20); setTimeout(() => clearInterval(t), 3000)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {
      onAccepted: () => execAccepted(),
      onOutput: () => { if (cancelSent) wroteAfterCancel(); },
    }, 'command');
    const promptEnd = agentToy.prompt({
      op: promptOp, handle: 'toy-r0123abcd-a0123abcd', env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
      lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
    }, { onAccepted: () => promptAccepted() });
    await Promise.all([execAcceptance, promptAcceptance]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      await runtime.cancel(execOp);
      await agentToy.cancel(promptOp);
      cancelSent = true;
      await outputAfterCancel;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([execEnd, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not confirm the cancel of exec ${execOp} within 15 s, so what it started may still run.` } });
      expect(await Promise.race([promptEnd, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not confirm the cancel of prompt ${promptOp} within 15 s, so what it started may still run.` } });
    } finally {
      vi.useRealTimers();
      fs.writeFileSync(release, '');
    }
  });

  it('keeps a display the runtime sends before it accepts a prompt, and still ends the prompt runtime_unanswered when no acceptance comes within 15 s', async () => {
    const display = { label: 'Review the change', url: 't3://thread/5e1c' };
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), agent: { display }, answer: { prompt: 'display' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    const accepted: unknown[] = [];
    let showed: (sent: RuntimeDisplay) => void = () => {};
    const shown = new Promise<RuntimeDisplay>((resolve) => { showed = resolve; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const op = newOpId();
      const prompted = runtime.prompt({
        op, handle: 'toy-r0123abcd-a0123abcd', env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
        lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
      }, { onAccepted: (acceptance) => { accepted.push(acceptance); }, onDisplay: showed });

      expect(await Promise.race([shown, prompted])).toEqual(display);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([prompted, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not accept prompt ${op} within 15 s.` } });
      expect(accepted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends an accepted prompt lost with runtime_unanswered 15 s after its cancel when the runtime answers the cancel with only a display', async () => {
    const display = { label: 'Review the change', url: 't3://thread/5e1c' };
    const release = path.join(dir, 'release');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), agent: { release, display }, answer: { cancel: 'display' } }, mode: 'unattended' })).toMatchObject({ ok: true });
    let promptAccepted: () => void = () => {};
    let showed: (sent: RuntimeDisplay) => void = () => {};
    const acceptance = new Promise<void>((resolve) => { promptAccepted = resolve; });
    const shown = new Promise<RuntimeDisplay>((resolve) => { showed = resolve; });
    const op = newOpId();
    const promptEnd = runtime.prompt({
      op, handle: 'toy-r0123abcd-a0123abcd', env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
      lease: { step: 'review', tool: 'claude', prompt: 'p', result: path.join(dir, 'out', 'result.json'), permissions: 'unattended', interactive: false },
    }, { onAccepted: () => promptAccepted(), onDisplay: showed });
    await acceptance;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      await runtime.cancel(op);

      expect(await Promise.race([shown, promptEnd])).toEqual(display);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([promptEnd, 'still waiting'])).toEqual({ kind: 'lost', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not confirm the cancel of prompt ${op} within 15 s, so what it started may still run.` } });
    } finally {
      vi.useRealTimers();
      fs.writeFileSync(release, '');
    }
  });

  it('ignores a display for an operation it does not wait on', async () => {
    const { runtime, handle } = await opened({ display: { label: 'place' }, answer: { cancel: 'display' } });

    await runtime.cancel(newOpId());

    expect(await runtime.reattach(handle)).toMatchObject({ kind: 'alive' });
  });

  it('fails an init the runtime does not answer within 15 s as runtime_unanswered', async () => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const ready = runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), answer: { init: 'silent' } }, mode: 'unattended' });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([ready, 'still waiting'])).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: 'Step runtime "toy" did not answer init within 15 s.' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an attended init 10 min, long enough to approve a sign-in page, and shows the runtime\'s notice meanwhile', async () => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    let noticed: (line: string) => void = () => {};
    const notice = new Promise<string>((resolve) => { noticed = resolve; });
    const warned = vi.spyOn(log, 'warn').mockImplementation((line) => noticed(line));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const ready = runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), answer: { init: 'silent' }, notice: { init: 'Open https://toy.example.test/device to sign in.' } }, mode: 'attended' });

      expect(await notice).toBe('Step runtime "toy": Open https://toy.example.test/device to sign in.');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await Promise.race([ready, 'still waiting'])).toBe('still waiting');
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 15_000);
      expect(await Promise.race([ready, 'still waiting'])).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: 'Step runtime "toy" did not answer init within 10 min, while it ran attended.' } });
    } finally {
      vi.useRealTimers();
      warned.mockRestore();
    }
  });

  it('fails a reattach and a close the runtime does not answer within 15 s as runtime_unanswered', async () => {
    const { runtime, handle } = await opened({ answer: { reattach: 'silent', close: 'silent' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const reattached = runtime.reattach(handle);
      const closed = runtime.close(handle);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await reattached).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer reattach of ${handle} within 15 s.` } });
      expect(await closed).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer close of ${handle} within 15 s.` } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a cancel a runtime tries again, over stdio', () => {
  let dir: string;
  const started: StepRuntime<DriverCan>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-retry-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const toy = async (options: RuntimeOptions): Promise<StepRuntime<DriverCan>> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), ...options }, mode: 'unattended' })).toMatchObject({ ok: true });

    return runtime;
  };

  it('reports the operation running from when it reads the retried cancel until the stop is confirmed, never the stop that failed before', async () => {
    const cannotStop = { code: 'cancel_failed', message: 'The provider is down. Start it, then run teamai workflow cancel again.' };
    const first = await toy({ cancel_fails: cannotStop });
    const place = await first.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error('not opened');
    const op = newOpId();
    void first.exec({ op, handle: place.handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, {}, 'command');
    expect(await until(async () => JSON.stringify(await first.reattach(place.handle)).includes('"running"'))).toBe(true);
    await first.cancel(op);
    expect(await until(async () => JSON.stringify(await first.reattach(place.handle)).includes('cancel_failed'))).toBe(true);

    // A later runtime process, once the provider is back, stops it a while after it reads the cancel.
    const again = await toy({ stop_ms: 1000 });
    await again.cancel(op);

    expect(await again.reattach(place.handle)).toMatchObject({ kind: 'alive', ops: [{ op, state: 'running' }] });
    expect(await until(async () => JSON.stringify(await again.reattach(place.handle)).includes('"cancelled"'), 10_000)).toBe(true);
  });
});

describe('the toy runtime once teamai stops reading it', () => {
  let dir: string;
  const started: StepRuntime<DriverCan>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-epipe-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps running an exec whose output nobody reads, and a toy started again reads how it exited', async () => {
    const state = path.join(dir, 'state');
    const worktree = path.join(dir, 'worktree');
    // teamai is gone: the toy's stdout has no reader, so each line it writes fails with EPIPE.
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = readline.createInterface({ input: toy.stdout });
    const replies: string[] = [];
    lines.on('line', (line) => replies.push(line));
    lines.on('error', (error) => replies.push(`error: ${error.message}`));
    const exec = newOpId();
    toy.stdin.write(`${JSON.stringify({ type: 'init', protocol: 1, homeEnv: homeEnvOf([]), mode: 'unattended', options: { state } })}\n`);
    toy.stdin.write(`${JSON.stringify({ type: 'open', op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } })}\n`);
    toy.stdin.write(`${JSON.stringify({ type: 'exec', op: exec, handle: 'toy-r0123abcd-a0123abcd', argv: [process.execPath, '-e', 'setTimeout(() => { for (let i = 0; i < 50; i += 1) console.log(`line ${i}`); }, 300)'], env: {}, unset: [], cwd: worktree })}\n`);
    expect(await until(() => replies.some((line) => line.includes(exec) && line.includes('accepted')))).toBe(true);
    lines.close();
    toy.stdout.destroy();
    toy.stdin.end();
    await new Promise((resolve) => toy.once('close', resolve));
    const again = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(again);
    expect(await again.init({ homeEnv: homeEnvOf([]), options: { state }, mode: 'unattended' })).toMatchObject({ ok: true });

    expect(await again.reattach('toy-r0123abcd-a0123abcd')).toMatchObject({ kind: 'alive', ops: [{ op: exec, state: 'exited', code: 0 }] });
  });

  it('records the outcome of an exec whose output arrives after the teamai that started it is gone', async () => {
    const worktree = path.join(dir, 'worktree');
    const state = path.join(dir, 'state');
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    readline.createInterface({ input: toy.stdout }).on('line', (line) => { lines.push(line); }).on('error', (error) => { lines.push(`error: ${error.message}`); });
    const write = (request: object): void => { toy.stdin.write(`${JSON.stringify(request)}\n`); };
    const op = newOpId();
    write({ type: 'init', protocol: 1, homeEnv: homeEnvOf([]), mode: 'unattended', options: { state } });
    write({ type: 'open', op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } });
    expect(await until(() => lines.some((line) => line.includes('"ready"')))).toBe(true);
    const argv = [process.execPath, '-e', 'setTimeout(() => process.stdout.write("finished"), 500)'];
    write({ type: 'exec', op, handle: 'toy-r0123abcd-a0123abcd', argv, env: {}, unset: [], credentials: {}, cwd: worktree });
    expect(await until(() => lines.some((line) => line.includes(op) && line.includes('"accepted"')))).toBe(true);
    // As when teamai is killed: nobody reads the toy's stdout any more, and its stdin ends.
    toy.stdout.destroy();
    toy.stdin.end();

    const second = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(second);
    expect(await second.init({ homeEnv: homeEnvOf([]), options: { state }, mode: 'unattended' })).toMatchObject({ ok: true });

    // Another command under the same id: an outcome of `finished` is the recorded one, not a second run.
    const rerun = [process.execPath, '-e', 'process.stdout.write("ran again")'];
    expect(await second.exec({ op, handle: 'toy-r0123abcd-a0123abcd', argv: rerun, env: {}, unset: [], credentials: {}, cwd: worktree }, {}, 'command'))
      .toEqual<ExecEnd>({ kind: 'exited', code: 0, stdout: 'finished' });
  });

  it('reads an exec its stopped owner has not recorded yet as running, then as the outcome the owner records', async () => {
    const worktree = path.join(dir, 'worktree');
    const state = path.join(dir, 'state');
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    readline.createInterface({ input: toy.stdout }).on('line', (line) => { lines.push(line); }).on('error', (error) => { lines.push(`error: ${error.message}`); });
    const write = (request: object): void => { toy.stdin.write(`${JSON.stringify(request)}\n`); };
    const op = newOpId();
    write({ type: 'init', protocol: 1, homeEnv: homeEnvOf([]), mode: 'unattended', options: { state } });
    write({ type: 'open', op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } });
    expect(await until(() => lines.some((line) => line.includes('"ready"')))).toBe(true);
    write({ type: 'exec', op, handle: 'toy-r0123abcd-a0123abcd', argv: [process.execPath, '-e', 'setTimeout(() => { process.stdout.write("retained"); require("fs").writeFileSync("ended", ""); }, 300)'], env: {}, unset: [], credentials: {}, cwd: worktree });
    expect(await until(() => lines.some((line) => line.includes(op) && line.includes('"accepted"')))).toBe(true);
    // The owner cannot record the outcome while it is stopped, though its exec ends.
    toy.kill('SIGSTOP');

    try {
      expect(await until(() => fs.existsSync(path.join(worktree, 'ended')))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
      started.push(second);
      expect(await second.init({ homeEnv: homeEnvOf([]), options: { state }, mode: 'unattended' })).toMatchObject({ ok: true });

      expect(await second.reattach('toy-r0123abcd-a0123abcd')).toEqual({ kind: 'alive', ops: [{ op, state: 'running' }] });
      toy.kill('SIGCONT');
      let read: unknown;
      expect(await until(async () => {
        read = await second.reattach('toy-r0123abcd-a0123abcd');

        return JSON.stringify(read) !== JSON.stringify({ kind: 'alive', ops: [{ op, state: 'running' }] });
      })).toBe(true);
      expect(read).toEqual({ kind: 'alive', ops: [{ op, state: 'exited', code: 0, stdout: 'retained' }] });
    } finally {
      toy.kill('SIGCONT');
      toy.stdin.end();
    }
  });

  it('fails init for a protocol version it does not speak, naming the key', async () => {
    const toy = spawn(process.execPath, [TOY_RUNTIME], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines: string[] = [];
    readline.createInterface({ input: toy.stdout }).on('line', (line) => { lines.push(line); }).on('error', (error) => { lines.push(`error: ${error.message}`); });
    toy.stdin.write(`${JSON.stringify({ type: 'init', protocol: 99, mode: 'unattended', options: { state: path.join(dir, 'state') } })}\n`);

    try {
      expect(await until(() => lines.length > 0)).toBe(true);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ type: 'init', ok: false, error: { code: 'bad_protocol', key: 'protocol' } });
    } finally {
      toy.stdin.end();
    }
  });
});

describe('a driver whose runtime stopped on a line it could not read', () => {
  let dir: string;
  let driver: ReturnType<typeof spawn> | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-stray-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(() => {
    if (driver?.exitCode === null && driver.signalCode === null) driver.kill('SIGKILL');
    const strayPid = path.join(dir, 'state', 'stray.pid');

    if (fs.existsSync(strayPid)) {
      try {
        signalPid(Number(fs.readFileSync(strayPid, 'utf8')), 'SIGKILL');
      } catch {
        // It already ended.
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exits once it disposes the runtime, though a tool the runtime started still holds the runtime\'s output open', async () => {
    const runtimes = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflow', 'runtimes');
    const entry = path.join(dir, 'driver.mjs');
    // A driver of its own process, as teamai is: it runs one exec through the StepRuntime interface, then disposes it.
    buildSync({
      stdin: {
        contents: `
          import { stdioStepRuntime } from './stdio.js';
          const [toy, dir] = process.argv.slice(2);
          const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [toy] });
          await runtime.init({ options: { state: dir + '/state', stray: true }, mode: 'unattended', homeEnv: ${JSON.stringify(homeEnvOf([]))} });
          const place = await runtime.open({ op: 'op-00000001', run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree: dir + '/worktree', readonly: [], result: dir + '/out', runDir: dir + '/scratch', toolHome: {} } }, async () => {});
          const end = await runtime.exec({ op: 'op-00000002', handle: place.handle, argv: [process.execPath, '-e', ''], env: {}, unset: [], credentials: {}, cwd: dir + '/worktree' }, {});
          console.log(JSON.stringify(end));
          await runtime.dispose();
        `,
        resolveDir: runtimes, loader: 'ts', sourcefile: 'driver.ts',
      },
      outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'error',
      banner: { js: "import { createRequire as driverCreateRequire } from 'node:module'; const require = driverCreateRequire(import.meta.url);" },
    });
    let printed = '';
    driver = spawn(process.execPath, [entry, TOY_RUNTIME, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    driver.stdout?.setEncoding('utf8').on('data', (data: string) => { printed += data; });
    const exited = new Promise<number | null>((resolve) => driver?.once('exit', (code) => resolve(code)));

    expect(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 5000))])).toBe(0);
    expect(printed).toContain('"kind":"lost"');
    expect(printed).toContain('runtime_exited');
    expect(pidAlive(Number(fs.readFileSync(path.join(dir, 'state', 'stray.pid'), 'utf8')))).toBe(true);
  });
});

describe('an attempt\'s deadline, over stdio', () => {
  let dir: string;
  const started: StepRuntime<DriverCan>[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-deadline-'));
    fs.mkdirSync(path.join(dir, 'worktree'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(started.splice(0).map((runtime) => runtime.dispose()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A toy with `options`, and its place opened with `deadline`. */
  const opened = async (options: RuntimeOptions, deadline: string): Promise<{ runtime: StepRuntime<DriverCan>; handle: string }> => {
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state: path.join(dir, 'state'), ...options }, mode: 'unattended' })).toMatchObject({ ok: true });
    const place = await runtime.open({
      op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, deadline,
      view: { worktree: path.join(dir, 'worktree'), readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} },
    }, async () => {});
    if (place.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(place)}`);

    return { runtime, handle: place.handle };
  };

  const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

  it('leaves an exec still running at the attempt\'s deadline to the step\'s own limit, and cancels it 15 s past the deadline', async () => {
    const { runtime, handle } = await opened({}, soon(5_000));
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const op = newOpId();

    let accepted = (): void => {};
    const isAccepted = new Promise<void>((resolve) => { accepted = resolve; });

    const end = runtime.exec({ op, handle, argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree') }, { onAccepted: () => accepted() }, 'command');
    await isAccepted;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([end, 'still running'])).toBe('still running');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    expect(await end).toEqual({ kind: 'cancelled' });
    expect(warned.mock.calls.map(([line]) => line)).toEqual([`Step runtime "toy" still ran exec ${op} 15 s past the attempt's deadline, so teamai cancels it.`]);
    warned.mockRestore();
  });

  it('cancels an accepted prompt still running 15 s past the attempt\'s deadline', async () => {
    const { runtime, handle } = await opened({ agent: { release: path.join(dir, 'never'), output: { ok: true } } }, soon(5_000));
    const request: PromptRequest = {
      op: newOpId(), handle, env: {}, unset: [], credentials: {}, cwd: path.join(dir, 'worktree'),
      lease: { step: 'review', tool: 'claude', permissions: 'approval-required', interactive: false, prompt: 'Review.', result: path.join(dir, 'out', 'result.json') },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let accepted = (): void => {};
    const isAccepted = new Promise<void>((resolve) => { accepted = resolve; });

    const end = runtime.prompt(request, { onAccepted: () => accepted() });
    await isAccepted;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([end, 'still running'])).toBe('still running');
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    expect(await end).toEqual({ kind: 'cancelled' });
  });

  it('fails a collect the runtime does not answer within 15 s past the attempt\'s deadline as runtime_unanswered', async () => {
    const { runtime, handle } = await opened({ answer: { collect: 'silent' } }, soon(5_000));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const collected = runtime.collect(handle);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await Promise.race([collected, 'still waiting'])).toBe('still waiting');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await Promise.race([collected, 'still waiting'])).toEqual({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "toy" did not answer collect of ${handle} within 15 s of the attempt's deadline.` } });
  });

  it('fails an open whose place is not ready at the attempt\'s deadline as runtime_unanswered, keeping its handle', async () => {
    // A runtime that accepts every open and never reports its place ready, as one whose image pull never ends.
    const acceptsOnly = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      if (request.type === 'open') process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted', handle: 'h1' }) + '\\n');
    });`;
    const runtime = stdioStepRuntime({ name: 'slow', command: process.execPath, args: ['-e', acceptsOnly] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
    const persisted: string[] = [];
    const op = newOpId();

    const place = await runtime.open({ op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, deadline: soon(1_000), view: { worktree: dir, readonly: [], result: dir, runDir: dir, toolHome: {} } }, async (handle) => { persisted.push(handle); });

    expect(place).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "slow" did not report the place of open ${op} ready by the attempt's deadline.` } });
    expect(persisted).toEqual(['h1']);
  });

  it('keeps the handle of an open sent past the attempt\'s deadline, which it fails once the runtime accepts it', async () => {
    // A runtime that accepts each open a moment later, and never reports its place ready.
    const late = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      if (request.type === 'open') setTimeout(() => process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted', handle: 'h1' }) + '\\n'), 300);
    });`;
    const runtime = stdioStepRuntime({ name: 'late', command: process.execPath, args: ['-e', late] });
    started.push(runtime);
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
    const persisted: string[] = [];
    const op = newOpId();

    const place = await runtime.open({ op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, deadline: soon(-60_000), view: { worktree: dir, readonly: [], result: dir, runDir: dir, toolHome: {} } }, async (handle) => { persisted.push(handle); });

    expect(place).toEqual({ kind: 'failed', failure: { code: 'runtime_unanswered', message: `Step runtime "late" did not report the place of open ${op} ready by the attempt's deadline.` } });
    expect(persisted).toEqual(['h1']);
  });
});

describe('the stdio step runtime client', () => {
  it('waits for the handle write when the runtime dies after accepting an open, and rejects with its error', async () => {
    // A runtime that accepts every open with a handle and exits before it reports the place ready.
    const acceptsThenExits = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      if (request.type === 'open') process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted', handle: 'h1' }) + '\\n', () => process.exit(1));
    });`;
    const runtime = stdioStepRuntime({ name: 'accepts-then-exits', command: process.execPath, args: ['-e', acceptsThenExits] });
    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
    const request: OpenRequest = { op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree: os.tmpdir(), readonly: [], result: os.tmpdir(), runDir: os.tmpdir(), toolHome: {} } };

    await expect(runtime.open(request, async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new Error('the run record could not be written');
    })).rejects.toThrow('the run record could not be written');
    await runtime.dispose();
  });

  it('shows the first 2000 characters of a longer notice, and keeps the runtime', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const long = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') {
        process.stdout.write(JSON.stringify({ event: 'notice', message: 'x'.repeat(3000) }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {} }) + '\\n');
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'long', command: process.execPath, args: ['-e', long] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      expect(warned.mock.calls.map(([line]) => line)).toEqual([`Step runtime "long": ${'x'.repeat(2000)}…`]);
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('shows a notice the runtime writes as a warning, with its credentials masked, and keeps the request it came with going', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // A runtime that tells the person something while it answers: at init, and before it accepts an open.
    const notes = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') { write({ event: 'notice', message: 'Signing in to acme as al.' }); write({ type: 'init', ok: true, can: {} }); }
      if (request.type === 'open') {
        write({ event: 'notice', op: request.op, message: 'The acme token ' + request.credentials.ACME_TOKEN + ' expires tomorrow.' });
        write({ op: request.op, event: 'accepted', handle: 'h1' });
        write({ event: 'notice', handle: 'h1', message: 'Pulling acme/agent:1.' });
        write({ op: request.op, event: 'ready' });
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'notes', command: process.execPath, args: ['-e', notes], secrets: { 'ACME_TOKEN (credential of notes)': 'acme-secret-7f3a91' } });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      const opened = await runtime.open({ op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: { ACME_TOKEN: 'acme-secret-7f3a91' }, view: { worktree: os.tmpdir(), readonly: [], result: os.tmpdir(), runDir: os.tmpdir(), toolHome: {} } }, async () => {});

      expect(opened).toMatchObject({ kind: 'ready', handle: 'h1' });
      const lines = warned.mock.calls.map(([line]) => line);
      expect(lines).toEqual([
        'Step runtime "notes": Signing in to acme as al.',
        expect.stringMatching(/^Step runtime "notes", operation op-[0-9a-f]+: The acme token <REDACTED:ACME_TOKEN \(credential of notes\)> expires tomorrow\.$/),
        'Step runtime "notes", place h1: Pulling acme/agent:1.',
      ]);
      expect(lines.join('\n')).not.toContain('acme-secret-7f3a91');
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('counts and logs a terminal for an operation it no longer waits on, and keeps the first one', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // A runtime that ends each exec twice, the second time differently, as one that answers a cancel after an end.
    const twice = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, can: {} });
      if (request.type === 'exec') {
        write({ op: request.op, event: 'accepted' });
        write({ op: request.op, event: 'exited', code: 0, stdout: 'ok' });
        write({ op: request.op, event: 'cancelled' });
        write({ op: request.op, event: 'output', stream: 'stdout', data: 'late' });
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'twice', command: process.execPath, args: ['-e', twice] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      const [first, second] = [newOpId(), newOpId()];
      const exec = (op: typeof first): ExecRequest => ({ op, handle: 'h1', argv: ['true'], env: {}, unset: [], credentials: {}, cwd: os.tmpdir() });

      expect(await runtime.exec(exec(first), {}, 'command')).toEqual({ kind: 'exited', code: 0, stdout: 'ok' });
      expect(await until(() => warned.mock.calls.length === 1)).toBe(true);
      expect(await runtime.exec(exec(second), {}, 'command')).toEqual({ kind: 'exited', code: 0, stdout: 'ok' });
      expect(await until(() => warned.mock.calls.length === 2)).toBe(true);

      expect(warned.mock.calls.map(([line]) => line)).toEqual([
        `Step runtime "twice" answered ${first} with cancelled after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: 1).`,
        `Step runtime "twice" answered ${second} with cancelled after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: 2).`,
      ]);
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('counts no end that answers a cancel it sent, even one that repeats an end already given', async () => {
    const warned = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // Each cancel is answered with an end twice; an exec ends, then ends again.
    const answers = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, can: {} });
      if (request.type === 'cancel') { write({ op: request.op, event: 'exited', code: 0, stdout: '' }); write({ op: request.op, event: 'cancelled' }); }
      if (request.type === 'exec') { write({ op: request.op, event: 'accepted' }); write({ op: request.op, event: 'exited', code: 0, stdout: '' }); write({ op: request.op, event: 'exited', code: 0, stdout: '' }); }
    });`;
    const runtime = stdioStepRuntime({ name: 'answers', command: process.execPath, args: ['-e', answers] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true });
      const [cancelled, ended] = [newOpId(), newOpId()];

      await runtime.cancel(cancelled);
      await runtime.exec({ op: ended, handle: 'h1', argv: ['true'], env: {}, unset: [], credentials: {}, cwd: os.tmpdir() }, {}, 'command');
      expect(await until(() => warned.mock.calls.length > 0)).toBe(true);
      expect(warned.mock.calls.map(([line]) => line)).toEqual([
        `Step runtime "answers" answered ${ended} with exited after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: 1).`,
      ]);
    } finally {
      warned.mockRestore();
      await runtime.dispose();
    }
  });

  it('fails a runtime that writes a key protocol 1 does not have, naming the key', async () => {
    const surplus = `require('readline').createInterface({ input: process.stdin }).on('line', () => {
      process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {}, surplus: true }) + '\\n');
    });`;
    const runtime = stdioStepRuntime({ name: 'surplus', command: process.execPath, args: ['-e', surplus] });

    expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: false, failure: { message: expect.stringContaining('"surplus"') } });
    await runtime.dispose();
  });

  const WAKE = { pool: 'gpu', repository: 'https://example.com/acme/app.git', message: 'teamai workflow resume --pool gpu --next', title: 'Fleet member for gpu' };

  it('wakes a fleet member on a runtime that offers it, and says where it launched it', async () => {
    // A runtime that wakes a member on another machine: it accepts, shows the thread it launched, and says where.
    const wakes = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, can: {}, wake: true });
      if (request.type === 'wake') {
        write({ op: request.op, event: 'accepted' });
        write({ op: request.op, event: 'display', display: { label: request.title, url: 't3://thread/th-1' } });
        write({ op: request.op, event: 'woken', where: 'studio-mac:' + request.pool });
      }
    });`;
    const runtime = stdioStepRuntime({ name: 'wakes', command: process.execPath, args: ['-e', wakes] });
    const shown: RuntimeDisplay[] = [];

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true, wakes: true });
      expect(await runtime.wake?.({ op: newOpId(), ...WAKE }, { onDisplay: (display) => shown.push(display) })).toEqual({ kind: 'woken', where: 'studio-mac:gpu' });
      expect(shown).toEqual([{ label: 'Fleet member for gpu', url: 't3://thread/th-1' }]);
    } finally {
      await runtime.dispose();
    }
  });

  it('wakes on the toy only when its wake_log is set, which gets each wake as one JSON line', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-toy-wake-'));
    const wakeLog = path.join(state, 'wakes.jsonl');
    const [plain, waking] = [stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }), stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] })];
    const op = newOpId();

    try {
      expect(await plain.init({ homeEnv: homeEnvOf([]), options: { state: path.join(state, 'plain') }, mode: 'unattended' })).not.toHaveProperty('wakes');
      expect(await waking.init({ homeEnv: homeEnvOf([]), options: { state: path.join(state, 'waking'), wake_log: wakeLog }, mode: 'unattended' })).toMatchObject({ ok: true, wakes: true });
      expect(await waking.wake?.({ op, ...WAKE }, {})).toEqual({ kind: 'woken', where: 'toy' });
      expect(fs.readFileSync(wakeLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual([{ type: 'wake', op, ...WAKE }]);
    } finally {
      await Promise.all([plain.dispose(), waking.dispose()]);
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('sends no wake to a runtime whose init did not offer one', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-toy-nowake-'));
    const calls = path.join(state, 'calls.jsonl');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state, calls }, mode: 'unattended' })).toMatchObject({ ok: true });
      expect(await runtime.wake?.({ op: newOpId(), ...WAKE }, {})).toEqual({ kind: 'failed', failure: { code: 'wake_unavailable', message: 'Step runtime "toy" wakes no fleet member: its init did not offer wake.' } });
      expect(fs.existsSync(calls)).toBe(false);
    } finally {
      await runtime.dispose();
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it('sends no wake to a runtime opened only to recover, whatever its init says', async () => {
    // A runtime that offers wake in every mode, and would wake on any.
    const always = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, can: {}, wake: true });
      if (request.type === 'wake') { write({ op: request.op, event: 'accepted' }); write({ op: request.op, event: 'woken', where: 'anywhere' }); }
    });`;
    const runtime = stdioStepRuntime({ name: 'always', command: process.execPath, args: ['-e', always] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'recover' })).toMatchObject({ ok: true });
      expect(await runtime.wake?.({ op: newOpId(), ...WAKE }, {})).toMatchObject({ kind: 'failed', failure: { code: 'wake_unavailable' } });
    } finally {
      await runtime.dispose();
    }
  });

  it('ends a wake lost when the runtime stops after accepting it, since the member may still launch', async () => {
    const acceptsThenExits = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type === 'init') process.stdout.write(JSON.stringify({ type: 'init', ok: true, can: {}, wake: true }) + '\\n');
      if (request.type === 'wake') process.stdout.write(JSON.stringify({ op: request.op, event: 'accepted' }) + '\\n', () => process.exit(1));
    });`;
    const runtime = stdioStepRuntime({ name: 'accepts-then-exits', command: process.execPath, args: ['-e', acceptsThenExits] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true, wakes: true });
      expect(await runtime.wake?.({ op: newOpId(), ...WAKE }, {})).toEqual({ kind: 'lost', failure: { code: 'runtime_exited', message: expect.stringContaining('Step runtime "accepts-then-exits" stopped: it exited with status 1.') } });
    } finally {
      await runtime.dispose();
    }
  });

  /** A place and a prompt on it, in a fresh directory, for a runtime that launches agents. */
  const promptPlace = (dir: string) => {
    const worktree = path.join(dir, 'worktree');
    fs.mkdirSync(worktree);
    const open: OpenRequest = { op: newOpId(), run: 'r0123abcd', attempt: 'a0123abcd', credentials: {}, view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} } };
    const prompt = (handle: string, lease: Partial<PromptRequest['lease']> = {}): PromptRequest => ({
      op: newOpId(), handle, env: {}, unset: [], credentials: {}, cwd: worktree,
      lease: { step: 'review', tool: 'claude', permissions: 'approval-required', interactive: false, prompt: 'Review the change.', result: path.join(dir, 'out', 'result.json'), ...lease },
    });

    return { open, prompt };
  };

  it('never sends an answer lease, which only the host slot answers, and fails it runtime_protocol', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stdio-answer-'));
    const received = path.join(dir, 'received.jsonl');
    // A runtime that records every line it reads, and accepts any open.
    const recording = `const fs = require('fs'); const file = process.argv.at(-1);
    require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      fs.appendFileSync(file, line + '\\n');
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, prompt: true, can: { exec: false } });
      if (request.type === 'open') { write({ op: request.op, event: 'accepted', handle: 'h1' }); write({ op: request.op, event: 'ready' }); }
    });`;
    const runtime = stdioStepRuntime({ name: 'recording', command: process.execPath, args: ['-e', recording, received] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true, launchesAgents: true });
      const place = promptPlace(dir);
      expect(await runtime.open(place.open, async () => {})).toMatchObject({ kind: 'ready', handle: 'h1' });

      expect(await runtime.prompt(place.prompt('h1', { answer: true }), {})).toEqual({
        kind: 'failed', failure: { code: 'runtime_protocol', message: expect.stringContaining('Step runtime "recording" is never sent an answer step') },
      });
      const types = fs.readFileSync(received, 'utf8').trim().split('\n').map((line) => z.object({ type: z.string() }).parse(JSON.parse(line)).type);
      expect(types).toEqual(['init', 'open']);
    } finally {
      await runtime.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a prompt\'s limits to the runtime as the lease gives them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stdio-limits-'));
    const state = path.join(dir, 'state');
    const runtime = stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] });
    const limits = { budget: { tokens: 20_000 }, timeoutMs: 600_000, idleMs: 120_000 };

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { state, agent: { output: { ok: true } } }, mode: 'unattended' })).toMatchObject({ ok: true, launchesAgents: true });
      const place = promptPlace(dir);
      const opened = await runtime.open(place.open, async () => {});
      if (opened.kind !== 'ready') throw new Error(`not opened: ${JSON.stringify(opened)}`);
      const request = place.prompt(opened.handle, { limits });

      expect(await runtime.prompt(request, {})).toMatchObject({ kind: 'finished' });
      const sent = fs.readFileSync(path.join(state, 'prompts.jsonl'), 'utf8').trim().split('\n')
        .map((line) => z.object({ op: z.string(), sent: z.object({ limits: z.unknown().optional() }).optional() }).parse(JSON.parse(line)))
        .find((line) => line.op === request.op && line.sent !== undefined);
      expect(sent?.sent?.limits).toEqual(limits);
    } finally {
      await runtime.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the tool home and conversations a runtime offers, and the limit a prompt was stopped at', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stdio-stopped-'));
    const stopping = `require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
      if (request.type === 'init') write({ type: 'init', ok: true, prompt: true, toolHome: true, conversations: true, can: { exec: false } });
      if (request.type === 'open') { write({ op: request.op, event: 'accepted', handle: 'h1' }); write({ op: request.op, event: 'ready' }); }
      if (request.type === 'prompt') { write({ op: request.op, event: 'accepted' }); write({ op: request.op, event: 'finished', session: { tool: 'claude', id: 's1' }, result: {}, stopped: 'budget' }); }
    });`;
    const runtime = stdioStepRuntime({ name: 'stopping', command: process.execPath, args: ['-e', stopping] });

    try {
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: {}, mode: 'unattended' })).toMatchObject({ ok: true, launchesAgents: true, runsOnToolHome: true, keepsConversations: true });
      const place = promptPlace(dir);
      await runtime.open(place.open, async () => {});

      expect(await runtime.prompt(place.prompt('h1'), {})).toEqual({ kind: 'finished', session: { tool: 'claude', id: 's1' }, result: {}, stopped: 'budget' });
    } finally {
      await runtime.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A command step that runs until it is stopped. */
const SLOW_COMMAND = 'echo begun > begun.txt; sleep 60';
const SLOW = `schemaVersion: v1alpha1
name: slow
description: Works until stopped.
steps:
  - id: work
    workspace: new
    command: ${SLOW_COMMAND}
`;

/** A prompt step that names its tool, so the owner offers it on a fleet that lists the tool. */
const PROMPTED = `schemaVersion: v1alpha1
name: slow
description: Reviews the work.
steps:
  - id: work
    workspace: new
    tool: claude
    prompt: Review the work.
    output:
      ok: boolean
`;

/** A workflow step whose sub-graph, two commands in the step's own copy, a member can run whole. */
const WHOLE = `schemaVersion: v1alpha1
name: slow
description: Runs a pair of steps.
inputs: { mark: string }
steps:
  - id: work
    workspace: new
    workflow: pair
    with:
      mark: "{{ inputs.mark }}"
`;

const PAIR = `schemaVersion: v1alpha1
name: pair
description: Writes a mark, then counts it.
inputs: { mark: string }
outputs:
  counted: steps.count.outputs.counted
steps:
  - id: write
    workspace: continue
    env:
      MARK: "{{ inputs.mark }}"
    command: echo written > "$MARK"
  - id: count
    needs: [write]
    workspace: continue
    command: echo '{"counted":1}'
    output:
      counted: number
`;

/** As WHOLE with PAIR, written inline: its steps read the run's inputs and their own steps. */
const INLINE = `schemaVersion: v1alpha1
name: slow
description: Runs a pair of steps written inline.
inputs: { mark: string }
steps:
  - id: work
    workspace: new
    workflow:
      outputs:
        counted: steps.count.outputs.counted
      steps:
        - id: write
          workspace: continue
          env:
            MARK: "{{ inputs.mark }}"
          command: echo written > "$MARK"
        - id: count
          needs: [write]
          workspace: continue
          command: echo '{"counted":1}'
          output:
            counted: number
`;

/** An inline workflow whose step reads a step around it, which a nested run has none of. */
const INLINE_AROUND = `schemaVersion: v1alpha1
name: slow
description: Names a mark, then writes it in an inline workflow.
steps:
  - id: name
    command: echo '{"mark":"made.txt"}'
    output:
      mark: string
  - id: work
    needs: [name]
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          env:
            MARK: "{{ steps.name.outputs.mark }}"
          command: echo written > "$MARK"
`;

/** As PAIR, with a gate before the count: the member asks the owner, whose person answers. */
const GATED = `schemaVersion: v1alpha1
name: pair
description: Writes a mark, asks to keep it, then counts it.
inputs: { mark: string }
outputs:
  counted: steps.keep.outputs.counted
steps:
  - id: write
    workspace: continue
    env:
      MARK: "{{ inputs.mark }}"
    command: echo written > "$MARK"
  - id: keep
    needs: [write]
    workspace: continue
    approve: "Keep {{ inputs.mark }}?"
    command: echo '{"counted":1}'
    output:
      counted: number
`;

/** A whole workflow step with a token budget its first review spends: the owner would fail it before the second. */
const BUDGETED = `schemaVersion: v1alpha1
name: slow
description: Reviews twice, on a budget.
steps:
  - id: work
    workspace: new
    workflow: reviews
    budget: { tokens: 1 }
`;

/** As BUDGETED, with the budget on the run around the step rather than on the step. */
const RUN_BUDGETED = `schemaVersion: v1alpha1
name: slow
description: Reviews twice, on a budget of the run.
budget: { tokens: 1 }
steps:
  - id: work
    workspace: new
    workflow: reviews
`;

/** As BUDGETED, per item of a for_each step whose budget covers all its items. */
const ITEMS_BUDGETED = `schemaVersion: v1alpha1
name: slow
description: Reviews twice per item, on a budget of all the items.
inputs: { items: [string] }
steps:
  - id: work
    workspace: new
    for_each: { items: inputs.items }
    workflow: reviews
    budget: { tokens: 1 }
`;

/** A whole workflow step whose two reviews run on claude. */
const REVIEWED = `schemaVersion: v1alpha1
name: slow
description: Reviews twice.
steps:
  - id: work
    workspace: new
    workflow: reviews
`;

const REVIEWS = `schemaVersion: v1alpha1
name: reviews
description: Reviews the work twice.
steps:
  - id: first
    workspace: continue
    tool: claude
    prompt: Review the work first.
    output:
      ok: boolean
  - id: second
    needs: [first]
    workspace: continue
    tool: claude
    prompt: Review the work again.
    output:
      ok: boolean
`;

/** A whole workflow that reviews on claude, then waits a minute: a cancel lands after the review spent its tokens. */
const REVIEW_HOLD = `schemaVersion: v1alpha1
name: reviews
description: Reviews the work, then waits.
steps:
  - id: first
    workspace: continue
    tool: claude
    prompt: Review the work first.
    output:
      ok: boolean
  - id: hold
    needs: [first]
    workspace: continue
    command: sleep 60
`;

/** A step that requires a label from the workflow's defaults, which only a member that declares it where it runs the step takes. */
const LABELLED = `schemaVersion: v1alpha1
name: slow
description: Renders on a GPU.
defaults:
  requires: { labels: [gpu] }
steps:
  - id: work
    workspace: new
    command: echo rendered
`;

/** A step under a strict sandbox that requires a team env key, and writes what of it and of a forge token its process sees. */
const SCOPED_COMMAND = 'printf "%s|%s" "${DEPLOY_URL:-}" "${GH_TOKEN:-}" > env.txt';
const SCOPED = `schemaVersion: v1alpha1
name: slow
description: Deploys in a sandbox.
steps:
  - id: work
    workspace: new
    requires: { env: [DEPLOY_URL], isolation: sandbox, strict: true }
    command: ${SCOPED_COMMAND}
`;

/** As SCOPED, a prompt step. */
const SCOPED_PROMPT = `schemaVersion: v1alpha1
name: slow
description: Reviews in a sandbox.
steps:
  - id: work
    workspace: new
    requires: { env: [DEPLOY_URL], isolation: sandbox, strict: true }
    tool: claude
    prompt: Review the work.
    output:
      ok: boolean
`;

/** A command step that requires env, which it writes into its copy. */
const KEYED = `schemaVersion: v1alpha1
name: slow
description: Writes the deploy key.
steps:
  - id: work
    workspace: new
    requires: { env: [FLEET_DEPLOY_KEY] }
    command: printf %s "$FLEET_DEPLOY_KEY" > key.txt
`;

/** As PAIR, with a gate step of its own between the commands, which runs no tool. */
const ASKED = `schemaVersion: v1alpha1
name: pair
description: Writes a mark, asks to go on, then counts it.
inputs: { mark: string }
steps:
  - id: write
    workspace: continue
    env:
      MARK: "{{ inputs.mark }}"
    command: echo written > "$MARK"
  - id: confirm
    needs: [write]
    approve: "Go on?"
  - id: count
    needs: [confirm]
    workspace: continue
    command: echo counted
`;

/** The fleet runtimes a scenario opened, which teardown disposes. */
const fleetRuntimes: StepRuntime<DriverCan>[] = [];

/** Polls `read` until it answers something. */
async function eventually<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = await read();

    if (value !== undefined) return value;

    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Alice starts workflow `slow` and leases its step, which the fleet runtime of her install then runs. */
async function ownerOf({ workflow = SLOW, command = SLOW_COMMAND, tools, labels, workflows = {}, files = {}, isSandbox = false, inputs, isWhole = false, isPromptless = false, isMeasured = false, isMemberEnv = false, beforeStart }: { workflow?: string; command?: string; tools?: string[]; labels?: string[]; workflows?: Record<string, string>; files?: Record<string, string>; isSandbox?: boolean; inputs?: Record<string, JsonValue>; isWhole?: boolean; isPromptless?: boolean; isMeasured?: boolean; isMemberEnv?: boolean; beforeStart?: (alice: Member) => Promise<void> } = {}) {
  const acme = team({ slow: workflow, ...workflows }, files);
  const [alice, bob] = [await acme.member('alice'), await acme.member('bob')];
  await beforeStart?.(alice);
  const run = RunIdSchema.parse(await startIn(alice, 'slow', inputs));
  const next = await leaseNext(alice.config, run, alice.driver, { can: { workspace: [...WORKSPACES], ...(tools && { tools }), ...(labels && { labels }), ...(isSandbox && { isolation: 'sandbox' as const, env: true }), ...(isWhole && { workflow: true }), ...(isPromptless && { prompt: false as const }), ...(isMeasured && { tokens: true }), ...(isMemberEnv && { env: 'member' as const }) } });
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  const attempt = AttemptIdSchema.parse((next.data.lease as { attempt: string }).attempt);
  /** A fleet runtime of Alice's install, as a driver of hers opens it, whose place is `cwd`; `handle` names it. */
  const open = async (cwd = alice.checkout, options: RuntimeOptions = { stale_after: '60s' }) => {
    const runtime = fleetStepRuntime({ config: alice.config, masks: {} });
    fleetRuntimes.push(runtime);
    const initialized = await runtime.init({ homeEnv: homeEnvOf([]), options, mode: 'unattended', checkout: alice.checkout });
    expect(initialized).toMatchObject({ ok: true, can: { remote: true }, launchesAgents: true });
    expect(initialized.ok && initialized.can).not.toHaveProperty('prompt');
    const opened = await runtime.open({ op: newOpId(), run, attempt, credentials: {} }, async () => undefined);
    if (opened.kind !== 'ready') throw new Error(opened.failure.message);
    const exec = (op: OpId, kind: 'command' | 'workflow' = 'command', events: ExecEvents = {}) => runtime.exec({ op, handle: opened.handle, argv: shellArgv(command), env: {}, unset: [], credentials: {}, cwd }, events, kind);
    // What this host would send of the prompt: the member renders its own, so none of it reaches the record.
    const prompt = (op: OpId) => runtime.prompt({
      op, handle: opened.handle, env: {}, unset: [], credentials: {}, cwd,
      lease: { step: 'work', tool: 'claude', prompt: 'A prompt this host rendered.', result: path.join(cwd, 'result.json'), permissions: 'unattended', interactive: false },
    }, {});

    return { runtime, handle: opened.handle, exec, prompt };
  };

  const record = async () => eventually(async () => {
    const read = await readAttemptRecord(alice.config, run, attempt);

    return read.ok && read.value !== 'absent' ? read.value : undefined;
  });

  return { alice, bob, run, attempt, open, record };
}

/** The runs on `config`'s install: on a member, the nested runs of the whole workflows it took. */
async function runsOf(config: Member['config']) {
  const dir = runsDir(config);
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)) : [];
  const states = await Promise.all(ids.map(async (id) => readRun(config, RunIdSchema.parse(id))));

  return states.flatMap((state) => (state === 'missing' || state === 'corrupt' ? [] : [state]));
}

describe('StepRuntime scenarios: fleet with two installs', () => {
  // Every runtime a scenario opened ends before its installs go, so no wait reads a removed checkout.
  afterEach(async () => {
    await Promise.all(fleetRuntimes.splice(0).map(async (runtime) => runtime.dispose()));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the step\'s command, which a member runs, then ends as the member\'s command did, with its work in the place', async () => {
    const owner = await ownerOf({ workflow: SLOW.replace(SLOW_COMMAND, 'echo done > done.txt && echo \'{"made":1}\''), command: 'echo done > done.txt && echo \'{"made":1}\'' });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: '{"made":1}' });
    expect(fs.readFileSync(path.join(place, 'done.txt'), 'utf8')).toBe('done\n');
  }, 60_000);

  it('gives the member the files the place holds uncommitted, as a step here would find them, and takes its work over them', async () => {
    const command = 'cat half.txt > seen.txt && echo \'{"made":1}\'';
    const owner = await ownerOf({ workflow: SLOW.replace(SLOW_COMMAND, command), command });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    // What an earlier attempt of the step left there, as in a place it kept when its tool hit a usage limit.
    fs.writeFileSync(path.join(place, 'half.txt'), 'half');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);

    await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' } } });

    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: '{"made":1}' });
    expect(fs.readFileSync(path.join(place, 'seen.txt'), 'utf8')).toBe('half');
  }, 60_000);

  it('leaves an attempt whose step requires a label to a member that declares it where it would run the step, as its own copy of the workflow says', async () => {
    const owner = await ownerOf({ workflow: LABELLED, command: 'echo rendered', labels: ['gpu'] });
    const { exec } = await owner.open();
    const ended = exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);
    const take = async (place: MemberPlace) => takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place });
    const elsewhere = { kind: 'runtime' as const, driver: 'teamai-docker', use: 'docker', runtime: fleetStepRuntime({ config: owner.bob.config, masks: {} }) };

    expect(await take({ command: { kind: 'here' } })).toEqual({ data: { idle: { offered: 0 } } });
    owner.bob.config.workflows = { tools: {}, labels: ['gpu'] };
    // This machine's labels say nothing of a runtime of its driver, where the step would run.
    expect(await take({ command: elsewhere })).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });

    expect(await take({ command: { kind: 'here' } })).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toMatchObject({ kind: 'exited', code: 0 });
  }, 60_000);

  it('runs the step\'s command with the env its lease scopes: a required key from the member\'s team store, and no forge token under a strict sandbox', async () => {
    vi.stubEnv('GH_TOKEN', 'member-token');
    const owner = await ownerOf({ workflow: SCOPED, command: SCOPED_COMMAND, files: { 'env/env.yaml': 'variables:\n  - key: DEPLOY_URL\n    value: https://deploy.example\n' }, isSandbox: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toMatchObject({ kind: 'exited', code: 0 });
    expect(fs.readFileSync(path.join(place, 'env.txt'), 'utf8')).toBe('https://deploy.example|');
  }, 60_000);

  it('leaves an attempt whose step requires env this member\'s workflows.allow.env does not allow for another member', async () => {
    const owner = await ownerOf({ workflow: SCOPED, command: SCOPED_COMMAND, files: { 'env/env.yaml': 'variables:\n  - key: DEPLOY_URL\n    value: https://deploy.example\n' }, isSandbox: true });
    const { exec } = await owner.open();
    void exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);
    owner.bob.config.workflows = { tools: {}, allow: { env: ['NPM_TOKEN'] } };
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' } } });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });
    expect(infos).toHaveBeenCalledWith(`Left attempt ${owner.attempt} of run ${owner.run} for another member: its step requires env DEPLOY_URL, which workflows.allow.env on this machine does not allow.`);
  }, 60_000);

  it('says on the offer why it left it, once, and the owner\'s wait shows that reason once, naming the member', async () => {
    const owner = await ownerOf({ workflow: SCOPED, command: SCOPED_COMMAND, files: { 'env/env.yaml': 'variables:\n  - key: DEPLOY_URL\n    value: https://deploy.example\n' }, isSandbox: true });
    const { exec } = await owner.open();
    void exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);
    owner.bob.config.workflows = { tools: {}, allow: { env: ['NPM_TOKEN'] } };
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const warns = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const bob = await installOwner(owner.bob.config);
    const take = () => takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: bob, secrets: {}, place: { command: { kind: 'here' } } });
    const why = 'its step requires env DEPLOY_URL, which workflows.allow.env on this machine does not allow';

    expect(await take()).toEqual({ data: { idle: { offered: 0 } } });
    const left = await owner.record();
    expect(left).toMatchObject({ state: 'offered', left: [{ member: bob, why }] });
    // The same reason again is on the offer already: the member writes nothing.
    await readableReportsWorktree(owner.bob.config);
    expect(await take()).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ write: left?.write });

    const shown = `Fleet member ${bob.user} left step "work" of run ${owner.run} for another member of pool default: ${why}. The step waits for a member that can run it; to stop waiting, run teamai workflow cancel ${owner.run}.`;
    expect(await until(() => warns.mock.calls.some(([message]) => message === shown), 10_000)).toBe(true);
    // Another member leaves the offer for another reason: the wait shows it from a later read of the offer, which still
    // holds bob's reason, and shows bob's no more.
    const offered = await owner.record();
    if (offered.state !== 'offered') throw new Error(`the offer moved: ${offered.state}`);
    const carol = { id: `${bob.id}-carol`, user: 'carol' };
    expect(await leaveOffer(owner.bob.config, offered, { member: carol, why: 'its step requires a GPU', secrets: {} })).toEqual({ ok: true, value: undefined });
    const later = `Fleet member carol left step "work" of run ${owner.run} for another member of pool default: its step requires a GPU. The step waits for a member that can run it; to stop waiting, run teamai workflow cancel ${owner.run}.`;
    expect(await until(() => warns.mock.calls.some(([message]) => message === later), 10_000)).toBe(true);
    expect(warns.mock.calls.filter(([message]) => message === shown)).toHaveLength(1);
  }, 60_000);

  it('runs a prompt step\'s tool with the env its lease scopes, as it does a command', async () => {
    vi.stubEnv('GH_TOKEN', 'member-token');
    const owner = await ownerOf({ workflow: SCOPED_PROMPT, tools: ['claude'], files: { 'env/env.yaml': 'variables:\n  - key: DEPLOY_URL\n    value: https://deploy.example\n' }, isSandbox: true });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const seen = path.join(bin, 'env.txt');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}', before: `fs.writeFileSync(${JSON.stringify(seen)}, (process.env.DEPLOY_URL ?? '') + '|' + (process.env.GH_TOKEN ?? ''));` });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const { prompt } = await owner.open();

    try {
      const ended = prompt(newOpId());
      await owner.record();
      await readableReportsWorktree(owner.bob.config);

      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { prompt: { kind: 'here' } } });

      expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
      expect(await ended).toMatchObject({ kind: 'finished' });
      expect(fs.readFileSync(seen, 'utf8')).toBe('https://deploy.example|');
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 60_000);

  it('leases a whole workflow step to a runtime that runs whole workflows, and starts it for any other, leasing its first step', async () => {
    const whole = await ownerOf({ workflow: WHOLE, workflows: { pair: PAIR }, inputs: { mark: 'made.txt' }, isWhole: true });
    const expanded = await ownerOf({ workflow: WHOLE, workflows: { pair: PAIR }, inputs: { mark: 'made.txt' } });

    expect(await readRun(whole.alice.config, whole.run)).toMatchObject({ steps: [{ id: 'work', status: 'leased' }] });
    expect(await readRun(expanded.alice.config, expanded.run)).toMatchObject({ steps: [{ id: 'work', status: 'running' }, { id: 'work.write', status: 'leased' }, { id: 'work.count', status: 'pending' }] });
  }, 60_000);

  it('starts a workflow step that could go whole at reconcile on a run whose driver has no runtime that runs it whole, so a gate first inside it is asked before any slot frees', async () => {
    const gateFirst = `schemaVersion: v1alpha1
name: pair
description: Asks to go on, then writes a mark.
inputs: { mark: string }
steps:
  - id: confirm
    approve: "Go on?"
  - id: write
    needs: [confirm]
    workspace: continue
    command: echo written > made.txt
`;
    const acme = team({ slow: WHOLE, pair: gateFirst });
    const alice = await acme.member('alice');
    const run = await startIn(alice, 'slow', { mark: 'made.txt' });

    const next = await leaseNext(alice.config, run, alice.driver, { canTakeLease: false, can: { workspace: [...WORKSPACES], hitl: true } });

    expect(next).toMatchObject({ data: { hitl: { step: 'work.confirm', message: 'Go on?' } } });
    expect(await readRun(alice.config, run)).toMatchObject({ steps: [{ id: 'work', status: 'running' }, { id: 'work.confirm' }, { id: 'work.write', status: 'pending' }] });
  }, 60_000);

  it('offers a whole workflow step as one attempt, which a member runs as a nested run from its own copy of the workflow, then ends with the workflow\'s outputs and its work in the place', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: PAIR }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId(), 'workflow');
    expect(await owner.record()).toMatchObject({ state: 'offered', lease: { kind: 'workflow', step: 'work', inputs: { mark: 'made.txt' } } });
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: JSON.stringify({ outcome: 'succeeded', outputs: { counted: 1 } }) });
    expect(fs.readFileSync(path.join(place, 'made.txt'), 'utf8')).toBe('written\n');
  }, 90_000);

  // A run's id is the same in every workflow it runs, as it is where the step runs here.
  it('gives the steps of a whole workflow step a member runs the owner\'s run id, not its nested run\'s', async () => {
    const pair = PAIR.replace('      MARK: "{{ inputs.mark }}"\n    command: echo written > "$MARK"', '      MARK: "{{ inputs.mark }}"\n      RUN: "{{ run.id }}"\n    command: echo "$RUN" > "$MARK"');
    expect(pair).not.toBe(PAIR);
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId(), 'workflow');
    await owner.record();
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toMatchObject({ kind: 'exited', code: 0 });
    expect(fs.readFileSync(path.join(place, 'made.txt'), 'utf8')).toBe(`${owner.run}\n`);
  }, 90_000);

  it('offers an inline workflow step whose steps read only the run\'s inputs as one attempt, which a member runs as a nested run and ends with its outputs', async () => {
    const owner = await ownerOf({ workflow: INLINE, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId(), 'workflow');
    expect(await owner.record()).toMatchObject({ state: 'offered', lease: { kind: 'workflow', step: 'work', inputs: { mark: 'made.txt' } } });
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: JSON.stringify({ outcome: 'succeeded', outputs: { counted: 1 } }) });
    expect(fs.readFileSync(path.join(place, 'made.txt'), 'utf8')).toBe('written\n');
  }, 90_000);

  it('starts an inline workflow step one of whose steps reads a step around it where it stands, since a nested run has none of them', async () => {
    const acme = team({ slow: INLINE_AROUND });
    const alice = await acme.member('alice');
    const run = await startIn(alice, 'slow', {});
    const named = await leaseNext(alice.config, run, alice.driver, { can: { workspace: [...WORKSPACES], workflow: true } });
    const lease = z.object({ step: z.string(), attempt: z.string(), revision: z.number() }).parse('data' in named ? named.data.lease : undefined);
    expect(lease.step).toBe('name');
    await reportAttempt(alice.config, run, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: alice.driver, outputs: { mark: 'made.txt' } });

    const next = await leaseNext(alice.config, run, alice.driver, { can: { workspace: [...WORKSPACES], workflow: true } });

    expect(next).toMatchObject({ data: { lease: { step: 'work.write' } } });
  }, 60_000);

  it('offers a step whose requires.env has no value on the owner to a fleet entry whose env is member, whose member gives it from its own env', async () => {
    const owner = await ownerOf({ workflow: KEYED, isMemberEnv: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId());
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);
    vi.stubEnv('FLEET_DEPLOY_KEY', 'deploy-key-of-bob');

    try {
      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

      expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(await ended).toMatchObject({ kind: 'exited', code: 0 });
    expect(fs.readFileSync(path.join(place, 'key.txt'), 'utf8')).toBe('deploy-key-of-bob');
  }, 90_000);

  it('leaves a step whose requires.env has no value on this member for another member, naming the variable, rather than claiming and failing it', async () => {
    const owner = await ownerOf({ workflow: KEYED, isMemberEnv: true });
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { exec } = await owner.open();
    void exec(newOpId());
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });
    expect(infos).toHaveBeenCalledWith(expect.stringContaining(`Left attempt ${owner.attempt} of run ${owner.run} for another member: its step requires env FLEET_DEPLOY_KEY, which has no value here:`));
  }, 60_000);

  it('leaves a whole workflow step one of whose steps requires env this member\'s workflows.allow.env does not allow, as the owner\'s negotiation judges each step, rather than claiming and failing it', async () => {
    const owner = await ownerOf({
      workflow: WHOLE, workflows: { pair: PAIR.replace('    command: echo written > "$MARK"', '    requires: { env: [DEPLOY_URL] }\n    command: echo written > "$MARK"') },
      files: { 'env/env.yaml': 'variables:\n  - key: DEPLOY_URL\n    value: https://deploy.example\n' }, inputs: { mark: 'made.txt' }, isWhole: true, isSandbox: true,
    });
    const { exec } = await owner.open();
    void exec(newOpId(), 'workflow');
    await owner.record();
    await readableReportsWorktree(owner.bob.config);
    owner.bob.config.workflows = { tools: {}, allow: { env: ['NPM_TOKEN'] } };
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { workflow: { kind: 'here' } } });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });
    expect(infos).toHaveBeenCalledWith(`Left attempt ${owner.attempt} of run ${owner.run} for another member: its step "write" requires env DEPLOY_URL, which workflows.allow.env on this machine does not allow.`);
  }, 60_000);

  it('leases a whole workflow step with a gate inside to a runtime that runs whole workflows', async () => {
    const whole = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });

    expect(await readRun(whole.alice.config, whole.run)).toMatchObject({ steps: [{ id: 'work', status: 'leased' }] });
  }, 60_000);

  it('leaves an attempt whose run\'s definitions this member does not find for another member, rather than claiming and failing it', async () => {
    // Alice runs a workflow she changed and did not push, so the run pins no team commit and Bob's copy differs.
    const owner = await ownerOf({ beforeStart: async (alice) => {
      const clone = alice.config.repo.localPath;
      fs.writeFileSync(path.join(clone, 'workflows', 'slow.yaml'), SLOW.replace('description: ', 'description: Changed here. '));
      git(clone, 'commit', '-qam', 'unpushed change');
      await pull(alice);
    } });
    const { exec } = await owner.open();
    void exec(newOpId());
    await owner.record();
    await readableReportsWorktree(owner.bob.config);
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' } } });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });
    expect(infos).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^Left attempt ${owner.attempt} of run ${owner.run} for another member: it finds no definition of the run here: `)));
  }, 60_000);

  it('leaves a whole workflow step one of whose steps requires a label this member does not declare for another member', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: PAIR.replace('    command: echo written > "$MARK"', '    requires: { labels: [gpu] }\n    command: echo written > "$MARK"') }, inputs: { mark: 'made.txt' }, isWhole: true, labels: ['gpu'] });
    const { exec } = await owner.open(undefined, { stale_after: '60s' });
    void exec(newOpId(), 'workflow');
    await owner.record();
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { workflow: { kind: 'here' } } });

    expect(taken).toEqual({ data: { idle: { offered: 0 } } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });
  }, 60_000);

  it('leases a whole workflow step whose gate step runs no tool to a runtime that runs no prompt', async () => {
    const whole = await ownerOf({ workflow: WHOLE, workflows: { pair: ASKED }, inputs: { mark: 'made.txt' }, isWhole: true, isPromptless: true });

    expect(await readRun(whole.alice.config, whole.run)).toMatchObject({ steps: [{ id: 'work', status: 'leased' }] });
  }, 60_000);

  it('asks the owner the gate a member\'s whole workflow reached, through the record, and goes on with the answer the owner\'s person gave', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const asked: ExecQuestion[] = [];
    const ended = exec(newOpId(), 'workflow', { ask: async (question) => {
      asked.push(question);
      expect(await owner.record()).toMatchObject({ state: 'asking', question: { step: 'keep', kind: 'approve', message: 'Keep made.txt?' } });

      return { choice: 'yes' };
    } });
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(asked).toEqual([{ step: 'keep', kind: 'approve', message: 'Keep made.txt?', options: ['yes', 'no'], required: false }]);
    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: JSON.stringify({ outcome: 'succeeded', outputs: { counted: 1 } }) });
    expect(fs.readFileSync(path.join(place, 'made.txt'), 'utf8')).toBe('written\n');
  }, 90_000);

  it('asks the owner\'s person again when their answer to a member\'s gate holds a secret in its note, which teamai-reports must not hold', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const answers = [{ choice: 'yes', note: 'deploy with ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }, { choice: 'yes' }];
    const asked: ExecQuestion[] = [];
    const ended = exec(newOpId(), 'workflow', { ask: async (question) => {
      asked.push(question);

      return answers.shift() ?? { refused: 'asked more than twice' };
    } });
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(asked.map(({ step }) => step)).toEqual(['keep', 'keep']);
    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: JSON.stringify({ outcome: 'succeeded', outputs: { counted: 1 } }) });
  }, 90_000);

  it('keeps the gate a member asks open to the owner\'s person while a read of the record fails, and puts it to the person once', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const clone = owner.alice.config.repo.localPath;
    const asked: ExecQuestion[] = [];
    const closedWhileAsked: boolean[] = [];
    const ended = exec(newOpId(), 'workflow', { ask: async (question, closed) => {
      asked.push(question);

      if (asked.length > 1) return { choice: 'yes' };
      // Alice's reads of teamai-reports fail while her person thinks: her wait reads the record about every second.
      git(clone, 'remote', 'set-url', 'origin', path.join(path.dirname(clone), 'gone.git'));
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      git(clone, 'remote', 'set-url', 'origin', owner.alice.config.repo.remote);
      closedWhileAsked.push(closed.aborted);

      return { choice: 'yes' };
    } });
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(closedWhileAsked).toEqual([false]);
    expect(asked).toHaveLength(1);
    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: JSON.stringify({ outcome: 'succeeded', outputs: { counted: 1 } }) });
  }, 90_000);

  it('writes the owner\'s answer at a later read when a write of teamai-reports fails, rather than failing the step while the member waits', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const origin = owner.alice.config.repo.remote;
    const refusing = path.join(path.dirname(origin), 'refuse-answer');
    const refused = path.join(path.dirname(origin), 'answer-refused');
    fs.writeFileSync(refusing, '');
    // teamai-reports refuses the push of the owner's answer while `refusing` is there.
    receiveHook(origin, `while read old new ref; do
  subject=$(git log -1 --format=%s "$new") || exit 1
  case "$subject" in *'Answer attempt'*) if [ -f ${JSON.stringify(refusing)} ]; then touch ${JSON.stringify(refused)}; echo busy >&2; exit 1; fi;; esac
done`);
    const { exec } = await owner.open(place);
    const ended = exec(newOpId(), 'workflow', { ask: async () => ({ choice: 'yes' }) });
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);
    // A while after the first refusal, teamai-reports takes the answer again.
    const reopened = eventually(async () => (fs.existsSync(refused) ? true : undefined), 60_000).then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      fs.rmSync(refusing);
    });

    const taken = takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(await ended).toEqual({ kind: 'exited', code: 0, stdout: JSON.stringify({ outcome: 'succeeded', outputs: { counted: 1 } }) });
    expect(await taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
    await reopened;
  }, 120_000);

  it('fails a member\'s whole workflow at its gate when nobody answers where the run is driven', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId(), 'workflow');
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 1 } } });
    const end = await ended;
    expect(end.kind === 'exited' && JSON.parse(end.stdout)).toMatchObject({ outcome: 'failed', failure: { code: 'hitl_required', message: expect.stringContaining('Step "keep" of the workflow step "work"') } });
  }, 90_000);

  it('cancels the nested run of a member\'s whole workflow whose gate the owner refused, so it no longer waits at that gate', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: GATED }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);
    const ended = exec(newOpId(), 'workflow');
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { ran: { exit_code: 1 } } });
    expect(await ended).toMatchObject({ kind: 'exited', code: 1 });
    expect(await runsOf(owner.bob.config)).toEqual([expect.objectContaining({ status: 'cancelled' })]);
  }, 90_000);

  it('stops a member\'s whole workflow that the owner cancelled before its nested run started, once the run appears, and runs none of its steps', async () => {
    const owner = await ownerOf({ workflow: WHOLE, workflows: { pair: PAIR }, inputs: { mark: 'made.txt' }, isWhole: true });
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    // Bob reads the record for a cancel every 4 s, a third of stale_after.
    const { runtime, exec } = await owner.open(place, { stale_after: '12s' });
    const op = newOpId();
    const ended = exec(op, 'workflow');
    await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
    await readableReportsWorktree(owner.bob.config);
    // Bob's nested run is slow to start: the copy of his team checkout's index it pins the run's team files with takes
    // 5 s to refresh (git asks the hook twice), past his first read of the record, which finds the owner's cancel.
    const hook = path.join(path.dirname(owner.bob.checkout), 'slow-pin');
    fs.writeFileSync(hook, '#!/bin/sh\ncase "$GIT_INDEX_FILE" in *teamai-team-pin-*) sleep 2.5;; esac\nexit 1\n', { mode: 0o755 });
    git(owner.bob.config.repo.localPath, 'config', 'core.fsmonitor', hook);
    void eventually(async () => ((await owner.record())?.state === 'claimed' ? true : undefined)).then(async () => runtime.cancel(op));

    const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

    expect(taken).toMatchObject({ data: { cancelled: { run: owner.run, attempt: owner.attempt } } });
    expect(await ended).toEqual({ kind: 'cancelled' });
    const [nested] = await runsOf(owner.bob.config);
    expect(nested).toMatchObject({ status: 'cancelled' });
    expect(nested?.steps.filter((step) => step.status === 'succeeded')).toEqual([]);
  }, 90_000);

  it('fails a member\'s whole workflow once its steps spent more than the workflow step\'s budget, as the owner would, and returns what they spent', async () => {
    const owner = await ownerOf({ workflow: BUDGETED, workflows: { reviews: REVIEWS }, tools: ['claude'], isWhole: true, isMeasured: true });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}' });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);

    try {
      const ended = exec(newOpId(), 'workflow');
      await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
      await readableReportsWorktree(owner.bob.config);

      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

      expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 1 } } });
      const end = await ended;
      expect(end.kind === 'exited' && JSON.parse(end.stdout)).toMatchObject({ outcome: 'failed', failure: { code: 'budget_exceeded' }, tokens: { input: expect.any(Number) } });
      expect(claude.calls()).toEqual([expect.objectContaining({ args: expect.arrayContaining([expect.stringContaining('Review the work first.')]) })]);
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 90_000);

  it('ends a member\'s whole workflow the owner cancelled with what its steps spent before it stopped, so the budgets around the step count it, also to a teamai that reattaches after a restart', async () => {
    const owner = await ownerOf({ workflow: RUN_BUDGETED.replace('budget: { tokens: 1 }', 'budget: { tokens: 1000000 }'), workflows: { reviews: REVIEW_HOLD }, tools: ['claude'], isWhole: true, isMeasured: true });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}' });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    // Bob reads the record for a cancel every 4 s, a third of stale_after.
    const { runtime, handle, exec } = await owner.open(place, { stale_after: '12s' });
    const op = newOpId();

    try {
      const ended = exec(op, 'workflow');
      await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
      await readableReportsWorktree(owner.bob.config);
      const reviewed = async () => ((await runsOf(owner.bob.config))[0]?.steps.some((step) => step.id === 'first' && step.status === 'succeeded') ? true : undefined);
      void eventually(reviewed, 60_000).then(async () => runtime.cancel(op));

      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

      expect(taken).toMatchObject({ data: { cancelled: { run: owner.run, attempt: owner.attempt } } });
      const end = await ended;
      expect(end.kind).toBe('cancelled');
      expect(end.kind === 'cancelled' && JSON.parse(end.stdout ?? '{}')).toMatchObject({ tokens: { input: expect.any(Number), output: expect.any(Number) } });
      expect(await owner.record()).toMatchObject({ state: 'cancelled', tokens: { input: expect.any(Number) } });
      // A teamai that restarted reads the end from the record as the live one gave it.
      const restarted = fleetStepRuntime({ config: owner.alice.config, masks: {} });
      fleetRuntimes.push(restarted);
      expect(await restarted.init({ homeEnv: homeEnvOf([]), options: { stale_after: '12s' }, mode: 'unattended', checkout: owner.alice.checkout })).toMatchObject({ ok: true });
      expect(await restarted.reattach(handle)).toMatchObject({ kind: 'alive', ops: [{ op, state: 'cancelled', stdout: end.kind === 'cancelled' ? end.stdout : '' }] });
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 120_000);

  it.each([
    ['the budget of the run around it', RUN_BUDGETED, undefined],
    ['the budget of its for_each step, which covers all its items', ITEMS_BUDGETED, { items: ['one'] }],
  ])('stops a member\'s whole workflow once its steps spent more than %s, as the owner would between them', async (_budget, workflow, inputs) => {
    const owner = await ownerOf({ workflow, workflows: { reviews: REVIEWS }, tools: ['claude'], isWhole: true, isMeasured: true, ...(inputs && { inputs }) });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}' });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { exec } = await owner.open(place);

    try {
      const ended = exec(newOpId(), 'workflow');
      await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
      await readableReportsWorktree(owner.bob.config);

      await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

      const end = await ended;
      expect(end.kind === 'exited' && JSON.parse(end.stdout)).toMatchObject({ outcome: 'failed', failure: { code: 'budget_exceeded' } });
      expect(claude.calls()).toEqual([expect.objectContaining({ args: expect.arrayContaining([expect.stringContaining('Review the work first.')]) })]);
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 90_000);

  it('offers a prompt step, which a member runs on its own tool from its own copy of the step, then ends with the result its agent wrote', async () => {
    const owner = await ownerOf({ workflow: PROMPTED, tools: ['claude'] });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}' });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { prompt } = await owner.open(place);

    try {
      const ended = prompt(newOpId());
      expect(await owner.record()).toMatchObject({ state: 'offered', lease: { step: 'work', prompt: 'Review the work.' } });
      await readableReportsWorktree(owner.bob.config);

      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' } } });

      expect(taken).toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
      // The session Claude ran on Bob's machine, by the id Claude gave it, not the attempt's.
      expect(await ended).toEqual({ kind: 'finished', session: { tool: 'claude', id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/) }, result: { output: { ok: true } }, usage: expect.any(Object) });
      expect(claude.calls()).toEqual([expect.objectContaining({ args: expect.arrayContaining([expect.stringContaining('Review the work.')]) })]);
      expect(JSON.stringify(claude.calls())).not.toContain('A prompt this host rendered.');
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 60_000);

  it('ends a prompt step usage_limited, with what the member\'s tool said, when the member\'s tool stops on its usage limit', async () => {
    const owner = await ownerOf({ workflow: PROMPTED, tools: ['claude'] });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}', before: `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm (Europe/Madrid)" }) + '\\n'); process.exit(1);` });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    const { prompt } = await owner.open(place);

    try {
      const ended = prompt(newOpId());
      await owner.record();
      await readableReportsWorktree(owner.bob.config);

      await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' } } });

      expect(await ended).toMatchObject({ kind: 'finished', session: { tool: 'claude' }, result: { failure: { code: 'usage_limited', message: expect.stringContaining('claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)') } } });
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 60_000);

  it('leaves a whole workflow step one of whose prompt steps runs on a tool this member does not have, rather than claiming and failing it', async () => {
    const owner = await ownerOf({ workflow: REVIEWED, workflows: { reviews: REVIEWS }, tools: ['claude'], isWhole: true });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // Only the system's own programs, so no claude this machine has installed is found.
    vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(path.delimiter));
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { exec } = await owner.open();

    try {
      void exec(newOpId(), 'workflow');
      await eventually(async () => ((await owner.record())?.state === 'offered' ? true : undefined));
      await readableReportsWorktree(owner.bob.config);

      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' }, workflow: { kind: 'here' } } });

      expect(taken).toEqual({ data: { idle: { offered: 0 } } });
      expect(await owner.record()).toMatchObject({ state: 'offered' });
      expect(infos).toHaveBeenCalledWith(`Left attempt ${owner.attempt} of run ${owner.run} for another member: its step "first" runs on claude, which is not on PATH here.`);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('leaves a prompt attempt whose tool this member does not have for another member, saying why', async () => {
    const owner = await ownerOf({ workflow: PROMPTED, tools: ['claude'] });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    // Only the system's own programs, so no claude this machine has installed is found.
    vi.stubEnv('PATH', [bin, '/usr/bin', '/bin'].join(path.delimiter));
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    const infos = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { prompt } = await owner.open();

    try {
      void prompt(newOpId());
      await owner.record();
      await readableReportsWorktree(owner.bob.config);

      const taken = await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' } } });

      expect(taken).toEqual({ data: { idle: { offered: 0 } } });
      expect(await owner.record()).toMatchObject({ state: 'offered' });
      expect(infos).toHaveBeenCalledWith(`Left attempt ${owner.attempt} of run ${owner.run} for another member: its prompt step runs on claude, which is not on PATH here.`);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it('offers the step\'s command, and leaves the attempt out for a later resume when its teamai stops', async () => {
    const owner = await ownerOf();
    const { runtime, exec } = await owner.open();
    const op = newOpId();
    const ended = exec(op);

    expect(await owner.record()).toMatchObject({ state: 'offered', lease: { step: 'work', command: 'echo begun > begun.txt; sleep 60' } });
    await runtime.dispose();
    expect(await ended).toMatchObject({ kind: 'failed', failure: { code: 'runtime_interrupted' } });
    expect(await owner.record()).toMatchObject({ state: 'offered' });
  });

  it('withdraws the attempt when the run cancels the step, and ends cancelled', async () => {
    const owner = await ownerOf();
    const { runtime, exec } = await owner.open();
    const op = newOpId();
    const ended = exec(op);
    await owner.record();

    await runtime.cancel(op);

    expect(await ended).toEqual({ kind: 'cancelled' });
    expect(await owner.record()).toMatchObject({ state: 'withdrawn' });
  });

  it('withdraws the attempt once teamai-reports frees when the run cancels the step while another write holds it, rather than leaving the offer out', async () => {
    const owner = await ownerOf();
    const { runtime, exec } = await owner.open();
    const op = newOpId();
    const ended = exec(op);
    await owner.record();
    // Another teamai process of this install writing teamai-reports, as a cancel's own publish does. The offer's own
    // publish may still hold the lock after its record can be read, until its push ends.
    const lock = path.join(path.dirname(getWorktreeDir(owner.alice.config, REPORTS_WORKTREE_DIRNAME)), REPORTS_LOCK_FILENAME);
    await eventually(async () => (await acquireLock(lock)) || undefined);

    const cancelled = runtime.cancel(op);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await releaseLock(lock);
    await cancelled;

    expect(await ended).toEqual({ kind: 'cancelled' });
    expect(await owner.record()).toMatchObject({ state: 'withdrawn' });
  }, 60_000);

  it('withdraws the attempt once teamai-reports can be read again when the run cancels the step while it cannot, rather than leaving the offer out', async () => {
    const owner = await ownerOf();
    const { runtime, exec } = await owner.open();
    const op = newOpId();
    const ended = exec(op);
    await owner.record();
    const clone = owner.alice.config.repo.localPath;
    git(clone, 'remote', 'set-url', 'origin', path.join(path.dirname(clone), 'gone.git'));

    const cancelled = runtime.cancel(op);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    git(clone, 'remote', 'set-url', 'origin', owner.alice.config.repo.remote);
    await cancelled;

    expect(await ended).toEqual({ kind: 'cancelled' });
    expect(await owner.record()).toMatchObject({ state: 'withdrawn' });
  }, 60_000);

  it('runs any other exec of the place, such as setup, on this host', async () => {
    const owner = await ownerOf();
    const { runtime, handle } = await owner.open();

    expect(await runtime.exec({ op: newOpId(), handle, argv: shellArgv('echo set up'), env: {}, unset: [], credentials: {}, cwd: owner.alice.checkout }, {}, 'setup'))
      .toEqual({ kind: 'exited', code: 0, stdout: 'set up\n' });
    expect(await readAttemptRecord(owner.alice.config, owner.run, owner.attempt)).toEqual({ ok: true, value: 'absent' });
  });

  it('records the process group of a setup it runs on this host, so the stop of what a killed teamai left reaches it', async () => {
    const owner = await ownerOf();
    const { runtime, handle } = await owner.open();
    const op = newOpId();
    const ended = runtime.exec({ op, handle, argv: shellArgv('sleep 60'), env: {}, unset: [], credentials: {}, cwd: owner.alice.checkout }, {}, 'setup');

    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // What a resume and a workflow cancel run for an attempt a killed teamai of this install left.
      await stopLeftInProcess(owner.alice.config, owner.run, owner.attempt);

      expect(await Promise.race([ended.then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000))])).toBe('stopped');
    } finally {
      await runtime.cancel(op);
    }
  }, 30_000);

  it('runs a setup on this host and offers nothing, even when it is the same text as the step\'s command', async () => {
    const owner = await ownerOf({ workflow: SLOW.replace(SLOW_COMMAND, 'echo set up'), command: 'echo set up' });
    const { runtime, handle } = await owner.open();

    expect(await runtime.exec({ op: newOpId(), handle, argv: shellArgv('echo set up'), env: {}, unset: [], credentials: {}, cwd: owner.alice.checkout }, {}, 'setup'))
      .toEqual({ kind: 'exited', code: 0, stdout: 'set up\n' });
    expect(await readAttemptRecord(owner.alice.config, owner.run, owner.attempt)).toEqual({ ok: true, value: 'absent' });
  }, 15_000);

  it('takes into the place the work a member finished while the owner\'s teamai was down, once a restarted teamai resumes the prompt', async () => {
    const owner = await ownerOf({ workflow: PROMPTED, tools: ['claude'] });
    const bin = path.join(path.dirname(owner.bob.checkout), 'bin');
    const claude = fakeAgent(claudeFake, { bin, answer: '{"ok":true}', before: 'fs.writeFileSync(\'made.txt\', \'made\\n\');' });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('HOME', path.join(path.dirname(owner.bob.checkout), 'bob-home'));
    owner.bob.config.workflows = { tools: { default: 'claude' } };
    const place = path.join(path.dirname(owner.alice.checkout), 'alice-place');
    git(owner.alice.checkout, 'worktree', 'add', '-q', '--detach', place, 'HEAD');
    /** An attempt of Alice's run as one teamai process of hers drives it on a fleet runtime of its own. */
    const driven = async () => {
      const runtime = fleetStepRuntime({ config: owner.alice.config, masks: {} });
      fleetRuntimes.push(runtime);
      expect(await runtime.init({ homeEnv: homeEnvOf([]), options: { stale_after: '60s' }, mode: 'unattended', checkout: owner.alice.checkout })).toMatchObject({ ok: true });
      const attempt = attemptRun({ config: owner.alice.config, run: owner.run, attempt: owner.attempt, runtime, driver: 'fleet' });
      expect(await attempt.open(undefined)).toMatchObject({ ok: true });
      const prompt = async () => attempt.prompt({
        env: {}, unset: [], credentials: {}, cwd: place,
        lease: { step: 'work', tool: 'claude', prompt: 'A prompt this host rendered.', result: path.join(place, 'result.json'), permissions: 'unattended', interactive: false },
      }, {});

      return { runtime, prompt, stopLeft: async () => attempt.stopLeftOperation() };
    };

    try {
      const first = await driven();
      const left = first.prompt();
      expect(await owner.record()).toMatchObject({ state: 'offered' });
      // The owner's teamai stops while the prompt is out on the pool.
      await first.runtime.dispose();
      await left;
      await readableReportsWorktree(owner.bob.config);
      expect(await takeFleetAttempt(owner.bob.config, { pool: 'default', repository: getRepoIdentity(owner.bob.checkout) ?? '', root: owner.bob.checkout, member: await installOwner(owner.bob.config), secrets: {}, place: { command: { kind: 'here' }, prompt: { kind: 'here' } } }))
        .toMatchObject({ data: { ran: { run: owner.run, attempt: owner.attempt, exit_code: 0 } } });
      expect(await owner.record()).toMatchObject({ state: 'finished' });
      // A workflow cancel with no live driver finds nothing of the step running, whatever work is left to take.
      expect(await (await driven()).stopLeft()).toBeUndefined();

      const resumed = await (await driven()).prompt();

      expect(resumed).toMatchObject({ kind: 'finished', session: { tool: 'claude' }, result: { output: { ok: true } } });
      expect(fs.readFileSync(path.join(place, 'made.txt'), 'utf8')).toBe('made\n');
    } finally {
      vi.unstubAllEnvs();
      expect(await claude.stopLeft(), 'fake agents left running').toEqual([]);
    }
  }, 90_000);

  it('reconnects a restarted teamai to the exec it left by the same id, and a cancel with no wait reaches the record', async () => {
    const owner = await ownerOf();
    const first = await owner.open();
    const op = newOpId();
    const left = first.exec(op);
    await owner.record();
    await first.runtime.dispose();
    await left;

    const second = await owner.open();
    expect(await second.runtime.reattach(second.handle)).toEqual({ kind: 'alive', ops: [{ op, state: 'running' }] });
    const reconnected = second.exec(op);
    await second.runtime.cancel(op);

    expect(await reconnected).toEqual({ kind: 'cancelled' });

    // A teamai with no wait of its own, as workflow cancel with no live driver, reads the record.
    const third = await owner.open();
    expect(await third.runtime.reattach(third.handle)).toEqual({ kind: 'alive', ops: [{ op, state: 'cancelled' }] });
  });

  it('offers an attempt a teamai killed before its offer to the pool and stale_after it was going to, whatever fleet entry reached it now', async () => {
    const owner = await ownerOf();
    const op = newOpId();
    // What a teamai killed between noting the offer and writing it left.
    await markOffered(owner.alice.config, owner.run, owner.attempt, 'gpu', { op, staleAfterMs: 120_000 });
    const second = await owner.open(owner.alice.checkout, { pool: 'default', stale_after: '1s' });

    const reconnected = second.exec(op);

    expect(await owner.record()).toMatchObject({ state: 'offered', pool: 'gpu', staleAfterMs: 120_000 });
    await second.runtime.dispose();
    await reconnected;
  });

  it('waits on a reconnected attempt for as long as its offer allows, whatever fleet entry the restarted teamai reached it through', async () => {
    const owner = await ownerOf();
    const first = await owner.open();
    const op = newOpId();
    const left = first.exec(op);
    const offered = await owner.record();
    if (offered.state !== 'offered') throw new Error(`not offered: ${offered.state}`);
    expect(await claimAttempt(owner.bob.config, offered, await installOwner(owner.bob.config))).toMatchObject({ ok: true });
    await first.runtime.dispose();
    await left;

    const second = await owner.open(owner.alice.checkout, { pool: 'gpu', stale_after: '1s' });
    await second.runtime.reattach(second.handle);
    const reconnected = second.exec(op);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await second.runtime.dispose();

    expect(await reconnected).toMatchObject({ kind: 'failed', failure: { code: 'runtime_interrupted' } });
    expect(await owner.record()).toMatchObject({ state: 'claimed', pool: 'default', staleAfterMs: 60_000 });
  }, 30_000);
});


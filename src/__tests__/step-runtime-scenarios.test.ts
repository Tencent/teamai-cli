import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localStepRuntime } from '../workflow/runtimes/local.js';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';
import { newOpId, type ExecEnd, type ExecRequest, type OpenRequest, type RuntimeOptions, type StepRuntime } from '../workflow/runtimes/step-runtime.js';
import { TOY_RUNTIME } from './helpers/toy-runtime.js';

/**
 * One scenario suite every step runtime passes, through the `StepRuntime` interface alone. `retains` says whether the
 * runtime keeps outcomes across a restart of its own process, which `local`, in teamai's process, cannot.
 */
interface Subject {
  name: string;
  /** A runtime over `state`, which a restarted runtime of the same subject reads again. */
  start(state: string): StepRuntime;
  options(state: string): RuntimeOptions;
  retains: boolean;
}

const SUBJECTS: Subject[] = [
  {
    name: 'toy over stdio',
    start: () => stdioStepRuntime({ name: 'toy', command: process.execPath, args: [TOY_RUNTIME] }),
    options: (state) => ({ state }),
    retains: true,
  },
  { name: 'local', start: () => localStepRuntime(), options: () => ({}), retains: false },
];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return check();
}

describe.each(SUBJECTS)('StepRuntime scenarios: $name', (subject) => {
  let dir: string;
  let worktree: string;
  let state: string;
  const started: StepRuntime[] = [];

  const start = async (): Promise<StepRuntime> => {
    const runtime = subject.start(state);
    started.push(runtime);
    const ready = await runtime.init({ options: subject.options(state), mode: 'unattended' });
    expect(ready).toMatchObject({ ok: true });

    return runtime;
  };

  const openRequest = (op = newOpId()): OpenRequest => ({
    op, run: 'r0123abcd', attempt: 'a0123abcd', credentials: {},
    view: { worktree, readonly: [], result: path.join(dir, 'out'), toolHome: {} },
  });

  const execRequest = (handle: string, argv: string[], op = newOpId()): ExecRequest => ({ op, handle, argv, env: { STEP_VALUE: 'from-teamai' }, unset: [], cwd: worktree });

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

    expect(await runtime.init({ options: { ...subject.options(state), imgae: 'x' }, mode: 'unattended' }))
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
    });

    expect(accepted).toBe(true);
    expect(end).toEqual({ kind: 'exited', code: 3, stdout: 'from-teamai\n' });
    expect(output.join('')).toBe('from-teamai\n');
  });

  it('keeps names the exec unsets out of its process', async () => {
    // Set before the runtime starts, so a runtime in a process of its own inherits the name it has to remove.
    process.env.TEAMAI_SCENARIO_WITHHELD = 'secret';

    try {
      const runtime = await start();
      const opened = await runtime.open(openRequest(), async () => {});
      if (opened.kind !== 'ready') throw new Error('not opened');
      const end = await runtime.exec({ ...execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write(String(process.env.TEAMAI_SCENARIO_WITHHELD))']), unset: ['TEAMAI_SCENARIO_WITHHELD'] }, {});

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
    const first = await runtime.exec(request, {});

    expect(await runtime.exec(request, {})).toEqual(first);
    expect(fs.readFileSync(path.join(worktree, 'runs'), 'utf8')).toBe('x');
  });

  it('answers an exec id repeated while it runs with the same acceptance and outcome, running it once', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'require("fs").appendFileSync("runs", "x"); setTimeout(() => process.stdout.write("once"), 300)']);
    let accepted = 0;
    const events = { onAccepted: () => { accepted += 1; } };
    const first = runtime.exec(request, events);
    expect(await until(() => fs.existsSync(path.join(worktree, 'runs')))).toBe(true);
    const repeated = runtime.exec(request, events);

    expect(await Promise.all([first, repeated])).toEqual([{ kind: 'exited', code: 0, stdout: 'once' }, { kind: 'exited', code: 0, stdout: 'once' }]);
    expect(accepted).toBe(2);
    expect(fs.readFileSync(path.join(worktree, 'runs'), 'utf8')).toBe('x');
  });

  it('collects a failed exec and leaves its work in the place', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const end = await runtime.exec(execRequest(opened.handle, [process.execPath, '-e', 'require("fs").writeFileSync("work.txt", "kept"); process.exit(1)']), {});

    expect(end).toMatchObject({ kind: 'exited', code: 1 });
    expect(await runtime.collect(opened.handle)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(worktree, 'work.txt'), 'utf8')).toBe('kept');
  });

  it('cancels a running exec with the processes it started', async () => {
    const runtime = await start();
    const opened = await runtime.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'sleep 30 & echo $! > child.pid; wait']);
    const ending = runtime.exec(request, {});
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
    await runtime.close(opened.handle);
    expect(await runtime.reattach(opened.handle)).toEqual({ kind: 'gone' });
  });

  it.runIf(subject.retains)('reattaches after its own restart with a finished exec and its complete stdout', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, [process.execPath, '-e', 'process.stdout.write("retained")']);
    await first.exec(request, {});
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual({ kind: 'alive', ops: [{ op: request.op, state: 'exited', code: 0, stdout: 'retained' }] });
    expect(await second.exec(request, {})).toEqual({ kind: 'exited', code: 0, stdout: 'retained' });
  });

  it.runIf(subject.retains)('finishes an exec its own restart left running, so reattach reads it running, and cancel stops it', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo $$ > shell.pid; sleep 30']);
    void first.exec(request, {});
    const pidFile = path.join(worktree, 'shell.pid');
    expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const shell = Number(fs.readFileSync(pidFile, 'utf8').trim());
    await first.dispose();
    const second = await start();

    expect(await second.reattach(opened.handle)).toEqual({ kind: 'alive', ops: [{ op: request.op, state: 'running' }] });
    await second.cancel(request.op);
    expect(await until(() => !pidAlive(shell))).toBe(true);
    expect(await second.reattach(opened.handle)).toEqual({ kind: 'alive', ops: [{ op: request.op, state: 'cancelled' }] });
  });

  it.runIf(subject.retains)('does not run again an exec id its own restart left running, and ends it when cancelled', async () => {
    const first = await start();
    const opened = await first.open(openRequest(), async () => {});
    if (opened.kind !== 'ready') throw new Error('not opened');
    const request = execRequest(opened.handle, ['/bin/sh', '-c', 'echo x >> runs; sleep 30']);
    void first.exec(request, {});
    const runs = path.join(worktree, 'runs');
    expect(await until(() => fs.existsSync(runs))).toBe(true);
    await first.dispose();
    const second = await start();
    let accepted = false;
    const ending = second.exec(request, { onAccepted: () => { accepted = true; } });
    expect(await until(() => accepted)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fs.readFileSync(runs, 'utf8')).toBe('x\n');
    await second.cancel(request.op);
    expect(await ending).toEqual<ExecEnd>({ kind: 'cancelled' });
  });
});

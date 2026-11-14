import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { attemptRun, attemptSessionStore, attemptToolHome, readAttemptPlacement, seedToolHome, type AttemptRuntimeRecord } from '../workflow/runtimes/attempt.js';
import { endLogin, ensureLogin, holdLogin, holdLoginFrom, loginHolder, loginLockFile } from '../workflow/runtimes/login.js';
import { OpIdSchema, type RuntimeDisplay } from '@teamai/runtime-protocol';
import { newOpId, type ExecEnd, type PromptEnd, type Reattached, type StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { DriverCan } from '../workflow/requirements.js';
import { attemptDir, AttemptIdSchema, RunIdSchema } from '../workflow/store.js';
import { useToolInstances } from '../tool-registry.js';

const RUN = RunIdSchema.parse('r0123abcd');
const FIRST = AttemptIdSchema.parse('a00000001');
const SECOND = AttemptIdSchema.parse('a00000002');

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-login-'));
  vi.stubEnv('HOME', root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = (refresh: string): string => JSON.stringify({ tokens: { account_id: 'acct-1', refresh_token: refresh } });
const dedicated = (): string => path.join(root, '.teamai', 'logins', 'codex', 'auth.json');

const plantDedicated = (refresh: string): void => {
  fs.mkdirSync(path.dirname(dedicated()), { recursive: true });
  fs.writeFileSync(dedicated(), auth(refresh), { mode: 0o600 });
};

const hold = (attempt: typeof FIRST, signal: AbortSignal) => holdLogin({
  tool: 'codex', run: RUN, attempt, toolHome: path.join(root, attempt), signal, onWait: async () => {},
});

describe('the dedicated Codex login lock', () => {
  it('lets one of two attempts that ask in the same millisecond hold the login, and the other wait', async () => {
    plantDedicated('r1');
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

    const asked = await Promise.all([FIRST, SECOND].map(async (attempt) => ({ attempt, held: await hold(attempt, AbortSignal.timeout(1500)) })));

    const holders = asked.filter(({ held }) => held.ok);
    expect(holders).toHaveLength(1);
    expect(asked.find(({ held }) => !held.ok)?.held).toMatchObject({ ok: false, failure: { code: 'login_held' } });
    expect(await loginHolder('codex')).toMatchObject({ run: RUN, attempt: holders[0]?.attempt });
  });

  it('leaves the lock another attempt took meanwhile when two ends of one attempt race, each having read it as that attempt\'s', async () => {
    plantDedicated('r1');
    const toolHome = path.join(root, FIRST);
    expect(await hold(FIRST, new AbortController().signal)).toEqual({ ok: true });
    const lock = loginLockFile('codex');
    const remove = fsp.rm.bind(fsp);
    let secondRemoves = (): void => {};
    const bothRead = new Promise<void>((resolve) => { secondRemoves = resolve; });
    let secondHolds = (): void => {};
    const taken = new Promise<void>((resolve) => { secondHolds = resolve; });
    let removals = 0;
    let second: ReturnType<typeof hold> | undefined;
    // The first end removes the lock once the second read it too, or after half a second; attempt SECOND then takes the
    // free lock, and only then does the second end remove what it read. SECOND records its copy once the first end is done.
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (target !== lock) return remove(target, options);
      removals += 1;

      if (removals > 1) {
        secondRemoves();
        await taken;

        return remove(target, options);
      }

      await Promise.race([bothRead, new Promise((resolve) => setTimeout(resolve, 500))]);
      await remove(target, options);
      second = hold(SECOND, new AbortController().signal);
      while ((await loginHolder('codex'))?.attempt !== SECOND) await new Promise((resolve) => setTimeout(resolve, 10));
      secondHolds();
    });

    await Promise.all([FIRST, FIRST].map((attempt) => endLogin('codex', { run: RUN, attempt, toolHome, isCollected: true })));

    expect({ second: await second, holder: await loginHolder('codex') }).toMatchObject({ second: { ok: true }, holder: { run: RUN, attempt: SECOND } });
  });

  it('never replaces the lock another attempt took after an end of the holding attempt freed it, while that attempt copied the login', async () => {
    plantDedicated('r1');
    const lock = loginLockFile('codex');
    const link = fsp.link.bind(fsp);
    let raced = false;
    // Once attempt FIRST took the lock, and before it records the copy it makes, a second end of FIRST frees the lock and
    // attempt SECOND takes it.
    vi.spyOn(fsp, 'link').mockImplementation(async (existing, target) => {
      await link(existing, target);

      if (target !== lock || raced) return;
      raced = true;
      await endLogin('codex', { run: RUN, attempt: FIRST, toolHome: path.join(root, FIRST), isCollected: true });
      expect(await hold(SECOND, new AbortController().signal)).toEqual({ ok: true });
    });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 1000);

    const first = await hold(FIRST, stop.signal);

    expect({ first, holder: await loginHolder('codex') }).toMatchObject({ first: { ok: false, failure: { code: 'login_held' } }, holder: { run: RUN, attempt: SECOND } });
  });

  it('takes a login already written back, by a driver killed before it released the lock, as written back', async () => {
    plantDedicated('r1');
    const toolHome = path.join(root, FIRST);
    expect(await hold(FIRST, new AbortController().signal)).toEqual({ ok: true });
    fs.writeFileSync(path.join(toolHome, 'auth.json'), auth('r2'));
    fs.writeFileSync(dedicated(), auth('r2'));

    const ended = await endLogin('codex', { run: RUN, attempt: FIRST, toolHome, isCollected: true });

    expect(ended).toEqual({ wasHeld: true });
    expect(createHash('sha256').update(fs.readFileSync(dedicated())).digest('hex')).toBe(createHash('sha256').update(auth('r2')).digest('hex'));
  });

  it('keeps the token the tool refreshed when a restarted teamai holds the login again for the same attempt', async () => {
    plantDedicated('r1');
    const toolHome = path.join(root, FIRST);
    expect(await hold(FIRST, new AbortController().signal)).toEqual({ ok: true });
    fs.writeFileSync(path.join(toolHome, 'auth.json'), auth('r2'));

    expect(await hold(FIRST, new AbortController().signal)).toEqual({ ok: true });

    expect(fs.readFileSync(path.join(toolHome, 'auth.json'), 'utf8')).toBe(auth('r2'));
  });

  it('writes back the token a judge\'s Codex refreshed when the judge releases the login, then frees it', async () => {
    const daily = path.join(root, '.codex');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, 'auth.json'), auth('r1'), { mode: 0o600 });
    const toolHome = path.join(root, 'judge');
    const held = await holdLoginFrom({ tool: 'codex', executable: 'codex', from: daily, toolHome, run: RUN, attempt: FIRST, signal: new AbortController().signal });
    fs.writeFileSync(path.join(toolHome, 'auth.json'), auth('r2'));

    const kept = held.ok ? await held.release() : held.failure;

    expect({ kept, daily: fs.readFileSync(path.join(daily, 'auth.json'), 'utf8'), holder: await loginHolder('codex') }).toEqual({ kept: undefined, daily: auth('r2'), holder: undefined });
  });

  it('writes back the token a killed judge refreshed in a temporary home before a judge restarted on the same attempt copies the login into its own', async () => {
    const daily = path.join(root, '.codex');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, 'auth.json'), auth('r1'), { mode: 0o600 });
    const killed = path.join(root, 'teamai-confined-killed', 'codex');
    const restarted = path.join(root, 'teamai-confined-restarted', 'codex');
    expect((await holdLoginFrom({ tool: 'codex', executable: 'codex', from: daily, toolHome: killed, run: RUN, attempt: FIRST, signal: new AbortController().signal })).ok).toBe(true);
    fs.writeFileSync(path.join(killed, 'auth.json'), auth('r2'));

    const held = await holdLoginFrom({ tool: 'codex', executable: 'codex', from: daily, toolHome: restarted, run: RUN, attempt: FIRST, signal: new AbortController().signal });

    expect({ ok: held.ok, daily: fs.readFileSync(path.join(daily, 'auth.json'), 'utf8'), restarted: fs.readFileSync(path.join(restarted, 'auth.json'), 'utf8') })
      .toEqual({ ok: true, daily: auth('r2'), restarted: auth('r2') });
  });

  it('copies the login again into the fresh home of a run in this process whose attempt already holds the lock, as after a restart', async () => {
    const daily = path.join(root, '.codex');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, 'auth.json'), auth('r1'));
    fs.mkdirSync(path.dirname(loginLockFile('codex')), { recursive: true });
    fs.writeFileSync(loginLockFile('codex'), JSON.stringify({ run: RUN, attempt: FIRST, takenAt: new Date().toISOString(), copied: createHash('sha256').update(auth('r1')).digest('hex') }));
    const toolHome = path.join(root, 'fresh');

    const held = await holdLoginFrom({ tool: 'codex', executable: 'codex', from: daily, toolHome, run: RUN, attempt: FIRST, signal: new AbortController().signal });

    expect({ ok: held.ok, login: fs.existsSync(path.join(toolHome, 'auth.json')) ? fs.readFileSync(path.join(toolHome, 'auth.json'), 'utf8') : undefined }).toEqual({ ok: true, login: auth('r1') });
  });

  it('names the executable that ran in the login command it gives when it cannot write a login back to the home it came from', async () => {
    const daily = path.join(root, '.tcodex');
    fs.mkdirSync(daily, { recursive: true });
    fs.writeFileSync(path.join(daily, 'auth.json'), auth('r1'));
    const toolHome = path.join(root, 'fresh');
    const held = await holdLoginFrom({ tool: 'codex', executable: 'tcodex', from: daily, toolHome, run: RUN, attempt: FIRST, signal: new AbortController().signal });
    fs.writeFileSync(path.join(toolHome, 'auth.json'), auth('r2'));
    // The member signed in again meanwhile.
    fs.writeFileSync(path.join(daily, 'auth.json'), auth('r9'));

    expect(held.ok ? await held.release() : held).toMatchObject({ code: 'login_not_written_back', message: expect.stringContaining(`log in again with CODEX_HOME=${daily} tcodex login,`) });
  });
});

describe('an attempt a killed teamai left running on its step runtime', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  /** How many prompts the runtime of `runtimeSeeing` was sent. */
  let prompts = 0;

  /**
   * A runtime whose exec and prompt never end, and whose reattach answers `seen` in turn, then the last of them.
   * `received` settles once it was sent its exec or prompt: teamai records the operation before it sends it.
   */
  const runtimeSeeing = (seen: Array<(op: string) => Reattached>): StepRuntime<DriverCan> & { received: Promise<void> } => {
    let asked = 0;
    let op = '';
    let receive = (): void => {};
    const received = new Promise<void>((resolve) => { receive = resolve; });
    prompts = 0;

    return {
      received,
      name: 'fake',
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (_request, onAccepted) => {
        await onAccepted('h1');

        return { kind: 'ready', handle: 'h1' };
      },
      exec: (request) => {
        op = request.op;
        receive();

        return new Promise<ExecEnd>(() => {});
      },
      prompt: (request) => {
        op = request.op;
        prompts += 1;
        receive();

        return new Promise<PromptEnd>(() => {});
      },
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => (seen[Math.min(asked++, seen.length - 1)] ?? (() => ({ kind: 'gone' })))(op),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
  };

  /** Opens the attempt and sends its exec on `runtime`, as the teamai that was killed did. */
  const leftRunning = async (runtime: ReturnType<typeof runtimeSeeing>): Promise<void> => {
    const before = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await before.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    void before.exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {}, 'command');
    await runtime.received;
  };

  /** Opens the attempt and sends its prompt on `runtime`, as the teamai that was killed did. */
  const promptLeftRunning = async (runtime: ReturnType<typeof runtimeSeeing>): Promise<void> => {
    const before = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await before.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    void resumePrompt(runtime);
    await runtime.received;
  };

  const running = (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'running' }] });
  const unreachable = (): Reattached => ({ kind: 'failed', failure: { code: 'runtime_exited', message: 'gone away' } });
  const ended = (failure: { code: string; message: string }) => (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'failed', failure }] });
  const cancelled = (op: string): Reattached => ({ kind: 'alive', ops: [{ op: OpIdSchema.parse(op), state: 'cancelled' }] });
  const cannotStop = { code: 'cancel_failed', message: 'The provider is down. Start it, then run teamai workflow cancel again.' };

  it('takes an operation an alive reattach no longer lists as ended: it sends no cancel and still closes the place', async () => {
    const omits = (): Reattached => ({ kind: 'alive', ops: [] });
    const cancels: string[] = [];
    const closes: string[] = [];
    const runtime = { ...runtimeSeeing([omits]), cancel: async (op) => { cancels.push(op); }, close: async (handle) => { closes.push(handle); return { ok: true }; } } satisfies StepRuntime<DriverCan>;
    await leftRunning(runtime);
    const placed = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });

    expect(await placed.stopLeftOperation()).toBeUndefined();
    expect(await placed.close()).toBeUndefined();
    expect({ cancels, closes }).toEqual({ cancels: [], closes: ['h1'] });
    expect(await readAttemptPlacement(config(), RUN, FIRST)).toMatchObject({ kind: 'external', record: { phase: 'closed' } });
  });

  it('takes an operation that failed with any code but cancel_failed after the cancel as ended, as the next cancel does', async () => {
    const runtime = runtimeSeeing([running, ended({ code: 'tool_failed', message: 'codex exited with status 1' })]);
    await leftRunning(runtime);

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation()).toBeUndefined();
  });

  const resumePrompt = (runtime: StepRuntime<DriverCan>) => attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).prompt({
    lease: { step: 'review', tool: 'codex', prompt: 'p', result: path.join(root, 'out', 'result.json'), permissions: 'unattended', interactive: false }, env: {}, unset: [], credentials: {}, cwd: root,
  }, {});

  const displayed = async (): Promise<RuntimeDisplay | undefined> => {
    const placement = await readAttemptPlacement(config(), RUN, FIRST);

    return placement.kind === 'external' ? placement.record.display : undefined;
  };

  it('keeps the limit a prompt that finished before the restart was stopped at, as the runtime kept it', async () => {
    const op = newOpId();
    const runtime: StepRuntime<DriverCan> = {
      ...runtimeSeeing([]),
      reattach: async () => ({ kind: 'alive', ops: [{ op, state: 'finished', session: { tool: 'codex', id: 's-1' }, result: { output: { ok: true } }, stopped: 'budget' }] }),
    };
    const saved = { runtime: runtime.name, driver: 'd', phase: 'running', open: { op: newOpId(), handle: 'h1' }, prompt: { op } } satisfies AttemptRuntimeRecord;
    const dir = attemptDir(config(), RUN, FIRST);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(saved));

    expect(await resumePrompt(runtime)).toMatchObject({ kind: 'finished', session: { id: 's-1' }, stopped: 'budget' });
    expect(prompts).toBe(0);
  });

  it('keeps the recovered agent link while a prompt reconnects and after it finishes without another display', async () => {
    const op = newOpId();
    const workspace = { label: 'Workspace', url: 'https://example.com/workspace/1' };
    const agent = { label: 'Review', url: 't3://thread/actual-agent' };
    let atReconnect: RuntimeDisplay | undefined;
    const runtime: StepRuntime<DriverCan> = {
      ...runtimeSeeing([]),
      reattach: async () => ({ kind: 'alive', display: agent, ops: [{ op, state: 'running' }] }),
      prompt: async (request, events) => {
        expect(request.op).toBe(op);
        events.onAccepted?.({});
        atReconnect = await displayed();

        return { kind: 'finished', session: { tool: 'codex', id: 'actual-agent' }, result: { output: { ok: true } } };
      },
    };
    const saved = {
      runtime: runtime.name, driver: 'd', phase: 'running', open: { op: newOpId(), handle: 'h1' }, prompt: { op }, display: workspace,
    } satisfies AttemptRuntimeRecord;
    const dir = attemptDir(config(), RUN, FIRST);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(saved));

    const end = await resumePrompt(runtime);
    const afterEnd = await displayed();

    expect({ atReconnect, afterEnd, end: end.kind }).toEqual({ atReconnect: agent, afterEnd: agent, end: 'finished' });
  });

  it('stops a prompt a killed teamai left failed cancel_failed, instead of taking it as failed or sending it again', async () => {
    const runtime = runtimeSeeing([ended(cannotStop), cancelled]);
    await promptLeftRunning(runtime);

    expect(await resumePrompt(runtime)).toEqual({ kind: 'cancelled' });
    expect(prompts).toBe(1);
  });

  it('ends a prompt a killed teamai left failed cancel_failed as lost while its runtime still cannot stop it', async () => {
    const runtime = runtimeSeeing([ended(cannotStop)]);
    await promptLeftRunning(runtime);

    expect(await resumePrompt(runtime)).toMatchObject({ kind: 'lost', failure: { code: 'cancel_failed', message: expect.stringContaining(cannotStop.message) } });
  });

  it('ends its wait for the stop 15 s after the cancel, even when a reattach sent just before then answers late', async () => {
    const base = runtimeSeeing([running]);
    let op = '';
    let slowFrom = Number.POSITIVE_INFINITY;
    let askedToCancel: () => void = () => {};
    let letCancel: () => void = () => {};
    const cancelAsked = new Promise<void>((resolve) => { askedToCancel = resolve; });
    const cancelLet = new Promise<void>((resolve) => { letCancel = resolve; });
    // Its reattach answers at once until just before the 15 s, then takes as long as a runtime may take to answer one.
    const runtime = {
      ...base,
      exec: (request, events, kind) => {
        op = request.op;

        return base.exec(request, events, kind);
      },
      cancel: async () => {
        askedToCancel();
        await cancelLet;
      },
      reattach: async () => (Date.now() < slowFrom ? running(op) : new Promise<Reattached>((resolve) => setTimeout(() => resolve(running(op)), 15_000))),
    } satisfies StepRuntime<DriverCan>;
    await leftRunning(runtime);
    const stopped = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation();
    await cancelAsked;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    try {
      slowFrom = Date.now() + 14_900;
      letCancel();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await Promise.race([stopped, 'still waiting'])).toEqual({ code: 'runtime_unanswered', message: `Step runtime "fake" still reported operation ${op} of attempt ${FIRST} running 15 s after teamai asked it to cancel it.` });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not taken as stopped when its runtime cannot be asked after the cancel', async () => {
    const runtime = runtimeSeeing([unreachable]);
    await leftRunning(runtime);

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).stopLeftOperation()).toEqual({ code: 'runtime_exited', message: 'gone away' });
  });

  it('ends a restarted exec whose old run the runtime cannot show stopped as lost, instead of reporting it interrupted', async () => {
    const runtime = runtimeSeeing([running, unreachable]);
    await leftRunning(runtime);

    const end = await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {}, 'command');

    expect(end).toMatchObject({ kind: 'lost' });
  });

  it('leaves the exec at a stop on a runtime whose execs go on without teamai, and a restarted teamai sends it again by the same id, cancelling nothing', async () => {
    const sent: string[] = [];
    let cancels = 0;
    const seeing = runtimeSeeing([running]);
    const runtime: StepRuntime<DriverCan> = {
      ...seeing,
      isExecReconnected: true,
      exec: async (request, events, kind) => {
        sent.push(request.op);

        return seeing.exec(request, events, kind);
      },
      cancel: async () => { cancels += 1; },
    };
    const before = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await before.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    const left = before.exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {}, 'command');
    await seeing.received;

    await before.stop();

    expect(await left).toEqual({ kind: 'left' });
    void attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {}, 'command');
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toBe(sent[0]);
    expect(cancels).toBe(0);
  });

  it('waits at a stop for the cancel the run already asked of an exec on a runtime whose execs go on without teamai, rather than leaving it', async () => {
    const seeing = runtimeSeeing([running]);
    let endExec = (_end: ExecEnd): void => {};
    let landCancel = (): void => {};
    const cancelLanded = new Promise<void>((resolve) => { landCancel = resolve; });
    const runtime: StepRuntime<DriverCan> = {
      ...seeing,
      isExecReconnected: true,
      exec: (request, events, kind) => {
        void seeing.exec(request, events, kind);

        return new Promise<ExecEnd>((resolve) => { endExec = resolve; });
      },
      // The exec ends cancelled once the cancel lands, as a fleet exec does once its member answers it.
      cancel: async () => {
        await cancelLanded;
        endExec({ kind: 'cancelled' });
      },
    };
    const attempt = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await attempt.open({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} })).toMatchObject({ ok: true });
    const exec = attempt.exec({ argv: ['tool'], env: {}, unset: [], credentials: {}, cwd: root }, {}, 'command');
    await seeing.received;

    // The run cancels the step, and the driver stops it as it ends, before the cancel landed.
    const cancelAsked = attempt.cancel();
    const stopped = attempt.stop();
    landCancel();
    await Promise.all([cancelAsked, stopped]);

    expect(await exec).toMatchObject({ kind: 'cancelled' });
  });
});

describe('an open that failed, or that a killed teamai left unanswered', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });
  const view = () => ({ worktree: root, readonly: [], result: path.join(root, 'out'), runDir: path.join(root, 'scratch'), toolHome: {} });
  const refused = { code: 'sandbox_failed', message: 'The image cannot be pulled.' };

  /** A runtime whose open runs `open`, and that notes each open and close it was sent. */
  const runtimeOpening = (open: StepRuntime<DriverCan>['open']): StepRuntime<DriverCan> & { opens: string[]; closes: string[] } => {
    const opens: string[] = [];
    const closes: string[] = [];

    return {
      opens,
      closes,
      name: 'fake',
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (request, onAccepted) => {
        opens.push(request.op);

        return open(request, onAccepted);
      },
      exec: async () => ({ kind: 'cancelled' }),
      prompt: async () => ({ kind: 'cancelled' }),
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'gone' }),
      close: async (handle) => {
        closes.push(handle);

        return { ok: true };
      },
      dispose: async () => {},
    };
  };

  it('answers the failure of an open its runtime accepted, without sending it again, once teamai restarts, and closes the place', async () => {
    const runtime = runtimeOpening(async (_request, onAccepted) => {
      await onAccepted('h1');

      return { kind: 'failed', failure: refused };
    });
    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).open(view())).toMatchObject({ ok: false });

    const restarted = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });

    expect(await restarted.open(view())).toMatchObject({ ok: false, failure: { message: expect.stringContaining('(sandbox_failed): The image cannot be pulled.') } });
    expect(runtime.opens).toHaveLength(1);
    expect(await restarted.close()).toBeUndefined();
    expect(runtime.closes).toEqual(['h1']);
  });

  it('closes the record of an open teamai never sent to a runtime that had stopped, which holds no place', async () => {
    const runtime = runtimeOpening(async () => ({ kind: 'failed', failure: { code: 'runtime_not_sent', message: 'Step runtime "fake" stopped: it exited with status 70. teamai did not send open.' } }));
    const run = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });

    expect(await run.open(view())).toMatchObject({ ok: false });
    expect(await run.close()).toBeUndefined();
    expect(await readAttemptPlacement(config(), RUN, FIRST)).toMatchObject({ kind: 'external', record: { phase: 'closed' } });
  });

  it('keeps an open a killed teamai left with no handle when the restarted open is refused, since the first may have made a place', async () => {
    const left = runtimeOpening(() => new Promise(() => {}));
    void attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime: left, driver: 'd' }).open(view());
    await expect.poll(() => left.opens.length).toBe(1);

    const runtime = runtimeOpening(async () => ({ kind: 'failed', failure: refused }));
    const restarted = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });

    expect(await restarted.open(view())).toMatchObject({ ok: false });
    expect(runtime.opens).toEqual(left.opens);
    expect(await restarted.close()).toMatchObject({ message: expect.stringContaining('may hold a place for attempt a00000001 that teamai cannot close') });
  });
});

describe('a tool home seeded from the attempt whose session a step resumes', () => {
  it('copies the session, never the login teamai copied into that home under its lock', async () => {
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const session = '019a0000-0000-7000-8000-000000000001';
    const home = attemptToolHome(config, RUN, FIRST, 'codex');
    const day = path.join(home, 'sessions', '2026', '11', '04');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-11-04T10-00-00-${session}.jsonl`), `${JSON.stringify({ timestamp: '2026-11-04T10:00:01.000Z', type: 'session_meta', payload: { id: session, timestamp: '2026-11-04T10:00:00.000Z', cwd: root, originator: 'codex_cli_rs', cli_version: '0.163.0' } })}\n`);
    fs.writeFileSync(path.join(home, 'auth.json'), auth('r2'));
    fs.writeFileSync(path.join(attemptDir(config, RUN, FIRST), 'runtime.json'), JSON.stringify({ runtime: 'toy', driver: 'd', phase: 'closed', open: { op: newOpId(), handle: 'h1' }, toolHome: { tool: 'codex', dir: home } }));

    const seeded = await seedToolHome({ config, run: RUN, attempt: SECOND, tool: 'codex', sessions: [{ tool: 'codex', id: session }] });

    const next = attemptToolHome(config, RUN, SECOND, 'codex');
    expect(seeded).toEqual({ tool: 'codex', id: session });
    expect(fs.existsSync(path.join(next, 'sessions', '2026', '11', '04', `rollout-2026-11-04T10-00-00-${session}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(next, 'auth.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('leaves out a FIFO the earlier step left in that home, and still resumes its session', async () => {
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const session = '019a0000-0000-7000-8000-000000000002';
    const home = attemptToolHome(config, RUN, FIRST, 'codex');
    const day = path.join(home, 'sessions', '2026', '11', '04');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-11-04T10-00-00-${session}.jsonl`), `${JSON.stringify({ timestamp: '2026-11-04T10:00:01.000Z', type: 'session_meta', payload: { id: session, timestamp: '2026-11-04T10:00:00.000Z', cwd: root, originator: 'codex_cli_rs', cli_version: '0.163.0' } })}\n`);
    execFileSync('mkfifo', [path.join(home, 'left.fifo')]);
    fs.writeFileSync(path.join(attemptDir(config, RUN, FIRST), 'runtime.json'), JSON.stringify({ runtime: 'toy', driver: 'd', phase: 'closed', open: { op: newOpId(), handle: 'h1' }, toolHome: { tool: 'codex', dir: home } }));

    const seeded = await seedToolHome({ config, run: RUN, attempt: SECOND, tool: 'codex', sessions: [{ tool: 'codex', id: session }] });

    const next = attemptToolHome(config, RUN, SECOND, 'codex');
    expect(seeded).toEqual({ tool: 'codex', id: session });
    expect(fs.existsSync(path.join(next, 'sessions', '2026', '11', '04', `rollout-2026-11-04T10-00-00-${session}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(next, 'left.fifo'))).toBe(false);
  });
});

describe('the session store of an attempt whose runtime reported where it kept the session', () => {
  it('reads a Codex session in the home the runtime reported, such as a daemon\'s under another HOME, not in the member\'s own', async () => {
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const reported = path.join(root, 'daemon-home', '.codex');
    fs.mkdirSync(attemptDir(config, RUN, FIRST), { recursive: true });
    fs.writeFileSync(path.join(attemptDir(config, RUN, FIRST), 'runtime.json'), JSON.stringify({ runtime: 'paseo', driver: 'd', phase: 'closed', open: { op: newOpId(), handle: 'h1' }, sessionHome: { tool: 'codex', dir: reported } }));

    expect(await attemptSessionStore(config, RUN, FIRST)).toBe(path.join(reported, 'sessions'));
  });
});

describe('the first login of a tool teamai keeps one for', () => {
  it('runs the tool\'s login once for steps that ask for it at the same time', async () => {
    const bin = path.join(root, 'bin');
    const logins = path.join(root, 'logins.txt');
    fs.mkdirSync(bin);
    // A codex whose login takes a moment, writes the login file, and counts how often it ran.
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho login >> "${logins}"\nsleep 0.2\nmkdir -p "$CODEX_HOME"\necho '{}' > "$CODEX_HOME/auth.json"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const ended = await Promise.all([
      ensureLogin('codex', { step: { run: RUN, id: 'left' }, canAsk: true }),
      ensureLogin('codex', { step: { run: RUN, id: 'right' }, canAsk: true }),
    ]);

    expect(ended).toEqual([undefined, undefined]);
    expect(fs.readFileSync(logins, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the first login across teamai processes on one machine', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  /** Another teamai process, as a second run started in another terminal is, that checks the login as a step does. */
  const otherProcess = (env: NodeJS.ProcessEnv): Promise<string> => {
    const script = path.join(root, 'other.mjs');
    fs.writeFileSync(script, `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(path.join(repo, 'scripts', 'typescript-loader.mjs')).href)});
const { ensureLogin } = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src', 'workflow', 'runtimes', 'login.ts')).href)});
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(root, 'other.json'))}, JSON.stringify(await ensureLogin('codex', { step: { run: 'r0123abcd', id: 'other' }, canAsk: true }) ?? null));
`);

    return new Promise((resolve, reject) => {
      execFile(process.execPath, [script], { env, cwd: root }, (error) => (error ? reject(error) : resolve(fs.readFileSync(path.join(root, 'other.json'), 'utf8'))));
    });
  };

  it('runs the tool\'s login once when two teamai processes need it at the same time', async () => {
    const bin = path.join(root, 'bin');
    const logins = path.join(root, 'logins.txt');
    fs.mkdirSync(bin);
    // A codex whose login takes a moment, writes the login file, and counts how often it ran.
    fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\necho login >> "${logins}"\nsleep 1\nmkdir -p "$CODEX_HOME"\nprintf '%s' '${auth('r1')}' > "$CODEX_HOME/auth.json"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const [here, other] = await Promise.all([
      ensureLogin('codex', { step: { run: RUN, id: 'here' }, canAsk: true }),
      otherProcess({ ...process.env }),
    ]);

    expect({ here, other }).toEqual({ here: undefined, other: 'null' });
    expect(fs.readFileSync(logins, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('takes a login file that is empty, as one a login still writes leaves it, as no login', async () => {
    fs.mkdirSync(path.dirname(dedicated()), { recursive: true });
    fs.writeFileSync(dedicated(), '', { mode: 0o600 });

    expect(await ensureLogin('codex', { step: { run: RUN, id: 'review' }, canAsk: false })).toMatchObject({ code: 'credential_missing' });
  });

  it('ends the unattended refusal with a retry command the shell reads as one step path', async () => {
    const refused = await ensureLogin('codex', { step: { run: RUN, id: 'items[1].ask me' }, canAsk: false });

    expect(refused?.message).toMatch(new RegExp(`then run: teamai workflow retry ${RUN} 'items\\[1\\]\\.ask me'$`, 'u'));
  });
});

describe('the session store of an OpenCode prompt on a runtime that launches agents', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  /** A runtime whose prompt finishes an OpenCode session with `home`, or none. */
  const finishing = (home: string | undefined): StepRuntime<DriverCan> => ({
    name: 'agents',
    init: async () => ({ ok: true, can: {}, launchesAgents: true }),
    open: async (_request, onAccepted) => {
      await onAccepted('h1');

      return { kind: 'ready', handle: 'h1' };
    },
    exec: () => new Promise<ExecEnd>(() => {}),
    prompt: async (_request, events) => {
      events.onAccepted?.({});

      return { kind: 'finished', session: { tool: 'opencode', id: 'ses_1', ...(home === undefined ? {} : { home }) }, result: { output: { ok: true } } };
    },
    cancel: async () => {},
    collect: async () => ({ ok: true }),
    reattach: async () => ({ kind: 'gone' }),
    close: async () => ({ ok: true }),
    dispose: async () => {},
  });

  const promptOn = async (runtime: StepRuntime<DriverCan>): Promise<void> => {
    const run = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await run.open(undefined, { tool: 'opencode' })).toMatchObject({ ok: true });
    expect(await run.prompt({
      lease: { step: 'review', tool: 'opencode', prompt: 'p', result: path.join(root, 'out', 'result.json'), permissions: 'unattended', interactive: false }, env: {}, unset: [], credentials: {}, cwd: root,
    }, {})).toMatchObject({ kind: 'finished' });
  };

  it('reads an OpenCode session in the data home its runtime reported, where OpenCode keeps it under opencode/', async () => {
    const reported = path.join(root, 'daemon-home', '.local', 'share');
    await promptOn(finishing(reported));

    expect(await attemptSessionStore(config(), RUN, FIRST)).toBe(path.join(reported, 'opencode'));
  });

  it('reads an OpenCode session whose runtime named no home in the data home under $HOME, not in its config home', async () => {
    await promptOn(finishing(undefined));

    expect(await attemptSessionStore(config(), RUN, FIRST)).toBe(path.join(root, '.local', 'share', 'opencode'));
  });
});

describe('a place a restarted teamai opens again', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  it('keeps the handle it recorded while a place made in steps is opened again, so a failed reopen still names the whole place', async () => {
    const whole = JSON.stringify({ outer: 'box-1', inner: 'app-1' });
    const recorded = { runtime: 'app through box', driver: 'd', phase: 'running', open: { op: newOpId(), handle: whole }, prompt: { op: newOpId() } } satisfies AttemptRuntimeRecord;
    fs.mkdirSync(attemptDir(config(), RUN, FIRST), { recursive: true });
    fs.writeFileSync(path.join(attemptDir(config(), RUN, FIRST), 'runtime.json'), JSON.stringify(recorded));
    // The outer accepts again; the inner's open then fails, as one that timed out.
    const runtime: StepRuntime<DriverCan> = {
      name: 'app through box',
      init: async () => ({ ok: true, can: {}, launchesAgents: true }),
      open: async (_request, onAccepted) => {
        await onAccepted(JSON.stringify({ outer: 'box-1' }));

        return { kind: 'failed', failure: { code: 'runtime_unanswered', message: 'the inner did not answer' } };
      },
      exec: () => new Promise<ExecEnd>(() => {}),
      prompt: () => new Promise<PromptEnd>(() => {}),
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'gone' }),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };

    expect(await attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' }).open(undefined)).toMatchObject({ ok: false });
    expect(await readAttemptPlacement(config(), RUN, FIRST)).toMatchObject({ kind: 'external', record: { open: { handle: whole } } });
  });
});

describe('the session store of a tool instance\'s prompt on a runtime that launches agents', () => {
  const config = (): LocalConfig => ({ repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') });

  it('reads the session of an instance whose runtime named no home in the instance\'s own directory under $HOME, not in the one its variable moves', async () => {
    vi.stubEnv('ACME_CODEX_HOME', path.join(root, 'moved'));
    useToolInstances(new Map([['acme-codex', {
      kind: 'instance', name: 'acme-codex', extends: 'codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' },
      source: 'personal', file: path.join(root, '.teamai', 'tools', 'acme-codex.yaml'), location: '~/.teamai/tools/acme-codex.yaml', revision: 'r1',
    }]]));
    onTestFinished(() => useToolInstances(new Map()));
    const runtime: StepRuntime = {
      name: 'agents',
      init: async () => ({ ok: true, can: {}, launchesAgents: true }),
      open: async (_request, onAccepted) => {
        await onAccepted('h1');

        return { kind: 'ready', handle: 'h1' };
      },
      exec: () => new Promise<ExecEnd>(() => {}),
      prompt: async (_request, events) => {
        events.onAccepted?.({});

        return { kind: 'finished', session: { tool: 'acme-codex', id: 'ses_1' }, result: { output: { ok: true } } };
      },
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'gone' }),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
    const run = attemptRun({ config: config(), run: RUN, attempt: FIRST, runtime, driver: 'd' });
    expect(await run.open(undefined, { tool: 'acme-codex' })).toMatchObject({ ok: true });
    expect(await run.prompt({
      lease: { step: 'review', tool: 'acme-codex', prompt: 'p', result: path.join(root, 'out', 'result.json'), permissions: 'unattended', interactive: false }, env: {}, unset: [], credentials: {}, cwd: root,
    }, {})).toMatchObject({ kind: 'finished' });

    expect(await attemptSessionStore(config(), RUN, FIRST)).toBe(path.join(root, '.acme-codex', 'sessions'));
  });
});

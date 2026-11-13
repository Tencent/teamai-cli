import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { placeView, runtimeCommand, runtimeLauncher } from '../workflow/steps/runtime-steps.js';
import { stepLauncher } from '@teamai/runtime-tools';
import { toolsLaunchDeps } from '../workflow/runtimes/sources.js';
import { attemptRun, attemptRuntimePath, type AttemptRun } from '../workflow/runtimes/attempt.js';
import { acquireLock, releaseLock } from '../update.js';
import type { DriverCan } from '../workflow/requirements.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { AttemptIdSchema, attemptResultPath, attemptsDir, RunIdSchema, runsRemovalLockIn } from '../workflow/store.js';
import type { StepRuntime } from '@teamai/runtime-protocol/step-runtime';
import type { OpId } from '@teamai/runtime-protocol';

/** An attempt on a step runtime whose `cancel`, like the real one, stops only an exec it has sent. */
function commandRun(): { run: AttemptRun; execs: () => number } {
  let execs = 0;

  const run: AttemptRun = {
    open: async () => ({ ok: true, handle: 'h-1' }),
    exec: async () => {
      execs += 1;

      return { kind: 'exited', code: 0, stdout: '' };
    },
    setup: async () => ({ kind: 'exited', code: 0, stdout: '' }),
    prompt: async () => ({ kind: 'failed', failure: { code: 'prompt_unsupported', message: 'exec only' } }),
    cancel: async () => {},
    stop: async () => {},
    collect: async () => undefined,
    close: async () => {},
    stopLeftSetup: async () => undefined,
    closeForRemadeFolder: async () => undefined,
    stopLeftOperation: async () => undefined,
  };

  return { run, execs: () => execs };
}

describe('the place a step runtime is given', () => {
  // git keeps a linked worktree's record at <common git dir>/worktrees/<name>. Given again on its own, a runtime mounts
  // it at its own path: Docker Desktop then refuses its removal while the container runs, and makes it again when the
  // container starts after it went.
  it('gives a linked worktree\'s git paths as its common git directory and its .git pointer, not git\'s record inside that directory', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-place-view-')));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'linked');
    const git = (args: string[]): string => execFileSync('git', ['-C', main, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    fs.mkdirSync(main);
    git(['init', '-q', '-b', 'main']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one']);
    git(['worktree', 'add', '-q', '-b', 'side', worktree]);
    const config: LocalConfig = { repo: { localPath: main, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: main, dataHome: path.join(root, 'data') };

    const view = await placeView(config, RunIdSchema.parse('r0123abcd'), { attempt: AttemptIdSchema.parse('a00000001') }, worktree);

    expect(view.readonly.toSorted()).toEqual([path.join(main, '.git'), path.join(worktree, '.git')].toSorted());
  });
});

describe('a command step on a step runtime', () => {
  const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };

  it('does not run the command when the step is stopped once setup ended and before its exec is sent', async () => {
    const { run, execs } = commandRun();
    let stopStep = (): void => {};

    const started = runtimeCommand({
      run, view: async () => view, command: 'node build.js', env: {}, unset: [],
      setUp: async () => {
        // The stop arrives while teamai checks what setup left: no operation of the attempt runs on the runtime.
        stopStep();

        return undefined;
      },
    });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.exit).resolves.toMatchObject({ exitCode: 130 });
    expect(execs()).toBe(0);
  });
  it('stops the setup it runs when the step is stopped while its place opens, so setup ends stopped and the command never runs', async () => {
    const { run, execs } = commandRun();
    let stopStep = (): void => {};
    const stoppedSetup = { code: 'setup_failed', message: 'Setup "make deps" was stopped, so the step did not run.' };

    const started = runtimeCommand({
      run: { ...run, open: async () => {
        stopStep();

        return { ok: true, handle: 'h-1' };
      } },
      view: async () => view, command: 'node build.js', env: {}, unset: [],
      // Setup, as teamai runs it, ends stopped once its signal aborts, and runs nothing on the runtime then.
      setUp: async (signal) => (signal?.aborted === true ? stoppedSetup : undefined),
    });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.exit).resolves.toEqual(stoppedSetup);
    expect(execs()).toBe(0);
  });
});

describe('a prompt\'s tool exec\'d on a step runtime', () => {
  const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };

  it('does not exec the tool when the step is stopped once setup ended and before its exec is sent', async () => {
    const { run, execs } = commandRun();
    let stopStep = (): void => {};

    const launcher = runtimeLauncher(run, {
      view, tool: 'claude', toolHome: { tool: 'claude', dir: '/work/home' }, unset: [], credentials: {},
      setUp: async () => {
        // The timeout passes while teamai checks what setup left: no operation of the attempt runs on the runtime.
        stopStep();

        return undefined;
      },
    });
    const started = launcher({ executable: 'claude', args: ['-p'], cwd: '/work', env: {}, interactive: false, onStart: () => {}, onStdout: () => {} });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.closed).resolves.toMatchObject({ exitCode: 143 });
    expect(execs()).toBe(0);
  });
});

describe('a prompt\'s tool a resumed step attaches to on its step runtime', () => {
  it('reads the result that tool wrote before teamai stopped, which the launch never removes as another process\'s', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-attached-'));
    const resultPath = path.join(dir, 'out', 'result.json');
    const view = { worktree: dir, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} };
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, '{"output":{"ok":true}}');
    const { run } = commandRun();
    // The exec ended before teamai was killed; attaching to it again gives its end and writes nothing more.
    const launcher = runtimeLauncher({
      ...run,
      exec: async (_request, events) => {
        events.onAccepted?.({});

        return { kind: 'exited', code: 0, stdout: '' };
      },
    }, { view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(dir, 'home') }, unset: [], credentials: {}, setUp: async () => undefined });

    try {
      const ran = await stepLauncher(toolsLaunchDeps(), { start: launcher, canReattach: true, resolveTool: () => 'claude', resolveInstanceCommand: () => null })
        .run('claude', { prompt: 'review', cwd: dir, resultPath, secrets: {}, expected: undefined });

      expect(ran).toMatchObject({ started: true, exitCode: 0, output: { ok: true } });
      expect(ran.failure).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a prompt\'s tool a restarted teamai sends anew on its step runtime', () => {
  it('reads no result an earlier run of the tool left, when the runtime never got that exec and the tool writes none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sent-anew-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const ids = { run: RunIdSchema.parse('r0123abcd'), attempt: AttemptIdSchema.parse('a00000001') };
    const resultPath = attemptResultPath(config, ids.run, ids.attempt);
    const view = { worktree: root, readonly: [], result: path.dirname(resultPath), runDir: path.join(root, 'scratch'), toolHome: {} };
    let execs = 0;
    // The first tool writes its result and teamai is killed before the end; the runtime that comes back knows no
    // operation of the place, so the exec is sent again and the tool starts anew, writing no result this time.
    const runtime: StepRuntime<DriverCan> = {
      name: 'forgetful',
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (_request, onAccepted) => {
        await onAccepted('h-1');

        return { kind: 'ready', handle: 'h-1' };
      },
      exec: async (_request, events) => {
        execs += 1;
        events.onAccepted?.({});

        if (execs > 1) return { kind: 'exited', code: 0, stdout: '' };
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, '{"output":{"ok":true}}');

        return new Promise(() => {});
      },
      prompt: async () => ({ kind: 'cancelled' }),
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'alive', ops: [] }),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
    const first = attemptRun({ config, ...ids, runtime, driver: 'forgetful' });
    await first.open(view);
    void first.exec({ argv: ['claude'], env: {}, unset: [], credentials: {}, cwd: root }, {}, 'tool');
    await vi.waitFor(() => { expect(fs.existsSync(resultPath)).toBe(true); });

    const launcher = runtimeLauncher(attemptRun({ config, ...ids, runtime, driver: 'forgetful' }), { view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(root, 'home') }, unset: [], credentials: {}, setUp: async () => undefined });
    const ran = await stepLauncher(toolsLaunchDeps(), { start: launcher, canReattach: true, resolveTool: () => 'claude', resolveInstanceCommand: () => null })
      .run('claude', { prompt: 'review', cwd: root, resultPath, secrets: {}, expected: undefined });

    expect(execs).toBe(2);
    expect('output' in ran ? ran.output : undefined).toBeUndefined();
  });
});

describe('the timeout of a prompt\'s tool exec\'d on a step runtime', () => {
  it('counts from when the runtime accepts the tool, so a setup longer than the timeout leaves the tool its whole time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-timeout-'));
    const resultPath = path.join(dir, 'out', 'result.json');
    const view = { worktree: dir, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} };
    const { run } = commandRun();
    const launcher = runtimeLauncher({
      ...run,
      exec: async (_request, events) => {
        events.onAccepted?.({});
        fs.writeFileSync(resultPath, '{"output":{"ok":true}}');

        return { kind: 'exited', code: 0, stdout: '' };
      },
    }, {
      view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(dir, 'home') }, unset: [], credentials: {},
      setUp: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));

        return undefined;
      },
    });

    try {
      const ran = await stepLauncher(toolsLaunchDeps(), { start: launcher, resolveTool: () => 'claude', resolveInstanceCommand: () => null }).run('claude', { prompt: 'review', cwd: dir, resultPath, secrets: {}, expected: undefined, timeoutMs: 200 });

      expect(ran).toMatchObject({ started: true, exitCode: 0, output: { ok: true } });
      expect(ran).not.toHaveProperty('stoppedBy');
      expect(ran.failure).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the idle limit of a prompt\'s tool exec\'d on a step runtime', () => {
  it('counts from when the runtime accepts the tool, so a setup longer than the limit leaves the tool its whole limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-idle-'));
    const resultPath = path.join(dir, 'out', 'result.json');
    const view = { worktree: dir, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'scratch'), toolHome: {} };
    const { run } = commandRun();
    const launcher = runtimeLauncher({
      ...run,
      exec: async (_request, events) => {
        events.onAccepted?.({});
        fs.writeFileSync(resultPath, '{"output":{"ok":true}}');

        return { kind: 'exited', code: 0, stdout: '' };
      },
    }, {
      view, tool: 'claude', toolHome: { tool: 'claude', dir: path.join(dir, 'home') }, unset: [], credentials: {},
      // Setup prints nothing the tool's stdout carries, for longer than the idle limit.
      setUp: async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));

        return undefined;
      },
    });

    try {
      const ran = await stepLauncher(toolsLaunchDeps(), { start: launcher, resolveTool: () => 'claude', resolveInstanceCommand: () => null }).run('claude', { prompt: 'review', cwd: dir, resultPath, secrets: {}, expected: undefined, idleTimeoutMs: 200 });

      expect(ran).toMatchObject({ started: true, exitCode: 0, output: { ok: true } });
      expect(ran.failure).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an attempt\'s operations on a step runtime', () => {
  /** A step runtime that counts the execs it is sent, through the attempt's run as the driver builds it. */
  function counted(): { run: AttemptRun; config: LocalConfig; execs: () => number; done: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-attempt-ops-'));
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    let execs = 0;
    const runtime: StepRuntime<DriverCan> = {
      name: 'counted',
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (_request, onAccepted) => {
        await onAccepted('h-1');

        return { kind: 'ready', handle: 'h-1' };
      },
      exec: async () => {
        execs += 1;

        return { kind: 'exited', code: 0, stdout: '' };
      },
      prompt: async () => ({ kind: 'cancelled' }),
      cancel: async () => {},
      collect: async () => ({ ok: true }),
      reattach: async () => ({ kind: 'gone' }),
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
    const run = attemptRun({ config, run: RunIdSchema.parse('r0123abcd'), attempt: AttemptIdSchema.parse('a00000001'), runtime, driver: 'counted' });

    return { run, config, execs: () => execs, done: () => fs.rmSync(root, { recursive: true, force: true }) };
  }

  it('records the place it opens only once an uninstall beside it lets go of the places lock', async () => {
    const { run, config, done } = counted();
    onTestFinished(done);
    const lock = runsRemovalLockIn(getDataHome(config));
    expect(await acquireLock(lock)).toBe(true);
    const record = attemptRuntimePath(config, RunIdSchema.parse('r0123abcd'), AttemptIdSchema.parse('a00000001'));

    const opened = run.open({ worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const recordedWhileHeld = fs.existsSync(record);
    await releaseLock(lock);

    expect(recordedWhileHeld).toBe(false);
    await expect(opened).resolves.toEqual({ ok: true, handle: 'h-1' });
    expect(fs.existsSync(record)).toBe(true);
  });

  it('records no place for a run an uninstall removed while the open waited on the places lock, and opens none', async () => {
    const { run, config, done } = counted();
    onTestFinished(done);
    const runDir = path.dirname(attemptsDir(config, RunIdSchema.parse('r0123abcd')));
    fs.mkdirSync(runDir, { recursive: true });
    const lock = runsRemovalLockIn(getDataHome(config));
    expect(await acquireLock(lock)).toBe(true);

    const opened = run.open({ worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(runDir, { recursive: true, force: true });
    await releaseLock(lock);

    await expect(opened).resolves.toMatchObject({ ok: false, failure: { message: expect.stringContaining('its run was removed while it waited') } });
    expect(fs.existsSync(runDir)).toBe(false);
  });

  it('leaves no data home behind when an uninstall removed it while the open waited on the places lock', async () => {
    const { run, config, done } = counted();
    onTestFinished(done);
    const dataHome = getDataHome(config);
    fs.mkdirSync(path.dirname(attemptsDir(config, RunIdSchema.parse('r0123abcd'))), { recursive: true });
    const lock = runsRemovalLockIn(dataHome);
    expect(await acquireLock(lock)).toBe(true);

    const opened = run.open({ worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} });
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataHome, { recursive: true, force: true });
    await releaseLock(lock);

    await expect(opened).resolves.toMatchObject({ ok: false, failure: { message: expect.stringContaining('its run was removed while it waited') } });
    expect(fs.existsSync(dataHome)).toBe(false);
  });

  it('sends no exec when the step is stopped while the attempt records the exec it is about to send', async () => {
    const { run, execs, done } = counted();
    onTestFinished(done);
    const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };
    let stopStep = (): void => {};

    const started = runtimeCommand({
      run, view: async () => view, command: 'node build.js', env: {}, unset: [],
      setUp: async () => {
        // The stop lands once the exec is on its way: while the attempt reads and writes its record, before it sends it.
        setImmediate(stopStep);

        return undefined;
      },
    });
    stopStep = () => {
      void started.stop();
    };

    await expect(started.exit).resolves.toMatchObject({ exitCode: 130 });
    expect(execs()).toBe(0);
  });

  it.each([
    { sends: 'exec', how: 'cancel', ends: { kind: 'cancelled' }, cancels: 1 },
    { sends: 'exec', how: 'stop', ends: { kind: 'left' }, cancels: 0 },
    { sends: 'prompt', how: 'cancel', ends: { kind: 'cancelled' }, cancels: 1 },
    { sends: 'prompt', how: 'stop', ends: { kind: 'cancelled' }, cancels: 1 },
  ] as const)('passes a $how that lands while a restarted teamai finds the $sends it sends again on to that $sends', async ({ sends, how, ends, cancels }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-attempt-ops-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const config: LocalConfig = { repo: { localPath: root, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    const cancelled: string[] = [];
    const running = new Map<OpId, () => void>();
    let landStop: (() => void) | undefined;
    const pending = async ({ op }: { op: OpId }) => new Promise<{ kind: 'cancelled' }>((resolve) => { running.set(op, () => resolve({ kind: 'cancelled' })); });
    // Its execs go on without teamai, as a fleet's do, and the same id sent again reconnects to an exec or prompt still running.
    const runtime: StepRuntime<DriverCan> = {
      name: 'reconnected',
      isExecReconnected: true,
      init: async () => ({ ok: true, can: {}, launchesAgents: false }),
      open: async (_request, onAccepted) => {
        await onAccepted('h-1');

        return { kind: 'ready', handle: 'h-1' };
      },
      exec: pending,
      prompt: pending,
      cancel: async (op) => {
        cancelled.push(op);
        running.get(op)?.();
      },
      collect: async () => ({ ok: true }),
      reattach: async () => {
        landStop?.();

        return { kind: 'alive', ops: [...running.keys()].map((op) => ({ op, state: 'running' as const })) };
      },
      close: async () => ({ ok: true }),
      dispose: async () => {},
    };
    const ids = { config, run: RunIdSchema.parse('r0123abcd'), attempt: AttemptIdSchema.parse('a00000001'), runtime, driver: 'reconnected' };
    const command = { argv: ['node', 'build.js'], env: {}, unset: [], credentials: {}, cwd: '/work' };
    const asked = { env: {}, unset: [], credentials: {}, cwd: '/work', lease: { step: 'review', tool: 'claude', prompt: 'Review the work.', result: '/work/out/result.json', permissions: 'approval-required' as const, interactive: false } };
    const send = async (run: AttemptRun) => (sends === 'exec' ? run.exec(command, {}, 'command') : run.prompt(asked, {}));
    const first = attemptRun(ids);
    await first.open({ worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} });
    void send(first);
    await vi.waitFor(() => { expect(running.size).toBe(1); });

    const again = attemptRun(ids);
    const stop = () => { void (how === 'cancel' ? again.cancel() : again.stop()); };

    // The stop lands before the restarted attempt sends again what it recorded: while it writes the exec's record, or
    // while it asks the runtime what became of the prompt.
    if (sends === 'exec') setImmediate(stop);
    else landStop = stop;

    expect(await send(again)).toMatchObject(ends);
    expect(cancelled).toHaveLength(cancels);
  });
});

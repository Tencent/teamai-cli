import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '@teamai/shared/log';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { runStepLaunch, toolLauncher, type StepLaunchHost, type ToolClosed, type ToolLauncher } from './run-step-launch.js';

const claude = { name: 'claude', family: 'claude', step: BUILT_IN_TOOLS.claude.launch.claude.step, executable: '/usr/bin/claude' } as const;

const written: unknown[] = [];

const host: StepLaunchHost = {
  opencodeMajor: async () => 2,
  agyGatewayEnv: () => ({}),
  writeResult: async (_resultPath, result) => { written.push(result); },
};

const dirs: string[] = [];

async function resultPathIn(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-step-launch-'));
  dirs.push(dir);

  return path.join(dir, 'out', 'result.json');
}

afterEach(async () => {
  written.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * A fake process port: the tool starts, prints `lines`, and then ends with `exitCode`, or, when `untilStopped`, works on
 * until the launch stops it, as a tool past its budget does.
 */
function fakeLauncher(lines: readonly string[], { exitCode = 0, untilStopped = false } = {}): { start: ToolLauncher; stops: () => number } {
  let stops = 0;

  const start = toolLauncher(({ onStart, onStdout }) => {
    let end: (closed: ToolClosed) => void = () => {};
    const closed = new Promise<ToolClosed>((resolve) => { end = resolve; });
    const stdout = lines.map((line) => `${line}\n`).join('');

    queueMicrotask(() => {
      onStart();

      for (const line of lines) onStdout(`${line}\n`);

      if (!untilStopped) end({ exitCode, stdout });
    });

    return {
      closed,
      started: () => true,
      stop: async () => {
        stops++;
        end({ exitCode: 143, stdout });
      },
    };
  });

  return { start, stops: () => stops };
}

describe('runStepLaunch', () => {
  it('stops the tool once the tokens its stdout states pass the budget, and reports the budget and the tokens', async () => {
    // Headless Claude's stream-json with partial messages: each message_start states its input, each message_delta its output.
    const { start, stops } = fakeLauncher([
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', usage: { input_tokens: 30, output_tokens: 1, cache_read_input_tokens: 500 } } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } }),
    ], { untilStopped: true });

    const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' }, start, limits: { budget: 100 }, interactive: false, host });

    expect(ran).toMatchObject({ started: true, stoppedBy: 'budget', tokens: { input: 40, output: 70, cachedInput: 1000 } });
    expect(stops()).toBeGreaterThan(0);
  });

  it('reports a stop the port rejected, against its contract, and still ends the step at its limit', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { start: fake } = fakeLauncher([
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 200, output_tokens: 1 } } } }),
    ], { untilStopped: true });

    const start = toolLauncher((launch) => {
      const run = fake(launch);

      return { ...run, stop: async (signal) => { await run.stop(signal); throw new Error('the sandbox did not answer'); } };
    });

    try {
      const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' }, start, limits: { budget: 100 }, interactive: false, host });
      await new Promise((resolve) => { setTimeout(resolve, 20); });

      expect(ran).toMatchObject({ started: true, stoppedBy: 'budget' });
      expect(warn.mock.calls.map(([message]) => String(message))).toContain('teamai could not confirm that claude stopped: the sandbox did not answer');
    } finally {
      warn.mockRestore();
    }
  });

  it('marks a stop the port could not make, which ends the tool\'s run with a failure, as one it could not confirm', async () => {
    const start = toolLauncher(({ onStart, onStdout }) => {
      let end: (closed: ToolClosed) => void = () => {};
      const closed = new Promise<ToolClosed>((resolve) => { end = resolve; });

      queueMicrotask(() => {
        onStart();
        onStdout(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 200, output_tokens: 1 } } } })}\n`);
      });

      // As a sandbox's does: the stop settles, and the run ends naming what still runs.
      return { closed, started: () => true, stop: async () => { end({ failure: { code: 'cancel_failed', message: 'the tool reached a limit of its step and could not be stopped' } }); } };
    });

    const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' }, start, limits: { budget: 100 }, interactive: false, host });

    expect(ran).toMatchObject({ started: true, stopUnconfirmed: true, failure: { code: 'cancel_failed' } });
  });

  it('opens nothing for a step stopped before its launch, and ends it cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let starts = 0;
    const { start: fake } = fakeLauncher([JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' })]);

    const ran = await runStepLaunch({
      tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' },
      start: toolLauncher((launch) => { starts++; return fake(launch); }), signal: controller.signal, interactive: false, host,
    });

    expect(starts).toBe(0);
    expect(ran).toEqual({ started: false, exitCode: 1, failure: { code: 'cancelled', message: 'The step was stopped before claude started.' } });
  });

  it('ends cancelled, not failed, a step stopped while its runtime set up, before its tool started', async () => {
    const controller = new AbortController();
    let stops = 0;

    // A runtime's port: it opens the place and sets it up before the exec, and a stop there sends no exec.
    const start = toolLauncher(() => {
      let isStopRequested = false;
      const closed = (async (): Promise<ToolClosed> => {
        controller.abort();
        await new Promise((resolve) => { setTimeout(resolve, 10); });

        return isStopRequested ? { exitCode: 143, stdout: '' } : { exitCode: 0, stdout: '' };
      })();

      return { closed, started: () => false, stop: async () => { stops++; isStopRequested = true; } };
    });

    const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' }, start, signal: controller.signal, interactive: false, host });

    expect(stops).toBeGreaterThan(0);
    expect(ran).toEqual({ started: false, exitCode: 143, failure: { code: 'cancelled', message: 'The step was stopped before claude started.' } });
  });

  it('stops nothing at the timeout once the port\'s process end rejected', async () => {
    let stops = 0;
    const start = toolLauncher(({ onStart }) => {
      const closed = Promise.resolve().then((): ToolClosed => {
        onStart();
        throw new Error('the port lost the process');
      });

      return { closed, started: () => true, stop: async () => { stops++; } };
    });

    await expect(runStepLaunch({ tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' }, start, limits: { timeoutMs: 20 }, interactive: false, host })).rejects.toThrow('the port lost the process');
    await new Promise((resolve) => { setTimeout(resolve, 60); });

    expect(stops).toBe(0);
  });

  it('fails usage_limited, in the tool\'s own words, when the tool says it hit its usage limit', async () => {
    const { start } = fakeLauncher([
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'You\'ve hit your limit · resets 3pm (Europe/Madrid)' }),
    ], { exitCode: 1 });

    const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: 'a summary' }, start, interactive: false, host });

    expect(ran.failure).toEqual({ code: 'usage_limited', message: 'claude hit its usage limit: You\'ve hit your limit · resets 3pm (Europe/Madrid)' });
  });

  it.each([
    { major: 2, argv: ['run', '--standalone', '--format', 'json', 'Fix it.'] },
    { major: 1, argv: ['run', '--format', 'json', 'Fix it.'] },
  ])('runs a plain OpenCode $major step on its own server when OpenCode has a background service to leave behind', async ({ major, argv }) => {
    const opencode = { name: 'opencode', family: 'opencode', step: BUILT_IN_TOOLS.opencode.launch.opencode.step, executable: '/usr/bin/opencode' } as const;
    let launched: string[] = [];
    const { start } = fakeLauncher([JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'Done.' } })]);

    await runStepLaunch({
      tool: opencode, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: undefined },
      start: toolLauncher((launch) => { launched = launch.args; return start(launch); }), interactive: false, host: { ...host, opencodeMajor: async () => major },
    });

    // `opencode run` of 2.2.5 without --standalone starts `opencode serve --service`, which outlives it with the step's env.
    expect(launched).toEqual(argv);
  });

  it('builds an OpenCode step it does not ask the version of for OpenCode V2, the version teamai takes when it reads none', async () => {
    const shipped = BUILT_IN_TOOLS.opencode.launch.opencode.step;
    const majors: number[] = [];
    const opencode = {
      name: 'opencode', family: 'opencode', executable: '/usr/bin/opencode',
      step: { ...shipped, args: (input, how) => { majors.push(how.opencodeMajor); return shipped.args(input, how); } },
    } as const satisfies Parameters<typeof runStepLaunch>[0]['tool'];
    const asked: string[] = [];
    let launched: string[] = [];
    const { start } = fakeLauncher([]);

    // Interactive, with no agent and no effort: nothing in the launch needs the version, so the launch reads none.
    await runStepLaunch({
      tool: opencode, input: { prompt: 'Fix it.', cwd: os.tmpdir(), resultPath: await resultPathIn(), secrets: {}, expected: undefined },
      start: toolLauncher((launch) => { launched = launch.args; return start(launch); }), interactive: true,
      host: { ...host, opencodeMajor: async (executable) => { asked.push(executable); return 1; } },
    });

    expect({ asked, majors, launched }).toEqual({ asked: [], majors: [2], launched: ['--prompt', 'Fix it.'] });
  });

  it.each([
    ['starts its tool anew', false, undefined],
    ['can attach to the tool an earlier launch began, whose result it is', true, { ok: true }],
  ])('reads a result file an earlier process left only when its start %s', async (_, canReattach, output) => {
    const resultPath = await resultPathIn();
    await fs.mkdir(path.dirname(resultPath));
    await fs.writeFile(resultPath, JSON.stringify({ output: { ok: true } }));
    const { start } = fakeLauncher([JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' })]);

    const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Review.', cwd: os.tmpdir(), resultPath, secrets: {}, expected: undefined }, start, canReattach, interactive: false, host });

    expect(ran).toMatchObject({ started: true, exitCode: 0 });
    expect('output' in ran ? ran.output : undefined).toEqual(output);
  });

  it('refuses a directory an earlier process left at its result path, as one its tool left', async () => {
    const resultPath = await resultPathIn();
    await fs.mkdir(resultPath, { recursive: true });
    const { start } = fakeLauncher([JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' })]);

    const ran = await runStepLaunch({ tool: claude, input: { prompt: 'Review.', cwd: os.tmpdir(), resultPath, secrets: {}, expected: undefined }, start, interactive: false, host });

    expect(ran).toMatchObject({ started: true, failure: { code: 'tool_failed', message: `claude left a directory at its result path, ${resultPath}, not a regular file, so teamai did not read it` } });
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO the tool left at its result path, without reading it', async () => {
    const resultPath = await resultPathIn();
    await fs.mkdir(path.dirname(resultPath));
    execFileSync('mkfifo', [resultPath]);
    const { start } = fakeLauncher([JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.' })]);
    const late = new Promise<'still waiting'>((resolve) => { setTimeout(() => resolve('still waiting'), 2_000).unref(); });

    const settled = await Promise.race([runStepLaunch({ tool: claude, input: { prompt: 'Review.', cwd: os.tmpdir(), resultPath, secrets: {}, expected: 'a summary' }, start, interactive: false, host }), late]);

    // A read the FIFO still holds ends once a writer opens it and closes, so a failing run leaves no stuck read.
    if (settled === 'still waiting') closeSync(openSync(resultPath, constants.O_WRONLY | constants.O_NONBLOCK));
    expect(settled).toMatchObject({ started: true, failure: { code: 'tool_failed', message: `claude left a pipe at its result path, ${resultPath}, not a regular file, so teamai did not read it` } });
    expect(written).toEqual([]);
  });
});

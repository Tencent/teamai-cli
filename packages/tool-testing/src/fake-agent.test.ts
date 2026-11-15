import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_AGENT_MARKERS, fakeAgent, leftFakeAgents, runFakeAgent, type FakeAgentRecording } from './fake-agent.js';

/** A tool that printed two lines for real: a start line, then its answer. */
const RECORDING: FakeAgentRecording = {
  executable: 'tool',
  version: 'tool 1.0.0',
  data: { answer: 'recorded answer' },
  script: String.raw`
  await say('start');
  if (does('hang')) return hang();
  if (does('fail')) { await say('error: recorded failure'); process.exit(1); }
  await say('answer: ' + (reply ?? data.answer));
  process.exit(0);
`,
};

const made: string[] = [];

afterEach(async () => {
  const left = await leftFakeAgents();

  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  expect(left, 'fake agents left running').toEqual([]);
});

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fa-')));

  made.push(dir);

  return dir;
}

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

describe('fakeAgent', () => {
  it('signals no pid below 2 that its pid list names, as a line read while a fake still wrote it can', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });
    // A whole record of pid 1, and a record of pid 0 cut where a fake was still writing it.
    fs.writeFileSync(path.join(cwd, 'b', 'tool.pids'), `${JSON.stringify({ pid: 1, spawnedAt: Date.now() })}\n{"pid":0,"spawned`);
    // Spied, so a regression reaches no process: pid 0 is this test run's own group, and 1 is init.
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(await agent.stopLeft()).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('kills no process whose pid a fake that ended recorded, once the system gave that pid to another process', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });
    // The record a fake that ended left, whose pid the system then gave to a process this fake never started.
    const ended = Date.now() - 60_000;
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => { other.on('exit', resolve); });
    fs.writeFileSync(path.join(cwd, 'b', 'tool.pids'), `${JSON.stringify({ pid: other.pid, spawnedAt: ended })}\n`);

    try {
      expect(await agent.stopLeft()).toEqual([]);
      expect(other.exitCode === null && other.signalCode === null, 'the other process still runs').toBe(true);
    } finally {
      other.kill('SIGKILL');
      await exited;
    }
  });

  it.skipIf(process.platform === 'win32')('kills a fake it left running, whoever started it', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });
    const left = spawn(agent.executable, [], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const ended = new Promise<NodeJS.Signals | null>((resolve) => { left.on('exit', (_code, signal) => resolve(signal)); });
    await new Promise((resolve) => { left.stdout.once('data', resolve); left.stdin.end(FAKE_AGENT_MARKERS.hang); });

    expect(await agent.stopLeft()).toEqual([left.pid]);
    expect(await ended).toBe('SIGKILL');
  });

  it('answers --version, records each call, and prints the recording', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });

    const version = await runFakeAgent(agent.executable, ['--version'], '', { cwd });
    const out = await runFakeAgent(agent.executable, ['-p'], 'Which runner?', { cwd });

    expect({ version: version.stdout, out }).toEqual({ version: 'tool 1.0.0\n', out: { stdout: 'start\nanswer: recorded answer\n', code: 0 } });
    expect(agent.calls()).toEqual([{ args: ['-p'], prompt: 'Which runner?', cwd }]);
  });

  it('replies with the first matching answer, else the default one', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), answer: 'default', answers: [{ when: 'color', answer: 'blue' }] });

    expect([(await runFakeAgent(agent.executable, [], 'Name one color.', { cwd })).stdout, (await runFakeAgent(agent.executable, [], 'Name a city.', { cwd })).stdout])
      .toEqual(['start\nanswer: blue\n', 'start\nanswer: default\n']);
  });

  it('lets a before script change the reply or exit on its own', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), before: "if (prompt.includes('stop')) { process.stderr.write('rate limited'); process.exit(3); } reply = prompt.toUpperCase();" });

    expect([await runFakeAgent(agent.executable, [], 'stop', { cwd }), await runFakeAgent(agent.executable, [], 'go', { cwd })])
      .toEqual([{ stdout: '', code: 3 }, { stdout: 'start\nanswer: GO\n', code: 0 }]);
  });

  it('fails as the recording failed when the prompt asks it to', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });

    expect(await runFakeAgent(agent.executable, [], `Go. ${FAKE_AGENT_MARKERS.fail}`, { cwd })).toEqual({ stdout: 'start\nerror: recorded failure\n', code: 1 });
  });

  it.each([
    ['as it starts', 0],
    // A machine under load can take longer than the wait to start the fake at all.
    ['when it starts slowly', 1_000],
  ])('goes silent after its first line when it hangs, until it is stopped, %s', async (_case, startMs) => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), always: ['hang'] });
    const slow = path.join(cwd, 'slow-start');
    fs.writeFileSync(slow, `#!/bin/sh\nsleep ${startMs / 1000}\nexec '${agent.executable}' "$@"\n`, { mode: 0o755 });

    expect(await runFakeAgent(slow, [], 'Go.', { cwd, stopAfterOutputMs: 800 })).toEqual({ stdout: 'start\n', code: null });
  });

  it('spaces its lines out when slow', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b'), slowMs: 300 });
    const begun = performance.now();

    await runFakeAgent(agent.executable, [], `Go. ${FAKE_AGENT_MARKERS.slow}`, { cwd });

    expect(performance.now() - begun).toBeGreaterThanOrEqual(600);
  });

  it('commits the prompt in its cwd when asked', async () => {
    const cwd = scratch();
    const agent = fakeAgent(RECORDING, { bin: path.join(cwd, 'b') });

    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'base'], { env: { ...process.env, ...GIT_ENV } });
    await runFakeAgent(agent.executable, [], `Change it. ${FAKE_AGENT_MARKERS.commit}`, { cwd, env: GIT_ENV });

    expect(execFileSync('git', ['-C', cwd, 'log', '--format=%s'], { encoding: 'utf8' }).trim().split('\n')).toEqual(['agent commit', 'base']);
  });
});

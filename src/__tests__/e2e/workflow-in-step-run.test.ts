/**
 * Real CLI: the run a command step's `teamai self-improvement run` starts is part of that step, so it ends with the
 * step: when the step times out, when the outer run is cancelled, and when the outer driver is killed and a later
 * `next` or `cancel` reads either run.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mayBeRunning, signalPid } from '@teamai/shared/process-group';
import { benchmarkFixture, envelope, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

/** The team's replacement of teamai-self-improvement: its one step writes its pid, then runs until it is stopped. */
const INNER = `schemaVersion: v1alpha1
name: teamai-self-improvement
description: Runs until it is stopped.
invoke: deny
inputs: { scorer: string, suite: string }
steps:
  - id: again
    command: node -e "require('fs').writeFileSync(process.env.FIXTURE_ROOT + '/inner.pid', String(process.pid)); setInterval(() => {}, 1000)"
`;

/** As INNER, with a step that ignores SIGTERM, so the driver that started it is killed before it stops the step. */
const STUBBORN_INNER = INNER.replace("setInterval(() => {}, 1000)", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");

/** A workflow whose command step runs the self-improvement shortcut, as part of the step. */
function outer(timeout?: string): string {
  return `schemaVersion: v1alpha1
name: outer
description: Improves the team's resources as one step.
steps:
  - id: work
    command: teamai self-improvement run quality --suite fix${timeout === undefined ? '' : `\n    timeout: ${timeout}`}
`;
}

const RunFileSchema = z.object({ name: z.string(), status: z.string(), steps: z.array(z.object({ id: z.string(), status: z.string(), failure: z.object({ code: z.string(), message: z.string() }).optional() })) });

const fixtures: BenchmarkFixture[] = [];
const started: ChildProcess[] = [];

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function fixtureWith(timeout?: string, inner = INNER): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false, tools: [], team: { 'workflows/outer.yaml': outer(timeout), 'workflows/teamai-self-improvement.yaml': inner } });
  fixtures.push(fixture);

  return fixture;
}

/** `teamai workflow start outer --driver local`, left running: the process is the CLI itself, as the shim execs it. */
function startOuter(fixture: BenchmarkFixture): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn(path.join(fixture.bin, 'teamai'), ['workflow', 'start', 'outer', '--driver', 'local'], { cwd: fixture.work, env: fixture.env, stdio: 'ignore' });
  started.push(child);

  return { child, exited: new Promise((resolve) => child.on('close', () => resolve())) };
}

async function until<T>(read: () => T | undefined, what: string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;

  for (;;) {
    const found = read();

    if (found !== undefined) return found;

    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Run `name`'s id and status, and why its first step ended, when it failed or was cancelled. */
function runNamed(fixture: BenchmarkFixture, name: string): { id: string; status: string; failure?: { code: string; message: string } } | undefined {
  for (const id of fixture.runIds()) {
    const run = RunFileSchema.safeParse(fixture.runFile(id));

    if (run.success && run.data.name === name) return { id, status: run.data.status, ...(run.data.steps[0]?.failure && { failure: run.data.steps[0].failure }) };
  }

  return undefined;
}

/** The pid the inner step wrote once it runs. */
function innerPid(fixture: BenchmarkFixture): number | undefined {
  const file = path.join(fixture.root, 'inner.pid');

  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : undefined;
}


describe('a run a command step started as part of the step', () => {
  it('is cancelled when the step times out, naming the step', async () => {
    const fixture = await fixtureWith('5s');

    const ran = await fixture.teamai(['workflow', 'start', 'outer', '--driver', 'local']);

    const top = runNamed(fixture, 'outer');
    expect(top, said(ran)).toMatchObject({ status: 'failed' });
    const inner = await until(() => {
      const found = runNamed(fixture, 'teamai-self-improvement');

      return found?.status === 'running' ? undefined : found;
    }, 'the inner run to end', 15_000).catch(() => runNamed(fixture, 'teamai-self-improvement'));
    expect(inner).toMatchObject({ status: 'cancelled', failure: { code: 'cancelled', message: `Ended: step work of run ${top?.id ?? ''} stopped (timeout)` } });
    const pid = innerPid(fixture);
    expect(pid).toBeDefined();
    await until(() => (mayBeRunning(pid ?? 0) ? undefined : true), 'the inner step to stop', 15_000);
  }, 180_000);

  it('is cancelled when teamai workflow cancel stops the outer run', async () => {
    const fixture = await fixtureWith();
    const { exited } = startOuter(fixture);
    const pid = await until(() => innerPid(fixture), 'the inner step to run');
    const top = runNamed(fixture, 'outer');

    const cancelled = await fixture.teamai(['workflow', 'cancel', top?.id ?? '']);
    await exited;

    expect(envelope(cancelled).data, said(cancelled)).toMatchObject({ run: { status: 'cancelled' } });
    const inner = await until(() => {
      const found = runNamed(fixture, 'teamai-self-improvement');

      return found?.status === 'running' ? undefined : found;
    }, 'the inner run to end', 15_000).catch(() => runNamed(fixture, 'teamai-self-improvement'));
    expect(inner).toMatchObject({ status: 'cancelled', failure: { message: `Ended: step work of run ${top?.id ?? ''} stopped (cancelled)` } });
    await until(() => (mayBeRunning(pid) ? undefined : true), 'the inner step to stop', 15_000);
  }, 180_000);

  it('has its step stopped when teamai workflow cancel stops the outer run and the step outlives the run\'s own driver', async () => {
    const fixture = await fixtureWith(undefined, STUBBORN_INNER);
    const { exited } = startOuter(fixture);
    const pid = await until(() => innerPid(fixture), 'the inner step to run');
    const top = runNamed(fixture, 'outer');

    await fixture.teamai(['workflow', 'cancel', top?.id ?? '']);
    await exited;

    expect(runNamed(fixture, 'teamai-self-improvement')).toMatchObject({ status: 'cancelled' });
    await until(() => (mayBeRunning(pid) ? undefined : true), 'the inner step to stop', 15_000).finally(() => {
      if (mayBeRunning(pid)) signalPid(pid, 'SIGKILL');
    });
  }, 180_000);

  it('is cancelled, and its step stopped, by a cancel of the outer run whose driver was killed', async () => {
    const fixture = await fixtureWith();
    const { child, exited } = startOuter(fixture);
    const pid = await until(() => innerPid(fixture), 'the inner step to run');
    const top = runNamed(fixture, 'outer');

    child.kill('SIGKILL');
    await exited;
    const cancelled = await fixture.teamai(['workflow', 'cancel', top?.id ?? '']);

    expect(envelope(cancelled).data, said(cancelled)).toMatchObject({ run: { status: 'cancelled' } });
    expect(runNamed(fixture, 'teamai-self-improvement')).toMatchObject({ status: 'cancelled', failure: { message: `Ended: step work of run ${top?.id ?? ''} stopped (cancelled)` } });
    await until(() => (mayBeRunning(pid) ? undefined : true), 'the inner step to stop', 15_000);
  }, 180_000);

  it('is cancelled by its own next once the step of an outer run whose driver was killed passed its timeout', async () => {
    const fixture = await fixtureWith('8s');
    const { child, exited } = startOuter(fixture);
    const pid = await until(() => innerPid(fixture), 'the inner step to run');
    const top = runNamed(fixture, 'outer');

    // The inner run's driver runs on in the killed driver's step, and reads its own run until it ends.
    child.kill('SIGKILL');
    await exited;

    const inner = await until(() => {
      const found = runNamed(fixture, 'teamai-self-improvement');

      return found?.status === 'running' ? undefined : found;
    }, 'the inner run to end', 30_000).catch(() => runNamed(fixture, 'teamai-self-improvement'));
    expect(inner).toMatchObject({ status: 'cancelled', failure: { message: `Ended: step work of run ${top?.id ?? ''} stopped (timeout)` } });
    await until(() => (mayBeRunning(pid) ? undefined : true), 'the inner step to stop', 15_000);
    expect(runNamed(fixture, 'outer')).toMatchObject({ status: 'running' });
  }, 180_000);
});

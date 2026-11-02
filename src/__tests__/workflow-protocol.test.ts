import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { inProcessClient, type WorkflowClient } from '../workflow/protocol.js';
import { readRun, RunIdSchema, withRunLock, type RunLock } from '../workflow/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

async function fixture(workflows: Record<string, string>): Promise<{ config: LocalConfig; checkout: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-protocol-')); dirs.push(root);
  const checkout = path.join(root, 'work');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'README.md'), 'hello\n');
  git(checkout, 'init', '-q', '-b', 'main'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(root, 'knowledge', 'workflows'), { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(root, 'knowledge', 'workflows', `${name}.yaml`), yaml);
  const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data') };
  await syncWorkflowDefinitions(config);
  return { config, checkout };
}

const CHECK = `schemaVersion: v1alpha1
name: check
description: Lint.
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const WIDE = `schemaVersion: v1alpha1
name: wide
description: Fan out, review, ship.
alias: fan
invoke: ask
inputs:
  targets: [string]
steps:
  - id: a
    command: echo a
  - id: b
    needs: []
    for_each: { items: inputs.targets, max_parallel: 2 }
    command: echo b
  - id: c
    needs: []
    for_each: { items: inputs.targets, max_parallel: 4 }
    command: echo c
  - id: review
    needs: [a, b, c]
    approve: Ship it?
    prompt: Review the change.
  - id: ship
    needs: [review]
    workspace: new
    command: echo ship
`;

async function protocol(config: LocalConfig): Promise<WorkflowClient> {
  return inProcessClient({ config, env: await resolveWorkflowEnv(config) });
}

const driver = { kind: 'skill', machine: 'test', workspace: '/work', can: { hitl: false, workspace: ['read-only'] } };

const LeaseSchema = z.object({ attempt: z.string(), revision: z.number() }).passthrough();

async function leased(config: LocalConfig, checkout: string): Promise<{ run: RunLock['run']; attempt: string; revision: number; lease: z.infer<typeof LeaseSchema> }> {
  const client = await protocol(config);
  const started = await client.start('check', { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
  if (!('data' in started)) throw new Error(JSON.stringify(started));
  const run = RunIdSchema.parse(started.data.run);
  const next = await client.next(run, { driver });
  if (!('data' in next) || !('lease' in next.data)) throw new Error(JSON.stringify(next));
  const lease = LeaseSchema.parse(next.data.lease);
  return { run, attempt: lease.attempt, revision: lease.revision, lease };
}

describe('workflow protocol in process', () => {
  it('describes a workflow before any run: inputs, invoke, gates, prompts, steps outside the checkout, and its width', async () => {
    const { config } = await fixture({ wide: WIDE });
    expect(await (await protocol(config)).describe('fan', { ceiling: 3, can: {} })).toEqual({ description: {
      name: 'wide', description: 'Fan out, review, ship.', alias: 'fan', invoke: 'ask', source: 'team', inputs: { targets: { type: 'array', items: { type: 'string' } } },
      facts: { prompts: ['review'], interactive: [], modeled: [], width: 3, gates: [{ step: 'review', kind: 'approve', required: false, guards: { kind: 'prompt' } }], inWorkspace: ['ship'], scored: [],
        deliver: [], requiresEnv: { keys: [], missingHere: [], declaredHere: [] }, budgets: [], held: [],
        runs: [
          { step: 'a', executor: 'command', env: [] }, { step: 'b', executor: 'command', env: [] }, { step: 'c', executor: 'command', env: [] },
          { step: 'review', executor: 'prompt', env: [] }, { step: 'ship', executor: 'command', env: [] },
        ] },
    }, judging: { kind: 'none' } });
    expect(await (await protocol(config)).describe('wide', { ceiling: 20, can: {} })).toMatchObject({ description: { facts: { width: 7 } } });
  });

  it('counts a for_each with no max_parallel as wide as the ceiling, and one command as one', async () => {
    const each = CHECK.replace('name: check', 'name: each\ninputs:\n  targets: [string]').replace('  - id: lint\n', '  - id: lint\n    for_each: inputs.targets\n');
    const { config } = await fixture({ check: CHECK, each });
    expect(await (await protocol(config)).describe('each', { ceiling: 5, can: {} })).toMatchObject({ description: { facts: { width: 5 } } });
    expect(await (await protocol(config)).describe('check', { ceiling: 5, can: {} })).toMatchObject({ description: { invoke: 'deny', facts: { width: 1, prompts: [], interactive: [], gates: [], inWorkspace: [] } } });
  });

  it('answers workflow_not_found for a name with no runnable version', async () => {
    const { config } = await fixture({ check: CHECK });
    expect(await (await protocol(config)).describe('missing', { ceiling: 3, can: {} })).toEqual({ error: { code: 'workflow_not_found', message: 'Workflow or alias missing has no unambiguous runnable version' } });
  });

  it('refuses a start inside a workflow attempt before it looks the workflow up, and an answer from it', async () => {
    const { config } = await fixture({ check: CHECK });
    const client = await protocol(config);
    const nested = { code: 'nested_workflow', message: "This process runs inside workflow attempt r0123456789abcdef/a0000000a (TEAMAI_WORKFLOW_ATTEMPT is set), so it cannot start or drive a workflow run. Do the step's own work here; to run another workflow as part of a run, add it to the definition as a workflow step." };
    const caller = { evidence: { kind: 'attempt', attempt: 'r0123456789abcdef/a0000000a' }, confirmed: true, mode: 'attended' } as const;
    expect(await client.start('missing', { caller })).toEqual({ error: nested });
    expect(await client.respond('r0123456789abcdef', 'lint', 'yes', { via: { kind: 'process', caller: { tty: true, evidence: caller.evidence } } })).toEqual({ error: nested });
  });

  it('fails a reader step that changed the checkout it was prepared in, when its report says it succeeded', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, attempt, revision, lease } = await leased(config, checkout);
    const client = await protocol(config);
    const answer = await withRunLock(config, run, async (lock) => {
      expect(await client.prepare(lock, lease)).toEqual({ kind: 'prepared', dir: checkout });
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed\n');
      return client.report(run, { attempt, revision, outcome: 'success', driver }, { lock });
    }, { waitMs: 0 });
    expect(answer).toMatchObject({ data: { accepted: true, step: { id: 'lint', status: 'failed' } } });
    const stored = await readRun(config, run);
    expect(typeof stored === 'object' && stored.steps[0]).toMatchObject({ failure: { code: 'read_only_dirty', message: 'Read-only command step changed repository paths: README.md' } });
  });

  it('keeps the first snapshot when an attempt is prepared again, so a change made in between still fails it', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, attempt, revision, lease } = await leased(config, checkout);
    const client = await protocol(config);
    await withRunLock(config, run, (lock) => client.prepare(lock, lease), { waitMs: 0 });
    fs.writeFileSync(path.join(checkout, 'new.txt'), 'new\n');
    await withRunLock(config, run, (lock) => client.prepare(lock, lease), { waitMs: 0 });
    expect(await client.report(run, { attempt, revision, outcome: 'success', driver })).toMatchObject({ data: { step: { status: 'failed' } } });
  });

  it('does not check a reader step that failed, so it keeps its own failure', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, attempt, revision, lease } = await leased(config, checkout);
    const client = await protocol(config);
    await withRunLock(config, run, async (lock) => {
      await client.prepare(lock, lease);
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed\n');
      return client.report(run, { attempt, revision, outcome: 'failed', driver, message: 'command exited with status 1', failure: { code: 'command_failed', message: 'command exited with status 1' } }, { lock });
    }, { waitMs: 0 });
    const stored = await readRun(config, run);
    expect(typeof stored === 'object' && stored.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'command_failed' } });
  });

  it('refuses to prepare an attempt the run has not leased', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, lease } = await leased(config, checkout);
    const client = await protocol(config);
    const other = { ...lease, attempt: 'a00000000' };
    expect(await withRunLock(config, run, (lock) => client.prepare(lock, other), { waitMs: 0 }))
      .toEqual({ kind: 'failed', failure: { code: 'wrong_attempt', message: 'Attempt a00000000 is not the leased attempt' } });
  });
});

describe('the run lock', () => {
  it('waits up to waitMs for the holder to release it, and answers driver_running past that', async () => {
    const { config } = await fixture({ check: CHECK });
    const run = RunIdSchema.parse('r0123abcd');
    let release = (): void => {};
    let entered = (): void => {};
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = withRunLock(config, run, () => new Promise<string>((resolve) => { release = () => resolve('first'); entered(); }), { waitMs: 0 });
    await inside;
    expect(await withRunLock(config, run, async () => 'second', { waitMs: 0 })).toEqual({ error: {
      code: 'driver_running', message: `Run ${run} is already driven by process ${process.pid} on this machine. Stop that driver, or wait for it.`,
    } });
    const waiting = withRunLock(config, run, async (lock) => lock.run, { waitMs: 5_000 });
    setTimeout(release, 200);
    expect(await held).toBe('first');
    expect(await waiting).toBe(run);
  });
});

const REPORTED = `schemaVersion: v1alpha1
name: reported
description: Work, then report and tidy whatever happened.
steps:
  - id: work
    command: node -e "process.exit(0)"
finally:
  - id: report
    command: node -e "process.exit(0)"
    output: { text: string }
  - id: tidy
    needs: []
    command: node -e "process.exit(0)"
    output: { freed: number }
outputs:
  text: steps.report.outputs.text
  freed: steps.tidy.outputs.freed
`;

describe('finally steps', () => {
  const other = { ...driver, machine: 'other' };
  const failure = { code: 'command_failed', message: 'command exited with status 1' };

  async function startReported(config: LocalConfig, checkout: string): Promise<{ client: WorkflowClient; run: string }> {
    const client = await protocol(config);
    const started = await client.start('reported', { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in started)) throw new Error(JSON.stringify(started));
    return { client, run: RunIdSchema.parse(started.data.run) };
  }

  async function lease(client: WorkflowClient, run: string, by = driver): Promise<z.infer<typeof LeaseSchema>> {
    const next = await client.next(run, { driver: by });
    if (!('data' in next) || !('lease' in next.data)) throw new Error(JSON.stringify(next));
    return LeaseSchema.parse(next.data.lease);
  }

  it('keeps a run whose steps failed running while any driver runs its finally steps, then ends it failed with what they returned', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const { client, run } = await startReported(config, checkout);
    const work = await lease(client, run);
    await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'failed', driver, message: failure.message, failure });

    const before = Date.now();
    const report = await lease(client, run, other);
    expect(report).toMatchObject({ step: 'report' });
    const stored = await readRun(config, run);
    if (typeof stored !== 'object') throw new Error(stored);
    expect(stored).toMatchObject({ status: 'running', finalizing: { outcome: 'failed' } });
    const until = Date.parse(stored.finalizing?.until ?? '');
    expect(until - before).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(until - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    await client.report(run, { attempt: report.attempt, revision: report.revision, outcome: 'success', driver: other, outputs: { text: 'two steps, one failed' } });
    const tidy = await lease(client, run, other);
    expect(tidy).toMatchObject({ step: 'tidy' });
    await client.report(run, { attempt: tidy.attempt, revision: tidy.revision, outcome: 'failed', driver: other, message: failure.message, failure });

    expect(await client.next(run, { driver: other })).toMatchObject({ data: { done: {
      outcome: 'failed',
      outputs: { text: 'two steps, one failed' },
      finally: [{ id: 'tidy', outcome: 'failed', failure }],
    } } });
    const done = await client.next(run, { driver: other });
    expect('data' in done && done.data.done).not.toHaveProperty('outputs.freed');
    expect('data' in done && done.data.done).not.toHaveProperty('failure');
  });

  it('ends a run whose steps succeeded as succeeded, though a finally step failed', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const { client, run } = await startReported(config, checkout);
    const work = await lease(client, run);
    await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    const report = await lease(client, run);
    await client.report(run, { attempt: report.attempt, revision: report.revision, outcome: 'failed', driver, message: failure.message, failure });
    const tidy = await lease(client, run);
    await client.report(run, { attempt: tidy.attempt, revision: tidy.revision, outcome: 'success', driver, outputs: { freed: 3 } });

    expect(await client.next(run, { driver })).toMatchObject({ data: { done: {
      run, outcome: 'succeeded', outputs: { freed: 3 }, finally: [{ id: 'report', outcome: 'failed', failure }],
    } } });
  });

  it('runs the finally steps of a cancelled run, which ends cancelled', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const { client, run } = await startReported(config, checkout);
    await lease(client, run);
    expect(await client.cancel(run)).toMatchObject({ data: { run: { status: 'running', finalizing: { outcome: 'cancelled' } } } });
    for (const step of ['report', 'tidy']) {
      const held = await lease(client, run);
      expect(held).toMatchObject({ step });
      await client.report(run, { attempt: held.attempt, revision: held.revision, outcome: 'success', driver, outputs: step === 'report' ? { text: 'cancelled' } : { freed: 0 } });
    }
    const done = await client.next(run, { driver });
    expect(done).toMatchObject({ data: { done: { outcome: 'cancelled', outputs: { text: 'cancelled', freed: 0 } } } });
    expect('data' in done && done.data.done).not.toHaveProperty('finally');
  });

  it('ends every unfinished finally step, leased or not, when the run is cancelled while they run, and keeps its outcome', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const { client, run } = await startReported(config, checkout);
    const work = await lease(client, run);
    await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    const report = await lease(client, run);

    expect(await client.cancel(run)).toMatchObject({ data: { cancelled: { steps: ['report', 'tidy'] }, run: { status: 'succeeded' } } });
    expect(await client.report(run, { attempt: report.attempt, revision: report.revision, outcome: 'success', driver, outputs: { text: 'late' } }))
      .toMatchObject({ error: { code: 'lease_cancelled' } });
    const cancelled = { code: 'cancelled', message: 'Cancelled by teamai workflow cancel' };
    const done = await client.next(run, { driver });
    expect(done).toMatchObject({ data: { done: {
      outcome: 'succeeded', finally: [{ id: 'report', outcome: 'cancelled', failure: cancelled }, { id: 'tidy', outcome: 'cancelled', failure: cancelled }],
    } } });
    expect('data' in done && done.data.done).not.toHaveProperty('outputs.text');
  });

  it('cancels one finally step by id as the steps of the run end, and runs the others', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const { client, run } = await startReported(config, checkout);
    const work = await lease(client, run);
    await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    expect(await client.cancel(run, 'report')).toMatchObject({ data: { cancelled: { steps: ['report'] }, run: { status: 'running', finalizing: { outcome: 'succeeded' } } } });
    const tidy = await lease(client, run);
    expect(tidy).toMatchObject({ step: 'tidy' });
    await client.report(run, { attempt: tidy.attempt, revision: tidy.revision, outcome: 'success', driver, outputs: { freed: 2 } });
    expect(await client.next(run, { driver })).toMatchObject({ data: { done: {
      outcome: 'succeeded', outputs: { freed: 2 }, finally: [{ id: 'report', outcome: 'cancelled', failure: { code: 'cancelled' } }],
    } } });
  });

  it('ends a run at the end its steps reached, after its finally steps', async () => {
    const ended = REPORTED.replace('name: reported', 'name: ended').replace('steps:\n  - id: work\n', 'ends: { blocked: failed }\nsteps:\n  - id: work\n    end: blocked\n');
    const { config, checkout } = await fixture({ ended });
    const client = await protocol(config);
    const started = await client.start('ended', { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in started)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.run);
    const work = await lease(client, run);
    await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    for (const step of ['report', 'tidy']) {
      const held = await lease(client, run);
      expect(held).toMatchObject({ step });
      await client.report(run, { attempt: held.attempt, revision: held.revision, outcome: 'success', driver, outputs: step === 'report' ? { text: 'blocked' } : { freed: 0 } });
    }
    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'failed', end: 'blocked', outputs: { text: 'blocked' } } } });
  });

  it('returns an output its step gave as null, and leaves out one a skipped step did not give', async () => {
    const nulled = `schemaVersion: v1alpha1
name: nulled
description: Give an output as null, and skip the step that gives another.
steps:
  - id: emit
    command: node -e "process.exit(0)"
    output: { value: json }
  - id: skipped
    needs: [emit]
    if: steps.emit.outcome == 'failed'
    command: node -e "process.exit(0)"
    output: { other: json }
outputs:
  value: steps.emit.outputs.value
  other: steps.skipped.outputs.other
`;
    const { config, checkout } = await fixture({ nulled });
    const client = await protocol(config);
    const started = await client.start('nulled', { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in started)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.run);
    const emit = await lease(client, run);
    await client.report(run, { attempt: emit.attempt, revision: emit.revision, outcome: 'success', driver, outputs: { value: null } });

    const done = await client.next(run, { driver });
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { value: null } } } });
    expect('data' in done && done.data.done).not.toHaveProperty('outputs.other');
  });

  it('runs the finally steps again when a retry reopens the run, and ends it by its steps alone', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const { client, run } = await startReported(config, checkout);
    const runSteps = async (outcome: 'success' | 'failed', text: string): Promise<void> => {
      const work = await lease(client, run);
      await client.report(run, { attempt: work.attempt, revision: work.revision, outcome, driver, ...(outcome === 'failed' ? { message: failure.message, failure } : {}) });
      const report = await lease(client, run);
      await client.report(run, { attempt: report.attempt, revision: report.revision, outcome: 'success', driver, outputs: { text } });
      const tidy = await lease(client, run);
      await client.report(run, outcome === 'failed'
        ? { attempt: tidy.attempt, revision: tidy.revision, outcome: 'failed', driver, message: failure.message, failure }
        : { attempt: tidy.attempt, revision: tidy.revision, outcome: 'success', driver, outputs: { freed: 1 } });
    };
    // The first pass's tidy fails too; the run that the retry reopens ends by its steps alone.
    await runSteps('failed', 'first');
    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'failed', outputs: { text: 'first' }, finally: [{ id: 'tidy' }] } } });

    expect(await client.retry(run, 'work')).toMatchObject({ data: { reopened: true } });
    await runSteps('success', 'second');
    expect(await client.next(run, { driver })).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { text: 'second', freed: 1 } } } });
  });

  it('runs the finally steps of a run that timed out under a deadline of their own, and ends it timed out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const { config, checkout } = await fixture({ reported: REPORTED.replace('steps:\n', 'timeout: 1m\nsteps:\n') });
      const { client, run } = await startReported(config, checkout);
      await lease(client, run);
      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
      const report = await lease(client, run);
      expect(report).toMatchObject({ step: 'report', expiresAt: '2026-01-01T00:12:00.000Z' });
      await client.report(run, { attempt: report.attempt, revision: report.revision, outcome: 'success', driver, outputs: { text: 'timed out' } });
      const tidy = await lease(client, run);
      await client.report(run, { attempt: tidy.attempt, revision: tidy.revision, outcome: 'success', driver, outputs: { freed: 1 } });
      expect(await client.next(run, { driver })).toMatchObject({ data: { done: {
        outcome: 'failed', failure: { code: 'timeout' }, outputs: { text: 'timed out', freed: 1 },
      } } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the finally steps still unfinished when their deadline passes, and keeps the run\'s outcome', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const { config, checkout } = await fixture({ reported: REPORTED });
      const { client, run } = await startReported(config, checkout);
      const work = await lease(client, run);
      await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
      await lease(client, run);
      vi.setSystemTime(new Date('2026-01-01T00:10:01.000Z'));
      const done = await client.next(run, { driver });
      expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', finally: [
        { id: 'report', outcome: 'cancelled', failure: { code: 'timeout' } },
        { id: 'tidy', outcome: 'cancelled', failure: { code: 'timeout' } },
      ] } } });
      expect('data' in done && done.data.done).not.toHaveProperty('failure');
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('a finally step in the checkout', () => {
  it('fails a finally step that changed the checkout, as any read-only command', async () => {
    const { config, checkout } = await fixture({ reported: REPORTED });
    const client = await protocol(config);
    const started = await client.start('reported', { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
    if (!('data' in started)) throw new Error(JSON.stringify(started));
    const run = RunIdSchema.parse(started.data.run);
    const leaseOf = async (): Promise<z.infer<typeof LeaseSchema>> => {
      const next = await client.next(run, { driver });
      if (!('data' in next) || !('lease' in next.data)) throw new Error(JSON.stringify(next));
      return LeaseSchema.parse(next.data.lease);
    };
    const work = await leaseOf();
    await client.report(run, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver });
    const report = await leaseOf();
    const answer = await withRunLock(config, run, async (lock) => {
      expect(await client.prepare(lock, report)).toEqual({ kind: 'prepared', dir: checkout });
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed\n');
      return client.report(run, { attempt: report.attempt, revision: report.revision, outcome: 'success', driver, outputs: { text: 'done' } }, { lock });
    }, { waitMs: 0 });
    expect(answer).toMatchObject({ data: { accepted: true, step: { id: 'report', status: 'failed', failure: { code: 'read_only_dirty' } } } });
  });
});

describe('the run timeout a start gives', () => {
  it('ends the run at the shorter of the workflow timeout and the one its start gave', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const { config, checkout } = await fixture({ check: CHECK, slow: CHECK.replace('name: check', 'name: slow\ntimeout: 1h') });
      const client = await protocol(config);
      const caller = { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } as const;
      const deadlineOf = async (name: string, timeout: number): Promise<unknown> => {
        const started = await client.start(name, { checkout, caller, timeout });
        if (!('data' in started)) throw new Error(JSON.stringify(started));
        const next = await client.next(RunIdSchema.parse(started.data.run), { driver });
        return 'data' in next && 'lease' in next.data ? LeaseSchema.parse(next.data.lease).expiresAt : next;
      };
      expect(await deadlineOf('check', 90_000)).toBe('2026-01-01T00:01:30.000Z');
      expect(await deadlineOf('slow', 2 * 3_600_000)).toBe('2026-01-01T01:00:00.000Z');
      expect(await deadlineOf('slow', 60_000)).toBe('2026-01-01T00:01:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

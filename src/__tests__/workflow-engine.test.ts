import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseReport, reportAttempt, SETTLED_ATTEMPTS_LIMIT, startRun, type ReportInput } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import { outputMismatch } from '../workflow/output.js';
import { pendingRecords, type WorkflowRunRecord } from '../workflow/records.js';
import { readRun, runLockPath, writeRun } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];

function testConfig(): { config: LocalConfig; work: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-engine-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  return {
    work,
    config: {
      repo: { localPath: knowledge, remote: 'local', kind: 'self' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: root,
      dataHome: path.join(root, 'data'),
    },
  };
}

const driverA: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };
const driverB: DriverIdentity = { kind: 'external', machine: 'b', workspace: '/work' };

async function startBuild(body: string): Promise<{ config: LocalConfig; work: string; runId: string }> {
  const fixture = testConfig();
  fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), body);
  await syncWorkflowDefinitions(fixture.config);
  const started = await startRun(fixture.config, 'build');
  if ('error' in started) throw new Error(started.error.message);
  return { ...fixture, runId: String(started.data.run) };
}

const TWO_STEPS = `schemaVersion: v1alpha1
name: build
description: Two commands.
steps:
  - id: one
    command: node one.js
  - id: two
    needs: [one]
    command: node two.js
    output:
      ok: boolean
`;

/** Drives a run with next and report, failing the steps in `failing`. Returns the leased step ids and the done envelope. */
async function drive(config: LocalConfig, runId: string, failing: string[] = []): Promise<{ leased: string[]; done: unknown }> {
  const leased: string[] = [];
  for (;;) {
    const next = await leaseNext(config, runId, driverA);
    if ('error' in next) throw new Error(next.error.message);
    if (next.data.done) return { leased, done: next.data.done };
    const lease = next.data.lease as { step: string; attempt: string; revision: number };
    leased.push(lease.step);
    const reported = await reportAttempt(config, runId, {
      attempt: lease.attempt,
      revision: lease.revision,
      outcome: failing.includes(lease.step) ? 'failed' : 'success',
      driver: driverA,
    });
    if ('error' in reported) throw new Error(reported.error.message);
  }
}

function graph(steps: string, header = ''): string {
  return `schemaVersion: v1alpha1
name: build
description: A needs graph.
${header}steps:
${steps}`;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow engine', () => {
  it('parses and stores tool report metadata', async () => {
    const parsed = parseReport({
      attempt: 'a00000000',
      revision: 1,
      outcome: 'success',
      driver: driverA,
      tool: 'claude',
      model: 'sonnet',
      session: 'session-1',
      tokens: { input: 2, output: 1, cachedInput: 1 },
      failure: { code: 'tool_failed', message: 'failed' },
    });
    expect(parsed).toMatchObject({ tool: 'claude', model: 'sonnet', session: 'session-1', tokens: { input: 2 } });
    expect(parseReport({
      attempt: 'a00000000',
      revision: 1,
      outcome: 'success',
      driver: driverA,
      tokens: { input: Number.NaN },
    })).toBe('tokens.input must be a finite number');
  });

  it('leases steps in order and stores the outcome', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const first = await leaseNext(config, runId, driverA);
    expect(first).toMatchObject({ data: { lease: { step: 'one', revision: 1 } } });
    if ('error' in first) return;
    const attempt = String((first.data.lease as { attempt: string }).attempt);
    const accepted = await reportAttempt(config, runId, {
      attempt, revision: 1, outcome: 'success', driver: driverA, exitCode: 0,
    });
    expect(accepted).toMatchObject({ data: { accepted: true, revision: 2, step: { status: 'succeeded' } } });

    const second = await leaseNext(config, runId, driverA);
    if ('error' in second) throw new Error(second.error.message);
    const nextAttempt = String((second.data.lease as { attempt: string }).attempt);
    await reportAttempt(config, runId, {
      attempt: nextAttempt,
      revision: 2,
      outcome: 'success',
      driver: driverA,
      outputs: { ok: true },
    });
    const done = await leaseNext(config, runId, driverA);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'succeeded', steps: [{ outcome: 'success' }, { outcome: 'success', outputs: { ok: true } }] });
  });

  it('returns a released step to pending without ending the run', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const attempt = String((leased.data.lease as { attempt: string }).attempt);
    const released = await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'released', driver: driverA });
    expect(released).toMatchObject({ data: { accepted: true, step: { status: 'pending', outcome: 'released' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'running', revision: 2, steps: [{ status: 'pending', outcome: 'released' }, { status: 'pending' }] });

    const again = await leaseNext(config, runId, driverA);
    expect(again).toMatchObject({ data: { lease: { step: 'one', revision: 2 } } });
    if ('error' in again) return;
    expect((again.data.lease as { attempt: string }).attempt).not.toBe(attempt);
  });

  it('skips the steps after a failed step and fails the run', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    await reportAttempt(config, runId, {
      attempt: String((leased.data.lease as { attempt: string }).attempt),
      revision: 1,
      outcome: 'failed',
      driver: driverA,
      exitCode: 2,
    });
    const done = await leaseNext(config, runId, driverA);
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'failed', steps: [{ status: 'failed' }, { status: 'skipped' }] });
  });

  it('stamps updatedAt when next settles the run after a failed report', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const failing = await startBuild(TWO_STEPS);
      const leased = await leaseNext(failing.config, failing.runId, driverA);
      if ('error' in leased) throw new Error(leased.error.message);
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await reportAttempt(failing.config, failing.runId, {
        attempt: String((leased.data.lease as { attempt: string }).attempt),
        revision: 1,
        outcome: 'failed',
        driver: driverA,
      });
      expect(await readRun(failing.config, failing.runId)).toMatchObject({ status: 'running' });
      vi.setSystemTime(new Date('2026-01-01T00:01:30.000Z'));
      await leaseNext(failing.config, failing.runId, driverA);
      expect(await readRun(failing.config, failing.runId)).toMatchObject({
        status: 'failed',
        updatedAt: '2026-01-01T00:01:30.000Z',
      });

      const finishing = await startBuild(TWO_STEPS);
      const stored = await readRun(finishing.config, finishing.runId);
      if (typeof stored !== 'object') throw new Error('run missing');
      stored.steps = stored.steps.map((step) => ({ ...step, status: 'succeeded', outcome: 'success' }));
      await writeRun(finishing.config, stored);
      vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
      await leaseNext(finishing.config, finishing.runId, driverA);
      expect(await readRun(finishing.config, finishing.runId)).toMatchObject({
        status: 'succeeded',
        updatedAt: '2026-01-01T00:02:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects stale, repeated, wrong-attempt, and wrong-driver reports', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const attempt = String((leased.data.lease as { attempt: string }).attempt);

    expect(await reportAttempt(config, runId, { attempt: 'a00000000', revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'wrong_attempt' } });
    expect(await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverB }))
      .toMatchObject({ error: { code: 'wrong_driver' } });

    await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverA });
    expect(await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt, revision: 2, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt: 'a00000001', revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'stale_revision' } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ revision: 2, steps: [{ status: 'succeeded' }, { status: 'pending' }] });
  });

  it('accepts extra keys on a shorthand object output', async () => {
    expect(outputMismatch(
      { type: 'object', fields: { ok: { type: 'boolean' }, nested: { type: 'object', fields: { n: { type: 'number' } } } } },
      { ok: true, extra: 'kept', nested: { n: 1, more: true } },
    )).toBeNull();
    expect(outputMismatch({ type: 'object', fields: { ok: { type: 'boolean' } } }, { extra: true }))
      .toBe('output.ok is missing');

    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    await reportAttempt(config, runId, {
      attempt: String((leased.data.lease as { attempt: string }).attempt),
      revision: 1,
      outcome: 'success',
      driver: driverA,
    });
    const second = await leaseNext(config, runId, driverA);
    if ('error' in second) throw new Error(second.error.message);
    const accepted = await reportAttempt(config, runId, {
      attempt: String((second.data.lease as { attempt: string }).attempt),
      revision: 2,
      outcome: 'success',
      driver: driverA,
      outputs: { ok: true, note: 'extra' },
    });
    expect(accepted).toMatchObject({ data: { accepted: true, step: { status: 'succeeded', outcome: 'success' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ steps: [{ status: 'succeeded' }, { outputs: { ok: true, note: 'extra' } }] });
  });

  it('settles a running run with no pending steps from the step statuses', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    stored.steps = [
      { id: 'one', status: 'failed', outcome: 'failed' },
      { id: 'two', status: 'succeeded', outcome: 'success' },
    ];
    await writeRun(config, stored);

    const done = await leaseNext(config, runId, driverA);

    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ status: 'failed' });
  });

  it('keeps settledAttempts bounded across a release loop', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const attempts: string[] = [];
    for (let i = 0; i < SETTLED_ATTEMPTS_LIMIT + 5; i += 1) {
      const leased = await leaseNext(config, runId, driverA);
      if ('error' in leased) throw new Error(leased.error.message);
      const lease = leased.data.lease as { attempt: string; revision: number };
      attempts.push(lease.attempt);
      const released = await reportAttempt(config, runId, {
        attempt: lease.attempt,
        revision: lease.revision,
        outcome: 'released',
        driver: driverA,
      });
      expect(released).toMatchObject({ data: { accepted: true } });
    }

    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.settledAttempts).toHaveLength(SETTLED_ATTEMPTS_LIMIT);
    expect(stored.settledAttempts).not.toContain(attempts[0]);
    expect(stored.settledAttempts).toContain(attempts.at(-1));
    expect(stored.status).toBe('running');

    const latest = attempts.at(-1) ?? '';
    expect(await reportAttempt(config, runId, { attempt: latest, revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt: latest, revision: stored.revision, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'repeated_report' } });
    expect(await reportAttempt(config, runId, { attempt: attempts[0] ?? '', revision: 1, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'stale_revision' } });
    expect(await reportAttempt(config, runId, { attempt: attempts[0] ?? '', revision: stored.revision, outcome: 'success', driver: driverA }))
      .toMatchObject({ error: { code: 'wrong_attempt' } });

    const after = await readRun(config, runId);
    expect(after).toMatchObject({
      status: 'running',
      revision: stored.revision,
      settledAttempts: stored.settledAttempts,
    });
  });

  it('keeps the lease on disk after next returns', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const attempt = String((leased.data.lease as { attempt: string }).attempt);
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({
      steps: [
        { status: 'leased', lease: { attempt, revision: 1, driver: driverA } },
        { status: 'pending' },
      ],
    });
    const accepted = await reportAttempt(config, runId, { attempt, revision: 1, outcome: 'success', driver: driverA });
    expect(accepted).toMatchObject({ data: { accepted: true } });
  });

  it('does not lease a step while another process holds the run lock', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const lock = runLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    try {
      const blocked = await leaseNext(config, runId, driverA);
      expect(blocked).toMatchObject({ error: { code: 'busy' } });
    } finally {
      await releaseLock(lock);
    }
    const leased = await leaseNext(config, runId, driverA);
    expect(leased).toMatchObject({ data: { lease: { step: 'one' } } });
  });

  it('does not let two concurrent callers lease the same step', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const [left, right] = await Promise.all([
      leaseNext(config, runId, driverA),
      leaseNext(config, runId, driverB),
    ]);
    const leases = [left, right].filter((result) => 'data' in result && 'lease' in result.data);
    const waits = [left, right].filter((result) => 'data' in result && 'wait' in result.data);
    expect(leases).toHaveLength(1);
    expect(waits).toHaveLength(1);
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.steps.filter((step) => step.status === 'leased')).toHaveLength(1);
    expect(new Set(stored.steps.map((step) => step.lease?.attempt).filter(Boolean)).size).toBe(1);
  });

  it('runs one command at a time through the same next and report operations', async () => {
    const { config, work, runId } = await startBuild(TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "require('fs').writeFileSync('step-one.txt', '1')\n");
    fs.writeFileSync(path.join(work, 'two.js'), [
      "const fs = require('fs')",
      "if (fs.readFileSync('step-one.txt', 'utf8') !== '1') process.exit(1)",
      "fs.writeFileSync('step-two.txt', '2')",
      "process.stdout.write(JSON.stringify({ ok: true }))",
      '',
    ].join('\n'));

    const done = await runLocalDriver(config, runId, work);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', run: runId } } });
    expect(fs.readFileSync(path.join(work, 'step-two.txt'), 'utf8')).toBe('2');
  });

  // #1083: run records publish at start and end; a publication failure is
  // queued durably and surfaced as `record: pending`, never failing the run.
  it('surfaces record publication state on start and done envelopes', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    // The fixture has no reports remote, so publication cannot succeed —
    // the run must still start, and the record must be queued for the next
    // pull.
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    const { pendingRecords } = await import('../workflow/records.js');
    const queued = await pendingRecords(config);
    expect(queued).toHaveLength(1);
    expect(queued[0].phase).toBe('start');
    expect(queued[0].run).toBe(runId);
    // A machine that dies after start stays visible as started-but-not-ended:
    // the queued record has no endedAt and status running.
    expect(queued[0].status).toBe('running');
    expect(queued[0]).not.toHaveProperty('endedAt');
    // The driver workspace never crosses into the record.
    expect(JSON.stringify(queued)).not.toContain('/work');
  });

  it('queues an end record on the next that settles a run after a failed report (#1126 P1)', async () => {
    const failing = `schemaVersion: v1alpha1
name: build
description: One command.
steps:
  - id: one
    command: node one.js
`;
    const { config, runId } = await startBuild(failing);
    const { pendingRecords } = await import('../workflow/records.js');
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const lease = leased.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: driverA });
    // A failed report does not settle the run; the next `next` does.
    expect((await pendingRecords(config)).find((record) => record.phase === 'end')).toBeUndefined();

    const done = await leaseNext(config, runId, driverA);
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const end = (await pendingRecords(config)).find((record) => record.phase === 'end');
    expect(end).toBeDefined();
    expect(end!.status).toBe('failed');
    expect(end!.stepCounts).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 0 });
  });

  it('queues an end record when the run settles', async () => {
    const { config, work, runId } = await startBuild(TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    fs.writeFileSync(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    const done = await runLocalDriver(config, runId, work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const { pendingRecords } = await import('../workflow/records.js');
    const queued = await pendingRecords(config);
    const end = queued.find((record) => record.phase === 'end');
    expect(end).toBeDefined();
    expect(end!.status).toBe('succeeded');
    expect(end!.stepCounts).toEqual({ total: 2, succeeded: 2, failed: 0, skipped: 0 });
  });

  it('passes env to a command as variables over the inherited environment, never as shell', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: label
    command: node -e "require('fs').writeFileSync('title.txt', process.env.TITLE + '|' + (process.env.PATH && 'inherited'))"
    env:
      TITLE: "{{ inputs.title }}"
`, 'inputs:\n  title: string\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { title: '$(touch pwned)' });
    if ('error' in started) throw new Error(started.error.message);

    const done = await runLocalDriver(fixture.config, String(started.data.run), fixture.work);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(fixture.work, 'title.txt'), 'utf8')).toBe('$(touch pwned)|inherited');
    expect(fs.existsSync(path.join(fixture.work, 'pwned'))).toBe(false);
  });

  it('skips a step whose dependency failed and still runs an independent branch', async () => {
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: test
    needs: [build]
    command: node test.js
  - id: docs
    needs: []
    command: node docs.js
`));

    const { leased, done } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      status: 'failed',
      steps: [{ id: 'build', status: 'failed' }, { id: 'test', status: 'skipped' }, { id: 'docs', status: 'succeeded' }],
    });
  });

  it.each([
    ['linear', `  - id: a
    command: node a.js
  - id: b
    needs: [a]
    command: node b.js
  - id: c
    needs: [b]
    command: node c.js
`, ['a', 'b', 'c']],
    ['diamond', `  - id: a
    command: node a.js
  - id: d
    needs: [b, c]
    command: node d.js
  - id: c
    needs: [a]
    command: node c.js
  - id: b
    needs: [a]
    command: node b.js
`, ['a', 'c', 'b', 'd']],
    ['join of two roots', `  - id: a
    command: node a.js
  - id: join
    needs: [a, b]
    command: node join.js
  - id: b
    needs: []
    command: node b.js
`, ['a', 'b', 'join']],
  ])('settles a %s graph in declaration order of ready steps', async (_shape, steps, order) => {
    const { config, runId } = await startBuild(graph(steps));

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(order);
    expect(done).toMatchObject({ outcome: 'succeeded' });
  });

  it('skips a join only when every step it needs was skipped', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: fix
    needs: [check]
    command: node fix.js
  - id: docs
    needs: []
    command: node docs.js
  - id: some-skipped
    needs: [fix, docs]
    command: node some.js
  - id: all-skipped
    needs: [fix]
    command: node all.js
`));

    const { leased, done } = await drive(config, runId, ['check']);

    expect(leased).toEqual(['check', 'docs', 'some-skipped']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [
        { id: 'check', status: 'failed' },
        { id: 'fix', status: 'skipped' },
        { id: 'docs', status: 'succeeded' },
        { id: 'some-skipped', status: 'succeeded' },
        { id: 'all-skipped', status: 'skipped' },
      ],
    });
  });

  it('accepts the report for a lease handed out after skipping steps', async () => {
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: test
    needs: [build]
    command: node test.js
  - id: docs
    needs: []
    command: node docs.js
`));
    const first = await leaseNext(config, runId, driverA);
    if ('error' in first) throw new Error(first.error.message);
    const lease = first.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: driverA });

    const docs = await leaseNext(config, runId, driverA);
    expect(docs).toMatchObject({ data: { lease: { step: 'docs', revision: 2 } } });
    if ('error' in docs) return;
    const docsLease = docs.data.lease as { attempt: string; revision: number };
    expect(await readRun(config, runId)).toMatchObject({ revision: 2, steps: [{ status: 'failed' }, { status: 'skipped' }, { status: 'leased' }] });

    const accepted = await reportAttempt(config, runId, {
      attempt: docsLease.attempt, revision: docsLease.revision, outcome: 'success', driver: driverA,
    });
    expect(accepted).toMatchObject({ data: { accepted: true, revision: 3, step: { id: 'docs', status: 'succeeded' } } });
  });

  it('settles an end-only step without a lease and skips what is left', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: drop
    needs: [check]
    end: dropped
  - id: build
    needs: [check]
    command: node build.js
`, 'ends:\n  dropped: succeeded\n'));

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['check']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded', end: 'dropped' });
    expect(await readRun(config, runId)).toMatchObject({
      status: 'succeeded',
      revision: 2,
      steps: [{ id: 'check', status: 'succeeded' }, { id: 'drop', status: 'succeeded' }, { id: 'build', status: 'skipped' }],
    });
  });

  it.each([
    ['a failed end fails the run', 'ends:\n  stuck: failed\n', `  - id: triage
    command: node triage.js
    end: stuck
  - id: build
    needs: []
    command: node build.js
`, [], ['triage'], { outcome: 'failed', end: 'stuck' }],
    ['a succeeded end succeeds the run after another step failed', 'ends:\n  recovered: succeeded\n', `  - id: docs
    command: node docs.js
  - id: check
    needs: []
    command: node check.js
    end: recovered
  - id: later
    needs: [check]
    command: node later.js
`, ['docs'], ['docs', 'check'], { outcome: 'succeeded', end: 'recovered' }],
    ['a step with end that fails reaches no end', 'ends:\n  shipped: succeeded\n', `  - id: ship
    command: node ship.js
    end: shipped
  - id: docs
    needs: []
    command: node docs.js
`, ['ship'], ['ship', 'docs'], { outcome: 'failed' }],
  ])('%s', async (_name, header, steps, failing, order, expected) => {
    const { config, runId } = await startBuild(graph(steps, header));

    const { leased, done } = await drive(config, runId, failing);

    expect(leased).toEqual(order);
    expect(done).toEqual({ run: runId, record: 'pending', ...expected });
    expect(await leaseNext(config, runId, driverA)).toEqual({ data: { done: { run: runId, record: 'pending', ...expected } } });
  });

  it('reaches a ready end before it leases a step declared earlier', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: docs
    needs: []
    command: node docs.js
  - id: drop
    needs: [check]
    end: dropped
`, 'ends:\n  dropped: succeeded\n'));

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['check']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded', end: 'dropped' });
  });
  it('runs a recovery step that reads a failed check, and the run still fails', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: node label.js
  - id: ship
    needs: [check]
    command: node ship.js
`));

    const { leased, done } = await drive(config, runId, ['check']);

    expect(leased).toEqual(['check', 'label']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [{ id: 'check', status: 'failed' }, { id: 'label', status: 'succeeded' }, { id: 'ship', status: 'skipped' }],
    });
  });

  it('skips a step whose if reads only one of two stopped dependencies', async () => {
    const { config, runId } = await startBuild(graph(`  - id: lint
    command: node lint.js
  - id: test
    needs: []
    command: node test.js
  - id: report
    needs: [lint, test]
    if: steps.lint.outcome == 'failed'
    command: node report.js
  - id: both
    needs: [lint, test]
    if: steps.lint.outcome == 'failed' || steps.test.outcome == 'failed'
    command: node both.js
`));

    const { leased, done } = await drive(config, runId, ['lint', 'test']);

    expect(leased).toEqual(['lint', 'test', 'both']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{}, {}, { id: 'report', status: 'skipped' }, { id: 'both', status: 'succeeded' }] });
  });

  it('runs the branch whose if is true and skips the other without failing the run', async () => {
    const { config, runId } = await startBuild(graph(`  - id: review
    command: node review.js
    output:
      verdict: pass | fix
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    command: node fix.js
  - id: merge
    needs: [review]
    if: steps.review.outputs.verdict == 'pass'
    command: node merge.js
  - id: after-merge
    needs: [merge]
    command: node after.js
`));
    const first = await leaseNext(config, runId, driverA);
    if ('error' in first) throw new Error(first.error.message);
    const lease = first.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', outputs: { verdict: 'fix' }, driver: driverA });

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['fix']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({
      revision: 3,
      steps: [{}, { id: 'fix', status: 'succeeded' }, { id: 'merge', status: 'skipped' }, { id: 'after-merge', status: 'skipped' }],
    });
  });

  it('evaluates an if only after every step it reads has settled', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late through gate.
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    if: steps.late.outcome == 'success'
    command: node deploy.js
  - id: late
    needs: []
    command: node late.js
`));

    const { leased } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs', 'late', 'deploy']);
  });

  it('evaluates an if against the run inputs', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: build
    command: node build.js
  - id: ship
    needs: [build]
    if: inputs.ship
    command: node ship.js
`, 'inputs:\n  ship: boolean\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { ship: true });
    if ('error' in started) throw new Error(started.error.message);

    const { leased } = await drive(fixture.config, String(started.data.run));

    expect(leased).toEqual(['build', 'ship']);
  });

  it('leases a step only after every step its templates read has settled', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late through gate.
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    command: node deploy.js
    env:
      LATE: "{{ steps.late.outcome }}"
  - id: late
    needs: []
    command: node late.js
`));

    const { leased } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs', 'late', 'deploy']);
  });

  it.each([
    ['fails', ['check'], ['check'], { outcome: 'succeeded', end: 'handled' }],
    ['succeeds', [], ['check', 'ship'], { outcome: 'succeeded' }],
  ])('settles a recovery end-only step only when the check it reads %s', async (_case, failing, order, done) => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: handle
    needs: [check]
    if: steps.check.outcome == 'failed'
    end: handled
  - id: ship
    needs: [check]
    command: node ship.js
`, 'ends:\n  handled: succeeded\n'));

    const result = await drive(config, runId, failing);

    expect(result.leased).toEqual(order);
    expect(result.done).toEqual({ run: runId, record: 'pending', ...done });
  });

  it.each([
    ['a missing input', { issue: 42 }, 'inputs.title is missing'],
    ['an undeclared input', { issue: 42, title: 'Fix', titel: 'Fix' }, 'inputs.titel is not an input workflow "build" declares'],
    ['a mistyped input', { issue: '42', title: 'Fix' }, 'inputs.issue must be a number'],
    ['inputs that are not an object', [42, 'Fix'], 'inputs must be a JSON object'],
  ])('rejects %s with invalid_inputs before a run exists', async (_case, inputs, message) => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: fix
    command: node fix.js
`, 'inputs:\n  issue: number\n  title: string\n'));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'build', inputs)).toEqual({ error: { code: 'invalid_inputs', message } });
    expect(fs.existsSync(path.join(fixture.config.dataHome!, 'workflows', 'runs'))).toBe(false);
  });

  it('stores the inputs and renders inputs and step outputs into a prompt, leaving other braces as written', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: plan
    command: node plan.js
    output:
      task:
        files: [string]
  - id: fix
    needs: [plan]
    prompt: "Fix #{{ inputs.issue }} {{inputs.title}} in {{ steps.plan.outputs.task }}. Keep \${{ secrets.TOKEN }} and {{ name }}."
`, 'inputs:\n  issue: number\n  title: string\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { issue: 42, title: 'Crash' });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const plan = await leaseNext(fixture.config, runId, driverA);
    if ('error' in plan) throw new Error(plan.error.message);
    const lease = plan.data.lease as { attempt: string; revision: number };
    await reportAttempt(fixture.config, runId, { ...lease, outcome: 'success', outputs: { task: { files: ['a.ts'] } }, driver: driverA });

    const fix = await leaseNext(fixture.config, runId, driverA);

    expect(fix).toMatchObject({ data: { lease: { step: 'fix', prompt: 'Fix #42 Crash in {"files":["a.ts"]}. Keep ${{ secrets.TOKEN }} and {{ name }}.' } } });
    expect(await readRun(fixture.config, runId)).toMatchObject({ inputs: { issue: 42, title: 'Crash' } });
  });

  it('leases a command with its env rendered to strings and its command as written', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: plan
    command: node plan.js
  - id: label
    needs: [plan]
    command: node label.js "$TITLE"
    env:
      TITLE: "{{ inputs.title }}"
      FILES: "{{ steps.plan.outputs.files }}"
      LABEL: "issue-{{ inputs.issue }}"
      PORT: 8080
`, 'inputs:\n  issue: number\n  title: string\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { issue: 42, title: '$(touch pwned)' });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const plan = await leaseNext(fixture.config, runId, driverA);
    if ('error' in plan) throw new Error(plan.error.message);
    const lease = plan.data.lease as { attempt: string; revision: number };
    await reportAttempt(fixture.config, runId, { ...lease, outcome: 'success', outputs: { files: ['a.ts'] }, driver: driverA });

    const label = await leaseNext(fixture.config, runId, driverA);
    const again = await leaseNext(fixture.config, runId, driverA);

    expect(label).toMatchObject({ data: { lease: {
      step: 'label',
      command: 'node label.js "$TITLE"',
      env: { TITLE: '$(touch pwned)', FILES: '["a.ts"]', LABEL: 'issue-42', PORT: '8080' },
    } } });
    expect(again).toEqual(label);
  });

  it('renders every template in one value, in a prompt and in env', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: label
    command: node label.js
    env:
      REPO: "{{ inputs.owner }}/{{ inputs.repo }}"
  - id: review
    needs: [label]
    prompt: "Review {{ inputs.owner }}/{{ inputs.repo }}."
`, 'inputs:\n  owner: string\n  repo: string\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { owner: 'tencent', repo: 'teamai-cli' });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);

    const label = await leaseNext(fixture.config, runId, driverA);
    if ('error' in label) throw new Error(label.error.message);
    const lease = label.data.lease as { attempt: string; revision: number; env: Record<string, string> };
    await reportAttempt(fixture.config, runId, { ...lease, outcome: 'success', driver: driverA });
    const review = await leaseNext(fixture.config, runId, driverA);

    expect(lease.env).toEqual({ REPO: 'tencent/teamai-cli' });
    expect(review).toMatchObject({ data: { lease: { step: 'review', prompt: 'Review tencent/teamai-cli.' } } });
  });

  it('fails a step whose stored template cannot render and keeps settling the run', async () => {
    const { config, runId } = await startBuild(graph(`  - id: label
    command: node label.js
    env:
      TITLE: fixed
  - id: docs
    needs: []
    command: node docs.js
`));
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    run.definition.steps[0]!.env = { TITLE: '{{ inputs.a b }}' };
    await writeRun(config, run);

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['docs']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [
        { id: 'label', status: 'failed', failure: { code: 'invalid_template', message: 'step "label" env.TITLE template {{ inputs.a b }}: unexpected "b"' } },
        { id: 'docs', status: 'succeeded' },
      ],
    });
  });

  it('reports a run whose stored if does not parse instead of guessing', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: node label.js
`));
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    run.definition.steps[1]!.if = 'steps.check.outcome = 1';
    await writeRun(config, run);

    expect(await leaseNext(config, runId, driverA)).toMatchObject({
      error: { code: 'run_unreadable', message: expect.stringContaining('step "label" has an if that does not parse') },
    });
  });
});

/** Writes each workflow file, syncs, and starts `name`. */
async function startTree(
  files: Record<string, string>,
  name: string,
  inputs: unknown = {},
): Promise<{ config: LocalConfig; work: string; runId: string }> {
  const fixture = testConfig();
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', `${file}.yaml`), body);
  }
  await syncWorkflowDefinitions(fixture.config);
  const started = await startRun(fixture.config, name, inputs);
  if ('error' in started) throw new Error(started.error.message);
  return { ...fixture, runId: String(started.data.run) };
}

function workflow(name: string, steps: string, header = ''): string {
  return `schemaVersion: v1alpha1
name: ${name}
description: The ${name} workflow.
${header}steps:
${steps}`;
}

const CHECK = workflow('check', `  - id: classify
    command: node classify.js
  - id: comment
    needs: [classify]
    command: node comment.js
`);

describe('file sub-workflows', () => {
  it('leases the child steps by path in place of the workflow step, then continues the parent', async () => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: check
    workflow: check
  - id: ship
    needs: [check]
    command: node ship.js
`) }, 'ship');

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['check.classify', 'check.comment', 'ship']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({
      revision: 4,
      steps: [
        { id: 'check', status: 'succeeded' },
        { id: 'check.classify', status: 'succeeded' },
        { id: 'check.comment', status: 'succeeded' },
        { id: 'ship', status: 'succeeded' },
      ],
    });
  });

  it('fails start naming a child with no runnable version, without falling back to an older copy', async () => {
    const fixture = testConfig();
    const workflows = path.join(fixture.config.repo.localPath, 'workflows');
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: check
    workflow: check
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), CHECK);
    await syncWorkflowDefinitions(fixture.config);
    fs.writeFileSync(path.join(workflows, 'check.yaml'), `${CHECK}    for_each: [1]\n`);
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'ship')).toEqual({ error: {
      code: 'workflow_not_found',
      message: 'Workflow "ship" step "check" runs workflow "check", which has no runnable version. Check workflows/check.yaml and pull again.',
    } });
    expect(fs.existsSync(path.join(fixture.config.dataHome!, 'workflows', 'runs'))).toBe(false);
  });

  it('keeps the parent and child it started with, under one source hash, after a later pull changes them', async () => {
    const ship = workflow('ship', `  - id: check
    workflow: check
`);
    const { config, runId } = await startTree({ check: CHECK, ship }, 'ship');
    const workflows = path.join(config.repo.localPath, 'workflows');
    fs.writeFileSync(path.join(workflows, 'check.yaml'), workflow('check', `  - id: other
    command: node other.js
`));
    await syncWorkflowDefinitions(config);
    const second = await startRun(config, 'ship');
    if ('error' in second) throw new Error(second.error.message);
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), `${ship}  - id: extra\n    needs: []\n    command: node extra.js\n`);
    await syncWorkflowDefinitions(config);

    const { leased } = await drive(config, runId);

    expect(leased).toEqual(['check.classify', 'check.comment']);
    const first = await readRun(config, runId);
    const later = await readRun(config, String(second.data.run));
    if (typeof first !== 'object' || typeof later !== 'object') throw new Error('run missing');
    expect(first.sourceHash).not.toBe(later.sourceHash);
  });

  it('passes with values to the child, keeping the JSON type of a value that is exactly one template', async () => {
    const child = workflow('check', `  - id: classify
    prompt: "Classify {{ inputs.note }} in {{ inputs.task }}."
`, `inputs:
  issue: number
  task:
    files: [string]
  note: string
  meta:
    id: number
    tags: [string]
`);
    const { config, runId } = await startTree({ check: child, ship: workflow('ship', `  - id: plan
    command: node plan.js
    output:
      task:
        files: [string]
  - id: check
    needs: [plan]
    workflow: check
    with:
      issue: "{{ inputs.issue }}"
      task: "{{ steps.plan.outputs.task }}"
      note: "issue {{ inputs.issue }}"
      meta:
        id: "{{ inputs.issue }}"
        tags: ["x-{{ inputs.issue }}"]
`, 'inputs:\n  issue: number\n') }, 'ship', { issue: 42 });
    const plan = await leaseNext(config, runId, driverA);
    if ('error' in plan) throw new Error(plan.error.message);
    const lease = plan.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { task: { files: ['a.ts'] } }, driver: driverA });

    const classify = await leaseNext(config, runId, driverA);

    expect(classify).toMatchObject({ data: { lease: { step: 'check.classify', prompt: 'Classify issue 42 in {"files":["a.ts"]}.' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', status: 'succeeded' },
      { id: 'check', status: 'running', inputs: { issue: 42, task: { files: ['a.ts'] }, note: 'issue 42', meta: { id: 42, tags: ['x-42'] } } },
      { id: 'check.classify', status: 'leased' },
    ] });
  });

  it('starts a workflow step only after every step its with values read has settled', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late through gate.
    const child = workflow('check', `  - id: classify
    command: node classify.js
`, 'inputs:\n  late: string\n');
    const { config, runId } = await startTree({ check: child, ship: workflow('ship', `  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    workflow: check
    with:
      late: "{{ steps.late.outcome }}"
  - id: late
    needs: []
    command: node late.js
`) }, 'ship');

    const { leased } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs', 'late', 'deploy.classify']);
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([{ id: 'deploy', status: 'succeeded', outcome: 'success', inputs: { late: 'success' } }]) });
  });

  it('fails a workflow step with invalid_inputs when with does not fit the child inputs, and keeps settling', async () => {
    const child = workflow('check', `  - id: classify
    command: node classify.js
`, 'inputs:\n  issue: number\n');
    const { config, runId } = await startTree({ check: child, ship: workflow('ship', `  - id: check
    workflow: check
    with:
      issue: "{{ inputs.title }}"
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: node label.js
`, 'inputs:\n  title: string\n') }, 'ship', { title: '42' });

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['label']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ revision: 2, steps: [
      { id: 'check', status: 'failed', failure: { code: 'invalid_inputs', message: 'step "check" with does not fit workflow "check": inputs.issue must be a number' } },
      { id: 'label', status: 'succeeded' },
    ] });
  });

  it('finishes only the child at its end, and the parent branches on steps.<id>.end and reads its outputs', async () => {
    const child = workflow('check', `  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
  - id: drop
    needs: [classify]
    if: steps.classify.outputs.verdict == 'drop'
    end: dropped
  - id: comment
    needs: [classify]
    command: node comment.js
`, 'ends:\n  dropped: succeeded\noutputs:\n  verdict: steps.classify.outputs.verdict\n');
    const { config, runId } = await startTree({ check: child, ship: workflow('ship', `  - id: check
    workflow: check
  - id: close
    needs: [check]
    if: steps.check.end == 'dropped'
    command: node close.js
    env:
      VERDICT: "{{ steps.check.outputs.verdict }}"
  - id: fix
    needs: [check]
    if: steps.check.end != 'dropped'
    command: node fix.js
`) }, 'ship');
    const classify = await leaseNext(config, runId, driverA);
    if ('error' in classify) throw new Error(classify.error.message);
    const lease = classify.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { verdict: 'drop' }, driver: driverA });

    const close = await leaseNext(config, runId, driverA);
    if ('error' in close) throw new Error(close.error.message);
    const closeLease = close.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...closeLease, outcome: 'success', driver: driverA });
    const done = await leaseNext(config, runId, driverA);

    expect(close).toMatchObject({ data: { lease: { step: 'close', env: { VERDICT: 'drop' } } } });
    expect(done).toEqual({ data: { done: { run: runId, record: 'pending', outcome: 'succeeded' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'check', status: 'succeeded', end: 'dropped', outputs: { verdict: 'drop' } },
      { id: 'check.classify', status: 'succeeded' },
      { id: 'check.drop', status: 'succeeded' },
      { id: 'check.comment', status: 'skipped' },
      { id: 'close', status: 'succeeded' },
      { id: 'fix', status: 'skipped' },
    ] });
  });

  it.each([
    ['ends the parent when its child succeeds', [], ['check.classify', 'check.comment'], { outcome: 'succeeded', end: 'shipped' }],
    ['reaches no end when its child fails', ['check.classify'], ['check.classify', 'docs'], { outcome: 'failed' }],
  ])('a workflow step with end runs its child first and %s', async (_name, failing, order, expected) => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: check
    workflow: check
    end: shipped
  - id: docs
    needs: []
    command: node docs.js
`, 'ends:\n  shipped: succeeded\n') }, 'ship');

    const { leased, done } = await drive(config, runId, failing);

    expect(leased).toEqual(order);
    expect(done).toEqual({ run: runId, record: 'pending', ...expected });
  });

  it('fails the workflow step when its child fails, so a recovery step in the parent runs', async () => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: check
    workflow: check
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: node label.js
`) }, 'ship');

    const { leased, done } = await drive(config, runId, ['check.comment']);

    expect(leased).toEqual(['check.classify', 'check.comment', 'label']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'check', status: 'failed', outcome: 'failed' },
      { id: 'check.classify', status: 'succeeded' },
      { id: 'check.comment', status: 'failed' },
      { id: 'label', status: 'succeeded' },
    ] });
  });

  it('reports a run stored with a step after the first that has no needs, instead of running it as a root', async () => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: check
    workflow: check
`) }, 'ship');
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    delete run.workflows!.check!.steps[1]!.needs;
    await writeRun(config, run);

    expect(await leaseNext(config, runId, driverA)).toEqual({ error: {
      code: 'run_unreadable',
      message: `Run ${runId} was started by an older teamai: step "comment" in workflow "check" has no needs. Start a new run.`,
    } });
  });

  it('checks a child step report against the output that child step declares', async () => {
    const child = workflow('check', `  - id: classify
    command: node classify.js
    output:
      verdict: fix | drop
`);
    const { config, runId } = await startTree({ check: child, ship: workflow('ship', `  - id: check
    workflow: check
`) }, 'ship');
    const classify = await leaseNext(config, runId, driverA);
    if ('error' in classify) throw new Error(classify.error.message);
    const lease = classify.data.lease as { attempt: string; revision: number };

    const reported = await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { verdict: 'maybe' }, driver: driverA });

    expect(reported).toMatchObject({ data: { step: { id: 'check.classify', status: 'failed', outcome: 'failed' } } });
  });

  it('refuses to start a workflow that runs itself through the version a sub-workflow kept', async () => {
    const fixture = testConfig();
    const workflows = path.join(fixture.config.repo.localPath, 'workflows');
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: check
    workflow: check
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), CHECK);
    await syncWorkflowDefinitions(fixture.config);
    // ship's new revision runs a missing workflow, so ship keeps the version that runs check.
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: check
    workflow: gone
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), workflow('check', `  - id: again
    workflow: ship
`));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'ship')).toEqual({ error: {
      code: 'workflow_recursion',
      message: 'Workflow "ship" cannot start: its sub-workflows run in a cycle: ship -> check -> ship',
    } });
    expect(fs.existsSync(path.join(fixture.config.dataHome!, 'workflows', 'runs'))).toBe(false);
  });
});

describe('with on prompt steps', () => {
  it('renders a shared prompt file with the with values of the step that runs it', async () => {
    const fixture = testConfig();
    const knowledge = fixture.config.repo.localPath;
    fs.mkdirSync(path.join(knowledge, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'prompts', 'fix.md'), 'Fix {{ with.issue }} in {{ with.task }}, files {{ with.task.files }}.');
    fs.writeFileSync(path.join(knowledge, 'workflows', 'build.yaml'), graph(`  - id: plan
    command: node plan.js
    output:
      task:
        files: [string]
  - id: fix
    needs: [plan]
    prompt_file: prompts/fix.md
    with:
      issue: "#{{ inputs.issue }}"
      task: "{{ steps.plan.outputs.task }}"
`, 'inputs:\n  issue: number\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { issue: 42 });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const plan = await leaseNext(fixture.config, runId, driverA);
    if ('error' in plan) throw new Error(plan.error.message);
    const lease = plan.data.lease as { attempt: string; revision: number };
    await reportAttempt(fixture.config, runId, { ...lease, outcome: 'success', outputs: { task: { files: ['a.ts'] } }, driver: driverA });

    const fix = await leaseNext(fixture.config, runId, driverA);

    expect(fix).toMatchObject({ data: { lease: { step: 'fix', prompt: 'Fix #42 in {"files":["a.ts"]}, files ["a.ts"].' } } });
  });

  it('passes pull and leases verbatim a prompt that quotes GitHub Actions ${{ … }} expressions', async () => {
    const { config, runId } = await startBuild(graph(`  - id: explain
    prompt: "Explain \${{ secrets.X }} and \${{ inputs.version }} in \${{with.file}}; ref {{ with.ref }}."
    with:
      file: release.yml
      ref: "\${{ steps.build.outputs.sha }}"
`));

    const explain = await leaseNext(config, runId, driverA);

    expect(explain).toMatchObject({ data: { lease: {
      step: 'explain',
      prompt: 'Explain ${{ secrets.X }} and ${{ inputs.version }} in ${{with.file}}; ref ${{ steps.build.outputs.sha }}.',
    } } });
  });

  it('leases a prompt step only after every step its with values read has settled', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late through gate.
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    prompt: "Deploy after late {{ with.late }}."
    with:
      late: "{{ steps.late.outcome }}"
  - id: late
    needs: []
    command: node late.js
`));

    const { leased } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs', 'late', 'deploy']);
  });

  it('fails a prompt step whose stored with template cannot render and keeps settling the run', async () => {
    const { config, runId } = await startBuild(graph(`  - id: fix
    prompt: "Fix {{ with.task }}."
    with:
      task: fixed
  - id: label
    needs: []
    command: node label.js
`));
    const run = await readRun(config, runId);
    if (typeof run !== 'object' || !run.definition.steps[0]?.with) throw new Error('run missing');
    run.definition.steps[0].with = { task: '{{ inputs.task == 1 }}' };
    await writeRun(config, run);

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['label']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'fix', status: 'failed', failure: { code: 'invalid_template', message: 'step "fix" with template {{ inputs.task == 1 }}: a template reads one path' } },
      { id: 'label', status: 'succeeded' },
    ] });
  });
});

describe('inline workflows', () => {
  it('leases inline steps by path, and they read the enclosing inputs and the enclosing step\'s ancestors', async () => {
    const { config, runId } = await startTree({ ship: workflow('ship', `  - id: plan
    command: node plan.js
    output:
      task: string
  - id: check
    needs: [plan]
    workflow:
      steps:
        - id: classify
          prompt: "Classify {{ inputs.title }} for {{ steps.plan.outputs.task }}."
        - id: comment
          needs: [classify]
          if: steps.plan.outcome == 'success'
          command: node comment.js
  - id: ship
    needs: [check]
    command: node ship.js
`, 'inputs:\n  title: string\n') }, 'ship', { title: 'Bug' });
    const plan = await leaseNext(config, runId, driverA);
    if ('error' in plan) throw new Error(plan.error.message);
    const lease = plan.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { task: 'fix' }, driver: driverA });

    const classify = await leaseNext(config, runId, driverA);
    if ('error' in classify) throw new Error(classify.error.message);
    const classifyLease = classify.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...classifyLease, outcome: 'success', driver: driverA });
    const { leased, done } = await drive(config, runId);

    expect(classify).toMatchObject({ data: { lease: { step: 'check.classify', prompt: 'Classify Bug for fix.' } } });
    expect(leased).toEqual(['check.comment', 'ship']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
  });

  it('finishes only the inline workflow at its end, and the parent reads its end and outputs', async () => {
    const { config, runId } = await startTree({ ship: workflow('ship', `  - id: check
    workflow:
      ends:
        dropped: succeeded
      outputs:
        verdict: steps.classify.outputs.verdict
      steps:
        - id: classify
          command: node classify.js
          output:
            verdict: fix | drop
        - id: drop
          needs: [classify]
          if: steps.classify.outputs.verdict == 'drop'
          end: dropped
        - id: comment
          needs: [classify]
          command: node comment.js
  - id: close
    needs: [check]
    if: steps.check.end == 'dropped'
    command: node close.js
    env:
      VERDICT: "{{ steps.check.outputs.verdict }}"
`) }, 'ship');
    const classify = await leaseNext(config, runId, driverA);
    if ('error' in classify) throw new Error(classify.error.message);
    const lease = classify.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { verdict: 'drop' }, driver: driverA });

    const close = await leaseNext(config, runId, driverA);

    expect(close).toMatchObject({ data: { lease: { step: 'close', env: { VERDICT: 'drop' } } } });
    expect(await readRun(config, runId)).toMatchObject({ status: 'running', steps: [
      { id: 'check', status: 'succeeded', end: 'dropped', outputs: { verdict: 'drop' } },
      { id: 'check.classify', status: 'succeeded' },
      { id: 'check.drop', status: 'succeeded' },
      { id: 'check.comment', status: 'skipped' },
      { id: 'close', status: 'leased' },
    ] });
  });

  it('starts an inline workflow only after every enclosing step its steps read has settled', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late through gate.
    const { config, runId } = await startTree({ ship: workflow('ship', `  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    workflow:
      steps:
        - id: push
          command: node push.js
          env:
            LATE: "{{ steps.late.outcome }}"
  - id: late
    needs: []
    command: node late.js
`) }, 'ship');

    const { leased } = await drive(config, runId, ['build']);

    expect(leased).toEqual(['build', 'docs', 'late', 'deploy.push']);
  });

  it('snapshots a workflow file run from an inline workflow at any depth, and reads through every enclosing level', async () => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: plan
    command: node plan.js
  - id: outer
    needs: [plan]
    workflow:
      steps:
        - id: inner
          workflow:
            steps:
              - id: note
                command: node note.js
                env:
                  PLAN: "{{ steps.plan.outcome }}"
              - id: check
                needs: [note]
                workflow: check
`) }, 'ship');

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['plan', 'outer.inner.note', 'outer.inner.check.classify', 'outer.inner.check.comment']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({ workflows: { check: { name: 'check' } } });
  });

  it('refuses to start when a workflow file run from an inline workflow runs the parent again', async () => {
    const fixture = testConfig();
    const workflows = path.join(fixture.config.repo.localPath, 'workflows');
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: outer
    workflow:
      steps:
        - id: check
          workflow: check
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), CHECK);
    await syncWorkflowDefinitions(fixture.config);
    // ship's new revision runs a missing workflow, so ship keeps the version that runs check from its inline workflow.
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: outer
    workflow: gone
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), workflow('check', `  - id: again
    workflow: ship
`));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'ship')).toEqual({ error: {
      code: 'workflow_recursion',
      message: 'Workflow "ship" cannot start: its sub-workflows run in a cycle: ship -> check -> ship',
    } });
  });

  it('reads its own step where an enclosing step has the same id', async () => {
    const { config, runId } = await startTree({ ship: workflow('ship', `  - id: plan
    command: node plan.js
    output:
      task: string
  - id: check
    needs: [plan]
    workflow:
      steps:
        - id: plan
          command: node inner-plan.js
          output:
            task: string
        - id: fix
          needs: [plan]
          prompt: "Fix {{ steps.plan.outputs.task }}."
`) }, 'ship');
    for (const task of ['outer', 'inner']) {
      const next = await leaseNext(config, runId, driverA);
      if ('error' in next) throw new Error(next.error.message);
      const lease = next.data.lease as { attempt: string; revision: number };
      await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { task }, driver: driverA });
    }

    const fix = await leaseNext(config, runId, driverA);

    expect(fix).toMatchObject({ data: { lease: { step: 'check.fix', prompt: 'Fix inner.' } } });
  });
});

/** The end record the run queued; the fixtures have no reports remote, so it stays queued. */
async function endRecord(config: LocalConfig): Promise<WorkflowRunRecord | undefined> {
  return (await pendingRecords(config)).find((record) => record.phase === 'end');
}

/** Drives a run to done, reporting each step with the fields `reports` gives for its path. */
async function driveWith(config: LocalConfig, runId: string, reports: Record<string, Partial<ReportInput>> = {}): Promise<void> {
  for (;;) {
    const next = await leaseNext(config, runId, driverA);
    if ('error' in next) throw new Error(next.error.message);
    if (next.data.done) return;
    const lease = next.data.lease as { step: string; attempt: string; revision: number };
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: driverA, ...reports[lease.step] });
  }
}

describe('run records of graph runs', () => {
  it('lists the steps of a sub-workflow by path, each with its own agent, tool, model and tokens', async () => {
    const { config, runId } = await startTree({
      review: workflow('review', `  - id: classify
    prompt: Classify the issue.
    agent: classifier
  - id: comment
    needs: [classify]
    command: node comment.js
`),
      ship: workflow('ship', `  - id: check
    workflow: review
  - id: fix
    needs: [check]
    prompt: Fix the issue.
    agent: implementer
`),
    }, 'ship');

    await driveWith(config, runId, {
      'check.classify': { tool: 'claude', model: 'claude-sonnet', tokens: { input: 10, output: 5 } },
      fix: { tool: 'codex', model: 'gpt-codex', tokens: { input: 20, output: 8 } },
    });

    expect((await endRecord(config))?.steps).toEqual([
      { step: 'check', outcome: 'success' },
      { step: 'check.classify', agent: 'classifier', tool: 'claude', model: 'claude-sonnet', outcome: 'success', tokens: { input: 10, output: 5 } },
      { step: 'check.comment', outcome: 'success' },
      { step: 'fix', agent: 'implementer', tool: 'codex', model: 'gpt-codex', outcome: 'success', tokens: { input: 20, output: 8 } },
    ]);
  });

  it('counts skipped steps, and not the steps of a sub-workflow that never started', async () => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: plan
    command: node plan.js
  - id: check
    needs: [plan]
    workflow: check
  - id: docs
    needs: []
    command: node docs.js
`) }, 'ship');

    await driveWith(config, runId, { plan: { outcome: 'failed' } });

    expect(await endRecord(config)).toMatchObject({
      status: 'failed',
      stepCounts: { total: 3, succeeded: 1, failed: 1, skipped: 1 },
    });
  });

  it('carries the end the run reached, and no end when it reached none', async () => {
    const shipped = await startTree({ ship: workflow('ship', `  - id: build
    command: node build.js
  - id: done
    needs: [build]
    end: shipped
`, 'ends:\n  shipped: succeeded\n') }, 'ship');
    const plain = await startBuild(TWO_STEPS);

    await driveWith(shipped.config, shipped.runId);
    await driveWith(plain.config, plain.runId);

    expect(await endRecord(shipped.config)).toMatchObject({ status: 'succeeded', end: 'shipped' });
    expect(await endRecord(plain.config)).not.toHaveProperty('end');
  });

  it('gives an end-only step that succeeded a success outcome, and a skipped step none', async () => {
    const { config, runId } = await startTree({ ship: workflow('ship', `  - id: build
    command: node build.js
  - id: retry
    needs: [build]
    if: steps.build.outcome == 'failed'
    command: node retry.js
  - id: done
    needs: [build]
    end: shipped
`, 'ends:\n  shipped: succeeded\n') }, 'ship');

    await driveWith(config, runId);

    expect((await endRecord(config))?.steps).toEqual([
      { step: 'build', outcome: 'success' },
      { step: 'retry' },
      { step: 'done', outcome: 'success' },
    ]);
  });

  it('lists inline steps by path with their agent, and a failed workflow step by its outcome alone', async () => {
    const { config, runId } = await startTree({ check: CHECK, ship: workflow('ship', `  - id: review
    workflow:
      steps:
        - id: read
          prompt: Read the diff.
          agent: reviewer
  - id: check
    needs: [review]
    workflow: check
`) }, 'ship');

    await driveWith(config, runId, { 'check.comment': { outcome: 'failed', message: 'comment failed' } });

    const record = await endRecord(config);
    expect(record?.steps).toEqual([
      { step: 'review', outcome: 'success' },
      { step: 'review.read', agent: 'reviewer', outcome: 'success' },
      { step: 'check', outcome: 'failed' },
      { step: 'check.classify', outcome: 'success' },
      { step: 'check.comment', outcome: 'failed' },
    ]);
    expect(JSON.stringify(record)).not.toContain('undefined');
    expect(JSON.stringify(record)).not.toContain('comment failed');
  });

  it('publishes no input value, rendered env or prompt, or child definition', async () => {
    const sentinel = 'SENTINEL-7f3a';
    const child = workflow('triage', `  - id: classify
    prompt: "Classify {{ inputs.title }}."
    agent: classifier
`, 'inputs:\n  title: string\n');
    const { config, runId } = await startTree({ triage: child, ship: workflow('ship', `  - id: label
    command: node label.js
    env:
      TITLE: "{{ inputs.title }}"
  - id: triage
    needs: [label]
    workflow: triage
    with:
      title: "{{ inputs.title }}"
`, 'inputs:\n  title: string\n') }, 'ship', { title: sentinel });

    await driveWith(config, runId);

    const records = await pendingRecords(config);
    expect(records.map((record) => record.phase).sort()).toEqual(['end', 'start']);
    expect(await readRun(config, runId)).toMatchObject({ inputs: { title: sentinel } });
    const published = JSON.stringify(records);
    expect(published).not.toContain(sentinel);
    expect(published).not.toContain('Classify');
    expect(published).not.toContain('node label.js');
  });

  it('ends the record at the time the run file was saved', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    // A clock that moves on every reading, so two readings of "now" never agree.
    let tick = 0;
    const clock = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => `2026-01-01T00:00:${String(10 + Math.floor(tick / 1000)).padStart(2, '0')}.${String(tick++ % 1000).padStart(3, '0')}Z`);
    try {
      await driveWith(config, runId);
    } finally {
      clock.mockRestore();
    }

    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect((await endRecord(config))?.endedAt).toBe(stored.updatedAt);
  });
});

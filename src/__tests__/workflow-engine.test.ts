import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import * as update from '../update.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseNextPayload, parseReport, reportAttempt, resumableSessions, SETTLED_ATTEMPTS_LIMIT, startRun, type ReportInput } from '../workflow/engine.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/local-driver.js';
import { getCurrentVersion } from '../package-info.js';
import { outputMismatch } from '../workflow/output.js';
import { pendingRecords, type WorkflowRunRecord } from '../workflow/records.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import { getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import { readRun, runFilePath, runLockPath, runsDir, updateRun } from '../workflow/store.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import type { DriverIdentity, RunState } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

_setDriverPollMs(20);

const dirs: string[] = [];

/** Saves an edited run file under its lock, as a hand edit or an older teamai leaves one. */
async function saveRun(config: LocalConfig, run: RunState): Promise<void> {
  await updateRun(config, run.id, {}, async () => ({ value: undefined, write: run }));
}

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
  const started = await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) });
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
  vi.unstubAllEnvs();
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
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.report).toMatchObject({ tool: 'claude', model: 'sonnet', session: 'session-1', tokens: { input: 2 } });
    expect(parsed.ignored).toEqual([]);
    expect(parseReport({
      attempt: 'a00000000',
      revision: 1,
      outcome: 'success',
      driver: driverA,
      tokens: { input: Number.NaN },
    })).toBe('tokens.input must be a finite number');
  });

  it('reports the payload fields a driver sent that the CLI does not read', () => {
    const report = parseReport({
      attempt: 'a00000000',
      revision: 1,
      outcome: 'success',
      driver: { ...driverA, region: 'eu' },
      tokenz: {},
    });
    if (typeof report === 'string') throw new Error(report);
    expect(report.ignored).toEqual(['tokenz', 'driver.region']);

    const known = parseReport({ attempt: 'a00000000', revision: 1, outcome: 'success', driver: driverA });
    if (typeof known === 'string') throw new Error(known);
    expect(known.ignored).toEqual([]);

    const next = parseNextPayload({ driver: { ...driverA, region: 'eu' }, extra: 1 });
    if (typeof next === 'string') throw new Error(next);
    expect(next.ignored).toEqual(['extra', 'driver.region']);

    const nextKnown = parseNextPayload({ driver: driverA, running: ['a00000000'], canTakeLease: true });
    if (typeof nextKnown === 'string') throw new Error(nextKnown);
    expect(nextKnown.ignored).toEqual([]);
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
    const released = await reportAttempt(config, runId, {
      attempt, revision: 1, outcome: 'released', driver: driverA, exitCode: 130, message: 'stopped',
    });
    expect(released).toMatchObject({ data: { accepted: true, step: { status: 'pending', outcome: 'released' } } });
    const stored = await readRun(config, runId);
    expect(stored).toMatchObject({ status: 'running', revision: 2, steps: [{ id: 'one', status: 'pending' }, { id: 'two', status: 'pending' }] });
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.steps[0]).toEqual({ id: 'one', status: 'pending' });

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
      stored.steps = stored.steps.map((step) => ({ ...step, status: 'succeeded', outcome: 'success', settledAt: 0 }));
      await saveRun(finishing.config, stored);
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
      { id: 'one', status: 'failed', outcome: 'failed', settledAt: 0 },
      { id: 'two', status: 'succeeded', outcome: 'success', settledAt: 0 },
    ];
    await saveRun(config, stored);

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
    expect(new Set(stored.steps.map((step) => (step.status === 'leased' ? step.lease.attempt : undefined)).filter(Boolean)).size).toBe(1);
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
    expect(end!.stepCounts).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 0, cancelled: 0 });
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
    expect(end!.stepCounts).toEqual({ total: 2, succeeded: 2, failed: 0, skipped: 0, cancelled: 0 });
  });

  it.each([
    ['the member', (config: LocalConfig) => { config.usageReportEnabled = false; }],
    ['the team', (config: LocalConfig) => {
      fs.writeFileSync(path.join(config.repo.localPath, 'teamai.yaml'), 'team: test\nrepo: local\nprovider: git\nusageReport: false\ntoolPaths:\n  claude:\n    skills: .claude/skills\n');
    }],
  ])('queues no run record and reports none when %s turned usage reporting off', async (_who, optOut) => {
    const { config, work } = testConfig();
    optOut(config);
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    fs.writeFileSync(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    await syncWorkflowDefinitions(config);

    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    expect(started.data).not.toHaveProperty('record');
    const runId = String(started.data.run);
    expect(await runLocalDriver(config, runId, work)).toEqual({ data: { done: { run: runId, outcome: 'succeeded' }, cancelled: [] } });
    expect(await leaseNext(config, runId, driverA)).toEqual({ data: { done: { run: runId, outcome: 'succeeded' }, cancelled: [] } });
    expect(await pendingRecords(config)).toEqual([]);
  });

  it('reports no record for a run that settled with usage reporting off, after reporting is turned back on', async () => {
    const { config, work } = testConfig();
    config.usageReportEnabled = false;
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    fs.writeFileSync(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    await syncWorkflowDefinitions(config);
    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    await runLocalDriver(config, runId, work);

    config.usageReportEnabled = true;
    expect(await leaseNext(config, runId, driverA)).toEqual({ data: { done: { run: runId, outcome: 'succeeded' }, cancelled: [] } });
  });

  it('refuses to start a run whose file it could not write, and publishes no start record', async () => {
    const { config } = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), TWO_STEPS);
    await syncWorkflowDefinitions(config);
    const locked = vi.spyOn(update, 'acquireLock').mockResolvedValue(false);
    try {
      const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });

      expect(started).toMatchObject({ error: { code: 'busy' } });
      expect(await pendingRecords(config)).toEqual([]);
    } finally {
      locked.mockRestore();
    }
  });

  it('reports no record for a run whose records could not be queued', async () => {
    const { config, work } = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    fs.writeFileSync(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    await syncWorkflowDefinitions(config);
    const queue = path.join(config.dataHome!, 'workflows', 'pending');
    fs.mkdirSync(path.dirname(queue), { recursive: true });
    fs.writeFileSync(queue, '');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const settling = await runLocalDriver(config, runId, work);
    const later = await leaseNext(config, runId, driverA);
    const warnings = warn.mock.calls.map(([message]) => message);
    warn.mockRestore();

    expect(later).toEqual({ data: { done: { run: runId, outcome: 'succeeded' }, cancelled: [] } });
    expect(settling).toEqual(later);
    expect(started.data).not.toHaveProperty('record');
    expect(await pendingRecords(config)).toEqual([]);
    expect(warnings).toEqual([
      expect.stringContaining(`[workflows] Could not queue the start record of run ${runId}, so the team report will not include it: `),
      expect.stringContaining(`[workflows] Could not queue the end record of run ${runId}, so the team report will not include it: `),
    ]);
  });

  it('reports the record state of the requested run, not of another queued run', async () => {
    const { config, work, runId } = await startBuild(TWO_STEPS);
    fs.writeFileSync(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    fs.writeFileSync(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    await runLocalDriver(config, runId, work);
    // The fixture has no reports remote; clearing this run's queue entries stands in for a delivery.
    const queue = path.join(config.dataHome!, 'workflows', 'pending');
    for (const file of fs.readdirSync(queue)) if (file.startsWith(`${runId}.`)) fs.rmSync(path.join(queue, file));
    const other = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
    if ('error' in other) throw new Error(other.error.message);
    expect(other.data.record).toBe('pending');

    expect(await leaseNext(config, runId, driverA)).toEqual({ data: { done: { run: runId, outcome: 'succeeded', record: 'published' }, cancelled: [] } });
  });

  it('counts the attempts a run settled before the iteration counter existed', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);
    const leased = await leaseNext(config, runId, driverA);
    if ('error' in leased) throw new Error(leased.error.message);
    const lease = leased.data.lease as { attempt: string; revision: number };
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    // A run file from before settledCount: five settled attempts and no counter.
    await saveRun(config, { ...stored, settledAttempts: ['x1', 'x2', 'x3', 'x4', 'x5'], settledCount: undefined });

    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: driverA });

    const after = await readRun(config, runId);
    if (typeof after !== 'object') throw new Error('run missing');
    expect(after.settledCount).toBe(6);
  });

  it('passes env to a command as variables over the inherited environment, never as shell', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: label
    command: node -e "require('fs').writeFileSync('title.txt', process.env.TITLE + '|' + (process.env.PATH && 'inherited'))"
    env:
      TITLE: "{{ inputs.title }}"
`, 'inputs:\n  title: string\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { title: '$(touch pwned)' }, { secrets: await knownSecrets(fixture.config) });
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
    expect(await leaseNext(config, runId, driverA)).toEqual({ data: { done: { run: runId, record: 'pending', ...expected }, cancelled: [] } });
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

  it('reads an array element by index in an if, and an index out of range as null', async () => {
    const { config, runId } = await startBuild(graph(`  - id: review
    command: node review.js
    output:
      files: [string]
  - id: fix
    needs: [review]
    if: steps.review.outputs.files[1] == 'b.ts'
    command: node fix.js
  - id: third
    needs: [review]
    if: steps.review.outputs.files[2] != null
    command: node third.js
`));
    const first = await leaseNext(config, runId, driverA);
    if ('error' in first) throw new Error(first.error.message);
    const lease = first.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { files: ['a.ts', 'b.ts'] }, driver: driverA });

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['fix']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{}, { id: 'fix', status: 'succeeded' }, { id: 'third', status: 'skipped' }] });
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

  it('compares numbers and runs a predicate over a list, and waits for every step a predicate reads', async () => {
    // gate is skipped as soon as build fails, while late is still pending; deploy reads late only inside its predicate.
    const { config, runId } = await startBuild(graph(`  - id: build
    command: node build.js
  - id: docs
    needs: []
    command: node docs.js
    output:
      pages: [{ size: number }]
  - id: gate
    needs: [build, late]
    command: node gate.js
  - id: deploy
    needs: [gate, docs]
    if: length(steps.docs.outputs.pages) == 2 && steps.docs.outputs.pages[0].size < 10 && any(steps.docs.outputs.pages, .size > 10 && steps.late.outcome == 'success')
    command: node deploy.js
  - id: late
    needs: []
    command: node late.js
`));
    const leased: string[] = [];
    for (;;) {
      const next = await leaseNext(config, runId, driverA);
      if ('error' in next) throw new Error(next.error.message);
      if (next.data.done) break;
      const lease = next.data.lease as { step: string; attempt: string; revision: number };
      leased.push(lease.step);
      const outputs = lease.step === 'docs' ? { pages: [{ size: 5 }, { size: 50 }] } : undefined;
      await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: lease.step === 'build' ? 'failed' : 'success', ...(outputs ? { outputs } : {}), driver: driverA });
    }

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
    const started = await startRun(fixture.config, 'build', { ship: true }, { secrets: await knownSecrets(fixture.config) });
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

    expect(await startRun(fixture.config, 'build', inputs, { secrets: await knownSecrets(fixture.config) })).toEqual({ error: { code: 'invalid_inputs', message } });
    expect(fs.existsSync(path.join(fixture.config.dataHome!, 'workflows', 'runs'))).toBe(false);
  });

  it.each([
    ['an input that holds a secret value', '    command: node fix.js\n', { DEPLOY_TOKEN: 'Bearer deploy-secret-value-1082' },
      'inputs.DEPLOY_TOKEN holds the value of DEPLOY_TOKEN, a secret on this machine, which a run never stores. Pass the step a way to read DEPLOY_TOKEN instead, such as requires.env: [DEPLOY_TOKEN].'],
    ['a workflow that holds a secret value', '    command: node fix.js deploy-secret-value-1082\n', { DEPLOY_TOKEN: 'plain' },
      'workflows/build.yaml holds the value of DEPLOY_TOKEN, a secret on this machine, which a run never stores. Replace the value with requires.env: [DEPLOY_TOKEN], then pull again.'],
  ])('refuses %s with invalid_inputs naming the key, never the value', async (_case, step, inputs, message) => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value-1082');
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: fix\n${step}`, 'inputs:\n  DEPLOY_TOKEN: string\n'));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'build', inputs, { secrets: await knownSecrets(fixture.config) })).toEqual({ error: { code: 'invalid_inputs', message } });
    expect(fs.existsSync(runsDir(fixture.config))).toBe(false);
  });

  it.each([
    ['', ''],
    [' a step requires', '    requires: { env: [GH_TOKEN] }\n'],
  ])('refuses the environment value of a secret%s whose team value differs, naming the key', async (_case, requires) => {
    vi.stubEnv('GH_TOKEN', 'personal-token-value-1082');
    const fixture = testConfig();
    fs.mkdirSync(path.join(fixture.config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GH_TOKEN\n');
    await writeSecretStore(getTeamSecretsPath(fixture.config), { GH_TOKEN: { value: 'team-token-value-1082' } });
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: fix\n    command: node fix.js\n${requires}`, 'inputs:\n  note: string\n'));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'build', { note: 'personal-token-value-1082' }, { secrets: await knownSecrets(fixture.config) })).toMatchObject({ error: { code: 'invalid_inputs', message: expect.stringContaining('requires.env: [GH_TOKEN]') } });
    expect(await startRun(fixture.config, 'build', { note: 'team-token-value-1082' }, { secrets: await knownSecrets(fixture.config) })).toMatchObject({ error: { code: 'invalid_inputs', message: expect.stringContaining('requires.env: [GH_TOKEN]') } });
  });

  it('starts a workflow that holds the environment value of a required key the team does not declare secret', async () => {
    vi.stubEnv('DEPLOY_ENV', 'production-eu-west');
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: deploy
    command: echo production-eu-west
    requires: { env: [DEPLOY_ENV] }
`));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) })).toMatchObject({ data: { status: 'running' } });
  });

  it('keeps the lease of a driver whose checkout path is the value of a required key', async () => {
    const checkout = '/tmp/teamai-checkout-1082';
    vi.stubEnv('PWD', checkout);
    const driver: DriverIdentity = { kind: 'external', machine: 'a', workspace: checkout };
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph('  - id: fix\n    command: node fix.js\n    requires: { env: [PWD] }\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const fix = leaseIn(await leaseNext(fixture.config, runId, driver, { can: { env: true } }));

    expect(await leaseNext(fixture.config, runId, driver, { can: { env: true }, running: [fix.attempt] })).toMatchObject({ data: { cancelled: [] } });
    expect(await reportAttempt(fixture.config, runId, { attempt: fix.attempt, revision: fix.revision, outcome: 'success', driver })).not.toHaveProperty('error');
  });

  it.each(['GH_TOKEN', 'VALUE'])('refuses the environment value of declared %s whose team value differs, naming the key', async (key) => {
    vi.stubEnv(key, 'personal-token-value-1082');
    const fixture = testConfig();
    fs.mkdirSync(path.join(fixture.config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'env', 'secrets.yaml'), `secrets:\n  - key: ${key}\n`);
    await writeSecretStore(getTeamSecretsPath(fixture.config), { [key]: { value: 'team-token-value-1082' } });
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph('  - id: fix\n    command: node fix.js\n', 'inputs:\n  note: string\n'));
    await syncWorkflowDefinitions(fixture.config);

    expect(await startRun(fixture.config, 'build', { note: 'personal-token-value-1082' }, { secrets: await knownSecrets(fixture.config) })).toMatchObject({ error: { code: 'invalid_inputs', message: expect.stringContaining(`requires.env: [${key}]`) } });
    expect(await startRun(fixture.config, 'build', { note: 'team-token-value-1082' }, { secrets: await knownSecrets(fixture.config) })).toMatchObject({ error: { code: 'invalid_inputs', message: expect.stringContaining(`requires.env: [${key}]`) } });
  });

  it('warns that it cannot mask the team secrets when their store cannot be read', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const fixture = testConfig();
    fs.mkdirSync(path.join(fixture.config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GH_TOKEN\n');
    fs.mkdirSync(path.dirname(getTeamSecretsPath(fixture.config)), { recursive: true });
    fs.writeFileSync(getTeamSecretsPath(fixture.config), '{ not json');
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph('  - id: fix\n    command: node fix.js\n'));
    await syncWorkflowDefinitions(fixture.config);
    expect(await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) })).toMatchObject({ data: { status: 'running' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not mask the team\'s secret values'));
  });

  it('fails env_conflict only for a step env that shadows a team secret or a required key, not a plain team variable', async () => {
    const fixture = testConfig();
    fs.mkdirSync(path.join(fixture.config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'env', 'env.yaml'), 'variables:\n  - key: NODE_ENV\n    value: production\n');
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: GH_TOKEN\n');
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: test
    command: npm test
    env: { NODE_ENV: test }
  - id: push
    needs: [test]
    command: git push
    env: { GH_TOKEN: plain }
`));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const test = leaseIn(await leaseNext(fixture.config, runId, driverA, { can: { env: true } }));
    expect(test.step).toBe('test');
    await reportAttempt(fixture.config, runId, { attempt: test.attempt, revision: test.revision, outcome: 'success', driver: driverA });
    expect(await leaseNext(fixture.config, runId, driverA, { can: { env: true } })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(fixture.config, runId)).toMatchObject({ steps: [{ id: 'test', status: 'succeeded' }, { id: 'push', status: 'failed', failure: { code: 'env_conflict' } }] });
  });

  it('starts a run whose input shares a name with a secret env key', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-secret-value-1082');
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph('  - id: fix\n    command: node fix.js\n', 'inputs:\n  DEPLOY_TOKEN: string\n'));
    await syncWorkflowDefinitions(fixture.config);

    const started = await startRun(fixture.config, 'build', { DEPLOY_TOKEN: 'staging' }, { secrets: await knownSecrets(fixture.config) });
    const stored = await readRun(fixture.config, String('data' in started ? started.data.run : ''));
    expect(typeof stored === 'object' ? stored.inputs : stored).toEqual({ DEPLOY_TOKEN: 'staging' });
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
    const started = await startRun(fixture.config, 'build', { issue: 42, title: 'Crash' }, { secrets: await knownSecrets(fixture.config) });
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
    const started = await startRun(fixture.config, 'build', { issue: 42, title: '$(touch pwned)' }, { secrets: await knownSecrets(fixture.config) });
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
    const started = await startRun(fixture.config, 'build', { owner: 'tencent', repo: 'teamai-cli' }, { secrets: await knownSecrets(fixture.config) });
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
    await saveRun(config, run);

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
    await saveRun(config, run);

    expect(await leaseNext(config, runId, driverA)).toMatchObject({
      error: { code: 'run_unreadable', message: expect.stringContaining('step "label" has an if that does not parse') },
    });
  });

  it('types the id of a step instance as read-only', () => {
    const rename = (run: RunState): void => {
      // @ts-expect-error The engine indexes instances by id, so an instance never changes its id.
      run.steps[0]!.id = 'x';
    };
    expect(rename).toBeTypeOf('function');
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
  const started = await startRun(fixture.config, name, inputs, { secrets: await knownSecrets(fixture.config) });
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

/**
 * Saves the cached copy of `name`; the returned function writes it back, as a cache another teamai build wrote
 * can be left. Pull no longer keeps a copy that does not fit the workflows it runs, and start still refuses one.
 */
function saveCachedCopy(config: LocalConfig, name: string): () => void {
  const home = config.dataHome ?? '';
  const entry = fs.readdirSync(home, { recursive: true, encoding: 'utf8' }).find((file) => file.endsWith(`cache${path.sep}${name}.json`));
  if (entry === undefined) throw new Error(`no cached copy of ${name}`);
  const saved = fs.readFileSync(path.join(home, entry));
  return () => fs.writeFileSync(path.join(home, entry), saved);
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
    const restoreShip = saveCachedCopy(fixture.config, 'ship');
    fs.writeFileSync(path.join(workflows, 'check.yaml'), `${CHECK}    future_option: 10m\n`);
    await syncWorkflowDefinitions(fixture.config);
    restoreShip();

    expect(await startRun(fixture.config, 'ship', {}, { secrets: await knownSecrets(fixture.config) })).toEqual({ error: {
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
    const second = await startRun(config, 'ship', {}, { secrets: await knownSecrets(config) });
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
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([{ id: 'deploy', status: 'succeeded', outcome: 'success', inputs: { late: 'success' }, settledAt: expect.any(Number) }]) });
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
    expect(done).toEqual({ data: { done: { run: runId, record: 'pending', outcome: 'succeeded' }, cancelled: [] } });
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
    await saveRun(config, run);

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

  it('refuses to start a workflow that runs itself through a cached copy', async () => {
    const fixture = testConfig();
    const workflows = path.join(fixture.config.repo.localPath, 'workflows');
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: check
    workflow: check
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), CHECK);
    await syncWorkflowDefinitions(fixture.config);
    const restoreShip = saveCachedCopy(fixture.config, 'ship');
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: check
    command: node check.js
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), workflow('check', `  - id: again
    workflow: ship
`));
    await syncWorkflowDefinitions(fixture.config);
    // The cache now holds check running ship next to the ship that runs check.
    restoreShip();

    expect(await startRun(fixture.config, 'ship', {}, { secrets: await knownSecrets(fixture.config) })).toEqual({ error: {
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
    const started = await startRun(fixture.config, 'build', { issue: 42 }, { secrets: await knownSecrets(fixture.config) });
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
    run.definition.steps[0].with = { task: '{{ inputs.task = 1 }}' };
    await saveRun(config, run);

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['label']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'fix', status: 'failed', failure: { code: 'invalid_template', message: 'step "fix" with template {{ inputs.task = 1 }}: unexpected "="' } },
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
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    // The inline workflow reads the enclosing inputs; its step does not store them.
    expect(stored.steps.find((step) => step.id === 'check')).toEqual({ id: 'check', status: 'succeeded', outcome: 'success', settledAt: 4 });
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
    const restoreShip = saveCachedCopy(fixture.config, 'ship');
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), workflow('ship', `  - id: outer
    command: node check.js
`));
    fs.writeFileSync(path.join(workflows, 'check.yaml'), workflow('check', `  - id: again
    workflow: ship
`));
    await syncWorkflowDefinitions(fixture.config);
    // The cache now holds check running ship next to the ship that runs check.
    restoreShip();

    expect(await startRun(fixture.config, 'ship', {}, { secrets: await knownSecrets(fixture.config) })).toEqual({ error: {
      code: 'workflow_recursion',
      message: 'Workflow "ship" cannot start: its sub-workflows run in a cycle: ship -> check -> ship',
    } });
  });

  it('settles a workflow step whose only child its if skips, then leases the step after it, in serial order', async () => {
    const { config, runId } = await startTree({ ship: workflow('ship', `  - id: w
    workflow:
      steps:
        - id: only
          if: inputs.skip
          command: node only.js
  - id: after
    needs: [w]
    command: node after.js
`, 'inputs:\n  skip: boolean\n') }, 'ship', { skip: false });

    const { leased, done } = await drive(config, runId);

    expect(leased).toEqual(['after']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'w', status: 'succeeded' },
      { id: 'w.only', status: 'skipped' },
      { id: 'after', status: 'succeeded' },
    ] });
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
      { step: 'check', pass: 1, outcome: 'success' },
      { step: 'check.classify', pass: 1, agent: { definition: { name: 'classifier' } }, tool: 'claude', model: 'claude-sonnet', outcome: 'success', tokens: { input: 10, output: 5 } },
      { step: 'check.comment', pass: 1, outcome: 'success' },
      { step: 'fix', pass: 1, agent: { definition: { name: 'implementer' } }, tool: 'codex', model: 'gpt-codex', outcome: 'success', tokens: { input: 20, output: 8 } },
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
      { step: 'build', pass: 1, outcome: 'success' },
      { step: 'retry', pass: 1 },
      { step: 'done', pass: 1, outcome: 'success' },
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
      { step: 'review', pass: 1, outcome: 'success' },
      { step: 'review.read', pass: 1, agent: { definition: { name: 'reviewer' } }, outcome: 'success' },
      { step: 'check', pass: 1, outcome: 'failed' },
      { step: 'check.classify', pass: 1, outcome: 'success' },
      { step: 'check.comment', pass: 1, outcome: 'failed' },
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

  it('publishes no failure code a driver reported', async () => {
    const { config, runId } = await startBuild(TWO_STEPS);

    await driveWith(config, runId, { one: { outcome: 'failed', failure: { code: 'secret-x', message: 'secret-x happened' } } });

    const record = await endRecord(config);
    expect(record).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(record)).not.toContain('secret-x');
  });

  it('counts and marks cancelled steps, and publishes every pass a loop ran with its own tokens', async () => {
    const fan = workflow('fan', `  - id: build
    for_each: inputs.targets
    command: node build.js
  - id: check
    needs: [build]
    command: node check.js
    loop: { back_to: build, while: "length(steps.check.passes) < 3", max_iterations: 3 }
  - id: deploy
    needs: [check]
    for_each: { items: inputs.targets, max_parallel: 1 }
    command: node deploy.js
  - id: stop
    needs: [check]
    command: node stop.js
    end: done
`, 'inputs:\n  targets: [string]\nends:\n  done: succeeded\n');
    const { config, runId } = await startTree({ fan }, 'fan', { targets: ['SENTINEL-web', 'SENTINEL-api'] });
    const reported: TokenUsage[] = [];
    const running: string[] = [];
    for (;;) {
      const next = await leaseNext(config, runId, driverA, { running });
      if ('error' in next) throw new Error(next.error.message);
      if (next.data.done) break;
      const lease = leaseIn(next);
      // A deploy item is still running when stop ends the workflow, which cancels it.
      if (lease.step.startsWith('deploy')) {
        running.push(lease.attempt);
        continue;
      }
      const tokens = { input: 100 + reported.length, output: reported.length + 1 };
      reported.push(tokens);
      await reportAttempt(config, runId, { ...lease, outcome: 'success', outputs: { note: 'SENTINEL-output' }, tokens, driver: driverA });
    }
    const sum = (usages: Array<TokenUsage | undefined>): TokenUsage => usages.reduce<TokenUsage>(
      (total, usage) => ({ input: (total.input ?? 0) + (usage?.input ?? 0), output: (total.output ?? 0) + (usage?.output ?? 0) }),
      { input: 0, output: 0 },
    );

    const record = await endRecord(config);
    if (!record?.stepCounts || !record.steps) throw new Error('no end record');
    const { total, ...byStatus } = record.stepCounts;
    const entries = record.steps;

    expect(reported).toHaveLength(10);
    expect.soft(byStatus).toEqual({ succeeded: 5, failed: 0, skipped: 1, cancelled: 2 });
    expect.soft(total).toBe(Object.values(byStatus).reduce((all, count) => all + count, 0));
    expect.soft(sum(entries.map((entry) => entry.tokens))).toEqual(sum(reported));
    const passes = (step: string): typeof entries => entries.filter((entry) => entry.step === step).sort((a, b) => (a.pass ?? 0) - (b.pass ?? 0));
    expect(passes('check')).toEqual([2, 5, 8].map((index, pass) => ({ step: 'check', pass: pass + 1, outcome: 'success', tokens: reported[index] })));
    expect(passes('build[0]')).toEqual([0, 3, 6].map((index, pass) => ({ step: 'build[0]', pass: pass + 1, outcome: 'success', tokens: reported[index] })));
    expect(passes('stop')).toEqual([{ step: 'stop', pass: 1, outcome: 'success', tokens: reported[9] }]);
    expect(passes('deploy')).toEqual([{ step: 'deploy', pass: 1, outcome: 'cancelled' }]);
    expect(passes('deploy[0]')).toEqual([{ step: 'deploy[0]', pass: 1, outcome: 'cancelled' }]);
    expect(passes('deploy[1]')).toEqual([{ step: 'deploy[1]', pass: 1 }]);
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
  });

  it('gives its agent to the pass of an item that a later pass of the loop no longer has', async () => {
    const fan = workflow('fan', `  - id: plan
    command: node plan.js
    output:
      targets: [string]
  - id: build
    needs: [plan]
    for_each: steps.plan.outputs.targets
    workflow:
      steps:
        - id: review
          prompt: "Review {{ item }}."
          agent: reviewer
  - id: check
    needs: [build]
    command: node check.js
    loop: { back_to: plan, while: "length(steps.check.passes) < 2", max_iterations: 2 }
`);
    const { config, runId } = await startTree({ fan }, 'fan');

    const { leased } = await driveLoop(config, runId, (lease, earlier) => (lease.step === 'plan' ? { outputs: { targets: earlier === 0 ? ['web'] : [] } } : {}));

    expect(leased).toEqual(['plan#1', 'build[0].review#1', 'check#1', 'plan#2', 'check#2']);
    expect((await endRecord(config))?.steps?.filter((entry) => entry.step === 'build[0].review')).toEqual([
      { step: 'build[0].review', pass: 1, agent: { definition: { name: 'reviewer' } }, outcome: 'success' },
    ]);
  });
});

/** The lease a `next` envelope hands out; throws on anything else. */
function leaseIn(envelope: Awaited<ReturnType<typeof leaseNext>>): { step: string; attempt: string; revision: number } {
  if ('error' in envelope || !envelope.data.lease) throw new Error(`expected a lease, got ${JSON.stringify(envelope)}`);
  return envelope.data.lease as { step: string; attempt: string; revision: number };
}

describe('parallel leases', () => {
  const ROOTS = graph(`  - id: a
    command: node a.js
  - id: b
    needs: []
    command: node b.js
  - id: join
    needs: [a, b]
    command: node join.js
`);

  it('leases a second root while the driver lists the first as running', async () => {
    const { config, runId } = await startBuild(ROOTS);
    const a = leaseIn(await leaseNext(config, runId, driverA));

    const b = await leaseNext(config, runId, driverA, { running: [a.attempt] });

    expect(a.step).toBe('a');
    expect(b).toMatchObject({ data: { lease: { step: 'b', revision: 1 }, cancelled: [] } });
    expect(leaseIn(b).attempt).not.toBe(a.attempt);
  });

  it('hands its open lease back to a driver that lists no running attempts', async () => {
    const { config, runId } = await startBuild(ROOTS);
    const first = await leaseNext(config, runId, driverA);

    const again = await leaseNext(config, runId, driverA);

    expect(leaseIn(first).step).toBe('a');
    expect(again).toEqual(first);
  });

  it('lists as cancelled a running attempt that is not an open lease of the driver', async () => {
    const { config, runId } = await startBuild(ROOTS);

    const next = await leaseNext(config, runId, driverA, { running: ['a00000000'] });

    expect(next).toMatchObject({ data: { lease: { step: 'a' }, cancelled: ['a00000000'] } });
  });

  it('hands an unlisted lease back to a restarted driver before a step declared earlier that became ready', async () => {
    const { config, runId } = await startBuild(graph(`  - id: gate
    command: node gate.js
  - id: step1
    needs: [gate]
    command: node step1.js
  - id: step2
    needs: []
    command: node step2.js
`));
    const gate = leaseIn(await leaseNext(config, runId, driverA));
    const step2 = await leaseNext(config, runId, driverA, { running: [gate.attempt] });
    await reportAttempt(config, runId, { ...gate, outcome: 'success', driver: driverA });

    const restarted = await leaseNext(config, runId, driverA);

    expect(leaseIn(step2).step).toBe('step2');
    expect(restarted).toEqual(step2);
  });

  it('settles a workflow step whose only child its if skips, and leases what needs it while another lease runs', async () => {
    const fixture = testConfig();
    fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', 'build.yaml'), graph(`  - id: a
    command: node a.js
  - id: w
    needs: []
    workflow:
      steps:
        - id: only
          if: inputs.skip
          command: node only.js
  - id: after
    needs: [w]
    command: node after.js
`, 'inputs:\n  skip: boolean\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', { skip: false }, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const a = leaseIn(await leaseNext(fixture.config, runId, driverA));

    const after = await leaseNext(fixture.config, runId, driverA, { running: [a.attempt] });

    expect(after).toMatchObject({ data: { lease: { step: 'after' } } });
    expect(await readRun(fixture.config, runId)).toMatchObject({ steps: [
      { id: 'a', status: 'leased' },
      { id: 'w', status: 'succeeded' },
      { id: 'w.only', status: 'skipped' },
      { id: 'after', status: 'leased' },
    ] });
  });

  it('checks a report against the revision of its own lease, not the run revision a sibling report made', async () => {
    const { config, runId } = await startBuild(ROOTS);
    const a = leaseIn(await leaseNext(config, runId, driverA));
    const b = leaseIn(await leaseNext(config, runId, driverA, { running: [a.attempt] }));
    await reportAttempt(config, runId, { ...a, outcome: 'success', driver: driverA });

    const stale = await reportAttempt(config, runId, { ...b, revision: 2, outcome: 'success', driver: driverA });

    expect(stale).toEqual({ error: { code: 'stale_revision', message: `Revision 2 is stale; attempt ${b.attempt} was leased at 1` } });
    expect(await reportAttempt(config, runId, { ...b, outcome: 'success', driver: driverA })).toMatchObject({ data: { accepted: true, revision: 3 } });
  });

  const W = `  - id: w
    needs: []
    workflow:
      steps:
        - id: c1
          command: node c1.js
    end: a
`;
  const C2 = `  - id: c2
    needs: []
    command: node c2.js
    end: b
`;
  const C3 = `  - id: c3
    needs: []
    command: node c3.js
`;
  it.each([
    ['the workflow step is declared first', `${W}${C2}${C3}`],
    ['the other end is declared first', `${C2}${W}${C3}`],
  ])('applies the end reported first when three reports arrive with no next between them and %s', async (_order, steps) => {
    const { config, runId } = await startBuild(graph(steps, 'ends:\n  a: succeeded\n  b: failed\n'));
    const leases = new Map<string, { step: string; attempt: string; revision: number }>();
    for (let i = 0; i < 3; i += 1) {
      const lease = leaseIn(await leaseNext(config, runId, driverA, { running: [...leases.values()].map((item) => item.attempt) }));
      leases.set(lease.step, lease);
    }
    for (const step of ['w.c1', 'c2', 'c3']) {
      expect(await reportAttempt(config, runId, { ...leases.get(step)!, outcome: 'success', driver: driverA })).toMatchObject(
        step === 'w.c1' ? { data: { accepted: true } } : { error: { code: 'lease_cancelled' } },
      );
    }

    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { run: runId, outcome: 'succeeded', end: 'a' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ id: 'w', status: 'succeeded', settledAt: 2 }),
      expect.objectContaining({ id: 'c2', status: 'cancelled', settledAt: 2 }),
    ]) });
  });

  it('stamps a step it cannot render with when it became ready, not with when next ran', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: other
    needs: []
    command: node other.js
  - id: label
    needs: [check]
    command: node label.js
    env:
      TITLE: fixed
`));
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    run.definition.steps[2]!.env = { TITLE: '{{ inputs.a b }}' };
    await saveRun(config, run);
    const check = leaseIn(await leaseNext(config, runId, driverA));
    const other = leaseIn(await leaseNext(config, runId, driverA, { running: [check.attempt] }));
    await reportAttempt(config, runId, { ...check, outcome: 'success', driver: driverA });
    await reportAttempt(config, runId, { ...other, outcome: 'success', driver: driverA });

    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'check', settledAt: 2 },
      { id: 'other', settledAt: 3 },
      { id: 'label', status: 'failed', settledAt: 2, failure: { code: 'invalid_template' } },
    ] });
  });

  it('stamps an open lease it cannot render again with the revision it was leased at', async () => {
    const { config, runId } = await startBuild(ROOTS);
    const a = leaseIn(await leaseNext(config, runId, driverA));
    const b = leaseIn(await leaseNext(config, runId, driverA, { running: [a.attempt] }));
    await reportAttempt(config, runId, { ...b, outcome: 'success', driver: driverA });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error('run missing');
    run.definition.steps[0]!.env = { TITLE: '{{ inputs.a b }}' };
    await saveRun(config, run);

    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'a', status: 'failed', settledAt: 1, failure: { code: 'invalid_template' } },
      { id: 'b', settledAt: 2 },
      { id: 'join', status: 'skipped' },
    ] });
  });

  it('orders an end-only step by the report that reached it, not by when next settled it', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    command: node check.js
  - id: other
    needs: []
    command: node other.js
    end: late
  - id: handle
    needs: [check]
    end: early
`, 'ends:\n  early: succeeded\n  late: failed\n'));
    const check = leaseIn(await leaseNext(config, runId, driverA));
    const other = leaseIn(await leaseNext(config, runId, driverA, { running: [check.attempt] }));
    await reportAttempt(config, runId, { ...check, outcome: 'success', driver: driverA });
    await reportAttempt(config, runId, { ...other, outcome: 'success', driver: driverA });

    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { outcome: 'succeeded', end: 'early' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'check', settledAt: 2 },
      { id: 'other', status: 'cancelled', settledAt: 2 },
      { id: 'handle', status: 'succeeded', settledAt: 2 },
    ] });
  });

  it('reaches a finished workflow end past a ready step when the driver takes no lease, and cancels what still runs', async () => {
    const { config, runId } = await startBuild(graph(`  - id: trigger
    command: node trigger.js
  - id: spare
    needs: [trigger]
    command: node spare.js
  - id: w
    needs: []
    workflow:
      steps:
        - id: finish
          command: node finish.js
    end: done
  - id: slow
    needs: []
    command: node slow.js
  - id: ask
    needs: []
    prompt: Ask.
`, 'ends:\n  done: succeeded\n'));
    const leases = new Map<string, { step: string; attempt: string; revision: number }>();
    for (let i = 0; i < 4; i += 1) {
      const lease = leaseIn(await leaseNext(config, runId, driverA, { running: [...leases.values()].map((item) => item.attempt) }));
      leases.set(lease.step, lease);
    }
    expect([...leases.keys()]).toEqual(['trigger', 'w.finish', 'slow', 'ask']);
    await reportAttempt(config, runId, { ...leases.get('trigger')!, outcome: 'success', driver: driverA });
    await reportAttempt(config, runId, { ...leases.get('w.finish')!, outcome: 'success', driver: driverA });
    const slow = leases.get('slow')!;
    const ask = leases.get('ask')!;

    const reconciled = await leaseNext(config, runId, driverA, { running: [slow.attempt, ask.attempt], canTakeLease: false });

    expect(reconciled).toEqual({ data: { done: { run: runId, record: 'pending', outcome: 'succeeded', end: 'done' }, cancelled: [slow.attempt, ask.attempt] } });
    expect(await readRun(config, runId)).toMatchObject({
      cancelledAttempts: [slow.attempt, ask.attempt],
      steps: [
        { id: 'trigger', status: 'succeeded' },
        { id: 'spare', status: 'skipped' },
        { id: 'w', status: 'succeeded' },
        { id: 'w.finish', status: 'succeeded' },
        { id: 'slow', status: 'cancelled', attempt: slow.attempt, failure: { code: 'end_reached', message: 'Cancelled: workflow "build" reached end "done"' } },
        { id: 'ask', status: 'cancelled', attempt: ask.attempt },
      ],
    });
    expect(await reportAttempt(config, runId, { ...slow, outcome: 'success', driver: driverB })).toEqual({ error: {
      code: 'lease_cancelled', message: `Attempt ${slow.attempt} was cancelled; its report is not recorded`,
    } });
  });

  it('cancels only what runs under a sub-workflow that reaches its end, and the run goes on', async () => {
    const { config, runId } = await startBuild(graph(`  - id: w
    workflow:
      ends:
        stopped: succeeded
      outputs:
        long: steps.long.outcome
      steps:
        - id: stop
          command: node stop.js
          end: stopped
        - id: long
          needs: []
          command: node long.js
  - id: other
    needs: []
    command: node other.js
  - id: after
    needs: [w]
    command: node after.js
    env:
      LONG: "{{ steps.w.outputs.long }}"
`));
    const stop = leaseIn(await leaseNext(config, runId, driverA));
    const long = leaseIn(await leaseNext(config, runId, driverA, { running: [stop.attempt] }));
    const other = leaseIn(await leaseNext(config, runId, driverA, { running: [stop.attempt, long.attempt] }));
    await reportAttempt(config, runId, { ...stop, outcome: 'success', driver: driverA });

    const after = await leaseNext(config, runId, driverA, { running: [long.attempt, other.attempt] });

    expect([stop.step, long.step, other.step]).toEqual(['w.stop', 'w.long', 'other']);
    expect(after).toMatchObject({ data: { lease: { step: 'after', env: { LONG: 'cancelled' } }, cancelled: [long.attempt] } });
    expect(await readRun(config, runId)).toMatchObject({ cancelledAttempts: [long.attempt], steps: [
      { id: 'w', status: 'succeeded', end: 'stopped', outputs: { long: 'cancelled' } },
      { id: 'w.stop', status: 'succeeded' },
      { id: 'w.long', status: 'cancelled', failure: { code: 'end_reached', message: 'Cancelled: step "w" inline workflow reached end "stopped"' } },
      { id: 'other', status: 'leased' },
      { id: 'after', status: 'leased' },
    ] });
  });

  it('waits while every ready step is leased and listed as running', async () => {
    const { config, runId } = await startBuild(ROOTS);
    const a = leaseIn(await leaseNext(config, runId, driverA));
    const b = leaseIn(await leaseNext(config, runId, driverA, { running: [a.attempt] }));

    const next = await leaseNext(config, runId, driverA, { running: [a.attempt, b.attempt] });

    expect(next).toEqual({ data: { wait: { reason: 'a is leased' }, cancelled: [] } });
  });

  it('leases a later root while a workflow step waits for its leased child', async () => {
    const { config, runId } = await startBuild(graph(`  - id: w
    workflow:
      steps:
        - id: x
          command: node x.js
  - id: c
    needs: []
    command: node c.js
`));
    const x = leaseIn(await leaseNext(config, runId, driverA));

    const c = await leaseNext(config, runId, driverA, { running: [x.attempt] });

    expect(x.step).toBe('w.x');
    expect(c).toMatchObject({ data: { lease: { step: 'c' }, cancelled: [] } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'w', status: 'running' },
      { id: 'w.x', status: 'leased' },
      { id: 'c', status: 'leased' },
    ] });
  });

  it('ends the run on a reported end before it hands an unlisted lease back to a restarted driver', async () => {
    const { config, runId } = await startBuild(graph(`  - id: slow
    command: node slow.js
  - id: finish
    needs: []
    command: node finish.js
    end: done
`, 'ends:\n  done: succeeded\n'));
    const slow = leaseIn(await leaseNext(config, runId, driverA));
    const finish = leaseIn(await leaseNext(config, runId, driverA, { running: [slow.attempt] }));
    await reportAttempt(config, runId, { ...finish, outcome: 'success', driver: driverA });

    const restarted = await leaseNext(config, runId, driverA);

    expect(restarted).toMatchObject({ data: { done: { run: runId, outcome: 'succeeded', end: 'done' } } });
    expect(await readRun(config, runId)).toMatchObject({ cancelledAttempts: [slow.attempt], steps: [{ id: 'slow', status: 'cancelled' }, { id: 'finish' }] });
    expect(await reportAttempt(config, runId, { ...slow, outcome: 'success', driver: driverA })).toMatchObject({ error: { code: 'lease_cancelled' } });
  });

  it('settles and saves without leasing when the driver takes no lease', async () => {
    const { config, runId } = await startBuild(graph(`  - id: a
    command: node a.js
  - id: w
    needs: []
    workflow:
      steps:
        - id: x
          command: node x.js
  - id: after
    needs: [w]
    command: node after.js
`));
    const a = leaseIn(await leaseNext(config, runId, driverA));
    const x = leaseIn(await leaseNext(config, runId, driverA, { running: [a.attempt] }));
    await reportAttempt(config, runId, { ...x, outcome: 'success', driver: driverA });

    const reconciled = await leaseNext(config, runId, driverA, { running: [a.attempt], canTakeLease: false });

    expect(reconciled).toEqual({ data: { wait: { reason: 'a is leased' }, cancelled: [] } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'a', status: 'leased' },
      { id: 'w', status: 'succeeded' },
      { id: 'w.x', status: 'succeeded' },
      { id: 'after', status: 'pending' },
    ] });
    expect(await leaseNext(config, runId, driverA, { running: [a.attempt] })).toMatchObject({ data: { lease: { step: 'after' } } });
  });
});

describe('held-back steps', () => {
  const base = { commit: 'b'.repeat(40) };
  const allModes = ['read-only', 'new', 'continue'] as const;

  it('leases a ready step this driver can run past one it holds back, and keeps that one pending', async () => {
    const { config, runId } = await startBuild(graph(`  - id: a
    workspace: new
    command: node a.js
  - id: b
    needs: []
    command: node b.js
`));

    const next = await leaseNext(config, runId, driverA, { can: { workspace: ['read-only'] } });

    expect(next).toMatchObject({ data: { lease: { step: 'b' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'leased' }] });
    await reportAttempt(config, runId, { ...leaseIn(next), outcome: 'success', driver: driverA });
    const reason = 'step "a" needs workspace new, which this driver does not provide';
    expect(await leaseNext(config, runId, driverA, { can: { workspace: ['read-only'] } })).toEqual({ data: {
      wait: { reason, held: [{ step: 'a', reason, missing: ['workspace.new'] }] }, cancelled: [],
    } });
  });

  it('lets another driver take a new copy a driver handed back unused for a capability it lost', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-value');
    const { config, runId } = await startBuild(graph(`  - id: a
    workspace: new
    requires: { env: [DEPLOY_TOKEN] }
    command: node a.js
`));
    const first = await leaseNext(config, runId, driverA, { can: { workspace: [...allModes], env: true }, base });
    expect(first).toMatchObject({ data: { lease: { step: 'a', workspace: { branch: expect.stringMatching(/a/) } } } });
    expect(await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base })).toMatchObject({
      data: { wait: { held: [{ step: 'a', missing: ['env'] }] } },
    });
    const taken = await leaseNext(config, runId, driverB, { can: { workspace: [...allModes], env: true }, base });
    expect(taken).toMatchObject({ data: { lease: { step: 'a', workspace: { branch: expect.stringMatching(/a/) } } } });
  });

  it('asks for setup on every lease with a workspace in a workflow that declares it, also one that continues a copy another lease opened', async () => {
    const fixture = testConfig();
    const workflows = path.join(fixture.config.repo.localPath, 'workflows');
    fs.writeFileSync(path.join(workflows, 'build.yaml'), graph(`  - id: box
    workspace: new
    workflow:
      steps:
        - id: a
          workspace: continue
          command: node a.js
        - id: b
          needs: [a]
          workflow: inner
`));
    fs.writeFileSync(path.join(workflows, 'inner.yaml'), 'schemaVersion: v1alpha1\nname: inner\ndescription: Inner.\nsetup:\n  command: npm ci\nsteps:\n  - id: c\n    workspace: continue\n    command: node c.js\n');
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const a = leaseIn(await leaseNext(fixture.config, runId, driverA, { can: { workspace: [...allModes] }, base }));
    expect(a.step).toBe('box.a');
    await reportAttempt(fixture.config, runId, { attempt: a.attempt, revision: a.revision, outcome: 'success', driver: driverA });
    expect(await leaseNext(fixture.config, runId, driverA, { can: { workspace: [...allModes] }, base })).toMatchObject({
      data: { wait: { held: [{ step: 'box.b.c', missing: ['setup'] }] } },
    });
    expect(await leaseNext(fixture.config, runId, driverA, { can: { workspace: [...allModes], setup: true }, base })).toMatchObject({
      data: { lease: { step: 'box.b.c', setup: { command: 'npm ci' } } },
    });
  });

  it('keeps setup on the lease that replaces a released one, since no report has used the copy yet', async () => {
    const { config, runId } = await startBuild(graph(`  - id: a
    workspace: new
    command: node a.js
`, 'setup:\n  command: npm ci\n'));
    const can = { workspace: [...allModes], setup: true };
    const first = await leaseNext(config, runId, driverA, { can, base });
    expect(first).toMatchObject({ data: { lease: { step: 'a', setup: { command: 'npm ci' } } } });
    await reportAttempt(config, runId, { ...leaseIn(first), outcome: 'released', driver: driverA });

    expect(await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base })).toMatchObject({
      data: { wait: { held: [{ step: 'a', missing: ['setup'] }] } },
    });
    expect(await leaseNext(config, runId, driverA, { can, base })).toMatchObject({
      data: { lease: { step: 'a', setup: { command: 'npm ci' } } },
    });
  });

  it('keeps a copy a step ran in with its owner when the owner hands back a later step it can no longer run', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-value');
    const { config, runId } = await startBuild(graph(`  - id: box
    workspace: new
    workflow:
      steps:
        - id: a
          workspace: continue
          command: node a.js
        - id: b
          needs: [a]
          workspace: continue
          requires: { env: [DEPLOY_TOKEN] }
          command: node b.js
`));
    const can = { workspace: [...allModes], env: true };
    const a = leaseIn(await leaseNext(config, runId, driverA, { can, base }));
    await reportAttempt(config, runId, { ...a, outcome: 'success', driver: driverA });
    expect(await leaseNext(config, runId, driverA, { can, base })).toMatchObject({ data: { lease: { step: 'box.b' } } });
    expect(await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base })).toMatchObject({
      data: { wait: { held: [{ step: 'box.b', missing: ['env'] }] } },
    });

    expect(await leaseNext(config, runId, driverB, { can, base })).toMatchObject({
      data: { wait: { reason: 'step "box.b" continues a workspace owned by another driver' } },
    });
  });

  it.each([
    ['its setup failed', { code: 'setup_failed', message: 'Setup "npm ci" exited with code 1, so the step did not run.' }],
    ['its workspace lacked a commit', { code: 'workspace_base', message: 'Step "box.a" needs commit abc, which this checkout does not have.' }],
    ['its base config could not be applied', { code: 'base_config', message: 'Could not apply the base config.' }],
  ])('carries setup again when a step is retried after %s, since the step never ran in the copy', async (_case, failure) => {
    const { config, runId } = await startBuild(graph(`  - id: box
    workspace: new
    workflow:
      steps:
        - id: a
          workspace: continue
          command: node a.js
`, 'setup:\n  command: npm ci\n'));
    const can = { workspace: [...allModes], setup: true };
    const a = leaseIn(await leaseNext(config, runId, driverA, { can, base }));
    await reportAttempt(config, runId, { ...a, outcome: 'failed', driver: driverA, failure });
    expect(await retryStep(config, runId, await knownSecrets(config), 'box.a')).toMatchObject({ data: {} });

    expect(await leaseNext(config, runId, driverA, { can, base })).toMatchObject({
      data: { lease: { step: 'box.a', setup: { command: 'npm ci' } } },
    });
  });

  it('lets another driver take the first step of an enclosing copy a driver handed back unused for a capability it lost', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-value');
    const { config, runId } = await startBuild(graph(`  - id: box
    workspace: new
    workflow:
      steps:
        - id: work
          workspace: continue
          requires: { env: [DEPLOY_TOKEN] }
          command: node work.js
`));
    const first = await leaseNext(config, runId, driverA, { can: { workspace: [...allModes], env: true }, base });
    expect(first).toMatchObject({ data: { lease: { step: 'box.work' } } });
    expect(await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base })).toMatchObject({
      data: { wait: { held: [{ step: 'box.work', missing: ['env'] }] } },
    });

    expect(await leaseNext(config, runId, driverB, { can: { workspace: [...allModes], env: true }, base })).toMatchObject({
      data: { lease: { step: 'box.work' } },
    });
  });

  it('keeps the copy with its owner when a held hand-back leaves the owner another lease in it', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-value');
    const { config, runId } = await startBuild(graph(`  - id: box
    workspace: new
    workflow:
      steps:
        - id: a
          workspace: continue
          requires: { env: [DEPLOY_TOKEN] }
          command: node a.js
        - id: b
          needs: []
          workspace: continue
          command: node b.js
`));
    const can = { workspace: [...allModes], env: true };
    const a = leaseIn(await leaseNext(config, runId, driverA, { can, base }));
    expect(a.step).toBe('box.a');
    const b = leaseIn(await leaseNext(config, runId, driverA, { can, base, running: [a.attempt] }));
    expect(b.step).toBe('box.b');
    expect(await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base, running: [b.attempt] })).toMatchObject({
      data: { wait: { held: [{ step: 'box.a', missing: ['env'] }] } },
    });
    await reportAttempt(config, runId, { ...b, outcome: 'success', exitCode: 0, driver: driverA });

    expect(await leaseNext(config, runId, driverB, { can, base })).toMatchObject({
      data: { wait: { reason: 'step "box.a" continues a workspace owned by another driver' } },
    });
  });

  it('gives a copy back its owner when the owner takes back a lease in it', async () => {
    const { config, runId } = await startBuild(graph(`  - id: box
    workspace: new
    workflow:
      steps:
        - id: a
          workspace: continue
          command: node a.js
        - id: b
          needs: [a]
          workspace: continue
          command: node b.js
`));
    const can = { workspace: [...allModes] };
    const a = leaseIn(await leaseNext(config, runId, driverA, { can, base }));
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run unreadable');
    for (const copy of Object.values(stored.copies ?? {})) delete copy.owner;
    await saveRun(config, stored);
    expect(await leaseNext(config, runId, driverA, { can, base })).toMatchObject({ data: { lease: { step: 'box.a' } } });
    await reportAttempt(config, runId, { ...a, outcome: 'success', exitCode: 0, driver: driverA });

    expect(await leaseNext(config, runId, driverB, { can, base })).toMatchObject({
      data: { wait: { reason: 'step "box.b" continues a workspace owned by another driver' } },
    });
  });

  it('waits when every ready step is held back, and names each one in order', async () => {
    const { config, runId } = await startBuild(graph(`  - id: a
    workspace: new
    command: node a.js
  - id: c
    needs: []
    workspace: new
    command: node c.js
`));

    const next = await leaseNext(config, runId, driverA, { can: { workspace: ['read-only'] } });

    expect(next).toEqual({ data: { wait: {
      reason: 'step "a" needs workspace new, which this driver does not provide; step "c" needs workspace new, which this driver does not provide',
      held: [
        { step: 'a', reason: 'step "a" needs workspace new, which this driver does not provide', missing: ['workspace.new'] },
        { step: 'c', reason: 'step "c" needs workspace new, which this driver does not provide', missing: ['workspace.new'] },
      ],
    }, cancelled: [] } });
  });

  it('leases the next item when the first one is held back, and still starts at most max_parallel items', async () => {
    const { config, runId } = await startTree({ build: workflow('build', `  - id: build
    for_each: { items: inputs.targets, max_parallel: 1 }
    workspace: new
    command: node build.js
`, 'inputs:\n  targets: [string]\n') }, 'build', { targets: ['web', 'api', 'cli'] });
    const web = leaseIn(await leaseNext(config, runId, driverB, { can: { workspace: [...allModes] }, base }));
    await reportAttempt(config, runId, { ...web, outcome: 'released', driver: driverB });

    const api = await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base });
    const full = await leaseNext(config, runId, driverA, { can: { workspace: [...allModes] }, base, running: [leaseIn(api).attempt] });

    expect(web.step).toBe('build[0]');
    expect(api).toMatchObject({ data: { lease: { step: 'build[1]' } } });
    expect(full).toEqual({ data: { wait: { reason: 'build[1] is leased' }, cancelled: [] } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'build', status: 'running' },
      { id: 'build[0]', status: 'pending' },
      { id: 'build[1]', status: 'leased' },
      { id: 'build[2]', status: 'pending' },
    ] });
  });
});

describe('causal settlement order', () => {
  it.each(['workflow', 'for_each'])('checks an end-only condition after a %s step settles', async (action) => {
    const build = action === 'workflow'
      ? '    workflow:\n      steps:\n        - id: run\n          command: echo build\n'
      : '    for_each: inputs.items\n    command: echo build\n';
    const body = graph(`  - id: build
${build}  - id: stop
    needs: [build]
    if: steps.build.outcome == 'failed'
    end: broke
  - id: after
    needs: [build]
    command: echo after
`, 'ends: { broke: failed }\ninputs: { items: [number] }\n');
    const { config } = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), body);
    expect((await syncWorkflowDefinitions(config)).invalid).toEqual([]);
    const started = await startRun(config, 'build', { items: [1] }, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const built = leaseIn(await leaseNext(config, runId, driverA));
    expect(built.step).toBe(action === 'workflow' ? 'build.run' : 'build[0]');
    await reportAttempt(config, runId, { ...built, outcome: 'success', driver: driverA });
    const after = leaseIn(await leaseNext(config, runId, driverA));
    expect(after.step).toBe('after');
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ id: 'stop', status: 'skipped' }),
    ]) });
    await reportAttempt(config, runId, { ...after, outcome: 'success', driver: driverA });
    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('stamps a capped item with the report that freed its slot', async () => {
    const build = workflow('build', `  - id: plan
    command: echo plan
  - id: build
    needs: [plan]
    for_each: { items: steps.plan.outputs.items, max_parallel: 1 }
    workflow: child
    with: { task: "{{ item.task }}" }
`);
    const child = workflow('child', '  - id: run\n    command: echo child\n', 'inputs: { task: string }\n');
    const { config, runId } = await startTree({ build, child }, 'build');
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs: { items: [{ task: 'valid' }, { task: 1 }] }, driver: driverA });
    const first = leaseIn(await leaseNext(config, runId, driverA));
    expect(first.step).toBe('build[0].run');
    await reportAttempt(config, runId, { ...first, outcome: 'success', driver: driverA });
    expect(await leaseNext(config, runId, driverA, { canTakeLease: false })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ id: 'build[1]', status: 'failed', settledAt: 3, failure: expect.objectContaining({ code: 'invalid_inputs' }) }),
    ]) });
  });

  it('keeps downstream reports identical when next reconciles a nested end between reports', async () => {
    const run = async (between: boolean) => {
      const { config, runId } = await startBuild(graph(`  - id: inner
    workflow:
      ends: { stop: succeeded }
      outputs: { review: steps.review.outputs.v, fix: steps.fix.outcome }
      steps:
        - id: review
          command: echo review
        - id: fix
          needs: [review]
          command: echo fix
          loop: { back_to: review, max_iterations: 3 }
        - id: guard
          needs: []
          command: echo guard
          end: stop
  - id: after
    needs: [inner]
    command: echo after
    env: { VALUE: "{{ steps.inner.outputs }}" }
`));
      const review = leaseIn(await leaseNext(config, runId, driverA));
      const guard = leaseIn(await leaseNext(config, runId, driverA, { running: [review.attempt] }));
      await reportAttempt(config, runId, { ...review, outcome: 'success', outputs: { v: 'one' }, driver: driverA });
      const fix = leaseIn(await leaseNext(config, runId, driverA, { running: [guard.attempt] }));
      await reportAttempt(config, runId, { ...guard, outcome: 'success', driver: driverA });
      if (between) await leaseNext(config, runId, driverA, { running: [fix.attempt], canTakeLease: false });
      await reportAttempt(config, runId, { ...fix, outcome: 'success', driver: driverA });
      const after = leaseIn(await leaseNext(config, runId, driverA));
      await reportAttempt(config, runId, { ...after, outcome: 'success', driver: driverA });
      expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      const stored = await readRun(config, runId);
      if (typeof stored !== 'object') throw new Error(`run ${stored}`);
      const names = new Map([review, guard, fix, after].map((lease) => [lease.attempt, lease.step]));
      return JSON.parse(JSON.stringify(stored.steps).replace(/"installId":"[^"]+"/g, '"installId":"<install>"').replace(/a[0-9a-f]{8}/g, (attempt) => names.get(attempt) ?? attempt));
    };
    expect(await run(false)).toEqual(await run(true));
  });

  it.each([
    ['invalid_items', '    for_each: steps.plan.outputs.items\n    command: echo build\n', { items: 1 }],
    ['item_cycle', '    for_each: steps.plan.outputs.items\n    command: echo build\n', { items: [{ id: 'a', after: ['b'] }, { id: 'b', after: ['a'] }] }],
    ['invalid_template', '    command: echo build\n    env: { TITLE: fixed }\n', {}],
    ['invalid_inputs', '    workflow: child\n    with: { task: "{{ steps.plan.outputs.task }}" }\n', { task: 1 }],
  ])('reconciles %s before a later end even without capacity for a lease', async (code, action, outputs) => {
    const body = workflow('build', `  - id: plan
    command: echo plan
  - id: build
    needs: [plan]
${action}  - id: failed
    needs: [build]
    if: steps.build.outcome == 'failed'
    end: failed
  - id: fast
    needs: []
    command: echo fast
    end: fast
`, 'ends: { failed: failed, fast: succeeded }\n');
    const child = workflow('child', '  - id: run\n    command: echo child\n', 'inputs: { task: string }\n');
    const { config, runId } = await startTree({ build: body, child }, 'build');
    if (code === 'invalid_template') {
      const stored = await readRun(config, runId);
      if (typeof stored !== 'object') throw new Error(`run ${stored}`);
      stored.definition.steps[1]!.env = { TITLE: '{{ inputs.bad path }}' };
      await saveRun(config, stored);
    }
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    const fast = leaseIn(await leaseNext(config, runId, driverA, { running: [plan.attempt] }));
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs, driver: driverA });
    expect(await reportAttempt(config, runId, { ...fast, revision: fast.revision + 1, outcome: 'success', driver: driverB }))
      .toMatchObject({ error: { code: 'lease_cancelled' } });
    await reportAttempt(config, runId, { ...fast, outcome: 'success', driver: driverA });
    expect(await leaseNext(config, runId, driverA, { running: [], canTakeLease: false })).toMatchObject({ data: { done: { outcome: 'failed', end: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ id: 'build', status: 'failed', settledAt: 2, failure: { code, message: expect.any(String) } }),
      expect.objectContaining({ id: 'fast', status: 'cancelled', settledAt: 2 }),
    ]) });
    expect(await reportAttempt(config, runId, { ...fast, outcome: 'success', driver: driverA })).toMatchObject({ error: { code: 'lease_cancelled' } });
  });

  it('carries the loop report revision through a driverless exhausted pass', async () => {
    const { config, runId } = await startBuild(graph(`  - id: review
    command: echo review
  - id: fix
    needs: [review]
    command: echo fix
    loop: { back_to: review, max_iterations: 1 }
  - id: failed
    needs: [fix]
    if: steps.fix.outcome == 'failed'
    end: failed
  - id: fast
    needs: []
    command: echo fast
    end: fast
`, 'ends: { failed: failed, fast: succeeded }\n'));
    const review = leaseIn(await leaseNext(config, runId, driverA));
    const fast = leaseIn(await leaseNext(config, runId, driverA, { running: [review.attempt] }));
    await reportAttempt(config, runId, { ...review, outcome: 'success', driver: driverA });
    const fix = leaseIn(await leaseNext(config, runId, driverA, { running: [fast.attempt] }));
    await reportAttempt(config, runId, { ...fix, outcome: 'success', driver: driverA });
    const secondReview = leaseIn(await leaseNext(config, runId, driverA, { running: [fast.attempt] }));
    await reportAttempt(config, runId, { ...secondReview, outcome: 'success', driver: driverA });
    await reportAttempt(config, runId, { ...fast, outcome: 'success', driver: driverA });
    expect(await leaseNext(config, runId, driverA, { running: [], canTakeLease: false })).toMatchObject({ data: { done: { outcome: 'failed', end: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ id: 'fix', status: 'failed', settledAt: 4, failure: expect.objectContaining({ code: 'loop_exhausted' }) }),
      expect.objectContaining({ id: 'fast', status: 'cancelled', settledAt: 4 }),
    ]) });
  });

  it.each([
    {
      name: 'an engine failure reaches an end before a later report',
      body: graph(`  - id: plan
    command: echo plan
  - id: build
    needs: [plan]
    for_each: steps.plan.outputs.items
    command: echo build
  - id: stop
    needs: [build]
    if: steps.build.outcome == 'failed'
    end: broke
  - id: fast
    needs: []
    command: echo fast
    end: won
`, 'ends: { won: succeeded, broke: failed }\n'),
      leases: ['plan', 'fast'],
      reports: [
        { step: 'plan', outcome: 'success', outputs: { items: 'not a list' } },
        { step: 'fast', outcome: 'success' },
      ],
      done: { outcome: 'failed', end: 'broke' },
    },
    {
      name: 'a late skip cannot reach an end before an earlier report',
      body: graph(`  - id: a
    command: echo a
  - id: direct
    needs: []
    command: echo direct
    end: direct
  - id: b
    needs: []
    command: echo b
  - id: skipped
    needs: [b]
    command: echo skip
  - id: derived
    needs: [a, skipped]
    if: steps.skipped.outcome == 'skipped'
    end: after_skip
`, 'ends: { direct: succeeded, after_skip: failed }\n'),
      leases: ['a', 'direct', 'b'],
      reports: [
        { step: 'a', outcome: 'success' },
        { step: 'direct', outcome: 'success' },
        { step: 'b', outcome: 'failed' },
      ],
      done: { outcome: 'succeeded', end: 'direct' },
    },
    {
      name: 'a later loop report preserves the results before the end',
      body: graph(`  - id: review
    command: echo review
  - id: fix
    needs: [review]
    command: echo fix
    loop: { back_to: review, max_iterations: 3 }
  - id: guard
    needs: []
    command: echo guard
    end: stop
`, 'ends: { stop: succeeded }\noutputs: { review: steps.review.outputs.v, fix: steps.fix.outcome }\n'),
      leases: ['review', 'guard', 'fix'],
      reports: [
        { step: 'review', outcome: 'success', outputs: { v: 'one' } },
        { step: 'guard', outcome: 'success' },
        { step: 'fix', outcome: 'success' },
      ],
      done: { outcome: 'succeeded', end: 'stop' },
    },
  ] satisfies Array<{
    name: string;
    body: string;
    leases: string[];
    reports: Array<{ step: string; outcome: 'success' | 'failed'; outputs?: unknown }>;
    done: { outcome: string; end: string };
  }>)('gives the same done and stored steps with next between reports when $name', async ({ body, leases, reports, done }) => {
    const run = async (between: boolean) => {
      const { config, runId } = await startBuild(body);
      const held = new Map<string, ReturnType<typeof leaseIn>>();
      const running = () => [...held.values()].map((lease) => lease.attempt);
      let reported = 0;
      for (const step of leases) {
        if (step === 'fix') {
          const first = reports[reported++]!;
          await reportAttempt(config, runId, { ...held.get(first.step)!, ...first, driver: driverA });
        }
        const next = leaseIn(await leaseNext(config, runId, driverA, { running: running() }));
        expect(next.step).toBe(step);
        held.set(step, next);
      }
      for (const report of reports.slice(reported)) {
        await reportAttempt(config, runId, { ...held.get(report.step)!, ...report, driver: driverA });
        if (between) await leaseNext(config, runId, driverA, { running: running(), canTakeLease: false });
      }
      const next = await leaseNext(config, runId, driverA, { running: running(), canTakeLease: false });
      expect(next).toMatchObject({ data: { done } });
      const stored = await readRun(config, runId);
      if (typeof stored !== 'object') throw new Error(`run ${stored}`);
      const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(runId, '<run>').replace(/"installId":"[^"]+"/g, '"installId":"<install>"').replace(/a[0-9a-f]{8}/g, (attempt) =>
        [...held.values()].find((lease) => lease.attempt === attempt)?.step ?? attempt));
      if ('error' in next) throw new Error(next.error.message);
      return { done: normalize(next.data.done), steps: normalize(stored.steps) };
    };
    const interleaved = await run(true);
    const batched = await run(false);
    expect(batched).toEqual(interleaved);
  });
});

describe('a run file written before loops and for_each', () => {
  // Written through `workflow next` and `report`: build succeeded, check ran an inline workflow
  // whose end-only step the engine settled, and ship was leased, then released.
  const FIXTURE = path.join(__dirname, 'fixtures', 'workflow', 'run-before-loops.json');

  it('reads the run and continues it', async () => {
    const { config } = testConfig();
    const runId = 'rdc7b5bd3';
    fs.mkdirSync(path.dirname(runFilePath(config, runId)), { recursive: true });
    fs.copyFileSync(FIXTURE, runFilePath(config, runId));

    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error(`run ${stored}`);
    expect(stored.steps).toEqual([
      { id: 'build', status: 'succeeded', outcome: 'success', exitCode: 0, outputs: { artifact: 'app.tgz' }, settledAt: 0 },
      { id: 'check', status: 'succeeded', outcome: 'success', end: 'ready', outputs: { verdict: 'ship' }, settledAt: 0 },
      { id: 'check.classify', status: 'succeeded', outcome: 'success', exitCode: 0, outputs: { verdict: 'ship' }, settledAt: 0 },
      { id: 'check.done', status: 'succeeded', outcome: 'success', settledAt: 0 },
      { id: 'ship', status: 'pending' },
    ]);
    expect(stored).toMatchObject({ revision: 4, cancelledAttempts: [], archive: [] });

    const next = await leaseNext(config, runId, driverA);
    expect(next).toMatchObject({ data: { lease: { step: 'ship', revision: 4, env: { ARTIFACT: 'app.tgz' } } } });
    if ('error' in next) return;
    const lease = next.data.lease as { attempt: string; revision: number };
    const reported = await reportAttempt(config, runId, { ...lease, outcome: 'success', driver: driverA, exitCode: 0 });
    expect(reported).toMatchObject({ data: { accepted: true, revision: 5, step: { id: 'ship', status: 'succeeded' } } });
    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { done: { run: runId, outcome: 'succeeded' } } });
  });
});

interface LoopLease {
  step: string;
  attempt: string;
  revision: number;
  pass: number;
  command?: string;
  prompt?: string;
  env?: Record<string, string>;
}

/**
 * Drives a run serially. `answer` reports each lease, given how many times its step has been leased before.
 * Returns each lease as `<step>#<pass>`, and the done envelope.
 */
async function driveLoop(
  config: LocalConfig,
  runId: string,
  answer: (lease: LoopLease, earlier: number) => { outcome?: 'success' | 'failed'; outputs?: unknown } = () => ({}),
): Promise<{ leased: string[]; done: unknown }> {
  const leased: string[] = [];
  const counts = new Map<string, number>();
  for (;;) {
    const next = await leaseNext(config, runId, driverA);
    if ('error' in next) throw new Error(next.error.message);
    if (next.data.done) return { leased, done: next.data.done };
    const lease = next.data.lease as LoopLease;
    leased.push(`${lease.step}#${lease.pass}`);
    const earlier = counts.get(lease.step) ?? 0;
    counts.set(lease.step, earlier + 1);
    const { outcome = 'success', outputs } = answer(lease, earlier);
    const reported = await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome, outputs, driver: driverA });
    if ('error' in reported) throw new Error(reported.error.message);
  }
}

const REVIEW_AND_FIX = workflow('review-and-fix', `  - id: review
    command: node review.js
    output:
      verdict: pass | fix
      findings: [string]
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    command: node fix.js
    output:
      patch: string
    loop: { back_to: review, max_iterations: 3 }
`, 'outputs:\n  findings: steps.review.passes\n');

function reviews(...verdicts: Array<'pass' | 'fix'>) {
  return (lease: LoopLease, earlier: number) => (lease.step.endsWith('review')
    ? { outputs: { verdict: verdicts[earlier], findings: [`finding ${earlier + 1}`] } }
    : { outputs: { patch: `patch ${earlier + 1}` } });
}

const IMPLEMENT_TASK = workflow('implement-task', `  - id: implement
    command: node implement.js
  - id: e2e
    needs: [implement]
    command: npm run test:e2e
  - id: fix
    needs: [e2e]
    if: steps.e2e.outcome == 'failed'
    command: node fix.js
    loop: { back_to: e2e, max_iterations: 3 }
  - id: done
    needs: [e2e]
    if: steps.e2e.outcome == 'success'
    end: done
  - id: give-up
    needs: [fix]
    if: steps.fix.outcome == 'failed'
    end: stuck
`, 'ends:\n  done: succeeded\n  stuck: failed\n');

const PLAN_CHANGE = workflow('plan-change', `  - id: plan
    command: node plan.js
    output:
      summary: string
  - id: decide
    needs: [plan]
    command: node decide.js
    output:
      choice: build | revise | drop
      note: string
    loop: { back_to: plan, while: "steps.decide.outputs.choice == 'revise'", max_iterations: 3 }
  - id: accept
    needs: [decide]
    if: steps.decide.outputs.choice == 'build'
    end: planned
  - id: drop
    needs: [decide]
    if: steps.decide.outputs.choice == 'drop'
    end: dropped
`, 'ends:\n  planned: succeeded\n  dropped: succeeded\n');

function decisions(...choices: Array<'build' | 'revise' | 'drop'>) {
  return (lease: LoopLease, earlier: number) => (lease.step === 'plan'
    ? { outputs: { summary: `plan ${earlier + 1}` } }
    : { outputs: { choice: choices[earlier], note: `note ${earlier + 1}` } });
}

describe('step loops', () => {
  it('plans again while the person asks for a revision, and builds the revised plan', async () => {
    const { config, runId } = await startTree({ 'plan-change': PLAN_CHANGE }, 'plan-change');

    const { leased, done } = await driveLoop(config, runId, decisions('revise', 'build'));

    expect(leased).toEqual(['plan#1', 'decide#1', 'plan#2', 'decide#2']);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'planned' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', pass: 2, outputs: { summary: 'plan 2' } },
      { id: 'decide', status: 'succeeded', pass: 2, iteration: 2, loopFinal: true, outputs: { choice: 'build' } },
      { id: 'accept', status: 'succeeded' },
      { id: 'drop', status: 'skipped' },
    ] });
  });

  it('hands plan the note of the previous decision, and nothing on the first pass', async () => {
    const planChange = PLAN_CHANGE.replace('    command: node plan.js\n', '    command: node plan.js\n    env:\n      NOTE: "{{ steps.decide.outputs.note }}"\n');
    const { config, runId } = await startTree({ 'plan-change': planChange }, 'plan-change');
    const notes: Array<string | undefined> = [];
    const answer = decisions('revise', 'revise', 'build');

    const { leased, done } = await driveLoop(config, runId, (lease, earlier) => {
      if (lease.step === 'plan') notes.push(lease.env?.NOTE);
      return answer(lease, earlier);
    });

    expect(leased).toEqual(['plan#1', 'decide#1', 'plan#2', 'decide#2', 'plan#3', 'decide#3']);
    expect(notes).toEqual(['', 'note 1', 'note 2']);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'planned' });
  });

  it('keeps an inner loop closed when the step it reads in the previous pass settles later, and reads that pass next time', async () => {
    const reopen = workflow('reopen', `  - id: A
    command: node a.js
  - id: W
    needs: [A]
    workflow:
      steps:
        - id: p
          command: node p.js
        - id: q
          needs: [p]
          command: node q.js
          loop: { back_to: p, while: "steps.C.outputs.again && length(steps.q.passes) < 2", max_iterations: 3 }
  - id: C
    needs: [W]
    command: node c.js
    output:
      again: boolean
  - id: D
    needs: [C]
    command: node d.js
    output:
      more: boolean
    loop: { back_to: A, while: steps.D.outputs.more, max_iterations: 2 }
`);
    const { config, runId } = await startTree({ reopen }, 'reopen');

    const { leased, done } = await driveLoop(config, runId, (lease, earlier) => (lease.step === 'C'
      ? { outputs: { again: earlier === 0 } }
      : lease.step === 'D' ? { outputs: { more: earlier === 0 } } : {}));

    expect(leased).toEqual(['A#1', 'W.p#1', 'W.q#1', 'C#1', 'D#1', 'A#2', 'W.p#2', 'W.q#2', 'W.p#3', 'W.q#3', 'C#2', 'D#2']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
  });

  it('fails decide with loop_exhausted when the last pass still asks for a revision, keeping that answer', async () => {
    const { config, runId } = await startTree({ 'plan-change': PLAN_CHANGE }, 'plan-change');

    const { leased, done } = await driveLoop(config, runId, decisions('revise', 'revise', 'revise'));

    expect(leased).toEqual(['plan#1', 'decide#1', 'plan#2', 'decide#2', 'plan#3', 'decide#3']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', status: 'succeeded', pass: 3 },
      {
        id: 'decide', status: 'failed', pass: 3, iteration: 3, attempt: expect.any(String), outputs: { choice: 'revise', note: 'note 3' },
        failure: { code: 'loop_exhausted' },
      },
      { id: 'accept', status: 'skipped' },
      { id: 'drop', status: 'skipped' },
    ] });
  });

  it('decides the loop of a workflow step once its workflow finishes, then runs what needs it', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    workflow:
      outputs:
        again: steps.run.outputs.again
      steps:
        - id: run
          command: node check.js
          output:
            again: boolean
    loop: { back_to: check, while: steps.check.outputs.again, max_iterations: 3 }
  - id: ship
    needs: [check]
    command: node ship.js
`));

    const { leased, done } = await driveLoop(config, runId, (lease, earlier) => (lease.step === 'check.run' ? { outputs: { again: earlier === 0 } } : {}));

    expect(leased).toEqual(['check.run#1', 'check.run#2', 'ship#1']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [
        { id: 'check', status: 'succeeded', pass: 2, iteration: 2, loopFinal: true, outputs: { again: false }, passes: [{ pass: 1, outcome: 'success', outputs: { again: true } }] },
        { id: 'check.run', status: 'succeeded', pass: 2, outputs: { again: false } },
        { id: 'ship', status: 'succeeded' },
      ],
      archive: [{ step: 'check.run', pass: 1, outcome: 'success', attempt: expect.any(String), outputs: { again: true } }],
    });
  });

  it('leases the child of a workflow step loop without while once when max_iterations is 1, and fails the step', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    workflow:
      steps:
        - id: run
          command: node check.js
    loop: { back_to: check, max_iterations: 1 }
  - id: ship
    needs: [check]
    command: node ship.js
`));

    const { leased, done } = await driveLoop(config, runId);

    expect(leased).toEqual(['check.run#1']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({
      steps: [
        { id: 'check', status: 'failed', pass: 2, iteration: 1, failure: { code: 'loop_exhausted' }, passes: [{ pass: 1, outcome: 'success' }] },
        { id: 'ship', status: 'skipped' },
      ],
      archive: [{ step: 'check.run', pass: 1, outcome: 'success' }],
    });
  });

  it.each([
    ['passes on the first try', 1, ['implement#1', 'e2e#1'], { outcome: 'succeeded', end: 'done' }],
    ['passes after one fix', 2, ['implement#1', 'e2e#1', 'fix#1', 'e2e#2'], { outcome: 'succeeded', end: 'done' }],
    ['still fails after three fixes', 5, ['implement#1', 'e2e#1', 'fix#1', 'e2e#2', 'fix#2', 'e2e#3', 'fix#3', 'e2e#4'], { outcome: 'failed', end: 'stuck' }],
  ] as const)('ends implement-task when e2e %s, and nothing outside the loop reads e2e before the loop settles', async (_case, passingRun, leases, outcome) => {
    const { config, runId } = await startTree({ 'implement-task': IMPLEMENT_TASK }, 'implement-task');

    const { leased, done } = await driveLoop(config, runId, (lease, earlier) => ({
      outcome: lease.step === 'e2e' && earlier + 1 < passingRun ? 'failed' : 'success',
    }));

    expect(leased).toEqual(leases);
    expect(done).toMatchObject(outcome);
  });

  it('runs review again after a fix, and leases each pass with its number', async () => {
    const { config, runId } = await startTree({ 'review-and-fix': REVIEW_AND_FIX }, 'review-and-fix');

    const { leased, done } = await driveLoop(config, runId, reviews('fix', 'pass'));

    expect(leased).toEqual(['review#1', 'fix#1', 'review#2']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.steps).toMatchObject([
      {
        id: 'review', status: 'succeeded', pass: 2, outputs: { verdict: 'pass' },
        passes: [{ pass: 1, outcome: 'success', attempt: expect.any(String), outputs: { verdict: 'fix', findings: ['finding 1'] } }],
      },
      { id: 'fix', status: 'skipped', pass: 2, iteration: 1, passes: [{ pass: 1, outcome: 'success', outputs: { patch: 'patch 1' } }] },
    ]);
  });

  it('succeeds when the fourth review passes after three fixes', async () => {
    const { config, runId } = await startTree({ 'review-and-fix': REVIEW_AND_FIX }, 'review-and-fix');

    const { leased, done } = await driveLoop(config, runId, reviews('fix', 'fix', 'fix', 'pass'));

    expect(leased).toEqual(['review#1', 'fix#1', 'review#2', 'fix#2', 'review#3', 'fix#3', 'review#4']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
  });

  it('fails the loop owner with loop_exhausted instead of a fourth fix, and keeps the outputs of the third', async () => {
    const { config, runId } = await startTree({ 'review-and-fix': REVIEW_AND_FIX }, 'review-and-fix');

    const { leased, done } = await driveLoop(config, runId, reviews('fix', 'fix', 'fix', 'fix'));

    expect(leased).toEqual(['review#1', 'fix#1', 'review#2', 'fix#2', 'review#3', 'fix#3', 'review#4']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'review', status: 'succeeded', pass: 4 },
      {
        id: 'fix', status: 'failed', pass: 4, iteration: 3, outputs: { patch: 'patch 3' },
        failure: { code: 'loop_exhausted', message: 'Loop of step "fix" is exhausted: it ran 3 times, its max_iterations' },
      },
    ] });
  });

  it.each([
    ['the first review passes', ['pass'], [{ pass: 1, outcome: 'success', outputs: { verdict: 'pass', findings: ['finding 1'] } }]],
    ['a fix comes before the review that passes', ['fix', 'pass'], [
      { pass: 1, outcome: 'success', outputs: { verdict: 'fix', findings: ['finding 1'] } },
      { pass: 2, outcome: 'success', outputs: { verdict: 'pass', findings: ['finding 2'] } },
    ]],
  ] as const)('returns every review in findings, once each, when %s', async (_case, verdicts, findings) => {
    const { config, runId } = await startTree({
      'review-and-fix': REVIEW_AND_FIX,
      ship: workflow('ship', `  - id: review
    workflow: review-and-fix
`),
    }, 'ship');

    const { done } = await driveLoop(config, runId, reviews(...verdicts));

    expect(done).toMatchObject({ outcome: 'succeeded' });
    const stored = await readRun(config, runId);
    if (typeof stored !== 'object') throw new Error('run missing');
    expect(stored.steps.find((step) => step.id === 'review')).toMatchObject({ status: 'succeeded', outputs: { findings } });
  });
});

const ROUNDS = workflow('rounds', `  - id: check
    workflow:
      steps:
        - id: review
          command: node review.js
          output:
            verdict: string
  - id: decide
    needs: [check]
    command: node decide.js
    output:
      again: boolean
`, 'loop: { while: steps.decide.outputs.again, max_iterations: 3 }\n');

function rounds(...again: boolean[]) {
  return (lease: LoopLease, earlier: number) => (lease.step === 'decide'
    ? { outputs: { again: again[earlier] } }
    : { outputs: { verdict: `R${earlier + 1}` } });
}

describe('workflow loops', () => {
  it('runs the workflow again while its loop holds, and keeps every earlier pass in the run file', async () => {
    const { config, runId } = await startTree({ rounds: ROUNDS }, 'rounds');

    const { leased, done } = await driveLoop(config, runId, rounds(true, false));

    expect(leased).toEqual(['check.review#1', 'decide#1', 'check.review#2', 'decide#2']);
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({
      round: 2,
      steps: [
        { id: 'check', status: 'succeeded', pass: 2, passes: [{ pass: 1, outcome: 'success' }] },
        { id: 'check.review', status: 'succeeded', pass: 2, outputs: { verdict: 'R2' } },
        { id: 'decide', status: 'succeeded', pass: 2, outputs: { again: false }, passes: [{ pass: 1, outcome: 'success', outputs: { again: true } }] },
      ],
      archive: [{ step: 'check.review', pass: 1, outcome: 'success', outputs: { verdict: 'R1' } }],
    });
  });

  it('fails the run with loop_exhausted when the loop still holds after its last round', async () => {
    const { config, runId } = await startTree({ rounds: ROUNDS }, 'rounds');

    const { leased, done } = await driveLoop(config, runId, rounds(true, true, true));

    expect(leased).toEqual(['check.review#1', 'decide#1', 'check.review#2', 'decide#2', 'check.review#3', 'decide#3']);
    expect(done).toEqual({
      run: runId,
      record: 'pending',
      outcome: 'failed',
      failure: { code: 'loop_exhausted', message: 'Loop of workflow "rounds" is exhausted: it ran 3 rounds, its max_iterations' },
    });
  });

  it('publishes the code of the run failure in the end record, without its message', async () => {
    const { config, runId } = await startTree({ rounds: ROUNDS }, 'rounds');

    const { done } = await driveLoop(config, runId, rounds(true, true, true));

    const { message } = (done as { failure: { message: string } }).failure;
    const record = await endRecord(config);
    expect(record?.failure).toEqual({ code: 'loop_exhausted' });
    expect(JSON.stringify(record)).not.toContain(message);
  });

  it.each([
    ['its step loop ran out', { 'review-and-fix': REVIEW_AND_FIX }, 'review-and-fix', reviews('fix', 'fix', 'fix', 'fix')],
    ['the step loop of a sub-workflow ran out', {
      'review-and-fix': REVIEW_AND_FIX,
      ship: workflow('ship', `  - id: review
    workflow: review-and-fix
`),
    }, 'ship', reviews('fix', 'fix', 'fix', 'fix')],
    ['the looping workflow of a step ran out', { retry: workflow('retry', `  - id: attempt
    workflow:
      loop: { while: "steps.try.outcome == 'success'", max_iterations: 2 }
      steps:
        - id: try
          command: node try.js
`) }, 'retry', () => ({})],
  ])('publishes loop_exhausted without its message when a run fails because %s', async (_case, files, name, answer) => {
    const { config, runId } = await startTree(files, name);

    const { done } = await driveLoop(config, runId, answer);

    expect(done).toMatchObject({ outcome: 'failed' });
    const record = await endRecord(config);
    expect(record?.failure).toEqual({ code: 'loop_exhausted' });
    expect(JSON.stringify(record)).not.toContain('is exhausted');
  });

  it('runs another round after a round with a failed step, and ends with the outcome of the last round', async () => {
    const again = workflow('again', `  - id: work
    command: node work.js
`, "loop: { while: \"steps.work.outcome == 'failed'\", max_iterations: 3 }\n");
    const { config, runId } = await startTree({ again }, 'again');

    const { leased, done } = await driveLoop(config, runId, (_lease, earlier) => ({ outcome: earlier === 0 ? 'failed' : 'success' }));

    expect(leased).toEqual(['work#1', 'work#2']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
  });

  it('stops the loop at a succeeded end, with that end', async () => {
    const shipLoop = workflow('ship-loop', `  - id: build
    command: node build.js
    output:
      ready: boolean
  - id: ship
    needs: [build]
    if: steps.build.outputs.ready
    end: shipped
`, 'ends:\n  shipped: succeeded\nloop: { max_iterations: 3 }\n');
    const { config, runId } = await startTree({ 'ship-loop': shipLoop }, 'ship-loop');

    const { leased, done } = await driveLoop(config, runId, (_lease, earlier) => ({ outputs: { ready: earlier === 1 } }));

    expect(leased).toEqual(['build#1', 'build#2']);
    expect(done).toMatchObject({ outcome: 'succeeded', end: 'shipped' });
  });

  it('ends the loop as success when a break holds after its step succeeds, and skips what has not run', async () => {
    const poll = workflow('poll', `  - id: probe
    command: node probe.js
    output:
      status: string
    break: steps.probe.outputs.status == 'ready'
  - id: notify
    needs: [probe]
    command: node notify.js
`, 'loop: { max_iterations: 5 }\n');
    const { config, runId } = await startTree({ poll }, 'poll');

    const { leased, done } = await driveLoop(config, runId, (lease, earlier) => (lease.step === 'probe'
      ? { outputs: { status: earlier === 1 ? 'ready' : 'waiting' } }
      : {}));

    expect(leased).toEqual(['probe#1', 'notify#1', 'probe#2']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'probe', status: 'succeeded', pass: 2, outputs: { status: 'ready' } },
      { id: 'notify', status: 'skipped', pass: 2 },
    ] });
  });

  it('fails the step that runs a looping workflow with loop_exhausted after its last round, keeping that round\'s outputs', async () => {
    const retry = workflow('retry', `  - id: attempt
    workflow:
      outputs:
        result: steps.try.outputs.result
      loop: { while: "steps.try.outputs.result != 'ok'", max_iterations: 2 }
      steps:
        - id: try
          command: node try.js
          output:
            result: string
  - id: after
    needs: [attempt]
    command: node after.js
`);
    const { config, runId } = await startTree({ retry }, 'retry');

    const { leased, done } = await driveLoop(config, runId, (_lease, earlier) => ({ outputs: { result: `flaky ${earlier + 1}` } }));

    expect(leased).toEqual(['attempt.try#1', 'attempt.try#2']);
    expect(done).toMatchObject({ outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      {
        id: 'attempt', status: 'failed', round: 2, outputs: { result: 'flaky 2' },
        failure: { code: 'loop_exhausted', message: 'Loop of step "attempt" inline workflow is exhausted: it ran 2 rounds, its max_iterations' },
      },
      { id: 'attempt.try', status: 'succeeded', pass: 2 },
      { id: 'after', status: 'skipped' },
    ] });
  });
});

const FAN_PLAN = workflow('fan', `  - id: plan
    command: node plan.js
    output:
      targets: [string]
  - id: build
    needs: [plan]
    for_each: steps.plan.outputs.targets
    command: node build.js
    env:
      TARGET: "{{ item }}"
  - id: ship
    needs: [build]
    command: node ship.js
`);

const FAN_TASKS = workflow('fan', `  - id: plan
    command: node plan.js
  - id: build
    needs: [plan]
    for_each: steps.plan.outputs.tasks
    command: node build.js
    env:
      TASK: "{{ item.id }}"
  - id: ship
    needs: [build]
    command: node ship.js
`);

describe('for_each', () => {
  it('keeps fan-out results in previous-pass reads and in every exposed pass', async () => {
    const fan = workflow('fan', `  - id: plan
    command: echo plan
    env:
      PRIOR: "{{ steps.build.results }}"
      PASSES: "{{ steps.build.passes }}"
  - id: build
    needs: [plan]
    for_each: steps.plan.outputs.targets
    command: echo build
    output: { ok: boolean }
  - id: decide
    needs: [build]
    command: echo decide
    loop: { back_to: plan, while: "length(steps.decide.passes) < 2", max_iterations: 2 }
  - id: summary
    needs: [decide]
    command: echo summary
    env:
      PASSES: "{{ steps.build.passes }}"
`);
    const { config, runId } = await startTree({ fan }, 'fan');
    const plans: Array<LoopLease['env']> = [];
    let summary: LoopLease['env'];
    const result = [{ item: 'a', outcome: 'success', outputs: { ok: true } }];
    await driveLoop(config, runId, (lease) => {
      if (lease.step === 'plan') plans.push(lease.env);
      if (lease.step === 'summary') summary = lease.env;
      return lease.step === 'plan' ? { outputs: { targets: ['a'] } }
        : lease.step === 'build[0]' ? { outputs: { ok: true } } : {};
    });
    expect(plans).toEqual([
      { PRIOR: '', PASSES: '[]' },
      { PRIOR: JSON.stringify(result), PASSES: JSON.stringify([{ pass: 1, outcome: 'success', results: result }]) },
    ]);
    expect(JSON.parse(summary?.PASSES ?? 'null')).toEqual([
      { pass: 1, outcome: 'success', results: result },
      { pass: 2, outcome: 'success', results: result },
    ]);
  });

  it('runs a command once per item, as build[0] and build[1] with the item in env, and keeps results in item order', async () => {
    const fan = workflow('fan', `  - id: build
    for_each: inputs.targets
    command: node build.js
    env:
      TARGET: "{{ item }}"
`, 'inputs:\n  targets: [string]\n');
    const { config, runId } = await startTree({ fan }, 'fan', { targets: ['web', 'api'] });
    const targets: Array<string | undefined> = [];

    const { leased, done } = await driveLoop(config, runId, (lease) => {
      targets.push(lease.env?.TARGET);
      return {};
    });

    expect(leased).toEqual(['build[0]#1', 'build[1]#1']);
    expect(targets).toEqual(['web', 'api']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'build', status: 'succeeded', results: [{ item: 'web', outcome: 'success' }, { item: 'api', outcome: 'success' }] },
      { id: 'build[0]', status: 'succeeded', item: 'web' },
      { id: 'build[1]', status: 'succeeded', item: 'api' },
    ] });
  });

  it('leases item as written from a step without for_each, and fills it in a for_each step of the same workflow', async () => {
    const fixture = testConfig();
    const knowledge = fixture.config.repo.localPath;
    fs.mkdirSync(path.join(knowledge, 'prompts'));
    const quote = 'Quote {{ item }}, {{ item.name }}, {{ item[0] }} and {{ length(item.xs) }} from a playbook.';
    fs.writeFileSync(path.join(knowledge, 'prompts', 'quote.md'), quote);
    fs.writeFileSync(path.join(knowledge, 'workflows', 'fan.yaml'), workflow('fan', `  - id: explain
    prompt: "Explain {{ item }}, {{ item.name }}, {{ item[0] }} and {{ length(item.xs) }} in a Jinja loop: {{ with.loop }}."
    with:
      loop: ["{{ item }}", "{{ length(item.xs) }}"]
  - id: quote
    needs: [explain]
    prompt_file: prompts/quote.md
  - id: play
    needs: [quote]
    command: ansible localhost -m debug -a 'msg={{ item }}'
    env:
      ITEM: "{{ item }}"
      COUNT: "{{ length(item.xs) }}"
  - id: build
    needs: [play]
    for_each: inputs.packages
    prompt: "Build {{ item.dir }}."
`, 'inputs:\n  packages: [{ dir: string }]\n'));
    await syncWorkflowDefinitions(fixture.config);
    const started = await startRun(fixture.config, 'fan', { packages: [{ dir: 'packages/core' }] }, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    const leases: Array<Pick<LoopLease, 'step' | 'command' | 'prompt' | 'env'>> = [];

    await driveLoop(fixture.config, String(started.data.run), ({ step, command, prompt, env }) => {
      leases.push({ step, ...(command ? { command } : {}), ...(prompt ? { prompt } : {}), ...(env ? { env } : {}) });
      return {};
    });

    expect(leases).toEqual([
      { step: 'explain', prompt: 'Explain {{ item }}, {{ item.name }}, {{ item[0] }} and {{ length(item.xs) }} in a Jinja loop: ["{{ item }}","{{ length(item.xs) }}"].' },
      { step: 'quote', prompt: quote },
      { step: 'play', command: "ansible localhost -m debug -a 'msg={{ item }}'", env: { ITEM: '{{ item }}', COUNT: '{{ length(item.xs) }}' } },
      { step: 'build[0]', prompt: 'Build packages/core.' },
    ]);
  });

  it('evaluates an expression in a prompt, a prompt_file, env and with, and leaves other braces as written', async () => {
    const fixture = testConfig();
    const knowledge = fixture.config.repo.localPath;
    fs.mkdirSync(path.join(knowledge, 'prompts'));
    fs.writeFileSync(path.join(knowledge, 'prompts', 'review.md'), "Review {{ length(steps.build.results) }} builds; {{ filter(steps.build.results, .outcome == 'failed') }} failed.");
    const kept = "Keep {{ filter(items) }}, {{ all(products) }}, {{ items | length }}, ${{ length(steps.build.results) }}, {{#each items}}{{this}}{{/each}}, {{{ x }}} and {{ item }} as written.";
    fs.writeFileSync(path.join(knowledge, 'workflows', 'triage.yaml'), workflow('triage', `  - id: build
    for_each: inputs.packages
    command: node build.js
    env:
      PACKAGE: "{{ item.id }}"
      LAST: "{{ item.id == 'cli' }}"
  - id: notify
    needs: [build]
    if: steps.build.outcome == 'failed'
    command: node notify.js
    env:
      FAILED: "{{ filter(steps.build.results, .outcome == 'failed') }}"
      COUNT: "{{ length(steps.build.results) }}"
      ANY: "{{ any(steps.build.results, .outcome == 'failed') }}"
      MANY: "{{ length(steps.build.results) > 3 }}"
      BROKE: "{{ steps.build.outcome == 'failed' }}"
  - id: fix
    needs: [notify]
    with:
      failed: "{{ filter(steps.build.results, .outcome == 'failed') }}"
      summary: "{{ length(filter(steps.build.results, .outcome == 'failed')) }} of {{ length(steps.build.results) }}"
    prompt: "Fix {{ with.failed[0].item.id }} ({{ with.summary }} failed): {{ with.failed }}"
  - id: review
    needs: [fix]
    prompt_file: prompts/review.md
  - id: quote
    needs: [review]
    prompt: "${kept}"
`, 'inputs:\n  packages: [{ id: string, dir: string }]\n'));
    const synced = await syncWorkflowDefinitions(fixture.config);
    expect(synced.invalid.map((diagnostic) => diagnostic.message)).toEqual([]);
    const started = await startRun(fixture.config, 'triage', { packages: [{ id: 'core', dir: 'packages/core' }, { id: 'cli', dir: 'packages/cli' }] }, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    const leases: Array<Pick<LoopLease, 'step' | 'prompt' | 'env'>> = [];

    const { done } = await driveLoop(fixture.config, String(started.data.run), ({ step, prompt, env }) => {
      leases.push({ step, ...(prompt ? { prompt } : {}), ...(env ? { env } : {}) });
      return step === 'build[1]' ? { outcome: 'failed' } : {};
    });

    const failed = '[{"item":{"id":"cli","dir":"packages/cli"},"outcome":"failed"}]';
    expect(leases).toEqual([
      { step: 'build[0]', env: { PACKAGE: 'core', LAST: 'false' } },
      { step: 'build[1]', env: { PACKAGE: 'cli', LAST: 'true' } },
      { step: 'notify', env: { FAILED: failed, COUNT: '2', ANY: 'true', MANY: 'false', BROKE: 'true' } },
      { step: 'fix', prompt: `Fix cli (1 of 2 failed): ${failed}` },
      { step: 'review', prompt: `Review 2 builds; ${failed} failed.` },
      { step: 'quote', prompt: kept },
    ]);
    expect(done).toEqual({ run: String(started.data.run), record: 'pending', outcome: 'failed' });
  });

  it('renders a read of a skipped step as an if evaluates it: a list it does not have is null, so a count is empty and a comparison false', async () => {
    const { config, runId } = await startTree({ lint: workflow('lint', `  - id: lint
    if: inputs.lint
    for_each: inputs.packages
    command: node lint.js
  - id: plan
    needs: []
    command: node plan.js
  - id: report
    needs: [plan, lint]
    prompt: "Lint {{ steps.lint.outcome }}: [{{ length(steps.lint.results) }}] checked, any failed [{{ any(steps.lint.results, .outcome == 'failed') }}], over one {{ length(steps.lint.results) > 1 }}, first [{{ steps.lint.results[0].item.id }}], failed [{{ filter(steps.lint.results, .outcome == 'failed') }}]."
`, 'inputs:\n  packages: [{ id: string }]\n  lint: boolean\n') }, 'lint', { packages: [{ id: 'core' }], lint: false });
    const prompts: string[] = [];

    const { leased } = await driveLoop(config, runId, ({ prompt }) => {
      if (prompt) prompts.push(prompt);
      return {};
    });

    expect(leased).toEqual(['plan#1', 'report#1']);
    expect(prompts).toEqual(['Lint skipped: [] checked, any failed [], over one false, first [], failed [].']);
  });

  it('checks each item against output, keeps its outputs in results, and a later step reads them by index', async () => {
    const sized = workflow('sized', `  - id: build
    for_each: inputs.targets
    command: node build.js
    output:
      size: number
  - id: report
    needs: [build]
    if: steps.build.results[1].outcome == 'failed'
    command: node report.js
    env:
      FIRST: "{{ steps.build.results[0].outputs.size }}"
`, 'inputs:\n  targets: [string]\n');
    const { config, runId } = await startTree({ sized }, 'sized', { targets: ['web', 'api'] });
    const env: Array<Record<string, string> | undefined> = [];

    const { leased, done } = await driveLoop(config, runId, (lease) => {
      env.push(lease.env);
      return { outputs: { size: lease.step === 'build[0]' ? 3 : 'big' } };
    });

    expect(leased).toEqual(['build[0]#1', 'build[1]#1', 'report#1']);
    expect(env.at(-1)).toEqual({ FIRST: '3' });
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'build', status: 'failed', results: [
        { item: 'web', outcome: 'success', outputs: { size: 3 } },
        { item: 'api', outcome: 'failed' },
      ] },
      { id: 'build[0]', status: 'succeeded', outputs: { size: 3 } },
      { id: 'build[1]', status: 'failed', failure: { code: 'invalid_output', message: 'stdout JSON does not match output: output.size must be a number' } },
      { id: 'report', status: 'succeeded' },
    ] });
  });

  it('runs again only the items that failed, through a for_each that filters the results of an earlier step', async () => {
    const retry = workflow('retry', `  - id: build
    for_each: inputs.targets
    command: node build.js
    env:
      TARGET: "{{ item }}"
  - id: again
    needs: [build]
    if: steps.build.outcome == 'failed'
    for_each: filter(steps.build.results, .outcome == 'failed')
    command: node build.js
    env:
      TARGET: "{{ item.item }}"
`, 'inputs:\n  targets: [string]\n');
    const { config, runId } = await startTree({ retry }, 'retry', { targets: ['web', 'api', 'cli'] });
    const targets: Array<string | undefined> = [];

    const { leased } = await driveLoop(config, runId, (lease) => {
      targets.push(lease.env?.TARGET);
      return { outcome: lease.step === 'build[1]' ? 'failed' : 'success' };
    });

    expect(leased).toEqual(['build[0]#1', 'build[1]#1', 'build[2]#1', 'again[0]#1']);
    expect(targets).toEqual(['web', 'api', 'cli', 'api']);
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      { id: 'again', status: 'succeeded', outcome: 'success', settledAt: 5, results: [{ item: { item: 'api', outcome: 'failed' }, outcome: 'success' }] },
    ]) });
  });

  it('runs an inline workflow per item under ids such as build[2].verify, and its steps read the item', async () => {
    const inline = workflow('inline', `  - id: build
    for_each: inputs.targets
    workflow:
      outputs:
        size: steps.verify.outputs.size
      steps:
        - id: compile
          command: node compile.js
          env:
            TARGET: "{{ item.name }}"
        - id: verify
          needs: [compile]
          if: item.check
          command: node verify.js
          env:
            TARGET: "{{ item.name }}"
          output:
            size: number
`, 'inputs:\n  targets: [{ name: string, check: boolean }]\n');
    const targets = [{ name: 'web', check: true }, { name: 'api', check: false }, { name: 'cli', check: true }];
    const { config, runId } = await startTree({ inline }, 'inline', { targets });
    const leases: string[] = [];

    const { leased, done } = await driveLoop(config, runId, (lease) => {
      leases.push(`${lease.step}:${lease.env?.TARGET}`);
      return lease.step.endsWith('verify') ? { outputs: { size: leases.length } } : {};
    });

    expect(leased).toEqual(['build[0].compile#1', 'build[0].verify#1', 'build[1].compile#1', 'build[2].compile#1', 'build[2].verify#1']);
    expect(leases).toEqual(['build[0].compile:web', 'build[0].verify:web', 'build[1].compile:api', 'build[2].compile:cli', 'build[2].verify:cli']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    const run = await readRun(config, runId) as RunState;
    expect(run.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
      'build:succeeded',
      'build[0]:succeeded', 'build[0].compile:succeeded', 'build[0].verify:succeeded',
      'build[1]:succeeded', 'build[1].compile:succeeded', 'build[1].verify:skipped',
      'build[2]:succeeded', 'build[2].compile:succeeded', 'build[2].verify:succeeded',
    ]);
    expect(run.steps[0]).toMatchObject({ results: [
      { item: targets[0], outcome: 'success', outputs: { size: 2 } },
      { item: targets[1], outcome: 'success', outputs: { size: null } },
      { item: targets[2], outcome: 'success', outputs: { size: 5 } },
    ] });
  });

  it('passes a whole item to a workflow file through with, keeping its JSON type', async () => {
    const ship = workflow('ship', `  - id: build
    for_each: inputs.tasks
    workflow: implement
    with:
      task: "{{ item }}"
`, 'inputs:\n  tasks: [{ id: string, title: string }]\n');
    const implement = workflow('implement', `  - id: work
    command: node work.js
    env:
      TITLE: "{{ inputs.task.title }}"
`, 'inputs:\n  task: { id: string, title: string }\n');
    const tasks = [{ id: 'a', title: 'Parse' }, { id: 'b', title: 'Render' }];
    const { config, runId } = await startTree({ ship, implement }, 'ship', { tasks });
    const titles: Array<string | undefined> = [];

    const { leased, done } = await driveLoop(config, runId, (lease) => {
      titles.push(lease.env?.TITLE);
      return {};
    });

    expect(leased).toEqual(['build[0].work#1', 'build[1].work#1']);
    expect(titles).toEqual(['Parse', 'Render']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'build', status: 'succeeded' },
      { id: 'build[0]', status: 'succeeded', item: tasks[0], inputs: { task: tasks[0] } },
      { id: 'build[0].work', status: 'succeeded' },
      { id: 'build[1]', status: 'succeeded', item: tasks[1], inputs: { task: tasks[1] } },
      { id: 'build[1].work', status: 'succeeded' },
    ] });
  });

  it('archives the items of a round when its workflow loops, and numbers the next round\'s items after them', async () => {
    const rounds = workflow('rounds', `  - id: build
    for_each: inputs.targets
    command: node build.js
    output:
      round: number
  - id: decide
    needs: [build]
    command: node decide.js
    output:
      again: boolean
`, 'inputs:\n  targets: [string]\nloop: { while: steps.decide.outputs.again, max_iterations: 2 }\n');
    const { config, runId } = await startTree({ rounds }, 'rounds', { targets: ['web', 'api'] });

    const { leased, done } = await driveLoop(config, runId, (lease, earlier) => (lease.step === 'decide'
      ? { outputs: { again: earlier === 0 } }
      : { outputs: { round: earlier + 1 } }));

    expect(leased).toEqual(['build[0]#1', 'build[1]#1', 'decide#1', 'build[0]#2', 'build[1]#2', 'decide#2']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    const run = await readRun(config, runId) as RunState;
    expect(run.steps).toMatchObject([
      { id: 'build', pass: 2, results: [{ item: 'web', outputs: { round: 2 } }, { item: 'api', outputs: { round: 2 } }], passes: [
        { pass: 1, outcome: 'success', results: [{ item: 'web', outcome: 'success', outputs: { round: 1 } }, { item: 'api', outcome: 'success', outputs: { round: 1 } }] },
      ] },
      { id: 'build[0]', pass: 2, item: 'web', outputs: { round: 2 } },
      { id: 'build[1]', pass: 2, item: 'api', outputs: { round: 2 } },
      { id: 'decide', pass: 2 },
    ]);
    expect(run.archive).toEqual([
      expect.objectContaining({ step: 'build[0]', pass: 1, outcome: 'success', outputs: { round: 1 } }),
      expect.objectContaining({ step: 'build[1]', pass: 1, outcome: 'success', outputs: { round: 1 } }),
    ]);
  });

  it('succeeds an empty fan-out with no results in the same next, and runs what needs it', async () => {
    const { config, runId } = await startTree({ fan: FAN_PLAN }, 'fan');

    const { leased, done } = await driveLoop(config, runId, (lease) => (lease.step === 'plan' ? { outputs: { targets: [] } } : {}));

    expect(leased).toEqual(['plan#1', 'ship#1']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'succeeded' });
    expect((await readRun(config, runId) as RunState).steps).toEqual([
      { id: 'plan', status: 'succeeded', outcome: 'success', attempt: expect.any(String), installId: expect.any(String), outputs: { targets: [] }, settledAt: 2 },
      { id: 'build', status: 'succeeded', outcome: 'success', results: [], settledAt: 2 },
      { id: 'ship', status: 'succeeded', outcome: 'success', attempt: expect.any(String), installId: expect.any(String), settledAt: 3 },
    ]);
  });

  it('fails the step with invalid_items when for_each gives no list, and skips what needs it', async () => {
    const { config, runId } = await startTree({ fan: FAN_PLAN.replace('    output:\n      targets: [string]\n', '') }, 'fan');

    const { leased, done } = await driveLoop(config, runId, () => ({ outputs: { targets: 'web' } }));

    expect(leased).toEqual(['plan#1']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', status: 'succeeded' },
      { id: 'build', status: 'failed', failure: { code: 'invalid_items', message: 'step "build" for_each gives a string, not a list of items' } },
      { id: 'ship', status: 'skipped' },
    ] });
  });

  it.each([
    ['an unknown id', [{ id: 'a', after: [] }, { id: 'b', after: ['x'] }], 'step "build" item 1 runs after "x", which is not the id of an item'],
    ['a duplicate id', [{ id: 'a' }, { id: 'b' }, { id: 'a' }], 'step "build" items 0 and 2 have the same id "a"'],
    ['after that is not a list of ids', [{ id: 'a', after: 'b' }, { id: 'b' }], 'step "build" item 0 after must be a list of item ids'],
  ])('fails the step with invalid_items for %s, before any item runs', async (_case, tasks, message) => {
    const { config, runId } = await startTree({ fan: FAN_TASKS }, 'fan');

    const { leased, done } = await driveLoop(config, runId, () => ({ outputs: { tasks } }));

    expect(leased).toEqual(['plan#1']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', status: 'succeeded' },
      { id: 'build', status: 'failed', failure: { code: 'invalid_items', message } },
      { id: 'ship', status: 'skipped' },
    ] });
  });

  it('starts at most max_parallel items at once, and gives the next one to a driver that lists the ones it runs', async () => {
    const capped = FAN_PLAN.replace('for_each: steps.plan.outputs.targets', 'for_each: { items: steps.plan.outputs.targets, max_parallel: 2 }');
    const { config, runId } = await startTree({ fan: capped }, 'fan');
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs: { targets: ['web', 'api', 'cli'] }, driver: driverA });

    const web = leaseIn(await leaseNext(config, runId, driverA));
    const api = leaseIn(await leaseNext(config, runId, driverA, { running: [web.attempt] }));
    const full = await leaseNext(config, runId, driverA, { running: [web.attempt, api.attempt] });
    await reportAttempt(config, runId, { ...web, outcome: 'success', driver: driverA });
    const cli = await leaseNext(config, runId, driverA, { running: [api.attempt] });

    expect([web.step, api.step]).toEqual(['build[0]', 'build[1]']);
    expect(full).toEqual({ data: { wait: { reason: 'build[0] is leased' }, cancelled: [] } });
    expect(cli).toMatchObject({ data: { lease: { step: 'build[2]', env: { TARGET: 'cli' } }, cancelled: [] } });
  });

  it('hands a restarted driver its item leases back with the same ids, attempts and env, one per call', async () => {
    const { config, runId } = await startTree({ fan: FAN_PLAN }, 'fan');
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs: { targets: ['web', 'api'] }, driver: driverA });
    const web = await leaseNext(config, runId, driverA);
    const api = await leaseNext(config, runId, driverA, { running: [leaseIn(web).attempt] });

    const webAgain = await leaseNext(config, runId, driverA, { running: [] });
    const apiAgain = await leaseNext(config, runId, driverA, { running: [leaseIn(webAgain).attempt] });

    expect(webAgain).toEqual(web);
    expect(apiAgain).toEqual(api);
    expect(apiAgain).toMatchObject({ data: { lease: { step: 'build[1]', env: { TARGET: 'api' } } } });
    await reportAttempt(config, runId, { ...leaseIn(webAgain), outcome: 'success', driver: driverA });
    await reportAttempt(config, runId, { ...leaseIn(apiAgain), outcome: 'success', driver: driverA });
    expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { lease: { step: 'ship' } } });
  });

  it('accepts the report of an item leased beside a sibling whose report came first', async () => {
    const { config, runId } = await startTree({ fan: FAN_PLAN }, 'fan');
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs: { targets: ['web', 'api'] }, driver: driverA });
    const web = leaseIn(await leaseNext(config, runId, driverA));
    const api = leaseIn(await leaseNext(config, runId, driverA, { running: [web.attempt] }));

    const apiReport = await reportAttempt(config, runId, { ...api, outcome: 'success', driver: driverA });
    const webReport = await reportAttempt(config, runId, { ...web, outcome: 'success', driver: driverA });

    expect([web.revision, api.revision]).toEqual([2, 2]);
    expect(apiReport).toMatchObject({ data: { accepted: true, revision: 3, step: { id: 'build[1]', status: 'succeeded' } } });
    expect(webReport).toMatchObject({ data: { accepted: true, revision: 4, step: { id: 'build[0]', status: 'succeeded' } } });
  });

  it('keeps a sibling running when an item fails, and fails the step once every item settled', async () => {
    const { config, runId } = await startTree({ fan: FAN_PLAN }, 'fan');
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs: { targets: ['web', 'api'] }, driver: driverA });
    const web = leaseIn(await leaseNext(config, runId, driverA));
    const api = leaseIn(await leaseNext(config, runId, driverA, { running: [web.attempt] }));

    await reportAttempt(config, runId, { ...web, outcome: 'failed', driver: driverA });
    const meanwhile = await leaseNext(config, runId, driverA, { running: [api.attempt] });
    const stored = await readRun(config, runId);
    const reported = await reportAttempt(config, runId, { ...api, outcome: 'success', driver: driverA });
    const done = await leaseNext(config, runId, driverA);

    expect(meanwhile).toEqual({ data: { wait: { reason: 'build[1] is leased' }, cancelled: [] } });
    expect(stored).toMatchObject({ steps: [
      { id: 'plan' }, { id: 'build', status: 'running' }, { id: 'build[0]', status: 'failed' }, { id: 'build[1]', status: 'leased' }, { id: 'ship', status: 'pending' },
    ] });
    expect(reported).toMatchObject({ data: { accepted: true, step: { id: 'build[1]', status: 'succeeded' } } });
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan' },
      { id: 'build', status: 'failed', results: [{ item: 'web', outcome: 'failed' }, { item: 'api', outcome: 'success' }] },
      { id: 'build[0]' }, { id: 'build[1]' },
      { id: 'ship', status: 'skipped' },
    ] });
  });

  it('starts an item only after the items its after names, and skips it when one of them failed or was skipped', async () => {
    const { config, runId } = await startTree({ fan: FAN_TASKS }, 'fan');
    const plan = leaseIn(await leaseNext(config, runId, driverA));
    const tasks = [{ id: 'a' }, { id: 'b', after: ['a'] }, { id: 'c' }, { id: 'd', after: ['b'] }];
    await reportAttempt(config, runId, { ...plan, outcome: 'success', outputs: { tasks }, driver: driverA });

    const a = leaseIn(await leaseNext(config, runId, driverA));
    const c = leaseIn(await leaseNext(config, runId, driverA, { running: [a.attempt] }));
    const full = await leaseNext(config, runId, driverA, { running: [a.attempt, c.attempt] });
    await reportAttempt(config, runId, { ...a, outcome: 'failed', driver: driverA });
    await reportAttempt(config, runId, { ...c, outcome: 'success', driver: driverA });
    const done = await leaseNext(config, runId, driverA);

    expect([a.step, c.step]).toEqual(['build[0]', 'build[2]']);
    expect(full).toMatchObject({ data: { wait: { reason: 'build[0] is leased' }, cancelled: [] } });
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', status: 'succeeded' },
      { id: 'build', status: 'failed', results: [
        { item: tasks[0], outcome: 'failed' },
        { item: tasks[1], outcome: 'skipped' },
        { item: tasks[2], outcome: 'success' },
        { item: tasks[3], outcome: 'skipped' },
      ] },
      { id: 'build[0]', status: 'failed' },
      { id: 'build[1]', status: 'skipped' },
      { id: 'build[2]', status: 'succeeded' },
      { id: 'build[3]', status: 'skipped' },
      { id: 'ship', status: 'skipped' },
    ] });
  });

  it('fails the step with item_cycle naming the cycle, before any item runs', async () => {
    const { config, runId } = await startTree({ fan: FAN_TASKS }, 'fan');
    const tasks = [{ id: 'd' }, { id: 'a', after: ['c'] }, { id: 'b', after: ['a'] }, { id: 'c', after: ['b'] }];

    const { leased, done } = await driveLoop(config, runId, () => ({ outputs: { tasks } }));

    expect(leased).toEqual(['plan#1']);
    expect(done).toEqual({ run: runId, record: 'pending', outcome: 'failed' });
    expect(await readRun(config, runId)).toMatchObject({ steps: [
      { id: 'plan', status: 'succeeded' },
      { id: 'build', status: 'failed', failure: { code: 'item_cycle', message: 'step "build" has items that run after each other in a cycle: a -> c -> b -> a' } },
      { id: 'ship', status: 'skipped' },
    ] });
  });
});

describe('where an item is bound', () => {
  const header = 'inputs:\n  items: [{ name: string, xs: [string] }]\n';
  const pair = (prompt: string, indent = ''): string => `${indent}  - id: s
${indent}    prompt: "${prompt}"
${indent}  - id: p
${indent}    needs: []
${indent}    command: node p.js
`;
  const positions: Array<[string, (prompt: string) => Record<string, string>, string, boolean]> = [
    ['a step outside a for_each', (prompt) => ({ top: workflow('top', pair(prompt), header) }), 's', false],
    ['a for_each step', (prompt) => ({ top: workflow('top', `  - id: s
    for_each: inputs.items
    prompt: "${prompt}"
  - id: p
    needs: []
    command: node p.js
`, header) }), 's[0]', true],
    ["a step of an item's inline workflow", (prompt) => ({ top: workflow('top', `  - id: each
    for_each: inputs.items
    workflow:
      steps:
${pair(prompt, '      ')}`, header) }), 'each[0].s', true],
    ['a step of a named workflow an item runs', (prompt) => ({
      top: workflow('top', '  - id: each\n    for_each: inputs.items\n    workflow: inner\n', header),
      inner: workflow('inner', pair(prompt)),
    }), 'each[0].s', false],
  ];
  const inputs = { items: [{ name: 'I', xs: ['success'] }] };

  it.each(positions)('renders item in %s only where pull, the lease and what the step waits for all bind it', async (_case, files, step, bound) => {
    const reads = await startTree(files('{{ item.name }}|{{ length(item.xs) }}'), 'top', inputs);
    expect(leaseIn(await leaseNext(reads.config, reads.runId, driverA))).toMatchObject({
      step, prompt: bound ? 'I|1' : '{{ item.name }}|{{ length(item.xs) }}',
    });

    const fixture = testConfig();
    for (const [file, body] of Object.entries(files('{{ any(item.xs, . == steps.p.outcome) }}'))) {
      fs.writeFileSync(path.join(fixture.config.repo.localPath, 'workflows', `${file}.yaml`), body);
    }
    const pulled = await syncWorkflowDefinitions(fixture.config);
    expect(pulled.invalid.map((diagnostic) => diagnostic.message).filter((message) => message.includes('steps.p'))).toHaveLength(bound ? 1 : 0);
    if (bound) return;
    // Where item is not bound, the step reads no step, so it does not wait for p.
    const started = await startRun(fixture.config, 'top', inputs, { secrets: await knownSecrets(fixture.config) });
    if ('error' in started) throw new Error(started.error.message);
    expect(leaseIn(await leaseNext(fixture.config, String(started.data.run), driverA)).step).toBe(step);
  });
});

describe('the model a prompt step lease carries', () => {
  type ModelFields = { model?: unknown; defaultModel?: unknown };

  /** Leases every step in turn, each reported a success, and returns the model fields of each lease by step. */
  async function leasedModels(config: LocalConfig, runId: string): Promise<Record<string, ModelFields>> {
    const models: Record<string, ModelFields> = {};
    for (;;) {
      const next = await leaseNext(config, runId, driverA);
      if ('error' in next) throw new Error(next.error.message);
      if (next.data.done) return models;
      const lease = next.data.lease as { step: string; attempt: string; revision: number } & ModelFields;
      models[lease.step] = {
        ...('model' in lease ? { model: lease.model } : {}),
        ...('defaultModel' in lease ? { defaultModel: lease.defaultModel } : {}),
      };
      const reported = await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: driverA });
      if ('error' in reported) throw new Error(reported.error.message);
    }
  }

  it('carries the step model and defaults.model as written on prompt steps, and neither on a command step', async () => {
    const { config, runId } = await startTree({ build: graph(`  - id: plan
    prompt: Plan it.
    model: strong
  - id: compile
    needs: [plan]
    command: node compile.js
  - id: summary
    needs: [compile]
    prompt: Summarize it.
  - id: check
    needs: [summary]
    for_each: inputs.targets
    prompt: Check {{ item }}.
`, 'inputs: { targets: [string] }\ndefaults:\n  model: fast\n') }, 'build', { targets: ['a'] });

    expect(await leasedModels(config, runId)).toEqual({
      plan: { model: 'strong', defaultModel: 'fast' },
      compile: {},
      summary: { defaultModel: 'fast' },
      'check[0]': { defaultModel: 'fast' },
    });
  });

  it('gives the steps of an inline workflow the enclosing defaults.model, also on a lease handed back', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    workflow:
      steps:
        - id: classify
          prompt: Classify it.
`, 'defaults:\n  model: fast\n'));

    const first = await leaseNext(config, runId, driverA);
    const again = await leaseNext(config, runId, driverA);

    expect(first).toMatchObject({ data: { lease: { step: 'check.classify', defaultModel: 'fast' } } });
    expect(again).toMatchObject({ data: { lease: { step: 'check.classify', defaultModel: 'fast' } } });
  });

  it('gives the steps of a workflow file its own defaults.model, or else the one in effect for the step that runs it', async () => {
    const { config, runId } = await startTree({
      own: workflow('own', `  - id: classify
    prompt: Classify it.
`, 'defaults:\n  model: strong\n'),
      plain: workflow('plain', `  - id: comment
    prompt: Comment on it.
  - id: label
    needs: [comment]
    command: node label.js
`),
      build: graph(`  - id: first
    workflow: own
  - id: second
    needs: [first]
    workflow: plain
`, 'defaults:\n  model: fast\n'),
    }, 'build');

    expect(await leasedModels(config, runId)).toEqual({
      'first.classify': { defaultModel: 'strong' },
      'second.comment': { defaultModel: 'fast' },
      'second.label': {},
    });
  });
});

describe('the agent a pass ran as (#1176)', () => {
  const REVIEW = workflow('build', `  - id: review
    prompt: Review the change.
    agent: reviewer
`);

  async function leaseReview(): Promise<{ config: LocalConfig; runId: string; lease: { attempt: string; revision: number } }> {
    const { config, runId } = await startTree({ build: REVIEW }, 'build');
    const next = await leaseNext(config, runId, driverB);
    if ('error' in next) throw new Error(next.error.message);
    const { attempt, revision } = next.data.lease as { attempt: string; revision: number };
    return { config, runId, lease: { attempt, revision } };
  }

  it('keeps the engine\'s own teamai, driver and definition and drops a version that is a path', async () => {
    const { config, runId, lease } = await leaseReview();
    const parsed = parseReport({
      ...lease,
      outcome: 'success',
      driver: driverB,
      tool: 'claude',
      model: 'claude-opus-4-1-20250805',
      agent: {
        teamai: '0.0.1',
        driver: 'spoofed',
        definition: { name: 'spoofed', applied: 'main' },
        tool: { name: 'other', version: '/usr/local/bin/claude' },
        model: { requested: 'claude-opus-4-1' },
      },
    });
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.ignored).toEqual([]);

    await reportAttempt(config, runId, parsed.report);
    await leaseNext(config, runId, driverB);

    const agent = {
      v: 1,
      definition: { name: 'reviewer', applied: 'main' },
      tool: { name: 'claude' },
      model: { requested: 'claude-opus-4-1', reported: 'claude-opus-4-1-20250805' },
      teamai: getCurrentVersion(),
      driver: 'external',
    };
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ agent }] });
    expect((await endRecord(config))?.steps).toEqual([
      { step: 'review', pass: 1, agent, tool: 'claude', model: 'claude-opus-4-1-20250805', outcome: 'success' },
    ]);
  });

  it('rejects an agent that is not an object', () => {
    expect(parseReport({ attempt: 'a00000000', revision: 1, outcome: 'success', driver: driverA, agent: 'reviewer' }))
      .toBe('agent must be an object');
  });

  it('records the definition alone for a pass that reported no agent', async () => {
    const { config, runId, lease } = await leaseReview();
    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver: driverB, tool: 'claude' });
    await leaseNext(config, runId, driverB);

    expect((await endRecord(config))?.steps).toEqual([
      { step: 'review', pass: 1, agent: { definition: { name: 'reviewer' } }, tool: 'claude', outcome: 'success' },
    ]);
  });

  it('reads a stored agent it cannot parse as none, not as a corrupt run', async () => {
    const { config, runId, lease } = await leaseReview();
    await reportAttempt(config, runId, { ...lease, outcome: 'success', driver: driverB, tool: 'claude', agent: {} });
    const raw = JSON.parse(fs.readFileSync(runFilePath(config, runId), 'utf8')) as { steps: Array<Record<string, unknown>> };
    raw.steps[0].agent = { v: 2, tool: { name: 'claude' } };
    fs.writeFileSync(runFilePath(config, runId), JSON.stringify(raw));

    const stored = await readRun(config, runId);

    expect(stored).toMatchObject({ steps: [{ status: 'succeeded', tool: 'claude' }] });
    expect(typeof stored === 'object' && stored.steps[0]).toEqual(expect.not.objectContaining({ agent: expect.anything() }));
  });
});

describe('sessions a step can still continue', () => {
  /** Leases and reports `count` steps, each with the session `sessions` gives its path, if any. */
  async function settleSteps(config: LocalConfig, runId: string, count: number, sessions: Record<string, string[]>): Promise<string[]> {
    const leased: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const lease = leaseIn(await leaseNext(config, runId, driverA));
      leased.push(lease.step);
      const session = sessions[lease.step]?.shift();
      await reportAttempt(config, runId, {
        attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: driverA, ...(session ? { tool: 'claude', session } : {}),
      });
    }
    return leased;
  }

  async function continued(config: LocalConfig, runId: string): Promise<string[]> {
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(String(run));
    return resumableSessions(run).map((session) => `${session.tool}:${session.id}`).sort();
  }

  it('names the latest session of a step a loop runs again and of the step a later one resumes, and no other', async () => {
    const { config, runId } = await startBuild(workflow('build', `  - id: plan
    prompt: Plan.
  - id: aside
    needs: [plan]
    prompt: Look elsewhere.
  - id: review
    needs: [plan]
    prompt: Review.
    session: continue
    loop: { back_to: review, while: "length(steps.review.passes) < 3", max_iterations: 3 }
  - id: fix
    needs: [plan, review]
    prompt: Fix.
    session: { from: plan }
`));
    await settleSteps(config, runId, 4, { plan: ['p1'], aside: ['a1'], review: ['r1', 'r2'] });

    expect(await continued(config, runId)).toEqual(['claude:p1', 'claude:r2']);
  });

  it('names what the steps of a workflow that has not started yet will continue', async () => {
    const { config, runId } = await startBuild(workflow('build', `  - id: plan
    prompt: Plan.
  - id: brief
    needs: []
    prompt: Brief.
  - id: round
    needs: []
    workflow:
      steps:
        - id: plan
          prompt: Plan this round.
        - id: ask
          needs: [plan]
          prompt: Ask.
          session: continue
    loop: { back_to: round, while: "length(steps.round.passes) < 2", max_iterations: 2 }
  - id: gate
    needs: [plan, brief]
    prompt: Gate.
  - id: work
    needs: [plan, brief, gate]
    workflow:
      steps:
        - id: plan
          prompt: Plan the work.
        - id: draft
          needs: [plan]
          prompt: Draft.
          session: { from: plan }
        - id: check
          needs: []
          prompt: Check.
          session: { from: brief }
`));
    const leased = await settleSteps(config, runId, 4, { 'round.plan': ['q1'], 'round.ask': ['s1'], plan: ['p1'], brief: ['b1'] });

    expect(leased).toEqual(['plan', 'brief', 'round.plan', 'round.ask']);
    expect(await continued(config, runId)).toEqual(['claude:b1', 'claude:s1']);
  });

  it('names nothing for a run whose steps have all settled', async () => {
    const { config, runId } = await startBuild(workflow('build', `  - id: plan
    prompt: Plan.
  - id: fix
    needs: [plan]
    prompt: Fix.
    session: { from: plan }
`));
    await settleSteps(config, runId, 2, { plan: ['p1'], fix: ['f1'] });

    expect(await continued(config, runId)).toEqual([]);
  });
});

describe('the session a step resumes after other steps continued it', () => {
  const PLAN = workflow('build', `  - id: plan
    prompt: Plan.
  - id: build
    needs: [plan]
    prompt: Build.
    session: { from: plan }
  - id: check
    needs: [build]
    prompt: Check.
    session: { from: plan }
  - id: final
    needs: [check]
    prompt: Wrap up.
    session: { from: plan }
`);

  /**
   * Leases the next step and reports it through the report payload a driver sends, with the session the step ran in and
   * the extra fields `fields` adds. Returns the session the lease carried.
   */
  async function step(config: LocalConfig, runId: string, ran: { tool: string; session: string }, fields: Record<string, unknown> = {}): Promise<unknown> {
    const next = await leaseNext(config, runId, driverA);
    const lease = leaseIn(next);
    const parsed = parseReport({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: driverA, ...ran, ...fields });
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.ignored).toEqual([]);
    expect(await reportAttempt(config, runId, parsed.report)).toMatchObject({ data: { accepted: true } });
    return 'data' in next ? (next.data.lease as { session?: unknown }).session : undefined;
  }

  it('hands every later step the plan\'s session while each step resumes it by the same id', async () => {
    const { config, runId } = await startBuild(PLAN);
    const plan = { tool: 'claude', id: 'plan-1' };

    expect(await step(config, runId, { tool: 'claude', session: 'plan-1' })).toBeUndefined();
    expect(await step(config, runId, { tool: 'claude', session: 'plan-1' }, { resumed: plan })).toEqual(plan);
    expect(await step(config, runId, { tool: 'claude', session: 'plan-1' }, { resumed: plan })).toEqual(plan);
    expect(await step(config, runId, { tool: 'claude', session: 'plan-1' }, { resumed: plan })).toEqual(plan);
  });

  it('hands later steps the copy a step continued the session in, through every tool and copy after it', async () => {
    const { config, runId } = await startBuild(PLAN);

    await step(config, runId, { tool: 'claude', session: 'plan-1' });
    expect(await step(config, runId, { tool: 'codex', session: 'copy-1' }, { resumed: { tool: 'claude', id: 'plan-1' } }))
      .toEqual({ tool: 'claude', id: 'plan-1' });
    expect(await step(config, runId, { tool: 'claude', session: 'copy-2' }, { resumed: { tool: 'codex', id: 'copy-1' } }))
      .toEqual({ tool: 'codex', id: 'copy-1', earlier: [{ tool: 'claude', id: 'plan-1' }] });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(String(run));
    expect(resumableSessions(run)).toEqual([{ tool: 'claude', id: 'copy-2', earlier: [{ tool: 'codex', id: 'copy-1' }, { tool: 'claude', id: 'plan-1' }] }]);
    expect(await step(config, runId, { tool: 'claude', session: 'copy-2' }, { resumed: { tool: 'claude', id: 'copy-2' } }))
      .toEqual({ tool: 'claude', id: 'copy-2', earlier: [{ tool: 'codex', id: 'copy-1' }, { tool: 'claude', id: 'plan-1' }] });
  });

  it('keeps handing later steps the plan\'s session when a step started a new session instead of resuming it', async () => {
    const { config, runId } = await startBuild(PLAN);

    await step(config, runId, { tool: 'claude', session: 'plan-1' });
    expect(await step(config, runId, { tool: 'opencode', session: 'ses_fresh' })).toEqual({ tool: 'claude', id: 'plan-1' });
    expect(await step(config, runId, { tool: 'claude', session: 'plan-1' }, { resumed: { tool: 'claude', id: 'plan-1' } }))
      .toEqual({ tool: 'claude', id: 'plan-1' });
  });

  it('refuses a resumed session another step of the run holds, which the lease did not offer', async () => {
    const { config, runId } = await startBuild(workflow('build', `  - id: plan
    prompt: Plan.
  - id: other
    needs: []
    prompt: Other.
  - id: check
    needs: [plan, other]
    prompt: Check.
    session: { from: plan }
`));
    await step(config, runId, { tool: 'claude', session: 'plan-1' });
    await step(config, runId, { tool: 'claude', session: 'other-1' });
    const lease = leaseIn(await leaseNext(config, runId, driverA));

    expect(await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: driverA, tool: 'claude', session: 'check-1',
      resumed: { tool: 'claude', id: 'other-1' },
    })).toMatchObject({ error: { code: 'invalid_report', message: expect.stringContaining('other-1') } });
  });

  it('adds no link when a step releases the session it resumed', async () => {
    const { config, runId } = await startBuild(PLAN);
    await step(config, runId, { tool: 'claude', session: 'plan-1' });
    const lease = leaseIn(await leaseNext(config, runId, driverA));

    expect(await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'released', driver: driverA, tool: 'codex', session: 'copy-1',
      resumed: { tool: 'claude', id: 'plan-1' },
    })).toMatchObject({ data: { accepted: true } });
    const again = await leaseNext(config, runId, driverA);
    expect('data' in again ? (again.data.lease as { session?: unknown }).session : undefined).toEqual({ tool: 'claude', id: 'plan-1' });
  });

  it('accepts the session a lease is handed back with, which a copy continued since it was first leased', async () => {
    const { config, runId } = await startBuild(workflow('build', `  - id: plan
    prompt: Plan.
  - id: review
    needs: [plan]
    prompt: Review.
    session: { from: plan }
  - id: check
    needs: [plan]
    prompt: Check.
    session: { from: plan }
`));
    await step(config, runId, { tool: 'claude', session: 'plan-1' });
    const review = leaseIn(await leaseNext(config, runId, driverA));
    const check = leaseIn(await leaseNext(config, runId, driverA, { running: [review.attempt] }));
    await reportAttempt(config, runId, {
      attempt: check.attempt, revision: check.revision, outcome: 'success', driver: driverA, tool: 'claude', session: 'check-1',
      resumed: { tool: 'claude', id: 'plan-1' },
    });
    const handedBack = await leaseNext(config, runId, driverA, { running: [] });
    expect(handedBack).toMatchObject({
      data: { lease: { attempt: review.attempt, session: { tool: 'claude', id: 'check-1', earlier: [{ tool: 'claude', id: 'plan-1' }] } } },
    });

    expect(await reportAttempt(config, runId, {
      attempt: review.attempt, revision: review.revision, outcome: 'success', driver: driverA, tool: 'claude', session: 'review-1',
      resumed: { tool: 'claude', id: 'check-1' },
    })).toMatchObject({ data: { accepted: true } });
  });

  it('refuses a report whose resumed session is not a tool and an id', () => {
    const report = { attempt: 'a00000000', revision: 1, outcome: 'success', driver: driverA, tool: 'claude', session: 's' };

    expect(parseReport({ ...report, resumed: 's' })).toBe('resumed must be a session: a tool and an id');
    expect(parseReport({ ...report, resumed: { tool: 'claude', id: '' } })).toBe('resumed must be a session: a tool and an id');
  });
});

describe('deliver: pr at workflow start', () => {
  async function start(files: Record<string, string>, name: string, base?: RunState['base']): Promise<{ config: LocalConfig; started: Awaited<ReturnType<typeof startRun>> }> {
    const { config } = testConfig();
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${file}.yaml`), body);
    await syncWorkflowDefinitions(config);
    return { config, started: await startRun(config, name, {}, { secrets: await knownSecrets(config), ...(base ? { base } : {}) }) };
  }
  const commit = 'a'.repeat(40);

  it('refuses a top-level prompt that delivers but runs read-only, naming the step, before the run exists', async () => {
    const { config, started } = await start({ ship: workflow('ship', `  - id: fix
    prompt: Fix the bug.
    deliver: pr
`) }, 'ship', { ref: 'main', commit });

    expect(started).toEqual({ error: {
      code: 'bad_delivery',
      message: 'Step "fix" has deliver: pr but runs read-only. Set workspace: new on it, or on the workflow step that runs it.',
    } });
    expect(fs.existsSync(path.join(config.dataHome ?? '', 'workflows', 'runs'))).toBe(false);
  });

  it('starts the same prompt inside a sub-workflow that a workspace: new step runs', async () => {
    const { started } = await start({
      fix: workflow('fix', `  - id: write
    prompt: Fix the bug.
    deliver: pr
`),
      ship: workflow('ship', `  - id: change
    workspace: new
    workflow: fix
`),
    }, 'ship', { ref: 'main', commit });

    expect(started).toMatchObject({ data: { status: 'running' } });
  });

  it('refuses a workflow step that delivers without a copy of its own', async () => {
    const { started } = await start({ ship: workflow('ship', `  - id: change
    deliver: pr
    workflow:
      steps:
        - id: write
          workspace: new
          prompt: Fix the bug.
`) }, 'ship', { ref: 'main', commit });

    expect(started).toEqual({ error: {
      code: 'bad_delivery',
      message: 'Step "change" delivers its workflow, so it needs workspace: new to own the branch it delivers.',
    } });
  });

  it.each([
    ['refuses', '', { error: {
      code: 'bad_delivery',
      message: 'Step "each" has deliver: pr, but no step of the workflow it runs writes a branch, so it would deliver nothing. Set workspace: new on "each" so its prompt steps write, or give a step in that workflow workspace: new or continue.',
    } }],
    ['starts', '    workspace: new\n', { data: { status: 'running' } }],
  ])('%s a for_each workflow step that delivers, by whether a step its items run writes a branch', async (_case, workspace, expected) => {
    const { config } = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), workflow('review', `  - id: read
    prompt: Review the package.
  - id: lint
    needs: [read]
    command: npm run lint
`));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'ship.yaml'), workflow('ship', `  - id: each
    for_each: inputs.packages
${workspace}    deliver: pr
    workflow: review
`, 'inputs: { packages: [string] }\n'));
    expect((await syncWorkflowDefinitions(config)).invalid).toEqual([]);

    expect(await startRun(config, 'ship', { packages: ['web'] }, { base: { ref: 'main', commit }, secrets: await knownSecrets(config) })).toMatchObject(expected);
  });

  it.each(['approve: Continue?', 'end: done'])('refuses delivery when an inherited writable workflow contains only approval or end steps (%s)', async (action) => {
    const { started } = await start({ ship: workflow('ship', `  - id: change
    workspace: new
    deliver: pr
    workflow:
      ends: { done: succeeded }
      steps:
        - id: approve
          ${action}
        - id: check
          needs: []
          command: echo check
          end: done
`) }, 'ship', { ref: 'main', commit });

    expect(started).toMatchObject({ error: { code: 'bad_delivery', message: expect.stringContaining('no step of the workflow it runs writes a branch') } });
  });

  it('refuses a run that delivers from a detached HEAD, telling to start from a named branch', async () => {
    const { started } = await start({ ship: workflow('ship', `  - id: fix
    workspace: new
    prompt: Fix the bug.
    deliver: pr
`) }, 'ship', { commit });

    expect(started).toEqual({ error: {
      code: 'no_base_branch',
      message: `Step "fix" delivers a pull request, but the run would start from a detached HEAD at ${commit}, so no branch is there for the pull request to target. Check out a named branch, then start the run again.`,
    } });
  });

  it('starts a run from a detached HEAD when no step delivers', async () => {
    const { started } = await start({ ship: workflow('ship', `  - id: fix
    workspace: new
    prompt: Fix the bug.
`) }, 'ship', { commit });

    expect(started).toMatchObject({ data: { status: 'running' } });
  });
});

describe('deadlines', () => {
  const at = (minutes: number): string => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();

  it('gives a lease the first of its own deadline, those of the steps it is under, fan-out items included, and the run\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(at(0)));
      const { config, runId } = await startBuild(graph(`  - id: plan
    command: echo plan
    output:
      targets: [string]
  - id: batch
    needs: [plan]
    timeout: 30m
    for_each: { items: steps.plan.outputs.targets }
    workflow:
      steps:
        - id: work
          command: echo work
          timeout: 45m
`, 'timeout: 1h\n'));
      const plan = leaseIn(await leaseNext(config, runId, driverA));
      expect(plan).toMatchObject({ step: 'plan', expiresAt: at(60) });
      await reportAttempt(config, runId, { attempt: plan.attempt, revision: plan.revision, outcome: 'success', driver: driverA, outputs: { targets: ['a'] } });
      vi.setSystemTime(new Date(at(20)));
      expect(await leaseNext(config, runId, driverA)).toMatchObject({ data: { lease: { step: 'batch[0].work', expiresAt: at(50) } } });
      vi.setSystemTime(new Date(at(25)));
      expect(await leaseNext(config, runId, driverA, { running: [] })).toMatchObject({ data: { lease: { step: 'batch[0].work', expiresAt: at(50) } } });
      expect(await readRun(config, runId)).toMatchObject({ steps: [
        { id: 'plan' },
        { id: 'batch', status: 'running', expiresAt: at(50) },
        { id: 'batch[0]', status: 'running' },
        { id: 'batch[0].work', status: 'leased', lease: { expiresAt: at(65) } },
      ] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps what a lease did not enforce on the step its timeout or a cancel stopped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(at(0)));
      const { config, runId } = await startBuild(graph(`  - id: slow
    timeout: 10m
    requires: { network: false }
    command: echo slow
  - id: other
    needs: []
    requires: { network: false }
    command: echo other
`));
      const slow = leaseIn(await leaseNext(config, runId, driverA));
      const other = leaseIn(await leaseNext(config, runId, driverA, { running: [slow.attempt] }));
      expect(other.step).toBe('other');
      vi.setSystemTime(new Date(at(15)));
      expect(await leaseNext(config, runId, driverA, { running: [slow.attempt, other.attempt] })).toMatchObject({ data: { cancelled: [slow.attempt] } });
      await cancelRun(config, runId, await knownSecrets(config));
      const unenforced = [{ requirement: 'network', asked: false }];
      expect(await readRun(config, runId)).toMatchObject({ steps: [
        { id: 'slow', status: 'failed', failure: { code: 'timeout' }, unenforced },
        { id: 'other', status: 'cancelled', unenforced },
      ] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a workflow step by the timeout of the file it runs when that is shorter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(at(0)));
      const fixture = testConfig();
      const workflows = path.join(fixture.config.repo.localPath, 'workflows');
      fs.writeFileSync(path.join(workflows, 'build.yaml'), graph('  - id: check\n    workflow: check\n    timeout: 1h\n'));
      fs.writeFileSync(path.join(workflows, 'check.yaml'), 'schemaVersion: v1alpha1\nname: check\ndescription: Check it.\ntimeout: 10m\nsteps:\n  - id: inner\n    command: echo inner\n');
      await syncWorkflowDefinitions(fixture.config);
      const started = await startRun(fixture.config, 'build', {}, { secrets: await knownSecrets(fixture.config) });
      if ('error' in started) throw new Error(started.error.message);
      const runId = String(started.data.run);
      expect(await leaseNext(fixture.config, runId, driverA)).toMatchObject({ data: { lease: { step: 'check.inner', expiresAt: at(10) } } });
      vi.setSystemTime(new Date(at(10)));
      expect(await leaseNext(fixture.config, runId, driverA)).toMatchObject({ data: { done: { outcome: 'failed' } } });
      expect(await readRun(fixture.config, runId)).toMatchObject({ steps: [
        { id: 'check', status: 'failed', failure: { code: 'timeout' } },
        { id: 'check.inner', status: 'cancelled', failure: { code: 'timeout' } },
      ] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('token budgets', () => {
  const reports = { can: { tokens: true } };

  async function report(config: LocalConfig, runId: string, lease: { attempt: string; revision: number }, outcome: ReportInput['outcome'], tokens: TokenUsage): Promise<void> {
    expect(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome, driver: driverA, tokens })).toMatchObject({ data: { accepted: true } });
  }

  it('fails a workflow step that spent its budget, counting released attempts and not cached input, so a step that reads it recovers', async () => {
    const { config, runId } = await startBuild(graph(`  - id: check
    budget: { tokens: 100 }
    workflow:
      steps:
        - id: first
          prompt: First.
        - id: second
          needs: [first]
          prompt: Second.
  - id: recover
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: echo recover
`));
    await report(config, runId, leaseIn(await leaseNext(config, runId, driverA, reports)), 'success', { input: 50, output: 10, cachedInput: 1000 });
    const second = leaseIn(await leaseNext(config, runId, driverA, reports));
    expect(second.step).toBe('check.second');
    await report(config, runId, second, 'released', { input: 30, output: 20 });
    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { lease: { step: 'recover' } } });
    expect(await readRun(config, runId)).toMatchObject({
      releasedTokens: [{ step: 'check.second', attempt: second.attempt, tokens: { input: 30, output: 20 } }],
      steps: [
        { id: 'check', status: 'failed', failure: { code: 'budget_exceeded', message: 'step "check" inline workflow spent 110 of its 100-token budget' } },
        { id: 'check.first', status: 'succeeded' },
        { id: 'check.second', status: 'skipped' },
        { id: 'recover', status: 'leased' },
      ],
    });
  });

  it('spends a for_each workflow step\'s budget over all its items', async () => {
    const { config, runId } = await startTree({ build: workflow('build', `  - id: check
    budget: { tokens: 100 }
    for_each: { items: inputs.targets, max_parallel: 1 }
    workflow:
      steps:
        - id: review
          prompt: "Review {{ item }}."
  - id: recover
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: echo recover
`, 'inputs:\n  targets: [string]\n') }, 'build', { targets: ['web', 'api', 'cli'] });
    await report(config, runId, leaseIn(await leaseNext(config, runId, driverA, reports)), 'success', { input: 50, output: 10 });
    await report(config, runId, leaseIn(await leaseNext(config, runId, driverA, reports)), 'success', { input: 50, output: 10 });

    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { lease: { step: 'recover' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([
      expect.objectContaining({ id: 'check', status: 'failed', failure: { code: 'budget_exceeded', message: 'step "check" spent 120 of its 100-token budget' } }),
      expect.objectContaining({ id: 'check[2]', status: 'skipped' }),
    ]) });
  });

  it('keeps the budget of the workflow file each for_each item runs to that item', async () => {
    const { config, runId } = await startTree({
      build: workflow('build', `  - id: check
    for_each: { items: inputs.targets, max_parallel: 1 }
    workflow: review
`, 'inputs:\n  targets: [string]\n'),
      review: workflow('review', `  - id: review
    prompt: Review.
`, 'budget: { tokens: 100 }\n'),
    }, 'build', { targets: ['web', 'api'] });
    await report(config, runId, leaseIn(await leaseNext(config, runId, driverA, reports)), 'success', { input: 50, output: 10 });
    await report(config, runId, leaseIn(await leaseNext(config, runId, driverA, reports)), 'success', { input: 50, output: 10 });

    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('counts the passes a loop archived, so the run fails before a pass that would start past its budget', async () => {
    const { config, runId } = await startBuild(graph(`  - id: work
    workflow:
      steps:
        - id: review
          prompt: Review.
    loop: { back_to: work, max_iterations: 5 }
`, 'budget: { tokens: 5 }\n'));
    for (let pass = 0; pass < 2; pass += 1) {
      const review = leaseIn(await leaseNext(config, runId, driverA, reports));
      expect(review.step).toBe('work.review');
      await report(config, runId, review, 'success', { input: 2, output: 1 });
    }
    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'budget_exceeded' } } } });
  });

  it('lets a workflow spend exactly its budget', async () => {
    const { config, runId } = await startBuild(graph(`  - id: work
    prompt: Work.
`, 'budget: { tokens: 10 }\n'));
    await report(config, runId, leaseIn(await leaseNext(config, runId, driverA, reports)), 'success', { input: 6, output: 4 });
    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('counts the tokens a stopped attempt\'s own driver reports, once, and still answers lease_cancelled', async () => {
    const { config, runId } = await startBuild(graph(`  - id: work
    prompt: Work.
  - id: other
    needs: []
    prompt: Other.
`, 'budget: { tokens: 10 }\n'));
    const work = leaseIn(await leaseNext(config, runId, driverA, reports));
    const other = leaseIn(await leaseNext(config, runId, driverA, { ...reports, running: [work.attempt] }));
    await report(config, runId, work, 'success', { input: 15, output: 5 });
    expect(await leaseNext(config, runId, driverA, { ...reports, running: [other.attempt] })).toMatchObject({ data: { done: { outcome: 'failed' }, cancelled: [other.attempt] } });
    const late = { attempt: other.attempt, revision: other.revision, outcome: 'success' as const, tokens: { input: 7 } };
    expect(await reportAttempt(config, runId, { ...late, driver: driverB })).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(await reportAttempt(config, runId, { ...late, driver: driverA })).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(await reportAttempt(config, runId, { ...late, driver: driverA })).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(await readRun(config, runId)).toMatchObject({ releasedTokens: [{ step: 'other', attempt: other.attempt, tokens: { input: 7 } }] });
  });

  it('counts the late tokens of an attempt a held hand-back stopped', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-value');
    const { config, runId } = await startBuild(graph(`  - id: work
    prompt: Work.
    requires: { env: [DEPLOY_TOKEN] }
`));
    const work = leaseIn(await leaseNext(config, runId, driverA, { can: { tokens: true, env: true } }));
    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { wait: { held: [{ step: 'work', missing: ['env'] }] } } });
    expect(await reportAttempt(config, runId, { attempt: work.attempt, revision: work.revision, outcome: 'success', driver: driverA, tokens: { input: 7 } }))
      .toMatchObject({ error: { code: 'lease_cancelled' } });

    expect(await readRun(config, runId)).toMatchObject({ releasedTokens: [{ step: 'work', attempt: work.attempt, tokens: { input: 7 } }] });
  });

  it('charges a stopped attempt\'s late tokens to the budget it was leased under, not to the one a retry opened after it', async () => {
    const { config, runId } = await startBuild(graph(`  - id: a
    prompt: A.
  - id: b
    needs: []
    prompt: B.
  - id: c
    needs: []
    prompt: C.
`, 'budget: { tokens: 10 }\n'));
    const a = leaseIn(await leaseNext(config, runId, driverA, reports));
    const b = leaseIn(await leaseNext(config, runId, driverA, { ...reports, running: [a.attempt] }));
    const c = leaseIn(await leaseNext(config, runId, driverA, { ...reports, running: [a.attempt, b.attempt] }));
    await report(config, runId, a, 'success', { input: 12 });
    expect(await leaseNext(config, runId, driverA, { ...reports, running: [b.attempt, c.attempt] })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await retryStep(config, runId, await knownSecrets(config), 'b')).toMatchObject({ data: { reopened: true } });
    expect(await reportAttempt(config, runId, { attempt: c.attempt, revision: c.revision, outcome: 'success', driver: driverA, tokens: { input: 20 } }))
      .toMatchObject({ error: { code: 'lease_cancelled' } });

    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { lease: { step: 'b' } } });
  });

  it('counts the late tokens of a stopped attempt whose step a retry already replaced', async () => {
    const { config, runId } = await startBuild(graph(`  - id: a
    prompt: A.
  - id: b
    needs: []
    prompt: B.
`, 'budget: { tokens: 100 }\n'));
    const a = leaseIn(await leaseNext(config, runId, driverA, reports));
    const b = leaseIn(await leaseNext(config, runId, driverA, { ...reports, running: [a.attempt] }));
    expect(await cancelRun(config, runId, await knownSecrets(config), 'a')).toMatchObject({ data: { cancelled: { attempts: [a.attempt] } } });
    expect(await retryStep(config, runId, await knownSecrets(config), 'a')).toMatchObject({ data: {} });
    expect(await reportAttempt(config, runId, { attempt: a.attempt, revision: a.revision, outcome: 'success', driver: driverA, tokens: { input: 7 } }))
      .toMatchObject({ error: { code: 'lease_cancelled' } });

    expect(await readRun(config, runId)).toMatchObject({ releasedTokens: [{ step: 'a', attempt: a.attempt, tokens: { input: 7 } }] });
    expect(b.step).toBe('b');
  });

  it('gives a workflow step a whole budget on each pass a loop runs it', async () => {
    const { config, runId } = await startBuild(graph(`  - id: work
    budget: { tokens: 5 }
    workflow:
      steps:
        - id: review
          prompt: Review.
    loop: { back_to: work, max_iterations: 3 }
`));
    for (let pass = 0; pass < 3; pass += 1) {
      const review = leaseIn(await leaseNext(config, runId, driverA, reports));
      expect(review.step).toBe('work.review');
      await report(config, runId, review, 'success', { input: 2, output: 1 });
    }
    expect(await leaseNext(config, runId, driverA, reports)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'work', status: 'failed', failure: { code: 'loop_exhausted' } }] });
  });

  it('gives a budgeted interactive prompt to a driver that cannot meter it, and records its spend as not counted', async () => {
    const { config, runId } = await startBuild(graph(`  - id: pair
    interactive: true
    prompt: Work on it with me.
  - id: after
    needs: [pair]
    prompt: Sum it up.
`, 'budget: { tokens: 100 }\n'));
    const pair = leaseIn(await leaseNext(config, runId, driverA, { can: { hitl: true } }));
    expect(pair.step).toBe('pair');
    expect(await reportAttempt(config, runId, { attempt: pair.attempt, revision: pair.revision, outcome: 'success', driver: driverA })).toMatchObject({
      data: { step: { id: 'pair', status: 'succeeded', unenforced: [{ requirement: 'budget' }] } },
    });
    expect(await leaseNext(config, runId, driverA, { can: { hitl: true } })).toMatchObject({
      data: { wait: { held: [{ step: 'after', missing: ['tokens'] }] } },
    });
  });
});

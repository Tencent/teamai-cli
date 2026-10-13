import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, SETTLED_ATTEMPTS_LIMIT, startRun } from '../workflow/engine.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import { outputMismatch } from '../workflow/output.js';
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
    command: node two.js
    output:
      ok: boolean
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow engine', () => {
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

  it('stops the run when a step fails', async () => {
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
    expect(stored).toMatchObject({ status: 'failed', steps: [{ status: 'failed' }, { status: 'pending' }] });
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
});

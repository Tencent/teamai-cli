import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../utils/logger.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, parseNextPayload, parseReport, reportAttempt, startRun, type NextOptions } from '../workflow/engine.js';
import { cancelRun, respondToHitl, retryStep } from '../workflow/run-controls.js';
import { pendingRecords } from '../workflow/records.js';
import { projectRun } from '../workflow/snapshot.js';
import { readRun, runFilePath } from '../workflow/store.js';
import type { RunState, WorkflowEnvelope } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

const roots: string[] = [];
const driver = { kind: 'test', machine: 'test', workspace: '/work' };
const hitl = { can: { hitl: true } };
interface ControlData {
  run: { id: string; status: string; revision: number };
  lease: { step: string; attempt: string; revision: number; prompt?: string; interactive?: true };
  hitl: { step: string; pass: number; message: string };
  done: { outcome: string };
  answered: { choice: string };
  cancelled: { steps: string[]; attempts: string[] };
  retried: { pass: number };
  reopened: boolean;
  accepted: boolean;
}
function data(result: WorkflowEnvelope): ControlData {
  expect(result).not.toHaveProperty('error');
  if ('error' in result) throw new Error(result.error.message);
  return result.data as unknown as ControlData;
}
async function fixture(steps: string, header = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-controls-'));
  roots.push(root);
  const config: LocalConfig = { repo: { localPath: path.join(root, 'repo'), remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  fs.mkdirSync(path.join(config.repo.localPath, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows/build.yaml'), `schemaVersion: v1alpha1\nname: build\ndescription: Run controls.\n${header}steps:\n${steps}\n`);
  const synced = await syncWorkflowDefinitions(config);
  expect(synced.invalid).toEqual([]);
  const started = await startRun(config, 'build', header.includes('after:') ? { items: [{ id: 'one', after: [] }, { id: 'two', after: ['one'] }] } : header.includes('inputs:') ? { items: [{ name: 'one' }] } : {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  const id = String(started.data.run);
  return { config, id, next: (options: NextOptions = {}) => leaseNext(config, id, driver, { ...hitl, ...options }),
    respond: async (step: string, choice: string, extra = {}) => respondToHitl(config, id, await knownSecrets(config), { step, choice, channel: 'tty', agent: false, ...extra }),
    report: (lease: { attempt: string; revision: number }, outcome: 'success' | 'failed' = 'success') => reportAttempt(config, id, { attempt: lease.attempt, revision: lease.revision, driver, outcome }),
    state: async () => await readRun(config, id) as RunState };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('workflow HITL', () => {
  it('opens a HITL request without a lease or revision bump, answers, then leases', async () => {
    const f = await fixture('  - id: build\n    approve: Build it?\n    command: echo build');
    const hitl = data(await f.next()).hitl;
    expect(hitl).toEqual({ run: f.id, step: 'build', pass: 1, kind: 'approve', message: 'Build it?', options: ['yes', 'no'], required: false, respond: `teamai workflow respond ${f.id} build <option> --pass 1` });
    expect((await f.state()).revision).toBe(1);
    const answered = data(await f.respond('build', 'yes', { note: 'Ready' }));
    expect(answered).toEqual({ answered: { step: 'build', pass: 1, choice: 'yes', channel: 'tty' }, run: { id: f.id, status: 'running', revision: 1 } });
    expect(data(await f.next()).lease.step).toBe('build');
    expect((await f.state()).steps[0]?.answer).toMatchObject({ choice: 'yes', note: 'Ready', channel: 'tty', agent: false, at: expect.any(String) });
    expect(await f.respond('build', 'no')).toMatchObject({ error: { code: 'repeated_response', message: expect.stringContaining('yes') } });
  });

  it('a refused end HITL request skips instead of eagerly reaching its end', async () => {
    const f = await fixture('  - id: finish\n    approve: Finish?\n    end: shipped\n  - id: work\n    needs: []\n    command: echo work', 'ends: { shipped: succeeded }\n');
    const lease = data(await f.next()).lease;
    expect(lease.step).toBe('work');
    expect(data(await f.next({ ...hitl, running: [lease.attempt], canTakeLease: false } as NextOptions)).hitl.step).toBe('finish');
    await f.respond('finish', 'no');
    expect((await f.state()).steps[0]?.status).toBe('skipped');
    await f.report(lease);
    expect(data(await f.next()).done).toMatchObject({ run: f.id, outcome: 'succeeded' });
  });

  it('an approved end HITL request reaches its end without leasing', async () => {
    const f = await fixture('  - id: finish\n    approve: Finish?\n    end: shipped', 'ends: { shipped: succeeded }\n');
    expect(data(await f.next()).hitl.step).toBe('finish');
    expect(data(await f.respond('finish', 'yes')).run).toMatchObject({ status: 'succeeded', end: 'shipped', revision: 1 });
  });

  it.each([
    ['approve: Go?', false, 'skipped', 'no', 'no_hitl'],
    ['approve: Go?', true, 'succeeded', 'yes', 'auto_approve'],
    ['approve: { message: Go?, required: true }', false, 'failed', undefined, undefined],
    ['approve: { message: Go?, required: true }', true, 'failed', undefined, undefined],
    ['choose: { message: Pick, options: [one, two], default: one }', true, 'succeeded', 'one', 'auto_approve'],
    ['choose: { message: Pick, options: [one, two], default: one }', false, 'failed', undefined, undefined],
    ['choose: { message: Pick, options: [one, two] }', true, 'failed', undefined, undefined],
  ])('settles %s without HITL with auto_approve=%s', async (hitl, auto, status, choice, channel) => {
    const f = await fixture(`  - id: ask\n    ${hitl}`);
    f.config.workflows = { tools: {}, auto_approve: auto };
    expect(data(await leaseNext(f.config, f.id, driver))).toHaveProperty('done');
    const state = (await f.state()).steps[0]!;
    expect(state.status).toBe(status);
    expect(state.answer).toEqual(choice ? { choice, channel, agent: false, at: expect.any(String) } : undefined);
    if (state.status === 'failed') expect(state.failure?.code).toBe('hitl_required');
  });

  it('requires a terminal answer for a required HITL request, and validates choice and pass', async () => {
    const f = await fixture('  - id: ask\n    approve: { message: Go?, required: true }\n    command: echo work');
    expect(await f.respond('ask', 'yes', { channel: 'cli', agent: true })).toMatchObject({ error: { code: 'agent_in_path' } });
    expect(await f.respond('ask', 'wrong')).toMatchObject({ error: { code: 'invalid_choice' } });
    expect(await f.respond('ask', 'yes', { pass: 2 })).toMatchObject({ error: { code: 'stale_response' } });
    expect(data(await f.respond('ask', 'yes')).answered.choice).toBe('yes');
  });

  it('asks on every loop pass and renders the previous answer note', async () => {
    const f = await fixture(`  - id: plan
    prompt: "Plan {{ steps.decide.note }}"
  - id: decide
    needs: [plan]
    choose: { message: "After {{ steps.plan.outcome }}", options: [build, revise] }
    loop: { back_to: plan, while: "steps.decide.choice == 'revise'", max_iterations: 3 }`);
    const first = data(await f.next()).lease;
    expect(first.prompt).toBe('Plan ');
    await f.report(first);
    expect(data(await f.next()).hitl.message).toBe('After success');
    await f.respond('decide', 'revise', { note: 'Keep the flag', pass: 1 });
    const second = data(await f.next()).lease;
    expect(second.prompt).toBe('Plan Keep the flag');
    await f.report(second);
    expect(data(await f.next()).hitl.pass).toBe(2);
    expect(await f.respond('decide', 'build', { pass: 1 })).toMatchObject({ error: { code: 'stale_response' } });
    expect(data(await f.respond('decide', 'build', { pass: 2 })).run.status).toBe('succeeded');
    const decide = (await f.state()).steps.find((s) => s.id === 'decide')!;
    expect(decide.passes?.[0]?.answer?.note).toBe('Keep the flag');
  });

  it('holds interactive work for a driver with HITL and leases it to one', async () => {
    const f = await fixture('  - id: pair\n    prompt: Pair with me.\n    interactive: true');
    expect(data(await f.next()).lease.interactive).toBe(true);
    const alone = await fixture('  - id: pair\n    prompt: Pair with me.\n    interactive: true');
    expect(await leaseNext(alone.config, alone.id, driver)).toMatchObject({ data: { wait: { held: [
      { step: 'pair', reason: 'step "pair" needs hitl, which this driver does not declare', missing: ['hitl'] },
    ] } } });
    expect((await alone.state()).steps[0]).toMatchObject({ status: 'pending' });
  });

  it('parses capabilities separately from driver identity and reports unknown names', () => {
    expect(parseNextPayload({ driver: { ...driver, can: { hitl: true, unknown: 'secret' } }, other: 1 })).toEqual({ request: { driver, can: { hitl: true } }, ignored: ['other', 'driver.can.unknown'] });
    expect(parseNextPayload({ driver: { ...driver, can: { hitl: 'yes' } } })).toBe('driver.can.hitl: Expected boolean, received string');
    expect(parseNextPayload({ driver: { ...driver, can: { workspace: ['new', 'elsewhere'] } } })).toMatch(/^driver\.can\.workspace\.1: /);
  });

  it('reads claim as a request to take the run over, and refuses one that is not a boolean', () => {
    expect(parseNextPayload({ driver, claim: true })).toEqual({ request: { driver, claim: true }, ignored: [] });
    expect(parseNextPayload({ driver, claim: 'yes' })).toBe('claim must be a boolean');
  });
});


describe('workflow cancellation', () => {
  it('cancels a leased attempt, rejects its report, and lists it to the driver', async () => {
    const f = await fixture('  - id: work\n    command: echo work\n  - id: later\n    needs: [work]\n    command: echo later');
    const lease = data(await f.next()).lease;
    expect(data(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'work'))).toMatchObject({ cancelled: { steps: ['work'], attempts: [lease.attempt] }, run: { status: 'failed', revision: 1 } });
    expect(await f.report(lease)).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(data(await leaseNext(f.config, f.id, driver, { ...hitl, running: [lease.attempt] })).cancelled).toEqual([lease.attempt]);
    expect((await f.state()).steps[0]).toMatchObject({ status: 'cancelled', failure: { code: 'cancelled' } });
  });

  it('cancels pending work as stopped, so its dependents skip', async () => {
    const f = await fixture('  - id: first\n    command: echo first\n  - id: pending\n    needs: [first]\n    command: echo pending\n  - id: later\n    needs: [pending]\n    command: echo later');
    await f.next();
    expect(data(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'pending')).run.status).toBe('running');
    expect((await f.state()).steps.map((s) => s.status)).toEqual(['leased', 'cancelled', 'skipped']);
    expect(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'later')).toMatchObject({ error: { code: 'not_cancellable' } });
  });

  it('cancels a waiting HITL request and allows a recovery branch', async () => {
    const f = await fixture(`  - id: ask
    approve: Go?
  - id: recover
    needs: [ask]
    if: steps.ask.outcome == 'cancelled'
    end: recovered`, 'ends: { recovered: succeeded }\n');
    expect(data(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'ask')).run).toMatchObject({ status: 'succeeded', end: 'recovered' });
  });

  it('stops descendants of a running workflow and preserves their attempts', async () => {
    const f = await fixture(`  - id: nested
    workflow:
      steps:
        - id: work
          command: echo work
        - id: pending
          needs: [work]
          command: echo pending`);
    const lease = data(await f.next()).lease;
    const cancelled = data(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'nested'));
    expect(cancelled.cancelled.attempts).toEqual([lease.attempt]);
    expect((await f.state()).steps.map((s) => s.status)).toEqual(['cancelled', 'cancelled', 'skipped']);
    expect(await f.report(lease)).toMatchObject({ error: { code: 'lease_cancelled' } });
  });

  it('whole-run cancel does not start another round of a top-level loop', async () => {
    const f = await fixture('  - id: work\n    command: echo work', 'loop: { max_iterations: 3 }\n');
    const lease = data(await f.next()).lease;
    await f.report(lease);
    expect(data(await cancelRun(f.config, f.id, await knownSecrets(f.config))).run).toMatchObject({ status: 'cancelled', revision: 2 });
    expect((await f.state()).round).toBeUndefined();
    expect(await cancelRun(f.config, f.id, await knownSecrets(f.config))).toMatchObject({ error: { code: 'run_settled' } });
  });
});


describe('workflow retry', () => {
  it.each(['cancelled', 'failed', 'succeeded'])('points to resume after reopening a %s run', async (outcome) => {
    const f = await fixture(outcome === 'succeeded'
      ? '  - id: work\n    choose: { message: Go?, options: [go, stop] }'
      : '  - id: work\n    command: echo work');
    if (outcome === 'succeeded') {
      await f.next();
      await f.respond('work', 'go');
    } else {
      const lease = data(await f.next()).lease;
      if (outcome === 'cancelled') await cancelRun(f.config, f.id, await knownSecrets(f.config));
      else {
        await f.report(lease, 'failed');
        await f.next();
      }
    }
    expect((await f.state()).status).toBe(outcome);
    expect(data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'work'))).toMatchObject({
      reopened: true, run: { status: 'running' }, resume: `teamai workflow resume ${f.id}`,
    });
  });

  it('counts the workflow timeout of a reopened run from the retry, in the run and in what it publishes', async () => {
    const f = await fixture('  - id: work\n    command: echo work', 'timeout: 1h\n');
    await f.report(data(await f.next()).lease, 'failed');
    expect(data(await f.next()).done.outcome).toBe('failed');
    const before = Date.now();
    expect(data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'work'))).toMatchObject({ reopened: true });
    const state = await f.state();
    expect(Date.parse(state.limitsFrom?.at ?? '')).toBeGreaterThanOrEqual(before - 1000);
    const projected = projectRun(state, {});
    expect(projected.ok && projected.value.limitsFrom).toEqual(state.limitsFrom);
  });

  it('gives a run a whole timeout again when the retry is what finds it timed out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const f = await fixture('  - id: work\n    command: echo work', 'timeout: 1h\n');
      data(await f.next());
      vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
      data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'work'));
      expect(data(await f.next()).lease).toMatchObject({ step: 'work', expiresAt: '2026-01-01T03:00:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a run that spent its budget, and a workflow step that spent its own, a whole budget again on retry', async () => {
    const tokens = { can: { hitl: true, tokens: true } };
    const spend = async (f: Awaited<ReturnType<typeof fixture>>, step: string): Promise<void> => {
      const lease = data(await f.next(tokens)).lease;
      expect(lease.step).toBe(step);
      data(await reportAttempt(f.config, f.id, { attempt: lease.attempt, revision: lease.revision, driver, outcome: 'success', tokens: { input: 15, output: 5 } }));
    };
    const run = await fixture('  - id: work\n    prompt: Work.\n  - id: other\n    needs: []\n    prompt: Other.', 'budget: { tokens: 10 }\n');
    const work = data(await run.next(tokens)).lease;
    expect(data(await run.next({ ...tokens, running: [work.attempt] })).lease.step).toBe('other');
    data(await reportAttempt(run.config, run.id, { attempt: work.attempt, revision: work.revision, driver, outcome: 'success', tokens: { input: 15, output: 5 } }));
    expect(data(await run.next(tokens)).done).toMatchObject({ outcome: 'failed', failure: { code: 'budget_exceeded' } });
    data(await retryStep(run.config, run.id, await knownSecrets(run.config), 'other'));
    await spend(run, 'other');

    const nested = await fixture('  - id: check\n    budget: { tokens: 10 }\n    workflow:\n      steps:\n        - id: inner\n          prompt: Inner.');
    await spend(nested, 'check.inner');
    expect(data(await nested.next(tokens)).done).toMatchObject({ outcome: 'failed' });
    expect((await nested.state()).steps[0]).toMatchObject({ id: 'check', failure: { code: 'budget_exceeded' } });
    data(await retryStep(nested.config, nested.id, await knownSecrets(nested.config), 'check'));
    await spend(nested, 'check.inner');
  });

  it('reopens a failed run, keeps the failed pass and retries skipped dependents', async () => {
    const f = await fixture('  - id: work\n    command: echo work\n  - id: later\n    needs: [work]\n    command: echo later');
    await f.report(data(await f.next()).lease, 'failed');
    expect(data(await f.next()).done.outcome).toBe('failed');
    expect(data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'work'))).toMatchObject({ retried: { step: 'work', pass: 2 }, reopened: true, run: { status: 'running', revision: 3 } });
    const state = await f.state();
    expect(state.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
    expect(state.steps[0]?.passes?.[0]).toMatchObject({ pass: 1, outcome: 'failed' });
    expect(state.steps[1]?.pass).toBeUndefined();
    await f.report(data(await f.next()).lease);
    const later = data(await f.next()).lease;
    expect(later.step).toBe('later');
    await f.report(later);
    expect(data(await f.next()).done.outcome).toBe('succeeded');
  });

  it('invalidates a stuck lease and keeps parallel leases reportable at their own revision', async () => {
    const f = await fixture('  - id: one\n    command: echo one\n  - id: two\n    needs: []\n    command: echo two');
    const one = data(await f.next()).lease;
    const two = data(await leaseNext(f.config, f.id, driver, { ...hitl, running: [one.attempt] })).lease;
    const retried = data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'one'));
    expect(retried.retried.pass).toBe(2);
    expect(retried.reopened).toBe(false);
    expect(retried).not.toHaveProperty('resume');
    expect(await f.report(one)).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(data(await f.report(two)).accepted).toBe(true);
    expect((await f.state()).steps[0]?.passes?.[0]).toMatchObject({ outcome: 'cancelled', failure: { code: 'retried' } });
  });

  it.each(['nested', 'items'])('reopens a failed child through %s containers', async (kind) => {
    const f = await fixture(`  - id: parent
    ${kind === 'items' ? 'for_each: inputs.items\n    ' : ''}workflow:
      steps:
        - id: work
          command: echo work
        - id: later
          needs: [work]
          command: echo later`, kind === 'items' ? 'inputs: { items: [{ name: string }] }\n' : '');
    const lease = data(await f.next()).lease;
    await f.report(lease, 'failed');
    await f.next();
    expect(data(await retryStep(f.config, f.id, await knownSecrets(f.config), lease.step)).reopened).toBe(true);
    expect((await f.state()).steps[0]?.status).toBe('running');
    expect(data(await f.next()).lease.step).toBe(lease.step);
  });

  it('resets the targeted loop owner after loop_exhausted', async () => {
    const f = await fixture('  - id: work\n    command: echo work\n    loop: { back_to: work, max_iterations: 1 }');
    await f.report(data(await f.next()).lease);
    expect(data(await f.next()).done.outcome).toBe('failed');
    expect((await f.state()).steps[0]).toMatchObject({ status: 'failed', iteration: 1 });
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'work');
    expect(data(await f.next()).lease.step).toBe('work');
  });

  it('rejects retry beneath an independent standing end without changing passes', async () => {
    const f = await fixture('  - id: work\n    command: echo work\n  - id: finish\n    needs: []\n    approve: Finish?\n    end: shipped', 'ends: { shipped: succeeded }\n');
    await f.next();
    await f.respond('finish', 'yes');
    const before = await f.state();
    expect(await retryStep(f.config, f.id, await knownSecrets(f.config), 'work')).toMatchObject({ error: { code: 'not_retryable', message: expect.stringContaining('does not depend on it') } });
    expect(await f.state()).toEqual(before);
  });

  it('retries a cone end and undoes its skips and lease cancellations', async () => {
    const f = await fixture(`  - id: work
    command: echo work
  - id: finish
    needs: [work]
    if: steps.work.outcome == 'failed'
    end: failed
  - id: parallel
    needs: []
    command: echo parallel
  - id: later
    needs: [parallel]
    command: echo later`, 'ends: { failed: failed }\n');
    const work = data(await f.next()).lease;
    const parallel = data(await leaseNext(f.config, f.id, driver, { ...hitl, running: [work.attempt] })).lease;
    await f.report(work, 'failed');
    await f.next();
    expect((await f.state()).steps.map((s) => s.status)).toEqual(['failed', 'succeeded', 'cancelled', 'skipped']);
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'work');
    expect((await f.state()).steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(await f.report(parallel)).toMatchObject({ error: { code: 'lease_cancelled' } });
  });
});

describe('retry graph boundaries', () => {
  it('retries a fan-out item and the items after it, retaining unrelated cancellations', async () => {
    const f = await fixture(`  - id: items
    for_each: inputs.items
    command: echo item
  - id: unrelated
    needs: []
    command: echo unrelated`, 'inputs: { items: [{ id: string, after: [string] }] }\n');
    const lease = data(await f.next()).lease;
    expect(lease.step).toBe('items[0]');
    await f.report(lease, 'failed');
    await cancelRun(f.config, f.id, await knownSecrets(f.config), 'unrelated');
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'items[0]');
    const run = await f.state();
    expect(run.steps.find((s) => s.id === 'items')?.status).toBe('running');
    expect(run.steps.find((s) => s.id === 'unrelated')?.status).toBe('cancelled');
    const retried = data(await f.next()).lease;
    expect(retried.step).toBe('items[0]');
    await f.report(retried);
    expect(data(await f.next()).lease.step).toBe('items[1]');
  });

  it('replaces a refused answer in the retry cone with a new unanswered pass', async () => {
    const f = await fixture(`  - id: work
    command: echo work
  - id: ask
    needs: [work]
    if: steps.work.outcome == 'failed'
    approve: Recover?`);
    await f.report(data(await f.next()).lease, 'failed');
    await f.respond('ask', 'no');
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'work');
    const ask = (await f.state()).steps.find((s) => s.id === 'ask')!;
    expect(ask).toMatchObject({ status: 'pending', pass: 2, passes: [{ pass: 1, outcome: 'skipped', answer: { choice: 'no' } }] });
    expect(ask.answer).toBeUndefined();
  });

  it('retains the final top-level round when retrying exhausted work', async () => {
    const f = await fixture('  - id: work\n    command: echo work', 'loop: { max_iterations: 1 }\n');
    await f.report(data(await f.next()).lease, 'failed');
    expect(data(await f.next()).done.outcome).toBe('failed');
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'work');
    await f.report(data(await f.next()).lease);
    await f.next();
    expect((await f.state()).failure?.code).toBe('loop_exhausted');
  });

  it('does not reset a loop owner when retry targets another step in its range', async () => {
    const f = await fixture(`  - id: work
    command: echo work
  - id: decide
    needs: [work]
    choose: { message: Again?, options: [again, stop] }
    loop: { back_to: work, while: "steps.decide.choice == 'again'", max_iterations: 3 }`);
    await f.report(data(await f.next()).lease);
    await f.respond('decide', 'again');
    await f.report(data(await f.next()).lease, 'failed');
    await f.next();
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'work');
    expect((await f.state()).steps.find((s) => s.id === 'decide')?.iteration).toBe(1);
  });
});


it('accepts interactive success without outputs but validates outputs that were supplied', async () => {
  const f = await fixture('  - id: pair\n    prompt: Work together.\n    interactive: true\n    output: { ok: boolean }');
  const lease = data(await f.next()).lease;
  expect(data(await f.report(lease)).accepted).toBe(true);
  expect(data(await f.next()).done.outcome).toBe('succeeded');
  const invalid = await fixture('  - id: pair\n    prompt: Work together.\n    interactive: true\n    output: { ok: boolean }');
  const other = data(await invalid.next()).lease;
  await reportAttempt(invalid.config, invalid.id, { ...other, outcome: 'success', driver, outputs: { ok: 'wrong' } });
  expect(data(await invalid.next()).done.outcome).toBe('failed');
});


it('ignores the process override and top-level capabilities in JSON, and leaves report capabilities opaque', () => {
  expect(parseNextPayload({ driver, can: { hitl: true }, autoApprove: true })).toEqual({ request: { driver }, ignored: ['can', 'autoApprove'] });
  expect(parseReport({ driver: { ...driver, can: { hitl: true, future: 'secret' } }, attempt: 'a1', revision: 1, outcome: 'success' })).toMatchObject({ ignored: [] });
});

it('fails a HITL request message changed after pull with invalid_template', async () => {
  const f = await fixture('  - id: ask\n    approve: Continue?');
  const run = await f.state();
  run.definition.steps[0]!.hitl!.message = '{{ steps.ask.unknown }}';
  fs.writeFileSync(runFilePath(f.config, f.id), JSON.stringify(run));
  expect(data(await f.next()).done.outcome).toBe('failed');
  expect((await f.state()).steps[0]).toMatchObject({ status: 'failed', failure: { code: 'invalid_template' } });
});


describe('changing a HITL request answer', () => {
  it('retries a refused approve and asks again at a new pass', async () => {
    const f = await fixture('  - id: ask\n    approve: Continue?\n    command: echo work');
    await f.respond('ask', 'no');
    expect(data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'ask'))).toMatchObject({ retried: { pass: 2 }, reopened: true });
    expect(data(await f.next()).hitl).toMatchObject({ step: 'ask', pass: 2, respond: `teamai workflow respond ${f.id} ask <option> --pass 2` });
    await f.respond('ask', 'yes', { pass: 2 });
    expect(data(await f.next()).lease.step).toBe('ask');
    expect((await f.state()).steps[0]?.passes?.[0]?.answer?.choice).toBe('no');
  });

  it('retries a succeeded choose, including the end selected by its old answer', async () => {
    const f = await fixture(`  - id: decide
    choose: { message: Build or drop?, options: [build, drop] }
  - id: drop
    needs: [decide]
    if: steps.decide.choice == 'drop'
    end: dropped
  - id: build
    needs: [decide]
    if: steps.decide.choice == 'build'
    command: echo build`, 'ends: { dropped: succeeded }\n');
    await f.respond('decide', 'drop');
    expect((await f.state()).end).toBe('dropped');
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'decide');
    expect(data(await f.next()).hitl.pass).toBe(2);
    await f.respond('decide', 'build');
    expect(data(await f.next()).lease.step).toBe('build');
    expect((await f.state()).end).toBeUndefined();
  });

  it('logs every HITL decision without a HITL driver and hitl_required failure once', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const no = await fixture('  - id: ask\n    approve: Continue?');
    await leaseNext(no.config, no.id, driver);
    await leaseNext(no.config, no.id, driver);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith('Step "ask" was skipped: its approve HITL request needs a person, and the driver declares no HITL (driver.can.hitl). Set workflows.auto_approve, pass --auto-approve, or run the workflow from a terminal.');
    const yes = await fixture('  - id: ask\n    approve: Continue?');
    await leaseNext(yes.config, yes.id, driver, { autoApprove: true });
    expect(warn).toHaveBeenLastCalledWith('Step "ask" was approved by auto_approve.');
    const choose = await fixture('  - id: ask\n    choose: { message: Pick, options: [one, two], default: one }');
    await leaseNext(choose.config, choose.id, driver, { autoApprove: true });
    expect(warn).toHaveBeenLastCalledWith('Step "ask" chose "one" by auto_approve.');
    const required = await fixture('  - id: ask\n    approve: { message: Continue?, required: true }');
    await leaseNext(required.config, required.id, driver);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("needs a person's answer"));
    expect(warn).toHaveBeenCalledTimes(4);
  });
});


describe('run control recovery invariants', () => {
  it('does not queue or publish a provisional end when retry reconciles the last failure', async () => {
    const f = await fixture('  - id: work\n    command: exit 1');
    await f.report(data(await f.next()).lease, 'failed');
    expect((await f.state()).status).toBe('running');
    expect(data(await retryStep(f.config, f.id, await knownSecrets(f.config), 'work')).reopened).toBe(false);
    expect((await pendingRecords(f.config)).map((record) => record.phase)).toEqual(['start']);
    expect((await f.state()).endRecordQueued).toBeUndefined();
  });

  it('removes a queued end when retry reopens a settled run', async () => {
    const f = await fixture('  - id: work\n    command: exit 1');
    await f.report(data(await f.next()).lease, 'failed');
    await f.next();
    expect((await pendingRecords(f.config)).some((record) => record.phase === 'end')).toBe(true);
    await retryStep(f.config, f.id, await knownSecrets(f.config), 'work');
    expect((await pendingRecords(f.config)).map((record) => record.phase)).toEqual(['start']);
    expect((await f.state()).endRecordQueued).toBeUndefined();
  });

  it('releases an interactive lease handed back without a person, so it waits for a driver with one', async () => {
    const f = await fixture('  - id: pair\n    prompt: Pair with me.\n    interactive: true');
    const lease = data(await f.next()).lease;
    expect(data(await leaseNext(f.config, f.id, driver, { running: [lease.attempt] })).done).toBeUndefined();
    expect(await leaseNext(f.config, f.id, driver)).toMatchObject({ data: { wait: { held: [{ step: 'pair', missing: ['hitl'] }] } } });
    expect((await f.state()).steps[0]).toMatchObject({ status: 'pending' });
    expect((await f.state()).cancelledAttempts).toContain(lease.attempt);
    expect(await f.report(lease)).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(data(await f.next()).lease).toMatchObject({ step: 'pair', interactive: true });
  });

  it('adds what a handed-back lease can no longer enforce to what it recorded, and settles the step with both', async () => {
    const f = await fixture('  - id: fetch\n    command: echo fetch\n    requires: { network: false, isolation: sandbox }');
    const lease = data(await leaseNext(f.config, f.id, driver, { can: { isolation: 'sandbox' } })).lease;
    expect(lease).toMatchObject({ unenforced: [{ requirement: 'network', asked: false }] });
    const again = await leaseNext(f.config, f.id, driver, { can: { network: true } });
    const both = [{ requirement: 'network', asked: false }, { requirement: 'isolation', asked: 'sandbox', provided: 'none' }];
    expect(again).toMatchObject({ data: { lease: { attempt: lease.attempt, unenforced: both } } });
    expect(await f.report(lease)).toMatchObject({ data: { step: { id: 'fetch', unenforced: both } } });
    expect((await f.state()).steps[0]).toMatchObject({ status: 'succeeded', unenforced: both });
  });

  it('holds a step the member policy refuses, before what the driver lacks, whatever the driver declares', async () => {
    const f = await fixture('  - id: fetch\n    command: echo fetch\n    requires: { network: true }\n  - id: deploy\n    needs: []\n    command: echo deploy\n    requires: { env: [DEPLOY_TOKEN] }');
    f.config.workflows = { tools: {}, allow: { network: false, env: ['OTHER_TOKEN'] } };
    expect(await leaseNext(f.config, f.id, driver, { can: { network: true, env: true } })).toMatchObject({ data: { wait: { held: [
      { step: 'fetch', missing: ['policy.network'] }, { step: 'deploy', missing: ['policy.env'] },
    ] } } });
    expect(await leaseNext(f.config, f.id, driver)).toMatchObject({ data: { wait: { held: [
      { step: 'fetch', missing: ['policy.network'] }, { step: 'deploy', missing: ['policy.env'] },
    ] } } });
    f.config.workflows = { tools: {}, allow: { network: true, env: ['DEPLOY_TOKEN'] } };
    expect(await leaseNext(f.config, f.id, driver)).toMatchObject({ data: { lease: { step: 'fetch' } } });
  });

  it('says a step held by the member policy waits for workflows.allow, not for a driver', async () => {
    const f = await fixture('  - id: fetch\n    command: echo fetch\n    requires: { network: true }');
    f.config.workflows = { tools: {}, allow: { network: false } };
    const reason = 'step "fetch" needs network, which workflows.allow in local config does not allow on this machine';
    expect(await leaseNext(f.config, f.id, driver, { can: { network: true } })).toMatchObject({ data: { wait: { reason, held: [{ step: 'fetch', reason }] } } });
  });

  it('caps the open leases of any driver at workflows.max_parallel', async () => {
    const f = await fixture('  - id: one\n    command: echo one\n  - id: two\n    needs: []\n    command: echo two');
    f.config.workflows = { tools: {}, max_parallel: 1 };
    const one = data(await leaseNext(f.config, f.id, driver)).lease;
    expect(await leaseNext(f.config, f.id, driver, { running: [one.attempt] })).toMatchObject({ data: {
      wait: { reason: '1 steps are leased, as many as workflows.max_parallel allows on this machine' },
    } });
    await f.report(one);
    expect(data(await leaseNext(f.config, f.id, driver)).lease.step).toBe('two');
  });

  it('releases a lease handed back to a driver that no longer scopes env, so it waits for one that does', async () => {
    vi.stubEnv('DEPLOY_TOKEN', 'deploy-token-value');
    const f = await fixture('  - id: deploy\n    command: echo deploy\n    requires: { env: [DEPLOY_TOKEN] }');
    const lease = data(await leaseNext(f.config, f.id, driver, { can: { env: true } })).lease;
    expect(await leaseNext(f.config, f.id, driver)).toMatchObject({ data: { wait: { held: [{ step: 'deploy', missing: ['env'] }] } } });
    expect((await f.state()).steps[0]).toMatchObject({ status: 'pending' });
    expect(await f.report(lease)).toMatchObject({ error: { code: 'lease_cancelled' } });
    vi.unstubAllEnvs();
  });

  it('lists only the steps changed by cancellation before reconciliation', async () => {
    const f = await fixture('  - id: work\n    command: echo work\n  - id: dependent\n    needs: [work]\n    command: echo later\n  - id: recover\n    needs: [work]\n    if: steps.work.outcome == \'cancelled\'\n    end: recovered', 'ends: { recovered: succeeded }\n');
    await f.next();
    expect(data(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'work')).cancelled.steps).toEqual(['work']);
  });

  it('explains how to recover a run cancelled before any step ran', async () => {
    const f = await fixture('  - id: ask\n    approve: Continue?');
    await f.next();
    await cancelRun(f.config, f.id, await knownSecrets(f.config));
    expect(await retryStep(f.config, f.id, await knownSecrets(f.config), 'ask')).toMatchObject({ error: { code: 'not_retryable', message: expect.stringContaining('start a new run') } });
  });

  it('stores only the identity of the latest driver and keeps it on control end records', async () => {
    const f = await fixture('  - id: work\n    command: echo work\n  - id: ask\n    needs: [work]\n    approve: Continue?');
    const lease = data(await f.next()).lease;
    const stored: unknown = JSON.parse(fs.readFileSync(runFilePath(f.config, f.id), 'utf8'));
    expect(stored).toHaveProperty('driver', driver);
    expect(stored).toHaveProperty('steps.0.lease.driver', driver);
    await f.report(lease);
    await f.respond('ask', 'yes');
    expect((await pendingRecords(f.config)).find((record) => record.phase === 'end')?.driver).toEqual({ kind: 'test' });
  });
});


it.each(['whole run', 'inline workflow'])('retry after cancelling a %s runs its skipped sibling', async (kind) => {
  const f = await fixture(kind === 'whole run' ? `  - id: setup
    command: echo work
  - id: a
    needs: [setup]
    command: echo work
  - id: b
    needs: [setup]
    command: echo work` : `  - id: ship
    workflow:
      steps:
        - id: a
          command: echo work
        - id: b
          needs: []
          command: echo work`);
  if (kind === 'whole run') await f.report(data(await f.next()).lease);
  const a = data(await f.next()).lease;
  await cancelRun(f.config, f.id, await knownSecrets(f.config), kind === 'whole run' ? undefined : 'ship');
  await retryStep(f.config, f.id, await knownSecrets(f.config), a.step);
  await f.report(data(await f.next()).lease);
  const b = data(await f.next()).lease;
  expect(b?.step).toBe(kind === 'whole run' ? 'b' : 'ship.b');
  await f.report(b);
  expect(data(await f.next()).done.outcome).toBe('succeeded');
});


it('stores the latest driver that called next before any lease exists', async () => {
  const f = await fixture('  - id: decide\n    choose: { message: Pick, options: [build, stop] }');
  await f.next();
  expect((await f.state()).driver).toEqual(driver);
  const latest = { kind: 'local', machine: os.hostname(), workspace: '/latest' };
  await leaseNext(f.config, f.id, latest, { can: { hitl: true }, canTakeLease: false });
  expect((await f.state()).driver).toEqual(latest);
  await f.respond('decide', 'stop');
  expect((await pendingRecords(f.config)).find((record) => record.phase === 'end')?.driver).toEqual({ kind: 'local' });
});


describe('retry and cancel state matrix', () => {
  const states = [
    { name: 'pending with an answer', status: 'pending', prepare: 'answer' },
    { name: 'waiting', status: 'waiting', prepare: 'wait' },
    { name: 'leased', status: 'leased', prepare: 'lease' },
    { name: 'running workflow', status: 'running', prepare: 'run' },
    { name: 'failed', status: 'failed', prepare: 'fail' },
    { name: 'cancelled', status: 'cancelled', prepare: 'cancel' },
    { name: 'refused approve', status: 'skipped', prepare: 'refuse' },
    { name: 'answered choose', status: 'succeeded', prepare: 'choose' },
  ] as const;
  const operations = ['retry ancestor', 'retry step', 'cancel step', 'cancel run'] as const;

  it.each(states.flatMap((state) => operations.map((operation) => ({ ...state, operation }))))(
    '$operation with a $name step', async ({ status, prepare, operation }) => {
      const question = prepare === 'choose'
        ? 'choose: { message: "Deploy the {{ steps.plan.choice }} plan?", options: [yes, no] }'
        : 'approve: { message: "Deploy the {{ steps.plan.choice }} plan?", required: true }';
      const action = prepare === 'choose' ? '' : prepare === 'run'
        ? '\n    workflow:\n      steps:\n        - id: work\n          command: echo work'
        : '\n    command: echo deploy';
      const f = await fixture(`  - id: plan
    choose: { message: Which plan?, options: [small, big] }
  - id: deploy
    needs: [plan]
    ${question}${action}
  - id: unrelated
    needs: []
    approve: Keep the run open?`);
      data(await f.respond('plan', 'small'));
      if (prepare !== 'wait') data(await f.respond('deploy', prepare === 'refuse' ? 'no' : 'yes'));
      let lease: ControlData['lease'] | undefined;
      if (prepare === 'lease' || prepare === 'run' || prepare === 'fail') {
        lease = data(await f.next()).lease;
        expect(lease.step).toBe(prepare === 'run' ? 'deploy.work' : 'deploy');
        if (prepare === 'fail') data(await f.report(lease, 'failed'));
      }
      if (prepare === 'cancel') data(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'deploy'));
      const before = await f.state();
      const subject = before.steps.find((step) => step.id === 'deploy')!;
      expect(subject.status).toBe(status);
      expect(subject.answer?.choice).toBe(prepare === 'wait' ? undefined : prepare === 'refuse' ? 'no' : 'yes');

      if (operation === 'retry ancestor' || operation === 'retry step') {
        const target = operation === 'retry ancestor' ? 'plan' : 'deploy';
        if (target === 'deploy' && (status === 'pending' || status === 'waiting' || status === 'running')) {
          expect(await retryStep(f.config, f.id, await knownSecrets(f.config), target)).toMatchObject({ error: { code: 'not_retryable' } });
          expect(await f.state()).toEqual(before);
          return;
        }
        data(await retryStep(f.config, f.id, await knownSecrets(f.config), target));
        const after = await f.state();
        for (const id of target === 'plan' ? ['plan', 'deploy'] : ['deploy']) {
          const previous = before.steps.find((step) => step.id === id)!;
          const current = after.steps.find((step) => step.id === id)!;
          expect(current.answer).toBeUndefined();
          expect(current.pass).toBeGreaterThan(previous.pass ?? 1);
          expect(await f.respond(id, id === 'plan' ? 'big' : 'yes', { pass: previous.pass ?? 1 }))
            .toMatchObject({ error: {
              code: 'stale_response',
              message: `The HITL request of pass ${previous.pass ?? 1} was answered or replaced; step ${id} ${current.status === 'waiting' ? `now waits at pass ${current.pass}` : `is now at pass ${current.pass} (status: ${current.status})`}`,
            } });
        }
        expect(after.steps.find((step) => step.id === 'unrelated')).toEqual(before.steps.find((step) => step.id === 'unrelated'));
        if (target === 'plan') data(await f.respond('plan', 'big', { pass: 2 }));
        expect(data(await f.next()).hitl).toMatchObject({ step: 'deploy', pass: 2, message: `Deploy the ${target === 'plan' ? 'big' : 'small'} plan?` });
      } else {
        const cancellable = status === 'pending' || status === 'waiting' || status === 'leased' || status === 'running';
        if (operation === 'cancel step' && !cancellable) {
          expect(await cancelRun(f.config, f.id, await knownSecrets(f.config), 'deploy')).toMatchObject({ error: { code: 'not_cancellable' } });
          expect(await f.state()).toEqual(before);
          return;
        }
        data(await cancelRun(f.config, f.id, await knownSecrets(f.config), operation === 'cancel step' ? 'deploy' : undefined));
        const after = await f.state();
        const expected = operation === 'cancel run' && (status === 'pending' || status === 'waiting')
          ? 'skipped' : cancellable ? 'cancelled' : status;
        expect(after.steps.find((step) => step.id === 'deploy')?.status).toBe(expected);
        expect(after.status).toBe(operation === 'cancel run' ? 'cancelled' : 'running');
        if (status === 'running') expect(after.steps.find((step) => step.id === 'deploy.work')?.status).toBe('cancelled');
      }
      if (lease && prepare !== 'fail') expect(await f.report(lease)).toMatchObject({ error: { code: 'lease_cancelled' } });
    },
  );
});

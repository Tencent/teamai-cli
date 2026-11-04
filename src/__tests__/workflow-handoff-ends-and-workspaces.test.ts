import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import { updateReports } from '../utils/reports-branch.js';
import * as workflowCache from '../workflow/cache.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { claimRun, publishRun, resumeRun } from '../workflow/handoff.js';
import { pendingRecords, publishPendingRecords } from '../workflow/records.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import { readRun, runLockPath } from '../workflow/store.js';
import type { DriverIdentity } from '../workflow/types.js';
import { markReadCopy, worktreePath } from '../workflow/worktree.js';
import { knownSecrets } from '../env-resolution.js';
import { BUILD, cacheFiles, COPY, creates, deleteRunBranches, DELIVERED_STACK, deliveringStack, dirs, editRun, git, hasCommit, holdBasePin, Member, openPull, originFile, originRef, PACKAGE_VERSION, PAIR, pull, pushCommitTo, receiveHook, runStep, settle, SHIP, STACK, start, startIn, team, work, WORKSPACES } from './helpers/workflow-handoff-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow handoff through teamai-reports', () => {
  it.each([['records on', true], ['records off', false]])('lets a member claim a run its owner published and then finished, and runs nothing (%s)', async (_label, usageReportEnabled) => {
    const acme = team();
    const alice = await acme.member('alice');
    alice.config.usageReportEnabled = usageReportEnabled;
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { stateRevision: 1 } });
    expect(await runStep(alice, runId)).toBe('two');
    await settle(alice, runId);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });

    const claimed = await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(claimed).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 3 } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 3 });
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'not_owner' } });
  });

  it('lets a member claim a run its owner published and then cancelled, and retry it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({ data: { lease: { step: 'one' } } });
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(await cancelRun(alice.config, runId, await knownSecrets(alice.config))).not.toHaveProperty('data.notPublished');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'cancelled', stateRevision: 2 });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { outcome: 'cancelled' } } });

    expect(await retryStep(bob.config, runId, await knownSecrets(bob.config), 'one')).toMatchObject({ data: { reopened: true } });
    expect(await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'already_owned' } });
    expect(await runStep(bob, runId)).toBe('one');
  });

  it('refuses a member who resumes a run that was taken back from it and finished, until it claims the run as it ended', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    await runStep(alice, runId);
    await runStep(alice, runId);
    await settle(alice, runId);

    expect(await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'not_owner' } });
    expect(await resumeRun(bob.config, runId, { claim: true, checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
  });

  it('lets a member claim a run that ended failed, from how it ended, and retry only the step that failed', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const next = await leaseNext(alice.config, runId, alice.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const lease = next.data.lease as { step: string; attempt: string; revision: number };
    await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: alice.driver, message: 'two broke' });
    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'failed', stateRevision: 2 });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 3 } });
    expect(await retryStep(bob.config, runId, await knownSecrets(bob.config), 'two')).toMatchObject({ data: { reopened: true } });
    expect(await runStep(bob, runId)).toBe('two');
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 4 });
  });

  it('leaves the claim on teamai-reports alone when the earlier owner ends the run, and tells that member who claimed it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const claimed = await claimRun(bob.config, runId, { checkout: bob.checkout });
    if (!claimed.ok) throw new Error(claimed.error.message);
    const claim = originFile(acme.origin, `workflows/runs/${runId}/state.json`);
    expect(await runStep(alice, runId)).toBe('two');

    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({
      data: {
        done: {
          outcome: 'succeeded',
          notPublished: { code: 'not_owner', owner: claimed.value.owner, message: expect.stringContaining(`is owned by ${claimed.value.owner.user}`) },
        },
      },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBe(claim);
  });

  it('keeps the run record of the member who took a run when the member it was taken from ends it, and tells that member', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await runStep(bob, runId)).toBe('two');
    await settle(bob, runId);
    const record = originFile(acme.origin, `workflows/runs/${runId}.json`);
    expect(JSON.parse(record ?? '{}')).toMatchObject({ username: 'bob', status: 'succeeded' });
    expect(await runStep(alice, runId)).toBe('two');

    const ended = await leaseNext(alice.config, runId, alice.driver);
    expect(ended).toMatchObject({
      data: { done: { outcome: 'succeeded', notPublished: { code: 'not_owner', message: expect.stringContaining('its run record') } } },
    });
    expect(ended).not.toHaveProperty('data.done.record');
    expect(await publishPendingRecords(alice.config)).toEqual({ state: 'published' });
    expect(originFile(acme.origin, `workflows/runs/${runId}.json`)).toBe(record);
  });

  it('tells the owner to publish again when the end of a run it published did not reach teamai-reports', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await runStep(alice, runId);
    receiveHook(acme.origin, 'exit 1');

    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({
      data: { done: { outcome: 'succeeded', notPublished: { code: 'records_pending', message: expect.stringContaining(`teamai workflow publish ${runId}`) } } },
    });
    receiveHook(acme.origin, 'exit 0');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { stateRevision: 2 } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });
  });

  it('warns once that the branches of a run were not cleaned up when its end did not reach teamai-reports', async () => {
    const acme = team({ copy: COPY });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'copy');
    await work(alice, runId, 'change.txt');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    receiveHook(acme.origin, 'exit 1');
    const warn = vi.spyOn(log, 'warn');

    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({ data: { done: { outcome: 'succeeded', notPublished: { code: 'records_pending' } } } });
    expect(warn.mock.calls.filter(([message]) => String(message).includes('were not cleaned up'))).toEqual([
      [`The branches of run ${runId} were not cleaned up: its end did not reach teamai-reports. teamai doctor --fix tries again.`],
    ]);
  });

  it('publishes how a run ended on the next request when the end was saved but not published', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await runStep(alice, runId);
    const lock = path.join(path.dirname(alice.config.repo.localPath), '.reports-lock');
    expect(await acquireLock(lock)).toBe(true);
    try {
      await settle(alice, runId);
    } finally {
      await releaseLock(lock);
    }
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'running', stateRevision: 1 });

    const again = await leaseNext(alice.config, runId, alice.driver);
    expect(again).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(again).not.toHaveProperty('data.done.notPublished');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });
  });

  /** A `copy` run its owner published, then ran to its end, which is published too; its copy branch is on the business origin. */
  async function finishedCopyRun(): Promise<{ acme: ReturnType<typeof team>; alice: Member; runId: string; branch: string }> {
    const acme = team({ copy: COPY });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'copy');
    const { branch } = await work(alice, runId, 'change.txt');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { stateRevision: 1 } });
    await settle(alice, runId);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });
    return { acme, alice, runId, branch };
  }

  it('answers done for a finished run without a notPublished, and without pushing its base pin again, when its branches are gone from the business origin', async () => {
    const { acme, alice, runId } = await finishedCopyRun();
    deleteRunBranches(acme.business, runId);

    const again = await leaseNext(alice.config, runId, alice.driver);
    expect(again).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(again).not.toHaveProperty('data.done.notPublished');
    expect(originRef(acme.business, `refs/heads/teamai/${runId}/base`)).toBeUndefined();
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });
  });

  it('answers done for a finished run without a notPublished when its copy branch gained a commit on the business origin', async () => {
    const { acme, alice, runId, branch } = await finishedCopyRun();
    pushCommitTo(acme.business, branch);

    const again = await leaseNext(alice.config, runId, alice.driver);
    expect(again).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(again).not.toHaveProperty('data.done.notPublished');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });
  });

  it.each([
    { status: 'running', end: async () => {} },
    { status: 'succeeded', end: async (alice: Member, runId: string) => {
      await work(alice, runId, 'more.txt');
      await work(alice, runId, 'last.txt');
      await settle(alice, runId);
    } },
    { status: 'failed', end: async (alice: Member, runId: string) => {
      const next = await leaseNext(alice.config, runId, alice.driver, { can: { workspace: [...WORKSPACES] } });
      if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
      const lease = next.data.lease as { attempt: string; revision: number };
      await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: alice.driver, message: 'broke' });
      await settle(alice, runId);
    } },
    { status: 'cancelled', end: async (alice: Member, runId: string) => {
      await cancelRun(alice.config, runId, await knownSecrets(alice.config));
    } },
  ])('needs the branches of a $status run on the business origin to claim it only while it runs', async ({ status, end }) => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await end(alice, runId);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status });
    deleteRunBranches(acme.business, runId);

    const resumed = await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout });
    if (status === 'running') {
      expect(resumed).toMatchObject({ ok: false, error: { code: 'commit_missing' } });
      expect(await readRun(bob.config, runId)).toBe('missing');
      return;
    }
    expect(resumed).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await runLocalDriver(bob.config, runId, bob.checkout, { hitl: false })).toMatchObject({ data: { done: { outcome: status } } });
  });

  it('does not touch the business origin when a cancel finds the run already ended', async () => {
    const { acme, alice, runId } = await finishedCopyRun();
    deleteRunBranches(acme.business, runId);

    expect(await cancelRun(alice.config, runId, await knownSecrets(alice.config))).toMatchObject({ error: { code: 'run_settled' } });
    expect(originRef(acme.business, `refs/heads/teamai/${runId}/base`)).toBeUndefined();
  });

  it('answers a next after a cancel with the end record published, though the cancel was still publishing it when the run ended', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const lock = path.join(path.dirname(alice.config.repo.localPath), '.reports-lock');
    expect(await acquireLock(lock)).toBe(true);
    try {
      expect(await cancelRun(alice.config, runId, await knownSecrets(alice.config))).toMatchObject({ data: { run: { status: 'cancelled' } } });
    } finally {
      await releaseLock(lock);
    }
    expect((await pendingRecords(alice.config)).map((record) => record.run)).toContain(runId);

    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({ data: { done: { run: runId, outcome: 'cancelled', record: 'published' } } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}.json`) ?? '{}')).toMatchObject({ phase: 'end' });
  });

  it('publishes the end a cancel settles, though the cancel answers with an error', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { stateRevision: 1 } });
    const next = await leaseNext(alice.config, runId, alice.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const lease = next.data.lease as { attempt: string; revision: number };
    expect(await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'failed', driver: alice.driver }))
      .toMatchObject({ data: { accepted: true } });

    expect(await cancelRun(alice.config, runId, await knownSecrets(alice.config), 'two')).toMatchObject({ error: { code: 'run_settled' } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'failed', stateRevision: 2 });
  });

  it('keeps the state last published when a run ends with a commit the business origin does not have, and says to push it', async () => {
    const acme = team({ copy: COPY });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'copy');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { stateRevision: 1 } });
    const published = originFile(acme.origin, `workflows/runs/${runId}/state.json`);
    const { branch, commit } = await work(alice, runId, 'change.txt', alice.driver, { push: false });

    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({
      data: { done: { outcome: 'succeeded', notPublished: { code: 'commit_missing', branch, commit } } },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBe(published);
  });

  it('installs a claim that origin took even when this machine could not install it the first time', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const lock = runLockPath(bob.config, runId);
    expect(await acquireLock(lock)).toBe(true);
    try {
      expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'busy' } });
    } finally {
      await releaseLock(lock);
    }

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 2 } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ stateRevision: 2 });
  });

  it('carries the settled-attempt count of a run file that has only the attempt list', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await editRun(alice.config, runId, ({ settledCount: _count, ...run }) => run);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });

    const claimed = await readRun(bob.config, runId);
    expect(typeof claimed === 'object' && claimed.settledCount).toBe(1);
  });

  it('lets a driver claim a published run through next', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const first = await leaseNext(bob.config, runId, bob.driver, { claim: true });
    expect(first).toMatchObject({ data: { lease: { step: 'two' } } });
    // Claiming again keeps the lease, which next hands back to the driver that did not list it as running.
    const again = await leaseNext(bob.config, runId, bob.driver, { claim: true });
    expect(again).toMatchObject({ data: { lease: { step: 'two', attempt: 'data' in first ? (first.data.lease as { attempt: string }).attempt : '' } } });
    const published = JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}');
    expect(published).toMatchObject({ stateRevision: 2 });
  });

  it('answers next with the claim refusal when the run is not published', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);

    expect(await leaseNext(bob.config, runId, bob.driver, { claim: true })).toMatchObject({ error: { code: 'run_not_published' } });
  });

  it('hands over a run with a workspace: publish pins its base on the business origin, and the claim continues the copy', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published' } });
    expect(originRef(acme.business, `refs/heads/teamai/${runId}/base`)).toBe(git(alice.checkout, 'rev-parse', 'main'));
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(hasCommit(bob.checkout, wrote.commit)).toBe(false);

    const more = await work(bob, runId, 'more.txt');
    expect(more).toMatchObject({ step: 'change.more', branch: wrote.branch });
    expect(git(bob.checkout, 'rev-parse', `${more.commit}^`)).toBe(wrote.commit);
  });

  it('hands over a copy that started from the branch of a step it needs, with the branch it started from', async () => {
    const acme = team({ stack: STACK });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'stack');
    const a = await work(alice, runId, 'a.txt');
    const b = await work(alice, runId, 'b.txt');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published' } });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const claimed = await readRun(bob.config, runId);
    expect(typeof claimed !== 'string' && claimed.copies?.[b.branch]).toEqual({ commit: b.commit, from: a.branch });
  });

  it('publishes a step that delivers with what it delivers, and the claim finds the pull request the first machine opened and opens no other', async () => {
    const acme = team({ stack: DELIVERED_STACK });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const { gh, runId, a, b } = await deliveringStack(acme, alice, bob);
    // Alice's process opened b's request too, then stopped before the run heard of it.
    gh.configure({ open: [openPull(1, a.branch), openPull(2, b.branch, a.branch)] });

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published' } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? 'null')).toMatchObject({
      copies: { [b.branch]: { commit: b.commit, from: a.branch } },
      deliveries: [{ url: 'https://github.com/acme/app/pull/1', branch: a.branch, base: 'main', step: 'a', pass: 1 }],
      steps: [{ id: 'a', status: 'succeeded' }, { id: 'b', status: 'delivering', delivery: { branch: b.branch, head: b.commit } }],
    });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });

    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(bob.config, runId);
    expect(typeof run !== 'string' && run.steps[1]).toMatchObject({ id: 'b', status: 'succeeded' });
    expect(typeof run !== 'string' && run.deliveries?.[1]).toEqual({ url: 'https://github.com/acme/app/pull/2', branch: b.branch, base: a.branch, step: 'b', pass: 1 });
    expect(creates(gh)).toEqual([[a.branch, 'main']]);
  });

  it('opens the pull request of a step that was delivering when the run was claimed, once, on the machine that claimed it', async () => {
    const acme = team({ stack: DELIVERED_STACK });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const { gh, runId, a, b } = await deliveringStack(acme, alice, bob);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(creates(gh)).toEqual([[a.branch, 'main']]);

    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[a.branch, 'main'], [b.branch, a.branch]]);
    const run = await readRun(bob.config, runId);
    expect(typeof run !== 'string' && run.deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/acme/app/pull/1', 'https://github.com/acme/app/pull/2']);
  });

  it.each<[string, (snapshot: { deliveries: Array<{ url: string }>; steps: Array<{ delivery?: { reported?: string } }> }) => void, string]>([
    ['a receipt', (snapshot) => { snapshot.deliveries = snapshot.deliveries.map((receipt) => ({ ...receipt, url: 'https://user:token@github.com/acme/app/pull/1' })); }, 'deliveries[0].url'],
    ['a reported URL', (snapshot) => { const step = snapshot.steps[1]; if (step?.delivery) step.delivery.reported = 'http://github.com/acme/app/pull/2'; }, 'steps[1].delivery.reported'],
  ])('refuses to claim a snapshot whose pull request URL in %s is not one TeamAI keeps, naming the field', async (_name, edit, field) => {
    const acme = team({ stack: DELIVERED_STACK });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const { runId } = await deliveringStack(acme, alice, bob);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const editor = path.join(path.dirname(acme.origin), 'editor');
    git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
    const rel = `workflows/runs/${runId}/state.json`;
    const snapshot = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
    edit(snapshot);
    fs.writeFileSync(path.join(editor, rel), `${JSON.stringify(snapshot, null, 2)}\n`);
    git(editor, 'commit', '-qam', 'hand edit');
    git(editor, 'push', '-q', 'origin', 'teamai-reports');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'snapshot_unsupported', field } });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses to publish, telling to publish again, when the run moves while publish checks the business origin', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'ship');
    const pin = holdBasePin(acme.business);

    const publishing = publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await pin.held();
    await work(alice, runId, 'write.txt');
    pin.release();

    expect(await publishing).toMatchObject({
      ok: false,
      error: { code: 'state_moved', message: expect.stringMatching(`changed while it was being published.*Publish it again: teamai workflow publish ${runId}`) },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', stateRevision: 1 } });
  });

  it('publishes the run as it is when publish decides, when only what publish did not check moved while it checked', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'ship');
    const pin = holdBasePin(acme.business);

    const publishing = publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await pin.held();
    expect(await leaseNext(alice.config, runId, alice.driver, { can: { workspace: [...WORKSPACES] } })).toMatchObject({ data: { lease: { step: 'change.write' } } });
    pin.release();

    expect(await publishing).toMatchObject({ ok: true, value: { publication: 'published', stateRevision: 1, inFlight: [{ step: 'change.write' }] } });
  });

  it('pins the base on the origin of the checkout the run started in when published from another repository', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'ship');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.config.repo.localPath })).toMatchObject({ ok: true, value: { publication: 'published' } });
    expect(originRef(acme.business, `refs/heads/teamai/${runId}/base`)).toBe(git(alice.checkout, 'rev-parse', 'main'));
    expect(originRef(acme.origin, `refs/heads/teamai/${runId}/base`)).toBeUndefined();
  });

  it('refuses to claim a workspace whose branch on origin moved past the recorded commit, and changes nothing', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    // A driver pushed more work to the copy and stopped before it reported it.
    const dir = worktreePath(alice.checkout, wrote.branch);
    fs.writeFileSync(path.join(dir, 'late.txt'), 'late\n');
    git(dir, 'add', 'late.txt');
    git(dir, 'commit', '-qm', 'late');
    git(dir, 'push', '-q', 'origin', wrote.branch);
    const late = git(dir, 'rev-parse', 'HEAD');

    const owner = (JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}') as { owner: { user: string } }).owner.user;
    const refused = await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(refused).toMatchObject({ ok: false, error: { code: 'branch_diverged', branch: wrote.branch, expected: wrote.commit, actual: late } });
    expect(refused.ok ? '' : refused.error.message).toMatch(new RegExp(
      `${owner} can publish it again: teamai workflow publish ${runId}\\..*back to ${wrote.commit} discards the commits on it past ${wrote.commit}`,
    ));
    expect(originRef(acme.business, `refs/heads/${wrote.branch}`)).toBe(late);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ stateRevision: 1 });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses to publish a workspace whose last push did not land, telling to push it from this checkout', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    const dir = worktreePath(alice.checkout, wrote.branch);
    fs.writeFileSync(path.join(dir, 'unpushed.txt'), 'unpushed\n');
    git(dir, 'add', 'unpushed.txt');
    git(dir, 'commit', '-qm', 'unpushed');
    const unpushed = git(dir, 'rev-parse', 'HEAD');
    await editRun(alice.config, runId, (run) => ({ ...run, copies: { ...run.copies, [wrote.branch]: { ...run.copies?.[wrote.branch], commit: unpushed } } }));

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({
      ok: false,
      error: {
        code: 'commit_missing',
        branch: wrote.branch,
        commit: unpushed,
        message: expect.stringContaining(`git -C ${alice.checkout} push origin ${unpushed}:refs/heads/${wrote.branch}`),
      },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
    git(alice.checkout, 'push', '-q', 'origin', `${unpushed}:refs/heads/${wrote.branch}`);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published' } });
  });

  it('refuses to publish a workspace whose recorded commit is not on origin', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    git(alice.checkout, 'push', '-q', 'origin', '--delete', wrote.branch);

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({
      ok: false,
      error: { code: 'commit_missing', branch: wrote.branch, commit: wrote.commit },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('moves a lease that opened its own copy to a new pass and branch on claim, and only releases one that continues a copy', async () => {
    const acme = team({ pair: PAIR });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'pair');
    const base = git(alice.checkout, 'rev-parse', 'main');
    const first = await leaseNext(alice.config, runId, alice.driver, { can: { workspace: [...WORKSPACES] } });
    const built = 'data' in first ? (first.data.lease as { attempt: string; workspace: { branch: string } }) : undefined;
    expect(built?.workspace.branch).toBe(`teamai/${runId}/build/p1`);
    expect(await leaseNext(alice.config, runId, alice.driver, { can: { workspace: [...WORKSPACES] }, running: [built?.attempt ?? ''] }))
      .toMatchObject({ data: { lease: { step: 'change.write', workspace: { branch: `teamai/${runId}/change/p1` } } } });

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({
      ok: true,
      value: { inFlight: [{ step: 'build', driverKind: 'local' }, { step: 'change.write', driverKind: 'local' }] },
    });
    await claimRun(bob.config, runId, { checkout: bob.checkout });

    const claimed = await readRun(bob.config, runId);
    expect(claimed).toMatchObject({
      steps: [{ id: 'build', status: 'pending', pass: 2 }, { id: 'change', status: 'running' }, { id: 'change.write', status: 'pending' }],
      copies: { [`teamai/${runId}/change/p1`]: {} },
    });
    expect(claimed).not.toHaveProperty('pushedBranches');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).not.toHaveProperty('pushedBranches');
    expect(typeof claimed === 'object' && Object.keys(claimed.copies ?? {})).toEqual([`teamai/${runId}/change/p1`]);
    const again = await leaseNext(bob.config, runId, bob.driver, { can: { workspace: [...WORKSPACES] } });
    expect(again).toMatchObject({ data: { lease: { step: 'build', pass: 2, workspace: { branch: `teamai/${runId}/build/p2`, start: { commit: base } } } } });
  });

  it('gives a claimed copy to the first driver that leases it, and holds it from another driver after that', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });
    const runner: DriverIdentity = { kind: 'runner', machine: 'ci', workspace: bob.checkout };
    // The runner takes the copy's next step and hands it back unrun: the copy stays the runner's.
    const taken = await leaseNext(bob.config, runId, runner, { can: { workspace: [...WORKSPACES] } });
    expect(taken).toMatchObject({ data: { lease: { step: 'change.more' } } });
    const lease = 'data' in taken ? (taken.data.lease as { attempt: string; revision: number }) : { attempt: '', revision: 0 };
    expect(await reportAttempt(bob.config, runId, { ...lease, outcome: 'released', driver: runner })).toMatchObject({ data: { accepted: true } });

    expect(await leaseNext(bob.config, runId, bob.driver, { can: { workspace: [...WORKSPACES] } })).toMatchObject({ data: { wait: {} } });
    expect(await work(bob, runId, 'more.txt', runner)).toMatchObject({ step: 'change.more' });
  });

  const REVIEW = `schemaVersion: v1alpha1
name: review
description: Builds, then has the change checked.
steps:
  - id: build
    command: echo build
  - id: check
    needs: [build]
    workflow: check
`;

  const CHECK = `schemaVersion: v1alpha1
name: check
description: Reads the change.
steps:
  - id: read
    prompt_file: prompts/read.md
`;

  it('claims a run whose workflows the team changed since, as the team commit it ran at holds them, and leaves its own cache as it is', async () => {
    const acme = team({ review: REVIEW, check: CHECK }, { 'prompts/read.md': 'Read the change.\n' });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const started = await startRun(alice.config, 'review', {}, { secrets: await knownSecrets(alice.config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    expect(await runStep(alice, runId)).toBe('build');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    acme.change({
      'workflows/check.yaml': CHECK.replace('prompts/read.md', 'prompts/look.md'),
      'prompts/look.md': 'Look at the change.\n',
      'prompts/read.md': null,
    });
    await pull(bob);
    const cache = cacheFiles(bob);
    const head = git(bob.config.repo.localPath, 'rev-parse', 'HEAD');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const ran = await readRun(alice.config, runId);
    const claimed = await readRun(bob.config, runId);
    if (typeof ran !== 'object' || typeof claimed !== 'object') throw new Error('runs were not stored');
    expect({ definition: claimed.definition, workflows: claimed.workflows }).toEqual({ definition: ran.definition, workflows: ran.workflows });
    expect(JSON.stringify(claimed.workflows)).toContain('Read the change.');
    expect(cacheFiles(bob)).toEqual(cache);
    expect(git(bob.config.repo.localPath, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(bob.config.repo.localPath, 'status', '--porcelain')).toBe('');
  });

  it('fetches the team commit a run ran at when this machine has not fetched it yet', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const changed = acme.change({ 'workflows/build.yaml': BUILD.replace('echo two', 'echo second') });
    await pull(alice);
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(hasCommit(bob.config.repo.localPath, changed)).toBe(false);

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { lease: { step: 'two', command: 'echo second' } } });
  });

  it('lets another teamai-reports writer on the machine through while a claim rebuilds the workflows the run ran', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    acme.change({ 'workflows/build.yaml': BUILD.replace('echo two', 'echo second') });
    await pull(alice);
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const rebuild = workflowCache.loadWorkflowBundleAt;
    const during: string[] = [];
    vi.spyOn(workflowCache, 'loadWorkflowBundleAt').mockImplementationOnce(async (...args) => {
      const other = await updateReports(bob.config, async (worktree) => {
        fs.writeFileSync(path.join(worktree, 'unrelated.txt'), 'another writer\n');
        return { files: ['unrelated.txt'], message: 'unrelated' };
      });
      during.push(other.status);
      return rebuild(...args);
    });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 2 } });
    expect(during).toEqual(['published']);
    expect(originFile(acme.origin, 'unrelated.txt')).toBe('another writer\n');
  });

  it('refuses a claim, telling to claim again, when the run changed on teamai-reports while the claim prepared it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    acme.change({ 'workflows/build.yaml': BUILD.replace('echo two', 'echo second') });
    await pull(alice);
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const rebuild = workflowCache.loadWorkflowBundleAt;
    vi.spyOn(workflowCache, 'loadWorkflowBundleAt').mockImplementationOnce(async (...args) => {
      await runStep(alice, runId);
      await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
      return rebuild(...args);
    });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({
      ok: false,
      error: { code: 'state_moved', message: expect.stringContaining(`teamai workflow resume ${runId} --claim`) },
    });
    expect(await readRun(bob.config, runId)).toBe('missing');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ stateRevision: 2 });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 3 } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { lease: { step: 'two', command: 'echo second' } } });
  });

  it('refuses a claim, naming the team commit, when origin no longer has the commit the run ran at', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const before = git(bob.config.repo.localPath, 'rev-parse', 'HEAD');
    const changed = acme.change({ 'workflows/build.yaml': BUILD.replace('echo two', 'echo second') });
    await pull(alice);
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    // Someone force-pushed the team branch back past the commit the run ran at.
    git(path.dirname(acme.origin), '--git-dir', acme.origin, 'update-ref', 'refs/heads/main', before);

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({
      ok: false,
      error: { code: 'definition_mismatch', teamRevision: changed, message: expect.stringMatching(new RegExp(`${changed}.*even after fetching`)) },
    });
    expect(await readRun(bob.config, runId)).toBe('missing');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ stateRevision: 1 });
  });

  it('refuses a claim, telling to pull, when no team commit holds the workflows the run ran and this machine has others', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    fs.writeFileSync(path.join(alice.config.repo.localPath, 'workflows', 'build.yaml'), BUILD.replace('echo two', 'echo edited'));
    await syncScorersThenWorkflows(alice.config);
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const refused = await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(refused).toMatchObject({ ok: false, error: { code: 'definition_mismatch', message: expect.stringMatching(/without a team commit.*teamai pull/) } });
    expect(refused.ok ? undefined : refused.error).not.toHaveProperty('teamRevision');
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses a claim when this teamai reads the workflow sources the run ran differently', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const editor = path.join(path.dirname(acme.origin), 'editor');
    git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
    const rel = `workflows/runs/${runId}/state.json`;
    const snapshot: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
    fs.writeFileSync(path.join(editor, rel), `${JSON.stringify({ ...snapshot, definitionHash: '0'.repeat(64) }, null, 2)}\n`);
    git(editor, 'commit', '-qam', 'another teamai');
    git(editor, 'push', '-q', 'origin', 'teamai-reports');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({
      ok: false,
      error: { code: 'definition_mismatch', teamRevision: snapshot.teamRevision, message: expect.stringContaining('same teamai version') },
    });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('claims a run of teamai\'s default from a machine on the same teamai, and refuses one another version ran, naming both versions', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const inputs = { session: 's1', source: 'claude', publish: false, scorers: [], demand: 'named' };
    const startClose = async (): Promise<string> => {
      const started = await startRun(alice.config, 'teamai-share-session', inputs, { secrets: await knownSecrets(alice.config) });
      if ('error' in started) throw new Error(started.error.message);
      const runId = String(started.data.run);
      await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
      return runId;
    };
    const same = await startClose();
    expect(await claimRun(bob.config, same, { checkout: bob.checkout })).toMatchObject({ ok: true });

    const older = await startClose();
    const editor = path.join(path.dirname(acme.origin), 'editor');
    git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
    const rel = `workflows/runs/${older}/state.json`;
    const snapshot: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
    fs.writeFileSync(path.join(editor, rel), `${JSON.stringify({ ...snapshot, sourceHash: '0'.repeat(64), origin: { source: 'default', teamaiVersion: '0.0.1' } }, null, 2)}\n`);
    git(editor, 'commit', '-qam', 'an older teamai');
    git(editor, 'push', '-q', 'origin', 'teamai-reports');

    expect(await claimRun(bob.config, older, { checkout: bob.checkout })).toMatchObject({
      ok: false,
      error: { code: 'definition_mismatch', message: `Run ${older} runs teamai's default workflow "teamai-share-session" of teamai 0.0.1, which differs from the one teamai ${PACKAGE_VERSION} ships. Continue it on a machine with teamai 0.0.1, or start a new run.` },
    });
    expect(await readRun(bob.config, older)).toBe('missing');
  });

  it('claims a run of a team that keeps its workflows in the business repository, as the commit it ran at holds them', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-handoff-self-')));
    dirs.push(root);
    const seed = path.join(root, 'seed');
    const origin = path.join(root, 'product.git');
    fs.mkdirSync(path.join(seed, '.teamai', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.teamai', 'workflows', 'build.yaml'), BUILD);
    git(root, 'init', '-q', '-b', 'main', seed);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'product');
    git(root, 'clone', '-q', '--bare', seed, origin);
    const member = async (name: string): Promise<Member> => {
      const checkout = path.join(root, name, 'work');
      git(root, 'clone', '-q', origin, checkout);
      const config: LocalConfig = {
        repo: { localPath: path.join(checkout, '.teamai'), remote: origin, kind: 'self', businessRepoRoot: checkout },
        username: name,
        scope: 'project',
        projectRoot: checkout,
        additionalRoles: [],
        dataHome: path.join(root, name, 'data'),
      };
      await syncScorersThenWorkflows(config);
      return { config, checkout, driver: { kind: 'local', machine: name, workspace: checkout } };
    };
    const alice = await member('alice');
    const bob = await member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    fs.writeFileSync(path.join(seed, '.teamai', 'workflows', 'build.yaml'), BUILD.replace('echo two', 'echo second'));
    git(seed, 'commit', '-qam', 'change build');
    git(seed, 'push', '-q', origin, 'main');
    git(bob.checkout, 'pull', '-q', '--ff-only');
    await syncScorersThenWorkflows(bob.config);

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { lease: { step: 'two', command: 'echo two' } } });
  });

  /** alice writes in the copy and publishes, bob claims and writes more and publishes, and alice claims the run back. */
  async function handBack(): Promise<{ alice: Member; business: string; runId: string; wrote: { branch: string; commit: string }; more: { commit: string } }> {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });
    const more = await work(bob, runId, 'more.txt');
    await publishRun(bob.config, runId, { env: {}, checkout: bob.checkout });
    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    return { alice, business: acme.business, runId, wrote, more };
  }

  // Two members, a worktree each and a publish and a claim between them: real git,
  // which a loaded runner takes far longer over.
  it('continues a copy it took back from the commit the other machine recorded, fast-forwarding its own branch', { timeout: 120_000 }, async () => {
    const { alice, business, runId, wrote, more } = await handBack();

    expect(await runLocalDriver(alice.config, runId, alice.checkout, { hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const tip = git(alice.checkout, 'rev-parse', wrote.branch);
    expect(git(alice.checkout, 'rev-parse', `${tip}^`)).toBe(more.commit);
    expect(originRef(business, `refs/heads/${wrote.branch}`)).toBe(tip);
    const settledRun = await readRun(alice.config, runId);
    expect(typeof settledRun === 'object' && settledRun.publication).not.toHaveProperty('reconcileCopies');
  });

  function commitLocally(dir: string): void {
    fs.writeFileSync(path.join(dir, 'local.txt'), 'local\n');
    git(dir, 'add', 'local.txt');
    git(dir, 'commit', '-qm', 'local');
  }

  it.each([
    ['has changes', (dir: string) => fs.writeFileSync(path.join(dir, 'stray.txt'), 'stray\n')],
    ['has a commit apart from the recorded one', (dir: string) => commitLocally(dir)],
    ['is ahead of the recorded commit', (dir: string, branch: string) => {
      git(dir, 'fetch', '-q', 'origin', branch);
      git(dir, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
      commitLocally(dir);
    }],
    ['is not on its branch', (dir: string) => git(dir, 'checkout', '-q', '--detach')],
    ['a reader left and is not back', async (dir: string, branch: string) => {
      fs.writeFileSync(path.join(dir, 'stray.txt'), 'stray\n');
      await markReadCopy(dir, { branch, step: 'change.read' });
      fs.rmSync(path.join(dir, 'stray.txt'));
    }],
  ])('refuses to continue a copy it took back that %s, and leaves it as it is', async (_name, change) => {
    const { alice, runId, wrote } = await handBack();
    const dir = worktreePath(alice.checkout, wrote.branch);
    await change(dir, wrote.branch);
    const tip = git(alice.checkout, 'rev-parse', wrote.branch);
    const status = git(dir, 'status', '--porcelain');

    expect(await runLocalDriver(alice.config, runId, alice.checkout, { hitl: false })).toMatchObject({ error: { code: 'branch_diverged' } });
    expect(git(alice.checkout, 'rev-parse', wrote.branch)).toBe(tip);
    expect(git(dir, 'status', '--porcelain')).toBe(status);
    expect(await readRun(alice.config, runId)).toMatchObject({ publication: { reconcileCopies: true } });
  });
});

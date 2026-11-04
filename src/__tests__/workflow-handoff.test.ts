import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import * as reportsBranch from '../utils/reports-branch.js';
import { updateReports } from '../utils/reports-branch.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { claimRun, publishRun, resumeRun } from '../workflow/handoff.js';
import { pendingRecords, queueRunRecord } from '../workflow/records.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import type { StepPass, StepState } from '../workflow/step-state.js';
import { readRun, updateRun } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';
import { BUILD, dirs, editRun, git, originFile, originRef, receiveHook, reportsHead, runStep, settle, SHIP, start, startIn, team, work } from './helpers/workflow-handoff-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow handoff through teamai-reports', () => {
  it('hands a published run to another install, which continues it, and refuses the earlier owner', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    expect(await runStep(alice, runId)).toBe('one');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', stateRevision: 1 } });
    const claimed = await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(claimed).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 2 } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { lease: { step: 'two' } } });

    const refused = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'not_owner', owner: claimed.ok ? claimed.value.owner : {}, ownedAt: expect.any(String) },
    });
  });

  it('keeps the mode a run started in through a claim, and records each pass in the mode of the driver that ran it (#1384)', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const started = await startRun(alice.config, 'build', {}, { secrets: await knownSecrets(alice.config), runMode: 'attended' });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    const next = await leaseNext(alice.config, runId, alice.driver, { runMode: 'attended' });
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const lease = next.data.lease as { attempt: string; revision: number };
    await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: alice.driver });
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true });

    vi.stubEnv('CI', 'true');
    try {
      expect(await runLocalDriver(bob.config, runId, bob.checkout, { hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}.json`) ?? '{}')).toMatchObject({
      phase: 'end', runMode: 'attended', steps: [{ step: 'one', runMode: 'attended' }, { step: 'two', runMode: 'unattended' }],
    });
  });

  it('leaves the flags a run was driven with on the install that gave them: a claim starts without them, and taking it back keeps them', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    const flags = { tools: { default: 'claude' }, autoApprove: true, sandbox: true } as const;
    expect(await runLocalDriver(alice.config, runId, alice.checkout, { hitl: false, ...flags })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true });
    expect(await readRun(bob.config, runId)).not.toHaveProperty('driveOptions');
    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    expect(await readRun(alice.config, runId)).toMatchObject({ driveOptions: flags });
  });

  it('names the owner by the team username, as the run records do', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    const ownerOnOrigin = (): unknown => JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}').owner;

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    expect(ownerOnOrigin()).toMatchObject({ user: 'alice' });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { owner: { user: 'bob' } } });
    expect(ownerOnOrigin()).toMatchObject({ user: 'bob' });
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({
      ok: false,
      error: { code: 'not_owner', message: expect.stringContaining(`Run ${runId} is owned by bob (install `) },
    });
  });

  it('publishes an unchanged run without a new reports commit or state revision', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', stateRevision: 1 } });
    const head = reportsHead(acme.origin);
    const published = originFile(acme.origin, `workflows/runs/${runId}/state.json`);

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'unchanged', stateRevision: 1 } });
    expect(reportsHead(acme.origin)).toBe(head);
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBe(published);
  });

  it('keeps its own progress and leases when it claims a run it already owns', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { lease: { step: 'one' } } });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'already_owned', stateRevision: 2 } });
    const kept = await readRun(bob.config, runId);
    expect(typeof kept === 'object' && kept.steps.find((step) => step.id === 'one')?.status).toBe('leased');
  });

  it('resumes a run this machine never published without reaching teamai-reports', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    git(alice.config.repo.localPath, 'remote', 'set-url', 'origin', path.join(path.dirname(acme.origin), 'gone.git'));

    expect(await resumeRun(alice.config, runId, { claim: false, checkout: alice.checkout })).toEqual({ ok: true, value: null });
  });

  it('refuses to claim a run nobody published', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'run_not_published' } });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses to claim from a team with no teamai-reports without creating the branch on origin', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    git(acme.origin, 'update-ref', '-d', 'refs/heads/teamai-reports');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'run_not_published' } });
    expect(originRef(acme.origin, 'refs/heads/teamai-reports')).toBeUndefined();
  });

  it('says teamai-reports is unreachable, never that the run is unpublished, when origin cannot be read', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    git(bob.config.repo.localPath, 'remote', 'set-url', 'origin', path.join(path.dirname(acme.origin), 'gone.git'));

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'reports_unreachable' } });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses a team repo of kind http before touching any reports checkout', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const http: LocalConfig = { ...alice.config, repo: { ...alice.config.repo, kind: 'http' } };

    expect(await publishRun(http, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'unsupported_repo' } });
    expect(await claimRun(http, runId, { checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'unsupported_repo' } });
  });

  it('answers busy and installs nothing while another process writes teamai-reports', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const lock = path.join(path.dirname(bob.config.repo.localPath), '.reports-lock');
    expect(await acquireLock(lock)).toBe(true);
    try {
      expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'busy' } });
    } finally {
      await releaseLock(lock);
    }
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses a local run that shares the published id but started at another time', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const local = await readRun(alice.config, runId);
    if (typeof local !== 'object') throw new Error('no run');
    await updateRun(bob.config, runId, {}, async () => ({ value: undefined, write: { ...local, createdAt: '2020-01-01T00:00:00.000Z' } }));

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({
      ok: false,
      error: { code: 'run_mismatch', localCreatedAt: '2020-01-01T00:00:00.000Z', remoteCreatedAt: local.createdAt },
    });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ stateRevision: 1 });
  });

  it.each([
    ['a field at the root', (snapshot: Record<string, unknown>) => ({ ...snapshot, futureField: 1 }), 'futureField'],
    ['a field of a step', (snapshot: Record<string, unknown>) => ({ ...snapshot, steps: [{ ...(snapshot.steps as object[])[0], futureField: 1 }] }), 'steps[0].futureField'],
    ['a newer format', (snapshot: Record<string, unknown>) => ({ ...snapshot, snapshot: 2 }), 'snapshot'],
    ['a field of an agent observation', (snapshot: Record<string, unknown>) => ({
      ...snapshot,
      steps: [{
        ...(snapshot.steps as object[])[0], status: 'succeeded', outcome: 'success', settledAt: 1,
        agent: { v: 1, tool: { name: 'claude' }, teamai: '0.22.0', driver: 'local', futureField: 1 },
      }],
    }), 'steps[0].agent.futureField'],
  ])('refuses to claim a snapshot with %s it does not know', async (_name, edit, field) => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const editor = path.join(path.dirname(acme.origin), 'editor');
    git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
    const rel = `workflows/runs/${runId}/state.json`;
    const snapshot: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
    fs.writeFileSync(path.join(editor, rel), `${JSON.stringify(edit(snapshot), null, 2)}\n`);
    git(editor, 'commit', '-qam', 'newer teamai');
    git(editor, 'push', '-q', 'origin', 'teamai-reports');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'snapshot_unsupported', field } });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('refuses to claim a snapshot whose team commit is not a commit id', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const editor = path.join(path.dirname(acme.origin), 'editor');
    git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
    const rel = `workflows/runs/${runId}/state.json`;
    const snapshot: Record<string, unknown> = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
    fs.writeFileSync(path.join(editor, rel), `${JSON.stringify({ ...snapshot, teamRevision: '--upload-pack=touch upload-pack-ran' }, null, 2)}\n`);
    git(editor, 'commit', '-qam', 'not a commit');
    git(editor, 'push', '-q', 'origin', 'teamai-reports');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'snapshot_unsupported', field: 'teamRevision' } });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  interface HandedStep { id: string; changes: { branch: string; base: string; from: string; to: string; commits: string[] }; read?: unknown; passes?: unknown[] }
  interface HandedRun { base: { commit: string }; copies: Record<string, { commit: string; from?: string }>; steps: HandedStep[]; archive: unknown[] }
  it.each<[string, (snapshot: HandedRun, step: HandedStep, branch: string) => void, (at: number, branch: string) => string]>([
    ['its base', (snapshot) => { snapshot.base.commit = 'main'; }, () => 'base.commit'],
    ['a copy', (snapshot, _step, branch) => { snapshot.copies[branch] = { commit: 'HEAD' }; }, (_at, branch) => `copies.${branch}.commit`],
    ['the base of a change', (_snapshot, step) => { step.changes.base = '--upload-pack=touch ran'; }, (at) => `steps[${at}].changes.base`],
    ['the start of a change', (_snapshot, step) => { step.changes.from = 'abc1234'; }, (at) => `steps[${at}].changes.from`],
    ['the end of a change', (_snapshot, step) => { step.changes.to = `${step.changes.to}^`; }, (at) => `steps[${at}].changes.to`],
    ['a commit of a change', (_snapshot, step) => { step.changes.commits = ['HEAD~1']; }, (at) => `steps[${at}].changes.commits[0]`],
    ['what a step read', (_snapshot, step, branch) => { step.read = { branch, base: step.changes.base, commit: 'HEAD' }; }, (at) => `steps[${at}].read.commit`],
    ['the base a step read on', (_snapshot, step, branch) => { step.read = { branch, base: 'main', commit: step.changes.to }; }, (at) => `steps[${at}].read.base`],
    ['a change of an earlier pass', (_snapshot, step) => {
      step.passes = [{ pass: 1, outcome: 'success', changes: { ...step.changes, to: 'main' } }];
    }, (at) => `steps[${at}].passes[0].changes.to`],
    ['a change of a pass a loop removed', (snapshot, step) => {
      snapshot.archive = [{ step: 'change.write', pass: 1, outcome: 'success', changes: { ...step.changes, from: 'main' } }];
    }, () => 'archive[0].changes.from'],
  ])('refuses to claim a snapshot whose commit of %s is not a commit id, naming the field', async (_name, edit, field) => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const editor = path.join(path.dirname(acme.origin), 'editor');
    git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
    const rel = `workflows/runs/${runId}/state.json`;
    const snapshot: HandedRun = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
    const at = snapshot.steps.findIndex((step) => step.id === 'change.write');
    const step = snapshot.steps[at];
    if (!step) throw new Error('no change.write step');
    edit(snapshot, step, wrote.branch);
    fs.writeFileSync(path.join(editor, rel), `${JSON.stringify(snapshot, null, 2)}\n`);
    git(editor, 'commit', '-qam', 'hand edit');
    git(editor, 'push', '-q', 'origin', 'teamai-reports');

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({
      ok: false,
      error: { code: 'snapshot_unsupported', field: field(at, wrote.branch), message: expect.stringContaining(`publish the run again from the machine that owns it: teamai workflow publish ${runId}`) },
    });
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it.each<[string, (branch: string, commit: string) => HandedRun['copies'], (branch: string) => string]>([
    ['is a branch outside any run', (_branch, commit) => ({ main: { commit } }), () => 'copies.main'],
    ['is a branch of another run', (_branch, commit) => ({ 'teamai/r0123456789abcdef/change/p1': { commit } }), () => 'copies.teamai/r0123456789abcdef/change/p1'],
    ['started from a branch outside the run', (branch, commit) => ({ [branch]: { commit, from: 'main' } }), (branch) => `copies.${branch}.from`],
  ])(
    'refuses to claim a snapshot whose copy %s, and changes nothing',
    async (_name, copies, field) => {
      const acme = team({ ship: SHIP });
      const alice = await acme.member('alice');
      const bob = await acme.member('bob');
      const runId = await startIn(alice, 'ship');
      const wrote = await work(alice, runId, 'write.txt');
      await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
      const editor = path.join(path.dirname(acme.origin), 'editor');
      git(path.dirname(acme.origin), 'clone', '-q', '--branch', 'teamai-reports', acme.origin, editor);
      const rel = `workflows/runs/${runId}/state.json`;
      const snapshot: HandedRun = JSON.parse(fs.readFileSync(path.join(editor, rel), 'utf8'));
      snapshot.copies = copies(wrote.branch, wrote.commit);
      fs.writeFileSync(path.join(editor, rel), `${JSON.stringify(snapshot, null, 2)}\n`);
      git(editor, 'commit', '-qam', 'hand edit');
      git(editor, 'push', '-q', 'origin', 'teamai-reports');

      expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'snapshot_unsupported', field: field(wrote.branch) } });
      expect(await readRun(bob.config, runId)).toBe('missing');
    },
  );

  it('refuses to publish a run that recorded a change by something other than a commit id, naming the field', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'ship');
    await work(alice, runId, 'write.txt');
    await editRun(alice.config, runId, (run) => ({
      ...run,
      steps: run.steps.map((step) => (step.status === 'succeeded' && step.changes ? { ...step, changes: { ...step.changes, from: 'main' } } : step)),
    }));
    const stored = await readRun(alice.config, runId);
    if (typeof stored !== 'object') throw new Error('run was not stored');
    const at = stored.steps.findIndex((step) => step.id === 'change.write');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'snapshot_unsupported', field: `steps[${at}].changes.from` } });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('hands over every pass, answer, result, and counter of a run, keeping only messages and driver identities on this machine', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    const commit = (char: string): string => char.repeat(40);
    const driver = { kind: 'ide', machine: 'alice-desk', workspace: '/home/alice/ide' };
    const answer = { choice: 'yes', note: 'looks fine', at: '2026-10-21T10:00:00.000Z', channel: 'driver' as const, agent: false };
    const report = {
      exitCode: 0, tool: 'claude', model: 'opus', session: 'session-1', tokens: { input: 10, output: 20, cachedInput: 5 },
      changes: { branch: `teamai/${runId}/one/p1`, base: commit('a'), from: commit('a'), to: commit('b'), commits: [commit('b')] },
      read: { branch: `teamai/${runId}/read/p1`, base: commit('a'), commit: commit('c') },
      agent: { v: 1 as const, tool: { name: 'claude', version: '2.1.0' }, model: { requested: 'opus' }, teamai: '0.22.0', driver: 'local' },
    };
    const results = [{ item: { name: 'x' }, outcome: 'success' as const, outputs: { n: 1 }, branch: `teamai/${runId}/one/p1` }];
    const pass: StepPass = {
      pass: 1, attempt: 'a00000001', outcome: 'failed', outputs: { tries: 1 }, end: 'retry', results,
      failure: { code: 'tool_failed', message: 'exit 1 on alice-desk' }, message: 'exit 1 on alice-desk', ...report, answer: { ...answer, driver },
    };
    const steps: StepState[] = [
      {
        id: 'one', status: 'succeeded', outcome: 'success', pass: 2, passes: [pass], answer: { ...answer, driver }, item: { name: 'x' },
        inputs: { level: 3 }, iteration: 1, round: 1, attempt: 'a00000002', outputs: { ok: true, list: [1, 'two'] }, end: 'done',
        results, settledAt: 2, loopFinal: true, message: 'built on alice-desk', ...report,
      },
      {
        id: 'two', status: 'failed', outcome: 'failed', attempt: 'a00000003', settledAt: 3, exitCode: 1,
        message: 'two broke on alice-desk', failure: { code: 'tool_failed', message: 'two broke on alice-desk' },
      },
    ];
    await editRun(alice.config, runId, (run) => ({
      ...run, status: 'failed', failure: { code: 'loop_exhausted', message: 'gave up on alice-desk' }, inputs: { target: 'prod' },
      round: 1, steps, archive: [{ ...pass, step: 'one.child' }], cancelledAttempts: ['a00000009'],
      settledAttempts: ['a00000001', 'a00000002'], settledCount: 3, driver,
    }));
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const text = originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '';
    expect(text).not.toContain('alice-desk');
    expect(text).not.toContain('/home/alice');
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true });
    const kept = 'The details stay on the machine that ran this step.';
    const handedPass = { ...pass, failure: { code: 'tool_failed', message: kept }, answer };
    delete handedPass.message;
    const claimed = await readRun(bob.config, runId);
    expect(claimed).toMatchObject({
      status: 'failed', failure: { code: 'loop_exhausted', message: kept }, inputs: { target: 'prod' }, round: 1,
      archive: [{ ...handedPass, step: 'one.child' }], cancelledAttempts: ['a00000009'], settledAttempts: [], settledCount: 3,
    });
    expect(typeof claimed === 'object' && claimed.steps).toEqual([
      {
        id: 'one', status: 'succeeded', outcome: 'success', pass: 2, passes: [handedPass], answer, item: { name: 'x' },
        inputs: { level: 3 }, iteration: 1, round: 1, attempt: 'a00000002', outputs: { ok: true, list: [1, 'two'] }, end: 'done',
        results, settledAt: 2, loopFinal: true, ...report,
      },
      { id: 'two', status: 'failed', outcome: 'failed', attempt: 'a00000003', settledAt: 3, exitCode: 1, failure: { code: 'tool_failed', message: kept } },
    ]);
    expect(claimed).not.toHaveProperty('driver');
  });

  it('refuses to publish what looks like a secret, naming where without the value', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    await runStep(alice, runId, { note: 'deploy-key-value-1234', token });

    const shaped = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(shaped).toMatchObject({ ok: false, error: { code: 'secret_detected', step: 'one', field: 'outputs.token', label: 'gh_tok' } });
    expect(JSON.stringify(shaped)).not.toContain(token);
    const known = await publishRun(alice.config, runId, { env: { DEPLOY_KEY: 'deploy-key-value-1234' }, checkout: alice.checkout });
    expect(known).toMatchObject({ ok: false, error: { code: 'secret_detected', step: 'one', label: 'DEPLOY_KEY' } });
    expect(JSON.stringify(known)).not.toContain('deploy-key-value-1234');
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  const SECRET = 'deploy-key-value-1234';
  const settled = { status: 'succeeded' as const, outcome: 'success' as const, attempt: 'a00000001', settledAt: 1 };
  it.each<[string, (run: RunState) => RunState, { step?: string; field: string }]>([
    ['the run inputs', (run) => ({ ...run, inputs: { key: SECRET } }), { field: 'inputs.key' }],
    ['the inputs of a step', (run) => ({ ...run, steps: [{ id: 'one', status: 'pending', inputs: { key: SECRET } }] }), { step: 'one', field: 'inputs.key' }],
    ['the item of a step', (run) => ({ ...run, steps: [{ id: 'one', status: 'pending', item: SECRET }] }), { step: 'one', field: 'item' }],
    ['a list deep in the outputs of a step', (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { deep: ['fine', SECRET] } }] }), { step: 'one', field: 'outputs.deep[1]' }],
    ['the outputs of an item result', (run) => ({ ...run, steps: [{ id: 'one', ...settled, results: [{ item: 1, outcome: 'success', outputs: { key: SECRET } }] }] }), { step: 'one', field: 'results[0].outputs.key' }],
    ['the note of an answer', (run) => ({ ...run, steps: [{ id: 'one', status: 'pending', answer: { choice: 'yes', note: SECRET, at: run.createdAt, channel: 'cli', agent: false } }] }), { step: 'one', field: 'answer.note' }],
    ['an earlier pass', (run) => ({ ...run, steps: [{ id: 'one', status: 'pending', pass: 2, passes: [{ pass: 1, outcome: 'success', outputs: { key: SECRET } }] }] }), { step: 'one', field: 'passes[0].outputs.key' }],
    ['the archive', (run) => ({ ...run, archive: [{ step: 'one.child', pass: 1, outcome: 'success', outputs: { key: SECRET } }] }), { step: 'one.child', field: 'outputs.key' }],
    ['a key of the outputs of a step', (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { fine: { [SECRET]: 1 } } }] }), { step: 'one', field: 'outputs.fine' }],
    ['the failure code of a step', (run) => ({ ...run, steps: [{ id: 'one', status: 'failed', outcome: 'failed', settledAt: 1, failure: { code: SECRET, message: 'm' } }] }), { step: 'one', field: 'failure.code' }],
    ['the id of a step', (run) => ({ ...run, steps: [{ id: 'one', status: 'pending' }, { id: SECRET, status: 'pending' }] }), { field: 'steps[1].id' }],
    ['the step of an archived pass', (run) => ({ ...run, archive: [{ step: SECRET, pass: 1, outcome: 'success' }] }), { field: 'archive[0].step' }],
  ])('refuses to publish a secret in %s, naming the field and the variable it matched', async (_name, edit, where) => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await editRun(alice.config, runId, edit);

    const refused = await publishRun(alice.config, runId, { env: { DEPLOY_KEY: SECRET }, checkout: alice.checkout });
    expect(refused).toMatchObject({ ok: false, error: { code: 'secret_detected', ...where, label: 'DEPLOY_KEY' } });
    if (!where.step) expect(refused.ok ? undefined : refused.error).not.toHaveProperty('step');
    expect(JSON.stringify(refused)).not.toContain(SECRET);
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('refuses to publish the value of a secret the team declares, whatever its name, and publishes its plain variables', async () => {
    const acme = team({ build: BUILD }, {
      'env/secrets.yaml': 'secrets:\n  - key: WAREHOUSE_DSN\n',
      'env/env.yaml': 'variables:\n  - key: DEPLOY_ENV\n    value: production-eu-west\n',
    });
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const env = { WAREHOUSE_DSN: 'mysql-prod-7Hq2xVb9Lk' };
    await editRun(alice.config, runId, (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { dsn: 'mysql-prod-7Hq2xVb9Lk' } }] }));

    const refused = await publishRun(alice.config, runId, { env, checkout: alice.checkout });
    expect(refused).toMatchObject({ ok: false, error: { code: 'secret_detected', step: 'one', field: 'outputs.dsn', label: 'WAREHOUSE_DSN' } });
    expect(JSON.stringify(refused)).not.toContain('mysql-prod-7Hq2xVb9Lk');

    await editRun(alice.config, runId, (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { target: 'production-eu-west' } }] }));
    expect(await publishRun(alice.config, runId, { env, checkout: alice.checkout })).toMatchObject({ ok: true });
  });

  it('refuses to publish a declared secret shorter than the length that marks an environment value as secret', async () => {
    const acme = team({ build: BUILD }, { 'env/secrets.yaml': 'secrets:\n  - key: ACCESS_CODE\n' });
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await editRun(alice.config, runId, (run) => ({ ...run, inputs: { target: '493827' } }));

    const refused = await publishRun(alice.config, runId, { env: { ACCESS_CODE: '493827' }, checkout: alice.checkout });
    expect(refused).toMatchObject({ ok: false, error: { code: 'secret_detected', field: 'inputs.target', label: 'ACCESS_CODE' } });
    expect(JSON.stringify(refused)).not.toContain('493827');
  });

  it('refuses to publish a declared secret a step output holds as a number', async () => {
    const acme = team({ build: BUILD }, { 'env/secrets.yaml': 'secrets:\n  - key: ACCESS_CODE\n' });
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await editRun(alice.config, runId, (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { code: 493827 } }] }));

    const refused = await publishRun(alice.config, runId, { env: { ACCESS_CODE: '493827' }, checkout: alice.checkout });
    expect(refused).toMatchObject({ ok: false, error: { code: 'secret_detected', step: 'one', field: 'outputs.code', label: 'ACCESS_CODE' } });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('publishes text that holds a declared secret only inside a longer token, or one too short to tell from ordinary text', async () => {
    const acme = team({ build: BUILD }, { 'env/secrets.yaml': 'secrets:\n  - key: ACCESS_CODE\n  - key: RETRIES\n  - key: MODE\n' });
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await editRun(alice.config, runId, (run) => ({ ...run, inputs: { target: 'build-4938271 turned on after 1 retry' } }));

    const published = await publishRun(alice.config, runId, { env: { ACCESS_CODE: '493827', RETRIES: '1', MODE: 'on' }, checkout: alice.checkout });
    expect(published).toMatchObject({ ok: true });
  });

  it('names a declared secret too short to protect when it publishes', async () => {
    const acme = team({ build: BUILD }, { 'env/secrets.yaml': 'secrets:\n  - key: DOOR_PIN\n' });
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const warn = vi.spyOn(log, 'warn');

    expect(await publishRun(alice.config, runId, { env: { DOOR_PIN: '42' }, checkout: alice.checkout })).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DOOR_PIN'));
  });

  const HOME_FILE = path.join(os.homedir(), 'private', 'customer-data.csv');
  it.each<[string, (run: RunState) => RunState, { step?: string; field: string }]>([
    ['the run inputs', (run) => ({ ...run, inputs: { file: HOME_FILE } }), { field: 'inputs.file' }],
    ['text in the outputs of a step', (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { summary: `Wrote ${HOME_FILE}.` } }] }), { step: 'one', field: 'outputs.summary' }],
    ['the note of an answer', (run) => ({ ...run, steps: [{ id: 'one', status: 'pending', answer: { choice: 'yes', note: `see ~/notes.md`, at: run.createdAt, channel: 'cli', agent: false } }] }), { step: 'one', field: 'answer.note' }],
    ['a key of the outputs of a step', (run) => ({ ...run, steps: [{ id: 'one', ...settled, outputs: { files: { [HOME_FILE]: 'ok' } } }] }), { step: 'one', field: 'outputs.files' }],
    ['a Windows drive path', (run) => ({ ...run, inputs: { file: 'C:\\Users\\alice\\data.csv' } }), { field: 'inputs.file' }],
    ['a Windows share path', (run) => ({ ...run, inputs: { file: '\\\\fileserver\\share\\data.csv' } }), { field: 'inputs.file' }],
    ['a file URL', (run) => ({ ...run, inputs: { file: 'file:///srv/data.csv' } }), { field: 'inputs.file' }],
  ])('refuses to publish an absolute path of this machine in %s, naming the field', async (_name, edit, where) => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await editRun(alice.config, runId, edit);

    const refused = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'local_path_detected', ...where, message: expect.stringContaining('Continue it on this machine') },
    });
    if (!where.step) expect(refused.ok ? undefined : refused.error).not.toHaveProperty('step');
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('publishes URLs, paths relative to the repository, and text with slashes', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const inputs = {
      url: 'https://example.com/Users/alice/report', file: 'src/app/main.ts', dir: './docs', route: '/api/v1/users',
      text: 'read and/or write 3/4 of the I/O', branch: 'origin/main',
    };
    await editRun(alice.config, runId, (run) => ({ ...run, inputs }));

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ inputs });
  });

  it('refuses to publish while the run has records teamai-reports did not take, saying why', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    receiveHook(acme.origin, `while read old new ref; do git diff --name-only "$old" "$new" | grep -q "workflows/runs/${runId}.json" && { echo "run records are held back" >&2; exit 1; }; done; exit 0`);
    await runStep(alice, runId);
    await runStep(alice, runId);
    await settle(alice, runId);

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({
      ok: false,
      error: { code: 'records_pending', message: expect.stringContaining('run records are held back') },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('refuses to publish when a record of the run is queued while the run is being published', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    const write = reportsBranch.updateReports;
    vi.spyOn(reportsBranch, 'updateReports').mockImplementation(async (config, change) => {
      const run = await readRun(alice.config, runId);
      if (typeof run === 'object') await queueRunRecord(alice.config, run, alice.driver, 'end', {});
      return write(config, change);
    });

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'records_pending' } });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('publishes a run while records of another run wait to be published', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    const other = await start(alice);
    const otherRun = await readRun(alice.config, other);
    if (typeof otherRun !== 'object') throw new Error('run was not stored');
    await queueRunRecord(alice.config, otherRun, alice.driver, 'end', {});
    const write = reportsBranch.updateReports;
    vi.spyOn(reportsBranch, 'updateReports').mockImplementationOnce(async (config, change) => {
      await queueRunRecord(alice.config, otherRun, alice.driver, 'end', {});
      return write(config, change);
    });

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published' } });
    expect((await pendingRecords(alice.config)).map((record) => record.run)).toEqual([other]);
  });

  it('adopts its own snapshot that a later reports write delivered', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    receiveHook(acme.origin, 'exit 1');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'reports_failed' } });
    receiveHook(acme.origin, 'exit 0');
    await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, 'unrelated.txt'), 'another writer\n');
      return { files: ['unrelated.txt'], message: 'unrelated' };
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).not.toBeNull();

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'unchanged', stateRevision: 1 } });
  });

  it('resumes its own run after a first publish whose push did not land', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    receiveHook(acme.origin, 'exit 1');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'reports_failed' } });

    expect(await resumeRun(alice.config, runId, { claim: false, checkout: alice.checkout })).toEqual({ ok: true, value: null });
    expect(await runStep(alice, runId)).toBe('two');
  });

  it('never lets a queued publish replace a claim made after it, and the stale publisher is no longer the owner', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await runStep(alice, runId);
    receiveHook(acme.origin, 'exit 1');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'reports_failed' } });
    receiveHook(acme.origin, 'exit 0');
    const claimed = await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(claimed).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 2 } });
    const claim = originFile(acme.origin, `workflows/runs/${runId}/state.json`);

    expect(await updateReports(alice.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, 'unrelated.txt'), 'another writer\n');
      return { files: ['unrelated.txt'], message: 'unrelated' };
    })).toMatchObject({ status: 'published' });
    expect(originFile(acme.origin, 'unrelated.txt')).toBe('another writer\n');
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBe(claim);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({
      ok: false,
      error: { code: 'not_owner', owner: claimed.ok ? claimed.value.owner : {} },
    });
  });

  it('never lets a queued claim replace a publish made after it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    receiveHook(acme.origin, 'exit 1');
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: false, error: { code: 'reports_failed' } });
    receiveHook(acme.origin, 'exit 0');
    await runStep(alice, runId);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', stateRevision: 2 } });
    const published = originFile(acme.origin, `workflows/runs/${runId}/state.json`);

    expect(await updateReports(bob.config, async (worktree) => {
      fs.writeFileSync(path.join(worktree, 'unrelated.txt'), 'another writer\n');
      return { files: ['unrelated.txt'], message: 'unrelated' };
    })).toMatchObject({ status: 'published' });
    expect(originFile(acme.origin, 'unrelated.txt')).toBe('another writer\n');
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBe(published);
    expect(await readRun(bob.config, runId)).toBe('missing');
  });

  it('keeps progress made while a publish was pending, and publishes it when the run ends', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runId = await start(alice);
    await runStep(alice, runId);
    receiveHook(acme.origin, 'exit 1');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'reports_failed' } });
    receiveHook(acme.origin, 'exit 0');
    expect(await runStep(alice, runId)).toBe('two');
    await settle(alice, runId);
    // The end record's write delivers the publish that did not land, and the end follows it.
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'unchanged', stateRevision: 2 } });
  });

  it('never runs again a run its owner finished after a first publish that did not land, and the member who resumes it owns it', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    receiveHook(acme.origin, 'exit 1');
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'reports_failed' } });
    receiveHook(acme.origin, 'exit 0');
    expect(await resumeRun(alice.config, runId, { claim: false, checkout: alice.checkout })).toEqual({ ok: true, value: null });
    expect(await runStep(alice, runId)).toBe('two');
    await settle(alice, runId);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ status: 'succeeded', stateRevision: 2 });

    const resumed = await resumeRun(bob.config, runId, { claim: false, checkout: bob.checkout });
    expect(resumed).toMatchObject({ ok: true, value: { ownership: 'claimed', stateRevision: 3 } });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { done: { run: runId, outcome: 'succeeded' } } });
    const installed = await readRun(bob.config, runId);
    expect(typeof installed === 'object' ? installed.steps.map((step) => [step.id, step.status]) : installed).toEqual([['one', 'succeeded'], ['two', 'succeeded']]);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({
      status: 'succeeded', stateRevision: 3, owner: resumed.ok && resumed.value ? resumed.value.owner : {},
    });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}.json`) ?? '{}')).toMatchObject({ username: 'alice', status: 'succeeded' });
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'not_owner' } });
  });

});

describe('a run with private steps', () => {
  const JUDGE = 'schemaVersion: v1alpha1\nname: judge\ndescription: Judge on this machine only.\nprivate: true\nsteps:\n  - id: label\n    command: echo label\n    output: { label: string, reasoning: string }\noutputs:\n  label: steps.label.outputs.label\n';
  const REVIEWED = 'schemaVersion: v1alpha1\nname: reviewed\ndescription: Judge, then ship.\nsteps:\n  - id: check\n    workflow: judge\n  - id: ship\n    needs: [check]\n    command: echo ship\n';

  it('refuses publish and claim with private_open while a private step is open, and publishes none of its outputs once it settled', async () => {
    const acme = team({ judge: JUDGE, reviewed: REVIEWED });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'reviewed');
    const next = await leaseNext(alice.config, runId, alice.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const lease = next.data.lease as { step: string; attempt: string; revision: number };
    expect(lease.step).toBe('check.label');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'private_open' } });
    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'private_open' } });

    await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: alice.driver, outputs: { label: 'good', reasoning: 'it reads well' } });
    expect(await leaseNext(alice.config, runId, alice.driver)).toMatchObject({ data: { lease: { step: 'ship' } } });
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });

    const published = originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '';
    expect(published).not.toContain('it reads well');
    expect(JSON.parse(published)).toMatchObject({ steps: [{ id: 'check', outputs: { label: 'good' } }, { id: 'check.label', status: 'succeeded' }, { id: 'ship' }] });
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true });
  });

  it('publishes the answer of a private step without its note, in the step, its passes and the archive', async () => {
    const acme = team({ judge: JUDGE, reviewed: REVIEWED });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'reviewed');
    const next = await leaseNext(alice.config, runId, alice.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const lease = next.data.lease as { attempt: string; revision: number };
    await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: alice.driver, outputs: { label: 'good', reasoning: 'it reads well' } });
    const answer = { choice: 'yes', note: 'the customer is Initech', at: '2026-10-21T10:00:00.000Z', channel: 'cli' as const, agent: false };
    await editRun(alice.config, runId, (run) => ({
      ...run,
      steps: run.steps.map((step) => (step.id === 'check.label' ? { ...step, answer, passes: [{ pass: 1, attempt: 'a00000001', outcome: 'success', answer }] }
        : step.id === 'ship' ? { ...step, answer: { ...answer, note: 'ship it' } } : step)),
      archive: [{ pass: 1, attempt: 'a00000002', outcome: 'success', answer, step: 'check.label' }],
    }));

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    const published = originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '';
    expect(published).not.toContain('Initech');
    expect(JSON.parse(published)).toMatchObject({
      steps: [{ id: 'check' }, { id: 'check.label', answer: { choice: 'yes' }, passes: [{ answer: { choice: 'yes' } }] }, { id: 'ship', answer: { note: 'ship it' } }],
      archive: [{ step: 'check.label', answer: { choice: 'yes' } }],
    });
  });

  it('publishes no item or inputs a private step built from a private output', async () => {
    const FIND = 'schemaVersion: v1alpha1\nname: judge\ndescription: Judge on this machine only.\nprivate: true\nsteps:\n  - id: find\n    command: echo find\n    output: { names: [string] }\n'
      + '  - id: each\n    needs: [find]\n    for_each: steps.find.outputs.names\n    command: echo each\n'
      + '  - id: deep\n    needs: [find]\n    workflow: deep\n    with: { who: "{{ steps.find.outputs.names }}" }\n';
    const DEEP = 'schemaVersion: v1alpha1\nname: deep\ndescription: Look deeper.\ninputs:\n  who: [string]\nsteps:\n  - id: look\n    command: echo look\n';
    const acme = team({ judge: FIND, deep: DEEP, reviewed: REVIEWED });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'reviewed');

    for (;;) {
      const next = await leaseNext(alice.config, runId, alice.driver);
      if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
      const lease = next.data.lease as { step: string; attempt: string; revision: number };
      if (lease.step === 'ship') break;
      const outputs = lease.step === 'check.find' ? { names: ['Initech'] } : undefined;
      await reportAttempt(alice.config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: alice.driver, ...(outputs ? { outputs } : {}) });
    }

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '').not.toContain('Initech');
    const bob = await acme.member('bob');
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true });
    expect(await leaseNext(bob.config, runId, bob.driver)).toMatchObject({ data: { lease: { step: 'ship' } } });
  });

  it('keeps a run of a private workflow on the machine that started it', async () => {
    const acme = team({ judge: JUDGE });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'judge');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'isolated_run' } });
    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: false, error: { code: 'isolated_run' } });
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { listHandoffs } from '../dashboard/workflow-runs.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { AgentSession } from '../session-flow/agent-session.js';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import * as reportsBranch from '../utils/reports-branch.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import { leaseNext, reportAttempt, resumableSessions, startRun } from '../workflow/engine.js';
import { claimOffered, claimRun, publishRun, resumeRun, settledSteps } from '../workflow/handoff.js';
import { pendingRecords, queueRunRecord } from '../workflow/records.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { cancelRun } from '../workflow/run-controls.js';
import type { LocalToolAdapter } from '../workflow/drivers/local/local-tool-adapter.js';
import { installOwner, readRun } from '../workflow/store.js';
import { PublishedRuns, type Taker } from '../workflow-published-runs.js';
import type { WorkflowDefinition, WorkflowEnvelope } from '../workflow/types.js';
import { worktreePath } from '../workflow/worktree.js';
import { resolveWorkflowEnv } from '../env-resolution.js';
import { archiveOnDefaultBranch, BUILD, dirs, git, holdBasePin, Member, onGitHub, originFile, originRef, pull, runStep, SHIP, start, startIn, team, work, WORKSPACES } from './helpers/workflow-handoff-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sessions a published run shares', () => {
  const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review again in the same session.
steps:
  - id: review
    prompt: Review this project.
    session: continue
    loop: { back_to: review, while: "length(steps.review.passes) < 2", max_iterations: 2 }
`;
  const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const REVIEW_CHAIN = `schemaVersion: v1alpha1
name: review
description: Plan, check the plan in its session, then build on it.
steps:
  - id: plan
    prompt: Plan this project.
  - id: check
    needs: [plan]
    prompt: Check the plan.
    session: { from: plan }
  - id: build
    needs: [check]
    prompt: Build the plan.
    session: { from: plan }
`;

  /** Writes the Claude Code session the member's tool left in `cwd`, which answered `answer`, and returns its id. */
  async function claudeSession(cwd: string, answer: string): Promise<string> {
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'projects'), { recursive: true });
    return getAdapter('claude-code').writeSession({
      sessionId: `review-${answer.length}`,
      title: 'Review this project',
      cwd,
      platform: 'claude-code',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:05.000Z',
      messages: [
        { role: 'user', timestamp: '2026-10-01T10:00:00.000Z', content: [{ type: 'text', text: 'Review this project.' }] },
        { role: 'assistant', timestamp: '2026-10-01T10:00:05.000Z', content: [{ type: 'text', text: answer }] },
      ],
      metadata: {},
    }, cwd);
  }

  /** Runs the review's first pass on the member's machine, in Claude Code session `session`, which resumed `resumed` if given. */
  async function reviewed(member: Member, runId: string, session: string, resumed?: { tool: string; id: string }): Promise<void> {
    const lease = leaseOf(await leaseNext(member.config, runId, member.driver));
    const reported = await reportAttempt(member.config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: member.driver, tool: 'claude', session,
      ...(resumed ? { resumed } : {}),
    });
    if ('error' in reported) throw new Error(reported.error.message);
  }

  function leaseOf(envelope: Awaited<ReturnType<typeof leaseNext>>): { attempt: string; revision: number } {
    if (!('data' in envelope) || !envelope.data.lease) throw new Error(`no lease: ${JSON.stringify(envelope)}`);
    return envelope.data.lease as { attempt: string; revision: number };
  }

  /** Removes the member's own copy of `session`, as on a machine that never ran it. */
  async function forget(cwd: string, session: string): Promise<void> {
    const listed = (await getAdapter('claude-code').listConversations(cwd)).find((meta) => meta.sessionId === session);
    fs.rmSync(listed?.filePath ?? '');
  }

  it('refuses to publish, telling to publish again, when a step gets a session to continue while publish checks the business origin', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    const pin = holdBasePin(acme.business);

    const publishing = publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });
    await pin.held();
    await reviewed(alice, runId, 'review-1');
    pin.release();

    expect(await publishing).toMatchObject({ ok: false, error: { code: 'state_moved' } });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('archives the session a step will continue, scrubbed, and the member who claims the run resumes a copy of it', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, `Found two problems. The deploy token is ${TOKEN}.`);
    await reviewed(alice, runId, session);

    const published = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });

    expect(published).toMatchObject({ ok: true, value: { publication: 'published', sessions: [{ tool: 'claude', id: session }] } });
    const state = originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '';
    expect(state).toContain(session);
    expect(state).not.toContain('Found two problems');
    const archived = execFileSync('git', ['--git-dir', acme.origin, 'ls-tree', '-r', '--name-only', 'teamai-reports', 'sessions'], { encoding: 'utf8' })
      .split('\n').filter((file) => file.endsWith('.jsonl'));
    expect(archived).toHaveLength(1);
    const transcript = execFileSync('git', ['--git-dir', acme.origin, 'show', `teamai-reports:${archived[0]}`], { encoding: 'utf8' });
    expect(transcript).toContain('Found two problems.');
    expect(transcript).not.toContain(TOKEN);

    await forget(alice.checkout, session);
    await claimsAndResumes(await acme.member('bob'), runId, session);
  });

  /** `bob` claims the run and drives the review's second pass, which resumes a copy of the review's first session. */
  async function claimsAndResumes(bob: Member, runId: string, session: string): Promise<void> {
    bob.config.workflows = { tools: { default: 'claude' } };
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const resumed: Array<string | undefined> = [];
    const tool: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_name, input) => {
        resumed.push(input.resume);
        return { started: true as const, exitCode: 0 };
      }),
    };

    expect(await runLocalDriver(bob.config, runId, bob.checkout, { adapter: tool, hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(resumed).toEqual([expect.any(String)]);
    expect(resumed[0]).not.toBe(session);
    expect(await AgentSession.find({ platform: 'claude-code', sessionId: resumed[0] ?? '' }, { scrub: false })).toMatchObject({
      status: 'done',
      session: { cwd: bob.checkout, messages: [{ content: [{ text: 'Review this project.' }] }, { content: [{ text: expect.stringContaining('Found two problems.') }] }] },
    });
  }

  it('archives the sessions of a run it already published unchanged, and leaves the snapshot as it was', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'Found two problems.');
    await reviewed(alice, runId, session);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { stateRevision: 1 } });
    const snapshot = originFile(acme.origin, `workflows/runs/${runId}/state.json`);

    const again = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });

    expect(again).toMatchObject({ ok: true, value: { publication: 'unchanged', stateRevision: 1, sessions: [{ tool: 'claude', id: session }] } });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBe(snapshot);
    await forget(alice.checkout, session);
    await claimsAndResumes(await acme.member('bob'), runId, session);
  });

  it('files a session whose workspace copy is gone under the repository the run works in', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    const copy = fs.mkdtempSync(path.join(path.dirname(alice.checkout), 'copy-'));
    const session = await claudeSession(copy, 'Found two problems.');
    fs.rmSync(copy, { recursive: true });
    await reviewed(alice, runId, session);

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({ ok: true });

    await forget(copy, session);
    await claimsAndResumes(await acme.member('bob'), runId, session);
  });

  it('restores a session archived after this machine last pulled, and leaves the team clone as it is', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'Found two problems.');
    await reviewed(alice, runId, session);
    const clone = git(bob.config.repo.localPath, 'rev-parse', 'HEAD');

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({ ok: true });

    await forget(alice.checkout, session);
    await claimsAndResumes(bob, runId, session);
    expect(git(bob.config.repo.localPath, 'rev-parse', 'HEAD')).toBe(clone);
  });

  it('fetches the default-branch archive once per run for sessions teamai-reports lacks, and starts new sessions from the team clone saying why when that fetch fails', async () => {
    const SPLIT = `schemaVersion: v1alpha1
name: split
description: Two steps that continue the plan's session.
steps:
  - id: plan
    prompt: Plan the change.
  - id: build
    needs: [plan]
    prompt: Build it.
    session: { from: plan }
  - id: check
    needs: [build]
    prompt: Check it.
    session: { from: plan }
`;
    const acme = team({ split: SPLIT });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'split');
    const session = await claudeSession(alice.checkout, 'Planned it.');
    await reviewed(alice, runId, session);
    await archiveOnDefaultBranch(alice, session);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    await forget(alice.checkout, session);
    bob.config.workflows = { tools: { default: 'claude' } };
    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true });
    const clone = git(bob.config.repo.localPath, 'rev-parse', 'HEAD');
    // git holds this lock while it moves the ref, so a fetch into it fails until it is gone.
    const lock = path.join(bob.config.repo.localPath, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    fs.writeFileSync(lock, '');
    const warn = vi.spyOn(log, 'warn');
    const resumed: Array<string | undefined> = [];
    const tool: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_name, input) => {
        resumed.push(input.resume);
        fs.rmSync(lock, { force: true });
        return { started: true as const, exitCode: 0 };
      }),
    };

    expect(await runLocalDriver(bob.config, runId, bob.checkout, { adapter: tool, hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

    expect(resumed).toEqual([undefined, undefined]);
    const fresh = warn.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('starts a new claude session'));
    expect(fresh).toEqual([
      expect.stringMatching(/^Step "build" .*Fetching the archive from origin failed.*main\.lock/s),
      expect.stringMatching(/^Step "check" .*Fetching the archive from origin failed.*main\.lock/s),
    ]);
    expect(git(bob.config.repo.localPath, 'rev-parse', 'HEAD')).toBe(clone);
  });

  it('refuses a member who no longer owns the run before it pins a base, archives a session, or publishes a record', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'review');
    await reviewed(alice, runId, await claudeSession(alice.checkout, 'Found two problems.'));
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    const claimed = await claimRun(bob.config, runId, { checkout: bob.checkout });
    // Gone from the business origin, so a publish that got as far as the origin check would pin it again.
    git(alice.checkout, 'push', '-q', 'origin', '--delete', `teamai/${runId}/base`);
    const run = await readRun(alice.config, runId);
    if (typeof run !== 'object') throw new Error('run was not stored');
    await queueRunRecord(alice.config, run, alice.driver, 'end', {});
    const refs = git(acme.business, 'for-each-ref');
    const archive = (): string => execFileSync('git', ['--git-dir', acme.origin, 'ls-tree', '-r', '--name-only', 'main', 'sessions'], { encoding: 'utf8' });

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({
      ok: false,
      error: { code: 'not_owner', owner: claimed.ok ? claimed.value.owner : {} },
    });
    expect(git(acme.business, 'for-each-ref')).toBe(refs);
    expect(archive()).toBe('');
    expect((await pendingRecords(alice.config)).map((record) => record.run)).toEqual([runId]);
  });

  it('refuses to publish when a session a step continues cannot be read here, and publishes nothing', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    await reviewed(alice, runId, 'gone-session');

    const published = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });

    expect(published).toMatchObject({
      ok: false,
      error: { code: 'sessions_not_archived', message: expect.stringMatching(/^Run r[0-9a-f]+ was not published: .*gone-session.*publish without --sessions/) },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('refuses to publish when no session of a chain a step continues can be read here, and lists each one it could not read', async () => {
    const acme = team({ review: REVIEW_CHAIN });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    await reviewed(alice, runId, 'gone-1');
    await reviewed(alice, runId, 'gone-2', { tool: 'claude', id: 'gone-1' });

    const published = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });

    expect(published).toMatchObject({
      ok: false,
      error: { code: 'sessions_not_archived', message: expect.stringMatching(/gone-2.*gone-1.*publish without --sessions/) },
    });
    expect(originFile(acme.origin, `workflows/runs/${runId}/state.json`)).toBeNull();
  });

  it('archives the newest session of a chain this machine can read, and lists the newer one it skipped', async () => {
    const acme = team({ review: REVIEW_CHAIN });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'Found two problems.');
    await reviewed(alice, runId, session);
    await reviewed(alice, runId, 'copy-1', { tool: 'claude', id: session });

    const published = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });

    expect(published).toMatchObject({
      ok: true,
      value: { publication: 'published', sessions: [{ tool: 'claude', id: session }], skipped: [{ tool: 'claude', id: 'copy-1' }] },
    });
    const archived = execFileSync('git', ['--git-dir', acme.origin, 'ls-tree', '-r', '--name-only', 'teamai-reports', 'sessions'], { encoding: 'utf8' })
      .split('\n').filter((file) => file.endsWith('.jsonl'));
    expect(archived).toHaveLength(1);
  });

  it('publishes a chain this machine cannot read when the archive already holds one of its sessions', async () => {
    const acme = team({ review: REVIEW_CHAIN });
    const alice = await acme.member('alice');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'Found two problems.');
    await reviewed(alice, runId, session);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({ ok: true });
    await reviewed(alice, runId, 'copy-1', { tool: 'claude', id: session });
    await forget(alice.checkout, session);

    const published = await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions });

    expect(published).toMatchObject({
      ok: true,
      value: { publication: 'published', sessions: [{ tool: 'claude', id: session }], skipped: [{ tool: 'claude', id: 'copy-1' }] },
    });
  });

  it('archives on teamai-reports for a team that keeps its workflows in the business repository', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-handoff-self-')));
    dirs.push(root);
    const seed = path.join(root, 'seed');
    const origin = path.join(root, 'product.git');
    fs.mkdirSync(path.join(seed, '.teamai', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.teamai', 'workflows', 'review.yaml'), REVIEW);
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
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'Found two problems.');
    await reviewed(alice, runId, session);
    const stale = await reportsBranch.ensureReportsWorktree(bob.config, { pushIfCreated: false });
    const lock = path.join(alice.config.dataHome ?? '', '.reports-lock');
    const write = reportsBranch.updateReports;
    // Another process takes the reports lock once publish has read who owns the run.
    vi.spyOn(reportsBranch, 'updateReports').mockImplementationOnce(async (config, change) => {
      const read = await write(config, change);
      expect(await acquireLock(lock)).toBe(true);
      return read;
    });
    try {
      expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({
        ok: false, error: { code: 'sessions_not_archived', message: expect.stringContaining('did not reach the team session archive (another teamai process is writing teamai-reports). Publish again,') },
      });
    } finally {
      await releaseLock(lock);
    }

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions }))
      .toMatchObject({ ok: true, value: { sessions: [{ tool: 'claude', id: session }] } });
    const archived = execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'teamai-reports', 'sessions'], { encoding: 'utf8' });
    expect(archived).toMatch(/\.jsonl$/m);
    expect(execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' })).not.toContain('sessions/');
    expect(fs.existsSync(path.join(stale, 'sessions'))).toBe(false);
    await forget(alice.checkout, session);
    await claimsAndResumes(bob, runId, session);
  });
});

describe('a run taken back on the machine that worked on it', () => {
  it('refuses to continue a copy at the recorded commit that has changes, and pushes none of them', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });
    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const dir = worktreePath(alice.checkout, wrote.branch);
    expect(git(alice.checkout, 'rev-parse', wrote.branch)).toBe(wrote.commit);
    fs.writeFileSync(path.join(dir, 'abandoned.txt'), 'left by an attempt that never reported\n');

    expect(await runLocalDriver(alice.config, runId, alice.checkout, { hitl: false })).toMatchObject({
      error: { code: 'branch_diverged', message: expect.stringContaining(dir) },
    });
    expect(git(dir, 'status', '--porcelain')).toBe('?? abandoned.txt');
    expect(originRef(acme.business, `refs/heads/${wrote.branch}`)).toBe(wrote.commit);
    expect(await readRun(alice.config, runId)).toMatchObject({ publication: { reconcileCopies: true } });
  });

  it('brings a copy that next takes back with claim to the commit the other machine recorded, as a resume does', async () => {
    const acme = team({ ship: SHIP });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'ship');
    const wrote = await work(alice, runId, 'write.txt');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });
    const more = await work(bob, runId, 'more.txt');
    await publishRun(bob.config, runId, { env: {}, checkout: bob.checkout });

    expect(await leaseNext(alice.config, runId, alice.driver, { claim: true, can: { workspace: [...WORKSPACES] } })).toMatchObject({ data: { lease: { step: 'change.last' } } });
    expect(git(alice.checkout, 'rev-parse', wrote.branch)).toBe(more.commit);
    const run = await readRun(alice.config, runId);
    expect(typeof run === 'object' && run.publication).not.toHaveProperty('reconcileCopies');
  });
});

describe('the session archive a claimed run restores from', () => {
  const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review again in the same session.
steps:
  - id: review
    prompt: Review this project.
    session: continue
    loop: { back_to: review, while: "length(steps.review.passes) < 2", max_iterations: 2 }
`;

  /** Writes Claude Code session `id` in `cwd` with one assistant answer per entry of `answers`, and returns the id it got. */
  async function claudeSession(cwd: string, id: string, replies: string[]): Promise<string> {
    fs.mkdirSync(path.join(os.homedir(), '.claude', 'projects'), { recursive: true });
    return getAdapter('claude-code').writeSession({
      sessionId: id,
      title: 'Review this project',
      cwd,
      platform: 'claude-code',
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: `2026-10-01T10:0${replies.length}:00.000Z`,
      messages: [
        { role: 'user', timestamp: '2026-10-01T10:00:00.000Z', content: [{ type: 'text', text: 'Review this project.' }] },
        ...replies.map((text, index) => ({ role: 'assistant' as const, timestamp: `2026-10-01T10:0${index + 1}:00.000Z`, content: [{ type: 'text' as const, text }] })),
      ],
      metadata: {},
    }, cwd);
  }

  async function reviewed(member: Member, runId: string, session: string): Promise<void> {
    const next = await leaseNext(member.config, runId, member.driver);
    if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
    const lease = next.data.lease as { attempt: string; revision: number };
    const reported = await reportAttempt(member.config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: member.driver, tool: 'claude', session,
    });
    if ('error' in reported) throw new Error(reported.error.message);
  }

  /** Claims the run as `member` and drives it with a tool that records the session each step resumes. */
  async function claimAndDrive(member: Member, runId: string): Promise<Array<string | undefined>> {
    member.config.workflows = { tools: { default: 'claude' } };
    expect(await claimRun(member.config, runId, { checkout: member.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const resumed: Array<string | undefined> = [];
    const tool: LocalToolAdapter = {
      runInteractive: vi.fn(),
      run: vi.fn(async (_name, input) => {
        resumed.push(input.resume);
        return { started: true as const, exitCode: 0 };
      }),
    };
    expect(await runLocalDriver(member.config, runId, member.checkout, { adapter: tool, hitl: false })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    return resumed;
  }

  /** Removes the member's own copy of `session`, as on a machine that never ran it. */
  async function forget(cwd: string, session: string): Promise<void> {
    const listed = (await getAdapter('claude-code').listConversations(cwd)).find((meta) => meta.sessionId === session);
    fs.rmSync(listed?.filePath ?? '');
  }

  async function answers(sessionId: string | undefined): Promise<string[]> {
    const found = await AgentSession.find({ platform: 'claude-code', sessionId: sessionId ?? '' }, { scrub: false });
    if (found.status !== 'done') throw new Error(found.failure.message);
    return found.session.messages.filter((message) => message.role === 'assistant')
      .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])));
  }

  it('resumes the version origin holds of a session archived again under the same id, and leaves the team clone as it is', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'review-a', ['Found two problems.']);
    await reviewed(alice, runId, session);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({ ok: true });
    await pull(bob);
    await claudeSession(alice.checkout, 'review-a', ['Found two problems.', 'The second one is in the parser.']);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions })).toMatchObject({ ok: true });
    await forget(alice.checkout, session);
    const clone = git(bob.config.repo.localPath, 'rev-parse', 'HEAD');

    const resumed = await claimAndDrive(bob, runId);

    expect(await answers(resumed[0])).toEqual(['Found two problems.', 'The second one is in the parser.']);
    expect(git(bob.config.repo.localPath, 'rev-parse', 'HEAD')).toBe(clone);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('teamai-sessions-'))).toEqual([]);
  });

  it('restores a session another machine archived on the default branch before sessions moved to teamai-reports', async () => {
    const acme = team({ review: REVIEW });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'review');
    const session = await claudeSession(alice.checkout, 'review-a', ['Found two problems.']);
    await reviewed(alice, runId, session);
    await archiveOnDefaultBranch(alice, session);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    await forget(alice.checkout, session);

    const resumed = await claimAndDrive(bob, runId);

    expect(await answers(resumed[0])).toEqual(['Found two problems.']);
    expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('teamai-sessions-'))).toEqual([]);
  });

  /** Runs `work` as on `member`'s own machine: its tools keep their sessions under a home of its own. */
  async function on<T>(member: Member, task: () => Promise<T>): Promise<T> {
    const home = path.join(path.dirname(member.checkout), 'home');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    vi.stubEnv('HOME', home);
    try {
      return await task();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  /** Adds an assistant turn saying `text` to Claude Code session `id` in `cwd`, as `claude --resume <id>` does. */
  async function addTurn(cwd: string, id: string, text: string): Promise<void> {
    const listed = (await getAdapter('claude-code').listConversations(cwd)).find((meta) => meta.sessionId === id);
    if (!listed?.filePath) throw new Error(`no session ${id} in ${cwd}`);
    const records = fs.readFileSync(listed.filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = records.findLast((record) => record.type === 'user' || record.type === 'assistant');
    const turn = {
      parentUuid: last?.uuid ?? null, isSidechain: false, type: 'assistant', uuid: `turn-${text.length}-${Date.now()}`,
      message: { role: 'assistant', content: [{ type: 'text', text }], model: 'claude-sonnet' },
      timestamp: new Date().toISOString(), cwd, sessionId: id,
    };
    fs.appendFileSync(listed.filePath, `${JSON.stringify(turn)}\n`);
  }

  /** What a Claude Code stand-in saw: the prompt, and the answers of the session it resumed, if any. */
  interface Seen { prompt: string; history: string[] }

  /**
   * A Claude Code stand-in that answers each prompt with `replies[prompt]`: in the session it resumes, as Claude Code
   * does, or in a session of its own. It reports the session it ran in.
   */
  function claudeTool(replies: Record<string, string>, seen: Seen[]): LocalToolAdapter {
    return {
      runInteractive: vi.fn(),
      run: vi.fn(async (_name, input) => {
        const answer = replies[input.prompt] ?? 'Done.';
        const history = input.resume ? await answers(input.resume) : [];
        seen.push({ prompt: input.prompt, history });
        if (input.resume) await addTurn(input.cwd, input.resume, answer);
        const session = input.resume ?? await claudeSession(input.cwd, `fresh-${seen.length}`, [answer]);
        return { started: true as const, exitCode: 0, session };
      }),
    };
  }

  /**
   * Drives the run on `member`'s machine until it asks for an approval nobody there gives. With `approve`, the first
   * approval it asks for is given, so the step behind it runs here.
   */
  async function driveHere(member: Member, runId: string, tool: LocalToolAdapter, approve: boolean): Promise<WorkflowEnvelope> {
    member.config.workflows = { tools: { default: 'claude' } };
    let asked = 0;
    const question = async (): Promise<string> => {
      asked += 1;
      if (approve && asked === 1) return 'yes';
      throw new Error('nobody approves on this machine');
    };
    return runLocalDriver(member.config, runId, member.checkout, { adapter: tool, hitl: true, question });
  }

  const SPLIT = `schemaVersion: v1alpha1
name: split
description: Steps that continue the plan's session, each approved on the machine that runs it.
steps:
  - id: plan
    prompt: Plan the change.
  - id: build
    needs: [plan]
    approve: Build it here?
    prompt: Build it.
    session: { from: plan }
  - id: check
    needs: [build]
    approve: Check it here?
    prompt: Check it.
    session: { from: plan }
  - id: final
    needs: [check]
    approve: Wrap it up here?
    prompt: Wrap it up.
    session: { from: plan }
`;
  const SPLIT_ANSWERS = { 'Plan the change.': 'Planned it.', 'Build it.': 'Built it.', 'Check it.': 'Checked it.', 'Wrap it up.': 'Wrapped it up.' };

  // Three handovers run about 330 git processes, which took up to 16.5 s on a macOS CI runner.
  it('continues the plan\'s session with every turn a step added on either machine, when the run goes back and forth', async () => {
    const acme = team({ split: SPLIT });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await startIn(alice, 'split');
    const seen: Seen[] = [];
    const tool = claudeTool(SPLIT_ANSWERS, seen);
    const handOver = async (from: Member, to: Member, approve: boolean): Promise<void> => {
      expect(await on(from, () => publishRun(from.config, runId, { env: {}, checkout: from.checkout, sessions: resumableSessions }))).toMatchObject({ ok: true });
      expect(await on(to, () => claimRun(to.config, runId, { checkout: to.checkout }))).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
      const driven = await on(to, () => driveHere(to, runId, tool, approve));
      if (!('data' in driven)) expect(driven).toMatchObject({ error: { code: 'interrupted' } });
    };

    expect(await on(alice, () => driveHere(alice, runId, tool, false))).toMatchObject({ error: { code: 'interrupted' } });
    await handOver(alice, bob, true);
    await handOver(bob, alice, true);
    await handOver(alice, bob, true);

    expect(seen.map(({ prompt, history }) => [prompt, history])).toEqual([
      ['Plan the change.', []],
      ['Build it.', ['Planned it.']],
      ['Check it.', ['Planned it.', 'Built it.']],
      ['Wrap it up.', ['Planned it.', 'Built it.', 'Checked it.']],
    ]);
    expect(await readRun(bob.config, runId)).toMatchObject({ status: 'succeeded' });
  }, 60_000);

  it('resumes the session a copy continued when the copy was never archived, rather than starting a new one', async () => {
    const acme = team({ split: SPLIT });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const carol = await acme.member('carol');
    const runId = await startIn(alice, 'split');
    const seen: Seen[] = [];
    const tool = claudeTool(SPLIT_ANSWERS, seen);

    expect(await on(alice, () => driveHere(alice, runId, tool, false))).toMatchObject({ error: { code: 'interrupted' } });
    expect(await on(alice, () => publishRun(alice.config, runId, { env: {}, checkout: alice.checkout, sessions: resumableSessions }))).toMatchObject({ ok: true });
    expect(await on(bob, () => claimRun(bob.config, runId, { checkout: bob.checkout }))).toMatchObject({ ok: true });
    expect(await on(bob, () => driveHere(bob, runId, tool, true))).toMatchObject({ error: { code: 'interrupted' } });
    expect(await on(bob, () => publishRun(bob.config, runId, { env: {}, checkout: bob.checkout }))).toMatchObject({ ok: true });
    expect(await on(carol, () => claimRun(carol.config, runId, { checkout: carol.checkout }))).toMatchObject({ ok: true });
    expect(await on(carol, () => driveHere(carol, runId, tool, true))).toMatchObject({ error: { code: 'interrupted' } });

    expect(seen.map(({ prompt, history }) => [prompt, history])).toEqual([
      ['Plan the change.', []],
      ['Build it.', ['Planned it.']],
      ['Check it.', ['Planned it.']],
    ]);
  });
});

describe('settledSteps', () => {
  const definition: WorkflowDefinition = {
    schemaVersion: 'v1alpha1', name: 'w', description: 'w',
    steps: [{
      id: 'items', forEach: { items: 'inputs.list' },
      workflow: { steps: [{ id: 'approve', command: 'true' }, { id: 'review', needs: ['approve'], workflow: { steps: [{ id: 'approve', command: 'true' }] } }] },
    }],
  };
  const settled = (steps: Array<{ id: string; status: string }>) => settledSteps({ steps, definition });

  it('lists a step inside for_each items by its definition path once every item settled it or settled whole', () => {
    const items = (statuses: string[]) => [
      { id: 'items', status: 'running' },
      ...statuses.map((status, index) => ({ id: `items[${index}]`, status: status === 'skipped' ? 'skipped' : 'running' })),
      ...statuses.flatMap((status, index) => (status === 'skipped' || status === 'unstarted' ? [] : [{ id: `items[${index}].approve`, status }])),
    ];
    expect(settled(items(['succeeded', 'succeeded']))).toContain('items.approve');
    expect(settled(items(['succeeded', 'skipped']))).toContain('items.approve');
    expect(settled(items(['succeeded', 'pending']))).not.toContain('items.approve');
    expect(settled(items(['succeeded', 'unstarted']))).not.toContain('items.approve');
    expect(settled([{ id: 'a', status: 'running' }, { id: 'a[0]', status: 'running' }, { id: 'a[0].b[0].c', status: 'succeeded' }])).not.toContain('a.b.c');
  });

  it('counts a step inside an item settled when the item settled a step that holds it', () => {
    const steps = [
      { id: 'items', status: 'running' },
      { id: 'items[0]', status: 'running' },
      { id: 'items[0].review', status: 'skipped' },
      { id: 'items[1]', status: 'running' },
      { id: 'items[1].review', status: 'running' },
      { id: 'items[1].review.approve', status: 'succeeded' },
    ];
    expect(settled(steps)).toContain('items.review.approve');
    expect(settled(steps)).not.toContain('items.review');
  });

  it('settles nothing while a loop could run a settled step again', () => {
    const looping: WorkflowDefinition = { ...definition, steps: [{ id: 'review', command: 'true' }, { id: 'fix', needs: ['review'], command: 'true', loop: { backTo: 'review', maxIterations: 2 } }] };
    expect(settledSteps({ steps: [{ id: 'review', status: 'succeeded' }], definition: looping })).toEqual([]);
    const inline: WorkflowDefinition = { ...definition, steps: [{ id: 'sub', workflow: { loop: { maxIterations: 2 }, steps: [{ id: 'review', command: 'true' }] } }] };
    expect(settledSteps({ steps: [{ id: 'sub.review', status: 'succeeded' }], definition: inline })).toEqual([]);
  });

  it('settles a step once no loop that reaches it can run again', () => {
    const looping: WorkflowDefinition = {
      ...definition,
      steps: [
        { id: 'sub', workflow: { loop: { maxIterations: 2 }, steps: [{ id: 'draft', command: 'true' }] } },
        { id: 'review', needs: ['sub'], command: 'true' },
        { id: 'fix', needs: ['review'], command: 'true', loop: { backTo: 'review', maxIterations: 2 } },
        { id: 'gate', needs: ['fix'], command: 'true' },
        { id: 'final', needs: ['gate'], command: 'true' },
      ],
    };
    const of = (fix: { status: string; loopFinal?: boolean }) => settledSteps({
      definition: looping,
      steps: [
        { id: 'sub', status: 'succeeded' }, { id: 'sub.draft', status: 'succeeded' }, { id: 'review', status: 'succeeded' },
        { id: 'fix', ...fix }, { id: 'gate', status: 'succeeded' }, { id: 'final', status: 'running' },
      ],
    });
    expect(of({ status: 'succeeded', loopFinal: true })).toEqual(expect.arrayContaining(['sub', 'sub.draft', 'review', 'fix', 'gate']));
    expect(of({ status: 'running' })).toEqual(expect.arrayContaining(['sub', 'sub.draft', 'gate']));
    expect(of({ status: 'running' })).not.toContain('review');
    expect(of({ status: 'succeeded' })).not.toContain('review');
  });
});

describe('offering a run to a runner (#1390)', () => {
  /** Names `url` as the origin of each member's business checkout, which a run with no workspace never reaches. */
  function originAt(url: string, members: Member[]): void {
    for (const { checkout } of members) git(checkout, 'remote', 'set-url', 'origin', url);
  }

  it('offers a running run it publishes, under its business repository, and a claim takes the offer away with the ownership', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    originAt('https://github.com/acme/app.git', [alice, bob]);
    const runId = await start(alice);
    await runStep(alice, runId);

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', offered: true } });
    const offered = JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}');
    expect(offered).toMatchObject({ owner: { user: 'alice' }, offered: { at: expect.any(String) }, repository: 'github.com/acme/app' });

    expect(await claimRun(bob.config, runId, { checkout: bob.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const claimed = JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}');
    expect(claimed).toMatchObject({ owner: { user: 'bob' }, repository: 'github.com/acme/app' });
    expect(claimed).not.toHaveProperty('offered');
  });

  it('offers no run it publishes from a checkout with no origin, since no runner could tell which repository it works in', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    git(alice.checkout, 'remote', 'remove', 'origin');
    const runId = await start(alice);
    await runStep(alice, runId);

    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', offered: false } });
    const published = JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}');
    expect(published).toMatchObject({ owner: { user: 'alice' } });
    expect(published).not.toHaveProperty('offered');
    expect(published).not.toHaveProperty('repository');
  });

  it('refuses a next of the earlier owner once its reports checkout shows another install claimed the run', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runId = await start(alice);
    await runStep(alice, runId);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });

    // A pull fetches teamai-reports, so alice's checkout then shows bob's claim.
    await reportsBranch.readableReportsWorktree(alice.config);
    const next = await leaseNext(alice.config, runId, alice.driver);
    expect(next).toMatchObject({ error: { code: 'not_owner', owner: { user: 'bob' } } });
    expect(await readRun(alice.config, runId)).toMatchObject({ steps: [{ id: 'one', status: 'succeeded' }, { id: 'two', status: 'pending' }] });
  });

  it('lets one of two runners that take the same offered run at once claim it, and the other gets state_moved', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runners = [await acme.member('runner-1'), await acme.member('runner-2')];
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const taken = await Promise.all(runners.map((runner) => claimOffered(runner.config, runId, { checkout: runner.checkout })));
    expect(taken.filter((claim) => claim.ok)).toHaveLength(1);
    expect(taken.filter((claim) => !claim.ok)).toMatchObject([{ error: { code: 'state_moved' } }]);
    const winner = runners[taken.findIndex((claim) => claim.ok)];
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ owner: { user: winner?.config.username }, stateRevision: 2 });
  });

  it('claims no run that is no longer offered, though any claim could take it over', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const runner = await acme.member('runner');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, runId, { checkout: bob.checkout });

    expect(await claimOffered(runner.config, runId, { checkout: runner.checkout })).toMatchObject({ ok: false, error: { code: 'state_moved' } });
    expect(await readRun(runner.config, runId)).toBe('missing');
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ owner: { user: 'bob' } });
  });

  it('takes the offer away when its owner resumes the run, so no runner takes a run its owner drives, and offers it again on the next publish', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect(await resumeRun(alice.config, runId, { claim: false, checkout: alice.checkout })).toMatchObject({ ok: true, value: { ownership: 'already_owned' } });
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).not.toHaveProperty('offered');
    expect(await claimOffered(runner.config, runId, { checkout: runner.checkout })).toMatchObject({ ok: false, error: { code: 'state_moved' } });

    await runStep(alice, runId);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true, value: { publication: 'published', offered: true } });
    expect(await claimOffered(runner.config, runId, { checkout: runner.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
  });

  const RELEASE = `schemaVersion: v1alpha1
name: release
description: Build, then ship once a person approves.
steps:
  - id: build
    command: echo build
  - id: ship
    needs: [build]
    approve: { message: Ship it?, required: true }
    command: echo ship
`;

  /** A process that runs teamai in a CI job, with no agent session: unattended unless `mode` says otherwise. */
  function runnerTaker(mode: 'attended' | 'unattended' = 'unattended', { sandbox = false } = {}) {
    return { caller: { evidence: { kind: 'none' as const }, confirmed: false, mode }, driver: 'local' as const, tools: {}, sandbox, hasPerson: false };
  }

  /** What `member` reads of teamai-reports after a pull. */
  async function publishedRuns(member: Member, taker: Taker = runnerTaker(), env: NodeJS.ProcessEnv = {}) {
    await reportsBranch.readableReportsWorktree(member.config);
    return PublishedRuns.list(member.config, { taker, env: await resolveWorkflowEnv(member.config, env) });
  }

  it('lists an offered run whose step left has a required approval as needing a person, which a runner no person attends does not take', async () => {
    const acme = team({ release: RELEASE });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'release', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    expect(await runStep(alice, runId)).toBe('build');
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const runs = await publishedRuns(runner);
    expect(runs).toEqual([expect.objectContaining({
      run: runId, workflow: 'release', owner: expect.objectContaining({ user: 'alice' }), repository: 'github.com/acme/app',
      offer: { at: expect.any(String), needs: ['only a person can answer the approval at ship'], mayNeed: ['ship'], uses: { env: [], prompts: [] }, lacks: [] },
    })]);
    const self = (await installOwner(runner.config)).id;
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: false, self })).toEqual([]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: true, self }).map((run) => run.run)).toEqual([runId]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/other', hasPerson: true, self })).toEqual([]);
  });

  const SHIP_ISSUE = `schemaVersion: v1alpha1
name: ship-issue
description: Build, and pair with a person only when the run is stuck and someone picks pair.
steps:
  - id: build
    command: echo build
  - id: stuck
    needs: [build]
    choose: { message: Stuck?, options: [give-up, pair], default: give-up }
  - id: pair
    needs: [stuck]
    if: steps.stuck.choice == 'pair'
    approve: { message: Pair now?, required: true }
    command: echo pair
`;

  it('lets a runner take an offered run whose person step only a choice can reach, and finish it under --auto-approve', async () => {
    const acme = team({ 'ship-issue': SHIP_ISSUE });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'ship-issue', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const runs = await publishedRuns(runner, { ...runnerTaker(), autoApprove: true });
    expect(runs.map((run) => run.offer && { needs: run.offer.needs, mayNeed: run.offer.mayNeed })).toEqual([{ needs: [], mayNeed: ['pair'] }]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: false, self: (await installOwner(runner.config)).id }).map((run) => run.run)).toEqual([runId]);

    expect(await claimOffered(runner.config, runId, { checkout: runner.checkout })).toMatchObject({ ok: true });
    vi.stubEnv('TEAMAI_MODE', 'unattended');
    try {
      expect(await runLocalDriver(runner.config, runId, runner.checkout, { hitl: false, autoApprove: true })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await readRun(runner.config, runId)).toMatchObject({ steps: [{ id: 'build', status: 'succeeded' }, { id: 'stuck', answer: { choice: 'give-up', channel: 'auto_approve' } }, { id: 'pair', status: 'skipped' }] });
  });

  it('lets an unattended skill session take an offered run whose person step is not ready yet, and leaves one handed back at a required approval', async () => {
    // An agent session takes only a workflow that allows it.
    const allowed = (yaml: string) => yaml.replace('\nsteps:', '\ninvoke: allow\nsteps:');
    const acme = team({ 'ship-issue': allowed(SHIP_ISSUE), release: allowed(RELEASE) });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const skill = { caller: { evidence: { kind: 'skill-driver' as const }, confirmed: false, mode: 'unattended' as const }, driver: 'skill' as const, hasPerson: false };
    const later = await startRun(alice.config, 'ship-issue', {}, { secrets: {} });
    const laterId = 'data' in later ? String(later.data.run) : '';
    await publishRun(alice.config, laterId, { env: {}, checkout: alice.checkout });
    const handed = await startRun(alice.config, 'release', {}, { secrets: {} });
    const handedId = 'data' in handed ? String(handed.data.run) : '';
    expect(await runStep(alice, handedId)).toBe('build');
    await publishRun(alice.config, handedId, { env: {}, checkout: alice.checkout });

    const runs = await publishedRuns(runner, skill);
    expect(runs.map((run) => [run.run, run.offer?.needs, run.offer?.mayNeed])).toEqual([
      [laterId, [], ['pair']], [handedId, ['only a person can answer the approval at ship'], ['ship']],
    ]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: false, self: (await installOwner(runner.config)).id }).map((run) => run.run)).toEqual([laterId]);
  });

  it('says a choice with a default may need a person for a runner without --auto-approve, and not for one with it', async () => {
    const acme = team({ 'ship-issue': SHIP_ISSUE });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'ship-issue', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect((await publishedRuns(runner)).map((run) => run.offer?.mayNeed)).toEqual([['stuck', 'pair']]);
    expect((await publishedRuns(runner, { ...runnerTaker(), autoApprove: true })).map((run) => run.offer?.mayNeed)).toEqual([['pair']]);
  });

  it('hands a run that reaches a required approval unattended to a person on teamai-reports: a second runner leaves it, and a person claims and finishes it', async () => {
    const acme = team({ release: RELEASE });
    const ci = await acme.member('ci');
    const runner = await acme.member('runner');
    const alice = await acme.member('alice');
    onGitHub(acme.business, [ci, runner, alice]);
    const runId = await startIn(ci, 'release');
    const info = vi.spyOn(log, 'info');

    vi.stubEnv('TEAMAI_MODE', 'unattended');
    try {
      expect(await runLocalDriver(ci.config, runId, ci.checkout, { hitl: false })).toEqual({
        data: { handoff: { run: runId, steps: ['ship'], resume: `teamai workflow resume ${runId} --claim` } },
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(info).toHaveBeenCalledWith(`Step "ship" needs a person, so run ${runId} is offered on teamai-reports. A person continues it with: teamai workflow resume ${runId} --claim`);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({
      owner: { user: 'ci' }, offered: { at: expect.any(String) }, steps: [{ id: 'build', status: 'succeeded' }, { id: 'ship', status: 'waiting' }],
    });

    const runs = await publishedRuns(runner);
    expect(runs.map((run) => run.offer?.needs)).toEqual([['only a person can answer the approval at ship']]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: false, self: (await installOwner(runner.config)).id })).toEqual([]);

    expect(await claimRun(alice.config, runId, { checkout: alice.checkout })).toMatchObject({ ok: true, value: { ownership: 'claimed' } });
    const question = vi.fn(async () => 'yes');
    expect(await runLocalDriver(alice.config, runId, alice.checkout, { hitl: true, question })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(question).toHaveBeenCalledTimes(1);
    expect(JSON.parse(originFile(acme.origin, `workflows/runs/${runId}/state.json`) ?? '{}')).toMatchObject({ owner: { user: 'alice' }, status: 'succeeded' });
  });

  const SIGN = `schemaVersion: v1alpha1
name: sign
description: Build, then sign with the release key.
steps:
  - id: build
    command: echo build
  - id: sign
    needs: [build]
    requires: { env: [SIGNING_KEY] }
    command: echo sign
`;

  it('lists an offered run whose steps left require env with no value here as lacking it, which no runner here takes', async () => {
    const acme = team({ sign: SIGN });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'sign', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    const runs = await publishedRuns(runner);
    expect(runs).toEqual([expect.objectContaining({
      run: runId, offer: { at: expect.any(String), needs: [], mayNeed: [], uses: { env: ['SIGNING_KEY'], prompts: [] }, lacks: [{
        reason: 'sign requires env SIGNING_KEY, which has no value here', fix: 'set SIGNING_KEY in the environment, or declare it in the team repo with teamai env add SIGNING_KEY --secret and give it a value with teamai env set SIGNING_KEY',
      }] },
    })]);
    const self = (await installOwner(runner.config)).id;
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: true, self })).toEqual([]);

    const keyed = await publishedRuns(runner, runnerTaker(), { SIGNING_KEY: 'k' });
    expect(keyed[0]?.offer).toMatchObject({ lacks: [] });
    expect(PublishedRuns.candidates(keyed, { repository: 'github.com/acme/app', hasPerson: false, self }).map((run) => run.run)).toEqual([runId]);
  });

  const DOCS = `schemaVersion: v1alpha1
name: docs
description: Build, then write the release notes.
steps:
  - id: build
    command: echo build
  - id: notes
    needs: [build]
    prompt: Write the release notes.
`;

  it('lists an offered run whose prompt steps left have no tool here as lacking one, which the skill driver, running them in its session, does not', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', '');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const acme = team({ docs: DOCS });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'docs', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect((await publishedRuns(runner))[0]?.offer?.lacks).toEqual([{
      reason: 'no tool is configured here for the prompt step notes', fix: 'pass --tools default=<tool>, or set workflows.tools.default',
    }]);
    const skill = { caller: { evidence: { kind: 'skill-driver' as const }, confirmed: false, mode: 'attended' as const }, driver: 'skill' as const, hasPerson: true };
    expect((await publishedRuns(runner, skill))[0]?.offer?.lacks).toEqual([]);
  });

  it('lists an offered run whose steps left need a sandbox as lacking --sandbox on a machine that does not declare one, which no runner there takes', async () => {
    const acme = team({ sealed: `schemaVersion: v1alpha1
name: sealed
description: A build that runs only on a sandbox.
steps:
  - id: build
    requires: { isolation: sandbox, strict: true }
    command: echo build
` });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'sealed', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });
    const self = (await installOwner(runner.config)).id;

    const runs = await publishedRuns(runner);
    expect(runs[0]?.offer?.lacks).toEqual([{
      reason: 'build needs a sandbox, which this machine does not declare',
      fix: 'pass --sandbox on a disposable host, such as a CI runner or a container, or set workflows.sandbox: true',
    }]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: false, self })).toEqual([]);
    expect((await publishedRuns(runner, runnerTaker('unattended', { sandbox: true })))[0]?.offer?.lacks).toEqual([]);
  });

  it('names one --tools default=<tool> for every prompt step left with no tool configured here, whichever agent each runs', async () => {
    vi.stubEnv('TEAMAI_AI_TOOL', '');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const acme = team({ docs: `${DOCS}    agent: writer
  - id: review
    needs: [notes]
    agent: reviewer
    prompt: Review the release notes.
` });
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const started = await startRun(alice.config, 'docs', {}, { secrets: {} });
    const runId = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect((await publishedRuns(runner))[0]?.offer?.lacks).toEqual([{
      reason: 'no tool is configured here for the prompt steps notes and review', fix: 'pass --tools default=<tool>, or set workflows.tools.default',
    }]);
  });

  it('lets a runner with no agent session take an offered run of an invoke: deny workflow, and refuses it to the skill driver', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const runner = await acme.member('runner');
    originAt('https://github.com/acme/app.git', [alice, runner]);
    const runId = await start(alice);
    await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout });

    expect(await publishedRuns(runner)).toMatchObject([{ run: runId, offer: { needs: [] } }]);
    expect((await publishedRuns(runner))[0]?.offer).not.toHaveProperty('refusal');
    const skill = { caller: { evidence: { kind: 'skill-driver' as const }, confirmed: false, mode: 'unattended' as const }, driver: 'skill' as const, hasPerson: false };
    expect(await publishedRuns(runner, skill)).toMatchObject([{ run: runId, offer: { refusal: { code: 'invoke_denied' } } }]);
  });

  it('lists a claimed run as held by the install that claimed it, after the offered ones', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    const held = await start(alice);
    await publishRun(alice.config, held, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, held, { checkout: bob.checkout });
    const offered = await start(alice);
    await publishRun(alice.config, offered, { env: {}, checkout: alice.checkout });

    const runs = await publishedRuns(alice);
    expect(runs.map((run) => [run.run, run.owner.user, run.offer !== undefined])).toEqual([[offered, 'alice', true], [held, 'bob', false]]);
  });

  it('lists for resume the runs others offer for this repository, then the running runs here as teamai-reports shows them', async () => {
    const acme = team();
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    originAt('https://github.com/acme/app.git', [alice, bob]);
    const local = await start(alice);
    const ended = await start(alice);
    const held = await start(alice);
    const reoffered = await start(alice);
    for (const run of [ended, held, reoffered]) {
      await publishRun(alice.config, run, { env: {}, checkout: alice.checkout });
      await claimRun(bob.config, run, { checkout: bob.checkout });
    }
    await cancelRun(bob.config, ended, {});
    await publishRun(bob.config, reoffered, { env: {}, checkout: bob.checkout });
    const bobs = await start(bob);
    await publishRun(bob.config, bobs, { env: {}, checkout: bob.checkout });

    await reportsBranch.readableReportsWorktree(alice.config);
    const env = await resolveWorkflowEnv(alice.config, {});
    const listed = async (repository: string | undefined) => (await PublishedRuns.resumable(alice.config, { taker: runnerTaker(), env, repository }))
      .map((row) => (row.kind === 'offered' ? [row.kind, row.published.run, row.published.owner.user] : [row.kind, row.run.id, row.kind === 'here' ? 'alice' : row.owner.user]));
    expect(await listed('github.com/acme/app')).toEqual([
      ['offered', reoffered, 'bob'], ['offered', bobs, 'bob'], ['claimed', held, 'bob'], ['ended', ended, 'bob'], ['here', local, 'alice'],
    ]);
    // `--next` takes no run in a checkout without an origin, so none is offered there.
    expect(await listed(undefined)).toEqual([['claimed', held, 'bob'], ['ended', ended, 'bob'], ['here', local, 'alice']]);
  });

  it('shows the dashboard each run handed over, with what a runner would need, marking the ones this install published', async () => {
    const acme = team({ build: BUILD, release: RELEASE });
    const alice = await acme.member('alice');
    const bob = await acme.member('bob');
    originAt('https://github.com/acme/app.git', [alice, bob]);
    const started = await startRun(alice.config, 'release', {}, { secrets: {} });
    const offered = 'data' in started ? String(started.data.run) : '';
    await publishRun(alice.config, offered, { env: {}, checkout: alice.checkout });
    const held = await start(alice);
    await publishRun(alice.config, held, { env: {}, checkout: alice.checkout });
    await claimRun(bob.config, held, { checkout: bob.checkout });

    await reportsBranch.readableReportsWorktree(alice.config);
    const rows = await listHandoffs(alice.config);
    expect(rows).toEqual([
      expect.objectContaining({
        run: offered, workflow: 'release', isMine: true, owner: expect.objectContaining({ user: 'alice' }), repository: 'github.com/acme/app',
        offer: { at: expect.any(String), needs: [], mayNeed: ['ship'], uses: { env: [], prompts: [] }, lacks: [] },
      }),
      expect.objectContaining({ run: held, workflow: 'build', isMine: false, owner: expect.objectContaining({ user: 'bob' }) }),
    ]);
    expect(rows[1]).not.toHaveProperty('offer');
  });
});

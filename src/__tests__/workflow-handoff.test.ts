import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { listHandoffs } from '../dashboard/workflow-runs.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { SyncManager, defaultSyncMeta, getRepoIdentity } from '../session-flow/sync.js';
import type { LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { log } from '../utils/logger.js';
import * as reportsBranch from '../utils/reports-branch.js';
import { updateReports } from '../utils/reports-branch.js';
import * as workflowCache from '../workflow/cache.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, resumableSessions, startRun } from '../workflow/engine.js';
import { claimOffered, claimRun, publishRun, resumeRun, settledSteps } from '../workflow/handoff.js';
import { pendingRecords, publishPendingRecords, queueRunRecord } from '../workflow/records.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import type { LocalToolAdapter } from '../workflow/drivers/local/local-tool-adapter.js';
import type { StepPass, StepState } from '../workflow/step-state.js';
import { installOwner, readRun, runLockPath, updateRun } from '../workflow/store.js';
import { PublishedRuns, type Taker } from '../workflow-published-runs.js';
import type { DriverIdentity, RunState, WorkflowDefinition, WorkflowEnvelope } from '../workflow/types.js';
import { ensureWorktree, fetchMissingCommits, headCommit, markReadCopy, worktreePath } from '../workflow/worktree.js';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import { fakeGh } from './helpers/fake-gh.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

const BUILD = `schemaVersion: v1alpha1
name: build
description: Two commands.
steps:
  - id: one
    command: echo one
  - id: two
    needs: [one]
    command: echo two
`;

const SHIP = `schemaVersion: v1alpha1
name: ship
description: Three changes made one after another in one copy.
steps:
  - id: change
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: echo write > write.txt
        - id: more
          needs: [write]
          workspace: continue
          command: echo more > more.txt
        - id: last
          needs: [more]
          workspace: continue
          command: echo last > last.txt
`;

const PAIR = `schemaVersion: v1alpha1
name: pair
description: A change in a copy of its own, and one in a copy a workflow opens.
steps:
  - id: build
    workspace: new
    command: echo build > build.txt
  - id: change
    needs: []
    workspace: new
    workflow:
      steps:
        - id: write
          workspace: continue
          command: echo write > write.txt
`;

const COPY = `schemaVersion: v1alpha1
name: copy
description: One change in a copy of its own.
steps:
  - id: change
    workspace: new
    command: echo change > change.txt
`;

const STACK = `schemaVersion: v1alpha1
name: stack
description: A change, and one that starts from it.
steps:
  - id: a
    workspace: new
    command: echo a > a.txt
  - id: b
    needs: [a]
    workspace: new
    command: echo b > b.txt
`;

const DELIVERED_STACK = `schemaVersion: v1alpha1
name: stack
description: A change delivered as a pull request, and one stacked on it.
steps:
  - id: a
    workspace: new
    command: echo a > a.txt
    deliver: pr
  - id: b
    needs: [a]
    workspace: new
    command: echo b > b.txt
    deliver: pr
`;

const WORKSPACES = ['read-only', 'new', 'continue'] as const;

interface Member {
  config: LocalConfig;
  /** The business checkout this member drives the run from. */
  checkout: string;
  driver: DriverIdentity;
}

/**
 * A team repository with `workflows` and the other `files`, and a business repository, each on a bare origin; a function
 * that makes a member's install: a team clone, a data home, and a business checkout the member drives runs from; and one
 * that pushes a team commit writing `files`, or deleting those set to null, and returns it.
 */
function team(workflows: Record<string, string> = { build: BUILD }, files: Record<string, string> = {}): {
  origin: string;
  business: string;
  member(name: string): Promise<Member>;
  change(files: Record<string, string | null>): string;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-handoff-')));
  dirs.push(root);
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'team.git');
  const business = path.join(root, 'business.git');
  const product = path.join(root, 'product');
  git(root, 'init', '-q', '-b', 'main', product);
  fs.writeFileSync(path.join(product, 'README.md'), '# product\n');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'product');
  git(root, 'clone', '-q', '--bare', product, business);
  fs.mkdirSync(path.join(seed, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: github\n');
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(seed, 'workflows', `${name}.yaml`), yaml);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  }
  git(root, 'init', '-q', '-b', 'main', seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'team');
  git(root, 'clone', '-q', '--bare', seed, origin);
  return {
    origin,
    business,
    member: async (name) => {
      const home = path.join(root, name);
      const clone = path.join(home, 'team-repo');
      const checkout = path.join(home, 'work');
      fs.mkdirSync(home, { recursive: true });
      git(root, 'clone', '-q', business, checkout);
      git(root, 'clone', '-q', origin, clone);
      git(clone, 'config', 'user.name', name);
      git(clone, 'config', 'user.email', `${name}@example.com`);
      const config: LocalConfig = {
        repo: { localPath: clone, remote: origin, kind: 'git' },
        username: name,
        scope: 'user',
        additionalRoles: [],
        dataHome: path.join(home, 'data'),
      };
      await syncWorkflowDefinitions(config);
      return { config, checkout, driver: { kind: 'local', machine: name, workspace: checkout } };
    },
    change: (changes) => {
      const editor = fs.mkdtempSync(path.join(root, 'editor-'));
      git(root, 'clone', '-q', origin, editor);
      for (const [file, text] of Object.entries(changes)) {
        if (text === null) git(editor, 'rm', '-q', file);
        else fs.writeFileSync(path.join(editor, file), text);
      }
      git(editor, 'add', '-A');
      git(editor, 'commit', '-qm', 'team change');
      git(editor, 'push', '-q', 'origin', 'main');
      return git(editor, 'rev-parse', 'HEAD');
    },
  };
}

/** Brings the member's team clone up to origin and syncs its workflow cache, as a pull does. */
async function pull({ config }: Member): Promise<void> {
  git(config.repo.localPath, 'pull', '-q', '--ff-only');
  await syncWorkflowDefinitions(config);
}

/** Every file of the member's workflow cache, with its content. */
function cacheFiles({ config }: Member): Record<string, string> {
  const dir = path.join(config.dataHome ?? '', 'workflows', 'cache');
  return Object.fromEntries(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
}

/** A file on origin's `teamai-reports`, or null when origin has none. */
function originFile(origin: string, rel: string): string | null {
  try {
    return execFileSync('git', ['--git-dir', origin, 'show', `teamai-reports:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function reportsHead(origin: string): string {
  return execFileSync('git', ['--git-dir', origin, 'rev-parse', 'teamai-reports'], { encoding: 'utf8' }).trim();
}

/**
 * Holds every push of a run's base pin to business origin `business` until `release` is called. `held` resolves once a
 * publish is waiting there, past its check of the business origin.
 */
function holdBasePin(business: string): { held: () => Promise<void>; release: () => void } {
  const held = path.join(path.dirname(business), 'pin-held');
  const release = path.join(path.dirname(business), 'pin-release');
  receiveHook(business, `while read old new ref; do case "$ref" in */base) touch '${held}'; while [ ! -f '${release}' ]; do sleep 0.05; done;; esac; done; exit 0`);
  return {
    held: async () => {
      for (let waited = 0; !fs.existsSync(held) && waited < 200; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(held)).toBe(true);
    },
    release: () => fs.writeFileSync(release, ''),
  };
}

/** Installs a pre-receive hook on `origin`; `exit 0` lets every push through again. */
function receiveHook(origin: string, script: string): void {
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/** Archives Claude Code session `session` of the member's checkout on the team repo's default branch, as teamai did before sessions moved to teamai-reports. */
async function archiveOnDefaultBranch({ config, checkout }: Member, session: string): Promise<void> {
  const found = await AgentSession.find({ platform: 'claude-code', sessionId: session });
  if (found.status !== 'done') throw new Error(found.failure.message);
  const archive = new SyncManager(config.repo.localPath);
  await archive.saveSession(found.session, defaultSyncMeta({
    platform: 'claude-code', author: config.username, cwd: checkout, sessionId: session, repoIdentity: getRepoIdentity(checkout), title: found.session.title,
  }, found.session.createdAt));
  archive.gitCommit('sync: archive 1 session(s)');
  archive.gitPush();
}

async function editRun(config: LocalConfig, runId: string, edit: (run: RunState) => RunState): Promise<void> {
  await updateRun(config, runId, {}, async (run) => (run === 'missing' ? { value: undefined } : { value: undefined, write: edit(run) }));
}

/** Settles a run whose steps all reported: the next `next` ends it and publishes its end record. */
async function settle(member: Member, runId: string): Promise<void> {
  expect(await leaseNext(member.config, runId, member.driver)).toMatchObject({ data: { done: {} } });
}

/** Starts `workflow` in the member's business checkout, which fixes the run's base. */
async function startIn({ config, checkout }: Member, workflow: string): Promise<string> {
  const base = await headCommit(checkout);
  const started = await startRun(config, workflow, {}, { secrets: await knownSecrets(config), ...(base ? { base } : {}), checkout });
  if ('error' in started) throw new Error(started.error.message);
  return String(started.data.run);
}

/**
 * Does what a driver does with the next lease: open the leased copy at its start, commit `file` there, push the branch to
 * the business origin, and report the change.
 */
async function work(
  member: Member,
  runId: string,
  file: string,
  driver = member.driver,
  { push = true }: { push?: boolean } = {},
): Promise<{ step: string; branch: string; commit: string }> {
  const next = await leaseNext(member.config, runId, driver, { can: { workspace: [...WORKSPACES] } });
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  const lease = next.data.lease as {
    step: string; attempt: string; revision: number; workspace: { branch: string; base: { commit: string }; start: { commit: string } };
  };
  const { branch, base, start: startCommit } = lease.workspace;
  await fetchMissingCommits(member.checkout, { run: runId, commits: [base.commit, startCommit.commit] });
  const opened = await ensureWorktree(member.checkout, branch, startCommit.commit);
  if ('error' in opened) throw new Error(opened.error);
  fs.writeFileSync(path.join(opened.dir, file), `${file}\n`);
  git(opened.dir, 'add', file);
  git(opened.dir, 'commit', '-qm', file);
  const commit = git(opened.dir, 'rev-parse', 'HEAD');
  if (push) git(opened.dir, 'push', '-q', 'origin', branch);
  const reported = await reportAttempt(member.config, runId, {
    attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver,
    changes: { branch, base: base.commit, from: startCommit.commit, to: commit, commits: [commit] },
  });
  if ('error' in reported) throw new Error(reported.error.message);
  return { step: lease.step, branch, commit };
}

/** The commit `ref` points at on bare repository `origin`, or undefined when it has no such ref. */
function originRef(origin: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/** Deletes every branch of run `runId` on bare repository `business`, as a merge that deletes a run's branches does. */
function deleteRunBranches(business: string, runId: string): void {
  const refs = git(business, '--git-dir', business, 'for-each-ref', '--format=%(refname)', `refs/heads/teamai/${runId}/`).split('\n').filter(Boolean);
  for (const ref of refs) git(business, '--git-dir', business, 'update-ref', '-d', ref);
}

/** Commits a file on `branch` of bare repository `business`, as a push from another checkout of the copy does. */
function pushCommitTo(business: string, branch: string): void {
  const editor = fs.mkdtempSync(path.join(path.dirname(business), 'editor-'));
  git(path.dirname(business), 'clone', '-q', '--branch', branch, business, editor);
  fs.writeFileSync(path.join(editor, 'later.txt'), 'later\n');
  git(editor, 'add', '-A');
  git(editor, 'commit', '-qm', 'later');
  git(editor, 'push', '-q', 'origin', `HEAD:${branch}`);
}

function hasCommit(dir: string, commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function start({ config }: Member): Promise<string> {
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return String(started.data.run);
}

/** Leases the next step to `member` and reports it succeeded; returns its id. */
async function runStep(member: Member, runId: string, outputs?: Record<string, unknown>): Promise<string> {
  const next = await leaseNext(member.config, runId, member.driver);
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  const lease = next.data.lease as { step: string; attempt: string; revision: number };
  const reported = await reportAttempt(member.config, runId, {
    attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: member.driver, ...(outputs ? { outputs } : {}),
  });
  if ('error' in reported) throw new Error(reported.error.message);
  return lease.step;
}

/** Gives each member's business checkout a GitHub origin that git reaches as `business`, so delivery opens pull requests there. */
function onGitHub(business: string, members: Member[]): void {
  for (const { checkout } of members) {
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    git(checkout, 'config', `url.${business}.insteadOf`, 'https://github.com/acme/app.git');
  }
}

/** An open pull request as GitHub lists it. */
function openPull(number: number, head: string, base = 'main') {
  const repo = { full_name: 'acme/app' };
  return { state: 'open', html_url: `https://github.com/acme/app/pull/${number}`, head: { ref: head, repo }, base: { ref: base, repo } };
}

/** The head and target branch of each pull request the fake gh was asked to open, in order. */
function creates(gh: ReturnType<typeof fakeGh>): string[][] {
  return gh.calls().filter((call) => call.args[0] === 'pr').map((call) => ['-H', '-B'].map((flag) => call.args[call.args.indexOf(flag) + 1] ?? ''));
}

/**
 * Starts the delivered stack on `alice`, delivers `a` and reports `b`, so `b` is delivering when the run is published.
 * The fake host keeps `a`'s pull request.
 */
async function deliveringStack(acme: ReturnType<typeof team>, alice: Member, bob: Member) {
  onGitHub(acme.business, [alice, bob]);
  const gh = fakeGh(path.join(path.dirname(acme.origin), 'gh'));
  const runId = await startIn(alice, 'stack');
  const a = await work(alice, runId, 'a.txt');
  const b = await work(alice, runId, 'b.txt');
  return { gh, runId, a, b };
}

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
    await syncWorkflowDefinitions(alice.config);
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
      await syncWorkflowDefinitions(config);
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
    await syncWorkflowDefinitions(bob.config);

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

  it('continues a copy it took back from the commit the other machine recorded, fast-forwarding its own branch', async () => {
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
      await syncWorkflowDefinitions(config);
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
  });

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
  function runnerTaker(mode: 'attended' | 'unattended' = 'unattended') {
    return { caller: { evidence: { kind: 'none' as const }, confirmed: false, mode }, driver: 'local' as const, tools: {}, hasPerson: false };
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
      offer: { at: expect.any(String), needs: ['only a person can answer the approval at ship'], uses: { env: [], prompts: [] }, lacks: [] },
    })]);
    const self = (await installOwner(runner.config)).id;
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: false, self })).toEqual([]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/app', hasPerson: true, self }).map((run) => run.run)).toEqual([runId]);
    expect(PublishedRuns.candidates(runs, { repository: 'github.com/acme/other', hasPerson: true, self })).toEqual([]);
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
      run: runId, offer: { at: expect.any(String), needs: [], uses: { env: ['SIGNING_KEY'], prompts: [] }, lacks: [{
        reason: 'sign requires env SIGNING_KEY, which has no value here', fix: 'Set it in the environment, or declare it in the team repo (teamai env add SIGNING_KEY --secret)',
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
        offer: { at: expect.any(String), needs: ['only a person can answer the approval at ship'], uses: { env: [], prompts: [] }, lacks: [] },
      }),
      expect.objectContaining({ run: held, workflow: 'build', isMine: false, owner: expect.objectContaining({ user: 'bob' }) }),
    ]);
    expect(rows[1]).not.toHaveProperty('offer');
  });
});

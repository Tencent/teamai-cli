import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { parseWorkflow } from '../workflow/parse.js';
import { leaseNext, parseReport, reportAttempt, startRun, withIgnored, type NextOptions } from '../workflow/engine.js';
import { knownSecrets } from '../env-resolution.js';
import { sanitizePrUrl } from '../workflow/pr-url.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { deliveryLockPath, readRun, runLockPath } from '../workflow/store.js';
import * as store from '../workflow/store.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/local-driver.js';
import { acquireLock, releaseLock } from '../update.js';
import { AGENT_PATHS, DELIVERY_ONLY_PATHS, protectedPaths } from '../workflow/worktree.js';
import { fakeGh, type FakeGhOptions } from './helpers/fake-gh.js';
import { deliverPr } from '../workflow/pr-delivery.js';
import { buildEndRecord, pendingRecords } from '../workflow/records.js';
import { projectRun } from '../workflow/snapshot.js';
import * as worktree from '../workflow/worktree.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import * as registry from '../providers/registry.js';
import { GitHubProvider } from '../providers/github/index.js';
import type { GitProvider, PullRequestLookup } from '../providers/types.js';
import type { LocalConfig } from '../types.js';
import type { RunState } from '../workflow/types.js';

_setDriverPollMs(20);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function fixture(steps: string, inputs?: unknown): Promise<{ config: LocalConfig; cwd: string; runId: string; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-delivery-'));
  dirs.push(root);
  const cwd = path.join(root, 'product');
  const knowledge = path.join(root, 'team');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  git(root, ['init', '-q', '--bare', 'remote.git']);
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.teamai/\n');
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n');
  git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', 'base']);
  git(cwd, ['remote', 'add', 'origin', 'https://github.com/fixture/app.git']);
  git(cwd, ['config', `url.${path.join(root, 'remote.git')}.insteadOf`, 'https://github.com/fixture/app.git']);
  git(cwd, ['push', '-qu', 'origin', 'main']);
  const config: LocalConfig = { repo: { localPath: knowledge, remote: 'local', kind: 'self' }, scope: 'project',
    username: 'tester', usageReportEnabled: false, additionalRoles: [], projectRoot: cwd, dataHome: path.join(root, 'data'), workflows: { tools: {}, max_parallel: 1 } };
  fs.writeFileSync(path.join(knowledge, 'workflows', 'ship.yaml'), `schemaVersion: v1alpha1\nname: ship\ndescription: Deliver work\n${inputs ? 'inputs:\n  packages: [{ name: string, id: string, after: [string] }]\n' : ''}steps:\n${steps}`);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'ship', inputs ?? {}, { checkout: cwd, base: { ref: 'main', commit: git(cwd, ['rev-parse', 'HEAD']) }, secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, cwd, root, runId: String(started.data.run) };
}

async function state(config: LocalConfig, runId: string): Promise<RunState> {
  const run = await readRun(config, runId);
  if (typeof run === 'string') throw new Error(run);
  return run;
}

const LeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), pass: z.number(),
  workspace: z.object({ branch: z.string(), base: z.object({ commit: z.string() }), start: z.object({ commit: z.string() }).optional() }).optional(),
});
type Lease = z.infer<typeof LeaseSchema>;
const remote = { kind: 'remote', machine: 'paseo', workspace: 'session-1' };
const writable: NextOptions = { can: { workspace: ['read-only', 'new', 'continue'] } };
const head = 'c'.repeat(40);

/** Takes the next lease as a driver that speaks only CLI JSON does. */
async function take(config: LocalConfig, runId: string): Promise<Lease> {
  const next = await leaseNext(config, runId, remote, writable);
  if (!('data' in next) || !next.data.lease) throw new Error(`no lease: ${JSON.stringify(next)}`);
  return LeaseSchema.parse(next.data.lease);
}

/** Reports through the wire payload `teamai workflow report --json` reads. */
async function report(config: LocalConfig, runId: string, body: Record<string, unknown>) {
  const parsed = parseReport({ driver: remote, ...body });
  if (typeof parsed === 'string') throw new Error(parsed);
  return withIgnored(await reportAttempt(config, runId, parsed.report), parsed.ignored);
}

/** Commits `files` on the lease's branch in a clone of its own and pushes it, as a remote driver does, and returns the commit. */
function pushWork(root: string, lease: Lease, files: Record<string, string> = { 'work.txt': 'work\n' }): string {
  if (!lease.workspace) throw new Error(`lease ${lease.step} has no workspace`);
  const clone = fs.mkdtempSync(path.join(root, 'driver-'));
  git(root, ['clone', '-q', path.join(root, 'remote.git'), clone]);
  git(clone, ['checkout', '-q', '-b', lease.workspace.branch, lease.workspace.base.commit]);
  return commitAndPush(clone, lease.workspace.branch, files);
}

/** Commits `files` on top of `branch` as origin holds it, in a clone of its own, and pushes it, as a driver that went on working does. */
function pushOnto(root: string, branch: string, files: Record<string, string>): string {
  const clone = fs.mkdtempSync(path.join(root, 'driver-'));
  git(root, ['clone', '-q', '-b', branch, path.join(root, 'remote.git'), clone]);
  return commitAndPush(clone, branch, files);
}

function commitAndPush(clone: string, branch: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    fs.writeFileSync(path.join(clone, file), content);
  }
  git(clone, ['add', '-A']);
  git(clone, ['-c', 'user.name=Driver', '-c', 'user.email=driver@example.com', 'commit', '-qm', 'work']);
  git(clone, ['push', '-q', 'origin', branch]);
  return git(clone, ['rev-parse', 'HEAD']);
}

/** Reports a lease's success with one commit on its branch (`to`, a commit no repository has unless given), and `changes` fields the driver adds. */
async function succeed(config: LocalConfig, runId: string, lease: Lease, changes: Record<string, unknown> = {}) {
  const base = lease.workspace?.base.commit;
  const to = typeof changes.to === 'string' ? changes.to : head;
  return report(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success',
    ...(lease.workspace ? { changes: { branch: lease.workspace.branch, base, from: base, to, commits: [to], ...changes } } : {}) });
}

/** The value that follows `flag` in a gh call. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

/** An open pull request as GitHub lists it. */
function pull(number: number, head: string, base = 'main', repo = 'fixture/app') {
  return { state: 'open', html_url: `https://github.com/${repo}/pull/${number}`, head: { ref: head, repo: { full_name: repo } }, base: { ref: base, repo: { full_name: repo } } };
}

const FIX_THEN_REVIEW = `  - id: fix\n    workspace: new\n    command: node fix.js\n    deliver: pr\n  - id: review\n    needs: [fix]\n    command: echo review\n`;

/** Two independent steps that continue one shared branch, the first delivering it. */
const IMPL_AND_DOCS = `  - id: work
    workspace: new
    workflow:
      steps:
        - id: impl
          command: echo impl
          workspace: continue
          deliver: pr
        - id: docs
          needs: []
          command: echo docs
          workspace: continue
`;

describe('workflow PR delivery contract', () => {
  it('parses delivery on a writable step and rejects unsupported delivery', () => {
    const yaml = 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship changes\nsteps:\n  - id: write\n    command: node write.js\n    workspace: new\n    deliver: pr\n';
    const parsed = parseWorkflow('ship.yaml', yaml);
    expect(parsed.ok && parsed.definition.steps[0]).toMatchObject({ deliver: 'pr' });
    expect(parseWorkflow('ship.yaml', yaml.replace('deliver: pr', 'deliver: merge')).ok).toBe(false);
    expect(parseWorkflow('ship.yaml', yaml.replace('    workspace: new\n', '')).ok).toBe(false);
    const inherited = 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship changes\nsteps:\n  - id: change\n    workspace: new\n    workflow:\n      steps:\n        - id: write\n          prompt: Edit the code.\n          deliver: pr\n';
    expect(parseWorkflow('ship.yaml', inherited).ok).toBe(true);
    expect(parseWorkflow('ship.yaml', inherited.replace('prompt: Edit the code.', 'command: echo edit')).ok).toBe(false);
  });

  it('reads the reported URL from changes.pr_url and names unread nested fields without values', () => {
    const parsed = parseReport({ attempt: 'a1', revision: 1, outcome: 'success',
      driver: { kind: 'remote', machine: 'host', workspace: 'work' },
      changes: { branch: 'work', base: 'base', from: 'base', to: 'head', commits: [], pr_url: 'https://review.example/1', private: 'secret' } });
    expect(parsed).toMatchObject({ report: { prUrl: 'https://review.example/1' }, ignored: ['changes.private'] });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('refuses a reported pull request without branch facts', () => {
    const driver = { kind: 'remote', machine: 'host', workspace: 'work' };
    expect(parseReport({ attempt: 'a1', revision: 1, outcome: 'success', driver, changes: { pr_url: 'https://review.example/1' } }))
      .toBe('changes must include branch, base, from, and to');
  });

  it.each([
    ['https://github.com/acme/app/pull/101', { url: 'https://github.com/acme/app/pull/101' }],
    ['https://bitbucket.acme.internal/projects/APP/repos/web/pull-requests/7/overview', { url: 'https://bitbucket.acme.internal/projects/APP/repos/web/pull-requests/7/overview' }],
    ['https://review.acme.internal/changes/4821?session=abc#c3', { url: 'https://review.acme.internal/changes/4821' }],
    ['https://user:token@github.com/acme/app/pull/1', { reason: 'contains credentials' }],
    ['http://github.com/acme/app/pull/1', { reason: 'must use HTTPS' }],
    ['not a url', { reason: 'is not a valid URL' }],
    [`https://example.com/${'a'.repeat(512)}`, { reason: 'exceeds 512 characters' }],
    [101, { reason: 'must be a URL string' }],
  ])('sanitizes %s', (value, expected) => expect(sanitizePrUrl(value)).toEqual(expected));

  const urls = fc.webUrl({ validSchemes: ['https', 'http'], withQueryParameters: true, withFragments: true, authoritySettings: { withUserInfo: true } });

  it('never keeps credentials, a query or a fragment, gives back what it kept unchanged, and stays within 512 characters', () => {
    fc.assert(fc.property(fc.oneof(urls, fc.string(), fc.string({ minLength: 513, maxLength: 700 })), (value) => {
      const result = sanitizePrUrl(value);
      if (result.url === undefined) return;
      const url = new URL(result.url);
      expect(url.protocol).toBe('https:');
      expect([url.username, url.password, url.search, url.hash]).toEqual(['', '', '', '']);
      expect(result.url.length).toBeLessThanOrEqual(512);
      expect(sanitizePrUrl(result.url)).toEqual(result);
    }), { numRuns: 500 });
  });

  it('drops every URL with credentials, and keeps the host and path of any other https URL', () => {
    fc.assert(fc.property(urls, (value) => {
      const url = new URL(value);
      const expected = url.username || url.password ? undefined
        : url.protocol === 'https:' && `${url.origin}${url.pathname}`.length <= 512 ? `${url.origin}${url.pathname}` : undefined;
      expect(sanitizePrUrl(value).url).toBe(expected);
    }), { numRuns: 500 });
  });
});

describe('delivering a step', () => {
  it('delivers a driver-reported URL without opening a PR, and leases the dependent in the same next', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    expect(fix).toMatchObject({ step: 'fix', workspace: { branch } });

    expect(await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://review.acme.internal/changes/4821?session=abc#c3' }))
      .toEqual({ data: { accepted: true, revision: 2, step: { id: 'fix', status: 'delivering', outcome: 'success' }, cleanup: true } });

    const held = deliveryLockPath(config, runId);
    expect(await acquireLock(held)).toBe(true);
    try {
      expect(await leaseNext(config, runId, remote, writable)).toEqual({ data: { wait: { reason: 'fix is delivering', delivering: ['fix'] }, cancelled: [] } });
    } finally {
      await releaseLock(held);
    }

    const review = await take(config, runId);
    expect(review.step).toBe('review');
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'succeeded', settledAt: 2 });
    expect(run.deliveries).toEqual([{ url: 'https://review.acme.internal/changes/4821', branch, base: 'main', step: 'fix', pass: 1 }]);
    expect(gh.calls()).toEqual([]);

    await report(config, runId, { attempt: review.attempt, revision: review.revision, outcome: 'success' });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(buildEndRecord(await state(config, runId), remote, 'tester').prs).toEqual(['https://review.acme.internal/changes/4821']);
  });

  it('keeps the local driver polling while another process delivers, rather than giving up as busy', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://review.acme.internal/changes/1' });
    const held = deliveryLockPath(config, runId);
    expect(await acquireLock(held)).toBe(true);
    const released = new Promise<void>((resolve) => setTimeout(() => void releaseLock(held).then(resolve), 200));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    await released;
  });

  it.each([
    ['a filesystem path', (root: string) => path.join(root, 'remote.git')],
    ['a host only git reaches', () => 'https://git.example.internal/fixture/app.git'],
  ])('fails a delivery that has no URL and an origin at %s, naming the branch that keeps the work', async (_case, origin) => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    git(cwd, ['remote', 'set-url', 'origin', origin(root)]);
    git(cwd, ['config', `url.${path.join(root, 'remote.git')}.insteadOf`, 'https://git.example.internal/fixture/app.git']);
    const fix = await take(config, runId);
    const to = pushWork(root, fix);
    expect(await succeed(config, runId, fix, { to })).toMatchObject({ data: { step: { id: 'fix', status: 'delivering' } } });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const branch = `teamai/${runId}/fix/p1`;
    expect((await state(config, runId)).steps).toMatchObject([
      { id: 'fix', status: 'failed', delivery: { branch, head: to }, failure: { code: 'delivery_failed', message: expect.stringContaining(`The work is kept on origin in branch ${branch}.`) } },
      { id: 'review', status: 'skipped' },
    ]);
    expect((await state(config, runId)).steps[0]).toMatchObject({ failure: { message: expect.stringContaining(`teamai workflow retry ${runId} fix`) } });
    expect(gh.calls()).toEqual([]);
  });

  it('opens one pull request from the pushed branch into the run base branch, outside the member checkout, and records it', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const to = pushWork(root, fix);
    expect(await succeed(config, runId, fix, { to })).toMatchObject({ data: { step: { id: 'fix', status: 'delivering' } } });

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries).toEqual([{ url: 'https://github.com/fixture/app/pull/1', branch, base: 'main', step: 'fix', pass: 1 }]);
    const [lookup, create, again, ...rest] = gh.calls();
    expect(again?.args).toEqual(lookup?.args);
    expect(rest).toEqual([]);
    expect(lookup?.args[0]).toBe('api');
    expect(lookup?.prompt).toBe('0');
    const query = new URLSearchParams(lookup?.args[1]?.split('?')[1]);
    expect([lookup?.args[1]?.split('?')[0], query.get('state'), query.get('head'), query.get('base')]).toEqual(['repos/fixture/app/pulls', 'open', `fixture:${branch}`, 'main']);
    expect(create?.args.slice(0, 2)).toEqual(['pr', 'create']);
    expect([flag(create?.args ?? [], '-R'), flag(create?.args ?? [], '-H'), flag(create?.args ?? [], '-B')]).toEqual(['fixture/app', branch, 'main']);
    expect(fs.realpathSync(create?.cwd ?? cwd).startsWith(fs.realpathSync(root))).toBe(false);
    expect(git(root, ['--git-dir=remote.git', 'rev-parse', `refs/heads/${branch}`])).toBe(to);
  });

  it.each([
    ['a delivery that stopped after opening it', {}],
    ['a create that failed after GitHub took it', { create: 'fail-after-open' as const }],
  ])('records the pull request %s rather than opening another', async (_case, options) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const gh = fakeGh(path.join(root, 'gh'), { ...options, open: 'create' in options ? [] : [pull(5, `${branch}-other`), pull(6, branch, 'main', 'fork/app'), pull(7, branch)] });
    await succeed(config, runId, fix, { to: pushWork(root, fix) });

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    const url = 'create' in options ? 'https://github.com/fixture/app/pull/1' : 'https://github.com/fixture/app/pull/7';
    const run = await state(config, runId);
    expect(run.deliveries?.map((receipt) => receipt.url)).toEqual([url]);
    expect(gh.calls().map((call) => call.args[0])).toEqual('create' in options ? ['api', 'pr', 'api'] : ['api']);
    // The receipt settles the request the run listed before it asked GitHub to open one.
    expect(run.creating).toBeUndefined();
    expect(run.steps[0]).toMatchObject({ delivery: { branch } });
    const handed = projectRun(run, {});
    expect(handed.ok && handed.value.steps[0]).toEqual(run.steps[0]);
  });

  it('fails, opening none, when the lookup names an open pull request on another host than the origin', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const gh = fakeGh(path.join(root, 'gh'), { open: [{ ...pull(7, branch), html_url: 'https://github.example.net/fixture/app/pull/7' }] });
    const to = pushWork(root, fix);
    await succeed(config, runId, fix, { to });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.deliveries).toBeUndefined();
    expect(run.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`answered with a pull request URL TeamAI cannot keep. The work is kept on origin in branch ${branch}.`) } });
    expect(gh.calls().map((call) => call.args[0])).toEqual(['api']);
    expect(git(root, ['--git-dir=remote.git', 'rev-parse', `refs/heads/${branch}`])).toBe(to);
  });

  it('keeps the work on origin when GitHub cannot be reached, stores none of its output, and retry delivers without running the step again', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'), { lookup: 'fail' });
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const to = pushWork(root, fix);
    await succeed(config, runId, fix, { to });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failed = await state(config, runId);
    expect(failed.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`The work is kept on origin in branch ${branch}.`) } });
    expect(failed.steps[0]).toMatchObject({ failure: { message: expect.stringContaining(`teamai workflow retry ${runId} fix`) } });
    expect(JSON.stringify(failed)).not.toContain('ghp_fake_secret');
    expect(git(root, ['--git-dir=remote.git', 'rev-parse', `refs/heads/${branch}`])).toBe(to);

    gh.configure({});
    expect(await retryStep(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: {} });
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it('asks the run before it opens a pull request, and opens none for a step that stopped delivering', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    if (!fix.workspace) throw new Error('fix has no workspace');
    const to = pushWork(root, fix);
    const job = { key: { step: 'fix', pass: 1, settledAt: 2, branch: fix.workspace.branch, head: to }, runId, runName: 'ship', checkout: cwd, base: fix.workspace.base.commit, target: 'main', childWork: [] };

    expect(await deliverPr(job, async () => 'refused')).toEqual({ ok: false, fault: { kind: 'withdrawn' } });
    expect(gh.calls().map((call) => call.args[0])).toEqual(['api']);
  });

  it('cancels a delivering step: it delivers nothing and its dependents do not run', async () => {
    const { config, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { pr_url: 'https://review.acme.internal/changes/1' });

    expect(await cancelRun(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: { cancelled: { steps: ['fix'], attempts: [] }, run: { status: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps).toMatchObject([
      { id: 'fix', status: 'cancelled', attempt: fix.attempt, delivery: { branch: `teamai/${runId}/fix/p1`, head } }, { id: 'review', status: 'skipped' },
    ]);
    expect(run.deliveries).toBeUndefined();
  });

  it.each([
    ['TeamAI would open the pull request', {}],
    ['the driver reported one', { pr_url: 'https://github.com/fixture/app/pull/1' }],
  ])('refuses a branch that changes protected paths, naming them, before any pull request is opened or accepted, when %s', async (_case, changes) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const gh = fakeGh(path.join(root, 'gh'), { open: [pull(1, `teamai/${runId}/fix/p1`)] });
    const to = pushWork(root, fix, { '.github/workflows/ci.yml': 'on: push\n', 'src/app.ts': 'ok\n', 'packages/web/CLAUDE.md': 'rules\n' });
    await succeed(config, runId, fix, { to, ...changes });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps).toMatchObject([
      { id: 'fix', status: 'failed', failure: { code: 'protected_path', message: expect.stringContaining('.github/workflows/ci.yml, packages/web/CLAUDE.md.') } },
      { id: 'review', status: 'skipped' },
    ]);
    expect(run.steps[0]).not.toMatchObject({ failure: { message: expect.stringContaining('src/app.ts') } });
    if ('pr_url' in changes) expect(run.steps[0]).toMatchObject({ delivery: { reported: changes.pr_url } });
    expect(run.deliveries).toBeUndefined();
    // The report-time lookup only reads; delivery refuses the protected paths before it looks up or opens anything.
    expect(gh.calls().map((call) => call.args[0])).toEqual('pr_url' in changes ? ['api'] : []);
  });

  it.each([
    ['TeamAI would open the pull request', {}],
    ['the driver reported one', { pr_url: 'https://github.com/fixture/app/pull/1' }],
  ])('opens and accepts nothing when origin\'s branch moved past the checked commit to one that changes protected paths, when %s', async (_case, changes) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const gh = fakeGh(path.join(root, 'gh'), { open: 'pr_url' in changes ? [pull(1, branch)] : [] });
    const checked = pushWork(root, fix, { 'src/app.ts': 'ok\n' });
    const ahead = pushOnto(root, branch, { '.github/workflows/x.yml': 'on: push\n' });
    expect(await succeed(config, runId, fix, { to: checked, ...changes })).not.toHaveProperty('data.dropped');

    // No step that writes the branch is leased, so no report can record that commit, and the first call fails the step.
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps).toMatchObject([
      { id: 'fix', status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`branch ${branch} on origin is at commit ${ahead}, which holds commit ${checked}, the last one a report recorded on it, and later commits no report recorded, so TeamAI has not checked them`) } },
      { id: 'review', status: 'skipped' },
    ]);
    expect(run.steps[0]).toMatchObject({ failure: { message: expect.stringContaining(`teamai workflow retry ${runId} fix`) } });
    expect(run.deliveries).toBeUndefined();
    expect(creates(gh)).toEqual([]);
  });

  it('names a missing origin branch and reads it without credential prompts', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const to = pushWork(root, fix);
    const branch = fix.workspace?.branch ?? '';
    git(cwd, ['fetch', 'origin', branch]);
    git(root, ['--git-dir=remote.git', 'update-ref', '-d', `refs/heads/${branch}`]);
    await succeed(config, runId, fix, { to });
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    vi.stubEnv('GIT_ASKPASS', '/opt/editor/askpass.sh');
    const reads = vi.spyOn(worktree, 'git');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`origin has no branch ${branch}; push ${to} to it, then run: teamai workflow retry ${runId} fix`) } });
    expect(reads).toHaveBeenCalledWith(cwd, ['-c', 'credential.interactive=false', 'ls-remote', 'origin', `refs/heads/${branch}`], { timeoutMs: 30000, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' } });
    expect(run.deliveries).toBeUndefined();
    expect(gh.calls()).toEqual([]);
  });

  it('fetches the commits it checks within the delivery timeout and without credential prompts', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const to = pushWork(root, fix);
    await succeed(config, runId, fix, { to });
    // Every git process that reaches origin logs the askpass it was given, then serves the fixture's bare repository.
    const [log, transport, bare] = [path.join(root, 'transport.log'), path.join(root, 'transport.sh'), path.join(root, 'remote.git')];
    fs.writeFileSync(transport, `#!/bin/sh\nprintf '%s\\n' "$GIT_ASKPASS" >> '${log}'\nexec git upload-pack "$1"\n`, { mode: 0o755 });
    git(cwd, ['config', '--unset', `url.${bare}.insteadOf`]);
    git(cwd, ['config', `url.ext::${transport} ${bare}.insteadOf`, 'https://github.com/fixture/app.git']);
    git(cwd, ['config', 'protocol.ext.allow', 'always']);
    vi.stubEnv('GIT_ASKPASS', '/opt/editor/askpass.sh');
    const fetches = vi.spyOn(worktree, 'fetchMissingCommits');

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' };
    expect(fetches).toHaveBeenCalledWith(cwd, { run: runId, commits: [fix.workspace?.base.commit, to] }, { timeoutMs: 30000, env });
    const askpass = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(askpass.length).toBeGreaterThanOrEqual(3);
    expect(askpass.filter((given) => given !== 'echo')).toEqual([]);
  });

  it('reads a reported head only as a full commit id, so a ref name cannot stand in for the pushed branch', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    pushWork(root, fix, { '.github/workflows/ci.yml': 'on: push\n' });
    await succeed(config, runId, fix, { to: 'main', pr_url: 'https://github.com/fixture/app/pull/1' });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[0]).toMatchObject({
      status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`Push branch teamai/${runId}/fix/p1 to origin`) },
    });
  });

  it('refuses protected changes the branch inherited from a step it needs, though the delivering step left them alone', async () => {
    const write = (file: string) => `node -e "require('fs').mkdirSync(require('path').dirname('${file}'),{recursive:true});require('fs').writeFileSync('${file}','x')"`;
    const { config, cwd, root, runId } = await fixture(`  - id: earlier\n    workspace: new\n    command: ${write('.github/workflows/ci.yml')}\n  - id: later\n    needs: [earlier]\n    workspace: new\n    command: ${write('change.txt')}\n    deliver: pr\n`);

    const gh = fakeGh(path.join(root, 'gh'));
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[1]).toMatchObject({ id: 'later', status: 'failed', failure: { code: 'protected_path', message: expect.stringContaining('.github/workflows/ci.yml') } });
    expect(gh.calls()).toEqual([]);
  });

  it('records a pull request once, however many deliveries report it', async () => {
    const { config, root, runId } = await fixture(`  - id: a\n    workspace: new\n    command: node a.js\n    deliver: pr\n  - id: b\n    needs: [a]\n    workspace: new\n    command: node b.js\n    deliver: pr\n`);
    const url = 'https://review.acme.internal/changes/9';
    const a = await take(config, runId);
    await succeed(config, runId, a, { to: pushWork(root, a), pr_url: url });
    const b = await take(config, runId);
    await succeed(config, runId, b, { to: pushWork(root, b), pr_url: url });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect((await state(config, runId)).deliveries).toEqual([{ url, branch: `teamai/${runId}/a/p1`, base: 'main', step: 'a', pass: 1 }]);
  });

  it('records a pull request delivered after the run ended, and queues the end record again with it', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    config.usageReportEnabled = true;
    const url = 'https://review.acme.internal/changes/3';
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: url });
    const read = worktree.fetchMissingCommits;
    vi.spyOn(worktree, 'fetchMissingCommits').mockImplementation(async (dir, options) => {
      await cancelRun(config, runId, await knownSecrets(config));
      return read(dir, options);
    });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'cancelled' });
    expect(run.deliveries).toEqual([{ url, branch: `teamai/${runId}/fix/p1`, base: 'main', step: 'fix', pass: 1 }]);
    expect((await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end')?.prs).toEqual([url]);
  });

  it('hands over a delivering step with what it delivers, and the run with its receipts', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const url = 'https://review.acme.internal/changes/5';
    const fix = await take(config, runId);
    const to = pushWork(root, fix);
    await succeed(config, runId, fix, { to, pr_url: url });
    const branch = `teamai/${runId}/fix/p1`;

    const delivering = projectRun(await state(config, runId), {});
    expect(delivering.ok && delivering.value.steps[0]).toMatchObject({ status: 'delivering', delivery: { branch, head: to, reported: url } });
    await take(config, runId);
    const delivered = projectRun(await state(config, runId), {});
    expect(delivered.ok && delivered.value.deliveries).toEqual([{ url, branch, base: 'main', step: 'fix', pass: 1 }]);
  });

});

/** A command that adds a line no earlier run of it wrote to `file`, so every run commits. */
const bump = (file: string) => `node -e "require('fs').appendFileSync('${file}', Date.now() + ' ' + Math.random() + '\\n')"`;

/** The head and target branch of each pull request the fake gh was asked to open, in order. */
function creates(gh: ReturnType<typeof fakeGh>): Array<[string | undefined, string | undefined]> {
  return gh.calls().filter((call) => call.args[0] === 'pr').map((call) => [flag(call.args, '-H'), flag(call.args, '-B')]);
}

/** The commits on `head` that `target` does not have, on the fixture's origin, leaving out the merge that brings a copy up to its needs. */
function commitsBeyond(root: string, target: string, head: string): string[] {
  return git(root, ['--git-dir=remote.git', 'log', '--no-merges', '--format=%H', `${target}..${head}`]).split('\n').filter(Boolean);
}

function changedTo(run: RunState, id: string): string | undefined {
  const step = run.steps.find((item) => item.id === id);
  return step && 'changes' in step ? step.changes?.to : undefined;
}

describe('where a pull request goes', () => {
  it('opens the pull request of a step into the delivered branch of the step it needs, with only its own commits', async () => {
    const { config, cwd, root, runId } = await fixture(`  - id: a\n    workspace: new\n    command: ${bump('a.txt')}\n    deliver: pr\n  - id: b\n    needs: [a]\n    workspace: new\n    command: ${bump('b.txt')}\n    deliver: pr\n`);
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [a, b] = [`teamai/${runId}/a/p1`, `teamai/${runId}/b/p1`];
    expect(creates(gh)).toEqual([[a, 'main'], [b, a]]);
    const run = await state(config, runId);
    expect(commitsBeyond(root, a, b)).toEqual([changedTo(run, 'b')]);
    expect(run.deliveries).toEqual([
      { url: 'https://github.com/fixture/app/pull/1', branch: a, base: 'main', step: 'a', pass: 1 },
      { url: 'https://github.com/fixture/app/pull/2', branch: b, base: a, step: 'b', pass: 1 },
    ]);
  });

  it('keeps a URL a stacked step reports when it is the open pull request into the delivered branch of the step it needs', async () => {
    const { config, root, runId } = await fixture(`  - id: a\n    workspace: new\n    command: node a.js\n    deliver: pr\n  - id: b\n    needs: [a]\n    workspace: new\n    command: node b.js\n    deliver: pr\n`);
    const gh = fakeGh(path.join(root, 'gh'));
    const [a, b] = [`teamai/${runId}/a/p1`, `teamai/${runId}/b/p1`];
    const first = await take(config, runId);
    await succeed(config, runId, first, { to: pushWork(root, first) });
    const second = await take(config, runId);
    gh.configure({ open: [pull(1, a), pull(2, b, a)] });

    const accepted = await succeed(config, runId, second, { to: pushWork(root, second), pr_url: 'https://github.com/fixture/app/pull/2' });
    expect(accepted).toMatchObject({ data: { accepted: true, step: { id: 'b', status: 'delivering' } } });
    expect(accepted).not.toHaveProperty('data.dropped');
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect((await state(config, runId)).deliveries?.[1]).toEqual({ url: 'https://github.com/fixture/app/pull/2', branch: b, base: a, step: 'b', pass: 1 });
    expect(creates(gh)).toEqual([[a, 'main']]);
  });

  it('opens the pull request of a for_each item into the delivered branch of the item it runs after, with only its own commits', async () => {
    const { config, cwd, root, runId } = await fixture(`  - id: build\n    for_each: inputs.packages\n    workspace: new\n    command: ${bump('items.txt')}\n    deliver: pr\n`,
      { packages: [{ name: 'one', id: 'one', after: [] }, { name: 'two', id: 'two', after: ['one'] }] });
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [one, two] = [`teamai/${runId}/build-0/p1`, `teamai/${runId}/build-1/p1`];
    expect(creates(gh)).toEqual([[one, 'main'], [two, one]]);
    expect(commitsBeyond(root, one, two)).toEqual([changedTo(await state(config, runId), 'build[1]')]);
  });

  it('passes over a need that was skipped, to the delivered branch before it', async () => {
    const { config, cwd, root, runId } = await fixture([
      `  - id: a\n    workspace: new\n    command: ${bump('a.txt')}\n    deliver: pr\n`,
      `  - id: retry\n    needs: [a]\n    if: steps.a.outcome == 'failed'\n    workspace: new\n    command: ${bump('retry.txt')}\n    deliver: pr\n`,
      `  - id: c\n    needs: [retry, a]\n    workspace: new\n    command: ${bump('c.txt')}\n    deliver: pr\n`,
    ].join(''));
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect((await state(config, runId)).steps[1]).toMatchObject({ id: 'retry', status: 'skipped' });
    expect(creates(gh)).toEqual([[`teamai/${runId}/a/p1`, 'main'], [`teamai/${runId}/c/p1`, `teamai/${runId}/a/p1`]]);
  });

  it('opens the pull request of a sub-workflow\'s first step into the delivered branch of what the workflow step needs', async () => {
    const { config, cwd, root, runId } = await fixture([
      `  - id: a\n    workspace: new\n    command: ${bump('a.txt')}\n    deliver: pr\n`,
      `  - id: change\n    needs: [a]\n    workflow:\n      steps:\n        - id: write\n          workspace: new\n          command: ${bump('write.txt')}\n          deliver: pr\n`,
    ].join(''));
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[`teamai/${runId}/a/p1`, 'main'], [`teamai/${runId}/change-write/p1`, `teamai/${runId}/a/p1`]]);
  });

  it('opens one pull request for a workflow step with workspace: new, from the branch its steps share, and none for its steps', async () => {
    const { config, cwd, root, runId } = await fixture([
      `  - id: a\n    workspace: new\n    command: ${bump('a.txt')}\n    deliver: pr\n`,
      `  - id: change\n    needs: [a]\n    workspace: new\n    deliver: pr\n    workflow:\n      steps:\n`,
      `        - id: write\n          workspace: continue\n          command: ${bump('write.txt')}\n`,
      `        - id: more\n          needs: [write]\n          workspace: continue\n          command: ${bump('more.txt')}\n`,
    ].join(''));
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const [a, change] = [`teamai/${runId}/a/p1`, `teamai/${runId}/change/p1`];
    expect(creates(gh)).toEqual([[a, 'main'], [change, a]]);
    const run = await state(config, runId);
    expect(commitsBeyond(root, a, change)).toEqual([changedTo(run, 'change.more'), changedTo(run, 'change.write')]);
    expect(run.deliveries?.map((receipt) => [receipt.step, receipt.branch])).toEqual([['a', a], ['change', change]]);
  });

  /** A workflow step that delivers its copy, where `a` writes the copy and `b` writes a branch of its own after it. */
  const COPY_AND_SIDE_BRANCH = [
    `  - id: work\n    workspace: new\n    deliver: pr\n    workflow:\n      steps:\n`,
    `        - id: a\n          workspace: continue\n          command: ${bump('a.txt')}\n`,
    `        - id: b\n          needs: [a]\n          workspace: new\n          command: ${bump('b.txt')}\n`,
  ].join('');

  it('opens no pull request for a workflow step whose branch leaves out the work of a step inside it on another branch', async () => {
    const { config, cwd, root, runId } = await fixture(COPY_AND_SIDE_BRANCH);
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    const [work, b] = [`teamai/${runId}/work/p1`, `teamai/${runId}/work-b/p1`];
    expect(run.steps.find((step) => step.id === 'work.b')).toMatchObject({ status: 'succeeded', changes: { branch: b } });
    expect(run.steps.find((step) => step.id === 'work')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`step "work.b" wrote branch ${b}, which branch ${work} does not hold, so a pull request from it would leave that work out`) } });
    expect(run.steps.find((step) => step.id === 'work')).toMatchObject({ failure: { message: expect.stringContaining('Have a later step in the workflow need step "work.b", so it merges branch') } });
    expect(creates(gh)).toEqual([]);
    expect(run.deliveries).toBeUndefined();
  });

  it('fails a workflow step whose own branch holds nothing beyond the run base while a step inside it wrote another branch', async () => {
    const { config, cwd, root, runId } = await fixture([
      `  - id: work\n    workspace: new\n    deliver: pr\n    workflow:\n      steps:\n`,
      `        - id: a\n          workspace: continue\n          command: node -e ""\n`,
      `        - id: b\n          needs: [a]\n          workspace: new\n          command: ${bump('b.txt')}\n`,
    ].join(''));
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    const [work, b] = [`teamai/${runId}/work/p1`, `teamai/${runId}/work-b/p1`];
    expect(run.steps.find((step) => step.id === 'work.a')).toMatchObject({ status: 'succeeded', changes: { branch: work, to: run.base?.commit } });
    expect(run.steps.find((step) => step.id === 'work')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`step "work.b" wrote branch ${b}, which branch ${work} does not hold`) } });
    expect(creates(gh)).toEqual([]);
    expect(run.deliveries).toBeUndefined();
  });

  it('opens the pull request of a workflow step once a later step inside it merges the branch another step wrote', async () => {
    const { config, cwd, root, runId } = await fixture(`${COPY_AND_SIDE_BRANCH}        - id: c\n          needs: [b]\n          workspace: continue\n          command: ${bump('c.txt')}\n`);
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const work = `teamai/${runId}/work/p1`;
    expect(creates(gh)).toEqual([[work, 'main']]);
    expect(commitsBeyond(root, 'main', work)).toContain(changedTo(await state(config, runId), 'work.b'));
  });

  it('opens a pull request for each pass of a looped new step, leaves the earlier ones open, and lists them in order', async () => {
    const { config, cwd, root, runId } = await fixture(
      `  - id: fix\n    workspace: new\n    command: ${bump('fix.txt')}\n    deliver: pr\n    loop: { back_to: fix, while: "length(steps.fix.passes) < 2", max_iterations: 2 }\n`,
    );
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[`teamai/${runId}/fix/p1`, 'main'], [`teamai/${runId}/fix/p2`, 'main']]);
    expect(gh.calls().every((call) => call.args[0] === 'api' || (call.args[0] === 'pr' && call.args[1] === 'create'))).toBe(true);
    expect(buildEndRecord(await state(config, runId), remote, 'tester').prs).toEqual(['https://github.com/fixture/app/pull/1', 'https://github.com/fixture/app/pull/2']);
  });

  it('opens one pull request for a step that loops on one continue branch, and lists it once', async () => {
    const { config, cwd, root, runId } = await fixture(
      `  - id: change\n    workspace: new\n    workflow:\n      steps:\n        - id: fix\n          workspace: continue\n          command: ${bump('fix.txt')}\n          deliver: pr\n          loop: { back_to: fix, while: "length(steps.fix.passes) < 3", max_iterations: 3 }\n`,
    );
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[`teamai/${runId}/change/p1`, 'main']]);
    // The first pass looks the branch up before and after it opens the request, and each later pass finds it.
    expect(gh.calls().filter((call) => call.args[0] === 'api')).toHaveLength(4);
    expect(buildEndRecord(await state(config, runId), remote, 'tester').prs).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it('lists a pull request once when its host answers the create with another URL than its lookup gives', async () => {
    const { config, cwd, runId } = await fixture(
      `  - id: change\n    workspace: new\n    workflow:\n      steps:\n        - id: fix\n          workspace: continue\n          command: ${bump('fix.txt')}\n          deliver: pr\n          loop: { back_to: fix, while: "length(steps.fix.passes) < 2", max_iterations: 2 }\n`,
    );
    const branch = `teamai/${runId}/change/p1`;
    const open: string[] = [];
    const create = providerDouble(async ({ source, target }) => (source === branch && target === 'main' ? open[0] : undefined), async () => {
      open.push('https://github.com/fixture/app/pull/1');
      return 'https://github.com/fixture/app/-/merge_requests/1';
    });

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(buildEndRecord(await state(config, runId), remote, 'tester').prs).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it.each([
    ['lists a request on another host', async (): Promise<string | undefined> => 'https://other.example/review/1', 'https://github.com/fixture/app/pull/1', true],
    ['cannot answer, and the create named a request on another host', (): Promise<string | undefined> => Promise.reject(new Error('GitHub timed out')), 'https://other.example/review/1', false],
    ['cannot answer, and the create named a request on the origin host', (): Promise<string | undefined> => Promise.reject(new Error('GitHub timed out')), 'https://github.com/fixture/app/pull/1', false],
  ])('records no receipt, when the lookup after it %s', async (_case, lookupAfter, answered, unsafe) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const create = providerDouble(async () => (create.mock.calls.length === 0 ? undefined : lookupAfter()), async () => answered);

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(unsafe ? `answered with a pull request URL TeamAI cannot keep. The work is kept on origin in branch ${branch}.` : `may have opened a pull request from branch ${branch}, but TeamAI could not confirm it`) } });
    expect(run.deliveries).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('starts the next for_each item while an earlier one delivers, since max_parallel bounds agents', async () => {
    const { config, root, runId } = await fixture(`  - id: build\n    for_each: { items: inputs.packages, max_parallel: 1 }\n    workspace: new\n    command: node build.js\n    deliver: pr\n`,
      { packages: ['one', 'two'].map((name) => ({ name, id: name, after: [] })) });
    const first = await take(config, runId);
    await succeed(config, runId, first, { to: pushWork(root, first), pr_url: 'https://review.acme.internal/changes/1' });
    const held = deliveryLockPath(config, runId);
    expect(await acquireLock(held)).toBe(true);
    try {
      expect(await take(config, runId)).toMatchObject({ step: 'build[1]' });
    } finally {
      await releaseLock(held);
    }
  });

  it('lists the pull requests of three for_each items in item order', async () => {
    const { config, cwd, root, runId } = await fixture(`  - id: build\n    for_each: inputs.packages\n    workspace: new\n    command: ${bump('items.txt')}\n    deliver: pr\n`,
      { packages: ['one', 'two', 'three'].map((name) => ({ name, id: name, after: [] })) });
    const gh = fakeGh(path.join(root, 'gh'));

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([0, 1, 2].map((index) => [`teamai/${runId}/build-${index}/p1`, 'main']));
    const run = await state(config, runId);
    expect(run.deliveries?.map((receipt) => receipt.step)).toEqual(['build[0]', 'build[1]', 'build[2]']);
    expect(buildEndRecord(run, remote, 'tester').prs).toEqual([1, 2, 3].map((number) => `https://github.com/fixture/app/pull/${number}`));
  });
});

describe('protected paths', () => {
  it('protect every path a step reads from the run base, every CI and hook path, and AGENTS.md or CLAUDE.md at any depth, in any case', () => {
    const changed = [...AGENT_PATHS, ...DELIVERY_ONLY_PATHS].flatMap((root) => [root, `${root}/nested/file`, root.toUpperCase()]);
    expect(protectedPaths(changed)).toEqual(changed);
    expect(protectedPaths(['src/app.ts', 'docs/agents.mdx', '.claudeignore', '.github/dependabot.yml', '.github/workflows-notes.md', 'packages/web/AGENTS.md', 'Claude.md']))
      .toEqual(['packages/web/AGENTS.md', 'Claude.md']);
  });
});

describe('reading the delivered branch', () => {
  it('tells a commit that is not an ancestor from a git error', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-code-'));
    execFileSync('git', ['init', '-q', repo]);
    const missing = '0'.repeat(40);

    try {
      expect((await worktree.git(repo, ['merge-base', '--is-ancestor', missing, missing], { timeoutMs: 5_000 })).code).toBe(128);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('reported URLs from a driver', () => {
  it('drops a URL with credentials without failing the report, and never stores, echoes or publishes it', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const accepted = await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://user:s3cret-value@github.com/fixture/app/pull/1', extra: 'kept-out' });
    expect(accepted).toMatchObject({ data: {
      accepted: true, step: { id: 'fix', status: 'delivering' },
      dropped: [{ field: 'changes.pr_url', reason: 'contains credentials' }], ignored: ['changes.extra'],
    } });
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    const run = await state(config, runId);
    expect(run.steps[0]).not.toHaveProperty('delivery.reported');
    expect(run.deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/1']);
    expect(JSON.stringify([accepted, run, buildEndRecord(run, remote, 'tester'), gh.calls()])).not.toMatch(/s3cret-value|kept-out/);
  });

  it('drops a URL from a step that does not deliver, saying why, and still accepts the report', async () => {
    const { config, root, runId } = await fixture('  - id: write\n    command: node write.js\n    workspace: new\n');
    const gh = fakeGh(path.join(root, 'gh'));
    expect(await succeed(config, runId, await take(config, runId), { pr_url: 'https://github.com/fixture/app/pull/1' })).toEqual({ data: {
      accepted: true, revision: 2, step: { id: 'write', status: 'succeeded', outcome: 'success' }, cleanup: true,
      dropped: [{ field: 'changes.pr_url', reason: 'the step has no deliver: pr' }],
    } });
    expect((await state(config, runId)).deliveries).toBeUndefined();
    expect(gh.calls()).toEqual([]);
  });

  it.each([
    ['fails', FIX_THEN_REVIEW, { outcome: 'failed' }, true, 'the step failed'],
    ['succeeds with stdout that does not match its output', `${FIX_THEN_REVIEW.split('  - id: review')[0]}    output:\n      ok: boolean\n`, { outcome: 'success', outputs: { ok: 'yes' } }, true, 'the step failed'],
    ['is released', FIX_THEN_REVIEW, { outcome: 'released' }, true, 'the step was released'],
    ['succeeds with its branch at the run base', FIX_THEN_REVIEW, { outcome: 'success' }, false, 'the branch has no changes beyond the run base'],
  ])('names a kept URL as dropped, without its value, when the step %s', async (_case, steps, body, pushes, reason) => {
    const { config, root, runId } = await fixture(steps);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const base = fix.workspace?.base.commit;
    const to = pushes ? pushWork(root, fix) : base;
    const url = 'https://review.acme.internal/changes/4821';
    const accepted = await report(config, runId, { attempt: fix.attempt, revision: fix.revision, ...body,
      changes: { branch: fix.workspace?.branch, base, from: base, to, commits: pushes ? [to] : [], pr_url: url } });

    expect(accepted).toMatchObject({ data: { accepted: true, dropped: [{ field: 'changes.pr_url', reason }] } });
    expect(JSON.stringify(accepted)).not.toContain('changes/4821');
    expect((await state(config, runId)).deliveries).toBeUndefined();
    expect(gh.calls()).toEqual([]);
  });

  it.each([
    ['is not the open pull request of its branch', [7], (branch: string) => `is not the open pull request of branch ${branch} into main`, 7],
    ['names a branch with no open pull request', [], (branch: string) => `branch ${branch} has no open pull request into main`, 1],
  ])('drops a URL on the origin host that %s, and delivers the open one of the branch instead', async (_case, open, reason, delivered) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    fakeGh(path.join(root, 'gh'), { open: open.map((number) => pull(number, branch)) });
    expect(await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://github.com/fixture/app/pull/9' })).toMatchObject({ data: {
      accepted: true, step: { id: 'fix', status: 'delivering' }, dropped: [{ field: 'changes.pr_url', reason: reason(branch) }],
    } });

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual([`https://github.com/fixture/app/pull/${delivered}`]);
  });

  it('keeps a URL on the origin host that is the open pull request of its branch, and opens nothing for it', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const gh = fakeGh(path.join(root, 'gh'), { open: [pull(4, `teamai/${runId}/fix/p1`)] });
    const accepted = await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://github.com/fixture/app/pull/4?tab=files#top' });
    expect(accepted).toMatchObject({ data: { accepted: true, step: { id: 'fix', status: 'delivering' } } });
    expect(accepted).not.toHaveProperty('data.dropped');

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/4']);
    expect(gh.calls().filter((call) => call.args[0] === 'pr')).toEqual([]);
  });

  it.each([
    ['cannot answer', (): FakeGhOptions => ({ lookup: 'fail' })],
    ['answers with a URL on another host', (branch: string): FakeGhOptions => ({ open: [{ ...pull(4, branch), html_url: 'https://github.example.net/fixture/app/pull/4' }] })],
  ])('drops a URL on the origin host when the lookup that checks it %s, without its value, and delivers the open one later', async (_case, options) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const gh = fakeGh(path.join(root, 'gh'), options(branch));
    const accepted = await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://github.com/fixture/app/pull/4' });
    expect(accepted).toMatchObject({ data: {
      accepted: true, step: { id: 'fix', status: 'delivering' }, dropped: [{ field: 'changes.pr_url', reason: `could not be checked against the open pull requests of branch ${branch} into main` }],
    } });
    expect(JSON.stringify(accepted)).not.toContain('pull/4');
    expect((await state(config, runId)).steps[0]).not.toHaveProperty('delivery.reported');

    gh.configure({ open: [pull(4, branch)] });
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/4']);
    expect(creates(gh)).toEqual([]);
  });
});

/**
 * Puts a provider double on the fixture's GitHub origin: `findOpen` answers lookups and `create` opens requests. Returns
 * the create spy, so a test can show what was asked of the host.
 */
function providerDouble(findOpen: PullRequestLookup['findOpen'], create: GitProvider['createPullRequest'], hostname = 'github.com') {
  const provider = new GitHubProvider();
  const creates = vi.spyOn(provider, 'createPullRequest').mockImplementation(create);
  vi.spyOn(registry, 'providerForRemote').mockReturnValue({ kind: 'provider', provider, pullRequests: { findOpen }, repo: 'fixture/app', hostname });
  return creates;
}

describe('retrying and cancelling a delivery', () => {
  it('delivers the winning child branch after an end cancels a sibling delivery', async () => {
    const { config, root, runId } = await fixture(`  - id: ship
    for_each: inputs.packages
    deliver: pr
    workflow:
      ends:
        done: succeeded
      steps:
        - id: loser
          command: echo loser
          workspace: new
          deliver: pr
        - id: winner
          needs: []
          command: echo winner
          workspace: new
          end: done
`, { packages: [{ name: 'a', id: 'a', after: [] }] });
    const gh = fakeGh(path.join(root, 'gh'));
    config.workflows = { tools: {}, ...config.workflows, max_parallel: 2 };
    const loser = await take(config, runId);
    const winnerNext = await leaseNext(config, runId, remote, { ...writable, running: [loser.attempt] });
    if ('error' in winnerNext) throw new Error(winnerNext.error.message);
    if (!winnerNext.data.lease) throw new Error(JSON.stringify(winnerNext));
    const winner = LeaseSchema.parse(winnerNext.data.lease);
    await succeed(config, runId, loser, { to: pushWork(root, loser, { 'loser.txt': 'loser' }) });
    await report(config, runId, { attempt: winner.attempt, revision: winner.revision, outcome: 'success',
      changes: { branch: winner.workspace?.branch, base: winner.workspace?.base.commit, from: winner.workspace?.base.commit,
        to: pushWork(root, winner, { 'winner.txt': 'winner' }), commits: [] } });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await state(config, runId);
    expect(run.steps.find((step) => step.id === 'ship[0].loser')).toMatchObject({ status: 'cancelled', settledAt: 2 });
    expect(creates(gh)).toEqual([[winner.workspace?.branch, 'main']]);
    expect(run.steps.find((step) => step.id === 'ship')).toMatchObject({ results: [{ branch: winner.workspace?.branch }] });
  });

  it('starts explicit cancellation recovery from the latest recorded write on a shared branch', async () => {
    const { config, root, runId } = await fixture(`  - id: work
    workspace: new
    workflow:
      steps:
        - id: impl
          command: echo impl
          workspace: continue
          deliver: pr
        - id: docs
          needs: []
          command: echo docs
          workspace: continue
        - id: recover
          needs: [impl, docs]
          if: steps.impl.outcome == 'cancelled'
          command: echo recover
          workspace: new
`);
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);
    const to = pushOnto(root, docs.workspace?.branch ?? '', { 'docs.txt': 'docs' });
    await succeed(config, runId, docs, { to });
    const settledAt = (await state(config, runId)).steps.find((step) => step.id === 'work.impl');
    await cancelRun(config, runId, await knownSecrets(config), 'work.impl');

    const recovery = await take(config, runId);
    expect(recovery).toMatchObject({ step: 'work.recover', workspace: { start: { commit: to } } });
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ settledAt: settledAt && 'settledAt' in settledAt ? settledAt.settledAt : undefined });
  });

  it.each([false, true])('retries delivery at a later recorded shared-branch tip and checks its protected paths (%s)', async (protectedChange) => {
    const { config, root, runId } = await fixture(`  - id: work
    workspace: new
    workflow:
      steps:
        - id: impl
          command: echo impl
          workspace: continue
          deliver: pr
        - id: docs
          needs: []
          command: echo docs
          workspace: continue
`);
    const gh = fakeGh(path.join(root, 'gh'), { lookup: 'fail' });
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const docs = await take(config, runId);
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed' } });
    const file = protectedChange ? '.github/workflows/docs.yml' : 'docs.txt';
    const to = pushOnto(root, docs.workspace?.branch ?? '', { [file]: 'docs' });
    await succeed(config, runId, docs, { to });
    expect((await state(config, runId)).copies?.[docs.workspace?.branch ?? '']?.commit).toBe(to);
    gh.configure({});
    await retryStep(config, runId, await knownSecrets(config), 'work.impl');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: protectedChange ? 'failed' : 'succeeded' } } });
    const run = await state(config, runId);
    if (protectedChange) {
      const message = `commit ${to}, which a later report recorded on the shared branch ${docs.workspace?.branch}, changed protected paths against the run base: ${file}. Step "work.impl" itself left them alone, so a retry does not run it again.`;
      expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(message) } });
      expect(creates(gh)).toEqual([]);
      expect(run.deliveries).toBeUndefined();
      await retryStep(config, runId, await knownSecrets(config), 'work.impl');
      expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering', attempt: impl.attempt });
    } else {
      expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'succeeded' });
      expect(creates(gh)).toEqual([[docs.workspace?.branch, 'main']]);
      expect(run.deliveries).toHaveLength(1);
    }
  });

  it.each(['puts origin back at the step\'s own commit', 'retries the workflow step'] as const)('names remedies for a protected change a later report recorded on the shared branch, and the run accepts the one that %s', async (remedy) => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'), { lookup: 'fail' });
    const impl = await take(config, runId);
    const own = pushWork(root, impl);
    await succeed(config, runId, impl, { to: own });
    const docs = await take(config, runId);
    const branch = docs.workspace?.branch ?? '';
    await succeed(config, runId, docs, { to: pushOnto(root, branch, { '.github/workflows/docs.yml': 'docs' }) });
    gh.configure({});
    await retryStep(config, runId, await knownSecrets(config), 'work.impl');
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failure = (await state(config, runId)).steps.find((step) => step.id === 'work.impl');
    expect(failure).toMatchObject({ failure: { code: 'delivery_failed', message: expect.stringContaining(`put branch ${branch} on origin back at ${own}, the commit the step reported, then run: teamai workflow retry ${runId} work.impl`) } });
    expect(failure).toMatchObject({ failure: { message: expect.stringContaining(`run its steps again in a new branch: teamai workflow retry ${runId} work`) } });

    if (remedy === 'retries the workflow step') {
      expect(await retryStep(config, runId, await knownSecrets(config), 'work')).toMatchObject({ data: { retried: { step: 'work', pass: 2 } } });
      expect(await take(config, runId)).toMatchObject({ step: 'work.impl', workspace: { branch: `teamai/${runId}/work/p2` } });
      return;
    }
    git(root, ['--git-dir=remote.git', 'update-ref', `refs/heads/${branch}`, own]);
    await retryStep(config, runId, await knownSecrets(config), 'work.impl');
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[branch, 'main']]);
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'succeeded' });
  });

  it('blames the delivering step for its own protected change when a later report recorded more work on the shared branch', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl, { '.github/workflows/impl.yml': 'impl' }) });
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);
    await succeed(config, runId, docs, { to: pushOnto(root, docs.workspace?.branch ?? '', { '.github/workflows/docs.yml': 'docs' }) });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failure = (await state(config, runId)).steps.find((step) => step.id === 'work.impl');
    expect(failure).toMatchObject({ status: 'failed', failure: { code: 'protected_path', message: expect.stringContaining('Step "work.impl" changed protected paths against the run base: .github/workflows/impl.yml.') } });
    expect(creates(gh)).toEqual([]);
  });

  it('refuses a recorded later tip whose history no longer holds the delivering step\'s commit', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    const own = pushWork(root, impl);
    await succeed(config, runId, impl, { to: own });
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);
    const branch = docs.workspace?.branch ?? '';
    const clone = fs.mkdtempSync(path.join(root, 'rewrite-'));
    git(root, ['clone', '-q', '-b', branch, path.join(root, 'remote.git'), clone]);
    git(clone, ['reset', '-q', '--hard', `${own}~1`]);
    fs.writeFileSync(path.join(clone, 'docs.txt'), 'docs');
    git(clone, ['add', '-A']);
    git(clone, ['-c', 'user.name=Driver', '-c', 'user.email=driver@example.com', 'commit', '-qm', 'rewrite']);
    git(clone, ['push', '-q', '--force', 'origin', branch]);
    const rewritten = git(clone, ['rev-parse', 'HEAD']);
    await succeed(config, runId, docs, { to: rewritten });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failure = (await state(config, runId)).steps.find((step) => step.id === 'work.impl');
    expect(failure).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`commit ${rewritten}, the last one a report recorded on branch ${branch}, does not contain commit ${own} the step reported`) } });
    expect(creates(gh)).toEqual([]);
    expect((await state(config, runId)).deliveries).toBeUndefined();
  });

  it('checks only the selected recorded tip when later work removed an earlier protected change', async () => {
    const { config, root, runId } = await fixture(`  - id: work
    workspace: new
    workflow:
      steps:
        - id: impl
          command: echo impl
          workspace: continue
          deliver: pr
        - id: docs
          needs: []
          command: echo docs
          workspace: continue
`);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl, { '.github/workflows/temporary.yml': 'temporary' }) });
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);
    const branch = docs.workspace?.branch ?? '';
    const clone = fs.mkdtempSync(path.join(root, 'correction-'));
    git(root, ['clone', '-q', '-b', branch, path.join(root, 'remote.git'), clone]);
    git(clone, ['rm', '.github/workflows/temporary.yml']);
    const to = commitAndPush(clone, branch, { 'docs.txt': 'docs' });
    await succeed(config, runId, docs, { to });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[branch, 'main']]);
    expect((await state(config, runId)).deliveries).toHaveLength(1);
  });

  it.each(['moved', 'missing'] as const)('names the commit the run recorded last when the shared branch on origin is %s at a retry', async (change) => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'), { lookup: 'fail' });
    const impl = await take(config, runId);
    const own = pushWork(root, impl);
    await succeed(config, runId, impl, { to: own });
    const docs = await take(config, runId);
    const branch = docs.workspace?.branch ?? '';
    const recorded = pushOnto(root, branch, { 'docs.txt': 'docs' });
    await succeed(config, runId, docs, { to: recorded });
    if (change === 'moved') pushOnto(root, branch, { 'later.txt': 'later' });
    else git(root, ['--git-dir=remote.git', 'update-ref', '-d', `refs/heads/${branch}`]);
    gh.configure({});
    await retryStep(config, runId, await knownSecrets(config), 'work.impl');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failure = (await state(config, runId)).steps.find((step) => step.id === 'work.impl');
    const remedy = change === 'moved' ? `Put branch ${branch} on origin back at ${recorded}, then run` : `push ${recorded} to it, then run`;
    expect(failure).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(remedy) } });
    expect(failure).not.toMatchObject({ failure: { message: expect.stringContaining(own) } });
    expect(creates(gh)).toEqual([]);
  });

  it('keeps a step delivering while origin\'s branch is ahead of what the run recorded, and delivers it once a report records that commit', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const branch = impl.workspace?.branch ?? '';
    let pushed = false;
    let docs: Lease | undefined;
    let ahead = '';
    const read = worktree.git;
    // The sibling is leased and pushes once delivery picked work.impl, before delivery reads the branch.
    vi.spyOn(worktree, 'git').mockImplementation(async (...args) => {
      if (!pushed && args[1].includes('ls-remote')) {
        pushed = true;
        docs = await take(config, runId);
        ahead = pushOnto(root, branch, { 'docs.txt': 'docs' });
      }
      return read(...args);
    });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { lease: { step: 'work.docs' } } });
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering' });
    expect(creates(gh)).toEqual([]);
    if (!docs) throw new Error('work.docs was never leased');
    await succeed(config, runId, docs, { to: ahead });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[branch, 'main']]);
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'succeeded' });
  });

  it('keeps waiting for a report of a commit ahead on origin while a step that writes the branch still runs, however many calls come', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);
    const branch = docs.workspace?.branch ?? '';
    const ahead = pushOnto(root, branch, { 'docs.txt': 'docs' });

    for (let drain = 1; drain <= 3; drain += 1) {
      expect(await leaseNext(config, runId, remote, { ...writable, running: [docs.attempt] })).toMatchObject({ data: { wait: { delivering: ['work.impl'] } } });
    }
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering' });
    expect(creates(gh)).toEqual([]);
    await succeed(config, runId, docs, { to: ahead });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[branch, 'main']]);
    expect((await state(config, runId)).steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'succeeded' });
  });

  it('keeps a step delivering when a report records origin\'s ahead commit while delivery reads the branch, and delivers it on the next call', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const branch = impl.workspace?.branch ?? '';
    let reported = false;
    const read = worktree.git;
    // The sibling is leased and pushes once delivery picked work.impl, and reports right after delivery read its push.
    vi.spyOn(worktree, 'git').mockImplementation(async (...args) => {
      if (reported || !args[1].includes('ls-remote')) return read(...args);
      reported = true;
      const docs = await take(config, runId);
      const ahead = pushOnto(root, branch, { 'docs.txt': 'docs' });
      const answer = await read(...args);
      await succeed(config, runId, docs, { to: ahead });
      return answer;
    });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { wait: { delivering: ['work.impl'] } } });
    expect(reported).toBe(true);
    expect(creates(gh)).toEqual([]);
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[branch, 'main']]);
  });

  it('records only the canonical receipt after an unconfirmed TGit-style create and a retry', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const canonical = 'https://git.woa.com/fixture/app/merge_requests/7';
    let recovered = false;
    const lookup = vi.fn(async () => {
      if (recovered) return canonical;
      if (create.mock.calls.length > 0) throw new Error('TGit lookup timed out');
      return undefined;
    });
    const create = providerDouble(lookup, async () => 'https://git.woa.com/fixture/app/-/merge_requests/7', 'git.woa.com');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failed = await state(config, runId);
    expect(failed.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`may have opened a pull request from branch ${fix.workspace?.branch}, but TeamAI could not confirm it`) } });
    expect(failed.steps[0]).toMatchObject({ failure: { message: expect.stringContaining(`teamai workflow retry ${runId} fix`) } });
    expect(failed.deliveries).toBeUndefined();
    expect(failed.creating).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(2);

    recovered = true;
    await retryStep(config, runId, await knownSecrets(config), 'fix');
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    const run = await state(config, runId);
    expect(run.creating).toBeUndefined();
    expect(run.deliveries?.map((receipt) => receipt.url)).toEqual([canonical]);
    expect(buildEndRecord(run, remote, 'tester').prs).toEqual([canonical]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('records only the canonical receipt when the lookup right after a TGit-style create does not list it yet', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const canonical = 'https://git.woa.com/fixture/app/merge_requests/7';
    let listed = false;
    const lookup = vi.fn(async () => (listed ? canonical : undefined));
    const create = providerDouble(lookup, async () => 'https://git.woa.com/fixture/app/-/merge_requests/7', 'git.woa.com');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const failed = await state(config, runId);
    expect(failed.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`may have opened a pull request from branch ${fix.workspace?.branch}, but TeamAI could not confirm it`) } });
    expect(failed.deliveries).toBeUndefined();
    expect(failed.creating).toHaveLength(1);

    listed = true;
    await leaseNext(config, runId, remote, writable);
    await retryStep(config, runId, await knownSecrets(config), 'fix');
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    const run = await state(config, runId);
    expect(run.creating).toBeUndefined();
    expect(run.deliveries?.map((receipt) => receipt.url)).toEqual([canonical]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries a failed delivery in the same pass and attempt, without a lease, and opens the pull request on the next call', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'), { lookup: 'fail' });
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });

    gh.configure({});
    expect(await retryStep(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: {} });
    const retried = (await state(config, runId)).steps[0];
    expect(retried).toMatchObject({ id: 'fix', status: 'delivering', attempt: fix.attempt });
    expect(retried?.pass ?? 1).toBe(1);
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect(creates(gh)).toEqual([[`teamai/${runId}/fix/p1`, 'main']]);
    expect((await state(config, runId)).steps[0]).toMatchObject({ id: 'fix', status: 'succeeded', attempt: fix.attempt });
  });

  it('retries a branch that changed protected paths by running the step again, in a new pass', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix, { '.github/workflows/ci.yml': 'on: push\n' }) });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });

    expect(await retryStep(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: {} });
    const again = await take(config, runId);
    expect(again).toMatchObject({ step: 'fix', pass: 2, workspace: { branch: `teamai/${runId}/fix/p2` } });
    expect(again.attempt).not.toBe(fix.attempt);
    expect(gh.calls()).toEqual([]);
  });

  it('cancels a delivering step and keeps its branch on origin', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    const to = pushWork(root, fix);
    await succeed(config, runId, fix, { to });

    expect(await cancelRun(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: { cancelled: { steps: ['fix'] } } });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[0]).toMatchObject({ id: 'fix', status: 'cancelled' });
    expect(git(root, ['--git-dir=remote.git', 'rev-parse', `refs/heads/teamai/${runId}/fix/p1`])).toBe(to);
    expect(gh.calls()).toEqual([]);
  });

  it('leaves a step delivering, opening nothing, while the run lock is held when its pull request is about to be opened', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const runLock = runLockPath(config, runId);
    let holding = false;
    let released = false;
    const update = store.updateRun;
    vi.spyOn(store, 'updateRun').mockImplementation(async (...args) => {
      const result = await update(...args);
      // The process that holds the run lock lets it go once an update gave up waiting for it.
      if (result.status === 'busy' && holding) {
        await releaseLock(runLock);
        holding = false;
        released = true;
      }
      return result;
    });
    let opened: string | undefined;
    const create = providerDouble(async () => {
      if (!released && !holding) holding = await acquireLock(runLock);
      return opened;
    }, async () => {
      opened = 'https://github.com/fixture/app/pull/1';
      return opened;
    });

    expect(await leaseNext(config, runId, remote, writable)).toEqual({ data: { wait: { reason: 'fix is delivering', delivering: ['fix'] }, cancelled: [] } });
    expect(released).toBe(true);
    expect((await state(config, runId)).steps[0]).toMatchObject({ id: 'fix', status: 'delivering' });
    expect(create).not.toHaveBeenCalled();

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it('opens nothing when the run is cancelled while its delivery looks for an open pull request', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const create = providerDouble(async () => {
      await cancelRun(config, runId, await knownSecrets(config));
      return undefined;
    }, async () => 'https://github.com/fixture/app/pull/1');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'cancelled' });
    expect(run.deliveries).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['pushes and records a protected commit while the lookup runs', 'lookup', true, false],
    ['pushes a protected commit while the lookup runs, and records it later', 'lookup', false, false],
    ['pushes and records a protected commit once delivery read origin\'s branch for the last time', 'last read', true, false],
    ['pushes and records a protected commit while the lookup finds the branch\'s open pull request', 'lookup', true, true],
  ] as const)('opens nothing when a sibling %s, and checks that commit on the next call', async (_case, when, recorded, open) => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const branch = impl.workspace?.branch ?? '';
    let docs: Lease | undefined;
    let sibling: string | undefined;
    // Leased only once delivery picked work.impl: a sibling leased before the pick holds the delivery back.
    const siblingPushes = async () => {
      docs = await take(config, runId);
      sibling = pushOnto(root, branch, { '.github/workflows/ci.yml': 'on: push\n' });
      if (recorded) await succeed(config, runId, docs, { to: sibling });
    };
    let looked = false;
    const read = worktree.git;
    vi.spyOn(worktree, 'git').mockImplementation(async (...args) => {
      const answer = await read(...args);
      if (when === 'last read' && looked && sibling === undefined && args[1].includes('ls-remote')) await siblingPushes();
      return answer;
    });
    let opened: string | undefined = open ? 'https://github.com/fixture/app/pull/1' : undefined;
    const create = providerDouble(async () => {
      if (when === 'lookup' && sibling === undefined) await siblingPushes();
      looked = true;
      return opened;
    }, async () => {
      opened = 'https://github.com/fixture/app/pull/1';
      return opened;
    });

    const answer = await leaseNext(config, runId, remote, writable);
    if (!docs) throw new Error('work.docs was never leased');
    // A sibling that has not reported is still leased, and this call did not list it as running, so it gets it back.
    expect(answer).toMatchObject({ data: recorded ? { wait: { delivering: ['work.impl'] } } : { lease: { step: 'work.docs', attempt: docs.attempt } } });
    const waiting = await state(config, runId);
    expect(waiting.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering' });
    expect(waiting.creating).toBeUndefined();
    expect(create).not.toHaveBeenCalled();

    if (!recorded) await succeed(config, runId, docs, { to: sibling });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    const message = `commit ${sibling}, which a later report recorded on the shared branch ${branch}, changed protected paths against the run base: .github/workflows/ci.yml.`;
    expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(message) } });
    expect(run.deliveries).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('opens nothing when a sibling that writes the shared branch is leased while the lookup runs, and checks its commit once it reports', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const branch = impl.workspace?.branch ?? '';
    let docs: Lease | undefined;
    const create = providerDouble(async () => {
      docs ??= await take(config, runId);
      return undefined;
    }, async () => 'https://github.com/fixture/app/pull/1');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { lease: { step: 'work.docs' } } });
    const waiting = await state(config, runId);
    expect(waiting.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering' });
    expect(waiting.creating).toBeUndefined();
    expect(create).not.toHaveBeenCalled();

    if (!docs) throw new Error('work.docs was never leased');
    const sibling = pushOnto(root, branch, { '.github/workflows/x.yml': 'on: push\n' });
    await succeed(config, runId, docs, { to: sibling });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`commit ${sibling}, which a later report recorded on the shared branch ${branch}`) } });
    expect(run.deliveries).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('takes no open pull request when a sibling that writes the shared branch is leased while the lookup finds it, and checks its commit once it reports', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const branch = impl.workspace?.branch ?? '';
    let docs: Lease | undefined;
    const create = providerDouble(async () => {
      docs ??= await take(config, runId);
      return 'https://github.com/fixture/app/pull/1';
    }, async () => 'https://github.com/fixture/app/pull/2');

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { lease: { step: 'work.docs' } } });
    const waiting = await state(config, runId);
    expect(waiting.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering' });
    expect(waiting.deliveries).toBeUndefined();

    if (!docs) throw new Error('work.docs was never leased');
    const sibling = pushOnto(root, branch, { '.github/workflows/x.yml': 'on: push\n' });
    await succeed(config, runId, docs, { to: sibling });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`commit ${sibling}, which a later report recorded on the shared branch ${branch}`) } });
    expect(run.deliveries).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('asks the host nothing while a sibling that writes the shared branch is leased, however many calls come', async () => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const gh = fakeGh(path.join(root, 'gh'));
    const impl = await take(config, runId);
    await succeed(config, runId, impl, { to: pushWork(root, impl) });
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);
    const branch = docs.workspace?.branch ?? '';

    for (let call = 1; call <= 3; call += 1) {
      expect(await leaseNext(config, runId, remote, { ...writable, running: [docs.attempt] })).toMatchObject({ data: { wait: { delivering: ['work.impl'] } } });
    }
    expect(gh.calls()).toEqual([]);

    await succeed(config, runId, docs, { to: pushOnto(root, branch, { 'docs.txt': 'docs' }) });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(creates(gh)).toEqual([[branch, 'main']]);
  });

  it.each([
    ['TeamAI would open its pull request', {}, false],
    ['its driver reported its pull request', { pr_url: 'https://github.com/fixture/app/pull/1' }, true],
    ['the lookup finds its open pull request', {}, true],
  ])('delivers nothing while a sibling that writes the shared branch is leased, when %s, and checks the sibling\'s commit once it reports', async (_case, changes, open) => {
    const { config, root, runId } = await fixture(IMPL_AND_DOCS);
    const impl = await take(config, runId);
    const branch = impl.workspace?.branch ?? '';
    const gh = fakeGh(path.join(root, 'gh'), { open: open ? [pull(1, branch)] : [] });
    expect(await succeed(config, runId, impl, { to: pushWork(root, impl), ...changes })).not.toHaveProperty('data.dropped');
    const lock = deliveryLockPath(config, runId);
    expect(await acquireLock(lock)).toBe(true);
    const docs = await take(config, runId);
    await releaseLock(lock);

    expect(await leaseNext(config, runId, remote, { ...writable, running: [docs.attempt] })).toMatchObject({ data: { wait: { delivering: ['work.impl'] } } });
    const waiting = await state(config, runId);
    expect(waiting.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'delivering' });
    expect(waiting.creating).toBeUndefined();
    expect(waiting.deliveries).toBeUndefined();

    const sibling = pushOnto(root, branch, { '.github/workflows/x.yml': 'on: push\n' });
    await succeed(config, runId, docs, { to: sibling });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`commit ${sibling}, which a later report recorded on the shared branch ${branch}`) } });
    expect(run.deliveries).toBeUndefined();
    expect(creates(gh)).toEqual([]);
  });

  it('records a pull request opened while the run was cancelled, keeps the step cancelled, and queues the end record again with it', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    config.usageReportEnabled = true;
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const url = 'https://github.com/fixture/app/pull/8';
    let opened: string | undefined;
    providerDouble(async () => opened, async () => {
      await cancelRun(config, runId, await knownSecrets(config));
      opened = url;
      return url;
    });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'cancelled' });
    expect(run.deliveries).toEqual([{ url, branch: `teamai/${runId}/fix/p1`, base: 'main', step: 'fix', pass: 1 }]);
    expect((await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end')?.prs).toEqual([url]);
  });

  it.each<[string, number]>([
    ['none', 2], ['failed', 3], ['unsafe', 1],
  ])('bounds unresolved-create lookups answering %s across drains', async (answer, limit) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    let recovering = false;
    const lookup = vi.fn(async () => {
      if (!recovering) return undefined;
      if (answer === 'failed') throw new Error('host unavailable');
      return answer === 'unsafe' ? 'https://other.example/pull/7' : undefined;
    });
    const create = providerDouble(lookup, async () => {
      await cancelRun(config, runId, await knownSecrets(config));
      throw new Error('create timed out');
    });
    await leaseNext(config, runId, remote, writable);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ lookups: { total: 0, none: 0, failed: 0 } })]);
    recovering = true;
    lookup.mockClear();

    for (let count = 1; count <= limit; count += 1) {
      await leaseNext(config, runId, remote, writable);
      expect(lookup).toHaveBeenCalledTimes(count);
      const run = await state(config, runId);
      if (count < limit) {
        expect(run.creating).toEqual([expect.objectContaining({ lookups: { total: count, none: answer === 'none' ? count : 0, failed: answer === 'failed' ? count : 0 } })]);
        const projected = projectRun(run, {});
        expect(projected.ok && projected.value.creating).toEqual(run.creating);
      } else expect(run.creating).toBeUndefined();
      expect(run.deliveries).toBeUndefined();
    }
    await leaseNext(config, runId, remote, writable);
    expect(lookup).toHaveBeenCalledTimes(limit);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty unresolved lookup until a later drain finds its receipt', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    let url: string | undefined;
    const lookup = vi.fn(async () => url);
    providerDouble(lookup, async () => {
      await cancelRun(config, runId, await knownSecrets(config));
      throw new Error('create timed out');
    });
    await leaseNext(config, runId, remote, writable);
    await leaseNext(config, runId, remote, writable);
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ lookups: { total: 1, none: 1, failed: 0 } })]);
    url = 'https://github.com/fixture/app/pull/7';
    await leaseNext(config, runId, remote, writable);
    const run = await state(config, runId);
    expect(run.creating).toBeUndefined();
    expect(run.deliveries?.map((receipt) => receipt.url)).toEqual([url]);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it('counts the lookups of a retried create from zero, so one empty lookup after it keeps the request listed', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const lookup = vi.fn(async () => undefined);
    const create = providerDouble(lookup, async () => {
      throw new Error('create timed out');
    });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    await leaseNext(config, runId, remote, writable);
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ lookups: { total: 1, none: 1, failed: 0 } })]);

    await retryStep(config, runId, await knownSecrets(config), 'fix');
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ lookups: { total: 0, none: 0, failed: 0 } })]);
    await leaseNext(config, runId, remote, writable);
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ lookups: { total: 1, none: 1, failed: 0 } })]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('records a pull request a cancelled delivery opened before its process stopped, by looking it up on a later call, and opens no other', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    config.usageReportEnabled = true;
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const url = 'https://github.com/fixture/app/pull/8';
    const open: string[] = [];
    let opened = (): void => {};
    const creating = new Promise<void>((resolve) => { opened = resolve; });
    const create = providerDouble(async ({ source, target }) => (source === branch && target === 'main' ? open[0] : undefined), async () => {
      await cancelRun(config, runId, await knownSecrets(config));
      open.push(url);
      opened();
      // The process stops here: the host opened the request, and the run never hears of it.
      return new Promise<string>(() => {});
    });
    void leaseNext(config, runId, remote, writable);
    await creating;
    // A stopped process leaves its delivery lock to whoever comes next.
    fs.rmSync(deliveryLockPath(config, runId), { force: true });
    expect((await state(config, runId)).steps[0]).toMatchObject({ id: 'fix', status: 'cancelled', delivery: { branch } });
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ step: 'fix', pass: 1, branch, target: 'main' })]);
    expect((await state(config, runId)).deliveries).toBeUndefined();

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'cancelled' });
    expect(run.deliveries).toEqual([{ url, branch, base: 'main', step: 'fix', pass: 1 }]);
    expect((await pendingRecords(config)).find((record) => record.run === runId && record.phase === 'end')?.prs).toEqual([url]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    expect((await state(config, runId)).deliveries).toHaveLength(1);
  });

  it('only looks up the request a cancelled delivery asked for before its process stopped, and opens none when the host holds none', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    let opened = (): void => {};
    const creating = new Promise<void>((resolve) => { opened = resolve; });
    const create = providerDouble(async () => undefined, async () => {
      if (create.mock.calls.length > 1) return 'https://github.com/fixture/app/pull/9';
      await cancelRun(config, runId, await knownSecrets(config));
      opened();
      // The process stops here, before the host opened anything.
      return new Promise<string>(() => {});
    });
    void leaseNext(config, runId, remote, writable);
    await creating;
    fs.rmSync(deliveryLockPath(config, runId), { force: true });
    expect((await state(config, runId)).steps[0]).toMatchObject({ id: 'fix', status: 'cancelled', delivery: { branch } });
    expect((await state(config, runId)).creating).toEqual([expect.objectContaining({ step: 'fix', pass: 1, branch, target: 'main' })]);

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    const run = await state(config, runId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(run.deliveries).toBeUndefined();
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'cancelled', delivery: { branch } });
    expect(run.creating).toEqual([expect.objectContaining({ lookups: { total: 1, none: 1, failed: 0 } })]);
    await leaseNext(config, runId, remote, writable);
    expect((await state(config, runId)).creating).toBeUndefined();
  });

  it('records a pull request a cancelled delivery opened before its process stopped, when the step is retried before any later call', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const url = 'https://github.com/fixture/app/pull/8';
    const open: string[] = [];
    let opened = (): void => {};
    const creating = new Promise<void>((resolve) => { opened = resolve; });
    const create = providerDouble(async ({ source, target }) => (source === branch && target === 'main' ? open[0] : undefined), async () => {
      await cancelRun(config, runId, await knownSecrets(config), 'fix');
      open.push(url);
      opened();
      return new Promise<string>(() => {});
    });
    void leaseNext(config, runId, remote, writable);
    await creating;
    fs.rmSync(deliveryLockPath(config, runId), { force: true });
    expect(await retryStep(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: { retried: { step: 'fix', pass: 2 } } });

    expect(await take(config, runId)).toMatchObject({ step: 'fix', pass: 2 });
    expect((await state(config, runId)).deliveries).toEqual([{ url, branch, base: 'main', step: 'fix', pass: 1 }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('leaves a step that was retried while a lookup-only reconcile ran delivering, and delivers it', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { to: pushWork(root, fix) });
    const url = 'https://github.com/fixture/app/pull/3';
    let retried = false;
    let opened: string | undefined;
    const create = providerDouble(async () => {
      const step = (await state(config, runId)).steps[0];
      if (step?.status === 'failed' && !retried) {
        retried = true;
        expect(await retryStep(config, runId, await knownSecrets(config), 'fix')).toMatchObject({ data: { retried: { step: 'fix', pass: 1 } } });
        return undefined;
      }
      if (create.mock.calls.length === 1 && !retried) throw new Error('GitHub timed out');
      return opened;
    }, async () => {
      if (create.mock.calls.length === 1) throw new Error('GitHub timed out');
      opened = url;
      return url;
    });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(retried).toBe(false);
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    const run = await state(config, runId);
    expect(retried).toBe(true);
    expect(run.steps[0]).toMatchObject({ id: 'fix', status: 'succeeded' });
    expect(run.deliveries?.map((receipt) => receipt.url)).toEqual([url]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('looks up before it opens again a pull request of a step that still delivers after its process stopped inside the create', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const branch = `teamai/${runId}/fix/p1`;
    const to = pushWork(root, fix);
    await succeed(config, runId, fix, { to });
    const url = 'https://github.com/fixture/app/pull/4';
    const asked: string[] = [];
    const open: string[] = [];
    let stopped = (): void => {};
    const creating = new Promise<void>((resolve) => { stopped = resolve; });
    const create = providerDouble(async () => {
      asked.push('find');
      return open[0];
    }, async () => {
      asked.push('create');
      if (create.mock.calls.length > 1) {
        open.push(url);
        return url;
      }
      stopped();
      // The process stops here, before the host opened anything, and the step still delivers.
      return new Promise<string>(() => {});
    });
    void leaseNext(config, runId, remote, writable);
    await creating;
    fs.rmSync(deliveryLockPath(config, runId), { force: true });
    const marked = await state(config, runId);
    expect(marked.steps[0]).toMatchObject({ id: 'fix', status: 'delivering' });
    expect(marked.creating).toEqual([{ step: 'fix', pass: 1, settledAt: 2, branch, head: to, target: 'main', lookups: { total: 0, none: 0, failed: 0 } }]);
    const handed = projectRun(marked, {});
    expect(handed.ok && handed.value.creating).toEqual(marked.creating);

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect(asked).toEqual(['find', 'create', 'find', 'create', 'find']);
    const run = await state(config, runId);
    expect(run.deliveries).toEqual([{ url, branch, base: 'main', step: 'fix', pass: 1 }]);
    expect(run.creating).toBeUndefined();
  });
});

describe('limits that stop a delivering run', () => {
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000);
  const TIMED_WORK = `  - id: work
    workspace: new
    timeout: 10m
    workflow:
      steps:
        - id: impl
          command: echo impl
          workspace: continue
          deliver: pr
  - id: after
    needs: [work]
    command: echo after
`;

  it.each([
    ['while its step delivers', 'before'],
    ['while its delivery looks for an open pull request', 'lookup'],
  ] as const)('opens nothing once a timeout passes %s', async (_case, when) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at(0));
      const { config, root, runId } = await fixture(TIMED_WORK);
      const impl = await take(config, runId);
      await succeed(config, runId, impl, { to: pushWork(root, impl) });
      const lookup = vi.fn(async () => {
        if (when === 'lookup') vi.setSystemTime(at(15));
        return undefined;
      });
      const create = providerDouble(lookup, async () => 'https://github.com/fixture/app/pull/1');
      if (when === 'before') vi.setSystemTime(at(15));

      await leaseNext(config, runId, remote, writable);
      const run = await state(config, runId);
      expect(create).not.toHaveBeenCalled();
      expect(run.deliveries).toBeUndefined();
      expect(run.creating).toBeUndefined();
      expect(run.steps.find((step) => step.id === 'work')).toMatchObject({ status: 'failed', failure: { code: 'timeout' } });
      expect(run.steps.find((step) => step.id === 'work.impl')).toMatchObject({ status: 'cancelled' });
      if (when === 'before') expect(lookup).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

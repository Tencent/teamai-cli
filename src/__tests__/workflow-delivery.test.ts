import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { parseWorkflow } from '../workflow/parse.js';
import { leaseNext, parseReport, reportAttempt, startRun, withIgnored } from '../workflow/engine.js';
import { sanitizePrUrl } from '../workflow/pr-url.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { deliveryLockPath, readRun } from '../workflow/store.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/local-driver.js';
import { acquireLock, releaseLock } from '../update.js';
import { AGENT_PATHS, DELIVERY_ONLY_PATHS, protectedPaths } from '../workflow/worktree.js';
import { fakeGh } from './helpers/fake-gh.js';
import { deliverPr } from '../workflow/pr-delivery.js';
import { buildEndRecord, pendingRecords } from '../workflow/records.js';
import { projectRun } from '../workflow/snapshot.js';
import * as worktree from '../workflow/worktree.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
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
  const started = await startRun(config, 'ship', inputs ?? {}, { checkout: cwd, base: { ref: 'main', commit: git(cwd, ['rev-parse', 'HEAD']) } });
  if ('error' in started) throw new Error(started.error.message);
  return { config, cwd, root, runId: String(started.data.run) };
}

async function state(config: LocalConfig, runId: string): Promise<RunState> {
  const run = await readRun(config, runId);
  if (typeof run === 'string') throw new Error(run);
  return run;
}

const LeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(),
  workspace: z.object({ branch: z.string(), base: z.object({ commit: z.string() }) }).optional(),
});
type Lease = z.infer<typeof LeaseSchema>;
const remote = { kind: 'remote', machine: 'paseo', workspace: 'session-1' };
const writable = { workspaceModes: ['read-only', 'new', 'continue'] as Array<'read-only' | 'new' | 'continue'> };
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
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    fs.writeFileSync(path.join(clone, file), content);
  }
  git(clone, ['add', '-A']);
  git(clone, ['-c', 'user.name=Driver', '-c', 'user.email=driver@example.com', 'commit', '-qm', 'work']);
  git(clone, ['push', '-q', 'origin', lease.workspace.branch]);
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
    const [lookup, create, ...rest] = gh.calls();
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
    // A step marked before it asks GitHub to open a request looks one up first after a crash; one found needs no mark.
    expect(run.steps[0]).toMatchObject({ delivery: { branch, ...('create' in options ? { creating: true } : {}) } });
    if (!('create' in options)) expect(run.steps[0]).not.toHaveProperty('delivery.creating');
    const handed = projectRun(run, {});
    expect(handed.ok && handed.value.steps[0]).toEqual(run.steps[0]);
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
    expect(await retryStep(config, runId, 'fix')).toMatchObject({ data: {} });
    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it('asks the run before it opens a pull request, and opens none for a step that stopped delivering', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    const gh = fakeGh(path.join(root, 'gh'));
    const fix = await take(config, runId);
    if (!fix.workspace) throw new Error('fix has no workspace');
    const to = pushWork(root, fix);
    const job = { key: { step: 'fix', pass: 1, settledAt: 2, branch: fix.workspace.branch, head: to }, runId, runName: 'ship', checkout: cwd, base: fix.workspace.base.commit, target: 'main' };

    expect(await deliverPr(job, async () => false)).toEqual({ ok: false, fault: { kind: 'withdrawn' } });
    expect(gh.calls().map((call) => call.args[0])).toEqual(['api']);
  });

  it('cancels a delivering step: it delivers nothing and its dependents do not run', async () => {
    const { config, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { pr_url: 'https://review.acme.internal/changes/1' });

    expect(await cancelRun(config, runId, 'fix')).toMatchObject({ data: { cancelled: { steps: ['fix'], attempts: [] }, run: { status: 'failed' } } });
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
      await cancelRun(config, runId);
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

  it.todo('delivers a workflow step with workspace: new once, against the delivered branch of the step it needs');
  it.todo('delivers each for_each item against the delivered branch of the item it waited for, and lists the PRs in item order');
  it.todo('targets the nearest delivered branch, passing over a need that was skipped');
});

describe('protected paths', () => {
  it('protect every path a step reads from the run base, every CI and hook path, and AGENTS.md or CLAUDE.md at any depth, in any case', () => {
    const changed = [...AGENT_PATHS, ...DELIVERY_ONLY_PATHS].flatMap((root) => [root, `${root}/nested/file`, root.toUpperCase()]);
    expect(protectedPaths(changed)).toEqual(changed);
    expect(protectedPaths(['src/app.ts', 'docs/agents.mdx', '.claudeignore', '.github/dependabot.yml', '.github/workflows-notes.md', 'packages/web/AGENTS.md', 'Claude.md']))
      .toEqual(['packages/web/AGENTS.md', 'Claude.md']);
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

  it.each([
    ['is the open pull request of its branch', {}],
    ['cannot be checked while GitHub cannot be reached', { lookup: 'fail' as const }],
  ])('keeps a URL on the origin host that %s, and opens nothing for it', async (_case, options) => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const gh = fakeGh(path.join(root, 'gh'), { ...options, open: [pull(4, `teamai/${runId}/fix/p1`)] });
    const accepted = await succeed(config, runId, fix, { to: pushWork(root, fix), pr_url: 'https://github.com/fixture/app/pull/4?tab=files#top' });
    expect(accepted).toMatchObject({ data: { accepted: true, step: { id: 'fix', status: 'delivering' } } });
    expect(accepted).not.toHaveProperty('data.dropped');

    expect(await take(config, runId)).toMatchObject({ step: 'review' });
    expect((await state(config, runId)).deliveries?.map((receipt) => receipt.url)).toEqual(['https://github.com/fixture/app/pull/4']);
    expect(gh.calls().filter((call) => call.args[0] === 'pr')).toEqual([]);
  });
});

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
import { GitHubProvider } from '../providers/github/index.js';
import { buildEndRecord, pendingRecords } from '../workflow/records.js';
import { projectRun } from '../workflow/snapshot.js';
import * as worktree from '../workflow/worktree.js';
import { cancelRun } from '../workflow/run-controls.js';
import type { LocalConfig } from '../types.js';
import type { RunState } from '../workflow/types.js';

_setDriverPollMs(20);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
  if (!('data' in next)) throw new Error(JSON.stringify(next));
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

/** The pull request lookups and creates a GitHub origin could see, none of which may run. */
function provider() {
  return [
    vi.spyOn(GitHubProvider.prototype, 'createPullRequest').mockRejectedValue(new Error('no PR may be opened')),
    vi.spyOn(GitHubProvider.prototype, 'findOpenPullRequest').mockRejectedValue(new Error('no PR may be looked up')),
    vi.spyOn(GitHubProvider.prototype, 'validatePullRequest').mockRejectedValue(new Error('no PR may be read')),
  ];
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
    const create = vi.spyOn(GitHubProvider.prototype, 'createPullRequest').mockRejectedValue(new Error('no PR may be opened'));
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
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
    expect(create).not.toHaveBeenCalled();

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

  it('fails a delivery that has no URL and no host to open one on, naming the branch that keeps the work', async () => {
    const { config, cwd, root, runId } = await fixture(FIX_THEN_REVIEW);
    git(cwd, ['remote', 'set-url', 'origin', path.join(root, 'remote.git')]);
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
  });

  it('cancels a delivering step: it delivers nothing and its dependents do not run', async () => {
    const { config, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    await succeed(config, runId, fix, { pr_url: 'https://review.acme.internal/changes/1' });

    expect(await cancelRun(config, runId, 'fix')).toMatchObject({ data: { cancelled: { steps: ['fix'], attempts: [] }, run: { status: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps).toMatchObject([{ id: 'fix', status: 'cancelled', attempt: fix.attempt }, { id: 'review', status: 'skipped' }]);
    expect(run.deliveries).toBeUndefined();
  });

  it.each([
    ['TeamAI would open the pull request', {}],
    ['the driver reported one', { pr_url: 'https://github.com/fixture/app/pull/1' }],
  ])('refuses a branch that changes protected paths, naming them, before any provider request, when %s', async (_case, changes) => {
    const calls = provider();
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    const to = pushWork(root, fix, { '.github/workflows/ci.yml': 'on: push\n', 'src/app.ts': 'ok\n', 'packages/web/CLAUDE.md': 'rules\n' });
    await succeed(config, runId, fix, { to, ...changes });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps).toMatchObject([
      { id: 'fix', status: 'failed', failure: { code: 'protected_path', message: expect.stringContaining('.github/workflows/ci.yml, packages/web/CLAUDE.md.') } },
      { id: 'review', status: 'skipped' },
    ]);
    expect(run.steps[0]).not.toMatchObject({ failure: { message: expect.stringContaining('src/app.ts') } });
    expect(run.deliveries).toBeUndefined();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it('reads a reported head only as a full commit id, so a ref name cannot stand in for the pushed branch', async () => {
    const { config, root, runId } = await fixture(FIX_THEN_REVIEW);
    const fix = await take(config, runId);
    pushWork(root, fix, { '.github/workflows/ci.yml': 'on: push\n' });
    await succeed(config, runId, fix, { to: 'main', pr_url: 'https://github.com/fixture/app/pull/1' });

    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[0]).toMatchObject({
      status: 'failed', failure: { code: 'delivery_failed', message: expect.stringContaining(`Push branch teamai/${runId}/fix/p1 to origin`) },
    });
  });

  it('refuses protected changes the branch inherited from a step it needs, though the delivering step left them alone', async () => {
    const calls = provider();
    const write = (file: string) => `node -e "require('fs').mkdirSync(require('path').dirname('${file}'),{recursive:true});require('fs').writeFileSync('${file}','x')"`;
    const { config, cwd, runId } = await fixture(`  - id: earlier\n    workspace: new\n    command: ${write('.github/workflows/ci.yml')}\n  - id: later\n    needs: [earlier]\n    workspace: new\n    command: ${write('change.txt')}\n    deliver: pr\n`);

    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[1]).toMatchObject({ id: 'later', status: 'failed', failure: { code: 'protected_path', message: expect.stringContaining('.github/workflows/ci.yml') } });
    for (const call of calls) expect(call).not.toHaveBeenCalled();
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
    const validate = vi.spyOn(GitHubProvider.prototype, 'validatePullRequest');
    const { config, runId } = await fixture(FIX_THEN_REVIEW);
    const accepted = await succeed(config, runId, await take(config, runId), { pr_url: 'https://user:s3cret-value@github.com/fixture/app/pull/1', extra: 'kept-out' });
    expect(accepted).toMatchObject({ data: {
      accepted: true, step: { id: 'fix', status: 'delivering' },
      dropped: [{ field: 'changes.pr_url', reason: 'contains credentials' }], ignored: ['changes.extra'],
    } });
    expect(await leaseNext(config, runId, remote, writable)).toMatchObject({ data: { done: {} } });
    const run = await state(config, runId);
    expect(run.steps[0]).not.toHaveProperty('delivery.reported');
    expect(JSON.stringify([accepted, run, buildEndRecord(run, remote, 'tester')])).not.toMatch(/s3cret-value|kept-out/);
    expect(validate).not.toHaveBeenCalled();
  });

  it('drops a URL from a step that does not deliver, saying why, and still accepts the report', async () => {
    const { config, runId } = await fixture('  - id: write\n    command: node write.js\n    workspace: new\n');
    expect(await succeed(config, runId, await take(config, runId), { pr_url: 'https://github.com/fixture/app/pull/1' })).toEqual({ data: {
      accepted: true, revision: 2, step: { id: 'write', status: 'succeeded', outcome: 'success' }, cleanup: true,
      dropped: [{ field: 'changes.pr_url', reason: 'the step has no deliver: pr' }],
    } });
    expect((await state(config, runId)).deliveries).toBeUndefined();
  });
});

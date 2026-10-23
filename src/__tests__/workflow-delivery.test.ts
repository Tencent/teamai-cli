import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseWorkflow } from '../workflow/parse.js';
import { leaseNext, parseReport, reportAttempt, startRun } from '../workflow/engine.js';
import { sanitizePrUrl } from '../workflow/pr-url.js';
import { deliveryTarget, protectedDeliveryPaths, validateReportedPr } from '../workflow/delivery.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { readRun, writeRun } from '../workflow/store.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import { GitHubProvider } from '../providers/github/index.js';
import { buildEndRecord } from '../workflow/records.js';
import { cancelRun, retryStep } from '../workflow/run-controls.js';
import { settled, stopped } from '../workflow/step-state.js';
import type { LocalConfig } from '../types.js';
import type { RunState } from '../workflow/types.js';

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

const command = `node -e "require('fs').writeFileSync('change.txt', 'change')"`;
const driver = { kind: 'local', machine: 'fixture', workspace: 'fixture' };

function provider() {
  const lookup = vi.spyOn(GitHubProvider.prototype, 'findOpenPullRequest').mockResolvedValue(undefined);
  const validate = vi.spyOn(GitHubProvider.prototype, 'validatePullRequest').mockResolvedValue(true);
  let number = 0;
  const create = vi.spyOn(GitHubProvider.prototype, 'createPullRequest').mockImplementation(async () => `https://github.com/fixture/app/pull/${++number}`);
  return { lookup, validate, create };
}

describe('workflow PR delivery contract', () => {
  it('parses delivery on a writable step and rejects unsupported delivery', () => {
    const yaml = 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship changes\nsteps:\n  - id: write\n    command: node write.js\n    workspace: new\n    deliver: pr\n';
    const parsed = parseWorkflow('ship.yaml', yaml);
    expect(parsed.ok && parsed.definition.steps[0]).toMatchObject({ deliver: 'pr' });
    expect(parseWorkflow('ship.yaml', yaml.replace('deliver: pr', 'deliver: merge')).ok).toBe(false);
  });

  it('keeps the URL for validation and names unread nested fields without values', () => {
    const parsed = parseReport({ attempt: 'a1', revision: 1, outcome: 'success',
      driver: { kind: 'remote', machine: 'host', workspace: 'work' },
      changes: { branch: 'work', base: 'base', from: 'base', to: 'head', commits: [], pr_url: 'https://review.example/1', private: 'secret' } });
    expect(parsed).toMatchObject({ report: { changes: { pr_url: 'https://review.example/1' } }, ignored: ['changes.private'] });
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it.each([
    ['https://github.com/acme/app/pull/101', 'https://github.com/acme/app/pull/101'],
    ['https://bitbucket.acme.internal/projects/APP/repos/web/pull-requests/7/overview', 'https://bitbucket.acme.internal/projects/APP/repos/web/pull-requests/7/overview'],
    ['https://review.acme.internal/changes/4821?session=abc#c3', 'https://review.acme.internal/changes/4821'],
    ['https://user:token@github.com/acme/app/pull/1', undefined],
    ['http://github.com/acme/app/pull/1', undefined], ['not a url', undefined],
    [`https://example.com/${'a'.repeat(512)}`, undefined],
  ])('sanitizes %s', (value, expected) => expect(sanitizePrUrl(value).url).toBe(expected));

  it('never preserves credentials, queries or fragments and is idempotent and bounded', () => {
    fc.assert(fc.property(fc.webUrl({ validSchemes: ['https', 'http'] }), (value) => {
      const result = sanitizePrUrl(value);
      if (!result.url) return;
      const url = new URL(result.url);
      expect(url.protocol).toBe('https:');
      expect([url.username, url.password, url.search, url.hash]).toEqual(['', '', '', '']);
      expect(result.url.length).toBeLessThanOrEqual(512);
      expect(sanitizePrUrl(result.url)).toEqual(result);
    }), { numRuns: 300 });
  });
});

describe('durable PR delivery', () => {
  it('pushes a branch and opens a PR against the recorded base without merging', async () => {
    const api = provider();
    const { config, cwd, root, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n    deliver: pr\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ status: 'succeeded', changes: { pr_url: 'https://github.com/fixture/app/pull/1' } });
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ repo: 'fixture/app', source: `teamai/${runId}/write/p1`, target: 'main' }));
    expect(git(root, ['--git-dir=remote.git', 'show', `refs/heads/teamai/${runId}/write/p1:change.txt`])).toBe('change');
    expect(git(cwd, ['show', 'main:base.txt'])).toBe('base');
    expect(buildEndRecord(run, driver, 'tester').prs).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it('keeps pushed work after missing credentials and retries delivery without rerunning the agent', async () => {
    const api = provider();
    api.lookup.mockRejectedValue(new Error('Set GITHUB_TOKEN before resuming.'));
    const { config, cwd, root, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n    deliver: pr\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'failed' } } });
    let run = await state(config, runId);
    const branch = `teamai/${runId}/write/p1`;
    expect(run.steps[0]).toMatchObject({ failure: { code: 'delivery_failed', message: expect.stringContaining(branch) } });
    expect(git(root, ['--git-dir=remote.git', 'show', `${branch}:change.txt`])).toBe('change');
    const attempts = run.settledCount;
    api.lookup.mockResolvedValue('https://github.com/fixture/app/pull/88');
    expect(await retryStep(config, runId, 'write')).toMatchObject({ data: { reopened: true } });
    run = await state(config, runId);
    expect(run.steps[0]?.status).toBe('delivering');
    expect(settled(run.steps[0])).toBe(false);
    expect(stopped(run.steps[0]!)).toBe(false);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    run = await state(config, runId);
    expect(run.settledCount).toBe(attempts);
    expect(api.create).not.toHaveBeenCalled();
    expect(run.steps[0]).toMatchObject({ changes: { branch, pr_url: 'https://github.com/fixture/app/pull/88' } });
  });

  it('checks protected changes against the run base before any provider request', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: write\n    command: node -e "require('fs').mkdirSync('.github/workflows',{recursive:true});require('fs').writeFileSync('.github/workflows/evil.yml','bad')"\n    workspace: new\n    deliver: pr\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[0]).toMatchObject({ failure: { message: expect.stringContaining('.github/workflows/evil.yml') } });
    expect(api.create).not.toHaveBeenCalled(); expect(api.lookup).not.toHaveBeenCalled();
    expect(protectedDeliveryPaths(['src/a.ts', '.mcp.json', '.cursor/rules/x', 'nested/AGENTS.md', '.husky/pre-commit'])).toEqual(['.mcp.json', '.cursor/rules/x', 'nested/AGENTS.md', '.husky/pre-commit']);
  });

  it('delivers a continued composite branch once and follows inherited needs', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: first\n    command: ${command}\n    workspace: new\n    deliver: pr\n  - id: change\n    needs: [first]\n    workspace: new\n    deliver: pr\n    workflow:\n      steps:\n        - id: write\n          workspace: continue\n          command: node -e "require('fs').writeFileSync('second.txt','second')"\n        - id: review\n          needs: [write]\n          command: cat second.txt\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1]?.[0]).toMatchObject({ source: `teamai/${runId}/change/p1`, target: `teamai/${runId}/first/p1` });
    expect((await state(config, runId)).steps.find((step) => step.id === 'change')).toMatchObject({ status: 'succeeded', changes: { pr_url: 'https://github.com/fixture/app/pull/2' } });
  });

  it('delivers each after-item against its actual origin and publishes PRs in item order', async () => {
    const api = provider();
    const { config, cwd, root, runId } = await fixture(`  - id: packages\n    for_each:\n      items: inputs.packages\n    workspace: new\n    deliver: pr\n    command: node -e "require('fs').writeFileSync(process.env.PACKAGE+'.txt',process.env.PACKAGE)"\n    env:\n      PACKAGE: "{{ item.name }}"\n`, { packages: [{ name: 'one', id: 'one', after: [] }, { name: 'two', id: 'two', after: ['one'] }, { name: 'three', id: 'three', after: ['two'] }] });
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(api.create.mock.calls.map(([opts]) => opts.target)).toEqual(['main', `teamai/${runId}/packages-0/p1`, `teamai/${runId}/packages-1/p1`]);
    expect(git(root, ['--git-dir=remote.git', 'diff', '--name-only', `teamai/${runId}/packages-0/p1`, `teamai/${runId}/packages-1/p1`])).toBe('two.txt');
    expect(buildEndRecord(await state(config, runId), driver, 'tester').prs).toEqual([1, 2, 3].map((n) => `https://github.com/fixture/app/pull/${n}`));
  });

  it('accepts sanitized remote links, drops unsafe/mismatched ones without exposing their values', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n`);
    const next = await leaseNext(config, runId, driver, { workspaceModes: ['new'], base: { ref: 'main', commit: git(cwd, ['rev-parse', 'HEAD']) } });
    const lease = 'data' in next && next.data.lease as { attempt: string; revision: number; workspace: { branch: string; base: { commit: string } } };
    if (!lease) throw new Error(JSON.stringify(next));
    const changes = { branch: lease.workspace.branch, base: lease.workspace.base.commit, from: 'a', to: 'b', commits: [], pr_url: 'https://user:token@github.com/fixture/app/pull/1' };
    const accepted = await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, driver, outcome: 'success', changes });
    expect(accepted).toMatchObject({ data: { accepted: true, dropped: [{ field: 'changes.pr_url', reason: 'contains credentials' }] } });
    expect(JSON.stringify([accepted, await state(config, runId)])).not.toContain('token');
    expect(api.validate).not.toHaveBeenCalled();
  });

  it.each([
    { url: 'https://review.example/changes/1?session=secret#note', valid: undefined, expected: 'https://review.example/changes/1', reason: undefined },
    { url: 'https://github.com/fixture/app/pull/1', valid: false, expected: undefined, reason: 'repository or branches do not match the lease' },
  ])('records only a validated driver link ($url)', async ({ url, valid, expected, reason }) => {
    const api = provider(); api.validate.mockResolvedValue(valid);
    const { config, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n`);
    const next = await leaseNext(config, runId, driver, { workspaceModes: ['new'] });
    const lease = 'data' in next && next.data.lease as { attempt: string; revision: number; workspace: { branch: string; base: { commit: string } } };
    if (!lease) throw new Error('missing lease');
    const accepted = await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, driver, outcome: 'success', changes: {
      branch: lease.workspace.branch, base: lease.workspace.base.commit, from: 'a', to: 'b', commits: [], pr_url: url,
    } });
    expect(accepted).toMatchObject({ data: { accepted: true, ...(reason ? { dropped: [{ field: 'changes.pr_url', reason }] } : {}) } });
    const run = await state(config, runId);
    expect(buildEndRecord(run, driver, 'tester').prs).toEqual(expected ? [expected] : undefined);
    expect(JSON.stringify(run)).not.toContain('session=');
  });

  it('can cancel a persisted delivery without treating it as settled success', async () => {
    const { config, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n    deliver: pr\n`);
    const run = await state(config, runId);
    run.steps = [{ id: 'write', status: 'delivering', settledAt: 1, changes: { branch: 'work', base: 'base', from: 'base', to: 'head', commits: [] } }];
    await writeRun(config, run);
    expect(await cancelRun(config, runId, 'write')).toMatchObject({ data: { run: { status: 'failed' } } });
    expect((await state(config, runId)).steps[0]).toMatchObject({ status: 'cancelled' });
  });

  it('walks undelivered origin branches and deduplicates URLs from passes and archives', async () => {
    const { config, runId } = await fixture(`  - id: write\n    command: echo test\n`);
    const run = await state(config, runId);
    const changes = { branch: 'first', base: 'base', from: 'base', to: 'head', commits: [], pr_url: 'https://review.example/1', prRecordedAt: 2 };
    run.copies = { second: { owner: driver, origin: 'first' }, third: { owner: driver, origin: 'second' } };
    run.steps = [{ id: 'write', status: 'succeeded', outcome: 'success', settledAt: 4, changes: { ...changes, branch: 'third', prRecordedAt: 4 }, passes: [{ pass: 1, outcome: 'success', changes }] }];
    run.archive = [{ step: 'older', pass: 1, outcome: 'success', changes: { ...changes, pr_url: 'https://review.example/2', prRecordedAt: 3 } }];
    expect(deliveryTarget(run, 'third')).toBe('first');
    expect(buildEndRecord(run, driver, 'tester').prs).toEqual(['https://review.example/1', 'https://review.example/2']);
    if (run.steps[0]?.status === 'succeeded') run.steps[0].outputs = { pr_url: 'https://untrusted.example/no' };
    expect(buildEndRecord(run, driver, 'tester').prs).not.toContain('https://untrusted.example/no');
  });

  it('opens a separate PR per new-workspace loop pass and retains all earlier URLs', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n    deliver: pr\n    loop: { back_to: write, while: "length(steps.write.passes) < 3", max_iterations: 3 }\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(api.create.mock.calls.map(([opts]) => opts.source)).toEqual([1, 2, 3].map((pass) => `teamai/${runId}/write/p${pass}`));
    expect(buildEndRecord(await state(config, runId), driver, 'tester').prs).toEqual([1, 2, 3].map((n) => `https://github.com/fixture/app/pull/${n}`));
  });

  it('reuses one PR when a loop continues the same branch', async () => {
    const api = provider();
    api.lookup.mockImplementation(async () => api.create.mock.calls.length ? 'https://github.com/fixture/app/pull/1' : undefined);
    const { config, cwd, runId } = await fixture(`  - id: change\n    workspace: new\n    workflow:\n      steps:\n        - id: write\n          workspace: continue\n          command: node -e "require('fs').appendFileSync('change.txt','pass\\n')"\n          deliver: pr\n          loop: { back_to: write, while: "length(steps.write.passes) < 3", max_iterations: 3 }\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(api.create).toHaveBeenCalledTimes(1); expect(api.lookup).toHaveBeenCalledTimes(3);
    expect(buildEndRecord(await state(config, runId), driver, 'tester').prs).toEqual(['https://github.com/fixture/app/pull/1']);
  });

  it('passes over a skipped first need to the earlier delivered branch', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: first\n    command: ${command}\n    workspace: new\n    deliver: pr\n  - id: other\n    needs: []\n    workspace: new\n    command: node -e "require('fs').writeFileSync('other.txt','other')"\n    deliver: pr\n  - id: skipped\n    needs: [first]\n    if: steps.first.outcome == 'failed'\n    command: echo skipped\n  - id: last\n    needs: [skipped, other]\n    workspace: new\n    command: node -e "require('fs').writeFileSync('last.txt','last')"\n    deliver: pr\n`);
    expect(await runLocalDriver(config, runId, cwd), JSON.stringify(await state(config, runId))).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(api.create.mock.calls[2]?.[0]).toMatchObject({ source: `teamai/${runId}/last/p1`, target: `teamai/${runId}/first/p1` });
  });

  it('rejects inherited protected changes even when the delivering step did not edit those paths', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: earlier\n    workspace: new\n    command: node -e "require('fs').mkdirSync('.github/workflows',{recursive:true});require('fs').writeFileSync('.github/workflows/ci.yml','bad')"\n  - id: later\n    needs: [earlier]\n    workspace: new\n    command: ${command}\n    deliver: pr\n`);
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[1]).toMatchObject({ failure: { message: expect.stringContaining('.github/workflows/ci.yml') } });
    expect(api.lookup).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
  });

  it('allows cancellation during provider I/O and retains the resulting PR receipt without reviving the step', async () => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n    deliver: pr\n`);
    api.create.mockImplementation(async () => {
      expect(await cancelRun(config, runId, 'write')).toMatchObject({ data: { run: { status: 'failed' } } });
      return 'https://github.com/fixture/app/pull/99';
    });
    expect(await runLocalDriver(config, runId, cwd)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await state(config, runId);
    expect(run.steps[0]).toMatchObject({ status: 'cancelled', changes: { pr_url: 'https://github.com/fixture/app/pull/99' } });
    expect(buildEndRecord(run, driver, 'tester').prs).toEqual(['https://github.com/fixture/app/pull/99']);
  });

  it('keeps an execution deadline across delivery and makes no provider call once it expired', async () => {
    const api = provider();
    const { config, runId } = await fixture(`  - id: write\n    command: ${command}\n    workspace: new\n    deliver: pr\n`);
    const run = await state(config, runId);
    run.steps = [{ id: 'write', status: 'delivering', settledAt: 1, deliveryDeadline: Date.now() - 1,
      changes: { branch: 'work', base: 'base', from: 'base', to: 'head', commits: [] } }];
    await writeRun(config, run);
    expect(await leaseNext(config, runId, driver)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect((await state(config, runId)).steps[0]).toMatchObject({ failure: { code: 'timeout' } });
    expect(api.lookup).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
  });

  it.each(['https://oauth2:fixture-token@github.com/fixture/app.git', 'ssh://git@github.com:22/fixture/app.git', 'git@github.com:fixture/app.git'])('recognizes hosting metadata through %s without passing transport credentials', async (remote) => {
    const api = provider();
    const { config, cwd, runId } = await fixture(`  - id: write\n    command: echo test\n`);
    git(cwd, ['remote', 'set-url', 'origin', remote]);
    expect(await validateReportedPr(await state(config, runId), { branch: 'work', base: 'base', from: 'base', to: 'head', commits: [], pr_url: 'https://github.com/fixture/app/pull/1' })).toEqual({ url: 'https://github.com/fixture/app/pull/1' });
    expect(api.validate).toHaveBeenCalledWith('https://github.com/fixture/app/pull/1', expect.objectContaining({ repo: 'fixture/app' }));
    expect(JSON.stringify(api.validate.mock.calls)).not.toContain('fixture-token');
  });
});

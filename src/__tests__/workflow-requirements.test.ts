import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { readRun, runFilePath } from '../workflow/store.js';
import { maskSecrets, mergeRequirements, requirementsMismatch } from '../workflow/requirements.js';
import { runLocalDriver } from '../workflow/local-driver.js';
import type { LocalToolAdapter, LocalToolRun } from '../workflow/local-tool-adapter.js';
import { parseWorkflow } from '../workflow/parse.js';

const dirs: string[] = [];
const driver = { kind: 'fixture', machine: 'test', workspace: '/work' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture(header: string, steps: string, inputs: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-requirements-')); dirs.push(root);
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  fs.writeFileSync(path.join(work, '.gitignore'), '.npmrc\nnode_modules/\n');
  execFileSync('git', ['add', '.'], { cwd: work });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: work });
  const config: LocalConfig = { repo: { localPath: repo, remote: 'local', kind: 'self' }, scope: 'project', username: 'test', additionalRoles: [], projectRoot: work, dataHome: path.join(root, 'data'), workflows: { tools: { default: 'claude' } } };
  fs.writeFileSync(path.join(repo, 'workflows', 'build.yaml'), `schemaVersion: v1alpha1\nname: build\ndescription: Requirements.\n${header}steps:\n${steps}`);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'build', inputs);
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run), repo, work };
}

function declare(repo: string) {
  fs.mkdirSync(path.join(repo, 'env'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'env', 'secrets.yaml'), 'secrets:\n  - key: WORKFLOW_TEST_TOKEN\n  - key: WORKFLOW_SETUP_TOKEN\n');
  vi.stubEnv('WORKFLOW_TEST_TOKEN', 'fixture-agent-private-token');
  vi.stubEnv('WORKFLOW_SETUP_TOKEN', 'fixture-setup-private-token');
}

describe('workflow requirements and limits (#1082)', () => {
  it('merges env names and replaces scalar defaults', () => {
    expect(mergeRequirements({ network: false, env: ['A'] }, { network: true, env: ['B', 'A'] })).toEqual({ network: true, env: ['A', 'B'] });
    expect(requirementsMismatch({ network: true }, { network: false }, { network: true })).toContain('policy');
    expect(requirementsMismatch({ isolation: 'sandbox' }, {}, { isolation: 'worktree' })).toContain('isolation');
    expect(requirementsMismatch({ network: false }, {}, { network: [true, false] })).toBeUndefined();
  });
  it('masks every nested string while retaining keys and non-string values', () => {
    expect(maskSecrets({ TOKEN: 'secret-long', message: 'prefix secret-long', future: [{ value: 'secret-longer' }, 3] }, ['secret-longer', 'secret-long']))
      .toEqual({ TOKEN: '[REDACTED]', message: 'prefix [REDACTED]', future: [{ value: '[REDACTED]' }, 3] });
  });
  it('holds an unsupported step and still leases a compatible ready root', async () => {
    const { config, runId } = await fixture('', '  - id: online\n    requires: { network: true }\n    command: echo online\n  - id: offline\n    needs: []\n    command: echo offline\n');
    expect(await leaseNext(config, runId, driver)).toMatchObject({ data: { lease: { step: 'offline' } } });
  });
  it('fails missing required env before a lease is issued', async () => {
    const { config, runId } = await fixture('', '  - id: work\n    requires: { env: [MISSING_WORKFLOW_TOKEN] }\n    command: echo work\n');
    expect(await leaseNext(config, runId, driver, { capabilities: { env: true } })).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ failure: { code: 'missing_env' } }] });
  });
  it('expires a lease before accepting its late report', async () => {
    const { config, runId } = await fixture('', '  - id: work\n    timeout: 1s\n    command: sleep 5\n');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    const next = await leaseNext(config, runId, driver); if ('error' in next) throw new Error(next.error.message);
    const lease = next.data.lease as { attempt: string; revision: number };
    vi.spyOn(Date, 'now').mockReturnValue(now + 2_000);
    expect(await reportAttempt(config, runId, { ...lease, driver, outcome: 'success' })).toMatchObject({ error: { code: 'lease_cancelled' } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ failure: { code: 'timeout' } }] });
  });
  it('cancels parallel leases when the reported budget is spent', async () => {
    const { config, runId } = await fixture('budget: { tokens: 10 }\n', '  - id: a\n    prompt: A\n  - id: b\n    needs: []\n    prompt: B\n');
    const a = await leaseNext(config, runId, driver, { capabilities: { tokens: true } }); if ('error' in a) throw new Error(a.error.message);
    const first = a.data.lease as { attempt: string; revision: number };
    const b = await leaseNext(config, runId, driver, { running: [first.attempt], capabilities: { tokens: true } }); if ('error' in b) throw new Error(b.error.message);
    const second = b.data.lease as { attempt: string; revision: number };
    await reportAttempt(config, runId, { ...first, driver, outcome: 'success', tokens: { input: 9, output: 1 } });
    const done = await leaseNext(config, runId, driver, { running: [second.attempt] });
    expect(done).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'budget_exceeded' } }, cancelled: [second.attempt] } });
    expect(fs.readFileSync(runFilePath(config, runId), 'utf8')).not.toContain('secret-long');
  });
  it('rejects malformed requirements and limits instead of retaining a runnable cache', () => {
    for (const header of ['requires: { network: maybe }', 'timeout: -1s', 'budget: { tokens: 0 }', 'setup: { command: npm ci, typo: true }']) {
      const parsed = parseWorkflow('build.yaml', `schemaVersion: v1alpha1\nname: build\ndescription: Invalid.\n${header}\nsteps:\n  - id: a\n    command: echo a\n`);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.diagnostics.some((diagnostic) => diagnostic.code === 'bad_requirements')).toBe(true);
    }
  });
  it('delivers only required env to a command and masks nested output and stderr', async () => {
    const { config, runId, repo, work } = await fixture('', `  - id: work\n    requires: { env: [WORKFLOW_TEST_TOKEN] }\n    command: node -e 'console.error(process.env.WORKFLOW_TEST_TOKEN); console.log(JSON.stringify({token:process.env.WORKFLOW_TEST_TOKEN,other:process.env.WORKFLOW_SETUP_TOKEN??null}))'\n`);
    declare(repo);
    const done = await runLocalDriver(config, runId, work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const state = await readRun(config, runId);
    expect(state).toMatchObject({ steps: [{ outputs: { token: '[REDACTED]', other: null } }] });
    expect(JSON.stringify(state)).not.toContain('fixture-agent-private-token');
    expect(JSON.stringify(state)).not.toContain('fixture-setup-private-token');
  });
  it('withholds setup env from the agent and passes max_turns to a supported adapter', async () => {
    const { config, runId, repo, work } = await fixture('setup:\n  command: node -e \'if(!process.env.WORKFLOW_SETUP_TOKEN)process.exit(1)\'\n  requires: { env: [WORKFLOW_SETUP_TOKEN] }\n', '  - id: work\n    workspace: new\n    prompt: Work.\n    max_turns: 3\n    requires: { env: [WORKFLOW_TEST_TOKEN] }\n');
    declare(repo);
    let input: LocalToolRun | undefined;
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn(async (_tool, value) => { input = value; return { started: true as const, exitCode: 0 }; }) };
    expect(await runLocalDriver(config, runId, work, { adapter })).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(input?.env?.WORKFLOW_TEST_TOKEN).toBe('fixture-agent-private-token');
    expect(input?.env?.WORKFLOW_SETUP_TOKEN).toBeUndefined();
    expect(input?.maxTurns).toBe(3);
  });
  it.each([
    ['tracked', `node -e 'require("fs").writeFileSync("tracked.txt","changed")'`, 'setup_dirty'],
    ['ignored secret', `node -e 'require("fs").writeFileSync(".npmrc",process.env.WORKFLOW_SETUP_TOKEN)'`, 'setup_secret'],
  ])('does not launch an agent when setup leaves %s files', async (_name, command, code) => {
    const { config, runId, repo, work } = await fixture(`setup:\n  command: ${command}\n  requires: { env: [WORKFLOW_SETUP_TOKEN] }\n`, '  - id: work\n    workspace: new\n    prompt: Work.\n');
    declare(repo);
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };
    await runLocalDriver(config, runId, work, { adapter });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ failure: { code } }] });
  });
  it('runs setup when a nested workflow first opens its inherited workspace', async () => {
    const { config, runId, work } = await fixture('setup:\n  command: node -e \'process.exit(7)\'\n', '  - id: work\n    workspace: new\n    workflow:\n      steps:\n        - id: child\n          prompt: Work.\n');
    const adapter: LocalToolAdapter = { runInteractive: vi.fn(), run: vi.fn() };
    await runLocalDriver(config, runId, work, { adapter });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(await readRun(config, runId)).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ id: 'work.child', failure: { code: 'setup_failed', message: 'Workspace setup failed; the agent was not started' } })]) });
  });
  it('rejects a command env key that shadows a declared secret', async () => {
    const { config, runId, repo } = await fixture('', '  - id: work\n    command: echo work\n    env: { WORKFLOW_TEST_TOKEN: input }\n');
    declare(repo);
    await leaseNext(config, runId, driver);
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ failure: { code: 'env_collision' } }] });
  });
  it('counts budget tokens from archived children and stops before a third pass', async () => {
    const { config, runId } = await fixture('budget: { tokens: 5 }\n', '  - id: work\n    workflow:\n      steps:\n        - id: review\n          prompt: Review.\n    loop: { back_to: work, max_iterations: 5 }\n');
    for (let pass = 0; pass < 2; pass++) {
      const next = await leaseNext(config, runId, driver, { capabilities: { tokens: true } });
      if ('error' in next) throw new Error(next.error.message);
      const lease = next.data.lease as { attempt: string; revision: number };
      expect(await reportAttempt(config, runId, { ...lease, driver, outcome: 'success', tokens: { input: 3 } })).toMatchObject({ data: { accepted: true } });
    }
    expect(await leaseNext(config, runId, driver)).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'budget_exceeded' } } } });
    expect(await readRun(config, runId)).toMatchObject({ archive: [expect.objectContaining({ tokens: { input: 3 } })] });
  });
  it('rechecks capabilities when a restarted driver asks for its open lease', async () => {
    const { config, runId } = await fixture('', '  - id: work\n    command: echo work\n    requires: { network: true }\n');
    expect(await leaseNext(config, runId, driver, { capabilities: { network: true } })).toMatchObject({ data: { lease: { step: 'work' } } });
    expect(await leaseNext(config, runId, driver)).toMatchObject({ data: { wait: { reason: 'Driver cannot enforce requires.network=true' } } });
  });
  it('enforces a configured member concurrency ceiling for external drivers', async () => {
    const { config, runId } = await fixture('', '  - id: a\n    command: echo a\n  - id: b\n    needs: []\n    command: echo b\n');
    config.workflows = { tools: {}, max_parallel: 1 };
    const first = await leaseNext(config, runId, driver); if ('error' in first) throw new Error(first.error.message);
    const lease = first.data.lease as { attempt: string };
    expect(await leaseNext(config, runId, driver, { running: [lease.attempt] })).toMatchObject({ data: { wait: { reason: 'Member workflow max_parallel reached' } } });
  });
  it('rejects secret values in persisted inputs', async () => {
    const { config, repo } = await fixture('inputs: { value: string }\n', '  - id: work\n    command: echo work\n', { value: 'ordinary input' });
    declare(repo);
    expect(await startRun(config, 'build', { value: 'fixture-agent-private-token' })).toMatchObject({ error: { code: 'invalid_inputs' } });
  });
});

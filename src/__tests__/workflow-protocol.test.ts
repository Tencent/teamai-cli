import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveWorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { inProcessClient, type WorkflowClient } from '../workflow/protocol.js';
import { readRun, RunIdSchema, withRunLock, type RunLock } from '../workflow/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore' });
}

async function fixture(workflows: Record<string, string>): Promise<{ config: LocalConfig; checkout: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-protocol-')); dirs.push(root);
  const checkout = path.join(root, 'work');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'README.md'), 'hello\n');
  git(checkout, 'init', '-q', '-b', 'main'); git(checkout, 'add', '.'); git(checkout, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(root, 'knowledge', 'workflows'), { recursive: true });
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(root, 'knowledge', 'workflows', `${name}.yaml`), yaml);
  const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(root, 'knowledge'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: checkout, dataHome: path.join(root, 'data') };
  await syncWorkflowDefinitions(config);
  return { config, checkout };
}

const CHECK = `schemaVersion: v1alpha1
name: check
description: Lint.
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

const WIDE = `schemaVersion: v1alpha1
name: wide
description: Fan out, review, ship.
alias: fan
invoke: ask
inputs:
  targets: [string]
steps:
  - id: a
    command: echo a
  - id: b
    needs: []
    for_each: { items: inputs.targets, max_parallel: 2 }
    command: echo b
  - id: c
    needs: []
    for_each: { items: inputs.targets, max_parallel: 4 }
    command: echo c
  - id: review
    needs: [a, b, c]
    approve: Ship it?
    prompt: Review the change.
  - id: ship
    needs: [review]
    workspace: new
    command: echo ship
`;

async function protocol(config: LocalConfig): Promise<WorkflowClient> {
  return inProcessClient({ config, env: await resolveWorkflowEnv(config) });
}

const driver = { kind: 'skill', machine: 'test', workspace: '/work', can: { hitl: false, workspace: ['read-only'] } };

const LeaseSchema = z.object({ attempt: z.string(), revision: z.number() }).passthrough();

async function leased(config: LocalConfig, checkout: string): Promise<{ run: RunLock['run']; attempt: string; revision: number; lease: z.infer<typeof LeaseSchema> }> {
  const client = await protocol(config);
  const started = await client.start('check', { checkout, caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' } });
  if (!('data' in started)) throw new Error(JSON.stringify(started));
  const run = RunIdSchema.parse(started.data.run);
  const next = await client.next(run, { driver });
  if (!('data' in next) || !('lease' in next.data)) throw new Error(JSON.stringify(next));
  const lease = LeaseSchema.parse(next.data.lease);
  return { run, attempt: lease.attempt, revision: lease.revision, lease };
}

describe('workflow protocol in process', () => {
  it('describes a workflow before any run: inputs, invoke, gates, prompts, steps outside the checkout, and its width', async () => {
    const { config } = await fixture({ wide: WIDE });
    expect(await (await protocol(config)).describe('fan', { ceiling: 3, can: {} })).toEqual({ description: {
      name: 'wide', description: 'Fan out, review, ship.', alias: 'fan', invoke: 'ask', inputs: { targets: { type: 'array', items: { type: 'string' } } },
      facts: { prompts: ['review'], interactive: [], modeled: [], width: 3, gates: [{ step: 'review', kind: 'approve', required: false, guards: { kind: 'prompt' } }], inWorkspace: ['ship'], scored: [],
        deliver: [], requiresEnv: { keys: [], missingHere: [] }, budgets: [], held: [],
        runs: [
          { step: 'a', executor: 'command', env: [] }, { step: 'b', executor: 'command', env: [] }, { step: 'c', executor: 'command', env: [] },
          { step: 'review', executor: 'prompt', env: [] }, { step: 'ship', executor: 'command', env: [] },
        ] },
    }, judging: { kind: 'none' } });
    expect(await (await protocol(config)).describe('wide', { ceiling: 20, can: {} })).toMatchObject({ description: { facts: { width: 7 } } });
  });

  it('counts a for_each with no max_parallel as wide as the ceiling, and one command as one', async () => {
    const each = CHECK.replace('name: check', 'name: each\ninputs:\n  targets: [string]').replace('  - id: lint\n', '  - id: lint\n    for_each: inputs.targets\n');
    const { config } = await fixture({ check: CHECK, each });
    expect(await (await protocol(config)).describe('each', { ceiling: 5, can: {} })).toMatchObject({ description: { facts: { width: 5 } } });
    expect(await (await protocol(config)).describe('check', { ceiling: 5, can: {} })).toMatchObject({ description: { invoke: 'deny', facts: { width: 1, prompts: [], interactive: [], gates: [], inWorkspace: [] } } });
  });

  it('answers workflow_not_found for a name with no runnable version', async () => {
    const { config } = await fixture({ check: CHECK });
    expect(await (await protocol(config)).describe('missing', { ceiling: 3, can: {} })).toEqual({ error: { code: 'workflow_not_found', message: 'Workflow or alias missing has no unambiguous runnable version' } });
  });

  it('refuses a start inside a workflow attempt before it looks the workflow up, and an answer from it', async () => {
    const { config } = await fixture({ check: CHECK });
    const client = await protocol(config);
    const nested = { code: 'nested_workflow', message: "This process runs inside workflow attempt r0123456789abcdef/a0000000a (TEAMAI_WORKFLOW_ATTEMPT is set), so it cannot start or drive a workflow run. Do the step's own work here; to run another workflow as part of a run, add it to the definition as a workflow step." };
    const caller = { evidence: { kind: 'attempt', attempt: 'r0123456789abcdef/a0000000a' }, confirmed: true, mode: 'attended' } as const;
    expect(await client.start('missing', { caller })).toEqual({ error: nested });
    expect(await client.respond('r0123456789abcdef', 'lint', 'yes', { via: { kind: 'process', caller: { tty: true, evidence: caller.evidence } } })).toEqual({ error: nested });
  });

  it('fails a reader step that changed the checkout it was prepared in, when its report says it succeeded', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, attempt, revision, lease } = await leased(config, checkout);
    const client = await protocol(config);
    const answer = await withRunLock(config, run, async (lock) => {
      expect(await client.prepare(lock, lease)).toEqual({ kind: 'prepared', dir: checkout });
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed\n');
      return client.report(run, { attempt, revision, outcome: 'success', driver }, { lock });
    }, { waitMs: 0 });
    expect(answer).toMatchObject({ data: { accepted: true, step: { id: 'lint', status: 'failed' } } });
    const stored = await readRun(config, run);
    expect(typeof stored === 'object' && stored.steps[0]).toMatchObject({ failure: { code: 'read_only_dirty', message: 'Read-only command step changed repository paths: README.md' } });
  });

  it('keeps the first snapshot when an attempt is prepared again, so a change made in between still fails it', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, attempt, revision, lease } = await leased(config, checkout);
    const client = await protocol(config);
    await withRunLock(config, run, (lock) => client.prepare(lock, lease), { waitMs: 0 });
    fs.writeFileSync(path.join(checkout, 'new.txt'), 'new\n');
    await withRunLock(config, run, (lock) => client.prepare(lock, lease), { waitMs: 0 });
    expect(await client.report(run, { attempt, revision, outcome: 'success', driver })).toMatchObject({ data: { step: { status: 'failed' } } });
  });

  it('does not check a reader step that failed, so it keeps its own failure', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, attempt, revision, lease } = await leased(config, checkout);
    const client = await protocol(config);
    await withRunLock(config, run, async (lock) => {
      await client.prepare(lock, lease);
      fs.writeFileSync(path.join(checkout, 'README.md'), 'changed\n');
      return client.report(run, { attempt, revision, outcome: 'failed', driver, message: 'command exited with status 1', failure: { code: 'command_failed', message: 'command exited with status 1' } }, { lock });
    }, { waitMs: 0 });
    const stored = await readRun(config, run);
    expect(typeof stored === 'object' && stored.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'command_failed' } });
  });

  it('refuses to prepare an attempt the run has not leased', async () => {
    const { config, checkout } = await fixture({ check: CHECK });
    const { run, lease } = await leased(config, checkout);
    const client = await protocol(config);
    const other = { ...lease, attempt: 'a00000000' };
    expect(await withRunLock(config, run, (lock) => client.prepare(lock, other), { waitMs: 0 }))
      .toEqual({ kind: 'failed', failure: { code: 'wrong_attempt', message: 'Attempt a00000000 is not the leased attempt' } });
  });
});

describe('the run lock', () => {
  it('waits up to waitMs for the holder to release it, and answers driver_running past that', async () => {
    const { config } = await fixture({ check: CHECK });
    const run = RunIdSchema.parse('r0123abcd');
    let release = (): void => {};
    let entered = (): void => {};
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = withRunLock(config, run, () => new Promise<string>((resolve) => { release = () => resolve('first'); entered(); }), { waitMs: 0 });
    await inside;
    expect(await withRunLock(config, run, async () => 'second', { waitMs: 0 })).toEqual({ error: {
      code: 'driver_running', message: `Run ${run} is already driven by process ${process.pid} on this machine. Stop that driver, or wait for it.`,
    } });
    const waiting = withRunLock(config, run, async (lock) => lock.run, { waitMs: 5_000 });
    setTimeout(release, 200);
    expect(await held).toBe('first');
    expect(await waiting).toBe(run);
  });
});

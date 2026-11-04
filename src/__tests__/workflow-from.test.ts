import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { knownSecrets } from '../env-resolution.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { retryStep } from '../workflow/run-controls.js';
import { readRun } from '../workflow/store.js';
import type { DriverCan } from '../workflow/requirements.js';
import type { DriverIdentity } from '../workflow/types.js';

const dirs: string[] = [];
const driver: DriverIdentity = { kind: 'local', machine: 'a', workspace: '/work' };

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-from-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

const PLANNED = `schemaVersion: v1alpha1
name: planned
description: Plan, then run the plan.
steps:
  - id: plan
    command: node plan.js
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
outputs:
  plan: steps.plan.outputs.plan
`;

async function startPlanned(config: LocalConfig, body = PLANNED): Promise<string> {
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'planned.yaml'), body);
  await syncScorersThenWorkflows(config);
  const started = await startRun(config, 'planned', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return String(started.data.run);
}

const LeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number() }) }) });

/** Leases the next step, which must be `step`, and reports it succeeded with `outputs`. Returns the report's envelope. */
async function settle(config: LocalConfig, runId: string, step: string, outputs?: unknown): Promise<unknown> {
  const { lease } = LeaseSchema.parse(await leaseNext(config, runId, driver)).data;
  expect(lease.step).toBe(step);
  return reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, ...(outputs !== undefined ? { outputs } : {}) });
}

const GENERATED = {
  schemaVersion: 'v1alpha1',
  name: 'generated',
  description: 'Say hello.',
  steps: [{ id: 'hello', command: 'node hello.js' }],
};

describe('workflow: { from }', () => {
  it('runs the workflow its producer printed, once the run admits it, and keeps the whole output', async () => {
    const config = testConfig();
    const runId = await startPlanned(config);
    const output = { definition: { definition: GENERATED }, plan: { trials: ['hello'] } };

    await settle(config, runId, 'plan', output);
    await settle(config, runId, 'trials.hello');
    const done = await leaseNext(config, runId, driver);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { plan: { trials: ['hello'] } } } } });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${run}`);
    expect(run.admitted?.plan).toMatchObject({ output, field: 'definition', definition: { name: 'generated', steps: [{ id: 'hello', command: 'node hello.js' }] } });
    expect(run.admitted?.plan?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('admits a bundle whose producer reuses one object in two steps', async () => {
    const config = testConfig();
    const runId = await startPlanned(config);
    const env = { GREETING: 'hello' };
    const definition = { ...GENERATED, steps: [{ id: 'one', command: 'node hello.js', env }, { id: 'two', needs: ['one'], command: 'node hello.js', env }] };

    const reported = await settle(config, runId, 'plan', { definition: { definition }, plan: {} });

    expect(reported).not.toHaveProperty('error');
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${run}`);
    expect(run.admitted?.plan?.definition).toMatchObject({ steps: [{ id: 'one', env }, { id: 'two', env }] });
  });
});

describe('a workflow output run in a copy with a role', () => {
  const PLANNED_IN_ROLE_COPY = PLANNED.replace('    workflow: { from: plan }', '    role: review\n    workspace: new\n    workflow: { from: plan }');

  const CAN: DriverCan = { workspace: ['read-only', 'new', 'continue'], role: true };
  const WorkspaceLease = z.object({ data: z.object({ lease: z.object({
    step: z.string(), attempt: z.string(), revision: z.number(), workspace: z.object({ branch: z.string(), base: z.object({ commit: z.string() }) }),
  }) }) });

  /** A run of `planned` in a role copy, its `plan` step settled with an output that admitted `definition`. */
  async function admitted(definition: Record<string, unknown>): Promise<{ config: LocalConfig; runId: string }> {
    const config = testConfig();
    fs.mkdirSync(path.join(config.repo.localPath, 'manifest'));
    fs.writeFileSync(path.join(config.repo.localPath, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: review\n    resources: { knowledge: [], skills: [review] }\n  - id: spec\n    resources: { knowledge: [], skills: [spec] }\n');
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'planned.yaml'), PLANNED_IN_ROLE_COPY);
    await syncScorersThenWorkflows(config);
    const started = await startRun(config, 'planned', {}, { secrets: await knownSecrets(config), base: { ref: 'main', commit: 'a'.repeat(40) } });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    await settle(config, runId, 'plan', { definition: { definition }, plan: {} });
    return { config, runId };
  }

  it('fails a step of the output that continues the copy with another role, rather than run it with either', async () => {
    const { config, runId } = await admitted({ ...GENERATED, steps: [{ id: 'look', role: 'spec', workspace: 'continue', prompt: 'Write the spec.' }] });

    await leaseNext(config, runId, driver, { can: CAN, prepare: true });

    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'trials.look')).toMatchObject({ status: 'failed', failure: {
      code: 'role_unavailable',
      message: 'step "trials.look" has role spec but continues the copy step "trials" opened with role review, which every step there runs with; remove role from step "trials.look", or set it on step "trials"',
    } });
  });

  it('fails a step of the output that resumes the session of a step that ran with another role', async () => {
    const { config, runId } = await admitted({ ...GENERATED, steps: [
      { id: 'plan', role: 'spec', workspace: 'new', prompt: 'Write the plan.' },
      { id: 'review', needs: ['plan'], workspace: 'continue', session: { from: 'plan' }, prompt: 'Review the plan.' },
    ] });
    const { lease } = WorkspaceLease.parse(await leaseNext(config, runId, driver, { can: CAN, prepare: true })).data;
    const base = lease.workspace.base.commit;
    await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, changes: { branch: lease.workspace.branch, base, from: base, to: base, commits: [] } });

    await leaseNext(config, runId, driver, { can: CAN, prepare: true });

    const run = await readRun(config, runId);
    expect(lease.step).toBe('trials.plan');
    expect(typeof run === 'object' && run.steps.find((step) => step.id === 'trials.review')).toMatchObject({ status: 'failed', failure: {
      code: 'bad_session',
      message: 'step "trials.review" resumes "plan", which ran with role spec, while step "trials.review" runs with role review; a session goes on only with the knowledge it started with, so run both steps with one role, or start a new session',
    } });
  });
});

describe('admitting a workflow output', () => {
  const inner = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: 'v1alpha1', name: 'inner.0123456789ab', description: 'Inner.', steps, ...extra });

  it.each([
    ['a value that is no bundle', { definition: 'generated' },
      'Step "plan" output definition is not a workflow this run can admit: definition: Invalid input: expected record, received string; a bundle is { definition, workflows? }'],
    ['a bundle with a key it does not define', { definition: GENERATED, trials: 3 },
      'Step "plan" output definition is not a workflow this run can admit: Unrecognized key: "trials"; a bundle is { definition, workflows? }'],
    ['a definition that does not parse', { definition: { ...GENERATED, steps: [{ id: 'hello' }] } },
      'Step "plan" output definition is not a workflow this run can admit: workflows/generated.yaml:5: field "steps[0]": a step has exactly one action: command, prompt, prompt_file, answer, or workflow; or no action with end, approve, or choose'],
    ['a from step of its own', { definition: { ...GENERATED, steps: [{ id: 'make', command: 'node make.js', output: { definition: 'workflow' } }, { id: 'run', needs: ['make'], workflow: { from: 'make' } }] } },
      'Step "plan" output definition is not a workflow this run can admit: workflows/generated.yaml: step "run" runs workflow: { from }, which a workflow output may not'],
    ['a prompt file', { definition: { ...GENERATED, steps: [{ id: 'hello', prompt_file: 'prompts/hello.md' }] } },
      'Step "plan" output definition is not a workflow this run can admit: workflows/generated.yaml: step "hello" has prompt_file, which a workflow output may not; print the prompt as prompt'],
    ['finally steps', { definition: { ...GENERATED, finally: [{ id: 'tidy', command: 'rm -rf tmp' }] } },
      'Step "plan" output definition is not a workflow this run can admit: workflows/generated.yaml has finally steps, which a workflow output may not; only a run of that workflow runs them'],
    ['scorers, which a run reads at its team pin and from its own files', { definition: GENERATED, scorers: { 'teamai:correctness:fix': { sourceHash: 'h', content: 'c', generated: true } } },
      'Step "plan" output definition is not a workflow this run can admit: Unrecognized key: "scorers"; a bundle is { definition, workflows? }'],
    ['a named workflow that names a credential a strict sandbox withholds', {
      definition: { ...GENERATED, steps: [{ id: 'hello', workflow: 'inner.0123456789ab', requires: { isolation: 'sandbox', strict: true } }] },
      workflows: { 'inner.0123456789ab': inner([{ id: 'push', command: 'git push', requires: { env: ['GH_TOKEN'] } }]) },
    }, 'Step "plan" output definition is not a workflow this run can admit: workflows/generated.yaml:6: field "steps[0].workflow": steps[0].workflow runs workflow "inner.0123456789ab", whose steps[0].requires.env names GH_TOKEN, which the strict sandbox it runs in withholds from every step. Remove it from requires.env, or drop strict.'],
    ['an unattended prompt that no strict sandbox covers', {
      definition: { ...GENERATED, steps: [{ id: 'arm', workflow: 'inner.0123456789ab', requires: { isolation: 'sandbox' } }] },
      workflows: { 'inner.0123456789ab': inner([{ id: 'work', prompt: 'Fix it.', permissions: 'unattended' }]) },
    }, 'Step "plan" output definition is not a workflow this run can admit: step "arm.work" sets permissions: unattended, which only a strict sandbox allows. Add requires: { isolation: sandbox, strict: true } to it, to a step around it, to defaults, or to the step that runs its workflow.'],
    ['a named workflow that does not parse', {
      definition: GENERATED,
      workflows: { 'inner.0123456789ab': inner([{ id: 'work' }]) },
    }, 'Step "plan" output definition is not a workflow this run can admit: workflows/inner.0123456789ab.yaml:5: field "steps[0]": a step has exactly one action: command, prompt, prompt_file, answer, or workflow; or no action with end, approve, or choose'],
    ['named workflows that run each other', {
      definition: { ...GENERATED, steps: [{ id: 'hello', workflow: 'inner.0123456789ab' }] },
      workflows: {
        'inner.0123456789ab': inner([{ id: 'there', workflow: 'inner.ba9876543210' }]),
        'inner.ba9876543210': { ...inner([{ id: 'back', workflow: 'inner.0123456789ab' }]), name: 'inner.ba9876543210' },
      },
    }, 'Step "plan" output definition is not a workflow this run can admit: workflows/inner.0123456789ab.yaml:6: field "steps[0].workflow": step "there" runs workflow "inner.ba9876543210" in a cycle: inner.0123456789ab -> inner.ba9876543210 -> inner.0123456789ab'],
    ['a definition with no name', { definition: { schemaVersion: 'v1alpha1', description: 'Say hello.', steps: [{ id: 'hello', command: 'node hello.js' }] } }, 'Step "plan" output definition is not a workflow this run can admit: workflows/definition.yaml:1: field "name": name must be a non-empty token'],
  ])('fails the producer for %s, and runs nothing it printed', async (_case, definition, message) => {
    const config = testConfig();
    const runId = await startPlanned(config);

    const reported = await settle(config, runId, 'plan', { definition, plan: {} });
    const done = await leaseNext(config, runId, driver);

    expect(reported).toMatchObject({ data: { step: { id: 'plan', status: 'failed', failure: { code: 'invalid_output', message } } } });
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.admitted).toBeUndefined();
  });

  it('admits an unattended prompt under the strict sandbox of the step that runs the output', async () => {
    const config = testConfig();
    const runId = await startPlanned(config, PLANNED.replace('workflow: { from: plan }', 'workflow: { from: plan }\n    requires: { isolation: sandbox, strict: true }'));
    const bundle = {
      definition: { ...GENERATED, steps: [{ id: 'arm', workflow: 'inner.0123456789ab' }] },
      workflows: { 'inner.0123456789ab': inner([{ id: 'work', prompt: 'Fix it.', permissions: 'unattended' }]) },
    };

    const reported = await settle(config, runId, 'plan', { definition: bundle, plan: {} });

    expect(reported).toMatchObject({ data: { step: { id: 'plan', status: 'succeeded' } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.admitted?.plan?.definition).toMatchObject({ steps: [{ id: 'arm' }] });
  });

  it('withholds from each step of the admitted workflow a key only another of its steps requires', async () => {
    vi.stubEnv('ONLY_ONE', 'one-value');
    const config = testConfig();
    const runId = await startPlanned(config);
    const definition = { ...GENERATED, steps: [{ id: 'one', command: 'node one.js', requires: { env: ['ONLY_ONE'] } }, { id: 'two', needs: ['one'], command: 'node two.js' }] };
    await settle(config, runId, 'plan', { definition: { definition }, plan: {} });
    const can = { workspace: ['read-only' as const], env: true };
    const EnvLeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string(), attempt: z.string(), revision: z.number(), envScope: z.object({ provide: z.array(z.string()), withhold: z.array(z.string()) }) }) }) });

    const one = EnvLeaseSchema.parse(await leaseNext(config, runId, driver, { can })).data.lease;
    await reportAttempt(config, runId, { attempt: one.attempt, revision: one.revision, outcome: 'success', driver });
    const two = EnvLeaseSchema.parse(await leaseNext(config, runId, driver, { can })).data.lease;

    expect({ step: one.step, provide: one.envScope.provide }).toEqual({ step: 'trials.one', provide: ['ONLY_ONE'] });
    expect({ step: two.step, provide: two.envScope.provide, withholds: two.envScope.withhold.includes('ONLY_ONE') }).toEqual({ step: 'trials.two', provide: [], withholds: true });
  });

  it('fails the producer whose workflow field is no object, before it is admitted', async () => {
    const config = testConfig();
    const runId = await startPlanned(config);

    const reported = await settle(config, runId, 'plan', { definition: 'node generated.js', plan: {} });

    expect(reported).toMatchObject({ data: { step: { id: 'plan', status: 'failed', failure: { code: 'invalid_output', message: 'stdout JSON does not match output: output.definition must be an object that holds a workflow definition' } } } });
  });

  it('fails the producer when its output holds a secret value, naming the secret and not the value', async () => {
    const config = testConfig();
    const runId = await startPlanned(config);
    const secrets = { DEPLOY_TOKEN: 'sekrit-value-123' };
    const { lease } = LeaseSchema.parse(await leaseNext(config, runId, driver)).data;

    const reported = await reportAttempt(config, runId, {
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver,
      outputs: { definition: { definition: GENERATED }, plan: { note: 'sekrit-value-123' } },
    }, secrets);

    expect(reported).toMatchObject({ data: { step: { status: 'failed', failure: { code: 'invalid_output' } } } });
    expect(JSON.stringify(reported)).toContain('holds the value of DEPLOY_TOKEN');
    expect(JSON.stringify(reported)).not.toContain('sekrit-value-123');
  });

  it('runs a named workflow the bundle brings, under the name it brings it by', async () => {
    const config = testConfig();
    const runId = await startPlanned(config);
    const bundle = {
      definition: { ...GENERATED, steps: [{ id: 'arm', workflow: 'inner.0123456789ab' }] },
      workflows: { 'inner.0123456789ab': inner([{ id: 'work', command: 'node work.js' }]) },
    };

    await settle(config, runId, 'plan', { definition: bundle, plan: {} });
    await settle(config, runId, 'trials.arm.work');
    const done = await leaseNext(config, runId, driver);

    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const run = await readRun(config, runId);
    if (typeof run !== 'object') throw new Error(`run ${run}`);
    expect(Object.keys(run.workflows ?? {})).toEqual(['inner.0123456789ab']);
  });
});

describe('a producer the run already holds', () => {
  const team = (config: LocalConfig, name: string, body: string) => fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), body);

  it('fails when its bundle brings a workflow under a name the run holds with other content', async () => {
    const config = testConfig();
    team(config, 'inner.0123456789ab', `schemaVersion: v1alpha1
name: inner.0123456789ab
description: The team's inner.
steps:
  - id: work
    command: node team-work.js
`);
    const runId = await startPlanned(config, `${PLANNED.replace('outputs:', `  - id: arm
    needs: [trials]
    workflow: inner.0123456789ab
outputs:`)}`);
    const workflows = { 'inner.0123456789ab': { schemaVersion: 'v1alpha1', name: 'inner.0123456789ab', description: 'Inner.', steps: [{ id: 'work', command: 'node work.js' }] } };

    const reported = await settle(config, runId, 'plan', { definition: { definition: GENERATED, workflows }, plan: {} });

    expect(reported).toMatchObject({ data: { step: { status: 'failed', failure: { code: 'invalid_output',
      message: 'Step "plan" output definition brings "inner.0123456789ab", which this run already holds with other content; name each workflow by its content.' } } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.workflows?.['inner.0123456789ab']?.steps).toEqual([{ id: 'work', command: 'node team-work.js' }]);
  });

  it('refuses a workflow that runs it in a loop before the run starts, as its second round could not give a workflow', async () => {
    const config = testConfig();
    team(config, 'produce', PLANNED.replace('name: planned', 'name: produce').replace(/outputs:[\s\S]*$/, ''));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'planned.yaml'), `schemaVersion: v1alpha1
name: planned
description: Produce, then produce again.
steps:
  - id: round
    workflow: produce
  - id: check
    needs: [round]
    command: node check.js
    loop: { back_to: round, max_iterations: 2 }
`);

    const synced = await syncScorersThenWorkflows(config);
    const started = await startRun(config, 'planned', {}, { secrets: await knownSecrets(config) });

    expect(synced.invalid.map((diagnostic) => diagnostic.message)).toContain('step "round" runs workflow "produce", whose step "plan" outputs a workflow, so it runs once; step "round" may not repeat in a loop or run per item of a for_each');
    expect(started).toMatchObject({ error: { code: 'workflow_not_found' } });
  });
});

describe('a run with a from step', () => {
  it('is isolated, so no step runs again and replaces the workflow it admitted', async () => {
    const config = testConfig();
    const runId = await startPlanned(config);
    await settle(config, runId, 'plan', { definition: { definition: GENERATED }, plan: {} });

    const retried = await retryStep(config, runId, {}, 'plan');

    expect(retried).toEqual({ error: { code: 'not_retryable', message: `Run ${runId} is isolated: it runs only on the machine that started it, and a step that ran again would change what it already admitted or measured. Start a new run: teamai workflow start planned` } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' && run.admitted?.plan?.output).toEqual({ definition: { definition: GENERATED }, plan: {} });
  });

  it.each([
    ['teamai-benchmark', 'team', 'teamai benchmark run fix'],
    ['teamai-benchmark', 'member', 'teamai benchmark run fix --member-aliases'],
    ['suites', 'member', `teamai workflow start suites --inputs '{"suite":"fix","aliases":"member"}'`],
  ])('of workflow %s with aliases %s, names the command that starts it again', async (name, aliases, command) => {
    const config = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), PLANNED.replace('name: planned', `name: ${name}\ninputs: { suite: string, aliases: string }`));
    await syncScorersThenWorkflows(config);
    const started = await startRun(config, name, { suite: 'fix', aliases }, { secrets: await knownSecrets(config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    await settle(config, runId, 'plan', { definition: { definition: GENERATED }, plan: {} });

    expect(await retryStep(config, runId, {}, 'plan')).toEqual({ error: { code: 'not_retryable', message: `Run ${runId} is isolated: it runs only on the machine that started it, and a step that ran again would change what it already admitted or measured. Start a new run: ${command}` } });
  });
});

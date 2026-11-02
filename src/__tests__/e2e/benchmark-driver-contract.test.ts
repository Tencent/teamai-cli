/**
 * Real CLI: the benchmark workflow driven from outside, as a driver that knows only the CLI JSON protocol runs it. The
 * driver starts `benchmark`, asks `workflow next --prepare`, runs each command lease (the plan, the baselines, the
 * checks and the report) and its setup in the lease's cwd with the attempt marker every driver sets, and launches each
 * prompt lease's tool there with the lease's model and limits. Every process it starts goes without the names the lease
 * withholds.
 */
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LeaseWireSchema } from '../../workflow/lease-wire.js';
import type { EnvScope } from '../../workflow/requirements.js';
import { benchmarkFixture, envelope, PRODUCT_URL, startFixBenchmark, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

/** The suite of the contract: one check task `fix`, and the arms `claude` and `codex`, with `trial` when given. */
function twoArms(timeout: string, trial?: string): string {
  return `schemaVersion: v1alpha1
name: fix
description: Fix the answer with two tools.
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 1
timeout: ${timeout}
${trial ? `trial: ${trial}\n` : ''}`;
}

/**
 * One claude arm under trial limits `trial`. The run ends once its trial does, so the case never races the run's
 * deadline: with a second arm this driver cannot run, the trial would have to report before that deadline.
 */
const ONE_ARM = (trial: string): string => twoArms('60s', trial).replace('  - name: codex\n    tool: codex\n', '');

const SANDBOX_CLAUDE = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'], end_turn: true, unattended: true };
const HeldSchema = z.array(z.object({ step: z.string(), missing: z.array(z.string()) }));
const DoneSchema = z.object({ outcome: z.string(), failure: z.object({ code: z.string() }).optional(), outputs: z.object({ text: z.string().optional() }) });
/** A lease `next` answers: with `--prepare`, with the place it prepared for the step; else run in the driver's workspace. */
const PreparedLeaseSchema = z.intersection(LeaseWireSchema, z.object({ cwd: z.string().min(1).optional() }));
type PreparedLease = z.infer<typeof PreparedLeaseSchema>;
const NextSchema = z.object({
  data: z.union([
    z.object({ lease: PreparedLeaseSchema }),
    z.object({ wait: z.object({ held: HeldSchema.optional() }) }),
    z.object({ done: DoneSchema }),
  ]),
});
const AcceptedSchema = z.object({ data: z.object({ accepted: z.literal(true) }) });
/** What execFile rejects with: the exit code, and `killed` once its `timeout` stopped the process. */
const ExitedSchema = z.object({ code: z.number().nullable().optional(), killed: z.boolean().optional(), stdout: z.string().optional() });
const StreamLineSchema = z.object({
  model: z.string().optional(), session_id: z.string().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(), total_cost_usd: z.number().optional(),
});
const RecordSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), baseline: z.string() })),
  trials: z.array(z.object({ order: z.number(), arm: z.string(), result: z.string(), limit: z.string().optional(), unenforced: z.array(z.string()).optional() })),
});
const RunSchema = z.object({ status: z.string(), steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) });

const execute = promisify(execFile);

async function spawned(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }): Promise<{ code: number; killed: boolean; stdout: string }> {
  return execute(file, args, options).then(({ stdout }) => ({ code: 0, killed: false, stdout }), (error: unknown) => {
    const exited = ExitedSchema.parse(error);
    return { code: exited.code ?? 1, killed: exited.killed ?? false, stdout: exited.stdout ?? '' };
  });
}

/** The model and session a tool printed, from the first stream line that names each, and the tokens and cost it stated last. */
function sessionOf(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => StreamLineSchema.safeParse(JSON.parse(line)).data);
  const model = lines.find((line) => line?.model)?.model;
  const session = lines.find((line) => line?.session_id)?.session_id;
  const usage = lines.findLast((line) => line?.usage !== undefined)?.usage;
  const cost = lines.findLast((line) => line?.total_cost_usd !== undefined)?.total_cost_usd;
  return {
    ...(model ? { model } : {}), ...(session ? { session } : {}),
    ...(usage ? { tokens: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
    ...(cost !== undefined ? { cost: { amount: cost, unit: 'USD' } } : {}),
  };
}

interface Driven {
  /** Each step this driver was leased, in order. */
  leased: string[];
  /** What the last `wait` held. */
  held: z.infer<typeof HeldSchema>;
  done?: z.infer<typeof DoneSchema>;
}

/** Drives `run` for at most `maxPolls` calls of `next --prepare` (or plain `next` without `prepare`), declaring `can`. */
async function drive(fixture: BenchmarkFixture, input: { run: string; can: Record<string, unknown>; prepare: boolean; maxPolls: number }): Promise<Driven> {
  const identity = { kind: 'external', machine: 'contract-driver', workspace: fixture.work };
  const tools: Record<string, string> = { claude: path.join(fixture.bin, 'claude'), codex: path.join(fixture.bin, 'codex') };
  const envOf = (lease: PreparedLease, scope: EnvScope | undefined): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(fixture.env).filter(([key]) => !(scope?.withhold ?? []).includes(key))),
    ...lease.env,
    TEAMAI_WORKFLOW_ATTEMPT: `${input.run}/${lease.attempt}`,
  });
  const leased: string[] = [];
  let held: Driven['held'] = [];
  for (let polls = 0; polls < input.maxPolls; polls += 1) {
    const asked = await fixture.teamai(['workflow', 'next', input.run, ...(input.prepare ? ['--prepare'] : []), '--json', JSON.stringify({ driver: { ...identity, can: input.can }, running: [] })]);
    const answer = NextSchema.parse(envelope(asked)).data;
    if ('done' in answer) return { leased, held, done: answer.done };
    if ('wait' in answer) {
      held = answer.wait.held ?? [];
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
      continue;
    }
    const { lease } = answer;
    leased.push(lease.step);
    const env = envOf(lease, lease.envScope);
    const cwd = lease.cwd ?? fixture.work;
    const setup = lease.setup ? await spawned('/bin/sh', ['-c', lease.setup.command], { cwd, env: envOf(lease, lease.setup.envScope) }) : undefined;
    let settled: Record<string, unknown>;
    if (setup && setup.code !== 0) settled = { outcome: 'failed' };
    else if (lease.command !== undefined) {
      const ran = await spawned('/bin/sh', ['-c', lease.command], { cwd, env });
      settled = ran.code === 0 ? { outcome: 'success', ...(lease.output !== undefined ? { outputs: JSON.parse(ran.stdout) } : {}) } : { outcome: 'failed' };
    } else {
      const tool = lease.tool === undefined ? undefined : tools[lease.tool];
      if (tool === undefined || lease.prompt === undefined) throw new Error(`leased a prompt this driver cannot launch: ${JSON.stringify(lease)}`);
      const model = typeof lease.model === 'object' ? lease.model : undefined;
      const begun = Date.now();
      const ran = await spawned(tool, ['-p', lease.prompt, ...(model ? ['--model', model.name] : []), ...(model?.effort ? ['--effort', model.effort] : [])], {
        cwd, env, ...(lease.limits?.timeoutMs !== undefined ? { timeout: lease.limits.timeoutMs } : {}),
      });
      const unenforced = [...(lease.limits?.budget !== undefined ? ['budget'] : []), ...(lease.limits?.maxTurns !== undefined ? ['max_turns'] : [])];
      settled = {
        tool: lease.tool, durationMs: Date.now() - begun,
        ...(ran.killed ? { outcome: 'success', limit: 'timeout' } : ran.code === 0 ? { outcome: 'success', ...sessionOf(ran.stdout) } : { outcome: 'failed' }),
        ...(unenforced.length > 0 ? { unenforced } : {}),
      };
    }
    const reported = envelope(await fixture.teamai(['workflow', 'report', input.run, '--json', JSON.stringify({ driver: identity, attempt: lease.attempt, revision: lease.revision, ...settled })]));
    if (!AcceptedSchema.safeParse(reported).success) throw new Error(`The report of ${lease.step} was not accepted: ${JSON.stringify(reported)}`);
  }
  return { leased, held };
}

const EVERY_STEP = ['plan', 'trials.baselines.fix', 'trials.r1.fix.claude.prompt', 'trials.r1.fix.claude.check', 'report'];

describe('the benchmark workflow, driven from outside', () => {
  it('runs only the trial whose tool the driver lists, and the suite timeout settles the other not_run', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: twoArms('15s') });
    try {
      const status = fixture.status();
      const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.teamClone, encoding: 'utf8' }).trim();
      const runId = await startFixBenchmark(fixture, '15s');

      const result = await drive(fixture, { run: runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 40 });

      expect(result.leased).toEqual(EVERY_STEP);
      expect(result.done).toMatchObject({ outcome: 'failed', failure: { code: 'timeout' } });
      expect(result.done?.outputs.text).toContain('| claude | claude | tool default (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
      expect(result.done?.outputs.text).toContain('| codex | codex | tool default (team) | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0% (0/1) |');
      expect(result.done?.outputs.text).toContain('These results hold for these tasks, this run and this machine.');
      const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
      expect(record.tasks).toEqual([expect.objectContaining({ id: 'fix', baseline: 'valid' })]);
      expect(record.trials).toEqual([
        expect.objectContaining({ order: 1, arm: 'claude', result: 'passed' }),
        expect.objectContaining({ order: 2, arm: 'codex', result: 'not_run' }),
      ]);
      const prompt = RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.prompt');
      expect(prompt).toMatchObject({ status: 'succeeded', tool: 'claude', model: 'fake-claude', session: 'fake-session', durationMs: expect.any(Number) });
      // The driver sends neither: teamai observed both of the clone it prepared.
      expect(prompt).toMatchObject({ agent: { team: { revision: baseline }, project: { commit: fixture.startingCommit } } });
      expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude']);
      expect(fixture.trialRootEntries()).toEqual([]);
      expect(fixture.status()).toBe(status);
    } finally {
      fixture.remove();
    }
  }, 120_000);
  it("gives a trial of an arm on a team branch a clone with that branch's team installed, and records the branch commit", async () => {
    const skill = (name: string): string => `---\nname: ${name}\ndescription: Helps with ${name}.\n---\nUse ${name}.\n`;
    const suite = twoArms('60s').replace('  - name: codex\n    tool: codex\n', '  - name: before\n    team: bench/before\n');
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite, team: { 'skills/fixer/SKILL.md': skill('fixer') } });
    try {
      const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.teamClone, encoding: 'utf8' }).trim();
      execFileSync('git', ['push', '-q', fixture.teamOrigin, `${before}:refs/heads/bench/before`], { cwd: fixture.teamClone });
      fixture.pushTeam({ 'skills/newer/SKILL.md': skill('newer') });
      const pulled = await fixture.teamai(['pull']);
      expect(pulled.code, pulled.stderr).toBe(0);
      const runId = await startFixBenchmark(fixture, '60s');

      const result = await drive(fixture, { run: runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 40 });

      expect(result.done).toMatchObject({ outcome: 'succeeded' });
      const prompt = RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.before.prompt');
      expect(prompt).toMatchObject({ status: 'succeeded', agent: { team: { revision: before } } });
      const skills = fixture.toolLaunches().map((launch) => launch.paths.flatMap((file) => /^\.claude\/skills\/(fixer|newer)\/SKILL\.md$/.exec(file)?.[1] ?? []).sort());
      expect(skills).toEqual([['fixer', 'newer'], ['fixer']]);
    } finally {
      fixture.remove();
    }
  }, 120_000);

  it('stops the tool at the trial timeout the lease sets, and the check decides the trial its report says a limit ended', async () => {
    const fixture = await benchmarkFixture({ tool: 'hangs', sandbox: false, suite: ONE_ARM('{ timeout: 3s }') });
    try {
      const runId = await startFixBenchmark(fixture, '60s');

      const result = await drive(fixture, { run: runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 40 });

      expect(result.leased).toEqual(EVERY_STEP);
      expect(result.done?.outputs.text).toContain('| claude | claude | tool default (team) | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0% (0/1) |');
      expect(RecordSchema.parse(fixture.benchmarkRecord(runId)).trials).toEqual([
        expect.objectContaining({ order: 1, arm: 'claude', result: 'failed', limit: 'timeout' }),
      ]);
    } finally {
      fixture.remove();
    }
  }, 120_000);

  it('leases a driver that cannot end the turn the trial under on_limit: fail, and records on_limit as not enforced', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: ONE_ARM('{ timeout: 10s }') });
    try {
      const runId = await startFixBenchmark(fixture, '60s');

      const result = await drive(fixture, { run: runId, can: { ...SANDBOX_CLAUDE, end_turn: false }, prepare: true, maxPolls: 40 });

      expect(result.leased).toEqual(EVERY_STEP);
      expect(RecordSchema.parse(fixture.benchmarkRecord(runId)).trials).toEqual([
        expect.objectContaining({ order: 1, arm: 'claude', result: 'passed', unenforced: ['on_limit'] }),
      ]);
    } finally {
      fixture.remove();
    }
  }, 120_000);

  it.each([
    ['declares nothing', {}, true, ['workspace.clone']],
    ['provides clones but does not ask --prepare', SANDBOX_CLAUDE, false, ['prepare']],
  ])('runs the plan, then holds the task baseline, and so every trial, from a driver that %s', async (_, can, prepare, missing) => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: twoArms('10m') });
    try {
      const runId = await startFixBenchmark(fixture, '10m');

      const result = await drive(fixture, { run: runId, can, prepare, maxPolls: 2 });

      expect(result.leased).toEqual(['plan']);
      expect(result.held).toEqual([expect.objectContaining({ step: 'trials.baselines.fix', missing: expect.arrayContaining(missing) })]);
      expect(fixture.toolLaunches()).toEqual([]);
    } finally {
      fixture.remove();
    }
  }, 120_000);

  it("gives the tool a clone of its own, from which a control command does not reach the member's run", async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, suite: twoArms('10m') });
    try {
      const status = fixture.status();
      const runId = await startFixBenchmark(fixture, '10m');
      fixture.probeControl(runId);

      const result = await drive(fixture, { run: runId, can: SANDBOX_CLAUDE, prepare: true, maxPolls: 4 });

      expect(result.leased).toEqual(EVERY_STEP.slice(0, 4));
      const [launch] = fixture.toolLaunches();
      expect(launch).toMatchObject({ tool: 'claude', ownGit: true, head: fixture.startingCommit, remotes: '' });
      expect(path.relative(fixture.work, launch?.cwd ?? fixture.work).startsWith('..')).toBe(true);
      // A run id reaches the member's run from any directory, so the tool runs with the attempt marker, which refuses
      // every call that changes a run.
      expect(fixture.probeAnswers()).toEqual([{ error: expect.objectContaining({ code: 'nested_workflow' }) }]);
      const run = RunSchema.parse(fixture.runFile(runId));
      expect(run.status).toBe('running');
      expect(run.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
      expect(fixture.status()).toBe(status);
    } finally {
      fixture.remove();
    }
  }, 120_000);
});

/**
 * Real CLI: every arm's trials run the model its alias named for its tool when the run started, read from the team's
 * aliases at the run's team revision, on every driver, whatever the aliases say later. The member's own aliases count
 * only with --member-aliases, and the table and the record say whose aliases resolved each model.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { benchmarkFixture, envelope, PRODUCT_URL, said, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const SUITE = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
  model: strong
arms:
  - name: strong
  - name: fast
    model: fast
  - name: codex
    tool: codex
repetitions: 1
timeout: 10m
`;
const ALIASES = `aliases:
  strong:
    claude: { model: claude-strong-1, effort: high }
    codex: { model: gpt-strong-1, effort: high }
  fast:
    claude: claude-fast-1
`;
const LATER_ALIASES = `aliases:
  strong:
    claude: claude-strong-2
    codex: gpt-strong-2
  fast:
    claude: claude-fast-2
`;
const MEMBER_ALIASES = 'aliases:\n  strong:\n    claude: claude-member-1\n';

const AgentSchema = z.object({
  tool: z.object({ name: z.string() }),
  model: z.object({ requested: z.string().optional(), reported: z.string().optional() }).optional(),
  effort: z.object({ requested: z.string().optional() }).optional(),
}).passthrough();
const RunSchema = z.object({ status: z.string(), steps: z.array(z.object({ id: z.string(), agent: AgentSchema.optional() }).passthrough()) });
const RecordSchema = z.object({
  arms: z.array(z.object({ name: z.string() }).passthrough()),
  trials: z.array(z.object({ arm: z.string(), result: z.string(), durationMs: z.number().optional() }).passthrough()),
}).passthrough();
const DoneSchema = z.object({ run: z.string(), outputs: z.object({ text: z.string() }).passthrough() }).passthrough();

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

async function modelFixture(aliases = ALIASES): Promise<BenchmarkFixture> {
  const fixture = await benchmarkFixture({
    tool: 'fixes', sandbox: true, suite: SUITE, team: { 'models/aliases.yaml': aliases },
    firstLaunch: 'pulls-a-team-change', teamChange: { 'models/aliases.yaml': LATER_ALIASES },
  });
  fixtures.push(fixture);
  fs.mkdirSync(path.join(fixture.home, '.teamai', 'models'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, '.teamai', 'models', 'aliases.yaml'), MEMBER_ALIASES);
  return fixture;
}

/** Runs the benchmark with `teamai benchmark run` on the local driver, and answers its run and the results text its `done` carries. */
async function runLocally(fixture: BenchmarkFixture): Promise<{ runId: string; text: string }> {
  const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
  const done = DoneSchema.safeParse(envelope(ran).data?.done);
  if (!done.success) throw new Error(`no done: ${said(ran)}`);
  return { runId: done.data.run, text: done.data.outputs.text };
}

const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/ci' };
const CAN = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude', 'codex'], unattended: true };
const LeaseSchema = z.object({
  attempt: z.string(), revision: z.number(), command: z.string().optional(), env: z.record(z.string(), z.string()).optional(), output: z.unknown().optional(),
  cwd: z.string().optional(), envScope: z.object({ withhold: z.array(z.string()) }).passthrough().optional(),
}).passthrough();
const PromptLeaseSchema = z.object({
  attempt: z.string(), revision: z.number(), prompt: z.string(), tool: z.string(), cwd: z.string(), envScope: z.object({ withhold: z.array(z.string()) }),
  model: z.object({ name: z.string(), effort: z.string().optional() }).optional(),
});
const NextSchema = z.union([
  z.object({ lease: LeaseSchema }),
  z.object({ wait: z.object({}).passthrough() }),
  z.object({ done: DoneSchema }),
]);
const ExitSchema = z.object({ code: z.number(), stdout: z.string().optional() });
const StreamLineSchema = z.object({
  model: z.string().optional(), session_id: z.string().optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(), total_cost_usd: z.number().optional(),
});

/** `env` without the names a lease withholds, with the values it gives. */
function withheld(env: NodeJS.ProcessEnv, withhold: readonly string[], given: Record<string, string>): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !withhold.includes(key))), ...given };
}

/** The model and session a tool printed, and the tokens and cost it stated last. */
function sessionOf(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.startsWith('{')).flatMap((line) => {
    const parsed = StreamLineSchema.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  });
  const model = lines.find((line) => line.model)?.model;
  const session = lines.find((line) => line.session_id)?.session_id;
  const usage = lines.findLast((line) => line.usage !== undefined)?.usage;
  const cost = lines.findLast((line) => line.total_cost_usd !== undefined)?.total_cost_usd;
  return {
    ...(model ? { model } : {}), ...(session ? { session } : {}),
    ...(usage ? { tokens: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
    ...(cost !== undefined ? { cost: { amount: cost, unit: 'USD' } } : {}),
  };
}

/**
 * Drives run `runId` to its end as an external driver: the plan, the checks and the report are command leases it runs
 * in their places with the attempt marker, reporting a step's stdout JSON as its outputs; a prompt it runs on the fake
 * tool the lease names, with the lease's model and effort, and reports what the tool printed. Answers the run's `done`.
 */
async function driveExternally(fixture: BenchmarkFixture, runId: string): Promise<z.infer<typeof DoneSchema>> {
  const report = async (body: Record<string, unknown>): Promise<void> => {
    const reported = await fixture.teamai(['workflow', 'report', runId, '--json', JSON.stringify({ driver: EXTERNAL, ...body })]);
    if (envelope(reported).data?.accepted !== true) throw new Error(`report refused: ${said(reported)}`);
  };
  for (let polls = 0; polls < 60; polls += 1) {
    const next = await fixture.teamai(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can: CAN }, running: [] })]);
    const answer = NextSchema.parse(envelope(next).data);
    if ('done' in answer) return answer.done;
    if ('wait' in answer) {
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      continue;
    }
    const { lease } = answer;
    const marker = { TEAMAI_WORKFLOW_ATTEMPT: `${runId}/${lease.attempt}` };
    if (lease.command !== undefined) {
      const ran = await promisify(execFile)('sh', ['-c', lease.command], { cwd: lease.cwd ?? fixture.work, env: withheld(fixture.env, lease.envScope?.withhold ?? [], { ...lease.env, ...marker }) })
        .then(({ stdout }) => ({ code: 0, stdout }), (failed: unknown) => ExitSchema.parse(failed));
      const outputs: unknown = ran.code === 0 && lease.output !== undefined && ran.stdout !== undefined ? JSON.parse(ran.stdout) : undefined;
      await report({ attempt: lease.attempt, revision: lease.revision, outcome: ran.code === 0 ? 'success' : 'failed', exitCode: ran.code, ...(outputs !== undefined ? { outputs } : {}) });
      continue;
    }
    const prompt = PromptLeaseSchema.parse(lease);
    const started = Date.now();
    const launched = await promisify(execFile)(path.join(fixture.bin, prompt.tool), [
      '-p', prompt.prompt, ...(prompt.model ? ['--model', prompt.model.name] : []), ...(prompt.model?.effort ? ['--effort', prompt.model.effort] : []),
    ], { cwd: prompt.cwd, env: withheld(fixture.env, prompt.envScope.withhold, marker) }).then((result) => ({ outcome: 'success', ...sessionOf(result.stdout) }), () => ({ outcome: 'failed' }));
    await report({ attempt: prompt.attempt, revision: prompt.revision, tool: prompt.tool, durationMs: Date.now() - started, ...launched });
  }
  throw new Error(`run ${runId} did not end`);
}

const DRIVERS: Array<{ name: string; run(fixture: BenchmarkFixture): Promise<{ runId: string; text: string }> }> = [
  { name: 'the local driver', run: (fixture) => runLocally(fixture) },
  {
    name: 'an external driver',
    run: async (fixture) => {
      const started = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', '10m']);
      const runId = z.object({ run: z.string() }).parse(envelope(started).data).run;
      const done = await driveExternally(fixture, runId);
      return { runId, text: done.outputs.text };
    },
  },
];

describe.each(DRIVERS)('benchmark arm models on $name', ({ run }) => {
  it('runs each arm on the model the team aliases named at start, also after the aliases change and are pulled during the run', async () => {
    const fixture = await modelFixture();

    const { runId, text } = await run(fixture);

    expect(fs.readFileSync(path.join(fixture.teamClone, 'models', 'aliases.yaml'), 'utf8')).toBe(LATER_ALIASES);
    expect(fixture.toolLaunches().map(({ tool, model, effort }) => ({ tool, model, effort }))).toEqual([
      { tool: 'claude', model: 'claude-strong-1', effort: 'high' }, { tool: 'claude', model: 'claude-fast-1', effort: null }, { tool: 'codex', model: 'gpt-strong-1', effort: 'high' },
    ]);
    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    const agentOf = (arm: string) => stored.steps.find((step) => step.id === `trials.r1.fix.${arm}.prompt`)?.agent;
    expect(agentOf('strong')).toMatchObject({ tool: { name: 'claude' }, model: { requested: 'claude-strong-1' }, effort: { requested: 'high' } });
    expect(agentOf('fast')).toMatchObject({ tool: { name: 'claude' }, model: { requested: 'claude-fast-1' } });
    expect(agentOf('codex')).toMatchObject({ tool: { name: 'codex' }, model: { requested: 'gpt-strong-1' }, effort: { requested: 'high' } });
    const record = RecordSchema.parse(fixture.benchmarkRecord(runId));
    expect(record.arms).toEqual([
      { name: 'strong', tool: 'claude', model: 'claude-strong-1', alias: 'strong', effort: 'high', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
      { name: 'fast', tool: 'claude', model: 'claude-fast-1', alias: 'fast', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
      { name: 'codex', tool: 'codex', model: 'gpt-strong-1', alias: 'strong', effort: 'high', source: 'team', team: { kind: 'pulled', revision: expect.any(String) } },
    ]);
    expect(record.trials.map(({ result, durationMs }) => ({ result, durationMs }))).toEqual(Array.from({ length: 3 }, () => ({ result: 'passed', durationMs: expect.any(Number) })));
    expect(record.trials.find((trial) => trial.arm === 'strong')).toMatchObject({ tokens: { input: 4, output: 2 }, cost: { amount: 0.25, unit: 'USD' } });
    expect(text).toContain('| strong | claude | claude-strong-1 high (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(text).toContain('| codex | codex | gpt-strong-1 high (team) | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 100% (1/1) |');
    expect(text).toMatch(/\| fast \| 6 \(1\) \| \d+\.\d s \(1\) \| 0\.25 USD \(1\) \|/);
  }, 120_000);
});

describe('benchmark arm models at start', () => {
  it('resolves with the member\'s aliases under --member-aliases, and shows member as the source of each model they decided', async () => {
    const fixture = await modelFixture();

    const ran = await fixture.teamai(['benchmark', 'run', 'fix', '--member-aliases']);
    const { run: runId, outputs: { text } } = DoneSchema.parse(envelope(ran).data?.done);

    expect(fixture.toolLaunches().map(({ model }) => model)).toEqual(['claude-member-1', 'claude-fast-1', 'gpt-strong-1']);
    expect(RecordSchema.parse(fixture.benchmarkRecord(runId)).arms).toMatchObject([
      { name: 'strong', model: 'claude-member-1', source: 'member' },
      { name: 'fast', model: 'claude-fast-1', source: 'team' },
      { name: 'codex', model: 'gpt-strong-1', source: 'team' },
    ]);
    expect(text).toContain('| strong | claude | claude-member-1 (member) |');
  }, 120_000);

  it('refuses a plan whose --aliases is neither team nor member, naming both', async () => {
    const fixture = await modelFixture();

    const planned = await fixture.teamai(['benchmark', 'plan', 'fix', '--aliases', 'mine']);

    expect(planned.code, said(planned)).toBe(1);
    expect(planned.stdout).toBe('');
    expect(planned.stderr).toContain('invalid_arguments: --aliases takes team, the team\'s models/aliases.yaml, or member, your ~/.teamai/models/aliases.yaml over the team\'s; got mine.');
  }, 120_000);

  it('refuses to start an arm whose alias names no model for its tool, and leaves no run and no record', async () => {
    const fixture = await modelFixture('aliases:\n  strong:\n    claude: claude-strong-1\n  fast:\n    claude: claude-fast-1\n');

    const started = await fixture.teamai(['benchmark', 'run', 'fix']);

    expect(envelope(started).error).toEqual({
      code: 'arm_model_missing',
      message: 'Arm "codex" uses model alias "strong", which has no model for codex in models/aliases.yaml. Add one and start again.',
    });
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
    const reports = (() => {
      try {
        return execFileSync('git', ['--git-dir', fixture.teamOrigin, 'ls-tree', '-r', '--name-only', 'teamai-reports'], { encoding: 'utf8' });
      } catch {
        return '';
      }
    })();
    expect(reports).not.toContain('workflows/runs/');
    expect(reports).not.toContain('benchmarks/runs/');
  }, 120_000);

  it.each([
    {
      origin: 'a member alias resolves to a credential URL', suite: SUITE, command: ['benchmark', 'run', 'fix', '--member-aliases'],
      member: 'aliases:\n  strong:\n    claude: https://member:private-password-123@models.example.test/private-model\n',
      error: 'Arm "strong" has a model that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix your entry in ~/.teamai/models/aliases.yaml, or start again without --member-aliases.',
    },
    {
      origin: 'the suite names a local path', suite: SUITE.replace('  model: strong', '  model: /home/member/models/private.gguf'), command: ['benchmark', 'run', 'fix'], member: undefined,
      error: 'Arm "strong" has a model that is not a plain name, such as a URL or a local path, and a benchmark record publishes it. Fix the suite or the team\'s models/aliases.yaml, push it, run teamai pull, and start again.',
    },
  ])('refuses to start when $origin, and leaves no run and no record', async ({ suite, command, member, error }) => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, suite, team: { 'models/aliases.yaml': ALIASES } });
    fixtures.push(fixture);
    if (member) {
      fs.mkdirSync(path.join(fixture.home, '.teamai', 'models'), { recursive: true });
      fs.writeFileSync(path.join(fixture.home, '.teamai', 'models', 'aliases.yaml'), member);
    }

    const started = await fixture.teamai(command);

    expect(envelope(started).error).toEqual({ code: 'arm_unpublishable', message: error });
    expect(started.stdout + started.stderr).not.toContain('private-password-123');
    expect(fixture.runIds()).toEqual([]);
    expect(fixture.toolLaunches()).toEqual([]);
  }, 120_000);
});

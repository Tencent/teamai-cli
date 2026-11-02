/**
 * Real CLI: the names a trial never sees stay out of its setup, its tool and its check on every driver, also when the
 * team env declares one of them, and out of whatever git starts in the clone after the tool ran there. A driver from
 * outside runs every command lease of the benchmark workflow (its plan, baselines, checks and report) and each setup
 * itself, in the place `next --prepare` prepared, without the names the lease withholds and with the attempt marker
 * every driver sets.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LeaseWireSchema } from '../../workflow/lease-wire.js';
import type { EnvScope } from '../../workflow/requirements.js';
import { benchmarkFixture, envelope, PRODUCT_URL, runFixBenchmark, startFixBenchmark, type BenchmarkFixture, type Envelope } from '../helpers/benchmark-fixture.js';

const WITHHELD = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'];
const WITH_SETUP = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 1
timeout: 10m
setup:
  command: env > "$FIXTURE_ROOT/setup.env"
`;
const TASK = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make node test.js pass.
startingCommit: '{{startingCommit}}'
check:
  run: env > "$FIXTURE_ROOT/check.env" && node test.js
  protect: [test.js]
`;
const CRITERIA_TASK = `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make answer.js export 42.
startingCommit: '{{startingCommit}}'
successCriteria: answer.js exports 42.
`;
const CAN = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, setup: true, tools: ['claude'], unattended: true };
/** A lease `next --prepare` answers, with the place it prepared for the step. */
const LeaseSchema = z.intersection(LeaseWireSchema, z.object({ cwd: z.string().min(1) }));
type Lease = z.infer<typeof LeaseSchema>;
const LeasedSchema = z.object({ data: z.object({ lease: LeaseSchema }) });
const NextSchema = z.object({ data: z.union([z.object({ lease: LeaseSchema }), z.object({ wait: z.object({}).passthrough() }), z.object({ done: z.object({}).passthrough() })]) });
const RecordSchema = z.object({ trials: z.array(z.object({ result: z.string() }).passthrough()) });
const StepsSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) });
const ExitedSchema = z.object({ code: z.number().nullable().optional(), stdout: z.string().optional() });
const execute = promisify(execFile);

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

/** A driver of `run` from outside, as `identity`, that runs the command leases and setups it is given itself. */
function fromOutside(fixture: BenchmarkFixture, run: string, identity = { kind: 'external', machine: 'by-hand', workspace: fixture.work }) {
  const next = async (): Promise<Envelope> => envelope(await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ driver: { ...identity, can: CAN }, running: [] })]));
  const send = async (lease: Lease, settled: Record<string, unknown>): Promise<Envelope> => envelope(await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({
    driver: identity, attempt: lease.attempt, revision: lease.revision, ...settled,
  })]));
  const envOf = (lease: Lease, scope: EnvScope | undefined): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(fixture.env).filter(([key]) => !(scope?.withhold ?? []).includes(key))),
    ...lease.env,
    TEAMAI_WORKFLOW_ATTEMPT: `${run}/${lease.attempt}`,
  });
  const launch = async (file: string, args: string[], lease: Lease, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> => execute(file, args, { cwd: lease.cwd, env })
    .then(({ stdout }) => ({ code: 0, stdout }), (error: unknown) => {
      const exited = ExitedSchema.parse(error);
      return { code: exited.code ?? 1, stdout: exited.stdout ?? '' };
    });
  /** Runs the lease's setup, when it has one, and answers whether it passed. */
  const setUp = async (lease: Lease): Promise<boolean> => !lease.setup || (await launch('/bin/sh', ['-c', lease.setup.command], lease, envOf(lease, lease.setup.envScope))).code === 0;
  const command = async (lease: Lease): Promise<Envelope> => {
    if (lease.command === undefined) throw new Error(`step ${lease.step} runs no command`);
    const ran = await setUp(lease) ? await launch('/bin/sh', ['-c', lease.command], lease, envOf(lease, lease.envScope)) : undefined;
    return send(lease, ran?.code === 0 ? { outcome: 'success', ...(lease.output !== undefined ? { outputs: JSON.parse(ran.stdout) } : {}) } : { outcome: 'failed' });
  };
  /** Takes and runs every command lease until `next` answers a prompt lease, or else what it answered. */
  const commandsUntil = async (wanted: 'prompt' | 'done'): Promise<Envelope> => {
    for (let polls = 0; polls < 60; polls += 1) {
      const answer = await next();
      const parsed = NextSchema.safeParse(answer);
      if (!parsed.success || 'done' in parsed.data.data) return answer;
      if ('wait' in parsed.data.data) {
        if (wanted === 'prompt') return answer;
        await new Promise((resolve) => { setTimeout(resolve, 500); });
        continue;
      }
      const { lease } = parsed.data.data;
      if (lease.command === undefined) return answer;
      await command(lease);
    }
    throw new Error(`run ${run} did not reach a ${wanted}`);
  };
  return {
    identity, next,
    /** Reports the prompt lease a success of claude. */
    report: (lease: Lease): Promise<Envelope> => send(lease, { tool: 'claude', outcome: 'success' }),
    /** Runs the prompt lease's setup and its tool, as the lease says, and reports it. */
    launchTool: async (lease: Lease): Promise<Envelope> => {
      const ran = await setUp(lease) && lease.prompt !== undefined ? await launch(path.join(fixture.bin, 'claude'), ['-p', lease.prompt], lease, envOf(lease, lease.envScope)) : undefined;
      return send(lease, { tool: 'claude', outcome: ran?.code === 0 ? 'success' : 'failed' });
    },
    /** The trial's prompt lease, once the driver ran the plan and the baselines before it. */
    prompt: async (): Promise<Lease> => LeasedSchema.parse(await commandsUntil('prompt')).data.lease,
    /** What `next` answers once the driver ran every command lease left: the run's end, or a lease it cannot run. */
    finish: () => commandsUntil('done'),
  };
}

const DRIVERS: Array<{ name: string; run(fixture: BenchmarkFixture): Promise<string> }> = [
  { name: 'the local driver', run: runFixBenchmark },
  {
    name: 'a driver from outside',
    run: async (fixture) => {
      const run = await startFixBenchmark(fixture);
      const driver = fromOutside(fixture, run);
      await driver.launchTool(await driver.prompt());
      await driver.finish();
      return run;
    },
  },
];

describe.each(DRIVERS)('the strip list on $name', ({ run }) => {
  it('keeps every withheld name out of setup, the tool and the check', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: WITH_SETUP, tasks: { fix: TASK }, printsEnv: true,
      team: { 'env/env.yaml': 'variables:\n  - key: GH_TOKEN\n    value: from-the-team\n' },
    });
    fixtures.push(fixture);
    for (const name of WITHHELD) fixture.env[name] = `member-${name.toLowerCase()}`;
    fixture.env.BENCHMARK_VISIBLE = 'seen';

    const runId = await run(fixture);

    expect(fixture.toolLaunches()).toHaveLength(1);
    for (const who of ['setup', 'tool', 'check']) {
      const seen = fs.readFileSync(path.join(fixture.root, `${who}.env`), 'utf8').split('\n').map((line) => line.split('=')[0]);
      expect(seen, who).toContain('BENCHMARK_VISIBLE');
      expect(seen.filter((name) => WITHHELD.includes(name ?? '')), who).toEqual([]);
    }
    const stored = StepsSchema.parse(fixture.runFile(runId));
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);

  it('keeps a withheld name out of setup also when the suite setup requires it', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: TASK }, printsEnv: true,
      suite: `${WITH_SETUP}  requires:\n    env: [GH_TOKEN]\n`,
    });
    fixtures.push(fixture);
    fixture.env.GH_TOKEN = 'member-gh-token';

    const runId = await run(fixture);

    const seen = fs.readFileSync(path.join(fixture.root, 'setup.env'), 'utf8').split('\n').map((line) => line.split('=')[0]);
    expect(seen).not.toContain('GH_TOKEN');
    const stored = StepsSchema.parse(fixture.runFile(runId));
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);
});

describe('git in the clone once the tool ran there', () => {
  /** A script that writes the environment it was started with to `<name>.env` in the fixture's root, and fails. */
  function recorder(fixture: BenchmarkFixture, name: string): string {
    const file = path.join(fixture.root, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\nenv > "$FIXTURE_ROOT/${name}.env"\nexit 1\n`, { mode: 0o755 });
    return file;
  }

  it('runs no hook or fsmonitor the agent configured there, and gives a filter git still runs none of the withheld names', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    for (const name of WITHHELD) fixture.env[name] = `member-${name.toLowerCase()}`;
    fixture.env.BENCHMARK_VISIBLE = 'seen';
    const runId = await startFixBenchmark(fixture);
    const driver = fromOutside(fixture, runId);
    const lease = await driver.prompt();
    const hooks = path.join(fixture.root, 'agent-hooks');
    fs.mkdirSync(hooks);
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit']) fs.copyFileSync(recorder(fixture, 'hook'), path.join(hooks, hook));
    const agentGit = (args: string[]) => execFileSync('git', args, { cwd: lease.cwd, env: fixture.env });
    agentGit(['config', 'core.hooksPath', hooks]);
    agentGit(['config', 'core.fsmonitor', recorder(fixture, 'fsmonitor')]);
    agentGit(['config', 'filter.agent.clean', 'env > "$FIXTURE_ROOT/filter.env"; cat']);
    fs.writeFileSync(path.join(lease.cwd, '.gitattributes'), 'answer.js filter=agent\n');
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');

    const reported = await driver.report(lease);
    const checked = await driver.finish();

    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(checked).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.existsSync(path.join(fixture.root, 'hook.env'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, 'fsmonitor.env'))).toBe(false);
    const filtered = fs.readFileSync(path.join(fixture.root, 'filter.env'), 'utf8').split('\n').map((line) => line.split('=')[0]);
    expect(filtered).toContain('BENCHMARK_VISIBLE');
    expect(filtered.filter((name) => WITHHELD.includes(name ?? ''))).toEqual([]);
  }, 120_000);

  it('gives an fsmonitor the suite setup configured there none of the withheld names, as teamai reads what the tool starts on', async () => {
    const suite = WITH_SETUP.replace('env > "$FIXTURE_ROOT/setup.env"', 'git config core.fsmonitor "$FIXTURE_ROOT/fsmonitor.sh"');
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], suite, tasks: { fix: TASK } });
    fixtures.push(fixture);
    fs.writeFileSync(path.join(fixture.root, 'fsmonitor.sh'), '#!/bin/sh\nenv >> "$FIXTURE_ROOT/fsmonitor.env"\nexit 1\n', { mode: 0o755 });
    for (const name of WITHHELD) fixture.env[name] = `member-${name.toLowerCase()}`;

    const runId = await runFixBenchmark(fixture);

    const monitored = path.join(fixture.root, 'fsmonitor.env');
    const seen = fs.existsSync(monitored) ? fs.readFileSync(monitored, 'utf8').split('\n').map((line) => line.split('=')[0]) : [];
    expect(seen.filter((name) => WITHHELD.includes(name ?? ''))).toEqual([]);
    expect(RecordSchema.parse(fixture.benchmarkRecord(runId)).trials).toEqual([expect.objectContaining({ result: 'passed' })]);
  }, 120_000);

  it('runs no hook the agent configured as hook.<name>.command there, whatever its name', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    const runId = await startFixBenchmark(fixture);
    const driver = fromOutside(fixture, runId);
    const lease = await driver.prompt();
    const agentGit = (args: string[]) => execFileSync('git', args, { cwd: lease.cwd, env: fixture.env });
    for (const name of ['from-agent', 'from.agent', 'from=agent']) {
      agentGit(['config', `hook.${name}.command`, recorder(fixture, 'hook')]);
      for (const event of ['pre-commit', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction']) agentGit(['config', '--add', `hook.${name}.event`, event]);
    }
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');

    const reported = await driver.report(lease);
    const checked = await driver.finish();

    expect(fs.existsSync(path.join(fixture.root, 'hook.env'))).toBe(false);
    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(checked).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(RecordSchema.parse(fixture.benchmarkRecord(runId)).trials).toEqual([expect.objectContaining({ result: 'passed' })]);
  }, 120_000);

  it('shows the judge what the agent changed from the starting commit itself, when the agent replaced that commit with git replace', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], tasks: { fix: CRITERIA_TASK } });
    fixtures.push(fixture);
    const runId = await startFixBenchmark(fixture);
    const driver = fromOutside(fixture, runId);
    const lease = await driver.prompt();
    const agentGit = (args: string[]) => execFileSync('git', args, { cwd: lease.cwd, env: fixture.env });
    fs.writeFileSync(path.join(lease.cwd, 'answer.js'), 'module.exports = 42;\n');
    agentGit(['add', 'answer.js']);
    agentGit(['commit', '-q', '-m', 'the fix']);
    agentGit(['replace', fixture.startingCommit, 'HEAD']);
    const judge = { kind: 'external', machine: 'judge', workspace: fixture.work };

    const reported = await driver.report(lease);
    const leased = z.object({ data: z.object({ lease: z.object({ ref: z.string() }) }) })
      .parse(envelope(await fixture.teamai(['score', '--next', '--json', JSON.stringify({ driver: { ...judge, can: { judge: { isolation: 'verified', tools: ['claude'] } } } })])));
    await fixture.teamai(['score', '--lease', leased.data.lease.ref, '--json', JSON.stringify({ driver: judge })]);

    expect(reported).toMatchObject({ data: { accepted: true } });
    expect(fixture.judgeLaunches()).toEqual([expect.objectContaining({ diff: expect.stringContaining('+module.exports = 42;') })]);
  }, 120_000);
});

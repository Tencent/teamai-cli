/**
 * Real CLI: every trial runs with the team assets of the run's frozen team revision, delivered into its own clone by its
 * own install, whatever the member's checkout pulls during the run, and nothing of that install reaches the member.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { benchmarkFixture, envelope, fixTask, PRODUCT_URL, runFixBenchmark, said, startFixBenchmark, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const TWO_REPETITIONS = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 2
timeout: 10m
`;
const SKILL = '---\nname: fixer\ndescription: Fixes the answer.\n---\nMake the answer right.\n';
const SANDBOX_CLAUDE = { workspace: ['read-only', 'new', 'continue', 'clone'], isolation: 'sandbox', env: true, tools: ['claude'], unattended: true };
const AgentSchema = z.object({
  team: z.object({ revision: z.string(), localChanges: z.boolean() }).passthrough().optional(),
  project: z.object({ commit: z.string() }).passthrough().optional(),
}).passthrough();
const RunSchema = z.object({
  status: z.string(),
  steps: z.array(z.object({ id: z.string(), status: z.string(), agent: AgentSchema.optional() }).passthrough()),
});
/** A check that passes only when the prompt's commit changed answer.js and nothing else. */
const ONLY_ANSWER_CHANGED = `const changed = require('node:child_process').execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).trim();
if (changed !== 'answer.js') throw new Error('The commit changed: ' + changed);
require('./test.js');
`;

const fixtures: BenchmarkFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const EXTERNAL = { kind: 'external', machine: 'ci', workspace: '/ci' };
const LeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), command: z.string().optional(), prompt: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(), envScope: z.object({ withhold: z.array(z.string()) }).passthrough().optional(), output: z.unknown().optional(), cwd: z.string().optional(),
}).passthrough();
const NextSchema = z.union([
  z.object({ lease: LeaseSchema }),
  z.object({ wait: z.object({}).passthrough() }),
  z.object({ done: z.object({ outcome: z.string() }).passthrough() }),
]);
const PromptLeaseSchema = z.object({
  attempt: z.string(), revision: z.number(), prompt: z.string(), tool: z.string(), cwd: z.string(), envScope: z.object({ withhold: z.array(z.string()) }),
});
const ExitSchema = z.object({ code: z.number(), stdout: z.string().optional() });

/** Asks run `runId` for work as an external driver that can run claude trials in a sandbox, with places it prepares. */
async function nextFor(fixture: BenchmarkFixture, runId: string, can = SANDBOX_CLAUDE): Promise<z.infer<typeof NextSchema>> {
  const next = await fixture.teamai(['workflow', 'next', runId, '--prepare', '--json', JSON.stringify({ driver: { ...EXTERNAL, can }, running: [] })]);
  return NextSchema.parse(envelope(next).data);
}

async function report(fixture: BenchmarkFixture, runId: string, body: Record<string, unknown>): Promise<void> {
  const reported = await fixture.teamai(['workflow', 'report', runId, '--json', JSON.stringify({ driver: EXTERNAL, ...body })]);
  if (envelope(reported).data?.accepted !== true) throw new Error(`report refused: ${said(reported)}`);
}

/** `env` without the names a lease withholds, with the values it gives. */
function withheld(env: NodeJS.ProcessEnv, withhold: readonly string[], given: Record<string, string>): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => !withhold.includes(key))), ...given };
}

/**
 * Runs a command lease in its place with the attempt marker every driver gives a step's processes, and reports its exit
 * and, for a step with output, its stdout JSON.
 */
async function runCommand(fixture: BenchmarkFixture, runId: string, lease: z.infer<typeof LeaseSchema> & { command: string }): Promise<void> {
  const ran = await promisify(execFile)('sh', ['-c', lease.command], { cwd: lease.cwd ?? fixture.work, env: withheld(fixture.env, lease.envScope?.withhold ?? [], { ...lease.env, TEAMAI_WORKFLOW_ATTEMPT: `${runId}/${lease.attempt}` }) })
    .then(({ stdout }) => ({ code: 0, stdout }), (failed: unknown) => ExitSchema.parse(failed));
  const outputs: unknown = ran.code === 0 && lease.output !== undefined && ran.stdout !== undefined ? JSON.parse(ran.stdout) : undefined;
  await report(fixture, runId, {
    attempt: lease.attempt, revision: lease.revision, outcome: ran.code === 0 ? 'success' : 'failed', exitCode: ran.code, ...(outputs !== undefined ? { outputs } : {}),
  });
}

/** Launches a prompt lease's tool in its prepared clone, without the names it withholds and with the attempt marker, and reports it. */
async function runPrompt(fixture: BenchmarkFixture, runId: string, leased: unknown): Promise<void> {
  const lease = PromptLeaseSchema.parse(leased);
  const env = withheld(fixture.env, lease.envScope.withhold, { TEAMAI_WORKFLOW_ATTEMPT: `${runId}/${lease.attempt}` });
  const started = Date.now();
  const launched = await promisify(execFile)(path.join(fixture.bin, lease.tool), ['-p', lease.prompt], { cwd: lease.cwd, env }).then(() => 'success', () => 'failed');
  await report(fixture, runId, { attempt: lease.attempt, revision: lease.revision, tool: lease.tool, durationMs: Date.now() - started, outcome: launched });
}

/**
 * Drives run `runId` as an external driver until it is done: it runs the plan, the checks and the report as the command
 * leases they are, and the prompts on the fake tools. Stops at the first lease `until` takes, and answers it.
 */
async function drive(fixture: BenchmarkFixture, runId: string, until: (lease: z.infer<typeof LeaseSchema>) => boolean = () => false, can = SANDBOX_CLAUDE): Promise<z.infer<typeof LeaseSchema> | undefined> {
  for (let polls = 0; polls < 40; polls += 1) {
    const answer = await nextFor(fixture, runId, can);
    if ('done' in answer) return undefined;
    if ('wait' in answer) {
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      continue;
    }
    const { lease } = answer;
    if (until(lease)) return lease;
    if (lease.command !== undefined) await runCommand(fixture, runId, { ...lease, command: lease.command });
    else await runPrompt(fixture, runId, lease);
  }
  throw new Error(`run ${runId} did not end`);
}

const DRIVERS: Array<{ name: string; run(fixture: BenchmarkFixture): Promise<string> }> = [
  { name: 'the local driver', run: runFixBenchmark },
  {
    name: 'an external driver',
    run: async (fixture) => {
      const runId = await startFixBenchmark(fixture);
      await drive(fixture, runId);
      return runId;
    },
  },
];

describe.each(DRIVERS)('trial team assets on $name', ({ run }) => {
  it('gives every trial the frozen team revision and the starting commit, also after the member pulls a team change', async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], suite: TWO_REPETITIONS, firstLaunch: 'pulls-a-team-change',
      team: { 'skills/fixer/SKILL.md': SKILL }, app: { 'AGENTS.md': 'Starting agents.\n', 'CLAUDE.md': 'Starting claude.\n' },
    });
    fixtures.push(fixture);
    fs.writeFileSync(path.join(fixture.work, 'AGENTS.md'), 'The member edited this.\n');
    fs.writeFileSync(path.join(fixture.work, 'CLAUDE.md'), 'The member edited this too.\n');
    const settings = path.join(fixture.home, '.claude', 'settings.json');
    const settingsBefore = fs.readFileSync(settings);
    const baseline = git(fixture.teamClone, ['rev-parse', 'HEAD']);

    const runId = await run(fixture);

    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    for (const repetition of [1, 2]) {
      expect(stored.steps.find((step) => step.id === `trials.r${repetition}.fix.claude.prompt`)?.agent).toMatchObject({
        team: { revision: baseline, localChanges: false }, project: { commit: fixture.startingCommit },
      });
    }
    expect(git(fixture.teamClone, ['rev-parse', 'HEAD'])).not.toBe(baseline);
    const launches = fixture.toolLaunches();
    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      expect(launch.paths).toContain('.claude/skills/fixer/SKILL.md');
      expect(launch.agentFiles).toEqual({ 'AGENTS.md': 'Starting agents.\n', 'CLAUDE.md': 'Starting claude.\n' });
    }
    expect(fixture.hookCalls()).toEqual([]);
    expect(fs.readFileSync(settings)).toEqual(settingsBefore);
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 180_000);
});

/** Every value under a `delivered` or `gitExcludePaths` key of `value`: what pull recorded it delivered into the checkout. */
function pullRecords(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => (key === 'delivered' || key === 'gitExcludePaths' ? [inner] : pullRecords(inner)));
}

/** What the member has from pull: the checkout's status, the pull record in each state file, and every file under `.claude/`. */
function memberSide(fixture: BenchmarkFixture): { status: string; records: unknown[]; files: string[][] } {
  const data = path.join(fixture.home, '.teamai');
  const states = [path.join(data, 'state.json'), ...fs.readdirSync(path.join(data, 'projects')).map((project) => path.join(data, 'projects', project, 'state.json'))]
    .filter((file) => fs.existsSync(file));
  const files = fs.readdirSync(path.join(fixture.work, '.claude'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name)).sort().map((file) => [path.relative(fixture.work, file), fs.readFileSync(file, 'utf8')]);
  return { status: git(fixture.work, ['status', '--porcelain']), records: states.flatMap((file) => pullRecords(JSON.parse(fs.readFileSync(file, 'utf8')))), files };
}

describe("the member's checkout around a benchmark", () => {
  it.each([
    ['ends', async (fixture: BenchmarkFixture) => { await runFixBenchmark(fixture); }],
    ['is cancelled halfway', async (fixture: BenchmarkFixture) => {
      const runId = await startFixBenchmark(fixture);
      const second = await drive(fixture, runId, ({ step }) => step === 'trials.r2.fix.claude.prompt');
      expect(second?.step).toBe('trials.r2.fix.claude.prompt');
      const cancelled = await fixture.teamai(['workflow', 'cancel', runId]);
      expect(cancelled.code, said(cancelled)).toBe(0);
    }],
  ] as const)("leaves the checkout, its pull record and its delivered files as they were when a run %s", async (_, run) => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], suite: TWO_REPETITIONS, team: { 'skills/fixer/SKILL.md': SKILL } });
    fixtures.push(fixture);
    const before = memberSide(fixture);
    expect(JSON.stringify(before.records)).toContain('fixer');
    expect(before.files.map(([file]) => file)).toContain('.claude/skills/fixer/SKILL.md');

    await run(fixture);

    expect(memberSide(fixture)).toEqual(before);
  }, 180_000);
});

describe('trial team assets', () => {
  it("commits only the agent's edits, not the team assets the trial's install delivered", async () => {
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], team: { 'skills/fixer/SKILL.md': SKILL }, app: { 'check.js': ONLY_ANSWER_CHANGED },
      tasks: { fix: fixTask('{{startingCommit}}').replace('run: node test.js', 'run: node check.js') },
    });
    fixtures.push(fixture);

    const runId = await runFixBenchmark(fixture);

    expect(fixture.toolLaunches()[0]?.paths).toContain('.claude/skills/fixer/SKILL.md');
    expect(RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);

  it('pins the team revision with the team remote unreachable', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], team: { 'skills/fixer/SKILL.md': SKILL } });
    fixtures.push(fixture);
    const baseline = git(fixture.teamClone, ['rev-parse', 'HEAD']);
    fs.renameSync(fixture.teamOrigin, `${fixture.teamOrigin}.gone`);

    const runId = await runFixBenchmark(fixture);

    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.prompt')?.agent).toMatchObject({ team: { revision: baseline } });
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
    expect(fixture.toolLaunches()[0]?.paths).toContain('.claude/skills/fixer/SKILL.md');
  }, 120_000);

  it('runs a killed trial again in a fresh clone on workflow resume, and removes the first', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'], firstLaunch: 'kills-its-driver' });
    fixtures.push(fixture);

    const killed = await fixture.teamai(['benchmark', 'run', 'fix']);
    const [runId] = fixture.runIds();
    if (runId === undefined) throw new Error(`no run: ${said(killed)}`);
    const resumed = await fixture.teamai(['workflow', 'resume', runId]);

    expect(killed.code, said(killed)).not.toBe(0);
    expect(resumed.code, said(resumed)).toBe(0);
    const [first, second, ...more] = fixture.toolLaunches();
    expect(more).toEqual([]);
    expect(second?.cwd).not.toBe(first?.cwd);
    expect(fs.existsSync(path.dirname(first?.cwd ?? fixture.tmp))).toBe(false);
    const stored = RunSchema.parse(fixture.runFile(runId));
    expect(stored.status).toBe('succeeded');
    expect(stored.steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
    expect(fixture.trialRootEntries()).toEqual([]);
  }, 120_000);

  it('fetches a starting commit the checkout lacks from the suite repo at plan, and a trial clones it offline', async () => {
    const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['claude'] });
    fixtures.push(fixture);
    const later = fixture.pushProduct({ 'README.md': '# app, later\n' });
    fixture.pushTeam({ 'benchmarks/fix/tasks/fix.yaml': fixTask(later) });
    const pulled = await fixture.teamai(['pull']);
    expect(pulled.code, said(pulled)).toBe(0);

    const runId = await startFixBenchmark(fixture);
    const planned = await nextFor(fixture, runId);
    if (!('lease' in planned) || planned.lease.step !== 'plan' || planned.lease.command === undefined) throw new Error(`no plan lease: ${JSON.stringify(planned)}`);
    await runCommand(fixture, runId, { ...planned.lease, command: planned.lease.command });
    fs.renameSync(fixture.productOrigin, `${fixture.productOrigin}.gone`);
    const resumed = await fixture.teamai(['workflow', 'resume', runId]);

    expect(resumed.code, said(resumed)).toBe(0);
    expect(fixture.toolLaunches()[0]?.head).toBe(later);
    expect(RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);

});

const CODEX_SUITE = `schemaVersion: v1alpha1
name: fix
repo: ${PRODUCT_URL}
defaults:
  tool: codex
arms:
  - name: codex
timeout: 10m
`;
const RULE = 'CLONE-RULE-SENTINEL: keep the answer right.\n';

/** Every file under the member's Claude and Codex homes and teamai's local dashboard, with its content. */
function homeFiles(fixture: BenchmarkFixture): string[][] {
  return ['.claude', '.codex', path.join('.teamai', 'dashboard')].map((dir) => path.join(fixture.home, dir)).filter((dir) => fs.existsSync(dir))
    .flatMap((dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)))
    .sort().map((file) => [path.relative(fixture.home, file), fs.readFileSync(file, 'utf8')]);
}

/**
 * A Codex trial driven up to its prompt, with its clone prepared, and `teamai` as the trial's tool would run it there: in a
 * subdirectory of the clone, with the member's HOME and the attempt marker.
 */
async function inTrialClone(): Promise<{ fixture: BenchmarkFixture; runId: string; lease: z.infer<typeof PromptLeaseSchema>; dir: string; teamai: (args: string[], input?: string) => ReturnType<typeof spawnSync> }> {
  const fixture = await benchmarkFixture({ tool: 'fixes', sandbox: true, tools: ['codex'], suite: CODEX_SUITE, team: { 'rules/answer.md': RULE } });
  fixtures.push(fixture);
  const runId = await startFixBenchmark(fixture);
  const lease = PromptLeaseSchema.parse(await drive(fixture, runId, (leased) => leased.prompt !== undefined, { ...SANDBOX_CLAUDE, tools: ['codex'] }));
  const dir = path.join(lease.cwd, 'nested');
  fs.mkdirSync(dir);
  const env = withheld(fixture.env, lease.envScope.withhold, { TEAMAI_WORKFLOW_ATTEMPT: `${runId}/${lease.attempt}` });
  return { fixture, runId, lease, dir, teamai: (args, input = '') => spawnSync(path.join(fixture.bin, 'teamai'), args, { cwd: dir, env, input, encoding: 'utf8' }) };
}

describe('teamai run in a trial clone', () => {
  it("resolves the clone's own install from a subdirectory of the clone, and writes nothing into the member's home", async () => {
    const { fixture, dir, teamai } = await inTrialClone();
    const before = { member: memberSide(fixture), homes: homeFiles(fixture) };

    const hook = teamai(['hook-dispatch', 'session-start', '--tool', 'codex'], JSON.stringify({ cwd: dir, session_id: 'in-clone', hook_event_name: 'SessionStart', source: 'startup' }));
    // The hook's background pass pulls too; a pull while it holds the lock is skipped.
    await waitForDetachedChildren();
    const pulled = teamai(['pull']);

    expect(hook.status, String(hook.stderr)).toBe(0);
    expect(String(hook.stdout)).toContain('CLONE-RULE-SENTINEL');
    expect(pulled.status, `${String(pulled.stdout)}${String(pulled.stderr)}`).toBe(0);
    expect(String(pulled.stdout)).toContain('[workspace] Already synced');
    expect({ member: memberSide(fixture), homes: homeFiles(fixture) }).toEqual(before);
  }, 180_000);

  it("records a learning contributed in the clone on the trial's step", async () => {
    const { fixture, runId, lease, dir, teamai } = await inTrialClone();
    const file = path.join(dir, 'learning.md');
    fs.writeFileSync(file, '# Run the answer check first\n\nThe answer check names the expected value.\n');

    const contributed = teamai(['contribute', '--file', file, '--title', 'Run the answer check first']);
    await report(fixture, runId, { attempt: lease.attempt, revision: lease.revision, tool: lease.tool, durationMs: 1, outcome: 'success' });

    expect(contributed.status, `${String(contributed.stdout)}${String(contributed.stderr)}`).toBe(0);
    const step = z.object({ steps: z.array(z.object({ id: z.string(), outcomes: z.array(z.unknown()).optional() }).passthrough()) })
      .parse(fixture.runFile(runId)).steps.find(({ id }) => id === 'trials.r1.fix.codex.prompt');
    expect(step?.outcomes).toEqual([{ kind: 'learning', id: expect.stringMatching(/^run-the-answer-check-first-/) }]);
  }, 180_000);

  it("runs the trial's check with the member's HOME, not the clone install's", async () => {
    const homeCheck = "if (process.env.HOME.split(require('node:path').sep).includes('teamai-clones')) throw new Error('HOME is ' + process.env.HOME);\nrequire('./test.js');\n";
    const fixture = await benchmarkFixture({
      tool: 'fixes', sandbox: true, tools: ['claude'], team: { 'rules/answer.md': RULE }, app: { 'home-check.js': homeCheck },
      tasks: { fix: fixTask('{{startingCommit}}').replace('run: node test.js', 'run: node home-check.js').replace('protect: [test.js]', 'protect: [test.js, home-check.js]') },
    });
    fixtures.push(fixture);

    const runId = await runFixBenchmark(fixture);

    expect(RunSchema.parse(fixture.runFile(runId)).steps.find((step) => step.id === 'trials.r1.fix.claude.check')).toMatchObject({ status: 'succeeded' });
  }, 120_000);
});

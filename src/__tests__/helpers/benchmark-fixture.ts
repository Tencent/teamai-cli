/**
 * One member of a team that benchmarks a project, for the real CLI. The fixture owns every repo it makes:
 *   app.git     the project origin, `https://github.com/fixture/app.git` to git. Its first commit is a task's starting
 *               commit: `node test.js` fails there until answer.js exports 42.
 *   team.git    the team origin, `https://github.com/acme/team.git` to git, with the suite `fix` (by default one task,
 *               `fix`, and one arm, `claude`).
 *   home/       the member's HOME: `.gitconfig` with both URL rewrites, and the teamai install a workspace init made.
 *   home/work   the member's checkout of the project, where every command runs.
 *   bin/        a fake `claude` and a fake `codex` that answer the way `tool` says, and log where they ran, the model
 *               they were launched with and what they found there to tool.log, beside links to node and git. Each prints
 *               the model it was launched with as the one it ran, `fake-<tool>` without one, and a cost of 0.25 USD. PATH is bin/, /usr/bin and /bin, so a tool
 *               the fixture leaves out is not found; bin/teamai runs the CLI under test. Launched as a judge (with --json-schema), the fake `claude` answers the
 *               way `judge` says, at a cost of 0.1 USD, and logs to judge.log the labels it could give, the diff.patch of its
 *               evidence and what is left under the trial root then. Each launch also checks out a branch and back in its cwd under a
 *               HOME whose `.teamai/bin/teamai` writes hook.marker, so a teamai git hook there leaves the marker. Once
 *               `probeControl(run)` is called, each launch also runs `teamai workflow cancel <run>` in its own cwd and
 *               logs the answer to probe.log.
 *   tmp/        TMPDIR for every command, so whatever a run leaves in the temp dir is this fixture's.
 * Every command also has FIXTURE_ROOT, the fixture's root, so a suite's setup or check can leave what it saw there.
 *
 * `startBenchmarkRun` makes a run in process instead, for tests that call the engine without the CLI.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import type { LocalConfig } from '../../types.js';
import { compileBundle, freezePlan, type BenchmarkPlan } from '../../benchmark/plan.js';
import type { BenchmarkRunRecord, TrialResult } from '../../benchmark/result.js';
import { planOfRun } from '../../benchmark/run-plan.js';
import { commitCheckFiles, type CommittedSuite } from '../../benchmark/trial.js';
import { commitCacheOf } from '../../workflow/place/place.js';
import { parseSuite, type TeamChoice } from '../../benchmark/suite.js';
import type { ArmTeam } from '../../benchmark/terms.js';
import type { BenchmarkSuiteFiles } from '../../workflow/conformance-interpreter.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { error, leaseNext, reportAttempt, startRun } from '../../workflow/engine.js';
import type { DriverCan } from '../../workflow/requirements.js';
import { readRun } from '../../workflow/store.js';
import type { DriverIdentity, WorkflowEnvelope } from '../../workflow/types.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
export const TEAM_URL = 'https://github.com/acme/team.git';
export const PRODUCT_URL = 'https://github.com/fixture/app.git';

/**
 * What a fake tool does in the trial's clone: make the check pass, leave the clone as it was, or, on the fixture's first
 * launch of any fake tool, exit 1 without a change and make the check pass on every later one. The last three game a
 * check that reads them: set `skip` in check.config.js, add test/pass.setup.js, which stubs out assert, or commit that
 * helper as test/helpers/pass.setup.js into a git repository of its own. `writes-a-passing-test` writes an executable
 * test/auth/refresh.test.js that always passes, and no fix. `hangs` never exits; `fixes-and-hangs` makes the check pass,
 * takes git's index, HEAD and branch locks in the clone as a commit does, and never exits. `corrupts-git-and-hangs` leaves
 * the clone's index unreadable, so nothing can commit its work, and never exits. `fixes-behind-a-hanging-filter` makes the
 * check pass and exits, leaving a git clean filter on every file of the clone that never returns.
 * `fixes-behind-a-hanging-smudge` makes the check pass and exits, leaving a git smudge filter on the protected test.js
 * that never returns, in the clone's own .git/info/attributes. Each such filter logs its pid, read by `filterPids`.
 * `fixes-and-runs-out-of-turns` makes the check
 * pass, then, when launched with --max-turns, ends as Claude does at that cap: an `error_max_turns` result and exit 1.
 * `fixes-slowly` makes the check pass and exits after three seconds.
 * `fixes-when-unattended` makes the check pass only when launched in its tool's unattended mode, as Claude
 * (`--permission-mode bypassPermissions`) or Codex (`--dangerously-bypass-approvals-and-sandbox`); otherwise it is
 * refused the edit, as a real tool on a machine whose settings grant none, and exits 0 having changed nothing.
 * `fixes-and-spends` makes the check pass and bills 140 tokens: as claude, in two messages streamed as Claude streams
 * them with partial messages, and then works on with no result; as codex, in the one turn.completed Codex prints as it
 * ends.
 */
export type FakeTool = 'fixes' | 'does-nothing' | 'fails-first' | 'skips-the-check' | 'adds-a-helper' | 'adds-a-helper-repository' | 'writes-a-passing-test' | 'hangs'
  | 'fixes-and-hangs' | 'corrupts-git-and-hangs' | 'fixes-behind-a-hanging-filter' | 'fixes-behind-a-hanging-smudge' | 'fixes-and-runs-out-of-turns'
  | 'fixes-and-spends' | 'fixes-slowly' | 'fixes-when-unattended';

/**
 * What a fake tool does on the fixture's first launch of any fake tool, before it answers: push a team commit of
 * `teamChange` and run `teamai pull` in the member's checkout, or kill the process that launched it and exit. Only the
 * local driver may be killed: the fake external driver runs inside the test.
 */
export type FirstLaunch = 'pulls-a-team-change' | 'kills-its-driver';

/** What the fake `claude` judge answers: the first label of its scorer, `incorrect` where its scorer has one, a label its scorer lacks, or exit 1. */
export type FakeJudge = 'first-label' | 'incorrect' | 'another-label' | 'fails' | 'hangs';

/** One launch of the fake judge: the labels its answer schema allows, its evidence's diff.patch, and the trial roots left. */
const JudgeLaunchSchema = z.object({ labels: z.array(z.string()), diff: z.string().nullable(), trialRoots: z.array(z.string()) });
export type JudgeLaunch = z.infer<typeof JudgeLaunchSchema>;

/**
 * Where one launch of a fake tool ran: when it started, in ms since the epoch, which tool, the `--model` and the effort it was launched with (null without one), its cwd,
 * that cwd's own `.git`, its HEAD and its remotes, every file in it outside `.git`, its AGENTS.md and CLAUDE.md, and the
 * team instructions pull wrote for Claude, .claude/rules/teamai-context.md (null when missing).
 */
const ToolLaunchSchema = z.object({
  at: z.number(), tool: z.string(), model: z.string().nullable(), effort: z.string().nullable(), cwd: z.string(), ownGit: z.boolean(), head: z.string(), remotes: z.string(),
  paths: z.array(z.string()), agentFiles: z.object({ 'AGENTS.md': z.string().nullable(), 'CLAUDE.md': z.string().nullable() }), teamContext: z.string().nullable(),
});
export type ToolLaunch = z.infer<typeof ToolLaunchSchema>;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const EnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface BenchmarkFixture {
  root: string;
  home: string;
  work: string;
  /** Where the fake tools are. */
  bin: string;
  /** The environment every teamai command runs with. */
  env: NodeJS.ProcessEnv;
  teamOrigin: string;
  /** app.git, the project origin. */
  productOrigin: string;
  tmp: string;
  /** The member's clone of the team repo, which `teamai pull` updates. */
  teamClone: string;
  /** The project commit the task starts from. */
  startingCommit: string;
  teamai(args: string[]): Promise<CliResult>;
  /** The run file of `run`, as JSON. */
  runFile(run: string): unknown;
  /** Commits `files` to the team origin's main branch, as another member's push would; a null file or directory is deleted. */
  pushTeam(files: Record<string, string | null>): void;
  /** Commits `files` to the project origin's main branch, which the member's checkout has not fetched, and returns the commit. */
  pushProduct(files: Record<string, string>): string;
  /** The runs stored in the member's workspace data home. */
  runIds(): string[];
  /** `git status --porcelain` of the member's checkout. */
  status(): string;
  /** The end record of `run` on the team origin's teamai-reports branch, as JSON. */
  endRecord(run: string): unknown;
  /** The benchmark record of `run` in its run directory, as JSON. */
  benchmarkRecord(run: string): unknown;
  /** The benchmark record of `run` on the team origin's teamai-reports branch, as JSON. */
  reportedBenchmark(run: string): unknown;
  /** Every launch of the fake tool so far. */
  toolLaunches(): ToolLaunch[];
  /** The pid of each git filter a fake tool left, as each logged it when git started it. */
  filterPids(): number[];
  /** Every launch of the fake judge so far. */
  judgeLaunches(): JudgeLaunch[];
  /** What is left under the trial root in TMPDIR. */
  trialRootEntries(): string[];
  /** The arguments of each `teamai` call a git hook made in a fake tool's cwd. */
  hookCalls(): string[];
  /** Makes every later launch of a fake tool run `teamai workflow cancel <run>` from its cwd, as an agent might. */
  probeControl(run: string): void;
  /** The envelope of each control command a fake tool ran. */
  probeAnswers(): Envelope[];
  remove(): void;
}

export function said(result: CliResult): string {
  return `exit ${result.code}\n${result.stdout}\n${result.stderr}`;
}

/** The last JSON line a command printed. */
export function envelope(result: CliResult): Envelope {
  const line = result.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope:\n${said(result)}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

/** Starts the benchmark workflow on suite `fix` for an external driver, bounded by `timeout`, and answers its run. */
export async function startFixBenchmark(fixture: BenchmarkFixture, timeout = '10m'): Promise<string> {
  const answer = await fixture.teamai(['workflow', 'start', 'teamai-benchmark', '--inputs', '{"suite":"fix","aliases":"team"}', '--timeout', timeout]);
  const run = envelope(answer).data?.run;
  if (typeof run !== 'string') throw new Error(`no run: ${said(answer)}`);
  return run;
}

/** Runs suite `fix` with `teamai benchmark run` on the local driver, and answers its run, whatever its outcome. */
export async function runFixBenchmark(fixture: BenchmarkFixture): Promise<string> {
  const ran = await fixture.teamai(['benchmark', 'run', 'fix']);
  const run = z.object({ run: z.string() }).safeParse(envelope(ran).data?.done).data?.run;
  if (run === undefined) throw new Error(`no run: ${said(ran)}`);
  return run;
}

const CommandLeaseSchema = z.object({
  step: z.string(), attempt: z.string(), revision: z.number(), command: z.string().optional(), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional(),
}).passthrough();

/**
 * Answers `next --prepare` for the driver `payload` names until it gets something other than a command lease, running
 * each command lease as an external driver does: in the lease's cwd, as its attempt, reporting its stdout as outputs.
 */
export async function driveCommands(fixture: BenchmarkFixture, run: string, payload: { driver: Record<string, unknown> }): Promise<Envelope> {
  for (;;) {
    const answer = envelope(await fixture.teamai(['workflow', 'next', run, '--prepare', '--json', JSON.stringify({ ...payload, running: [] })]));
    const lease = CommandLeaseSchema.safeParse(answer.data?.lease);
    if (!lease.success || lease.data.command === undefined) return answer;
    const { attempt, revision, command, env, cwd } = lease.data;
    const ran = spawnSync('sh', ['-c', command], { cwd: cwd ?? fixture.work, env: { ...fixture.env, ...env, TEAMAI_WORKFLOW_ATTEMPT: `${run}/${attempt}` }, encoding: 'utf8' });
    const outputs: unknown = ran.status === 0 ? JSON.parse(ran.stdout) : undefined;
    const reported = envelope(await fixture.teamai(['workflow', 'report', run, '--json', JSON.stringify({
      attempt, revision, outcome: ran.status === 0 ? 'success' : 'failed', driver: payload.driver, ...(outputs === undefined ? {} : { outputs }),
    })]));
    if (reported.error) throw new Error(`report of ${lease.data.step} refused: ${JSON.stringify(reported)}`);
  }
}

export const FIX_SUITE = `schemaVersion: v1alpha1
name: fix
description: Fix the answer.
repo: ${PRODUCT_URL}
defaults:
  tool: claude
arms:
  - name: claude
repetitions: 1
timeout: 10m
`;

export function fixTask(startingCommit: string, prompt = 'Make node test.js pass.'): string {
  return `schemaVersion: v1alpha1
title: Fix the answer
prompt: ${prompt}
startingCommit: ${startingCommit}
check:
  run: node test.js
  protect: [test.js]
`;
}

const FIX = "fs.writeFileSync('answer.js', 'module.exports = 42;\\n');";
const FAKE_TOOLS: Record<FakeTool, string> = {
  fixes: FIX,
  'fixes-slowly': `${FIX} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);`,
  'fixes-when-unattended': `const mode = path.basename(process.argv[1]) === 'claude' ? ['--permission-mode', 'bypassPermissions'] : ['--dangerously-bypass-approvals-and-sandbox'];
const at = process.argv.indexOf(mode[0]);
if (at !== -1 && mode.every((flag, index) => process.argv[at + index] === flag)) { ${FIX} }
else process.stderr.write('Permission to write answer.js was not granted.\\n');`,
  'does-nothing': '',
  hangs: 'setInterval(() => {}, 60_000);',
  'fixes-and-hangs': `${FIX} const ref = fs.readFileSync('.git/HEAD', 'utf8').match(/^ref: (.+)$/m);
for (const name of ['index', 'HEAD', ...(ref ? [ref[1]] : [])]) {
  fs.mkdirSync(path.dirname('.git/' + name), { recursive: true });
  fs.writeFileSync('.git/' + name + '.lock', '');
}
setInterval(() => {}, 60_000);`,
  'corrupts-git-and-hangs': `fs.writeFileSync('.git/index', 'not an index');
setInterval(() => {}, 60_000);`,
  'fixes-behind-a-hanging-filter': `${FIX} fs.writeFileSync('.gitattributes', '* filter=hang\\n');
fs.appendFileSync('.git/config', '[filter "hang"]\\n\\tclean = "echo $$ >> ' + filterPids + '; exec sleep 600"\\n');`,
  'fixes-behind-a-hanging-smudge': `${FIX} fs.mkdirSync('.git/info', { recursive: true });
fs.writeFileSync('.git/info/attributes', 'test.js filter=hang\\n');
fs.appendFileSync('.git/config', '[filter "hang"]\\n\\tsmudge = "echo $$ >> ' + filterPids + '; exec sleep 600"\\n');`,
  'fixes-and-spends': `${FIX} if (path.basename(process.argv[1]) === 'claude') {
  for (const id of ['m1', 'm2']) {
    process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: 40, output_tokens: 1 } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 40, output_tokens: 2 } } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 40, output_tokens: 30 } } }) + '\\n');
  }
  setInterval(() => {}, 60_000);
  return;
}
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 80, output_tokens: 60 } }) + '\\n');`,
  'fixes-and-runs-out-of-turns': `${FIX} if (process.argv.includes('--max-turns')) {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'fake-session', usage: { input_tokens: 4, output_tokens: 2 } }) + '\\n');
  process.exit(1);
}`,
  'fails-first': `if (first) process.exitCode = 1; else ${FIX}`,
  'skips-the-check': "fs.writeFileSync('check.config.js', 'module.exports = { skip: true };\\n');",
  'adds-a-helper': "fs.mkdirSync('test', { recursive: true }); fs.writeFileSync('test/pass.setup.js', \"require('node:assert').strictEqual = () => {};\\n\");",
  'writes-a-passing-test': "fs.mkdirSync('test/auth', { recursive: true }); fs.writeFileSync('test/auth/refresh.test.js', '#!/bin/sh\\nexit 0\\n', { mode: 0o755 });",
  'adds-a-helper-repository': `fs.mkdirSync('test/helpers', { recursive: true });
fs.writeFileSync('test/helpers/pass.setup.js', "require('node:assert').strictEqual = () => {};\\n");
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-qm', 'helper']]) execFileSync('git', args, { cwd: 'test/helpers' });`,
};

/**
 * The fake claude's code that leaves session fake-session, in which the Skill tool loaded `skill` when its cwd has it. A
 * launch whose prompt says `[no session]` leaves none, and removes the one an earlier launch in its cwd left.
 */
function loadsSkill(skill: string): string {
  return `{
  const project = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(project, { recursive: true });
  if (process.argv.some((arg) => arg.includes('[no session]'))) fs.rmSync(path.join(project, 'fake-session.jsonl'), { force: true });
  else {
    const at = new Date(Date.now() + 1000).toISOString();
    const base = { cwd: process.cwd(), sessionId: 'fake-session', timestamp: at };
    const asked = { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Fix it.' } };
    const loaded = [
      { ...base, type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', model: 'fake-claude', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: ${JSON.stringify(skill)} } }] } },
      { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: ${skill}' }] } },
    ];
    const answered = { ...base, type: 'assistant', uuid: 'u2', parentUuid: 'u1', message: { role: 'assistant', model: 'fake-claude', content: [{ type: 'text', text: 'Fixed.' }] } };
    const has = fs.existsSync(path.join('.claude', 'skills', ${JSON.stringify(skill)}, 'SKILL.md'));
    fs.writeFileSync(path.join(project, 'fake-session.jsonl'), [asked, ...(has ? loaded : [answered])].map((line) => JSON.stringify(line)).join('\\n') + '\\n');
  }
}`;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function seed(dir: string, files: Record<string, string>, origin: string, executable: readonly string[] = []): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFiles(dir, files);
  for (const file of executable) fs.chmodSync(path.join(dir, file), 0o755);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
  git(dir, ['push', '-q', origin, 'main']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

export interface BenchmarkFixtureOptions {
  tool: FakeTool;
  sandbox: boolean;
  /** The fake tools in bin/; both by default. */
  tools?: Array<'claude' | 'codex'>;
  /** benchmarks/fix/suite.yaml; FIX_SUITE by default. */
  suite?: string;
  /** benchmarks/fix/tasks/<name>.yaml by name; `{{startingCommit}}` is replaced. One task, `fix`, by default. */
  tasks?: Record<string, string>;
  /** More files in the team repo, such as a skill. */
  team?: Record<string, string>;
  /** The team repo files committed executable. */
  executable?: string[];
  /** More files in the starting commit. */
  app?: Record<string, string>;
  firstLaunch?: FirstLaunch;
  /** The files `pulls-a-team-change` pushes; later.md by default. */
  teamChange?: Record<string, string>;
  /** Each launch of a fake tool also writes what `sh -c env` prints to tool.env in the fixture's root. */
  printsEnv?: boolean;
  /** How the fake `claude` judges; `first-label` by default. */
  judge?: FakeJudge;
  /** The member's `workflows.max_parallel`; unset by default, which the local driver reads as 1. */
  maxParallel?: number;
  /** The role the member joins with, `teamai init --role`; none by default. */
  role?: string;
  /**
   * A skill each launch of the fake claude loads when its cwd has it in .claude/skills: each launch leaves a Claude session,
   * as the local driver reads `used` from, in which the Skill tool loaded it or no skill, unless its prompt says
   * `[no session]`. Without it, no launch leaves one.
   */
  loadsSkill?: string;
  /**
   * Self mode: the team files sit under .teamai/ of the project repo, committed after the starting commit, and the
   * member runs `teamai init .` there. No team repo of its own is seeded.
   */
  selfMode?: boolean;
}

export async function benchmarkFixture(options: BenchmarkFixtureOptions): Promise<BenchmarkFixture> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-')));
  const home = path.join(root, 'home');
  const work = path.join(home, 'work');
  const teamOrigin = path.join(root, 'team.git');
  const productOrigin = path.join(root, 'app.git');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  for (const dir of [path.join(home, '.claude'), bin, tmp]) fs.mkdirSync(dir, { recursive: true });
  git(root, ['init', '-q', '--bare', '-b', 'main', teamOrigin]);
  git(root, ['init', '-q', '--bare', '-b', 'main', productOrigin]);
  const productSeed = path.join(root, 'seed-app');
  const startingCommit = seed(productSeed, {
    'README.md': '# app\n',
    'answer.js': 'module.exports = 41;\n',
    'test.js': "const assert = require('node:assert');\nassert.strictEqual(require('./answer.js'), 42);\n",
    ...options.app,
  }, productOrigin);
  const teamSeed = path.join(root, 'seed-team');
  const tasks = options.tasks ?? { fix: fixTask('{{startingCommit}}') };
  const teamFiles = {
    'teamai.yaml': options.selfMode ? `team: app\nrepo: ${PRODUCT_URL}\nprovider: git\nmode: self\n` : `team: acme\nrepo: ${TEAM_URL}\nprovider: git\n`,
    'benchmarks/fix/suite.yaml': options.suite ?? FIX_SUITE,
    ...Object.fromEntries(Object.entries(tasks).map(([name, text]) => [`benchmarks/fix/tasks/${name}.yaml`, text.replaceAll('{{startingCommit}}', startingCommit)])),
    ...options.team,
  };
  if (options.selfMode) {
    writeFiles(productSeed, Object.fromEntries(Object.entries(teamFiles).map(([file, text]) => [`.teamai/${file}`, text])));
    git(productSeed, ['add', '-A']);
    git(productSeed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'team']);
    git(productSeed, ['push', '-q', productOrigin, 'main']);
  } else {
    seed(teamSeed, teamFiles, teamOrigin, options.executable);
  }
  const toolLog = path.join(root, 'tool.log');
  const filterPidLog = path.join(root, 'filter-pids.log');
  const judgeLog = path.join(root, 'judge.log');
  const probeRun = path.join(root, 'probe.run');
  const probeLog = path.join(root, 'probe.log');
  const hookHome = path.join(root, 'hook-home');
  const hookMarker = path.join(root, 'hook.marker');
  fs.mkdirSync(path.join(hookHome, '.teamai', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(hookHome, '.teamai', 'bin', 'teamai'), `#!/bin/sh\necho "$*" >> '${hookMarker}'\n`);
  fs.chmodSync(path.join(hookHome, '.teamai', 'bin', 'teamai'), 0o755);
  // The check steps run `teamai benchmark check`, which resolves on PATH to the CLI under test.
  fs.writeFileSync(path.join(bin, 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const firstLaunch: Record<FirstLaunch, string> = {
    'pulls-a-team-change': `if (first) {
  const team = (...args) => execFileSync('git', args, { cwd: ${JSON.stringify(teamSeed)}, encoding: 'utf8' });
  team('pull', '-q', ${JSON.stringify(teamOrigin)}, 'main');
  for (const [file, text] of Object.entries(${JSON.stringify(options.teamChange ?? { 'later.md': 'A team change pushed during the run.\n' })})) {
    fs.mkdirSync(path.dirname(path.join(${JSON.stringify(teamSeed)}, file)), { recursive: true });
    fs.writeFileSync(path.join(${JSON.stringify(teamSeed)}, file), text);
  }
  team('add', '-A');
  team('-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'team change during the run');
  team('push', '-q', ${JSON.stringify(teamOrigin)}, 'main');
  const pulled = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'pull'], { cwd: ${JSON.stringify(work)}, encoding: 'utf8' });
  if (pulled.status !== 0) throw new Error('teamai pull failed: ' + pulled.stderr);
}`,
    'kills-its-driver': `if (first) {
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}`,
  };
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  for (const tool of options.tools ?? ['claude', 'codex']) {
    // Both print what the claude stream and the generic JSON reader each take a model and session from.
    fs.writeFileSync(path.join(bin, tool), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
${tool === 'claude' ? judgeMode(judgeLog, path.join(tmp, 'teamai-clones'), options.judge ?? 'first-label') : ''}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const first = !fs.existsSync(${JSON.stringify(toolLog)});
const filterPids = ${JSON.stringify(filterPidLog)};
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !(dir === '.' && entry.name === '.git'))
  .flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name).split(path.sep).join('/')]));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const head = git('rev-parse', 'HEAD');
const launchedWith = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
const codexEffort = process.argv.find((arg) => arg.startsWith('model_reasoning_effort='));
const effort = process.argv.includes('--effort') ? process.argv[process.argv.indexOf('--effort') + 1] : codexEffort ? codexEffort.slice('model_reasoning_effort='.length) : null;
const hooked = { ...process.env, HOME: ${JSON.stringify(hookHome)} };
spawnSync('git', ['checkout', '-q', '-b', 'hook-probe'], { env: hooked });
spawnSync('git', ['checkout', '-q', '--detach', head], { env: hooked });
spawnSync('git', ['branch', '-q', '-D', 'hook-probe']);
fs.appendFileSync(${JSON.stringify(toolLog)}, JSON.stringify({
  at: Date.now(), tool: ${JSON.stringify(tool)}, model: launchedWith, effort, cwd: process.cwd(), ownGit: fs.statSync('.git').isDirectory(), head, remotes: git('remote'),
  paths: files('.'), agentFiles: { 'AGENTS.md': read('AGENTS.md'), 'CLAUDE.md': read('CLAUDE.md') }, teamContext: read('.claude/rules/teamai-context.md'),
}) + '\\n');
${options.printsEnv ? `fs.writeFileSync(${JSON.stringify(path.join(root, 'tool.env'))}, execFileSync('sh', ['-c', 'env'], { encoding: 'utf8' }));` : ''}
${options.firstLaunch ? firstLaunch[options.firstLaunch] : ''}
${tool === 'claude' && options.loadsSkill !== undefined ? loadsSkill(options.loadsSkill) : ''}
if (fs.existsSync(${JSON.stringify(probeRun)})) {
  const run = fs.readFileSync(${JSON.stringify(probeRun)}, 'utf8');
  fs.appendFileSync(${JSON.stringify(probeLog)}, spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'workflow', 'cancel', run], { encoding: 'utf8' }).stdout);
}
${FAKE_TOOLS[options.tool]}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: launchedWith ?? 'fake-${tool}', session_id: 'fake-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', session_id: 'fake-session', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.25 }) + '\\n');
`);
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', '\tname = member', '\temail = member@example.com',
    `[url "file://${teamOrigin}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${productOrigin}"]`, `\tinsteadOf = ${PRODUCT_URL}`, '',
  ].join('\n'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', FIXTURE_ROOT: root,
  };
  for (const name of ['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GITHUB_TOKEN', 'GH_TOKEN']) delete env[name];
  const teamai = (args: string[], runEnv: NodeJS.ProcessEnv = env): Promise<CliResult> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const ok = async (args: string[], runEnv: NodeJS.ProcessEnv = env): Promise<void> => {
    const result = await teamai(args, runEnv);
    if (result.code !== 0) throw new Error(`teamai ${args.join(' ')} failed:\n${said(result)}`);
  };

  git(root, ['clone', '-q', PRODUCT_URL, work], env);
  // init . reads the team URL from origin, which git would rewrite to its file:// stand-in.
  const initEnv = options.selfMode ? { ...env, GIT_CONFIG_GLOBAL: path.join(root, 'plain.gitconfig') } : env;
  if (options.selfMode) fs.writeFileSync(path.join(root, 'plain.gitconfig'), '[user]\n\tname = member\n\temail = member@example.com\n');
  await ok(['init', options.selfMode ? '.' : TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'workspace', '--force', ...(options.role ? ['--role', options.role] : [])], initEnv);
  // init . commits the knowledge skeleton; a member pushes it, so another machine can pull the revision.
  if (options.selfMode) git(work, ['push', '-q', 'origin', 'HEAD:main'], env);
  await ok(['pull']);
  const dataHome = (): string => {
    const projects = path.join(home, '.teamai', 'projects');
    const found = fs.readdirSync(projects).map((name) => path.join(projects, name))
      .find((dir) => fs.existsSync(path.join(dir, 'config.yaml')) && fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8').includes(`projectRoot: ${work}`));
    if (!found) throw new Error(`no workspace data home for ${work} under ${projects}`);
    return found;
  };
  const configPath = path.join(dataHome(), 'config.yaml');
  const config: unknown = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  const parsed = z.object({ repo: z.object({ localPath: z.string() }).passthrough(), workflows: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(config);
  fs.writeFileSync(configPath, YAML.stringify({ ...parsed, workflows: { ...parsed.workflows, sandbox: options.sandbox, ...(options.maxParallel !== undefined ? { max_parallel: options.maxParallel } : {}) } }));

  return {
    root, home, work, bin, env, teamOrigin, productOrigin, tmp, teamClone: parsed.repo.localPath, startingCommit, teamai,
    runFile: (run) => {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dataHome(), 'workflows', 'runs', `${run}.json`), 'utf8'));
      return value;
    },
    pushTeam: (files) => {
      git(teamSeed, ['pull', '-q', teamOrigin, 'main']);
      for (const [file, text] of Object.entries(files)) {
        if (text === null) fs.rmSync(path.join(teamSeed, file), { recursive: true, force: true });
        else writeFiles(teamSeed, { [file]: text });
      }
      git(teamSeed, ['add', '-A']);
      git(teamSeed, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'team change']);
      git(teamSeed, ['push', '-q', teamOrigin, 'main']);
    },
    pushProduct: (files) => {
      writeFiles(productSeed, files);
      git(productSeed, ['add', '-A']);
      git(productSeed, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'product change']);
      git(productSeed, ['push', '-q', productOrigin, 'main']);
      return git(productSeed, ['rev-parse', 'HEAD']);
    },
    runIds: () => {
      const runs = path.join(dataHome(), 'workflows', 'runs');
      return fs.existsSync(runs) ? fs.readdirSync(runs).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)) : [];
    },
    status: () => git(work, ['status', '--porcelain']),
    endRecord: (run) => {
      const value: unknown = JSON.parse(git(root, ['--git-dir', teamOrigin, 'show', `teamai-reports:workflows/runs/${run}.json`]));
      return value;
    },
    benchmarkRecord: (run) => {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dataHome(), 'workflows', 'runs', run, 'benchmark.json'), 'utf8'));
      return value;
    },
    reportedBenchmark: (run) => {
      const value: unknown = JSON.parse(git(root, ['--git-dir', teamOrigin, 'show', `teamai-reports:benchmarks/runs/${run}.json`]));
      return value;
    },
    filterPids: () => (fs.existsSync(filterPidLog) ? fs.readFileSync(filterPidLog, 'utf8').trim().split('\n').map(Number) : []),
    toolLaunches: () => (fs.existsSync(toolLog) ? fs.readFileSync(toolLog, 'utf8').trim().split('\n').map((line) => ToolLaunchSchema.parse(JSON.parse(line))) : []),
    judgeLaunches: () => (fs.existsSync(judgeLog) ? fs.readFileSync(judgeLog, 'utf8').trim().split('\n').map((line) => JudgeLaunchSchema.parse(JSON.parse(line))) : []),
    trialRootEntries: () => (fs.existsSync(path.join(tmp, 'teamai-clones')) ? fs.readdirSync(path.join(tmp, 'teamai-clones')) : []),
    hookCalls: () => (fs.existsSync(hookMarker) ? fs.readFileSync(hookMarker, 'utf8').trim().split('\n') : []),
    probeControl: (run) => fs.writeFileSync(probeRun, run),
    probeAnswers: () => (fs.existsSync(probeLog) ? fs.readFileSync(probeLog, 'utf8').trim().split('\n').map((line) => EnvelopeSchema.parse(JSON.parse(line))) : []),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** The start of the fake `claude`: its version, which has a verified judge profile, and, launched as a judge, its answer. */
function judgeMode(log: string, trialRoots: string, judge: FakeJudge): string {
  return `if (process.argv.includes('--version')) {
  console.log('2.1.308 (Claude Code)');
  process.exit(0);
}
if (process.argv.includes('--json-schema')) {
  const labels = JSON.parse(process.argv[process.argv.indexOf('--json-schema') + 1]).properties.label.enum;
  const diff = fs.existsSync('diff.patch') ? fs.readFileSync('diff.patch', 'utf8') : null;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ labels, diff, trialRoots: fs.existsSync(${JSON.stringify(trialRoots)}) ? fs.readdirSync(${JSON.stringify(trialRoots)}) : [] }) + '\\n');
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (${JSON.stringify(judge)} === 'hangs') { setInterval(() => {}, 1000); return; }
    if (${JSON.stringify(judge)} === 'fails') process.exit(1);
    const label = ${JSON.stringify(judge)} === 'another-label' ? 'no-such-label' : ${JSON.stringify(judge)} === 'incorrect' && labels.includes('incorrect') ? 'incorrect' : labels[0];
    console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-judge' }));
    console.log(JSON.stringify({ type: 'result', structured_output: { label, reasoning: 'The fake judge decided.' }, total_cost_usd: 0.1 }));
  });
  return;
}`;
}

/** The commits a run made in process starts from. No repo holds them, so nothing may fetch them. */
export const RUN_START = 'a'.repeat(40);
export const RUN_TEAM = 'b'.repeat(40);

/**
 * A member of a git team, as a trial needs, with nothing on disk but what a run writes under `root`. It publishes no
 * records: its remote is a real URL, so publishing would reach the network, where a credential helper can outlive the
 * test and, on Windows, keep `root` from being removed.
 */
export function benchmarkRunConfig(root: string): LocalConfig {
  return {
    repo: { localPath: path.join(root, 'team'), remote: TEAM_URL, kind: 'git' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'), usageReportEnabled: false,
  };
}

/**
 * The plan of the suite in `files`, frozen in process as startBenchmark freezes it, at team commit RUN_TEAM and with
 * RUN_START for `{{startingCommit}}`, without the install startBenchmark reads the suite and the team revision from. An
 * arm's model is planned as written: no aliases resolve it.
 */
export async function frozenBenchmark(config: LocalConfig, files: BenchmarkSuiteFiles): Promise<{ plan: BenchmarkPlan; committed: CommittedSuite } | WorkflowEnvelope> {
  const parsed = parseSuite({
    suite: { relativePath: `benchmarks/${files.name}/suite.yaml`, content: files.suite },
    tasks: Object.entries(files.tasks).map(([name, content]) => ({
      relativePath: `benchmarks/${files.name}/tasks/${name}.yaml`, content: content.replaceAll('{{startingCommit}}', RUN_START),
    })),
  });
  if (!parsed.ok) return error('benchmark_not_found', parsed.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
  const { suite } = parsed;
  // Every team an arm names resolves to RUN_TEAM, as start would resolve it in a team repo at that revision.
  const resolved = (team: TeamChoice): ArmTeam => (team.kind === 'none' ? team : { ...team, revision: RUN_TEAM });
  const [first, ...rest] = suite.arms.map((arm) => ({ name: arm.name, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), source: 'team' as const, team: resolved(arm.team) }));
  const committed = await commitCheckFiles(commitCacheOf(config, suite.repo), suite);
  if (!committed.ok) return error('check_files_unwritable', committed.failed);
  const plan = freezePlan({ committed: committed.suite, baselineTeamRevision: RUN_TEAM, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, arms: [first, ...rest], scorers: {} });
  return { plan, committed: committed.suite };
}

/** The shipped benchmark workflow's plan and trials steps, without its report, which no process here can run. */
export const PLANNED_BENCHMARK = `schemaVersion: v1alpha1
name: planned
description: Plan a benchmark, then run it.
steps:
  - id: plan
    command: teamai benchmark plan fix
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
    requires: { isolation: sandbox, strict: true }
`;

const PlanLeaseSchema = z.object({ data: z.object({ lease: z.object({ attempt: z.string(), revision: z.number(), command: z.string() }) }) });
const PLANNER: DriverIdentity = { kind: 'local', machine: 'planner', workspace: '/plan' };

/**
 * A run of `body`, the planned benchmark workflow by default, bounded by the suite's timeout, made in process: each
 * command step a driver that opens no clone can take printed the bundle `compileBundle` makes of the suite in `files`,
 * its prompts `unattended` when asked,
 * frozen as `frozenBenchmark` freezes it, with its plan, or what `outputsOf` makes of them. The trials wait for a driver.
 */
export async function startBenchmarkRun(config: LocalConfig, files: BenchmarkSuiteFiles, { body = PLANNED_BENCHMARK, outputsOf, unattended = false }: {
  body?: string; outputsOf?: (bundle: ReturnType<typeof compileBundle>, plan: BenchmarkPlan) => unknown; unattended?: boolean;
} = {}): Promise<WorkflowEnvelope> {
  const frozen = await frozenBenchmark(config, files);
  if (!('plan' in frozen)) return frozen;
  const bundle = compileBundle(frozen.plan, frozen.committed, { unattended });
  fs.mkdirSync(path.join(config.repo.localPath, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'planned.yaml'), body);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'planned', {}, { secrets: {}, timeout: frozen.committed.suite.timeoutMs });
  if ('error' in started) return started;
  const runId = String(started.data.run);
  // As the step prints them, JSON on its stdout, without the team revision, which this config has no team repo to pin at.
  const outputs: unknown = JSON.parse(JSON.stringify(outputsOf ? outputsOf(bundle, frozen.plan) : { definition: { ...bundle, workflows: {} }, plan: frozen.plan }));
  for (let leased = PlanLeaseSchema.safeParse(await leaseNext(config, runId, PLANNER)); leased.success; leased = PlanLeaseSchema.safeParse(await leaseNext(config, runId, PLANNER))) {
    const { attempt, revision } = leased.data.data.lease;
    await reportAttempt(config, runId, { attempt, revision, outcome: 'success', driver: PLANNER, outputs });
  }
  return started;
}

/**
 * The benchmark record of run `run` of suite `fix`, as `teamai benchmark report` writes it: one trial of task `fix` on
 * each arm of `tools`, each on team revision `team`, every one `result`.
 */
export function fixRecord(run: string, { startedAt, username, result = 'passed', team = RUN_TEAM, tools = ['claude'] }: {
  startedAt: string; username?: string; result?: TrialResult; team?: string; tools?: string[];
}): BenchmarkRunRecord {
  return {
    schemaVersion: 1, run, outcome: 'succeeded', teamaiVersion: '0.0.0', startedAt, finishedAt: startedAt, ...(username ? { username } : {}),
    workflow: { name: 'teamai-benchmark', origin: { source: 'team' }, sourceHash: 'f'.repeat(64) },
    suite: { name: 'fix', sourceHash: 's1' }, repetitions: 1, baselineTeamRevision: team, scorers: [],
    tasks: [{ id: 'fix', startingCommit: RUN_START, sourceHash: 't1', baseline: 'valid' }],
    arms: tools.map((tool) => ({ name: tool, tool, source: 'team', team: { kind: 'pulled', revision: team } })),
    trials: tools.map((tool, index) => ({ task: 'fix', arm: tool, repetition: 1, order: index + 1, step: `trials.r1.fix.${tool}.prompt`, result })),
  };
}

const BaselineLeaseSchema = z.object({ data: z.object({ lease: z.object({ step: z.string().startsWith('trials.baselines.'), attempt: z.string(), revision: z.number() }) }) });

/**
 * Settles each baseline of a run made in process as `teamai benchmark check --baseline` settles one: by its task in
 * `baselines`, with the result it outputs, and `failed` by default, as a check that fails on its starting commit, so
 * that task's trials run.
 */
export async function settleBaselines(
  config: LocalConfig, runId: string, driver: DriverIdentity, can: DriverCan, baselines: Record<string, 'passed' | 'failed' | 'could_not_run'> = {},
): Promise<void> {
  const run = await readRun(config, runId);
  const planned = typeof run === 'object' ? planOfRun(run) : undefined;
  const count = planned && 'found' in planned ? planned.found.plan.tasks.filter((task) => task.judge.kind === 'check').length : 0;
  for (let settled = 0; settled < count; settled += 1) {
    const { attempt, revision, step } = BaselineLeaseSchema.parse(await leaseNext(config, runId, driver, { can, prepare: true })).data.lease;
    const result = baselines[step.slice('trials.baselines.'.length)] ?? 'failed';
    await reportAttempt(config, runId, { attempt, revision, driver, outcome: 'success', exitCode: 0, outputs: { result } });
  }
}

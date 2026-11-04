/**
 * Real CLI: a Claude Code session that fixed a bug keeps it as a benchmark task with teamai's default
 * teamai-session-to-task, driving the run with the skill driver as the session's agent does. Its SessionStart hook
 * records the commit it started at; describe proposes that commit, the solution at HEAD and the suite; the draft step writes
 * the task file and names its id; the propose step copies it into a fresh clone of the team repo, on the task's own
 * branch, and the run opens the pull request on the fake gh. Then the team repo's CI job from the benchmarks guide tries
 * the task on that pull request's branch.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const SESSION = '7c1e0000-0000-4000-8000-000000001402';
const TEAM_URL = 'https://github.com/acme/team.git';
const PRODUCT_URL = 'https://github.com/acme/auth-service.git';
const TEST = "require('node:assert').strictEqual(require('../answer.js'), 42);\n";

const EnvelopeSchema = z.object({ data: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const InputSchema = z.object({ name: z.string(), value: z.unknown().optional(), why: z.string().optional() }).passthrough();
const DescribeSchema = z.object({ describe: z.object({ ask: z.object({ question: z.object({ inputs: z.array(InputSchema), options: z.array(z.object({ start: z.string() })).nonempty() }) }) }) });
const ActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choose'), about: z.enum(['host', 'gate']), options: z.array(z.object({ run: z.string(), id: z.string().optional(), choice: z.string().optional() })) }),
  z.object({ kind: z.literal('dispatch'), step: z.string(), brief: z.string(), ack: z.string(), report: z.string() }),
  z.object({ kind: z.literal('done'), outcome: z.string(), prs: z.array(z.string()) }),
]);
const TurnSchema = z.object({
  run: z.string(), actions: z.array(ActionSchema),
  // oxlint-disable-next-line unicorn/no-thenable -- a workflow turn names its next step `then`; it is data, not a promise method
  then: z.object({ run: z.string() }).optional(),
});

interface Member {
  root: string;
  work: string;
  teamOrigin: string;
  env: NodeJS.ProcessEnv;
  gh: FakeGh;
}

const roots: string[] = [];
afterEach(async () => {
  await waitForDetachedChildren();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

function teamai(member: Member, args: string[], options: { session?: boolean; input?: string } = {}): { code: number | null; stdout: string; stderr: string } {
  const env = options.session ? { ...member.env, CLAUDE_CODE_SESSION_ID: SESSION } : member.env;
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: member.work, env, encoding: 'utf8', timeout: 120_000, input: options.input });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The words of a literal the CLI printed, `teamai …`, whose single-quoted words hold no space. */
function wordsOf(literal: string): string[] {
  const [command, ...words] = literal.split(' ');
  expect(command, literal).toBe('teamai');
  return words.map((word) => (word.length > 1 && word.startsWith('\'') && word.endsWith('\'') ? word.slice(1, -1) : word));
}

/** Runs a literal the CLI printed, as the session's agent runs it: its envelope, which must carry data. */
function agentRuns(member: Member, literal: string): Record<string, unknown> {
  const result = teamai(member, wordsOf(literal), { session: true });
  const line = result.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  const answer = line === undefined ? {} : EnvelopeSchema.parse(JSON.parse(line));
  if (answer.data === undefined) throw new Error(`${literal}\nexit ${result.code}\n${result.stdout}\n${result.stderr}`);
  return answer.data;
}

/**
 * A member's checkout of acme/auth-service at the commit where node test/refresh.test.js would fail, in a workspace of
 * the team acme, whose repo has the suite benchmarks/fix-auth for that project. teamai and a fake gh are on PATH.
 */
function newMember(): Member {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-to-task-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const work = path.join(home, 'work');
  const teamOrigin = path.join(root, 'team.git');
  const productOrigin = path.join(root, 'app.git');
  for (const dir of [home, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const gh = fakeGhHost(path.join(root, 'gh'));
  fs.symlinkSync(gh.bin, path.join(bin, 'gh'));
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', '\tname = member', '\temail = member@example.com',
    `[url "file://${teamOrigin}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${productOrigin}"]`, `\tinsteadOf = ${PRODUCT_URL}`, '',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: [bin, process.env.PATH ?? ''].join(path.delimiter), GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', TEAMAI_MODE: 'attended',
  };
  for (const name of ['XDG_CONFIG_HOME', 'GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'CI', 'TEAMAI_WORKFLOW_ATTEMPT', 'TEAMAI_LAUNCHED_BY']) delete env[name];
  for (const [origin, seedName, files] of [
    [productOrigin, 'seed-app', { 'answer.js': 'module.exports = 41;\n', 'README.md': '# auth-service\n' }],
    [teamOrigin, 'seed-team', {
      'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\nusageReport: false\n`,
      'benchmarks/fix-auth/suite.yaml': `schemaVersion: v1alpha1\nname: fix-auth\nrepo: ${PRODUCT_URL}\ndefaults: { tool: claude }\narms: [{ name: main }]\ntimeout: 30m\n`,
      'benchmarks/fix-auth/tasks/existing.yaml': `schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Make it pass.\nstartingCommit: ${'a'.repeat(40)}\nsuccessCriteria: It passes.\n`,
    }],
  ] as const) {
    const seed = path.join(root, seedName);
    write(seed, files);
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(seed, ['init', '-q', '-b', 'main']);
    git(seed, ['add', '-A']);
    git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
    git(seed, ['push', '-q', origin, 'main']);
  }
  git(root, ['clone', '-q', PRODUCT_URL, work], env);
  fs.mkdirSync(path.join(work, '.claude'));
  const clone = path.join(work, '.teamai', 'team-repo');
  git(root, ['clone', '-q', TEAM_URL, clone], env);
  write(work, {
    '.teamai/config.yaml': YAML.stringify({
      repo: { localPath: clone, remote: TEAM_URL, kind: 'git' },
      username: 'member', scope: 'project', projectRoot: work, updatePolicy: 'skip', additionalRoles: [], enabledAgents: ['claude'],
    }),
  });
  const result = { root, work, teamOrigin, env, gh };
  const pulled = teamai(result, ['pull']);
  expect(pulled.code, `${pulled.stdout}${pulled.stderr}`).toBe(0);
  return result;
}

/** The value describe proposes for `name`, which must have one. */
function proposed(inputs: Array<z.infer<typeof InputSchema>>, name: string): string {
  const value = inputs.find((input) => input.name === name)?.value;
  if (typeof value !== 'string') throw new Error(`describe proposed no ${name}: ${JSON.stringify(inputs)}`);
  return value;
}

type Done = Extract<z.infer<typeof ActionSchema>, { kind: 'done' }>;

const StepSchema = z.object({ id: z.string(), status: z.string(), message: z.string().optional(), failure: z.object({ code: z.string(), message: z.string() }).optional() });
const RunFileSchema = z.object({ steps: z.array(StepSchema) });

/** Step `step` of run `run`, from its run file in the member's data home. */
function stepOf(m: Member, run: string, step: string): z.infer<typeof StepSchema> | undefined {
  const file = fs.readdirSync(path.join(m.root, 'home'), { recursive: true, encoding: 'utf8' }).find((entry) => entry.endsWith(path.join('workflows', 'runs', `${run}.json`)));
  if (file === undefined) throw new Error(`no run file for ${run}`);
  return RunFileSchema.parse(JSON.parse(fs.readFileSync(path.join(m.root, 'home', file), 'utf8'))).steps.find((one) => one.id === step);
}

/**
 * Drives teamai-session-to-task on `inputs` from the start literal describe gave, as the session's agent does: it picks h1,
 * answers every gate yes, and drafts `task` as the file of task `id`. The end the run reached, and the choices each gate asked.
 */
function sessionToTask(m: Member, start: string, inputs: Record<string, string>, draft: { task: string; id: string }): { run: string; done: Done; asked: string[] } {
  const taskFile = path.join(m.root, `${draft.id.replaceAll('/', '-')}.yaml`);
  let turn = TurnSchema.parse(agentRuns(m, start.replace('{inputs}', JSON.stringify(inputs))).turn);
  const asked: string[] = [];
  for (let call = 0; call < 30; call += 1) {
    const [action] = turn.actions;
    if (action?.kind === 'done') return { run: turn.run, done: action, asked };
    if (action?.kind === 'choose') {
      if (action.about === 'gate') asked.push(action.options.map((option) => option.choice).join('/'));
      const picked = action.options.find((option) => (action.about === 'host' ? option.id === 'h1' : option.choice === 'yes'));
      if (picked === undefined) throw new Error(`no option to pick in ${JSON.stringify(action)}`);
      turn = TurnSchema.parse(agentRuns(m, picked.run).turn);
      continue;
    }
    if (action?.kind === 'dispatch') {
      expect(action.step).toBe('draft');
      turn = TurnSchema.parse(agentRuns(m, action.ack).turn);
      const brief = fs.readFileSync(action.brief, 'utf8');
      expect(brief).toContain(`The task starts at commit ${inputs.start}; the solution, the commit that completes it, is ${inputs.solution}`);
      fs.writeFileSync(taskFile, draft.task);
      const result = /Write `([^`]+result\.json)`/.exec(brief)?.[1];
      if (result === undefined) throw new Error(`the brief names no result file:\n${brief}`);
      fs.writeFileSync(result, JSON.stringify({ kind: 'output', output: { verdict: 'draft', file: taskFile, id: draft.id } }));
      expect(agentRuns(m, action.report)).toMatchObject({ runner: { status: 'reported' } });
    }
    if (turn.then === undefined) throw new Error(`the run ended with no done action: ${JSON.stringify(turn)}`);
    turn = TurnSchema.parse(agentRuns(m, turn.then.run).turn);
  }
  throw new Error('the run did not end in 30 calls');
}

/** A member whose session fixed the bug: describe's inputs for teamai-session-to-task and its start literal. */
function fixedSession(m: Member): { inputs: Record<string, string>; start: string } {
  const start = git(m.work, ['rev-parse', 'HEAD']);
  // The session starts: Claude Code runs teamai's SessionStart hook, which records the commit.
  const hooked = teamai(m, ['hook-dispatch', 'session-start', '--tool', 'claude'], { input: JSON.stringify({ session_id: SESSION, cwd: m.work, hook_event_name: 'SessionStart', source: 'startup' }) });
  expect(hooked.code, hooked.stderr).toBe(0);
  // The agent fixes the bug with its test, and the person commits it.
  write(m.work, { 'answer.js': 'module.exports = 42;\n', 'test/refresh.test.js': TEST });
  git(m.work, ['add', 'answer.js', 'test/refresh.test.js'], m.env);
  git(m.work, ['commit', '-qm', 'reject reused refresh tokens'], m.env);
  git(m.work, ['push', '-q', 'origin', 'HEAD:main'], m.env);
  const solution = git(m.work, ['rev-parse', 'HEAD']);

  const described = DescribeSchema.parse(agentRuns(m, 'teamai workflow start --describe teamai-session-to-task --driver skill')).describe.ask.question;
  const inputs = Object.fromEntries(['session', 'source', 'suite', 'start', 'solution'].map((name) => [name, proposed(described.inputs, name)]));
  expect(inputs).toEqual({ session: SESSION, source: 'claude-code', suite: 'benchmarks/fix-auth', start, solution });
  return { inputs, start: described.options[0].start };
}

/** The session's task, drafted with the person: the solution's test is hidden in check.add. */
const refreshRace = (inputs: Record<string, string>, title = 'Reused refresh tokens are accepted'): string => `schemaVersion: v1alpha1
title: ${title}
prompt: A refresh token that was already used still gets new tokens. Reject it.
startingCommit: ${inputs.start}
solutionCommit: ${inputs.solution}
check:
  run: node test/refresh.test.js
  protect: ['test/**']
  add: ['test/refresh.test.js']
source: { platform: claude-code, sessionId: ${SESSION} }
`;

const BRANCH = 'teamai/session-to-task/benchmarks/fix-auth/refresh-race';

// Each case runs about thirty CLI calls per run, with a pull, a clone and a push, so it gets 240 s, not the default 60 s.
describe('teamai-session-to-task from a Claude Code session', () => {
  it('keeps the fix as a task in a pull request named for it, updates that pull request when the task is drafted again, and the team repo CI job passes on it', async () => {
    const m = newMember();
    const { inputs, start } = fixedSession(m);

    const first = sessionToTask(m, start, inputs, { task: refreshRace(inputs), id: 'refresh-race' });

    expect(first.done, JSON.stringify(first.done)).toMatchObject({ outcome: 'succeeded', prs: ['https://github.com/acme/team/pull/1'] });
    expect(first.asked).toEqual(['yes/no']);
    expect(git(m.teamOrigin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/'])).toBe(BRANCH);
    expect(git(m.teamOrigin, ['diff', '--name-only', 'main', BRANCH])).toBe('benchmarks/fix-auth/tasks/refresh-race.yaml');
    const created = m.gh.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'create');
    expect(created.map((call) => call.args[call.args.indexOf('-t') + 1])).toEqual(['teamai-session-to-task: benchmarks/fix-auth/tasks/refresh-race.yaml']);

    // Drafted again with a better title, the same task goes on its branch and pull request.
    const again = sessionToTask(m, start, inputs, { task: refreshRace(inputs, 'A reused refresh token gets new tokens'), id: 'refresh-race' });

    expect(again.done, JSON.stringify(again.done)).toMatchObject({ outcome: 'succeeded', prs: ['https://github.com/acme/team/pull/1'] });
    expect(m.gh.pulls().map((pull) => pull.head)).toEqual([BRANCH]);
    expect(m.gh.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'create')).toHaveLength(1);
    expect(git(m.teamOrigin, ['show', `${BRANCH}:benchmarks/fix-auth/tasks/refresh-race.yaml`])).toContain('title: A reused refresh token gets new tokens');

    // The team repo's CI job on that pull request: the guide's step, in a checkout of the project beside the team repo.
    const ci = path.join(m.root, 'ci');
    git(m.root, ['clone', '-q', TEAM_URL, path.join(ci, 'team')], m.env);
    git(path.join(ci, 'team'), ['checkout', '-q', BRANCH], m.env);
    git(m.root, ['clone', '-q', PRODUCT_URL, path.join(ci, 'project')], m.env);
    const guide = fs.readFileSync(path.join(ROOT, 'docs', 'guide', 'benchmarks.md'), 'utf8');
    const block = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map(([, body]) => body ?? '').find((body) => body.startsWith('# .github/workflows/benchmark-tasks.yml in the team repo'));
    const step = z.object({ jobs: z.object({ try: z.object({ steps: z.array(z.object({ run: z.string().optional() }).passthrough()) }) }) }).parse(YAML.parse(block ?? '')).jobs.try.steps.find((one) => one.run?.includes('teamai benchmark try'));
    const job = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step?.run ?? 'exit 9'], { cwd: path.join(ci, 'project'), env: { ...m.env, BASE_REF: 'main' }, encoding: 'utf8', timeout: 120_000 });
    expect(job.status, `${job.stdout}${job.stderr}`).toBe(0);
    expect(`${job.stdout}${job.stderr}`).toContain(`the check fails at ${inputs.start.slice(0, 7)} and passes at the solution ${inputs.solution.slice(0, 7)}`);
  }, 360_000);

  it('opens no pull request for a task main already holds, and refuses a task id or suite that is no task path, and a suite with no suite.yaml', async () => {
    const m = newMember();
    const { inputs, start } = fixedSession(m);
    const existing = git(m.teamOrigin, ['show', 'main:benchmarks/fix-auth/tasks/existing.yaml']);
    const branches = (): string => git(m.teamOrigin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/']);

    const same = sessionToTask(m, start, inputs, { task: `${existing}\n`, id: 'existing' });

    expect(same.done, JSON.stringify(same.done)).toMatchObject({ outcome: 'succeeded', prs: [] });
    expect(branches()).toBe('');

    const id = sessionToTask(m, start, inputs, { task: refreshRace(inputs), id: '../../escape' });

    expect(id.asked).toEqual([]);
    expect(stepOf(m, id.run, 'check')?.message).toContain('Task id "../../escape" is not a task file name: use letters, digits, - and _, starting with a letter or digit.');

    const suite = sessionToTask(m, start, { ...inputs, suite: 'benchmarks/../../escape' }, { task: refreshRace(inputs), id: 'refresh-race' });

    expect(suite.asked).toEqual([]);
    expect(stepOf(m, suite.run, 'check')?.message).toContain('Suite "benchmarks/../../escape" is not a suite directory: give benchmarks/<suite> or benchmarks/<namespace>/<suite>');

    const missing = sessionToTask(m, start, { ...inputs, suite: 'benchmarks/missing' }, { task: refreshRace(inputs), id: 'refresh-race' });

    expect(stepOf(m, missing.run, 'propose')?.failure).toMatchObject({ code: 'push_failed', message: expect.stringContaining('benchmarks/missing/tasks/refresh-race.yaml: in no suite teamai pull reads') });
    expect(branches()).toBe('');
    expect(m.gh.pulls()).toEqual([]);
  }, 360_000);
});

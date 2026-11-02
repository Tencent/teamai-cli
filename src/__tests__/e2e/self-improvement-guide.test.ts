/**
 * Real CLI: the self-improvement loop in docs/guide/self-improvement.md, run the way GitHub Actions runs its two jobs,
 * with teamai's default workflow teamai-self-improvement. The test reads the guide's files by the path each block names,
 * puts the suite in the team repo, and runs each job's steps with bash under a runner HOME of its own: `actions/checkout` clones the repository it names (the team repo
 * when it names none) with every commit, `npx teamai-cli` is the built CLI, and `gh` is a fake that keeps the pull
 * requests. Failing labels a judge gave sessions sit on teamai-reports, each with the commit its session started at.
 *
 * The fake `claude`, prompted to improve the harness, appends a marker to the team's review skill and writes one regression task per
 * failure it is given; in a benchmark trial, either tool fixes the task when the delivered team files hold the marker.
 * So the `main` arms fail every regression task and the `pulled` arms pass them. The only change the test makes to the
 * guide's files is one repetition instead of three, to keep the run short.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { benchmarkFixture, PRODUCT_URL, TEAM_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const GUIDE = path.join(ROOT, 'docs', 'guide', 'self-improvement.md');
const BRANCH = 'teamai/self-improvement/review-quality';
const MARKER = 'Name every removed null check as a bug.';
const SCORER = `---
labels:
  - { value: good, score: 1, description: Found the bug the change brought in }
  - { value: missed-bug, score: 0, description: Approved a change with a bug }
passingScore: 1
samplingRate: 0
---
Judge whether the review caught the bug in the change.
`;
const SKILL = '---\nname: review\ndescription: Review a change.\n---\nRead the diff and report every bug.\n';

const JobSchema = z.object({
  env: z.record(z.string(), z.string()).default({}),
  steps: z.array(z.object({
    uses: z.string().optional(),
    with: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    'working-directory': z.string().optional(),
  })),
});
type Job = z.infer<typeof JobSchema>;

interface Ran {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Each fenced block of the guide that starts with `# <path>`, by that path. */
function guideFiles(): Record<string, string> {
  const text = fs.readFileSync(GUIDE, 'utf8');
  return Object.fromEntries([...text.matchAll(/^```yaml\n# (\S+)[^\n]*\n([\s\S]*?)^```/gm)].map((match) => [match[1] ?? '', match[2] ?? '']));
}

/** The guide's file `name`, which it must show. */
function guideFile(name: string): string {
  const body = guideFiles()[name];
  if (body === undefined) throw new Error(`${GUIDE} shows no ${name}`);
  return body;
}

/** The one job of the GitHub Actions workflow the guide shows as `name`. */
function guideJob(name: string): Job {
  const workflow = z.object({ jobs: z.record(z.string(), z.unknown()) }).parse(parseDocument(guideFile(name)).toJS());
  const [job, ...more] = Object.values(workflow.jobs);
  if (job === undefined || more.length > 0) throw new Error(`${name} has more than one job`);
  return JobSchema.parse(job);
}

function said(ran: readonly Ran[]): string {
  return ran.map((step) => `$ ${step.command}\nexit ${step.status}\n${step.stdout}\n${step.stderr}`).join('\n');
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/**
 * The fake `<tool>`: improves when prompted to, else fixes a trial's task once the team files it got hold the marker.
 * While it improves, it runs the script at `during` once if there is one, as a teammate acting in the meantime.
 */
function fakeTool(tool: string, improveLog: string, during: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const said = process.argv.slice(2).join('\\n');
if (said.includes("Improve the team's harness")) {
  const team = process.cwd();
  const suite = /write (\\S+)\\/tasks\\/<id>\\.yaml/.exec(said)[1];
  const failures = JSON.parse(/Failures to fix, newest first: (.*)$/m.exec(said)[1]);
  fs.appendFileSync(${JSON.stringify(improveLog)}, JSON.stringify({ cwd: process.cwd(), failures }) + '\\n');
  if (fs.existsSync(${JSON.stringify(during)})) {
    spawnSync('sh', [${JSON.stringify(during)}], { stdio: 'inherit' });
    fs.rmSync(${JSON.stringify(during)});
  }
  const skill = path.join(team, 'skills', 'review', 'SKILL.md');
  if (!fs.readFileSync(skill, 'utf8').includes(${JSON.stringify(MARKER)})) fs.appendFileSync(skill, ${JSON.stringify(`${MARKER}\n`)});
  for (const { failure, start } of failures) {
    const id = 'missed-null-check-' + failure.subject.sessionId;
    fs.mkdirSync(path.join(team, suite, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(team, suite, 'tasks', id + '.yaml'), [
      'schemaVersion: v1alpha1', 'title: Review approves a change that drops a null check', 'prompt: Make node test.js pass.',
      'startingCommit: ' + start.commit, 'check:', '  run: node test.js', '  protect: [test.js]', 'source: ' + JSON.stringify(failure.subject), '',
    ].join('\\n'));
  }
  fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { verdict: 'proposed' } }));
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-${tool}', session_id: 'improve-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', session_id: 'improve-session', usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.25 }) + '\\n');
  process.exit(0);
}
const holds = (dir) => fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.name !== '.git' && entry.name !== 'node_modules'
  && (entry.isDirectory() ? holds(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8').includes(${JSON.stringify(MARKER)})));
if (!process.argv.includes('--json-schema') && !process.argv.includes('--version') && holds('.')) fs.writeFileSync('answer.js', 'module.exports = 42;\\n');
const ran = spawnSync(path.join(__dirname, '${tool}.fixture'), process.argv.slice(2), { stdio: 'inherit' });
process.exit(ran.status ?? 1);
`;
}

describe.skipIf(spawnSync('jq', ['--version']).status !== 0)('the self-improvement loop in its guide, run through the real CLI', () => {
  let fixture: BenchmarkFixture;
  let gh: FakeGh;
  let improveLog: string;
  let runners = 0;
  const startedAt = new Date().toISOString();

  /** The failing label a model judge gave the session `sessionId`, which started at `start`, dirty or not. */
  const failing = (sessionId: string, start: { commit: string; dirty: boolean }) => ({
    scorer: 'review-quality', rubric: { sourceHash: 'rubric-1' }, label: 'missed-bug', score: 0, passed: false,
    judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-opus-5-5' }, isolation: 'verified', access: 'read' },
    source: 'session', subject: { platform: 'claude-code', sessionId }, runMode: 'attended', scoredAt: startedAt,
    agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local', project: start },
  });

  /** Adds `labels` to teamai-reports on the team origin, as a teammate's `score --push` does. */
  const publishLabels = (author: string, labels: unknown[]): void => {
    const reports = fs.mkdtempSync(path.join(fixture.root, 'reports-'));
    git(reports, ['init', '-q', '-b', 'teamai-reports']);
    if (spawnSync('git', ['fetch', '-q', fixture.teamOrigin, 'teamai-reports'], { cwd: reports }).status === 0) git(reports, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    const file = path.join(reports, 'scores', author, `${startedAt.slice(0, 7)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, labels.map((label) => `${JSON.stringify(label)}\n`).join(''));
    git(reports, ['add', '-A']);
    git(reports, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-qm', 'labels']);
    git(reports, ['push', '-q', fixture.teamOrigin, 'HEAD:refs/heads/teamai-reports']);
  };

  /** Runs `job` on a fresh runner, with `expressions` for the Actions expressions it uses. */
  const runJob = (job: Job, expressions: Record<string, string>): Ran[] => {
    const runner = path.join(fixture.root, `runner-${++runners}`);
    const workspace = path.join(runner, 'work');
    fs.mkdirSync(workspace, { recursive: true });
    const expand = (text: string): string => text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => {
      const value = expressions[expression];
      if (value === undefined) throw new Error(`the job uses \${{ ${expression} }}, which the test does not fill in`);
      return value;
    });
    const env: NodeJS.ProcessEnv = {
      ...fixture.env, HOME: runner, USERPROFILE: runner, CI: 'true', GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: 'acme/team',
      ...Object.fromEntries(Object.entries(job.env).map(([name, value]) => [name, expand(value)])),
    };
    const ran: Ran[] = [];
    for (const step of job.steps) {
      if (ran.some((before) => before.status !== 0) && !step.if?.includes('always()')) continue;
      if (step.uses?.startsWith('actions/setup-node@')) continue;
      if (step.uses?.startsWith('actions/checkout@')) {
        const repository = step.with?.repository ?? 'acme/team';
        const into = path.join(workspace, String(step.with?.path ?? ''));
        execFileSync('git', ['clone', '-q', `https://github.com/${repository}.git`, into], { env, stdio: 'pipe' });
        continue;
      }
      if (step.uses !== undefined) throw new Error(`the job uses ${step.uses}, which the test does not run`);
      if (step.run === undefined) continue;
      const cwd = path.join(workspace, step['working-directory'] ?? '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', expand(step.run)], { cwd, env, encoding: 'utf8', timeout: 240_000 });
      ran.push({ command: step.run, status: result.status, stdout: result.stdout, stderr: result.stderr });
    }
    return ran;
  };

  const improve = (): Ran[] => runJob(guideJob('.github/workflows/self-improvement.yml'), {
    'vars.TEAM_REPO': TEAM_URL, 'secrets.TEAM_TOKEN': 'fixture-team-token', 'secrets.ANTHROPIC_API_KEY': 'fixture-anthropic-key',
    'secrets.PROJECT_READ_TOKEN': 'fixture-project-token', "inputs.scorer || 'review-quality'": 'review-quality',
  });

  const prove = (pull: number): Ran[] => runJob(guideJob('.github/workflows/regressions.yml'), {
    'vars.TEAM_REPO': TEAM_URL, 'secrets.ANTHROPIC_API_KEY': 'fixture-anthropic-key',
    'secrets.OPENAI_API_KEY': 'fixture-openai-key', 'secrets.PROJECT_READ_TOKEN': 'fixture-project-token', 'github.token': 'fixture-github-token',
    'github.head_ref': BRANCH, 'github.event.pull_request.number': String(pull),
  });

  /** The commit the proposal's branch is at on the team origin, or '' when it has none. */
  const branchHead = (): string => spawnSync('git', ['--git-dir', fixture.teamOrigin, 'rev-parse', '--verify', '-q', BRANCH], { encoding: 'utf8' }).stdout.trim();
  /** The files the proposal's branch changes against main on the team origin. */
  const proposed = (): string[] => git(fixture.root, ['--git-dir', fixture.teamOrigin, 'diff', '--name-only', 'main', BRANCH]).split('\n');
  const improveLaunches = (): Array<{ failures: Array<{ failure: { subject: { sessionId: string } } }> }> =>
    (fs.existsSync(improveLog) ? fs.readFileSync(improveLog, 'utf8').trim().split('\n').map((line) => z.object({
      failures: z.array(z.object({ failure: z.object({ subject: z.object({ sessionId: z.string() }) }) })),
    }).parse(JSON.parse(line))) : []);

  let first: Ran[];
  let proof: Ran[];
  let again: Ran[];
  let branchAfterFirst: string;
  let proposedAfterFirst: string[];
  let branchAfterAgain: string;
  let launchesAfterAgain: number;

  beforeAll(async () => {
    fixture = await benchmarkFixture({ tool: 'does-nothing', sandbox: false });
    improveLog = path.join(fixture.root, 'improve.log');
    gh = fakeGhHost(path.join(fixture.root, 'gh'));
    fs.symlinkSync(gh.bin, path.join(fixture.bin, 'gh'));
    fs.symlinkSync(execFileSync('which', ['jq'], { encoding: 'utf8' }).trim(), path.join(fixture.bin, 'jq'));
    fs.symlinkSync(execFileSync('which', ['bash'], { encoding: 'utf8' }).trim(), path.join(fixture.bin, 'bash'));
    for (const tool of ['claude', 'codex']) {
      fs.renameSync(path.join(fixture.bin, tool), path.join(fixture.bin, `${tool}.fixture`));
      fs.writeFileSync(path.join(fixture.bin, tool), fakeTool(tool, improveLog, path.join(fixture.root, 'during-improve.sh')), { mode: 0o755 });
    }
    fs.writeFileSync(path.join(fixture.bin, 'npx'), [
      '#!/bin/sh',
      '[ "$1" = teamai-cli ] || { echo "the job ran npx $*" >&2; exit 97; }',
      'shift',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fixture.bin, 'npm'), [
      '#!/bin/sh',
      'case "$*" in "ci"|"install -g @anthropic-ai/claude-code"|"install -g @anthropic-ai/claude-code @openai/codex") exit 0;; esac',
      'echo "the job ran npm $*" >&2; exit 97', '',
    ].join('\n'), { mode: 0o755 });
    // The suite's project, which the guide calls acme/auth-service, is the fixture's project.
    fs.appendFileSync(path.join(fixture.home, '.gitconfig'), `[url "file://${fixture.productOrigin}"]\n\tinsteadOf = https://github.com/acme/auth-service.git\n`);
    fixture.pushTeam({
      'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`,
      'benchmarks/fix': null,
      'scorers/review-quality.md': SCORER,
      'skills/review/SKILL.md': SKILL,
      'benchmarks/regressions/suite.yaml': guideFile('benchmarks/regressions/suite.yaml').replace('repetitions: 3', 'repetitions: 1'),
    });
    expect(PRODUCT_URL).not.toBe('https://github.com/acme/auth-service.git');
    const clean = { commit: fixture.startingCommit, dirty: false };
    publishLabels('alice', [failing('s1000000', clean), failing('s2000000', clean), failing('s3000000', { ...clean, dirty: true })]);

    first = improve();
    branchAfterFirst = branchHead();
    proposedAfterFirst = proposed();
    const [pull] = gh.pulls();
    proof = pull ? prove(Number(pull.url.split('/').pop())) : [];
    again = improve();
    branchAfterAgain = branchHead();
    launchesAfterAgain = improveLaunches().length;
  }, 600_000);

  afterAll(() => fixture?.remove());

  it('opens one pull request that changes the skill and adds a regression task per clean failure', () => {
    expect(first.map((step) => step.status), said(first)).toEqual(first.map(() => 0));
    expect(gh.pulls().map((pull) => pull.head)).toEqual([BRANCH]);
    expect(proposedAfterFirst.sort()).toEqual([
      'benchmarks/regressions/tasks/missed-null-check-s1000000.yaml',
      'benchmarks/regressions/tasks/missed-null-check-s2000000.yaml',
      'skills/review/SKILL.md',
    ]);
    const task = git(fixture.root, ['--git-dir', fixture.teamOrigin, 'show', `${branchAfterFirst}:benchmarks/regressions/tasks/missed-null-check-s1000000.yaml`]);
    expect(task).toContain(`startingCommit: ${fixture.startingCommit}`);
    expect(task).toContain('source: {"platform":"claude-code","sessionId":"s1000000"}');
  });

  it('proves the pull request on both tools, before and after, and puts the results in its body', () => {
    expect(proof.map((step) => step.status), said(proof)).toEqual(proof.map(() => 0));
    const [pull] = gh.pulls();
    const body = pull?.body ?? '';
    expect(body).toContain('<!-- teamai:regressions -->');
    expect(body).toContain('## Regression benchmark');
    expect(body).toMatch(/\| claude-main \|[^\n]*\| 0% \(0\/2\)/);
    expect(body).toMatch(/\| claude-pulled \|[^\n]*\| 100% \(2\/2\)/);
    expect(body).toMatch(/\| codex-main \|[^\n]*\| 0% \(0\/2\)/);
    expect(body).toMatch(/\| codex-pulled \|[^\n]*\| 100% \(2\/2\)/);
    expect(body).toContain('### How far each judge agrees with hand labels');
    expect(body.indexOf('<!-- teamai:regressions -->')).toBe(body.lastIndexOf('<!-- teamai:regressions -->'));
  });

  it('opens nothing more when run again on the same failures', () => {
    expect(again.map((step) => step.status), said(again)).toEqual(again.map(() => 0));
    expect(gh.pulls()).toHaveLength(1);
    expect(branchAfterAgain).toBe(branchAfterFirst);
    expect(launchesAfterAgain).toBe(1);
  });

  it('updates the same pull request with a task for a new failure, keeping the earlier ones', () => {
    publishLabels('bob', [failing('s4000000', { commit: fixture.startingCommit, dirty: false })]);
    const ran = improve();
    expect(ran.map((step) => step.status), said(ran)).toEqual(ran.map(() => 0));
    expect(gh.pulls().map((pull) => pull.head)).toEqual([BRANCH]);
    // A failure another test left uncovered may come along; the ones the proposal covers never do.
    const launched = improveLaunches().at(-1)?.failures.map(({ failure }) => failure.subject.sessionId) ?? [];
    expect(launched).toContain('s4000000');
    expect(launched).not.toContain('s1000000');
    expect(launched).not.toContain('s2000000');
    expect(proposed()).toContain('benchmarks/regressions/tasks/missed-null-check-s4000000.yaml');
    expect(proposed()).toContain('benchmarks/regressions/tasks/missed-null-check-s1000000.yaml');
  }, 240_000);

  it('keeps a teammate\'s commit pushed to the proposal while a run improves it, and pushes nothing over it', () => {
    publishLabels('bob', [failing('s5000000', { commit: fixture.startingCommit, dirty: false })]);
    const teammate = path.join(fixture.root, 'teammate');
    fs.writeFileSync(path.join(fixture.root, 'during-improve.sh'), [
      `git clone -q --branch ${BRANCH} ${JSON.stringify(fixture.teamOrigin)} ${JSON.stringify(teammate)}`,
      `cd ${JSON.stringify(teammate)}`,
      'mkdir -p rules && echo "# Ask for a test of each fix" > rules/during.md',
      'git add -A && git -c user.name=Bob -c user.email=bob@example.com commit -qm "Ask for a test of each fix"',
      `git push -q origin ${BRANCH}`, '',
    ].join('\n'));

    const ran = improve();

    const theirs = git(teammate, ['rev-parse', 'HEAD']);
    expect(ran.some((step) => step.status !== 0), said(ran)).toBe(true);
    const done = z.object({ data: z.object({ done: z.object({ run: z.string() }) }) }).parse(JSON.parse(ran.at(-1)?.stdout.trim().split('\n').at(-1) ?? '{}'));
    // The run state is in the data home of the runner that ran the job.
    const state = fs.readdirSync(fixture.root, { recursive: true, encoding: 'utf8' })
      .find((name) => name.split(path.sep).join('/').endsWith(`/workflows/runs/${done.data.done.run}.json`));
    if (state === undefined) throw new Error(`no run state for ${done.data.done.run}\n${said(ran)}`);
    const improveStep = z.object({ steps: z.array(z.object({ id: z.string(), failure: z.object({ message: z.string() }).optional() })) })
      .parse(JSON.parse(fs.readFileSync(path.join(fixture.root, state), 'utf8'))).steps.find((step) => step.id === 'improve');
    expect(improveStep?.failure?.message, said(ran)).toContain(`${BRANCH} moved on origin while step "improve" ran, so nothing was pushed and origin keeps it.`);
    expect(branchHead()).toBe(theirs);
    expect(proposed()).toContain('rules/during.md');
  }, 240_000);
});

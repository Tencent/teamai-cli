/**
 * Real CLI: the "Start from CI" job in docs/guide/workflow.md, run the way GitHub Actions runs it. The test reads the
 * job's checkout ref, `env` and `run:` commands from the guide, fills in the Actions expressions, and runs each command
 * with bash in a clone of the product, where `npx teamai-cli` is the built CLI and `gh` is the fake every delivery test
 * shares. The product's origin is GitHub, or a host TeamAI reaches through git alone, and the team repo is on a generic
 * git host; git rewrites each to a bare repository.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ciRecipesOf, runCommandsOf, type CiRecipe } from '../helpers/ci-recipe.js';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const GUIDE = path.join(ROOT, 'docs', 'guide', 'workflow.md');
const TEAM_URL = 'https://git.example.internal/acme/team.git';
const GITHUB_URL = 'https://github.com/fixture/app.git';
const GENERIC_URL = 'https://git.example.internal/acme/app.git';
const ISSUE = 42;
/** What each Actions expression in the recipe stands for in the fixture. */
const EXPRESSIONS: Record<string, string> = {
  'github.event.issue.number': String(ISSUE),
  'vars.TEAM_REPO': TEAM_URL,
  'secrets.WORKFLOW_TOKEN': 'fixture-token',
};

const workflow = (required: boolean): string => `schemaVersion: v1alpha1
name: ship-issue
description: Write the issue number on a branch and deliver it for review.
inputs: { issue: number }
steps:
  - id: approve
    approve: { message: Ship it?, required: ${required} }
  - id: work
    needs: [approve]
    workspace: new
    deliver: pr
    command: node -e "require('fs').writeFileSync('issue.txt', process.env.ISSUE)"
    env:
      ISSUE: "{{ inputs.issue }}"
`;

const DoneSchema = z.object({ data: z.object({ done: z.object({ run: z.string(), outcome: z.string() }) }) });
const RunSchema = z.object({
  steps: z.array(z.object({
    id: z.string(), status: z.string(),
    changes: z.object({ to: z.string() }).optional(),
    failure: z.object({ code: z.string(), message: z.string() }).optional(),
  })),
  deliveries: z.array(z.object({ url: z.string(), branch: z.string(), base: z.string(), step: z.string(), pass: z.number() })).optional(),
});
const RecordSchema = z.object({ run: z.string(), prs: z.array(z.string()).optional() });
const OpenSchema = z.array(z.object({ html_url: z.string(), head: z.object({ ref: z.string() }) }));

interface Ran {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Each fixture root, and a wait for the detached processes its commands left running, which still write there. */
const fixtures: Array<{ root: string; settled: () => Promise<void> }> = [];

afterAll(async () => {
  for (const { root, settled } of fixtures.splice(0)) {
    await settled();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

/** `text` with each `${{ <expression> }}` replaced as Actions does before the shell runs. */
function expand(text: string): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => {
    const value = EXPRESSIONS[expression];
    if (value === undefined) throw new Error(`the recipe uses \${{ ${expression} }}, which the fixture does not fill in`);
    return value;
  });
}

function seed(root: string, bare: string, files: Record<string, string>): void {
  const dir = fs.mkdtempSync(path.join(root, 'seed-'));
  git(root, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
  git(dir, ['push', '-q', bare, 'main']);
}

/**
 * The run state `run` left in the data home of the checkout's workspace scope, `~/.teamai/projects/<checkout>/`, not
 * the copy of its record in that data home's reports worktree.
 */
function runState(root: string, run: string): z.infer<typeof RunSchema> {
  const state = new RegExp(`^home/\\.teamai/projects/[^/]+/workflows/runs/${run}\\.json$`);
  const file = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).find((name) => state.test(name.split(path.sep).join('/')));
  if (!file) throw new Error(`no run state for ${run} under ${root}`);
  return RunSchema.parse(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')));
}

/**
 * Runs the recipe's one job against a fresh product whose origin is `origin`, with a team repo whose `ship-issue`
 * workflow asks an approval that is `required` or optional. A step that fails stops the job, as in Actions.
 */
function runRecipe(origin: string, required: boolean): { recipe: CiRecipe; ran: Ran[]; root: string; gh: FakeGh; team: string; product: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ci-recipe-')));
  const detached = trackDetachedProcesses(root);
  fixtures.push({ root, settled: detached.waitForExit });
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const team = path.join(root, 'team.git');
  const product = path.join(root, 'app.git');
  for (const dir of [home, bin, path.join(home, '.gh')]) fs.mkdirSync(dir);
  const gh = fakeGhHost(path.join(root, 'gh'));
  fs.writeFileSync(path.join(bin, 'npx'), [
    '#!/bin/sh',
    '[ "$1" = teamai-cli ] || { echo "the recipe ran npx $*" >&2; exit 97; }',
    'shift',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', '\tname = runner', '\temail = runner@example.com',
    `[url "file://${team}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${product}"]`, `\tinsteadOf = ${origin}`, '',
  ].join('\n'));
  seed(root, team, { 'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\n`, 'workflows/ship-issue.yaml': workflow(required) });
  seed(root, product, { 'README.md': '# app\n' });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GH_CONFIG_DIR: path.join(home, '.gh'),
    PATH: [bin, path.dirname(gh.bin), process.env.PATH ?? ''].join(path.delimiter),
    GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', FORCE_COLOR: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
  };
  for (const name of ['XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GITHUB_TOKEN', 'GH_TOKEN']) delete env[name];

  const [recipe, ...others] = ciRecipesOf(GUIDE);
  if (!recipe || others.length > 0) throw new Error(`${GUIDE} shows ${others.length + (recipe ? 1 : 0)} GitHub Actions workflows, not one`);
  const [job, ...jobs] = Object.values(recipe.jobs);
  if (!job || jobs.length > 0) throw new Error('the recipe has more than one job');
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const ref = z.string().parse(checkout?.with?.ref);
  const work = path.join(root, 'work');
  git(root, ['clone', '-q', '-b', ref, origin, work], env);
  const jobEnv = Object.fromEntries(Object.entries(job.env ?? {}).map(([name, value]) => [name, expand(value)]));

  const ran: Ran[] = [];
  for (const command of runCommandsOf(recipe)) {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', expand(command)], {
      cwd: work, env: { ...env, ...jobEnv }, encoding: 'utf8', timeout: 120_000,
    });
    ran.push({ command, status: result.status, stdout: result.stdout, stderr: result.stderr });
    if (result.status !== 0) break;
  }
  return { recipe, ran, root, gh, team, product };
}

function said(ran: Ran[]): string {
  return ran.map((step) => `$ ${step.command}\nexit ${step.status}\n${step.stdout}\n${step.stderr}`).join('\n');
}

function doneOf(step: Ran | undefined): { run: string; outcome: string } {
  const line = step?.stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope from ${step?.command}`);
  return DoneSchema.parse(JSON.parse(line)).data.done;
}

function createsOf(gh: FakeGh): string[][] {
  return gh.calls().filter((call) => call.args[0] === 'pr' && call.args[1] === 'create')
    .map((call) => ['-R', '-H', '-B'].map((flag) => call.args[call.args.indexOf(flag) + 1] ?? ''));
}

/** The query the guide's run records section gives for the run that opened `url`, run over the records on `team`. */
function runThatOpened(root: string, team: string, url: string): string {
  const query = /^jq -r .+ workflows\/runs\/\*\.json$/m.exec(fs.readFileSync(GUIDE, 'utf8'))?.[0];
  if (!query) throw new Error(`${GUIDE} shows no jq query over workflows/runs`);
  const reports = path.join(root, 'reports');
  fs.mkdirSync(path.join(reports, 'workflows', 'runs'), { recursive: true });
  for (const file of git(root, ['--git-dir', team, 'ls-tree', '--name-only', 'teamai-reports', 'workflows/runs/']).split('\n').filter(Boolean)) {
    fs.writeFileSync(path.join(reports, file), git(root, ['--git-dir', team, 'show', `teamai-reports:${file}`]));
  }
  const result = spawnSync('bash', ['-c', query.replace('<url>', url)], { cwd: reports, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe('the CI recipe in the workflow guide, run through the real CLI', () => {
  describe('on a GitHub origin', () => {
    let job: ReturnType<typeof runRecipe>;
    let done: { run: string; outcome: string };
    const url = 'https://github.com/fixture/app/pull/1';
    beforeAll(() => {
      job = runRecipe(GITHUB_URL, false);
      expect(job.ran.map((step) => step.status), said(job.ran)).toEqual(runCommandsOf(job.recipe).map(() => 0));
      done = doneOf(job.ran.at(-1));
    }, 180_000);

    it('opens one pull request from the delivered branch into the checked-out branch, and lists it in the run record', () => {
      const { root, gh, team, product } = job;
      expect(done.outcome).toBe('succeeded');
      const branch = `teamai/${done.run}/work/p1`;
      expect(createsOf(gh)).toEqual([['fixture/app', branch, 'main']]);
      const opened = OpenSchema.parse(JSON.parse(fs.readFileSync(path.join(path.dirname(gh.bin), 'open.json'), 'utf8')));
      expect(opened.map((pull) => [pull.head.ref, pull.html_url])).toEqual([[branch, url]]);
      expect(runState(root, done.run).deliveries).toEqual([{ url, branch, base: 'main', step: 'work', pass: 1 }]);
      expect(git(root, ['--git-dir', product, 'show', `${branch}:issue.txt`])).toBe(String(ISSUE));
      const record = RecordSchema.parse(JSON.parse(git(root, ['--git-dir', team, 'show', `teamai-reports:workflows/runs/${done.run}.json`])));
      expect(record.prs).toEqual([url]);
    });

    it.skipIf(!hasJq)('finds the run that opened the pull request with the jq query of the guide', () => {
      expect(runThatOpened(job.root, job.team, url)).toBe(done.run);
    });
  });

  it('fails a run whose origin TeamAI reaches through git alone, naming the branch it pushed there', () => {
    const { recipe, ran, root, gh, product } = runRecipe(GENERIC_URL, false);

    expect(ran.map((step) => step.status), said(ran)).toEqual(runCommandsOf(recipe).map((_, index, all) => (index === all.length - 1 ? 1 : 0)));
    const done = doneOf(ran.at(-1));
    expect(done.outcome).toBe('failed');
    const branch = `teamai/${done.run}/work/p1`;
    const work = runState(root, done.run).steps.find((step) => step.id === 'work');
    expect(work?.failure).toMatchObject({ code: 'delivery_failed', message: expect.stringContaining(`The work is kept on origin in branch ${branch}.`) });
    expect(git(root, ['--git-dir', product, 'rev-parse', `refs/heads/${branch}`])).toBe(work?.changes?.to);
    expect(createsOf(gh)).toEqual([]);
  }, 180_000);

  it('fails a required approval unattended with hitl_required, and opens nothing', () => {
    const { recipe, ran, root, gh } = runRecipe(GITHUB_URL, true);

    expect(ran.map((step) => step.status), said(ran)).toEqual(runCommandsOf(recipe).map((_, index, all) => (index === all.length - 1 ? 1 : 0)));
    const done = doneOf(ran.at(-1));
    expect(done.outcome).toBe('failed');
    expect(runState(root, done.run).steps.find((step) => step.id === 'approve')?.failure).toMatchObject({ code: 'hitl_required' });
    expect(createsOf(gh)).toEqual([]);
  }, 180_000);
});

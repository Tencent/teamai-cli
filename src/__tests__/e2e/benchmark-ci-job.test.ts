/**
 * Real CLI: the GitHub Actions job in docs/guide/benchmarks.md, run the way Actions runs it. The test reads the job's
 * `env` and `run:` commands from the guide, fills in the Actions expressions, and runs each command with bash in a fresh
 * clone of the fixture's project under a runner HOME of its own, where `npx teamai-cli` is the built CLI, `npm install`
 * of Claude Code finds the fixture's fake `claude` already on PATH, and `$GITHUB_STEP_SUMMARY` is a file. A step after a
 * failed one runs only when its `if` says `always()`, as in Actions. The team repo is on a generic git host, which git
 * rewrites to the fixture's team origin, since a GitHub one would need a real token.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { benchmarkFixture, FIX_SUITE, fixTask, PRODUCT_URL, type BenchmarkFixture } from '../helpers/benchmark-fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const GUIDE = path.join(ROOT, 'docs', 'guide', 'benchmarks.md');
const TEAM_REPO = 'https://git.example.internal/acme/team.git';
/** What each Actions expression in the job stands for in the fixture. */
const EXPRESSIONS: Record<string, string> = {
  'vars.TEAM_REPO': TEAM_REPO,
  'secrets.TEAM_TOKEN': 'fixture-team-token',
  'secrets.ANTHROPIC_API_KEY': 'fixture-anthropic-key',
};

const JobSchema = z.object({
  'runs-on': z.string(),
  env: z.record(z.string(), z.string()).default({}),
  steps: z.array(z.object({ uses: z.string().optional(), run: z.string().optional(), if: z.string().optional() })),
});
const DoneSchema = z.object({ data: z.object({ done: z.object({ outcome: z.string(), outputs: z.object({ text: z.string() }) }) }) });

interface Ran {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The one job of the one GitHub Actions workflow the guide shows. */
function guideJob(): z.infer<typeof JobSchema> {
  const text = fs.readFileSync(GUIDE, 'utf8');
  const workflows = [...text.matchAll(/^```yaml\n([\s\S]*?)^```/gm)]
    .map((match): unknown => parseDocument(match[1] ?? '').toJS())
    .filter((value) => !!value && typeof value === 'object' && 'jobs' in value)
    .map((value) => z.object({ jobs: z.record(z.string(), z.unknown()) }).parse(value));
  const [workflow, ...others] = workflows;
  if (!workflow || others.length > 0) throw new Error(`${GUIDE} shows ${workflows.length} GitHub Actions workflows, not one`);
  const [job, ...jobs] = Object.values(workflow.jobs);
  if (job === undefined || jobs.length > 0) throw new Error('the guide\'s workflow has more than one job');
  return JobSchema.parse(job);
}

/** `text` with each `${{ <expression> }}` replaced as Actions does before the shell runs. */
function expand(text: string): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => {
    const value = EXPRESSIONS[expression];
    if (value === undefined) throw new Error(`the job uses \${{ ${expression} }}, which the fixture does not fill in`);
    return value;
  });
}

function said(ran: Ran[]): string {
  return ran.map((step) => `$ ${step.command}\nexit ${step.status}\n${step.stdout}\n${step.stderr}`).join('\n');
}

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe.skipIf(!hasJq)('the GitHub Actions job in the benchmarks guide, run through the real CLI', () => {
  let fixture: BenchmarkFixture;
  let ran: Ran[];
  let work: string;
  let summary: string;

  beforeAll(async () => {
    fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false, tools: ['claude'] });
    const job = guideJob();
    const suite = /teamai-cli benchmark run (\S+)/.exec(job.steps.map((step) => step.run ?? '').join('\n'))?.[1];
    if (!suite) throw new Error('the job starts no benchmark');
    fixture.pushTeam({
      [`benchmarks/${suite}/suite.yaml`]: FIX_SUITE.replace('name: fix', `name: ${suite}`),
      [`benchmarks/${suite}/tasks/fix.yaml`]: fixTask(fixture.startingCommit),
    });

    const runner = path.join(fixture.root, 'runner');
    work = path.join(runner, 'work');
    summary = path.join(fixture.root, 'step-summary.md');
    fs.mkdirSync(runner);
    fs.appendFileSync(path.join(fixture.home, '.gitconfig'), `[url "file://${fixture.teamOrigin}"]\n\tinsteadOf = ${TEAM_REPO}\n`);
    fs.writeFileSync(path.join(fixture.bin, 'npx'), [
      '#!/bin/sh',
      '[ "$1" = teamai-cli ] || { echo "the job ran npx $*" >&2; exit 97; }',
      'shift',
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(fixture.bin, 'npm'), [
      '#!/bin/sh',
      '[ "$*" = "install -g @anthropic-ai/claude-code" ] || { echo "the job ran npm $*" >&2; exit 97; }', '',
    ].join('\n'), { mode: 0o755 });
    fs.symlinkSync(execFileSync('which', ['jq'], { encoding: 'utf8' }).trim(), path.join(fixture.bin, 'jq'));
    const env: NodeJS.ProcessEnv = {
      ...fixture.env, HOME: runner, USERPROFILE: runner, CI: 'true', GITHUB_STEP_SUMMARY: summary,
      ...Object.fromEntries(Object.entries(job.env).map(([name, value]) => [name, expand(value)])),
    };
    execFileSync('git', ['clone', '-q', PRODUCT_URL, work], { env, stdio: 'ignore' });

    ran = [];
    for (const step of job.steps) {
      if (step.run === undefined) continue;
      if (ran.some((before) => before.status !== 0) && !step.if?.includes('always()')) continue;
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', expand(step.run)], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
      ran.push({ command: step.run, status: result.status, stdout: result.stdout, stderr: result.stderr });
    }
  }, 180_000);

  afterAll(() => fixture?.remove());

  it('runs every step, and its benchmark trial in a sandbox the job declared', () => {
    expect(ran.map((step) => step.status), said(ran)).toEqual(guideJob().steps.filter((step) => step.run !== undefined).map(() => 0));
    expect(fixture.toolLaunches().map((launch) => launch.tool)).toEqual(['claude']);
  });

  it('leaves its trials\' sessions on the runner when the unattended run ends', () => {
    const started = ran.find((step) => step.command.includes('benchmark run'));
    expect(started?.stderr, said(ran)).not.toContain('step session');
  });

  it('writes the done envelope to done.json and its results text to the job summary', () => {
    const done = DoneSchema.parse(JSON.parse(fs.readFileSync(path.join(work, 'done.json'), 'utf8'))).data.done;
    expect(done.outcome).toBe('succeeded');
    expect(done.outputs.text).toContain('100% (1/1)');
    expect(fs.readFileSync(summary, 'utf8')).toBe(`${done.outputs.text}\n`);
  });
});

describe('a runner whose init set up no AI tool', () => {
  let fixture: BenchmarkFixture | undefined;

  afterAll(() => fixture?.remove());

  it('refuses the start with how to set a tool up', async () => {
    fixture = await benchmarkFixture({ tool: 'fixes', sandbox: false });
    const runner = path.join(fixture.root, 'runner');
    const work = path.join(runner, 'work');
    fs.mkdirSync(runner);
    fs.appendFileSync(path.join(fixture.home, '.gitconfig'), `[url "file://${fixture.teamOrigin}"]\n\tinsteadOf = ${TEAM_REPO}\n`);
    const env: NodeJS.ProcessEnv = { ...fixture.env, HOME: runner, USERPROFILE: runner, CI: 'true' };
    execFileSync('git', ['clone', '-q', PRODUCT_URL, work], { env, stdio: 'ignore' });
    const teamai = (args: string[]): Ran => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
      return { command: `teamai ${args.join(' ')}`, status: result.status, stdout: result.stdout, stderr: result.stderr };
    };

    const ran = [teamai(['init', TEAM_REPO, '--provider', 'git', '--scope', 'workspace', '--force']), teamai(['pull'])];
    const started = teamai(['benchmark', 'run', 'fix', '--sandbox']);

    expect(ran.map((step) => step.status), said(ran)).toEqual([0, 0]);
    expect(JSON.parse(started.stdout), said([started])).toEqual({ error: {
      code: 'team_revision_unpullable',
      message: 'teamai pull set up no AI tool in this checkout, so the team revision it delivered cannot be read. Run teamai init with --agent <tool>, run teamai pull, and start again.',
    } });
  }, 180_000);
});

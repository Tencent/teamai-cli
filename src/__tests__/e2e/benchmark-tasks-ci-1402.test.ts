/**
 * Real CLI: the team repo CI job docs/guide/benchmarks.md gives for benchmark task pull requests, run as GitHub runs its
 * step, with bash, in a checkout of the suite's repo beside a checkout of the team repo at the pull request. The script
 * is read from the guide, so the guide shows the job this test proves. No teamai init runs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const JOB_FILE = '# .github/workflows/benchmark-tasks.yml in the team repo';

const StepSchema = z.object({ name: z.string().optional(), run: z.string().optional(), env: z.record(z.string(), z.string()).optional(), 'working-directory': z.string().optional() }).passthrough();
const JobFileSchema = z.object({ jobs: z.object({ try: z.object({ steps: z.array(StepSchema) }).passthrough() }) }).passthrough();

const MATRIX_JOB_FILE = '# .github/workflows/benchmark-tasks.yml, one suite per matrix entry';

/** The step of the guide's CI job under `header` that tries each task: its script, the env GitHub gives it, and where it runs. */
function guideStep(header: string): { run: string; env: Record<string, string>; workingDirectory: string } {
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'guide', 'benchmarks.md'), 'utf8');
  const block = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map(([, body]) => body ?? '').find((body) => body.startsWith(header));
  if (block === undefined) throw new Error(`docs/guide/benchmarks.md has no yaml block that starts with "${header}"`);
  const step = JobFileSchema.parse(YAML.parse(block)).jobs.try.steps.find((candidate) => candidate.run?.includes('teamai benchmark try'));
  if (step?.run === undefined) throw new Error(`the guide's CI job "${header}" has no step that runs teamai benchmark try`);
  return { run: step.run, env: step.env ?? {}, workingDirectory: step['working-directory'] ?? '.' };
}

// Each case clones the project and runs setup and the check twice per task it tries, so cases get 120 s, not the default 60 s.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const TEST = "require('node:assert').strictEqual(require('../answer.js'), 42);\n";
const OTHER_CASE = "require('node:assert').ok(true);\n";

/**
 * The suite's repo, acme/auth-service, with the commits each task names, checked out at `project`; and the team repo with the
 * suite benchmarks/fix-auth on main, checked out at `team` on a pull request branch that adds `tasks` (null deletes one). The job's step
 * runs in `project`, with `teamai` on PATH running the CLI under test.
 */
function pullRequest(tasks: (commits: Record<string, string>) => Record<string, string | null>, job: { header: string; env: Record<string, string> } = { header: JOB_FILE, env: { BASE_REF: 'main' } }): { code: number | null; output: string; commits: Record<string, string> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tasks-ci-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  const team = path.join(root, 'team');
  for (const dir of [home, bin, project, path.join(root, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = ci\n\temail = ci@example.com\n');
  fs.writeFileSync(path.join(bin, 'teamai'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: [bin, process.env.PATH ?? ''].join(path.delimiter), TMPDIR: path.join(root, 'tmp'), FORCE_COLOR: '0', ...job.env,
  };
  const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const commit = (cwd: string, files: Record<string, string | null>, subject: string): string => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) {
        fs.rmSync(path.join(cwd, file));
        continue;
      }
      fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      fs.writeFileSync(path.join(cwd, file), text);
    }
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '--allow-empty', '-m', subject]);
    return git(cwd, ['rev-parse', 'HEAD']);
  };
  git(project, ['init', '-q', '-b', 'main']);
  const commits = {
    start: commit(project, { 'answer.js': 'module.exports = 41;\n' }, 'pods time out on first start'),
    fix: commit(project, { 'answer.js': 'module.exports = 42;\n', 'test/startup.test.js': TEST }, 'fix the first start, with its test'),
    caseStart: commit(project, { 'answer.js': 'module.exports = 41;\n', 'test/startup.test.js': OTHER_CASE }, 'a startup test without the case'),
    caseFix: commit(project, { 'answer.js': 'module.exports = 42;\n', 'test/startup.test.js': `${OTHER_CASE}${TEST}` }, 'fix that adds the case'),
    testedStart: commit(project, { 'answer.js': 'module.exports = 41;\n', 'test/startup.test.js': TEST }, 'a failing startup test'),
    testedFix: commit(project, { 'answer.js': 'module.exports = 42;\n' }, 'fix that leaves the test alone'),
  };
  const teamOrigin = path.join(root, 'team.git');
  git(root, ['init', '-q', '--bare', '-b', 'main', teamOrigin]);
  git(root, ['clone', '-q', teamOrigin, team]);
  commit(team, {
    'benchmarks/fix-auth/suite.yaml': 'schemaVersion: v1alpha1\nname: fix-auth\nrepo: https://github.com/acme/auth-service.git\ndefaults: { tool: claude }\narms: [{ name: main }]\ntimeout: 30m\n',
    'benchmarks/fix-auth/tasks/existing.yaml': task(commits.start, { solution: commits.fix, add: true }),
  }, 'suite');
  git(team, ['push', '-q', 'origin', 'HEAD:main']);
  git(team, ['checkout', '-q', '-b', 'tasks']);
  commit(team, Object.fromEntries(Object.entries(tasks(commits)).map(([name, text]) => [`benchmarks/fix-auth/tasks/${name}.yaml`, text])), 'add tasks');
  const step = guideStep(job.header);
  // GitHub sets each env value the step declares; this run sets the same names.
  expect(Object.keys(step.env).sort()).toEqual(Object.keys(job.env).sort());
  const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], { cwd: path.join(root, step.workingDirectory), env, encoding: 'utf8', timeout: 120_000 });
  return { code: ran.status, output: `${ran.stdout}${ran.stderr}`, commits };
}

/** A task of benchmarks/fix-auth whose check runs test/startup.test.js, protecting test/. */
function task(start: string, { solution, add }: { solution?: string; add?: boolean | string } = {}): string {
  const added = add === true ? 'test/startup.test.js' : add;
  return `schemaVersion: v1alpha1
title: Pods time out on first start
prompt: The first start of a pod times out after 30 s on a cold node. Make it start.
startingCommit: ${start}
${solution ? `solutionCommit: ${solution}\n` : ''}check:
  run: node test/startup.test.js
  protect: ['test/**']
${added ? `  add: ['${added}']\n` : ''}source: { platform: claude-code, sessionId: 7c1e }
`;
}

const short = (commit: string): string => commit.slice(0, 7);

describe('the guide\'s CI job for benchmark task pull requests', () => {
  it('passes for a task whose solution brought the test check.add hides, and for one whose solution added a case to a test file', () => {
    const job = pullRequest((c) => ({ 'pod-startup': task(c.start, { solution: c.fix, add: true }), 'startup-case': task(c.caseStart, { solution: c.caseFix, add: true }) }));

    expect(job.code, job.output).toBe(0);
    expect(job.output).toContain(`the check fails at ${short(job.commits.start)} and passes at the solution ${short(job.commits.fix)}`);
    expect(job.output).toContain(`the check fails at ${short(job.commits.caseStart)} and passes at the solution ${short(job.commits.caseFix)}`);
    expect(job.output).not.toContain('existing.yaml');
  }, 120_000);

  it('passes for a task with no check.add whose check fails at startingCommit and passes at the solution', () => {
    const job = pullRequest((c) => ({ 'tested-start': task(c.testedStart, { solution: c.testedFix }) }));

    expect(job.code, job.output).toBe(0);
    expect(job.output).toContain(`the check fails at ${short(job.commits.testedStart)} and passes at the solution ${short(job.commits.testedFix)}`);
  }, 120_000);

  it.each<[string, (c: Record<string, string>) => string, (c: Record<string, string>) => string]>([
    ['the solution\'s test is not in check.add', (c) => task(c.start, { solution: c.fix }), (c) => `the check fails at the solution ${short(c.fix)}`],
    ['a check.add path is not a file at the solution', (c) => task(c.start, { solution: c.fix, add: 'test/missing.test.js' }), (c) => `test/missing.test.js is not a file at the solutionCommit ${c.fix}`],
    ['the check passes without changes', (c) => task(c.fix), (c) => `the check passes without changes at ${short(c.fix)}`],
  ])('fails when %s, and tries every other task', (_case, failing, said) => {
    const job = pullRequest((c) => ({ 'a-failing': failing(c), 'b-passing': task(c.start, { solution: c.fix, add: true }) }));

    expect(job.code, job.output).not.toBe(0);
    expect(job.output).toContain(said(job.commits));
    expect(job.output).toContain(`and passes at the solution ${short(job.commits.fix)}`);
  }, 120_000);

  it('tries a task the pull request renames and changes', () => {
    const job = pullRequest((c) => ({ existing: null, renamed: task(c.start, { solution: c.fix }) }));

    expect(job.code, job.output).not.toBe(0);
    expect(job.output).toContain(`the check fails at the solution ${short(job.commits.fix)}`);
  }, 120_000);

  it('tries, per matrix entry, only the tasks of that entry\'s suite', () => {
    const tasks = (c: Record<string, string>) => ({ 'pod-startup': task(c.start, { solution: c.fix, add: true }), 'not-added': task(c.start, { solution: c.fix }) });

    const frontend = pullRequest(tasks, { header: MATRIX_JOB_FILE, env: { BASE_REF: 'main', SUITE: 'benchmarks/fix-auth' } });
    expect(frontend.code, frontend.output).not.toBe(0);
    expect(frontend.output).toContain(`the check fails at the solution ${short(frontend.commits.fix)}`);
    expect(frontend.output).toContain(`and passes at the solution ${short(frontend.commits.fix)}`);

    const checkout = pullRequest(tasks, { header: MATRIX_JOB_FILE, env: { BASE_REF: 'main', SUITE: 'benchmarks/payments/checkout' } });
    expect(checkout.code, checkout.output).toBe(0);
    expect(checkout.output).toBe('');
  }, 120_000);

  it.each([[JOB_FILE, {}], [MATRIX_JOB_FILE, { SUITE: 'benchmarks/fix-auth' }]] as const)('fails, rather than trying nothing, when the base branch is missing: %s', (header, more) => {
    const job = pullRequest((c) => ({ 'pod-startup': task(c.start, { solution: c.fix, add: true }) }), { header, env: { BASE_REF: 'renamed-default', ...more } });

    expect(job.code, job.output).not.toBe(0);
    expect(job.output).toContain('origin/renamed-default');
  }, 120_000);
});

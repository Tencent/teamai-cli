/**
 * Real CLI: `teamai benchmark try <task file>` in a checkout of the suite's repo, reading the task file and its suite from
 * a team repo checkout beside it, under a HOME where teamai init never ran.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

const TEST = "const assert = require('node:assert');\nassert.strictEqual(require('./answer.js'), 42);\n";
const STARTUP_TEST = "require('node:assert').strictEqual(require('../answer.js'), 42);\n";
const OTHER_CASE = "require('node:assert').ok(true);\n";

/** A project checkout whose history holds the starting commit and each kind of fix a task can name, and a team repo checkout beside it. */
function fixture(suiteLines = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-try-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const work = path.join(root, 'project');
  const team = path.join(root, 'team');
  for (const dir of [home, tmp, work]) fs.mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), FORCE_COLOR: '0',
  };
  const origin = path.join(root, 'origin.git');
  fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = member\n\temail = member@example.com\n[url "${origin}"]\n\tinsteadOf = https://github.com/fixture/app.git\n`);
  const git = (args: string[]): string => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();
  const commit = (files: Record<string, string>, subject: string): string => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), text);
    }
    git(['add', '-A']);
    git(['commit', '-q', '--allow-empty', '-m', subject]);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '-q']);
  const commits = {
    start: commit({ 'answer.js': 'module.exports = 41;\n', 'test.js': TEST }, 'start'),
    fix: commit({ 'answer.js': 'module.exports = 42;\n' }, 'fix'),
    badFix: commit({ 'answer.js': 'module.exports = 43;\n' }, 'bad fix'),
    testInFix: commit({ 'answer.js': 'module.exports = 41;\n', 'test.js': "require('node:assert').ok(true);\n" }, 'fix that rewrites the test'),
    // A fix that brings the test proving it, and one that adds that case to a test file the starting commit has.
    podStart: commit({ 'answer.js': 'module.exports = 41;\n' }, 'no startup test'),
    podFix: commit({ 'answer.js': 'module.exports = 42;\n', 'test/startup.test.js': STARTUP_TEST }, 'fix with its test'),
    changedStart: commit({ 'answer.js': 'module.exports = 41;\n', 'test/startup.test.js': OTHER_CASE }, 'startup test without the case'),
    changedFix: commit({ 'answer.js': 'module.exports = 42;\n', 'test/startup.test.js': `${OTHER_CASE}${STARTUP_TEST}` }, 'fix that adds the case'),
  };
  const suiteDir = path.join(team, 'benchmarks', 'fix');
  fs.mkdirSync(path.join(suiteDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(suiteDir, 'suite.yaml'), `schemaVersion: v1alpha1
name: fix
repo: https://github.com/fixture/app.git
defaults:
  tool: claude
arms:
  - name: claude
timeout: 5m
${suiteLines}`);
  /** Writes task file `name` and runs `benchmark try` on it. */
  const tryTask = (name: string, taskText: string): Promise<Result> => {
    fs.writeFileSync(path.join(suiteDir, 'tasks', `${name}.yaml`), taskText);
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'benchmark', 'try', `../team/benchmarks/fix/tasks/${name}.yaml`], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  };
  /** Commits `files` on top of `base` to the suite repo, `origin`, from another clone: this checkout never has it. */
  const pushElsewhere = (base: string, files: Record<string, string>): string => {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
    git(['push', '-q', origin, `${base}:refs/heads/main`]);
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', origin, other], { env });
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true });
      fs.writeFileSync(path.join(other, file), text);
    }
    const there = (args: string[]): string => execFileSync('git', args, { cwd: other, env, encoding: 'utf8' }).trim();
    there(['add', '-A']);
    there(['commit', '-q', '-m', 'fix elsewhere']);
    there(['push', '-q', 'origin', 'HEAD:main']);
    return there(['rev-parse', 'HEAD']);
  };
  return { commits, home, tmp, suiteDir, tryTask, pushElsewhere, has: (sha: string) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: work, env }).status === 0 };
}

function task({ start, fix, run = 'node test.js', judge }: { start: string; fix?: string; run?: string; judge?: string }): string {
  return `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make node test.js pass.
startingCommit: ${start}
${judge ?? `check:\n  run: ${run}\n  protect: [test.js]`}
${fix ? `source: { platform: claude-code, sessionId: s1, fix: ${fix} }\n` : ''}`;
}

function said(result: Result): string {
  return `exit ${result.code}\n${result.stdout}\n${result.stderr}`;
}

function message(result: Result): string {
  const line = result.stdout.trim().split('\n').at(-1) ?? '{}';
  const parsed: unknown = JSON.parse(line);
  const envelope = parsed && typeof parsed === 'object' ? parsed as { data?: { try?: { message?: string } }; error?: { message?: string } } : {};
  return envelope.error?.message ?? envelope.data?.try?.message ?? '';
}

type Commits = ReturnType<typeof fixture>['commits'];
const short = (commit: string): string => commit.slice(0, 7);

describe('benchmark try', () => {
  // #1402's table: the task, then the suite's extra lines, the exit, and what the answer says.
  it.each<[string, (commits: Commits) => string, string, number, (commits: Commits) => string]>([
    ['pod-startup', (c) => task({ start: c.start, fix: c.fix }), '', 0, (c) => `the check fails at ${short(c.start)} and passes at the fix ${short(c.fix)}`],
    ['old-bug', (c) => task({ start: c.fix }), '', 1, (c) => `the check passes without changes at ${short(c.fix)}`],
    ['bad-fix', (c) => task({ start: c.start, fix: c.badFix }), '', 1, (c) => `the check fails at the fix ${short(c.badFix)} (exit 1)`],
    ['test-in-fix', (c) => task({ start: c.start, fix: c.testInFix }), '', 1, (c) => `the check fails at the fix ${short(c.testInFix)} (exit 1), with the protected paths as ${short(c.start)} has them. The fix changes test.js`],
    ['no-fix', (c) => task({ start: c.start }), '', 0, () => 'the check was not tried on a fix'],
    ['criteria-only', (c) => task({ start: c.start, judge: 'successCriteria: The answer is 42.' }), '', 0, () => 'there is no check to try'],
    ['missing-tool', (c) => task({ start: c.start, run: 'no-such-tool test' }), '', 1, (c) => `the check "no-such-tool test" could not run at ${short(c.start)} (not_found)`],
    ['setup-error', (c) => task({ start: c.start }), 'setup:\n  command: exit 3\n', 1, (c) => `could not be tried at ${short(c.start)}: Setup "exit 3" exited with code 3`],
  ])('%s', async (name, text, suite, exit, expected) => {
    const { commits, home, tmp, tryTask } = fixture(suite);

    const result = await tryTask(name, text(commits));

    expect(result.code, said(result)).toBe(exit);
    expect(message(result)).toContain(expected(commits));
    const teamai = path.join(home, '.teamai');
    // No config, run or record: only the BASH_ENV helper every step's environment uses.
    expect(fs.existsSync(teamai) ? fs.readdirSync(teamai, { recursive: true }).filter((entry) => entry !== 'env-exec-bash-env.sh') : []).toEqual([]);
    const trials = path.join(tmp, 'teamai-clones');
    expect(fs.existsSync(trials) ? fs.readdirSync(trials) : []).toEqual([]);
  }, 60_000);

  // check.add writes its files from the fix at both commits, whether or not startingCommit has them.
  it.each<[string, (commits: Commits) => [string, string], string, string, number, (commits: Commits) => string]>([
    ['pod-startup', (c) => [c.podStart, c.podFix], '\n  add: [test/startup.test.js]', '', 0, (c) => `the check fails at ${short(c.podStart)} and passes at the fix ${short(c.podFix)}`],
    ['changed-test', (c) => [c.changedStart, c.changedFix], '\n  add: [test/startup.test.js]', '', 0, (c) => `the check fails at ${short(c.changedStart)} and passes at the fix ${short(c.changedFix)}`],
    ['not-added', (c) => [c.podStart, c.podFix], '', '', 1, (c) => `the check fails at the fix ${short(c.podFix)}`],
    ['add-missing', (c) => [c.podStart, c.podFix], '\n  add: [test/missing.test.js]', '', 1, (c) => `test/missing.test.js is not a file at the fix ${short(c.podFix)}`],
  ])('check.add: %s', async (name, commitsOf, add, suite, exit, expected) => {
    const { commits, tryTask } = fixture(suite);
    const [start, fix] = commitsOf(commits);

    const result = await tryTask(name, task({ start, fix, judge: `check:\n  run: node test/startup.test.js\n  protect: [test]${add}` }));

    expect(result.code, said(result)).toBe(exit);
    expect(message(result)).toContain(expected(commits));
  }, 60_000);

  it('writes a test from the suite directory at both commits, as a run does', async () => {
    const { commits, suiteDir, tryTask } = fixture();
    fs.mkdirSync(path.join(suiteDir, 'check-files'));
    fs.writeFileSync(path.join(suiteDir, 'check-files', 'startup.test.js'), STARTUP_TEST);
    const add = '\n  add:\n    - from: check-files/startup.test.js\n      to: test/startup.test.js';

    const result = await tryTask('hidden', task({ start: commits.podStart, fix: commits.fix, judge: `check:\n  run: node test/startup.test.js\n  protect: [test]${add}` }));

    expect(result.code, said(result)).toBe(0);
    expect(message(result)).toContain(`the check fails at ${short(commits.podStart)} and passes at the fix ${short(commits.fix)}`);
  }, 60_000);

  it('runs setup before it writes the added files at both commits, as a run does', async () => {
    const { commits, suiteDir, tryTask } = fixture(`setup:\n  command: node -e "if (require('fs').existsSync('test/startup.test.js')) process.exit(3)"\n`);
    fs.mkdirSync(path.join(suiteDir, 'check-files'));
    fs.writeFileSync(path.join(suiteDir, 'check-files', 'startup.test.js'), STARTUP_TEST);
    const add = '\n  add:\n    - from: check-files/startup.test.js\n      to: test/startup.test.js';

    const result = await tryTask('setup-first', task({ start: commits.podStart, fix: commits.fix, judge: `check:\n  run: node test/startup.test.js\n  protect: [test]${add}` }));

    expect(result.code, said(result)).toBe(0);
    expect(message(result)).toContain(`the check fails at ${short(commits.podStart)} and passes at the fix ${short(commits.fix)}`);
  }, 60_000);

  it('fetches a fix this checkout lacks by SHA from the suite repo, as a run does', async () => {
    const { commits, tryTask, pushElsewhere, has } = fixture();
    const fix = pushElsewhere(commits.podStart, { 'answer.js': 'module.exports = 42;\n', 'test/startup.test.js': STARTUP_TEST });

    const result = await tryTask('fetched', task({ start: commits.podStart, fix, judge: 'check:\n  run: node test/startup.test.js\n  protect: [test]\n  add: [test/startup.test.js]' }));

    expect(result.code, said(result)).toBe(0);
    expect(message(result)).toContain(`passes at the fix ${short(fix)}`);
    expect(has(fix)).toBe(false);
  }, 60_000);

  it('validates the task file as pull does', async () => {
    const { commits, tryTask } = fixture();

    const result = await tryTask('short-fix', task({ start: commits.start, fix: '9a1d4e7' }));

    expect(result.code, said(result)).toBe(1);
    expect(message(result)).toContain('field "source.fix": must be a full 40-character commit');
  }, 60_000);
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/benchmark-assets.mjs', import.meta.url));
let root: string;
let suite: Record<string, unknown>;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@teamai.test', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@teamai.test' },
    encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true,
  }).trim();
}

function run() {
  const file = path.join(root, 'suite.json');
  const output = path.join(root, 'report.json');
  write(file, JSON.stringify(suite));
  const result = spawnSync(process.execPath, [SCRIPT, file, output], {
    env: process.env, cwd: root, encoding: 'utf8', timeout: 180_000, windowsHide: true,
  });
  expect(result.error, `${result.stdout}${result.stderr}`).toBeUndefined();
  return { result, report: JSON.parse(fs.readFileSync(output, 'utf8')), markdown: fs.readFileSync(`${output}.md`, 'utf8') };
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-benchmark-test-')));
  const code = path.join(root, 'code');
  const team = path.join(root, 'team');
  write(path.join(code, 'answer.txt'), '0');
  git(['init', '-q', '-b', 'main'], code);
  git(['add', '.'], code);
  git(['commit', '-qm', 'bug'], code);
  write(path.join(team, 'teamai.yaml'), JSON.stringify({ team: 'benchmark', repo: team, provider: 'git', usageReport: false }));
  write(path.join(team, 'rules', 'answer.md'), '# Rule\nWrite answer 41.\n');
  git(['init', '-q', '-b', 'main'], team);
  git(['add', '.'], team);
  git(['commit', '-qm', 'before'], team);
  git(['tag', 'before'], team);
  write(path.join(team, 'rules', 'answer.md'), '# Rule\nWrite answer 42.\n');
  git(['add', '.'], team);
  git(['commit', '-qm', 'after'], team);
  write(path.join(root, 'check.cjs'), "const fs = require('node:fs'); process.exit(fs.readFileSync('answer.txt', 'utf8') === '42' ? 0 : 1);\n");
  write(path.join(root, 'runner.cjs'), [
    "const fs = require('node:fs');",
    "if (fs.readFileSync(0, 'utf8') !== 'Fix the answer.') process.exit(2);",
    "const rule = '.claude/rules/answer.md';",
    "const answer = fs.existsSync(rule) && fs.readFileSync(rule, 'utf8').includes('42') ? '42' : '41';",
    "fs.writeFileSync('answer.txt', answer);",
    "fs.writeFileSync(process.env.TEAMAI_BENCHMARK_RESULT, JSON.stringify({ tokens: 100, costUsd: 0.01 }));",
  ].join('\n'));
  suite = {
    codeRepo: code, codeRef: 'main', teamRepo: team, before: 'before', after: 'main', tool: 'claude',
    run: ['{node}', '{suite}/runner.cjs'], repetitions: 2, timeoutMs: 30_000,
    tasks: [{ id: 'answer', prompt: 'Fix the answer.', check: ['{node}', '{suite}/check.cjs'] }],
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('asset comparison through the built CLI', () => {
  it('pins both asset revisions, reports paired gains, and leaves source repositories untouched', () => {
    const { result, report, markdown } = run();
    expect(result.status, JSON.stringify(report)).toBe(0);
    expect(report.error).toBeUndefined();
    expect(report.codeCommit).toBe(git(['rev-parse', 'main'], path.join(root, 'code')));
    expect(report.teamCommits.before).toBe(git(['rev-parse', 'before'], path.join(root, 'team')));
    expect(report.teamCommits.after).toBe(git(['rev-parse', 'main'], path.join(root, 'team')));
    expect(report.baselines).toEqual([{ task: 'answer', code: 1 }]);
    expect(report.trials.map((row: { arm: string }) => row.arm)).toEqual(['before', 'after', 'after', 'before']);
    expect(report.summary.before).toMatchObject({ trials: 2, passed: 0, failed: 2, errors: 0, tokens: 200, costUsd: 0.02 });
    expect(report.summary.after).toMatchObject({ trials: 2, passed: 2, failed: 0, errors: 0, costPerPassed: 0.01 });
    expect(report.pairs.map((pair: { change: string }) => pair.change)).toEqual(['improved', 'improved']);
    expect(markdown).toContain('Cost/success USD');
    expect(git(['status', '--porcelain'], path.join(root, 'code'))).toBe('');
    expect(git(['status', '--porcelain'], path.join(root, 'team'))).toBe('');
    expect(fs.readFileSync(path.join(root, 'code', 'answer.txt'), 'utf8')).toBe('0');
  }, 180_000);

  it('supports no delivered team assets and preserves missing usage as unknown', () => {
    suite.before = 'none';
    suite.repetitions = 1;
    write(path.join(root, 'runner.cjs'), "const fs = require('node:fs'); const rule = '.claude/rules/answer.md'; fs.writeFileSync('answer.txt', fs.existsSync(rule) ? '42' : '41');\n");
    const { result, report, markdown } = run();
    expect(result.status, JSON.stringify(report)).toBe(0);
    expect(report.teamCommits.before).toBeNull();
    expect(report.summary.before.failed).toBe(1);
    expect(report.summary.after.passed).toBe(1);
    expect(report.summary.after.costUsd).toBeNull();
    expect(report.summary.after.tokens).toBeNull();
    expect(markdown).toContain('unknown');
  }, 180_000);

  it('rejects a passing baseline before spending any agent calls', () => {
    write(path.join(root, 'check.cjs'), 'process.exit(0);\n');
    const { result, report } = run();
    expect(result.status).toBe(1);
    expect(report.error).toContain('check must run and fail');
    expect(report.trials).toEqual([]);
  }, 180_000);

  it('records a failed runner as an error, not as a task regression', () => {
    suite.repetitions = 1;
    write(path.join(root, 'runner.cjs'), 'process.exit(2);\n');
    const { result, report } = run();
    expect(result.status).toBe(1);
    expect(report.summary.before.errors).toBe(1);
    expect(report.summary.after.errors).toBe(1);
    expect(report.pairs[0].change).toBe('inconclusive');
  }, 180_000);

  it('stops a timed-out runner and its child before the child can write outside the trial', () => {
    suite.before = 'none';
    suite.after = 'none';
    suite.repetitions = 1;
    suite.timeoutMs = 3000;
    const escaped = path.join(root, 'escaped.txt');
    const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(escaped)}, 'orphan'), 5000);`;
    write(path.join(root, 'runner.cjs'), `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' }); setTimeout(() => {}, 20000);\n`);
    const { result, report } = run();
    expect(result.status).toBe(1);
    expect(report.trials).toHaveLength(2);
    expect(report.trials.every((trial: { error: string }) => trial.error.includes('timeout'))).toBe(true);
    expect(fs.existsSync(escaped)).toBe(false);
  }, 180_000);
});

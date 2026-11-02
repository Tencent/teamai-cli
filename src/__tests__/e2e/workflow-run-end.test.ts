/**
 * Real CLI: how a run ends. Its `finally` steps run after its steps end, whatever the outcome, its `outputs` reach
 * `done`, and `workflow start --timeout` bounds it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCLI(args: string[], cwd: string): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: process.env, stdio: 'pipe' });
}

function envelope(stdout: string): { data?: Record<string, unknown>; error?: { code: string; message: string } } {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

describe('how a run ends, through the CLI', () => {
  let repo: string;
  let out: string;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-finally-e2e-'));
    out = path.join(path.dirname(repo), `${path.basename(repo)}-out`);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
    if (out) fs.rmSync(out, { recursive: true, force: true });
  });

  it('runs finally after the only step fails, keeps the run failed, and returns an output finally wrote', async () => {
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    const marker = path.join(out, 'finally.txt');
    fs.writeFileSync(path.join(repo, 'report.js'), [
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      "process.stdout.write(JSON.stringify({ text: 'reported' }))",
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workflows, 'cleanup.yaml'), `schemaVersion: v1alpha1
name: cleanup
description: Fail, then report.
steps:
  - id: work
    command: node -e "process.exit(1)"
finally:
  - id: report
    command: node report.js
    output: { text: string }
outputs:
  text: steps.report.outputs.text
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const run = await runCLI(['workflow', 'start', 'cleanup', '--driver', 'local'], repo);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(envelope(run.stdout)).toMatchObject({ data: { done: { outcome: 'failed', outputs: { text: 'reported' } } } });
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran');
  });

  it('times a run out at the --timeout its start gave, and refuses a --timeout it cannot keep', async () => {
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'slow.yaml'), `schemaVersion: v1alpha1
name: slow
description: Wait half a minute.
timeout: 1h
steps:
  - id: wait
    command: node -e "setTimeout(() => {}, 30000)"
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const started = Date.now();
    const run = await runCLI(['workflow', 'start', 'slow', '--driver', 'local', '--timeout', '2s'], repo);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(envelope(run.stdout)).toMatchObject({ data: { done: { outcome: 'failed', failure: { code: 'timeout' } } } });
    expect(Date.now() - started).toBeLessThan(20_000);

    const refused = await runCLI(['workflow', 'start', 'slow', '--timeout', 'soon'], repo);
    expect(refused.code).toBe(1);
    expect(envelope(refused.stdout)).toEqual({ error: { code: 'invalid_arguments', message: '--timeout must be a positive duration, such as 500ms, 30s, 10m, or 2h' } });
  });
});


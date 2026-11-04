/**
 * Real CLI: how a run ends. Its `finally` steps run after its steps end, whatever the outcome, its `outputs` reach
 * `done`, `workflow start --timeout` bounds it, and its `$TEAMAI_RUN_DIR` is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
    expect(envelope(refused.stdout)).toEqual({ error: { code: 'invalid_arguments', message: '--timeout must be a positive duration, such as 500ms, 30s, 10m, 2h, or 14d' } });
  });

  it('gives every step of a run, sub-workflows included, one $TEAMAI_RUN_DIR, and removes it when the run ends, whatever the end', async () => {
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(repo, 'write.js'), [
      "const fs = require('fs');",
      "const dir = process.env.TEAMAI_RUN_DIR;",
      "fs.writeFileSync(require('path').join(dir, 'note.txt'), 'from write');",
      `fs.writeFileSync(require('path').join(${JSON.stringify(out)}, process.argv[2] + '.txt'), dir);`,
      "process.exit(process.argv[2] === 'fail' ? 1 : 0);",
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repo, 'read.js'), [
      "const note = require('fs').readFileSync(require('path').join(process.env.TEAMAI_RUN_DIR, 'note.txt'), 'utf8');",
      'process.stdout.write(JSON.stringify({ note }));',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workflows, 'shared.yaml'), `schemaVersion: v1alpha1
name: shared
description: Write a note in the run directory, then read it in a sub-workflow.
steps:
  - id: write
    command: node write.js pass
  - id: check
    needs: [write]
    workflow: shared-read
outputs:
  note: steps.check.outputs.note
`);
    fs.writeFileSync(path.join(workflows, 'shared-read.yaml'), `schemaVersion: v1alpha1
name: shared-read
description: Read the note the run left in its directory.
steps:
  - id: read
    command: node read.js
    output: { note: string }
outputs:
  note: steps.read.outputs.note
`);
    fs.writeFileSync(path.join(workflows, 'shared-fail.yaml'), `schemaVersion: v1alpha1
name: shared-fail
description: Write a note in the run directory, then fail.
steps:
  - id: write
    command: node write.js fail
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const passed = await runCLI(['workflow', 'start', 'shared', '--driver', 'local'], repo);
    expect(passed.code, `${passed.stdout}\n${passed.stderr}`).toBe(0);
    const done = envelope(passed.stdout);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { note: 'from write' } } } });
    const runId = String(z.object({ data: z.object({ done: z.object({ run: z.string() }) }) }).parse(done).data.done.run);
    const dir = fs.readFileSync(path.join(out, 'pass.txt'), 'utf8');
    expect(dir).toContain(runId);
    expect(fs.existsSync(dir), 'the run directory is gone once the run succeeded').toBe(false);
    expect(fs.readFileSync(path.join(path.dirname(path.dirname(dir)), `${runId}.json`), 'utf8')).not.toContain(dir);

    const failed = await runCLI(['workflow', 'start', 'shared-fail', '--driver', 'local'], repo);
    expect(failed.code, `${failed.stdout}\n${failed.stderr}`).toBe(1);
    const failedDir = fs.readFileSync(path.join(out, 'fail.txt'), 'utf8');
    expect(failedDir).not.toBe(dir);
    expect(fs.existsSync(failedDir), 'the run directory is gone once the run failed').toBe(false);
  });
});

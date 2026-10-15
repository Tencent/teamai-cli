/**
 * Real CLI: a two-command workflow finishes with --driver local, state survives
 * a process exit between next and report, and an invalid file does not block
 * the last valid version.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
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
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

describe('command workflow CLI', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-e2e-'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('completes two commands, keeps state across processes, and keeps the last valid version', async () => {
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);

    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(repo, 'one.js'), "require('fs').writeFileSync('step-one.txt', '1')\n");
    fs.writeFileSync(path.join(repo, 'two.js'), [
      "const fs = require('fs')",
      "if (fs.readFileSync('step-one.txt', 'utf8') !== '1') process.exit(1)",
      "fs.writeFileSync('step-two.txt', '2')",
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(workflows, 'build.yaml'), `schemaVersion: v1alpha1
name: build
description: Write a marker, then a second marker.
steps:
  - id: one
    command: node one.js
  - id: two
    needs: [one]
    command: node two.js
`);
    fs.writeFileSync(path.join(workflows, 'broken.yaml'), `schemaVersion: v1alpha1
name: other
description: This file does not match its name.
steps:
  - id: one
    command: node -e "process.exit(0)"
`);
    fs.writeFileSync(path.join(workflows, 'pause.yaml'), `schemaVersion: v1alpha1
name: pause
description: Two steps reported by separate processes.
steps:
  - id: one
    command: node -e "process.exit(0)"
  - id: two
    needs: [one]
    command: node -e "process.exit(0)"
`);

    const pulled = await runCLI(['pull'], repo);
    const pullOutput = `${pulled.stdout}\n${pulled.stderr}`;
    expect(pulled.code, pullOutput).toBe(0);
    expect(pullOutput).toContain('workflows/broken.yaml:2:');
    expect(pullOutput).toContain('field "name"');

    const completed = await runCLI(['workflow', 'start', 'build', '--driver', 'local'], repo);
    expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
    expect(envelope(completed.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(repo, 'step-two.txt'), 'utf8')).toBe('2');

    const started = await runCLI(['workflow', 'start', 'pause'], repo);
    expect(started.code, started.stdout).toBe(0);
    const runId = String(envelope(started.stdout).data?.run);
    const driver = JSON.stringify({ driver: { kind: 'local', machine: 'e2e', workspace: repo } });
    const leased = await runCLI(['workflow', 'next', runId, '--json', driver], repo);
    expect(leased.code, leased.stdout).toBe(0);
    const lease = envelope(leased.stdout).data?.lease as { attempt: string; revision: number; step: string };
    expect(lease.step).toBe('one');

    const reported = await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({
      attempt: lease.attempt,
      revision: lease.revision,
      outcome: 'success',
      driver: { kind: 'local', machine: 'e2e', workspace: repo },
    })], repo);
    expect(reported.code, reported.stdout).toBe(0);
    expect(envelope(reported.stdout).data).toMatchObject({ accepted: true, step: { status: 'succeeded' } });

    const second = await runCLI(['workflow', 'next', runId, '--json', driver], repo);
    const secondLease = envelope(second.stdout).data?.lease as { attempt: string; revision: number; step: string };
    expect(secondLease.step).toBe('two');
    const finished = await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({
      attempt: secondLease.attempt,
      revision: secondLease.revision,
      outcome: 'success',
      driver: { kind: 'local', machine: 'e2e', workspace: repo },
    })], repo);
    expect(envelope(finished.stdout).data).toMatchObject({ accepted: true });
    const done = await runCLI(['workflow', 'next', runId, '--json', driver], repo);
    expect(envelope(done.stdout).data).toMatchObject({ done: { outcome: 'succeeded' } });

    fs.rmSync(path.join(repo, 'step-one.txt'));
    fs.rmSync(path.join(repo, 'step-two.txt'));
    fs.writeFileSync(path.join(workflows, 'build.yaml'), 'schemaVersion: [\n');
    const repulled = await runCLI(['pull'], repo);
    const repullOutput = `${repulled.stdout}\n${repulled.stderr}`;
    expect(repulled.code, repullOutput).toBe(0);
    expect(repullOutput).toContain('workflows/build.yaml:');
    expect(repullOutput).toContain('Kept the last valid version of build');

    const cached = await runCLI(['workflow', 'start', 'build', '--driver', 'local'], repo);
    expect(cached.code, `${cached.stdout}\n${cached.stderr}`).toBe(0);
    expect(envelope(cached.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(repo, 'step-two.txt'), 'utf8')).toBe('2');

    const missing = await runCLI(['workflow', 'start', 'broken', '--driver', 'local'], repo);
    expect(missing.code, missing.stdout).toBe(1);
    expect(envelope(missing.stdout).error?.code).toBe('workflow_not_found');

    fs.writeFileSync(path.join(workflows, 'fail.yaml'), `schemaVersion: v1alpha1
name: fail
description: A command that exits with an error.
steps:
  - id: fail
    command: node -e "process.exit(1)"
`);
    const failPull = await runCLI(['pull'], repo);
    expect(failPull.code, `${failPull.stdout}\n${failPull.stderr}`).toBe(0);
    const failed = await runCLI(['workflow', 'start', 'fail', '--driver', 'local'], repo);
    expect(failed.code, `${failed.stdout}\n${failed.stderr}`).toBe(1);
    expect(envelope(failed.stdout)).toMatchObject({ data: { done: { outcome: 'failed' } } });
  });
});

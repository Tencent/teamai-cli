/**
 * Real CLI: `workflow start --inputs` validates the inputs before a run exists,
 * and an input reaches a command only as an env variable, never as shell.
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
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

describe('workflow inputs CLI', () => {
  let repo: string;
  let out: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-inputs-e2e-'));
    out = path.join(path.dirname(repo), `${path.basename(repo)}-out`);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('rejects bad inputs before a run and passes an input to a command only through env', async () => {
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);

    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'label.yaml'), `schemaVersion: v1alpha1
name: label
description: Write the issue title to a file.
inputs:
  issue: number
  title: string
steps:
  - id: write
    command: node -e "require('fs').writeFileSync('${path.join(out, 'title.txt')}', process.env.TITLE)"
    env:
      TITLE: "{{ inputs.title }}"
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const missing = await runCLI(['workflow', 'start', 'label', '--driver', 'local', '--inputs', '{"issue":42}'], repo);
    expect(missing.code, missing.stdout).toBe(1);
    expect(envelope(missing.stdout)).toEqual({ error: { code: 'invalid_inputs', message: 'inputs.title is missing' } });
    expect(fs.existsSync(path.join(out, 'title.txt'))).toBe(false);

    const started = await runCLI(['workflow', 'start', 'label', '--driver', 'local', '--inputs', '{"issue":42,"title":"$(touch pwned)"}'], repo);
    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    expect(envelope(started.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(out, 'title.txt'), 'utf8')).toBe('$(touch pwned)');
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
  });

  it('runs a step whose if reads an array element, compares numbers and calls any, and skips one that calls length', async () => {
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);

    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'triage.yaml'), `schemaVersion: v1alpha1
name: triage
description: Label the first issue when it is small and another issue is large.
inputs:
  issues: [{ title: string, size: number }]
steps:
  - id: label
    if: inputs.issues[0].size < 10 && any(inputs.issues, .size >= 100)
    command: node -e "require('fs').writeFileSync('${path.join(out, 'label.txt')}', process.env.TITLE)"
    env:
      TITLE: "{{ inputs.issues[0].title }}"
  - id: many
    needs: []
    if: length(inputs.issues) > 2
    command: node -e "require('fs').writeFileSync('${path.join(out, 'many.txt')}', 'ran')"
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const started = await runCLI(['workflow', 'start', 'triage', '--driver', 'local', '--inputs', '{"issues":[{"title":"typo","size":3},{"title":"rewrite","size":400}]}'], repo);
    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    expect(envelope(started.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(out, 'label.txt'), 'utf8')).toBe('typo');
    expect(fs.existsSync(path.join(out, 'many.txt'))).toBe(false);
  });
});

/**
 * Real CLI: a workflow runs a file sub-workflow with typed `with` values. The child's end and outputs
 * reach the parent, an input reaches a command only through env, and a recovered failure still fails the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState } from '../../workflow/types.js';

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

const CHECK_ISSUE = `schemaVersion: v1alpha1
name: check-issue
description: Record the issue title and classify the issue.
inputs:
  issue: number
  title: string
ends:
  ready: succeeded
outputs:
  verdict: steps.classify.outputs.verdict
steps:
  - id: write
    command: node -e "require('fs').writeFileSync('__OUT__/title.txt', process.env.TITLE)"
    env:
      TITLE: "{{ inputs.title }}"
  - id: classify
    needs: [write]
    command: node -e "process.stdout.write(JSON.stringify({verdict:process.env.ISSUE==='42'?'fix':'drop'}))"
    env:
      ISSUE: "{{ inputs.issue }}"
    output:
      verdict: fix | drop
  - id: done
    needs: [classify]
    end: ready
`;

const SHIP = `schemaVersion: v1alpha1
name: ship
description: Check the issue, try a fix, and label it when the fix fails.
inputs:
  issue: number
  title: string
steps:
  - id: check
    workflow: check-issue
    with:
      issue: "{{ inputs.issue }}"
      title: "{{ inputs.title }}"
  - id: fix
    needs: [check]
    if: steps.check.end == 'ready' && steps.check.outputs.verdict == 'fix'
    command: node -e "require('fs').writeFileSync('__OUT__/fix.txt', process.env.END + ' ' + process.env.VERDICT); process.exit(1)"
    env:
      END: "{{ steps.check.end }}"
      VERDICT: "{{ steps.check.outputs.verdict }}"
  - id: label
    needs: [fix]
    if: steps.fix.outcome == 'failed'
    command: node -e "require('fs').writeFileSync('__OUT__/label.txt', 'needs-human')"
`;

describe('workflow sub-workflow CLI', () => {
  let repo: string;
  let out: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-subworkflow-e2e-'));
    out = path.join(path.dirname(repo), `${path.basename(repo)}-out`);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('runs a child with ends and outputs, keeps an input literal, and fails after a recovered failure', async () => {
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'check-issue.yaml'), CHECK_ISSUE.replaceAll('__OUT__', out));
    fs.writeFileSync(path.join(workflows, 'ship.yaml'), SHIP.replaceAll('__OUT__', out));
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const started = await runCLI(['workflow', 'start', 'ship', '--driver', 'local', '--inputs', '{"issue":42,"title":"$(touch pwned)"}'], repo);

    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(1);
    const done = envelope(started.stdout).data?.done as { run: string; outcome: string; end?: string };
    expect(done).toEqual({ run: expect.any(String), outcome: 'failed', record: 'pending' });
    expect(fs.readFileSync(path.join(out, 'title.txt'), 'utf8')).toBe('$(touch pwned)');
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'fix.txt'), 'utf8')).toBe('ready fix');
    expect(fs.readFileSync(path.join(out, 'label.txt'), 'utf8')).toBe('needs-human');
    const dataHome = await resolveProjectDataHome(repo);
    const run = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${done.run}.json`), 'utf8')) as RunState;
    expect(run.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
      'check:succeeded',
      'check.write:succeeded',
      'check.classify:succeeded',
      'check.done:succeeded',
      'fix:failed',
      'label:succeeded',
    ]);
    expect(run.steps[0]).toMatchObject({ end: 'ready', outputs: { verdict: 'fix' }, inputs: { issue: 42, title: '$(touch pwned)' } });
  });
});

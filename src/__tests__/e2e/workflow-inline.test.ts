/**
 * Real CLI: a step runs an inline workflow. Its steps read the enclosing inputs and a step the enclosing step needs,
 * its end finishes only the inline workflow, and the parent reads its end and outputs.
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

const SHIP_INLINE = `schemaVersion: v1alpha1
name: ship-inline
description: Plan, check the issue inline, and fix it when the check says so.
inputs:
  title: string
steps:
  - id: plan
    command: node -e "process.stdout.write(JSON.stringify({task:'fix'}))"
    output:
      task: string
  - id: check
    needs: [plan]
    workflow:
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
          command: node -e "process.stdout.write(JSON.stringify({verdict:process.env.TASK}))"
          env:
            TASK: "{{ steps.plan.outputs.task }}"
          output:
            verdict: fix | drop
        - id: done
          needs: [classify]
          end: ready
        - id: never
          needs: [classify]
          command: node -e "require('fs').writeFileSync('__OUT__/never.txt', 'ran')"
  - id: fix
    needs: [check]
    if: steps.check.end == 'ready'
    command: node -e "require('fs').writeFileSync('__OUT__/fix.txt', process.env.END + ' ' + process.env.VERDICT)"
    env:
      END: "{{ steps.check.end }}"
      VERDICT: "{{ steps.check.outputs.verdict }}"
`;

describe('workflow inline CLI', () => {
  let repo: string;
  let out: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-inline-e2e-'));
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

  it('runs an inline workflow that reads the enclosing scope, and the parent reads its end and outputs', async () => {
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'ship-inline.yaml'), SHIP_INLINE.replaceAll('__OUT__', out));
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const started = await runCLI(['workflow', 'start', 'ship-inline', '--driver', 'local', '--inputs', '{"title":"$(touch pwned)"}'], repo);

    expect(started.code, `${started.stdout}\n${started.stderr}`).toBe(0);
    const done = envelope(started.stdout).data?.done as { run: string; outcome: string };
    expect(done).toEqual({ run: expect.any(String), outcome: 'succeeded', record: 'pending' });
    expect(fs.readFileSync(path.join(out, 'title.txt'), 'utf8')).toBe('$(touch pwned)');
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'never.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'fix.txt'), 'utf8')).toBe('ready fix');
    const dataHome = await resolveProjectDataHome(repo);
    const run = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${done.run}.json`), 'utf8')) as RunState;
    expect(run.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
      'plan:succeeded',
      'check:succeeded',
      'check.write:succeeded',
      'check.classify:succeeded',
      'check.done:succeeded',
      'check.never:skipped',
      'fix:succeeded',
    ]);
    expect(run.steps[1]).toMatchObject({ end: 'ready', outputs: { verdict: 'fix' } });
  });
});

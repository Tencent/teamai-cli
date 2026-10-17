import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function envelope(stdout: string): WorkflowEnvelope {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as WorkflowEnvelope;
}

describe('local prompt workflow CLI', () => {
  let repo: string;
  let bin: string;

  beforeAll(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-prompt-e2e-'));
    bin = path.join(repo, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    const fake = path.join(bin, 'claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync(require('node:path').dirname(process.env.TEAMAI_WORKFLOW_RESULT), { recursive: true });
fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true } }));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: 'fake-session' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: 'fake-session',
  usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 }
}) + '\\n');
`);
    fs.chmodSync(fake, 0o755);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('runs a command and prompt step with a fake claude executable', async () => {
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'prompt.yaml'), `schemaVersion: v1alpha1
name: prompt
description: Exercise the local prompt adapter.
steps:
  - id: prepare
    command: node -e "process.stdout.write(JSON.stringify({ready:true}))"
    output:
      ready: boolean
  - id: review
    needs: [prepare]
    prompt: Review the repository without changing it.
    output:
      ok: boolean
`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    const nested = path.join(repo, 'packages', 'api');
    fs.mkdirSync(nested, { recursive: true });
    const result = await runCLI(
      ['workflow', 'start', 'prompt', '--driver', 'local', '--tools', 'default=claude'],
      nested,
      { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    );

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const completed = envelope(result.stdout);
    expect(completed).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    if ('error' in completed) throw new Error(completed.error.message);
    const runId = String((completed.data.done as { run: string }).run);
    const dataHome = await resolveProjectDataHome(repo);
    const stored = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
    expect(stored.steps[1]).toMatchObject({
      status: 'succeeded',
      tool: 'claude',
      model: 'fake-claude',
      session: 'fake-session',
      outputs: { ok: true },
    });
    const resultFile = path.join(dataHome, 'workflows', 'runs', runId, 'attempts');
    expect(fs.readdirSync(resultFile)).toHaveLength(2);
    expect(path.resolve(resultFile).startsWith(`${path.resolve(repo)}${path.sep}`)).toBe(false);
  });
});

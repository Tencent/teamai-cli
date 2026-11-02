/**
 * Real CLI: `on_limit: end_turn` on an ordinary workflow, run by the local driver. A limit ends the agent's turn, the
 * step succeeds with that limit, and what needs it runs.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveProjectDataHome } from '../../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const DoneSchema = z.object({ data: z.object({ done: z.object({ run: z.string(), outcome: z.string() }).passthrough() }) });
const StoredSchema = z.object({ steps: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()) });

/** A claude that starts a session, states its usage, then works until it is stopped. */
const HANGING_CLAUDE = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-claude', session_id: 'fake-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 4, output_tokens: 2 } } }) + '\\n');
setInterval(() => {}, 1000);
`;

function runCLI(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...extraEnv, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function lastEnvelope(stdout: string): unknown {
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line);
}

describe('on_limit: end_turn on the local driver', () => {
  let repo: string;
  let bin: string;

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-on-limit-e2e-'));
    bin = path.join(repo, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], { cwd: repo });
    const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
    fs.writeFileSync(path.join(bin, 'claude'), HANGING_CLAUDE);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  });

  afterEach(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  /** Starts `workflow` locally on the fake claude, and reads the run it settled. */
  async function run(workflow: string): Promise<{ done: z.infer<typeof DoneSchema>['data']['done']; steps: z.infer<typeof StoredSchema>['steps'] }> {
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'limited.yaml'), workflow);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    const started = await runCLI(['workflow', 'start', 'limited', '--driver', 'local', '--tools', 'default=claude'], repo, {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    });
    const parsed = DoneSchema.safeParse(lastEnvelope(started.stdout));
    if (!parsed.success) throw new Error(`${started.stdout}\n${started.stderr}`);
    const dataHome = await resolveProjectDataHome(repo);
    const stored = StoredSchema.parse(JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${parsed.data.data.done.run}.json`), 'utf8')));
    return { done: parsed.data.data.done, steps: stored.steps };
  }

  it('ends a prompt\'s turn at its timeout, settles it succeeded with that limit, and runs the command that needs it', async () => {
    const { done, steps } = await run(`schemaVersion: v1alpha1
name: limited
description: A prompt whose turn its timeout ends.
steps:
  - id: work
    prompt: Work until you are stopped.
    timeout: 2s
    on_limit: end_turn
  - id: after
    needs: [work]
    command: node -e "process.stdout.write('ran')"
`);

    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(steps.find((step) => step.id === 'work')).toMatchObject({ status: 'succeeded', limit: 'timeout' });
    expect(steps.find((step) => step.id === 'after')).toMatchObject({ status: 'succeeded' });
  }, 60_000);
});

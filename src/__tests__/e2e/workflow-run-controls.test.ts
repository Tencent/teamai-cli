import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';
import type { RunState, WorkflowEnvelope } from '../../workflow/types.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
interface Result { code: number | null; stdout: string; stderr: string }
function runCLI(args: string[], cwd: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
function envelope(result: Result): WorkflowEnvelope {
  const lines = result.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  expect(lines, result.stderr).toHaveLength(1);
  return JSON.parse(lines[0]!) as WorkflowEnvelope;
}
function data(result: Result): Record<string, unknown> {
  const value = envelope(result);
  expect(value, result.stderr).toHaveProperty('data');
  if ('error' in value) throw new Error(value.error.message);
  return value.data;
}
async function waitFor(check: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The local command did not start within five seconds');
}

describe('workflow manual controls through the CLI', () => {
  let repo: string;
  let dataHome: string;
  beforeEach(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-run-controls-')));
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], ['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git']]) execFileSync('git', args, { cwd: repo });
    // These names are how a command shows which checkout it ran in. A command with no workspace is read-only, so they stay out of git status.
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'started\nfixed\ndependent\nin-workspace\napproved\n');
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    dataHome = await resolveProjectDataHome(repo);
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
  async function define(steps: string, header = ''): Promise<void> {
    const directory = path.join(repo, '.teamai/workflows');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'build.yaml'), `schemaVersion: v1alpha1\nname: build\ndescription: Exercise run controls.\n${header}steps:\n${steps}\n`);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  }
  function state(id: string): RunState { return JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows/runs', `${id}.json`), 'utf8')) as RunState; }
  const driver = () => ({ kind: 'local', machine: os.hostname(), workspace: repo, can: { hitl: true } });

  it('opens a HITL request, answers from another process, and returns the guarded lease', async () => {
    await define('  - id: build\n    approve: Build it?\n    command: echo build');
    const id = String(data(await runCLI(['workflow', 'start', 'build'], repo)).run);
    const next = ['workflow', 'next', id, '--json', JSON.stringify({ driver: driver() })];
    expect(data(await runCLI(next, repo))).toMatchObject({ hitl: { step: 'build', pass: 1, respond: `teamai workflow respond ${id} build <option> --pass 1` } });
    const response = await runCLI(['workflow', 'respond', id, 'build', 'yes', '--pass', '1', '--note', 'Ready'], repo);
    expect(response.code).toBe(0);
    expect(data(response)).toMatchObject({ answered: { channel: 'cli', choice: 'yes' }, run: { revision: 1 } });
    expect(data(await runCLI(next, repo))).toMatchObject({ lease: { step: 'build' } });
    expect(state(id).steps[0]?.answer).toMatchObject({ note: 'Ready', agent: true });
  });

  it('advertises a shell-safe respond command for a fan-out HITL request', async () => {
    await define('  - id: items\n    for_each: inputs.items\n    workflow:\n      steps:\n        - id: ask\n          approve: Continue?', 'inputs: { items: [string] }\n');
    const id = String(data(await runCLI(['workflow', 'start', 'build', '--inputs', '{"items":["a"]}'], repo)).run);
    const hitl = data(await runCLI(['workflow', 'next', id, '--json', JSON.stringify({ driver: driver() })], repo)).hitl as { respond: string };
    const zsh = spawnSync('zsh', ['--version'], { encoding: 'utf8' });
    if (zsh.error) expect(zsh.error).toHaveProperty('code', 'ENOENT');
    else {
      const command = `teamai() { '${process.execPath}' '${CLI}' "$@"; }\n${hitl.respond.replace('<option>', 'yes')}`;
      const response = spawnSync('zsh', ['-f', '-c', command], { cwd: repo, env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf8' });
      expect(response.status, response.stderr).toBe(0);
      expect(data({ code: response.status, stdout: response.stdout, stderr: response.stderr })).toMatchObject({
        answered: { step: 'items[0].ask', choice: 'yes', channel: 'cli' }, run: { status: 'succeeded' },
      });
    }
    expect(hitl.respond).toBe(`teamai workflow respond ${id} 'items[0].ask' <option> --pass 1`);
  });

  it('stops a long sleep from a second process and exits with cancelled', async () => {
    await define('  - id: sleep\n    command: echo started > started; exec sleep 30');
    const driving = runCLI(['workflow', 'start', 'build', '--driver', 'local'], repo);
    await waitFor(() => fs.existsSync(path.join(repo, 'started')));
    const id = fs.readdirSync(path.join(dataHome, 'workflows/runs')).find((name) => /^r[0-9a-f]+\.json$/.test(name))!.slice(0, -5);
    const duplicate = await runCLI(['workflow', 'resume', id], repo);
    expect(duplicate.code).toBe(1);
    expect(envelope(duplicate)).toMatchObject({ error: { code: 'driver_running', message: expect.stringMatching(/already driven by process [0-9]+/) } });
    const cancelled = await runCLI(['workflow', 'cancel', id], repo);
    expect(cancelled.code).toBe(0);
    expect(data(cancelled)).toMatchObject({ run: { status: 'cancelled' } });
    const result = await driving;
    expect(result.code).toBe(1);
    expect(data(result)).toMatchObject({ done: { outcome: 'cancelled' } });
    expect(state(id).status).toBe('cancelled');
    expect(state(id).failure).toBeUndefined();
  }, 15000);

  it('retries a failed step, then resumes and runs its skipped dependent', async () => {
    fs.writeFileSync(path.join(repo, 'build.cjs'), "if (!require('fs').existsSync('fixed')) process.exit(1)\n");
    await define('  - id: build\n    command: node build.cjs\n  - id: later\n    needs: [build]\n    command: echo ran > dependent');
    const failed = await runCLI(['workflow', 'start', 'build', '--driver', 'local'], repo);
    expect(failed.code).toBe(1);
    const done = data(failed).done as { run: string; outcome: string };
    expect(done.outcome).toBe('failed');
    expect(state(done.run).steps[1]?.status).toBe('skipped');
    fs.writeFileSync(path.join(repo, 'fixed'), '');
    const retried = await runCLI(['workflow', 'retry', done.run, 'build'], repo);
    expect(retried.code).toBe(0);
    expect(data(retried)).toMatchObject({ retried: { step: 'build', pass: 2 }, reopened: true });
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    const resumed = await runCLI(['workflow', 'resume', done.run], sub);
    expect(resumed.code).toBe(0);
    expect(data(resumed)).toMatchObject({ done: { outcome: 'succeeded' } });
    expect(fs.readFileSync(path.join(repo, 'dependent'), 'utf8').trim()).toBe('ran');
    expect(state(done.run).steps[0]?.passes?.[0]?.outcome).toBe('failed');
  });

  it('resumes in the original workspace after answering the first HITL request before any lease', async () => {
    await define('  - id: decide\n    choose: { message: Continue?, options: [build, stop] }\n  - id: work\n    needs: [decide]\n    command: echo ran > in-workspace');
    const id = String(data(await runCLI(['workflow', 'start', 'build'], repo)).run);
    expect(data(await runCLI(['workflow', 'next', id, '--json', JSON.stringify({ driver: driver() })], repo))).toMatchObject({ hitl: { step: 'decide' } });
    expect(state(id).steps.some((step) => step.status === 'leased')).toBe(false);
    const response = await runCLI(['workflow', 'respond', id, 'decide', 'build', '--pass', '1'], repo);
    expect(response.code).toBe(0);
    expect(data(response)).toMatchObject({ answered: { choice: 'build' }, run: { status: 'running' } });
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    const resumed = await runCLI(['workflow', 'resume', id], sub);
    expect(resumed.code).toBe(0);
    expect(data(resumed)).toMatchObject({ done: { outcome: 'succeeded' } });
    expect(fs.readFileSync(path.join(repo, 'in-workspace'), 'utf8').trim()).toBe('ran');
    expect(fs.existsSync(path.join(sub, 'in-workspace'))).toBe(false);
  });

  it('resumes from a subdirectory in the open local lease workspace', async () => {
    await define('  - id: work\n    command: echo ran > in-workspace');
    const id = String(data(await runCLI(['workflow', 'start', 'build'], repo)).run);
    expect(data(await runCLI(['workflow', 'next', id, '--json', JSON.stringify({ driver: driver() })], repo))).toHaveProperty('lease');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub);
    expect((await runCLI(['workflow', 'resume', id], sub)).code).toBe(0);
    expect(fs.existsSync(path.join(repo, 'in-workspace'))).toBe(true);
    expect(fs.existsSync(path.join(sub, 'in-workspace'))).toBe(false);
  });

  it.each(['start', 'resume'])('supports process-only auto approval on %s', async (command) => {
    await define('  - id: ask\n    approve: Continue?\n    command: echo ran > approved');
    const args = command === 'start' ? ['workflow', 'start', 'build', '--driver', 'local', '--auto-approve']
      : ['workflow', 'resume', String(data(await runCLI(['workflow', 'start', 'build'], repo)).run), '--auto-approve'];
    const result = await runCLI(args, repo);
    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(repo, 'approved'))).toBe(true);
    const done = data(result).done as { run: string };
    expect(state(done.run).steps[0]?.answer?.channel).toBe('auto_approve');
    expect(result.stderr).toContain('Step "ask" was approved by auto_approve.');
  });

  it('rejects invalid pass values and disallows auto approval in the JSON payload', async () => {
    await define('  - id: ask\n    approve: Continue?\n    command: echo ran > approved');
    const id = String(data(await runCLI(['workflow', 'start', 'build'], repo)).run);
    for (const pass of ['0', '-1', '1.5', 'text']) {
      const result = await runCLI(['workflow', 'respond', id, 'ask', 'yes', '--pass', pass], repo);
      expect(result.code).toBe(1);
      expect(envelope(result)).toMatchObject({ error: { code: 'invalid_pass' } });
    }
    const result = await runCLI(['workflow', 'next', id, '--json', JSON.stringify({ driver: { ...driver(), can: { hitl: false } }, autoApprove: true })], repo);
    expect(data(result)).toMatchObject({ done: { outcome: 'succeeded' }, ignored: ['autoApprove'] });
    expect(state(id).steps[0]?.answer).toMatchObject({ choice: 'no', channel: 'no_hitl' });
    expect(result.stderr).toContain('Step "ask" was skipped: its approve HITL request needs a person');
  });
});

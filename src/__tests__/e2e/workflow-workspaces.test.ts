/**
 * Real CLI: workspace: new steps commit on their own branches, a later step
 * merges them, the branches are pushed to origin, and the active checkout is
 * left untouched. A command with no workspace that writes a file fails. A
 * merge of two writes to the same path fails and names the branch.
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

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8' });
}

function envelope(stdout: string): { data?: Record<string, unknown>; error?: { code: string; message: string } } {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

const CHANGE = `schemaVersion: v1alpha1
name: change
description: Two change branches joined by a third, then one branch per item.
inputs:
  names: [string]
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "const fs=require('fs'); if (fs.readFileSync('left.txt','utf8')!=='L' || fs.readFileSync('right.txt','utf8')!=='R') process.exit(1); fs.writeFileSync('joined.txt','J')"
  - id: fan
    needs: [join]
    for_each:
      items: inputs.names
    workspace: new
    command: node -e "require('fs').writeFileSync('item.txt', process.env.NAME)"
    env:
      NAME: "{{ item }}"
`;

const DIRTY = `schemaVersion: v1alpha1
name: dirty
description: A command with no workspace must not change the checkout.
steps:
  - id: write
    command: node -e "require('fs').writeFileSync('dirty.txt', 'x')"
`;

const CLASH = `schemaVersion: v1alpha1
name: clash
description: Two branches write the same path, so the join cannot merge.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('same.txt', 'L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('same.txt', 'R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "process.exit(0)"
`;

describe('workflow workspaces CLI', () => {
  let repo: string;
  let bare: string;
  let head: string;

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workspace-e2e-'));
    repo = path.join(root, 'checkout');
    bare = path.join(root, 'origin.git');
    fs.mkdirSync(repo);
    fs.mkdirSync(bare);
    git(['init', '-q', '--bare', '-b', 'main'], bare);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'tracked.txt'], repo);
    git(['commit', '-q', '-m', 'base'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
  });

  afterAll(() => {
    if (repo) fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  });

  it('joins branches, pushes them, leaves the checkout, and fails a read-only write and a merge conflict', async () => {
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    git(['remote', 'set-url', 'origin', bare], repo);
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'change.yaml'), CHANGE);
    fs.writeFileSync(path.join(workflows, 'dirty.yaml'), DIRTY);
    fs.writeFileSync(path.join(workflows, 'clash.yaml'), CLASH);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
    head = git(['rev-parse', 'HEAD'], repo).trim();

    const changed = await runCLI(['workflow', 'start', 'change', '--driver', 'local', '--inputs', '{"names":["a","b"]}'], repo);
    expect(changed.code, `${changed.stdout}\n${changed.stderr}`).toBe(0);
    const done = envelope(changed.stdout).data?.done as { run: string; outcome: string };
    expect(done).toMatchObject({ outcome: 'succeeded' });
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head);
    expect(git(['diff', '--stat'], repo).trim()).toBe('');
    expect(git(['status', '--porcelain', '--', 'tracked.txt', 'left.txt', 'right.txt', 'joined.txt', 'item.txt', 'same.txt', 'dirty.txt'], repo).trim()).toBe('');
    expect(fs.existsSync(path.join(repo, 'left.txt'))).toBe(false);

    const dataHome = await resolveProjectDataHome(repo);
    const run = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${done.run}.json`), 'utf8')) as RunState;
    const join = run.steps.find((step) => step.id === 'join');
    const fan = run.steps.find((step) => step.id === 'fan');
    const branch = join && 'changes' in join ? join.changes?.branch : undefined;
    expect(branch).toMatch(/\/join\/p1$/);
    expect(git(['show', `${branch}:joined.txt`], repo)).toBe('J');
    expect(git(['show', `${branch}:left.txt`], repo)).toBe('L');
    expect(git(['show', `${branch}:right.txt`], repo)).toBe('R');
    expect(fan && 'results' in fan && fan.results?.map((item) => item.branch)).toEqual([
      expect.stringMatching(/\/fan-0\/p1$/),
      expect.stringMatching(/\/fan-1\/p1$/),
    ]);
    const remote = git(['ls-remote', '--heads', 'origin'], repo);
    for (const name of ['left', 'right', 'join', 'fan-0', 'fan-1']) {
      expect(remote, name).toContain(`refs/heads/teamai/${done.run}/${name}/p1`);
    }

    const dirty = await runCLI(['workflow', 'start', 'dirty', '--driver', 'local'], repo);
    expect(dirty.code, `${dirty.stdout}\n${dirty.stderr}`).toBe(1);
    const dirtyDone = envelope(dirty.stdout).data?.done as { run: string; outcome: string };
    expect(dirtyDone).toMatchObject({ outcome: 'failed' });
    const dirtyRun = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${dirtyDone.run}.json`), 'utf8')) as RunState;
    expect(dirtyRun.steps[0]).toMatchObject({ status: 'failed', failure: { code: 'read_only_dirty' } });
    expect(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8')).toBe('x');
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head);

    const clash = await runCLI(['workflow', 'start', 'clash', '--driver', 'local'], repo);
    expect(clash.code, `${clash.stdout}\n${clash.stderr}`).toBe(1);
    const clashDone = envelope(clash.stdout).data?.done as { run: string; outcome: string };
    const clashRun = JSON.parse(fs.readFileSync(path.join(dataHome, 'workflows', 'runs', `${clashDone.run}.json`), 'utf8')) as RunState;
    const clashJoin = clashRun.steps.find((step) => step.id === 'join');
    expect(clashJoin).toMatchObject({ status: 'failed', failure: { code: 'merge_conflict' } });
    expect(clashJoin && 'failure' in clashJoin ? clashJoin.failure?.message : '').toContain('same.txt');
    expect(fs.existsSync(path.join(repo, 'same.txt'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head);
  });
});

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
  const line = stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
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
    // A prompt "Write fixed to a.txt." writes that file in the step's checkout, as an agent editing code would.
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const [, text, file] = /Write (\\w+) to ([\\w.]+)\\./.exec(process.argv.join(' ')) ?? [];
if (file) fs.writeFileSync(file, text);
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

  it('keeps the fix of a for_each item for the items after it and the step that joins them', async () => {
    // Steps that write push their branches, so this checkout has an origin that takes them.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-factory-e2e-'));
    const work = path.join(root, 'work');
    const origin = path.join(root, 'origin.git');
    const url = 'http://127.0.0.1:9/team/app.git';
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      fs.mkdirSync(work);
      fs.writeFileSync(path.join(work, 'check.js'), "process.exit(require('fs').readFileSync(process.env.FILE, 'utf8') === 'fixed' ? 0 : 1);\n");
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
      execFileSync('git', ['add', 'check.js'], { cwd: work });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: work });
      execFileSync('git', ['remote', 'add', 'origin', url], { cwd: work });
      const initialized = await runCLI(['init', '--self', '--agent', 'claude', '--force'], work);
      expect(initialized.code, `${initialized.stdout}\n${initialized.stderr}`).toBe(0);
      // After init, which names the team repository from the remote URL as written.
      execFileSync('git', ['config', `url.${origin}.insteadOf`, url], { cwd: work });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: work });
      const workflows = path.join(work, '.teamai', 'workflows');
      fs.mkdirSync(workflows, { recursive: true });
      // Item a is written broken and fixed once; item b starts from a and is right the first time.
      fs.writeFileSync(path.join(workflows, 'factory.yaml'), `schemaVersion: v1alpha1
name: factory
description: Implement each item and fix it until its check passes, then document them together.
inputs:
  items: [{ id: string, first: string, after: [string] }]
steps:
  - id: build
    for_each:
      items: inputs.items
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: Write {{ item.first }} to {{ item.id }}.txt.
        - id: check
          needs: [implement]
          command: node check.js
          env:
            FILE: "{{ item.id }}.txt"
        - id: fix
          needs: [check]
          if: steps.check.outcome == 'failed'
          prompt: Write fixed to {{ item.id }}.txt.
          loop: { back_to: check, max_iterations: 2 }
  - id: docs
    needs: [build]
    workspace: new
    prompt: Write documented to docs.txt.
`);
      const pulled = await runCLI(['pull'], work);
      expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
      const items = [{ id: 'a', first: 'broken', after: [] }, { id: 'b', first: 'fixed', after: ['a'] }];
      const result = await runCLI(
        ['workflow', 'start', 'factory', '--driver', 'local', '--tools', 'default=claude', '--inputs', JSON.stringify({ items })],
        work,
        { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
      );

      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      const completed = envelope(result.stdout);
      expect(completed).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      if ('error' in completed) throw new Error(completed.error.message);
      const runId = String((completed.data.done as { run: string }).run);
      const stored = JSON.parse(fs.readFileSync(path.join(await resolveProjectDataHome(work), 'workflows', 'runs', `${runId}.json`), 'utf8')) as RunState;
      const build = stored.steps.find((step) => step.id === 'build');
      const itemBranches = build && 'results' in build ? build.results?.map((item) => item.branch) : undefined;
      // The run deleted the item branches once docs held them, so read the commit it recorded for each.
      const itemCommit = (index: number) => stored.copies?.[itemBranches?.[index] ?? '']?.commit;
      const onItem = (index: number, file: string): string => execFileSync('git', ['show', `${itemCommit(index)}:${file}`], { cwd: origin, encoding: 'utf8' });
      expect({ a: onItem(0, 'a.txt'), aInB: onItem(1, 'a.txt'), b: onItem(1, 'b.txt') }).toEqual({ a: 'fixed', aInB: 'fixed', b: 'fixed' });
      const docs = stored.steps.find((step) => step.id === 'docs');
      const branch = docs && 'changes' in docs ? docs.changes?.branch : undefined;
      if (!branch) throw new Error(`docs wrote no branch: ${JSON.stringify(docs)}`);
      const show = (file: string): string => execFileSync('git', ['show', `${branch}:${file}`], { cwd: origin, encoding: 'utf8' });
      expect({ a: show('a.txt'), b: show('b.txt'), docs: show('docs.txt') }).toEqual({ a: 'fixed', b: 'fixed', docs: 'documented' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

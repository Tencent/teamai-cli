/**
 * Real CLI: a step loop runs a set number of passes, then a `for_each` of two
 * items meets at a barrier, and a last step records what it reads of both.
 * With `workflows.max_parallel: 2` the items overlap and the run succeeds.
 * With 1 the first item times out alone, and its failure cancels no sibling.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectDataHome } from '../../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const TICK = `const fs = require('fs');
const path = require('path');
const file = path.join(process.env.OUT, 'ticks.txt');
const count = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
fs.writeFileSync(file, String(count));
console.log(JSON.stringify({ count }));
`;

const BARRIER = `const fs = require('fs');
const path = require('path');
const { ME: me, OTHER: other, OUT: out } = process.env;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, me + '.ready'), '');
const deadline = Date.now() + 3000;
setInterval(() => {
  if (fs.existsSync(path.join(out, other + '.ready'))) process.exit(0);
  if (Date.now() > deadline) { console.error(me + ' never saw ' + other); process.exit(1); }
}, 20);
`;

const RECORD = `const path = require('path');
require('fs').writeFileSync(path.join(process.env.OUT, 'record.json'), JSON.stringify({
  passes: JSON.parse(process.env.PASSES),
  results: JSON.parse(process.env.RESULTS),
}));
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: loop-and-fan
description: Count to three in a loop, meet two items at a barrier, then record both.
inputs:
  pairs: [{ me: string, other: string }]
steps:
  - id: tick
    command: node tick.js
    env:
      OUT: ${JSON.stringify('')}
    output:
      count: number
    loop: { back_to: tick, while: "steps.tick.outputs.count < 3", max_iterations: 5 }
  - id: meet
    needs: [tick]
    workspace: new
    for_each: inputs.pairs
    command: node barrier.js
    env:
      ME: "{{ item.me }}"
      OTHER: "{{ item.other }}"
      OUT: ${JSON.stringify('')}
  - id: record
    needs: [tick, meet]
    if: length(steps.tick.passes) == 3 && length(steps.meet.results) == 2
    command: node record.js
    env:
      PASSES: "{{ steps.tick.passes }}"
      RESULTS: "{{ steps.meet.results }}"
      OUT: ${JSON.stringify('')}
`;

const PAIRS = [{ me: 'left', other: 'right' }, { me: 'right', other: 'left' }];

function runCLI(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

function envelope(stdout: string): { data?: Record<string, unknown> } {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return JSON.parse(line) as { data?: Record<string, unknown> };
}

describe.skipIf(process.platform === 'win32')('workflow step loop and for_each', () => {
  let repo: string;
  let out: string;
  let configPath: string;

  function setMaxParallel(max: number): void {
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(configPath, YAML.stringify({ ...config, workflows: { max_parallel: max } }));
  }

  async function start(): Promise<{ code: number | null; stdout: string; stderr: string }> {
    for (const file of ['ticks.txt', 'left.ready', 'right.ready', 'record.json']) fs.rmSync(path.join(out, file), { force: true });
    return runCLI(['workflow', 'start', 'loop-and-fan', '--driver', 'local', '--inputs', JSON.stringify({ pairs: PAIRS })], repo);
  }

  function record(): { passes: unknown; results: unknown } {
    return JSON.parse(fs.readFileSync(path.join(out, 'record.json'), 'utf8')) as { passes: unknown; results: unknown };
  }

  const passes = [1, 2, 3].map((count) => ({ pass: count, outcome: 'success', outputs: { count } }));

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-loop-fan-out-e2e-')));
    out = path.join(path.dirname(repo), `${path.basename(repo)}-out`);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/workflow.git'], repo);
    const init = await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo);
    expect(init.code, `${init.stdout}\n${init.stderr}`).toBe(0);
    configPath = path.join(await resolveProjectDataHome(repo), 'config.yaml');
    fs.writeFileSync(path.join(repo, 'tick.js'), TICK);
    fs.writeFileSync(path.join(repo, 'barrier.js'), BARRIER);
    fs.writeFileSync(path.join(repo, 'record.js'), RECORD);
    git(['add', 'tick.js', 'barrier.js', 'record.js'], repo);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'scripts'], repo);
    const workflows = path.join(repo, '.teamai', 'workflows');
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(path.join(workflows, 'loop-and-fan.yaml'), WORKFLOW.replaceAll('OUT: ""', `OUT: ${JSON.stringify(out)}`));
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('loops three times, then runs both items at once with max_parallel 2', async () => {
    setMaxParallel(2);

    const run = await start();

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(envelope(run.stdout)).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(fs.readFileSync(path.join(out, 'ticks.txt'), 'utf8')).toBe('3');
    expect(record()).toMatchObject({
      passes,
      results: PAIRS.map((item) => ({ item, outcome: 'success' })),
    });
  });

  it('fails the barrier with max_parallel 1, and the failed item cancels no sibling', async () => {
    setMaxParallel(1);

    const run = await start();

    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(envelope(run.stdout)).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(record()).toMatchObject({
      passes,
      results: [{ item: PAIRS[0], outcome: 'failed' }, { item: PAIRS[1], outcome: 'success' }],
    });
  });
});

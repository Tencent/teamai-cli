import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { startRun } from '../workflow/engine.js';
import { _setDriverPollMs, runLocalDriver } from '../workflow/local-driver.js';
import { readRun } from '../workflow/store.js';
import { knownSecrets } from '../env-resolution.js';

_setDriverPollMs(20);

const output = vi.hoisted(() => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== 'unicode-fixture') return actual.spawn(...args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      queueMicrotask(() => {
        // Force byte boundaries and interleave streams without relying on OS pipe timing.
        for (let i = 0; i < Math.max(output.stdout.length, output.stderr.length); i++) {
          if (i < output.stdout.length) child.stdout.write(output.stdout.subarray(i, i + 1));
          if (i < output.stderr.length) child.stderr.write(output.stderr.subarray(i, i + 1));
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', output.code);
      });
      return child;
    }),
  };
});

let root: string;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

async function run() {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-command-utf8-')));
  const workspace = path.join(root, 'workspace');
  const team = path.join(root, 'team');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(team, 'workflows'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@teamai.test', 'commit', '-qm', 'fixture'], { cwd: workspace });
  fs.writeFileSync(path.join(team, 'workflows', 'unicode.yaml'), `schemaVersion: v1alpha1
name: unicode
description: Preserve command output.
steps:
  - id: emit
    command: unicode-fixture
`);
  const config: LocalConfig = {
    repo: { localPath: team, remote: 'local', kind: 'git' }, username: 'tester',
    scope: 'project', projectRoot: workspace, dataHome: path.join(root, 'data'), additionalRoles: [],
  };
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'unicode', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  const runId = String(started.data.run);
  const done = await runLocalDriver(config, runId, workspace);
  const state = await readRun(config, runId);
  if (typeof state === 'string') throw new Error(`Workflow state is ${state}`);
  const attempts = path.join(config.dataHome!, 'workflows', 'runs', runId, 'attempts');
  const attempt = fs.readdirSync(attempts)[0]!;
  const result = JSON.parse(fs.readFileSync(path.join(attempts, attempt, 'result.json'), 'utf8'));
  return { done, state, result };
}

describe('local workflow command UTF-8', () => {
  it.each(['检查完成', 'café', '😀', 'plain ASCII'])('preserves %s in state and the attempt result', async (summary) => {
    output.stdout = Buffer.from(JSON.stringify({ summary }));
    output.stderr = Buffer.from('诊断 café 😀');
    output.code = 0;
    const { done, state, result } = await run();
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    expect(state?.steps[0]).toMatchObject({ status: 'succeeded', outputs: { summary } });
    expect(result).toEqual({ output: { summary } });
  });

  it('preserves split stderr in the stored command failure', async () => {
    output.stdout = Buffer.alloc(0);
    output.stderr = Buffer.from('执行失败 café 😀');
    output.code = 1;
    const { done, state } = await run();
    expect(done).toMatchObject({ data: { done: { outcome: 'failed' } } });
    expect(state?.steps[0]).toMatchObject({ message: 'command exited with status 1: 执行失败 café 😀' });
  });

  it('flushes an incomplete trailing UTF-8 sequence on stderr at EOF', async () => {
    output.stdout = Buffer.alloc(0);
    output.stderr = Buffer.concat([Buffer.from('failure: '), Buffer.from([0xe4, 0xbd])]);
    output.code = 1;
    const { state } = await run();
    expect(state?.steps[0]).toMatchObject({ message: 'command exited with status 1: failure: �' });
  });
});

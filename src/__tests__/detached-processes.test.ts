import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackDetachedProcesses } from './helpers/detached-processes.js';
import { groupRunning } from './helpers/skill-runners.js';
import { signalGroup } from '@teamai/shared/process-group';

it('waits for a detached writer after its spawning parent has exited', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-detached-fixture-'));
  const tracker = trackDetachedProcesses(root);
  const output = path.join(root, 'late-write');
  try {
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(output)}, 'finished'), 300)`;
    const parent = spawnSync(process.execPath, ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
        detached: true, stdio: 'ignore'
      }).unref();
    `], { env: { ...process.env, NODE_OPTIONS: tracker.nodeOptions } });
    expect(parent.status, parent.stderr.toString()).toBe(0);
    await tracker.waitForExit();
    expect(fs.readFileSync(output, 'utf8')).toBe('finished');
  } finally {
    await tracker.waitForExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('forgets a pid the runner cannot signal, as macOS answers EPERM for a recycled pid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-detached-eperm-'));
  const tracker = trackDetachedProcesses(root);
  const children = path.join(root, 'detached-children');
  fs.writeFileSync(path.join(children, '4242'), '');
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('EPERM: operation not permitted, kill'), { code: 'EPERM' });
  });
  try {
    // The pid is alive, but it is not this runner's child any more: it is
    // forgotten, and the teardown does not fail the file (#1504).
    expect(tracker.running()).toEqual([]);
    expect(fs.existsSync(path.join(children, '4242'))).toBe(false);
  } finally {
    kill.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('stops a skill runner it waited on, and the command group the runner started, then fails naming the runner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-detached-runner-'));
  const tracker = trackDetachedProcesses(root);
  const pids = path.join(root, 'pids');
  // A runner as the CLI starts one: detached by a parent that exits, idling, with its step's command in a group of its own.
  const command = `require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); setInterval(() => {}, 1000)`;
  const runner = `require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(command)}], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  const parent = spawnSync(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(runner)}, 'workflow', 'report', 'r0123456789abcdef', '--driver', 'skill', '--attempt', 'a00000000'], {
      detached: true, stdio: 'ignore'
    }).unref();
  `], { env: { ...process.env, NODE_OPTIONS: tracker.nodeOptions } });
  expect(parent.status, parent.stderr.toString()).toBe(0);
  const started = () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
  const deadline = Date.now() + 10_000;
  while (started().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const [left = 0, step = 0] = started();
  try {
    await expect(tracker.waitForExit({ runnerExitMs: 200 })).rejects.toThrow(`Skill runners outlived the test and were stopped: ${left}.`);
    expect(groupRunning(left), 'the runner was stopped').toBe(false);
    expect(groupRunning(step), 'the command the runner started was stopped').toBe(false);
  } finally {
    for (const pid of [left, step]) {
      signalGroup(pid, 'SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

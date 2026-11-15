import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine, tempDir, type FakeEngine } from './harness.js';
import { signalPid } from '@teamai/shared/process-group';

const IMAGE = 'ghcr.io/acme/agent:1';

/**
 * A tool that leaves behind a process writing into its home, in a process group of its own, so removing the container
 * cannot stop it: it writes that process's pid to `writer.pid` in its working directory and exits.
 */
const LEAVE_WRITER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const loop = "const fs = require('node:fs'); let n = 0; for (;;) { try { fs.writeFileSync(process.env.HOME + '/f' + (n++ % 50), 'x'); } catch {} }";
const writer = spawn(process.execPath, ['-e', loop], { detached: true, stdio: 'ignore' });
fs.writeFileSync('writer.pid', String(writer.pid));
writer.unref();
`;

let dir: string;
let engine: FakeEngine;
let workspace: string;
const leftWriters: number[] = [];

/** Runs the fake `docker` with `args`, and answers how it exited and what it printed. */
function docker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(path.join(engine.bin, 'docker'), args, { env: engine.env() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Creates the running container `name`, with `workspace` mounted at its own path. */
async function runContainer(name: string): Promise<void> {
  expect(await docker(['pull', IMAGE])).toMatchObject({ code: 0 });
  const created = await docker(['run', '-d', '--name', name, '-v', `${workspace}:${workspace}:rw`, '--entrypoint', '/bin/sh', IMAGE, '-c', 'sleep 3600']);
  expect(created.code).toBe(0);
}

/** What is left of every container in the engine's state, removed or not. */
const containerDirs = (): string[] => fs.readdirSync(path.join(engine.state, 'containers'));

beforeEach(() => {
  dir = tempDir();
  engine = fakeEngine(dir);
  engine.image(IMAGE, { 'leave-writer': LEAVE_WRITER });
  workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
});

afterEach(() => {
  for (const pid of leftWriters.splice(0)) {
    signalPid(pid, 'SIGKILL');
  }

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('the fake engine', () => {
  it('fails an exec that reaches a container removed while it was on its way with No such container, starting nothing and leaving nothing of it', async () => {
    await runContainer('box');
    engine.holdExec(1_500);
    const exec = docker(['exec', '-w', workspace, 'box', '/bin/sh', '-c', 'echo started > started']);
    await vi.waitFor(() => { expect(engine.calls().some(([, command]) => command === 'exec')).toBe(true); });

    expect(await docker(['rm', '--force', 'box'])).toMatchObject({ code: 0, stdout: 'box\n' });
    expect(await exec).toMatchObject({ code: 1, stderr: 'Error response from daemon: No such container: box\n' });
    expect(fs.existsSync(path.join(workspace, 'started'))).toBe(false);
    expect(containerDirs()).toEqual([]);
  });

  it('removes a container while something still writes into its home, and that writer cannot bring it back', async () => {
    await runContainer('box');
    expect(await docker(['exec', '-w', workspace, 'box', 'leave-writer'])).toMatchObject({ code: 0 });
    leftWriters.push(Number(fs.readFileSync(path.join(workspace, 'writer.pid'), 'utf8')));
    // The writer is under way once its first file is in the container's home.
    await vi.waitFor(() => { expect(containerDirs().some((id) => fs.existsSync(path.join(engine.state, 'containers', id, 'home', 'f0')))).toBe(true); });

    const removed = await docker(['rm', '--force', 'box']);

    expect(removed).toMatchObject({ code: 0, stdout: 'box\n', stderr: '' });
    expect(engine.containers()).toEqual([]);
    expect(containerDirs()).toEqual([]);
  });
});

describe('mounts', () => {
  /** The mounts the fake keeps for the container named `name`. */
  const mountsOf = (name: string): unknown => {
    const found = containerDirs().map((id) => JSON.parse(fs.readFileSync(path.join(engine.state, 'containers', id, 'container.json'), 'utf8')) as { name: string; mounts: unknown }).find((container) => container.name === name);

    return found?.mounts;
  };

  it('reads a Windows source path, drive letter and all, as docker on Windows does', async () => {
    expect(await docker(['pull', IMAGE])).toMatchObject({ code: 0 });
    const created = await docker(['run', '-d', '--name', 'win', '-v', 'C:\\Users\\member\\repo:/repo:ro', '-v', 'D:/work/out:/out', '-v', '/srv/cache:/cache:rw', '--entrypoint', '/bin/sh', IMAGE, '-c', 'sleep 3600']);

    expect(created.code).toBe(0);
    expect(mountsOf('win')).toEqual([
      { source: 'C:\\Users\\member\\repo', target: '/repo', readonly: true },
      { source: 'D:/work/out', target: '/out', readonly: false },
      { source: '/srv/cache', target: '/cache', readonly: false },
    ]);
    expect(await docker(['rm', '--force', 'win'])).toMatchObject({ code: 0 });
  });
});

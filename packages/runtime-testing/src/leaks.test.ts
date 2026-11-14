import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectRuntime } from './connect.js';
import { expectNothingLeft } from './leaks.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-testing-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A process that runs until killed, with `dir` on its command line, as a fake's child would have. */
function strayIn(at: string): { pid: number; kill: () => Promise<void> } {
  const script = path.join(at, 'stray.mjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  return { pid: child.pid ?? 0, kill: async () => { child.kill('SIGKILL'); await exited; } };
}

describe('the check that a test left nothing running', () => {
  it('passes when nothing names the test\'s directory', async () => {
    await expect(expectNothingLeft({ dir })).resolves.toBeUndefined();
  });

  it('passes when a process the test left ends by itself shortly after', async () => {
    const script = path.join(dir, 'brief.mjs');
    fs.writeFileSync(script, 'setTimeout(() => {}, 300);\n');
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));

    await expect(expectNothingLeft({ dir })).resolves.toBeUndefined();
    await exited;
  });

  it('names a process whose command line names a path under the test\'s directory', async () => {
    const stray = strayIn(dir);

    try {
      await expect(expectNothingLeft({ dir })).rejects.toThrow(new RegExp(`process: ${stray.pid} .*stray\\.mjs`));
    } finally {
      await stray.kill();
    }

    await expect(expectNothingLeft({ dir })).resolves.toBeUndefined();
  });

  it('names a runtime the test did not close, wherever its executable is', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-testing-bundle-')));

    try {
      const executable = path.join(elsewhere, 'runtime.mjs');
      fs.writeFileSync(executable, 'process.stdin.resume();\n');
      const runtime = connectRuntime({ executable, env: {} });

      await expect(expectNothingLeft({ dir, connections: [runtime] })).rejects.toThrow(/runtime: \d+ .*runtime\.mjs/);
      await runtime.close();
      await expect(expectNothingLeft({ dir, connections: [runtime] })).resolves.toBeUndefined();
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('accepts what a runtime said, in a close\'s kept, that it leaves on purpose, and names the rest', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-testing-bundle-')));

    try {
      const executable = path.join(elsewhere, 'runtime.mjs');
      fs.writeFileSync(executable, 'process.stdout.write(JSON.stringify({ event: "close_failed", handle: "h-1", failure: { code: "sandbox_failed", message: "remove it" }, kept: ["teamai-r1-a1"] }) + "\\n");\n');
      const runtime = connectRuntime({ executable, env: {} });
      await runtime.next((line) => line['event'] === 'close_failed');
      await runtime.close();

      await expect(expectNothingLeft({ dir, connections: [runtime], left: () => ['teamai-r1-a1'] })).resolves.toBeUndefined();
      await expect(expectNothingLeft({ dir, connections: [runtime], left: () => ['teamai-r1-a1', 'teamai-r1-a2'] })).rejects.toThrow(/^The test left behind:\nleft: teamai-r1-a2$/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('accepts only a whole kept name, and names a leak whose name starts with one or whose path lies under one', async () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-testing-bundle-')));
    const keptDir = path.join(dir, 'teamai-r1-a1');
    const strayDir = path.join(dir, 'teamai-r1-a1-other');
    fs.mkdirSync(keptDir);
    fs.mkdirSync(strayDir);
    const inKept = strayIn(keptDir);
    const besideKept = strayIn(strayDir);

    try {
      const executable = path.join(elsewhere, 'runtime.mjs');
      const answer = { event: 'close_failed', handle: 'h-1', failure: { code: 'sandbox_failed', message: 'remove it' }, kept: ['teamai-r1-a1', keptDir] };
      fs.writeFileSync(executable, `process.stdout.write(${JSON.stringify(JSON.stringify(answer))} + "\\n");\n`);
      const runtime = connectRuntime({ executable, env: {} });
      await runtime.next((line) => line['event'] === 'close_failed');
      await runtime.close();

      const left = expectNothingLeft({ dir, connections: [runtime], left: () => ['container teamai-r1-a1', 'container teamai-r1-a10'] });

      await expect(left).rejects.toThrow(`process: ${inKept.pid} ${process.execPath} ${path.join(keptDir, 'stray.mjs')}`);
      await expect(left).rejects.toThrow(`process: ${besideKept.pid} ${process.execPath} ${path.join(strayDir, 'stray.mjs')}`);
      await expect(left).rejects.toThrow('left: container teamai-r1-a10');
      await expect(left).rejects.not.toThrow('left: container teamai-r1-a1\n');
    } finally {
      await inKept.kill();
      await besideKept.kill();
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

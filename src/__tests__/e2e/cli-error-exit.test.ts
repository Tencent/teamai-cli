import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(
  args: string[],
  home: string,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('an async command action that throws', () => {
  // #1270: a rejection reached the user as an unhandled one, so Node printed
  // the error under a `cli.js:NNNN` header with its stack. `session list`
  // throws a plain Error rather than a NotInitializedError, so the entry
  // boundary has to cover it, not only the commands that wrap themselves.
  function fixture(): { root: string; home: string; work: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-cmd-error-'));
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(work);
    return { root, home, work };
  }

  it('prints one line on stderr and exits 1, with no stack', async () => {
    const { root, home, work } = fixture();
    try {
      const { code, stdout, stderr } = await runCLI(['session', 'list'], home, work);
      expect(code).toBe(1);
      expect(stderr).toContain('teamai is not set up for this directory');
      // The `cli.js:NNNN` header and the `at ...` frames of an unhandled rejection.
      expect(stderr).not.toContain('cli.js:');
      expect(stderr).not.toMatch(/^\s+at /m);
      expect(stdout).toBe('');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps the stack reachable under --verbose', async () => {
    const { root, home, work } = fixture();
    try {
      const { code, stdout, stderr } = await runCLI(['-v', 'session', 'list'], home, work);
      expect(code).toBe(1);
      expect(stderr).toContain('teamai is not set up for this directory');
      expect(stdout).toMatch(/^\s+at /m);
      expect(stdout).toContain('resolveRepoRoot');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

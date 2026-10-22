import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

function runCLI(args: string[], home: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('commands that need an initialized teamai', () => {
  // Issue #1227: these commands reject with NotInitializedError and used to
  // reach the user as an uncaught Node stack trace.
  for (const args of [['status'], ['list'], ['push', '--dry-run']]) {
    it(`"${args.join(' ')}" prints the message and exits 1 without a stack trace`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-not-init-'));
      const home = path.join(root, 'home');
      const work = path.join(root, 'work');
      fs.mkdirSync(home);
      fs.mkdirSync(work);
      try {
        const { code, output } = await runCLI(args, home, work);
        expect(code).toBe(1);
        expect(output).toContain('teamai is not initialized. Run `teamai init` first.');
        expect(output).not.toContain('NotInitializedError');
        expect(output).not.toMatch(/^\s+at /m);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

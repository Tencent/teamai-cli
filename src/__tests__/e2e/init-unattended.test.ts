import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue #711: `teamai init` must never wait on a person when there is no one.
 *
 * Drives the compiled CLI with a fake `gh` on PATH that has no session and whose
 * `auth login` behaves like the real device flow when nobody opens the browser
 * (it sleeps). On `main` before the fix, `init` sat inside that login until the
 * provider's deadline. Now it must exit 1 within seconds and name the credential.
 *
 * No network: authentication is refused before any clone is attempted.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

// Well under the vitest testTimeout; the unfixed CLI would still be running.
const LIMIT_MS = 15_000;

interface RunResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

let sandbox: string;
let binDir: string;
let home: string;

function writeFakeGh(dir: string): void {
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(
    gh,
    `#!/bin/sh
# Fake gh for init-unattended.test.ts: no session; login never completes.
case "$1 $2" in
  "auth status") echo "You are not logged into any GitHub hosts." >&2; exit 1 ;;
  "auth login")  echo "! First copy your one-time code: XXXX-XXXX"; sleep 300; exit 1 ;;
  "api user")    exit 1 ;;
  *) echo "gh version 2.0.0 (fake)"; exit 0 ;;
esac
`,
  );
  fs.chmodSync(gh, 0o755);
}

function runInit(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [CLI, 'init', 'https://github.com/acme/team', '--scope', 'user', '--role', 'dev', '--agent', 'claude', '--force'],
      {
        cwd: sandbox,
        // Fresh environment: no developer token, no gh config, our fake gh first.
        env: {
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          HOME: home,
          USERPROFILE: home,
          FORCE_COLOR: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LIMIT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

describe.skipIf(process.platform === 'win32')('teamai init without a terminal (#711)', () => {
  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-unattended-'));
    binDir = path.join(sandbox, 'bin');
    home = path.join(sandbox, 'home');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFakeGh(binDir);
    if (!fs.existsSync(CLI)) throw new Error(`Build first: ${CLI} is missing`);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('fails fast and names GITHUB_TOKEN instead of starting the browser login', async () => {
    const result = await runInit({});
    expect(result.timedOut, `init was still running after ${LIMIT_MS}ms:\n${result.output}`).toBe(false);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/GITHUB_TOKEN/);
    expect(result.output).not.toMatch(/one-time code/);
  });

  // stdin is already not a TTY here, so this case shows only that CI=true does
  // not change the outcome; the pseudo-terminal leg of the predicate is proven
  // in prompt-interactive.test.ts, where isTTY is forced on.
  it('gives the same result with CI=true set', async () => {
    const result = await runInit({ CI: 'true' });
    expect(result.timedOut, result.output).toBe(false);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/GITHUB_TOKEN/);
  });
});

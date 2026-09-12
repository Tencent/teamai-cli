import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliPath } from '../../utils/cli-path.js';
import { ghExec, isGhInstalled } from '../../providers/github/gh-cli.js';
import { cnbExec, isCnbInstalled } from '../../providers/cnb/cnb-cli.js';

/**
 * Real-PATH integration test for the provider CLI wrappers — no `vi.mock`.
 *
 * The unit suite (`src/__tests__/cli-path.test.ts`) stubs the resolver, so it can
 * prove the *logic* but never that a resolved path is actually launchable, and
 * that gap is exactly where the bug lived: `isGhInstalled()` answered "installed"
 * while every `ghExec()` returned status 1 with an empty stderr, because the
 * resolved path was an MSYS path Node cannot spawn.
 *
 * These tests plant real executables in a temp dir, prepend it to PATH, and drive
 * the real resolver + launcher. Both an extensionless POSIX shim and a `.cmd`
 * shim are written, the way `npm install -g` does on Windows, so the picker has a
 * wrong candidate to skip.
 *
 * Run with `npm run test:e2e`. This directory is excluded from the default
 * `vitest run` (see `vitest.config.ts`), and `ci.yml` only runs the single e2e
 * file it names explicitly — so this is not CI-gated. That is deliberate: the CI
 * matrix has no Windows runner, and the `.cmd` branch can only be exercised on
 * Windows. Run it there.
 */
const MARKER = 'teamai-fake-cli';

let binDir: string;
let originalPath: string | undefined;

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/** Write the two shims `npm install -g` drops on Windows, plus the POSIX one. */
function writeShims(name: string): void {
  const posix = path.join(binDir, name);
  fs.writeFileSync(posix, `#!/bin/sh\necho "${MARKER} 1.2.3"\n`);
  fs.chmodSync(posix, 0o755);
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\necho ${MARKER} 1.2.3\r\n`);
}

/**
 * The planted shim is what the PATH scan finds on Windows and Linux. On macOS a
 * machine-wide install can win instead — `bash -lc` goes through `path_helper`,
 * which rebuilds PATH from `/etc/paths*` and drops the prepended dir — so assert
 * the strict marker only when our own shim is the resolved one; otherwise assert
 * the weaker but still regression-relevant "it launched and said something".
 */
function expectLaunched(
  result: { stdout: string; stderr: string; status: number },
  resolved: string | null,
): void {
  expect(result.status, `status=${result.status} stderr=${result.stderr}`).toBe(0);
  if (resolved !== null && sameDir(path.dirname(resolved), binDir)) {
    expect(result.stdout).toContain(MARKER);
  } else {
    expect(result.stdout.length, `resolved=${resolved}`).toBeGreaterThan(0);
  }
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-provider-cli-'));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe('resolveCliPath against the real PATH', () => {
  it('resolves a PATH-prepended executable to an absolute path that exists', () => {
    // A name no machine-wide install can shadow, so the assertion is deterministic
    // on every platform: the only candidate is the shim we just planted.
    writeShims('teamai-probe-cli');
    const resolved = resolveCliPath('teamai-probe-cli');
    expect(resolved, 'planted shim was not found on PATH').not.toBeNull();
    expect(sameDir(path.dirname(resolved!), binDir)).toBe(true);
    // The original bug resolved to a path that failed this check, which is why
    // detection said "installed" while the launcher got ENOENT.
    expect(fs.existsSync(resolved!)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')(
    "prefers the .cmd sibling over the extensionless npm shim, which CreateProcess cannot launch",
    () => {
      writeShims('teamai-probe-cli');
      const resolved = resolveCliPath('teamai-probe-cli');
      expect(resolved!.toLowerCase().endsWith('.cmd')).toBe(true);
      expect(resolved!.toLowerCase().endsWith(`${path.sep}teamai-probe-cli.cmd`)).toBe(true);
    },
  );

  it('returns null for a command that is not on PATH', () => {
    expect(resolveCliPath('teamai-definitely-absent-cmd')).toBeNull();
  });
});

describe('the gh and cnb wrappers launch what they resolve', () => {
  it('ghExec does not fail silently', () => {
    writeShims('gh');
    expect(isGhInstalled()).toBe(true);
    expectLaunched(ghExec(['--version']), resolveCliPath('gh'));
  });

  it('cnbExec does not fail silently', () => {
    writeShims('cnb');
    expect(isCnbInstalled()).toBe(true);
    expectLaunched(cnbExec(['status']), resolveCliPath('cnb'));
  });
});

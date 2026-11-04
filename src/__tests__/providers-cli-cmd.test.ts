import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCliPath } from '../utils/cli-path.js';

/**
 * The `.cmd` sibling is what CreateProcess launches. The other provider PATH
 * cases live in `e2e/providers-cli-path.test.ts` and run on macOS: `where`
 * is not the resolver there, and comparing directory strings fails on the
 * Windows runner, whose temp path is the 8.3 form and `where` returns the long one.
 */

let binDir: string;
let originalPath: string | undefined;

/** The two shims `npm install -g` drops on Windows. `where` lists the extensionless one first. */
function writeShims(name: string): void {
  fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\necho teamai-probe\n');
  fs.chmodSync(path.join(binDir, name), 0o755);
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), '@echo off\r\necho teamai-probe\r\n');
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

describe('resolveCliPath on Windows', () => {
  it.skipIf(process.platform !== 'win32')(
    'prefers the .cmd sibling over the extensionless npm shim, which CreateProcess cannot launch',
    () => {
      writeShims('teamai-probe-cli');
      const resolved = resolveCliPath('teamai-probe-cli');
      expect(resolved!.toLowerCase().endsWith('.cmd')).toBe(true);
      expect(resolved!.toLowerCase().endsWith(`${path.sep}teamai-probe-cli.cmd`)).toBe(true);
    },
  );
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOnPath } from '../utils/lookpath.js';

describe('isOnPath', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lookpath-'));
    dirs.push(dir);
    return dir;
  }

  it('finds an executable whose name equals the lookup', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'teamai-lookpath-hit');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(bin, 0o755);
    expect(isOnPath('teamai-lookpath-hit', { pathEnv: dir })).toBe(true);
  });

  it('returns false when the name is not on PATH', () => {
    expect(isOnPath('teamai-lookpath-absent', { pathEnv: tempDir() })).toBe(false);
  });

  it('on win32 matches uvx.exe via PATHEXT when uvx itself is absent', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'uvx.exe'), '');
    expect(
      isOnPath('uvx', {
        platform: 'win32',
        pathEnv: dir,
        pathExt: '.EXE;.CMD',
      }),
    ).toBe(true);
    expect(isOnPath('uvx', { platform: 'darwin', pathEnv: dir })).toBe(false);
  });

  it('skips empty PATH entries instead of searching cwd', () => {
    const dir = tempDir();
    const sneaky = path.join(dir, 'teamai-lookpath-cwd');
    fs.writeFileSync(sneaky, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(sneaky, 0o755);
    const prev = process.cwd();
    process.chdir(dir);
    try {
      expect(isOnPath('teamai-lookpath-cwd', { pathEnv: '' })).toBe(false);
      expect(isOnPath('teamai-lookpath-cwd', { pathEnv: path.delimiter })).toBe(false);
    } finally {
      process.chdir(prev);
    }
  });

  it('rejects names with path separators or shell metacharacters', () => {
    const dir = tempDir();
    expect(isOnPath(`echo; touch ${dir}`, { pathEnv: dir })).toBe(false);
    expect(isOnPath('../uvx', { pathEnv: dir })).toBe(false);
  });
});

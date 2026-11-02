import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate getUserHome() so the bundled-runtime lookups see a per-test home.
const homeState = vi.hoisted(() => ({ home: '' }));
vi.mock('../utils/home.js', () => ({
  getUserHome: () => homeState.home,
}));

// Mock the logger so the module's debug traces do not reach the real log file.
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureBundledRuntimeOnPath, resetBundledRuntimeCache, resolveWorkbuddyNode } from '../bundled-runtime.js';
import { log } from '../utils/logger.js';

/** Lay out a WorkBuddy PortableGit runtime under the test home. */
function makePortableGit(version: string, dirs = ['cmd', 'usr/bin', 'mingw64/bin'], dataRoot = '.workbuddy'): string {
  const root = path.join(homeState.home, dataRoot, 'binaries', 'PortableGit', 'versions', version);
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  if (dirs.includes('cmd')) fs.writeFileSync(path.join(root, 'cmd', 'git.exe'), '');
  return root;
}

/** A dir holding some other git.exe, to stand in for a system install. */
function makeForeignGit(): string {
  const dir = path.join(homeState.home, 'other-git');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'git.exe'), '');
  return dir;
}

/**
 * An empty dir to use as a PATH with no git in it. Never `/usr/bin`: on macOS
 * and Linux that really holds a git, and since the win32 simulation drops the
 * execute-bit requirement, the gate would match it and short-circuit the case.
 */
function makeEmptyPathDir(): string {
  const dir = path.join(homeState.home, 'empty-bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ensureBundledRuntimeOnPath', () => {
  let savedPath: string | undefined;

  beforeEach(() => {
    homeState.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-'));
    resetBundledRuntimeCache();
    vi.clearAllMocks();
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    fs.rmSync(homeState.home, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  it('prepends the bundled git and appends the dirs git itself shells out to', () => {
    const root = makePortableGit('1.2.0');
    const original = makeEmptyPathDir();
    process.env.PATH = original;

    ensureBundledRuntimeOnPath('win32');

    const entries = process.env.PATH!.split(path.delimiter);
    expect(entries[0]).toBe(path.join(root, 'cmd'));
    expect(entries).toContain(original);
    expect(entries.indexOf(path.join(root, 'mingw64', 'bin'))).toBeGreaterThan(entries.indexOf(original));
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining(path.join(root, 'cmd')));
  });

  it('picks the newest version and stays idempotent', () => {
    makePortableGit('1.2.0');
    const newest = makePortableGit('1.10.0');
    process.env.PATH = '';

    ensureBundledRuntimeOnPath('win32');
    const once = process.env.PATH;
    ensureBundledRuntimeOnPath('win32');

    expect(process.env.PATH!.split(path.delimiter)[0]).toBe(path.join(newest, 'cmd'));
    expect(process.env.PATH).toBe(once);
  });

  it('leaves a machine that already resolves git alone', () => {
    makePortableGit('1.2.0');
    const foreign = makeForeignGit();
    process.env.PATH = foreign;

    ensureBundledRuntimeOnPath('win32');

    expect(process.env.PATH).toBe(foreign);
    expect(log.debug).toHaveBeenCalledWith('bundled runtime: git already resolves on PATH; leaving it alone');
  });

  it('does not duplicate a dir PATH already carries', () => {
    const root = makePortableGit('1.2.0');
    process.env.PATH = [path.join(root, 'cmd'), makeEmptyPathDir()].join(path.delimiter);

    ensureBundledRuntimeOnPath('win32');

    const entries = process.env.PATH!.split(path.delimiter);
    expect(entries.filter(e => e === path.join(root, 'cmd'))).toHaveLength(1);
  });

  it('leaves PATH alone without a bundled runtime, and says so', () => {
    const original = makeEmptyPathDir();
    process.env.PATH = original;

    ensureBundledRuntimeOnPath('win32');

    expect(process.env.PATH).toBe(original);
    expect(log.debug).toHaveBeenCalledWith('bundled runtime: no bundled git to add to PATH');
  });

  it('skips a runtime whose cmd dir has no git.exe', () => {
    makePortableGit('1.2.0', ['usr/bin']);
    const original = makeEmptyPathDir();
    process.env.PATH = original;

    ensureBundledRuntimeOnPath('win32');

    expect(process.env.PATH).toBe(original);
  });

  it('falls back to the previous complete version when the newest lacks a git', () => {
    makePortableGit('1.10.0', ['usr/bin']);
    const older = makePortableGit('1.2.0');
    process.env.PATH = '';

    ensureBundledRuntimeOnPath('win32');

    expect(process.env.PATH!.split(path.delimiter)[0]).toBe(path.join(older, 'cmd'));
  });

  it('finds the PortableGit of WorkBuddy AI, the international edition', () => {
    const root = makePortableGit('1.2.0', undefined, '.workbuddy-ai');
    process.env.PATH = '';

    ensureBundledRuntimeOnPath('win32');

    expect((process.env.PATH ?? '').split(path.delimiter)[0]).toBe(path.join(root, 'cmd'));
  });

  it('leaves PATH alone off Windows', () => {
    makePortableGit('1.2.0');
    const original = makeEmptyPathDir();
    process.env.PATH = original;

    ensureBundledRuntimeOnPath('darwin');

    expect(process.env.PATH).toBe(original);
  });
});

// WorkBuddy 5.6.2 and 5.7.6 (`VENDOR_ASSETS` in main/index.js) unpack Node into
// <data root>/binaries/node/versions/<version>-<variant>: bin/node, or node.exe on Windows.
describe('resolveWorkbuddyNode', () => {
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    homeState.home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-'));
    savedConfigDir = process.env.WORKBUDDY_CONFIG_DIR;
    delete process.env.WORKBUDDY_CONFIG_DIR;
  });

  afterEach(() => {
    fs.rmSync(homeState.home, { recursive: true, force: true });
    if (savedConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = savedConfigDir;
  });

  function makeNode(versions: string, binary = path.join('bin', 'node')): string {
    const file = path.join(versions, binary);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  }
  const versionsIn = (dataRoot: string) => path.join(dataRoot, 'binaries', 'node', 'versions');

  it('finds the Node WorkBuddy unpacked', () => {
    const node = makeNode(path.join(versionsIn(path.join(homeState.home, '.workbuddy')), '22.22.2-6'));
    expect(resolveWorkbuddyNode('darwin')).toBe(node);
  });

  it('finds the Node of WorkBuddy AI, the international edition', () => {
    const node = makeNode(path.join(versionsIn(path.join(homeState.home, '.workbuddy-ai')), '22.22.2-6'));
    expect(resolveWorkbuddyNode('linux')).toBe(node);
  });

  it('takes node.exe from the version directory on Windows', () => {
    const node = makeNode(path.join(versionsIn(path.join(homeState.home, '.workbuddy')), '22.22.2-6'), 'node.exe');
    expect(resolveWorkbuddyNode('win32')).toBe(node);
  });

  it('takes the newest complete version, past the active-version file and an unfinished unpack', () => {
    const versions = versionsIn(path.join(homeState.home, '.workbuddy'));
    makeNode(path.join(versions, '22.9.0-3'));
    makeNode(path.join(versions, '22.22.2-3'));
    const newest = makeNode(path.join(versions, '22.22.2-6'));
    fs.mkdirSync(path.join(versions, '24.0.0-1'), { recursive: true });
    fs.mkdirSync(path.join(versions, '24.1.0-1.installing.42'), { recursive: true });
    fs.writeFileSync(path.join(versions, 'current'), '22.22.2-6');
    expect(resolveWorkbuddyNode('darwin')).toBe(newest);
  });

  it('looks in WORKBUDDY_CONFIG_DIR first', () => {
    makeNode(path.join(versionsIn(path.join(homeState.home, '.workbuddy')), '22.22.2-6'));
    const moved = path.join(homeState.home, 'wb-data');
    process.env.WORKBUDDY_CONFIG_DIR = moved;
    const node = makeNode(path.join(versionsIn(moved), '22.22.2-6'));
    expect(resolveWorkbuddyNode('darwin')).toBe(node);
  });

  it('finds nothing without a WorkBuddy runtime', () => {
    expect(resolveWorkbuddyNode('darwin')).toBeNull();
  });
});

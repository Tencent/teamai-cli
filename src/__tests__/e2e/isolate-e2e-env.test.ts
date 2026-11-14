import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards helpers/isolate-e2e-env.ts: a skill runner a test leaves working in
// this file's own temporary directory fails that test (teardown-writers.ts),
// which holds only when no other file shares the directory.
describe('E2E temporary directory isolation', () => {
  it('runs each test file with a temporary directory of its own, not the one the worker started with', () => {
    // teardown-writers.ts makes its tracker in the worker's first temporary directory, before any isolation.
    const workerTmp = path.dirname(process.env.TEAMAI_TEST_DETACHED_ROOT ?? '');

    expect(os.tmpdir()).not.toBe(workerTmp);
    expect(fs.statSync(os.tmpdir()).isDirectory()).toBe(true);
    expect(process.env.TMP).toBe(os.tmpdir());
    expect(process.env.TEMP).toBe(os.tmpdir());
  });
});

// Guards helpers/isolate-e2e-env.ts: which OpenCode a test meets decides how teamai delivers to it and launches it, and
// the machine's, or the opencode-ai devDependency npm puts first on PATH, made the same case pass or fail by how the
// suite was started.
describe('E2E OpenCode isolation', () => {
  it('meets OpenCode V2 on PATH, the version CI installs, not an OpenCode of this machine', () => {
    const asked = spawnSync('opencode', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });

    expect({ status: asked.status, stdout: asked.stdout.trim() }).toEqual({ status: 0, stdout: 'opencode v2.0.29' });
  });

  it('keeps every XDG folder under the sandbox HOME, where the stand-in and teamai look for OpenCode\'s', () => {
    const set = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].filter((name) => process.env[name] !== undefined);

    expect(set).toEqual([]);
  });
});

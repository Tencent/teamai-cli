import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it.runIf(process.platform !== 'win32')('refuses pull from a removed cwd before migration with actionable output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-removed-cwd-'));
  try {
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(work);
    // Delete before Node starts: process.cwd() can cache a directory it already read.
    const run = spawnSync('sh', ['-c', 'rmdir "$REMOVED_WORK" && exec "$TEST_NODE" "$TEST_CLI" pull'], {
      cwd: work, env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', REMOVED_WORK: work, TEST_NODE: process.execPath, TEST_CLI: cli },
      encoding: 'utf8', timeout: 15_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Current working directory is unavailable. Change to an existing directory and retry.');
    expect(run.stdout + run.stderr).not.toMatch(/uv_cwd|Auto-migration failed|original .teamai data|^\s+at /m);
    expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

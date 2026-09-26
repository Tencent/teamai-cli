/**
 * A reports reader whose refresh failed must not create the checkout without
 * the reports lock (#823 item 15): a writer that took the lock meanwhile may be
 * creating it at the same path (#808).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { REPORTS_LOCK_FILENAME, REPORTS_WORKTREE_DIRNAME, type LocalConfig } from '../types.js';

// The first refresh fails before it creates anything, as a transient failure would.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, isDedicatedRepoRoot: vi.fn(actual.isDedicatedRepoRoot).mockResolvedValueOnce(false) };
});

// A writer takes the reports lock the moment the failed refresh lets it go.
const writer = vi.hoisted(() => ({ took: false }));
vi.mock('../update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update.js')>();
  return {
    ...actual,
    releaseLock: async (lockPath?: string) => {
      await actual.releaseLock(lockPath);
      if (!writer.took && lockPath && path.basename(lockPath) === REPORTS_LOCK_FILENAME) {
        writer.took = true;
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'writer' }));
      }
    },
  };
});

const { readableReportsWorktree } = await import('../utils/reports-branch.js');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-reports-reader-lock-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function gitInstall(): Promise<LocalConfig> {
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  await seedGit.add(['.']);
  await seedGit.commit('init');
  const origin = path.join(tmp, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const clone = path.join(tmp, 'team-repo');
  await simpleGit().clone(origin, clone);
  return { repo: { localPath: clone, remote: origin, kind: 'git' }, username: 'alice', scope: 'user', additionalRoles: [] };
}

describe('readableReportsWorktree after a failed refresh (#823 item 15)', () => {
  it('creates no checkout while a writer holds the reports lock', async () => {
    const config = await gitInstall();
    const checkout = path.join(tmp, REPORTS_WORKTREE_DIRNAME);

    const dir = await readableReportsWorktree(config);

    expect(writer.took).toBe(true);
    expect(dir).toBe(checkout);
    expect(fs.existsSync(checkout)).toBe(false);
  });
});

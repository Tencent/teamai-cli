import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acquireImportLock, isImportInProgress } from '../utils/import-lock.js';

/**
 * Mirrors the lockPathFor formula from the implementation.
 * Lock is placed in the parent of the resolved teamRepoPath.
 */
function lockPathFor(teamRepoPath: string): string {
  return path.join(path.dirname(path.resolve(teamRepoPath)), '.teamai-import.lock');
}

/** Returns true if a file exists at the given absolute path. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('import-lock', () => {
  let root: string;
  let teamRepo: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'implock-'));
    teamRepo = path.join(root, 'team-repo');
    lockPath = lockPathFor(teamRepo);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('acquire writes lock file, release deletes it', async () => {
    const release = await acquireImportLock(teamRepo);
    expect(await fileExists(lockPath)).toBe(true);
    await release();
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('isImportInProgress is true while locked and false after release', async () => {
    const release = await acquireImportLock(teamRepo);
    expect(await isImportInProgress(teamRepo)).toBe(true);
    await release();
    expect(await isImportInProgress(teamRepo)).toBe(false);
  });

  it('isImportInProgress is false when no lock file exists', async () => {
    expect(await isImportInProgress(teamRepo)).toBe(false);
  });

  it('first release keeps lock alive (ref count 2 → 1), second release removes it (1 → 0)', async () => {
    const release1 = await acquireImportLock(teamRepo);
    const release2 = await acquireImportLock(teamRepo);

    await release1();
    expect(await fileExists(lockPath)).toBe(true);
    expect(await isImportInProgress(teamRepo)).toBe(true);

    await release2();
    expect(await fileExists(lockPath)).toBe(false);
    expect(await isImportInProgress(teamRepo)).toBe(false);
  });

  it('release is idempotent: calling the same release twice does not throw', async () => {
    const release = await acquireImportLock(teamRepo);
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('stale lock (startedAt 3 hours ago) is inactive and the lock file is removed', async () => {
    const staleMeta = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      teamRepo,
    };
    await writeFile(lockPath, JSON.stringify(staleMeta, null, 2), 'utf8');

    expect(await isImportInProgress(teamRepo)).toBe(false);
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('lock for a dead process (pid 2147483646) is inactive and the lock file is removed', async () => {
    const deadMeta = {
      pid: 2147483646,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      teamRepo,
    };
    await writeFile(lockPath, JSON.stringify(deadMeta, null, 2), 'utf8');

    expect(await isImportInProgress(teamRepo)).toBe(false);
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('lock from a different host within TTL is treated as active', async () => {
    const remoteMeta = {
      pid: process.pid,
      host: 'some-other-host-xyz',
      startedAt: new Date().toISOString(),
      teamRepo,
    };
    await writeFile(lockPath, JSON.stringify(remoteMeta, null, 2), 'utf8');

    expect(await isImportInProgress(teamRepo)).toBe(true);
  });

  it('malformed lock file with fresh mtime is treated as active', async () => {
    await writeFile(lockPath, 'not-json{', 'utf8');

    expect(await isImportInProgress(teamRepo)).toBe(true);
  });
  it('refuses while another live process holds it, and leaves that lock in place', async () => {
    const held = JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString(), teamRepo }, null, 2);
    await writeFile(lockPath, held, 'utf8');

    await expect(acquireImportLock(teamRepo)).rejects.toThrow(
      `Another teamai import is writing this teamwiki (process ${process.ppid} on ${os.hostname()}). Wait for it to finish, then run this command again. If no import is running, remove ${lockPath}.`,
    );
    expect(await readFile(lockPath, 'utf8')).toBe(held);
  });

  it('goes on under the hold of the process that started it, and leaves that lock in place', async () => {
    const held = JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString(), teamRepo }, null, 2);
    await writeFile(lockPath, held, 'utf8');
    const before = process.env.TEAMAI_IMPORT_LOCK_HOLDER;
    process.env.TEAMAI_IMPORT_LOCK_HOLDER = `${process.ppid}@${os.hostname()}`;

    try {
      const release = await acquireImportLock(teamRepo);
      await release();
    } finally {
      if (before === undefined) delete process.env.TEAMAI_IMPORT_LOCK_HOLDER;
      else process.env.TEAMAI_IMPORT_LOCK_HOLDER = before;
    }

    expect(await readFile(lockPath, 'utf8')).toBe(held);
  });

  it('takes the lock over from a process that is gone', async () => {
    await writeFile(lockPath, JSON.stringify({ pid: 2147483646, host: os.hostname(), startedAt: new Date().toISOString(), teamRepo }), 'utf8');

    const release = await acquireImportLock(teamRepo);
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(process.pid);
    await release();
    expect(await fileExists(lockPath)).toBe(false);
  });

  it('leaves the lock of a holder that took it over when the one it took it from releases', async () => {
    const release = await acquireImportLock(teamRepo);
    const taken = JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString(), teamRepo }, null, 2);
    await writeFile(lockPath, taken, 'utf8');

    await release();

    expect(await readFile(lockPath, 'utf8')).toBe(taken);
  });

  it('leaves no directory behind that it created only for the lock', async () => {
    const output = path.join(root, 'out', 'wiki');

    const release = await acquireImportLock(path.join(output, 'teamwiki'));
    expect(await fileExists(path.join(output, '.teamai-import.lock'))).toBe(true);
    await release();

    expect(await fileExists(path.join(root, 'out'))).toBe(false);
  });
});

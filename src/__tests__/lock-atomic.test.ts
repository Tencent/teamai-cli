import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { acquireLock, releaseLock } from '../update.js';

// ─── Real-filesystem tests for the atomic lock (issue #374 P0) ──────────────
//
// These exercise acquireLock/releaseLock against a real temp directory, so the
// OS-level exclusivity (link's EEXIST, O_CREAT|O_EXCL without hard links) and the
// on-disk owner token are genuinely tested — the thing the previous
// check-then-write lock got wrong. Spies on fs-extra only stage the interleavings
// a single process cannot produce on its own (#760).

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lock-'));
  lockPath = path.join(tmpDir, '.test-lock');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('acquireLock (real fs)', () => {
  it('acquires a fresh lock and writes a JSON payload with pid + owner', async () => {
    expect(await acquireLock(lockPath)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
    expect(typeof payload.owner).toBe('string');
    expect(typeof payload.startedAt).toBe('string');
    await releaseLock(lockPath);
  });

  it('creates the parent directory if missing', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c', '.lock');
    expect(await acquireLock(nested)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    await releaseLock(nested);
  });

  it('grants the lock to exactly one of many concurrent acquirers', async () => {
    // O_EXCL is atomic: even fired together, only one create wins. The losers
    // read the winner's live-pid lock and back off.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => acquireLock(lockPath)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await releaseLock(lockPath);
  });

  it('refuses when a live process already holds the lock', async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'live', startedAt: 'x' }));
    expect(await acquireLock(lockPath)).toBe(false);
    // Untouched.
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('live');
  });

  it('reclaims a stale lock left by a dead process (JSON payload)', async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, owner: 'dead', startedAt: 'x' }));
    expect(await acquireLock(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    await releaseLock(lockPath);
  });

  it('reclaims a stale legacy plain-PID lock from an older teamai version', async () => {
    fs.writeFileSync(lockPath, '999999');
    expect(await acquireLock(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    await releaseLock(lockPath);
  });

  it('does not reclaim a lock whose contents name no owner (garbage) (#760)', async () => {
    // Nothing proves its owner dead; a crash that left it needs a hand removal.
    fs.writeFileSync(lockPath, 'not-json-not-a-pid');
    expect(await acquireLock(lockPath)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('not-json-not-a-pid');
  });

  it('grants the lock to exactly one of many concurrent reclaimers of a STALE lock', async () => {
    // The reviewer's repro: a dead-PID lock already on disk, many processes race
    // to reclaim it at once. The reclaim is serialized behind a sentinel, so the
    // stale lock is taken over exactly once — never two winners.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, owner: 'dead', startedAt: 'x' }));
    const results = await Promise.all(
      Array.from({ length: 32 }, () => acquireLock(lockPath)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // The surviving lock belongs to this process (the single winner).
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    await releaseLock(lockPath);
    // After release the winner is gone and the path is re-acquirable.
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(await acquireLock(lockPath)).toBe(true);
    await releaseLock(lockPath);
  });
});

describe('acquireLock never takes over a lock another live process may hold (#760)', () => {
  it('does not rename over a lock it could not read (released and re-created in between)', async () => {
    // Another process holds the lock; this one only ever sees it vanish, as when
    // the previous holder released it and a third process re-created it between
    // this process's failed create and its read.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'other', startedAt: 'x' }));
    const readFile = vi.spyOn(fse, 'readFile').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    try {
      expect(await acquireLock(lockPath)).toBe(false);
    } finally {
      readFile.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('other');
  });

  it('takes a lock released between its failed create and its read, instead of reporting busy', async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'other', startedAt: 'x' }));
    const readFile = vi.spyOn(fse, 'readFile').mockImplementationOnce(async () => {
      fs.rmSync(lockPath); // the holder releases it
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    try {
      expect(await acquireLock(lockPath)).toBe(true);
    } finally {
      readFile.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    await releaseLock(lockPath);
  });

  it('under the reclaim sentinel, does not rename over a stale lock that vanished and was re-created', async () => {
    // The first pass sees a dead owner and takes the sentinel; by the second pass
    // the dead lock was cleared and another process re-created it.
    const dead = JSON.stringify({ pid: 999999, owner: 'dead', startedAt: 'x' });
    fs.writeFileSync(lockPath, dead);
    const readFile = vi.spyOn(fse, 'readFile')
      .mockImplementationOnce(async () => dead)
      .mockImplementationOnce(async () => {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'other', startedAt: 'x' }));
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
    try {
      expect(await acquireLock(lockPath)).toBe(false);
    } finally {
      readFile.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('other');
  });

  it('does not reclaim a lock whose owner is alive but belongs to another user (EPERM)', async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, owner: 'root-owned', startedAt: 'x' }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    try {
      expect(await acquireLock(lockPath)).toBe(false);
    } finally {
      kill.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('root-owned');
  });

  it('a creator stalled mid-create does not end up sharing the lock', async () => {
    // Model the syscalls: a write straight to the lock name is an O_EXCL create,
    // which opens the file before writing it; any other write lands whole. The
    // first acquirer stalls inside its write until a second acquirer has had its
    // try.
    let resume = (): void => {};
    const stalled = new Promise<void>((resolve) => { resume = resolve; });
    const writeFile = vi.spyOn(fse, 'writeFile').mockImplementationOnce(async (file, data) => {
      if (file === lockPath) fs.writeFileSync(file, '', { flag: 'wx' });
      await stalled;
      fs.writeFileSync(file, data);
    });
    try {
      const first = acquireLock(lockPath);
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
      const second = await acquireLock(lockPath);
      resume();
      expect([await first, second].filter(Boolean)).toHaveLength(1);
    } finally {
      resume();
      writeFile.mockRestore();
    }
  });

  it('still locks on a filesystem without hard links (falls back to O_EXCL)', async () => {
    const link = vi.spyOn(fse, 'link').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    try {
      expect(await acquireLock(lockPath)).toBe(true);
      expect(await acquireLock(lockPath)).toBe(false);
    } finally {
      link.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await releaseLock(lockPath);
  });

  it('without hard links, a creator stalled for any time keeps its lock', async () => {
    // O_EXCL fallback: the first acquirer opens the lock and stalls before
    // writing; a second one finds it empty and must back off.
    let resume = (): void => {};
    const stalled = new Promise<void>((resolve) => { resume = resolve; });
    let stalledOnce = false;
    vi.spyOn(fse, 'link').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    vi.spyOn(fse, 'writeFile').mockImplementation(async (file, data) => {
      if (file === lockPath && !stalledOnce) {
        stalledOnce = true;
        const fd = fs.openSync(file, 'wx');
        await stalled;
        fs.writeSync(fd, String(data));
        fs.closeSync(fd);
        return;
      }
      fs.writeFileSync(file, data, { flag: file === lockPath || String(file).endsWith('.sentinel') ? 'wx' : 'w' });
    });
    try {
      const first = acquireLock(lockPath);
      await vi.waitFor(() => expect(stalledOnce).toBe(true));
      const second = await acquireLock(lockPath);
      resume();
      expect([await first, second]).toEqual([true, false]);
    } finally {
      resume();
      vi.restoreAllMocks();
    }
    await releaseLock(lockPath);
  });

  it('does not reclaim a lock it cannot read (EACCES: e.g. a root-owned 0600 lock)', async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, owner: 'root-owned', startedAt: 'x' }));
    const readFile = vi.spyOn(fse, 'readFile').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    try {
      expect(await acquireLock(lockPath)).toBe(false);
    } finally {
      readFile.mockRestore();
    }
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('root-owned');
  });

  it('does not reclaim an empty lock (its owner may still be writing it)', async () => {
    fs.writeFileSync(lockPath, '');
    expect(await acquireLock(lockPath)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('');
  });

  it('does not reclaim a partly written lock (its creator is mid-write)', async () => {
    fs.writeFileSync(lockPath, '{"pid":99');
    expect(await acquireLock(lockPath)).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('{"pid":99');
  });
});

describe('acquireLock filesystem failures (#999)', () => {
  it('rejects when the parent path is a file, rather than reporting contention', async () => {
    const parent = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(parent, 'keep');
    await expect(acquireLock(path.join(parent, '.lock'))).rejects.toThrow(parent);
    expect(fs.readFileSync(parent, 'utf-8')).toBe('keep');
  });

  it.each(['EACCES', 'ENOSPC'])('rejects a temp-file write failure (%s)', async (code) => {
    const error = Object.assign(new Error(`${code}: cannot write`), { code });
    const write = vi.spyOn(fse, 'writeFile').mockRejectedValueOnce(error);
    try {
      await expect(acquireLock(lockPath)).rejects.toMatchObject({ cause: error, message: expect.stringContaining(lockPath) });
      expect(fs.existsSync(lockPath)).toBe(false);
      await releaseLock(lockPath);
      expect(await acquireLock(lockPath)).toBe(true);
      await releaseLock(lockPath);
    } finally {
      write.mockRestore();
    }
  });

  it('rejects an exclusive-create permission failure on a filesystem without hard links', async () => {
    const error = Object.assign(new Error('EACCES: cannot create lock'), { code: 'EACCES' });
    const link = vi.spyOn(fse, 'link').mockRejectedValueOnce(Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }));
    const write = vi.spyOn(fse, 'writeFile').mockImplementation(async (file, data) => {
      if (file === lockPath) throw error;
      fs.writeFileSync(file, data);
    });
    try {
      await expect(acquireLock(lockPath)).rejects.toMatchObject({ cause: error });
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      link.mockRestore();
      write.mockRestore();
    }
  });

  it('rejects a reclaim-sentinel rename failure and preserves the stale lock', async () => {
    const dead = JSON.stringify({ pid: 999999, owner: 'dead', startedAt: 'x' });
    fs.writeFileSync(lockPath, dead);
    fs.writeFileSync(`${lockPath}.sentinel`, dead);
    const error = Object.assign(new Error('EPERM: cannot rename sentinel'), { code: 'EPERM' });
    const rename = vi.spyOn(fse, 'rename').mockRejectedValueOnce(error);
    try {
      await expect(acquireLock(lockPath)).rejects.toMatchObject({ cause: error });
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(dead);
      expect(fs.readFileSync(`${lockPath}.sentinel`, 'utf-8')).toBe(dead);
    } finally {
      rename.mockRestore();
    }
  });

  it('still backs off when another reclaimer removes the stale sentinel first', async () => {
    const dead = JSON.stringify({ pid: 999999, owner: 'dead', startedAt: 'x' });
    fs.writeFileSync(lockPath, dead);
    fs.writeFileSync(`${lockPath}.sentinel`, dead);
    const rename = vi.spyOn(fse, 'rename').mockImplementationOnce(async () => {
      fs.rmSync(`${lockPath}.sentinel`);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    try {
      expect(await acquireLock(lockPath)).toBe(false);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(dead);
    } finally {
      rename.mockRestore();
    }
  });

  it('rejects a stale-lock replacement failure and releases its reclaim sentinel', async () => {
    const dead = JSON.stringify({ pid: 999999, owner: 'dead', startedAt: 'x' });
    fs.writeFileSync(lockPath, dead);
    const error = Object.assign(new Error('EPERM: cannot replace lock'), { code: 'EPERM' });
    const rename = vi.spyOn(fse, 'rename').mockRejectedValueOnce(error);
    try {
      await expect(acquireLock(lockPath)).rejects.toMatchObject({ cause: error });
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(dead);
      expect(fs.existsSync(`${lockPath}.sentinel`)).toBe(false);
    } finally {
      rename.mockRestore();
    }
  });
});

describe('acquireLock dry-run filesystem errors (#999)', () => {
  it.each(['ENOTDIR', 'EISDIR', 'EIO'])('reports a read failure (%s) without writing a lock', async (code) => {
    const error = Object.assign(new Error(`${code}: cannot read lock`), { code });
    const read = vi.spyOn(fse, 'readFile').mockRejectedValueOnce(error);
    try {
      await expect(acquireLock(lockPath, { dryRun: true })).rejects.toMatchObject({
        cause: error, message: expect.stringContaining(`Cannot acquire lock ${lockPath}:`),
      });
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it('rejects a directory at the lock path and leaves its contents untouched', async () => {
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'keep'), 'keep');
    await expect(acquireLock(lockPath, { dryRun: true })).rejects.toThrow(lockPath);
    await releaseLock(lockPath);
    expect(fs.readdirSync(tmpDir)).toEqual(['.test-lock']);
    expect(fs.readFileSync(path.join(lockPath, 'keep'), 'utf-8')).toBe('keep');
  });

  it.each(['EACCES', 'EPERM'])('still treats a permission-denied existing lock as held (%s)', async (code) => {
    const payload = JSON.stringify({ pid: process.pid, owner: 'other', startedAt: 'x' });
    fs.writeFileSync(lockPath, payload);
    const read = vi.spyOn(fse, 'readFile').mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    try {
      expect(await acquireLock(lockPath, { dryRun: true })).toBe(false);
      await releaseLock(lockPath);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(payload);
    } finally {
      read.mockRestore();
    }
  });

  it('does not create a missing parent directory', async () => {
    const nested = path.join(tmpDir, 'missing', '.lock');
    expect(await acquireLock(nested, { dryRun: true })).toBe(true);
    await releaseLock(nested);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it.each([{ pid: process.pid, available: false }, { pid: 999999, available: true }])(
    'preserves a lock owned by pid $pid, including after release', async ({ pid, available }) => {
      const payload = JSON.stringify({ pid, owner: 'other', startedAt: 'x' });
      fs.writeFileSync(lockPath, payload);
      expect(await acquireLock(lockPath, { dryRun: true })).toBe(available);
      await releaseLock(lockPath);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(payload);
      expect(fs.readdirSync(tmpDir)).toEqual(['.test-lock']);
    },
  );

  it('still treats an ownerless lock as held', async () => {
    fs.writeFileSync(lockPath, '');
    expect(await acquireLock(lockPath, { dryRun: true })).toBe(false);
    await releaseLock(lockPath);
    expect(fs.readFileSync(lockPath, 'utf-8')).toBe('');
  });
});

describe('releaseLock (real fs)', () => {
  it('removes a lock this process owns', async () => {
    await acquireLock(lockPath);
    await releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does NOT delete a lock this process never acquired (owner-verified release)', async () => {
    // A lock on disk that we never acquired through acquireLock (no owner token).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'other', startedAt: 'x' }));
    await releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('other');
  });

  it('does NOT delete a lock that was reclaimed by another owner', async () => {
    await acquireLock(lockPath);
    // Simulate: we went stale and another process took over — the on-disk owner
    // token no longer matches ours.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4321, owner: 'someone-else', startedAt: 'x' }));
    await releaseLock(lockPath);
    // The other owner's lock survives.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).owner).toBe('someone-else');
  });

  it('allows re-acquisition after a clean release', async () => {
    expect(await acquireLock(lockPath)).toBe(true);
    await releaseLock(lockPath);
    expect(await acquireLock(lockPath)).toBe(true);
    await releaseLock(lockPath);
  });
});

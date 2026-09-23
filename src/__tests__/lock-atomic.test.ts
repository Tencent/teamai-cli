import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock } from '../update.js';

// ─── Real-filesystem tests for the atomic lock (issue #374 P0) ──────────────
//
// These exercise acquireLock/releaseLock against a real temp directory (no fs
// mock), so the OS-level O_CREAT|O_EXCL ('wx') exclusivity and the on-disk owner
// token are genuinely tested — the thing the previous check-then-write lock got
// wrong.

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

  it('reclaims a lock whose contents are unparseable garbage', async () => {
    fs.writeFileSync(lockPath, 'not-json-not-a-pid');
    expect(await acquireLock(lockPath)).toBe(true);
    await releaseLock(lockPath);
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

  it('never publishes a partially written lock under concurrent creation', async () => {
    // Regression for #760: with `writeFile(..., { flag: 'wx' })` the lock file
    // existed empty/partial between the open and the write, so a concurrent
    // staleness check could read it as unparseable (reclaimable) and a
    // reclaimer could rename over a live holder. Every on-disk observation of
    // the lock must now be complete, parseable JSON because creation is
    // published with an atomic temp-write + hard-link.
    const readerErrors: string[] = [];
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        // Yield so the async writers make progress between observations.
        await new Promise((resolve) => setImmediate(resolve));
        try {
          const payload: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
          if (
            typeof payload !== 'object'
            || payload === null
            || typeof (payload as { owner?: unknown }).owner !== 'string'
            || typeof (payload as { pid?: unknown }).pid !== 'number'
          ) {
            readerErrors.push(`incomplete lock payload: ${JSON.stringify(payload)}`);
          }
        } catch (err) {
          // ENOENT (released between observations) and Windows EPERM/EBUSY
          // (delete-pending or rename in flight) are transient states of an
          // absent or being-replaced lock; anything else — above all an
          // unparseable partial write — is a violation.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'EBUSY') {
            readerErrors.push(String(err));
          }
        }
      }
    })();

    const writers = Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 40; i++) {
        if (await acquireLock(lockPath)) await releaseLock(lockPath);
      }
    });
    await Promise.all(writers);
    stop = true;
    await reader;
    expect(readerErrors).toEqual([]);
  });
});

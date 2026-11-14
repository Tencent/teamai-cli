import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { spawnSync } from 'node:child_process';

import { appendJsonl, appendJsonlBatch, readJsonl, rewriteJsonl, HOOK_LOCK_WAIT } from '../utils/jsonl-store.js';

let dir: string;
const file = () => path.join(dir, 'recall-log.jsonl');
const lockPath = () => `${file()}.lock`;
const holdLock = (pid = process.pid) =>
  fse.outputFile(lockPath(), JSON.stringify({ pid, startedAt: new Date().toISOString(), owner: 'other' }));
const sideRecords = async () => (await fs.promises.readdir(dir)).filter((n) => n.startsWith('recall-log.pending-'));
const modeOf = async (p: string) => (await fs.promises.stat(p)).mode & 0o777;
// Windows has no POSIX permission bits to assert on.
const posixIt = process.platform === 'win32' ? it.skip : it;

beforeEach(async () => {
  dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-jsonl-store-'));
});

afterEach(async () => {
  await fse.remove(dir);
});

describe('jsonl store', () => {
  it('reads back what it appended, in order', async () => {
    await appendJsonl(file(), { kind: 'run', n: 1 });
    await appendJsonl(file(), { kind: 'claim', n: 2 });

    expect(await readJsonl(file())).toStrictEqual([{ kind: 'run', n: 1 }, { kind: 'claim', n: 2 }]);
  });

  posixIt('refuses to append where a FIFO sits, rather than report a record it wrote into the pipe as landed', async () => {
    spawnSync('mkfifo', [file()]);

    await expect(appendJsonl(file(), { kind: 'run', n: 1 })).rejects.toThrow('is a pipe, not a regular file');
  });

  // Outside Linux a holder's start is read through ps; a slow one must not hold a hook past its budget.
  (process.platform === 'win32' || process.platform === 'linux' ? it.skip : it)('keeps a hook append within its budget while ps answers slowly for a live holder', async () => {
    const bin = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-slow-ps-'));
    await fs.promises.writeFile(path.join(bin, 'ps'), '#!/bin/sh\nsleep 2\nexec /bin/ps "$@"\n', { mode: 0o755 });
    await holdLock();
    vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
    try {
      const started = performance.now();
      const side = await appendJsonl(file(), { kind: 'run', n: 1 }, { wait: HOOK_LOCK_WAIT });

      expect(performance.now() - started).toBeLessThan(1000);
      expect(side).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(bin);
    }
  });

  it('reads nothing where nothing was recorded', async () => {
    expect(await readJsonl(file())).toEqual([]);
  });

  posixIt('keeps the file and its side records owner-only', async () => {
    await appendJsonl(file(), { n: 1 });
    await holdLock();
    await appendJsonl(file(), { n: 2 });

    expect(await modeOf(file())).toBe(0o600);
    expect(await modeOf(path.join(dir, (await sideRecords())[0]))).toBe(0o600);
  });

  posixIt('keeps a side record owner-only while there is no file yet', async () => {
    await holdLock();
    await appendJsonl(file(), { n: 1 });

    expect(await modeOf(path.join(dir, (await sideRecords())[0]))).toBe(0o600);
  });

  it('gives up on a held lock within the hook wait and still reads the record', async () => {
    await appendJsonl(file(), { n: 1 });
    await holdLock();

    const started = Date.now();
    await appendJsonl(file(), { n: 2 });

    expect(Date.now() - started).toBeLessThan(HOOK_LOCK_WAIT.budgetMs + 750);
    expect(await sideRecords()).toHaveLength(1);
    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 2 }]);
    expect(await readJsonl(file(), { includePending: false })).toStrictEqual([{ n: 1 }]);
  });

  it('folds side records in at the next append, each once', async () => {
    await holdLock();
    await appendJsonl(file(), { n: 1 });
    await appendJsonl(file(), { n: 1 });
    await fs.promises.rm(lockPath());

    await appendJsonl(file(), { n: 2 });

    expect(await sideRecords()).toEqual([]);
    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 1 }, { n: 2 }]);
  });

  it('reads a side record once when a fold appended it but died before removing it', async () => {
    await holdLock();
    await appendJsonl(file(), { n: 1 });
    const [side] = await sideRecords();
    await fs.promises.writeFile(file(), await fs.promises.readFile(path.join(dir, side), 'utf-8'));

    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }]);
  });

  it.each(['main', 'pending'])('keeps a side record visible when a fold races the %s file read', async (during) => {
    await appendJsonl(file(), { n: 1 });
    await holdLock();
    await appendJsonl(file(), { n: 2 }, { wait: { budgetMs: 0, delayMs: 0 } });
    const [side] = await sideRecords();
    await fs.promises.rm(lockPath());
    const realOpen = fs.promises.open.bind(fs.promises);
    let folded = false;
    const read = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      if (!folded && during === 'pending' && args[0] === path.join(dir, side)) {
        folded = true;
        await appendJsonl(file(), { n: 3 });
      }

      const handle = await realOpen(...args);

      if (during === 'main' && args[0] === file()) {
        const realRead = handle.readFile.bind(handle);
        vi.spyOn(handle, 'readFile').mockImplementation(async (options) => {
          const content = await realRead(options);

          if (!folded) {
            folded = true;
            await appendJsonl(file(), { n: 3 });
          }

          return content;
        });
      }

      return handle;
    });

    try {
      const records = await readJsonl(file());
      expect(folded).toBe(true);
      expect(records.filter((record) => record.n === 1)).toStrictEqual([{ n: 1 }]);
      expect(records.filter((record) => record.n === 2)).toStrictEqual([{ n: 2 }]);
      expect(await sideRecords()).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it('appends a batch in order, and records it in one side record while the lock is held', async () => {
    await appendJsonlBatch(file(), [{ n: 1 }, { n: 2 }]);
    await holdLock();
    await appendJsonlBatch(file(), [{ n: 3 }, { n: 4 }, { n: 5 }]);

    expect(await sideRecords()).toHaveLength(1);
    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);

    await fs.promises.rm(lockPath());
    await appendJsonl(file(), { n: 6 });

    expect(await sideRecords()).toEqual([]);
    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }]);
  });

  it('writes nothing for an empty batch', async () => {
    expect(await appendJsonlBatch(file(), [])).toBeNull();

    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('folds each line of a batch side record once when a fold appended only part of it', async () => {
    await holdLock();
    await appendJsonlBatch(file(), [{ n: 1 }, { n: 2 }]);
    const [side] = await sideRecords();
    const [first] = (await fs.promises.readFile(path.join(dir, side), 'utf-8')).split('\n');
    // A fold that was killed after appending the batch's first line.
    await fs.promises.writeFile(file(), `${first}\n`);
    await fs.promises.rm(lockPath());

    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 2 }]);

    await appendJsonl(file(), { n: 3 });

    expect(await sideRecords()).toEqual([]);
    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('skips a side record that is still being written', async () => {
    await fse.outputFile(path.join(dir, 'recall-log.pending-00000000-0000-4000-8000-000000000000.jsonl'), '{"n":');
    await appendJsonl(file(), { n: 1 });

    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }]);
  });

  it('skips a malformed trailing line on read, and appends after it without losing the next record', async () => {
    await fs.promises.writeFile(file(), '{"n":1}\n{"n":2,"kind":"ru');

    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }]);

    await appendJsonl(file(), { n: 3 });

    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 3 }]);
  });

  it('leaves the file consistent when an append finishes after its caller timed out', async () => {
    await appendJsonl(file(), { n: 1 });
    await holdLock();
    const late = appendJsonl(file(), { n: 2 }, { wait: { budgetMs: 2_000, delayMs: 10 } });

    const outcome = await Promise.race([late.then(() => 'done'), new Promise((r) => setTimeout(() => r('timed out'), 50))]);
    expect(outcome).toBe('timed out');
    await fs.promises.rm(lockPath());
    await late;
    await appendJsonl(file(), { n: 3 });

    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await sideRecords()).toEqual([]);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it('reclaims the lock of an append whose process was killed', async () => {
    await holdLock(spawnSync(process.execPath, ['-e', '']).pid ?? 0);

    await appendJsonl(file(), { n: 1 });

    expect(await sideRecords()).toEqual([]);
    expect(await readJsonl(file())).toStrictEqual([{ n: 1 }]);
  });

  it('prunes by rewriting under the lock, folding side records in first', async () => {
    for (const n of [1, 2, 3]) await appendJsonl(file(), { n });
    await holdLock();
    await appendJsonl(file(), { n: 4 });
    await fs.promises.rm(lockPath());

    await rewriteJsonl(file(), (lines) => lines.filter((l) => (JSON.parse(l) as { n: number }).n % 2 === 0));

    expect(await sideRecords()).toEqual([]);
    expect(await readJsonl(file())).toStrictEqual([{ n: 2 }, { n: 4 }]);
  });

  posixIt('keeps the file owner-only after a rewrite', async () => {
    for (const n of [1, 2]) await appendJsonl(file(), { n });

    await rewriteJsonl(file(), (lines) => lines.slice(1));

    expect(await modeOf(file())).toBe(0o600);
  });

  it('leaves the file untouched when a rewrite keeps nothing new', async () => {
    await appendJsonl(file(), { n: 1 });
    const before = await fs.promises.readFile(file(), 'utf-8');

    await rewriteJsonl(file(), () => null);

    expect(await fs.promises.readFile(file(), 'utf-8')).toBe(before);
  });

  it('refuses to rewrite while another holder keeps the lock', async () => {
    await appendJsonl(file(), { n: 1 });
    const before = await fs.promises.readFile(file(), 'utf-8');
    await holdLock();

    await expect(rewriteJsonl(file(), () => [], { wait: { budgetMs: 100, delayMs: 10 } })).rejects.toThrow(/still held/);
    expect(await fs.promises.readFile(file(), 'utf-8')).toBe(before);
  });
});

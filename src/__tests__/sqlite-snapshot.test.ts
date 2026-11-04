import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotSqlite } from '../session-flow/sqlite.js';

const HAS_SQLITE3 = process.platform !== 'win32' && spawnSync('sqlite3', ['-version']).status === 0;
const dirs: string[] = [];
const writers: ChildProcessWithoutNullStreams[] = [];

function workdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-sqlite-snapshot-'));
  dirs.push(dir);
  return dir;
}

function count(db: string): string {
  return spawnSync('sqlite3', [db, 'SELECT count(*) FROM t;'], { encoding: 'utf8' }).stdout.trim();
}

afterEach(() => {
  for (const writer of writers.splice(0)) writer.kill();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_SQLITE3)('snapshotSqlite', () => {
  it('copies a WAL database its writer closed, without writing beside it', async () => {
    const dir = workdir();
    const db = path.join(dir, 'state.db');
    expect(spawnSync('sqlite3', [db, 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1), (2); PRAGMA wal_checkpoint(TRUNCATE);']).status).toBe(0);
    // A writer that closes cleanly leaves neither file; some sqlite3 builds keep them, so remove them as it would.
    fs.rmSync(`${db}-wal`, { force: true });
    fs.rmSync(`${db}-shm`, { force: true });
    const before = fs.readdirSync(dir).sort();
    const target = path.join(workdir(), 'copy.db');

    await snapshotSqlite('sqlite3', db, target);

    expect(count(target)).toBe('2');
    expect(fs.readdirSync(dir).sort()).toEqual(before);
  });

  it('includes the rows a writer that still has it open has not checkpointed', async () => {
    const dir = workdir();
    const db = path.join(dir, 'state.db');
    const writer = spawn('sqlite3', [db]);
    writers.push(writer);
    writer.stdin.write('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(x); INSERT INTO t VALUES (1), (2), (3);\n');
    await expect.poll(() => fs.existsSync(`${db}-shm`) && fs.existsSync(`${db}-wal`)).toBe(true);
    await expect.poll(() => count(db)).toBe('3');
    const target = path.join(workdir(), 'copy.db');

    await snapshotSqlite('sqlite3', db, target);

    expect(count(target)).toBe('3');
  });
});

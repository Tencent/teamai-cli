/**
 * sqlite.ts -- shared access to the local index DBs of the target clients
 * (Cursor / Codex / WorkBuddy).
 *
 * Those DBs are owned by the client processes; TeamAI only performs tiny
 * upserts/deletes during migration and rollback. We drive the sqlite3 CLI
 * instead of a node driver: no extra dependency, and macOS ships sqlite3
 * (WAL and busy_timeout supported).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WIN_EXEC_EXTENSIONS } from '../utils/cli-path.js';
import { execCommand } from '../utils/exec.js';

/** Locate the sqlite3 CLI: PATH first, then well-known install locations off Windows.
 *  On Windows a PATH entry holds `sqlite3.exe`, so the name carries the extension.
 *  Each caller says what a missing CLI means for the write it skips. */
export function findSqlite3(platform: NodeJS.Platform = process.platform): string | null {
  const names = platform === 'win32' ? WIN_EXEC_EXTENSIONS.map((ext) => `sqlite3${ext}`) : ['sqlite3'];

  const onPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((d) => names.map((name) => path.join(d, name)));

  const candidates =
    platform === 'win32' ? onPath : [...onPath, '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3'];

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);

      return p;
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Writes a consistent copy of `db`, a database another tool owns and may be writing in WAL mode, to `target`, without
 * creating anything beside it. While a writer has it open, its `-shm` file exists, and sqlite3 takes the snapshot with a
 * read-only `.backup`: copying the file and its `-wal` separately can straddle a checkpoint and lose committed rows.
 * Without a `-shm`, no writer has it open, so the file and the `-wal` it left are the whole database and are copied as
 * they are. A read-only connection could not open it then: it would have to create the `-shm`.
 */
export async function snapshotSqlite(sqlite3: string, db: string, target: string): Promise<void> {
  if (!fs.existsSync(`${db}-shm`)) {
    await fs.promises.copyFile(db, target);
    await fs.promises.copyFile(`${db}-wal`, `${target}-wal`).catch((cause: unknown) => {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause;
    });

    return;
  }

  // sqlite3 reads backslash escapes inside a quoted dot-command argument, so the path is given with forward slashes.
  const backup = await execCommand(sqlite3, [`${pathToFileURL(db).href}?mode=ro`, `.backup "${target.replaceAll('\\', '/')}"`], { timeoutMs: 30_000 });

  if (backup.code !== 0) throw new Error(`sqlite3 could not snapshot ${db}: ${backup.stderr.trim() || `exit ${backup.code}`}`);
}

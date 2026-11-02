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
import { WIN_EXEC_EXTENSIONS } from '../utils/cli-path.js';

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

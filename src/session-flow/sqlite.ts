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

/** Locate the sqlite3 CLI: PATH first, then well-known install locations.
 *  Callers should degrade to "skip the index write" when it is missing. */
export function findSqlite3(): string | null {
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((d) => path.join(d, 'sqlite3')),
    '/usr/bin/sqlite3',
    '/opt/homebrew/bin/sqlite3',
    '/usr/local/bin/sqlite3',
  ];
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

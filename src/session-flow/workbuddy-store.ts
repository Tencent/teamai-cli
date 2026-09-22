/**
 * workbuddy-store.ts -- register migrated sessions into WorkBuddy's local database.
 *
 * Background: WorkBuddy's task/space list does **not** scan
 * `~/.workbuddy/projects/<proj>/*.jsonl`; it queries the `sessions` table in
 * `~/.workbuddy/workbuddy.db` (Drizzle + WAL):
 *   - list entries = sessions rows (title / updated_at / cwd / is_playground ...)
 *   - space grouping = the workspaces table (path + last_opened_at)
 * Writing only the jsonl leaves the session invisible in WorkBuddy -- the
 * migration "succeeds" but shows nothing. Same class of problem as Cursor's
 * composerHeaders and Codex's state_5.threads.
 *
 * Best-effort, in order:
 *   1. make sure the cwd exists in workspaces (otherwise the session belongs
 *      to no space)
 *   2. upsert a sessions row (user_id reuses the value already in the DB --
 *      it is an account id and must not be invented)
 *   3. on failure return {ok:false, reason}; the caller decides what to show.
 *      The jsonl is already on disk either way.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getWorkBuddyProjectsDir } from './fs.js';
import { findSqlite3 } from './sqlite.js';

 /** WorkBuddy data root (`~/.workbuddy`; projects/ and the DB live under it). */
export function getWorkBuddyHome(): string {
  return path.dirname(getWorkBuddyProjectsDir());
}

export function getWorkBuddyDbPath(): string {
  return path.join(getWorkBuddyHome(), 'workbuddy.db');
}

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

 /** Run a SQL script through the sqlite3 CLI (temp file, mode 0600, deleted after). */
function runSql(dbPath: string, sql: string, timeoutMs = 30_000): { ok: boolean; reason?: string } {
  const sqlite3 = findSqlite3();
  if (!sqlite3) return { ok: false, reason: 'sqlite3 CLI not found' };

  const sqlPath = path.join(os.tmpdir(), `teamai-workbuddy-${process.pid}-${Date.now()}.sql`);
  try {
    fs.writeFileSync(sqlPath, sql, { encoding: 'utf-8', mode: 0o600 });
    const r = spawnSync(sqlite3, [dbPath], {
      input: fs.readFileSync(sqlPath),
      maxBuffer: 32 * 1024 * 1024,
      timeout: timeoutMs,
    });
    if (r.status !== 0) {
      const stderr = (r.stderr?.toString() ?? '').trim();
      return { ok: false, reason: stderr.slice(0, 300) || `sqlite3 exit ${r.status}` };
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    try {
      fs.unlinkSync(sqlPath);
    } catch {
      // ignore
    }
  }
  return { ok: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the account id (sessions.user_id is NOT NULL and the client filters the list by it).
 *
 * Multi-source discovery, most reliable first:
 *   1. user_id on existing session rows in workbuddy.db -- most authoritative (the client wrote it)
 *   2. directory name of ~/.workbuddy/connectors/<uuid>/ -- per-account dir, observed to equal user_id
 *   3. a uuid found in ~/.workbuddy/app/sessions.json -- last resort
 *
 * Do **not** fall back to ~/.workbuddy/device-id: it is a device id, not the account id
 * (they differ in practice), so the client's user filter would still hide the session and we
 * would leave a dirty row behind. Returns null when no source has it; the caller skips registration and warns.
 */
function readUserId(dbPath: string): string | null {
  const sqlite3 = findSqlite3();

   // 1) existing session rows
  if (sqlite3 && fs.existsSync(dbPath)) {
    try {
      const r = spawnSync(
        sqlite3,
        ['-readonly', dbPath, "select user_id from sessions where user_id is not null and user_id <> '' limit 1;"],
        { encoding: 'utf-8', timeout: 10_000 },
      );
      const v = (r.stdout ?? '').trim();
      if (UUID_RE.test(v)) return v;
    } catch {
       // fall through to the next source
    }
  }

  const home = getWorkBuddyHome();

   // 2) connectors/<uuid> directory names
  try {
    const connectorsDir = path.join(home, 'connectors');
    for (const name of fs.readdirSync(connectorsDir)) {
      if (UUID_RE.test(name)) return name;
    }
  } catch {
     // fall through to the next source
  }

   // 3) uuid in app/sessions.json
  try {
    const raw = fs.readFileSync(path.join(home, 'app', 'sessions.json'), 'utf-8');
    for (const m of raw.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
      return m[0];
    }
  } catch {
     // nothing available: skip registration
  }

  return null;
}

export interface RegisterWorkBuddySessionArgs {
   /** Session working directory (absolute; decides which space it lands in). */
  cwd: string;
  sessionId: string;
  title: string;
   /** epoch milliseconds. */
  createdAtMs: number;
  updatedAtMs: number;
   /** Source session model name (optional; natives commonly use 'auto'). */
  model?: string;
}

export interface RegisterWorkBuddyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Register the session in WorkBuddy's sessions table (and the workspaces row as needed).
 *
 * Idempotent: re-migrating the same sessionId hits ON CONFLICT DO UPDATE -- no duplicates.
 */
export function registerWorkBuddySession(args: RegisterWorkBuddySessionArgs): RegisterWorkBuddyResult {
  const dbPath = getWorkBuddyDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `workbuddy.db not found: ${dbPath}` };
  }

   // user_id is the account id; inventing one makes the client's user filter hide the row.
  const userId = readUserId(dbPath);
  if (!userId) {
    return { ok: false, reason: 'no existing session row to derive user_id from' };
  }

  const created = Number.isFinite(args.createdAtMs) ? args.createdAtMs : Date.now();
  const updated = Number.isFinite(args.updatedAtMs) ? args.updatedAtMs : created;
  const model = args.model && args.model.trim() ? args.model.trim() : 'auto';

  const sql = [
     // The client holds a write lock at runtime: bound the wait so the CLI cannot hang.
    'PRAGMA busy_timeout=5000;',
    'BEGIN IMMEDIATE;',
     // 1) the space row -- without it the session belongs to no space and has nowhere to show
    'INSERT INTO workspaces (path, last_opened_at) VALUES ' +
      `('${esc(args.cwd)}', ${updated}) ` +
      `ON CONFLICT(path) DO UPDATE SET last_opened_at = MAX(last_opened_at, ${updated});`,
     // 2) the session row. is_playground=0 puts it in the space list (matches a native
     //    in-project session); custom_title stays empty so `title` takes effect.
    'INSERT INTO sessions ' +
      '(id, cwd, user_id, title, custom_title, status, created_at, updated_at, deleted_at, ' +
      'is_playground, source_mode, model, last_activity_at) VALUES (' +
      `'${esc(args.sessionId)}','${esc(args.cwd)}','${esc(userId)}','${esc(args.title)}','',` +
      `'completed',${created},${updated},NULL,0,NULL,'${esc(model)}',${updated}) ` +
      'ON CONFLICT(id) DO UPDATE SET ' +
      'cwd=excluded.cwd, title=excluded.title, status=excluded.status, ' +
      'updated_at=excluded.updated_at, last_activity_at=excluded.last_activity_at;',
    'COMMIT;',
  ].join('\n');

  return runSql(dbPath, sql);
}

 /** Remove the session from WorkBuddy's list (called on rollback / delete). */
export function unregisterWorkBuddySession(sessionId: string): RegisterWorkBuddyResult {
  const dbPath = getWorkBuddyDbPath();
  if (!fs.existsSync(dbPath)) return { ok: false, reason: 'workbuddy.db not found' };
  const sql =
    'PRAGMA busy_timeout=5000;\n' +
    'BEGIN IMMEDIATE;\n' +
    `DELETE FROM sessions WHERE id='${esc(sessionId)}';\n` +
    'COMMIT;';
  return runSql(dbPath, sql);
}

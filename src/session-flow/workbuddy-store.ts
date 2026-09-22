/**
 * workbuddy-store.ts — 把迁移出来的会话注册进 WorkBuddy 的本地数据库。
 *
 * 背景：WorkBuddy 的「任务 / 空间」列表**不是**扫 `~/.workbuddy/projects/<proj>/*.jsonl`
 * 列出来的，而是查 `~/.workbuddy/workbuddy.db` 的 `sessions` 表（Drizzle + WAL）：
 *   - 列表项 = sessions 行（title / updated_at / cwd / is_playground …）
 *   - 空间分组 = workspaces 表（path + last_opened_at）
 * 只写 jsonl 的话会话在 WorkBuddy 里完全不可见（迁移「成功」但看不到），
 * 与 Cursor 的 composerHeaders / Codex 的 state_5.threads 是同一类问题。
 *
 * 这里 best-effort 做三件事：
 *   1. 确保 workspaces 里有该 cwd（否则会话不属于任何「空间」）
 *   2. upsert 一条 sessions 行（user_id 沿用库内既有值——它是账号标识，不能编造）
 *   3. 失败一律返回 {ok:false, reason}，由调用方决定是否提示；不影响 jsonl 已落盘
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getWorkBuddyProjectsDir } from './fs.js';
import { findSqlite3 } from './sqlite.js';

/** WorkBuddy 数据根目录（`~/.workbuddy`，projects/db 都在其下）。 */
export function getWorkBuddyHome(): string {
  return path.dirname(getWorkBuddyProjectsDir());
}

export function getWorkBuddyDbPath(): string {
  return path.join(getWorkBuddyHome(), 'workbuddy.db');
}

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

/** 用 sqlite3 CLI 执行一段 SQL（临时文件 mode 0600，执行完删除）。 */
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
 * 取得本机的 WorkBuddy 账号标识 user_id（sessions.user_id 是 NOT NULL，且客户端按它过滤列表）。
 *
 * 多源探测，按可靠度降序：
 *   1. workbuddy.db 里既有会话行的 user_id —— 最权威（就是客户端自己写的）
 *   2. ~/.workbuddy/connectors/<uuid>/ 的目录名 —— 客户端按账号分的目录，实测与 user_id 同值
 *   3. ~/.workbuddy/app/sessions.json 里出现的 uuid —— 兜底
 *
 * 注意：**不要用 ~/.workbuddy/device-id 兜底**。实测 device-id(76345293-…) ≠ user_id(b2778798-…)，
 * 它是设备标识不是账号标识，写进去客户端仍按 user_id 过滤 → 会话照样不可见，还留一条脏数据。
 * 三个来源都拿不到（真·全新未登录）时返回 null，由调用方跳过注册并告警。
 */
function readUserId(dbPath: string): string | null {
  const sqlite3 = findSqlite3();

  // 1) 库内既有会话
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
      // 落到下一来源
    }
  }

  const home = getWorkBuddyHome();

  // 2) connectors/<uuid> 目录名
  try {
    const connectorsDir = path.join(home, 'connectors');
    for (const name of fs.readdirSync(connectorsDir)) {
      if (UUID_RE.test(name)) return name;
    }
  } catch {
    // 落到下一来源
  }

  // 3) app/sessions.json 里的 uuid
  try {
    const raw = fs.readFileSync(path.join(home, 'app', 'sessions.json'), 'utf-8');
    for (const m of raw.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
      return m[0];
    }
  } catch {
    // 拿不到就跳过注册
  }

  return null;
}

export interface RegisterWorkBuddySessionArgs {
  /** 会话工作目录（绝对路径，决定归属哪个「空间」）。 */
  cwd: string;
  sessionId: string;
  title: string;
  /** epoch 毫秒。 */
  createdAtMs: number;
  updatedAtMs: number;
  /** 源会话模型名（可空，原生常见 'auto'）。 */
  model?: string;
}

export interface RegisterWorkBuddyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 把会话注册进 WorkBuddy 的 sessions 表（并按需补 workspaces 行）。
 *
 * 幂等：同一 sessionId 重复迁移走 ON CONFLICT DO UPDATE，不会产生重复项。
 */
export function registerWorkBuddySession(args: RegisterWorkBuddySessionArgs): RegisterWorkBuddyResult {
  const dbPath = getWorkBuddyDbPath();
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: `workbuddy.db not found: ${dbPath}` };
  }

  // user_id 是账号标识，编造会导致列表按用户过滤时看不到 → 没有既有行就不写
  const userId = readUserId(dbPath);
  if (!userId) {
    return { ok: false, reason: 'no existing session row to derive user_id from' };
  }

  const created = Number.isFinite(args.createdAtMs) ? args.createdAtMs : Date.now();
  const updated = Number.isFinite(args.updatedAtMs) ? args.updatedAtMs : created;
  const model = args.model && args.model.trim() ? args.model.trim() : 'auto';

  const sql = [
    // WorkBuddy 运行时持有写锁：给有限 busy 超时，避免 CLI 挂起
    'PRAGMA busy_timeout=5000;',
    'BEGIN IMMEDIATE;',
    // 1) 空间（workspaces）——没有这行会话不属于任何空间，界面里无处显示
    'INSERT INTO workspaces (path, last_opened_at) VALUES ' +
      `('${esc(args.cwd)}', ${updated}) ` +
      `ON CONFLICT(path) DO UPDATE SET last_opened_at = MAX(last_opened_at, ${updated});`,
    // 2) 会话行。is_playground=0 → 归入「空间」列表（=0 与原生在项目里开的会话一致）；
    //    custom_title 留空，让 title 生效。
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

/** 从 WorkBuddy 列表里移除该会话（迁移回滚 / 删除会话时调用）。 */
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

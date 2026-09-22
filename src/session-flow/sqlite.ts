/**
 * sqlite.ts — 客户端本地库（Cursor/Codex/WorkBuddy 的索引库）访问的公共部分。
 *
 * 这些库都由各自客户端进程持有，TeamAI 只在迁移/回滚时做极小的 upsert / delete。
 * 统一用 sqlite3 CLI 而不是 node 驱动：无需额外依赖，且能天然复用 macOS 自带的
 * sqlite3（支持 WAL 与 busy_timeout）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 定位 sqlite3 CLI：PATH → 常见安装位置。找不到时调用方应降级为「不写索引」。 */
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

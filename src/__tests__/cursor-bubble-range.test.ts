import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCursorSessionId, cursorBubbleCleanupWhere } from '../session-flow/cursor-store.js';

describe('cursor bubble cleanup', () => {
  it('uses an index range and rejects wildcard ids', () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const where = cursorBubbleCleanupWhere(id);
    expect(where.toUpperCase()).not.toContain('LIKE');
    expect(assertCursorSessionId('%')).toBe('invalid session id');
    expect(assertCursorSessionId(id)).toBeNull();

    const db = path.join(os.tmpdir(), `teamai-bubble-range-${process.pid}.db`);
    const sql = `
      CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      INSERT INTO cursorDiskKV (key, value) VALUES
        ('bubbleId:${id}:ffffffff-ffff-4fff-8fff-ffffffffffff', 'own'),
        ('bubbleId:${id}-extra:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'longer'),
        ('bubbleId:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:aaa', 'other');
      DELETE FROM cursorDiskKV WHERE ${where};
      SELECT key FROM cursorDiskKV ORDER BY key;
    `;
    const r = spawnSync('sqlite3', [db], { input: sql, encoding: 'utf-8' });
    fs.rmSync(db, { force: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').sort()).toEqual([
      'bubbleId:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:aaa',
      `bubbleId:${id}-extra:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    ].sort());
  });
});

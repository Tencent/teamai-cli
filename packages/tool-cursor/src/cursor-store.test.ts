import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCursorSessionId, cursorBubbleCleanupWhere, getCursorStateRoot } from './cursor-store.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the IDE store root', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('honors XDG_CONFIG_HOME on Linux, as ide-history does', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const xdg = path.join(os.tmpdir(), 'teamai-cursor-xdg');
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    expect(getCursorStateRoot()).toBe(path.join(xdg, 'Cursor'));

    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    // `os.homedir()`, which is what cursor-store reads.
    expect(getCursorStateRoot()).toBe(path.join(os.homedir(), '.config', 'Cursor'));
  });

  it('treats a blank XDG_CONFIG_HOME as unset, not as the working directory', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('XDG_CONFIG_HOME', '');
    // `??` would keep the empty string, leaving the result a relative `Cursor`.
    expect(getCursorStateRoot()).toBe(path.join(os.homedir(), '.config', 'Cursor'));
  });
});

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

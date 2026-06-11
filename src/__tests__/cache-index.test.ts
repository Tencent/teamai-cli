import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    loadCacheIndex,
    saveCacheIndex,
    statDirSize,
    touchCacheEntry,
    type CacheIndex,
} from '../utils/cache-index.js';

// ─── Helpers ────────────────────────────────────────────

function makeTmpDir(): string {
    const tmp = path.join(os.tmpdir(), `cache-index-test-${randomUUID()}`);
    return tmp;
}

// ─── Tests ───────────────────────────────────────────────

describe('cache-index', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = makeTmpDir();
        await fs.ensureDir(tmpDir);
        process.env.TEAMAI_CACHE_DIR = tmpDir;
    });

    afterEach(async () => {
        delete process.env.TEAMAI_CACHE_DIR;
        await fs.remove(tmpDir);
        vi.restoreAllMocks();
    });

    // ─── loadCacheIndex ─────────────────────────────────

    describe('loadCacheIndex', () => {
        it('文件不存在时返回空索引', async () => {
            const idx = await loadCacheIndex();
            expect(idx.version).toBe(1);
            expect(idx.entries).toEqual([]);
        });

        it('文件损坏（非 JSON）时返回空索引（不抛错）', async () => {
            const indexPath = path.join(tmpDir, '.cache-index.json');
            await fs.writeFile(indexPath, 'NOT_VALID_JSON', 'utf8');

            const idx = await loadCacheIndex();
            expect(idx.version).toBe(1);
            expect(idx.entries).toEqual([]);
        });

        it('version 不符合时返回空索引', async () => {
            const indexPath = path.join(tmpDir, '.cache-index.json');
            await fs.writeFile(indexPath, JSON.stringify({ version: 2, entries: [] }), 'utf8');

            const idx = await loadCacheIndex();
            expect(idx.version).toBe(1);
            expect(idx.entries).toEqual([]);
        });
    });

    // ─── saveCacheIndex ─────────────────────────────────

    describe('saveCacheIndex', () => {
        it('往返一致', async () => {
            const idx: CacheIndex = {
                version: 1,
                updated_at: new Date().toISOString(),
                entries: [
                    {
                        key: 'github/owner/repo',
                        size_bytes: 1234,
                        last_used: '2025-01-01T00:00:00.000Z',
                        last_synced_sha: 'abc12345',
                    },
                ],
            };

            await saveCacheIndex(idx);
            const loaded = await loadCacheIndex();

            expect(loaded.version).toBe(1);
            expect(loaded.entries).toHaveLength(1);
            expect(loaded.entries[0].key).toBe('github/owner/repo');
            expect(loaded.entries[0].size_bytes).toBe(1234);
            expect(loaded.entries[0].last_synced_sha).toBe('abc12345');
        });
    });

    // ─── touchCacheEntry ────────────────────────────────

    describe('touchCacheEntry', () => {
        it('新增条目 + 计算 size_bytes', async () => {
            // 创建真实目录 + 文件
            const repoDir = path.join(tmpDir, 'github', 'myorg', 'myrepo');
            await fs.ensureDir(repoDir);
            await fs.writeFile(path.join(repoDir, 'file.txt'), 'hello world', 'utf8');

            await touchCacheEntry({ provider: 'github', owner: 'myorg', repo: 'myrepo' });

            const idx = await loadCacheIndex();
            expect(idx.entries).toHaveLength(1);
            expect(idx.entries[0].key).toBe('github/myorg/myrepo');
            expect(idx.entries[0].size_bytes).toBeGreaterThan(0);
            expect(idx.entries[0].last_used).toBeTruthy();
        });

        it('已存在条目 → 更新 last_used / size / sha 字段', async () => {
            const repoDir = path.join(tmpDir, 'github', 'myorg', 'myrepo');
            await fs.ensureDir(repoDir);
            await fs.writeFile(path.join(repoDir, 'file.txt'), 'content', 'utf8');

            // 第一次 touch
            await touchCacheEntry({ provider: 'github', owner: 'myorg', repo: 'myrepo', lastSyncedSha: 'sha1111' });
            const idx1 = await loadCacheIndex();
            const firstUsed = idx1.entries[0].last_used;

            // 等 1ms 后再 touch
            await new Promise((r) => setTimeout(r, 5));
            // 写大一点的文件
            await fs.writeFile(path.join(repoDir, 'big.txt'), 'x'.repeat(1000), 'utf8');
            await touchCacheEntry({ provider: 'github', owner: 'myorg', repo: 'myrepo', lastSyncedSha: 'sha2222' });

            const idx2 = await loadCacheIndex();
            expect(idx2.entries).toHaveLength(1);
            expect(idx2.entries[0].last_synced_sha).toBe('sha2222');
            expect(new Date(idx2.entries[0].last_used).getTime()).toBeGreaterThanOrEqual(
                new Date(firstUsed).getTime(),
            );
            expect(idx2.entries[0].size_bytes).toBeGreaterThanOrEqual(1000);
        });

        it('未提供 lastSyncedSha 时保留已有 sha', async () => {
            const repoDir = path.join(tmpDir, 'github', 'myorg', 'myrepo');
            await fs.ensureDir(repoDir);

            await touchCacheEntry({ provider: 'github', owner: 'myorg', repo: 'myrepo', lastSyncedSha: 'keepme' });
            await touchCacheEntry({ provider: 'github', owner: 'myorg', repo: 'myrepo' });

            const idx = await loadCacheIndex();
            expect(idx.entries[0].last_synced_sha).toBe('keepme');
        });
    });

    // ─── statDirSize ────────────────────────────────────

    describe('statDirSize', () => {
        it('目录不存在时返回 0', async () => {
            const size = await statDirSize(path.join(tmpDir, 'nonexistent'));
            expect(size).toBe(0);
        });

        it('真实递归累加文件大小', async () => {
            const dir = path.join(tmpDir, 'dirtest');
            await fs.ensureDir(path.join(dir, 'sub'));
            await fs.writeFile(path.join(dir, 'a.txt'), 'aa', 'utf8');             // 2 bytes
            await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'bbb', 'utf8');    // 3 bytes

            const size = await statDirSize(dir);
            expect(size).toBeGreaterThanOrEqual(5);
        });

        it('软链接跳过（不跟随）', async () => {
            const dir = path.join(tmpDir, 'linktest');
            await fs.ensureDir(dir);
            await fs.writeFile(path.join(dir, 'real.txt'), 'realcontent', 'utf8');

            // 软链目标不存在也没关系
            try {
                await fs.symlink(path.join(tmpDir, 'nonexist'), path.join(dir, 'link'));
            } catch {
                // 某些环境可能不支持软链接，直接跳过该断言
                return;
            }

            // 不应因软链抛错
            const size = await statDirSize(dir);
            expect(size).toBeGreaterThan(0);
        });
    });

    describe('loadCacheIndex — 文件大小限制', () => {
        it('索引文件超过 10 MB 时返回空索引（size 超限走 catch → 返回 emptyIndex）', async () => {
            const indexPath = path.join(tmpDir, '.cache-index.json');
            // 写入 11 MB 内容（真实文件，非 mock fs.stat）
            const chunk = 'x'.repeat(1024 * 1024);
            let content = '';
            for (let i = 0; i < 11; i++) content += chunk;
            await fs.writeFile(indexPath, content, 'utf8');

            // loadCacheIndex 内部 catch 会返回 emptyIndex 而非抛出
            // 但 size 超限路径会 throw，被 catch 捕获后返回空
            const idx = await loadCacheIndex();
            expect(idx.version).toBe(1);
            expect(idx.entries).toHaveLength(0);
        });
    });
});

import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    gcCache,
    getCacheStatus,
    loadCacheIndex,
    saveCacheIndex,
    type CacheIndex,
} from '../utils/cache-index.js';

// ─── Helpers ────────────────────────────────────────────

function makeTmpDir(): string {
    return path.join(os.tmpdir(), `cache-gc-test-${randomUUID()}`);
}

function daysAgo(days: number): string {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return d.toISOString();
}

/**
 * 创建一个真实目录并写入指定字节数的文件（使用稀疏文件近似）。
 */
async function makeRepoDir(root: string, key: string, approxBytes: number): Promise<string> {
    const absPath = path.join(root, key);
    await fs.ensureDir(absPath);
    const buf = Buffer.alloc(approxBytes);
    await fs.writeFile(path.join(absPath, 'data'), buf);
    return absPath;
}

// ─── Tests ───────────────────────────────────────────────

describe('cache-gc', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = makeTmpDir();
        await fs.ensureDir(tmpDir);
        process.env.TEAMAI_CACHE_DIR = tmpDir;
        delete process.env.TEAMAI_CACHE_MAX_BYTES;
    });

    afterEach(async () => {
        delete process.env.TEAMAI_CACHE_DIR;
        delete process.env.TEAMAI_CACHE_MAX_BYTES;
        await fs.remove(tmpDir);
    });

    /**
     * 构造 4 个条目：
     *   a - 最近使用，100 bytes
     *   b - 31 天前 (stale)，100 bytes
     *   c - 60 天前 (stale)，100 bytes
     *   d - 最近 1 天，2 GB（稀疏文件）
     */
    async function buildFixture(): Promise<void> {
        const TWO_GB = 2 * 1024 * 1024 * 1024;

        await makeRepoDir(tmpDir, 'github/owner/a', 100);
        await makeRepoDir(tmpDir, 'github/owner/b', 100);
        await makeRepoDir(tmpDir, 'github/owner/c', 100);

        // d：写一个 2GB 稀疏文件（使用 node:fs ftruncate）
        const dDir = path.join(tmpDir, 'github/owner/d');
        await fs.ensureDir(dDir);
        const fh = await nodeFs.open(path.join(dDir, 'big'), 'w');
        await fh.truncate(TWO_GB);
        await fh.close();

        const idx: CacheIndex = {
            version: 1,
            updated_at: new Date().toISOString(),
            entries: [
                { key: 'github/owner/a', size_bytes: 100, last_used: daysAgo(0) },
                { key: 'github/owner/b', size_bytes: 100, last_used: daysAgo(31) },
                { key: 'github/owner/c', size_bytes: 100, last_used: daysAgo(60) },
                { key: 'github/owner/d', size_bytes: TWO_GB, last_used: daysAgo(1) },
            ],
        };
        await saveCacheIndex(idx);
    }

    it('默认 maxBytes=5GB 时只删 b/c（stale）；a/d 保留', async () => {
        await buildFixture();

        const result = await gcCache({ maxBytes: 5 * 1024 * 1024 * 1024, staleDays: 30 });

        const removedKeys = result.removed.map((r: { key: string }) => r.key).sort();
        expect(removedKeys).toEqual(['github/owner/b', 'github/owner/c']);
        expect(result.removed.every((r: { reason: string }) => r.reason === 'stale')).toBe(true);

        const idx = await loadCacheIndex();
        const keys = idx.entries.map((e: { key: string }) => e.key).sort();
        expect(keys).toEqual(['github/owner/a', 'github/owner/d']);
    });

    it('maxBytes=1GB 时除 stale 外，d 因超容也被淘汰', async () => {
        await buildFixture();

        const ONE_GB = 1024 * 1024 * 1024;
        const result = await gcCache({ maxBytes: ONE_GB, staleDays: 30 });

        const removedKeys = result.removed.map((r: { key: string }) => r.key).sort();
        expect(removedKeys).toContain('github/owner/b');
        expect(removedKeys).toContain('github/owner/c');
        expect(removedKeys).toContain('github/owner/d');

        const staleCount = result.removed.filter((r: { reason: string }) => r.reason === 'stale').length;
        const overCapCount = result.removed.filter((r: { reason: string }) => r.reason === 'over-cap').length;
        expect(staleCount).toBe(2);
        expect(overCapCount).toBe(1);

        const idx = await loadCacheIndex();
        const keys = idx.entries.map((e: { key: string }) => e.key);
        expect(keys).toEqual(['github/owner/a']);
    });

    it('dryRun=true 不动盘', async () => {
        await buildFixture();

        const result = await gcCache({ maxBytes: 5 * 1024 * 1024 * 1024, staleDays: 30, dryRun: true });

        // b/c 应被报告为 removed，但不删盘
        expect(result.removed.length).toBeGreaterThanOrEqual(2);

        // 磁盘上 b/c 仍存在
        expect(await fs.pathExists(path.join(tmpDir, 'github/owner/b'))).toBe(true);
        expect(await fs.pathExists(path.join(tmpDir, 'github/owner/c'))).toBe(true);

        // 索引不变（dryRun 下不写盘）
        const idx = await loadCacheIndex();
        expect(idx.entries).toHaveLength(4);
    });

    it('getCacheStatus：索引中存在但磁盘已删的 entry 被自愈', async () => {
        // 构造一个索引，指向不存在的目录
        const idx: CacheIndex = {
            version: 1,
            updated_at: new Date().toISOString(),
            entries: [
                { key: 'github/owner/exists', size_bytes: 100, last_used: daysAgo(0) },
                { key: 'github/owner/gone', size_bytes: 200, last_used: daysAgo(0) },
            ],
        };
        // 只创建 exists 目录
        await makeRepoDir(tmpDir, 'github/owner/exists', 100);
        await saveCacheIndex(idx);

        const status = await getCacheStatus();

        // gone 被自愈删除
        expect(status.entryCount).toBe(1);
        expect(status.entries[0].key).toBe('github/owner/exists');

        // 索引已持久化
        const saved = await loadCacheIndex();
        expect(saved.entries).toHaveLength(1);
    });
});

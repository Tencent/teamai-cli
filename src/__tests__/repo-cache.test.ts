import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';

import {
    getRepoCacheDir,
    getRepoSlug,
    writeLastSync,
    readLastSync,
    ensureCacheRoot,
} from '../utils/repo-cache.js';

describe('repo-cache', () => {
    let tmpDir: string;
    let originalCacheDir: string | undefined;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-repo-cache-test-'));
        originalCacheDir = process.env.TEAMAI_CACHE_DIR;
        process.env.TEAMAI_CACHE_DIR = tmpDir;
    });

    afterEach(async () => {
        if (originalCacheDir === undefined) {
            delete process.env.TEAMAI_CACHE_DIR;
        } else {
            process.env.TEAMAI_CACHE_DIR = originalCacheDir;
        }
        await fs.remove(tmpDir);
    });

    describe('getRepoCacheDir', () => {
        it('拼接路径正确（简单 owner）', () => {
            const result = getRepoCacheDir('github', 'myorg', 'myrepo');
            expect(result).toBe(path.join(tmpDir, 'github', 'myorg', 'myrepo'));
        });

        it('拼接路径正确（多级 owner）', () => {
            const result = getRepoCacheDir('tgit', 'team/sub', 'service');
            expect(result).toBe(path.join(tmpDir, 'tgit', 'team/sub', 'service'));
        });

        it('不同 provider 产生不同路径', () => {
            const github = getRepoCacheDir('github', 'org', 'repo');
            const tgit = getRepoCacheDir('tgit', 'org', 'repo');
            expect(github).not.toBe(tgit);
        });
    });

    describe('getRepoSlug', () => {
        it('简单 owner 生成正确 slug', () => {
            expect(getRepoSlug('github', 'myorg', 'myrepo')).toBe('github__myorg__myrepo');
        });

        it('多级 owner 中 / 替换为 -', () => {
            expect(getRepoSlug('tgit', 'team/sub', 'service')).toBe('tgit__team-sub__service');
        });

        it('多层 group 全部替换', () => {
            expect(getRepoSlug('tgit', 'a/b/c', 'repo')).toBe('tgit__a-b-c__repo');
        });
    });

    describe('writeLastSync / readLastSync', () => {
        it('往返写读一致', async () => {
            const cacheDir = path.join(tmpDir, 'test-repo');
            await fs.ensureDir(cacheDir);

            const sha = 'abc123def456789012345678901234567890abcd';
            await writeLastSync(cacheDir, sha);

            const result = await readLastSync(cacheDir);
            expect(result).not.toBeNull();
            expect(result!.sha).toBe(sha);
            expect(result!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        });

        it('LAST_SYNC 文件不存在时返回 null', async () => {
            const cacheDir = path.join(tmpDir, 'nonexistent-repo');
            const result = await readLastSync(cacheDir);
            expect(result).toBeNull();
        });

        it('多次写入取最后一次', async () => {
            const cacheDir = path.join(tmpDir, 'test-repo-2');
            await fs.ensureDir(cacheDir);

            await writeLastSync(cacheDir, 'sha1111');
            await writeLastSync(cacheDir, 'sha2222');

            const result = await readLastSync(cacheDir);
            expect(result!.sha).toBe('sha2222');
        });
    });

    describe('ensureCacheRoot', () => {
        it('返回缓存根路径并确保目录存在', async () => {
            const newTmpRoot = path.join(tmpDir, 'deep', 'nested', 'root');
            process.env.TEAMAI_CACHE_DIR = newTmpRoot;

            const result = await ensureCacheRoot();
            expect(result).toBe(newTmpRoot);
            expect(await fs.pathExists(newTmpRoot)).toBe(true);
        });
    });
});

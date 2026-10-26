import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';

import {
    getRepoCacheDir,
    assertSafeRepoCachePath,
    getRepoSlug,
    writeLastSync,
    readLastSync,
    ensureCacheRoot,
} from '../utils/repo-cache.js';
import { parseGitHubRepoInput } from '../providers/github/repo-url.js';
import { parseGitLabRepoInput } from '../providers/gitlab/repo-url.js';
import { parseTGitRepoInput } from '../providers/tgit/repo-url.js';

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

        it.each([
            ['../github', 'org', 'repo'],
            ['github/other', 'org', 'repo'],
            ['github', '../../../victim', 'repo'],
            ['github', 'team/../other', 'repo'],
            ['github', 'team/./sub', 'repo'],
            ['github', 'org', '../victim'],
            ['github', 'org', 'nested/repo'],
            ['github', '..\\..\\victim', 'repo'],
            ['github', 'org', '..\\victim'],
            ['github', '/absolute', 'repo'],
            ['github', 'org', '/absolute'],
            ['github', 'C:\\victim', 'repo'],
            ['github', 'org', 'C:victim'],
            ['github', 'team//sub', 'repo'],
            ['github', 'team/', 'repo'],
            ['github', 'org', '.'],
            ['github', 'org', '..'],
            ['github', 'org', '.. '],
            ['github', 'org', '...'],
            ['github', 'org', 'repo\0name'],
            ['', 'org', 'repo'],
            ['github', '', 'repo'],
            ['github', 'org', ''],
        ])('rejects unsafe cache components %j/%j/%j', (provider, owner, repo) => {
            expect(() => getRepoCacheDir(provider, owner, repo)).toThrow('Invalid repository cache path');
        });

        it.each(['my.repo-name_1', '.hidden', 'repo..name', 'r'.repeat(100), '项目'])('preserves valid repository name %s', (repo) => {
            expect(getRepoCacheDir('gitlab', 'team/sub/group', repo))
                .toBe(path.join(tmpDir, 'gitlab', 'team', 'sub', 'group', repo));
        });

        it.each([
            { provider: 'github', parse: parseGitHubRepoInput, url: 'https://github.com/team/service.git', owner: 'team' },
            { provider: 'github', parse: parseGitHubRepoInput, url: 'git@github.com:team/service.git', owner: 'team' },
            { provider: 'gitlab', parse: parseGitLabRepoInput, url: 'https://gitlab.com/team/sub/service.git', owner: 'team/sub' },
            { provider: 'gitlab', parse: parseGitLabRepoInput, url: 'git@gitlab.com:team/sub/service.git', owner: 'team/sub' },
            { provider: 'tgit', parse: parseTGitRepoInput, url: 'https://git.woa.com/team/sub/service.git', owner: 'team/sub' },
            { provider: 'tgit', parse: parseTGitRepoInput, url: 'git@git.woa.com:team/sub/service.git', owner: 'team/sub' },
        ])('preserves the parsed cache path for $url', ({ provider, parse, url, owner }) => {
            const info = parse(url);
            expect(getRepoCacheDir(provider, info.owner, info.repo)).toBe(path.join(tmpDir, provider, owner, 'service'));
        });

        it('rejects the cache root itself and paths outside it', () => {
            expect(() => assertSafeRepoCachePath(tmpDir)).toThrow('Invalid repository cache path');
            expect(() => assertSafeRepoCachePath(path.join(tmpDir, '..', 'outside'))).toThrow(/path traversal/i);
        });

        it('rejects an existing or missing cache reached through a link outside the cache root', async () => {
            const cache = path.join(tmpDir, 'cache');
            const outside = path.join(tmpDir, 'outside');
            await fs.ensureDir(cache);
            await fs.ensureDir(path.join(outside, 'org', 'existing'));
            await fs.symlink(outside, path.join(cache, 'gitlab'), process.platform === 'win32' ? 'junction' : 'dir');
            process.env.TEAMAI_CACHE_DIR = cache;

            for (const repo of ['existing', 'missing']) {
                expect(() => getRepoCacheDir('gitlab', 'org', repo)).toThrow('Path traversal detected');
            }
        });

        it('allows a cache root that is itself a directory link', async () => {
            const cache = path.join(tmpDir, 'cache');
            const link = path.join(tmpDir, 'cache-link');
            await fs.ensureDir(cache);
            await fs.symlink(cache, link, process.platform === 'win32' ? 'junction' : 'dir');
            process.env.TEAMAI_CACHE_DIR = link;

            expect(getRepoCacheDir('gitlab', 'team/sub', 'repo'))
                .toBe(path.join(link, 'gitlab', 'team', 'sub', 'repo'));
        });

        it('allows an intermediate directory link whose target stays inside the cache root', async () => {
            const provider = path.join(tmpDir, 'provider');
            await fs.ensureDir(provider);
            await fs.symlink(provider, path.join(tmpDir, 'gitlab'), process.platform === 'win32' ? 'junction' : 'dir');

            expect(getRepoCacheDir('gitlab', 'team/sub', 'repo'))
                .toBe(path.join(tmpDir, 'gitlab', 'team', 'sub', 'repo'));
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

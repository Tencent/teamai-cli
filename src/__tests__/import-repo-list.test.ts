// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import { stringify as yamlStringify } from 'yaml';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../import-repo.js', async (importOriginal) => ({
    repoSlugForUrl: (await importOriginal<typeof import('../import-repo.js')>()).repoSlugForUrl,
    importFromRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock('../import-codebase.js', async (importOriginal) => ({
    failIncompleteDeepEnrich: (await importOriginal<typeof import('../import-codebase.js')>()).failIncompleteDeepEnrich,
    refreshTeamwikiIndexes: vi.fn().mockResolvedValue(undefined),
    publishTeamwikiViaMR: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
    autoDetectInit: vi.fn().mockRejectedValue(new Error('no config in test')),
}));

// ─── Imports（after mocks）──────────────────────────────

import { importFromRepoList } from '../import-repo-list.js';
import { importFromRepo } from '../import-repo.js';
import { DetachedTeamRepoError } from '../utils/git.js';
import { autoDetectInit } from '../config.js';
import { LocalConfigSchema, TeamaiConfigSchema } from '../types.js';
import { publishTeamwikiViaMR, refreshTeamwikiIndexes } from '../import-codebase.js';

// ─── Tests ──────────────────────────────────────────────

describe('importFromRepoList', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-list-test-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        await fs.ensureDir(path.join(tmpDir, '.teamai'));
        vi.clearAllMocks();
        vi.mocked(autoDetectInit).mockRejectedValue(new Error('no config in test'));
    });

    afterEach(async () => {
        process.exitCode = undefined;
        process.chdir(originalCwd);
        await fs.remove(tmpDir);
        vi.restoreAllMocks();
    });

    async function writeYaml(fileName: string, content: unknown): Promise<string> {
        const filePath = path.join(tmpDir, fileName);
        await fs.writeFile(filePath, yamlStringify(content), 'utf8');
        return filePath;
    }

    it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid concurrency %s before reading the list or preparing output', async (concurrency) => {
            const output = path.join(tmpDir, 'out');
            await expect(importFromRepoList({ listPath: path.join(tmpDir, 'missing.yaml'), concurrency, output }))
                .rejects.toThrow('--concurrency must be a positive safe integer');
            expect(importFromRepo).not.toHaveBeenCalled();
            expect(await fs.pathExists(output)).toBe(false);
        },
    );

    it('rejects zero instead of leaving a nonempty batch pending', async () => {
        const listPath = await writeYaml('repos.yaml', { version: 1, repos: [{ url: 'https://github.com/org/repo' }] });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await expect(Promise.race([
                importFromRepoList({ listPath, concurrency: 0, dryRun: true }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Batch is still pending')), 250); }),
            ])).rejects.toThrow('--concurrency must be a positive safe integer');
            expect(importFromRepo).not.toHaveBeenCalled();
        } finally {
            clearTimeout(timer);
        }
    });

    it.each([1, 2, 3])('keeps at most %i imports active and releases a failed import\'s slot', async (concurrency) => {
        const repos = Array.from({ length: 5 }, (_, i) => ({ url: `https://github.com/org/repo-${i}` }));
        const listPath = await writeYaml('repos.yaml', { version: 1, repos });
        const releases: Array<() => void> = [];
        let active = 0;
        let peak = 0;
        vi.mocked(importFromRepo).mockImplementation(async ({ url }) => {
            active++;
            peak = Math.max(peak, active);
            try {
                await new Promise<void>((resolve, reject) => {
                    releases.push(() => url.endsWith('repo-0') ? reject(new Error('Fixture failure')) : resolve());
                });
            } finally {
                active--;
            }
            return true;
        });

        const batch = importFromRepoList({ listPath, concurrency, dryRun: true });
        await vi.waitFor(() => expect(importFromRepo).toHaveBeenCalledTimes(concurrency));
        for (let settled = 0; settled < repos.length; settled++) {
            await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
            releases.shift()!();
        }
        expect(await batch).toEqual({ succeeded: 4, failed: [{ url: repos[0].url, error: 'Fixture failure' }], skipped: [] });
        expect(peak).toBe(concurrency);
        expect(active).toBe(0);
        vi.mocked(importFromRepo).mockResolvedValue(true);
    });

    it('exits 1 and names the retry command for each repo whose deep enrich did not finish', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-1' }, { url: 'https://github.com/org/repo-2' }],
        });
        vi.mocked(importFromRepo).mockImplementation(async ({ url }) => !url.endsWith('repo-2'));
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
        try {
            await importFromRepoList({ listPath: filePath, output: 'wiki' });
        } finally {
            spy.mockRestore();
        }

        expect(process.exitCode).toBe(1);
        const output = lines.join('\n');
        expect(output).toContain(
            'Deep enrich incomplete: github__org__repo-2. Run `teamai codebase --deep-enrich --project github__org__repo-2 --output wiki` to retry.',
        );
        expect(output).not.toContain('github__org__repo-1');
    });

    it('names an import of each unfinished repo, with its auth, domain and file cap, as its retry in a team repo', async () => {
        const localPath = path.join(tmpDir, 'team-repo');
        await fs.ensureDir(path.join(localPath, 'teamwiki'));
        vi.mocked(autoDetectInit).mockResolvedValueOnce({
            localConfig: LocalConfigSchema.parse({ repo: { localPath, remote: 'https://example.com/team.git' }, username: 'test', scope: 'project' }),
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git' }),
        });
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-1' }, { url: 'https://github.com/org/repo-2', auth: 'ssh', domain: 'billing' }],
        });
        vi.mocked(importFromRepo).mockResolvedValue(false);
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
        try {
            await importFromRepoList({ listPath: filePath, maxFiles: 500 });
        } finally {
            spy.mockRestore();
            vi.mocked(importFromRepo).mockResolvedValue(true);
        }

        expect(process.exitCode).toBe(1);
        const output = lines.join('\n');
        expect(output).toContain('Deep enrich incomplete: github__org__repo-1. Run `teamai codebase --deep-enrich --project github__org__repo-1` to retry.');
        expect(output).toContain('Deep enrich incomplete: github__org__repo-2. Run `teamai codebase --deep-enrich --project github__org__repo-2` to retry.');
    });

    it('加载 yaml → 调度 → 汇总数字正确（2 个成功）', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/repo-1', domain: '推理' },
                { url: 'https://github.com/org/repo-2', domain: '训练' },
            ],
        });

        const result = await importFromRepoList({ listPath: filePath, output: tmpDir });

        expect(importFromRepo).toHaveBeenCalledTimes(2);
        expect(result.succeeded).toBe(2);
        expect(result.failed).toHaveLength(0);
        expect(result.skipped).toHaveLength(0);
    });

    it('org entry → skipped 数 +1，importFromRepo 不被调用', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { org: 'https://github.com/myorg', default_domain: '平台' },
                { url: 'https://github.com/org/single-repo' },
            ],
        });

        const result = await importFromRepoList({ listPath: filePath, output: tmpDir });

        expect(importFromRepo).toHaveBeenCalledTimes(1);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].url).toBe('https://github.com/myorg');
        expect(result.succeeded).toBe(1);
    });

    it('单仓抛错 → failed +1，不中断其他', async () => {
        vi.mocked(importFromRepo)
            .mockRejectedValueOnce(new Error('克隆失败'))
            .mockResolvedValue(true);

        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/fail-repo' },
                { url: 'https://github.com/org/success-repo' },
            ],
        });

        const result = await importFromRepoList({ listPath: filePath, output: tmpDir });

        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].url).toBe('https://github.com/org/fail-repo');
        expect(result.failed[0].error).toContain('克隆失败');
        expect(result.succeeded).toBe(1);
    });

    it('priority=high 条目优先排序：先于 normal', async () => {
        const callOrder: string[] = [];
        vi.mocked(importFromRepo).mockImplementation(async (opts) => {
            callOrder.push(opts.url);
            return true;
        });

        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/normal-repo', priority: 'normal' },
                { url: 'https://github.com/org/high-repo', priority: 'high' },
            ],
        });

        await importFromRepoList({ listPath: filePath, concurrency: 1, output: tmpDir });

        expect(callOrder[0]).toBe('https://github.com/org/high-repo');
        expect(callOrder[1]).toBe('https://github.com/org/normal-repo');
    });

    it('--output: every repo and the index rebuild use <output>/teamwiki, and nothing is pushed', async () => {
        const output = path.join(tmpDir, 'out');
        await fs.ensureDir(path.join(output, 'teamwiki'));
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-1' }],
        });

        await importFromRepoList({ listPath: filePath, output });

        expect(importFromRepo).toHaveBeenCalledWith(expect.objectContaining({ output, skipAutoPush: true }));
        expect(refreshTeamwikiIndexes).toHaveBeenCalledWith(path.join(output, 'teamwiki'));
        expect(publishTeamwikiViaMR).not.toHaveBeenCalled();
    });


    it('propagates a detached-clone refusal from batch publishing', async () => {
        const localPath = path.join(tmpDir, 'team-repo');
        await fs.ensureDir(path.join(localPath, 'teamwiki'));
        vi.mocked(autoDetectInit).mockResolvedValueOnce({
            localConfig: LocalConfigSchema.parse({ repo: { localPath, remote: 'https://example.com/team.git' }, username: 'test', scope: 'project' }),
            teamConfig: TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.com/team.git' }),
        });
        const refusal = new DetachedTeamRepoError('main');
        vi.mocked(publishTeamwikiViaMR).mockRejectedValueOnce(refusal);
        const listPath = await writeYaml('repos.yaml', { version: 1, repos: [{ url: 'https://github.com/org/repo' }] });
        await expect(importFromRepoList({ listPath })).rejects.toBe(refusal);
    });

    it('fails before importing anything when there is neither a team repo nor --output', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-1' }],
        });

        await expect(importFromRepoList({ listPath: filePath })).rejects.toThrow('no config in test');
        expect(importFromRepo).not.toHaveBeenCalled();
    });
});

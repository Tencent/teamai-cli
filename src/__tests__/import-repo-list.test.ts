// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import { stringify as yamlStringify } from 'yaml';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('../import-repo.js', () => ({
    importFromRepo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../aggregate.js', () => ({
    regenerateAggregate: vi.fn().mockResolvedValue({
        domainFiles: [],
        indexFile: '/mock/index.md',
    }),
}));

vi.mock('../domains/store.js', () => ({
    loadDomains: vi.fn().mockResolvedValue({
        version: 1,
        confidence_threshold: 0.6,
        domains: [],
    }),
}));

// ─── Imports（after mocks）──────────────────────────────

import { importFromRepoList } from '../import-repo-list.js';
import { importFromRepo } from '../import-repo.js';
import { regenerateAggregate } from '../aggregate.js';

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
    });

    afterEach(async () => {
        process.chdir(originalCwd);
        await fs.remove(tmpDir);
        vi.restoreAllMocks();
    });

    async function writeYaml(fileName: string, content: unknown): Promise<string> {
        const filePath = path.join(tmpDir, fileName);
        await fs.writeFile(filePath, yamlStringify(content), 'utf8');
        return filePath;
    }

    it('加载 yaml → 调度 → 汇总数字正确（2 个成功）', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/repo-1', domain: '推理' },
                { url: 'https://github.com/org/repo-2', domain: '训练' },
            ],
        });

        const result = await importFromRepoList({ listPath: filePath });

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

        const result = await importFromRepoList({ listPath: filePath });

        expect(importFromRepo).toHaveBeenCalledTimes(1);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].url).toBe('https://github.com/myorg');
        expect(result.succeeded).toBe(1);
    });

    it('单仓抛错 → failed +1，不中断其他', async () => {
        vi.mocked(importFromRepo)
            .mockRejectedValueOnce(new Error('克隆失败'))
            .mockResolvedValue(undefined);

        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/fail-repo' },
                { url: 'https://github.com/org/success-repo' },
            ],
        });

        const result = await importFromRepoList({ listPath: filePath });

        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].url).toBe('https://github.com/org/fail-repo');
        expect(result.failed[0].error).toContain('克隆失败');
        expect(result.succeeded).toBe(1);
    });

    it('skipAggregate=true → 不调用 regenerateAggregate', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-x' }],
        });

        await importFromRepoList({ listPath: filePath, skipAggregate: true });

        expect(regenerateAggregate).not.toHaveBeenCalled();
    });

    it('默认 skipAggregate=false → 调用 regenerateAggregate', async () => {
        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [{ url: 'https://github.com/org/repo-y' }],
        });

        await importFromRepoList({ listPath: filePath });

        expect(regenerateAggregate).toHaveBeenCalledTimes(1);
    });

    it('priority=high 条目优先排序：先于 normal', async () => {
        const callOrder: string[] = [];
        vi.mocked(importFromRepo).mockImplementation(async (opts) => {
            callOrder.push(opts.url);
        });

        const filePath = await writeYaml('repos.yaml', {
            version: 1,
            repos: [
                { url: 'https://github.com/org/normal-repo', priority: 'normal' },
                { url: 'https://github.com/org/high-repo', priority: 'high' },
            ],
        });

        await importFromRepoList({ listPath: filePath, concurrency: 1 });

        expect(callOrder[0]).toBe('https://github.com/org/high-repo');
        expect(callOrder[1]).toBe('https://github.com/org/normal-repo');
    });
});

// -*- coding: utf-8 -*-
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import { stringify as yamlStringify } from 'yaml';

import { regenerateAggregate } from '../aggregate.js';
import { getTeamCodebasePaths } from '../utils/team-codebase-paths.js';
import type { DomainsFile } from '../domains/index.js';

// ─── Helpers ────────────────────────────────────────────

function makeDomainsFile(overrides: Partial<DomainsFile> = {}): DomainsFile {
    return {
        version: 1,
        confidence_threshold: 0.6,
        domains: [],
        ...overrides,
    };
}

async function writeRepoMd(reposDir: string, slug: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    const fm = yamlStringify(frontmatter).trim();
    const content = `---\n${fm}\n---\n\n${body}`;
    await fs.ensureDir(reposDir);
    await fs.writeFile(path.join(reposDir, `${slug}.md`), content, 'utf8');
}

// ─── Tests ──────────────────────────────────────────────

describe('regenerateAggregate', () => {
    let tmpDir: string;
    let paths: ReturnType<typeof getTeamCodebasePaths>;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-aggregate-test-'));
        paths = getTeamCodebasePaths(tmpDir);
        await fs.ensureDir(paths.reposDir);
        await fs.ensureDir(paths.domainsDir);
    });

    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('两个域各一仓 → 生成正确的 domain-*.md 与 index.md', async () => {
        // 准备 3 个 fake slug.md
        await writeRepoMd(paths.reposDir, 'github-org-repo-a', {
            repo_url: 'https://github.com/org/repo-a',
            repo_name: 'Repo A',
            primary_language: 'TypeScript',
            line_count: 5000,
            last_synced: '2026-06-01T00:00:00Z',
        }, '# Repo A\n\n这是 Repo A 的摘要，用于推理服务。\n');

        await writeRepoMd(paths.reposDir, 'github-org-repo-b', {
            repo_url: 'https://github.com/org/repo-b',
            repo_name: 'Repo B',
            primary_language: 'Python',
            line_count: 3000,
            last_synced: '2026-06-02T00:00:00Z',
        }, '# Repo B\n\n这是 Repo B 的摘要，用于训练服务。\n');

        await writeRepoMd(paths.reposDir, 'github-org-repo-c', {
            repo_url: 'https://github.com/org/repo-c',
            repo_name: 'Repo C',
            primary_language: 'Go',
            line_count: 2000,
            last_synced: '2026-06-03T00:00:00Z',
        }, '# Repo C\n\n这是 Repo C 的摘要，用于推理优化。\n');

        const domains = makeDomainsFile({
            domains: [
                {
                    name: '推理',
                    description: '推理相关仓库',
                    repos: [
                        { url: 'https://github.com/org/repo-a', confidence: 0.9, signal: 'README', locked: false },
                        { url: 'https://github.com/org/repo-c', confidence: 0.85, signal: 'description', locked: false },
                    ],
                },
                {
                    name: '训练',
                    description: '训练相关仓库',
                    repos: [
                        { url: 'https://github.com/org/repo-b', confidence: 0.8, signal: 'README', locked: false },
                    ],
                },
            ],
        });

        const result = await regenerateAggregate({ paths, domains });

        // domain-*.md 生成
        expect(result.domainFiles).toHaveLength(2);
        expect(result.indexFile).toBe(paths.index);

        // domain-推理.md 存在
        const domainInferPath = path.join(paths.domainsDir, 'domain-推理.md');
        expect(await fs.pathExists(domainInferPath)).toBe(true);
        const domainInferContent = await fs.readFile(domainInferPath, 'utf8');
        expect(domainInferContent).toContain('# 业务域：推理');
        expect(domainInferContent).toContain('Repo A');
        expect(domainInferContent).toContain('Repo C');

        // index.md 存在
        expect(await fs.pathExists(paths.index)).toBe(true);
        const indexContent = await fs.readFile(paths.index, 'utf8');
        expect(indexContent).toContain('# 团队 Codebase 索引');
        expect(indexContent).toContain('推理');
        expect(indexContent).toContain('训练');
    });

    it('不属于任何 domain 的 repo 进未分类', async () => {
        await writeRepoMd(paths.reposDir, 'github-org-orphan', {
            repo_url: 'https://github.com/org/orphan',
            repo_name: 'Orphan Repo',
        }, '# Orphan\n\n孤儿仓库。\n');

        const domains = makeDomainsFile({ domains: [] });
        const result = await regenerateAggregate({ paths, domains });

        // 未分类 domain 文件
        const unclassifiedPath = path.join(paths.domainsDir, 'domain-未分类.md');
        expect(await fs.pathExists(unclassifiedPath)).toBe(true);
        expect(result.domainFiles).toHaveLength(1);
    });

    it('旧 domain 文件在本轮无仓时被清理', async () => {
        // 写一个旧的 domain-old.md
        const oldFile = path.join(paths.domainsDir, 'domain-old-domain.md');
        await fs.writeFile(oldFile, '# old', 'utf8');

        await writeRepoMd(paths.reposDir, 'github-org-new', {
            repo_url: 'https://github.com/org/new',
        }, '# New\n\n新仓库。\n');

        const domains = makeDomainsFile({
            domains: [{
                name: '新域',
                description: '',
                repos: [{ url: 'https://github.com/org/new', locked: false }],
            }],
        });

        await regenerateAggregate({ paths, domains });

        // 旧文件已删除
        expect(await fs.pathExists(oldFile)).toBe(false);
        // 新文件存在
        expect(await fs.pathExists(path.join(paths.domainsDir, 'domain-新域.md'))).toBe(true);
    });
});

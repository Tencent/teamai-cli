// -*- coding: utf-8 -*-
import path from 'node:path';

import fs from 'fs-extra';
import matter from 'gray-matter';

import type { DomainsFile } from './domains/index.js';
import type { TeamCodebasePaths } from './utils/team-codebase-paths.js';
import { safeDomainSlug } from './utils/team-codebase-paths.js';

/** regenerateAggregate 入参。 */
export interface AggregateOptions {
    paths: TeamCodebasePaths;
    domains: DomainsFile;
}

/** 从 slug.md 文件解析出的仓库摘要信息。 */
interface RepoSummary {
    slug: string;
    /** 仓库 URL（来自 frontmatter.repo_url 或 frontmatter.url） */
    url: string;
    /** 仓库名称（来自 frontmatter.repo_name 或 frontmatter 第一个 # 标题） */
    name: string;
    /** 主语言 */
    primaryLanguage: string;
    /** 代码行数 */
    lineCount: string;
    /** 最后同步时间（ISO 或 N/A） */
    lastSynced: string;
    /** 摘要段落（≤200 字） */
    excerpt: string;
}

/**
 * 解析 repos/<slug>.md 文件，提取仓库摘要。
 *
 * @param filePath slug.md 绝对路径
 * @param slug     文件名（不含扩展名）
 * @returns        RepoSummary 对象
 */
async function parseRepoMd(filePath: string, slug: string): Promise<RepoSummary> {
    const raw = await fs.readFile(filePath, 'utf8');
    const { data, content } = matter(raw);

    const fm = data as Record<string, unknown>;

    const url = typeof fm.repo_url === 'string' ? fm.repo_url
        : typeof fm.url === 'string' ? fm.url
        : '';

    // 仓库名：frontmatter.repo_name 或首个 # 标题
    let name = typeof fm.repo_name === 'string' ? fm.repo_name : '';
    if (!name) {
        const titleMatch = content.match(/^#\s+(.+)/m);
        name = titleMatch ? titleMatch[1].trim() : slug;
    }

    const primaryLanguage = typeof fm.primary_language === 'string' ? fm.primary_language : 'N/A';
    const lineCount = fm.line_count != null ? String(fm.line_count) : 'N/A';
    const lastSynced = typeof fm.last_synced === 'string' ? fm.last_synced
        : typeof fm.generated_at === 'string' ? fm.generated_at
        : 'N/A';

    // 摘要：去掉标题行，取首段前 200 字
    const bodyWithoutTitle = content.replace(/^#[^\n]*\n/m, '').trim();
    const firstPara = bodyWithoutTitle.split(/\n\n+/)[0] ?? '';
    const excerpt = firstPara.slice(0, 200);

    return { slug, url, name, primaryLanguage, lineCount, lastSynced, excerpt };
}

/**
 * 读取 paths.reposDir 下的所有 <slug>.md，按 domains 中的 repo→domain 映射
 * 重新生成所有 domains/domain-<safe>.md 与 index.md。
 *
 * 不调用 AI，纯模板拼接。
 * 写出前先清理不再有仓库的旧 domain-*.md 文件。
 *
 * @param opts AggregateOptions
 * @returns    写出文件路径列表
 */
export async function regenerateAggregate(opts: AggregateOptions): Promise<{
    domainFiles: string[];
    indexFile: string;
}> {
    const { paths, domains } = opts;

    // 确保目录存在
    await fs.ensureDir(paths.domainsDir);
    await fs.ensureDir(paths.reposDir);

    // 1. 读取所有 repos/<slug>.md
    let repoFiles: string[] = [];
    try {
        const entries = await fs.readdir(paths.reposDir);
        repoFiles = entries.filter((f) => f.endsWith('.md'));
    } catch {
        // reposDir 不存在或为空
    }

    // slug → RepoSummary
    const repoMap = new Map<string, RepoSummary>();
    for (const file of repoFiles) {
        const slug = file.replace(/\.md$/, '');
        try {
            const summary = await parseRepoMd(path.join(paths.reposDir, file), slug);
            repoMap.set(slug, summary);
        } catch {
            // 解析失败跳过
        }
    }

    // 2. 构建 domain → slug[] 映射（基于 domains.yaml 中每个域的 repos[].url）
    // 建立 url → slug 反查表（从 repoMap）
    const urlToSlug = new Map<string, string>();
    for (const [slug, summary] of repoMap) {
        if (summary.url) {
            urlToSlug.set(summary.url, slug);
        }
    }

    // 收集每个域的 slugs
    const domainToSlugs = new Map<string, string[]>();
    for (const domain of domains.domains) {
        const slugs: string[] = [];
        for (const repo of domain.repos) {
            const slug = urlToSlug.get(repo.url);
            if (slug) {
                slugs.push(slug);
            }
        }
        if (slugs.length > 0) {
            domainToSlugs.set(domain.name, slugs);
        }
    }

    // 未归类：在 reposDir 有文件但 domains.yaml 中没有任何域声明该 url
    const assignedSlugs = new Set(
        [...domainToSlugs.values()].flat(),
    );
    const unclassifiedSlugs = [...repoMap.keys()].filter((s) => !assignedSlugs.has(s));
    if (unclassifiedSlugs.length > 0) {
        domainToSlugs.set('未分类', unclassifiedSlugs);
    }

    // 3. 清理不再有仓库的旧 domain-*.md
    const existingDomainFiles = (await fs.readdir(paths.domainsDir))
        .filter((f) => /^domain-.+\.md$/.test(f));

    const newDomainFileNames = new Set(
        [...domainToSlugs.keys()].map((name) => `domain-${safeDomainSlug(name)}.md`),
    );

    for (const oldFile of existingDomainFiles) {
        if (!newDomainFileNames.has(oldFile)) {
            await fs.remove(path.join(paths.domainsDir, oldFile));
        }
    }

    // 4. 生成 domain-<safe>.md
    const now = new Date().toISOString();
    const domainFiles: string[] = [];

    for (const [domainName, slugs] of domainToSlugs) {
        const domainEntry = domains.domains.find((d) => d.name === domainName);
        const description = domainEntry?.description ?? '';
        const safeSlug = safeDomainSlug(domainName);
        const outputPath = path.join(paths.domainsDir, `domain-${safeSlug}.md`);

        const tableRows = slugs.map((slug) => {
            const s = repoMap.get(slug);
            if (!s) return '';
            const repoName = s.name || slug;
            const url = s.url || 'N/A';
            const lang = s.primaryLanguage;
            const lines = s.lineCount;
            const synced = s.lastSynced.slice(0, 10);
            return `| ${repoName} | ${url} | ${lang} | ~${lines} | ${synced} |`;
        }).filter(Boolean).join('\n');

        const repoSections = slugs.map((slug) => {
            const s = repoMap.get(slug);
            if (!s) return '';
            const repoName = s.name || slug;
            const excerpt = s.excerpt || '（暂无摘要）';
            return [
                `### ${repoName}`,
                '',
                `> ${excerpt}`,
                '',
                `[完整视图 → repos/${slug}.md](../repos/${slug}.md)`,
                '',
            ].join('\n');
        }).filter(Boolean).join('\n');

        const content = [
            '---',
            `domain: ${domainName}`,
            `description: ${description}`,
            `repo_count: ${slugs.length}`,
            `last_synced: ${now}`,
            'generator: teamai import (P5.2 aggregate)',
            '---',
            '',
            `# 业务域：${domainName}`,
            '',
            description ? `> ${description}` : '',
            '',
            '## 仓库列表',
            '',
            '| 仓库 | URL | 主语言 | 行数 | 最后同步 |',
            '|---|---|---|---|---|',
            tableRows,
            '',
            '## 仓库摘要',
            '',
            repoSections,
        ].filter((line) => line !== null).join('\n');

        await fs.writeFile(outputPath, content, 'utf8');
        domainFiles.push(outputPath);
    }

    // 5. 生成 index.md
    const totalRepos = [...domainToSlugs.values()].reduce((acc, arr) => acc + arr.length, 0);
    const domainCount = domainToSlugs.size;

    const domainMapRows = [...domainToSlugs.entries()]
        .map(([name, slugs]) => {
            const safeSlug = safeDomainSlug(name);
            return `| ${name} | ${slugs.length} | [domain-${safeSlug}](domains/domain-${safeSlug}.md) |`;
        })
        .join('\n');

    const allRepoRows = [...domainToSlugs.entries()]
        .flatMap(([domainName, slugs]) =>
            slugs.map((slug) => {
                const s = repoMap.get(slug);
                const repoName = s?.name ?? slug;
                return `| ${repoName} | ${domainName} | [详情](repos/${slug}.md) |`;
            }),
        )
        .join('\n');

    const indexContent = [
        '---',
        'generator: teamai import (P5.2 aggregate)',
        `last_generated: ${now}`,
        `domain_count: ${domainCount}`,
        `repo_count: ${totalRepos}`,
        'schemaVersion: 1',
        '---',
        '',
        '# 团队 Codebase 索引',
        '',
        '## 业务域地图',
        '',
        '| 业务域 | 仓库数 | 入口 |',
        '|---|---|---|',
        domainMapRows,
        '',
        '## 全部仓库索引',
        '',
        '| 仓库 | 业务域 | 详细视图 |',
        '|---|---|---|',
        allRepoRows,
        '',
        '## 维护说明',
        '',
        '由 `teamai import --from-repo-list` 自动生成。请勿手工编辑本文件，',
        '对单仓内容的修改请到对应 `repos/<slug>.md`。',
        '',
    ].join('\n');

    await fs.writeFile(paths.index, indexContent, 'utf8');

    return { domainFiles, indexFile: paths.index };
}

// -*- coding: utf-8 -*-
/**
 * 组织级一键初始化入口。
 *
 * 对应 CLI：teamai import --from-org <org> [--bootstrap]
 *
 * 流程：
 *  1. 解析 org URL → provider + org 路径
 *  2. provider.listOrgRepos → OrgRepoInfo[]
 *  3. 按 includePattern / excludePattern / excludeArchived 过滤
 *  4. 转 RepoMeta[] → clusterRepos → DomainsFile 草稿
 *  5. 同时生成 RepoListFile 草稿
 *  6. 写草稿到 .teamai/domains.draft.yaml + .teamai/repo-whitelist.draft.yaml
 *  7. 若 bootstrap=true 进 reviewDomains → 写正式配置
 *  8. 若 skipImport=false，调 importFromRepoList 完成首次全量
 *  9. appendHistory 记录 bootstrap 元事件
 */

import path from 'node:path';
import fs from 'fs-extra';
import { stringify as yamlStringify } from 'yaml';

import {
    clusterRepos,
    saveDomainsDraft,
    saveDomains,
    reviewDomains,
    appendHistory,
} from './domains/index.js';
import type { DomainsFile, RepoMeta } from './domains/index.js';
import type { RepoListFile, RepoListEntry } from './repo-list/schema.js';
import { importFromRepoList } from './import-repo-list.js';
import { getProviderFromUrl, getProvider } from './providers/registry.js';
import type { OrgRepoInfo } from './providers/types.js';
import { log } from './utils/logger.js';

// ─── 常量 ────────────────────────────────────────────────

const WHITELIST_DRAFT_PATH = '.teamai/repo-whitelist.draft.yaml';
const WHITELIST_PATH = '.teamai/repo-whitelist.yaml';

// ─── 类型 ────────────────────────────────────────────────

/** importFromOrg 的选项。 */
export interface ImportFromOrgOptions {
    /** org URL 或 "github.com/org" / "git.woa.com/group" 或裸 "team-org" */
    org: string;
    /** true=进入交互 review；false=只生成草稿 */
    bootstrap?: boolean;
    /** 最多拉取的仓库数，默认 200 */
    maxRepos?: number;
    /** 排除 archived 仓库，默认 true */
    excludeArchived?: boolean;
    /** 仅纳入 fullName 匹配此正则的仓 */
    includePattern?: string;
    /** 排除 fullName 匹配此正则的仓 */
    excludePattern?: string;
    /** true=只产 yaml 草稿，跳过批量导入 */
    skipImport?: boolean;
    dryRun?: boolean;
    output?: string;
    forceSsh?: boolean;
    /** 跳过 AI enrichment */
    skipEnrich?: boolean;
}

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 解析 org 输入，返回 provider 名和 org 路径。
 *
 * 支持格式：
 *   - "https://github.com/team-org"    → { providerName: 'github', orgPath: 'team-org' }
 *   - "github.com/team-org"            → { providerName: 'github', orgPath: 'team-org' }
 *   - "git.woa.com/group/sub"          → { providerName: 'tgit',   orgPath: 'group/sub' }
 *   - "team-org"（裸名）               → { providerName: default,  orgPath: 'team-org' }
 *
 * @param org 用户输入
 */
function parseOrgInput(org: string): { providerName: string; orgPath: string } {
    const trimmed = org.trim();

    // 完整 HTTPS URL
    const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/(.+)/);
    if (httpsMatch) {
        const host = httpsMatch[1].toLowerCase();
        const orgPath = httpsMatch[2].replace(/\/$/, '');
        const providerName = host.includes('woa.com') ? 'tgit' : 'github';
        return { providerName, orgPath };
    }

    // "host/org" 格式（不含协议）
    const hostOrgMatch = trimmed.match(/^([^/]+)\/(.+)/);
    if (hostOrgMatch) {
        const host = hostOrgMatch[1].toLowerCase();
        const orgPath = hostOrgMatch[2];
        if (host.includes('.')) {
            // 有效 hostname
            const providerName = host.includes('woa.com') ? 'tgit' : 'github';
            return { providerName, orgPath };
        }
        // 裸 "owner/repo" 模式 → 视整体为 org 路径，用默认 provider
        return { providerName: getProviderFromUrl('').name, orgPath: trimmed };
    }

    // 纯数字 → TGit group ID（GitHub 不支持数字 org ID）
    if (/^\d+$/.test(trimmed)) {
        return { providerName: 'tgit', orgPath: trimmed };
    }

    // 裸 org 名
    const providerName = getProvider().name;
    return { providerName, orgPath: trimmed };
}

/**
 * 过滤仓库列表。
 */
function filterRepos(
    repos: OrgRepoInfo[],
    opts: {
        excludeArchived: boolean;
        includePattern?: string;
        excludePattern?: string;
    },
): OrgRepoInfo[] {
    let result = repos;

    if (opts.excludeArchived) {
        result = result.filter((r) => !r.archived);
    }

    if (opts.includePattern) {
        const re = new RegExp(opts.includePattern);
        result = result.filter((r) => re.test(r.fullName));
    }

    if (opts.excludePattern) {
        const re = new RegExp(opts.excludePattern);
        result = result.filter((r) => !re.test(r.fullName));
    }

    return result;
}

/**
 * 将 OrgRepoInfo 转换为 RepoMeta（聚类输入）。
 */
function toRepoMeta(info: OrgRepoInfo): RepoMeta {
    return {
        url: info.url,
        name: info.name,
        description: info.description,
        primary_language: info.primaryLanguage,
    };
}

/**
 * 根据 DomainsFile 草稿找到某 URL 所属域名。
 */
function findDomainForUrl(url: string, domains: DomainsFile): string | undefined {
    for (const domain of domains.domains) {
        if (domain.repos.some((r) => r.url === url)) {
            return domain.name;
        }
    }
    return undefined;
}

/**
 * 构建白名单草稿文件内容（YAML 字符串，含顶部注释）。
 */
function buildWhitelistYaml(repos: OrgRepoInfo[], domains: DomainsFile): string {
    const entries: RepoListEntry[] = repos.map((r) => ({
        url: r.url,
        domain: findDomainForUrl(r.url, domains),
        auth: 'token' as const,
        priority: 'normal' as const,
    }));

    const file: RepoListFile = {
        version: 1,
        repos: entries,
    };

    const header =
        '# 由 teamai import --from-org --bootstrap 生成；可手工编辑后再次 review\n';
    return header + yamlStringify(file);
}

// ─── 主入口 ──────────────────────────────────────────────

/**
 * 组织级一键初始化。
 *
 * 列出 org 下所有仓 → AI 聚类 → 生成白名单和域字典草稿 → 可选 review → 可选全量导入。
 *
 * @param opts 导入选项
 */
export async function importFromOrg(opts: ImportFromOrgOptions): Promise<void> {
    const cwd = process.cwd();
    const maxRepos = opts.maxRepos ?? 200;
    const excludeArchived = opts.excludeArchived ?? true;

    // 1. 解析 org → provider + orgPath
    const { providerName, orgPath } = parseOrgInput(opts.org);
    const provider = getProvider(providerName);

    if (!provider.listOrgRepos) {
        throw new Error(
            `Provider "${providerName}" 不支持 listOrgRepos，无法使用 --from-org`,
        );
    }

    // 记录开始事件
    const startTs = new Date().toISOString();
    await appendHistory(cwd, {
        ts: startTs,
        actor: 'ai',
        action: 'recommend',
        details: { event: 'bootstrap-start', org: opts.org, orgPath, provider: providerName },
    });

    // 2. 拉取仓库列表
    log.info(`正在从 ${providerName}/${orgPath} 拉取仓库列表...`);
    let rawRepos: OrgRepoInfo[];
    try {
        rawRepos = await provider.listOrgRepos(orgPath, { maxRepos });
    } catch (err) {
        throw new Error(`listOrgRepos 失败: ${String(err)}`);
    }

    log.info(`获取到 ${rawRepos.length} 个仓库，开始过滤...`);

    // 3. 过滤
    const filteredRepos = filterRepos(rawRepos, {
        excludeArchived,
        includePattern: opts.includePattern,
        excludePattern: opts.excludePattern,
    });

    if (filteredRepos.length === 0) {
        log.warn('过滤后无可用仓库，终止');
        return;
    }

    log.info(`过滤后剩余 ${filteredRepos.length} 个仓库，生成白名单...`);

    // 4. 生成白名单（跳过 AI 聚类，知识图谱通过 nodes/edges 自动组织关系）
    const whitelistDraftPath = path.join(cwd, WHITELIST_DRAFT_PATH);
    if (!opts.dryRun) {
        await fs.ensureDir(path.dirname(whitelistDraftPath));
        const lines = ['version: 1', 'repos:'];
        for (const repo of filteredRepos) {
            lines.push(`  - url: ${repo.url}`);
            lines.push(`    auth: token`);
            lines.push(`    priority: normal`);
        }
        await fs.writeFile(whitelistDraftPath, lines.join('\n') + '\n', 'utf8');
        log.info(`白名单已写入：${WHITELIST_DRAFT_PATH}（${filteredRepos.length} 个仓库）`);
    }

    // 5. 批量导入
    if (!opts.skipImport) {
        const whitelistPath = whitelistDraftPath;

        if (await fs.pathExists(whitelistPath)) {
            log.info(`开始批量导入（白名单：${whitelistPath}）...`);
            try {
                const result = await importFromRepoList({
                    listPath: whitelistPath,
                    concurrency: 3,
                    forceSsh: opts.forceSsh ?? false,
                    dryRun: opts.dryRun,
                    output: opts.output,
                    skipAggregate: false,
                    incremental: false,
                    skipEnrich: opts.skipEnrich ?? false,
                });
                log.info(
                    `批量导入完成：成功 ${result.succeeded}，失败 ${result.failed.length}，跳过 ${result.skipped.length}`,
                );
                // Rebuild global router.md / index.md with full stats
                try {
                    const { rebuildWikiIndex } = await import('./rebuild-wiki-index.js');
                    const teamRepoPath = path.join(cwd, '.teamai', 'team-repo');
                    const teamRepoWiki = path.join(teamRepoPath, 'teamwiki');
                    if (await fs.pathExists(teamRepoWiki)) {
                        await rebuildWikiIndex(teamRepoWiki);
                        log.info('teamwiki router.md / index.md 已重建');
                        const { autoPushTeamRepo } = await import('./utils/git.js');
                        await autoPushTeamRepo(teamRepoPath, '[teamai] Rebuild teamwiki index after batch import');
                    }
                } catch (e) {
                    log.debug(`wiki index rebuild/push failed: ${(e as Error).message}`);
                }
            } catch (err) {
                log.warn(`批量导入出错（不中断流程）：${String(err)}`);
            }
        } else {
            log.debug('白名单文件不存在，跳过批量导入');
        }
    }

    // 8. 记录完成事件
    await appendHistory(cwd, {
        ts: new Date().toISOString(),
        actor: 'ai',
        action: 'recommend',
        details: {
            event: 'bootstrap-complete',
            org: opts.org,
            repo_count: filteredRepos.length,
            
            
        },
    });

    log.success(`组织级初始化完成（${filteredRepos.length} 仓库）`);
}

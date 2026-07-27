// -*- coding: utf-8 -*-
/**
 * 组织级一键初始化入口。
 *
 * 对应 CLI：teamai import --from-org <org>
 *
 * 流程：
 *  1. 解析 org URL → provider + org 路径
 *  2. provider.listOrgRepos → OrgRepoInfo[]
 *  3. 按 includePattern / excludePattern / excludeArchived 过滤
 *  4. 生成扁平的 repo-whitelist 草稿（.teamai/repo-whitelist.draft.yaml）
 *  5. 若 skipImport=false，调 importFromRepoList 完成首次全量导入（产物写入 teamwiki）
 */

import path from 'node:path';
import fs from 'fs-extra';
import { importFromRepoList } from './import-repo-list.js';
import { getProviderFromUrl, getProvider } from './providers/registry.js';
import type { OrgRepoInfo } from './providers/types.js';
import { log } from './utils/logger.js';

// ─── 常量 ────────────────────────────────────────────────

const WHITELIST_DRAFT_PATH = '.teamai/repo-whitelist.draft.yaml';

// ─── 类型 ────────────────────────────────────────────────

/** importFromOrg 的选项。 */
export interface ImportFromOrgOptions {
    /** org URL 或 "github.com/org" / "git.woa.com/group" 或裸 "team-org" */
    org: string;
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

// ─── 主入口 ──────────────────────────────────────────────

/**
 * 组织级一键初始化。
 *
 * 列出 org 下所有仓 → 过滤 → 生成 repo-whitelist 草稿 → 可选全量导入（产物写入 teamwiki）。
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
            `Provider "${providerName}" does not support listOrgRepos, cannot use --from-org`,
        );
    }

    // 2. 拉取仓库列表
    log.info(`Fetching repo list from ${providerName}/${orgPath}`);
    let rawRepos: OrgRepoInfo[];
    try {
        rawRepos = await provider.listOrgRepos(orgPath, { maxRepos });
    } catch (err) {
        throw new Error(`listOrgRepos failed: ${String(err)}`);
    }

    log.info(`Fetched ${rawRepos.length} repos, filtering...`);

    // 3. 过滤
    const filteredRepos = filterRepos(rawRepos, {
        excludeArchived,
        includePattern: opts.includePattern,
        excludePattern: opts.excludePattern,
    });

    if (filteredRepos.length === 0) {
        log.warn('No repos after filtering, aborting');
        return;
    }

    log.info(`${filteredRepos.length} repos after filtering, generating whitelist...`);

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
        log.info(`Whitelist written: ${WHITELIST_DRAFT_PATH} (${filteredRepos.length} repos)`);
    }

    // 5. 批量导入
    if (!opts.skipImport) {
        const whitelistPath = whitelistDraftPath;

        if (await fs.pathExists(whitelistPath)) {
            log.info(`Starting batch import (whitelist: ${whitelistPath})...`);
            try {
                const result = await importFromRepoList({
                    listPath: whitelistPath,
                    concurrency: 3,
                    forceSsh: opts.forceSsh ?? false,
                    dryRun: opts.dryRun,
                    output: opts.output,
                    incremental: false,
                    skipEnrich: opts.skipEnrich ?? false,
                });
                log.info(
                    `Batch import complete: ${result.succeeded} succeeded, ${result.failed.length} failed, ${result.skipped.length} skipped`,
                );
                // Rebuild global router.md / index.md with full stats
                try {
                    const { rebuildWikiIndex } = await import('./rebuild-wiki-index.js');
                    const teamRepoPath = path.join(cwd, '.teamai', 'team-repo');
                    const teamRepoWiki = path.join(teamRepoPath, 'teamwiki');
                    if (await fs.pathExists(teamRepoWiki)) {
                        await rebuildWikiIndex(teamRepoWiki);
                        log.info('teamwiki router.md / index.md rebuilt');
                        const { autoPushTeamRepo } = await import('./utils/git.js');
                        await autoPushTeamRepo(teamRepoPath, '[teamai] Rebuild teamwiki index after batch import');
                    }
                } catch (e) {
                    log.debug(`wiki index rebuild/push failed: ${(e as Error).message}`);
                }
            } catch (err) {
                log.warn(`Batch import error (non-blocking): ${String(err)}`);
            }
        } else {
            log.debug('Whitelist file not found, skipping batch import');
        }
    }

    log.success(`Org initialization complete (${filteredRepos.length} repos)`);
}

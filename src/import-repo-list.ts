// -*- coding: utf-8 -*-
import fs from 'fs-extra';
import { loadRepoList } from './repo-list/store.js';
import { isOrgEntry, type RepoListEntry } from './repo-list/schema.js';
import { importFromRepo } from './import-repo.js';
import { publishTeamwikiViaMR, refreshTeamwikiIndexes } from './import-codebase.js';
import { log } from './utils/logger.js';
import { lockTeamwiki, resolveTeamwiki, type TeamwikiTarget } from './utils/teamwiki-root.js';

/** importFromRepoList 入参。 */
export interface ImportFromRepoListOptions {
    /** 白名单 yaml 路径 */
    listPath: string;
    /** 并发数，默认 3 */
    concurrency?: number;
    /** 强制 SSH clone */
    forceSsh?: boolean;
    /** Dry-run 模式 */
    dryRun?: boolean;
    /** 写入 <output>/teamwiki 而非团队仓库的 teamwiki/（不推送） */
    output?: string;
    /** 增量模式：缓存命中时仅 fetch+reset，未命中时 fallback 到全量 clone */
    incremental?: boolean;
    /** 跳过 AI enrichment（只做 clone + extract + graph，不调用 LLM） */
    skipEnrich?: boolean;
    /** 每个仓库采集源码文件的上限（默认 200） */
    maxFiles?: number;
}

/** importFromRepoList 汇总结果。 */
export interface ImportFromRepoListResult {
    succeeded: number;
    failed: Array<{ url: string; error: string }>;
    skipped: Array<{ url: string; reason: string }>;
}

/**
 * 按优先级排序条目（high 优先，low 最后，normal 居中）。
 *
 * @param entries RepoListEntry 数组
 * @returns       排序后的副本
 */
function sortByPriority(entries: RepoListEntry[]): RepoListEntry[] {
    const order: Record<string, number> = { high: 0, normal: 1, low: 2 };
    return [...entries].sort((a, b) => {
        const pa = order[a.priority ?? 'normal'] ?? 1;
        const pb = order[b.priority ?? 'normal'] ?? 1;
        return pa - pb;
    });
}

/**
 * 主入口：teamai import --from-repo-list <yaml>
 *
 * 流程：
 *  1. 加载白名单
 *  2. 展开 org entry（P5.2 暂不实现，遇到 org entry 直接 warn 跳过；留给 P5.4）
 *  3. 用 P5.1 的 importFromRepo 单仓内核处理每个 entry，并发上限 = concurrency
 *  4. 单仓失败不阻塞，最终汇总 succeeded/failed/skipped
 *
 * @param opts ImportFromRepoListOptions
 * @returns    汇总结果
 */
export async function importFromRepoList(
    opts: ImportFromRepoListOptions,
): Promise<ImportFromRepoListResult> {
    const {
        listPath,
        concurrency = 3,
        forceSsh = false,
        dryRun = false,
        output,
        incremental = false,
        skipEnrich = false,
        maxFiles,
    } = opts;

    // 1. 加载白名单
    const repoListFile = await loadRepoList(listPath);

    // Every entry lands in the same teamwiki: <output>/teamwiki, else the team repo's.
    let target: TeamwikiTarget | undefined;
    let releaseBatchLock: (() => Promise<void>) | null = null;
    if (!dryRun) {
        target = await resolveTeamwiki({ output });
        releaseBatchLock = await lockTeamwiki(target);
    }

    const succeeded: number[] = [];
    const failed: Array<{ url: string; error: string }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];

    try {
    // 2. 分拣 org entry（暂不支持）与单仓 entry
    const singleEntries: ReturnType<typeof sortByPriority> = [];
    for (const item of repoListFile.repos) {
        if (isOrgEntry(item)) {
            log.warn(`org entry not yet supported, skipped: ${item.org}`);
            skipped.push({ url: item.org, reason: 'org entry not yet supported' });
        } else {
            singleEntries.push(item);
        }
    }

    // 按优先级排序
    const orderedEntries = sortByPriority(singleEntries);

    // 3. 并发调度（简单 semaphore 循环）
    const semaphore = { running: 0 };
    const queue = [...orderedEntries];

    async function processEntry(entry: RepoListEntry): Promise<void> {
        const isPublic = entry.auth === 'public';
        const entryForceSsh = entry.auth === 'ssh' || forceSsh;

        try {
            await importFromRepo({
                url: entry.url,
                forceSsh: entryForceSsh,
                forceAnonymous: isPublic,
                explicitDomain: entry.domain,
                dryRun,
                output,
                incremental,
                skipAutoPush: true,
                skipEnrich,
                maxFiles,
            });
            succeeded.push(1);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`import failed: ${entry.url} — ${message}`);
            failed.push({ url: entry.url, error: message });
        }
    }

    // 并发控制循环
    const inFlight = new Set<Promise<void>>();

    for (const entry of queue) {
        while (semaphore.running >= concurrency) {
            // 等待任意一个完成
            await Promise.race(inFlight);
        }

        semaphore.running++;
        const task = processEntry(entry).finally(() => {
            semaphore.running--;
            inFlight.delete(task);
        });
        inFlight.add(task);
    }

    // 等待全部完成
    await Promise.all(inFlight);

    // 4. 统一聚合全局 graph-index.json，并全量重建 router.md / index.md（避免并发竞态）
    if (target && succeeded.length > 0 && await fs.pathExists(target.wikiRoot)) {
        await refreshTeamwikiIndexes(target.wikiRoot);
        log.info('teamwiki router.md / index.md rebuilt');
    }

    // 5. 统一推送（graph 通过 MR 提交）；--output 不碰团队仓库
    if (target?.team && succeeded.length > 0) {
        try {
            await publishTeamwikiViaMR(target.team, '[teamai] Batch import: graph');
        } catch (e) {
            log.warn(`[git] batch push failed (non-blocking): ${(e as Error).message}`);
        }
    }

    } finally {
        if (releaseBatchLock) {
            await releaseBatchLock();
        }
    }

    return {
        succeeded: succeeded.length,
        failed,
        skipped,
    };
}

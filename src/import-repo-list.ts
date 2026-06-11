// -*- coding: utf-8 -*-
import { loadRepoList } from './repo-list/store.js';
import { isOrgEntry, type RepoListEntry } from './repo-list/schema.js';
import { importFromRepo } from './import-repo.js';
import { loadDomains } from './domains/index.js';
import { regenerateAggregate } from './aggregate.js';
import { getTeamCodebasePaths } from './utils/team-codebase-paths.js';
import { log } from './utils/logger.js';

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
    /** 自定义产物根（同 P5.1 的 output 语义） */
    output?: string;
    /** 跳过 domain-*.md 与 index.md 重生（仅做单仓） */
    skipAggregate?: boolean;
    /** 增量模式：缓存命中时仅 fetch+reset，未命中时 fallback 到全量 clone */
    incremental?: boolean;
}

/** importFromRepoList 汇总结果。 */
export interface ImportFromRepoListResult {
    succeeded: number;
    failed: Array<{ url: string; error: string }>;
    skipped: Array<{ url: string; reason: string }>;
    aggregateGenerated: boolean;
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
 *  5. 全部完成后调用 regenerateAggregate 重建 domain-*.md + index.md
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
        skipAggregate = false,
        incremental = false,
    } = opts;

    // 1. 加载白名单
    const repoListFile = await loadRepoList(listPath);

    const succeeded: number[] = [];
    const failed: Array<{ url: string; error: string }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];

    // 2. 分拣 org entry（暂不支持）与单仓 entry
    const singleEntries: ReturnType<typeof sortByPriority> = [];
    for (const item of repoListFile.repos) {
        if (isOrgEntry(item)) {
            log.warn(`org entry 暂不支持，已跳过：${item.org}（将在 P5.4 实现）`);
            skipped.push({ url: item.org, reason: 'org entry 暂不支持（P5.4 实现）' });
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
                interactive: false,
                incremental,
            });
            succeeded.push(1);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`导入失败：${entry.url} — ${message}`);
            failed.push({ url: entry.url, error: message });
        }
    }

    // 并发控制循环
    const inFlight: Promise<void>[] = [];

    for (const entry of queue) {
        while (semaphore.running >= concurrency) {
            // 等待任意一个完成
            await Promise.race(inFlight);
        }

        semaphore.running++;
        const task = processEntry(entry).finally(() => {
            semaphore.running--;
            const idx = inFlight.indexOf(task);
            if (idx !== -1) inFlight.splice(idx, 1);
        });
        inFlight.push(task);
    }

    // 等待全部完成
    await Promise.all(inFlight);

    // 5. 重建聚合文件
    let aggregateGenerated = false;
    if (!skipAggregate && !dryRun) {
        try {
            const cwd = process.cwd();
            const paths = getTeamCodebasePaths(cwd, output);
            const domains = await loadDomains(cwd);
            await regenerateAggregate({ paths, domains });
            aggregateGenerated = true;
            log.info(`聚合文件已生成：${paths.index}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(`聚合文件生成失败（不中断流程）：${message}`);
        }
    }

    return {
        succeeded: succeeded.length,
        failed,
        skipped,
        aggregateGenerated,
    };
}

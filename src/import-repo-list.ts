import { loadRepoList } from './repo-list/store.js';
import { isOrgEntry, type RepoListEntry } from './repo-list/schema.js';
import { log } from './utils/logger.js';
import type { ImportItem, ImportSettings } from './import-from-repo.js';
import type { ShortcutEnd } from './workflow-commands.js';

/** importFromRepoList 入参。 */
export interface ImportFromRepoListOptions {
    /** 白名单 yaml 路径 */
    listPath: string;
    /** Maximum concurrent imports: a positive safe integer, default 3. */
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
    /** The command a person ran, as a refusal names it. */
    command?: string;
    /** --from-org starts the list it wrote. */
    mode?: 'list' | 'org';
}

/** What `importFromRepoList` did: previewed the list, or ran it. */
export type RepoListImport =
    | { kind: 'preview'; summary: string; failed: number }
    | { kind: 'run'; end: ShortcutEnd | undefined };

/**
 * 按优先级排序条目（high 优先，low 最后，normal 居中）。
 *
 * @param entries RepoListEntry 数组
 * @returns       排序后的副本
 */
function sortByPriority(entries: RepoListEntry[]): RepoListEntry[] {
    const order = new Map<string, number>([['high', 0], ['normal', 1], ['low', 2]]);

    return [...entries].sort((a, b) => {
        const pa = order.get(a.priority ?? 'normal') ?? 1;
        const pb = order.get(b.priority ?? 'normal') ?? 1;

        return pa - pb;
    });
}

/**
 * `teamai import --from-repo-list <yaml>`: imports every repository of the list, `concurrency` at once, through one
 * teamai-import-from-repo run, which refreshes the teamwiki indexes and publishes them once for the batch. An org entry
 * is skipped. One repository failing does not stop the others; the run's summary counts it, and the command exits 1.
 * A dry run previews each repository and starts no run.
 *
 * @returns how the run ended (undefined when it did not start), or for a dry run the summary of the previews
 */
export async function importFromRepoList(opts: ImportFromRepoListOptions): Promise<RepoListImport> {
    const { listPath, concurrency = 3, forceSsh = false, dryRun = false, output } = opts;

    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new Error('--concurrency must be a positive safe integer');
    }

    const repoListFile = await loadRepoList(listPath);
    const singleEntries: RepoListEntry[] = [];
    let skipped = 0;

    for (const item of repoListFile.repos) {
        if (isOrgEntry(item)) {
            log.warn(`org entry not yet supported, skipped: ${item.org}`);
            skipped++;
        } else {
            singleEntries.push(item);
        }
    }

    const orderedEntries = sortByPriority(singleEntries);

    if (dryRun) {
        const { previewRepoImport, repoSourceOf } = await import('./import-repo.js');
        let failed = 0;

        for (const entry of orderedEntries) {
            try {
                await previewRepoImport(repoSourceOf(entry.url), {
                    forceSsh: entry.auth === 'ssh' || forceSsh, forceAnonymous: entry.auth === 'public', incremental: opts.incremental, output,
                });
            } catch (err) {
                log.warn(`import failed: ${entry.url} — ${err instanceof Error ? err.message : String(err)}`);
                failed++;
            }
        }

        return { kind: 'preview', summary: `Batch import complete: ${orderedEntries.length - failed} succeeded, ${failed} failed, ${skipped} skipped`, failed };
    }

    const items: ImportItem[] = orderedEntries.map((entry) => ({ kind: 'repo', url: entry.url, domain: entry.domain, auth: entry.auth }));
    const settings: ImportSettings = { depth: 1, forceSsh, incremental: opts.incremental ?? false, skipEnrich: opts.skipEnrich ?? false, maxFiles: opts.maxFiles };
    const { resolveTeamwiki } = await import('./utils/teamwiki-root.js');
    const { ImportFromRepo } = await import('./import-from-repo.js');

    const end = await ImportFromRepo.start({
        mode: opts.mode ?? 'list', items, settings, target: await resolveTeamwiki({ output }), skipped, concurrency,
        command: opts.command ?? 'teamai import --from-repo-list',
    });

    return { kind: 'run', end };
}

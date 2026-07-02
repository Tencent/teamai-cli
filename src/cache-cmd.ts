import chalk from 'chalk';

import type { GlobalOptions } from './types.js';
import { getCacheStatus, gcCache } from './utils/cache-index.js';
import { log } from './utils/logger.js';

// ─── Types ───────────────────────────────────────────────

export interface CacheCmdOptions extends GlobalOptions {
    status?: boolean;
    gc?: boolean;
    maxBytes?: string;
    staleDays?: string;
    dryRun?: boolean;
    json?: boolean;
}

// ─── Helpers ────────────────────────────────────────────

/**
 * 将字节数格式化为人类可读字符串（B / KB / MB / GB）。
 *
 * @param bytes  字节数
 */
function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
    if (bytes >= 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${bytes} B`;
}

/**
 * 截断 SHA 到 8 位短格式。
 *
 * @param sha  完整 SHA 或 undefined
 */
function shortSha(sha?: string): string {
    if (!sha) return '-';
    return sha.slice(0, 8);
}

// ─── Command ──────────────────────────────────────────────

/**
 * teamai cache 命令入口。
 *
 * 支持 --status（默认）和 --gc 两种操作模式，配合 --json 输出机器可读格式。
 *
 * @param opts  命令行选项
 */
export async function cacheCmd(opts: CacheCmdOptions): Promise<void> {
    const isGc = opts.gc === true;

    if (isGc) {
        await runGc(opts);
    } else {
        await runStatus(opts);
    }
}

async function runStatus(opts: CacheCmdOptions): Promise<void> {
    const result = await getCacheStatus();

    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    console.log('');
    console.log(chalk.bold('Cache root:'), result.root);
    console.log('');

    if (result.entryCount === 0) {
        console.log(chalk.gray('（无缓存条目）'));
        return;
    }

    // 表头
    const colKey = 50;
    const colSize = 12;
    const colUsed = 26;
    const colSha = 10;

    const header = [
        'KEY'.padEnd(colKey),
        'SIZE'.padStart(colSize),
        'LAST_USED'.padEnd(colUsed),
        'SHA',
    ].join('  ');

    console.log(chalk.underline(header));

    for (const entry of result.entries) {
        const keyTrunc = entry.key.length > colKey ? `…${entry.key.slice(-(colKey - 1))}` : entry.key;
        const row = [
            keyTrunc.padEnd(colKey),
            formatBytes(entry.size_bytes).padStart(colSize),
            entry.last_used.padEnd(colUsed),
            shortSha(entry.last_synced_sha),
        ].join('  ');
        console.log(row);
    }

    console.log('');
    console.log(
        chalk.bold(`总计: ${result.entryCount} 个仓库，占用 ${formatBytes(result.totalBytes)}`),
    );
    console.log('');
}

async function runGc(opts: CacheCmdOptions): Promise<void> {
    let maxBytes: number | undefined;
    if (opts.maxBytes !== undefined) {
        const parsed = parseInt(opts.maxBytes, 10);
        if (!isNaN(parsed) && parsed > 0) {
            maxBytes = parsed;
        } else {
            log.warn(`--max-bytes 值无效: ${opts.maxBytes}，将使用默认值`);
        }
    }

    let staleDays: number | undefined;
    if (opts.staleDays !== undefined) {
        const parsed = parseInt(opts.staleDays, 10);
        if (!isNaN(parsed) && parsed > 0) {
            staleDays = parsed;
        } else {
            log.warn(`--stale-days 值无效: ${opts.staleDays}，将使用默认值`);
        }
    }

    const gcOpts = {
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(staleDays !== undefined ? { staleDays } : {}),
        dryRun: opts.dryRun,
    };

    const result = await gcCache(gcOpts);

    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (result.skipped.length > 0) {
            process.exit(1);
        }
        return;
    }

    const dryRunTag = opts.dryRun ? chalk.yellow('[dry-run] ') : '';

    console.log('');
    console.log(chalk.bold(`${dryRunTag}GC 执行结果`));
    console.log('');
    console.log(
        `前: ${result.before.entryCount} 个仓库，${formatBytes(result.before.totalBytes)}`,
    );
    console.log(
        `后: ${result.after.entryCount} 个仓库，${formatBytes(result.after.totalBytes)}`,
    );
    console.log('');

    if (result.removed.length === 0) {
        console.log(chalk.green('无需清理'));
    } else {
        console.log(chalk.bold(`清理列表（${result.removed.length} 项）:`));
        for (const item of result.removed) {
            const tag = item.reason === 'stale' ? chalk.yellow('[stale]') : chalk.red('[over-cap]');
            console.log(`  ${tag} ${item.key}  (${formatBytes(item.size_bytes)})`);
        }
    }

    if (result.skipped.length > 0) {
        console.log('');
        console.log(chalk.bold(chalk.red(`跳过列表（${result.skipped.length} 项，需人工排查）:`)));
        for (const item of result.skipped) {
            console.log(`  ${chalk.red('[skip]')} ${item.key}: ${item.reason}`);
        }
        console.log('');
        process.exit(1);
    }

    console.log('');
}

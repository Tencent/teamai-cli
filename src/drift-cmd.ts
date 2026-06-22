// -*- coding: utf-8 -*-
/**
 * drift 子命令实现：list / show / apply / lock 域漂移待处理项。
 *
 * 通过 `teamai domains drift` 调用，支持批量 apply、单条 apply/lock 操作。
 */

import chalk from 'chalk';

import {
    loadDomains,
    saveDomains,
    appendHistory,
    type DomainsFile,
} from './domains/index.js';
import {
    loadPendingReview,
    removePendingReview,
    type PendingReviewItem,
} from './review-store.js';
import { regenerateAggregate } from './aggregate.js';
import { getTeamCodebasePaths } from './utils/team-codebase-paths.js';
import { askConfirmation } from './utils/prompt.js';
import { log } from './utils/logger.js';
import type { GlobalOptions } from './types.js';

// ─── 类型 ────────────────────────────────────────────────

export interface DriftCmdOptions extends GlobalOptions {
    /** 位置参数：repoUrl，从 commander argument 取 */
    repoUrlArg?: string;
    apply?: boolean;
    applyAll?: boolean;
    threshold?: string;
    lock?: boolean;
    output?: string;
    json?: boolean;
    skipAggregate?: boolean;
    /** 测试专用：非 TTY 下自动确认新建域 */
    assumeYesForNewDomain?: boolean;
}

interface ApplyResult {
    ok: boolean;
    reason?: string;
}

// ─── 渲染辅助 ────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function renderDriftList(items: PendingReviewItem[]): void {
    const driftItems = items.filter((item) => item.kind === 'domain-drift');
    if (driftItems.length === 0) {
        console.log(chalk.gray('[drift] 暂无待处理漂移项'));
        return;
    }
    console.log(chalk.cyan(`[drift] 共 ${driftItems.length} 项`));
    const header = [
        '  ' + 'URL'.padEnd(40),
        '旧域'.padEnd(12),
        '新域(置信度)'.padEnd(18),
        'TS',
    ].join('  ');
    console.log(chalk.gray(header));
    for (const item of driftItems) {
        const url = truncate(String(item.payload['url'] ?? ''), 40).padEnd(40);
        const oldDomain = truncate(String(item.payload['oldDomain'] ?? ''), 12).padEnd(12);
        const newDomain = String(item.payload['newRecommendedDomain'] ?? '');
        const newConf = Number(item.payload['newConfidence'] ?? 0).toFixed(2);
        const newDomainCol = truncate(`${newDomain} (${newConf})`, 18).padEnd(18);
        const ts = item.ts.slice(0, 19);
        console.log(`  ${url}  ${chalk.yellow(oldDomain)}  ${chalk.green(newDomainCol)}  ${chalk.gray(ts)}`);
    }
}

function renderDriftJson(items: PendingReviewItem[]): void {
    const driftItems = items.filter((item) => item.kind === 'domain-drift');
    console.log(JSON.stringify(driftItems, null, 2));
}

// ─── apply 单条 ───────────────────────────────────────────

async function applyOne(
    cwd: string,
    item: PendingReviewItem,
    opts: DriftCmdOptions,
): Promise<ApplyResult> {
    if (item.kind !== 'domain-drift') {
        return { ok: false, reason: 'kind 不匹配' };
    }

    const url = String(item.payload['url'] ?? '');
    const oldDomain = String(item.payload['oldDomain'] ?? '');
    const newDomain = String(item.payload['newRecommendedDomain'] ?? '');
    const newConfidence = Number(item.payload['newConfidence'] ?? 0);
    const signal = String(item.payload['signal'] ?? '');

    if (!url || !oldDomain || !newDomain) {
        return { ok: false, reason: 'payload 字段缺失' };
    }

    const domains = await loadDomains(cwd);
    const oldEntry = domains.domains.find((d) => d.name === oldDomain);
    if (!oldEntry) {
        return { ok: false, reason: `旧域 ${oldDomain} 不存在` };
    }
    const repoIdx = oldEntry.repos.findIndex((r) => r.url === url);
    if (repoIdx === -1) {
        return { ok: false, reason: `${url} 不在旧域 ${oldDomain}` };
    }
    const repoEntry = oldEntry.repos[repoIdx]!;

    // 处理新域：不存在则提示新建
    let newEntry = domains.domains.find((d) => d.name === newDomain);
    if (!newEntry) {
        if (!process.stdin.isTTY && !opts.assumeYesForNewDomain) {
            return {
                ok: false,
                reason: `新域 ${newDomain} 不存在；非 TTY 不能自动新建（用 -y 或交互模式）`,
            };
        }
        const confirmed = opts.assumeYesForNewDomain
            ?? await askConfirmation(`新域「${newDomain}」不存在，是否新建？`, true);
        if (!confirmed) {
            return { ok: false, reason: '用户取消新建域' };
        }
        newEntry = { name: newDomain, description: '', confidence: 1.0, repos: [] };
        domains.domains.push(newEntry);
    }

    // 移动 entry
    oldEntry.repos.splice(repoIdx, 1);
    newEntry.repos.push({
        ...repoEntry,
        confidence: newConfidence,
        signal: signal || repoEntry.signal,
    });

    await saveDomains(cwd, domains);
    await appendHistory(cwd, {
        ts: new Date().toISOString(),
        actor: 'user',
        action: 'reassign',
        details: { url, fromDomain: oldDomain, toDomain: newDomain, newConfidence },
    });

    await removePendingReview(cwd, item.id);

    if (!opts.skipAggregate) {
        try {
            const paths = getTeamCodebasePaths(cwd, opts.output);
            await regenerateAggregate({ paths, domains });
        } catch (err) {
            log.warn(`[drift] aggregate 刷新失败：${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return { ok: true };
}

// ─── lock 单条 ────────────────────────────────────────────

async function lockOne(cwd: string, url: string): Promise<ApplyResult> {
    const domains = await loadDomains(cwd);

    let found = false;
    for (const domainEntry of domains.domains) {
        const repoIdx = domainEntry.repos.findIndex((r) => r.url === url);
        if (repoIdx !== -1) {
            domainEntry.repos[repoIdx] = { ...domainEntry.repos[repoIdx]!, locked: true };
            found = true;
            break;
        }
    }

    if (!found) {
        return { ok: false, reason: `${url} 不在任何域中` };
    }

    await saveDomains(cwd, domains);
    await appendHistory(cwd, {
        ts: new Date().toISOString(),
        actor: 'user',
        action: 'lock',
        details: { url },
    });

    // 移除所有该 url 的 drift 项
    const existing = await loadPendingReview(cwd);
    for (const item of existing) {
        if (item.kind === 'domain-drift' && String(item.payload['url'] ?? '') === url) {
            await removePendingReview(cwd, item.id);
        }
    }

    return { ok: true };
}

// ─── 主入口 ───────────────────────────────────────────────

/**
 * teamai domains drift [repoUrl] [--apply | --lock | --apply-all] 主入口。
 *
 * 操作分发：
 * - 无 repoUrlArg + 无 --apply-all → list 模式
 * - repoUrlArg + 无标志 → show 单条
 * - repoUrlArg + --apply → applyOne
 * - repoUrlArg + --lock → lockOne
 * - --apply-all [--threshold N] → 批量 apply
 */
export async function driftCmd(opts: DriftCmdOptions): Promise<void> {
    const cwd = process.cwd();
    const { repoUrlArg, apply, applyAll, threshold = '0.8', lock, json } = opts;

    // ── apply-all ──
    if (applyAll) {
        const thresholdNum = parseFloat(threshold);
        const items = await loadPendingReview(cwd);
        const driftItems = items
            .filter((item) => item.kind === 'domain-drift')
            .sort((a, b) => {
                const ca = Number(a.payload['newConfidence'] ?? 0);
                const cb = Number(b.payload['newConfidence'] ?? 0);
                return cb - ca;
            });

        let okCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (const item of driftItems) {
            const conf = Number(item.payload['newConfidence'] ?? 0);
            if (conf <= thresholdNum) {
                skippedCount++;
                continue;
            }
            const result = await applyOne(cwd, item, opts);
            if (result.ok) {
                okCount++;
            } else {
                failedCount++;
                log.warn(`[drift] apply 失败（${String(item.payload['url'] ?? '')}）：${result.reason ?? '未知错误'}`);
            }
        }

        if (json) {
            console.log(JSON.stringify({ ok: okCount, skipped: skippedCount, failed: failedCount }));
        } else {
            console.log(
                chalk.cyan('[drift] apply-all 完成：') +
                chalk.green(`${okCount} 成功`) + '  ' +
                chalk.yellow(`${skippedCount} 跳过`) + '  ' +
                chalk.red(`${failedCount} 失败`),
            );
        }
        return;
    }

    // ── 单条操作 ──
    if (repoUrlArg) {
        const items = await loadPendingReview(cwd);
        const driftItems = items.filter(
            (item) => item.kind === 'domain-drift' && String(item.payload['url'] ?? '') === repoUrlArg,
        );

        if (apply) {
            if (driftItems.length === 0) {
                log.error(`[drift] 未找到 ${repoUrlArg} 的漂移项`);
                process.exitCode = 1;
                return;
            }
            const item = driftItems[0]!;
            const result = await applyOne(cwd, item, opts);
            if (result.ok) {
                console.log(chalk.green(`[drift] apply 成功：${repoUrlArg}`));
            } else {
                log.error(`[drift] apply 失败：${result.reason ?? '未知错误'}`);
                process.exitCode = 1;
            }
            return;
        }

        if (lock) {
            const result = await lockOne(cwd, repoUrlArg);
            if (result.ok) {
                console.log(chalk.green(`[drift] lock 成功：${repoUrlArg}`));
            } else {
                log.error(`[drift] lock 失败：${result.reason ?? '未知错误'}`);
                process.exitCode = 1;
            }
            return;
        }

        // show 单条
        if (driftItems.length === 0) {
            console.log(chalk.gray(`[drift] 未找到 ${repoUrlArg} 的漂移项`));
            return;
        }
        if (json) {
            console.log(JSON.stringify(driftItems, null, 2));
        } else {
            renderDriftList(driftItems);
        }
        return;
    }

    // ── list 模式 ──
    const items = await loadPendingReview(cwd);
    if (json) {
        renderDriftJson(items);
    } else {
        renderDriftList(items);
    }
}

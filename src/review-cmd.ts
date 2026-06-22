// -*- coding: utf-8 -*-
/**
 * review 子命令实现：list / show / apply / reject 待处理项。
 *
 * 支持 --apply / --reject / --all-apply 等操作，apply 时调用 patchManagedSection 落盘。
 */

import path from 'node:path';

import chalk from 'chalk';
import fs from 'fs-extra';

import { appendHistory } from './domains/index.js';
import { patchManagedSection } from './section-patcher.js';
import type { GlobalOptions } from './types.js';
import { log } from './utils/logger.js';
import {
    loadPendingReview,
    removePendingReview,
    savePendingReview,
    type PendingReviewItem,
    type Risk,
} from './review-store.js';

// ─── 类型 ────────────────────────────────────────────────

export interface ReviewCmdOptions extends GlobalOptions {
    /** 位置参数：单条 ID（从 commander argument 取） */
    idArg?: string;
    apply?: boolean;
    reject?: boolean;
    reason?: string;
    allApply?: boolean;
    /** --all-apply 时按风险过滤；默认 medium */
    maxRisk?: Risk;
    json?: boolean;
}

// ─── 风险排序 ────────────────────────────────────────────

const RISK_ORDER: Record<Risk, number> = { high: 0, medium: 1, low: 2 };

function riskAtMost(itemRisk: Risk, ceiling: Risk): boolean {
    return RISK_ORDER[itemRisk] >= RISK_ORDER[ceiling];
}

// ─── 渲染辅助 ────────────────────────────────────────────

function riskColor(risk: Risk): string {
    if (risk === 'high') return chalk.red(risk);
    if (risk === 'medium') return chalk.yellow(risk);
    return chalk.green(risk);
}

function truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function renderList(items: PendingReviewItem[]): void {
    const counts = { high: 0, medium: 0, low: 0 };
    for (const item of items) counts[item.risk]++;

    console.log(
        chalk.bold(`[review] 共 ${items.length} 项`) +
        `（high: ${counts.high}, medium: ${counts.medium}, low: ${counts.low}）`,
    );

    if (items.length === 0) return;

    const header = [
        'ID'.padEnd(14),
        'RISK'.padEnd(10),
        'KIND'.padEnd(22),
        'TARGET'.padEnd(42),
        'SOURCE',
    ].join('  ');
    console.log(chalk.dim(header));

    for (const item of items) {
        const target = item.target.section
            ? `${truncate(item.target.file, 20)}:${truncate(item.target.section, 18)}`
            : truncate(item.target.file, 40);
        const row = [
            item.id.padEnd(14),
            riskColor(item.risk).padEnd(10 + (riskColor(item.risk).length - item.risk.length)),
            item.kind.padEnd(22),
            truncate(target, 40).padEnd(42),
            truncate(item.source, 30),
        ].join('  ');
        console.log(row);
    }
}

function renderShow(item: PendingReviewItem): void {
    console.log(chalk.bold('─── Pending Review Item ─────────────────'));
    console.log(`  ${chalk.cyan('ID')}:      ${item.id}`);
    console.log(`  ${chalk.cyan('ts')}:      ${item.ts}`);
    console.log(`  ${chalk.cyan('kind')}:    ${item.kind}`);
    console.log(`  ${chalk.cyan('risk')}:    ${riskColor(item.risk)}`);
    console.log(`  ${chalk.cyan('source')}:  ${item.source}`);
    console.log(`  ${chalk.cyan('target')}:`);
    console.log(`    file:    ${item.target.file}`);
    if (item.target.section) {
        console.log(`    section: ${item.target.section}`);
    }

    const content = item.payload['content'];
    if (typeof content === 'string' && content) {
        console.log(`  ${chalk.cyan('content')}:`);
        const lines = content.split('\n').slice(0, 20);
        for (const line of lines) {
            console.log(`    ${line}`);
        }
        if (content.split('\n').length > 20) {
            console.log(chalk.dim('    ... (truncated)'));
        }
    } else {
        console.log(`  ${chalk.cyan('payload')}: ${JSON.stringify(item.payload)}`);
    }
    console.log(chalk.bold('──────────────────────────────────────────'));
}

// ─── Apply 核心逻辑 ──────────────────────────────────────

async function applyOne(
    cwd: string,
    item: PendingReviewItem,
): Promise<{ ok: boolean; reason?: string }> {
    if (item.kind !== 'codebase-section') {
        return { ok: false, reason: `kind ${item.kind} 不支持自动应用，请人工处理` };
    }

    const { file, section } = item.target;
    if (!section) {
        return { ok: false, reason: 'target.section 缺失' };
    }

    const filePath = path.isAbsolute(file) ? file : path.join(cwd, file);
    if (!await fs.pathExists(filePath)) {
        return { ok: false, reason: `目标文件不存在：${filePath}` };
    }

    const oldMd = await fs.readFile(filePath, 'utf8');
    const body = String(item.payload['content'] ?? '');
    if (!body) {
        return { ok: false, reason: 'payload.content 为空' };
    }

    try {
        const newMd = patchManagedSection(oldMd, section, body, {
            source: item.source,
            syncedAt: new Date().toISOString(),
        });
        await fs.writeFile(filePath, newMd, 'utf8');
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

// ─── 主入口 ──────────────────────────────────────────────

/**
 * review 子命令主函数，分发 list / show / apply / reject / all-apply 模式。
 */
export async function reviewCmd(opts: ReviewCmdOptions): Promise<void> {
    const cwd = process.cwd();
    const { idArg, apply, reject, allApply, maxRisk = 'medium', json: jsonMode } = opts;

    // ── all-apply 模式 ────────────────────────────────────
    if (allApply) {
        const items = await loadPendingReview(cwd);
        const candidates = items.filter(
            (item) => item.kind === 'codebase-section' && riskAtMost(item.risk, maxRisk),
        );
        const skipped = items.filter(
            (item) => item.kind !== 'codebase-section' || !riskAtMost(item.risk, maxRisk),
        );

        const results: Array<{ id: string; ok: boolean; reason?: string }> = [];
        for (const item of candidates) {
            const result = await applyOne(cwd, item);
            if (result.ok) {
                await removePendingReview(cwd, item.id);
                await appendHistory(cwd, {
                    ts: new Date().toISOString(),
                    actor: 'user',
                    action: 'accept',
                    details: { id: item.id, target: item.target },
                });
            }
            results.push({ id: item.id, ok: result.ok, reason: result.reason });
        }

        if (jsonMode) {
            console.log(JSON.stringify({ results, skipped: skipped.map((s) => s.id) }));
            return;
        }

        const succeeded = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        const summary = `[review] --all-apply 完成：成功 ${succeeded.length}，失败 ${failed.length}，跳过 ${skipped.length}`;
        console.log(chalk.bold(summary));
        for (const fail of failed) {
            console.log(chalk.red(`  ✗ ${fail.id}: ${fail.reason}`));
        }
        for (const skip of skipped) {
            console.log(chalk.dim(`  ○ 跳过 ${skip.id}（kind=${skip.kind}, risk=${skip.risk}）`));
        }
        return;
    }

    // ── 无 idArg → list 模式 ──────────────────────────────
    if (!idArg) {
        const items = await loadPendingReview(cwd);
        const sorted = [...items].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]);

        if (jsonMode) {
            console.log(JSON.stringify(sorted));
            return;
        }

        renderList(sorted);
        return;
    }

    // ── 有 idArg 先查出条目 ───────────────────────────────
    const items = await loadPendingReview(cwd);
    const item = items.find((i) => i.id === idArg);

    if (!item) {
        log.warn(`[review] 未找到 id="${idArg}"`);
        if (jsonMode) {
            console.log(JSON.stringify({ ok: false, reason: `未找到 id="${idArg}"` }));
        }
        return;
    }

    // ── reject 模式 ───────────────────────────────────────
    if (reject) {
        await removePendingReview(cwd, idArg);
        await appendHistory(cwd, {
            ts: new Date().toISOString(),
            actor: 'user',
            action: 'reject',
            details: { id: idArg, reason: opts.reason ?? '' },
        });

        if (jsonMode) {
            console.log(JSON.stringify({ ok: true, action: 'reject', id: idArg }));
            return;
        }
        console.log(chalk.yellow(`[review] 已拒绝：${idArg}`));
        return;
    }

    // ── apply 模式 ────────────────────────────────────────
    if (apply) {
        const result = await applyOne(cwd, item);

        if (result.ok) {
            await removePendingReview(cwd, idArg);
            await appendHistory(cwd, {
                ts: new Date().toISOString(),
                actor: 'user',
                action: 'accept',
                details: { id: idArg, target: item.target },
            });
        }

        if (jsonMode) {
            console.log(JSON.stringify({ ok: result.ok, reason: result.reason, id: idArg }));
            return;
        }

        if (result.ok) {
            console.log(chalk.green(`[review] 已应用：${idArg} → ${item.target.file}`));
        } else {
            console.log(chalk.red(`[review] 应用失败：${idArg} — ${result.reason}`));
        }
        return;
    }

    // ── show 模式（默认，无 --apply / --reject）───────────
    if (jsonMode) {
        console.log(JSON.stringify(item));
        return;
    }
    renderShow(item);
}

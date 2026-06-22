import chalk from 'chalk';

import type { GlobalOptions } from './types.js';
import {
    lintTeamCodebase,
    formatLintReport,
    fixTeamCodebase,
} from './codebase-lint.js';
import type { Severity, LintReport, FixResult } from './codebase-lint.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CodebaseCmdOptions extends GlobalOptions {
    lint?: boolean;
    fix?: boolean;
    severity?: Severity;
    staleDays?: string;
    pendingReviewThreshold?: string;
    json?: boolean;
    output?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatFixResult(result: FixResult): string {
    const lines: string[] = [];
    if (result.applied.length > 0) {
        lines.push(chalk.green(`[fix] 已应用 ${result.applied.length} 项修复：`));
        for (const item of result.applied) {
            lines.push(chalk.green(`  ✓ [${item.category}] ${item.location}`));
            lines.push(`      ${item.description}`);
        }
    }
    if (result.skipped.length > 0) {
        lines.push(chalk.yellow(`[fix] 跳过 ${result.skipped.length} 项：`));
        for (const item of result.skipped) {
            lines.push(chalk.yellow(`  - [${item.category}] ${item.location}`));
            lines.push(`      ${item.reason}`);
        }
    }
    return lines.join('\n');
}

function hasHighIssues(report: LintReport): boolean {
    return report.summary.bySeverity.high > 0;
}

// ─── Command handler ─────────────────────────────────────────────────────────

/**
 * codebase 子命令处理函数。
 *
 * 支持 --lint（全局一致性检查）、--fix（低风险机械修复）、--json（CI 机器可读输出）。
 *
 * @param opts 命令选项（含全局选项）
 */
export async function codebaseCmd(opts: CodebaseCmdOptions): Promise<void> {
    const cwd = process.cwd();

    if (!opts.lint) {
        console.log('teamai codebase — 团队 codebase 文档健康度管理');
        console.log('');
        console.log('用法：');
        console.log('  teamai codebase --lint                  运行全局一致性检查');
        console.log('  teamai codebase --lint --fix            检查并自动修复低风险问题');
        console.log('  teamai codebase --lint --json           输出 JSON 报告（适合 CI）');
        console.log('  teamai codebase --lint --severity high  只报告 high 级别问题');
        return;
    }

    const staleDays = opts.staleDays ? parseInt(opts.staleDays, 10) : 60;
    const pendingThreshold = opts.pendingReviewThreshold
        ? parseInt(opts.pendingReviewThreshold, 10)
        : 10;
    const severity = opts.severity ?? 'info';

    if (opts.fix) {
        // lint → fix → re-lint
        const initialReport = await lintTeamCodebase({
            cwd,
            output: opts.output,
            severity,
            staleDays,
            pendingReviewThreshold: pendingThreshold,
        });

        const fixResult = await fixTeamCodebase({
            cwd,
            output: opts.output,
            dryRun: opts.dryRun,
        });

        if (opts.json) {
            // Re-run lint after fix to get final state
            const finalReport = await lintTeamCodebase({
                cwd,
                output: opts.output,
                severity,
                staleDays,
                pendingReviewThreshold: pendingThreshold,
            });
            console.log(JSON.stringify({ fixResult, finalReport }, null, 2));
            if (hasHighIssues(finalReport)) {
                process.exitCode = 1;
            }
        } else {
            console.log(formatFixResult(fixResult));
            console.log('');

            // Show remaining issues
            const finalReport = await lintTeamCodebase({
                cwd,
                output: opts.output,
                severity,
                staleDays,
                pendingReviewThreshold: pendingThreshold,
            });
            console.log('── 修复后剩余问题 ──');
            console.log(formatLintReport(finalReport));

            if (hasHighIssues(finalReport)) {
                process.exitCode = 1;
            }
        }
        // Suppress unused variable warning for initialReport
        void initialReport;
    } else {
        // lint only
        const report = await lintTeamCodebase({
            cwd,
            output: opts.output,
            severity,
            staleDays,
            pendingReviewThreshold: pendingThreshold,
        });

        if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            console.log(formatLintReport(report));
        }

        if (hasHighIssues(report)) {
            process.exitCode = 1;
        }
    }
}

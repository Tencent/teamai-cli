import path from 'node:path';
import { readFile } from 'node:fs/promises';

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
    extract?: boolean | string;
    incremental?: boolean;
    upgradeWiki?: boolean;
    severity?: Severity;
    staleDays?: string;
    pendingReviewThreshold?: string;
    json?: boolean;
    output?: string;
    project?: string;
    maxFiles?: string;
    status?: boolean;
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

    if (opts.upgradeWiki) {
        const { upgradeCodebaseWiki } = await import('./codebase-upgrade-wiki.js');
        await upgradeCodebaseWiki({ cwd, dryRun: opts.dryRun, json: opts.json });
        return;
    }


    if (opts.extract) {
        const { extractCodebase } = await import('./codebase-extract.js');
        const extractPath = typeof opts.extract === 'string' ? opts.extract : cwd;
        await extractCodebase({
            path: extractPath,
            incremental: opts.incremental,
            json: opts.json,
            project: opts.project,
            maxFiles: opts.maxFiles ? parseInt(opts.maxFiles, 10) : undefined,
        });
        return;
    }

    if (opts.status) {
        await printCodebaseStatus(opts);
        return;
    }

    if (!opts.lint) {
        console.log('teamai codebase — 团队 codebase 文档健康度管理');
        console.log('');
        console.log('用法：');
        console.log('  teamai codebase --extract [path]        提取代码知识 + 构建图谱');
        console.log('  teamai codebase --extract --incremental 增量模式');
        console.log('  teamai codebase --lint                  运行全局一致性检查');
        console.log('  teamai codebase --lint --fix            检查并自动修复低风险问题');
        console.log('  teamai codebase --lint --json           输出 JSON 报告（适合 CI）');
        console.log('  teamai codebase --lint --severity high  只报告 high 级别问题');
        return;
    }

    // 若 teamwiki/ 存在（team-repo 内），优先使用图谱 lint
    const { pathExists } = await import('./utils/fs.js');
    let teamwikiDir: string;
    try {
        const { autoDetectInit } = await import('./config.js');
        const { localConfig: lc } = await autoDetectInit();
        teamwikiDir = path.join(lc.repo.localPath, 'teamwiki');
    } catch {
        teamwikiDir = path.join(cwd, '.teamai', 'team-repo', 'teamwiki');
    }
    if (await pathExists(teamwikiDir)) {
        const { lintTeamwiki, formatWikiLintReport } = await import('./codebase-wiki-lint.js');
        const report = await lintTeamwiki({ wikiRoot: teamwikiDir, severity: opts.severity as 'high' | 'medium' | 'low' | 'info' });
        if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            console.log(formatWikiLintReport(report));
        }
        if (report.summary.high > 0) process.exitCode = 1;
        return;
    }

    const staleDays = opts.staleDays ? (parseInt(opts.staleDays, 10) || 60) : 60;
    const pendingThreshold = opts.pendingReviewThreshold
        ? (parseInt(opts.pendingReviewThreshold, 10) || 10)
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

/**
 * Print the git baseline recorded in teamwiki/source-manifest.json.
 *
 * Reports headSha / repoUrl / branch / lastScan / file count so users can
 * tell which commit the knowledge base corresponds to.
 */
async function printCodebaseStatus(opts: CodebaseCmdOptions): Promise<void> {
    const cwd = process.cwd();
    let teamwikiDir: string;
    if (opts.output) {
        teamwikiDir = path.resolve(opts.output, 'teamwiki');
    } else {
        try {
            const { autoDetectInit } = await import('./config.js');
            const { localConfig: lc } = await autoDetectInit();
            teamwikiDir = path.join(lc.repo.localPath, 'teamwiki');
        } catch {
            teamwikiDir = path.join(cwd, '.teamai', 'team-repo', 'teamwiki');
        }
    }
    const manifestPath = path.join(teamwikiDir, 'source-manifest.json');
    let manifest: {
        headSha?: string;
        repoUrl?: string;
        branch?: string;
        lastScan?: string;
        files?: unknown[];
        ingestedMrs?: Array<{ url: string; headSha?: string; at: string }>;
    };
    try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } catch {
        if (opts.json) {
            console.log(JSON.stringify({ error: 'no-manifest', manifestPath }));
        } else {
            console.log(chalk.yellow(`No source-manifest.json found at ${manifestPath}`));
        }
        process.exitCode = 1;
        return;
    }
    if (opts.json) {
        console.log(JSON.stringify({
            headSha: manifest.headSha ?? null,
            repoUrl: manifest.repoUrl ?? null,
            branch: manifest.branch ?? null,
            lastScan: manifest.lastScan ?? null,
            fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
            ingestedMrs: manifest.ingestedMrs ?? [],
        }, null, 2));
        return;
    }
    console.log(chalk.bold('Knowledge-base baseline'));
    console.log(`  headSha:  ${manifest.headSha ?? chalk.dim('(none)')}`);
    console.log(`  repoUrl:  ${manifest.repoUrl ?? chalk.dim('(none)')}`);
    console.log(`  branch:   ${manifest.branch ?? chalk.dim('(none)')}`);
    console.log(`  lastScan: ${manifest.lastScan ?? chalk.dim('(none)')}`);
    console.log(`  files:    ${Array.isArray(manifest.files) ? manifest.files.length : 0}`);
    const mrs = manifest.ingestedMrs ?? [];
    console.log(`  ingested MRs: ${mrs.length}`);
    for (const mr of mrs) {
        const sha = mr.headSha ? mr.headSha.slice(0, 8) : '(no sha)';
        console.log(`    - ${mr.url}  @${sha}  ${mr.at}`);
    }
}

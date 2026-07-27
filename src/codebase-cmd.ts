import path from 'node:path';
import { readFile } from 'node:fs/promises';

import chalk from 'chalk';

import type { GlobalOptions } from './types.js';
import type { WikiLintSeverity } from './codebase-wiki-lint.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CodebaseCmdOptions extends GlobalOptions {
    lint?: boolean;
    fix?: boolean;
    extract?: boolean | string;
    incremental?: boolean;
    upgradeWiki?: boolean;
    severity?: WikiLintSeverity;
    json?: boolean;
    output?: string;
    project?: string;
    maxFiles?: string;
    status?: boolean;
}

// ─── Command handler ─────────────────────────────────────────────────────────

/**
 * codebase 子命令处理函数。
 *
 * 支持 --lint（teamwiki 一致性检查）、--json（CI 机器可读输出）。
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

    // Resolve teamwiki directory
    const { pathExists } = await import('./utils/fs.js');
    let teamwikiDir: string;
    try {
        const { autoDetectInit } = await import('./config.js');
        const { localConfig: lc } = await autoDetectInit();
        teamwikiDir = path.join(lc.repo.localPath, 'teamwiki');
    } catch {
        teamwikiDir = path.join(cwd, '.teamai', 'team-repo', 'teamwiki');
    }

    if (!(await pathExists(teamwikiDir))) {
        console.log('No teamwiki found. Run `teamai import` first.');
        return;
    }

    if (opts.fix) {
        console.log('teamwiki lint has no autofix; showing report only.');
    }

    const { lintTeamwiki, formatWikiLintReport } = await import('./codebase-wiki-lint.js');
    const report = await lintTeamwiki({ wikiRoot: teamwikiDir, severity: opts.severity });
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatWikiLintReport(report));
    }
    if (report.summary.high > 0) process.exitCode = 1;
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

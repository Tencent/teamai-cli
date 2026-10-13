import path from 'node:path';
import { readFile } from 'node:fs/promises';

import chalk from 'chalk';

import type { GlobalOptions } from './types.js';
import type { WikiLintSeverity } from './codebase-wiki-lint.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CodebaseCmdOptions extends GlobalOptions {
    lint?: boolean;
    fix?: boolean;
    upgradeWiki?: boolean;
    severity?: WikiLintSeverity;
    json?: boolean;
    output?: string;
    project?: string;
    status?: boolean;
    reconcile?: boolean;
    deepEnrich?: boolean;
}

// ─── Command handler ─────────────────────────────────────────────────────────

/**
 * The teamwiki `teamai import` writes: `<output>/teamwiki` with `--output`,
 * else the team repo's. Undefined when there is neither.
 */
async function teamwikiDirFor(opts: CodebaseCmdOptions, readOnly: boolean): Promise<string | undefined> {
    const { resolveTeamwiki } = await import('./utils/teamwiki-root.js');
    try {
        // A read never persists a config migration (#893).
        return (await resolveTeamwiki({ output: opts.output, dryRun: opts.dryRun || readOnly })).wikiRoot;
    } catch {
        return undefined;
    }
}

/**
 * Handler for the `teamai codebase` subcommand.
 */
export async function codebaseCmd(opts: CodebaseCmdOptions): Promise<void> {
    const cwd = process.cwd();

    if (opts.upgradeWiki) {
        const { upgradeCodebaseWiki } = await import('./codebase-upgrade-wiki.js');
        await upgradeCodebaseWiki({ cwd, dryRun: opts.dryRun, json: opts.json });
        return;
    }

    if (opts.status) {
        await printCodebaseStatus(opts);
        return;
    }

    if (!opts.lint && !opts.reconcile && !opts.deepEnrich) {
        console.log('teamai codebase — team codebase knowledge management');
        console.log('');
        console.log('Usage:');
        console.log('  teamai codebase --lint                  Run teamwiki consistency lint');
        console.log('  teamai codebase --lint --json           Output JSON report (for CI)');
        console.log('  teamai codebase --lint --severity high  Only report high-severity issues');
        console.log('  teamai codebase --reconcile             Reconcile product and code knowledge');
        console.log('  teamai codebase --deep-enrich           Generate deep knowledge from extracted evidence');
        console.log('  teamai codebase --status                Show knowledge-base git baseline');
        console.log('');
        console.log('Extract code knowledge with `teamai import --dir <path>` or `teamai import --from-repo <url>`.');
        return;
    }

    // `--lint` alone only reads.
    const { pathExists } = await import('./utils/fs.js');
    const teamwikiDir = await teamwikiDirFor(opts, !opts.reconcile && !opts.deepEnrich);

    if (!teamwikiDir || !(await pathExists(teamwikiDir))) {
        console.log('No teamwiki found. Run `teamai import` first.');
        if (opts.reconcile || opts.deepEnrich) process.exitCode = 1;
        return;
    }

    if (opts.deepEnrich) {
        const project = opts.project?.trim() ?? '';
        if (!project) {
            console.log('Deep enrichment requires --project <slug>.');
            process.exitCode = 1;
            return;
        }
        const { assertWithinRoot } = await import('./utils/path-safety.js');
        const codeRoot = path.join(teamwikiDir, 'evidence', 'code');
        const evidenceDir = path.join(codeRoot, project);
        try {
            assertWithinRoot(codeRoot, evidenceDir);
        } catch (e) {
            console.log((e as Error).message);
            process.exitCode = 1;
            return;
        }
        if (!(await pathExists(evidenceDir))) {
            console.log(`No extracted evidence found for project "${project}". Run \`teamai import\` first.`);
            process.exitCode = 1;
            return;
        }
        let componentCount = 0;
        try {
            const manifest = JSON.parse(await readFile(path.join(evidenceDir, '_manifest.json'), 'utf-8')) as {
                components?: unknown;
            };
            componentCount = Array.isArray(manifest.components) ? manifest.components.length : 0;
        } catch {
            componentCount = 0;
        }
        if (componentCount === 0) {
            console.log(`No components in _manifest.json for project "${project}".`);
            process.exitCode = 1;
            return;
        }
        if (opts.dryRun) {
            if (opts.json) {
                console.log(JSON.stringify({ project, evidenceDir, dryRun: true }, null, 2));
            } else {
                console.log(`Deep enrichment preview: project=${project} (no writes)`);
            }
            return;
        }
        const { deepEnrich } = await import('./deep-enrich.js');
        const result = await deepEnrich({ project, evidenceDir, wikiRoot: teamwikiDir });
        if (opts.json) {
            console.log(JSON.stringify({
                project,
                evidenceDir,
                complete: result.complete,
                missingComponents: result.missingComponents,
                missingArchitecture: result.missingArchitecture,
            }, null, 2));
        } else if (result.complete) {
            console.log(`Deep enrichment complete: project=${project}`);
        } else {
            const parts: string[] = [];
            if (result.missingComponents.length > 0) {
                parts.push(`missing component docs: ${result.missingComponents.join(', ')}`);
            }
            if (result.missingArchitecture) parts.push('missing architecture.md');
            console.log(`Deep enrichment incomplete: project=${project}, ${parts.join(', ')}`);
        }
        if (!result.complete) process.exitCode = 1;
        return;
    }

    if (opts.reconcile) {
        const { reconcileKnowledge } = await import('./wiki-engine/adapters/index.js');
        const result = await reconcileKnowledge({ wikiRoot: teamwikiDir, dryRun: opts.dryRun });
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`Reconciliation complete: mappings=${result.mappings}, gaps=${result.gaps.length}, conflicts=${result.conflicts.length}`);
        }
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
    const teamwikiDir = await teamwikiDirFor(opts, true);
    if (!teamwikiDir) {
        if (opts.json) {
            console.log(JSON.stringify({ error: 'no-teamwiki' }));
        } else {
            console.log(chalk.yellow('No teamwiki found. Run `teamai init` and `teamai import` first, or pass --output.'));
        }
        process.exitCode = 1;
        return;
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

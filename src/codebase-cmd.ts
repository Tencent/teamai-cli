import path from 'node:path';
import { readFile } from 'node:fs/promises';

import chalk from 'chalk';
import { z } from 'zod';

import type { GlobalOptions } from './types.js';
import type { WikiLintSeverity } from './codebase-wiki-lint.js';
import type { TeamwikiTarget } from './utils/teamwiki-root.js';
import type { ShortcutEnd } from './workflow-commands.js';
import { DetachedTeamRepoError } from './utils/git.js';
import { log } from './utils/logger.js';

/** The component list of an evidence `_manifest.json`, which deep enrichment needs at least one of. */
const EvidenceComponentsSchema = z.object({ components: z.array(z.unknown()).optional().catch(undefined) });

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

/** How many components a deep enrichment has in progress at once, the max_parallel of its fan-out. */
const DEEP_ENRICH_CONCURRENCY = 5;

/**
 * Deep-enriches `project` of `target`, as `codebase --deep-enrich` and the hidden `deep-enrich` do, through a
 * teamai-codebase-deep-enrich run, under the import lock of the team repo when one holds the teamwiki, as every command
 * that writes it takes. Another teamwiki needs no teamai init: the run then builds a config of its own.
 */
export async function startDeepEnrich({ target, project, maxModules = 0, publish = false, json, command }: {
    target: TeamwikiTarget;
    project: string;
    maxModules?: number;
    /** Have the run commit and push the docs to the team repo that holds the teamwiki. */
    publish?: boolean;
    json: boolean;
    command: string;
}): Promise<ShortcutEnd | undefined> {
    const { lockTeamwiki } = await import('./utils/teamwiki-root.js');
    const { runShortcut } = await import('./workflow-commands.js');
    const releaseLock = await lockTeamwiki(target);
    const given = { wiki_root: target.wikiRoot, project, max_modules: maxModules, concurrency: DEEP_ENRICH_CONCURRENCY };
    // Only a publishing run passes publish, so a team's own teamai-codebase-deep-enrich need not declare it.
    const inputs = publish ? { ...given, publish } : given;

    try {
        return await runShortcut({
            workflow: 'teamai-codebase-deep-enrich',
            inputs,
            command,
            json,
        });
    } finally {
        await releaseLock();
    }
}

/** The teamwiki the hidden `deep-enrich` writes, `--wiki-root` or else the team repo's, with the team repo when it holds it. */
export async function hiddenDeepEnrichTarget(wikiRoot: string | undefined): Promise<TeamwikiTarget> {
    const { resolveTeamwiki, teamwikiAt } = await import('./utils/teamwiki-root.js');

    return wikiRoot === undefined ? resolveTeamwiki() : teamwikiAt(wikiRoot);
}

// ─── Command handler ─────────────────────────────────────────────────────────

/**
 * The teamwiki `teamai import` writes: `<output>/teamwiki` with `--output`,
 * else the team repo's. Undefined when there is neither.
 */
async function teamwikiTargetFor(opts: CodebaseCmdOptions, readOnly: boolean): Promise<TeamwikiTarget | undefined> {
    const { assertTeamwikiWritable, resolveTeamwiki } = await import('./utils/teamwiki-root.js');

    try {
        // A read never persists a config migration (#893).
        const target = await resolveTeamwiki({ output: opts.output, dryRun: opts.dryRun || readOnly });

        if (!readOnly && !opts.dryRun) await assertTeamwikiWritable(target);

        return target;
    } catch (error) {
        DetachedTeamRepoError.rethrow(error);

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

        try {
            await upgradeCodebaseWiki({ cwd, dryRun: opts.dryRun, json: opts.json });
        } catch (error) {
            if (!(error instanceof DetachedTeamRepoError)) throw error;
            log.error(error.message);
            process.exitCode = 1;
        }

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
        console.log('  teamai codebase --lint                  Run teamwiki consistency lint; also counts the member\'s asset relations (assets, relations, without a relation, unresolved)');
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
    let target: TeamwikiTarget | undefined;

    try {
        target = await teamwikiTargetFor(opts, !opts.reconcile && !opts.deepEnrich);
    } catch (error) {
        if (!(error instanceof DetachedTeamRepoError)) throw error;
        log.error(error.message);
        process.exitCode = 1;

        return;
    }

    if (!target || !(await pathExists(target.wikiRoot))) {
        if (opts.lint) {
            await lintWithoutTeamwiki(opts);

            return;
        }

        console.log('No teamwiki found. Run `teamai import` first.');

        if (opts.reconcile || opts.deepEnrich) process.exitCode = 1;

        return;
    }

    const teamwikiDir = target.wikiRoot;

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
            console.log(e instanceof Error ? e.message : String(e));
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
            const manifest = EvidenceComponentsSchema.parse(JSON.parse(await readFile(path.join(evidenceDir, '_manifest.json'), 'utf-8')));

            componentCount = manifest.components?.length ?? 0;
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

        // In the team repo, the run publishes the docs the way `teamai import` does, so the next `teamai push` does not
        // find the clone dirty.
        await startDeepEnrich({ target, project, publish: target.team !== undefined, json: opts.json === true, command: `teamai codebase --deep-enrich --project ${project}` });

        return;
    }

    if (opts.reconcile) {
        const { reconcileKnowledge } = await import('./wiki-engine/adapters/index.js');
        // In the team repo, write under the import lock and publish the graph as
        // `teamai import` does, so the next `teamai push` does not find the clone dirty.
        // Only the graph: a product page is the member's, and the `teamai pull` a
        // rejected push calls for would drop it with the unpushed commit.
        const team = opts.dryRun ? undefined : target.team;
        const { lockTeamwiki } = await import('./utils/teamwiki-root.js');
        const releaseLock = team ? await lockTeamwiki(target) : async () => {};

        try {
            const result = await reconcileKnowledge({ wikiRoot: teamwikiDir, dryRun: opts.dryRun });

            if (opts.json) {
                console.log(JSON.stringify(result, null, 2));
            } else {
                console.log(`Reconciliation complete: mappings=${result.mappings}, gaps=${result.gaps.length}, conflicts=${result.conflicts.length}`);

                // Proposed relations are printed only here, and only in a dry
                // run: a person copies the ones they accept into the asset's
                // `related:` frontmatter, in an ordinary PR (#1563 part 2).
                // Until merged there, recall never shows a candidate.
                if (opts.dryRun && result.relationCandidates.length > 0) {
                    console.log('');
                    console.log('Relation candidates (copy the ones you accept into the asset\'s related:)');

                    for (const candidate of result.relationCandidates) {
                        console.log(`  ${candidate.from}  ${candidate.relation}  ${candidate.to}   term "${candidate.term}", confidence ${candidate.confidenceScore.toFixed(1)}`);
                    }
                }
            }

            if (team) {
                const { autoPushTeamRepo } = await import('./utils/git.js');

                const pushed = await autoPushTeamRepo(
                    team.localConfig.repo.localPath,
                    '[teamai] Reconcile product and code knowledge',
                    [path.relative(team.localConfig.repo.localPath, path.join(teamwikiDir, '.indices', 'graph-index.json'))],
                );

                if (pushed && !opts.json) log.success(`Pushed to team knowledge repo (${team.localConfig.repo.remote})`);
            }
        } finally {
            await releaseLock();
        }

        return;
    }

    if (opts.fix) {
        console.log('teamwiki lint has no autofix; showing report only.');
    }

    const { lintTeamwiki, formatWikiLintReport } = await import('./codebase-wiki-lint.js');
    // Standalone `--output` names no member, so there is no asset data (#1562).
    const assetGraph = opts.output ? null : await lintAssetGraphForMember();
    const report = await lintTeamwiki({ wikiRoot: teamwikiDir, severity: opts.severity });

    if (assetGraph) report.assetGraph = assetGraph;

    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatWikiLintReport(report));
    }

    if (report.summary.high > 0) process.exitCode = 1;
}

/**
 * `--lint` without a teamwiki: the graph checks are skipped, but the member's
 * asset counts still print (#1562). With standalone `--output` there is no
 * member, so there is no assetGraph and the output is unchanged.
 */
async function lintWithoutTeamwiki(opts: CodebaseCmdOptions): Promise<void> {
    const assetGraph = opts.output ? null : await lintAssetGraphForMember();

    if (!assetGraph) {
        console.log('No teamwiki found. Run `teamai import` first.');

        return;
    }

    if (opts.json) {
        // The full report shape, with the graph checks absent: graphHealth
        // null reads as "not checked", never a measured 0%, and a script
        // reading `.summary` sees the same structure with and without a
        // teamwiki (#1562/#1637 review).
        console.log(JSON.stringify({
            issues: [],
            summary: { total: 0, high: 0, medium: 0, low: 0, info: 0 },
            graphHealth: null,
            assetGraph,
        }, null, 2));
    } else {
        const { formatAssetGraphLine } = await import('./codebase-wiki-lint.js');
        console.log(formatAssetGraphLine(assetGraph));
    }
}

// `--lint` only ever reads: the loaders must preview, not persist, a migration (#850).
async function lintAssetGraphForMember(): Promise<import('./lint-asset-graph.js').LintAssetGraph | null> {
    const { lintAssetGraph } = await import('./lint-asset-graph.js');

    return lintAssetGraph({ dryRun: true }).catch(() => null);
}

/**
 * Print the git baseline recorded in teamwiki/source-manifest.json.
 *
 * Reports headSha / repoUrl / branch / lastScan / file count so users can
 * tell which commit the knowledge base corresponds to.
 */
async function printCodebaseStatus(opts: CodebaseCmdOptions): Promise<void> {
    const teamwikiDir = (await teamwikiTargetFor(opts, true))?.wikiRoot;

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

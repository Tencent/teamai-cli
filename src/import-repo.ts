import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';

import { generateCodebaseMd } from './codebase.js';
import { extractCodebase } from './codebase-extract.js';
import { detectProvider } from './providers/registry.js';
import { shallowClone, shallowFetch } from './clone.js';
import {
    getRepoCacheDir,
    getRepoSlug,
    writeLastSync,
    readLastSync,
    ensureCacheRoot,
} from './utils/repo-cache.js';
import { touchCacheEntry } from './utils/cache-index.js';
import { log } from './utils/logger.js';

// ─── Types ──────────────────────────────────────────────

export interface ImportFromRepoOptions {
    /** Repo URL (https or ssh) */
    url: string;
    /** Shallow clone depth, default 1 */
    depth?: number;
    /** Force SSH clone */
    forceSsh?: boolean;
    /** Force anonymous HTTPS (even when token is available), for whitelist auth='public' */
    forceAnonymous?: boolean;
    /** Skip AI recommendation when --domain is explicitly set */
    explicitDomain?: string;
    /** Dry-run mode: skip writing to disk but still execute clone+scan */
    dryRun?: boolean;
    /** Custom output root directory; defaults to .teamai/team-repo/teamwiki */
    output?: string;
    /**
     * Whether to enable interactive confirmation.
     * Default true (shows AI recommendation and waits for user input in TTY);
     * pass false for batch imports → non-TTY path (assign to uncategorized when confidence is low).
     */
    interactive?: boolean;
    /** Incremental mode: on cache hit do fetch+reset only; on miss fall back to full clone */
    incremental?: boolean;
    /** In batch mode, skip per-repo autoPushTeamRepo (caller handles it collectively) */
    skipAutoPush?: boolean;
    /** Skip AI enrichment (only clone + extract + graph, no LLM calls) */
    skipEnrich?: boolean;
    /** Source MR/PR URL to record as ingested (P5, passed through to extractCodebase). */
    sourceMrUrl?: string;
}

// ─── Cross-Repo Edge Detection ─────────────────────────

interface SimpleGraphNode {
    id?: string; slug?: string;
    kind?: string; type?: string;
    label?: string; title?: string;
    file?: string;
}

interface SimpleGraphIndex {
    nodes: SimpleGraphNode[];
    edges: Array<{ from: string; to: string; relation: string }>;
}

/**
 * Detect cross-repo dependency relationships.
 *
 * By comparing node labels (component names / interface names) across two graphs,
 * when repo A has a node name matching a node name in repo B,
 * it indicates a potential dependency (e.g. shared interfaces, same-name component references).
 *
 * Based on the exportIndex matching approach in team-wiki's buildCodeGraphIndex.
 */
export function detectCrossRepoEdges(
    overlay: SimpleGraphIndex,
    existing: SimpleGraphIndex,
): Array<{ from: string; to: string; relation: 'DEPENDS_ON' }> {
    const crossEdges: Array<{ from: string; to: string; relation: 'DEPENDS_ON' }> = [];
    const edgeSet = new Set<string>();

    const nodeId = (n: SimpleGraphNode): string => n.id ?? n.slug ?? '';
    const nodeLabel = (n: SimpleGraphNode): string => n.label ?? n.title ?? '';
    const nodeKind = (n: SimpleGraphNode): string => n.kind ?? n.type ?? '';

    // Build label index for the existing graph's components/interfaces
    const existingIndex = new Map<string, string>();
    for (const node of existing.nodes) {
        const label = nodeLabel(node);
        if (label) existingIndex.set(label.toLowerCase(), nodeId(node));
    }

    // Build label index for the new graph's components/interfaces
    const overlayIndex = new Map<string, string>();
    for (const node of overlay.nodes) {
        const label = nodeLabel(node);
        if (label) overlayIndex.set(label.toLowerCase(), nodeId(node));
    }

    // Check if import edge targets in the new repo match component names in the existing repo
    for (const edge of overlay.edges) {
        if (edge.relation !== 'imports') continue;
        const segments = edge.to.split('/');
        const fileName = segments[segments.length - 1]?.replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '') ?? '';
        const pascalName = fileName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

        const match = existingIndex.get(pascalName.toLowerCase());
        if (match) {
            const fromNode = overlay.nodes.find(n => (n.file ?? n.id ?? n.slug ?? '') === edge.from);
            if (fromNode) {
                const fromId = nodeId(fromNode);
                const key = `${fromId}|${match}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    crossEdges.push({ from: fromId, to: match, relation: 'DEPENDS_ON' });
                }
            }
        }
    }

    // Reverse: check if import edges in the existing graph target components in the new repo
    for (const edge of existing.edges) {
        if (edge.relation !== 'imports') continue;
        const segments = edge.to.split('/');
        const fileName = segments[segments.length - 1]?.replace(/\.(ts|tsx|js|jsx|py|go|rs|java)$/, '') ?? '';
        const pascalName = fileName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

        const match = overlayIndex.get(pascalName.toLowerCase());
        if (match) {
            const fromNode = existing.nodes.find(n => (n.file ?? n.id ?? n.slug ?? '') === edge.from);
            if (fromNode) {
                const fromId = nodeId(fromNode);
                const key = `${fromId}|${match}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    crossEdges.push({ from: fromId, to: match, relation: 'DEPENDS_ON' });
                }
            }
        }
    }

    // Config repo association: config/data node label fully matches a component/interface label in the other repo
    const overlayConfigs = overlay.nodes.filter(n => nodeKind(n) === 'config' || nodeKind(n) === 'data');
    const existingConfigs = existing.nodes.filter(n => nodeKind(n) === 'config' || nodeKind(n) === 'data');

    for (const cfg of overlayConfigs) {
        const cfgName = nodeLabel(cfg).toLowerCase();
        if (cfgName.length < 5) continue;
        const cfgId = nodeId(cfg);
        const match = existingIndex.get(cfgName);
        if (match) {
            const key = `${match}|${cfgId}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                crossEdges.push({ from: match, to: cfgId, relation: 'DEPENDS_ON' });
            }
        }
    }

    for (const cfg of existingConfigs) {
        const cfgName = nodeLabel(cfg).toLowerCase();
        if (cfgName.length < 5) continue;
        const cfgId = nodeId(cfg);
        const match = overlayIndex.get(cfgName);
        if (match) {
            const key = `${match}|${cfgId}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                crossEdges.push({ from: match, to: cfgId, relation: 'DEPENDS_ON' });
            }
        }
    }

    return crossEdges;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Main entry point for `teamai import --from-repo <url>`.
 *
 * Flow:
 *  1. Parse url → provider + RepoInfo (owner/repo)
 *  2. Shallow clone (or incremental fetch+reset) to ~/.teamai/cache/repos/<provider>/<owner>/<repo>
 *  3. generateCodebaseMd({ repoPath: cacheDir }) → AI narrative
 *  4. extractCodebase → teamwiki evidence artifacts (deterministic overview + graph)
 *  5. Append AI narrative to teamwiki/evidence/code/<slug>/overview.md
 *  6. Write LAST_SYNC
 *
 * @throws Error on clone failure, scan failure, or IO failure
 */
export async function importFromRepo(opts: ImportFromRepoOptions): Promise<void> {
    const {
        url, depth = 1, forceSsh = false, forceAnonymous = false,
        explicitDomain, dryRun = false, output, interactive = true,
        incremental = false, skipAutoPush = false, skipEnrich = false, sourceMrUrl,
    } = opts;

    // 1. Parse provider and repo info
    const providerName = detectProvider(url);
    if (!providerName) {
        throw new Error(`Unsupported repo URL: ${url}`);
    }

    // Extract owner and repo name from url
    // Supports https://github.com/owner/repo[.git] and git@github.com:owner/repo[.git]
    let owner: string;
    let repoName: string;
    const httpsMatch = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
    const sshMatch = url.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) {
        owner = httpsMatch[1];
        repoName = httpsMatch[2];
    } else if (sshMatch) {
        owner = sshMatch[1];
        repoName = sshMatch[2];
    } else {
        throw new Error(`Unsupported repo URL: ${url}`);
    }

    log.info(`Importing remote repo: ${owner}/${repoName} (provider: ${providerName})`);

    // 2. Shallow clone or incremental fetch+reset
    await ensureCacheRoot();
    const cacheDir = getRepoCacheDir(providerName, owner, repoName);
    const slug = getRepoSlug(providerName, owner, repoName);

    const lastSync = await readLastSync(cacheDir);
    const cacheExists = await fs.pathExists(path.join(cacheDir, '.git'));
    const useIncremental = incremental && cacheExists && lastSync !== null;

    let cloneSha: string;
    let cloneBranch: string;
    let oldSha: string | null = null;

    if (useIncremental) {
        oldSha = lastSync.sha;
        log.info(`[incremental] cache hit ${cacheDir}, syncing from ${oldSha.slice(0, 8)}`);
        try {
            const fetchResult = await shallowFetch(cacheDir);
            cloneSha = fetchResult.sha;
            cloneBranch = 'HEAD';
            log.info(`[incremental] Fetch complete: SHA=${cloneSha.slice(0, 8)}`);
        } catch (fetchErr) {
            log.warn(
                `[incremental] fetch failed, falling back to full clone: ` +
                `${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
            );
            try {
                const cloneResult = await shallowClone(url, cacheDir, providerName, {
                    depth, forceSsh, forceAnonymous,
                });
                cloneSha = cloneResult.sha;
                cloneBranch = cloneResult.branch;
                oldSha = null; // treat as full clone on fallback, skip drift detection
            } catch (err) {
                throw new Error(`Clone failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    } else {
        log.info(`Shallow clone to cache: ${cacheDir}`);
        try {
            const cloneResult = await shallowClone(url, cacheDir, providerName, {
                depth, forceSsh, forceAnonymous,
            });
            cloneSha = cloneResult.sha;
            cloneBranch = cloneResult.branch;
        } catch (err) {
            // shallowClone cleans up the directory internally
            throw new Error(`Clone failed (${url}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    log.info(`Clone/Fetch complete: SHA=${cloneSha.slice(0, 8)}, branch=${cloneBranch}`);

    // 2.5 Skip AI scan if SHA unchanged (incremental fast path)
    if (useIncremental && oldSha && cloneSha === oldSha) {
        log.info(`[incremental] SHA unchanged (${cloneSha.slice(0, 8)}), skipping AI scan`);
        await writeLastSync(cacheDir, cloneSha);
        try {
            await touchCacheEntry({ provider: providerName, owner, repo: repoName, lastSyncedSha: cloneSha });
        } catch {}
        log.info(chalk.green(`✓ repo ${owner}/${repoName} unchanged, skipped`));
        return;
    }

    // 3. Scan and generate codebase.md (AI scan failure does not block graph extraction)
    log.info(`Scanning repository...`);
    let codebaseMd: string | undefined;
    if (skipEnrich) {
        log.debug('AI enrichment skipped (--skip-enrich)');
    } else {
        try {
            codebaseMd = await generateCodebaseMd({ repoPath: cacheDir });
        } catch (err) {
            log.warn(`AI codebase scan failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Resolve team-repo directory (needed for teamwiki evidence output)
    let teamRepoDir: string;
    let teamRepoRemote = '';
    let mrTeamConfig: { repo: string; provider?: string; reviewers?: string[] } | null = null;
    let mrLocalConfig: { repo: { remote: string; localPath: string }; username: string } | null = null;
    try {
        const { autoDetectInit } = await import('./config.js');
        const { localConfig: lc, teamConfig: tc } = await autoDetectInit();
        teamRepoDir = lc.repo.localPath;
        teamRepoRemote = lc.repo.remote;
        mrTeamConfig = { repo: tc.repo, provider: tc.provider, reviewers: tc.reviewers };
        mrLocalConfig = { repo: lc.repo, username: lc.username };
    } catch {
        teamRepoDir = path.join(process.cwd(), '.teamai', 'team-repo');
    }

    // 4. Generate teamwiki/ knowledge graph artifacts + append AI narrative to overview.md
    const teamwikiRoot = output
        ? path.resolve(output, '..', 'teamwiki')
        : path.join(teamRepoDir, 'teamwiki');
    if (!dryRun) {
        const cacheWiki = path.join(cacheDir, 'teamwiki');
        try {
            // Incremental mode: copy existing cache files to cacheDir for extractCodebase to read
            if (incremental) {
                const destIndices = path.join(teamwikiRoot, '.indices');
                const cacheIndices = path.join(cacheDir, 'teamwiki', '.indices');
                await fs.ensureDir(cacheIndices);
                for (const f of ['facts-cache.json', 'interfaces-cache.json']) {
                    const src = path.join(destIndices, f);
                    if (await fs.pathExists(src)) {
                        await fs.copy(src, path.join(cacheIndices, f));
                    }
                }
                const existingManifest = path.join(teamwikiRoot, 'source-manifest.json');
                if (await fs.pathExists(existingManifest)) {
                    await fs.copy(existingManifest, path.join(cacheDir, 'teamwiki', 'source-manifest.json'));
                }
            }
            await extractCodebase({
                path: cacheDir, project: slug, json: false, skipEnrich, incremental,
                repoUrl: url,
                branch: cloneBranch === 'HEAD' ? undefined : cloneBranch,
                sourceMrUrl,
            });
            // Move artifacts from cacheDir/teamwiki/ to target teamwikiRoot
            if (await fs.pathExists(cacheWiki)) {
                const evidenceSrc = path.join(cacheWiki, 'evidence', 'code', slug);
                const evidenceDest = path.join(teamwikiRoot, 'evidence', 'code', slug);
                // Clear old evidence first (keep .indices/ subdir) to remove stale pages
                if (await fs.pathExists(evidenceDest)) {
                    const entries = await fs.readdir(evidenceDest);
                    for (const entry of entries) {
                        if (entry === '.indices') continue;
                        await fs.remove(path.join(evidenceDest, entry));
                    }
                }
                await fs.ensureDir(evidenceDest);
                await fs.copy(evidenceSrc, evidenceDest, { overwrite: true });
                // Write AI narrative to overview.md (idempotent: replace if exists, append if not)
                if (codebaseMd) {
                    const overviewPath = path.join(evidenceDest, 'overview.md');
                    const existing = await fs.readFile(overviewPath, 'utf8').catch(() => '');
                    const aiNarrative = codebaseMd.replace(/^---[\s\S]*?---\n*/m, '');
                    const marker = '## AI Architecture Narrative';
                    const oldMarker = '## AI 架构叙事';
                    let markerIdx = existing.indexOf(marker);
                    if (markerIdx < 0) markerIdx = existing.indexOf(oldMarker);
                    const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
                    let combined: string;
                    if (!base || !base.startsWith('---')) {
                        combined = `---\ntitle: ${slug} overview\ndomain: code-knowledge\n---\n\n${marker}\n\n${aiNarrative}`;
                    } else {
                        combined = base + '\n\n---\n\n' + marker + '\n\n' + aiNarrative;
                    }
                    await fs.writeFile(overviewPath, combined, 'utf8');
                }
                // Per-repo graph: copy to evidence/<slug>/.indices/ (no global merge here — done in batch)
                const srcGraph = path.join(cacheWiki, '.indices', 'graph-index.json');
                if (await fs.pathExists(srcGraph)) {
                    const evidenceGraphDir = path.join(teamwikiRoot, 'evidence', 'code', slug, '.indices');
                    await fs.ensureDir(evidenceGraphDir);
                    await fs.copy(srcGraph, path.join(evidenceGraphDir, 'graph-index.json'));
                } else {
                    log.debug(`[graph] per-repo graph-index.json not found, skipping copy`);
                }
                // Persist incremental cache files to teamwikiRoot (for future incremental use)
                const cacheIndices = path.join(cacheWiki, '.indices');
                const destIndices = path.join(teamwikiRoot, '.indices');
                for (const cacheFile of ['facts-cache.json', 'interfaces-cache.json']) {
                    const src = path.join(cacheIndices, cacheFile);
                    if (await fs.pathExists(src)) {
                        await fs.ensureDir(destIndices);
                        await fs.copy(src, path.join(destIndices, cacheFile), { overwrite: true });
                    }
                }
                const srcManifest = path.join(cacheWiki, 'source-manifest.json');
                if (await fs.pathExists(srcManifest)) {
                    await fs.copy(srcManifest, path.join(teamwikiRoot, 'source-manifest.json'), { overwrite: true });
                }
                await fs.remove(cacheWiki);
            }
            // Explicit --domain overrides AI inference
            if (explicitDomain) {
                const domainsJsonPath = path.join(teamwikiRoot, 'evidence', 'code', slug, '_domains.json');
                if (await fs.pathExists(domainsJsonPath)) {
                    try {
                        const existing = JSON.parse(await fs.readFile(domainsJsonPath, 'utf8'));
                        existing.domain = explicitDomain;
                        await fs.writeFile(domainsJsonPath, JSON.stringify(existing, null, 2), 'utf8');
                    } catch { /* skip */ }
                } else {
                    await fs.writeFile(domainsJsonPath, JSON.stringify({ domain: explicitDomain }, null, 2), 'utf8');
                }
            }
            // Update top-level router.md and index.md (append new project, do not overwrite)
            const { routerTemplate, indexTemplate, HOT_TEMPLATE } = await import('./wiki-engine/adapters/templates.js');
            const routerPath = path.join(teamwikiRoot, 'router.md');
            const indexPath = path.join(teamwikiRoot, 'index.md');
            const projectLink = `[[evidence/code/${slug}/index]]`;
            if (await fs.pathExists(routerPath)) {
                const router = await fs.readFile(routerPath, 'utf8');
                if (!router.includes(projectLink)) {
                    const line = `- ${projectLink} — ${slug} code knowledge\n`;
                    await fs.writeFile(routerPath, router.trimEnd() + '\n' + line, 'utf8');
                }
            } else {
                await fs.writeFile(routerPath, routerTemplate([{ slug, label: slug }]), 'utf8');
            }
            if (await fs.pathExists(indexPath)) {
                const idx = await fs.readFile(indexPath, 'utf8');
                if (!idx.includes(slug)) {
                    const insertPoint = idx.indexOf('## Navigation');
                    if (insertPoint > 0) {
                        const entry = `- [${slug}](./evidence/code/${slug}/index.md) — code knowledge graph\n\n`;
                        await fs.writeFile(indexPath, idx.slice(0, insertPoint) + entry + idx.slice(insertPoint), 'utf8');
                    }
                }
            } else {
                await fs.writeFile(indexPath, indexTemplate([{ slug, label: slug }]), 'utf8');
            }
            if (!await fs.pathExists(path.join(teamwikiRoot, 'hot.md'))) {
                await fs.writeFile(path.join(teamwikiRoot, 'hot.md'), HOT_TEMPLATE, 'utf8');
            }

            log.info(chalk.green(`✓ teamwiki/ knowledge graph updated: ${slug}`));
        } catch (err) {
            log.debug(`[wiki-engine] Graph generation failed (non-blocking): ${err instanceof Error ? err.message : err}`);
        } finally {
            await fs.remove(cacheWiki).catch(() => {});
        }
    }

    // 4c. Reconcile product docs ↔ code knowledge (if product docs exist)
    if (!dryRun && teamwikiRoot) {
        try {
            const { reconcileKnowledge } = await import('./wiki-engine/adapters/index.js');
            const result = await reconcileKnowledge({ wikiRoot: teamwikiRoot, dryRun: false });
            if (result.mappings > 0 || result.gaps.length > 0) {
                log.info(`  reconcile: ${result.mappings} mappings, ${result.gaps.length} gaps, ${result.graphEdges.length} MAPS_TO edges`);
            }
        } catch (e) {
            log.debug(`reconcile skipped: ${(e as Error).message}`);
        }
    }

    // 5. Deep enrich (synchronous, before push — so all content goes into one MR)
    if (!dryRun && !skipEnrich && teamwikiRoot) {
        const evidenceDir = path.join(teamwikiRoot, 'evidence', 'code', slug);
        if (await fs.pathExists(path.join(evidenceDir, '_manifest.json'))) {
            try {
                const { deepEnrich } = await import('./deep-enrich.js');
                await deepEnrich({ project: slug, evidenceDir, wikiRoot: teamwikiRoot, cacheDir });
                log.info(chalk.green(`✓ Deep enrich complete: ${slug}`));
            } catch (e) {
                log.debug(`deep-enrich failed for ${slug} (non-blocking): ${(e as Error).message}`);
            }
        }
    }

    // 6. Aggregate global graph + create MR (single-repo mode; batch mode handled by import-repo-list)
    if (!dryRun && !skipAutoPush) {
        if (teamwikiRoot) {
            try {
                const { aggregateGlobalGraph } = await import('./graph-aggregate.js');
                await aggregateGlobalGraph(teamwikiRoot);
            } catch (e) {
                log.debug(`[graph] Single-repo aggregation skipped: ${(e as Error).message}`);
            }
        }
        if (await fs.pathExists(teamRepoDir) && mrTeamConfig && mrLocalConfig) {
            const { autoPushViaMR } = await import('./utils/git.js');
            const prUrl = await autoPushViaMR(
                teamRepoDir,
                `[teamai] Import codebase knowledge from ${owner}/${repoName}`,
                ['.'],
                mrTeamConfig,
                mrLocalConfig,
            );
            if (prUrl) {
                log.success(`MR created: ${prUrl}`);
            } else {
                log.success(`Branch pushed to team knowledge repo${teamRepoRemote ? ` (${teamRepoRemote})` : ''}`);
            }
        }
    }

    log.info(chalk.green(`✓ Repo ${owner}/${repoName} import complete`));


    // 7. Write LAST_SYNC
    if (!dryRun) {
        await writeLastSync(cacheDir, cloneSha);
        try {
            await touchCacheEntry({ provider: providerName, owner, repo: repoName, lastSyncedSha: cloneSha });
        } catch (touchErr) {
            log.debug(`[cache-index] touchCacheEntry failed: ${String(touchErr)}`);
        }
    }
}

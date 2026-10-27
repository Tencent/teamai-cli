import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';

import { generateCodebaseMd } from './codebase.js';
import { importCodebase, publishTeamwikiViaMR, reconcileAndDeepEnrich, refreshTeamwikiIndexes } from './import-codebase.js';
import { detectProvider, getProvider } from './providers/registry.js';
import { remoteHeadSha, shallowClone, shallowFetch } from './clone.js';
import {
    getRepoCacheDir,
    getRepoSlug,
    writeLastSync,
    readLastSync,
    ensureCacheRoot,
} from './utils/repo-cache.js';
import { touchCacheEntry } from './utils/cache-index.js';
import { log } from './utils/logger.js';
import { hasFrontmatter, stripFrontmatter } from './utils/frontmatter.js';
import { assertTeamwikiWritable, lockTeamwiki, resolveTeamwiki } from './utils/teamwiki-root.js';
import { isOverrideInvalid } from './tool-launch/call.js';

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
    /** Dry-run mode: read the remote head with ls-remote and stop before the clone, the lock and the LLM scan */
    dryRun?: boolean;
    /** Write into <output>/teamwiki instead of the team repo's teamwiki/ (no push) */
    output?: string;
    /** Incremental mode: on cache hit do fetch+reset only; on miss fall back to full clone */
    incremental?: boolean;
    /** In batch mode, skip per-repo autoPushTeamRepo (caller handles it collectively) */
    skipAutoPush?: boolean;
    /** Skip AI enrichment (only clone + extract + graph, no LLM calls) */
    skipEnrich?: boolean;
    /** Cap on source files collected for this repo (default 200) */
    maxFiles?: number;
    /** Source MR/PR URL to record as ingested in source-manifest.json (P5). */
    sourceMrUrl?: string | readonly string[];
}

// ─── Cross-Repo Edge Detection ─────────────────────────

interface SimpleGraphNode {
    id?: string; slug?: string;
    kind?: string; type?: string;
    label?: string; title?: string;
    file?: string;
    origin?: string;
}

interface SimpleGraphIndex {
    nodes: SimpleGraphNode[];
    edges: Array<{ from: string; to: string; relation: string; origin?: string }>;
}

interface LabelMatch {
    id: string;
    origin?: string;
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
): Array<{ from: string; to: string; relation: 'DEPENDS_ON'; crossOriginPairs?: string[][] }> {
    const crossEdges: Array<{ from: string; to: string; relation: 'DEPENDS_ON'; crossOriginPairs?: string[][] }> = [];
    const edgeSet = new Set<string>();

    const nodeId = (n: SimpleGraphNode): string => n.id ?? n.slug ?? '';
    const nodeLabel = (n: SimpleGraphNode): string => n.label ?? n.title ?? '';
    const nodeKind = (n: SimpleGraphNode): string => n.kind ?? n.type ?? '';
    // Both sides this edge spans matter: the side whose own import produced
    // the match, AND the side that match resolved to. Either one being
    // withheld later makes the relationship stale, so both are captured now
    // as a single pair — a slug collision after this can still reattribute
    // either endpoint node's CURRENT origin, but never this edge's own
    // record of what it depended on at the moment it was detected. Wrapped
    // in an outer array since `mergeGraphs` unions pairs from independent
    // detections rather than letting one overwrite another (#974 review
    // round 15 P2) — see `GraphEdge.crossOriginPairs`.
    const crossOriginPair = (a?: string, b?: string): string[][] | undefined => {
        const origins = [a, b].filter((o): o is string => !!o);
        return origins.length > 0 ? [origins] : undefined;
    };

    // Build label index for the existing graph's components/interfaces. Each
    // entry's `origin` is the matched node's AT THIS MOMENT — the only time
    // it's unambiguous, since a later-aggregated repo can still mint a
    // colliding unqualified slug and win the merge, silently reattributing
    // the final node without updating an edge created from this match.
    const existingIndex = new Map<string, LabelMatch>();
    for (const node of existing.nodes) {
        const label = nodeLabel(node);
        if (label) existingIndex.set(label.toLowerCase(), { id: nodeId(node), origin: node.origin });
    }

    // Build label index for the new graph's components/interfaces
    const overlayIndex = new Map<string, LabelMatch>();
    for (const node of overlay.nodes) {
        const label = nodeLabel(node);
        if (label) overlayIndex.set(label.toLowerCase(), { id: nodeId(node), origin: node.origin });
    }

    // Check if import edge targets in the new repo match component names in the existing repo
    for (const edge of overlay.edges) {
        if (edge.relation !== 'imports') continue;
        const segments = edge.to.split('/');
        const fileName = segments[segments.length - 1]?.replace(/\.(ts|tsx|js|jsx|py|go|rs|java|swift|scala)$/, '') ?? '';
        const pascalName = fileName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

        const match = existingIndex.get(pascalName.toLowerCase());
        if (match) {
            const fromNode = overlay.nodes.find(n => (n.file ?? n.id ?? n.slug ?? '') === edge.from);
            if (fromNode) {
                const fromId = nodeId(fromNode);
                const key = `${fromId}|${match.id}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    // The import edge's OWN origin tag, not a fresh lookup of
                    // whichever node currently sits at `edge.from`'s slug: a
                    // node collision that happens AFTER this edge was tagged
                    // (in a later-processed repo) can silently swap that
                    // node out without ever touching this edge's own tag
                    // (#974 review round 14 P1).
                    crossEdges.push({ from: fromId, to: match.id, relation: 'DEPENDS_ON', crossOriginPairs: crossOriginPair(edge.origin ?? fromNode.origin, match.origin) });
                }
            }
        }
    }

    // Reverse: check if import edges in the existing graph target components in the new repo
    for (const edge of existing.edges) {
        if (edge.relation !== 'imports') continue;
        const segments = edge.to.split('/');
        const fileName = segments[segments.length - 1]?.replace(/\.(ts|tsx|js|jsx|py|go|rs|java|swift|scala)$/, '') ?? '';
        const pascalName = fileName.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');

        const match = overlayIndex.get(pascalName.toLowerCase());
        if (match) {
            const fromNode = existing.nodes.find(n => (n.file ?? n.id ?? n.slug ?? '') === edge.from);
            if (fromNode) {
                const fromId = nodeId(fromNode);
                const key = `${fromId}|${match.id}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    // Same reasoning as the forward loop above: `existing`
                    // accumulates every repo processed so far, so the node
                    // currently at `edge.from`'s slug may already belong to
                    // a DIFFERENT, later-colliding repo than the one whose
                    // `imports` edge this actually is. `edge.origin` was
                    // stamped once, at that edge's own tagging time, and is
                    // immune to any node collision that happens afterward.
                    crossEdges.push({ from: fromId, to: match.id, relation: 'DEPENDS_ON', crossOriginPairs: crossOriginPair(edge.origin ?? fromNode.origin, match.origin) });
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
            const key = `${match.id}|${cfgId}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                crossEdges.push({ from: match.id, to: cfgId, relation: 'DEPENDS_ON', crossOriginPairs: crossOriginPair(match.origin, cfg.origin) });
            }
        }
    }

    for (const cfg of existingConfigs) {
        const cfgName = nodeLabel(cfg).toLowerCase();
        if (cfgName.length < 5) continue;
        const cfgId = nodeId(cfg);
        const match = overlayIndex.get(cfgName);
        if (match) {
            const key = `${match.id}|${cfgId}`;
            if (!edgeSet.has(key)) {
                edgeSet.add(key);
                crossEdges.push({ from: match.id, to: cfgId, relation: 'DEPENDS_ON', crossOriginPairs: crossOriginPair(match.origin, cfg.origin) });
            }
        }
    }

    return crossEdges;
}

// ─── Public API ─────────────────────────────────────────

/**
 * The evidence slug of a remote repo, `<provider>__<owner>__<repo>`: what
 * `--from-repo`, `--from-mr` and `teamai ci extract-mr` all name
 * `teamwiki/evidence/code/<slug>/`, so they update the same codebase.
 *
 * @throws Error when the URL names no supported provider
 */
export function repoSlugForUrl(url: string): string {
    const providerName = detectProvider(url);
    if (!providerName) throw new Error(`Unsupported repo URL: ${url}`);
    const { owner, repo } = getProvider(providerName).parseRepoInput(url);
    return getRepoSlug(providerName, owner, repo);
}

/**
 * Main entry point for `teamai import --from-repo <url>`.
 *
 * Flow:
 *  1. Parse url → provider + RepoInfo (owner/repo)
 *  2. Shallow clone (or incremental fetch+reset) to ~/.teamai/cache/repos/<provider>/<owner>/<repo>
 *  3. generateCodebaseMd({ repoPath: cacheDir }) → AI narrative
 *  4. importCodebase → teamwiki/evidence/code/<slug>/ (deterministic overview + graph),
 *     in <output>/teamwiki or the team repo's teamwiki/
 *  5. Append AI narrative to teamwiki/evidence/code/<slug>/overview.md
 *  6. Write LAST_SYNC
 *
 * A dry run stops after step 1: it reads the target remote commit with `git ls-remote`
 * and reports whether the cache is current.
 *
 * @throws Error on clone failure, scan failure, or IO failure
 */
export async function importFromRepo(opts: ImportFromRepoOptions): Promise<void> {
    const {
        url, depth = 1, forceSsh = false, forceAnonymous = false,
        explicitDomain, dryRun = false, output,
        incremental = false, skipAutoPush = false, skipEnrich = false, maxFiles, sourceMrUrl,
    } = opts;

    // 1. Parse provider and repo info
    const providerName = detectProvider(url);
    if (!providerName) {
        throw new Error(`Unsupported repo URL: ${url}`);
    }

    const repoInfo = getProvider(providerName).parseRepoInput(url);
    const owner = repoInfo.owner;
    const repoName = repoInfo.repo;

    log.info(`Importing remote repo: ${owner}/${repoName} (provider: ${providerName})`);

    // 2. Shallow clone or incremental fetch+reset
    const cacheDir = getRepoCacheDir(providerName, owner, repoName);
    const slug = getRepoSlug(providerName, owner, repoName);

    const lastSync = await readLastSync(cacheDir);
    const cacheExists = await fs.pathExists(path.join(cacheDir, '.git'));
    const useIncremental = incremental && cacheExists && lastSync !== null;

    // Where the evidence goes: <output>/teamwiki, else the team repo's teamwiki/.
    // Resolved before the clone so a missing team repo fails fast; a preview
    // without one still reports what it can.
    const target = await resolveTeamwiki({ output, dryRun }).catch((error: unknown) => {
        if (!dryRun) throw error;
        return undefined;
    });
    if (!dryRun) await assertTeamwikiWritable(target);
    const evidenceDest = target ? path.join(target.wikiRoot, 'evidence', 'code', slug) : undefined;
    // LAST_SYNC belongs to the shared clone cache: an unchanged cache is skipped
    // only when this teamwiki already holds that commit, not when another
    // --output or team repo was imported at it.
    const publishedHead = async (): Promise<string | undefined> => evidenceDest
        ? ((await fs.readJson(path.join(evidenceDest, 'source-manifest.json')).catch(() => null)) as { headSha?: string } | null)?.headSha
        : undefined;

    // A preview asks for the target remote commit and stops: the clone replaces the
    // cache (or fetches and resets it), and the lock and LLM scan follow (#900).
    if (dryRun) {
        let head: string;
        let previewIncremental = useIncremental;
        try {
            head = await remoteHeadSha(url, providerName, {
                forceSsh, forceAnonymous, cachedRepoPath: useIncremental ? cacheDir : undefined,
            });
        } catch (error) {
            if (!useIncremental) throw error;
            log.warn(`[incremental] preview refresh failed, previewing a full clone instead: ${(error as Error).message}`);
            head = await remoteHeadSha(url, providerName, { forceSsh, forceAnonymous });
            previewIncremental = false;
        }
        const skips = previewIncremental && (await publishedHead()) === head;
        const cache = !cacheExists
            ? `not cached yet, a real run would clone it into ${cacheDir}`
            : lastSync?.sha === head
                ? `cache is current at ${head.slice(0, 8)}${skips ? ', so an incremental run would skip it' : ''}`
                : `cache would be refreshed from ${lastSync ? lastSync.sha.slice(0, 8) : 'an unrecorded commit'} to ${head.slice(0, 8)}`;
        log.info(`[dry-run] Would import ${owner}/${repoName} at ${head.slice(0, 8)} into ${evidenceDest ?? path.join('teamwiki', 'evidence', 'code', slug)}; ${cache}`);
        return;
    }
    if (!target || !evidenceDest) throw new Error('unreachable: the teamwiki resolves outside a dry run');
    const { wikiRoot: teamwikiRoot, team } = target;

    await ensureCacheRoot();

    let cloneSha: string;
    let cloneBranch: string;
    let oldSha: string | null = null;

    if (useIncremental) {
        oldSha = lastSync.sha;
        log.info(`[incremental] cache hit ${cacheDir}, syncing from ${oldSha.slice(0, 8)}`);
        try {
            const fetchResult = await shallowFetch(cacheDir, { provider: providerName });
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

    // 2.5 Skip the AI scan if the cache did not move and the target teamwiki
    // already holds this commit (incremental fast path).
    if (useIncremental && oldSha && cloneSha === oldSha && (await publishedHead()) === cloneSha) {
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
            if (isOverrideInvalid(err)) throw err;
            log.warn(`AI codebase scan failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const releaseImportLock = await lockTeamwiki(target);
    try {
    // 4. Extract into teamwiki/evidence/code/<slug>/ + append AI narrative to overview.md
    let updated: boolean;
    try {
        updated = await importCodebase({
            sourceDir: cacheDir, slug, wikiRoot: teamwikiRoot, incremental, skipEnrich, maxFiles,
            repoUrl: url,
            branch: cloneBranch === 'HEAD' ? undefined : cloneBranch,
            sourceMrUrl,
        });
        // Write AI narrative to overview.md (idempotent: replace if exists, append if not)
        if (updated && codebaseMd) {
            const overviewPath = path.join(evidenceDest, 'overview.md');
            const existing = await fs.readFile(overviewPath, 'utf8').catch(() => '');
            const aiNarrative = stripFrontmatter(codebaseMd);
            const marker = '## AI Architecture Narrative';
            const oldMarker = '## AI 架构叙事';
            let markerIdx = existing.indexOf(marker);
            if (markerIdx < 0) markerIdx = existing.indexOf(oldMarker);
            const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();
            let combined: string;
            if (!base || !hasFrontmatter(base)) {
                combined = `---\ntitle: ${slug} overview\ndomain: code-knowledge\n---\n\n${marker}\n\n${aiNarrative}`;
            } else {
                combined = base + '\n\n---\n\n' + marker + '\n\n' + aiNarrative;
            }
            await fs.writeFile(overviewPath, combined, 'utf8');
        }
        // Explicit --domain overrides AI inference
        if (updated && explicitDomain) {
            const domainsJsonPath = path.join(evidenceDest, '_domains.json');
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
        log.info(chalk.green(updated
            ? `✓ teamwiki/ knowledge graph updated: ${slug}`
            : `✓ ${slug}: no source changes since the last import, teamwiki unchanged`));
    } catch (err) {
        throw new Error(`Knowledge extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (updated) {
        // 5. Reconcile + deep enrich (synchronous, before push — so all content goes into one MR)
        await reconcileAndDeepEnrich({ slug, wikiRoot: teamwikiRoot, sourceDir: cacheDir, skipEnrich });

        // 6. Aggregate global graph + create MR (single-repo mode; batch mode handled by import-repo-list)
        if (!skipAutoPush) {
            await refreshTeamwikiIndexes(teamwikiRoot);
            if (team) await publishTeamwikiViaMR(team, `[teamai] Import codebase knowledge from ${owner}/${repoName}`);
        }
    }

    log.info(chalk.green(`✓ Repo ${owner}/${repoName} import complete`));

    // 7. Write LAST_SYNC
    await writeLastSync(cacheDir, cloneSha);
    try {
        await touchCacheEntry({ provider: providerName, owner, repo: repoName, lastSyncedSha: cloneSha });
    } catch (touchErr) {
        log.debug(`[cache-index] touchCacheEntry failed: ${String(touchErr)}`);
    }
    } finally {
        await releaseImportLock();
    }
}

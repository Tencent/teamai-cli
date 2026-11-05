import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';

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
import { resolveTeamwiki } from './utils/teamwiki-root.js';
import { SourceManifestSchema } from './wiki-engine/code-knowledge/code-collector.js';
import { JsonObjectSchema } from './types.js';

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

/** A remote repository an import reads: where it is hosted, its clone cache, and its evidence slug. */
export interface RepoSource {
    url: string;
    providerName: string;
    owner: string;
    repo: string;
    cacheDir: string;
    slug: string;
}

/**
 * The repository `url` names.
 *
 * @throws Error when the URL names no supported provider, or a cache path that would leave the cache root
 */
export function repoSourceOf(url: string): RepoSource {
    const providerName = detectProvider(url);

    if (!providerName) throw new Error(`Unsupported repo URL: ${url}`);
    const { owner, repo } = getProvider(providerName).parseRepoInput(url);

    return { url, providerName, owner, repo, cacheDir: getRepoCacheDir(providerName, owner, repo), slug: getRepoSlug(providerName, owner, repo) };
}

/** How an import reaches a repository. */
export interface RepoFetchOptions {
    /** Shallow clone depth, default 1 */
    depth?: number;
    /** Force SSH clone */
    forceSsh?: boolean;
    /** Force anonymous HTTPS (even when token is available), for whitelist auth='public' */
    forceAnonymous?: boolean;
    /** On a cache hit fetch and reset only; on a miss fall back to a full clone */
    incremental?: boolean;
}

/** The head commit of `evidenceDest`'s published source-manifest.json, when it names one. */
async function publishedHead(evidenceDest: string | undefined): Promise<string | undefined> {
    return evidenceDest
        ? SourceManifestSchema.safeParse(await fs.readJson(path.join(evidenceDest, 'source-manifest.json')).catch(() => null)).data?.headSha
        : undefined;
}

/**
 * The `--dry-run` of a repository import: reads the target remote commit with `git ls-remote` and says whether the
 * cache is current, before the clone, the lock and any AI call (#900).
 */
export async function previewRepoImport(source: RepoSource, opts: RepoFetchOptions & { output?: string }): Promise<void> {
    const { url, providerName, owner, repo, cacheDir, slug } = source;
    const forceSsh = opts.forceSsh ?? false;
    const forceAnonymous = opts.forceAnonymous ?? false;
    const lastSync = await readLastSync(cacheDir);
    const cacheExists = await fs.pathExists(path.join(cacheDir, '.git'));
    const useIncremental = (opts.incremental ?? false) && cacheExists && lastSync !== null;
    // A preview without a team repo still reports what it can.
    const target = await resolveTeamwiki({ output: opts.output, dryRun: true }).catch(() => undefined);
    const evidenceDest = target ? path.join(target.wikiRoot, 'evidence', 'code', slug) : undefined;
    let head: string;
    let previewIncremental = useIncremental;

    try {
        head = await remoteHeadSha(url, providerName, {
            forceSsh, forceAnonymous, cachedRepoPath: useIncremental ? cacheDir : undefined,
        });
    } catch (error) {
        if (!useIncremental) throw error;
        log.warn(`[incremental] preview refresh failed, previewing a full clone instead: ${error instanceof Error ? error.message : String(error)}`);
        head = await remoteHeadSha(url, providerName, { forceSsh, forceAnonymous });
        previewIncremental = false;
    }

    const skips = previewIncremental && (await publishedHead(evidenceDest)) === head;

    const cache = !cacheExists
        ? `not cached yet, a real run would clone it into ${cacheDir}`
        : lastSync?.sha === head
            ? `cache is current at ${head.slice(0, 8)}${skips ? ', so an incremental run would skip it' : ''}`
            : `cache would be refreshed from ${lastSync ? lastSync.sha.slice(0, 8) : 'an unrecorded commit'} to ${head.slice(0, 8)}`;

    log.info(`[dry-run] Would import ${owner}/${repo} at ${head.slice(0, 8)} into ${evidenceDest ?? path.join('teamwiki', 'evidence', 'code', slug)}; ${cache}`);
}

/** The commit a fetch reached, or that the teamwiki already holds it unchanged, so the import is done. */
export type RepoFetched = { kind: 'fetched'; sha: string; branch: string } | { kind: 'unchanged'; sha: string };

/**
 * Shallow-clone `source` into its cache, or with `incremental` fetch and reset a cached clone. An incremental fetch that
 * finds the commit the cache and the teamwiki at `evidenceDest` already hold records the sync and answers `unchanged`.
 *
 * @throws Error when the clone fails
 */
export async function fetchRepo(source: RepoSource, opts: RepoFetchOptions & { evidenceDest: string }): Promise<RepoFetched> {
    const { url, providerName, owner, repo, cacheDir } = source;
    const depth = opts.depth ?? 1;
    const forceSsh = opts.forceSsh ?? false;
    const forceAnonymous = opts.forceAnonymous ?? false;
    const lastSync = await readLastSync(cacheDir);
    const cacheExists = await fs.pathExists(path.join(cacheDir, '.git'));
    const useIncremental = (opts.incremental ?? false) && cacheExists && lastSync !== null;

    await ensureCacheRoot();

    let cloneSha: string;
    let cloneBranch: string;
    let oldSha: string | null = null;

    const clone = async (): Promise<{ sha: string; branch: string }> => {
        try {
            return await shallowClone(url, cacheDir, providerName, { depth, forceSsh, forceAnonymous });
        } catch (err) {
            // shallowClone cleans up the directory internally
            throw new Error(`Clone failed (${url}): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
    };

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
            ({ sha: cloneSha, branch: cloneBranch } = await clone());
            oldSha = null; // treat as full clone on fallback, skip drift detection
        }
    } else {
        log.info(`Shallow clone to cache: ${cacheDir}`);
        ({ sha: cloneSha, branch: cloneBranch } = await clone());
    }

    log.info(`Clone/Fetch complete: SHA=${cloneSha.slice(0, 8)}, branch=${cloneBranch}`);

    // Skip the AI scan if the cache did not move and the target teamwiki already holds this commit.
    if (useIncremental && oldSha && cloneSha === oldSha && (await publishedHead(opts.evidenceDest)) === cloneSha) {
        log.info(`[incremental] SHA unchanged (${cloneSha.slice(0, 8)}), skipping AI scan`);
        await recordRepoSync(source, cloneSha);
        log.info(chalk.green(`✓ repo ${owner}/${repo} unchanged, skipped`));

        return { kind: 'unchanged', sha: cloneSha };
    }

    return { kind: 'fetched', sha: cloneSha, branch: cloneBranch };
}

/** Record that the clone cache of `source` was imported at `sha`. */
export async function recordRepoSync(source: RepoSource, sha: string): Promise<void> {
    await writeLastSync(source.cacheDir, sha);

    try {
        await touchCacheEntry({ provider: source.providerName, owner: source.owner, repo: source.repo, lastSyncedSha: sha });
    } catch (touchErr) {
        log.debug(`[cache-index] touchCacheEntry failed: ${String(touchErr)}`);
    }
}

/**
 * Write the AI narrative the tool answered for a repository into its published `overview.md`, after the deterministic
 * overview (idempotent: it replaces the narrative a previous import wrote).
 */
export async function writeRepoNarrative(evidenceDest: string, slug: string, answer: string): Promise<void> {
    const overviewPath = path.join(evidenceDest, 'overview.md');
    const existing = await fs.readFile(overviewPath, 'utf8').catch(() => '');
    const aiNarrative = narrativeBody(answer);
    const marker = '## AI Architecture Narrative';
    const oldMarker = '## AI 架构叙事';
    let markerIdx = existing.indexOf(marker);

    if (markerIdx < 0) markerIdx = existing.indexOf(oldMarker);
    const base = markerIdx >= 0 ? existing.slice(0, markerIdx).trimEnd() : existing.trimEnd();

    const combined = !base || !hasFrontmatter(base)
        ? `---\ntitle: ${slug} overview\ndomain: code-knowledge\n---\n\n${marker}\n\n${aiNarrative}`
        : base + '\n\n---\n\n' + marker + '\n\n' + aiNarrative;

    await fs.writeFile(overviewPath, combined, 'utf8');
}

/** The narrative of a tool's answer: without frontmatter, from its first heading, without the words a tool may put before it. */
function narrativeBody(answer: string): string {
    let body = stripFrontmatter(answer);
    const h1Idx = body.indexOf('# ');
    const h2Idx = body.indexOf('## ');
    const titleIdx = h1Idx >= 0 ? h1Idx : h2Idx;

    if (titleIdx > 0) {
        body = body.slice(titleIdx);
    } else if (titleIdx < 0) {
        body = body.replace(/^.*(?:文件写入|请授权|权限确认|以下是生成的|完整内容|文档已准备|由于无法).*\n*/gm, '').trim();
    }

    return body;
}

/** Assign the repository to the business domain `--domain` or its list entry names, over any the AI tool inferred. */
export async function writeExplicitDomain(evidenceDest: string, domain: string): Promise<void> {
    const domainsJsonPath = path.join(evidenceDest, '_domains.json');

    if (await fs.pathExists(domainsJsonPath)) {
        try {
            const existing = JsonObjectSchema.parse(JSON.parse(await fs.readFile(domainsJsonPath, 'utf8')));
            await fs.writeFile(domainsJsonPath, JSON.stringify({ ...existing, domain }, null, 2), 'utf8');
        } catch { /* an unreadable file keeps the domain it has */ }
    } else {
        await fs.writeFile(domainsJsonPath, JSON.stringify({ domain }, null, 2), 'utf8');
    }
}

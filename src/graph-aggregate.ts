// -*- coding: utf-8 -*-
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import fs from 'fs-extra';
import { log } from './utils/logger.js';
import { caseFoldKey } from './manifest-schema.js';
import { RELATION_TYPES, LEGACY_RELATIONS, type RelationType } from './wiki-engine/core/graph-index.schema.js';

/**
 * The same relation normalization `loadGraphIndex`'s schema applies on load
 * (legacy `imports` → `DEPENDS_ON`), needed here because `scopeGlobalGraph`
 * reads a per-repo graph file with a raw `JSON.parse`, bypassing that
 * normalization — so an edge-ownership key computed from the raw relation
 * would never match the already-normalized relation on the corresponding
 * edge in the loaded global graph.
 */
function normalizeRelation(relation: string): string {
    return RELATION_TYPES.includes(relation as RelationType) ? relation : (LEGACY_RELATIONS[relation] ?? relation);
}

/**
 * 聚合 teamwiki/evidence/code/ 下所有仓库的 per-repo graph。
 *
 * 串行合并避免竞态；对每对仓库执行跨仓 edge 检测。
 *
 * 注意：每次调用都会重新扫描所有 per-repo graph（O(n)）。
 * 单仓 import 时也会触发全量重聚合。仓库数量增大（>50）后
 * 可考虑增量聚合优化。
 *
 * @param teamwikiRoot teamwiki/ 根目录
 * @returns 聚合后的图，无产出时返回 null
 */
export async function buildAggregatedGraph(teamwikiRoot: string) {
    const evidenceBase = path.join(teamwikiRoot, 'evidence', 'code');
    if (!(await fs.pathExists(evidenceBase))) return null;

    const { mergeGraphs } = await import('./wiki-engine/adapters/index.js');
    type GraphIndex = Parameters<typeof mergeGraphs>[0];
    const { detectCrossRepoEdges } = await import('./import-repo.js');

    let globalGraph: GraphIndex | null = null;
    const projectDirs = await readdir(evidenceBase, { withFileTypes: true });

    for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const graphPath = path.join(evidenceBase, dir.name, '.indices', 'graph-index.json');
        if (!(await fs.pathExists(graphPath))) continue;

        try {
            const overlay = JSON.parse(await fs.readFile(graphPath, 'utf8')) as GraphIndex;
            if (globalGraph) {
                const crossEdges = detectCrossRepoEdges(overlay, globalGraph);
                globalGraph = mergeGraphs(globalGraph, overlay);
                if (crossEdges.length > 0) {
                    globalGraph.edges.push(...crossEdges);
                }
            } else {
                globalGraph = overlay;
            }
        } catch (e) {
            log.warn(`[graph] skipped ${dir.name} graph: ${(e as Error).message}`);
        }
    }

    return globalGraph;
}

/**
 * The merged `.indices/graph-index.json` minus a withheld codebase's own
 * content (#912 review).
 *
 * Rebuilding the graph from only the allowed per-repo files (the first
 * attempt at this) silently dropped anything that only ever lived in the
 * global file — `teamai codebase --reconcile`'s product↔code MAPS_TO edges
 * chief among them, since the reconciler reads and writes the global graph
 * directly and never a per-repo one. So this instead starts from the real
 * global graph and subtracts by identifier: a withheld codebase's own
 * per-repo graph file names exactly the node slugs AND edge endpoints it
 * contributed. Edge endpoints matter on their own — an AST/heuristic edge is
 * commonly `{from: 'src/a.ts', to: 'src/b.ts'}` with neither side a node in
 * `nodes[]` at all, so an earlier version that required both endpoints to
 * survive as nodes deleted every such edge, allowed codebases included, the
 * moment anything was withheld. Dropping an edge only when it actually
 * touches a withheld identifier (by removal, not by node survival) is what
 * leaves an allowed codebase's own file-to-file edges untouched while still
 * removing a cross-repo `DEPENDS_ON` edge into a withheld node.
 *
 * A withheld identifier is cleared again if an ALLOWED codebase's own graph
 * file also claims it: fact-level node slugs are not repo-qualified
 * (`buildCodeGraph` mints `component/App` the same way for any repo), so two
 * unrelated repos can legitimately collide on one slug after merging. In
 * that case withholding one must not also take down the other's node — but
 * two things still need handling for a colliding slug:
 * - An edge is a PAIR, not a single identifier, and `relation` is part of
 *   its identity: if the withheld repo has its own edge directly between two
 *   such colliding names (e.g. a withheld `App -DEPENDS_ON-> Config` beside
 *   an allowed `App -REFERENCES-> Config`), that edge is tracked and cleared
 *   by the exact `from|to|relation` tuple, so a relationship — of that
 *   specific kind — that only ever existed in the withheld repo cannot
 *   survive merely because both endpoint names, or some OTHER relation
 *   between them, happen to be shared.
 * - `mergeGraphs` lets the later-processed repo's node win outright on a
 *   colliding slug (no field-level merge), so the slug kept in the global
 *   graph can still carry the WITHHELD repo's title/domain rather than the
 *   allowed one's, if the withheld repo happened to merge last. The allowed
 *   repo's own copy of that node (read in the same per-repo scan) is
 *   re-attached onto the surviving node so its metadata is actually
 *   attributable to an allowed source.
 *
 * Per-repo files alone are not the whole story either: `teamai codebase
 * --reconcile` adds code-page nodes (`evidence/code/<slug>/<page>`) and their
 * MAPS_TO edges straight to the global graph, never to a per-repo file. Those
 * are caught by a second pass over the global graph's own nodes, matched by
 * the `evidence/code/<slug>/` prefix instead of per-repo membership.
 *
 * None of this works without a per-repo graph file to read ownership from in
 * the first place. `teamai codebase --extract` run directly (outside
 * `teamai import`'s cache-then-copy orchestration) writes only the global
 * `teamwiki/.indices/graph-index.json` and never populates
 * `evidence/code/<slug>/.indices/graph-index.json` at all — so a withheld
 * codebase extracted that way has no per-repo file for this function to read
 * ownership from, and would otherwise fail open: its fact-level nodes and
 * edges would stay in the "scoped" graph, fully exposed. So whenever a
 * withheld codebase's per-repo file is missing or unreadable, this fails
 * closed instead — returning `null` (no graph at all for this query) rather
 * than a result it cannot vouch for.
 *
 * @param teamwikiRoot teamwiki/ 根目录
 * @param withheldProjects 排除的 codebase slug（大小写不敏感）
 * @returns 过滤后的图；没有全局图、或任一被排除 codebase 的归属无法确认时返回 null
 */
export async function scopeGlobalGraph(
    teamwikiRoot: string,
    withheldProjects: Set<string>,
) {
    const { loadGraphIndex } = await import('./wiki-engine/core/graph-index.schema.js');
    type GraphIndex = NonNullable<Awaited<ReturnType<typeof loadGraphIndex>>>;
    const globalGraph = await loadGraphIndex(teamwikiRoot);
    if (!globalGraph || withheldProjects.size === 0) return globalGraph;

    const evidenceBase = path.join(teamwikiRoot, 'evidence', 'code');
    const withheldIds = new Set<string>();
    const allowedIds = new Set<string>();
    const withheldEdgeKeys = new Set<string>();
    const allowedEdgeKeys = new Set<string>();
    // `relation` is part of the edge's identity: an allowed REFERENCES edge
    // and a withheld DEPENDS_ON edge between the same two endpoints are two
    // different edges, not one — omitting it would let the allowed one clear
    // the withheld one out of withheldEdgeKeys even though it never claimed
    // it. `JSON.stringify` (not `|`-concatenation) avoids aliasing `a|b -> c`
    // with `a -> b|c` were an identifier ever to contain the separator —
    // matching `graphEdgeKey`'s own approach in graph-index.schema.ts.
    const edgeKey = (from: string, to: string, relation?: string) => JSON.stringify([from, to, relation ?? '']);
    const accountedWithheld = new Set<string>();
    type RepoNode = { slug?: string; id?: string; [key: string]: unknown };
    const allowedNodeBySlug = new Map<string, RepoNode>();
    const projectDirs = await readdir(evidenceBase, { withFileTypes: true }).catch(() => []);
    for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const foldedName = caseFoldKey(dir.name);
        const isWithheld = withheldProjects.has(foldedName);
        const graphPath = path.join(evidenceBase, dir.name, '.indices', 'graph-index.json');
        try {
            const parsed = JSON.parse(await fs.readFile(graphPath, 'utf8')) as {
                nodes?: unknown;
                edges?: unknown;
            };
            // A syntactically valid but structurally wrong file (`{}`, a
            // truncated write, ...) must not count as "successfully read
            // ownership from" just because JSON.parse didn't throw — that
            // would mark this withheld project accounted for while
            // contributing zero identifiers, silently exposing whatever the
            // global graph still has for it. Treat it the same as unreadable.
            if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
                throw new Error(`${graphPath} is not a valid graph-index.json (missing nodes[]/edges[])`);
            }
            const repoGraph = parsed as {
                nodes: RepoNode[];
                edges: Array<{ from?: string; to?: string; relation?: string }>;
            };
            const ids = isWithheld ? withheldIds : allowedIds;
            const edgeKeys = isWithheld ? withheldEdgeKeys : allowedEdgeKeys;
            for (const node of repoGraph.nodes) {
                const slug = node.slug ?? node.id;
                if (!slug) continue;
                ids.add(slug);
                if (!isWithheld) allowedNodeBySlug.set(slug, node);
            }
            for (const edge of repoGraph.edges) {
                if (edge.from) ids.add(edge.from);
                if (edge.to) ids.add(edge.to);
                if (edge.from && edge.to) edgeKeys.add(edgeKey(edge.from, edge.to, normalizeRelation(edge.relation ?? '')));
            }
            if (isWithheld) accountedWithheld.add(foldedName);
        } catch { /* handled below: an unreadable or structurally invalid file leaves this withheld project unaccounted for */ }
    }

    // Fail closed, not open: a withheld codebase this function could not load
    // ownership for (see doc comment) must not be treated as "nothing to
    // subtract" — that would silently leave its content exposed.
    for (const withheldSlug of withheldProjects) {
        if (!accountedWithheld.has(withheldSlug)) return null;
    }

    // A slug both sets claim needs its global metadata restored to the
    // allowed repo's own even though nothing about it gets removed — so this
    // is captured BEFORE allowedIds clears it out of withheldIds below, and
    // used on its own to decide whether the fast path a few lines down may
    // still return the graph completely untouched.
    const contestedSlugs = new Set<string>();
    for (const id of withheldIds) {
        if (allowedNodeBySlug.has(id)) contestedSlugs.add(id);
    }

    for (const id of allowedIds) withheldIds.delete(id);
    for (const key of allowedEdgeKeys) withheldEdgeKeys.delete(key);

    // `teamai codebase --reconcile` adds code-page nodes (e.g.
    // `evidence/code/svc-b/overview`) and their MAPS_TO edges straight to the
    // global graph, the same as it does for product-page nodes — never to any
    // per-repo file, so the scan above misses them. Unlike a bare fact-level
    // slug, this prefix unambiguously names the codebase it came from (it IS
    // the directory a withheld codebase declares), so there is no allowed/
    // withheld collision risk to guard against here the way there is above.
    for (const node of globalGraph.nodes) {
        const match = node.slug.match(/^evidence\/code\/([^/]+)\//);
        if (match && withheldProjects.has(caseFoldKey(match[1]))) withheldIds.add(node.slug);
    }

    if (withheldIds.size === 0 && withheldEdgeKeys.size === 0 && contestedSlugs.size === 0) return globalGraph;

    // `mergeGraphs` lets the later-processed repo's node win outright on a
    // colliding slug (no field-level merge) — so a slug kept here because an
    // ALLOWED repo also claims it can still carry a WITHHELD repo's title or
    // domain, if that withheld repo happened to aggregate after the allowed
    // one. Re-attaching the allowed repo's own copy of that node (read in the
    // same scan above) makes the surviving node's metadata actually
    // attributable to an allowed source, not whichever repo's write won.
    const nodes = globalGraph.nodes
        .filter((n) => !withheldIds.has(n.slug))
        .map((n) => (contestedSlugs.has(n.slug) ? { ...n, ...allowedNodeBySlug.get(n.slug) } : n));
    const edges = globalGraph.edges.filter((e) =>
        !withheldIds.has(e.from) && !withheldIds.has(e.to) && !withheldEdgeKeys.has(edgeKey(e.from, e.to, e.relation)));

    return { ...globalGraph, nodes, edges } satisfies GraphIndex;
}

/**
 * 聚合 teamwiki/evidence/code/ 下所有仓库的 per-repo graph 到全局 graph-index.json。
 *
 * @param teamwikiRoot teamwiki/ 根目录
 * @returns 聚合后的节点数和边数，无产出时返回 null
 */
export async function aggregateGlobalGraph(
    teamwikiRoot: string,
): Promise<{ nodes: number; edges: number } | null> {
    const globalGraph = await buildAggregatedGraph(teamwikiRoot);

    if (globalGraph) {
        const destPath = path.join(teamwikiRoot, '.indices', 'graph-index.json');
        await fs.ensureDir(path.dirname(destPath));
        await fs.writeFile(destPath, JSON.stringify(globalGraph, null, 2), 'utf8');
        log.info(`global graph-index.json aggregated (${globalGraph.nodes.length} nodes, ${globalGraph.edges.length} edges)`);
        return { nodes: globalGraph.nodes.length, edges: globalGraph.edges.length };
    }

    return null;
}

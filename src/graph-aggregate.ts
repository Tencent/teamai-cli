// -*- coding: utf-8 -*-
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import fs from 'fs-extra';
import { log } from './utils/logger.js';
import { caseFoldKey } from './manifest-schema.js';

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
 * an edge is a pair, not a single identifier: if the withheld repo ALSO has
 * an edge directly between two such colliding names, that edge is tracked
 * and cleared/subtracted by the exact `from|to` pair instead, so a
 * relationship that only ever existed in the withheld repo cannot survive
 * merely because both of its endpoint names happen to be shared.
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
    const edgeKey = (from: string, to: string) => `${from}|${to}`;
    const accountedWithheld = new Set<string>();
    const projectDirs = await readdir(evidenceBase, { withFileTypes: true }).catch(() => []);
    for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const foldedName = caseFoldKey(dir.name);
        const isWithheld = withheldProjects.has(foldedName);
        const graphPath = path.join(evidenceBase, dir.name, '.indices', 'graph-index.json');
        try {
            const repoGraph = JSON.parse(await fs.readFile(graphPath, 'utf8')) as {
                nodes?: Array<{ slug?: string; id?: string }>;
                edges?: Array<{ from?: string; to?: string }>;
            };
            const ids = isWithheld ? withheldIds : allowedIds;
            const edgeKeys = isWithheld ? withheldEdgeKeys : allowedEdgeKeys;
            for (const node of repoGraph.nodes ?? []) {
                const slug = node.slug ?? node.id;
                if (slug) ids.add(slug);
            }
            for (const edge of repoGraph.edges ?? []) {
                if (edge.from) ids.add(edge.from);
                if (edge.to) ids.add(edge.to);
                if (edge.from && edge.to) edgeKeys.add(edgeKey(edge.from, edge.to));
            }
            if (isWithheld) accountedWithheld.add(foldedName);
        } catch { /* handled below: an unreadable file leaves this withheld project unaccounted for */ }
    }

    // Fail closed, not open: a withheld codebase this function could not load
    // ownership for (see doc comment) must not be treated as "nothing to
    // subtract" — that would silently leave its content exposed.
    for (const withheldSlug of withheldProjects) {
        if (!accountedWithheld.has(withheldSlug)) return null;
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

    if (withheldIds.size === 0 && withheldEdgeKeys.size === 0) return globalGraph;

    const nodes = globalGraph.nodes.filter((n) => !withheldIds.has(n.slug));
    const edges = globalGraph.edges.filter((e) =>
        !withheldIds.has(e.from) && !withheldIds.has(e.to) && !withheldEdgeKeys.has(edgeKey(e.from, e.to)));

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

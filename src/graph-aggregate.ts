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

    const { mergeGraphs, createGraphIndex } = await import('./wiki-engine/adapters/index.js');
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
            // Stamp ownership onto the data itself before it ever enters the
            // global graph (#912 review): every node and edge this ONE
            // per-repo file contributed is unambiguously this project's.
            // Once merged, that tag travels with the node/edge forever —
            // scoping later reads it straight off the global graph instead
            // of re-reading this per-repo file and trusting its CURRENT
            // content still matches what was merged, which it may no longer
            // if the file was since emptied, rewritten by a newer
            // extraction, or deleted outright.
            for (const node of overlay.nodes) node.origin = dir.name;
            for (const edge of overlay.edges) edge.origin = dir.name;
            if (globalGraph) {
                // A cross-repo edge spans two codebases, so
                // detectCrossRepoEdges tags it with BOTH their origins as a
                // pair in `crossOriginPairs` (see its own doc comment) —
                // captured at the moment of the match rather than re-derived
                // later from whichever node ends up winning a slug collision.
                const crossEdges = detectCrossRepoEdges(overlay, globalGraph);
                globalGraph = mergeGraphs(globalGraph, overlay);
                if (crossEdges.length > 0) {
                    // Routed through `mergeGraphs`, not appended raw: a
                    // THIRD repo processed later can independently detect a
                    // cross-repo edge with the exact same from/to/relation
                    // identity as one already pushed here in an earlier
                    // iteration (e.g. two unrelated repos both importing a
                    // same-named component from a shared third one under an
                    // equally generic importer slug of their own). Appending
                    // both raw would leave two separate array entries
                    // sharing one key — scopeGlobalGraph's removal is keyed,
                    // so marking either one withheld removes both, which is
                    // exactly what crossOriginPairs (see its own doc
                    // comment) exists to prevent; that only works if both
                    // detections' pairs actually end up unioned onto ONE
                    // edge object, which only `mergeGraphs` does (#974
                    // review round 15 P2).
                    globalGraph = mergeGraphs(globalGraph, createGraphIndex([], crossEdges));
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
 * None of the above actually needs a per-repo graph file to be read at
 * query time at all, IF the global graph already carries `origin` tags:
 * `buildAggregatedGraph` stamps every node and edge with the codebase slug
 * its own per-repo file contributed it from, at the moment it merges that
 * file in. That tag travels with the data from then on — it stays correct
 * even if the per-repo file is later emptied, rewritten by a newer
 * extraction, or deleted outright, which re-reading the per-repo file at
 * query time cannot promise (an import that replaces a withheld codebase's
 * per-repo graph and is interrupted before the next re-aggregation leaves
 * exactly this mismatch: a newer per-repo file describing different
 * content than what the global graph actually has tagged from the older
 * generation). So a withheld codebase with ANY `origin`-tagged content in
 * the global graph is "tag-covered": every node/edge whose `origin` names
 * it is removed directly, and its per-repo file is not read at all for
 * subtraction purposes — the tag already answers the question reliably.
 *
 * A withheld codebase is NOT tag-covered when its content predates this
 * tagging (an older aggregation, before this field existed) or was
 * extracted directly via `teamai codebase --extract` (outside `teamai
 * import`'s cache-then-copy orchestration, which writes only the global
 * `teamwiki/.indices/graph-index.json` and never populates
 * `evidence/code/<slug>/.indices/graph-index.json` at all). Only THOSE
 * codebases fall back to reading their per-repo file, with the same
 * fail-closed guards as before: missing, unreadable, or failing to
 * validate against the same `GraphIndexSchema` the global graph is loaded
 * with (`parseGraphIndex`, not a loose "are nodes/edges arrays" check —
 * that alone would wave through a schema-invalid node and, separately,
 * leave `label`/`id`/`kind` legacy fields unnormalized, so a restored node
 * below would carry the wrong field name instead of just the wrong value),
 * or reporting zero nodes and zero edges (a schema-valid file can do this,
 * but a genuine extraction's never does — its overlay hub node alone
 * guarantees at least one) all fail closed — returning `null` (no graph at
 * all for this query) rather than a result that fallback cannot vouch for.
 * Note this fallback, and the fail-closed guard on it, is now reached only
 * by codebases tagging hasn't covered yet; the next aggregation that runs
 * for them (any `teamai import` or `codebase --extract`) tags them too.
 *
 * Collision handling (two codebases sharing one unqualified fact-level
 * slug) still needs an ALLOWED codebase's per-repo file regardless of
 * tagging, tag-covered or not: the merged global graph keeps only one
 * node per slug, so if a withheld codebase's write won that merge, tagging
 * alone would remove the node outright — losing the allowed codebase's
 * equally legitimate claim on it. Allowed codebases are therefore always
 * read, same as before `origin` tagging existed.
 *
 * @param teamwikiRoot teamwiki/ 根目录
 * @param withheldProjects 排除的 codebase slug（大小写不敏感）
 * @returns 过滤后的图；没有全局图、或任一被排除 codebase 的归属无法确认时返回 null
 */
export async function scopeGlobalGraph(
    teamwikiRoot: string,
    withheldProjects: Set<string>,
) {
    const { loadGraphIndex, parseGraphIndex } = await import('./wiki-engine/core/graph-index.schema.js');
    type GraphIndex = NonNullable<Awaited<ReturnType<typeof loadGraphIndex>>>;
    type GraphNode = GraphIndex['nodes'][number];
    const globalGraph = await loadGraphIndex(teamwikiRoot);
    if (!globalGraph || withheldProjects.size === 0) return globalGraph;

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
    const allowedNodeBySlug = new Map<string, GraphNode>();

    // Origin-tag removal first (see doc comment): authoritative and
    // independent of whatever any per-repo file currently says.
    const taggedOrigins = new Set<string>();
    for (const node of globalGraph.nodes) {
        if (!node.origin) continue;
        const origin = caseFoldKey(node.origin);
        taggedOrigins.add(origin);
        if (withheldProjects.has(origin)) withheldIds.add(node.slug);
    }
    for (const edge of globalGraph.edges) {
        // A cross-repo edge carries one pair of origins PER independent
        // detection that has ever produced its exact identity (`mergeGraphs`
        // unions pairs on collision rather than overwriting — #974 review
        // round 15 P2). Removing the edge the moment ANY single origin is
        // withheld would also discard a DIFFERENT, fully-allowed pair that
        // happens to produce the identical from/to/relation — so the edge is
        // withheld only when EVERY pair has at least one withheld member; a
        // plain single-origin edge (`origin` set, no pairs) is just a
        // length-1 list holding one length-1 "pair", so that case reduces to
        // the original single-tag check unchanged.
        const pairs = edge.crossOriginPairs ?? (edge.origin ? [[edge.origin]] : []);
        for (const pair of pairs) {
            for (const rawOrigin of pair) taggedOrigins.add(caseFoldKey(rawOrigin));
        }
        const edgeWithheld = pairs.length > 0 && pairs.every((pair) =>
            pair.some((rawOrigin) => withheldProjects.has(caseFoldKey(rawOrigin))));
        if (edgeWithheld) withheldEdgeKeys.add(edgeKey(edge.from, edge.to, edge.relation));
    }
    const tagCovered = new Set([...withheldProjects].filter((p) => taggedOrigins.has(p)));

    const evidenceBase = path.join(teamwikiRoot, 'evidence', 'code');
    const accountedWithheld = new Set<string>();
    // Slugs added to `withheldIds` by the per-repo-file fallback below
    // specifically (as opposed to the origin-tag pass above) — tracked
    // separately so the cross-repo-edge check further down can be scoped
    // to exactly the codebases that fallback actually covers.
    const fallbackWithheldIds = new Set<string>();
    const projectDirs = await readdir(evidenceBase, { withFileTypes: true }).catch(() => []);
    for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        const foldedName = caseFoldKey(dir.name);
        const isWithheld = withheldProjects.has(foldedName);
        // A tag-covered withheld codebase is already fully handled above;
        // an allowed codebase is always read, for collision restoration.
        if (isWithheld && tagCovered.has(foldedName)) continue;
        const graphPath = path.join(evidenceBase, dir.name, '.indices', 'graph-index.json');
        try {
            const raw = JSON.parse(await fs.readFile(graphPath, 'utf8'));
            // `parseGraphIndex` is the exact schema `loadGraphIndex` validates
            // the global graph with — reusing it here, instead of a loose
            // shape check, is what catches a schema-invalid node (missing
            // required fields, wrong types, ...) that `Array.isArray(nodes)`
            // alone would wave through. It also normalizes legacy fields
            // (`id`→slug, `label`→title, `kind`→type, the `imports`→
            // `DEPENDS_ON` relation) the same way the global graph already
            // was, so a node collected from here matches its global
            // counterpart's shape — both for ownership-key comparison and
            // for the metadata restored below. A per-repo file that doesn't
            // validate, same as one that doesn't parse at all, must not
            // count as "successfully read ownership from": that would mark
            // this withheld project accounted for while contributing zero
            // identifiers, silently exposing whatever the global graph
            // still has for it.
            const repoGraph = parseGraphIndex(raw);
            if (!repoGraph) throw new Error(`${graphPath} does not validate as a graph-index.json`);
            // A schema-valid but entirely empty graph ({nodes: [], edges: []})
            // still parses, so it would otherwise mark a withheld codebase
            // accounted for while contributing nothing to subtract — exposing
            // whatever the global graph still has for it if this file is
            // stale or was truncated mid-write rather than genuinely empty.
            // A real extraction's per-repo graph is never actually empty:
            // buildIndexHubOverlay unconditionally adds the project's own
            // index/hub node whenever extraction produces any page at all, so
            // zero nodes for a withheld codebase is itself suspicious — treat
            // it with the same distrust as a file that fails to validate.
            if (isWithheld && repoGraph.nodes.length === 0 && repoGraph.edges.length === 0) {
                throw new Error(`${graphPath} reports no nodes or edges for a withheld codebase — too suspicious (stale or truncated) to trust as complete ownership evidence`);
            }
            const ids = isWithheld ? withheldIds : allowedIds;
            const edgeKeys = isWithheld ? withheldEdgeKeys : allowedEdgeKeys;
            for (const node of repoGraph.nodes) {
                ids.add(node.slug);
                if (isWithheld) fallbackWithheldIds.add(node.slug);
                if (!isWithheld) allowedNodeBySlug.set(node.slug, node);
            }
            for (const edge of repoGraph.edges) {
                ids.add(edge.from);
                ids.add(edge.to);
                if (isWithheld) {
                    fallbackWithheldIds.add(edge.from);
                    fallbackWithheldIds.add(edge.to);
                }
                edgeKeys.add(edgeKey(edge.from, edge.to, edge.relation));
            }
            if (isWithheld) accountedWithheld.add(foldedName);
        } catch { /* handled below: an unreadable or schema-invalid file leaves this withheld project unaccounted for */ }
    }

    // Fail closed, not open: a withheld codebase tagging doesn't cover, that
    // this function also could not load a per-repo fallback for (see doc
    // comment), must not be treated as "nothing to subtract" — that would
    // silently leave its content exposed. A tag-covered codebase needs no
    // such fallback at all; it was already fully handled above.
    for (const withheldSlug of withheldProjects) {
        if (!tagCovered.has(withheldSlug) && !accountedWithheld.has(withheldSlug)) return null;
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

    // A legacy (not tag-covered) withheld codebase's contested slug is kept
    // because an allowed repo also legitimately claims it — correct for the
    // node itself. But a synthesized cross-repo edge that predates
    // `origin`/`crossOriginPairs` tagging entirely never lived in any per-repo
    // file (cross edges are written straight to the global graph at
    // aggregation time), so the fallback scan above has no way to discover,
    // let alone subtract, one touching this slug. Silently trusting that no
    // such edge exists would risk exposing a withheld-only relationship
    // with no path left to remove it — fail closed instead (#974 review
    // round 14 P1).
    const looksLikeUntaggedCrossEdge = (edge: { relation: string; origin?: string; crossOriginPairs?: string[][]; source?: string }) =>
        edge.relation === 'DEPENDS_ON' && !edge.origin && !edge.crossOriginPairs && !edge.source;
    for (const slug of contestedSlugs) {
        if (!fallbackWithheldIds.has(slug)) continue;
        const unverifiable = globalGraph.edges.some((e) => (e.from === slug || e.to === slug) && looksLikeUntaggedCrossEdge(e));
        if (unverifiable) return null;
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
    //
    // `import-iwiki.ts`'s own reconciler writes a MAPS_TO edge straight to
    // the global graph's edges[] too, but for its "term appears in the page
    // body" match it points `to` at the code PAGE's path
    // (`evidence/code/<slug>/<page>.md`) directly, with no corresponding
    // node ever created for that path — so scanning only `nodes[]` above
    // misses it exactly the same way scanning only per-repo files would.
    // Edge endpoints get the identical prefix check for that reason.
    for (const node of globalGraph.nodes) {
        const match = node.slug.match(/^evidence\/code\/([^/]+)\//);
        if (match && withheldProjects.has(caseFoldKey(match[1]))) withheldIds.add(node.slug);
    }
    for (const edge of globalGraph.edges) {
        for (const slug of [edge.from, edge.to]) {
            const match = slug.match(/^evidence\/code\/([^/]+)\//);
            if (match && withheldProjects.has(caseFoldKey(match[1]))) withheldIds.add(slug);
        }
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

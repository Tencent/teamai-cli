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
 * content (#912 review round 2).
 *
 * Rebuilding the graph from only the allowed per-repo files (the first
 * attempt at this) silently dropped anything that only ever lived in the
 * global file — `teamai codebase --reconcile`'s product↔code MAPS_TO edges
 * chief among them, since the reconciler reads and writes the global graph
 * directly and never a per-repo one. So this instead starts from the real
 * global graph and subtracts: a withheld codebase's own per-repo graph file
 * names exactly the node slugs it contributed (its AST/heuristic fact nodes,
 * which carry no `evidence/code/<slug>/` prefix, as well as its overlay hub
 * node, which does) — remove those by slug, then drop any edge left dangling
 * from a removed endpoint. That dangling-edge pass is what also removes a
 * cross-repo `DEPENDS_ON` edge into a withheld node and a reconciler MAPS_TO
 * edge into a withheld code page, without needing to know those edges came
 * from aggregation/reconcile rather than a per-repo file.
 *
 * @param teamwikiRoot teamwiki/ 根目录
 * @param withheldProjects 排除的 codebase slug（大小写不敏感）
 * @returns 过滤后的图；没有全局图时返回 null
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
    const withheldNodeSlugs = new Set<string>();
    const projectDirs = await readdir(evidenceBase, { withFileTypes: true }).catch(() => []);
    for (const dir of projectDirs) {
        if (!dir.isDirectory() || !withheldProjects.has(caseFoldKey(dir.name))) continue;
        const graphPath = path.join(evidenceBase, dir.name, '.indices', 'graph-index.json');
        try {
            const repoGraph = JSON.parse(await fs.readFile(graphPath, 'utf8')) as { nodes?: Array<{ slug?: string; id?: string }> };
            for (const node of repoGraph.nodes ?? []) {
                const slug = node.slug ?? node.id;
                if (slug) withheldNodeSlugs.add(slug);
            }
        } catch { /* no per-repo graph for this project; nothing to subtract */ }
    }

    if (withheldNodeSlugs.size === 0) return globalGraph;

    const nodes = globalGraph.nodes.filter((n) => !withheldNodeSlugs.has(n.slug));
    const keptSlugs = new Set(nodes.map((n) => n.slug));
    const edges = globalGraph.edges.filter((e) => keptSlugs.has(e.from) && keptSlugs.has(e.to));

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

// -*- coding: utf-8 -*-
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import fs from 'fs-extra';
import { log } from './utils/logger.js';
import { caseFoldKey } from './manifest-schema.js';

/**
 * 聚合 teamwiki/evidence/code/ 下仓库的 per-repo graph。
 *
 * 串行合并避免竞态；对每对仓库执行跨仓 edge 检测。`excludeProjects` 跳过的仓库
 * 既不贡献节点/边，也不参与跨仓 edge 检测——这是 #912 wiki 命名空间收紧 recall
 * 时重建“仅含已激活 codebase”的图所复用的同一条聚合逻辑（而不是在消费端按前缀
 * 猜测节点归属，因为 AST/heuristic 节点的 slug 本来就不带项目前缀）。
 *
 * 注意：每次调用都会重新扫描所有 per-repo graph（O(n)）。
 * 单仓 import 时也会触发全量重聚合。仓库数量增大（>50）后
 * 可考虑增量聚合优化。
 *
 * @param teamwikiRoot teamwiki/ 根目录
 * @param excludeProjects 跳过的 codebase slug（大小写不敏感）
 * @returns 聚合后的图，无产出时返回 null
 */
export async function buildAggregatedGraph(
    teamwikiRoot: string,
    excludeProjects: Set<string> = new Set(),
) {
    const evidenceBase = path.join(teamwikiRoot, 'evidence', 'code');
    if (!(await fs.pathExists(evidenceBase))) return null;

    const { mergeGraphs } = await import('./wiki-engine/adapters/index.js');
    type GraphIndex = Parameters<typeof mergeGraphs>[0];
    const { detectCrossRepoEdges } = await import('./import-repo.js');

    let globalGraph: GraphIndex | null = null;
    const projectDirs = await readdir(evidenceBase, { withFileTypes: true });

    for (const dir of projectDirs) {
        if (!dir.isDirectory()) continue;
        if (excludeProjects.has(caseFoldKey(dir.name))) continue;
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

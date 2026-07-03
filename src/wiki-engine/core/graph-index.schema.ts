import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { CONFIDENCE_SCORE_DEFAULTS, type WikiCategory, type WikiConfidence, type WikiEvidence } from "./wiki-protocol.js";

/**
 * Graph Index Schema — team-wiki.graph-index.v1
 *
 * Formal schema for knowledge graph indices that capture
 * relationships between wiki pages and code entities.
 */

export const GRAPH_INDEX_SCHEMA_VERSION = "team-wiki.graph-index.v1" as const;

export type RelationType =
  | "DEPENDS_ON"
  | "IMPLEMENTS"
  | "MAPS_TO"
  | "CONTAINS"
  | "REFERENCES"
  | "CONFLICTS_WITH"
  | "SUPERSEDES";

export const RELATION_TYPES: RelationType[] = [
  "DEPENDS_ON",
  "IMPLEMENTS",
  "MAPS_TO",
  "CONTAINS",
  "REFERENCES",
  "CONFLICTS_WITH",
  "SUPERSEDES"
];

export interface GraphNode {
  slug: string;
  type: WikiCategory;
  confidence: WikiConfidence;
  title: string;
  domain?: string;
}

/** Provenance of a graph edge (compile / reconcile pipeline). */
export type GraphEdgeSource =
  | "code-ast"
  | "code-heuristic"
  | "doc-structure"
  | "doc-entity"
  | "doc-triples"
  | "bridge-reconcile"
  | "doc-semantic"
  | "manual-mapping";

export interface GraphEdge {
  from: string;
  to: string;
  relation: RelationType;
  evidence?: WikiEvidence[];
  weight?: number;
  /** Fine-grained semantic predicate (e.g. G6 CALLS_HTTP, USES_TABLE). */
  predicate?: string;
  source?: GraphEdgeSource;
}

/** Wiki page slug: relative path without `.md`. */
export function toPageSlug(relativePath: string): string {
  return relativePath.replace(/\.md$/u, "").replace(/\\/g, "/");
}

export interface GraphIndex {
  schemaVersion: typeof GRAPH_INDEX_SCHEMA_VERSION;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Create an empty GraphIndex with the current timestamp.
 */
export function createGraphIndex(nodes: GraphNode[] = [], edges: GraphEdge[] = []): GraphIndex {
  return {
    schemaVersion: GRAPH_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

/**
 * Add a node to the graph index. If a node with the same slug already exists,
 * it is replaced with the new node.
 */
export function addNode(graph: GraphIndex, node: GraphNode): GraphIndex {
  const filtered = graph.nodes.filter((n) => n.slug !== node.slug);
  return { ...graph, nodes: [...filtered, node] };
}

/**
 * Add an edge to the graph index. Duplicate edges (same from, to, relation) are not added.
 */
export function addEdge(graph: GraphIndex, edge: GraphEdge): GraphIndex {
  const exists = graph.edges.some(
    (e) => e.from === edge.from && e.to === edge.to && e.relation === edge.relation
  );
  if (exists) {
    return graph;
  }
  return { ...graph, edges: [...graph.edges, edge] };
}

/**
 * Add an edge using confidence level as weight when no explicit weight is provided.
 * Falls back to CONFIDENCE_SCORE_DEFAULTS for the given confidence level.
 */
export function addEdgeWithConfidence(
  graph: GraphIndex,
  edge: Omit<GraphEdge, "weight"> & { weight?: number },
  confidence: WikiConfidence
): GraphIndex {
  const weight = edge.weight ?? CONFIDENCE_SCORE_DEFAULTS[confidence];
  return addEdge(graph, { ...edge, weight });
}

/**
 * Find all neighbor slugs of a given node (connected via any edge direction).
 */
export function findNeighbors(graph: GraphIndex, slug: string): string[] {
  const neighbors = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === slug) {
      neighbors.add(edge.to);
    }
    if (edge.to === slug) {
      neighbors.add(edge.from);
    }
  }
  return [...neighbors].sort();
}

/**
 * Find all neighbor slugs reachable within N hops.
 * Optionally filter by specific relation types.
 * Uses BFS to expand outward from the starting node.
 */
export function findNeighborsNHop(
  graph: GraphIndex,
  slug: string,
  hops: number,
  filterRelations?: RelationType[]
): string[] {
  const visited = new Set<string>([slug]);
  let frontier = new Set<string>([slug]);

  for (let hop = 0; hop < hops; hop++) {
    const nextFrontier = new Set<string>();
    for (const current of frontier) {
      for (const edge of graph.edges) {
        if (filterRelations && !filterRelations.includes(edge.relation)) {
          continue;
        }
        let neighbor: string | null = null;
        if (edge.from === current && !visited.has(edge.to)) {
          neighbor = edge.to;
        } else if (edge.to === current && !visited.has(edge.from)) {
          neighbor = edge.from;
        }
        if (neighbor) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  visited.delete(slug); // Remove starting node from results
  return [...visited].sort();
}

export interface GraphValidationIssue {
  code: "node.duplicate" | "edge.missing_node" | "edge.self_loop" | "edge.invalid_weight";
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  issues: GraphValidationIssue[];
}

/**
 * Validate a graph index for structural correctness:
 * - No duplicate node slugs
 * - All edge endpoints reference existing nodes
 * - No self-loop edges
 * - Edge weights (if provided) are between 0 and 1
 */
export function validateGraph(graph: GraphIndex): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  const slugs = new Set<string>();

  for (const node of graph.nodes) {
    if (slugs.has(node.slug)) {
      issues.push({
        code: "node.duplicate",
        message: `Duplicate node slug: ${node.slug}`,
      });
    }
    slugs.add(node.slug);
  }

  for (const edge of graph.edges) {
    if (!slugs.has(edge.from)) {
      issues.push({
        code: "edge.missing_node",
        message: `Edge references non-existent source node: ${edge.from}`,
      });
    }
    if (!slugs.has(edge.to)) {
      issues.push({
        code: "edge.missing_node",
        message: `Edge references non-existent target node: ${edge.to}`,
      });
    }
    if (edge.from === edge.to) {
      issues.push({
        code: "edge.self_loop",
        message: `Self-loop edge on node: ${edge.from}`,
      });
    }
    if (edge.weight !== undefined && (edge.weight < 0 || edge.weight > 1)) {
      issues.push({
        code: "edge.invalid_weight",
        message: `Edge weight out of range [0,1]: ${edge.from} -> ${edge.to} (${edge.weight})`,
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Graph Health Metrics — a summary of overall graph quality.
 */
export interface GraphHealthMetrics {
  healthScore: number;        // 0-100
  connectivity: number;       // largest connected component / total nodes (0-1)
  density: number;            // edges / nodes ratio
  freshness: number;          // nodes with usable status / total (0-1)
  confidenceRatio: number;    // edges with weight >= 0.8 / total edges (0-1)
  nodeCount: number;
  edgeCount: number;
  orphanNodes: number;        // nodes with no edges
  brokenEdges: number;        // edges referencing non-existent nodes
}

/**
 * Compute health metrics for a graph index.
 *
 * - connectivity: BFS from first node, count reachable / total
 * - density: edges.length / max(nodes.length, 1)
 * - freshness: simplified — nodeCount > 0 ? 1.0 : 0 (full impl needs status data)
 * - confidenceRatio: edges with weight >= 0.8 / total edges
 * - healthScore = connectivity*30 + (density>1.5?20:density/1.5*20) + freshness*25 + confidenceRatio*25
 * - orphanNodes: nodes not referenced in any edge (from or to)
 * - brokenEdges: edges where from or to is not in nodes
 */
export function computeGraphHealth(graph: GraphIndex): GraphHealthMetrics {
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  const slugSet = new Set(graph.nodes.map((n) => n.slug));

  // Connectivity: BFS/DFS from first node
  let connectivity = 0;
  if (nodeCount > 0) {
    const adjacency = new Map<string, Set<string>>();
    for (const node of graph.nodes) {
      adjacency.set(node.slug, new Set());
    }
    for (const edge of graph.edges) {
      if (slugSet.has(edge.from) && slugSet.has(edge.to)) {
        adjacency.get(edge.from)!.add(edge.to);
        adjacency.get(edge.to)!.add(edge.from);
      }
    }

    // BFS from the first node
    const visited = new Set<string>();
    const queue: string[] = [graph.nodes[0].slug];
    visited.add(graph.nodes[0].slug);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    connectivity = visited.size / nodeCount;
  }

  // Density
  const density = edgeCount / Math.max(nodeCount, 1);

  // Freshness: simplified — if there are nodes, assume 1.0
  const freshness = nodeCount > 0 ? 1.0 : 0;

  // Confidence ratio: edges with weight >= 0.8 / total edges
  let confidenceRatio = 0;
  if (edgeCount > 0) {
    const highConfidenceEdges = graph.edges.filter((e) => (e.weight ?? 0) >= 0.8).length;
    confidenceRatio = highConfidenceEdges / edgeCount;
  }

  // Orphan nodes: nodes not referenced in any edge
  const referencedSlugs = new Set<string>();
  for (const edge of graph.edges) {
    referencedSlugs.add(edge.from);
    referencedSlugs.add(edge.to);
  }
  const orphanNodes = graph.nodes.filter((n) => !referencedSlugs.has(n.slug)).length;

  // Broken edges: edges where from or to is not in nodes
  const brokenEdges = graph.edges.filter((e) => !slugSet.has(e.from) || !slugSet.has(e.to)).length;

  // Health score
  const densityScore = density > 1.5 ? 20 : (density / 1.5) * 20;
  const healthScore = connectivity * 30 + densityScore + freshness * 25 + confidenceRatio * 25;

  return {
    healthScore,
    connectivity,
    density,
    freshness,
    confidenceRatio,
    nodeCount,
    edgeCount,
    orphanNodes,
    brokenEdges,
  };
}

/**
 * Load graph-index.json from the wiki's indices directory.
 * Canonical path: wikiRoot/.indices/graph-index.json
 * Returns null if the file doesn't exist.
 */
export async function loadGraphIndex(wikiRoot: string): Promise<GraphIndex | null> {
  const graphPath = path.join(wikiRoot, ".indices", "graph-index.json");
  try {
    const raw = await readFile(graphPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) {
      return null;
    }
    return parsed as GraphIndex;
  } catch {
    return null;
  }
}

/**
 * Save graph-index.json to the wiki's indices directory.
 * Canonical path: wikiRoot/.indices/graph-index.json
 */
export async function saveGraphIndex(wikiRoot: string, graph: GraphIndex): Promise<string> {
  const dir = path.join(wikiRoot, ".indices");
  await mkdir(dir, { recursive: true });
  const outPath = path.join(dir, "graph-index.json");
  await writeFile(outPath, JSON.stringify(graph, null, 2), "utf8");
  return outPath;
}

/**
 * Merge two graphs: overlay nodes replace base nodes with same slug.
 *
 * Edges are deduplicated by `from|to|relation`. When a duplicate is encountered,
 * the variant carrying richer evidence wins (overlay-preferred on ties). This
 * matters for v1→v2 manifest upgrades: a re-compile that supplies real evidence
 * must not be discarded just because an older empty-evidence edge was written
 * to the persisted graph first.
 */
export function mergeGraphs(base: GraphIndex, overlay: GraphIndex): GraphIndex {
  const nodeMap = new Map<string, GraphNode>();
  const nodeKey = (n: GraphNode) => n.slug ?? (n as unknown as { id?: string }).id ?? `${n.title}:${n.type}`;
  for (const n of base.nodes) nodeMap.set(nodeKey(n), n);
  for (const n of overlay.nodes) nodeMap.set(nodeKey(n), n); // overlay wins

  const edgeKey = (e: GraphEdge) => `${e.from}|${e.to}|${e.relation}`;
  const edgeMap = new Map<string, GraphEdge>();

  const evidenceLen = (e: GraphEdge) => e.evidence?.length ?? 0;

  for (const e of base.edges) {
    edgeMap.set(edgeKey(e), e);
  }
  for (const e of overlay.edges) {
    const key = edgeKey(e);
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, e);
      continue;
    }
    // Prefer the variant with more evidence; on ties, prefer overlay.
    if (evidenceLen(e) >= evidenceLen(existing)) {
      edgeMap.set(key, e);
    }
  }

  return {
    schemaVersion: GRAPH_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };
}

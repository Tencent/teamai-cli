import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { CONFIDENCE_SCORE_DEFAULTS, WIKI_CATEGORIES, type WikiCategory, type WikiConfidence, type WikiEvidence } from "./wiki-protocol.js";

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
  source?: GraphEdgeSource;
  /**
   * The codebase slug (`evidence/code/<origin>/`) this node's own per-repo
   * graph file contributed it from, stamped by the aggregation that merges
   * per-repo graphs into the global one (#912). Absent on a cross-repo edge
   * node reference and on anything aggregated before this field existed.
   * Authoritative once present: it travels with the data itself, so it
   * stays correct even if that per-repo file is later deleted, emptied, or
   * rewritten to describe something different, which reading the per-repo
   * file back out at query time cannot promise.
   */
  origin?: string;
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

const LEGACY_GRAPH_EDGE_SOURCE = "code-heuristic" as const;

export const GRAPH_EDGE_SOURCES: readonly GraphEdgeSource[] = [
  "code-ast",
  LEGACY_GRAPH_EDGE_SOURCE,
  "doc-structure",
  "doc-entity",
  "doc-triples",
  "bridge-reconcile",
  "doc-semantic",
  "manual-mapping",
];

const WIKI_CONFIDENCES = Object.keys(CONFIDENCE_SCORE_DEFAULTS) as WikiConfidence[];
const WIKI_EVIDENCE_TYPES = ["definition", "implementation", "usage", "schema", "config"] as const;
const LEGACY_GRAPH_INDEX_SCHEMA_VERSION = 1;
const LEGACY_WIKI_CONFIDENCES: Record<string, WikiConfidence> = {
  high: "EXTRACTED",
  medium: "INFERRED",
  low: "AMBIGUOUS",
};
/** A relation name `loadGraphIndex` normalizes to a current `RelationType` on load. */
export const LEGACY_RELATIONS: Record<string, RelationType> = {
  imports: "DEPENDS_ON",
};
const LEGACY_WIKI_CATEGORIES: Record<string, WikiCategory> = {
  module: "component",
};

export interface GraphEdge {
  from: string;
  to: string;
  relation: RelationType;
  evidence?: WikiEvidence[];
  weight?: number;
  /** Fine-grained semantic predicate (e.g. G6 CALLS_HTTP, USES_TABLE). */
  predicate?: string;
  source?: GraphEdgeSource;
  /**
   * Same provenance as `GraphNode.origin`. Absent on a synthesized
   * cross-repo edge — see `crossOriginPairs` — since a single string cannot
   * describe which of the two codebases it spans needs it withheld.
   */
  origin?: string;
  /**
   * Every INDEPENDENT detection's pair of origins for a synthesized
   * cross-repo edge (see `detectCrossRepoEdges`): one entry per repo-pair
   * that has ever produced this exact from/to/relation identity — the side
   * whose own import produced the match, and the side matched by label
   * lookup against the other graph. Two different codebase pairs can
   * independently produce the identical edge identity (e.g. both import
   * something matching the same third repo's component under an equally
   * generic importer slug of their own); `mergeGraphs` unions pairs on
   * collision rather than letting one overwrite the other, so none of
   * their provenance is lost. `scopeGlobalGraph` withholds the edge only
   * when EVERY pair contains a withheld origin — an edge that remains
   * independently producible by a fully-allowed pair survives even though
   * the identical edge identity was ALSO, separately, produced by a
   * withheld pair. A pair has 1 element instead of 2 when only one side
   * had an origin at detection time (the other predates tagging); the
   * field is absent entirely on any non-cross-repo edge, and captured at
   * the moment of detection since a later slug collision can silently
   * reattribute either endpoint node to a different, allowed repo without
   * this edge ever being re-examined.
   */
  crossOriginPairs?: string[][];
}

const graphEdgeKey = (edge: GraphEdge): string => JSON.stringify([edge.from, edge.to, edge.relation]);

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

const WikiEvidenceSchema = z.object({
  ref: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  commit: z.string().optional(),
  type: z.enum(WIKI_EVIDENCE_TYPES).optional(),
  note: z.string().optional(),
}).passthrough();

const WikiConfidenceSchema = z.string().transform((value, context): WikiConfidence => {
  if (WIKI_CONFIDENCES.includes(value as WikiConfidence)) return value as WikiConfidence;
  const normalized = Object.hasOwn(LEGACY_WIKI_CONFIDENCES, value)
    ? LEGACY_WIKI_CONFIDENCES[value]
    : undefined;
  if (normalized) return normalized;
  context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid wiki confidence: ${value}` });
  return z.NEVER;
});

const GraphIndexVersionSchema = z.union([
  z.literal(GRAPH_INDEX_SCHEMA_VERSION),
  z.literal(LEGACY_GRAPH_INDEX_SCHEMA_VERSION),
]).transform(() => GRAPH_INDEX_SCHEMA_VERSION);

const GraphNodeSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const node = value as Record<string, unknown>;
  const rawType = node.type ?? node.kind;
  return {
    ...node,
    slug: node.slug ?? node.id,
    type: typeof rawType === "string" && Object.hasOwn(LEGACY_WIKI_CATEGORIES, rawType)
      ? LEGACY_WIKI_CATEGORIES[rawType]
      : rawType,
    title: node.title ?? node.label,
  };
}, z.object({
  slug: z.string(),
  type: z.custom<WikiCategory>((value) => WIKI_CATEGORIES.includes(value as WikiCategory)),
  confidence: WikiConfidenceSchema,
  title: z.string(),
  domain: z.string().optional(),
  source: z.custom<GraphEdgeSource>((value) => GRAPH_EDGE_SOURCES.includes(value as GraphEdgeSource)).optional(),
  origin: z.string().optional(),
}).passthrough());

const GraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.string(),
  evidence: z.array(WikiEvidenceSchema).optional(),
  weight: z.number().optional(),
  predicate: z.string().optional(),
  source: z.custom<GraphEdgeSource>((value) => GRAPH_EDGE_SOURCES.includes(value as GraphEdgeSource)).optional(),
  origin: z.string().optional(),
  crossOriginPairs: z.array(z.array(z.string())).optional(),
}).passthrough().transform((edge, context): GraphEdge => {
  const legacyRelation = Object.hasOwn(LEGACY_RELATIONS, edge.relation)
    ? LEGACY_RELATIONS[edge.relation]
    : undefined;
  const relation = RELATION_TYPES.includes(edge.relation as RelationType)
    ? edge.relation as RelationType
    : legacyRelation;
  if (!relation) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid graph relation: ${edge.relation}` });
    return z.NEVER;
  }
  return {
    ...edge,
    relation,
    source: edge.source ?? (legacyRelation ? LEGACY_GRAPH_EDGE_SOURCE : undefined),
  };
});

const GraphIndexSchema = z.object({
  schemaVersion: GraphIndexVersionSchema,
  generatedAt: z.string(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
}).passthrough();

/** Validates and normalizes `value` as a full `GraphIndex` (legacy field fallbacks, relation/confidence normalization included); `null` if it doesn't conform. */
export function parseGraphIndex(value: unknown): GraphIndex | null {
  const result = GraphIndexSchema.safeParse(value);
  return result.success ? result.data as GraphIndex : null;
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
  code: "node.duplicate" | "edge.duplicate" | "edge.missing_node" | "edge.self_loop" | "edge.invalid_weight";
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  issues: GraphValidationIssue[];
}

/**
 * Validate a graph index for structural correctness:
 * - No duplicate node slugs
 * - No duplicate edge identities
 * - All edge endpoints reference existing nodes
 * - No self-loop edges
 * - Edge weights (if provided) are between 0 and 1
 */
export function validateGraph(graph: GraphIndex): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  const slugs = new Set<string>();
  const edgeKeys = new Set<string>();

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
    const edgeKey = graphEdgeKey(edge);
    if (edgeKeys.has(edgeKey)) {
      issues.push({
        code: "edge.duplicate",
        message: `Duplicate edge: ${edge.from} -> ${edge.to} (${edge.relation})`,
      });
    }
    edgeKeys.add(edgeKey);
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
    return parseGraphIndex(parsed);
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

  const edgeMap = new Map<string, GraphEdge>();

  const evidenceLen = (e: GraphEdge) => e.evidence?.length ?? 0;
  // Two DIFFERENT codebase PAIRS can independently produce a synthesized
  // cross-repo edge with the identical `from|to|relation` identity (e.g.
  // repo X and repo Y both import something matching the same third repo
  // Z's component under an equally generic, unqualified importer slug of
  // their own). Whichever side "wins" the tie-break below must not
  // silently erase the OTHER side's `crossOriginPairs` — overwriting lost
  // that provenance entirely, which both made scopeGlobalGraph's later
  // withheld-origin check depend on merge order AND collapsed two
  // independent repo-pairs into one, making it impossible to tell that an
  // edge withheld via one pair might still be valid via another, fully
  // allowed one (#974 review rounds 14 P2 / 15 P2): union the pair lists
  // instead (deduping an identical pair), so the edge keeps a record of
  // every repo-pair that has ever independently produced this exact
  // relationship, regardless of which one happened to merge last.
  const mergeCrossOriginPairs = (a?: string[][], b?: string[][]): string[][] | undefined => {
    if (!a && !b) return undefined;
    const seen = new Set<string>();
    const merged: string[][] = [];
    for (const pair of [...(a ?? []), ...(b ?? [])]) {
      const key = JSON.stringify([...pair].sort());
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(pair);
    }
    return merged;
  };
  // An edge's plain `origin` is its own one-element provenance pair, same as
  // `scopeGlobalGraph` already treats it (#974 review round 17 P2) — folded
  // in here too, so the LOSING side of a collision doesn't lose it outright.
  // Without this, a cross-repo edge (crossOriginPairs, no origin) winning an
  // equal-evidence tie against an allowed repo's own ordinary edge (origin,
  // no crossOriginPairs) kept only the winner's own fields — the loser's
  // `origin` was never read at all, so it vanished from the merged edge
  // entirely rather than surviving as one more independent pair (#974
  // review round 18 P2).
  const edgePairs = (e: GraphEdge): string[][] | undefined => {
    const pairs = [...(e.crossOriginPairs ?? []), ...(e.origin ? [[e.origin]] : [])];
    return pairs.length > 0 ? pairs : undefined;
  };

  for (const e of base.edges) {
    edgeMap.set(graphEdgeKey(e), e);
  }
  for (const e of overlay.edges) {
    const key = graphEdgeKey(e);
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, e);
      continue;
    }
    // Prefer the variant with more evidence; on ties, prefer overlay.
    const winner = evidenceLen(e) >= evidenceLen(existing) ? e : existing;
    const crossOriginPairs = mergeCrossOriginPairs(edgePairs(existing), edgePairs(e));
    edgeMap.set(key, crossOriginPairs ? { ...winner, crossOriginPairs } : winner);
  }

  return {
    schemaVersion: GRAPH_INDEX_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };
}

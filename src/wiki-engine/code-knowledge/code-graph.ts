import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { type CodeFact } from "./code-extractors.js";
import {
  type GraphIndex,
  type GraphNode,
  type GraphEdge,
  createGraphIndex,
  addNode,
  addEdge,
  saveGraphIndex,
  GRAPH_INDEX_SCHEMA_VERSION,
} from "../core/graph-index.schema.js";

/**
 * @deprecated Use GraphIndex directly. Kept for backward compatibility during migration.
 */
export type CodeGraphIndex = GraphIndex;

export async function writeCodeGraph(wikiRoot: string, project: string, facts: CodeFact[]): Promise<{ graph: GraphIndex; path: string }> {
  const graph = buildCodeGraph(facts);
  const graphPath = await saveGraphIndex(wikiRoot, graph);
  return { graph, path: graphPath };
}

/**
 * Build a GraphIndex from raw code facts.
 * Nodes: one per unique component/interface/config/error fact.
 * Edges: DEPENDS_ON edges from relation facts (internal imports only).
 */
export function buildCodeGraph(facts: CodeFact[]): GraphIndex {
  const nodes: GraphNode[] = facts
    .filter((fact) => fact.kind !== "relation")
    .map((fact) => ({
      slug: `${fact.kind}/${fact.name}`,
      type: mapFactKindToCategory(fact.kind),
      confidence: fact.confidence === "EXTRACTED" ? "EXTRACTED" as const : "INFERRED" as const,
      title: fact.name,
      domain: path.dirname(fact.file).split('/')[0] || undefined,
    }));

  const nodeFiles = new Set(facts.filter(f => f.kind !== "relation").map(f => f.file));
  const edges: GraphEdge[] = facts
    .filter((fact) => fact.kind === "relation")
    .flatMap((fact) => {
      const targets = [...nodeFiles].filter((file) => relationMayTarget(fact.name, file));
      return targets.map((file) => ({
        from: fact.file,
        to: file,
        relation: "DEPENDS_ON" as const,
        weight: 0.8,
        source: "code-heuristic" as const,
      }));
    });

  return createGraphIndex(nodes, edges);
}

function relationMayTarget(importTarget: string, file: string): boolean {
  const normalized = importTarget.replace(/^\.\//u, "").replace(/\.\.\//g, "").replace(/\.(ts|tsx|js|jsx)$/u, "");
  if (normalized.length < 3) return false; // Skip very short matches to reduce false positives
  return file.includes(normalized);
}

function mapFactKindToCategory(kind: string): "component" | "interface" | "config" | "error" {
  switch (kind) {
    case "component": return "component";
    case "interface": return "interface";
    case "config": return "config";
    case "error": return "error";
    default: return "component";
  }
}

// ─── Unified Graph Compiler: build a full GraphIndex from component-level data ──

export interface CodeComponent {
  slug: string;
  title: string;
  category: string;
  imports: string[];
  exports: string[];
  calls: string[];
}

/**
 * Build a full GraphIndex from high-level code components.
 *
 * Creates DEPENDS_ON edges from imports (component A imports component B),
 * and REFERENCES edges from call chains (component A calls into component B).
 */
export function buildCodeGraphIndex(components: Array<{
  slug: string;
  title: string;
  category: string;
  imports: string[];
  exports: string[];
  calls: string[];
}>): GraphIndex {
  const nodes: GraphNode[] = components.map((c) => ({
    slug: c.slug,
    type: mapCategoryToWikiCategory(c.category),
    confidence: "EXTRACTED" as const,
    title: c.title,
  }));

  const edges: GraphEdge[] = [];
  const edgeSet = new Set<string>();

  // Build a lookup: export name → component slug
  const exportIndex = new Map<string, string>();
  for (const comp of components) {
    for (const exp of comp.exports) {
      exportIndex.set(exp, comp.slug);
    }
  }

  // Build DEPENDS_ON edges from imports
  for (const comp of components) {
    for (const imp of comp.imports) {
      const targetSlug = exportIndex.get(imp) ?? findComponentBySlugMatch(imp, components);
      if (targetSlug && targetSlug !== comp.slug) {
        const key = `${comp.slug}|${targetSlug}|DEPENDS_ON`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({
            from: comp.slug,
            to: targetSlug,
            relation: "DEPENDS_ON",
            weight: 0.9,
          });
        }
      }
    }
  }

  // Build REFERENCES edges from call chains
  for (const comp of components) {
    for (const call of comp.calls) {
      const targetSlug = exportIndex.get(call) ?? findComponentBySlugMatch(call, components);
      if (targetSlug && targetSlug !== comp.slug) {
        const key = `${comp.slug}|${targetSlug}|REFERENCES`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({
            from: comp.slug,
            to: targetSlug,
            relation: "REFERENCES",
            weight: 0.7,
          });
        }
      }
    }
  }

  return createGraphIndex(nodes, edges);
}

/**
 * Try to match an import/call target to a component slug by substring matching.
 */
function findComponentBySlugMatch(
  target: string,
  components: Array<{ slug: string }>
): string | undefined {
  const normalized = target.toLowerCase().replace(/[^a-z0-9]/g, "");
  return components.find((c) => {
    const slugNorm = c.slug.toLowerCase().replace(/[^a-z0-9]/g, "");
    return slugNorm.includes(normalized) || normalized.includes(slugNorm);
  })?.slug;
}

/**
 * Map a freeform category string to a WikiCategory type.
 */
function mapCategoryToWikiCategory(category: string): "component" | "interface" | "config" | "rule" | "process" | "decision" | "mapping" {
  switch (category.toLowerCase()) {
    case "component":
    case "module":
    case "service":
      return "component";
    case "interface":
    case "api":
    case "type":
      return "interface";
    case "config":
    case "configuration":
      return "config";
    case "rule":
    case "validation":
      return "rule";
    case "process":
    case "workflow":
      return "process";
    case "decision":
      return "decision";
    default:
      return "component";
  }
}

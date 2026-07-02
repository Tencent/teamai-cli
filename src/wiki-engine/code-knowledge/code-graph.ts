import path from "node:path";

import { type CodeFact } from "./code-extractors.js";
import {
  type GraphIndex,
  type GraphNode,
  type GraphEdge,
  createGraphIndex,
} from "../core/graph-index.schema.js";

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

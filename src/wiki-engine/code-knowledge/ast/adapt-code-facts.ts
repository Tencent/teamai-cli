import { type CodeFact, mapKindToEvidenceType } from "../code-extractors.js";
import type { AstImport, StructuralEdge } from "./types.js";

type UnresolvedGap = { kind: string; message: string; sources: string[] };

export function structuralEdgesToCodeFacts(edges: StructuralEdge[]): CodeFact[] {
  const facts: CodeFact[] = [];
  for (const edge of edges) {
    const evidence = edge.evidence[0];
    const lineStart = evidence?.lineStart ?? 1;
    const lineEnd = evidence?.lineEnd ?? lineStart;
    const name = edge.to;

    facts.push({
      kind: "relation",
      name,
      file: edge.from,
      lineStart,
      lineEnd,
      detail: `${edge.relation} → ${edge.to} (${edge.source})`,
      confidence: edge.confidence,
      evidenceType: mapKindToEvidenceType("relation")
    });
  }
  return facts;
}

export function unresolvedImportsToGaps(imports: AstImport[], resolvedKeys: Set<string>): UnresolvedGap[] {
  const gaps: UnresolvedGap[] = [];
  for (const imp of imports) {
    const key = `${imp.fromFile}:${imp.line}`;
    if (resolvedKeys.has(key)) continue;
    if (!imp.specifier.startsWith(".") && !imp.specifier.startsWith("/") && !imp.specifier.startsWith("@")) {
      gaps.push({
        kind: "EXTERNAL_IMPORT",
        message: `External package import not resolved: ${imp.specifier}`,
        sources: [`${imp.fromFile}:${imp.line}`]
      });
    } else {
      gaps.push({
        kind: "UNRESOLVED_IMPORT",
        message: `Could not resolve import "${imp.specifier}" from ${imp.fromFile}`,
        sources: [`${imp.fromFile}:${imp.line}`]
      });
    }
  }
  return gaps;
}


import { type CodeCollectedFile } from "./code-collector.js";
import { extractForLanguage } from "./extractors/index.js";

export type CodeFactKind = "component" | "interface" | "config" | "error" | "data" | "style" | "relation";

export type CodeEvidenceType = "definition" | "implementation" | "usage" | "schema" | "config";

/**
 * Map a CodeFactKind to a WikiEvidenceType.
 */
export function mapKindToEvidenceType(kind: CodeFactKind): CodeEvidenceType {
  switch (kind) {
    case "component":
    case "interface":
    case "error":
      return "definition";
    case "config":
      return "config";
    case "data":
      return "schema";
    case "relation":
      return "usage";
    case "style":
      return "definition";
  }
}

export interface CodeFact {
  kind: CodeFactKind;
  name: string;
  file: string;
  lineStart: number;
  lineEnd?: number;
  detail: string;
  confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  evidenceType?: CodeEvidenceType;
}

/**
 * Extract code facts from collected files.
 * Groups files by language, then dispatches to language-specific extractors.
 */
export function extractCodeFacts(files: CodeCollectedFile[]): CodeFact[] {
  const byLanguage = groupByLanguage(files);
  const facts: CodeFact[] = [];
  for (const [language, langFiles] of byLanguage) {
    facts.push(...extractForLanguage(language, langFiles));
  }
  return dedupe(facts);
}

function groupByLanguage(files: CodeCollectedFile[]): Map<string, CodeCollectedFile[]> {
  const map = new Map<string, CodeCollectedFile[]>();
  for (const file of files) {
    const group = map.get(file.language) ?? [];
    group.push(file);
    map.set(file.language, group);
  }
  return map;
}

function dedupe(facts: CodeFact[]): CodeFact[] {
  const seen = new Set<string>();
  const result: CodeFact[] = [];
  for (const fact of facts) {
    const key = `${fact.kind}:${fact.name}:${fact.file}:${fact.lineStart}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(fact);
    }
  }
  return result;
}

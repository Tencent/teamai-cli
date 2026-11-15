import { type CodeCollectedFile } from "./code-collector.js";
import { type CodeEvidenceType, type CodeFactKind } from "./code-fact-kind.js";
import { extractForLanguage, type ExtractorContext } from "./extractors/index.js";

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
 * Relations that carry extraction metadata for the incremental layer — a
 * Scala wildcard's package, a file's top-level declarations — rather than a
 * dependency. Evidence pages and gap detection skip them, and the graph
 * builder resolves none of them.
 */
export function isMetadataRelation(name: string): boolean {
  return /^scala-(?:wildcard|decl):/u.test(name);
}

/**
 * Extract code facts from collected files.
 * Groups files by language, then dispatches to language-specific extractors.
 * `context` — the run's full file list and the previous run's declarations —
 * lets extractors resolve cross-file constructs (see ExtractorContext).
 */
export function extractCodeFacts(files: CodeCollectedFile[], context?: ExtractorContext): CodeFact[] {
  const byLanguage = groupByLanguage(files);
  const allFacts: CodeFact[] = [];
  const effectiveContext: ExtractorContext = context ?? { allFiles: files, priorDeclarations: new Map() };

  for (const [language, langFiles] of byLanguage) {
    allFacts.push(...extractForLanguage(language, langFiles, effectiveContext));
  }

  // Deduplicate facts by kind:name:file (same symbol in same file only kept once)
  const seen = new Set<string>();

  const deduped = allFacts.filter(f => {
    if (f.kind === 'relation') return true;
    const key = `${f.kind}:${f.name}:${f.file}`;

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });

  return deduped;
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

import type { CodeFact } from "../code-extractors.js";

function factKey(fact: CodeFact): string {
  return `${fact.kind}:${fact.name}:${fact.file}:${fact.lineStart}`;
}

/**
 * Merge AST-derived facts with heuristic facts. AST wins on duplicate keys;
 * heuristic relation facts at the same file:line as an AST relation are dropped.
 */
export function mergeCodeFacts(astFacts: CodeFact[], heuristicFacts: CodeFact[]): CodeFact[] {
  const astRelationLines = new Set(
    astFacts.filter((f) => f.kind === "relation").map((f) => `${f.file}:${f.lineStart}`)
  );

  const astKeys = new Set(astFacts.map(factKey));
  const filteredHeuristic = heuristicFacts.filter((fact) => {
    if (fact.kind === "relation" && astRelationLines.has(`${fact.file}:${fact.lineStart}`)) {
      return false;
    }
    return !astKeys.has(factKey(fact));
  });

  const merged = [...astFacts, ...filteredHeuristic];
  const seen = new Set<string>();
  const result: CodeFact[] = [];
  for (const fact of merged) {
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}


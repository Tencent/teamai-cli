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

export interface EdgeConflict {
  from: string;
  toHeuristic: string;
  toAst: string;
  relation: string;
}

export function findConflictingEdges(
  astFacts: CodeFact[],
  heuristicFacts: CodeFact[]
): EdgeConflict[] {
  const conflicts: EdgeConflict[] = [];
  const heuristicByLine = new Map(
    heuristicFacts
      .filter((f) => f.kind === "relation")
      .map((f) => [`${f.file}:${f.lineStart}`, f] as const)
  );

  for (const ast of astFacts.filter((f) => f.kind === "relation")) {
    const heur = heuristicByLine.get(`${ast.file}:${ast.lineStart}`);
    if (heur && heur.name !== ast.name && heur.confidence === "EXTRACTED" && ast.confidence === "AMBIGUOUS") {
      conflicts.push({
        from: ast.file,
        toHeuristic: heur.name,
        toAst: ast.name,
        relation: "DEPENDS_ON"
      });
    }
  }

  return conflicts;
}

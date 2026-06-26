import type { CodeCollectedFile } from './code-knowledge/code-collector.js';
import type { CodeFact } from './code-knowledge/code-extractors.js';

export type CallChainLayer = "entry" | "orchestration" | "service" | "data";

export interface CallChainStep {
  layer: CallChainLayer;
  file: string;
  lineStart: number;
  symbol: string;
  callsTo: string[]; // symbols it calls
}

export interface CallChain {
  entryPoint: string;
  steps: CallChainStep[];
  depth: number;
}

// --- Layer classification heuristics ---

const ENTRY_PATTERNS = [
  /handler/i,
  /route/i,
  /controller/i,
  /endpoint/i,
  /main\.(ts|go|py|rs|java)$/,
  /server\.(ts|go|py|rs|java)$/,
  /app\.(ts|go|py|rs|java)$/,
];

const ORCHESTRATION_PATTERNS = [
  /workflow/i,
  /saga/i,
  /dispatcher/i,
  /orchestrat/i,
  /coordinator/i,
  /pipeline/i,
  /scheduler/i,
  /command/i,
];

const DATA_PATTERNS = [
  /\bdb\b/i,
  /repository/i,
  /\bdao\b/i,
  /model/i,
  /store/i,
  /database/i,
  /migration/i,
  /schema/i,
  /query/i,
  /entity/i,
];

function classifyLayer(filePath: string, symbol: string): CallChainLayer {
  const combined = `${filePath} ${symbol}`;

  if (ENTRY_PATTERNS.some((p) => p.test(combined))) return "entry";
  if (ORCHESTRATION_PATTERNS.some((p) => p.test(combined))) return "orchestration";
  if (DATA_PATTERNS.some((p) => p.test(combined))) return "data";
  return "service";
}

/**
 * Trace call chains from entry points through the codebase.
 * Simplified version of codebase-mind's 3-layer penetration analysis.
 *
 * Note: traces import/dependency edges, not runtime call sites. Output represents static dependency paths.
 *
 * 1. Find entry points (handlers, routes, main functions)
 * 2. For each entry point, trace through relations (imports/calls)
 * 3. Classify each step by layer (entry -> orchestration -> service -> data)
 * 4. Return chains up to depth 4
 */
export function traceCallChains(facts: CodeFact[], files: CodeCollectedFile[]): CallChain[] {
  const MAX_DEPTH = 4;

  // Build lookup structures
  const relationsByFile = buildRelationsByFile(facts);
  const componentsByFile = buildComponentsByFile(facts);
  const filesByModule = buildFilesByModule(files);

  // Find entry points
  const entryPoints = findEntryPoints(facts, files);

  const chains: CallChain[] = [];

  for (const entry of entryPoints) {
    const visited = new Set<string>();
    const steps: CallChainStep[] = [];

    traceFromEntry(entry.file, entry.symbol, 0);

    if (steps.length > 0) {
      chains.push({
        entryPoint: `${entry.symbol} (${entry.file})`,
        steps,
        depth: steps.length,
      });
    }

    function traceFromEntry(file: string, symbol: string, depth: number): void {
      if (depth >= MAX_DEPTH) return;

      const key = `${file}:${symbol}`;
      if (visited.has(key)) return;
      visited.add(key);

      const layer = classifyLayer(file, symbol);
      const relations = relationsByFile.get(file) ?? [];
      const callsTo: string[] = [];

      // Find what this file/symbol calls
      for (const relation of relations) {
        const targetFiles = resolveRelationTarget(relation.name, filesByModule);
        for (const targetFile of targetFiles) {
          const targetComponents = componentsByFile.get(targetFile) ?? [];
          for (const comp of targetComponents) {
            callsTo.push(comp.name);
          }
        }
      }

      steps.push({
        layer,
        file,
        lineStart: entry.lineStart,
        symbol,
        callsTo: callsTo.slice(0, 10),
      });

      // Recurse into called modules
      for (const relation of relations.slice(0, 5)) {
        const targetFiles = resolveRelationTarget(relation.name, filesByModule);
        for (const targetFile of targetFiles.slice(0, 2)) {
          const targetComponents = componentsByFile.get(targetFile) ?? [];
          const primary = targetComponents[0];
          if (primary) {
            traceFromEntry(targetFile, primary.name, depth + 1);
          }
        }
      }
    }
  }

  // Sort chains by depth (deepest first) for more useful output
  chains.sort((a, b) => b.depth - a.depth);
  return chains;
}

interface EntryPoint {
  file: string;
  symbol: string;
  lineStart: number;
}

function findEntryPoints(facts: CodeFact[], files: CodeCollectedFile[]): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];
  const seen = new Set<string>();

  // From facts: look for handler/route components
  for (const fact of facts) {
    if (fact.kind !== "component" && fact.kind !== "interface") continue;

    const isEntry =
      ENTRY_PATTERNS.some((p) => p.test(fact.file)) ||
      ENTRY_PATTERNS.some((p) => p.test(fact.name)) ||
      /^(GET|POST|PUT|DELETE|PATCH)\s+\//u.test(fact.name);

    if (isEntry) {
      const key = `${fact.file}:${fact.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        entryPoints.push({ file: fact.file, symbol: fact.name, lineStart: fact.lineStart });
      }
    }
  }

  // From files: look for key files that are likely entry points
  for (const file of files) {
    if (!file.isKeyFile) continue;
    if (ENTRY_PATTERNS.some((p) => p.test(file.relativePath))) {
      const key = `${file.relativePath}:main`;
      if (!seen.has(key)) {
        seen.add(key);
        entryPoints.push({ file: file.relativePath, symbol: "main", lineStart: 1 });
      }
    }
  }

  return entryPoints;
}

function buildRelationsByFile(facts: CodeFact[]): Map<string, CodeFact[]> {
  const map = new Map<string, CodeFact[]>();
  for (const fact of facts) {
    if (fact.kind !== "relation") continue;
    const group = map.get(fact.file) ?? [];
    group.push(fact);
    map.set(fact.file, group);
  }
  return map;
}

function buildComponentsByFile(facts: CodeFact[]): Map<string, CodeFact[]> {
  const map = new Map<string, CodeFact[]>();
  for (const fact of facts) {
    if (fact.kind !== "component") continue;
    const group = map.get(fact.file) ?? [];
    group.push(fact);
    map.set(fact.file, group);
  }
  return map;
}

function buildFilesByModule(files: CodeCollectedFile[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const file of files) {
    // Index by various forms of the path for flexible resolution
    const relativePath = file.relativePath;
    const withoutExt = relativePath.replace(/\.[^.]+$/, "");
    const basename = withoutExt.split("/").pop() ?? "";

    for (const key of [relativePath, withoutExt, basename]) {
      if (key) {
        const group = map.get(key) ?? [];
        group.push(relativePath);
        map.set(key, group);
      }
    }
  }
  return map;
}

function resolveRelationTarget(importPath: string, filesByModule: Map<string, string[]>): string[] {
  // Normalize import path
  const normalized = importPath
    .replace(/^\.\//, "")
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/, "");

  // Try exact match first
  const exact = filesByModule.get(normalized);
  if (exact) return exact;

  // Try with common patterns
  const withIndex = `${normalized}/index`;
  const indexMatch = filesByModule.get(withIndex);
  if (indexMatch) return indexMatch;

  // Try basename only
  const basename = normalized.split("/").pop() ?? "";
  const baseMatch = filesByModule.get(basename);
  if (baseMatch) return baseMatch;

  return [];
}

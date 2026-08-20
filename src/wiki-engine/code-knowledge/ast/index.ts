import { createRequire } from "node:module";

import type { CodeCollectedFile } from "../code-collector.js";
import { type CodeFact } from "../code-extractors.js";
import { structuralEdgesToCodeFacts, unresolvedImportsToGaps } from "./adapt-code-facts.js";
import { callResolutionWeight, resolveCallSites } from "./call-resolver.js";
import { buildFileExistenceChecker, resolveImportSpecifier } from "./import-resolver.js";
import { ensureAstReady } from "./parser-registry.js";
import type { AstExtractionGap, StructuralEdge, StructuralGraphResult } from "./types.js";
import { isAstParseableFile, walkFile } from "./walk.js";

const require = createRequire(import.meta.url);

let astAvailability: boolean | undefined;

/** Whether the WASM tree-sitter runtime and grammars can be loaded (honors TEAMAI_SKIP_AST). */
export function astAvailable(): boolean {
  if (process.env.TEAMAI_SKIP_AST === "1") {
    return false;
  }
  if (astAvailability !== undefined) {
    return astAvailability;
  }
  try {
    require.resolve("web-tree-sitter");
    require.resolve("web-tree-sitter/tree-sitter.wasm");
    require.resolve("tree-sitter-wasms/out/tree-sitter-typescript.wasm");
    astAvailability = true;
  } catch {
    astAvailability = false;
  }
  return astAvailability;
}

export interface ExtractStructuralGraphOptions {
  repoRoot: string;
  files: CodeCollectedFile[];
}

export async function extractStructuralGraph(
  options: ExtractStructuralGraphOptions
): Promise<StructuralGraphResult> {
  await ensureAstReady();

  const { repoRoot, files } = options;
  const symbols: StructuralGraphResult["symbols"] = [];
  const imports: StructuralGraphResult["imports"] = [];
  const callSites: StructuralGraphResult["callSites"] = [];
  const gaps: AstExtractionGap[] = [];
  const edges: StructuralEdge[] = [];

  const knownFiles = new Set(files.map((f) => f.relativePath));
  const fileExists = await buildFileExistenceChecker(repoRoot, knownFiles);

  let filesParsed = 0;
  let filesSkipped = 0;

  for (const file of files) {
    if (!isAstParseableFile(file.relativePath)) {
      filesSkipped++;
      continue;
    }
    const walked = walkFile(file);
    if (walked.parseErrors.length > 0) {
      for (const err of walked.parseErrors) {
        gaps.push({ kind: "PARSE_SKIP", message: err, sources: [file.relativePath] });
      }
      if (walked.symbols.length === 0 && walked.imports.length === 0) {
        filesSkipped++;
        continue;
      }
    }
    filesParsed++;
    symbols.push(...walked.symbols);
    imports.push(...walked.imports);
    callSites.push(...walked.callSites);
  }

  const symbolsByFile = new Map<string, typeof symbols>();
  for (const sym of symbols) {
    const list = symbolsByFile.get(sym.file) ?? [];
    list.push(sym);
    symbolsByFile.set(sym.file, list);
  }

  const resolvedImports = new Map<string, Awaited<ReturnType<typeof resolveImportSpecifier>>>();
  const resolvedKeys = new Set<string>();

  for (const imp of imports) {
    const key = `${imp.fromFile}:${imp.line}`;
    if (imp.isTypeOnly) continue;

    const resolved = await resolveImportSpecifier(repoRoot, imp.fromFile, imp.specifier, fileExists);
    resolvedImports.set(key, resolved);
    if (resolved) {
      resolvedKeys.add(key);
      edges.push({
        from: imp.fromFile,
        to: resolved.targetFile,
        relation: "DEPENDS_ON",
        source: "code-ast",
        weight: resolved.confidence === "EXTRACTED" ? 0.9 : 0.5,
        confidence: resolved.confidence,
        evidence: [
          {
            ref: imp.fromFile,
            lineStart: imp.line,
            lineEnd: imp.line,
            note: `resolved import ${imp.specifier}`
          }
        ]
      });
    }
  }

  gaps.push(...unresolvedImportsToGaps(imports.filter((i) => !i.isTypeOnly), resolvedKeys));

  const resolvedCalls = resolveCallSites(callSites, imports, resolvedImports, symbolsByFile);

  for (const call of resolvedCalls) {
    if (!call.resolvedTargetFile || call.resolvedTargetFile === call.fromFile) {
      continue;
    }

    edges.push({
      from: call.fromFile,
      to: call.resolvedTargetFile,
      relation: "REFERENCES",
      source: "code-ast",
      weight: callResolutionWeight(call.confidence),
      confidence: call.confidence,
      evidence: [
        {
          ref: call.fromFile,
          lineStart: call.line,
          lineEnd: call.line,
          note: `call ${call.calleeText}`
        }
      ]
    });
  }

  const stats = {
    symbols: symbols.length,
    imports: imports.length,
    importsResolved: resolvedKeys.size,
    calls: callSites.length,
    callsResolved: resolvedCalls.filter((c) => c.resolvedTargetFile).length,
    edges: edges.length,
    filesParsed,
    filesSkipped
  };

  return {
    symbols,
    imports,
    callSites: resolvedCalls,
    edges,
    gaps,
    stats
  };
}

export async function extractStructuralGraphAsFacts(
  options: ExtractStructuralGraphOptions
): Promise<{ facts: CodeFact[]; result: StructuralGraphResult }> {
  const result = await extractStructuralGraph(options);
  const facts = structuralEdgesToCodeFacts(result.edges);
  return { facts, result };
}

export function formatAstStatsSummary(stats: StructuralGraphResult["stats"]): string {
  const imports = `${stats.imports} imports (${stats.importsResolved} resolved)`;
  const calls = `${stats.calls} calls (${stats.callsResolved} resolved)`;
  return `ast: ${stats.symbols} symbols, ${imports}, ${calls}, ${stats.edges} edges`;
}

export * from "./types.js";
export { mergeCodeFacts } from "./merge-edges.js";

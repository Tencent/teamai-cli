import { createRequire } from "node:module";

import { Language, Parser, Query } from "web-tree-sitter";

import { GO_AST_QUERY_SOURCE, PYTHON_AST_QUERY_SOURCE, TS_AST_QUERY_SOURCE } from "./queries.js";

export type GrammarVariant = "typescript" | "tsx" | "python" | "go";

const require = createRequire(import.meta.url);

const GRAMMAR_WASM: Record<GrammarVariant, string> = {
  typescript: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  python: "tree-sitter-wasms/out/tree-sitter-python.wasm",
  go: "tree-sitter-wasms/out/tree-sitter-go.wasm"
};

const QUERY_SOURCE: Record<GrammarVariant, string> = {
  typescript: TS_AST_QUERY_SOURCE,
  tsx: TS_AST_QUERY_SOURCE,
  python: PYTHON_AST_QUERY_SOURCE,
  go: GO_AST_QUERY_SOURCE
};

let parserInstance: Parser | undefined;
let initPromise: Promise<void> | undefined;
const languages = new Map<GrammarVariant, Language>();
const queries = new Map<GrammarVariant, Query>();

/**
 * Initialize the WASM runtime, parser, grammars and queries once.
 *
 * Idempotent: concurrent and repeat callers await the same in-flight promise.
 * Must be awaited before any synchronous getParser/getLanguage/getQuery call.
 */
export async function ensureAstReady(): Promise<void> {
  if (!initPromise) {
    initPromise = initAst();
  }
  return initPromise;
}

async function initAst(): Promise<void> {
  await Parser.init({
    locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm")
  });
  parserInstance = new Parser();
  for (const variant of Object.keys(GRAMMAR_WASM) as GrammarVariant[]) {
    const language = await Language.load(require.resolve(GRAMMAR_WASM[variant]));
    languages.set(variant, language);
    queries.set(variant, new Query(language, QUERY_SOURCE[variant]));
  }
}

/** Lazy singleton parser. ensureAstReady() must have resolved first. */
export function getParser(): Parser {
  if (!parserInstance) {
    throw new Error("AST parser not initialized; call ensureAstReady() first");
  }
  return parserInstance;
}

export function grammarForExtension(ext: string): GrammarVariant | undefined {
  switch (ext.toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".py":
    case ".pyi":
      return "python";
    case ".go":
      return "go";
    default:
      return undefined;
  }
}

export function getLanguage(variant: GrammarVariant): Language {
  const language = languages.get(variant);
  if (!language) {
    throw new Error(`No tree-sitter grammar loaded for variant: ${variant}`);
  }
  return language;
}

export function getQuery(variant: GrammarVariant): Query {
  const query = queries.get(variant);
  if (!query) {
    throw new Error(`No tree-sitter query registered for variant: ${variant}`);
  }
  return query;
}

export function resetParserRegistryForTests(): void {
  parserInstance = undefined;
  initPromise = undefined;
  languages.clear();
  queries.clear();
}

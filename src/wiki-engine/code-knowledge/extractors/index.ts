import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact } from "../code-extractors.js";
import { extractToml, extractSql } from "./config.js";
import { extractGo } from "./go.js";
import { extractJava } from "./java.js";
import { extractPython } from "./python.js";
import { extractRust } from "./rust.js";
import { extractScala } from "./scala.js";
import { extractSwift } from "./swift.js";
import { extractTypescript } from "./typescript.js";

/** What an extractor may need beyond its own language batch. */
export interface ExtractorContext {
  /** Every collected file of the run, all languages — a Scala wildcard imports Java files just as freely. */
  allFiles: CodeCollectedFile[];
  /**
   * The symbol names each file declares, from the previous run's facts. An
   * incremental run re-extracts only changed files, so unchanged files are
   * known by their cached declarations alone.
   */
  priorDeclarations: Map<string, Set<string>>;
}

type LanguageExtractor = (files: CodeCollectedFile[], context?: ExtractorContext) => CodeFact[];

/**
 * Registry mapping language identifiers to their specialized extractors.
 */
const EXTRACTOR_REGISTRY: Record<string, LanguageExtractor> = {
  typescript: extractTypescript,
  javascript: extractTypescript, // JS uses the same TS extractor (compatible patterns)
  go: extractGo,
  python: extractPython,
  java: extractJava,
  rust: extractRust,
  scala: extractScala,
  swift: extractSwift,
  toml: extractToml,
  sql: extractSql,
};

/**
 * Dispatch extraction to the appropriate language-specific extractor.
 * `context` — the run's full file list and the previous run's declarations —
 * lets an extractor resolve cross-language and cross-file constructs.
 * Falls back to an empty array for unsupported languages (json, yaml, text, etc.).
 */
export function extractForLanguage(language: string, files: CodeCollectedFile[], context?: ExtractorContext): CodeFact[] {
  const extractor = EXTRACTOR_REGISTRY[language];
  if (!extractor) {
    return [];
  }
  return extractor(files, context);
}

/**
 * Returns the list of languages with registered extractors.
 */
export function supportedLanguages(): string[] {
  return Object.keys(EXTRACTOR_REGISTRY);
}

export { extractGo } from "./go.js";
export { extractJava } from "./java.js";
export { extractPython } from "./python.js";
export { extractRust } from "./rust.js";
export { extractScala, SCALA_DECL_PREFIX, SCALA_WILDCARD_PREFIX } from "./scala.js";
export { extractSwift } from "./swift.js";
export { extractTypescript } from "./typescript.js";

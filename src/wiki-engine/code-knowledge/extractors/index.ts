import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact } from "../code-extractors.js";
import { extractToml, extractSql } from "./config.js";
import { extractGo } from "./go.js";
import { extractJava } from "./java.js";
import { extractPython } from "./python.js";
import { extractRust } from "./rust.js";
import { extractTypescript } from "./typescript.js";

type LanguageExtractor = (files: CodeCollectedFile[]) => CodeFact[];

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
  toml: extractToml,
  sql: extractSql,
};

/**
 * Dispatch extraction to the appropriate language-specific extractor.
 * Falls back to an empty array for unsupported languages (json, yaml, text, etc.).
 */
export function extractForLanguage(language: string, files: CodeCollectedFile[]): CodeFact[] {
  const extractor = EXTRACTOR_REGISTRY[language];
  if (!extractor) {
    return [];
  }
  return extractor(files);
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
export { extractTypescript } from "./typescript.js";

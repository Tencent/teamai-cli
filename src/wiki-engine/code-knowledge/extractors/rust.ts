import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Rust extractor.
 * Extracts structs, impls, modules, traits, HTTP handlers, configs, errors, and use relations.
 */
export function extractRust(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    let pendingAttributes: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Collect attributes for context
      const attrMatch = /^\s*#\[([^\]]+)\]/u.exec(line);
      if (attrMatch) {
        pendingAttributes.push(attrMatch[1]);
        // Don't continue — attribute line might also contain other patterns
      }

      // --- Components ---
      const pubStruct = /^pub(?:\(crate\))?\s+struct\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (pubStruct) {
        facts.push(makeFact("component", pubStruct[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const implBlock = /^impl(?:<[^>]*>)?\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (implBlock && !/\bfor\b/u.test(line)) {
        facts.push(makeFact("component", `impl:${implBlock[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const modDecl = /^pub(?:\(crate\))?\s+mod\s+([a-z][a-z0-9_]*)/u.exec(line);
      if (modDecl) {
        facts.push(makeFact("component", `mod:${modDecl[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const privateMod = /^mod\s+([a-z][a-z0-9_]*)\s*;/u.exec(line);
      if (privateMod) {
        facts.push(makeFact("component", `mod:${privateMod[1]}`, file.relativePath, lineNumber, line, "INFERRED"));
      }

      const pubFn = /^pub(?:\(crate\))?\s+(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/u.exec(line);
      if (pubFn) {
        facts.push(makeFact("component", pubFn[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Interfaces ---
      const traitDecl = /^pub(?:\(crate\))?\s+trait\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (traitDecl) {
        facts.push(makeFact("interface", traitDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Trait impl (impl Trait for Type)
      const traitImpl = /^impl(?:<[^>]*>)?\s+([A-Z][A-Za-z0-9_]*)\s+for\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (traitImpl) {
        facts.push(makeFact("interface", `${traitImpl[2]}:impl:${traitImpl[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Actix/Axum HTTP handlers: #[get("/")] async fn handler
      const httpAttr = pendingAttributes.find((a) => /^(?:get|post|put|patch|delete)\s*\(/iu.test(a));
      if (httpAttr && pubFn) {
        const routePath = /\(\s*["'](\/[^"']*)/u.exec(httpAttr);
        if (routePath) {
          facts.push(makeFact("interface", `${httpAttr.split("(")[0].toUpperCase()} ${routePath[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
        }
      }

      // Router registrations: .route("/path", get(handler))
      const routeReg = /\.route\s*\(\s*["'](\/[^"']*)/u.exec(line);
      if (routeReg) {
        facts.push(makeFact("interface", routeReg[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Configs ---
      const stdEnvVar = /std::env::var\s*\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/u.exec(line);
      if (stdEnvVar) {
        facts.push(makeFact("config", stdEnvVar[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const envVar = /env::var\s*\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/u.exec(line);
      if (envVar && !stdEnvVar) {
        facts.push(makeFact("config", envVar[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Config structs in config.rs files
      if (isConfigFile(file.relativePath) && pubStruct) {
        facts.push(makeFact("config", `config:${pubStruct[1]}`, file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Errors ---
      const thiserror = pendingAttributes.some((a) => /derive\(.*thiserror::Error/u.test(a) || /derive\(.*Error/u.test(a));
      const errorEnum = /^pub(?:\(crate\))?\s+enum\s+([A-Z][A-Za-z0-9_]*(?:Error)?)/u.exec(line);
      if (errorEnum && thiserror) {
        facts.push(makeFact("error", errorEnum[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      } else if (errorEnum && /Error$/u.test(errorEnum[1])) {
        facts.push(makeFact("error", errorEnum[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      const errorStruct = /^pub(?:\(crate\))?\s+struct\s+([A-Z][A-Za-z0-9_]*Error)\b/u.exec(line);
      if (errorStruct) {
        facts.push(makeFact("error", errorStruct[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Relations ---
      const useDecl = /^use\s+([a-z_][\w:]*(?:::\{[^}]+\}|::\*|::[A-Z]\w*))/u.exec(line);
      if (useDecl) {
        facts.push(makeFact("relation", useDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const externCrate = /^extern\s+crate\s+([a-z_][a-z0-9_]*)/u.exec(line);
      if (externCrate) {
        facts.push(makeFact("relation", externCrate[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Reset attributes on non-attribute, non-blank lines
      if (!attrMatch && line.trim().length > 0) {
        pendingAttributes = [];
      }
    }
  }

  return facts;
}

function isConfigFile(relativePath: string): boolean {
  return /(?:config|settings)\.rs$/iu.test(relativePath);
}

function makeFact(
  kind: CodeFactKind,
  name: string,
  file: string,
  lineStart: number,
  rawLine: string,
  confidence: CodeFact["confidence"]
): CodeFact {
  return { kind, name, file, lineStart, detail: rawLine.trim(), confidence, evidenceType: mapKindToEvidenceType(kind) };
}

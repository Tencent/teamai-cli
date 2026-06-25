import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Enhanced TypeScript/JavaScript extractor.
 * Extracts components, interfaces/types, configs, errors, and relations.
 */
export function extractTypescript(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // --- Components ---
      const exportClass = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (exportClass) {
        facts.push(makeFact("component", exportClass[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const exportFunction = /^export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (exportFunction) {
        facts.push(makeFact("component", exportFunction[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const exportConst = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/u.exec(line);
      if (exportConst && !/CONFIG|DEFAULT|OPTION|SETTING|ENV/u.test(exportConst[1])) {
        facts.push(makeFact("component", exportConst[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const exportDefault = /^export\s+default\s+(?!class|function|abstract)([A-Za-z_$][\w$]*)/u.exec(line);
      if (exportDefault) {
        facts.push(makeFact("component", exportDefault[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Interfaces / Types ---
      const iface = /^export\s+(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/u.exec(line);
      if (iface) {
        facts.push(makeFact("interface", iface[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const typeAlias = /^export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/u.exec(line);
      if (typeAlias) {
        facts.push(makeFact("interface", typeAlias[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Route definitions
      const route = /(?:router|app|server)\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*["'`](\/[^"'`]*)/iu.exec(line);
      if (route) {
        facts.push(makeFact("interface", `${route[1].toUpperCase()} ${route[2]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Configs ---
      const envVar = /process\.env\.([A-Z][A-Z0-9_]{2,})/u.exec(line);
      if (envVar) {
        facts.push(makeFact("config", `process.env.${envVar[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const configConst = /^export\s+const\s+([A-Z][A-Z0-9_]*(?:CONFIG|DEFAULT|OPTION|SETTING|ENV)[A-Z0-9_]*)\s*=/u.exec(line);
      if (configConst) {
        facts.push(makeFact("config", configConst[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Errors ---
      const throwNew = /throw\s+new\s+([A-Za-z_$][\w$]*Error)\b/u.exec(line);
      if (throwNew) {
        facts.push(makeFact("error", throwNew[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const errorConst = /\b([A-Z][A-Z0-9_]*(?:ERROR|ERR|FAILED|FAILURE)[A-Z0-9_]*)\b/u.exec(line);
      if (errorConst && !throwNew) {
        facts.push(makeFact("error", errorConst[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Relations ---
      const importFrom = /^import\s+.*?from\s+["']([^"']+)["']/u.exec(line);
      if (importFrom) {
        facts.push(makeFact("relation", importFrom[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const dynamicImport = /(?:await\s+)?import\s*\(\s*["']([^"']+)["']\s*\)/u.exec(line);
      if (dynamicImport && !importFrom) {
        facts.push(makeFact("relation", dynamicImport[1], file.relativePath, lineNumber, line, "INFERRED"));
      }
    }
  }

  return facts;
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

import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Python extractor.
 * Extracts classes, module-level functions, ABC interfaces, route decorators,
 * configs, errors, and import relations.
 */
export function extractPython(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // --- Components ---
      const classDecl = /^class\s+([A-Z][A-Za-z0-9_]*)\s*[:(]/u.exec(line);
      if (classDecl && !isABCClass(line) && !isExceptionClass(line)) {
        facts.push(makeFact("component", classDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Module-level function: only promote to component if it matches service patterns
      const funcDecl = /^(?:async\s+)?def\s+([a-z_][a-z0-9_]*)\s*\(/u.exec(line);
      if (funcDecl) {
        const name = funcDecl[1];
        const isServiceFunc = /(?:handler|service|controller|command|worker|task|process|execute|dispatch|route)/i.test(name);
        if (isServiceFunc) {
          facts.push(makeFact("component", name, file.relativePath, lineNumber, line, "EXTRACTED"));
        }
      }

      // --- Interfaces ---
      if (isABCClass(line)) {
        const abcClass = /^class\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
        if (abcClass) {
          facts.push(makeFact("interface", abcClass[1], file.relativePath, lineNumber, line, "EXTRACTED"));
        }
      }

      // Flask/FastAPI route decorators
      const flaskRoute = /@app\.route\s*\(\s*["'](\/[^"']*)/u.exec(line);
      if (flaskRoute) {
        facts.push(makeFact("interface", flaskRoute[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const fastapiRoute = /@(?:router|app)\.\s*(get|post|put|patch|delete)\s*\(\s*["'](\/[^"']*)/u.exec(line);
      if (fastapiRoute) {
        facts.push(makeFact("interface", `${fastapiRoute[1].toUpperCase()} ${fastapiRoute[2]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Protocol class (typing)
      const protocolClass = /^class\s+([A-Z][A-Za-z0-9_]*)\s*\(.*Protocol.*\)/u.exec(line);
      if (protocolClass) {
        facts.push(makeFact("interface", protocolClass[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Configs ---
      const osEnviron = /os\.environ\s*(?:\[["']|\.get\s*\(\s*["'])([A-Z][A-Z0-9_]+)/u.exec(line);
      if (osEnviron) {
        facts.push(makeFact("config", osEnviron[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const dotenvRead = /(?:config|settings|environ)\s*(?:\[["']|\.get\s*\(\s*["']|\.)\s*([A-Z][A-Z0-9_]{2,})/u.exec(line);
      if (dotenvRead && !osEnviron) {
        facts.push(makeFact("config", dotenvRead[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // Settings patterns (e.g., SETTING_NAME = ...)
      const settingsPattern = /^([A-Z][A-Z0-9_]{3,})\s*[:=]\s*.+/u.exec(line);
      if (settingsPattern && isSettingsFile(file.relativePath)) {
        facts.push(makeFact("config", settingsPattern[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Errors ---
      if (isExceptionClass(line)) {
        const errClass = /^class\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
        if (errClass) {
          facts.push(makeFact("error", errClass[1], file.relativePath, lineNumber, line, "EXTRACTED"));
        }
      }

      const raiseStmt = /raise\s+([A-Z][A-Za-z0-9_]*(?:Error|Exception)?)\s*\(/u.exec(line);
      if (raiseStmt) {
        facts.push(makeFact("error", raiseStmt[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Relations ---
      const fromImport = /^from\s+([\w.]+)\s+import\s+(.+)/u.exec(line);
      if (fromImport) {
        const modulePath = fromImport[1];
        const names = fromImport[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const name of names) {
          facts.push(makeFact("relation", `${modulePath}.${name}`, file.relativePath, lineNumber, line, "EXTRACTED"));
        }
      }

      const importModule = /^import\s+([\w.]+)/u.exec(line);
      if (importModule && !fromImport) {
        facts.push(makeFact("relation", importModule[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }
    }
  }

  return facts;
}

function isABCClass(line: string): boolean {
  return /^class\s+\w+\s*\(.*(?:ABC|ABCMeta|metaclass\s*=\s*ABCMeta).*\)/u.test(line);
}

function isExceptionClass(line: string): boolean {
  return /^class\s+\w+\s*\(.*(?:Exception|Error|BaseException).*\)/u.test(line);
}

function isSettingsFile(relativePath: string): boolean {
  return /(?:settings|config|constants|env)\.py$/iu.test(relativePath);
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

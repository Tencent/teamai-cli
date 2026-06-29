import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Java extractor.
 * Extracts classes, Spring annotations, interfaces, controllers, configs, errors, and imports.
 */
export function extractJava(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    let pendingAnnotations: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Collect annotations for context on the next declaration
      const annotation = /^\s*@([A-Za-z]+)/u.exec(line);
      if (annotation) {
        pendingAnnotations.push(annotation[1]);
      }

      // --- Components ---
      const classDecl = /^(?:public|protected|private)?\s*(?:abstract\s+)?(?:final\s+)?class\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (classDecl) {
        const isSpringComponent = pendingAnnotations.some((a) =>
          ["Component", "Service", "Repository", "Configuration", "Bean"].includes(a)
        );
        facts.push(makeFact("component", classDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));

        if (isSpringComponent) {
          const springType = pendingAnnotations.find((a) =>
            ["Component", "Service", "Repository", "Configuration"].includes(a)
          );
          if (springType) {
            facts.push(makeFact("component", `@${springType}:${classDecl[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
          }
        }
      }

      // Enum declaration
      const enumDecl = /^(?:public|protected|private)?\s*enum\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (enumDecl) {
        facts.push(makeFact("component", enumDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Interfaces ---
      const ifaceDecl = /^(?:public|protected|private)?\s*interface\s+([A-Z][A-Za-z0-9_]*)/u.exec(line);
      if (ifaceDecl) {
        facts.push(makeFact("interface", ifaceDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Controllers and REST endpoints
      const isController = pendingAnnotations.some((a) =>
        ["Controller", "RestController"].includes(a)
      );
      if (isController && classDecl) {
        facts.push(makeFact("interface", `@Controller:${classDecl[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // RequestMapping and method mappings
      const requestMapping = /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*\(\s*(?:value\s*=\s*)?["'](\/[^"']*)/u.exec(line);
      if (requestMapping) {
        facts.push(makeFact("interface", requestMapping[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Configs ---
      const valueAnnotation = /@Value\s*\(\s*["']\$\{([^}]+)\}/u.exec(line);
      if (valueAnnotation) {
        facts.push(makeFact("config", valueAnnotation[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // application.properties/yml style references
      const propRef = /["']([a-z][a-z0-9._-]{3,})["']/u.exec(line);
      if (propRef && isConfigFile(file.relativePath)) {
        facts.push(makeFact("config", propRef[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Errors ---
      const errorEnum = /^(?:public|protected|private)?\s*enum\s+([A-Z][A-Za-z0-9_]*(?:Error|Code|Status))\b/u.exec(line);
      if (errorEnum) {
        facts.push(makeFact("error", errorEnum[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const throwStmt = /throw\s+new\s+([A-Za-z_$][\w$]*Exception)\s*\(/u.exec(line);
      if (throwStmt) {
        facts.push(makeFact("error", throwStmt[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const exceptionClass = /^(?:public|protected|private)?\s*class\s+([A-Z][A-Za-z0-9_]*Exception)\b/u.exec(line);
      if (exceptionClass) {
        facts.push(makeFact("error", exceptionClass[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Relations ---
      const importStmt = /^import\s+(?:static\s+)?([a-z][\w.]*\.[A-Z][\w]*)/u.exec(line);
      if (importStmt) {
        facts.push(makeFact("relation", importStmt[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Reset annotations if we hit a non-annotation, non-blank line
      if (!annotation && line.trim().length > 0) {
        pendingAnnotations = [];
      }
    }
  }

  return facts;
}

function isConfigFile(relativePath: string): boolean {
  return /(?:application|bootstrap|config)\.(?:properties|ya?ml)$/iu.test(relativePath);
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

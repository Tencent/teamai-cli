import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Go extractor.
 * Extracts structs, funcs, interfaces, HTTP handlers, configs, errors, and import relations.
 */
export function extractGo(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // --- Components ---
      const structDecl = /^type\s+([A-Z][A-Za-z0-9_]*)\s+struct\b/u.exec(line);
      if (structDecl) {
        facts.push(makeFact("component", structDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const funcNew = /^func\s+New([A-Z][A-Za-z0-9_]*)\s*\(/u.exec(line);
      if (funcNew) {
        facts.push(makeFact("component", `New${funcNew[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const packageDecl = /^package\s+([a-z][a-z0-9_]*)/u.exec(line);
      if (packageDecl) {
        facts.push(makeFact("component", `package:${packageDecl[1]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const topLevelFunc = /^func\s+([A-Z][A-Za-z0-9_]*)\s*\(/u.exec(line);
      if (topLevelFunc && !funcNew) {
        facts.push(makeFact("component", topLevelFunc[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Interfaces ---
      const ifaceDecl = /^type\s+([A-Z][A-Za-z0-9_]*)\s+interface\b/u.exec(line);
      if (ifaceDecl) {
        facts.push(makeFact("interface", ifaceDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // HTTP handler methods: func (h *Handler) ServeHTTP(...)
      const handlerMethod = /^func\s+\([^)]*\*?(\w+)\)\s+(ServeHTTP|Handle|Handler)\s*\(/u.exec(line);
      if (handlerMethod) {
        facts.push(makeFact("interface", `${handlerMethod[1]}.${handlerMethod[2]}`, file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Router registrations: r.HandleFunc("/path", handler)
      const routeReg = /\.\s*(?:HandleFunc|Handle|Get|Post|Put|Delete|Patch)\s*\(\s*["'](\/[^"']*)/u.exec(line);
      if (routeReg) {
        facts.push(makeFact("interface", routeReg[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Configs ---
      const envGet = /os\.Getenv\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/u.exec(line);
      if (envGet) {
        facts.push(makeFact("config", envGet[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // yaml/toml struct tags
      const structTag = /`(?:yaml|toml|json):"([^",]+)"/u.exec(line);
      if (structTag) {
        facts.push(makeFact("config", `tag:${structTag[1]}`, file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Errors ---
      const errVar = /^var\s+(Err[A-Z][A-Za-z0-9_]*)\s*=\s*(?:errors\.New|fmt\.Errorf)/u.exec(line);
      if (errVar) {
        facts.push(makeFact("error", errVar[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const errConst = /^\s*(Err[A-Z][A-Za-z0-9_]*)\s*(?:=|error)/u.exec(line);
      if (errConst && !errVar) {
        const inBlock = isInsideBlock(lines, i, "const", "var");
        if (inBlock) {
          facts.push(makeFact("error", errConst[1], file.relativePath, lineNumber, line, "INFERRED"));
        }
      }

      const fmtErrorf = /fmt\.Errorf\s*\(\s*["']([^"']{1,60})/u.exec(line);
      if (fmtErrorf && !errVar) {
        facts.push(makeFact("error", fmtErrorf[1], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Relations ---
      const importPath = /^\s*"([^"]+)"/u.exec(line);
      if (importPath && isInsideBlock(lines, i, "import")) {
        facts.push(makeFact("relation", importPath[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const singleImport = /^import\s+"([^"]+)"/u.exec(line);
      if (singleImport) {
        facts.push(makeFact("relation", singleImport[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }
    }
  }

  return facts;
}

/**
 * Checks if the current line index is inside a block starting with one of the given keywords.
 */
function isInsideBlock(lines: string[], currentIndex: number, ...keywords: string[]): boolean {
  for (let j = currentIndex - 1; j >= Math.max(0, currentIndex - 50); j--) {
    const candidate = lines[j];
    if (/^\s*\)\s*$/u.test(candidate)) {
      return false;
    }
    for (const keyword of keywords) {
      if (new RegExp(`^${keyword}\\s*\\(`, "u").test(candidate)) {
        return true;
      }
    }
  }
  return false;
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

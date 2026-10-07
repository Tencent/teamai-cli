import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Scala extractor.
 * Extracts classes, objects, traits, enums, defs, configs, errors, and import relations.
 */
export function extractScala(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Annotations (`@deprecated`), modifiers (`final case`), and Scala 3
      // modifiers (`transparent inline`) precede the keyword on the same line.
      const decl = stripLeadingModifiers(line);

      // --- Components ---
      const typeDecl = /^(class|object|enum)\s+([A-Z]\w*)/u.exec(decl);
      if (typeDecl) {
        facts.push(makeFact("component", typeDecl[2], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const defDecl = /^def\s+([a-z_]\w*)/u.exec(decl);
      if (defDecl) {
        facts.push(makeFact("component", defDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Interfaces ---
      const traitDecl = /^trait\s+([A-Z]\w*)/u.exec(decl);
      if (traitDecl) {
        facts.push(makeFact("interface", traitDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Configs ---
      const envRead = /\b(?:sys\.env|System\.getenv)\s*\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/u.exec(line);
      if (envRead) {
        facts.push(makeFact("config", envRead[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Errors ---
      const typeName = typeDecl?.[2] ?? traitDecl?.[1];
      if (typeName && /(?:Error|Exception)$/u.test(typeName)) {
        facts.push(makeFact("error", typeName, file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Relations ---
      // One relation per imported symbol, as a slash-separated path
      // (`com.foo.{Bar, Baz => B}` → `com/foo/Bar`, `com/foo/Baz`). Both
      // relation consumers match paths, not dotted packages: buildCodeGraph
      // fuzzy-matches file paths and the call-chain tracer resolves the
      // basename. Expanding the selector keeps the edge on the named file —
      // a bare package path would tie the importer to every file in the
      // directory.
      const importDecl = /^import\s+([A-Za-z_]\w*(?:\.\w+)*)(?:\s*\.\s*\{([^}]*)\})?/u.exec(decl);
      if (importDecl) {
        const packagePath = toPath(importDecl[1]);
        const symbols = importDecl[2] ? selectedSymbols(importDecl[2]) : [];
        const targets = symbols.length > 0 ? symbols.map((symbol) => `${packagePath}/${symbol}`) : [packagePath];
        for (const target of targets) {
          facts.push(makeFact("relation", target, file.relativePath, lineNumber, line, "EXTRACTED"));
        }
      }
    }
  }

  return facts;
}

/**
 * `case` is the one token that is both a declaration modifier (`case class`)
 * and a `match` clause (`case Invoice(id) =>`). It is stripped either way, but
 * a clause line then starts with a capitalized name — no declaration keyword —
 * so it cannot be mistaken for a declaration.
 */
const MODIFIER_PATTERN =
  /^\s*(?:@\w+(?:\[[^\]]*\])?(?:\([^)]*\))?\s+)*(?:(?:private|protected)(?:\[[^\]]*\])?\s+|(?:final|sealed|abstract|case|implicit|lazy|override|open|transparent|inline|infix|erased)\s+)*/u;

/** Anything after the leading annotations/modifiers is the declaration itself. */
function stripLeadingModifiers(line: string): string {
  return line.replace(MODIFIER_PATTERN, "");
}

/** `com.foo.Bar` → `com/foo/Bar`; a trailing wildcard (`_`, `*`) names the whole package and drops off. */
function toPath(dotted: string): string {
  return dotted.replace(/[._*]+$/u, "").replace(/\./gu, "/");
}

/**
 * `Bar, Baz => B` → `["Bar", "Baz"]`: the name a selector imports is the part
 * before `=>`. Anything that is not a plain identifier — the in-brace `_`
 * wildcard, nested selectors — is dropped; the package path covers it.
 */
function selectedSymbols(selector: string): string[] {
  const names = selector
    .split(",")
    .map((item) => item.split("=>")[0].trim())
    .filter((name) => /^[A-Za-z]\w*$/u.test(name));
  return [...new Set(names)];
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

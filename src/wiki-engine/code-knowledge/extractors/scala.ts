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
      // `import com.foo.Bar`, `import com.foo.{Bar, Baz}`, `import com.foo._`
      // (Scala 2) and `import com.foo.*` (Scala 3) all narrow to `com.foo`.
      // Dots are package separators; both relation consumers match
      // slash-separated paths (buildCodeGraph's fuzzy file match, the call-chain
      // tracer's module map), so emit the import as a path: `com.foo.Bar` →
      // `com/foo/Bar`.
      const importDecl = /^import\s+([A-Za-z_]\w*(?:\.\w+)*)/u.exec(decl);
      if (importDecl) {
        const target = importDecl[1].replace(/\._$/u, "").replace(/\./gu, "/");
        facts.push(makeFact("relation", target, file.relativePath, lineNumber, line, "EXTRACTED"));
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

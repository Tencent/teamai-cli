import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";

/**
 * Swift extractor.
 * Extracts types, protocols, functions, protocol conformances, configs, errors, and import relations.
 */
export function extractSwift(files: CodeCollectedFile[]): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Attributes (`@MainActor`) and modifiers (`public final`) precede the
      // keyword on the same line; SwiftFormat often puts an attribute on its own
      // line, in which case the declaration line is already free of them.
      const decl = stripLeadingModifiers(line);

      // --- Components ---
      const typeDecl = /^(class|struct|enum|actor)\s+([A-Z]\w*)/u.exec(decl);
      if (typeDecl) {
        facts.push(makeFact("component", typeDecl[2], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const funcDecl = /^func\s+([a-z_]\w*)/u.exec(decl);
      if (funcDecl) {
        facts.push(makeFact("component", funcDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Interfaces ---
      const protocolDecl = /^protocol\s+([A-Z]\w*)/u.exec(decl);
      if (protocolDecl) {
        facts.push(makeFact("interface", protocolDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // Conformances: `extension Point: Equatable, CustomStringConvertible where ...`
      // An extension declares no new type, so it only contributes protocols.
      const extensionDecl = /^extension\s+([A-Z]\w*)\s*:\s*([^{]+)/u.exec(decl);
      if (extensionDecl) {
        for (const conformance of extensionDecl[2].split(/\bwhere\b/u)[0].split(",")) {
          const protocolName = conformance.trim();
          if (/^[A-Z]\w*$/u.test(protocolName)) {
            facts.push(
              makeFact("interface", `${extensionDecl[1]}:impl:${protocolName}`, file.relativePath, lineNumber, line, "EXTRACTED")
            );
          }
        }
      }

      // --- Configs ---
      const envRead = /ProcessInfo\.processInfo\.environment\s*\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/u.exec(line);
      if (envRead) {
        facts.push(makeFact("config", envRead[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Errors ---
      if (typeDecl && typeDecl[2].endsWith("Error")) {
        facts.push(makeFact("error", typeDecl[2], file.relativePath, lineNumber, line, "INFERRED"));
      }

      // --- Relations ---
      const importDecl = /^import\s+(?:\w+\s+)?([A-Za-z_]\w*)/u.exec(decl);
      if (importDecl) {
        facts.push(makeFact("relation", importDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }
    }
  }

  return facts;
}

/**
 * `class` is the one token that is both a declaration keyword and a modifier
 * (`class func` declares a type method). Without the lookahead, `open class Foo`
 * would lose its `class` too and the type would be missed.
 */
const MODIFIER_PATTERN =
  /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|fileprivate|private|package)(?:\([^)]*\))?\s+|(?:final|indirect|nonisolated(?:\([^)]*\))?|static|class(?=\s+(?:func|var|let|subscript)\b)|override|mutating|nonmutating|required|convenience|lazy|weak|unowned|dynamic|optional|prefix|postfix|infix)\s+)*/u;

/** Anything after the leading attributes/modifiers is the declaration itself. */
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

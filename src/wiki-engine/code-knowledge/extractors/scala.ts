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
    // A brace selector scalafmt wraps across lines stays open until its `}`.
    let openImport: { line: number; prefix: string; selector: string } | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      if (openImport) {
        openImport.selector += ` ${line}`;
        if (openImport.selector.includes("}")) {
          const { line: start, prefix, selector } = openImport;
          openImport = undefined;
          pushRelations(facts, files, prefix, selector.split("}")[0], file.relativePath, start, line);
        }
        continue;
      }

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
      // One clause per imported symbol, as a path both relation consumers can
      // match: buildCodeGraph compares file paths, and the call-chain tracer
      // looks files up by path and basename. Several imports may share one
      // line (`import a.B, c.D`); a brace selector may continue on the lines
      // below, in which case it opens and waits for its `}`.
      const importHead = /^import\s+(.+)$/u.exec(decl);
      if (importHead) {
        let rest = importHead[1];
        while (rest.length > 0) {
          const clause = /^([A-Za-z_]\w*(?:\.\w+)*)(\s*\.\s*\{([^}]*)\})?/u.exec(rest);
          if (!clause) {
            break;
          }
          const after = rest.slice(clause[0].length);
          if (/^\s*\.\s*\{/u.test(after)) {
            openImport = { line: lineNumber, prefix: clause[1], selector: after.replace(/^\s*\.\s*\{/u, "") };
            break;
          }
          pushRelations(facts, files, clause[1], clause[3], file.relativePath, lineNumber, line);
          rest = after.replace(/^\s*,\s*/u, "");
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
 * `com/demo/core/Invoice/apply` → `com/demo/core/Invoice`: a lowercase tail
 * after a type names a member of it, and the file that defines the type is
 * the file the consumers can match.
 */
function toModulePath(path: string): string {
  const segments = path.split("/");
  let lastType = -1;
  for (let i = 0; i < segments.length; i++) {
    if (/^[A-Z]/u.test(segments[i])) {
      lastType = i;
    }
  }
  return lastType === -1 ? path : segments.slice(0, lastType + 1).join("/");
}

interface ImportSelection {
  /** A `_` entry imports everything in the package. */
  wildcard: boolean;
  /** The symbols the selector names (`Invoice as Inv` imports `Invoice`). */
  symbols: string[];
  /** Names renamed to `_` — imported only to be hidden. */
  hidden: string[];
}

/**
 * `{Invoice as Inv, Order => O}` → symbols `["Invoice", "Order"]`: the name an
 * entry imports is the part before the rename (`=>` in Scala 2, `as` in
 * Scala 3). An alias of `_` hides its name, and `_` alone imports the whole
 * package. Anything that is not a plain identifier (nested selectors) is
 * dropped; the package covers it.
 */
function parseSelectors(selector: string): ImportSelection {
  const selection: ImportSelection = { wildcard: false, symbols: [], hidden: [] };
  for (const entry of selector.split(",")) {
    const item = entry.trim();
    const renamed = /^([A-Za-z_]\w*)\s*(?:=>|\bas\b)\s*(.+)$/u.exec(item);
    const alias = renamed?.[2].trim();
    if (item === "_") {
      selection.wildcard = true;
    } else if (renamed && alias === "_") {
      selection.hidden.push(renamed[1]);
    } else if (renamed && alias && /^[A-Za-z_]\w*$/u.test(alias)) {
      selection.symbols.push(renamed[1]);
    } else if (!renamed && /^[A-Za-z_]\w*$/u.test(item)) {
      selection.symbols.push(item);
    }
  }
  selection.symbols = [...new Set(selection.symbols)];
  return selection;
}

/**
 * Emit one relation per imported symbol, as a slash-separated path
 * (`com.foo.{Bar, Baz => B}` → `com/foo/Bar`, `com/foo/Baz`) — a bare package
 * path would tie the importer to every file in the directory. A wildcard
 * (a trailing `._`/`.*` or a `_` entry) names the collected files of the
 * package itself, minus the names the selector hides, so the excluded file
 * gets no edge; with no collected file to name (an external package) the
 * package path is all that is left to say.
 */
function pushRelations(
  facts: CodeFact[],
  files: CodeCollectedFile[],
  dottedPrefix: string,
  selector: string | undefined,
  file: string,
  lineNumber: number,
  rawLine: string
): void {
  const packagePath = toPath(dottedPrefix);
  const selection = selector !== undefined ? parseSelectors(selector) : undefined;
  const wildcard = /[._*]$/u.test(dottedPrefix) || (selection?.wildcard ?? false);
  let targets: string[];
  if (wildcard) {
    const hidden = new Set(selection?.hidden ?? []);
    const expanded = expandWildcard(packagePath, files, hidden);
    targets = expanded.length > 0 ? expanded : [packagePath];
  } else {
    const symbols = selection?.symbols ?? [];
    targets = [...new Set((symbols.length > 0 ? symbols.map((symbol) => `${packagePath}/${symbol}`) : [packagePath]).map(toModulePath))];
  }
  for (const target of targets) {
    facts.push(makeFact("relation", target, file, lineNumber, rawLine, "EXTRACTED"));
  }
}

/** The files a wildcard import of `packagePath` brings in, minus hidden names. */
function expandWildcard(packagePath: string, files: CodeCollectedFile[], hidden: ReadonlySet<string>): string[] {
  return files
    .filter((candidate) => candidate.relativePath.includes(`/${packagePath}/`))
    .filter((candidate) => !hidden.has(fileName(candidate.relativePath)))
    .map((candidate) => candidate.relativePath);
}

/** `src/main/scala/core/Invoice.scala` → `Invoice`. */
function fileName(relativePath: string): string {
  return (relativePath.split("/").pop() ?? relativePath).replace(/\.\w+$/u, "");
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

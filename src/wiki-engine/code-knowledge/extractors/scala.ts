import { type CodeCollectedFile } from "../code-collector.js";
import { type CodeFact, type CodeFactKind, mapKindToEvidenceType } from "../code-extractors.js";
import { type ExtractorContext } from "./index.js";

const TYPE_DECL_PATTERN = /^(class|object|enum)\s+([A-Z]\w*)/u;
const DEF_DECL_PATTERN = /^def\s+([a-z_]\w*)/u;
const TRAIT_DECL_PATTERN = /^trait\s+([A-Z]\w*)/u;

/**
 * Marks a wildcard relation: `scala-wildcard:com/demo/core`. The name matches
 * no file, so no consumer resolves it; the incremental layer reads these
 * markers to re-extract importers whose package membership changed.
 */
export const SCALA_WILDCARD_PREFIX = "scala-wildcard:";

/**
 * Scala extractor.
 * Extracts classes, objects, traits, enums, defs, configs, errors, and import relations.
 *
 * `context.allFiles` — every collected file, all languages — resolves wildcard
 * imports in a mixed project, where a Scala wildcard imports Java files just as
 * freely as Scala ones. `context.priorDeclarations` — the previous run's
 * declarations — keeps symbol resolution working in an incremental run, which
 * re-extracts only changed files.
 */
export function extractScala(files: CodeCollectedFile[], context?: ExtractorContext): CodeFact[] {
  const facts: CodeFact[] = [];
  // An incremental run re-parses only changed files; everything else is known
  // by its cached declarations, which the fresh parse then overrides.
  const declarations = new Map(context?.priorDeclarations ?? []);
  for (const file of files) {
    declarations.set(file.relativePath, declarationNames(file.content));
  }
  const extractContext: ExtractContext = { allFiles: context?.allFiles ?? files, declarations };

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
          pushRelations(facts, extractContext, prefix, selector.split("}")[0], file.relativePath, start, line);
        }
        continue;
      }

      // Annotations (`@deprecated`), modifiers (`final case`), and Scala 3
      // modifiers (`transparent inline`) precede the keyword on the same line.
      const decl = stripLeadingModifiers(line);

      // --- Components ---
      const typeDecl = TYPE_DECL_PATTERN.exec(decl);
      if (typeDecl) {
        facts.push(makeFact("component", typeDecl[2], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      const defDecl = DEF_DECL_PATTERN.exec(decl);
      if (defDecl) {
        facts.push(makeFact("component", defDecl[1], file.relativePath, lineNumber, line, "EXTRACTED"));
      }

      // --- Interfaces ---
      const traitDecl = TRAIT_DECL_PATTERN.exec(decl);
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
          const clause = /^([A-Za-z_]\w*(?:\.\w+)*(?:\.\*)?)(\s*\.\s*\{([^}]*)\})?/u.exec(rest);
          if (!clause) {
            break;
          }
          const after = rest.slice(clause[0].length);
          if (/^\s*\.\s*\{/u.test(after)) {
            openImport = { line: lineNumber, prefix: clause[1], selector: after.replace(/^\s*\.\s*\{/u, "") };
            break;
          }
          pushRelations(facts, extractContext, clause[1], clause[3], file.relativePath, lineNumber, line);
          rest = after.replace(/^\s*,\s*/u, "");
        }
      }
    }
  }

  // Two imports of one file (a wildcard plus a named symbol, say) name the
  // same dependency twice — keep one relation per target per file.
  const seenRelations = new Set<string>();
  const uniqueFacts: CodeFact[] = [];
  for (const fact of facts) {
    if (fact.kind !== "relation") {
      uniqueFacts.push(fact);
      continue;
    }
    const key = `${fact.file}|${fact.name}`;
    if (seenRelations.has(key)) {
      continue;
    }
    seenRelations.add(key);
    uniqueFacts.push(fact);
  }
  return uniqueFacts;
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

interface ExtractContext {
  /** Every collected file of the run — a wildcard imports Java files as freely as Scala ones. */
  allFiles: CodeCollectedFile[];
  /** relativePath → the symbol names the file declares, this run or cached. */
  declarations: Map<string, Set<string>>;
}

/**
 * Emit one relation per imported symbol, as a path both relation consumers
 * match — a bare package path would tie the importer to every file in the
 * directory. A named symbol resolves to the file in the package that declares
 * it (Scala freely puts many types in one `Models.scala`), or to the
 * conventional path when no collected file declares it. A wildcard (a
 * trailing `._`/`.*` or a `_`/`*` entry) names the direct members of the
 * package directory, minus the names the selector hides; with no collected
 * file to name (an external package) the package path is all that is left to
 * say.
 */
function pushRelations(
  facts: CodeFact[],
  context: ExtractContext,
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
    facts.push(makeFact("relation", `${SCALA_WILDCARD_PREFIX}${packagePath}`, file, lineNumber, rawLine, "EXTRACTED"));
    const hidden = new Set(selection?.hidden ?? []);
    const expanded = expandWildcard(packagePath, context, hidden);
    if (expanded.length > 0) {
      targets = expanded;
    } else {
      // `com.demo.Models.*` wildcards an object, not a package — resolve it to
      // the file that declares the object, as a named import would.
      const modulePath = toModulePath(packagePath);
      const segments = modulePath.split("/");
      const symbol = segments[segments.length - 1];
      targets =
        segments.length > 1 && /^[A-Z]/u.test(symbol)
          ? [symbolTarget(symbol, segments.slice(0, -1).join("/"), file, context)]
          : [packagePath];
    }
  } else if (selection && selection.symbols.length > 0) {
    targets = [...new Set(selection.symbols.map((symbol) => symbolTarget(symbol, packagePath, file, context)))];
  } else if (selection) {
    // only hidden names — the package minus those names
    targets = [packagePath];
  } else {
    // A plain import names a symbol (`com.foo.Bar` — or a Scala 3 top-level
    // `def validate`) preceded by its package; resolving it against the
    // package's declarations keeps the conventional same-name path as fallback.
    const modulePath = toModulePath(packagePath);
    const segments = modulePath.split("/");
    const symbol = segments[segments.length - 1];
    targets =
      segments.length > 1
        ? [symbolTarget(symbol, segments.slice(0, -1).join("/"), file, context)]
        : [modulePath];
  }
  for (const target of targets) {
    facts.push(makeFact("relation", target, file, lineNumber, rawLine, "EXTRACTED"));
  }
}

interface ImportSelection {
  /** A `_` or `*` entry imports everything in the package. */
  wildcard: boolean;
  /** The symbols the selector names (`Invoice as Inv` imports `Invoice`). */
  symbols: string[];
  /** Names renamed to `_` — imported only to be hidden. */
  hidden: string[];
}

/**
 * `{Invoice as Inv, Order => O}` → symbols `["Invoice", "Order"]`: the name an
 * entry imports is the part before the rename (`=>` in Scala 2, `as` in
 * Scala 3). An alias of `_` hides its name, and `_` or `*` alone imports the
 * whole package. Anything that is not a plain identifier (nested selectors)
 * is dropped; the package covers it.
 */
function parseSelectors(selector: string): ImportSelection {
  const selection: ImportSelection = { wildcard: false, symbols: [], hidden: [] };
  for (const entry of selector.split(",")) {
    const item = entry.trim();
    const renamed = /^([A-Za-z_]\w*)\s*(?:=>|\bas\b)\s*(.+)$/u.exec(item);
    const alias = renamed?.[2].trim();
    if (item === "_" || item === "*") {
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

/**
 * The files a wildcard import of `packagePath` brings in: the package's
 * JVM-importable members, minus those hidden by file name and those whose
 * every declared symbol is hidden.
 */
function expandWildcard(packagePath: string, context: ExtractContext, hidden: ReadonlySet<string>): string[] {
  return packageMembers(packagePath, context.allFiles)
    .filter((candidate) => {
      if (hidden.has(fileName(candidate.relativePath))) {
        return false;
      }
      const declared = context.declarations.get(candidate.relativePath);
      return !(declared && declared.size > 0 && [...declared].every((name) => hidden.has(name)));
    })
    .map((candidate) => candidate.relativePath);
}

/**
 * The file in the package that declares `symbol`, or the conventional path if
 * none does — the symbol's own name is not a file name to rely on.
 */
function symbolTarget(symbol: string, packagePath: string, importer: string, context: ExtractContext): string {
  for (const candidate of packageMembers(packagePath, context.allFiles)) {
    if (candidate.relativePath !== importer && context.declarations.get(candidate.relativePath)?.has(symbol)) {
      return candidate.relativePath;
    }
  }
  return toModulePath(`${packagePath}/${symbol}`);
}

/**
 * The JVM-importable direct members of the package directory — a subpackage's
 * files are not among them, and neither is a resource like a `.sql` schema
 * that happens to sit beside the sources.
 */
function packageMembers(packagePath: string, files: CodeCollectedFile[]): CodeCollectedFile[] {
  return files
    .filter((candidate) => /\.(?:scala|java)$/u.test(candidate.relativePath))
    .filter((candidate) => {
      const tail = afterPackage(candidate.relativePath, packagePath);
      return tail !== undefined && !tail.includes("/");
    });
}

/** The part of `relativePath` below `com/demo/core`, or undefined when the file is elsewhere. */
function afterPackage(relativePath: string, packagePath: string): string | undefined {
  if (relativePath.startsWith(`${packagePath}/`)) {
    return relativePath.slice(packagePath.length + 1);
  }
  const marker = `/${packagePath}/`;
  const at = relativePath.indexOf(marker);
  return at === -1 ? undefined : relativePath.slice(at + marker.length);
}

/**
 * The top-level type, trait and def names a file declares — the names another
 * file can import from the package. A member sits inside braces or, in
 * significant-indentation Scala 3, at least one indent; either way it is not
 * a package-level name.
 */
function declarationNames(content: string): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    if (depth === 0 && !/^\s/u.test(rawLine)) {
      const decl = stripLeadingModifiers(rawLine);
      const typeDecl = TYPE_DECL_PATTERN.exec(decl);
      if (typeDecl) {
        names.add(typeDecl[2]);
      }
      const traitDecl = TRAIT_DECL_PATTERN.exec(decl);
      if (traitDecl) {
        names.add(traitDecl[1]);
      }
      const defDecl = DEF_DECL_PATTERN.exec(decl);
      if (defDecl) {
        names.add(defDecl[1]);
      }
    }
    depth += (rawLine.match(/\{/gu) ?? []).length - (rawLine.match(/\}/gu) ?? []).length;
  }
  return names;
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

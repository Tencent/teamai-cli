import path from "node:path";

import type { Node } from "web-tree-sitter";

import type { CodeCollectedFile } from "../code-collector.js";
import {
  collectExportLineStarts,
  isExportedSymbol,
  isTypeOnlyImport,
  normalizeImportSpecifier,
  parseImportBindings
} from "./import-bindings.js";
import { grammarForExtension, getLanguage, getParser, getQuery } from "./parser-registry.js";
import type { AstCallSite, AstImplementsSite, AstImport, AstSymbol, AstSymbolKind } from "./types.js";

export interface FileWalkResult {
  symbols: AstSymbol[];
  /**
   * Swift only: the declarations a sibling file of the same module can reach by
   * name. Empty for every other language, and a subset of `symbols` for Swift.
   */
  swiftModuleSymbols: AstSymbol[];
  imports: AstImport[];
  callSites: AstCallSite[];
  implementsSites: AstImplementsSite[];
  parseErrors: string[];
}

const MAX_FILE_BYTES = 512 * 1024;

export function isAstParseableFile(relativePath: string): boolean {
  return grammarForExtension(path.extname(relativePath)) !== undefined;
}

export function walkFile(file: CodeCollectedFile): FileWalkResult {
  const symbols: AstSymbol[] = [];
  const swiftModuleSymbols: AstSymbol[] = [];
  const imports: AstImport[] = [];
  const callSites: AstCallSite[] = [];
  const implementsSites: AstImplementsSite[] = [];
  const parseErrors: string[] = [];

  if (!isAstParseableFile(file.relativePath)) {
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
    parseErrors.push(`skipped large file: ${file.relativePath}`);
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  const variant = grammarForExtension(path.extname(file.relativePath))!;
  const language = getLanguage(variant);
  const parser = getParser();
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(file.content);
  } catch (error) {
    parseErrors.push(`parse failed: ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  if (!tree) {
    parseErrors.push(`parse returned null: ${file.relativePath}`);
    return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
  }

  try {
    const query = getQuery(variant);
    const exportLineStarts = collectExportLineStarts(variant, tree.rootNode);
    // One traversal per file, shared by every call site below: doing this per
    // call would re-walk the enclosing declaration once for each of its calls.
    const swiftShadowedNames =
      variant === "swift" ? buildSwiftShadowedNames(tree.rootNode) : undefined;

    for (const match of query.matches(tree.rootNode)) {
      const byName = new Map(match.captures.map((c) => [c.name, c.node]));

      if (byName.has("import.stmt")) {
        const stmt = byName.get("import.stmt")!;
        const specNode = byName.get("import.spec");
        if (!specNode) continue;
        const specifier = normalizeImportSpecifier(specNode.text, variant);
        const line = stmt.startPosition.row + 1;
        const isTypeOnly = isTypeOnlyImport(stmt.text, variant);
        imports.push({
          fromFile: file.relativePath,
          specifier,
          line,
          isTypeOnly,
          ...parseImportBindings(stmt.text, variant)
        });
        continue;
      }

      const symbolName = byName.get("symbol.name")?.text;
      if (symbolName) {
        const decl =
          byName.get("symbol.class") ?? byName.get("symbol.function") ?? byName.get("symbol.interface");
        if (!decl) continue;
        const kind: AstSymbolKind = byName.has("symbol.class")
          ? "class"
          : byName.has("symbol.interface")
            ? "interface"
            : "function";
        const lineStart = decl.startPosition.row + 1;
        const lineEnd = decl.endPosition.row + 1;
        const exported = isExportedSymbol(variant, decl.startIndex, file.content, lineStart, exportLineStarts);
        const symbol: AstSymbol = {
          id: symbolId(file.relativePath, kind, symbolName),
          kind,
          name: symbolName,
          file: file.relativePath,
          lineStart,
          lineEnd,
          exported
        };
        symbols.push(symbol);
        // Swift files in one module see each other without any import, so the
        // module index needs exactly the declarations a sibling can reach.
        if (variant === "swift" && isSwiftModuleVisible(decl)) {
          swiftModuleSymbols.push(symbol);
        }
        continue;
      }

      if (byName.has("call.stmt") || byName.has("call.member")) {
        const callNode = byName.get("call.stmt") ?? byName.get("call.member")!;
        const line = callNode.startPosition.row + 1;
        const callee = byName.get("call.callee")?.text;
        const receiver = byName.get("call.receiver")?.text;
        const member = byName.get("call.member")?.text;
        const calleeText = callee ?? (receiver && member ? `${receiver}.${member}` : callNode.text);
        const localBindings =
          swiftShadowedNames === undefined ? [] : swiftShadowedNamesAt(callNode, swiftShadowedNames);
        callSites.push({
          fromFile: file.relativePath,
          line,
          calleeText,
          receiver,
          ...(localBindings.length > 0 ? { localBindings } : {}),
          confidence: "INFERRED"
        });
        continue;
      }

      if (byName.has("impl.stmt")) {
        const classNode = byName.get("impl.class");
        const ifaceNames = match.captures
          .filter((c) => c.name === "impl.iface")
          .map((c) => c.node.text);
        if (classNode && ifaceNames.length > 0) {
          implementsSites.push({
            fromFile: file.relativePath,
            className: classNode.text,
            ifaceNames,
            line: classNode.startPosition.row + 1
          });
        }
        continue;
      }
    }
  } finally {
    tree.delete();
  }

  return { symbols, swiftModuleSymbols, imports, callSites, implementsSites, parseErrors };
}

/**
 * Whether the other files of a Swift module can reach this declaration by name.
 *
 * There is no `import` between the files of one module, so a sibling file sees
 * every top-level declaration that is not narrowed to its own file. Two
 * exclusions follow, and both are load-bearing when a name is looked up
 * module-wide:
 *
 * - **Not top-level.** A method, a protocol requirement or a type nested in
 *   another type is reached through its container, not by a bare name. Admitting
 *   one would let an unqualified call in one file bind to an unrelated method in
 *   another, and two same-named members would also look like an ambiguous module
 *   name and suppress a resolution that was correct.
 * - **Not file-scoped.** `private` and `fileprivate` narrow a declaration to the
 *   file that declares it (or to its enclosing declaration), so a sibling cannot
 *   see it. `private(set)` narrows only the setter and is *not* file-scoped;
 *   the grammar reports it as `private(set)`, which the comparison below leaves
 *   alone.
 *
 * Absence of a `modifiers` child means the default, `internal`, which the whole
 * module sees.
 *
 * `namedChildren` is typed `(Node | null)[]` in web-tree-sitter, so both child
 * lookups below are null-guarded with `?.`. The `?.` is load-bearing: without it
 * the callbacks would have to reason about a null hole, and `tsc --noEmit`
 * rejects them.
 */
function isSwiftModuleVisible(decl: Node): boolean {
  if (decl.parent?.type !== "source_file") {
    return false;
  }
  const modifiers = decl.namedChildren.find((child) => child?.type === "modifiers");
  if (!modifiers) {
    return true;
  }
  return !modifiers.namedChildren.some(
    (child) =>
      child?.type === "visibility_modifier" && (child.text === "private" || child.text === "fileprivate")
  );
}

function symbolId(file: string, kind: AstSymbolKind, name: string): string {
  const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `${file}#${kindLabel}:${name}`;
}

/** web-tree-sitter types `namedChildren` as `(Node | null)[]`; drop the holes. */
function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function addSwiftName(name: string, names: Set<string>): void {
  // `_` is the "no internal name" placeholder, not a binding. Nothing else is
  // tested here: every caller passes the text of a `simple_identifier` or a
  // `type_identifier`, which is the grammar's own verdict that the token is a
  // name, so there is no shape left to check. The character class that used to
  // guard this was the defect — widened to Unicode letters it still dropped
  // escaped identifiers such as `` `repeat` `` (which Swift requires when a name
  // collides with a keyword) and symbol or emoji names, so a parameter with such
  // a name never reached `localBindings` and a same-named sibling function won
  // the fallback.
  if (name !== "_") {
    names.add(name);
  }
}


/**
 * The names in one top-level declaration that stop a call inside it from
 * resolving through Swift module scope.
 *
 * `call-resolver` decides *which module* a bare call belongs to, but only the
 * syntax tree knows whether the callee is genuinely a module-level declaration:
 * `run(work:) { work() }` calls its parameter, and a `let work = ...` above the
 * call wins over a sibling file's `func work()`. Resolving those against the
 * module fabricates a cross-file edge, which is worse than missing one, so the
 * names are gathered here — while the tree is still in hand — and carried on the
 * call site.
 *
 * The question asked is deliberately *closed*: does the name occur anywhere else
 * in this declaration? Every construct that can introduce a name — a parameter, a
 * local `let`, `if let`, `guard let`, `for … in`, `catch let`, `case let`, a
 * stored property, a generic parameter, a closure capture list — puts that name
 * somewhere else in the declaration, whether or not this walk understands the
 * construct. Enumerating the constructs instead is precisely what makes a
 * whitelist the defect: there is always one more binding form, and that was the
 * shape of every review round this file has had.
 *
 * The cost is paid on the other side, deliberately. A name that merely *appears*
 * in the declaration — a value passed around rather than bound, a sibling
 * statement's local — suppresses the resolution too. Over-suppressing costs a
 * resolution; the opposite error invents an edge, and that asymmetry is the
 * point.
 */
function collectSwiftShadowedNames(node: Node, names: Set<string>, insideArgument = false): void {
  if (node.type === "simple_identifier" || node.type === "type_identifier") {
    // An argument is an expression position: `consume(work)` mentions `work`, it
    // does not bind it. Counting the mention suppresses the resolution of every
    // `work()` in the declaration — including the call that passes its own name,
    // `work(work)`, whose callee is the very thing the argument names.
    if (!insideArgument) {
      addSwiftName(node.text, names);
    }
    return;
  }
  // A type position such as `Int` in `(work: Int)` names a type, not a value;
  // collecting it would shadow every call to a same-named function. A generic
  // parameter is a `type_identifier` too, but it never sits under `user_type`,
  // so it still lands in the set.
  if (node.type === "user_type") {
    return;
  }
  // The name a *call* goes through is a use, not a binding. Without this,
  // `work(); work()` has each call count the other one's identifier as evidence,
  // and both cross-file resolutions are suppressed. Arguments are still walked,
  // so a closure that does bind a name — `handler { work in work() }` — keeps
  // counting.
  if (node.type === "call_expression") {
    for (const child of namedChildrenOf(node)) {
      if (child.type === "navigation_expression" || child.type === "simple_identifier") {
        continue;
      }
      collectSwiftShadowedNames(child, names, insideArgument);
    }
    return;
  }
  // A closure opens a scope, so its parameters and captures bind for real however
  // the closure itself was reached — including as an argument — and the argument
  // marker is cleared on the way in. Everything else keeps the marker it was
  // given.
  const childInsideArgument = node.type === "lambda_literal" ? false : insideArgument || node.type === "value_arguments";
  for (const child of namedChildrenOf(node)) {
    collectSwiftShadowedNames(child, names, childInsideArgument);
  }
}

/**
 * The shadowing names of every top-level declaration in a file.
 *
 * Built once per file, not once per call. The ancestors a call could be shadowed
 * by are the scopes between it and the file, and their union is exactly the
 * top-level declaration that holds the call — so reading that declaration whole
 * yields the same names, at one traversal per declaration instead of a subtree
 * walk per call. The per-call version made a function holding N calls cost
 * O(N²) AST visits.
 *
 * Read whole, the declaration no longer excludes the call's own subtree, and
 * that side effect mattered: a name appearing only in the call's own arguments
 * used to be invisible, so `work(work)` still resolved through its callee.
 * Marking argument positions restores that — and goes one step further, since a
 * mention in a *sibling* call (`consume(work)` before a bare `work()`) was
 * counted as a binding by the older version as well. An argument is an
 * expression position: it can mention a name, never bind one. A closure reached
 * through an argument still opens its own scope, so its parameters and captures
 * are collected.
 *
 * Keyed by `startIndex`: top-level declarations do not overlap, and tree-sitter
 * hands out a fresh wrapper on every navigation, so node identity is not
 * something a `Map` can be built on.
 */
function buildSwiftShadowedNames(root: Node): Map<number, string[]> {
  const byDeclaration = new Map<number, string[]>();
  for (const declaration of namedChildrenOf(root)) {
    const names = new Set<string>();
    collectSwiftShadowedNames(declaration, names);
    byDeclaration.set(declaration.startIndex, [...names]);
  }
  return byDeclaration;
}

/**
 * The shadowing names for one call site, read off the map built above.
 *
 * The scope that can shadow the name is the top-level declaration holding the
 * call: it is the outermost ancestor below the file, and the file's own module
 * level is what the fallback resolves *against*, so it cannot also be what
 * shadows the name. A call that *is* a top-level statement has no such
 * declaration above it, and the map holds only its own bare callee — which is
 * skipped as a callee position, leaving the empty set the per-call walk
 * produced.
 */
function swiftShadowedNamesAt(node: Node, byDeclaration: Map<number, string[]>): string[] {
  let scope: Node = node;
  while (scope.parent && scope.parent.type !== "source_file") {
    scope = scope.parent;
  }
  return byDeclaration.get(scope.startIndex) ?? [];
}

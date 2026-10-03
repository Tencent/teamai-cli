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
import type { SwiftMemberName } from "./module-scope.js";
import { grammarForExtension, getLanguage, getParser, getQuery } from "./parser-registry.js";
import type { AstCallSite, AstImplementsSite, AstImport, AstSymbol, AstSymbolKind } from "./types.js";

export interface FileWalkResult {
  symbols: AstSymbol[];
  /**
   * Swift only: the declarations a sibling file of the same module can reach by
   * name. Empty for every other language, and a subset of `symbols` for Swift.
   */
  swiftModuleSymbols: AstSymbol[];
  /**
   * Swift only: every name a type in this file declares as a member, paired
   * with the file so the module index can scope it. Disjoint from
   * `swiftModuleSymbols` — a member is not reachable by a bare name from a
   * sibling file. What they are needed for is the opposite question: a bare
   * name *inside* a type may be one of these, in which case it is not the
   * module-level declaration of the same name.
   *
   * Names, not symbols: a `let work: () -> Int` is callable under a bare name
   * just like a `func work()`, and a property is not a symbol this walker
   * extracts, so the question cannot be answered off the symbol list.
   */
  swiftMemberNames: SwiftMemberName[];
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
  const swiftMemberNames: SwiftMemberName[] = [];
  const imports: AstImport[] = [];
  const callSites: AstCallSite[] = [];
  const implementsSites: AstImplementsSite[] = [];
  const parseErrors: string[] = [];

  if (!isAstParseableFile(file.relativePath)) {
    return { symbols, swiftModuleSymbols, swiftMemberNames, imports, callSites, implementsSites, parseErrors };
  }

  if (Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES) {
    parseErrors.push(`skipped large file: ${file.relativePath}`);
    return { symbols, swiftModuleSymbols, swiftMemberNames, imports, callSites, implementsSites, parseErrors };
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
    return { symbols, swiftModuleSymbols, swiftMemberNames, imports, callSites, implementsSites, parseErrors };
  }

  if (!tree) {
    parseErrors.push(`parse returned null: ${file.relativePath}`);
    return { symbols, swiftModuleSymbols, swiftMemberNames, imports, callSites, implementsSites, parseErrors };
  }

  try {
    const query = getQuery(variant);
    const exportLineStarts = collectExportLineStarts(variant, tree.rootNode);
    // One traversal per file, shared by every call site below: doing this per
    // call would re-walk the enclosing declaration once for each of its calls.
    const swiftShadowedNames =
      variant === "swift" ? buildSwiftShadowedNames(tree.rootNode) : undefined;
    if (variant === "swift") {
      const names = new Set<string>();
      collectSwiftMemberNames(tree.rootNode, names);
      for (const name of names) {
        swiftMemberNames.push({ file: file.relativePath, name });
      }
    }

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
        const enclosedByType = variant === "swift" && isInsideSwiftTypeBody(callNode);
        callSites.push({
          fromFile: file.relativePath,
          line,
          calleeText,
          receiver,
          ...(localBindings.length > 0 ? { localBindings } : {}),
          ...(enclosedByType ? { enclosedByType } : {}),
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

  return { symbols, swiftModuleSymbols, swiftMemberNames, imports, callSites, implementsSites, parseErrors };
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

/**
 * tree-sitter-swift puts the members of a class, a struct, an actor or an
 * `extension` in a `class_body`, an enum's in an `enum_class_body` and a
 * protocol's requirements in a `protocol_body`.
 */
const SWIFT_TYPE_BODIES = new Set(["class_body", "enum_class_body", "protocol_body"]);

/**
 * Every name the types in a file declare as a member.
 *
 * Read off the tree rather than off the symbols the query captures, because the
 * query captures functions and types only: a `let work: () -> Int` is called as
 * `work()` exactly like a `func work()`, and so is a `var` holding a closure, so
 * a set built from function captures alone still lets the module-level fallback
 * claim a bare call that one of them answers.
 *
 * A declaration names itself one of two ways, and both are taken here:
 *
 * - a `name` field holding an identifier — a method, a nested type, a
 *   `typealias`, an `init`, an enum case;
 * - a `pattern` child — how `property_declaration` and
 *   `protocol_property_declaration` carry their name, including the several
 *   names of `let (a, b) = ...`. Descending the pattern is what
 *   `collectSwiftShadowedNames` already does for a local binding.
 *
 * A `subscript_declaration` has neither (its `name` field is the return type) and
 * is not reachable by a bare name anyway, so it contributes nothing.
 *
 * A declaration inside a function body is deliberately not a member: it sits
 * under `statements`, not under a type body, and nothing outside that body can
 * be referring to it. The enclosing-scope bindings on the call site already
 * cover that case.
 */
function collectSwiftMemberNames(node: Node, names: Set<string>): void {
  if (SWIFT_TYPE_BODIES.has(node.type)) {
    for (const member of namedChildrenOf(node)) {
      const name = member.childForFieldName("name");
      if (name && (name.type === "simple_identifier" || name.type === "type_identifier")) {
        addSwiftName(name.text, names);
        continue;
      }
      for (const child of namedChildrenOf(member)) {
        if (child.type === "pattern") {
          collectSwiftShadowedNames(child, names);
        }
      }
    }
  }
  for (const child of namedChildrenOf(node)) {
    collectSwiftMemberNames(child, names);
  }
}

/**
 * Whether a call sits lexically inside the body of a type.
 *
 * Swift reads an unqualified `work()` as `self.work()` only inside a type; in a
 * free function or at the top level of a file there is no `self`, so the same
 * call can only be the module-level `work`. The member names the index carries
 * are module-wide, so without this the veto reaches a call no type encloses and
 * drops an edge that nothing shadows.
 *
 * Lexical enclosure is all that is asked, and all this can answer: whether the
 * enclosing type is the one that *declares* the member needs the module's
 * inheritance and conformance graph, which this layer does not build.
 */
function isInsideSwiftTypeBody(node: Node): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (SWIFT_TYPE_BODIES.has(scope.type)) {
      return true;
    }
  }
  return false;
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
 * What is gathered is the set of names the declaration *binds*. The version this
 * replaces asked a different and open question — does this name occur anywhere
 * else in the declaration? — and answered it too broadly on both sides: an
 * argument mention (`consume(work)`) and an initializer mention
 * (`let alias = work`) are uses, yet they were collected as bindings and
 * suppressed the module lookup of every `work()` behind them. Each review round
 * found one more position of that kind, because "occurs somewhere" is satisfied
 * by every expression position there is.
 *
 * Binding, unlike occurrence, is finite: a Swift declaration can introduce a
 * name only in the ways `isSwiftBindingPosition` recognises, and those are fixed
 * by the language rather than by the review round. Asking the narrower question
 * is what lets this terminate.
 */
function collectSwiftShadowedNames(node: Node, names: Set<string>): void {
  // A type position names a type, not a value, and must not shadow a call. The
  // field rule below rejects these on its own — a `type_identifier` under
  // `user_type` carries no field naming it — so this states the constraint
  // directly rather than resting on that: a generic parameter is a
  // `type_identifier` too, and it *does* bind, one level down at `type_parameter`.
  if (node.type === "user_type") {
    return;
  }
  if (node.type === "simple_identifier" || node.type === "type_identifier") {
    if (isSwiftBindingPosition(node)) {
      addSwiftName(node.text, names);
    }
    return;
  }
  for (const child of namedChildrenOf(node)) {
    collectSwiftShadowedNames(child, names);
  }
}

/**
 * Whether this identifier is where a name is *bound* rather than where one is
 * *used*.
 *
 * The identifier alone cannot say — `work` binds in `let work = 1` and is used
 * in `let alias = work` — so the answer is read off its parent, which
 * tree-sitter-swift marks in one of two ways:
 *
 * - a grammar **field**: `name` on a declaration, a parameter, a closure
 *   parameter or a capture-list entry; `bound_identifier` on the name an
 *   `if let` / `guard let` / `while let` introduces.
 * - a **container node** with no field to key on: `pattern`, which carries the
 *   names a `let` / `var` / `for` / `catch` / `case` binds one level down or
 *   several (a tuple pattern nests `pattern` inside `pattern`), and
 *   `type_parameter`, which is how a generic parameter is declared.
 *
 * Every other position is a use by construction — an initializer, an argument, a
 * receiver, an assigned-to target, a bare expression — and none of them appear
 * above, so none of them are collected. That is the point: this is an allow-list
 * of the language's name-introduction sites, not a deny-list of the positions a
 * review has found so far.
 */
function isSwiftBindingPosition(node: Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (parent.type === "pattern" || parent.type === "type_parameter") {
    return true;
  }
  return (
    sameSpan(parent.childForFieldName("name"), node) ||
    sameSpan(parent.childForFieldName("bound_identifier"), node)
  );
}

/**
 * web-tree-sitter hands out a fresh wrapper on every navigation, so two nodes
 * that cover the same source are not `===`. Compare the spans instead.
 */
function sameSpan(candidate: Node | null, node: Node): boolean {
  return candidate !== null && candidate.startIndex === node.startIndex && candidate.endIndex === node.endIndex;
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
 * Reading the declaration whole is also what forced the *position* exclusions
 * the earlier version carried. A subtree walk from the call never entered the
 * call's own arguments, so `work(work)` resolved even though its argument
 * mentions its callee; reading the declaration brought that mention in, and it
 * took one exclusion. `let alias = work` then needed a second. Collecting
 * binding positions makes the question the whole-declaration read asks the same
 * question as before, so nothing is left to exclude.
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
 * declaration above it, so nothing was keyed under it and the lookup yields the
 * empty set — its bare callee is not a binding position in any case.
 */
function swiftShadowedNamesAt(node: Node, byDeclaration: Map<number, string[]>): string[] {
  let scope: Node = node;
  while (scope.parent && scope.parent.type !== "source_file") {
    scope = scope.parent;
  }
  return byDeclaration.get(scope.startIndex) ?? [];
}

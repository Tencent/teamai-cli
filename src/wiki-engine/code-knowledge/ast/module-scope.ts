import type { AstSymbol, AstSymbolKind } from "./types.js";

/**
 * Swift has no source-level package or module declaration — unlike Go's
 * `package` clause or Python's file-as-module rule, the module boundary is a
 * build-system fact that the AST cannot read. The only layout with a mandated
 * shape is SwiftPM: everything under `<package>/Sources/<Target>/` is one
 * module, and everything under `<package>/Tests/<Target>/` is another (test
 * targets see the library through `@testable import`, not by being the same
 * module).
 *
 * The key spans the path *up to and including* the target directory, not just
 * the `Sources/<Target>` tail. One repository can hold several Swift packages
 * side by side, and `Packages/A/Sources/App` and `Packages/B/Sources/App` are
 * two different modules that happen to share their last two segments; keying on
 * the tail alone would merge them and let a name in one package resolve into
 * the other.
 *
 * The marker that counts is the *innermost* one, because a package can also be
 * nested under a directory the outer package already named `Sources` or `Tests`:
 * `Tests/Fixtures/A/Sources/App` is package A's target `App`, not a target of the
 * outer package. Derived from the path shape alone, this is still an inference,
 * so the scan is deliberately biased towards under-scoping — see the loop below.
 *
 * Outside that layout this function returns `undefined` on purpose. Guessing a
 * module boundary from an arbitrary directory tree would fabricate edges
 * between files that Swift actually keeps apart, and a wrong edge is worse than
 * a missing one: the missing one still surfaces as a gap.
 */
export function swiftModuleScope(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/gu, "/");
  if (!normalized.toLowerCase().endsWith(".swift")) {
    return undefined;
  }
  const segments = normalized.split("/");
  // The innermost marker wins, so the scan runs from the end. A repository may
  // vendor whole packages beneath a directory of its own named `Tests` or
  // `Sources` — `Tests/Fixtures/A/Sources/App` and `Tests/Fixtures/B/Sources/App`
  // are two packages that share an outer `Tests` segment, and taking the first
  // marker would scope both to `Tests/Fixtures` and merge them.
  //
  // The direction also decides how a layout this function misreads can fail.
  // An inner marker can only ever yield a scope nested *inside* the true module,
  // which loses a resolution; an outer one can span two real modules, which
  // fabricates an edge. Missing beats wrong here for the same reason it does
  // everywhere else in this layer.
  //
  // The loop stops before the last two segments: they have to hold the marker
  // and the target directory, so `Sources/App.swift` states no target and gets
  // no scope.
  for (let index = segments.length - 3; index >= 0; index--) {
    const segment = segments[index];
    if (segment !== "Sources" && segment !== "Tests") {
      continue;
    }
    return segments.slice(0, index + 2).join("/");
  }
  return undefined;
}

/** A name a type declares as a member, and the file that declares it. */
export interface SwiftMemberName {
  file: string;
  name: string;
}

export interface SwiftModuleSymbolIndex {
  /** Module scope key → every declaration found in that module. */
  byModule: Map<string, AstSymbol[]>;
  /** File → its module scope key, for files that sit inside a known module. */
  scopeOfFile: Map<string, string>;
  /** Module scope key → every name a type in that module declares as a member. */
  memberNames: Map<string, Set<string>>;
}

/**
 * Index the declarations that a sibling file can reach by name.
 *
 * The caller supplies module-visible declarations only — top-level, and not
 * `private` / `fileprivate`. Neither fact survives into `AstSymbol`, so it
 * cannot be re-checked here; handing this function the full symbol list instead
 * would let a method, a protocol requirement or a file-scoped declaration
 * resolve from another file, which is exactly the fabricated edge this layer
 * exists to avoid. `walk.ts` decides it, at the point where the declaration node
 * is still in hand.
 *
 * `members` is the complement the lookup below cannot do without: the names
 * that belong to a type's body. They are not candidates — a bare name never
 * reaches a member of another file's type — but they say when a bare name is
 * not a candidate for the module level either, which is what
 * `swiftModuleDeclaresMember` is for. Names rather than symbols, because a
 * property is callable under a bare name and is not a symbol this layer
 * extracts.
 */
export function buildSwiftModuleSymbolIndex(
  symbols: AstSymbol[],
  members: SwiftMemberName[]
): SwiftModuleSymbolIndex {
  const byModule = new Map<string, AstSymbol[]>();
  const scopeOfFile = new Map<string, string>();
  const memberNames = new Map<string, Set<string>>();

  for (const member of members) {
    const scope = swiftModuleScope(member.file);
    if (!scope) {
      continue;
    }
    const names = memberNames.get(scope);
    if (names) {
      names.add(member.name);
    } else {
      memberNames.set(scope, new Set([member.name]));
    }
  }

  for (const symbol of symbols) {
    const scope = swiftModuleScope(symbol.file);
    if (!scope) {
      continue;
    }
    scopeOfFile.set(symbol.file, scope);
    const bucket = byModule.get(scope);
    if (bucket) {
      bucket.push(symbol);
    } else {
      byModule.set(scope, [symbol]);
    }
  }

  return { byModule, scopeOfFile, memberNames };
}

/**
 * Whether a type in `fromFile`'s module declares `name` as a member.
 *
 * A bare call inside a type runs that type's member when one is named after the
 * callee, and the member can come from anywhere: the type itself, a superclass,
 * an `extension` in a third file, a protocol's default implementation. None of
 * those are visible to a lookup that only knows the module's top-level
 * declarations, so a module-level function of the same name looks like the only
 * candidate and is claimed as the target.
 *
 * Answering the question per type would need the inheritance and conformance
 * graph of the whole module, which this layer does not build. Asking it of the
 * module — does *any* type declare this member? — needs only the names already
 * extracted, and errs the way the rest of the layer errs: a call *inside a type*
 * that does turn out to be the module-level one, made from a module where some
 * unrelated type declares a member of the same name, loses its edge. A missing
 * edge still shows up as a gap; an invented one is read as a fact.
 *
 * The caller decides which calls the question is put for, and puts it only for
 * those a type lexically encloses: outside a type there is no `self` for a bare
 * name to be read off, so no member can answer it.
 */
export function swiftModuleDeclaresMember(
  index: SwiftModuleSymbolIndex,
  fromFile: string,
  name: string
): boolean {
  const scope = index.scopeOfFile.get(fromFile) ?? swiftModuleScope(fromFile);
  if (!scope) {
    return false;
  }
  return index.memberNames.get(scope)?.has(name) === true;
}

/**
 * Find the single declaration of `name` in the same Swift module as `fromFile`.
 *
 * Returns `undefined` when the name is declared in another module, not at all,
 * or more than once inside this one. An ambiguous name means the layout cannot
 * say which file it lives in, so the caller records nothing rather than picking
 * one arbitrarily — the same reasoning the module-import gap already follows.
 *
 * Declarations in `fromFile` are excluded: the same-file lookup in the caller
 * already covers those, and admitting them here would let a same-file match
 * arrive through the cross-file path.
 */
export function findSwiftModuleSymbol(
  index: SwiftModuleSymbolIndex,
  fromFile: string,
  name: string,
  kinds: readonly AstSymbolKind[]
): AstSymbol | undefined {
  const scope = index.scopeOfFile.get(fromFile) ?? swiftModuleScope(fromFile);
  if (!scope) {
    return undefined;
  }
  const matches = (index.byModule.get(scope) ?? []).filter(
    (symbol) => symbol.name === name && symbol.file !== fromFile && kinds.includes(symbol.kind)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

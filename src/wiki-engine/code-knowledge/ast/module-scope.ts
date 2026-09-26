import type { AstSymbol, AstSymbolKind } from "./types.js";

/**
 * Swift has no source-level package or module declaration — unlike Go's
 * `package` clause or Python's file-as-module rule, the module boundary is a
 * build-system fact that the AST cannot read. The only layout with a mandated
 * shape is SwiftPM: everything under `Sources/<Target>/` is one module, and
 * everything under `Tests/<Target>/` is another (test targets see the library
 * through `@testable import`, not by being the same module).
 *
 * Outside that layout this function returns `undefined` on purpose. Guessing a
 * module boundary from an arbitrary directory tree would fabricate edges
 * between files that Swift actually keeps apart, and a wrong edge is worse than
 * a missing one: the missing one still surfaces as a gap.
 */
const SWIFT_MODULE_DIRECTORY = /(?:^|\/)(Sources|Tests)\/([^/]+)\//u;

/** Module scope key (`Sources/Foo`, `Tests/FooTests`) for a Swift file, if the layout states one. */
export function swiftModuleScope(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/gu, "/");
  if (!normalized.toLowerCase().endsWith(".swift")) {
    return undefined;
  }
  const match = SWIFT_MODULE_DIRECTORY.exec(normalized);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

export interface SwiftModuleSymbolIndex {
  /** Module scope key → every declaration found in that module. */
  byModule: Map<string, AstSymbol[]>;
  /** File → its module scope key, for files that sit inside a known module. */
  scopeOfFile: Map<string, string>;
}

export function buildSwiftModuleSymbolIndex(symbols: AstSymbol[]): SwiftModuleSymbolIndex {
  const byModule = new Map<string, AstSymbol[]>();
  const scopeOfFile = new Map<string, string>();

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

  return { byModule, scopeOfFile };
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

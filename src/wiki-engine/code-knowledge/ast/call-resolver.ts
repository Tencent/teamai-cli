import type { AstCallSite, AstImport, AstSymbol } from "./types.js";
import type { ResolvedImport } from "./import-resolver.js";
import type { SwiftModuleSymbolIndex } from "./module-scope.js";
import { findSwiftModuleSymbol } from "./module-scope.js";

export interface ImportBindingMap {
  /** Local name → exported symbol id in target file */
  localToSymbolId: Map<string, string>;
  /** Local name → resolved target file */
  localToFile: Map<string, string>;
}

export function buildImportBindingsForFile(
  fromFile: string,
  imports: AstImport[],
  resolved: Map<string, ResolvedImport | undefined>,
  symbolsByFile: Map<string, AstSymbol[]>
): ImportBindingMap {
  const localToSymbolId = new Map<string, string>();
  const localToFile = new Map<string, string>();

  for (const imp of imports.filter((i) => i.fromFile === fromFile)) {
    const key = `${imp.fromFile}:${imp.line}`;
    const target = resolved.get(key);
    if (!target) continue;

    localToFile.set(imp.defaultBinding ?? imp.namespaceBinding ?? "", target.targetFile);

    const targetSymbols = symbolsByFile.get(target.targetFile) ?? [];

    if (imp.defaultBinding) {
      const def = targetSymbols.find((s) => s.exported && (s.kind === "function" || s.kind === "class"));
      if (def) localToSymbolId.set(imp.defaultBinding, def.id);
      localToFile.set(imp.defaultBinding, target.targetFile);
    }

    if (imp.namespaceBinding) {
      localToFile.set(imp.namespaceBinding, target.targetFile);
    }

    for (const name of imp.namedBindings ?? []) {
      const local = name;
      const exported = targetSymbols.find((s) => s.name === name && s.exported);
      if (exported) localToSymbolId.set(local, exported.id);
      localToFile.set(local, target.targetFile);
    }
  }

  return { localToSymbolId, localToFile };
}

export function resolveCallSites(
  callSites: AstCallSite[],
  imports: AstImport[],
  resolved: Map<string, ResolvedImport | undefined>,
  symbolsByFile: Map<string, AstSymbol[]>,
  swiftModules?: SwiftModuleSymbolIndex
): AstCallSite[] {
  const bindingsByFile = new Map<string, ImportBindingMap>();
  return callSites.map((site) => {
    let bindings = bindingsByFile.get(site.fromFile);
    if (!bindings) {
      bindings = buildImportBindingsForFile(site.fromFile, imports, resolved, symbolsByFile);
      bindingsByFile.set(site.fromFile, bindings);
    }
    return resolveOneCall(site, symbolsByFile, bindings, swiftModules);
  });
}

function resolveOneCall(
  site: AstCallSite,
  symbolsByFile: Map<string, AstSymbol[]>,
  bindings: ImportBindingMap,
  swiftModules?: SwiftModuleSymbolIndex
): AstCallSite {
  const callee = site.calleeText;

  if (!callee.includes(".")) {
    const localSymbols = symbolsByFile.get(site.fromFile) ?? [];
    const sameFile = localSymbols.find((s) => s.name === callee && (s.kind === "function" || s.kind === "class"));
    if (sameFile) {
      return {
        ...site,
        resolvedTargetId: sameFile.id,
        resolvedTargetFile: site.fromFile,
        confidence: "EXTRACTED"
      };
    }

    const importedId = bindings.localToSymbolId.get(callee);
    const importedFile = bindings.localToFile.get(callee);
    if (importedId) {
      return {
        ...site,
        resolvedTargetId: importedId,
        resolvedTargetFile: importedFile,
        confidence: "EXTRACTED"
      };
    }
    if (importedFile) {
      return { ...site, resolvedTargetFile: importedFile, confidence: "INFERRED" };
    }

    // Swift module scope: a symbol declared elsewhere in the same module is
    // visible without any import, so the same-file and import lookups above
    // cannot be the only ones. INFERRED rather than EXTRACTED because the
    // module boundary itself is read off the directory layout, not the syntax.
    if (swiftModules) {
      const moduleSymbol = findSwiftModuleSymbol(swiftModules, site.fromFile, callee, ["function", "class"]);
      if (moduleSymbol) {
        return {
          ...site,
          resolvedTargetId: moduleSymbol.id,
          resolvedTargetFile: moduleSymbol.file,
          confidence: "INFERRED"
        };
      }
    }

    return site;
  }

  const [recv, member] = callee.split(".", 2);
  if (!recv || !member) return site;

  const importedFile = bindings.localToFile.get(recv);
  if (importedFile) {
    const targetSymbols = symbolsByFile.get(importedFile) ?? [];
    const sym = targetSymbols.find((s) => s.name === member);
    if (sym) {
      return {
        ...site,
        resolvedTargetId: sym.id,
        resolvedTargetFile: importedFile,
        receiver: recv,
        confidence: "EXTRACTED"
      };
    }
    return { ...site, resolvedTargetFile: importedFile, receiver: recv, confidence: "INFERRED" };
  }

  const localSymbols = symbolsByFile.get(site.fromFile) ?? [];
  const localClass = localSymbols.find((s) => s.name === recv && s.kind === "class");
  if (localClass) {
    return { ...site, resolvedTargetFile: site.fromFile, confidence: "INFERRED" };
  }

  // `Service.make()` where `Service` is declared in another file of the same
  // Swift module. Swift convention capitalises type names, so a receiver that
  // matches a module-local class declaration is a type reference and not a
  // local value — the same heuristic the same-file branch above already uses.
  if (swiftModules) {
    const moduleClass = findSwiftModuleSymbol(swiftModules, site.fromFile, recv, ["class"]);
    if (moduleClass) {
      return { ...site, resolvedTargetFile: moduleClass.file, receiver: recv, confidence: "INFERRED" };
    }
  }

  return site;
}

export function callResolutionWeight(confidence: AstCallSite["confidence"]): number {
  switch (confidence) {
    case "EXTRACTED":
      return 0.85;
    case "INFERRED":
      return 0.75;
    default:
      return 0.5;
  }
}

import type { Node } from "web-tree-sitter";

import type { AstImport } from "./types.js";
import type { GrammarVariant } from "./parser-registry.js";

type ImportBindingResult = Pick<AstImport, "namedBindings" | "defaultBinding" | "namespaceBinding">;

/** Parse import statement text into binding metadata (language-aware). */
export function parseImportBindings(
  importText: string,
  variant: GrammarVariant
): ImportBindingResult {
  if (variant === "python") {
    return parsePythonImportBindings(importText);
  }
  if (variant === "go") {
    return {};
  }
  return parseTsImportBindings(importText);
}

function parseTsImportBindings(importText: string): ImportBindingResult {
  const namedBindings: string[] = [];
  let defaultBinding: string | undefined;
  let namespaceBinding: string | undefined;

  const brace = /\{([^}]+)\}/u.exec(importText);
  if (brace) {
    for (const part of brace[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/u)[0]?.trim();
      if (name && name !== "type") namedBindings.push(name);
    }
  }

  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/u.exec(importText);
  if (ns) namespaceBinding = ns[1];

  const dm1 = /^import\s+([A-Za-z_$][\w$]*)\s*,/u.exec(importText);
  const dm2 = /^import\s+([A-Za-z_$][\w$]*)\s+from/u.exec(importText);
  const defaultMatch = dm1 ?? dm2;
  if (defaultMatch && !importText.includes("{")) {
    defaultBinding = defaultMatch[1];
  }

  return { namedBindings: namedBindings.length > 0 ? namedBindings : undefined, defaultBinding, namespaceBinding };
}

function parsePythonImportBindings(importText: string): ImportBindingResult {
  const namedBindings: string[] = [];
  let defaultBinding: string | undefined;
  let namespaceBinding: string | undefined;

  const fromImport = /^from\s+[\w.]+\s+import\s+(.+)$/u.exec(importText.trim());
  if (fromImport) {
    const tail = fromImport[1];
    if (tail.startsWith("(") && tail.endsWith(")")) {
      for (const part of tail.slice(1, -1).split(",")) {
        const token = part.trim().split(/\s+as\s+/u)[0]?.trim();
        if (token && token !== "*") namedBindings.push(token);
      }
    } else if (tail === "*") {
      namespaceBinding = "*";
    } else {
      for (const part of tail.split(",")) {
        const token = part.trim().split(/\s+as\s+/u)[0]?.trim();
        if (!token) continue;
        if (!defaultBinding) defaultBinding = token;
        else namedBindings.push(token);
      }
    }
  }

  const plain = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/u.exec(importText.trim());
  if (plain) {
    if (plain[2]) namespaceBinding = plain[2];
    else defaultBinding = plain[1].split(".").pop();
  }

  return { namedBindings: namedBindings.length > 0 ? namedBindings : undefined, defaultBinding, namespaceBinding };
}

/** Normalize import specifier from tree-sitter capture text. */
export function normalizeImportSpecifier(specText: string, variant: GrammarVariant): string {
  if (variant === "go") {
    return specText.replace(/^["`]|["`]$/gu, "");
  }
  return specText.replace(/^['"]|['"]$/gu, "");
}

export function isTypeOnlyImport(importText: string, variant: GrammarVariant): boolean {
  if (variant === "typescript" || variant === "tsx") {
    return /^\s*import\s+type\b/u.test(importText);
  }
  return false;
}

export function isExportedSymbol(
  variant: GrammarVariant,
  startIndex: number,
  source: string,
  lineStart: number,
  exportLineStarts: Set<number>
): boolean {
  if (variant === "typescript" || variant === "tsx") {
    return exportLineStarts.has(lineStart) || isTsExportedDeclaration(startIndex, source);
  }
  if (variant === "python") {
    return exportLineStarts.has(lineStart);
  }
  if (variant === "go") {
    const decl = source.slice(Math.max(0, startIndex - 20), startIndex);
    return /^func\s+[A-Z]/u.test(decl.trimStart()) || /^type\s+[A-Z]/u.test(decl.trimStart());
  }
  return false;
}

function isTsExportedDeclaration(startIndex: number, source: string): boolean {
  const prefix = source.slice(Math.max(0, startIndex - 80), startIndex);
  return /\bexport\s+(?:default\s+)?$/u.test(prefix.trimEnd());
}

export function collectExportLineStarts(
  variant: GrammarVariant,
  root: Node
): Set<number> {
  const lines = new Set<number>();
  if (variant === "typescript" || variant === "tsx") {
    for (const node of root.descendantsOfType("export_statement")) {
      if (node) lines.add(node.startPosition.row + 1);
    }
  }
  if (variant === "python") {
    // Python has no export keyword: treat module-level class/function
    // definitions as importable (tree-sitter-python has no "__export__" node).
    for (const node of root.descendantsOfType(["class_definition", "function_definition"])) {
      if (node && node.parent?.type === "module") {
        lines.add(node.startPosition.row + 1);
      }
    }
  }
  return lines;
}

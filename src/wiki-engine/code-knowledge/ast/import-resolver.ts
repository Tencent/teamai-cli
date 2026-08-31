import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { toPosix } from "../../core/wiki-protocol.js";

const EXTENSIONS_TS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_SUFFIXES_TS = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
const EXTENSIONS_PY = [".py"];
const INDEX_SUFFIXES_PY = ["/__init__.py"];
const EXTENSIONS_GO = [".go"];
/** Matches a dotted module identifier (e.g. `pkg.sub.mod`), used by Python/Go import resolution. */
const MODULE_IDENTIFIER_RE = /^[A-Za-z_][\w.]*$/u;

export interface TsconfigPathsConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
}

export interface ResolvedImport {
  targetFile: string;
  confidence: "EXTRACTED" | "AMBIGUOUS";
  candidates?: string[];
}

const tsconfigCache = new Map<string, TsconfigPathsConfig | null>();

/** Find nearest tsconfig.json upward from a file directory. */
export async function loadTsconfigPaths(
  repoRoot: string,
  fromRelativeFile: string
): Promise<TsconfigPathsConfig | null> {
  const absDir = path.dirname(path.resolve(repoRoot, fromRelativeFile));
  let dir = absDir;
  const root = path.resolve(repoRoot);

  while (dir === root || dir.startsWith(root + path.sep)) {
    if (tsconfigCache.has(dir)) {
      return tsconfigCache.get(dir) ?? null;
    }

    const configPath = path.join(dir, "tsconfig.json");
    try {
      const raw = JSON.parse(await readFile(configPath, "utf8")) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const configDir = path.dirname(configPath);
      const baseUrl = raw.compilerOptions?.baseUrl ?? ".";
      const pathsMap = raw.compilerOptions?.paths ?? {};
      const resolved: TsconfigPathsConfig = {
        baseUrl: toPosix(path.resolve(configDir, baseUrl)),
        paths: Object.fromEntries(
          Object.entries(pathsMap).map(([key, values]) => [
            key,
            values.map((v) => {
              const withoutStar = v.replace(/\*$/u, "");
              return toPosix(path.resolve(configDir, baseUrl, withoutStar));
            })
          ])
        )
      };
      tsconfigCache.set(dir, resolved);
      return resolved;
    } catch {
      // try parent
    }

    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  tsconfigCache.set(absDir, null);
  return null;
}


export async function resolveImportSpecifier(
  repoRoot: string,
  fromFile: string,
  specifier: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<ResolvedImport | undefined> {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolveRelativeImport(fromFile, specifier, fileExists);
  }

  if (fromFile.endsWith(".py") || fromFile.endsWith(".go")) {
    const sibling = await resolveSiblingModuleImport(fromFile, specifier, fileExists);
    if (sibling) return sibling;
    if (fromFile.endsWith(".py")) {
      const absolutePkg = await resolveAbsolutePackageImport(fromFile, specifier, fileExists);
      if (absolutePkg) return absolutePkg;
    }
  }

  const tsconfig = await loadTsconfigPaths(repoRoot, fromFile);
  if (tsconfig) {
    const mapped = await resolvePathsMapping(repoRoot, tsconfig, specifier, fromFile, fileExists);
    if (mapped) return mapped;
  }

  return undefined;
}

async function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<ResolvedImport | undefined> {
  const fromDir = path.dirname(fromFile);
  const base = toPosix(path.normalize(path.join(fromDir, specifier)));
  const candidates = await expandModulePaths(base, fromFile, fileExists);
  return pickCandidate(candidates);
}

/** Resolve `from b import` (Python) or local package dir imports (Go) via sibling path. */
async function resolveSiblingModuleImport(
  fromFile: string,
  specifier: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<ResolvedImport | undefined> {
  if (!MODULE_IDENTIFIER_RE.test(specifier)) {
    return undefined;
  }
  const fromDir = path.dirname(fromFile);
  // Python dotted modules (a.b.c) map to nested paths (a/b/c); other langs keep the specifier as-is.
  const modulePath = fromFile.endsWith(".py") ? specifier.replace(/\./gu, "/") : specifier;
  const base = toPosix(path.normalize(path.join(fromDir, modulePath)));
  const candidates = await expandModulePaths(base, fromFile, fileExists);
  return pickCandidate(candidates);
}

/**
 * Resolve a Python absolute package import from the repo root.
 *
 * Python code commonly imports via the top-level package name rooted at the
 * repository root (e.g. `from hai_flow.conf import config`), not relative to the
 * importing file's directory. This maps the dotted specifier directly onto a
 * repo-root-relative path (a.b.c -> a/b/c) and probes for a module file or
 * package `__init__.py`. Only applies to Python source files.
 *
 * @param fromFile     Repo-root-relative path of the importing file.
 * @param specifier    The (non-relative) import specifier, e.g. "hai_flow.conf".
 * @param fileExists   Predicate checking a repo-root-relative path exists.
 * @returns            Resolved import, or undefined when no repo-root path matches.
 */
async function resolveAbsolutePackageImport(
  fromFile: string,
  specifier: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<ResolvedImport | undefined> {
  if (!fromFile.endsWith(".py")) {
    return undefined;
  }
  if (!MODULE_IDENTIFIER_RE.test(specifier)) {
    return undefined;
  }
  const modulePath = specifier.replace(/\./gu, "/");
  const candidates = await expandModulePaths(modulePath, fromFile, fileExists);
  return pickCandidate(candidates);
}

async function resolvePathsMapping(
  repoRoot: string,
  config: TsconfigPathsConfig,
  specifier: string,
  fromFile: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<ResolvedImport | undefined> {
  const root = path.resolve(repoRoot);
  const entries = Object.entries(config.paths).sort((a, b) => b[0].length - a[0].length);

  for (const [pattern, targets] of entries) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (!specifier.startsWith(`${prefix}/`)) continue;
      const rest = specifier.slice(prefix.length + 1);
      for (const targetBase of targets) {
        const abs = toPosix(path.join(targetBase, rest));
        const rel = toPosix(path.relative(root, abs));
        const candidates = await expandModulePaths(rel, fromFile, fileExists);
        const picked = pickCandidate(candidates);
        if (picked) return picked;
      }
    } else if (pattern === specifier) {
      for (const target of targets) {
        const rel = toPosix(path.relative(root, target));
        const candidates = await expandModulePaths(rel, fromFile, fileExists);
        const picked = pickCandidate(candidates);
        if (picked) return picked;
      }
    }
  }

  return undefined;
}

function moduleExtensions(fromFile: string): { extensions: string[]; indexSuffixes: string[] } {
  if (fromFile.endsWith(".py")) {
    return { extensions: EXTENSIONS_PY, indexSuffixes: INDEX_SUFFIXES_PY };
  }
  if (fromFile.endsWith(".go")) {
    return { extensions: EXTENSIONS_GO, indexSuffixes: [] };
  }
  return { extensions: EXTENSIONS_TS, indexSuffixes: INDEX_SUFFIXES_TS };
}

/** Go: import "./pkg" often maps to pkg/pkg.go when the directory name matches the last segment. */
async function expandGoPackageDir(
  normalized: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<string[]> {
  const found: string[] = [];
  const seg = normalized.split("/").pop();
  if (seg) {
    const nested = `${normalized}/${seg}.go`;
    if (await fileExists(nested)) found.push(nested);
  }
  return found;
}

async function expandModulePaths(
  baseRelative: string,
  fromFile: string,
  fileExists: (relativePath: string) => Promise<boolean>
): Promise<string[]> {
  const found: string[] = [];
  const normalized = baseRelative.replace(/^\.\//u, "");
  const { extensions, indexSuffixes } = moduleExtensions(fromFile);

  for (const ext of extensions) {
    const candidate = `${normalized}${ext}`;
    if (await fileExists(candidate)) found.push(candidate);
  }

  for (const indexSuffix of indexSuffixes) {
    const candidate = `${normalized}${indexSuffix}`;
    if (await fileExists(candidate)) found.push(candidate);
  }

  if (fromFile.endsWith(".go")) {
    found.push(...(await expandGoPackageDir(normalized, fileExists)));
  }

  if (await fileExists(normalized)) found.push(normalized);

  return [...new Set(found)];
}

function pickCandidate(candidates: string[]): ResolvedImport | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) {
    return { targetFile: candidates[0]!, confidence: "EXTRACTED" };
  }
  return { targetFile: candidates[0]!, confidence: "AMBIGUOUS", candidates };
}

export async function buildFileExistenceChecker(
  repoRoot: string,
  knownFiles: Set<string>
): Promise<(relativePath: string) => Promise<boolean>> {
  return async (relativePath: string) => {
    if (knownFiles.has(relativePath)) return true;
    try {
      const abs = path.resolve(repoRoot, relativePath);
      const s = await stat(abs);
      return s.isFile();
    } catch {
      return false;
    }
  };
}

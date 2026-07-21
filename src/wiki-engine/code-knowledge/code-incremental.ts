import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";

import { collectCode, gitCommit, gitDiffNameStatus, isWorkingTreeClean } from "./code-collector.js";
import type { CodeFact } from "./code-extractors.js";
import type { InterfaceInventory } from "../interface-scanner.js";

export interface CodeIncrementalChange {
  added: string[];
  changed: string[];
  deleted: string[];
  affectedPages: string[];
}

export async function detectCodeIncrementalChanges(
  root: string,
  manifestPath: string,
  project: string,
): Promise<CodeIncrementalChange> {
  const previous = (await exists(manifestPath))
    ? (JSON.parse(await readFile(manifestPath, "utf8")) as {
        headSha?: string;
        files?: Array<{ relativePath: string; sha256: string }>;
      })
    : { files: [] };

  const oldSha = previous.headSha;
  const newSha = await gitCommit(root);

  // Git incremental path: only when both commits are known AND the working
  // tree is clean. A dirty tree has uncommitted/untracked changes that a
  // commit-to-commit diff cannot see, so we fall back to the full sha256
  // scan (which reads the working tree) to avoid silent staleness.
  if (oldSha && newSha && (await isWorkingTreeClean(root))) {
    const gitChanges = await gitDiffNameStatus(root, oldSha, newSha);
    if (gitChanges !== null) {
      const { added, changed, deleted } = gitChanges;
      return {
        added,
        changed,
        deleted,
        affectedPages: affectedPages(project, [...added, ...changed, ...deleted]),
      };
    }
  }

  // Fallback: full sha256 comparison when git is unavailable or no baseline
  const current = await collectCode({ root });
  const previousByPath = new Map((previous.files ?? []).map((file) => [file.relativePath, file.sha256]));
  const currentByPath = new Map(current.manifest.files.map((file) => [file.relativePath, file.sha256]));
  const added = [...currentByPath.keys()].filter((file) => !previousByPath.has(file)).sort();
  const changed = [...currentByPath.entries()]
    .filter(([file, sha]) => previousByPath.has(file) && previousByPath.get(file) !== sha)
    .map(([file]) => file)
    .sort();
  const deleted = [...previousByPath.keys()].filter((file) => !currentByPath.has(file)).sort();
  return { added, changed, deleted, affectedPages: affectedPages(project, [...added, ...changed, ...deleted]) };
}

function affectedPages(project: string, files: string[]): string[] {
  const pages = new Set<string>([`code/${project}/index.md`]);
  for (const file of files) {
    if (/config|\.json$|\.ya?ml$/u.test(file)) {
      pages.add(`code/${project}/config.md`);
    }
    if (/error|exception/i.test(file)) {
      pages.add(`code/${project}/error.md`);
    }
    pages.add(`code/${project}/component.md`);
  }
  return [...pages].sort();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

// ─── Facts Cache ──────────────────────────────────────────

const FACTS_CACHE_FILENAME = 'facts-cache.json';
const INTERFACES_CACHE_FILENAME = 'interfaces-cache.json';

export async function loadFactsCache(indicesDir: string): Promise<CodeFact[]> {
  const cachePath = path.join(indicesDir, FACTS_CACHE_FILENAME);
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as CodeFact[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveFactsCache(indicesDir: string, facts: CodeFact[]): Promise<void> {
  await mkdir(indicesDir, { recursive: true });
  await writeFile(path.join(indicesDir, FACTS_CACHE_FILENAME), JSON.stringify(facts), 'utf-8');
}

export async function loadInterfacesCache(indicesDir: string): Promise<InterfaceInventory> {
  const cachePath = path.join(indicesDir, INTERFACES_CACHE_FILENAME);
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as InterfaceInventory;
    return parsed?.entries ? parsed : { entries: [], scannedAt: '' };
  } catch {
    return { entries: [], scannedAt: '' };
  }
}

export async function saveInterfacesCache(
  indicesDir: string,
  inventory: InterfaceInventory,
): Promise<void> {
  await mkdir(indicesDir, { recursive: true });
  await writeFile(
    path.join(indicesDir, INTERFACES_CACHE_FILENAME),
    JSON.stringify(inventory, null, 2),
    'utf-8',
  );
}

export function pruneFactsByFiles(facts: CodeFact[], filesToRemove: Set<string>): CodeFact[] {
  return facts.filter(f => !filesToRemove.has(f.file));
}

export function pruneInterfacesByFiles(
  inventory: InterfaceInventory,
  _filesToRemove: Set<string>,
): InterfaceInventory {
  // InterfaceInventoryEntry.component 粒度为顶层目录（如 "src"），
  // 而 filesToRemove 是具体文件路径——两者粒度不匹配，无法精确剪除。
  // 保守策略：不在此处剪除旧条目，改由调用方在合并时按 component+type 去重。
  return inventory;
}

export function mergeInterfaceInventories(
  old: InterfaceInventory,
  fresh: InterfaceInventory,
): InterfaceInventory {
  // 按 component+type 去重，fresh 优先覆盖 old
  const keyOf = (e: { component: string; type: string }) => `${e.component}:${e.type}`;
  const merged = new Map<string, InterfaceInventory['entries'][number]>();
  for (const e of old.entries) merged.set(keyOf(e), e);
  for (const e of fresh.entries) merged.set(keyOf(e), e);
  return { entries: [...merged.values()], scannedAt: fresh.scannedAt || old.scannedAt };
}

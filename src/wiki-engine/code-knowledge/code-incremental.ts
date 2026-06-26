import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { collectCode } from "./code-collector.js";

export interface CodeIncrementalChange {
  added: string[];
  changed: string[];
  deleted: string[];
  affectedPages: string[];
}

export async function detectCodeIncrementalChanges(root: string, manifestPath: string, project: string): Promise<CodeIncrementalChange> {
  const previous = (await exists(manifestPath)) ? (JSON.parse(await readFile(manifestPath, "utf8")) as { files?: Array<{ relativePath: string; sha256: string }> }) : { files: [] };
  const current = await collectCode({ root });
  const previousByPath = new Map((previous.files ?? []).map((file) => [file.relativePath, file.sha256]));
  const currentByPath = new Map(current.manifest.files.map((file) => [file.relativePath, file.sha256]));
  const added = [...currentByPath.keys()].filter((file) => !previousByPath.has(file)).sort();
  const changed = [...currentByPath.entries()].filter(([file, sha]) => previousByPath.has(file) && previousByPath.get(file) !== sha).map(([file]) => file).sort();
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

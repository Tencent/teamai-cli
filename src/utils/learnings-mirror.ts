import path from 'node:path';
import fse from 'fs-extra';
import { ensureDir, listDirs, listFiles, listFilesRecursive, pathExists, remove } from './fs.js';

function visibleFiles(files: string[]): string[] {
  return files.filter((file) => file.split('/').every((segment) => !segment.startsWith('.')));
}

function visibleMarkdownFiles(files: string[]): string[] {
  return visibleFiles(files).filter((file) => file.endsWith('.md'));
}

/** Resolve one relative path to the absolute file that wins, across roots. */
type Resolved = Map<string, string>;

async function isDirectory(dir: string): Promise<boolean> {
  return await pathExists(dir) && (await fse.stat(dir)).isDirectory();
}

/**
 * Reconcile the machine-local learnings cache with the selected repo content.
 *
 * Root-level Markdown files are shared; only active namespace directories are
 * mirrored. The destination is a generated cache, so upstream deletions must
 * remove the corresponding cached learning before the search index is rebuilt.
 *
 * Sources are ordered by precedence: learnings live in more than one root once
 * they move to their own branch (#485), and for one relative path the first
 * root wins. A file is only deleted from the cache when NO root provides it —
 * mirroring from a single root would otherwise empty the others out of the
 * cache on the next pull.
 */
export async function mirrorLearnings(
  sourceDirs: string | readonly string[],
  destinationDir: string,
  activeNamespaces: string[],
): Promise<void> {
  const roots = typeof sourceDirs === 'string' ? [sourceDirs] : sourceDirs;
  const presentRoots: string[] = [];
  for (const root of roots) {
    if (await isDirectory(root)) presentRoots.push(root);
  }

  // Shared root-level learnings, first root wins.
  const sourceRootFiles: Resolved = new Map();
  for (const root of presentRoots) {
    for (const file of await listFiles(root)) {
      if (!file.endsWith('.md') || file.startsWith('.')) continue;
      if (!sourceRootFiles.has(file)) sourceRootFiles.set(file, path.join(root, file));
    }
  }

  const sourceNamespaces = new Set<string>();
  for (const root of presentRoots) {
    for (const namespace of await listDirs(root)) sourceNamespaces.add(namespace);
  }
  const selectedNamespaces = new Set(
    activeNamespaces.filter((namespace) =>
      !namespace.startsWith('.') && sourceNamespaces.has(namespace),
    ),
  );

  // Learnings inside each selected namespace, first root wins.
  const sourceNamespaceFiles = new Map<string, Resolved>();
  for (const namespace of selectedNamespaces) {
    const resolved: Resolved = new Map();
    for (const root of presentRoots) {
      const nsDir = path.join(root, namespace);
      if (!await pathExists(nsDir)) continue;
      // Every visible file, not only Markdown: a namespace may carry what its
      // learnings reference, and the mirror used to copy those too.
      for (const file of visibleFiles(await listFilesRecursive(nsDir))) {
        if (!resolved.has(file)) resolved.set(file, path.join(nsDir, file));
      }
    }
    sourceNamespaceFiles.set(namespace, resolved);
  }

  await ensureDir(destinationDir);

  // Root Markdown files are owned by the mirror. Leave unrelated root files
  // alone, but remove shared learnings that no source root has any more.
  for (const file of await listFiles(destinationDir)) {
    if (file.endsWith('.md') && !file.startsWith('.') && !sourceRootFiles.has(file)) {
      await remove(path.join(destinationDir, file));
    }
  }

  // Namespace directories are also mirror-owned. This removes both namespaces
  // that became inactive and active namespaces deleted from every root.
  for (const namespace of await listDirs(destinationDir)) {
    if (!selectedNamespaces.has(namespace)) {
      await remove(path.join(destinationDir, namespace));
    }
  }

  // An active namespace can remain selected while individual learnings are
  // deleted upstream. Reconcile those files before the overwrite copy.
  for (const namespace of selectedNamespaces) {
    const destinationNamespaceDir = path.join(destinationDir, namespace);
    if (!await pathExists(destinationNamespaceDir)) continue;
    const sourceFiles = sourceNamespaceFiles.get(namespace) ?? new Map();
    for (const file of visibleMarkdownFiles(await listFilesRecursive(destinationNamespaceDir))) {
      if (!sourceFiles.has(file)) {
        await remove(path.join(destinationNamespaceDir, file));
      }
    }
  }

  for (const [file, source] of sourceRootFiles) {
    await fse.copy(source, path.join(destinationDir, file), { overwrite: true });
  }
  for (const [namespace, files] of sourceNamespaceFiles) {
    for (const [file, source] of files) {
      await fse.copy(source, path.join(destinationDir, namespace, file), { overwrite: true });
    }
  }
}

/**
 * Add a single learning file to the machine-local cache without touching
 * anything else there. Unlike mirrorLearnings, this never deletes: it's for
 * sources that are only a partial, disposable snapshot (e.g. contributeSelf's
 * knowledge worktree, checked out at origin/<default>) and would otherwise
 * wipe out cached entries the snapshot simply doesn't happen to contain, such
 * as other projects' cache or a still-unmerged prior contribution (#472).
 */
export async function addLearningToCache(
  sourceFile: string,
  destinationDir: string,
  relativePath: string,
): Promise<void> {
  await fse.copy(sourceFile, path.join(destinationDir, relativePath), { overwrite: true });
}

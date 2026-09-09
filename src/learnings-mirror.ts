import path from 'node:path';
import fse from 'fs-extra';

import { listDirs, listFiles, listFilesRecursive, pathExists } from './utils/fs.js';

function isVisibleMarkdown(relativePath: string): boolean {
  return relativePath.endsWith('.md')
    && !relativePath.split(path.sep).some((part) => part.startsWith('.'));
}

/** Reconcile the user-scope learnings cache with the selected team knowledge. */
export async function mirrorLearnings(
  sourceDir: string,
  destinationDir: string,
  activeNamespaces: readonly string[],
): Promise<void> {
  const sourceExists = await pathExists(sourceDir);
  const active = new Set(activeNamespaces);

  if (await pathExists(destinationDir)) {
    const sourceRootFiles = new Set(
      sourceExists
        ? (await listFiles(sourceDir)).filter((file) => isVisibleMarkdown(file))
        : [],
    );
    for (const file of await listFiles(destinationDir)) {
      if (isVisibleMarkdown(file) && !sourceRootFiles.has(file)) {
        await fse.remove(path.join(destinationDir, file));
      }
    }

    for (const namespace of await listDirs(destinationDir)) {
      const sourceNamespace = path.join(sourceDir, namespace);
      if (!active.has(namespace) || !sourceExists || !await pathExists(sourceNamespace)) {
        await fse.remove(path.join(destinationDir, namespace));
        continue;
      }

      const sourceFiles = new Set(
        (await listFilesRecursive(sourceNamespace)).filter(isVisibleMarkdown),
      );
      for (const relativePath of await listFilesRecursive(path.join(destinationDir, namespace))) {
        if (isVisibleMarkdown(relativePath) && !sourceFiles.has(relativePath)) {
          await fse.remove(path.join(destinationDir, namespace, relativePath));
        }
      }
    }
  }

  if (!sourceExists) return;

  await fse.ensureDir(destinationDir);
  for (const file of await listFiles(sourceDir)) {
    if (!isVisibleMarkdown(file)) continue;
    await fse.copy(path.join(sourceDir, file), path.join(destinationDir, file), { overwrite: true });
  }
  for (const namespace of active) {
    const sourceNamespace = path.join(sourceDir, namespace);
    if (!await pathExists(sourceNamespace)) continue;
    await fse.copy(sourceNamespace, path.join(destinationDir, namespace), {
      overwrite: true,
      filter: (sourcePath: string) => !path.basename(sourcePath).startsWith('.'),
    });
  }
}

import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * The shared-instruction SOURCE directories a team repo may use.
 *
 * `claudemd/` is the original name; `agentsmd/` is the alternative spelling
 * for teams whose shared-instruction convention is `AGENTS.md` (Claude Code
 * reads `AGENTS.md` natively since v2.1.277). Both are collected with the
 * same rules — the directory name is a property of the repo's convention, not
 * of the resource, so the knowledge-namespace layout, the per-tool delivery
 * and the file format stay identical (#1682).
 *
 * This is the SOURCE side only. The `claudemd` RESOURCE kind and where
 * teamai writes each tool's instruction block (#945, #952) are unchanged.
 */
export const SHARED_INSTRUCTION_SOURCE_DIRS = ['claudemd', 'agentsmd'] as const;

export type SharedInstructionSourceDir = typeof SHARED_INSTRUCTION_SOURCE_DIRS[number];

/**
 * The source directory that wins a name conflict when both are present:
 * `agentsmd/` wins, because it is the explicit, newer convention and a team
 * that keeps both during a migration means "the new one is the truth".
 */
export const SHARED_INSTRUCTION_PREFERRED_DIR: SharedInstructionSourceDir = 'agentsmd';

/**
 * The source directories that exist in `repoPath`, in collection order
 * (preferred first, so a later directory never overrides an earlier one).
 *
 * Existence is by PATH, not by "is a directory": a repo whose `claudemd` is
 * a regular file is a broken repo, and the caller must see the same failure
 * it saw before (`readdir` on a file raises ENOTDIR, which pull reports as a
 * skipped sync). Silently ignoring it would hide a broken team repo.
 */
export async function existingSharedInstructionDirs(repoPath: string): Promise<SharedInstructionSourceDir[]> {
  const present = await Promise.all(
    SHARED_INSTRUCTION_SOURCE_DIRS.map(async (dir) => {
      try {
        await fs.stat(path.join(repoPath, dir));

        return dir;
      } catch {
        return null;
      }
    }),
  );

  const found = present.filter((dir): dir is SharedInstructionSourceDir => dir !== null);

  // Preferred first: the collection below keeps the first candidate per name.
  return found.sort((a, b) => rank(a) - rank(b));
}

function rank(dir: SharedInstructionSourceDir): number {
  return dir === SHARED_INSTRUCTION_PREFERRED_DIR ? 0 : 1;
}

/**
 * The source directory a NEW shared-instruction file is written to: the one
 * the repo already uses, or `claudemd/` when the repo has neither (so a repo
 * that never chose a convention keeps the historical default).
 */
export async function sharedInstructionWriteDir(repoPath: string): Promise<SharedInstructionSourceDir> {
  const dirs = await existingSharedInstructionDirs(repoPath);

  if (dirs.length === 0) return 'claudemd';

  // `existingSharedInstructionDirs` returns preferred-first, so this is the
  // preferred dir when it exists, else the other one.
  return dirs[0];
}

/**
 * The source directory holding this shared-instruction file, when it exists:
 * the write dir wins, else whichever source dir has it. A removal must find
 * the file wherever it was written, including a repo that switched source
 * directory after the file was contributed.
 */
export async function findSharedInstructionFile(
  repoPath: string,
  fileName: string,
): Promise<{ dir: SharedInstructionSourceDir; path: string } | null> {
  const dirs = await existingSharedInstructionDirs(repoPath);
  const writeDir = await sharedInstructionWriteDir(repoPath);
  const ordered = [writeDir, ...dirs.filter((dir) => dir !== writeDir)];

  for (const dir of ordered) {
    const candidate = path.join(repoPath, dir, fileName);

    try {
      const stat = await fs.stat(candidate);

      if (stat.isFile()) return { dir, path: candidate };
    } catch {
      continue;
    }
  }

  return null;
}

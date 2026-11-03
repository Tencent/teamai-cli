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
 * Only ENOENT means "this repo does not use that directory". Every other
 * failure is the caller's to see: a repo whose `claudemd` is a regular file
 * raises ENOTDIR here, and pull reports it as a skipped sync — the same
 * diagnostic it gave before this feature existed. Swallowing it would hide a
 * broken team repo behind a silently empty instruction block.
 */
export async function existingSharedInstructionDirs(repoPath: string): Promise<SharedInstructionSourceDir[]> {
  const present = await Promise.all(
    SHARED_INSTRUCTION_SOURCE_DIRS.map(async (dir) => {
      try {
        await fs.readdir(path.join(repoPath, dir));

        return dir;
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      }
    }),
  );

  const found = present.filter((dir): dir is SharedInstructionSourceDir => dir !== null);

  // Preferred first: the collection below keeps the first candidate per name.
  return found.sort((a, b) => rank(a) - rank(b));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function rank(dir: SharedInstructionSourceDir): number {
  return dir === SHARED_INSTRUCTION_PREFERRED_DIR ? 0 : 1;
}

/**
 * The shared-instruction file names that exist in more than one source
 * directory, with the directory each copy is in. The preferred directory
 * holds the copy pull delivers; the others are shadowed by it, and a team
 * that keeps both should hear about it rather than discover it (#1682).
 */
export async function shadowedSharedInstructionNames(
  repoPath: string,
): Promise<Array<{ name: string; deliveredFrom: SharedInstructionSourceDir; shadowedIn: SharedInstructionSourceDir[] }>> {
  const dirs = await existingSharedInstructionDirs(repoPath);

  if (dirs.length < 2) return [];

  const byName = new Map<string, SharedInstructionSourceDir[]>();

  for (const dir of dirs) {
    const entries = await fs.readdir(path.join(repoPath, dir));

    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const sources = byName.get(entry) ?? [];
      sources.push(dir);
      byName.set(entry, sources);
    }
  }

  return [...byName].flatMap(([name, sources]) => sources.length > 1
    ? [{
      name,
      deliveredFrom: sources[0],
      shadowedIn: sources.slice(1),
    }]
    : []);
}

/**
 * Where `learnings/` is read from and written to.
 *
 * Every reader used to build this path itself, from a different base, so a
 * forgotten call site did not fail: it read an empty directory and `recall`
 * quietly returned less. One accessor makes the set of roots a single decision,
 * and makes moving the write target one edit (#485).
 */
import path from 'node:path';

import { listFiles } from './fs.js';
import { learningsBranch } from './learnings-branch.js';
import {
  getDataHome,
  getKnowledgeDir,
  getUserLearningsDir,
  type LocalConfig,
} from '../types.js';

export interface LearningsRoots {
  /**
   * Where new learnings are written. Always identical to `read[0]`, so a write
   * is immediately the highest-precedence read.
   */
  write: string;
  /**
   * Every directory learnings are read from, highest precedence first.
   *
   * Invariants:
   *  - never empty, and `read[0] === write`
   *  - the knowledge clone's `learnings/` is always among them, whatever the
   *    write root is, so a team keeps reading the corpus it already wrote
   *  - entries are absolute and de-duplicated, and may not exist on disk
   *  - for kind 'http' the write root is the knowledge dir itself: that backend
   *    has no branch and no worktree
   *
   * For the same relative path in two roots the first one wins. That rule is
   * applied while collecting, not afterwards, because the relative path is also
   * the id votes are counted by.
   *
   * The contribution queue is deliberately NOT here. Recall and the index read
   * it, so a contribution is findable before it is published, but pruning and
   * promotion must not act on a learning that has not reached the team yet.
   * Those callers add `pendingLearningsDir` themselves.
   */
  read: readonly string[];
}

/**
 * The knowledge clone's learnings directory: what the team wrote before
 * learnings moved to their own branch. Read forever, written never — nothing
 * is copied out of it and nothing is deleted from it (#485).
 */
function inheritedRoot(localConfig: LocalConfig): string {
  // learnings-root ok: this IS the inherited root's definition
  return path.join(getKnowledgeDir(localConfig), 'learnings');
}

/**
 * Where new learnings are written: the `teamai-learnings` worktree. For an
 * HTTP backend, which has no branch, this is the knowledge dir itself, so the
 * write and inherited roots collapse into one.
 */
function writeRoot(localConfig: LocalConfig): string {
  // learnings-root ok: the write root's definition, inside the branch worktree
  return path.join(learningsBranch.dir(localConfig), 'learnings');
}

/**
 * Resolve the learnings roots for this repo. Pure: no I/O, no worktree
 * creation, no network, so it is safe on path-only code paths.
 */
export function learningsRoots(localConfig: LocalConfig): LearningsRoots {
  const write = writeRoot(localConfig);
  const read = [write];

  // The machine-local mirror is shared by every project on this machine, so it
  // is only a root when the scope is the machine-wide one. In project scope it
  // would surface another project's learnings in this project's recall.
  if (localConfig.scope === 'user') {
    read.push(getUserLearningsDir());
  }

  // This scope's own partition cache. `getDataHome` throws for a project-scoped
  // config with no project root, which the schema allows, so a missing cache is
  // simply one root fewer.
  try {
    read.push(path.join(getDataHome(localConfig), 'learnings'));
  } catch {
    // no partition for this config
  }

  read.push(inheritedRoot(localConfig));

  return { write, read: dedupe(read) };
}

/** One learning file, and the root it actually lives in. */
export interface LearningFile {
  /** Path relative to its root, which is also the id votes are counted by. */
  file: string;
  /** Absolute path to the file on disk. */
  absPath: string;
  /** The root it came from, so an in-place mutation knows where it is. */
  root: string;
}

/**
 * List the flat `.md` learnings across roots, highest precedence first.
 *
 * Same precedence rule as the search index: for one relative path the first
 * root wins, so a superseded copy in an inherited root is never listed twice
 * and never shadows the current one.
 */
export async function listLearningFiles(
  roots: readonly string[],
): Promise<LearningFile[]> {
  const out: LearningFile[] = [];
  const claimed = new Set<string>();

  for (const root of roots) {
    let files: string[] = [];
    try {
      files = await listFiles(root);
    } catch {
      continue; // a root that does not exist simply contributes nothing
    }
    for (const file of files) {
      if (!file.endsWith('.md') || claimed.has(file)) continue;
      claimed.add(file);
      out.push({ file, absPath: path.join(root, file), root });
    }
  }
  return out;
}

/**
 * Whether this learning lives in the root teamai publishes from.
 *
 * A learning outside it is in a checkout nothing pushes: changing it there
 * reaches no teammate and the next realign can undo it. Every mutation asks
 * this before deciding whether to write in place or in the write root.
 */
export function isInWriteRoot(absPath: string, writeRoot: string): boolean {
  const resolved = path.resolve(absPath);
  const root = path.resolve(writeRoot);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function dedupe(dirs: string[]): string[] {
  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Marker file names reserved for resources kept as folders (#1791, #1787).
 *
 * A directory under a type's directory that holds that type's marker, at any
 * depth, is a folder resource. A release that does not read that folder type
 * yet leaves the whole directory out of every scan of a team tree, instead of
 * misreading its files one by one: `rules/api-style/RULE.md` would otherwise
 * be the rule `api-style/RULE`, and `workflows/release/WORKFLOW.yaml` a
 * workflow named `WORKFLOW`.
 *
 * The marker is matched against the names `readdir` returns, so a lower-case
 * `rule.md` stays an ordinary rule on a file system that ignores case.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { errnoCode } from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';

const MARKED_TYPES = ['workflows', 'hooks', 'rules', 'mcp', 'benchmarks', 'scorers', 'agents'] as const;

export type MarkedType = typeof MARKED_TYPES[number];

function isMarkedType(type: string): type is MarkedType {
  return MARKED_TYPES.some((marked) => marked === type);
}

/** A reserved folder type: one this release reads, or one it skips whole with the line pull prints. */
export type FolderMarker =
  | {
    /** What the dashboard calls such a folder. */
    readonly kind: string;
    /** The file whose presence makes its directory a folder resource. */
    readonly marker: string;
    readonly supported: true;
  }
  | {
    readonly kind: string;
    readonly marker: string;
    readonly supported: false;
    /** What pull prints after the folder's path, verbatim. */
    readonly skipped: string;
  };

/** Each type keeps its resources in the team repo directory of the same name. */
export const FOLDER_MARKERS = {
  workflows: {
    kind: 'Workflow folder',
    marker: 'WORKFLOW.yaml',
    supported: true,
  },
  hooks: {
    kind: 'Hook folder',
    marker: 'HOOK.yaml',
    supported: true,
  },
  rules: {
    kind: 'Rule folder',
    marker: 'RULE.md',
    supported: true,
  },
  mcp: {
    kind: 'MCP server folder',
    marker: 'MCP.yaml',
    supported: true,
  },
  benchmarks: {
    kind: 'Benchmark suite folder',
    marker: 'SUITE.yaml',
    supported: true,
  },
  scorers: {
    kind: 'Scorer folder',
    marker: 'SCORER.md',
    supported: false,
    skipped: 'is a scorer folder, which this teamai cannot read yet; it was skipped. Run teamai update.',
  },
  agents: {
    kind: 'Agent folder',
    marker: 'AGENT.md',
    supported: false,
    skipped: 'is an agent folder, which this teamai cannot read yet; it was skipped. Run teamai update.',
  },
} as const satisfies Readonly<Record<MarkedType, FolderMarker>>;

/** The folder types this release skips. */
type UnreadType = { [Type in MarkedType]: typeof FOLDER_MARKERS[Type]['supported'] extends false ? Type : never }[MarkedType];

function isUnreadType(type: string): type is UnreadType {
  return isMarkedType(type) && !FOLDER_MARKERS[type].supported;
}

/** A directory a scan leaves out. */
export interface SkippedFolder {
  readonly type: UnreadType;
  /** Repo-relative, `/`-separated, with a trailing `/`: `rules/api-style/`. */
  readonly path: string;
}

/** The marker a scan of `type` must skip, or null when this release reads that folder type. */
export function unreadMarker(type: string): string | null {
  if (!isMarkedType(type)) return null;
  const { marker, supported } = FOLDER_MARKERS[type];

  return supported ? null : marker;
}

async function entryNames(dir: string): Promise<{ names: Set<string>; dirs: string[] }> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    return {
      names: new Set(entries.map((entry) => entry.name)),
      dirs: entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name),
    };
  } catch (error) {
    // Read as empty, as the scans that call this read such a directory: an
    // unreadable one fails no pull here that it did not fail before.
    const code = errnoCode(error);

    if (code !== 'ENOENT' && code !== 'ENOTDIR') log.debug(`Could not read ${dir} for folder markers: ${error instanceof Error ? error.message : String(error)}`);

    return { names: new Set(), dirs: [] };
  }
}

/**
 * Whether `dir` holds `marker`, by the names `readdir` returns: on a file
 * system that ignores case, `MCP.yaml` would otherwise answer for `mcp.yaml`.
 */
export async function holdsMarker(dir: string, marker: string | null): Promise<boolean> {
  if (marker === null) return false;

  return (await entryNames(dir)).names.has(marker);
}

/**
 * The folders of `type` this release cannot read under `root` (a team
 * checkout, or an author's `.teamai/`), sorted by path. The type directory
 * itself is never one: a marker there is an ordinary file of that type.
 */
export async function skippedFoldersIn(root: string, type: string): Promise<SkippedFolder[]> {
  const marker = unreadMarker(type);

  if (marker === null || !isUnreadType(type)) return [];
  const found: SkippedFolder[] = [];

  const walk = async (rel: string): Promise<void> => {
    const { names, dirs } = await entryNames(path.join(root, ...rel.split('/')));

    if (rel !== type && names.has(marker)) {
      found.push({ type, path: `${rel}/` });

      return;
    }

    for (const dir of dirs.sort()) await walk(`${rel}/${dir}`);
  };

  await walk(type);

  return found;
}

/** Every folder of every type this release cannot read under `root`, sorted by path. */
export async function findSkippedFolders(root: string): Promise<SkippedFolder[]> {
  const found = await Promise.all(MARKED_TYPES.map((type) => skippedFoldersIn(root, type)));

  return found.flat().sort((a, b) => a.path.localeCompare(b.path));
}

/** The line pull prints for a skipped folder. */
export function skippedFolderMessage(folder: SkippedFolder): string {
  return `${folder.path} ${FOLDER_MARKERS[folder.type].skipped}`;
}

/** Whether a repo-relative path lies inside one of `folders`. */
export function isInSkippedFolder(relPath: string, folders: readonly SkippedFolder[]): boolean {
  return folders.some((folder) => relPath.startsWith(folder.path));
}

/**
 * Print each skipped folder once per run. Also written to debug.log, because
 * a pull a hook starts runs silent.
 */
export function reportSkippedFolders(folders: readonly SkippedFolder[]): void {
  for (const folder of folders) {
    const message = skippedFolderMessage(folder);

    if (warnOnce(message)) log.persist(message);
  }
}

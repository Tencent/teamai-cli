/**
 * Folders pull delivers (#1787, common rule 9): hook, rule and MCP server folders, so a command or a rule can name a
 * file the team ships beside it. A folder sits where the configuration that names it is kept, so a pull in one
 * worktree never changes what another worktree runs or reads:
 *
 *   user scope                       → ~/.teamai/<type>/[<ns>/]<name>/
 *   workspace, rules and MCP         → <worktree>/.teamai/delivered/<type>/[<ns>/]<name>/ (one per worktree, as each
 *                                      worktree has its own rule copies and MCP configuration)
 *   workspace, remote team's hooks   → ~/.teamai/projects/<slug>/hooks/[<ns>/]<name>/    (shared, as every worktree
 *                                      runs the same entries: the main checkout's files, or HOME's)
 *   workspace, single-repo's hooks   → <worktree>/.teamai/delivered/hooks/[<ns>/]<name>/  (each checkout keeps its own)
 *
 * A rule folder's path stays the same across versions, so the text rendered from it does too. A hook or MCP server
 * folder sits at `<name>.<version>/` (`versionedPathOf`), one per set of files, so each configuration runs the files
 * it was written with. A new version is written to a hidden sibling and renamed into place. Each file is
 * recorded in the delivery ledger, and a folder goes through `removeDelivered` once the team drops it and no
 * configuration left names it (`namedIn`).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash, forgetDelivered, removeDelivered, type DeliveryLedger } from './delivered-copies.js';
import { FolderFiles, type FolderFile } from './folder-files.js';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { getDataHome, isSelfMode, type LocalConfig } from '../types.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { errnoCode, pathExists } from '../utils/fs.js';
import { log } from '../utils/logger.js';

/** The folder types pull delivers. */
export type DeliveredFolderType = 'hooks' | 'rules' | 'mcp';

/** One delivered folder: its type, and where it sits in its type's directory, `[<namespace>/]<name>/`. */
export interface DeliveredFolderRef {
  readonly type: DeliveredFolderType;
  readonly namespace: string | null;
  readonly name: string;
}

/** The variable a folder's text names its delivered path with (common rule 8), by type. A reserved team env name. */
export const PATH_VARIABLES = {
  hooks: 'TEAMAI_HOOK_DIR',
  rules: 'TEAMAI_RULE_DIR',
  mcp: 'TEAMAI_MCP_DIR',
} as const satisfies Readonly<Record<DeliveredFolderType, string>>;

/** The directory under `.teamai/` that holds a worktree's delivered folders; no team content type may use it. */
export const DELIVERED_DIR = 'delivered';

/** Where `localConfig`'s scope delivers folders of `type`: the worktree's `.teamai/delivered/`, or its data home (see above). */
function root(localConfig: LocalConfig, type: DeliveredFolderType): string {
  const worktree = worktreeRoot(localConfig);

  return worktree !== null && (type !== 'hooks' || isSelfMode(localConfig)) ? worktree : getDataHome(localConfig);
}

/** The worktree's `.teamai/delivered/`, where a project scope delivers its folders (see above). Null outside a project. */
function worktreeRoot(localConfig: LocalConfig): string | null {
  if (isSelfMode(localConfig)) return path.join(localConfig.repo.localPath, DELIVERED_DIR);

  return localConfig.scope === 'project' && localConfig.projectRoot ? checkoutRoot(localConfig.projectRoot) : null;
}

/** The `.teamai/delivered/` of the project's worktree checked out at `checkout`, which may be another worktree than the scope's. */
function checkoutRoot(checkout: string): string {
  return path.join(checkout, '.teamai', DELIVERED_DIR);
}

/** The absolute path `ref` is delivered at in `localConfig`'s scope: a rule folder's, the same for every version. */
function pathOf(localConfig: LocalConfig, ref: DeliveredFolderRef): string {
  return path.join(root(localConfig, ref.type), ref.type, ...(ref.namespace === null ? [] : [ref.namespace]), ref.name);
}

/**
 * Where `ref` is delivered at the version its `files` give: `[<namespace>/]<name>.<version>/`, `<version>` being the
 * first 8 hex digits of the SHA-256 of the files as canonical JSON (each file's path, whether it is executable, and
 * the SHA-256 of its bytes; the marker, so the definition, among them). A version's files never change, so a
 * configuration pull could not rewrite, or one of a tool the member excluded, keeps running the files it was written
 * with, whatever the team changes: the marker, a script, or a team value the configuration holds resolved.
 */
function versionedPathOf(localConfig: LocalConfig, ref: DeliveredFolderRef, files: readonly FolderFile[]): string {
  const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
  const fileIds = files.map((file) => ({ path: file.path, executable: file.executable, sha256: sha256(file.bytes) }));

  return pathOf(localConfig, { ...ref, name: `${ref.name}.${sha256(canonicalJson(fileIds)).slice(0, 8)}` });
}

/** The version a path from `anyVersionPathOf` holds, which `withoutVersions` gives every version. */
const ANY_VERSION = '.<version>';

/**
 * Where `ref` is delivered at any version: for a render of a team repo's earlier revision, whose files teamai does not
 * read, compared with what a tool holds through `withoutVersions`.
 */
function anyVersionPathOf(localConfig: LocalConfig, ref: DeliveredFolderRef): string {
  return pathOf(localConfig, { ...ref, name: `${ref.name}${ANY_VERSION}` });
}

/**
 * `text` with the version of every versioned folder it names (`/hooks/block-secrets.e246f037`, `/mcp/notes.3d414c75`)
 * as `anyVersionPathOf` writes it, so a configuration written for one version equals a render of another.
 */
function withoutVersions(text: string): string {
  return text.replace(/(\/(?:hooks|mcp)\/(?:[\w.-]+\/)*?[\w-]+)\.[0-9a-f]{8}(?![\w.-])/g, `$1${ANY_VERSION}`);
}

/**
 * The folders of `type` delivered under `root` (a scope's `root`, or a worktree's `.teamai/delivered/`) that one of
 * `texts` names: a directory holding the type's marker, named by its path from `root` with forward slashes
 * (`/hooks/block-secrets.e246f037`), followed by no character a name holds. An absolute path and one from a project
 * directory variable both carry it.
 */
async function namedIn(input: { readonly root: string; readonly type: DeliveredFolderType; readonly texts: readonly string[] }): Promise<string[]> {
  const { marker } = FOLDER_MARKERS[input.type];
  const named: string[] = [];

  const visit = async (dir: string, at: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const folderAt = `${at}/${entry.name}`;

      if (!await pathExists(path.join(full, marker))) {
        await visit(full, folderAt);
        continue;
      }

      if (input.texts.some((text) => text.split(folderAt).slice(1).some((after) => !/^[\w.-]/.test(after)))) named.push(full);
    }
  };

  await visit(path.join(input.root, input.type), `/${input.type}`);

  return named;
}

/** Write `files` under `dir`, keeping each one's executable bit. */
async function writeFiles(dir: string, files: readonly FolderFile[]): Promise<void> {
  for (const file of files) {
    const full = path.join(dir, ...file.path.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
  }
}

/** Whether `entry`, beside `dest`, is a sibling a delivery of `dest` wrote and an interruption left. */
function isLeftoverOf(dest: string, entry: string): boolean {
  const prefix = `.${path.basename(dest)}.`;

  return entry.startsWith(prefix) && /^(new|old)-[0-9a-f]{8}$/.test(entry.slice(prefix.length));
}

/** Remove the siblings an interrupted delivery of `dest` left. */
async function removeLeftovers(dest: string): Promise<void> {
  const parent = path.dirname(dest);
  const entries = await fs.readdir(parent).catch(() => []);

  for (const entry of entries.filter((name) => isLeftoverOf(dest, name))) await fs.rm(path.join(parent, entry), { recursive: true, force: true });
}

/** Whether the folder at `dest` holds exactly `files`: the same paths, bytes and executable bits, which Windows does not keep. */
async function holds(dest: string, files: readonly FolderFile[]): Promise<boolean> {
  const read = await FolderFiles.read(dest);
  const keepsModes = process.platform !== 'win32';

  if (read.kind !== 'files' || read.files.length !== files.length) return false;

  return read.files.every((onDisk, index) => {
    const wanted = files[index];

    return wanted !== undefined && onDisk.path === wanted.path && onDisk.bytes.equals(wanted.bytes)
      && (!keepsModes || onDisk.executable === wanted.executable);
  });
}

/**
 * Whether the file system holding the installed folder `dest` takes two names that differ only in case for one: one of
 * its `files`, looked up in the other case, is the same file.
 */
async function foldsCase(dest: string, files: readonly FolderFile[]): Promise<boolean> {
  const probe = files.find((file) => file.path.toUpperCase() !== file.path.toLowerCase());

  if (probe === undefined) return false;
  const other = probe.path === probe.path.toUpperCase() ? probe.path.toLowerCase() : probe.path.toUpperCase();

  try {
    const [found, swapped] = await Promise.all([probe.path, other].map((file) => fs.stat(path.join(dest, ...file.split('/')))));

    return found !== undefined && swapped !== undefined && found.dev === swapped.dev && found.ino === swapped.ino;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * `files` with each file of the installed folder at `dest` that the new version dropped (#1787). A rule copy or an MCP
 * configuration that a pull could not rewrite, or that a tool the member excluded keeps, may still name an earlier
 * version's file, so a file goes only with its folder. Where an earlier path clashes with a new one (a file that became a
 * directory, or, on a file system that takes them for one, the same name in another case), the new version's wins.
 */
async function withEarlierFiles(dest: string, files: readonly FolderFile[]): Promise<readonly FolderFile[]> {
  const installed = await FolderFiles.read(dest);

  if (installed.kind !== 'files') return files;
  const key = await foldsCase(dest, installed.files) ? (file: string) => file.toLowerCase() : (file: string) => file;
  const fresh = files.map((file) => key(file.path));
  const clashes = (earlier: string): boolean => fresh.some((wanted) => wanted === earlier || wanted.startsWith(`${earlier}/`) || earlier.startsWith(`${wanted}/`));
  const kept = installed.files.filter((file) => !clashes(key(file.path)));

  // In the order `FolderFiles.read` lists them, which `holds` compares against.
  return kept.length === 0 ? files : [...files, ...kept].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Move the delivered folder `dest` to `old`, out of the way of its new version: false when there is none yet. Any other
 * failure stops the delivery, naming the folder and why.
 */
async function moveAside(dest: string, old: string): Promise<boolean> {
  try {
    await fs.rename(dest, old);

    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;

    throw new Error(
      `could not replace the delivered folder ${dest} (${error instanceof Error ? error.message : String(error)}); `
      + 'a program running from it, such as a hook on Windows, can hold it, so close that program',
      { cause: error },
    );
  }
}

/** Folders moved into place, each with the version it replaced set aside until `commit` or `rollback`. */
export interface PlacedFolders {
  /** Remove the versions set aside, and record each folder's files in the ledger in place of what it recorded there. */
  readonly commit: () => Promise<void>;
  /** Put back the version each folder replaced, and remove a folder that had none. */
  readonly rollback: () => Promise<void>;
}

/**
 * Move each folder's `files`, in path order, into place at its `dest`, all or none, keeping the files an earlier
 * version had where the folder says so (`earlierFiles`): every new version is written to a hidden sibling first, then
 * each is renamed into place. A failure puts back every installed version already replaced, so the folders still
 * match the hooks and servers installed from them. A folder that already holds its version is left in place, so a hook
 * running from it is not disturbed.
 */
async function placeAll(folders: readonly FolderDelivery[], ledger: DeliveryLedger | undefined): Promise<PlacedFolders> {
  const staged: Array<{ readonly dest: string; readonly fresh: string; readonly old: string }> = [];

  const discardStaged = async (): Promise<void> => {
    for (const { fresh } of staged) await fs.rm(fresh, { recursive: true, force: true });
  };

  const delivered: FolderDelivery[] = [];

  try {
    for (const folder of folders) {
      const { dest } = folder;
      await removeLeftovers(dest);
      const files = folder.earlierFiles === 'keep' ? await withEarlierFiles(dest, folder.files) : folder.files;
      delivered.push({ ...folder, files });

      if (await holds(dest, files)) continue;
      const suffix = randomBytes(4).toString('hex');
      const sibling = (kind: 'new' | 'old'): string => path.join(path.dirname(dest), `.${path.basename(dest)}.${kind}-${suffix}`);
      staged.push({ dest, fresh: sibling('new'), old: sibling('old') });
      await writeFiles(sibling('new'), files);
    }
  } catch (error) {
    await discardStaged();
    throw error;
  }

  const placed: Array<{ readonly dest: string; readonly old: string; readonly replaced: boolean }> = [];

  const putBack = async (): Promise<void> => {
    for (const { dest, old, replaced } of placed.splice(0).toReversed()) {
      await fs.rm(dest, { recursive: true, force: true });

      if (replaced) await fs.rename(old, dest);
    }
  };

  try {
    for (const { dest, fresh, old } of staged) {
      const replaced = await moveAside(dest, old);

      try {
        await fs.rename(fresh, dest);
      } catch (error) {
        if (replaced) await fs.rename(old, dest);

        throw new Error(
          `could not move the new version of the delivered folder ${dest} into place (${error instanceof Error ? error.message : String(error)}); `
          + 'the installed version stays, and the next pull tries again',
          { cause: error },
        );
      }

      placed.push({ dest, old, replaced });
    }
  } catch (error) {
    await putBack();
    await discardStaged();
    throw error;
  }

  const commit = async (): Promise<void> => {
    // Every new version is in place: a previous one left behind is a leftover the next delivery removes, not a failure.
    for (const { dest, old, replaced } of placed.splice(0)) {
      if (!replaced) continue;

      try {
        await fs.rm(old, { recursive: true, force: true });
      } catch (error) {
        log.warn(`Could not remove ${old}, the previous version of ${dest} (${error instanceof Error ? error.message : String(error)}). The new version is in place; the next pull removes it.`);
      }
    }

    if (!ledger) return;

    for (const { dest, files } of delivered) {
      forgetDelivered(ledger.hashes, dest);

      for (const file of files) ledger.hashes[path.join(dest, ...file.path.split('/'))] = contentHash(file.bytes);
    }
  };

  return { commit, rollback: putBack };
}

/** `placeAll`, committed at once: each file is recorded in `ledger`, in place of what it recorded under its `dest`. */
async function deliverAll(folders: readonly FolderDelivery[], ledger: DeliveryLedger | undefined): Promise<void> {
  await (await placeAll(folders, ledger)).commit();
}

/** Deliver one folder, as `deliverAll` does. */
async function deliver(input: FolderDelivery & { readonly ledger: DeliveryLedger | undefined }): Promise<void> {
  await deliverAll([input], input.ledger);
}

/** `${TEAMAI_<TYPE>_DIR}`, as a folder's text writes it. */
function placeholder(type: DeliveredFolderType): string {
  return `\${${PATH_VARIABLES[type]}}`;
}

/** Whether `text` names its folder's path through `type`'s variable. */
function mentions(text: string, type: DeliveredFolderType): boolean {
  return text.includes(placeholder(type));
}

/**
 * `text` with each `${TEAMAI_<TYPE>_DIR}` replaced by the delivered path `dest`, in one pass: a replaced value is never
 * read again. The path has forward slashes on every platform and no quotes, which the author adds as the command
 * needs. With `project`, a tool's variable for the project directory (`$CLAUDE_PROJECT_DIR`) stands for the project's
 * root, so a project file the repository may commit names the same path in every worktree (common rule 10).
 */
function render(text: string, at: { readonly type: DeliveredFolderType; readonly dest: string; readonly project?: { readonly root: string; readonly variable: string } }): string {
  const forward = (file: string): string => file.split(path.sep).join('/');
  const value = at.project ? `${at.project.variable}/${forward(path.relative(at.project.root, at.dest))}` : forward(at.dest);

  return text.split(placeholder(at.type)).join(value);
}

/** What names one file or directory on disk, however a case-insensitive file system spells its path; null when absent. */
async function identity(file: string): Promise<string | null> {
  const stat = await fs.stat(file, { bigint: true }).catch(() => null);

  return stat === null ? null : `${stat.dev}:${stat.ino}`;
}

/**
 * Remove every folder of `type` in `localConfig`'s scope that is not in `keep` (absolute delivered paths), with an
 * emptied namespace directory, through `removeDelivered`. Hidden entries are left: a delivery in progress writes one.
 * A kept folder is recognised by what it is on disk, not by its spelling: after the team renames `mcp/Jira/` to
 * `mcp/jira/`, macOS and Windows deliver `jira` into the `Jira` directory already there. A folder it cannot remove is
 * named in a warning and stays until the next pull. Returns what it removed.
 */
async function prune(input: {
  readonly localConfig: LocalConfig;
  readonly type: DeliveredFolderType;
  readonly keep: readonly string[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<string[]> {
  const removed: string[] = [];
  const typeRoot = path.resolve(root(input.localConfig, input.type), input.type);
  const kept = new Set<string>();
  // The directories between the type's root and a kept folder: its namespace.
  const holdingKept = new Set<string>();

  for (const dest of input.keep) {
    const id = await identity(dest);

    if (id !== null) kept.add(id);

    for (let dir = path.dirname(path.resolve(dest)); dir.startsWith(typeRoot + path.sep); dir = path.dirname(dir)) {
      const dirId = await identity(dir);

      if (dirId !== null) holdingKept.add(dirId);
    }
  }

  const sweep = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries.filter((found) => !found.name.startsWith('.'))) {
      const full = path.resolve(dir, entry.name);
      const id = await identity(full);

      if (id !== null && kept.has(id)) continue;

      if (entry.isDirectory() && id !== null && holdingKept.has(id)) {
        await sweep(full);
        continue;
      }

      try {
        await removeDelivered(input.ledger, full);
        removed.push(full);
      } catch (error) {
        // The folders the team delivers are in place, and nothing names this one any more.
        log.warn(`Could not remove ${full}, which the team no longer delivers (${error instanceof Error ? error.message : String(error)}). `
          + 'Nothing names it any more; the next pull removes it.');
      }
    }
  };

  await sweep(typeRoot);

  return removed;
}

/** A folder to deliver: where, and its files in path order. */
export interface FolderDelivery {
  readonly dest: string;
  readonly files: readonly FolderFile[];
  /**
   * What happens to a file an earlier version had and this one drops: `keep` it until the folder goes, for a folder
   * whose files a configuration or a rule names by path (`withEarlierFiles`); `drop` it, for a folder whose reader takes
   * whatever files it holds, such as a default hook's language variants.
   */
  readonly earlierFiles: 'keep' | 'drop';
}

/**
 * One run of a type's folders for `localConfig`'s scope: deliver each of `folders`, then, with `prune`, remove the
 * type's others, all recorded in `ledger`. A worktree's `.teamai/delivered/` is then kept out of git by its own block
 * in `.git/info/exclude`. Throws when a folder cannot be written; the caller keeps what it installed.
 */
async function sync(input: {
  readonly localConfig: LocalConfig;
  readonly type: DeliveredFolderType;
  readonly folders: readonly FolderDelivery[];
  readonly ledger: DeliveryLedger | undefined;
  readonly prune: boolean;
}): Promise<void> {
  const { localConfig, type, folders, ledger } = input;

  await deliverAll(folders, ledger);

  if (input.prune) await prune({ localConfig, type, keep: folders.map(({ dest }) => dest), ledger });

  await excludeWorktreeFolders(localConfig, type);
}

/**
 * `sync` without prune, held open: each folder replaced keeps its previous version aside until the caller commits,
 * once every configuration that names the folders is written, or rolls back when one of those writes fails.
 */
async function place(input: {
  readonly localConfig: LocalConfig;
  readonly type: DeliveredFolderType;
  readonly folders: readonly FolderDelivery[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<PlacedFolders> {
  const placed = await placeAll(input.folders, input.ledger);

  await excludeWorktreeFolders(input.localConfig, input.type);

  return placed;
}

/** Keep a worktree's `.teamai/delivered/` out of git by its own block in `.git/info/exclude`, once it holds `type`'s folders. */
async function excludeWorktreeFolders(localConfig: LocalConfig, type: DeliveredFolderType): Promise<void> {
  const at = root(localConfig, type);

  if (at === worktreeRoot(localConfig) && await pathExists(at)) {
    const { excludeDeliveredFolders } = await import('../git-exclude-delivered.js');
    await excludeDeliveredFolders(localConfig, at);
  }
}

export const DeliveredFolders = { root, worktreeRoot, checkoutRoot, pathOf, versionedPathOf, anyVersionPathOf, withoutVersions, namedIn, sync, place, deliver, prune, placeholder, mentions, render } as const;

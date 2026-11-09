/**
 * Folders pull delivers to the data home of the scope that owns them (#1787, common rule 9): hook, rule and MCP
 * server folders, so a command or a rule can name a file the team ships beside it.
 *
 *   user scope                → ~/.teamai/<type>/[<ns>/]<name>/
 *   workspace, remote team    → ~/.teamai/projects/<slug>/<type>/[<ns>/]<name>/   (shared by worktrees)
 *   workspace, single-repo    → <worktree>/.teamai/delivered/<type>/[<ns>/]<name>/ (one per worktree)
 *
 * The path stays the same across versions, so what is rendered from it does too. A new version is written to a
 * hidden sibling and renamed into place. Each file is recorded in the delivery ledger, and a folder the team drops
 * is removed through `removeDelivered`.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash, forgetDelivered, removeDelivered, type DeliveryLedger } from './delivered-copies.js';
import { FolderFiles, type FolderFile } from './folder-files.js';
import { getDataHome, isSelfMode, type LocalConfig } from '../types.js';

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

/** The directory under `.teamai/` that holds a single-repo worktree's delivered folders; no team content type may use it. */
export const DELIVERED_DIR = 'delivered';

/** Where `localConfig`'s scope delivers folders: its data home, or the worktree's `.teamai/delivered/` in single-repo. */
function root(localConfig: LocalConfig): string {
  return isSelfMode(localConfig) ? path.join(localConfig.repo.localPath, DELIVERED_DIR) : getDataHome(localConfig);
}

/** The absolute path `ref` is delivered at in `localConfig`'s scope. The same for every version of the folder. */
function pathOf(localConfig: LocalConfig, ref: DeliveredFolderRef): string {
  return path.join(root(localConfig), ref.type, ...(ref.namespace === null ? [] : [ref.namespace]), ref.name);
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

/** Whether the folder at `dest` holds exactly `files`: the same paths, bytes and executable bits. */
async function holds(dest: string, files: readonly FolderFile[]): Promise<boolean> {
  const read = await FolderFiles.read(dest);

  if (read.kind !== 'files' || read.files.length !== files.length) return false;

  return read.files.every((onDisk, index) => {
    const wanted = files[index];

    return wanted !== undefined && onDisk.path === wanted.path && onDisk.executable === wanted.executable && onDisk.bytes.equals(wanted.bytes);
  });
}

/**
 * Deliver a folder's `files`, in path order, at `dest`: written to a hidden sibling, then renamed into place, so a
 * reader sees the old version or the new one whole. A folder that already holds them is left in place, so a hook
 * running from it is not disturbed. Each file is recorded in `ledger`, in place of what it recorded under `dest`.
 */
async function deliver(input: { readonly dest: string; readonly files: readonly FolderFile[]; readonly ledger: DeliveryLedger | undefined }): Promise<void> {
  const { dest, files, ledger } = input;
  const suffix = randomBytes(4).toString('hex');
  const fresh = path.join(path.dirname(dest), `.${path.basename(dest)}.new-${suffix}`);
  const old = path.join(path.dirname(dest), `.${path.basename(dest)}.old-${suffix}`);

  await removeLeftovers(dest);

  if (!await holds(dest, files)) {
    await writeFiles(fresh, files);
    const replacing = await fs.rename(dest, old).then(() => true, () => false);
    await fs.rename(fresh, dest);

    if (replacing) await fs.rm(old, { recursive: true, force: true });
  }

  if (!ledger) return;
  forgetDelivered(ledger.hashes, dest);

  for (const file of files) ledger.hashes[path.join(dest, ...file.path.split('/'))] = contentHash(file.bytes);
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

/**
 * Remove every folder of `type` in `localConfig`'s scope that is not in `keep` (absolute delivered paths), with an
 * emptied namespace directory, through `removeDelivered`. Hidden entries are left: a delivery in progress writes one.
 * Returns what it removed.
 */
async function prune(input: {
  readonly localConfig: LocalConfig;
  readonly type: DeliveredFolderType;
  readonly keep: readonly string[];
  readonly ledger: DeliveryLedger | undefined;
}): Promise<string[]> {
  const removed: string[] = [];
  const keep = new Set(input.keep.map((dest) => path.resolve(dest)));
  const holdsKept = (dir: string): boolean => [...keep].some((dest) => dest.startsWith(dir + path.sep));

  const sweep = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries.filter((found) => !found.name.startsWith('.'))) {
      const full = path.resolve(dir, entry.name);

      if (keep.has(full)) continue;

      if (entry.isDirectory() && holdsKept(full)) {
        await sweep(full);
        continue;
      }

      await removeDelivered(input.ledger, full);
      removed.push(full);
    }
  };

  await sweep(path.join(root(input.localConfig), input.type));

  return removed;
}

export const DeliveredFolders = { root, pathOf, deliver, prune, mentions, render } as const;

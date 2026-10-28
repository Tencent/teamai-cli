/**
 * The children of a workspace (#913): the repos and folders set up with teamai
 * inside it, up to three levels down through plain folders. A workspace
 * delivers its own selection plus each child's, into its own checkout. It
 * never pulls a child or writes into one: a child keeps updating itself.
 *
 *   ws/                   the workspace (`init` in the workspace scope)
 *     svc-a/              a child: a repo with its own config
 *     backend/svc-b/      a child two levels down
 *     backend/            a plain folder with a config of its own is a child too,
 *                         and the walk goes on through it
 *
 * The walk stops at any repo, set up or not, and never enters a dot folder or
 * node_modules. A child counts once per anchor, so a linked worktree whose
 * main checkout is also a child adds nothing. In a workspace that is a git
 * repo, only repos are children. Detection spawns no git for a plain clone, a
 * submodule or a linked worktree: their anchor follows from the path, the
 * `gitdir:` line or the `commondir` file.
 *
 * `readWorkspaceChildren` attaches what it reads to the workspace's config in
 * memory (`LocalConfig.children`), and `deliveredMembers` turns that into the
 * selections the resolvers read one by one, so each child keeps its own tags
 * and exclusions. Nothing here is persisted.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findProject, loadProjectsManifest, resolveActiveLearningsNamespaces } from './projects.js';
import type { LocalConfig } from './types.js';
import { readFileSafe, readJsonObject, writeJson } from './utils/fs.js';
import { remotesMatch } from './utils/git.js';
import { log } from './utils/logger.js';
import { resolvePartitionDir } from './utils/partition.js';
import { warnOnce } from './utils/warn-once.js';

/** How many folder levels below the workspace a child may be. */
const MAX_CHILD_DEPTH = 3;

/** What a child selects: the fields its `init`, `roles`, `projects`, `tags` and `exclude` set. */
export type ChildSelection = Pick<LocalConfig, 'primaryRole' | 'additionalRoles' | 'projects' | 'subscribedTags' | 'excludedSkills'>;

export interface WorkspaceChild {
  /** The child's folder relative to the workspace root, with `/`, for messages. */
  readonly path: string;
  /** The child's folder, absolute. */
  readonly root: string;
  /** The machine-data home of the child's config: one per anchor, so the dedupe key. */
  readonly anchor: string;
  readonly selection: ChildSelection;
}

/** A folder set up with teamai that the workspace does not read, and why. */
export interface LeftOutChild {
  readonly path: string;
  readonly reason: string;
}

/** What one read of a workspace found. */
export interface WorkspaceChildren {
  readonly children: readonly WorkspaceChild[];
  readonly leftOut: readonly LeftOutChild[];
  /**
   * Every folder set up under the workspace, absolute: each checkout of a
   * child (a linked worktree that adds no selection included) and each folder
   * left out. Each is a scope of its own, so the workspace's hooks stay out.
   */
  readonly roots: readonly string[];
  /**
   * A hash of every child's anchor and selection and of the children left
   * out, so pull's "Already synced" fast path sees a child that changed its
   * selection (stored in the checkout record).
   */
  readonly fingerprint: string;
}

/**
 * The workspace's config with the children found under it attached, or the
 * config as given when there are none: a scope without children reads and
 * delivers exactly as before. Only the workspace scope (internally `project`)
 * has children.
 */
export async function readWorkspaceChildren(workspace: LocalConfig): Promise<LocalConfig> {
  const { projectRoot } = workspace;
  if (workspace.scope !== 'project' || !projectRoot) return workspace;
  const root = await walkRoot(projectRoot);
  const gitWorkspace = await lstatOrNull(path.join(root, '.git')) !== null;
  const ownAnchor = workspace.dataHome ? path.resolve(workspace.dataHome) : null;
  const found: Array<{ path: string; root: string; read: ChildRead }> = [];
  await walk({ root, dir: root, depth: 1, gitWorkspace, found });
  found.sort((a, b) => compareStrings(a.path, b.path));

  const children: WorkspaceChild[] = [];
  const leftOut: LeftOutChild[] = [];
  const anchors = new Set<string>();
  const roots: string[] = [];
  for (const { path: childPath, root: childRoot, read } of found) {
    if (read.kind === 'unreadable') {
      roots.push(childRoot);
      leftOut.push({ path: childPath, reason: `its teamai config cannot be read (${read.reason})` });
      continue;
    }
    const { config } = read;
    const anchor = path.resolve(config.dataHome ?? childPath);
    if (anchor === ownAnchor) continue;
    // Every checkout of a child is its own, a second one of the same anchor included.
    roots.push(childRoot);
    if (anchors.has(anchor)) continue;
    anchors.add(anchor);
    if (config.repo.kind === 'self') {
      leftOut.push({ path: childPath, reason: 'it is set up in single-repo mode, so its team repo is the repo itself' });
    } else if (!remotesMatch(config.repo.remote, workspace.repo.remote)) {
      leftOut.push({ path: childPath, reason: `it uses another team repo (${config.repo.remote})` });
    } else {
      children.push({ path: childPath, root: childRoot, anchor, selection: selectionOf(config) });
    }
  }
  if (children.length === 0 && leftOut.length === 0) return workspace;
  // Run from a linked worktree, the children read are the main checkout's; the same folders in this checkout are theirs too.
  if (root !== projectRoot) roots.push(...roots.map((childRoot) => path.join(projectRoot, path.relative(root, childRoot))));
  return { ...workspace, children: { children, leftOut, roots, fingerprint: fingerprintOf(children, leftOut) } };
}

/**
 * The configs the resolvers read one by one for a workspace with children:
 * its own selection, when it has one, then each child's selection on the
 * workspace's config. Null when the config has no children, which means
 * "resolve it as it is". A project a child selects that the team repo does
 * not declare is left out of that child alone, and named.
 */
export async function deliveredMembers(config: LocalConfig): Promise<readonly LocalConfig[] | null> {
  const found = config.children?.children;
  if (!found || found.length === 0) return null;
  const { children: _children, ...own } = config;
  const manifest = found.some((child) => (child.selection.projects ?? []).length > 0)
    ? await loadProjectsManifest(own.repo.localPath)
    : null;
  const members: LocalConfig[] = hasOwnSelection(own) ? [own] : [];
  for (const child of found) {
    const projects = (child.selection.projects ?? []).filter((id) => {
      if (!manifest || findProject(manifest, id)) return true;
      warnOnce(`Workspace child ${child.path} selects project "${id}", which manifest/projects.yaml does not declare, so that project is left out of this workspace.`);
      return false;
    });
    const { roleUnresolved: _roleUnresolved, ...base } = own;
    // With roles assigned in the team repo (#1186) every member of this
    // workspace holds the workspace's assignment: a child cannot select a role,
    // so the selection it recorded is not a selection to honour.
    const roles = own.roleAssignment
      ? { primaryRole: own.primaryRole, additionalRoles: own.additionalRoles ?? [] }
      : {
        ...(child.selection.primaryRole ? { primaryRole: child.selection.primaryRole } : {}),
        additionalRoles: child.selection.additionalRoles ?? [],
      };
    members.push({
      ...base,
      ...withoutSelection(),
      ...roles,
      projects,
      ...(child.selection.subscribedTags ? { subscribedTags: child.selection.subscribedTags } : {}),
      ...(child.selection.excludedSkills ? { excludedSkills: child.selection.excludedSkills } : {}),
    });
  }
  return members;
}

/**
 * The learnings namespaces this scope indexes: in a workspace with children,
 * those of every member's projects, as pull indexes them; else its own.
 * Throws when manifest/projects.yaml cannot be read.
 */
export async function deliveredLearningsNamespaces(config: LocalConfig): Promise<string[]> {
  const namespaces = new Set<string>();
  for (const member of await deliveredMembers(config) ?? [config]) {
    for (const namespace of await resolveActiveLearningsNamespaces({ ...member, repo: config.repo })) {
      namespaces.add(namespace);
    }
  }
  return [...namespaces];
}

/**
 * All projects selected by this scope, including those selected by its children (#913).
 */
export function selectedProjects(config: LocalConfig): string[] {
  return [...new Set([
    ...config.projects ?? [],
    ...config.children?.children.flatMap((child) => child.selection.projects ?? []) ?? [],
  ])];
}

/**
 * Warning text for when manifest/projects.yaml cannot be read and namespaced learnings
 * are held back. Shared between `recall` and maintenance/digest callers.
 */
export function formatProjectsManifestWarning(
  caller: string,
  error: unknown,
  config: LocalConfig,
  options: {
    verb?: string;
    extraHeldBack?: string;
    targetName?: string;
    rebuildAction?: string;
  } = {},
): string {
  const projects = selectedProjects(config);
  const verb = options.verb ?? 'read';
  const errText = error instanceof Error ? error.message : String(error);
  const action = options.rebuildAction ? ` and ${options.rebuildAction}` : '';
  let subject = '';
  if (projects.length > 0) {
    subject = `The learnings of ${projects.length === 1 ? 'project' : 'projects'} ${projects.join(', ')}`;
    if (options.extraHeldBack) subject += `, and ${options.extraHeldBack},`;
  } else if (options.extraHeldBack) {
    subject = options.extraHeldBack.charAt(0).toUpperCase() + options.extraHeldBack.slice(1);
  }
  const projectSummary = subject === ''
    ? ''
    : ` ${subject} stay out of ${options.targetName ?? caller} until manifest/projects.yaml is fixed${action}; \`teamai doctor\` shows the problem.`;
  return `${caller} ${verb} the shared learnings only: ${errText}.${projectSummary}`;
}

/**
 * Active learnings namespaces for this configuration. When resolution fails
 * (e.g. an unreadable manifest/projects.yaml), logs a warning matching `recall`
 * and falls back to the shared root (empty namespaces).
 */
export async function safeDeliveredLearningsNamespaces(
  config: LocalConfig,
  caller: string,
): Promise<string[]> {
  try {
    return await deliveredLearningsNamespaces(config);
  } catch (e) {
    log.warn(formatProjectsManifestWarning(caller, e, config));
    return [];
  }
}

/** One name whose copies differ between two members, so the workspace delivers neither. */
export interface HeldBackItem<TItem> {
  readonly name: string;
  readonly first: TItem;
  readonly second: TItem;
}

/**
 * Union several members' items by name. One name with the same content in
 * every member that delivers it is delivered once, as the first member has it
 * (resolver order: the workspace's own selection, then its children by path).
 * One name whose copies differ is held back and returned in `held`; the other
 * items are not affected.
 */
export async function unionMemberItems<TItem>(input: {
  readonly perMember: readonly (readonly TItem[])[];
  readonly nameOf: (item: TItem) => string;
  readonly sameContent: (a: TItem, b: TItem) => boolean | Promise<boolean>;
}): Promise<{ items: TItem[]; held: HeldBackItem<TItem>[] }> {
  const byName = new Map<string, TItem>();
  const held = new Map<string, HeldBackItem<TItem>>();
  for (const items of input.perMember) {
    for (const item of items) {
      const name = input.nameOf(item);
      if (held.has(name)) continue;
      const first = byName.get(name);
      if (first === undefined) {
        byName.set(name, item);
      } else if (first !== item && !await input.sameContent(first, item)) {
        byName.delete(name);
        held.set(name, { name, first, second: item });
      }
    }
  }
  return { items: [...byName.values()], held: [...held.values()] };
}

/** The lines `pull` and `status` print about the children, or none for a scope without any. */
export function describeWorkspaceChildren(config: LocalConfig): string[] {
  const found = config.children;
  if (!found) return [];
  const lines: string[] = [];
  if (found.children.length > 0) {
    const count = found.children.length === 1 ? '1 child' : `${found.children.length} children`;
    lines.push(`Workspace with ${count}: ${found.children.map((child) => child.path).join(', ')}`);
  }
  for (const child of found.leftOut) {
    lines.push(`Workspace child ${child.path} is left out: ${child.reason}. Set it up with this workspace's team repo to include it.`);
  }
  return lines;
}

/** One line about the children, for `status`, or null for a scope without any. */
export function summarizeWorkspaceChildren(config: LocalConfig): string | null {
  const found = config.children;
  if (!found) return null;
  const read = found.children.length === 1 ? '1 child' : `${found.children.length} children`;
  const names = found.children.length > 0 ? `: ${found.children.map((child) => child.path).join(', ')}` : '';
  const leftOut = found.leftOut.length > 0 ? ` (${found.leftOut.length} left out; run \`teamai doctor\` for why)` : '';
  return `workspace: ${read}${names}${leftOut}`;
}

/** Whether `config` is a workspace that reads at least one child this run. */
export function hasWorkspaceChildren(config: Pick<LocalConfig, 'children'>): boolean {
  return (config.children?.children.length ?? 0) > 0;
}

/**
 * The workspaces whose walk reaches `childRoot`, nearest first: each folder up
 * to three levels above it that holds a project config, climbing through
 * plain folders only, as the walk goes down. A plain folder with a config of
 * its own is walked through, so a child can have several. A linked worktree
 * also has the workspaces of its main checkout, since Claude Code loads a
 * parent folder's instructions by path. Spawns no git.
 */
export async function findAncestorWorkspaces(childRoot: string): Promise<string[]> {
  const start = await fs.promises.realpath(childRoot).catch(() => path.resolve(childRoot));
  const gitDir = await lstatOrNull(path.join(start, '.git')).then((stat) => (stat?.isFile() ? gitDirOf(start) : null));
  const main = gitDir && /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) ? await mainCheckoutOf(gitDir) : null;
  const mainRoot = main ? await fs.promises.realpath(main).catch(() => main) : null;
  const found = [...await climb(start, mainRoot), ...mainRoot ? await climb(mainRoot, mainRoot) : []];
  return [...new Set(found)];
}

/**
 * Keep a child's Claude Code settings from loading the instructions of the
 * workspaces above it (#913): Claude Code reads every CLAUDE.md, AGENTS.md
 * and rules folder up the tree, so a session in a child would also get what
 * its workspace delivers for every other child. Adds `claudeMdExcludes`
 * entries for each workspace's CLAUDE.md, `.claude/CLAUDE.md` (where a pull
 * writes the team instructions), AGENTS.md and `.claude/rules/**` to
 * `settingsFile` (the child's `.claude/settings.local.json`), takes back the
 * ones `previous` names that no longer apply, and leaves every other entry
 * as it is. Returns the entries it owns now, for the next run's `previous`.
 * `withdraw` takes back every entry `previous` names, for uninstall. Writes
 * nothing outside a workspace or under `dryRun`; a file that is not a JSON
 * object is left alone, and the previous entries stay owned.
 */
export async function syncWorkspaceInstructionExcludes(input: {
  readonly projectRoot: string;
  readonly settingsFile: string;
  readonly previous: readonly string[];
  readonly dryRun?: boolean;
  readonly withdraw?: boolean;
}): Promise<string[]> {
  const desired = input.withdraw ? [] : (await findAncestorWorkspaces(input.projectRoot))
    .flatMap((workspace) => [
      path.join(workspace, 'CLAUDE.md'),
      path.join(workspace, '.claude', 'CLAUDE.md'),
      path.join(workspace, 'AGENTS.md'),
      path.join(workspace, '.claude', 'rules', '**'),
    ]);
  if (desired.length === 0 && input.previous.length === 0) return [];
  const read = await readJsonObject(input.settingsFile);
  if (read.kind === 'invalid') {
    if (!input.withdraw) log.warn(`${input.settingsFile} is not valid JSON (${read.error}), so this workspace's instructions were not excluded there. Fix the file, then run \`teamai pull\`.`);
    return [...input.previous];
  }
  const settings = read.kind === 'ok' ? read.value : {};
  const current = Array.isArray(settings.claudeMdExcludes) ? settings.claudeMdExcludes : [];
  const stale = new Set(input.previous.filter((entry) => !desired.includes(entry)));
  const kept = current.filter((entry) => typeof entry !== 'string' || !stale.has(entry));
  const next = [...kept, ...desired.filter((entry) => !kept.includes(entry))];
  // An entry the member already had stays the member's, so withdrawing leaves it.
  const owned = desired.filter((entry) => input.previous.includes(entry) || !current.includes(entry));
  if (input.dryRun || JSON.stringify(next) === JSON.stringify(current)) return owned;
  const { claudeMdExcludes: _old, ...rest } = settings;
  await writeJson(input.settingsFile, next.length > 0 ? { ...rest, claudeMdExcludes: next } : rest);
  return owned;
}

/** The configured folders above `start` a downward walk would pass through; `own` is the child's own anchor, never its workspace. */
async function climb(start: string, own: string | null): Promise<string[]> {
  const found: string[] = [];
  if (!isWalkable(path.basename(start))) return found;
  let dir = start;
  for (let level = 1; level <= MAX_CHILD_DEPTH; level++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    const parentGit = await lstatOrNull(path.join(parent, '.git'));
    // The same anchor the walk reads a child from: a linked worktree or a submodule keeps its config in its anchor's partition.
    const anchor = parentGit?.isDirectory() ? parent : parentGit?.isFile() ? await anchorOfGitFile(parent) : null;
    // Detection's order: the partition, then a config still in the checkout's `.teamai`.
    const configs = [
      ...anchor ? [path.join(await resolvePartitionDir(anchor, { dryRun: true }), 'config.yaml')] : [],
      path.join(parent, '.teamai', 'config.yaml'),
    ];
    if (parent !== own && (await Promise.all(configs.map(lstatOrNull))).some(Boolean)) found.push(parent);
    // The walk never goes through a repo, a dot folder or node_modules.
    if (parentGit || !isWalkable(path.basename(parent))) break;
    dir = parent;
  }
  return found;
}

type ChildRead =
  | { readonly kind: 'config'; readonly config: LocalConfig }
  | { readonly kind: 'unreadable'; readonly reason: string };

async function walk(input: {
  readonly root: string;
  readonly dir: string;
  readonly depth: number;
  readonly gitWorkspace: boolean;
  readonly found: Array<{ path: string; root: string; read: ChildRead }>;
}): Promise<void> {
  const entries = await fs.promises.readdir(input.dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory() && isWalkable(entry.name)).map(async (entry) => {
    const dir = path.join(input.dir, entry.name);
    const read = await readChildConfig(dir, input.gitWorkspace);
    if (read) input.found.push({ path: path.relative(input.root, dir).split(path.sep).join('/'), root: dir, read });
    // The walk stops at any repo: worktrees and folders inside it are its own.
    if (input.depth < MAX_CHILD_DEPTH && await lstatOrNull(path.join(dir, '.git')) === null) {
      await walk({ ...input, dir, depth: input.depth + 1 });
    }
  }));
}

/**
 * The project config of `dir` as detection would read it, or null when `dir`
 * is not set up. A plain clone, a submodule and a linked worktree are read
 * from their partition without git; another layout (a `core.worktree`, a git
 * dir elsewhere, a config still inside the checkout) takes detection's git
 * probe. Neither previews nor writes: a legacy partition is not renamed and a
 * single-repo clone is not bootstrapped.
 */
async function readChildConfig(dir: string, gitWorkspace: boolean): Promise<ChildRead | null> {
  // Loaded here: config.js reaches this module through the resolvers it imports.
  const { detectProjectConfig, readConfigFrom, resolveLegacyRole } = await import('./config.js');
  let unreadable: string | null = null;
  const onUnreadable = (_configPath: string, error: string): void => { unreadable ??= error; };
  // The fast reads below skip detection, so they resolve `hai` as it does.
  const read = async (dataHomeDir: string): Promise<LocalConfig | null> => {
    const config = await readConfigFrom(dataHomeDir, dir, undefined, onUnreadable, { selfHeal: false });
    return config && resolveLegacyRole(config);
  };
  const outcome = (config: LocalConfig | null): ChildRead | null => {
    if (unreadable !== null) return { kind: 'unreadable', reason: unreadable };
    return config ? { kind: 'config', config } : null;
  };
  const probe = async (): Promise<ChildRead | null> => outcome(
    await detectProjectConfig(dir, onUnreadable, { dryRun: true, selfHeal: false }),
  );

  const dotGit = await lstatOrNull(path.join(dir, '.git'));
  if (!dotGit) {
    // Outside a repo a folder is set up through its own `.teamai`; inside one,
    // such a folder is part of the workspace's checkout, not a child.
    if (gitWorkspace) return null;
    return outcome(await read(path.join(dir, '.teamai')));
  }

  let anchor: string | null;
  if (dotGit.isDirectory()) {
    const gitConfig = await readFileSafe(path.join(dir, '.git', 'config'));
    anchor = gitConfig && /^\s*worktree\s*=/m.test(gitConfig) ? null : await fs.promises.realpath(dir);
  } else {
    anchor = await anchorOfGitFile(dir);
  }
  if (anchor === null) return probe();
  const partition = await resolvePartitionDir(anchor, { dryRun: true });
  const fromPartition = await read(partition);
  if (fromPartition || unreadable !== null) return outcome(fromPartition);
  return await lstatOrNull(path.join(dir, '.teamai')) ? probe() : null;
}

/**
 * The anchor of a checkout whose `.git` is a file: the main checkout of a
 * linked worktree (from its `commondir`), or the git dir of a submodule (under
 * `modules/`). Null for any other layout, which takes the git probe.
 */
async function anchorOfGitFile(dir: string): Promise<string | null> {
  const gitDir = await gitDirOf(dir);
  if (!gitDir) return null;
  if (/[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) && !/[\\/]modules[\\/]/.test(gitDir)) {
    const main = await mainCheckoutOf(gitDir);
    return main ? fs.promises.realpath(main).catch(() => null) : null;
  }
  if (/[\\/]modules[\\/]/.test(gitDir) && !/[\\/]worktrees[\\/]/.test(gitDir)) {
    return fs.promises.realpath(gitDir).catch(() => null);
  }
  return null;
}

/** The git dir a `.git` file points at, or null. */
async function gitDirOf(dir: string): Promise<string | null> {
  const text = await readFileSafe(path.join(dir, '.git'));
  const pointer = text ? /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim() : undefined;
  return pointer ? path.resolve(dir, pointer) : null;
}

/** The main checkout of a linked worktree's git dir, or null for a bare repo or an unusual layout. */
async function mainCheckoutOf(worktreeGitDir: string): Promise<string | null> {
  const common = await readFileSafe(path.join(worktreeGitDir, 'commondir'));
  if (!common) return null;
  const commonDir = path.resolve(worktreeGitDir, common.trim());
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
}

/**
 * Where the walk starts: the workspace's root, or for a linked worktree of a
 * workspace repo its main checkout, so every checkout of the workspace
 * delivers the same children.
 */
async function walkRoot(projectRoot: string): Promise<string> {
  const dotGit = await lstatOrNull(path.join(projectRoot, '.git'));
  if (!dotGit?.isFile()) return projectRoot;
  const gitDir = await gitDirOf(projectRoot);
  const main = gitDir && /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) ? await mainCheckoutOf(gitDir) : null;
  return main ?? projectRoot;
}

function isWalkable(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules';
}

function hasOwnSelection(config: LocalConfig): boolean {
  return !!config.primaryRole || (config.projects ?? []).length > 0 || (config.subscribedTags ?? []).length > 0;
}

/** The selection fields of a member, cleared before a child's are set. */
function withoutSelection(): Pick<LocalConfig, 'additionalRoles' | 'projects'> & Record<'primaryRole' | 'subscribedTags' | 'excludedSkills', undefined> {
  return { primaryRole: undefined, additionalRoles: [], projects: [], subscribedTags: undefined, excludedSkills: undefined };
}

function selectionOf(config: LocalConfig): ChildSelection {
  return {
    ...(config.primaryRole ? { primaryRole: config.primaryRole } : {}),
    additionalRoles: config.additionalRoles ?? [],
    projects: config.projects ?? [],
    ...(config.subscribedTags ? { subscribedTags: config.subscribedTags } : {}),
    ...(config.excludedSkills ? { excludedSkills: config.excludedSkills } : {}),
  };
}

function fingerprintOf(children: readonly WorkspaceChild[], leftOut: readonly LeftOutChild[]): string {
  const sorted = (values: readonly string[] | undefined): string[] => [...values ?? []].sort();
  const data = {
    children: children.map((child) => ({
      anchor: child.anchor,
      primaryRole: child.selection.primaryRole ?? null,
      additionalRoles: sorted(child.selection.additionalRoles),
      projects: sorted(child.selection.projects),
      subscribedTags: child.selection.subscribedTags ? sorted(child.selection.subscribedTags) : null,
      excludedSkills: sorted(child.selection.excludedSkills),
    })),
    leftOut: leftOut.map((child) => `${child.path}\0${child.reason}`),
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  return fs.promises.lstat(p).catch(() => null);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

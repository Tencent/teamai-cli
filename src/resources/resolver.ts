import fs from 'node:fs/promises';
import path from 'node:path';
import { FOLDER_MARKERS, holdsMarker, unreadMarker } from '../folder-markers.js';
import { isSafeNamespaceSegment } from '../manifest-schema.js';
import { resolveNamespacedItems, type NamespaceCandidate, type NamespaceConflict, type ResolvedNamespaceItem } from '../namespace-resolver.js';
import { FolderFiles, type FolderFilesRead } from './folder-files.js';
import { TeamaiConfigBaseSchema } from '../types.js';
import { isIgnored } from '../utils/fs.js';

/** How a resource type lays out its items in a tree. `TEntry` is what one entry of its entry-list file holds. */
export interface ResourceLayout<TEntry = never> {
  /** The type's directory in a team tree and in teamai's package: `workflows`. */
  readonly dir: string;
  /**
   * The file whose presence, matched against the names `readdir` returns, makes a directory a folder of this type. Null
   * for a type with no folders. A folder holds no other item; a directory without the marker at the root is a namespace.
   */
  readonly marker: string | null;
  /**
   * Other spellings a folder may hold in place of `marker`, read the same way: `suite.yaml` for `SUITE.yaml`. A directory
   * holding two spellings is no folder any type can read, and is named in diagnostics.
   */
  readonly markerAliases?: readonly string[];
  /** The item a file directly in a layer's directory defines, by its name: `release.yaml` is `release`. Null for any other file. */
  readonly fileName: (file: string) => string | null;
  /** What a folder's directory name must match to be its type's name; a folder that does not is named in diagnostics. */
  readonly nameRule?: { readonly pattern: RegExp; readonly description: string };
  /** The file in a layer's directory whose entries are items (`hooks.yaml`), and how it reads them; `file` is its path, for messages. */
  readonly entryList?: {
    readonly file: string;
    readonly entries: (content: string, file: string) => EntryListRead<TEntry>;
  };
}

/** What an entry-list file holds: its entries in file order, with what its type has to say about it, or why it cannot be used. */
export type EntryListRead<TEntry> =
  | { readonly kind: 'entries'; readonly entries: ReadonlyArray<{ readonly name: string; readonly entry: TEntry }>; readonly notes?: readonly string[] }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * What a read of the team's files found besides items. `invalid`: a file or folder that defines no item because it
 * cannot be used; its type decides what that stops. `note`: something the team should hear, which changes nothing.
 * `path` is relative to the tree's root, `/`-separated; `message` names it.
 */
export interface ResourceDiagnostic {
  readonly kind: 'invalid' | 'note';
  readonly path: string;
  readonly message: string;
}

/** Where an item is defined, relative to its tree's root (`path`, `/`-separated, as messages show it) and absolute (`full`). */
export type ResourceSource<TEntry> =
  | { readonly kind: 'file'; readonly path: string; readonly full: string }
  /** `path` ends with `/`: `workflows/release/`. */
  | { readonly kind: 'folder'; readonly path: string; readonly full: string }
  /** The entry at `index` of the entry-list file at `path`. */
  | { readonly kind: 'entry'; readonly path: string; readonly full: string; readonly index: number; readonly entry: TEntry };

/** One definition of a name, and the layer that holds it. */
export type LayeredItem<TEntry, TShipped> =
  | { readonly layer: 'teamai'; readonly name: string; readonly source: ResourceSource<never>; readonly shipped: TShipped }
  | TeamItem<TEntry>;

/** A definition in the team's files, which the type reads and validates itself. */
export type TeamItem<TEntry> =
  | { readonly layer: 'root'; readonly name: string; readonly source: ResourceSource<TEntry> }
  | { readonly layer: 'namespace'; readonly namespace: string; readonly name: string; readonly source: ResourceSource<TEntry> };

/** Which definition of a name applies. */
export type LayeredResolution<TEntry, TShipped> =
  | { readonly kind: 'resolved'; readonly name: string; readonly item: LayeredItem<TEntry, TShipped>; readonly replaces: LayeredItem<TEntry, TShipped> | null }
  /**
   * Nothing says which one applies: `duplicate` when both are in one layer, `two-namespaces` when they are in two active
   * namespaces, `first` in the order the namespaces are active.
   */
  | { readonly kind: 'conflict'; readonly name: string; readonly reason: 'duplicate' | 'two-namespaces'; readonly first: TeamItem<TEntry>; readonly second: TeamItem<TEntry> }
  | { readonly kind: 'missing'; readonly name: string };

/** A default as teamai's package holds it. */
export interface ShippedFile {
  /** `/`-separated, from the package root: `workflows/teamai-score.yaml`, or a folder's marker. */
  readonly relativePath: string;
  readonly content: string;
  /** Every file of the folder a default is shipped as, the marker included. Absent for a default shipped as one file. */
  readonly folder?: FolderFilesRead;
}

/** teamai's defaults, the bottom layer: the package directory holding the type's directory, and how one is read. */
export interface TeamaiLayer<TShipped> {
  readonly root: string;
  readonly read: (file: ShippedFile) => TShipped;
}

/** The team's root and namespace layers. */
export interface TeamTree {
  /** The directory holding the type's directory: a team checkout, or `.teamai/` in self mode. */
  readonly root: string;
  /** The namespaces active for the member, or `legacy` (no roles.yaml or projects.yaml) for every namespace on disk. */
  readonly namespaces: () => Promise<readonly string[] | 'legacy'>;
}

/** What one scope sees: the team's layers and teamai's defaults, either of them alone, or both. */
export interface ResourceTree<TShipped> {
  readonly team?: TeamTree;
  readonly teamai?: TeamaiLayer<TShipped>;
}

/**
 * Every resource type that resolves through `Resources`. A type whose entry-list file needs its own parser adds
 * `entryList` to its row where that parser lives (`hooks.yaml`: `src/resources/hooks.ts`).
 */
export const RESOURCE_LAYOUTS = {
  workflows: { dir: 'workflows', marker: FOLDER_MARKERS.workflows.marker, fileName: (file: string) => (file.endsWith('.yaml') ? file.slice(0, -'.yaml'.length) : null) },
  hooks: { dir: 'hooks', marker: FOLDER_MARKERS.hooks.marker, fileName: () => null, nameRule: { pattern: /^[a-z0-9-]+$/, description: 'a hook id uses only lower-case letters, digits and hyphens' } },
  mcp: { dir: 'mcp', marker: FOLDER_MARKERS.mcp.marker, fileName: () => null, nameRule: { pattern: /^[A-Za-z0-9_-]+$/, description: 'an MCP server name uses only letters, digits, - and _' } },
  benchmarks: { dir: 'benchmarks', marker: FOLDER_MARKERS.benchmarks.marker, markerAliases: ['suite.yaml'], fileName: () => null },
  /** Names are paths at any depth (`Resources.walk`): `rules/fe/style.md` and `rules/fe/style/RULE.md` are `fe/style`. */
  rules: { dir: 'rules', marker: FOLDER_MARKERS.rules.marker, fileName: (file: string) => (file.endsWith('.md') ? file.slice(0, -'.md'.length) : null) },
} as const satisfies Readonly<Record<string, ResourceLayout<unknown>>>;

/**
 * Where a folder holding `file`, a `/`-separated path under the type's directory, can sit, as the scan meets folders: at
 * the root, then one namespace deep. `payments/release/prompt.md` can be in `payments` or `payments/release`.
 */
export function folderPlacesOf(file: string): string[] {
  const segments = file.split('/');

  return [1, 2].flatMap((depth) => (segments.length > depth ? [segments.slice(0, depth).join('/')] : []));
}

/**
 * The folder whose marker `file` is, from its `/`-separated path under the type's directory: `release/WORKFLOW.yaml`
 * is `release`'s, `payments/release/WORKFLOW.yaml` is `payments/release`'s. Undefined for a file that is no marker, or
 * a marker deeper than the scan meets folders.
 */
export function markerFolderOf(layout: ResourceLayout<unknown>, file: string): string | undefined {
  const dir = path.posix.dirname(file);
  const name = path.posix.basename(file);
  const isMarker = name === layout.marker || (layout.markerAliases ?? []).includes(name);

  return isMarker && folderPlacesOf(file).includes(dir) ? dir : undefined;
}

/** The names in `dir`, or none when it is missing, a symlink, or cannot be listed. */
async function fileNames(dir: string): Promise<string[]> {
  try {
    // readdir follows a directory symlink, so reject the directory itself before listing it.
    const stat = await fs.lstat(dir);

    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];

    return (await fs.readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * What pull says of `full`, shown as `folderPath`, when it is a symlink to a directory that holds one of `markers`: a
 * folder holds its own files, never a link (common rule 7 of #1787), so the folder is not read. Only the names behind
 * the link are read. Null for anything else.
 */
async function linkedFolder(full: string, folderPath: string, markers: ReadonlyArray<string | null>): Promise<ResourceDiagnostic | null> {
  if (!await isSymlink(full)) return null;
  const names = await fs.readdir(full).catch((): string[] => []);

  if (!markers.some((marker) => marker !== null && names.includes(marker))) return null;

  return {
    kind: 'invalid',
    path: folderPath,
    message: `${folderPath} is a symlink, and a folder holds its own files, never a link, so nothing is read from it. Put the directory itself in the team repo.`,
  };
}

/** The entries of `dir` that are symlinks, hidden ones left out. */
async function symlinks(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.flatMap((entry) => (entry.isSymbolicLink() && !entry.name.startsWith('.') ? [entry.name] : []));
}

/** The directories in `dir` that may hold items, in the order `readdir` lists them. */
async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    return entries.flatMap((entry) => (
      entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && isSafeNamespaceSegment(entry.name) ? [entry.name] : []
    ));
  } catch {
    return [];
  }
}

/** Which spelling of its type's marker a directory holds: none for a directory that is no folder, or two, which make it no folder any type can read. */
export type FolderMarkerRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'folder'; readonly marker: string }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Which spelling of `layout`'s marker the directory `full` holds, by the names `readdir` returns (common rule 1 of
 * #1787), so a file system that ignores case cannot read `SUITE.yaml` as `suite.yaml`. `path` names the folder in the
 * message, ending with `/`. A marker this release cannot read counts for nothing.
 */
export async function readFolderMarker(layout: ResourceLayout<unknown>, at: { readonly full: string; readonly path: string }): Promise<FolderMarkerRead> {
  const unread = unreadMarker(layout.dir);
  const names = new Set(await fileNames(at.full));
  const held = [layout.marker, ...layout.markerAliases ?? []].filter((marker): marker is string => marker !== null && marker !== unread && names.has(marker));
  const [marker, ...others] = held;

  if (marker === undefined) return { kind: 'none' };

  if (others.length > 0) return { kind: 'invalid', message: `${at.path} holds ${held.join(' and ')}, two spellings of one file; keep only ${layout.marker ?? marker}.` };

  return { kind: 'folder', marker };
}

/** An item one layer's directory holds, with the file that defines it: the file itself, the entry-list file, or the folder's marker. */
interface LayerItem<TEntry> {
  readonly name: string;
  readonly source: ResourceSource<TEntry>;
  readonly definition: string;
}

/** What one layer's directory holds: the items `layout` defines in it, the directories that are neither item nor skipped, and what the read found besides. */
interface LayerContents<TEntry> {
  readonly items: ReadonlyArray<LayerItem<TEntry>>;
  readonly plain: readonly string[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}

/** The entries of the entry-list file at `full`, with its notes, or why it cannot be used. */
async function entryItems<TEntry>(entryList: NonNullable<ResourceLayout<TEntry>['entryList']>, full: string, relative: string): Promise<LayerContents<TEntry>> {
  let content: string;

  try {
    content = await fs.readFile(full, 'utf8');
  } catch (error) {
    return { items: [], plain: [], diagnostics: [{ kind: 'invalid', path: relative, message: `${relative} cannot be read: ${error instanceof Error ? error.message : String(error)}` }] };
  }

  const read = entryList.entries(content, relative);

  switch (read.kind) {
    case 'invalid':
      return { items: [], plain: [], diagnostics: [{ kind: 'invalid', path: relative, message: read.message }] };
    case 'entries':
      return {
        items: read.entries.map(({ name, entry }, index) => ({ name, source: { kind: 'entry', path: relative, full, index, entry }, definition: full })),
        plain: [],
        diagnostics: (read.notes ?? []).map((message) => ({ kind: 'note', path: relative, message })),
      };
    default: {
      const unhandled: never = read;

      return unhandled;
    }
  }
}

/** The languages a text teamai renders may have a variant in: the values of `language` in teamai.yaml. */
const LANGUAGES = TeamaiConfigBaseSchema.shape.language.unwrap().options;

/**
 * Whether `file` is a language variant of the text file `base` (common rule 12 of #1787): `RULE.zh.md` of `RULE.md`,
 * with the language's exact lower-case name. Any other name, as `RULE.old.md`, is a support file.
 */
export function isLanguageVariant(base: string, file: string): boolean {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);

  return LANGUAGES.some((language) => file === `${stem}.${language}${ext}`);
}

/**
 * The note for a folder that holds files its layout reads as items elsewhere (common rule 1 of #1787): a directory
 * that held them gained the marker, so they are its files now. The marker's language variants are the folder's own
 * text and are never named. Null when it holds none.
 */
function itemFilesNote<TEntry>(layout: ResourceLayout<TEntry>, marker: string, folderPath: string, files: readonly string[]): ResourceDiagnostic | null {
  const read = files.filter((file) => file !== marker && !isLanguageVariant(marker, file) && (file === layout.entryList?.file || layout.fileName(file) !== null));

  if (read.length === 0) return null;

  const message = read.length === 1
    ? `${folderPath} holds ${marker}, so it is one folder, and ${read[0]} in it is one of its files, no longer read on its own.`
    : `${folderPath} holds ${marker}, so it is one folder, and ${read.join(', ')} in it are its files, no longer read on their own.`;

  return { kind: 'note', path: folderPath, message };
}

/** Read the layer in `dir`, naming each source by its path from `root`. */
async function readLayer<TEntry>(layout: ResourceLayout<TEntry>, root: string, dir: string): Promise<LayerContents<TEntry>> {
  const toPath = (full: string): string => path.relative(root, full).split(path.sep).join('/');
  const unread = unreadMarker(layout.dir);

  const items: Array<LayerItem<TEntry>> = [];
  const diagnostics: ResourceDiagnostic[] = [];

  for (const file of await fileNames(dir)) {
    const full = path.join(dir, file);

    if (layout.entryList?.file === file) {
      const read = await entryItems(layout.entryList, full, toPath(full));
      items.push(...read.items);
      diagnostics.push(...read.diagnostics);
      continue;
    }

    const name = layout.fileName(file);

    if (name !== null) items.push({ name, source: { kind: 'file', path: toPath(full), full }, definition: full });
  }

  const plain: string[] = [];

  for (const sub of await subdirectories(dir)) {
    const full = path.join(dir, sub);

    // A folder this release cannot read is left out whole (#1791): its marker would otherwise be an item in a namespace.
    if (await holdsMarker(full, unread)) continue;

    const folderPath = `${toPath(full)}/`;
    const held = await readFolderMarker(layout, { full, path: folderPath });

    switch (held.kind) {
      case 'none':
        plain.push(sub);
        break;
      case 'invalid':
        diagnostics.push({ kind: 'invalid', path: folderPath, message: held.message });
        break;
      case 'folder': {
        if (layout.nameRule && !layout.nameRule.pattern.test(sub)) {
          diagnostics.push({ kind: 'invalid', path: folderPath, message: `${folderPath} is not a valid name: ${layout.nameRule.description}. Rename the folder.` });
          break;
        }

        items.push({ name: sub, source: { kind: 'folder', path: folderPath, full }, definition: path.join(full, held.marker) });
        const note = itemFilesNote(layout, held.marker, folderPath, await fileNames(full));

        if (note) diagnostics.push(note);
        break;
      }

      default: {
        const unhandled: never = held;

        return unhandled;
      }
    }
  }

  const markers = [layout.marker, ...layout.markerAliases ?? []].filter((marker) => marker !== unread);

  for (const link of await symlinks(dir)) {
    const full = path.join(dir, link);
    const linked = await linkedFolder(full, `${toPath(full)}/`, markers);

    if (linked) diagnostics.push(linked);
  }

  return { items, plain, diagnostics };
}

/** A default file or folder of teamai's package, read. */
interface ShippedRead {
  readonly name: string;
  readonly source: ResourceSource<never>;
  readonly file: ShippedFile;
}

/** Each layout's defaults by package root, read once: teamai's package does not change while teamai runs. */
const shippedReads = new WeakMap<object, Map<string, Promise<readonly ShippedRead[]>>>();

/** The defaults of `layout` in the package at `root`, in path order. */
function readShipped<TEntry>(layout: ResourceLayout<TEntry>, root: string): Promise<readonly ShippedRead[]> {
  const byRoot = shippedReads.get(layout) ?? new Map<string, Promise<readonly ShippedRead[]>>();
  const known = byRoot.get(root);

  if (known) return known;

  const reading = (async (): Promise<readonly ShippedRead[]> => {
    const { items } = await readLayer(layout, root, path.join(root, layout.dir));
    const found: ShippedRead[] = [];

    for (const { name, source, definition } of [...items].sort((a, b) => (a.source.path < b.source.path ? -1 : 1))) {
      // teamai ships every default as a file or a folder of its own.
      if (source.kind === 'entry') continue;
      const relativePath = path.relative(root, definition).split(path.sep).join('/');
      const file: ShippedFile = { relativePath, content: await fs.readFile(definition, 'utf8') };
      found.push({ name, source, file: source.kind === 'folder' ? { ...file, folder: await FolderFiles.read(source.full) } : file });
    }

    return found;
  })();

  byRoot.set(root, reading);
  shippedReads.set(layout, byRoot);

  return reading;
}

/** teamai's defaults of `layout`, in path order. */
async function shippedItems<TEntry, TShipped>(layout: ResourceLayout<TEntry>, teamai: TeamaiLayer<TShipped>): Promise<Array<LayeredItem<TEntry, TShipped>>> {
  return (await readShipped(layout, teamai.root)).map(({ name, source, file }) => ({ layer: 'teamai', name, source, shipped: teamai.read(file) }));
}

/** The items of `layout` in the team's files: the root's, then each namespace's, in the order the scan meets them; and what the scan found besides. */
async function teamItems<TEntry>(layout: ResourceLayout<TEntry>, team: TeamTree): Promise<{ items: Array<TeamItem<TEntry>>; diagnostics: ResourceDiagnostic[] }> {
  const dir = path.join(team.root, layout.dir);
  const root = await readLayer(layout, team.root, dir);
  const items: Array<TeamItem<TEntry>> = root.items.map(({ name, source }) => ({ layer: 'root', name, source }));
  const diagnostics = [...root.diagnostics];

  for (const namespace of root.plain) {
    const read = await readLayer(layout, team.root, path.join(dir, namespace));
    diagnostics.push(...read.diagnostics);

    for (const { name, source } of read.items) items.push({ layer: 'namespace', namespace, name, source });
  }

  return { items, diagnostics };
}

/** One layer of the team's files, as `layer` reads it. */
export interface TeamLayer<TEntry> {
  readonly items: ReadonlyArray<TeamItem<TEntry>>;
  readonly diagnostics: readonly ResourceDiagnostic[];
}

/**
 * The items of one layer of the team's files, the root's (`namespace: null`) or `<dir>/<namespace>/`'s, in scan order,
 * with what the read found besides. For a type that applies its own rules to each item before the layers are resolved.
 * A namespace directory that holds a folder marker, or is a symlink, is no namespace and gives nothing.
 */
async function layer<TEntry>(layout: ResourceLayout<TEntry>, at: { readonly root: string; readonly namespace: string | null }): Promise<TeamLayer<TEntry>> {
  const typeDir = path.join(at.root, layout.dir);

  if (at.namespace === null) {
    const read = await readLayer(layout, at.root, typeDir);

    return { items: read.items.map(({ name, source }) => ({ layer: 'root', name, source })), diagnostics: read.diagnostics };
  }

  const { namespace } = at;
  const dir = path.join(typeDir, namespace);
  const markers = [layout.marker, ...layout.markerAliases ?? [], unreadMarker(layout.dir)];

  if (await isSymlink(dir) || (await Promise.all(markers.map((marker) => holdsMarker(dir, marker)))).some(Boolean)) return { items: [], diagnostics: [] };
  const read = await readLayer(layout, at.root, dir);

  return { items: read.items.map(({ name, source }) => ({ layer: 'namespace', namespace, name, source })), diagnostics: read.diagnostics };
}

/** Whether `file` is a symbolic link itself; false when it is missing. */
async function isSymlink(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A resolution `list` gives: every name it gives has a definition, or two that conflict. */
export type ListedResolution<TEntry, TShipped> = Exclude<LayeredResolution<TEntry, TShipped>, { readonly kind: 'missing' }>;

/** Every name of a layout in a tree, as `list` gives them, and what the read found besides. */
export interface ResourceSurvey<TEntry, TShipped> {
  readonly resolutions: Array<ListedResolution<TEntry, TShipped>>;
  /** Every definition in the team's files, in scan order, whether or not its namespace is active or it applies. */
  readonly definitions: ReadonlyArray<TeamItem<TEntry>>;
  readonly diagnostics: readonly ResourceDiagnostic[];
}

/**
 * Every name of `layout` in `tree`, each resolved as `resolve` resolves it: the team's names in the order the scan meets
 * them (the root's files in name order, then each namespace's), then the names only teamai ships, in name order. Asks
 * `tree` for its namespaces only once the scan meets an item in one, so a root-only tree reads no manifest. A file or
 * folder that cannot be used defines no item and is named in `diagnostics` instead, for its type to act on.
 */
async function survey<TEntry, TShipped>(layout: ResourceLayout<TEntry>, tree: ResourceTree<TShipped>): Promise<ResourceSurvey<TEntry, TShipped>> {
  const shipped = tree.teamai ? await shippedItems(layout, tree.teamai) : [];
  const { items, diagnostics } = tree.team ? await teamItems(layout, tree.team) : { items: [], diagnostics: [] };
  const onDisk = [...new Set(items.flatMap((item) => (item.layer === 'namespace' ? [item.namespace] : [])))];
  const declared = tree.team && onDisk.length > 0 ? await tree.team.namespaces() : [];
  const active = declared === 'legacy' ? onDisk : declared;
  const candidates = items.map((item) => ({ name: item.name, source: item.source.path, namespace: item.layer === 'namespace' ? item.namespace : null, value: item }));

  const team = pick(candidates, active).map((picked): ListedResolution<TEntry, TShipped> => {
    if (picked.kind === 'conflict') {
      return { kind: 'conflict', name: picked.name, reason: picked.reason, first: picked.first.value, second: picked.second.value };
    }

    const { item: winner } = picked;

    return { kind: 'resolved', name: winner.name, item: winner.value, replaces: winner.replaces?.value ?? shipped.find((item) => item.name === winner.name) ?? null };
  });

  const named = new Set(team.map(({ name }) => name));

  const resolutions = [...team, ...shipped.flatMap((item): Array<ListedResolution<TEntry, TShipped>> => (
    named.has(item.name) ? [] : [{ kind: 'resolved', name: item.name, item, replaces: null }]
  ))];

  return { resolutions, definitions: items, diagnostics };
}

/** Which definition of one name applies, or the two that conflict, as `pick` gives it. */
export type PickedName<T> = { readonly kind: 'resolved'; readonly item: ResolvedNamespaceItem<T> } | NamespaceConflict<T>;

/**
 * Which of `candidates` applies for each name, among the root and the `active` namespaces: the most specific place that
 * has it, as a whole, or a conflict. Names come in the order the candidates first meet them; a name only an inactive
 * namespace has is left out. `survey` resolves the team's files with it, and a type that admits each definition by its
 * own rules first (hooks, MCP) resolves what it admitted.
 */
function pick<T>(candidates: ReadonlyArray<NamespaceCandidate<T>>, active: readonly string[]): Array<PickedName<T>> {
  const byName = new Map<string, Array<NamespaceCandidate<T>>>();

  for (const candidate of candidates) {
    const group = byName.get(candidate.name);

    if (group) group.push(candidate);
    else byName.set(candidate.name, [candidate]);
  }

  return [...byName.values()].flatMap((group): Array<PickedName<T>> => {
    const resolution = resolveNamespacedItems(group, active);

    if (resolution.kind === 'conflict') return [resolution];
    const [item] = resolution.items;

    return item ? [{ kind: 'resolved', item }] : [];
  });
}

/**
 * A layout with no entry-list file, which can be invalid, and no name rule, which a folder can break. `list` and
 * `resolve` take only these. They still drop a folder that is a symlink, which `survey` names, so a type reads the
 * team's files through `survey` or `walk`.
 */
export type PlainLayout<TEntry = never> = ResourceLayout<TEntry> & { readonly entryList?: undefined; readonly nameRule?: undefined };

/** `survey`'s resolutions alone, without its diagnostics: for teamai's own layer, or a lookup whose type reports what its own read finds. */
async function list<TEntry, TShipped>(layout: PlainLayout<TEntry>, tree: ResourceTree<TShipped>): Promise<Array<ListedResolution<TEntry, TShipped>>> {
  return (await survey<TEntry, TShipped>(layout, tree)).resolutions;
}

/** Which definition of `name` applies in `tree`: the most specific layer that has it, as a whole, or a conflict. */
async function resolve<TEntry, TShipped>(layout: PlainLayout<TEntry>, name: string, tree: ResourceTree<TShipped>): Promise<LayeredResolution<TEntry, TShipped>> {
  return (await list(layout, tree)).find((resolution) => resolution.name === name) ?? { kind: 'missing', name };
}

/** An item `walk` found, named by its path from the type's directory: `fe/api-style`. */
export interface WalkedItem {
  readonly name: string;
  readonly source: Extract<ResourceSource<never>, { readonly kind: 'file' | 'folder' }>;
}

/** What `walk` found: every name defined once, in path order; every name defined twice; and what the walk found besides. */
export interface ResourceWalk {
  readonly items: readonly WalkedItem[];
  /** A file and a folder of one name in one directory (`style.md` beside `style/`); neither is in `items`. */
  readonly duplicates: ReadonlyArray<{ readonly name: string; readonly first: WalkedItem; readonly second: WalkedItem }>;
  readonly diagnostics: readonly ResourceDiagnostic[];
}

/**
 * Every item of `layout` at any depth of `<root>/<dir>/`, for a type whose names are paths and which applies its own
 * namespace rules to them (rules): `rules/fe/style.md` and `rules/fe/style/RULE.md` are both `fe/style`. A directory
 * that holds the marker is a folder, whose files are its own and are not read as items; every other directory is walked.
 * As the type read its files before folders: every file but a symlink and the names `isIgnored` gives, hidden ones too.
 */
async function walk(layout: PlainLayout, root: string): Promise<ResourceWalk> {
  const toPath = (full: string): string => path.relative(root, full).split(path.sep).join('/');
  const unread = unreadMarker(layout.dir);
  const folderMarker = layout.marker === unread ? null : layout.marker;
  const found: WalkedItem[] = [];
  const diagnostics: ResourceDiagnostic[] = [];

  const visit = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isFile()) {
        const stem = layout.fileName(entry.name);

        if (stem !== null) found.push({ name: `${prefix}${stem}`, source: { kind: 'file', path: toPath(full), full } });
        continue;
      }

      if (entry.isSymbolicLink()) {
        const linked = await linkedFolder(full, `${toPath(full)}/`, [folderMarker]);

        if (linked) diagnostics.push(linked);
        continue;
      }

      // A folder this release cannot read is left out whole (#1791).
      if (!entry.isDirectory() || await holdsMarker(full, unread)) continue;

      if (folderMarker !== null && await holdsMarker(full, folderMarker)) {
        const folderPath = `${toPath(full)}/`;
        found.push({ name: `${prefix}${entry.name}`, source: { kind: 'folder', path: folderPath, full } });
        const note = itemFilesNote(layout, folderMarker, folderPath, await fileNames(full));

        if (note) diagnostics.push(note);
        continue;
      }

      await visit(full, `${prefix}${entry.name}/`);
    }
  };

  await visit(path.join(root, layout.dir), '');
  found.sort((a, b) => (a.source.path < b.source.path ? -1 : 1));
  const byName = new Map<string, WalkedItem[]>();

  for (const item of found) byName.set(item.name, [...byName.get(item.name) ?? [], item]);

  const items: WalkedItem[] = [];
  const duplicates: Array<ResourceWalk['duplicates'][number]> = [];

  for (const [name, [first, second]] of byName) {
    if (first === undefined) continue;

    if (second === undefined) items.push(first);
    else duplicates.push({ name, first, second });
  }

  return { items, duplicates, diagnostics };
}

export const Resources = { list, resolve, survey, pick, layer, walk } as const;

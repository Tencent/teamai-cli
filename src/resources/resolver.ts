import fs from 'node:fs/promises';
import path from 'node:path';
import { holdsMarker, unreadMarker } from '../folder-markers.js';
import { isSafeNamespaceSegment } from '../manifest-schema.js';
import { resolveNamespacedItems } from '../namespace-resolver.js';
import { readFileSafe } from '../utils/fs.js';

/** How a resource type lays out its items in a tree. `TEntry` is what one entry of its entry-list file holds. */
export interface ResourceLayout<TEntry = never> {
  /** The type's directory in a team tree and in teamai's package: `workflows`. */
  readonly dir: string;
  /**
   * The file whose presence, matched against the names `readdir` returns, makes a directory a folder of this type. Null
   * for a type with no folders. A folder holds no other item; a directory without the marker at the root is a namespace.
   */
  readonly marker: string | null;
  /** The item a file directly in a layer's directory defines, by its name: `release.yaml` is `release`. Null for any other file. */
  readonly fileName: (file: string) => string | null;
  /** The file in a layer's directory whose entries are items (`hooks.yaml`), and how it names them, in file order. */
  readonly entryList?: {
    readonly file: string;
    readonly entries: (content: string) => ReadonlyArray<{ readonly name: string; readonly entry: TEntry }>;
  };
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
  /** `/`-separated, from the package root: `workflows/teamai-score.yaml`. */
  readonly relativePath: string;
  readonly content: string;
}

/** teamai's defaults, the bottom layer: the package directory holding the type's directory, and how one is read. */
export interface TeamaiLayer<TShipped> {
  readonly root: string;
  readonly read: (file: ShippedFile) => TShipped;
}

/** The team's root and namespace layers. */
export interface TeamTree {
  /** The directory holding the type's directory: a team checkout, or `.teamai/` in single-repo. */
  readonly root: string;
  /** The namespaces active for the member, or `legacy` (no roles.yaml or projects.yaml) for every namespace on disk. */
  readonly namespaces: () => Promise<readonly string[] | 'legacy'>;
}

/** What one scope sees: the team's layers and teamai's defaults, either of them alone, or both. */
export interface ResourceTree<TShipped> {
  readonly team?: TeamTree;
  readonly teamai?: TeamaiLayer<TShipped>;
}

/** Every resource type that resolves through `Resources`. */
export const RESOURCE_LAYOUTS = {
  workflows: { dir: 'workflows', marker: 'WORKFLOW.yaml', fileName: (file: string) => (file.endsWith('.yaml') ? file.slice(0, -'.yaml'.length) : null) },
} as const satisfies Readonly<Record<string, ResourceLayout<unknown>>>;

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

/** An item one layer's directory holds, with the file that defines it: the file itself, the entry-list file, or the folder's marker. */
interface LayerItem<TEntry> {
  readonly name: string;
  readonly source: ResourceSource<TEntry>;
  readonly definition: string;
}

/** What one layer's directory holds: the items `layout` defines in it, and the directories that are neither item nor skipped. */
interface LayerContents<TEntry> {
  readonly items: ReadonlyArray<LayerItem<TEntry>>;
  readonly plain: readonly string[];
}

/** The entries of the entry-list file at `full`, none when it cannot be read. */
async function entryItems<TEntry>(entryList: NonNullable<ResourceLayout<TEntry>['entryList']>, full: string, relative: string): Promise<Array<LayerItem<TEntry>>> {
  const content = await readFileSafe(full);

  return content === null ? [] : entryList.entries(content).map(({ name, entry }, index) => ({
    name, source: { kind: 'entry', path: relative, full, index, entry }, definition: full,
  }));
}

/** Read the layer in `dir`, naming each source by its path from `root`. */
async function readLayer<TEntry>(layout: ResourceLayout<TEntry>, root: string, dir: string): Promise<LayerContents<TEntry>> {
  const toPath = (full: string): string => path.relative(root, full).split(path.sep).join('/');
  const unread = unreadMarker(layout.dir);
  const folderMarker = layout.marker === unread ? null : layout.marker;

  const items: Array<LayerItem<TEntry>> = [];

  for (const file of await fileNames(dir)) {
    const full = path.join(dir, file);

    if (layout.entryList?.file === file) {
      items.push(...await entryItems(layout.entryList, full, toPath(full)));
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

    if (folderMarker !== null && await holdsMarker(full, folderMarker)) {
      items.push({ name: sub, source: { kind: 'folder', path: `${toPath(full)}/`, full }, definition: path.join(full, folderMarker) });
    } else {
      plain.push(sub);
    }
  }

  return { items, plain };
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
      found.push({ name, source, file: { relativePath, content: await fs.readFile(definition, 'utf8') } });
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

/** The items of `layout` in the team's files: the root's, then each namespace's, in the order the scan meets them. */
async function teamItems<TEntry>(layout: ResourceLayout<TEntry>, team: TeamTree): Promise<Array<TeamItem<TEntry>>> {
  const dir = path.join(team.root, layout.dir);
  const root = await readLayer(layout, team.root, dir);
  const items: Array<TeamItem<TEntry>> = root.items.map(({ name, source }) => ({ layer: 'root', name, source }));

  for (const namespace of root.plain) {
    for (const { name, source } of (await readLayer(layout, team.root, path.join(dir, namespace))).items) {
      items.push({ layer: 'namespace', namespace, name, source });
    }
  }

  return items;
}

/** A resolution `list` gives: every name it gives has a definition, or two that conflict. */
export type ListedResolution<TEntry, TShipped> = Exclude<LayeredResolution<TEntry, TShipped>, { readonly kind: 'missing' }>;

/**
 * Every name of `layout` in `tree`, each resolved as `resolve` resolves it: the team's names in the order the scan meets
 * them (the root's files in name order, then each namespace's), then the names only teamai ships, in name order. Asks
 * `tree` for its namespaces only once the scan meets an item in one, so a root-only tree reads no manifest.
 */
async function list<TEntry, TShipped>(layout: ResourceLayout<TEntry>, tree: ResourceTree<TShipped>): Promise<Array<ListedResolution<TEntry, TShipped>>> {
  const shipped = tree.teamai ? await shippedItems(layout, tree.teamai) : [];
  const items = tree.team ? await teamItems(layout, tree.team) : [];
  const onDisk = [...new Set(items.flatMap((item) => (item.layer === 'namespace' ? [item.namespace] : [])))];
  const declared = tree.team && onDisk.length > 0 ? await tree.team.namespaces() : [];
  const active = declared === 'legacy' ? onDisk : declared;
  const byName = new Map<string, Array<TeamItem<TEntry>>>();

  for (const item of items) {
    const group = byName.get(item.name);

    if (group) group.push(item);
    else byName.set(item.name, [item]);
  }

  const team = [...byName].flatMap(([name, group]): Array<ListedResolution<TEntry, TShipped>> => {
    const resolution = resolveNamespacedItems(group.map((item) => ({
      name, source: item.source.path, namespace: item.layer === 'namespace' ? item.namespace : null, value: item,
    })), active);

    if (resolution.kind === 'conflict') {
      return [{ kind: 'conflict', name, reason: resolution.reason, first: resolution.first.value, second: resolution.second.value }];
    }

    const [winner] = resolution.items;
    const replaced = shipped.find((item) => item.name === name) ?? null;

    return winner ? [{ kind: 'resolved', name, item: winner.value, replaces: winner.replaces?.value ?? replaced }] : [];
  });

  const named = new Set(team.map(({ name }) => name));

  return [...team, ...shipped.flatMap((item): Array<ListedResolution<TEntry, TShipped>> => (
    named.has(item.name) ? [] : [{ kind: 'resolved', name: item.name, item, replaces: null }]
  ))];
}

/** Which definition of `name` applies in `tree`: the most specific layer that has it, as a whole, or a conflict. */
async function resolve<TEntry, TShipped>(layout: ResourceLayout<TEntry>, name: string, tree: ResourceTree<TShipped>): Promise<LayeredResolution<TEntry, TShipped>> {
  return (await list(layout, tree)).find((resolution) => resolution.name === name) ?? { kind: 'missing', name };
}

export const Resources = { list, resolve } as const;

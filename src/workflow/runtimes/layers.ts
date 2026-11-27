import fs from 'node:fs/promises';
import path from 'node:path';
import { teamaiPackageDir } from '../../default-drivers.js';
import { workflowNamespacesOf } from '../../resource-namespaces.js';
import { isSymlink, RESOURCE_LAYOUTS, Resources, type ShippedFile, type TeamTree } from '../../resources/resolver.js';
import { PERSONAL_TOOLS_DIR } from '../../tool-instances.js';
import { getKnowledgeDir, getTeamaiHomeDir, type LocalConfig } from '../../types.js';
import { firstLink } from './resource-folder.js';

// ─── Where a driver's resources come from ────────────────
//
//  A driver definition, a step runtime and a sandbox profile are each `<kind>/<name>.yaml` or a folder `<kind>/<name>/`
//  holding the kind's marker, in three layers: the member's own ~/.teamai/<kind>/, the team repo's <kind>/ (and
//  <kind>/<namespace>/ for each active namespace), then teamai's own <kind>/ in its package. A name is looked up in every
//  layer, then as teamai-<name>, and the first layer that holds it decides: one whose definition cannot be used fails the
//  lookup, so another layer's never stands in for the one the member or the team wrote.
//

/** The member's own directories, which teamai reads and never writes, so team code it caches never reads as the member's. */
export const PERSONAL_DIRS = { drivers: 'drivers', runtimes: 'runtimes', sandboxes: 'sandboxes', tools: PERSONAL_TOOLS_DIR } as const;

/** The prefix of every name teamai ships a driver, a runtime or a sandbox profile by. */
export const SHIPPED_PREFIX = 'teamai-';

/** A kind of resource a driver is built from, found in the three layers. */
export type LayeredKind = 'drivers' | 'runtimes' | 'sandboxes';

export type Layer = 'personal' | 'team' | 'teamai';

export function personalDir(kind: keyof typeof PERSONAL_DIRS): string {
  return path.join(getTeamaiHomeDir(), PERSONAL_DIRS[kind]);
}

/**
 * `config`'s team tree as the resolver reads drivers, runtimes and sandboxes from it: the root, and each namespace active
 * for the member's workflows.
 */
export function teamTreeOf(config: LocalConfig): TeamTree {
  return { root: getKnowledgeDir(config), namespaces: () => workflowNamespacesOf(config) };
}

/** The names `asked` is looked up by, in order: itself, then as teamai ships it. */
export function namesOf(asked: string): string[] {
  return asked.startsWith(SHIPPED_PREFIX) ? [asked] : [asked, `${SHIPPED_PREFIX}${asked}`];
}

interface FoundAt {
  /** The name it was found by: the name asked, or `teamai-<name>`. */
  readonly resource: string;
  readonly form: 'file' | 'folder';
  /** The file form itself, or the folder. */
  readonly at: string;
  /** Where a message names it: its path in the team repo (`runtimes/t3/`), the member's file or folder, or teamai's. */
  readonly location: string;
}

/** A definition found, before its caller reads it: teamai's with its marker's text read, the team's with its config. */
export type LayerItem =
  | FoundAt & { readonly layer: 'personal' }
  | FoundAt & { readonly layer: 'team'; readonly config: LocalConfig }
  | FoundAt & { readonly layer: 'teamai'; readonly text: string };

/** Why the first layer that holds a name cannot give it. */
export type LayerRefusal =
  /** Two definitions in one place: the member's file and folder, or the team's in one folder. */
  | { readonly kind: 'duplicate'; readonly first: string; readonly second: string }
  | { readonly kind: 'two-namespaces'; readonly first: string; readonly second: string }
  /** The team repo's `<kind>` directory is a link, whose definitions are not the team repo's. */
  | { readonly kind: 'linked-dir'; readonly dir: string }
  /** The definition's folder is a link. */
  | { readonly kind: 'linked-folder'; readonly folder: string }
  /** The folder holds `link`, so what it runs or builds is not all the folder holds. */
  | { readonly kind: 'holds-link'; readonly link: string }
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** A folder of the name holds no marker, and nothing that makes it a namespace: a definition with its marker missing or misspelt. */
  | { readonly kind: 'no-marker'; readonly marker: string };

export type LayerFind =
  | { readonly kind: 'found'; readonly item: LayerItem; readonly replaces?: string }
  | { readonly kind: 'refused'; readonly layer: Layer; readonly resource: string; readonly location: string; readonly refusal: LayerRefusal }
  | { readonly kind: 'missing' };

type Step = { readonly kind: 'found'; readonly item: LayerItem } | Extract<LayerFind, { kind: 'refused' }> | { readonly kind: 'missing' };

const MISSING: Step = { kind: 'missing' };

/** Whether `file` names the marker `marker`, in another case or with another extension. */
function isMarkerLike(file: string, marker: string): boolean {
  return path.parse(file).name.toLowerCase() === path.parse(marker).name.toLowerCase();
}

/**
 * Whether `folder` is a definition of `kind` with its marker missing or misspelt: a folder (not a link) with no marker,
 * holding no definition of the kind besides a look-alike of the marker, so it is no namespace either.
 */
async function lacksMarker(kind: LayeredKind, folder: string): Promise<boolean> {
  const layout = RESOURCE_LAYOUTS[kind];

  if ((await fs.lstat(folder).catch(() => undefined))?.isDirectory() !== true) return false;
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => undefined);

  if (entries === undefined) return false;

  if (entries.some((entry) => entry.name === layout.marker)) return false;

  const holdsDefinition = await Promise.all(entries.map(async (entry) => (entry.isDirectory()
    ? (await fs.lstat(path.join(folder, entry.name, layout.marker)).catch(() => undefined))?.isFile() === true
    : layout.fileName(entry.name) !== null && !isMarkerLike(entry.name, layout.marker))));

  return !holdsDefinition.includes(true);
}

/** The member's own `name` of `kind`, `~/.teamai/<kind>/<name>.yaml` or `<name>/` holding the marker. */
async function fromPersonal(kind: LayeredKind, name: string): Promise<Step> {
  const { marker } = RESOURCE_LAYOUTS[kind];
  const file = path.join(personalDir(kind), `${name}.yaml`);
  const folder = path.join(personalDir(kind), name);
  const location = `${folder}${path.sep}`;

  const [isFile, isFolder] = await Promise.all([
    fs.stat(file).then((stat) => stat.isFile(), () => false),
    fs.stat(path.join(folder, marker)).then((stat) => stat.isFile(), () => false),
  ]);

  if (isFile && isFolder) return { kind: 'refused', layer: 'personal', resource: name, location: file, refusal: { kind: 'duplicate', first: file, second: location } };

  if (isFile) return { kind: 'found', item: { layer: 'personal', resource: name, form: 'file', at: file, location: file } };

  if (isFolder) return { kind: 'found', item: { layer: 'personal', resource: name, form: 'folder', at: folder, location } };

  return await lacksMarker(kind, folder) ? { kind: 'refused', layer: 'personal', resource: name, location, refusal: { kind: 'no-marker', marker } } : MISSING;
}

/** The team's `name` of `kind` in `config`'s team tree, among the root and the active namespaces. */
async function fromTeam(kind: LayeredKind, config: LocalConfig, name: string): Promise<Step> {
  const layout = RESOURCE_LAYOUTS[kind];
  const tree = teamTreeOf(config);
  const refused = (location: string, refusal: LayerRefusal): Step => ({ kind: 'refused', layer: 'team', resource: name, location, refusal });

  if (await isSymlink(path.join(tree.root, layout.dir))) return refused(layout.dir, { kind: 'linked-dir', dir: layout.dir });
  const { resolutions, diagnostics } = await Resources.survey(layout, { team: tree });
  // A folder that is a link holds what the team repo does not, so it is refused rather than passed over.
  const linked = diagnostics.find((diagnostic) => diagnostic.kind === 'invalid' && path.posix.basename(diagnostic.path) === name && diagnostic.path.endsWith('/'));

  if (linked) return refused(linked.path, { kind: 'linked-folder', folder: linked.path.slice(0, -1) });
  const resolution = resolutions.find((candidate) => candidate.name === name);

  if (resolution === undefined) {
    const namespaces = await tree.namespaces();
    const places = namespaces === 'legacy' ? [] : namespaces;

    for (const place of ['', ...places]) {
      const relative = path.posix.join(layout.dir, place, name);

      if (await lacksMarker(kind, path.join(tree.root, ...relative.split('/')))) return refused(`${relative}/`, { kind: 'no-marker', marker: layout.marker });
    }

    return MISSING;
  }

  if (resolution.kind === 'conflict') {
    return refused(resolution.first.source.path, { kind: resolution.reason, first: resolution.first.source.path, second: resolution.second.source.path });
  }

  const { source } = resolution.item;

  if (source.kind === 'folder') {
    const found = await firstLink(source.full);

    if (!found.ok) return refused(source.path, { kind: 'unreadable', reason: found.reason });

    if (found.link !== undefined) return refused(source.path, { kind: 'holds-link', link: found.link });
  }

  return { kind: 'found', item: { layer: 'team', resource: name, form: source.kind === 'folder' ? 'folder' : 'file', at: source.full, location: source.path, config } };
}

/** teamai's own `name` of `kind`, in `<kind>/` of its package. */
async function fromTeamai(kind: LayeredKind, name: string): Promise<Step> {
  const resolution = await Resources.resolve(RESOURCE_LAYOUTS[kind], name, { teamai: { root: teamaiPackageDir(), read: (file: ShippedFile) => file } });

  if (resolution.kind !== 'resolved' || resolution.item.layer !== 'teamai') return MISSING;
  const { item } = resolution;

  return {
    kind: 'found',
    item: { layer: 'teamai', resource: name, form: item.source.kind === 'folder' ? 'folder' : 'file', at: item.source.full, location: `teamai's ${item.shipped.relativePath}`, text: item.shipped.content },
  };
}

/**
 * The first definition of `kind` by `names`, in order, in the layers given: the member's own when `personal`, each of
 * `teams` in turn, then teamai's unless `teamai` is false. A layer that holds a name it cannot give refuses, and the
 * lookup ends there. A definition of the member or the team names the shipped one it stands in for (`replaces`).
 */
export async function findInLayers(kind: LayeredKind, names: readonly string[], { personal, teams, teamai = true }: { personal: boolean; teams: readonly LocalConfig[]; teamai?: boolean }): Promise<LayerFind> {
  const layers: Array<(name: string) => Promise<Step>> = [
    ...(personal ? [(name: string) => fromPersonal(kind, name)] : []),
    ...teams.map((config) => (name: string) => fromTeam(kind, config, name)),
    ...(teamai ? [(name: string) => fromTeamai(kind, name)] : []),
  ];

  for (const name of names) {
    for (const layer of layers) {
      const step = await layer(name);

      if (step.kind === 'missing') continue;

      if (step.kind === 'refused' || step.item.layer === 'teamai' || !teamai) return step;
      const replaces = await shippedName(kind, names);

      return replaces === undefined ? step : { ...step, replaces };
    }
  }

  return { kind: 'missing' };
}

/** The first of `names` teamai ships a definition of `kind` by, or none. */
async function shippedName(kind: LayeredKind, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    if ((await fromTeamai(kind, name)).kind === 'found') return name;
  }

  return undefined;
}

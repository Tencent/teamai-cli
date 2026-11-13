/**
 * Hooks and MCP servers (#1787): types whose items are entries of an entry-list file (`hooks.yaml`, `mcp.yaml`) and
 * folders, at the root and in each namespace, resolved through `Resources`. Each place is read by `Resources.layer`,
 * each item is admitted by its type's folder rules and the per-entry keys, and `Resources.pick` says which definition
 * of each name applies. The per-entry keys, the failure policy and how a workspace's members combine are shared with
 * env and models (`namespaced-entries.ts`).
 *
 * While `roles:` is deprecated, a name repeated with `roles:` on every copy is delivered as 0.25.0 did. Legacy mode (no
 * roles, no projects) reads the root alone and lets its entry-list file repeat a name, as before.
 */
import path from 'node:path';
import type { z } from 'zod';
import {
  activeEntryNamespaces, entryLayout, keepScopedEntry, namespaceDir, resolveWorkspaceEntries, TargetFiles,
  type EntryFailure, type EntryNotice, type EntryResolution, type EntryScopeKeys,
} from '../namespaced-entries.js';
import { firstConflict, repeatedNames, type NamespaceCandidate } from '../namespace-resolver.js';
import { type LocalConfig } from '../types.js';
import { isJsonObject, type JsonValue } from '@teamai/shared/json';
import { listDirs } from '../utils/fs.js';
import { parseYaml } from '@teamai/shared/yaml';
import { deliveredMembers } from '../workspace-children.js';
import { FolderFiles, type FolderFile } from './folder-files.js';
import { Resources, type ResourceLayout, type TeamItem } from './resolver.js';

/** What a type makes of one folder of a place: its definition and the keys it has that the schema does not know, a skip with what to tell the team, or why the place cannot be used. */
export type PlaceFolderRead<E> =
  | { readonly kind: 'read'; readonly definition: E; readonly unknownKeys: readonly string[] }
  | { readonly kind: 'skipped'; readonly note: string | null }
  | { readonly kind: 'invalid'; readonly reason: string };

/** A type resolved here, and how it makes a definition of an entry or a folder. */
export interface LayeredEntryType<TEntry, E> {
  readonly type: 'hooks' | 'mcp';
  /** Where its items are in a team tree, its entry-list file included. */
  readonly layout: ResourceLayout<TEntry>;
  /** The definition an entry of the entry-list file gives, and the keys it was written with that the schema does not know. */
  fromEntry(entry: TEntry): { readonly definition: E; readonly unknownKeys: readonly string[] };
  /** What the type makes of the folder `name` at `full` (`path` from the team root), in the root (`namespace` null) or the namespace directory `namespace`. */
  readFolder(folder: { readonly name: string; readonly full: string; readonly path: string; readonly namespace: string | null }): Promise<PlaceFolderRead<E>>;
  scopeOf(definition: E): EntryScopeKeys;
}

/** One definition a place holds: the item the resolver found, what the type made of it, and the keys it was written with that its schema does not know. */
export interface PlacedDefinition<TEntry, E> {
  readonly item: TeamItem<TEntry>;
  readonly definition: E;
  readonly unknownKeys: readonly string[];
}

/** What a place read tells the team: how the resolver read its layout, or a folder the type skips, at `path`. */
export interface PlaceNote {
  readonly kind: 'layout' | 'skipped';
  readonly path: string;
  readonly message: string;
}

/** One place read: its definitions in scan order and what to tell the team, or the file or folder that stops the type, and why. */
export type LayeredPlaceRead<TEntry, E> =
  | { readonly ok: true; readonly definitions: ReadonlyArray<PlacedDefinition<TEntry, E>>; readonly notes: readonly PlaceNote[] }
  | { readonly ok: false; readonly source: string; readonly reason: string };

/** A folder marker's YAML (at `markerPath`) read by the type's `schema`, with the keys it has that `schema` does not know, or why it does not parse. */
export function parseMarker<TSchema extends z.ZodObject>(
  content: string,
  markerPath: string,
  schema: TSchema,
): { readonly ok: true; readonly fields: z.output<TSchema>; readonly unknownKeys: readonly string[] } | { readonly ok: false; readonly reason: string } {
  try {
    const raw: JsonValue = parseYaml(content);
    const parsed = schema.safeParse(raw);

    if (!parsed.success) {
      return { ok: false, reason: `${markerPath} does not parse: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}` };
    }

    const known = Object.keys(schema.shape);

    return { ok: true, fields: parsed.data, unknownKeys: isJsonObject(raw) ? Object.keys(raw).filter((key) => !known.includes(key)) : [] };
  } catch (e) {
    return { ok: false, reason: `${markerPath} does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A folder of a type delivered whole (hooks, MCP; #1787): its marker's fields and every file, the files that keep it from being delivered, or why its marker does not parse. */
export type MarkerFolderRead<T> =
  | { readonly kind: 'read'; readonly fields: T; readonly unknownKeys: readonly string[]; readonly files: readonly FolderFile[] }
  | { readonly kind: 'undeliverable'; readonly problems: readonly string[] }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Read the folder at `folder.full` (`folder.path` from the team root, ending in `/`), whose `marker` the type's `schema` reads. */
export async function readMarkerFolder<TSchema extends z.ZodObject>(
  folder: { readonly full: string; readonly path: string },
  marker: string,
  schema: TSchema,
): Promise<MarkerFolderRead<z.output<TSchema>>> {
  const read = await FolderFiles.read(folder.full);

  if (read.kind === 'invalid') return { kind: 'undeliverable', problems: read.problems.map(FolderFiles.describe) };
  const parsed = parseMarker(read.files.find((file) => file.path === marker)?.bytes.toString('utf8') ?? '', `${folder.path}${marker}`, schema);

  return parsed.ok ? { kind: 'read', fields: parsed.fields, unknownKeys: parsed.unknownKeys, files: read.files } : { kind: 'invalid', reason: parsed.reason };
}

/**
 * The root (`namespace` null) or the namespace directory `namespace` of `type` in the team tree at `root`, as pull reads
 * it. An invalid file or folder stops the place; the resolver's notes and each skipped folder's note are its notes.
 */
async function readPlace<TEntry, E>(type: LayeredEntryType<TEntry, E>, at: { readonly root: string; readonly namespace: string | null }): Promise<LayeredPlaceRead<TEntry, E>> {
  const { items, diagnostics } = await Resources.layer(type.layout, at);
  const invalid = diagnostics.find((diagnostic) => diagnostic.kind === 'invalid');

  if (invalid) return { ok: false, source: invalid.path, reason: invalid.message };
  const notes: PlaceNote[] = diagnostics.map(({ path: notePath, message }) => ({ kind: 'layout', path: notePath, message }));
  const definitions: Array<PlacedDefinition<TEntry, E>> = [];

  for (const item of items) {
    const { source } = item;

    switch (source.kind) {
      case 'file':
        break;
      case 'entry':
        definitions.push({ item, ...type.fromEntry(source.entry) });
        break;

      case 'folder': {
        const read = await type.readFolder({ name: item.name, full: source.full, path: source.path, namespace: at.namespace });

        switch (read.kind) {
          case 'read':
            definitions.push({ item, definition: read.definition, unknownKeys: read.unknownKeys });
            break;
          case 'skipped':
            if (read.note !== null) notes.push({ kind: 'skipped', path: source.path, message: read.note });
            break;
          case 'invalid':
            return { ok: false, source: source.path, reason: read.reason };
          default: {
            const unhandled: never = read;

            return unhandled;
          }
        }

        break;
      }

      default: {
        const unhandled: never = source;

        return unhandled;
      }
    }
  }

  return { ok: true, definitions, notes };
}

/** `type`'s definitions this member receives: its active namespaces, then each place; a workspace with children unions its members' (#913). */
async function resolve<TEntry, E>(type: LayeredEntryType<TEntry, E>, localConfig: LocalConfig): Promise<EntryResolution<E>> {
  const namespaces = await activeEntryNamespaces(localConfig, entryLayout(type.type));

  if (!namespaces.ok) return { kind: 'failed', failure: namespaces.failure, notices: [] };
  const members = await deliveredMembers(localConfig);

  if (members) return resolveWorkspaceEntries({ type: type.type }, localConfig, members, (member) => resolve(type, member));

  return resolveScope(type, localConfig, namespaces.active);
}

/** `type`'s definitions in one scope's team tree, the root and each of the `active` namespaces (null in legacy mode). */
async function resolveScope<TEntry, E>(type: LayeredEntryType<TEntry, E>, localConfig: LocalConfig, active: readonly string[] | null): Promise<EntryResolution<E>> {
  const layout = entryLayout(type.type);
  const repoPath = localConfig.repo.localPath;
  const notices: EntryNotice[] = [];
  const targets = new TargetFiles(repoPath, layout);

  const dirs = active && active.length > 0 ? await listDirs(path.join(repoPath, layout.dir)) : [];

  const candidates: Array<NamespaceCandidate<E>> = [];
  // Entries still scoped by the deprecated per-entry `roles:`.
  const roleScoped = new Set<NamespaceCandidate<E>>();

  for (const namespace of [null, ...(active ?? [])]) {
    const read = await readPlace(type, { root: repoPath, namespace: namespace === null ? null : namespaceDir(dirs, namespace) });

    if (!read.ok) return { kind: 'failed', failure: { kind: 'broken-file', type: type.type, source: read.source, reason: read.reason, layout }, notices };

    for (const { message } of read.notes) notices.push({ kind: 'file-note', message });

    for (const { item, definition, unknownKeys } of read.definitions) {
      const scope = type.scopeOf(definition);

      if (!await keepScopedEntry(type.type, layout.noun, item.name, item.source.path, scope, unknownKeys, localConfig, targets, notices)) continue;
      const candidate = { name: item.name, source: item.source.path, namespace, value: definition };
      candidates.push(candidate);

      if (scope.roles !== undefined) roleScoped.add(candidate);
    }
  }

  const repeated = repeatedNames(
    candidates.filter((candidate) => candidate.namespace === null),
    (candidate) => candidate.name,
    (candidate) => candidate.source,
  ).map(([name]) => name);

  if (active === null) {
    // Legacy mode lets a file repeat a name, as before; a name in a file and as a folder is a duplicate (#1787).
    const twice = repeatedNames(candidates, (candidate) => candidate.name, (candidate) => candidate.source)
      .find(([, sources]) => new Set(sources).size > 1);

    if (twice) {
      const [name, sources] = twice;
      const [first = '', second = ''] = new Set(sources);

      return { kind: 'failed', failure: { kind: 'duplicate', type: type.type, name, source: first, second, layout }, notices };
    }

    return {
      kind: 'resolved',
      entries: candidates.map((c) => ({
        entry: c.value, name: c.name, namespace: null, source: c.source, replaces: null, replacedEntry: null,
      })),
      active,
      notices,
      repeated,
    };
  }

  // During the `roles:` deprecation window a file may repeat a name under
  // different `roles:`, as 0.25.0 allowed: every copy that passes the role
  // filter is delivered, as then (MCP keeps the last one). The resolver sees
  // one copy of such a name; a name repeated without `roles:` on every copy
  // is a duplicate.
  const copies = new Map<string, Array<NamespaceCandidate<E>>>();

  for (const candidate of candidates) {
    const key = `${candidate.source}\0${candidate.name}`;
    copies.set(key, [...(copies.get(key) ?? []), candidate]);
  }

  const repeatedUnderRoles = new Map<E, Array<NamespaceCandidate<E>>>();
  const laterCopies = new Set<NamespaceCandidate<E>>();

  for (const group of copies.values()) {
    const [first, ...rest] = group;

    if (!first || rest.length === 0 || !group.every((copy) => roleScoped.has(copy))) continue;
    repeatedUnderRoles.set(first.value, group);

    for (const copy of rest) laterCopies.add(copy);
  }

  // In the order the places are read, root first: hooks on one event run in the order they are listed, and a namespace
  // entry takes the place of the root entry it replaces.
  const picked = Resources.pick(candidates.filter((candidate) => !laterCopies.has(candidate)), active);
  const conflict = firstConflict(picked.flatMap((name) => (name.kind === 'conflict' ? [name] : [])), active);

  if (conflict) {
    const failure: EntryFailure = conflict.reason === 'duplicate'
      ? { kind: 'duplicate', type: type.type, name: conflict.name, source: conflict.first.source, second: conflict.second.source, layout }
      : { kind: 'two-namespaces', type: type.type, name: conflict.name, first: conflict.first.source, second: conflict.second.source, layout };

    return { kind: 'failed', failure, notices };
  }

  return {
    kind: 'resolved',
    entries: picked.flatMap((name) => (name.kind === 'resolved' ? (repeatedUnderRoles.get(name.item.value) ?? [name.item]).map((copy) => ({
      entry: copy.value,
      name: name.item.name,
      namespace: name.item.namespace,
      source: name.item.source,
      replaces: name.item.replaces?.source ?? null,
      replacedEntry: name.item.replaces?.value ?? null,
    })) : [])),
    active,
    notices,
    repeated,
  };
}

export const LayeredEntries = { resolve, readPlace } as const;

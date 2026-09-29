/**
 * Env variables, hooks, MCP servers and team model profiles by namespace (#707).
 *
 *   <type>/<type>.yaml         root, shared
 *   <type>/<ns>/<type>.yaml    read only where <ns> is active in resources.<type>
 *
 * Each file is a list of named entries. An active namespace entry replaces the
 * root entry of the same name, whole; the rule itself is `namespace-resolver`.
 * This module adds what is particular to list files: reading them, the failure
 * policy, and the per-entry `roles:` / `projects:` keys the namespaces replace.
 *
 * Failure policy: a file in the active set that does not parse, a name twice in
 * one file, or a name in two active namespaces stops the type for this run.
 * The caller keeps what is installed rather than reconciling to an empty set.
 * While `roles:` is deprecated, a name repeated with `roles:` on every copy is
 * delivered as 0.25.0 did.
 *
 * Legacy mode (no roles, no projects) reads the root file only, as before, and
 * keeps its old handling of a repeated name; doctor lists those as info.
 */
import path from 'node:path';
import { describeOverride, repeatedNames, resolveNamespacedItems, type NamespaceCandidate } from './namespace-resolver.js';
import { resolveResourceNamespaces } from './resource-namespaces.js';
import { activeRoleIds, findRole, loadRolesManifestIfPresent } from './roles.js';
import { findProject, loadProjectsManifest, unknownProjectMessage } from './projects.js';
import { caseFoldKey, isSafeNamespaceSegment, NAMESPACE_RULE } from './manifest-schema.js';
import type { LocalConfig } from './types.js';
import { listDirs, pathExists, readFileIfExists } from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';

export type EntryType = 'env' | 'hooks' | 'mcp' | 'models';

const ENTRY_FILE: Record<EntryType, string> = { env: 'env.yaml', hooks: 'hooks.yaml', mcp: 'mcp.yaml', models: 'models.yaml' };

/** What one entry is called, for messages. */
export const ENTRY_NOUN: Record<EntryType, string> = { env: 'variable', hooks: 'hook', mcp: 'server', models: 'profile' };

/** What a failure leaves unchanged, for messages. */
const INSTALLED: Record<EntryType, string> = {
  env: 'exported env variables',
  hooks: 'installed team hooks',
  mcp: 'installed team MCP servers',
  models: 'agent model settings',
};

/** Repo-relative (`/`-separated) path of a type's file in the root (`null`) or a namespace. */
export function entryFilePath(type: EntryType, namespace: string | null): string {
  return namespace === null ? `${type}/${ENTRY_FILE[type]}` : `${type}/${namespace}/${ENTRY_FILE[type]}`;
}

/** `entryFilePath` under a checkout. */
export function entryFileAbsolutePath(repoPath: string, type: EntryType, namespace: string | null): string {
  return path.join(repoPath, ...entryFilePath(type, namespace).split('/'));
}

/** One of a type's files that exists in a checkout. */
export interface EntryFile {
  /** null for the root file. */
  readonly namespace: string | null;
  readonly relativePath: string;
  readonly absolutePath: string;
}

/**
 * Every file of `type` in a checkout, active here or not: the root file, then
 * each `<type>/<ns>/` file in name order. Absent files are left out.
 */
export async function listEntryFiles(repoPath: string, type: EntryType): Promise<EntryFile[]> {
  const namespaces = (await listDirs(path.join(repoPath, type))).sort();
  const files: EntryFile[] = [];
  for (const namespace of [null, ...namespaces]) {
    const absolutePath = entryFileAbsolutePath(repoPath, type, namespace);
    if (await pathExists(absolutePath)) files.push({ namespace, relativePath: entryFilePath(type, namespace), absolutePath });
  }
  return files;
}

/** One parsed file, or why it cannot be used; the reason names the file. */
export type EntryFileRead<E> =
  | {
    readonly ok: true;
    readonly entries: readonly E[];
    readonly notes?: readonly string[];
    /** The keys an entry carries that its schema does not know, for the entries that carry any. */
    readonly unknownKeys?: ReadonlyMap<E, readonly string[]>;
  }
  | { readonly ok: false; readonly reason: string };

/** The per-entry scoping keys the namespaces replace. */
export interface EntryScopeKeys {
  readonly roles?: readonly string[];
  readonly projects?: readonly string[];
}

/** The list under `listKey` of a parsed file, as written, before its schema drops any key. */
export function writtenList(document: unknown, listKey: string): unknown {
  if (document === null || typeof document !== 'object') return undefined;
  const fields: [string, unknown][] = Object.entries(document);
  return fields.find(([key]) => key === listKey)?.[1];
}

/**
 * The keys each entry was written with that `schema` does not know, for the
 * entries that have any. zod drops such a key without a word, so a misspelled
 * `roles:` would send the entry to every member (#822). `entries` is the
 * `listKey` list of `document`, parsed, in the same order.
 */
export function unknownEntryKeys<E>(
  document: unknown,
  listKey: string,
  entries: readonly E[],
  schema: { readonly shape: object },
): Map<E, string[]> {
  const byEntry = new Map<E, string[]>();
  const raw = writtenList(document, listKey);
  if (!Array.isArray(raw)) return byEntry;
  const known = Object.keys(schema.shape);
  entries.forEach((entry, index) => {
    const written: unknown = raw[index];
    if (written === null || typeof written !== 'object') return;
    const unknown = Object.keys(written).filter((key) => !known.includes(key));
    if (unknown.length > 0) byEntry.set(entry, unknown);
  });
  return byEntry;
}

/**
 * Why a file that has none of its schema's top-level keys cannot be read, or
 * null when it has one (or is not a non-empty mapping). zod defaults the
 * missing list to empty and drops the key it does not know, so `server:` for
 * `servers:` read as "no entries" and removed every installed one (#822). An
 * extra key beside a known one stays permitted, as for env.yaml (#662).
 */
export function missingTopLevelKeyReason(document: unknown, schema: { readonly shape: object }): string | null {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return null;
  const found = Object.keys(document);
  const expected = Object.keys(schema.shape);
  if (found.length === 0 || found.some((key) => expected.includes(key))) return null;
  const quote = (keys: string[], suffix = ''): string => keys.map((key) => `\`${key}${suffix}\``).join(', ');
  return `it has no top-level ${quote(expected, ':').replace(/, (?=[^,]*$)/, ' or ')} key, only ${quote(found)}`;
}

/** How one type's files are read. */
/**
 * The text of one type file, null when it does not exist. Any other read error
 * (a permission, a directory on the name) is the file's problem, not its
 * absence: taking it for absent would deliver the root entry in place of an
 * override.
 */
export async function readEntryFileText(
  absolutePath: string,
  relativePath: string,
): Promise<{ ok: true; text: string | null } | { ok: false; reason: string }> {
  try {
    return { ok: true, text: await readFileIfExists(absolutePath) };
  } catch (error) {
    return { ok: false, reason: `${relativePath} cannot be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface EntryReader<E> {
  readonly type: EntryType;
  /** null when the file does not exist. */
  read(absolutePath: string, relativePath: string): Promise<EntryFileRead<E> | null>;
  nameOf(entry: E): string;
  scopeOf(entry: E): EntryScopeKeys;
}

export interface ResolvedEntry<E> {
  readonly entry: E;
  readonly name: string;
  /** null for the root file. */
  readonly namespace: string | null;
  /** Repo-relative file the entry comes from. */
  readonly source: string;
  /** Repo-relative root file whose entry of the same name this one replaces. */
  readonly replaces: string | null;
  /** The root entry this one replaces. */
  readonly replacedEntry: E | null;
}

/** Why a type was not applied this run. */
export type EntryFailure =
  | { readonly kind: 'broken-file'; readonly type: EntryType; readonly source: string; readonly reason: string }
  | { readonly kind: 'duplicate'; readonly type: EntryType; readonly name: string; readonly source: string }
  | {
    readonly kind: 'two-namespaces';
    readonly type: EntryType;
    readonly name: string;
    readonly first: string;
    readonly second: string;
  }
  | { readonly kind: 'namespaces-unresolved'; readonly type: EntryType; readonly reason: string };

/** A warning about an entry that still resolves, worded for the admin who can fix it. */
export interface EntryNotice {
  readonly kind: 'unknown-key' | 'removed-key' | 'deprecated-roles' | 'file-note';
  readonly message: string;
}

export type EntryResolution<E> =
  | {
    readonly kind: 'resolved';
    readonly entries: readonly ResolvedEntry<E>[];
    /** null in legacy mode, which reads the root file alone. */
    readonly active: readonly string[] | null;
    readonly notices: readonly EntryNotice[];
    /** Names repeated in the root file; only legacy mode lets one through. */
    readonly repeated: readonly string[];
  }
  | { readonly kind: 'failed'; readonly failure: EntryFailure; readonly notices: readonly EntryNotice[] };

/**
 * The active namespaces of `type` for this member, or null in legacy mode.
 * A manifest that exists and does not load is a failure, never legacy mode:
 * that would deliver the root alone and drop every namespace entry.
 */
export async function activeEntryNamespaces(
  localConfig: LocalConfig,
  type: EntryType,
): Promise<{ ok: true; active: string[] | null } | { ok: false; failure: EntryFailure }> {
  try {
    const resolved = await resolveResourceNamespaces(localConfig);
    return { ok: true, active: resolved ? resolved.activeNamespaces[type] ?? [] : null };
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'namespaces-unresolved', type, reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * The directory under `<type>/` that holds `namespace`. A declared namespace
 * names its directory case-folded, as docs does, so a `<type>/Checkout/` is
 * `checkout` on every filesystem, not only the case-insensitive ones. An exact
 * match wins on one that has both; with neither, the name itself.
 */
function namespaceDir(dirs: readonly string[], namespace: string): string {
  return dirs.includes(namespace)
    ? namespace
    : dirs.find((dir) => caseFoldKey(dir) === caseFoldKey(namespace)) ?? namespace;
}

/**
 * Read the root file and every active namespace file of one type, and resolve
 * them into the entries this member receives.
 */
export async function resolveEntries<E>(
  reader: EntryReader<E>,
  localConfig: LocalConfig,
  active: readonly string[] | null,
): Promise<EntryResolution<E>> {
  const { type } = reader;
  const repoPath = localConfig.repo.localPath;
  const places: (string | null)[] = [null, ...(active ?? [])];
  const notices: EntryNotice[] = [];
  const targets = new TargetFiles(repoPath, type);

  const dirs = active && active.length > 0 ? await listDirs(path.join(repoPath, type)) : [];

  const candidates: NamespaceCandidate<E>[] = [];
  // Entries still scoped by the deprecated per-entry `roles:`.
  const roleScoped = new Set<NamespaceCandidate<E>>();
  for (const namespace of places) {
    const dir = namespace === null ? null : namespaceDir(dirs, namespace);
    const source = entryFilePath(type, dir);
    const read = await reader.read(entryFileAbsolutePath(repoPath, type, dir), source);
    if (read === null) continue;
    if (!read.ok) return { kind: 'failed', failure: { kind: 'broken-file', type, source, reason: read.reason }, notices };
    for (const note of read.notes ?? []) notices.push({ kind: 'file-note', message: note });

    for (const entry of read.entries) {
      const name = reader.nameOf(entry);
      const scope = reader.scopeOf(entry);
      const unknownKeys = read.unknownKeys?.get(entry) ?? [];
      if (!await keepScopedEntry(type, name, source, scope, unknownKeys, localConfig, targets, notices)) continue;
      const candidate = { name, source, namespace, value: entry };
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
  const copies = new Map<string, NamespaceCandidate<E>[]>();
  for (const candidate of candidates) {
    const key = `${candidate.source}\0${candidate.name}`;
    copies.set(key, [...(copies.get(key) ?? []), candidate]);
  }
  const repeatedUnderRoles = new Map<E, NamespaceCandidate<E>[]>();
  const laterCopies = new Set<NamespaceCandidate<E>>();
  for (const group of copies.values()) {
    const [first, ...rest] = group;
    if (!first || rest.length === 0 || !group.every((copy) => roleScoped.has(copy))) continue;
    repeatedUnderRoles.set(first.value, group);
    for (const copy of rest) laterCopies.add(copy);
  }

  const resolution = resolveNamespacedItems(candidates.filter((candidate) => !laterCopies.has(candidate)), active);
  if (resolution.kind === 'conflict') {
    const failure: EntryFailure = resolution.reason === 'duplicate'
      ? { kind: 'duplicate', type, name: resolution.name, source: resolution.first.source }
      : { kind: 'two-namespaces', type, name: resolution.name, first: resolution.first.source, second: resolution.second.source };
    return { kind: 'failed', failure, notices };
  }

  // File order, not the resolver's name order: hooks on one event run in the
  // order they are listed. A namespace entry takes the place of the root entry
  // it replaces; the other namespace entries follow, in `active` order.
  const firstSeen = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    if (!firstSeen.has(candidate.name)) firstSeen.set(candidate.name, index);
  });
  const position = (name: string): number => firstSeen.get(name) ?? candidates.length;
  const items = [...resolution.items].sort((a, b) => position(a.name) - position(b.name));

  return {
    kind: 'resolved',
    entries: items.flatMap((item) => (repeatedUnderRoles.get(item.value) ?? [item]).map((copy) => ({
      entry: copy.value,
      name: item.name,
      namespace: item.namespace,
      source: item.source,
      replaces: item.replaces?.source ?? null,
      replacedEntry: item.replaces?.value ?? null,
    }))),
    active,
    notices,
    repeated,
  };
}

/** Resolve one type for this member: active namespaces, then the files. */
export async function resolveEntriesFor<E>(
  reader: EntryReader<E>,
  localConfig: LocalConfig,
): Promise<EntryResolution<E>> {
  const namespaces = await activeEntryNamespaces(localConfig, reader.type);
  if (!namespaces.ok) return { kind: 'failed', failure: namespaces.failure, notices: [] };
  return resolveEntries(reader, localConfig, namespaces.active);
}

/**
 * Whether an entry's per-entry keys let it through, recording a notice when it
 * carries one.
 *
 * A key the schema does not know (`unknownKeys`) may be a misspelled scoping
 * key, so such an entry is not delivered, as with a removed key.
 *
 * `projects:` (every type) and `roles:` on env exist only in the 0.26.0 betas
 * and are removed: such an entry reaches nobody, which is the direction that
 * cannot leak a project's value to the whole team. `roles:` on hooks and MCP
 * shipped in 0.25.0 and keeps filtering for one minor release.
 */
async function keepScopedEntry(
  type: EntryType,
  name: string,
  source: string,
  scope: EntryScopeKeys,
  unknownKeys: readonly string[],
  localConfig: LocalConfig,
  targets: TargetFiles,
  notices: EntryNotice[],
): Promise<boolean> {
  const label = `${source}: ${ENTRY_NOUN[type]} "${name}"`;
  if (unknownKeys.length > 0) {
    const one = unknownKeys.length === 1;
    const keys = unknownKeys.map((key) => `\`${key}:\``).join(', ');
    notices.push({
      kind: 'unknown-key',
      message: `${label} has unknown ${one ? 'key' : 'keys'} ${keys}, so this entry is not delivered. `
        + `Correct the ${one ? 'key' : 'keys'} or remove ${one ? 'it' : 'them'}.`,
    });
    return false;
  }

  const removedKeys: ('projects' | 'roles')[] = [];
  if (scope.projects !== undefined) removedKeys.push('projects');
  if (type === 'env' && scope.roles !== undefined) removedKeys.push('roles');
  if (removedKeys.length > 0) {
    const files: string[] = [];
    for (const key of removedKeys) files.push(...await targets.forIds(key, scope[key] ?? []));
    notices.push({
      kind: 'removed-key',
      message: `${label} is scoped with per-entry ${removedKeys.map((key) => `\`${key}:\``).join(' and ')}, `
        + 'which this version no longer reads, so it reaches nobody. '
        + moveTo(files),
    });
    return false;
  }

  if (scope.roles === undefined) return true;
  notices.push({
    kind: 'deprecated-roles',
    message: `${label} is scoped with per-entry \`roles:\`, which is deprecated and stops working in the next `
      + `minor release. ${moveTo(await targets.forIds('roles', scope.roles))}`,
  });
  // The 0.25.0 rule: no role configured matches everything; otherwise share one.
  const roles = activeRoleIds(localConfig);
  return roles === null || scope.roles.some((role) => roles.includes(role));
}

/**
 * Where an entry carrying a removed per-entry key belongs: the namespace files
 * its listed ids declare, or the removal. Shared with the write path (`env
 * add`), whose remediation has to name the same file — telling a user to drop
 * a root-scoped key where it sits would deliver the value to the whole team.
 */
export function moveTo(files: readonly string[]): string {
  if (files.length === 0) return 'It lists no id: remove it, or move it to the namespace file it is meant for.';
  if (files.length === 1) return `Move it to ${files[0]} and drop the key.`;
  return `Copy it into each of ${files.join(', ')} and drop the key.`;
}
/**
 * The namespace files an id's entries belong in: the namespaces its role or
 * project declares for the type, or `<type>/<id>/` with the declaration to add
 * when it declares none. The manifests are read at most once, and only when an
 * entry carries a per-entry key.
 */
export class TargetFiles {
  private roles: ReturnType<typeof loadRolesManifestIfPresent> | null = null;
  private projects: ReturnType<typeof loadProjectsManifest> | null = null;

  constructor(private readonly repoPath: string, private readonly type: EntryType) {}

  async forIds(axis: 'roles' | 'projects', ids: readonly string[]): Promise<string[]> {
    const files: string[] = [];
    for (const id of ids) {
      const declared = await this.declared(axis, id);
      if (declared.length > 0) {
        files.push(...declared.map((namespace) => entryFilePath(this.type, namespace)));
      } else {
        const owner = axis === 'roles' ? `role ${id}` : `project ${id}`;
        files.push(`${entryFilePath(this.type, id)} (declare ${this.type}: [${id}] for ${owner} in manifest/${axis}.yaml)`);
      }
    }
    return [...new Set(files)];
  }

  private async declared(axis: 'roles' | 'projects', id: string): Promise<string[]> {
    try {
      if (axis === 'roles') {
        this.roles ??= loadRolesManifestIfPresent(this.repoPath);
        const manifest = await this.roles;
        return (manifest ? findRole(manifest, id)?.resources[this.type] : undefined) ?? [];
      }
      this.projects ??= loadProjectsManifest(this.repoPath);
      const manifest = await this.projects;
      return (manifest ? findProject(manifest, id)?.resources[this.type] : undefined) ?? [];
    } catch {
      // A manifest that does not load names no namespace; the fallback path
      // still tells the admin where the entry goes.
      return [];
    }
  }
}

/**
 * Whether a role or project lists `namespace` under `resources.<type>`, compared
 * case-folded as the namespace directories are. Null when a manifest does not
 * load: the command that uses the answer reports nothing it cannot know.
 */
async function isDeclaredNamespace(repoPath: string, type: EntryType, namespace: string): Promise<boolean | null> {
  try {
    const [roles, projects] = await Promise.all([loadRolesManifestIfPresent(repoPath), loadProjectsManifest(repoPath)]);
    const key = caseFoldKey(namespace);
    return [...(roles?.roles ?? []), ...(projects?.projects ?? [])]
      .some((owner) => (owner.resources[type] ?? []).some((declared) => caseFoldKey(declared) === key));
  } catch {
    return null;
  }
}

/** The failure as one actionable line: what happened, what it left alone, what to do. */
export function describeEntryFailure(failure: EntryFailure): string {
  const kept = `${failure.type} was not applied this run, so your ${INSTALLED[failure.type]} are unchanged.`;
  const noun = ENTRY_NOUN[failure.type];
  switch (failure.kind) {
    case 'broken-file':
      // The reader's reason already names the file.
      return `${failure.reason.trimEnd().replace(/\.$/, '')}. ${kept} Fix the file in the team repo and push.`;
    case 'duplicate':
      return `${failure.source} defines ${noun} "${failure.name}" more than once. ${kept} `
        + 'Keep one of them in the team repo and push.';
    case 'two-namespaces':
      return `${noun} "${failure.name}" is defined in both ${failure.first} and ${failure.second}, and both namespaces `
        + `are active here, so nothing says which one you should receive. ${kept} Rename or remove it in one of `
        + 'the files, or stop declaring one of the namespaces for your roles and projects.';
    case 'namespaces-unresolved':
      return `Your ${failure.type} namespaces could not be resolved: ${failure.reason}. ${kept} `
        + 'Fix the manifest in the team repo and push.';
    default: {
      const unhandled: never = failure;
      return String(unhandled);
    }
  }
}

/**
 * Warn about a failure and the notices, each once per run (a pull resolves
 * each type more than once). Also written to debug.log, because a
 * SessionStart pull runs silent and a failure here is what keeps a member on
 * stale entries.
 */
export function reportEntryResolution(resolution: EntryResolution<unknown>): void {
  reportNotices(resolution.notices);
  if (resolution.kind === 'failed') {
    const message = describeEntryFailure(resolution.failure);
    if (warnOnce(message)) log.persist(message);
  }
}

/** List/status report only entries omitted from delivery; pull reports every notice. */
export function reportUndeliveredEntryNotices(resolution: Pick<EntryResolution<unknown>, 'notices'>): void {
  reportNotices(resolution.notices.filter((notice) => notice.kind === 'unknown-key' || notice.kind === 'removed-key'));
}

function reportNotices(notices: readonly EntryNotice[]): void {
  for (const notice of notices) {
    if (warnOnce(notice.message)) log.persist(notice.message);
  }
}

/** Where an entry comes from, for the list commands, `status` and `doctor`. */
export function describeOrigin(entry: ResolvedEntry<unknown>): string {
  if (entry.namespace === null) return 'root';
  return entry.replaces ? `${entry.namespace}, overrides root` : entry.namespace;
}

/** `2 root, 1 checkout`: how many resolved entries each place contributes, root first. */
export function describeOrigins(entries: readonly ResolvedEntry<unknown>[]): string {
  const byPlace = new Map<string, number>();
  for (const entry of entries) {
    const place = entry.namespace ?? 'root';
    byPlace.set(place, (byPlace.get(place) ?? 0) + 1);
  }
  return [...byPlace]
    .sort(([a], [b]) => Number(b === 'root') - Number(a === 'root'))
    .map(([place, n]) => `${n} ${place}`)
    .join(', ');
}

/**
 * Info lines for `doctor`: where a type's entries come from when a namespace
 * contributes any, each override, and in legacy mode each name the root file
 * repeats. None is a problem, so none is a failing check.
 */
export function describeEntryNotes(type: EntryType, resolution: EntryResolution<unknown>): string[] {
  if (resolution.kind !== 'resolved') return [];
  const lines = resolution.entries.some((entry) => entry.namespace !== null)
    ? [`${type}: ${resolution.entries.length} received here (${describeOrigins(resolution.entries)})`]
    : [];
  for (const entry of resolution.entries) {
    if (entry.replaces) lines.push(describeOverride(type, { name: entry.name, source: entry.source, replaces: entry.replaces }));
  }
  if (resolution.active === null) {
    for (const name of resolution.repeated) {
      lines.push(`${type}: "${name}" is defined more than once in ${entryFilePath(type, null)} (legacy mode does not check this; keep one of them)`);
    }
  }
  return lines;
}

/**
 * The namespace `--role <ns>` or `--project <id>` points a write at, or null
 * for the root file when neither is given. `--role` names the namespace itself,
 * as it does for `push`; `--project` is looked up in that project's own
 * `resources.<type>`. The namespace is spelled as its existing directory is,
 * which is the file pull reads. Phrased for the CLI user on failure. `--role`
 * warns when no role or project declares the namespace: its file would reach
 * nobody.
 */
export async function entryNamespaceFromFlags(
  repoPath: string,
  type: EntryType,
  flags: { role?: string; project?: string },
): Promise<{ ok: true; namespace: string | null } | { ok: false; message: string }> {
  if (flags.role !== undefined && flags.project !== undefined) {
    return { ok: false, message: 'Use either --role or --project, not both.' };
  }
  if (flags.role !== undefined) {
    if (!isSafeNamespaceSegment(flags.role)) {
      return { ok: false, message: `Invalid --role "${flags.role}": ${NAMESPACE_RULE}.` };
    }
    if (await isDeclaredNamespace(repoPath, type, flags.role) === false) {
      log.warn(
        `No role or project declares ${type} namespace "${flags.role}", so ${entryFilePath(type, flags.role)} reaches nobody. `
        + `Add \`${type}: [${flags.role}]\` to the resources of a role in manifest/roles.yaml or of a project in `
        + 'manifest/projects.yaml.',
      );
    }
    return { ok: true, namespace: namespaceDir(await listDirs(path.join(repoPath, type)), flags.role) };
  }
  if (flags.project === undefined) return { ok: true, namespace: null };

  let manifest: Awaited<ReturnType<typeof loadProjectsManifest>>;
  try {
    manifest = await loadProjectsManifest(repoPath);
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)} Fix it, or pass --role <ns>.` };
  }
  if (!manifest) return { ok: false, message: 'This team repo defines no projects (no manifest/projects.yaml). Pass --role <ns>.' };
  const project = findProject(manifest, flags.project);
  if (!project) return { ok: false, message: unknownProjectMessage(manifest, flags.project) };
  const namespaces = project.resources[type] ?? [];
  if (namespaces.length === 1 && namespaces[0] !== undefined) {
    return { ok: true, namespace: namespaceDir(await listDirs(path.join(repoPath, type)), namespaces[0]) };
  }
  return {
    ok: false,
    message: namespaces.length === 0
      ? `Project "${flags.project}" declares no ${type} namespace. Add \`${type}: [<ns>]\` to its resources in `
        + 'manifest/projects.yaml, or pass --role <ns>.'
      : `Project "${flags.project}" maps ${type} to several namespaces (${namespaces.join(', ')}); pass --role <ns> to pick one.`,
  };
}

import path from 'node:path';
import { z } from 'zod';
import { parseYaml } from '@teamai/shared/yaml';
import { ResourceHandler } from './base.js';
import type { HookDef, LocalConfig, ResourceItem, TeamaiConfig } from '../types.js';
import type { JsonValue } from '@teamai/shared/json';
import { TEAMAI_CUSTOM_HOOK_PREFIX, areTeamHooksDisabled, getHooksSharing, isSelfMode } from '../types.js';
import { pathExists } from '../utils/fs.js';
import { log } from '@teamai/shared/log';
import { warnOnce } from '../utils/warn-once.js';
import { pushRepoResourceItem, scanRepoResourceForPush } from './repo-resource.js';
import {
  entryFilePath, missingTopLevelKeyReason, readEntryFileText, reportEntryResolution, unknownEntryKeys, type EntryResolution, type ResolvedEntry,
} from '../namespaced-entries.js';
import { LayeredEntries, parseMarker, readMarkerFolder, type LayeredEntryType, type PlaceFolderRead } from './layered-entries.js';
import { RESOURCE_LAYOUTS, Resources, type EntryListRead, type ResourceLayout } from './resolver.js';
import { DeliveredFolders, type FolderDelivery } from './delivered-folders.js';
import { FolderFiles, type FolderFile, type FolderFilesRead } from './folder-files.js';
import { InheritedFolders, type Inheritance } from './inherited-folders.js';
import { getCurrentVersion } from '../package-info.js';
import { FOLDER_MARKERS } from '../folder-markers.js';
import { DefaultFolders, type DefaultFolderName } from '../default-folders.js';

// ─── Schema for hooks/hooks.yaml ────────────────────────────
//
//  Team-declared hooks. Event names use Claude PascalCase as the cross-tool
//  lingua franca; the reconcile engine maps to each tool's native format.

const TeamHookSchema = z.object({
  /** Unique id (marker + manifest index). */
  id: z.string().regex(RESOURCE_LAYOUTS.hooks.nameRule.pattern),
  /** Written into the hook description. */
  description: z.string(),
  /** Claude PascalCase event name. */
  event: z.string().min(1),
  /** Optional tool matcher (e.g. "Bash"). */
  matcher: z.string().optional(),
  /** Shell command to run. */
  command: z.string().min(1),
  /** Optional per-hook timeout in seconds. */
  timeout: z.number().optional(),
  /** Optional restriction to specific tools (default = all hook-capable tools). */
  tools: z.array(z.string()).optional(),
  /** Deprecated (0.25.0): members holding one of these role ids. Use hooks/<ns>/hooks.yaml. */
  roles: z.array(z.string()).optional(),
  /** Removed (0.26.0 betas only): kept so it is detected; such a hook reaches nobody. */
  projects: z.array(z.string()).optional(),
});

/** §4.8 team override of built-in (A) hooks. Whitelisted fields only. */
const BuiltinOverrideSchema = z
  .object({
    disabled: z.array(z.string()).default([]),
    overrides: z.record(z.string(), z.object({ timeout: z.number().optional() })).default({}),
  })
  .default({ disabled: [], overrides: {} });

export const HooksYamlSchema = z.object({
  hooks: z.array(TeamHookSchema).default([]),
  builtin: BuiltinOverrideSchema,
});

export type TeamHook = z.infer<typeof TeamHookSchema>;

/** `hooks/[<ns>/]<id>/HOOK.yaml`: a hooks.yaml entry without the id, which is the directory's name, and without roles or projects. */
const FolderHookSchema = TeamHookSchema.omit({ id: true, roles: true, projects: true });

/** A team hook as the team repo defines it. */
export type TeamHookDefinition =
  | { readonly kind: 'entry'; readonly hook: TeamHook }
  | TeamHookFolder;

/** A team hook folder: its `HOOK.yaml`, with the directory's name as id, the files pull delivers, `HOOK.yaml` included, and their version (`DeliveredFolders.identify`). */
export type TeamHookFolder = { readonly kind: 'folder'; readonly hook: TeamHook; readonly files: readonly FolderFile[]; readonly version: string };

export type HooksYaml = z.infer<typeof HooksYamlSchema>;

export type BuiltinOverride = z.infer<typeof BuiltinOverrideSchema>;

/** Absolute path of a team repo's hooks/hooks.yaml. */
export function teamHooksYamlPath(repoPath: string): string {
  return path.join(repoPath, 'hooks', 'hooks.yaml');
}

/** One hooks file, parsed, or why it cannot be used. */
type HooksFileRead =
  | { ok: true; yaml: HooksYaml; declaresBuiltin: boolean; unknownKeys: ReadonlyMap<TeamHook, readonly string[]> }
  | { ok: false; reason: string };

/** Parse one hooks file's text; `relativePath` names it in the reason. */
function parseHooksFile(content: string, relativePath: string): HooksFileRead {
  try {
    const raw: JsonValue = parseYaml(content);
    const topLevelProblem = missingTopLevelKeyReason(raw, HooksYamlSchema);

    if (topLevelProblem) return { ok: false, reason: `${relativePath} does not parse: ${topLevelProblem}` };
    const declaresBuiltin = raw instanceof Object && 'builtin' in raw;
    const yaml = HooksYamlSchema.parse(raw ?? {});

    return { ok: true, yaml, declaresBuiltin, unknownKeys: unknownEntryKeys(raw, 'hooks', yaml.hooks, TeamHookSchema) };
  } catch (e) {
    return { ok: false, reason: `${relativePath} does not parse: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Read one hooks file; null when it does not exist. */
async function readHooksFile(absolutePath: string, relativePath: string): Promise<HooksFileRead | null> {
  const file = await readEntryFileText(absolutePath, relativePath);

  if (!file.ok) return file;

  return file.text === null ? null : parseHooksFile(file.text, relativePath);
}

/** One entry of a hooks file, with the keys it was written with that the schema does not know. */
interface HooksFileEntry {
  readonly hook: TeamHook;
  readonly unknownKeys: readonly string[];
}

/**
 * A hooks file's entries for the resolver. The `builtin:` overrides are team-wide and read from the root file alone.
 * An entry naming `${TEAMAI_HOOK_DIR}` makes the file invalid: only a folder has a directory (#1787, common rule 8).
 */
function hooksFileEntries(content: string, relativePath: string): EntryListRead<HooksFileEntry> {
  const read = parseHooksFile(content, relativePath);

  if (!read.ok) return { kind: 'invalid', message: read.reason };
  const folderOnly = read.yaml.hooks.find((hook) => DeliveredFolders.mentions(hook.command, 'hooks'));

  if (folderOnly) {
    return {
      kind: 'invalid',
      message: `${relativePath}: hook "${folderOnly.id}" uses \${TEAMAI_HOOK_DIR}, which only a hook folder has. `
        + `Move it to hooks/${folderOnly.id}/HOOK.yaml, beside the files it runs.`,
    };
  }

  return {
    kind: 'entries',
    entries: read.yaml.hooks.map((hook) => ({ name: hook.id, entry: { hook, unknownKeys: read.unknownKeys.get(hook) ?? [] } })),
    notes: read.declaresBuiltin && relativePath !== entryFilePath('hooks', null)
      ? [`${relativePath}: \`builtin:\` is ignored outside hooks/hooks.yaml; built-in hook overrides apply to the whole team. Move it there.`]
      : [],
  };
}

/** Where team hooks live in a team tree: the entries of `hooks.yaml`, at the root and in each namespace. */
export const TEAM_HOOKS: ResourceLayout<HooksFileEntry> = {
  ...RESOURCE_LAYOUTS.hooks,
  entryList: { file: 'hooks.yaml', entries: hooksFileEntries },
};

/** The hooks one hooks file's text declares, or null when it does not parse: for reading a past revision. */
export function parseTeamHooks(content: string): TeamHook[] | null {
  try {
    const raw: JsonValue = parseYaml(content);

    if (missingTopLevelKeyReason(raw, HooksYamlSchema)) return null;

    return HooksYamlSchema.parse(raw ?? {}).hooks;
  } catch {
    return null;
  }
}

/** Read the hook folder at `full` (`folderPath` from the team root, ending in `/`), named `id`. */
export async function readHookFolder(full: string, folderPath: string, id: string): Promise<PlaceFolderRead<TeamHookFolder>> {
  const read = await readMarkerFolder({ full, path: folderPath }, RESOURCE_LAYOUTS.hooks.marker, FolderHookSchema);

  switch (read.kind) {
    case 'undeliverable':
      return { kind: 'invalid', reason: `${folderPath} is not a hook folder teamai can deliver: ${read.problems.join(', ')}` };
    case 'invalid':
      return read;
    case 'read': {
      const identity = await DeliveredFolders.identify(full, read.files);

      if (!identity.ok) return { kind: 'invalid', reason: `${folderPath} cannot be delivered: ${identity.reason}` };

      return { kind: 'read', definition: { kind: 'folder', hook: { ...read.fields, id }, files: identity.files, version: identity.version }, unknownKeys: read.unknownKeys };
    }

    default: {
      const unhandled: never = read;

      return unhandled;
    }
  }
}

/** How team hooks resolve for delivery: `hooks.yaml` entries and folders, in each place of the team tree, through the resolver. */
export const TEAM_HOOK_ENTRIES: LayeredEntryType<HooksFileEntry, TeamHookDefinition> = {
  type: 'hooks',
  layout: TEAM_HOOKS,
  fromEntry: ({ hook, unknownKeys }) => ({ definition: { kind: 'entry', hook }, unknownKeys }),
  readFolder: async ({ name, full, path: folderPath, namespace }) => {
    // A teamai- name only replaces a default (#1787, common rule 5), at the root, as builtin: overrides apply to the
    // whole team; defaultHookReplacements reads it there.
    if (DefaultFolders.isName('hooks', name)) {
      return { kind: 'skipped', note: namespace === null ? null : `${folderPath} is refused, and teamai's default stays in force: a default hook is replaced at the root of the team repo only. Move it to hooks/${name}/` };
    }

    if (name.startsWith('teamai-')) {
      return { kind: 'skipped', note: `${folderPath} is skipped: a teamai- name only replaces a teamai default, and teamai has no hook named ${name}. Rename the folder.` };
    }

    return readHookFolder(full, folderPath, name);
  },
  scopeOf: (definition) => definition.hook,
};

/** Convert one validated team hook into the unified HookDef model. */
export function teamHookToDef(h: TeamHook): HookDef {
  return {
    source: 'team',
    key: h.id,
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeout: h.timeout,
    description: `${TEAMAI_CUSTOM_HOOK_PREFIX}${h.id}] ${h.description}`,
    tools: h.tools,
  };
}

/**
 * The root file's `builtin:` block. `known: false` when hooks/hooks.yaml does
 * not parse: applying the built-in hooks without its overrides would re-enable
 * the ones the team disabled.
 */
export type BuiltinOverrideRead = { known: true; override: BuiltinOverride | undefined } | { known: false };

/**
 * The team hooks this member receives, with where each comes from, plus the
 * built-in overrides of the root file. The overrides are known whenever the
 * root file parses, even when the resolution fails elsewhere (a namespace file,
 * a hook id twice).
 */
export async function resolveTeamHookEntries(
  localConfig: LocalConfig,
): Promise<{ resolution: EntryResolution<TeamHookDefinition>; builtin: BuiltinOverrideRead }> {
  const resolution = await LayeredEntries.resolve(TEAM_HOOK_ENTRIES, localConfig);

  return { resolution, builtin: await readBuiltinOverride(localConfig) };
}

/** The root hooks file's `builtin:` block alone (see BuiltinOverrideRead). */
export async function readBuiltinOverride(localConfig: LocalConfig): Promise<BuiltinOverrideRead> {
  const root = await readHooksFile(teamHooksYamlPath(localConfig.repo.localPath), entryFilePath('hooks', null));

  if (root === null) return { known: true, override: undefined };

  return root.ok ? { known: true, override: root.yaml.builtin } : { known: false };
}

const RawBuiltinDisabledSchema = z.object({ builtin: z.object({ disabled: z.array(z.unknown()) }) });

/**
 * Whether the root hooks file's `builtin.disabled` array lists `key`, read from
 * the raw YAML so an invalid hook or field elsewhere in the file does not hide
 * it. `unreadable` only when the file cannot be read or its YAML does not parse.
 */
export async function readBuiltinDisabledListing(
  localConfig: LocalConfig,
  key: string,
): Promise<'listed' | 'not-listed' | 'unreadable'> {
  const file = await readEntryFileText(teamHooksYamlPath(localConfig.repo.localPath), entryFilePath('hooks', null));

  if (!file.ok) return 'unreadable';

  if (file.text === null) return 'not-listed';
  let raw: unknown;

  try {
    raw = parseYaml(file.text);
  } catch {
    return 'unreadable';
  }

  const parsed = RawBuiltinDisabledSchema.safeParse(raw);

  return parsed.success && parsed.data.builtin.disabled.includes(key) ? 'listed' : 'not-listed';
}

// ─── Security gate (§6) ─────────────────────────────────────
//
//  Team hooks are arbitrary shell run on session events — a supply-chain
//  execution surface. Before applying, run them through layered guards.

/** True if a command points at a script under ~/.teamai/team-scripts/. */
function isTeamScriptCommand(command: string): boolean {
  return command.includes('.teamai/team-scripts/');
}

/**
 * A folder at the root of the team repo that replaces one of teamai's default hooks (#1787): delivered to the scope's
 * data home, where the hint that uses it reads it, or refused for breaking the default's contract, with what pull
 * prints about it, while teamai's default stays in force. `files` is null for a folder that cannot be read.
 */
export type DefaultHookReplacement = (
  | { readonly kind: 'delivered'; readonly name: DefaultFolderName<'hooks'>; readonly path: string; readonly delivery: FolderDelivery }
  | { readonly kind: 'refused'; readonly name: DefaultFolderName<'hooks'>; readonly path: string; readonly files: readonly FolderFile[] | null; readonly messages: readonly string[] }
) & {
  /** What pull warns about each team file that replaces no file of teamai's folder, and `review --branch` fails. */
  readonly strays: readonly string[];
  /** The files teamai's folder gives the team's, which leaves them out; null when it gives none. */
  readonly inheritance: Inheritance | null;
};

/**
 * A folder at the root of a team tree that replaces one of teamai's default hooks: the files it and teamai's folder
 * make, what pull prints when it refuses them, and what it warns about the team files that replace nothing.
 */
interface DefaultHookFolder {
  readonly name: DefaultFolderName<'hooks'>;
  readonly path: string;
  readonly read: FolderFilesRead;
  readonly messages: readonly string[];
  readonly strays: readonly string[];
  readonly inheritance: Inheritance | null;
}

/** Each folder at the root of the team tree at `root` that replaces one of teamai's default hooks. */
async function readDefaultHookFolders(root: string): Promise<DefaultHookFolder[]> {
  const { items } = await Resources.layer(TEAM_HOOKS, { root, namespace: null });
  const folders: DefaultHookFolder[] = [];

  for (const { name, source } of items) {
    if (source.kind !== 'folder' || !DefaultFolders.isName('hooks', name)) continue;
    const own = await FolderFiles.read(source.full);
    const teamai = await Resources.inherited(TEAM_HOOKS, name);
    const merged = own.kind === 'files' && teamai?.files.kind === 'files' ? InheritedFolders.merge({ team: own.files, teamai: teamai.files.files, marker: FOLDER_MARKERS.hooks.marker }) : null;
    const read: FolderFilesRead = merged ? { kind: 'files', files: merged.files } : own;
    const problems = read.kind === 'invalid' ? read.problems.map(FolderFiles.describe) : await DefaultFolders.problems({ kind: 'hooks', name: name }, read.files);

    folders.push({
      name,
      path: source.path,
      read,
      messages: problems.map((problem) => `${source.path} is refused, and teamai's default stays in force until it is fixed: ${problem}`),
      strays: (merged?.strays ?? []).map((file) => InheritedFolders.strayMessage(source.path, file)),
      inheritance: merged ? InheritedFolders.inheritanceOf(merged, getCurrentVersion()) : null,
    });
  }

  return folders;
}

/** The team's replacements of teamai's default hooks, as pull reads them. */
export async function readDefaultHookReplacements(localConfig: LocalConfig): Promise<DefaultHookReplacement[]> {
  return (await readDefaultHookFolders(localConfig.repo.localPath)).map(({ name, path: folderPath, read, messages, strays, inheritance }): DefaultHookReplacement => (
    read.kind === 'files' && messages.length === 0
      ? { kind: 'delivered', name, path: folderPath, delivery: { dest: DeliveredFolders.pathOf(localConfig, { type: 'hooks', namespace: null, name }), files: read.files, earlierFiles: 'drop' }, strays, inheritance }
      : { kind: 'refused', name, path: folderPath, files: read.kind === 'files' ? read.files : null, messages, strays, inheritance }));
}

/** What pull prints about each replacement of a default hook it refuses or warns about in the team tree at `root`, for `teamai review --branch`, which fails both. */
export async function defaultHookRefusals(root: string): Promise<Array<{ readonly path: string; readonly messages: readonly string[] }>> {
  return (await readDefaultHookFolders(root)).flatMap(({ path: folderPath, messages, strays }) => {
    const all = [...messages, ...strays];

    return all.length === 0 ? [] : [{ path: folderPath, messages: all }];
  });
}

/** The default hook replacements to deliver, warning once about each one pull refuses. */
async function defaultHookReplacements(localConfig: LocalConfig): Promise<FolderDelivery[]> {
  const folders: FolderDelivery[] = [];

  for (const replacement of await readDefaultHookReplacements(localConfig)) {
    for (const message of replacement.strays) if (warnOnce(message)) log.persist(message);

    if (replacement.kind === 'delivered') {
      folders.push(replacement.delivery);
      continue;
    }

    for (const message of replacement.messages) if (warnOnce(message)) log.persist(message);
  }

  return folders;
}

/** One team hook as delivered: its definition for the tools, and the folder it runs from, if any. */
interface TeamHookDelivery {
  readonly def: HookDef;
  readonly folder: FolderDelivery | null;
}

/**
 * Where `localConfig`'s scope delivers the hook folder `folder`, in `namespace`: `hooks/[<ns>/]<id>.<version>/`, one
 * directory per version of its files, `HOOK.yaml` among them (#1787). Each tool's entry runs the files it was written
 * with: a tool whose entry pull could not rewrite keeps its own, while the others run the new ones.
 */
export function hookFolderPath(localConfig: LocalConfig, folder: TeamHookFolder, namespace: string | null): string {
  return DeliveredFolders.versionedPathOf(localConfig, { type: 'hooks', namespace, name: folder.hook.id }, folder.version);
}

/** The hook folder `hook`, delivered at `dest` in `localConfig`'s scope: its command names that path (#1787). */
function folderHookDef(localConfig: LocalConfig, hook: TeamHook, dest: string): HookDef {
  const projectRoot = isSelfMode(localConfig) ? localConfig.projectRoot ?? null : null;

  return {
    ...teamHookToDef(hook),
    command: DeliveredFolders.render(hook.command, { type: 'hooks', dest }),
    folder: { command: hook.command, dest, projectRoot },
  };
}

/** `resolved` for `localConfig`'s scope, with the folder it runs from, if any. */
function teamHookDelivery(localConfig: LocalConfig, resolved: ResolvedEntry<TeamHookDefinition>): TeamHookDelivery {
  const definition = resolved.entry;

  if (definition.kind === 'entry') return { def: teamHookToDef(definition.hook), folder: null };
  const def = folderHookDef(localConfig, definition.hook, hookFolderPath(localConfig, definition, resolved.namespace));

  // A version's folder holds only its files: an entry written for other files runs another folder.
  return { def, folder: def.folder ? { dest: def.folder.dest, files: definition.files, earlierFiles: 'drop' } : null };
}

/**
 * The hook a committed `HOOK.yaml` at `relativePath` (`hooks/[<ns>/]<id>/HOOK.yaml`) defined, rendered with
 * `localConfig`'s scope, so teamai recognises the entries it wrote from an earlier version (#993, #1787). Null for
 * any other path, or a version that does not parse.
 */
export function historicalFolderHookDef(localConfig: LocalConfig, relativePath: string, content: string): HookDef | null {
  const segments = relativePath.split('/');
  const [type, ...rest] = segments;
  const marker = rest.at(-1);
  const id = rest.at(-2);
  const namespace = rest.length === 3 ? rest[0] ?? null : null;

  if (type !== TEAM_HOOKS.dir || marker !== RESOURCE_LAYOUTS.hooks.marker || id === undefined || (rest.length !== 2 && rest.length !== 3)) return null;

  if (!RESOURCE_LAYOUTS.hooks.nameRule.pattern.test(id)) return null;
  const parsed = parseMarker(content, relativePath, FolderHookSchema);

  // The files of that revision are not read: its entries are compared with the version left out (`withoutVersions`).
  return parsed.ok ? folderHookDef(localConfig, { ...parsed.fields, id }, DeliveredFolders.anyVersionPathOf(localConfig, { type: 'hooks', namespace, name: id })) : null;
}

/**
 * Whether `requireTeamScripts` lets `def` through: a folder hook that names its folder through `${TEAMAI_HOOK_DIR}`,
 * checked before substitution, or a command under `~/.teamai/team-scripts/`. A provenance check, not a sandbox.
 */
function runsTeamScript(def: HookDef): boolean {
  return (def.folder !== undefined && DeliveredFolders.mentions(def.folder.command, 'hooks')) || isTeamScriptCommand(def.command);
}

/** Why `sharing.hooks.requireTeamScripts` keeps `resolved` out of every tool, or null when it lets it through. */
export function teamScriptRefusal(localConfig: LocalConfig, teamConfig: TeamaiConfig, resolved: ResolvedEntry<TeamHookDefinition>): string | null {
  return getHooksSharing(teamConfig).requireTeamScripts && !runsTeamScript(teamHookDelivery(localConfig, resolved).def)
    ? 'its command is neither in a hook folder through ${TEAMAI_HOOK_DIR} nor under ~/.teamai/team-scripts/ (sharing.hooks.requireTeamScripts)'
    : null;
}

/**
 * Resolve the team hooks that should actually be applied, after security gating:
 *   1. Local kill-switch (TEAMAI_HOOKS_DISABLED) → drop all team hooks.
 *   2. Optional command whitelist (sharing.hooks.requireTeamScripts).
 *   3. autoApply gate: during `pull` (auto), if sharing.hooks.autoApply is false,
 *      hold team hooks and hint the user to run `teamai hooks inject`.
 *   4. Transparency: print the commands that will run (unless silent).
 *
 * Always returns the built-in override (A overrides are not security-sensitive).
 */
export async function resolveTeamHooks(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  opts: { auto?: boolean; silent?: boolean; preview?: boolean } = {},
): Promise<
  | { ok: true; defs: HookDef[]; folders: readonly FolderDelivery[]; builtin: BuiltinOverride | undefined; held?: readonly string[] }
  | { ok: false; builtin: BuiltinOverrideRead }
> {
  // Which hooks this member receives: root plus active namespace files, before
  // the security gates so the transparency print below lists only hooks this
  // member will actually run. A resolution that fails keeps what is installed.
  const { resolution, builtin: builtinRead } = await resolveTeamHookEntries(localConfig);
  reportEntryResolution(resolution);

  if (resolution.kind === 'failed') return { ok: false, builtin: builtinRead };
  // A root file that does not parse fails the resolution, so it is known here.
  const builtin = builtinRead.known ? builtinRead.override : undefined;
  const sharing = getHooksSharing(teamConfig);
  let hooks = resolution.entries.map((resolved) => teamHookDelivery(localConfig, resolved));
  // The ids a workspace holds back (#913): each tool keeps what it has installed for them.
  const held = resolution.held ? { held: resolution.held } : {};
  // Texts and thresholds of teamai's own hints, which run no command of the team's: no gate below holds them back.
  const replacements = await defaultHookReplacements(localConfig);

  if (areTeamHooksDisabled()) {
    if (hooks.length > 0) log.warn(`Team hooks disabled (TEAMAI_HOOKS_DISABLED) — skipping ${hooks.length} team hook(s)`);

    return { ok: true, defs: [], folders: replacements, builtin };
  }

  if (sharing.requireTeamScripts) {
    const before = hooks.length;
    hooks = hooks.filter(({ def }) => runsTeamScript(def));
    const dropped = before - hooks.length;

    if (dropped > 0) {
      log.warn(`Skipped ${dropped} team hook(s) whose command is neither in a hook folder through \${TEAMAI_HOOK_DIR} nor under ~/.teamai/team-scripts/ (sharing.hooks.requireTeamScripts)`);
    }
  }

  if (opts.auto && !(sharing.autoApply ?? true) && hooks.length > 0) {
    log.info(`${hooks.length} team hook(s) pending — run 'teamai hooks inject' to apply (sharing.hooks.autoApply=false):`);

    for (const { def } of hooks) log.info(`  [${def.key}] ${def.command}`);

    return { ok: true, defs: [], folders: replacements, builtin, ...held };
  }

  const defs = hooks.map(({ def }) => def);

  if (defs.length > 0 && !opts.silent) {
    // A preview must not claim the hooks were applied: `pull --dry-run` resolves
    // them only to report what a real pull would write (#822).
    log.info(opts.preview
      ? `Would apply ${defs.length} team hook(s):`
      : `Applying ${defs.length} team hook(s):`);

    for (const d of defs) log.info(`  [${d.key}] ${d.command}`);
  }

  return { ok: true, defs, folders: [...hooks.flatMap(({ folder }) => folder ? [folder] : []), ...replacements], builtin, ...held };
}

/**
 * Deliver the folders the resolved team hooks run from, recorded in the scope's delivery record (#1787, common rule 9),
 * before any entry names them. Throws when a folder cannot be written; the caller then keeps the installed team hooks,
 * whose folders are left as they were.
 */
export async function deliverHookFolders(localConfig: LocalConfig, folders: readonly FolderDelivery[]): Promise<void> {
  const { editDeliveryRecord } = await import('../pull.js');
  const record = await editDeliveryRecord(localConfig);

  await DeliveredFolders.sync({ localConfig, type: 'hooks', folders, ledger: record.ledger, prune: false });
  await record.save();
}

/**
 * Remove the scope's hook folders that neither `folders` nor an installed entry runs from, once every tool's entries are
 * written. A folder whose path one of `installed` (the commands of the entries teamai recorded installing) names stays:
 * an entry pull left as it was, such as one of a tool the member excluded or one it could not write, still runs it.
 */
export async function pruneHookFolders(localConfig: LocalConfig, folders: readonly FolderDelivery[], installed: readonly string[]): Promise<void> {
  const { editDeliveryRecord } = await import('../pull.js');
  const record = await editDeliveryRecord(localConfig);
  const named = await DeliveredFolders.namedIn({ root: DeliveredFolders.root(localConfig, 'hooks'), type: 'hooks', texts: installed });

  await DeliveredFolders.prune({ localConfig, type: 'hooks', keep: [...folders.map(({ dest }) => dest), ...named], ledger: record.ledger });
  await record.save();
}

// ─── Handler ────────────────────────────────────────────────
//
//  Structurally mirrors EnvHandler: a single YAML in the team repo, parsed and
//  injected on pull. Unlike other resources, the actual injection runs in
//  pull.ts (reconcileHooksAllScopes) outside the rev fast-path, so pullItem here
//  is a no-op — the handler exists for registration, scanning, and counting.

export class HooksHandler extends ResourceHandler {
  readonly type = 'hooks' as const;

  async scanLocalForPush(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    return scanRepoResourceForPush('hooks', 'hooks', teamConfig, localConfig);
  }

  async scanTeamForPull(_teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<ResourceItem[]> {
    const yamlPath = teamHooksYamlPath(localConfig.repo.localPath);

    if (!(await pathExists(yamlPath))) return [];

    return [{ name: 'hooks.yaml', type: 'hooks', sourcePath: yamlPath, relativePath: 'hooks/hooks.yaml' }];
  }

  async pushItem(item: ResourceItem, _teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
    await pushRepoResourceItem(item, localConfig);
  }

  async pullItem(_item: ResourceItem, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<void> {
    // No-op — reconcileHooksAllScopes() in pull.ts performs injection across all
    // tools/scopes, bypassing the "Already synced" fast-path.
  }

  async removeItem(_name: string, _teamConfig: TeamaiConfig, _localConfig: LocalConfig): Promise<string[]> {
    log.warn('Edit hooks/hooks.yaml in the team repo to manage team hooks.');

    return [];
  }

  /** Count the team hooks this member receives (for status output). */
  async countHooks(localConfig: LocalConfig): Promise<number> {
    const { resolution } = await resolveTeamHookEntries(localConfig);

    return resolution.kind === 'resolved' ? resolution.entries.length : 0;
  }
}

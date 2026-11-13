/**
 * Which definition of each workflow, hook, MCP server, benchmark suite and rule folder applies in a workspace, and how the team
 * changed each of teamai's default hooks, for the dashboard's Resources page (#1787). Every type is read by the
 * readers pull uses: the resolver's survey lists every definition, and the type's own validator and resolution say
 * which applies and why another does not, in the words pull prints. Names, paths, sizes and rendered commands only:
 * never a file's content, a prompt, or an environment value.
 */
import path from 'node:path';
import { RECALL_RULE_NAME, resolveRecall, type RecallFolder } from '../builtin-rules.js';
import { loadCachedSuite, suiteDirectories, syncTeamDefinitions, type SyncTeamResult } from '../benchmark/suite-cache.js';
import { DefaultFolders, type DefaultFolderComparison } from '../default-folders.js';
import { DefaultWorkflows } from '../default-workflows.js';
import { activeEntryNamespaces, describeEntryFailure, entryLayout, type EntryFailure, type ResolvedEntry } from '../namespaced-entries.js';
import { LayeredEntries, type LayeredEntryType, type PlaceFolderRead } from '../resources/layered-entries.js';
import { resolveResourceNamespaces } from '../resource-namespaces.js';
import { DeliveredFolders } from '../resources/delivered-folders.js';
import { FolderFiles } from '../resources/folder-files.js';
import { InheritedFolders, type FolderFileLayer } from '../resources/inherited-folders.js';
import { getCurrentVersion } from '../package-info.js';
import { TEAM_HOOKS, TEAM_HOOK_ENTRIES, hookFolderPath, readDefaultHookReplacements, readHookFolder, teamScriptRefusal, type TeamHookDefinition, type TeamHookFolder } from '../resources/hooks.js';
import { TEAM_MCP, TEAM_MCP_ENTRIES, mcpFolderPath, readMcpFolder, type TeamMcpDefinition, type TeamMcpFolder } from '../resources/mcp.js';
import { teamMcpRefusal } from '../mcp-reconcile.js';
import { RESOURCE_LAYOUTS, Resources, type LayeredItem, type ListedResolution, type ResourceLayout } from '../resources/resolver.js';
import { RuleFolders } from '../resources/rule-folders.js';
import { buildRolePullContext, resolveDesiredRules } from '../resources/desired.js';
import { readTeamRules, rulesReceivingTools } from '../resources/rules.js';
import type { FolderReach } from '@teamai/tool-core/definition';
import { folderReachOf } from '../tool-registry.js';
import { getKnowledgeDir, isAgentExcluded, isRecallEnabled, type LocalConfig, type TeamaiConfig } from '../types.js';
import { pathExists } from '../utils/fs.js';
import { isSilent, setSilent } from '../utils/logger.js';
import { dropsKeptVersion } from '../workflow/cache.js';
import { WORKFLOW_MARKER, WorkflowFolder } from '../workflow/folder.js';
import { formatDiagnostic } from '../workflow/parse.js';
import type { WorkflowDiagnostic } from '../workflow/types.js';
import { collectRulesInventory } from './resources.js';

/** The types whose definitions the page lists by layer. Of rules, only folders: the Rules list shows rule files. */
export type LayeredResourceType = 'workflows' | 'hooks' | 'mcp' | 'benchmarks' | 'rules';

/** Where a definition comes from, bottom up: teamai's package, the team repo's root, or a namespace in it. */
export type ResourceLayer =
  | { readonly kind: 'teamai' }
  | { readonly kind: 'root' }
  | { readonly kind: 'namespace'; readonly namespace: string };

/** One definition's place: its layer, how it is written, and its path from the team repo's root (teamai's: the package's). */
export interface ResourcePlace {
  readonly layer: ResourceLayer;
  /** `entry`: one entry of an entry-list file, `hooks.yaml` or `mcp.yaml`, which `path` names. */
  readonly form: 'file' | 'folder' | 'entry';
  /** `/`-separated; a folder's ends with `/`. */
  readonly path: string;
}

/**
 * What pull does with a definition. `message` is what pull prints about it. `blocked`: nothing is wrong with it, but
 * another definition's problem stops its whole type this pull, which keeps what is installed.
 */
export type ResourceState =
  | { readonly kind: 'in-force' }
  | { readonly kind: 'replaced'; readonly by: string }
  | { readonly kind: 'inactive' }
  /** The member's tag subscriptions leave it out (`tags.yaml`), though its namespace is active: rules only. */
  | { readonly kind: 'unsubscribed' }
  /** teamai delivers none of its feature here: its recall rule, and the team's folder replacing it, while recall is off. */
  | { readonly kind: 'off' }
  | { readonly kind: 'conflict'; readonly reason: 'duplicate' | 'two-namespaces'; readonly message: string }
  /** `fallback`: what applies instead, the last valid version, teamai's default, what is installed, or nothing. */
  | { readonly kind: 'invalid'; readonly message: string; readonly fallback: 'kept' | 'default' | 'installed' | 'none' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'blocked'; readonly message: string };

/** What a folder holds and where pull puts it. */
export interface ResourceFolder {
  /** `layer`: where a file of a team folder over a teamai default comes from. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly executable: boolean; readonly layer?: FolderFileLayer }>;
  /** For a team folder over a teamai default: that teamai's version, and how many of its files are the team's and how many teamai's. Null for any other folder. */
  readonly inherited: { readonly teamaiVersion: string; readonly own: number; readonly teamai: number } | null;
  readonly bytes: number;
  /** The most its files may hold in all: a workflow folder's, which each run keeps a copy of. Null for no limit. */
  readonly limit: number | null;
  /** Where its files are put: by pull, in the scope's data home, or by a run's start, once per version. */
  readonly delivered: { readonly path: string; readonly present: boolean; readonly by: 'pull' | 'run' } | null;
  /** What a tool runs from it, with its folder's path filled in: a hook's command, an MCP server's command and args. Env by name only. */
  readonly runs: { readonly command: string; readonly args: readonly string[]; readonly env: readonly string[] } | null;
  /** The file pull reads a rule folder's text from for the team's `language`: `RULE.md`, or a variant such as `RULE.zh.md`. */
  readonly variant: string | null;
  /**
   * Where each tool that receives rules reads a delivered rule folder's files: the path pull writes for
   * `${TEAMAI_RULE_DIR}`, and how the tool reaches it: `worktree` in a project, else the tool's cell in user scope.
   */
  readonly reads: ReadonlyArray<{ readonly tool: string; readonly reach: FolderReach['reach'] | 'worktree'; readonly path: string }> | null;
}

/** One definition of a name, and what pull does with it. */
export interface LayeredResource extends ResourcePlace {
  readonly name: string;
  /** What it stands in for: teamai's default, or the root definition a namespace's replaces. */
  readonly replaces: ResourcePlace | null;
  readonly state: ResourceState;
  readonly folder: ResourceFolder | null;
}

/** One type's definitions, and what pull says about its files besides them. */
export interface LayeredResourceList {
  readonly type: LayeredResourceType;
  /** The file that makes a directory one of its folders. */
  readonly marker: string;
  readonly resources: LayeredResource[];
  /** A file or folder that defines nothing because pull cannot use it, with pull's message. */
  readonly problems: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  /** What pull notes about the type's files that changes nothing. */
  readonly notes: readonly string[];
}

/** One of teamai's default hooks: teamai's folder, or the team's that replaces it, and how the two differ. */
export interface DefaultHookResource extends DefaultFolderComparison {
  readonly name: string;
  /** `refused`: pull's messages about the team's folder, while teamai's stays in force. */
  readonly state:
    | { readonly kind: 'teamai' }
    /** `inherited`: what the team's folder takes from teamai's, as a folder's `inherited`. */
    | { readonly kind: 'replaced'; readonly path: string; readonly inherited: ResourceFolder['inherited'] }
    | { readonly kind: 'refused'; readonly path: string; readonly messages: readonly string[] };
  /** Where pull puts the team's folder, which the hint reads. */
  readonly delivered: { readonly path: string; readonly present: boolean } | null;
}

export interface LayeredResources {
  /** The team's `language`, which picks each default hook text's variant. */
  readonly language: 'en' | 'zh' | null;
  readonly types: LayeredResourceList[];
  readonly defaultHooks: DefaultHookResource[];
}

/** A definition the resolver found, in the team's files or teamai's package. */
type Found = LayeredItem<unknown, unknown>;

function placeOf(item: Found): ResourcePlace {
  const layer: ResourceLayer = item.layer === 'namespace' ? { kind: 'namespace', namespace: item.namespace } : item.layer === 'root' ? { kind: 'root' } : { kind: 'teamai' };

  return { layer, form: item.source.kind, path: item.source.path };
}

/**
 * What the team folder at `full` holds with the files the teamai default at `teamaiFull` gives it, each with its layer,
 * as pull reads them; none when either cannot be read, which its state says.
 */
async function inheritedFolderFiles(full: string, teamaiFull: string, marker: string): Promise<Pick<ResourceFolder, 'files' | 'bytes' | 'inherited'>> {
  const [own, teamai] = await Promise.all([FolderFiles.read(full), FolderFiles.read(teamaiFull)]);

  if (own.kind === 'invalid' || teamai.kind === 'invalid') return { files: [], bytes: 0, inherited: null };
  const merged = InheritedFolders.merge({ team: own.files, teamai: teamai.files, marker });
  const files = merged.files.map((file) => ({ path: file.path, bytes: file.bytes.length, executable: file.executable, layer: file.layer }));
  const fromTeamai = files.filter((file) => file.layer === 'teamai').length;

  return {
    files,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    inherited: fromTeamai > 0 ? { teamaiVersion: getCurrentVersion(), own: files.length - fromTeamai, teamai: fromTeamai } : null,
  };
}

/** What the folder at `full` holds, by path, size and executable bit; none when it cannot be read, which its state says. */
async function folderFiles(full: string): Promise<Pick<ResourceFolder, 'files' | 'bytes' | 'inherited'>> {
  const read = await FolderFiles.read(full);
  const files = read.kind === 'files' ? read.files.map((file) => ({ path: file.path, bytes: file.bytes.length, executable: file.executable })) : [];

  return { files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), inherited: null };
}

/** The namespaces of `type` active for `config`, as pull's sync asks for them: `legacy` without a manifest, none when it cannot be read. */
async function activeNamespaces(config: LocalConfig, type: 'workflows'): Promise<readonly string[] | 'legacy'> {
  try {
    const resolved = await resolveResourceNamespaces(config);

    return resolved === null ? 'legacy' : resolved.activeNamespaces[type] ?? [];
  } catch {
    return [];
  }
}

/** Whether `item` sits in a namespace `active` leaves out. */
function isInactive(item: Found, active: readonly string[] | 'legacy'): boolean {
  return item.layer === 'namespace' && active !== 'legacy' && !active.includes(item.namespace);
}

/** The diagnostics of pull's sync about the definition `item`: its file, or any file of its folder. */
function diagnosticsOf(item: Found, invalid: readonly WorkflowDiagnostic[]): WorkflowDiagnostic[] {
  return invalid.filter((diagnostic) => (item.source.kind === 'folder' ? diagnostic.file.startsWith(item.source.path) : diagnostic.file === item.source.path));
}

/** What pull printed about `diagnostics`, one per line. */
const printed = (diagnostics: readonly WorkflowDiagnostic[]): string => diagnostics.map(formatDiagnostic).join('\n');

/** Workflows: the resolver's survey over the team's files and teamai's package, and the dry sync pull runs. */
async function workflowList(config: LocalConfig, sync: SyncTeamResult): Promise<LayeredResourceList> {
  const active = await activeNamespaces(config, 'workflows');
  const layout = RESOURCE_LAYOUTS.workflows;
  const survey = await Resources.survey(layout, { team: { root: getKnowledgeDir(config), namespaces: async () => active }, teamai: DefaultWorkflows.layer });
  const byName = new Map(survey.resolutions.map((resolution) => [resolution.name, resolution]));
  const defaults = new Set((await Resources.list(layout, { teamai: DefaultWorkflows.layer })).map(({ name }) => name));
  const seen = new Set<WorkflowDiagnostic>();

  const stateOf = (item: Found, resolution: ListedResolution<unknown, unknown> | undefined): ResourceState => {
    if (isInactive(item, active) || resolution === undefined) return { kind: 'inactive' };
    // A default that runs a team workflow of another shape cannot start, though nothing is wrong with it.
    const broken = item.layer === 'teamai' ? sync.brokenDefaults.filter(({ name }) => name === item.name) : [];

    if (broken.length > 0) return { kind: 'blocked', message: broken.map(({ message }) => message).join('\n') };

    if (resolution.kind === 'conflict') {
      const conflict = sync.invalid.filter((diagnostic) => diagnostic.code === 'workflow_namespace_conflict' && diagnostic.file === resolution.first.source.path);
      conflict.forEach((diagnostic) => seen.add(diagnostic));

      return { kind: 'conflict', reason: resolution.reason, message: printed(conflict) };
    }

    if (resolution.item.source.path !== item.source.path) return { kind: 'replaced', by: resolution.item.source.path };
    // A folder pull skips whole, such as a teamai- name that replaces no default.
    const skipped = sync.skipped.find(({ path: at }) => at === item.source.path);

    if (skipped) return { kind: 'refused', message: skipped.message };
    const diagnostics = diagnosticsOf(item, sync.invalid);
    diagnostics.forEach((diagnostic) => seen.add(diagnostic));

    if (diagnostics.length === 0) return { kind: 'in-force' };
    const fallback = sync.kept.includes(item.name) ? 'kept' : defaults.has(item.name) ? 'default' : 'none';

    return { kind: 'invalid', message: printed(diagnostics), fallback };
  };

  const resources: LayeredResource[] = [];

  for (const item of [...survey.definitions, ...survey.resolutions.flatMap((resolution) => (resolution.kind === 'resolved' && resolution.item.layer === 'teamai' ? [resolution.item] : []))]) {
    const resolution = byName.get(item.name);
    const state = stateOf(item, resolution);
    const replaces = state.kind === 'in-force' && resolution?.kind === 'resolved' && resolution.replaces ? placeOf(resolution.replaces) : null;
    const inheritsFrom = item.layer === 'teamai' ? null : await Resources.inherited(layout, item.name);
    resources.push({ name: item.name, ...placeOf(item), replaces, state, folder: item.source.kind === 'folder' ? await workflowFolder(config, item.source.full, inheritsFrom?.full ?? null) : null });
  }

  return {
    type: 'workflows',
    marker: WORKFLOW_MARKER,
    resources,
    problems: sync.invalid.filter((diagnostic) => !seen.has(diagnostic) && diagnostic.file.startsWith(`${layout.dir}/`)).map((diagnostic) => ({ path: diagnostic.file, message: formatDiagnostic(diagnostic) })),
    notes: [...survey.diagnostics.flatMap((diagnostic) => (diagnostic.kind === 'note' ? [diagnostic.message] : [])), ...sync.aliasConflicts.map(formatDiagnostic)],
  };
}

/**
 * A workflow folder: its files against the limit, and where a run's start keeps this version of it. A team folder over
 * the teamai default at `teamaiFull` is read with the files the default gives it, as pull reads it.
 */
async function workflowFolder(config: LocalConfig, full: string, teamaiFull: string | null): Promise<ResourceFolder> {
  const [own, teamai] = await Promise.all([WorkflowFolder.read(full), teamaiFull === null ? null : FolderFiles.read(teamaiFull).then(WorkflowFolder.shipped)]);

  const read = own.kind === 'files' && teamai?.kind === 'files'
    ? { kind: 'files' as const, files: InheritedFolders.merge({ team: own.files, teamai: teamai.files, marker: WORKFLOW_MARKER }).files.map(({ layer: _layer, ...file }) => file) }
    : own;

  const pinned = read.kind === 'files' ? WorkflowFolder.dir(config, WorkflowFolder.hash(read.files)) : undefined;

  return {
    ...teamaiFull === null ? await folderFiles(full) : await inheritedFolderFiles(full, teamaiFull, WORKFLOW_MARKER),
    limit: WorkflowFolder.MAX_BYTES,
    delivered: pinned === undefined ? null : { path: pinned, present: await pathExists(pinned), by: 'run' },
    runs: null,
    variant: null,
    reads: null,
  };
}

/** A type whose items are entries of an entry-list file or folders (`TFolder`), resolved for delivery as `entries`, and how its folders are checked. */
interface EntryType<TEntry, TDefinition, TFolder extends TDefinition> {
  readonly type: 'hooks' | 'mcp';
  readonly layout: ResourceLayout<TEntry>;
  readonly entries: LayeredEntryType<TEntry, TDefinition>;
  /** The folder at `full` read as pull reads it, for the definition named `name`, or why pull cannot use it. */
  readonly readFolder: (full: string, folderPath: string, name: string) => Promise<PlaceFolderRead<TFolder>>;
  /** Where pull delivers the valid folder of `definition`, named `name` in `namespace`. */
  readonly deliveredAt: (config: LocalConfig, definition: TFolder, place: { readonly namespace: string | null; readonly name: string }) => string;
  /** What a tool runs from a valid folder delivered at `dest`. */
  readonly runs: (definition: TFolder, dest: string) => NonNullable<ResourceFolder['runs']>;
  /** Definitions another list shows: the team's folders that replace teamai's default hooks, at the root. */
  readonly listedElsewhere: (item: Found) => boolean;
  /** Why the team's policy keeps a definition pull resolves out of every tool, as pull reads it, or null. */
  readonly refusal: (config: LocalConfig, teamConfig: TeamaiConfig, resolved: ResolvedEntry<TDefinition>) => string | null;
  /** Whether pull still delivers the folder of a definition `refusal` refuses: MCP delivers every resolved server's folder. */
  readonly deliversRefused: boolean;
}

const HOOKS: EntryType<unknown, TeamHookDefinition, TeamHookFolder> = {
  type: 'hooks',
  layout: TEAM_HOOKS,
  entries: TEAM_HOOK_ENTRIES,
  readFolder: readHookFolder,
  deliveredAt: (config, definition, { namespace }) => hookFolderPath(config, definition, namespace),
  runs: (definition, dest) => ({ command: DeliveredFolders.render(definition.hook.command, { type: 'hooks', dest }), args: [], env: [] }),
  listedElsewhere: (item) => item.layer === 'root' && item.source.kind === 'folder' && DefaultFolders.isName('hooks', item.name),
  refusal: teamScriptRefusal,
  deliversRefused: false,
};

const MCP: EntryType<unknown, TeamMcpDefinition, TeamMcpFolder> = {
  type: 'mcp',
  layout: TEAM_MCP,
  entries: TEAM_MCP_ENTRIES,
  readFolder: readMcpFolder,
  deliveredAt: (config, definition, { namespace }) => mcpFolderPath(config, definition, namespace),
  runs: ({ server }, dest) => {
    const render = (text: string): string => DeliveredFolders.render(text, { type: 'mcp', dest });

    return { command: render(server.command ?? ''), args: (server.args ?? []).map(render), env: Object.keys(server.env ?? {}) };
  },
  listedElsewhere: () => false,
  refusal: teamMcpRefusal,
  deliversRefused: true,
};

/** The paths a failure of pull's resolution names, so the definitions there carry it. */
function failurePaths(failure: EntryFailure): string[] {
  switch (failure.kind) {
    case 'broken-file': return [failure.source];
    case 'duplicate': return [failure.source, failure.second];
    case 'two-namespaces': return [failure.first, failure.second];
    case 'namespaces-unresolved': return [];
    default: {
      const unhandled: never = failure;

      return unhandled;
    }
  }
}

/**
 * Hooks or MCP servers: the resolver's survey lists every definition, each folder is read by the type's own reader,
 * and pull's resolution says which apply. A problem anywhere stops the whole type for the run, as pull does, which
 * keeps what is installed: the other definitions are `blocked`.
 */
async function entryList<TEntry, TDefinition, TFolder extends TDefinition>(config: LocalConfig, teamConfig: TeamaiConfig, spec: EntryType<TEntry, TDefinition, TFolder>): Promise<LayeredResourceList> {
  const layout = entryLayout(spec.type);
  const resolution = await LayeredEntries.resolve(spec.entries, config);
  const namespaces = resolution.kind === 'resolved' ? { ok: true as const, active: resolution.active } : await activeEntryNamespaces(config, layout);
  const active = namespaces.ok ? namespaces.active ?? [] : [];
  const survey = await Resources.survey(spec.layout, { team: { root: getKnowledgeDir(config), namespaces: async () => active } });
  const failure = resolution.kind === 'failed' ? resolution.failure : null;
  const stopped = failure ? describeEntryFailure(failure) : null;
  const named = failure ? failurePaths(failure) : [];
  const notices = resolution.notices;
  // What pull prints for a file or folder it cannot use, had it been the first it met.
  const brokenFile = (source: string, reason: string): string => describeEntryFailure({ kind: 'broken-file', type: spec.type, source, reason, layout });

  // What a valid folder runs, from where pull delivers it; null for any other item.
  type Delivery = { readonly dest: string; readonly runs: NonNullable<ResourceFolder['runs']> } | null;

  const stateOf = async (item: Found): Promise<{ state: ResourceState; delivery: Delivery }> => {
    if (isInactive(item, active)) return { state: { kind: 'inactive' }, delivery: null };

    if (failure && stopped && named.includes(item.source.path) && (failure.kind === 'broken-file' || ('name' in failure && failure.name === item.name))) {
      return {
        state: failure.kind === 'duplicate' || failure.kind === 'two-namespaces'
          ? { kind: 'conflict', reason: failure.kind, message: stopped }
          : { kind: 'invalid', message: stopped, fallback: 'installed' },
        delivery: null,
      };
    }

    let delivery: Delivery = null;

    if (item.source.kind === 'folder' && !item.name.startsWith('teamai-')) {
      const read = await spec.readFolder(item.source.full, item.source.path, item.name);

      if (read.kind === 'invalid') return { state: { kind: 'invalid', message: brokenFile(item.source.path, read.reason), fallback: 'installed' }, delivery: null };

      if (read.kind === 'read') {
        const dest = spec.deliveredAt(config, read.definition, { namespace: item.layer === 'namespace' ? item.namespace : null, name: item.name });
        delivery = { dest, runs: spec.runs(read.definition, dest) };
      }
    }

    if (stopped) return { state: { kind: 'blocked', message: stopped }, delivery };

    if (resolution.kind !== 'resolved') return { state: { kind: 'inactive' }, delivery };
    const applied = resolution.entries.find((entry) => entry.name === item.name && entry.source === item.source.path);

    if (applied) {
      const refusal = spec.refusal(config, teamConfig, applied);

      return { state: refusal === null ? { kind: 'in-force' } : { kind: 'refused', message: refusal }, delivery };
    }

    const replacing = resolution.entries.find((entry) => entry.name === item.name && entry.replaces === item.source.path);

    if (replacing) return { state: { kind: 'replaced', by: replacing.source }, delivery };

    if (resolution.held?.includes(item.name)) {
      return { state: { kind: 'blocked', message: notices.find(({ message }) => message.includes(`"${item.name}"`))?.message ?? '' }, delivery };
    }

    // Pull's notices name a folder by its path, and an entry by its file and name.
    const prefix = item.source.kind === 'entry' ? `${item.source.path}: ${layout.noun} "${item.name}"` : item.source.path;
    const notice = notices.find(({ message }) => message.startsWith(prefix));

    if (notice === undefined) return { state: { kind: 'inactive' }, delivery };

    switch (notice.kind) {
      case 'unknown-key':
      case 'removed-key':
        return { state: { kind: 'invalid', message: notice.message, fallback: 'none' }, delivery };
      case 'file-note':
        return { state: { kind: 'refused', message: notice.message }, delivery };
      case 'deprecated-roles':
        return { state: { kind: 'inactive' }, delivery };
      default: {
        const unhandled: never = notice.kind;

        return unhandled;
      }
    }
  };

  const resources: LayeredResource[] = [];

  for (const item of survey.definitions) {
    if (spec.listedElsewhere(item)) continue;
    const { state, delivery } = await stateOf(item);
    const applied = resolution.kind === 'resolved' ? resolution.entries.find((entry) => entry.name === item.name && entry.source === item.source.path) : undefined;
    const replaced = applied?.replaces ? survey.definitions.find((other) => other.name === item.name && other.source.path === applied.replaces) : undefined;
    const isDelivered = state.kind === 'in-force' || state.kind === 'blocked' || (state.kind === 'refused' && applied !== undefined && spec.deliversRefused);
    const delivered = item.source.kind === 'folder' && isDelivered ? delivery?.dest ?? null : null;

    resources.push({
      name: item.name,
      ...placeOf(item),
      replaces: replaced ? placeOf(replaced) : null,
      state,
      folder: item.source.kind === 'folder'
        ? { ...await folderFiles(item.source.full), limit: null, delivered: delivered === null ? null : { path: delivered, present: await pathExists(delivered), by: 'pull' }, runs: delivery?.runs ?? null, variant: null, reads: null }
        : null,
    });
  }

  const claimed = new Set(resources.flatMap((resource) => (resource.state.kind === 'invalid' || resource.state.kind === 'conflict' ? [resource.state.message] : [])));

  // What stops the type is shown once: on the definitions it names, else as a problem of the type.
  const problems = [
    ...survey.diagnostics.flatMap((diagnostic) => (diagnostic.kind === 'invalid' ? [{ path: diagnostic.path, message: brokenFile(diagnostic.path, diagnostic.message) }] : [])),
    ...(stopped ? [{ path: named[0] ?? '', message: stopped }] : []),
  ].filter((problem, index, all) => !claimed.has(problem.message) && all.findIndex(({ message }) => message === problem.message) === index);

  return {
    type: spec.type,
    marker: spec.layout.marker ?? '',
    resources,
    problems,
    notes: [...new Set(notices.filter(({ kind }) => kind === 'deprecated-roles' || kind === 'file-note').map(({ message }) => message))],
  };
}

/**
 * Benchmark suites: every suite folder pull reads, in any namespace a manifest declares, and the dry sync's verdict on
 * those this member receives. A suite's directory is a namespace only where a manifest declares it, so suites are
 * listed by pull's own reader rather than by the resolver's survey.
 */
async function suiteList(config: LocalConfig, sync: SyncTeamResult): Promise<LayeredResourceList> {
  const layout = RESOURCE_LAYOUTS.benchmarks;
  const root = getKnowledgeDir(config);
  const diagnostics = sync.invalid.filter((diagnostic) => diagnostic.file.startsWith(`${layout.dir}/`));
  const seen = new Set<WorkflowDiagnostic>();

  const suites = (await suiteDirectories(config)).map((dir) => {
    const parent = path.posix.dirname(dir);
    const layer: ResourceLayer = parent === layout.dir ? { kind: 'root' } : { kind: 'namespace', namespace: path.posix.basename(parent) };

    return { name: path.posix.basename(dir), dir, place: { layer, form: 'folder' as const, path: `${dir}/` } };
  });

  const stateOf = async ({ name, dir }: { name: string; dir: string }): Promise<ResourceState> => {
    // Pull's message names both suite files: `(benchmarks/a/x/SUITE.yaml and benchmarks/b/x/SUITE.yaml)`.
    const conflict = diagnostics.filter((diagnostic) => diagnostic.code === 'benchmark_namespace_conflict' && (diagnostic.message.includes(`(${dir}/`) || diagnostic.message.includes(` ${dir}/`)));

    if (conflict.length > 0) {
      conflict.forEach((diagnostic) => seen.add(diagnostic));

      return { kind: 'conflict', reason: 'two-namespaces', message: printed(conflict) };
    }

    const own = diagnostics.filter((diagnostic) => diagnostic.file.startsWith(`${dir}/`));
    own.forEach((diagnostic) => seen.add(diagnostic));

    if (own.length > 0) return { kind: 'invalid', message: printed(own), fallback: !dropsKeptVersion(own) && await loadCachedSuite(config, name) ? 'kept' : 'none' };

    return sync.benchmarks.some((found) => found.relativePath.startsWith(`${dir}/`)) ? { kind: 'in-force' } : { kind: 'inactive' };
  };

  const states = new Map<string, ResourceState>();

  for (const found of suites) states.set(found.dir, await stateOf(found));
  const resources: LayeredResource[] = [];

  for (const { name, dir, place } of suites) {
    const state = states.get(dir) ?? { kind: 'inactive' };
    // A suite in an active namespace stands in for the shared suite of its name, whether or not it runs.
    const standIn = place.layer.kind === 'root' ? suites.find((other) => other.name === name && other.place.layer.kind === 'namespace' && states.get(other.dir)?.kind !== 'inactive') : undefined;
    const standInState = standIn ? states.get(standIn.dir) : undefined;
    const shared = place.layer.kind === 'namespace' && state.kind === 'in-force' ? suites.find((other) => other.name === name && other.place.layer.kind === 'root') : undefined;

    resources.push({
      name,
      ...place,
      replaces: shared ? shared.place : null,
      state: standIn === undefined ? state : standInState?.kind === 'conflict' ? { kind: 'blocked', message: standInState.message } : { kind: 'replaced', by: standIn.place.path },
      folder: { ...await folderFiles(path.join(root, dir)), limit: null, delivered: null, runs: null, variant: null, reads: null },
    });
  }

  return {
    type: 'benchmarks',
    marker: layout.marker ?? '',
    resources,
    problems: diagnostics.filter((diagnostic) => !seen.has(diagnostic)).map((diagnostic) => ({ path: diagnostic.file, message: formatDiagnostic(diagnostic) })),
    notes: [],
  };
}

/** The place of the team's rule at `relativePath`, from the repo's root: a folder's by its directory. */
function rulePlaceOf(relativePath: string): ResourcePlace {
  const isFolder = path.posix.basename(relativePath) === RESOURCE_LAYOUTS.rules.marker;
  const at = isFolder ? path.posix.dirname(relativePath) : relativePath;
  // `rules/<namespace>/<name>`: the segments between the type's directory and the rule's own name.
  const namespace = at.split('/').slice(1, -1).join('/');

  return { layer: namespace === '' ? { kind: 'root' } : { kind: 'namespace', namespace }, form: isFolder ? 'folder' : 'file', path: isFolder ? `${at}/` : at };
}

/**
 * teamai's recall rule and the team's `rules/teamai-recall/` folder that replaces it, as pull reads them. Pull puts the
 * recall texts into each tool's rules, so neither folder is delivered.
 */
async function recallResources(config: LocalConfig, teamConfig: TeamaiConfig): Promise<LayeredResource[]> {
  const recall = await resolveRecall(teamConfig.language, config.repo.localPath);
  const isOff = !isRecallEnabled(config, teamConfig);
  const teamai: ResourcePlace = { layer: { kind: 'teamai' }, form: 'folder', path: recall.teamai.path };

  const folderOf = async ({ dir, team }: RecallFolder): Promise<ResourceFolder> => ({
    ...team ? await inheritedFolderFiles(dir, recall.teamai.dir, RESOURCE_LAYOUTS.rules.marker) : await folderFiles(dir),
    limit: null,
    delivered: null,
    runs: null,
    variant: await RuleFolders.languageFile(dir, 'RULE', teamConfig.language),
    reads: null,
  });

  const teamaiState: ResourceState = isOff ? { kind: 'off' } : recall.team?.kind === 'replaces' ? { kind: 'replaced', by: recall.team.folder.path } : { kind: 'in-force' };
  const own: LayeredResource = { name: RECALL_RULE_NAME, ...teamai, replaces: null, state: teamaiState, folder: await folderOf(recall.teamai) };

  if (recall.team === null) return [own];
  const { team } = recall;
  const state: ResourceState = isOff ? { kind: 'off' } : team.kind === 'replaces' ? { kind: 'in-force' } : { kind: 'refused', message: team.message };

  return [{
    name: RECALL_RULE_NAME,
    layer: { kind: 'root' },
    form: 'folder',
    path: team.folder.path,
    replaces: state.kind === 'in-force' ? teamai : null,
    state,
    folder: await folderOf(team.folder),
  }, own];
}

/**
 * Rule folders, as pull reads the team's rules and resolves which this member receives. Each tool that receives rules
 * reads a delivered folder where pull renders `${TEAMAI_RULE_DIR}` for it.
 */
async function ruleList(config: LocalConfig, teamConfig: TeamaiConfig): Promise<LayeredResourceList> {
  const { rules, problems } = await readTeamRules(config.repo.localPath);
  const roleContext = await buildRolePullContext(config);
  // Which rules pull delivers and why it leaves the others out, as the Rules list says; which replaces which.
  const inventory = new Map((await collectRulesInventory(teamConfig, config, roleContext)).map((rule) => [rule.path, rule]));
  const { overrides } = await resolveDesiredRules(teamConfig, config, roleContext);
  const tools = (await rulesReceivingTools(teamConfig, config)).filter((tool) => !isAgentExcluded(config, tool));
  const resources: LayeredResource[] = [];

  for (const rule of rules.filter(RuleFolders.isFolder)) {
    const replacing = overrides.find((override) => override.replaces === rule.relativePath);
    const replaced = overrides.find((override) => override.source === rule.relativePath);
    const reason = inventory.get(rule.relativePath)?.undeliveredReason;

    const state: ResourceState = inventory.get(rule.relativePath)?.delivered
      ? { kind: 'in-force' }
      : replacing ? { kind: 'replaced', by: rulePlaceOf(replacing.source).path } : reason === 'tags' ? { kind: 'unsubscribed' } : { kind: 'inactive' };

    const delivered = state.kind === 'in-force' ? RuleFolders.pathOf(config, rule.name) : null;

    const reads = delivered === null ? null : tools.map((tool) => ({
      tool,
      reach: DeliveredFolders.worktreeRoot(config) === null ? folderReachOf(tool).reach : 'worktree' as const,
      path: RuleFolders.render(DeliveredFolders.placeholder('rules'), { localConfig: config, rule, tool }),
    }));

    resources.push({
      name: path.posix.basename(rule.name),
      ...rulePlaceOf(rule.relativePath),
      replaces: state.kind === 'in-force' && replaced ? rulePlaceOf(replaced.replaces) : null,
      state,
      folder: {
        ...await folderFiles(path.dirname(rule.sourcePath)),
        limit: null,
        delivered: delivered === null ? null : { path: delivered, present: await pathExists(delivered), by: 'pull' },
        runs: null,
        variant: await RuleFolders.languageFile(path.dirname(rule.sourcePath), 'RULE', teamConfig.language),
        reads,
      },
    });
  }

  return {
    type: 'rules',
    marker: RESOURCE_LAYOUTS.rules.marker ?? '',
    resources: [...resources, ...await recallResources(config, teamConfig)],
    problems: problems.flatMap(({ kind, path: at, message }) => (kind === 'invalid' ? [{ path: at, message }] : [])),
    notes: problems.flatMap(({ kind, message }) => (kind === 'note' ? [message] : [])),
  };
}

/** Each of teamai's default hooks, as pull reads the team's folder replacing it, against teamai's, for the team's `language`. */
async function defaultHookList(config: LocalConfig, language: TeamaiConfig['language']): Promise<DefaultHookResource[]> {
  const replacements = new Map((await readDefaultHookReplacements(config)).map((replacement) => [replacement.name, replacement]));

  // Each hook's comparison reads its own folders; one that throws is a teamai bug, and fails the page's data.
  return Promise.all(DefaultFolders.names('hooks').map(async (name): Promise<DefaultHookResource> => {
    const replacement = replacements.get(name);

    if (replacement === undefined) return { name, state: { kind: 'teamai' }, ...await DefaultFolders.compare({ kind: 'hooks', name: name }, null, language), delivered: null };

    if (replacement.kind === 'refused') {
      return { name, state: { kind: 'refused', path: replacement.path, messages: replacement.messages }, ...await DefaultFolders.compare({ kind: 'hooks', name: name }, replacement.files, language), delivered: null };
    }

    const { dest, files } = replacement.delivery;
    const { inheritance } = replacement;
    const inherited = inheritance ? { teamaiVersion: inheritance.teamaiVersion, own: files.length - inheritance.files.length, teamai: inheritance.files.length } : null;

    return { name, state: { kind: 'replaced', path: replacement.path, inherited }, ...await DefaultFolders.compare({ kind: 'hooks', name: name }, files, language), delivered: { path: dest, present: await pathExists(dest) } };
  }));
}

/** Every type's definitions in `config`'s scope, and teamai's default hooks there. Read-only: pull's sync runs dry. */
export async function collectLayeredResources(config: LocalConfig, teamConfig: TeamaiConfig): Promise<LayeredResources> {
  const wasSilent = isSilent();
  // The dry sync logs what a pull would; the page shows it instead.
  setSilent(true);

  try {
    const sync = await syncTeamDefinitions(config, { dryRun: true });

    return { language: teamConfig.language ?? null, types: [await workflowList(config, sync), await entryList(config, teamConfig, HOOKS), await entryList(config, teamConfig, MCP), await suiteList(config, sync), await ruleList(config, teamConfig)],
      defaultHooks: await defaultHookList(config, teamConfig.language) };
  } finally {
    setSilent(wasSilent);
  }
}

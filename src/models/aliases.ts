/**
 * Model aliases (#830): an agent names a kind of model (`model: strong`) and
 * the team says what that kind means in each tool, in `models/aliases.yaml`:
 *
 *   aliases:
 *     strong:
 *       claude: [{ model: opus, effort: high }, { model: fable }]
 *       codex:  { model: gpt-6-sol, effort: high }
 *
 * A role or project gets its own meaning in `models/<ns>/aliases.yaml`, read
 * where `<ns>` is active in `resources.models`, as model profiles are: its
 * alias replaces the root alias of the same name whole, and one name in two
 * active namespaces is a failure. A name any aliases file in the checkout
 * defines is an alias, active here or not, so one with no active definition
 * gives no model field rather than being written literally.
 *
 * A member replaces an entry on their machine in `~/.teamai/models/aliases.yaml`,
 * same shape, one file for every scope and team. There `~` or `default` for a
 * tool means that tool gets no model field.
 *
 * This module is the only place that interprets aliases. It loads the files a
 * scope reads, tells an alias from a literal model, and resolves one agent for
 * one tool. Renderers write what it resolves; nothing else reads the files.
 *
 * Resolution, first match wins: the tool's own extras `model` (the alias and
 * its effort are skipped), the member's local entry, the team entry (first
 * option), no model field. Each entry is whole: a local entry replaces the
 * team's, effort included. A tool switched to a model profile with
 * `teamai models switch` filters what the local or team entry gives: Claude
 * keeps `opus`, `sonnet` or `haiku`, which the switch routes to the gateway's
 * models, and every other switched tool gets no model, so it inherits one
 * natively. No switched tool gets an alias effort.
 *
 * A structural error in any of these files, active or not (bad YAML, wrong
 * types, a bad alias name, an effort without a model, `~` in a team file),
 * fails the load: no model can then be told from an alias, so agents with a
 * `model` are held. The member's file is the exception: it can make no name
 * an alias, so while only it fails, only agents whose `model` is an alias are
 * held. What this version does not know is dropped with a warning instead, so
 * a newer CLI's additions never freeze this one.
 */
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { getTeamaiHomeDir, type LocalConfig } from '../types.js';
import { activeEntryNamespaces, describeEntryFailure, entryLayout, listEntryFiles, namespaceDir, readEntryFileText, type EntryLayout } from '../namespaced-entries.js';
import { resolveNamespacedItems, type NamespaceCandidate } from '../namespace-resolver.js';
import { listDirs } from '../utils/fs.js';
import { liveModelSwitches, type LiveModelSwitch } from './switch.js';
import { agentEffortField, toolExtrasFor, type AgentSpec, type ToolName } from '../resources/agent-format.js';
import { AGENT_TOOLS, isAgentToolId } from '../tools.js';

/**
 * Alias names every team has, whether or not it maps them. A team maps one
 * by defining it. A name reserved in a later version keeps meaning the team's
 * alias wherever a team already defines it.
 */
const RESERVED_ALIASES = ['strong', 'fast'] as const;

/**
 * Names the tools already read as model aliases of their own, best effort and
 * kept short on purpose: a team alias named like one would silently change
 * what every agent with `model: opus` receives, so such an alias is dropped.
 * A full model id is not covered.
 */
const NATIVE_MODEL_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'default', 'auto', 'lite']);

const OPTION_FIELDS: ReadonlySet<string> = new Set(['model', 'effort']);

/** Repo-relative path of the root team aliases file; a namespace's is `models/<ns>/aliases.yaml`. */
export const TEAM_ALIASES_FILE = 'models/aliases.yaml';

/** The aliases files sit beside the model profiles and share their namespaces. */
const ALIASES_LAYOUT: EntryLayout = {
  ...entryLayout('models'),
  file: 'aliases.yaml',
  label: 'model aliases',
  noun: 'alias',
  kept: 'Model aliases were not resolved this run; agents whose model depends on them keep their deployed copies.',
};

/**
 * The member's override. Its keys have effect only where they name an alias
 * the team file or the reserved names define: one file serves every team.
 */
export function localAliasesPath(): string {
  return path.join(getTeamaiHomeDir(), 'models', 'aliases.yaml');
}

/**
 * In the local file, `~` or `default` for a tool sends it to its own default.
 * The team file rejects `~` and passes `default` through as a model, which is
 * CodeBuddy's native value for its default model.
 */
const LOCAL_DEFAULT = 'default';

/** The Claude aliases a switch points at the gateway's models of that family. */
const SWITCH_ROUTED_CLAUDE_MODELS: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku']);

const ALIAS_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Tools that share another tool's model catalog read its entry when they have
 * none of their own. Not the extras inheritance: that one covers only tclaude
 * and tcodex (`toolExtrasFor`).
 */
const ALIAS_BASE_TOOL: Partial<Record<ToolName, ToolName>> = {
  'claude-internal': 'claude',
  tclaude: 'claude',
  'codex-internal': 'codex',
  tcodex: 'codex',
  'qoder-cn': 'qoder',
};

const OptionSchema = z.union([
  z.string().min(1),
  z.object({ model: z.string().min(1), effort: z.string().min(1).optional() }),
]);
type AliasOption = z.infer<typeof OptionSchema>;

/**
 * Tool id to one option or an ordered list, only the first option used, or
 * null (`~`), which only the local file accepts. What this version does not
 * know is gone by now (`dropUnknownEntries`).
 */
const AliasSchema = z.record(z.string(), z.union([z.null(), OptionSchema, z.array(OptionSchema).min(1)]));

const AliasesFileSchema = z.object({
  aliases: z.record(
    z.string().regex(ALIAS_NAME_RE, 'alias names start with a lowercase letter, then lowercase letters, digits or hyphens'),
    AliasSchema,
  ).nullish(),
});

type AliasEntry = AliasOption | AliasOption[] | null;
type AliasEntries = Record<string, AliasEntry>;

/**
 * Something a file sets that no tool receives as written, dropped with a
 * message. With `tool`, it is about that tool key's entry of `alias` in
 * `file`; without, about the alias as a whole. `file` is a team file's
 * repo-relative path or the local file's absolute path.
 */
export interface AliasWarning {
  readonly alias: string;
  readonly file: string;
  readonly tool?: ToolName;
  readonly message: string;
}

/** One team alias as this scope reads it, and the repo-relative file it comes from. */
export interface TeamAlias {
  readonly entries: AliasEntries;
  readonly source: string;
}

/** A namespace aliases file `resources.models` does not activate here. */
export interface InactiveAliasFile {
  readonly namespace: string;
  readonly source: string;
}

/** The aliases a scope reads, or why they cannot be read. */
export type ModelAliases =
  | {
    readonly ok: true;
    /** Every alias name: reserved, and defined in any team aliases file of the checkout, active or not. */
    readonly names: ReadonlySet<string>;
    /** The root aliases, each replaced whole by an active namespace's alias of its name. */
    readonly team: ReadonlyMap<string, TeamAlias>;
    /** By alias name, the inactive namespace files that define it. */
    readonly inactive: ReadonlyMap<string, readonly InactiveAliasFile[]>;
    /** The member's override, for the names in `names` only. */
    readonly local: ReadonlyMap<string, AliasEntries>;
    /**
     * Why the member's override cannot be read. It may replace any entry, so
     * no alias resolves meanwhile; a literal model still does, since only the
     * team files make a name an alias.
     */
    readonly localFailure?: string;
    /**
     * Every entry the files set that was dropped, one actionable message
     * each. Pull prints those an agent it delivers uses (`aliasWarningsFor`).
     */
    readonly warnings: readonly AliasWarning[];
    /**
     * Each tool `models switch` can switch, by its own id: a variant such as
     * tclaude has no entry, so it is never switched.
     */
    readonly switches: Readonly<Partial<Record<ToolName, LiveModelSwitch>>>;
  }
  | { readonly ok: false; readonly reason: string };

/**
 * Which resolution step produced a tool's model: `literal` when `model` is not
 * an alias. `local` without a model is the member's `~` or `default`.
 * `switched` is a local or team model the switch filtered: Claude's family
 * alias it kept, or no model.
 */
export type ResolutionStep = 'extras' | 'literal' | 'switched' | 'local' | 'team' | 'default';

/**
 * What one tool receives for an agent's model, or why it cannot be resolved.
 * `effort` is present only when the alias produced it: an effort the tool's
 * extras set is the extras' own, and the step `extras` skips the alias whole.
 * `source` is the file whose alias decided it: a team file's repo-relative
 * path, or the local file's absolute path. A tool the team alias does not map
 * gets `default` with that alias's file; a name no active file defines, none.
 */
export type ModelResolution =
  | { readonly ok: true; readonly step: ResolutionStep; readonly model?: string; readonly effort?: string; readonly source?: string }
  | { readonly ok: false; readonly reason: string };

/** Why a value gives the tool no model: no entry for it, the member's `~` or `default`, a model switch, or an error. */
export type NoModel = 'unmapped' | 'local' | 'switched' | 'unresolved';

/** Why a resolution step gives no model. The only other one that can is `default`: the alias does not map the tool. */
const NO_MODEL_STEPS: Partial<Record<ResolutionStep, NoModel>> = { local: 'local', switched: 'switched' };

/** Why a resolution that gives the tool no model gives none. */
export function noModelReason(resolution: ModelResolution): NoModel {
  return resolution.ok ? NO_MODEL_STEPS[resolution.step] ?? 'unmapped' : 'unresolved';
}

/** Why `resolution` gives `tool` no model, worded to follow "which": `has no model for codex in models/aliases.yaml`. */
export function noModelCause(resolution: ModelResolution, tool: string): string {
  const source = (resolution.ok && resolution.source) || TEAM_ALIASES_FILE;
  const reason = noModelReason(resolution);
  switch (reason) {
    case 'unmapped': return `has no model for ${tool} in ${source}`;
    case 'local': return `${source} turns off for ${tool}`;
    case 'switched': return `gives no model for ${tool} while teamai models switch points ${tool} at a model profile`;
    case 'unresolved': return `cannot be resolved for ${tool}: ${resolution.ok ? '' : resolution.reason}`;
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}

/** Why `value` cannot be a `model`, worded to follow "model", or undefined when it can: an alias or a model name as is. */
export function modelValueProblem(value: string | undefined): string | undefined {
  if (value?.includes('{{')) return 'cannot contain a template; write an alias or a model name as is';
  if (!value || /\s/.test(value)) return 'must be a non-empty string without spaces';
  return undefined;
}

/**
 * Load the aliases `localConfig`'s scope reads: the team files of its
 * checkout and the member's override. A missing file is an empty mapping, so
 * `strong` and `fast` resolve to no model field.
 */
export async function loadModelAliases(localConfig: LocalConfig): Promise<ModelAliases> {
  const team = await loadTeamModelAliases(localConfig);
  if (!team.ok) return team;
  const { names } = team;
  const localPath = localAliasesPath();
  const read = await readAliasesFile(localPath, localPath);
  const local = read.ok ? read : { aliases: new Map<string, AliasEntries>(), warnings: [] };
  // Read once per load, and only matters for aliases: a literal model is written as is.
  const switches = await liveModelSwitches(localConfig);
  // A local name no team here defines is another team's: it has no effect, so no warning either.
  const localHere = new Map([...local.aliases].filter(([alias]) => names.has(alias)));
  return {
    ...team,
    local: localHere,
    ...(read.ok ? {} : { localFailure: read.reason }),
    warnings: [
      ...team.warnings,
      // A native name is in no team's `names`: the member meant it for all of them.
      ...local.warnings.filter(({ alias }) => names.has(alias) || NATIVE_MODEL_ALIASES.has(alias)),
      ...[...localHere].flatMap(([alias, entries]) => droppedEffortWarnings(alias, entries, localPath)),
    ],
    switches,
  };
}

/** The aliases the team files alone give, with no member override and no model switch, as `review --branch` checks them. */
export async function loadTeamModelAliases(localConfig: LocalConfig): Promise<ModelAliases> {
  const team = await loadTeamAliases(localConfig);
  if (!team.ok) return team;
  return {
    ok: true,
    names: new Set<string>([...RESERVED_ALIASES, ...team.names]),
    team: team.active,
    inactive: team.inactive,
    local: new Map(),
    warnings: team.warnings,
    switches: {},
  };
}

/**
 * Every team aliases file of the checkout, the root one and each
 * `models/<ns>/aliases.yaml`, is read whole: a name any of them defines is an
 * alias here, active or not, so one that cannot be read fails the load. Only
 * the root and the namespaces active in `resources.models` are resolved, with
 * the rule model profiles follow. Warnings are kept for the entries resolved.
 */
async function loadTeamAliases(localConfig: LocalConfig): Promise<
  | {
    ok: true;
    names: Set<string>;
    active: Map<string, TeamAlias>;
    inactive: Map<string, InactiveAliasFile[]>;
    warnings: AliasWarning[];
  }
  | { ok: false; reason: string }
> {
  const repoPath = localConfig.repo.localPath;
  const files: Array<{ namespace: string | null; source: string; aliases: Map<string, AliasEntries>; warnings: AliasWarning[] }> = [];
  for (const { namespace, relativePath, absolutePath } of await listEntryFiles(repoPath, ALIASES_LAYOUT)) {
    const read = await readAliasesFile(absolutePath, relativePath);
    if (!read.ok) return read;
    const optOut = [...read.aliases].flatMap(([alias, entries]) => Object.keys(entries).filter((tool) => entries[tool] === null).map((tool) => `${alias}.${tool}`));
    if (optOut.length > 0) {
      return {
        ok: false,
        reason: `Invalid model aliases file at ${relativePath}: ${optOut.join(', ')}: ~ is accepted only in a member's ${localAliasesPath()}. `
          + 'Remove the entry to leave the tool on its default model',
      };
    }
    files.push({ namespace, source: relativePath, ...read });
  }

  // Each active namespace reads the directory model profiles read for it. Its
  // file is its candidate, named by the namespace as declared.
  const activeDirs = new Map<string, string>();
  const active = files.some((file) => file.namespace !== null) ? await activeEntryNamespaces(localConfig, ALIASES_LAYOUT) : { ok: true as const, active: null };
  if (!active.ok) {
    const { failure } = active;
    const cause = failure.kind === 'namespaces-unresolved' ? failure.reason : describeEntryFailure(failure);
    return { ok: false, reason: `The models namespaces of your roles and projects cannot be resolved: ${cause}` };
  }
  if (active.active !== null) {
    const dirs = await listDirs(path.join(repoPath, 'models'));
    for (const namespace of active.active) {
      const dir = namespaceDir(dirs, namespace);
      if (!activeDirs.has(dir)) activeDirs.set(dir, namespace);
    }
  }

  const candidates: NamespaceCandidate<AliasEntries>[] = [];
  const inactive = new Map<string, InactiveAliasFile[]>();
  for (const file of files) {
    const namespace = file.namespace === null ? null : activeDirs.get(file.namespace);
    for (const [name, entries] of file.aliases) {
      if (namespace !== undefined) candidates.push({ name, source: file.source, namespace, value: entries });
      else inactive.set(name, [...inactive.get(name) ?? [], { namespace: file.namespace!, source: file.source }]);
    }
  }
  const resolution = resolveNamespacedItems(candidates, active.active ?? []);
  if (resolution.kind === 'conflict') {
    return {
      ok: false,
      reason: `Model alias "${resolution.name}" is defined in both ${resolution.first.source} and ${resolution.second.source}, and both `
        + 'namespaces are active here, so nothing says which one you should receive. Rename or remove it in one of the files, '
        + 'or stop declaring one of the namespaces for your roles and projects',
    };
  }
  const resolved = new Map(resolution.items.map((item) => [item.name, { entries: item.value, source: item.source }]));
  // A replaced root alias is not read, so neither are its warnings. An alias
  // dropped for its native name is in no file's resolved set and keeps them.
  const readSources = new Set([null, ...activeDirs.keys()]);
  const warnings = files
    .filter((file) => readSources.has(file.namespace))
    .flatMap((file) => file.warnings)
    .filter((warning) => (resolved.get(warning.alias)?.source ?? warning.file) === warning.file);
  return {
    ok: true,
    names: new Set(files.flatMap((file) => [...file.aliases.keys()])),
    active: resolved,
    inactive,
    warnings: [...warnings, ...[...resolved].flatMap(([alias, { entries, source }]) => droppedEffortWarnings(alias, entries, source))],
  };
}

/**
 * One aliases file, `label` naming it in messages and warnings. A structural
 * error fails it whole; what this version does not know is dropped with a
 * warning.
 */
async function readAliasesFile(
  absolutePath: string,
  label: string,
): Promise<{ ok: true; aliases: Map<string, AliasEntries>; warnings: AliasWarning[] } | { ok: false; reason: string }> {
  const read = await readEntryFileText(absolutePath, label);
  if (!read.ok) return read;
  let document: unknown = null;
  try {
    document = read.text === null ? null : YAML.parse(read.text);
  } catch (error) {
    // The parser's first line names the problem and its position; the code frame under it would split every message it is quoted in.
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replace(/:\s*$/, '');
    return { ok: false, reason: `Invalid model aliases YAML at ${label}: ${message}` };
  }
  // A file without its top-level key is broken, not empty, as for env.yaml
  // (#662): a misspelled `aliases:` would otherwise take every alias away.
  // Other keys beside it are left for a newer version.
  if (isRecord(document) && Object.keys(document).length > 0 && !('aliases' in document)) {
    const found = Object.keys(document).map((key) => `\`${key}\``).join(', ');
    return {
      ok: false,
      reason: `Invalid model aliases file at ${label}: it has no top-level \`aliases:\` key (found ${found}), so it defines no aliases. `
        + 'Put the alias names under `aliases:`',
    };
  }
  const known = dropUnknownEntries(document ?? {}, label);
  const parsed = AliasesFileSchema.safeParse(known.document);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Invalid model aliases file at ${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }
  return { ok: true, aliases: new Map(Object.entries(parsed.data.aliases ?? {})), warnings: known.warnings };
}

/**
 * Take out what this version does not know before the schema sees it, so a
 * newer CLI's additions never fail the file: an alias named like a native
 * model alias, a tool key that is not a tool and an option field other than
 * `model` and `effort`, each with a warning, and `gateways`, reserved for
 * mappings keyed by model profile, silently. Whatever is not shaped like an
 * alias map is left for the schema to reject.
 */
function dropUnknownEntries(document: unknown, file: string): { document: unknown; warnings: AliasWarning[] } {
  if (!isRecord(document) || !isRecord(document['aliases'])) return { document, warnings: [] };
  const warnings: AliasWarning[] = [];
  const aliases: Record<string, unknown> = {};
  for (const [alias, value] of Object.entries(document['aliases'])) {
    if (NATIVE_MODEL_ALIASES.has(alias)) {
      warnings.push({ alias, file, message: `${file}: alias "${alias}" has the name of a tool's own model alias, so it is ignored `
        + `and agents with model: ${alias} receive ${alias} as written. Rename the alias, such as "${alias}-team".` });
      continue;
    }
    if (!isRecord(value)) {
      aliases[alias] = value;
      continue;
    }
    const entries: Record<string, unknown> = {};
    for (const [tool, entry] of Object.entries(value)) {
      if (tool === 'gateways') continue;
      if (!isAgentToolId(tool)) {
        warnings.push({ alias, file, message: `${file}: alias "${alias}" maps "${tool}", which is not a tool teamai knows, so that entry `
          + 'is ignored. Fix the tool id, or update teamai if a newer version added that tool.' });
        continue;
      }
      const unknown = new Set<string>();
      const withoutUnknown = (option: unknown): unknown => {
        if (!isRecord(option)) return option;
        const fields = Object.keys(option).filter((field) => !OPTION_FIELDS.has(field));
        for (const field of fields) unknown.add(field);
        return fields.length === 0 ? option : Object.fromEntries(Object.entries(option).filter(([field]) => OPTION_FIELDS.has(field)));
      };
      entries[tool] = Array.isArray(entry) ? entry.map(withoutUnknown) : withoutUnknown(entry);
      if (unknown.size > 0) {
        const fields = [...unknown].map((field) => `"${field}"`).join(', ');
        warnings.push({ alias, file, tool, message: `${file}: alias "${alias}" sets ${fields} for ${tool}, which teamai `
          + `does not know, so ${tool} receives that entry without it. Remove it, or update teamai if a newer version added it.` });
      }
    }
    aliases[alias] = entries;
  }
  return { document: { ...document, aliases }, warnings };
}

/**
 * An effort mapped for a tool whose agent files TeamAI writes no effort field
 * for is dropped: the tool receives the model alone. One message per alias
 * and tool, however many of its options set an effort.
 */
function droppedEffortWarnings(alias: string, entries: AliasEntries, file: string): AliasWarning[] {
  const warnings: AliasWarning[] = [];
  for (const tool of AGENT_TOOLS) {
    const entry = entries[tool];
    if (entry === undefined || entry === null || agentEffortField(tool) !== undefined) continue;
    const withEffort = (Array.isArray(entry) ? entry : [entry]).find((option) => typeof option !== 'string' && option.effort !== undefined);
    if (withEffort === undefined || typeof withEffort === 'string') continue;
    const hint = tool === 'cursor'
      ? `Remove it, or write it into the model in Cursor's bracket form, such as "${withEffort.model}[effort=${withEffort.effort}]".`
      : `Remove effort from ${alias}.${tool} to silence this warning.`;
    warnings.push({ alias, file, tool, message: `${file}: alias "${alias}" sets an effort for ${tool}, but effort is not supported for `
      + `${tool} agent files, so ${tool} receives the model without it. ${hint}` });
  }
  return warnings;
}

/**
 * Whether `model` names an alias. While the aliases cannot be read, only the
 * reserved names are known to be aliases.
 */
export function isModelAlias(aliases: ModelAliases, model: string): boolean {
  return aliases.ok ? aliases.names.has(model) : (RESERVED_ALIASES as readonly string[]).includes(model);
}

/**
 * The warnings about what `tool` receives for `spec`: those about its alias as
 * a whole, and those about the entry its model comes from. A tool whose
 * extras model skips the alias, or that is switched, receives no entry as
 * written. Pull prints only these, so a member hears of an entry only when an
 * agent they receive uses it; doctor lists them all.
 */
export function aliasWarningsFor(aliases: ModelAliases, spec: AgentSpec, tool: ToolName): string[] {
  if (!aliases.ok || spec.model === undefined) return [];
  const alias = spec.model;
  const extrasModel = toolExtrasFor(spec, tool)?.['model'] !== undefined;
  const switched = aliases.switches[tool];
  const readsEntry = !extrasModel && !(switched?.ok === true && switched.switched);
  const entry = entrySource(aliases, alias, tool);
  const source = readsEntry ? entry : undefined;
  // No active file defines the alias and no local entry maps this tool: its model is gone.
  const inactiveOnly = !extrasModel && entry === undefined && !aliases.team.has(alias) ? aliases.inactive.get(alias) : undefined;
  return [
    ...aliases.warnings
      .filter((warning) => warning.alias === alias
        && (warning.tool === undefined || (warning.file === source?.file && warning.tool === source.key)))
      .map((warning) => warning.message),
    ...(inactiveOnly ? [inactiveOnlyWarning(alias, inactiveOnly)] : []),
  ];
}

/**
 * An alias only inactive namespace files define takes the agent's `model`
 * away here, which a name that is also a model id makes easy to miss. The
 * text names no tool or agent, so pull says it once per alias.
 */
function inactiveOnlyWarning(alias: string, files: readonly InactiveAliasFile[]): string {
  const list = (items: string[]): string => (items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
  const namespaces = [...new Set(files.map(({ namespace }) => namespace))];
  const whose = namespaces.length === 1 ? `whose namespace "${namespaces[0]}"` : `whose namespaces ${list(namespaces.map((ns) => `"${ns}"`))}`;
  return `Model alias "${alias}" is defined only in ${list(files.map(({ source }) => source))}, ${whose} your roles and projects `
    + `do not list in resources.models, so agents with model: ${alias} get no model field here and each tool uses its default model. `
    + `If the alias should apply to you, add ${namespaces.map((ns) => `\`models: [${ns}]\``).join(' or ')} to the resources of your role `
    + `in manifest/roles.yaml or of your project in manifest/projects.yaml. If "${alias}" is meant as a concrete model, rename the alias.`;
}

/** Which file's entry, under which tool key, `fromEntries` reads for `tool`. */
function entrySource(aliases: ModelAliases & { ok: true }, alias: string, tool: ToolName): { file: string; key: string } | undefined {
  const local = entryKey(aliases.local.get(alias), tool);
  if (local !== undefined) return { file: localAliasesPath(), key: local };
  const team = aliases.team.get(alias);
  const key = entryKey(team?.entries, tool);
  return team !== undefined && key !== undefined ? { file: team.source, key } : undefined;
}

/** What `tool` receives for `spec`'s model. */
export function resolveAgentModel(aliases: ModelAliases, spec: AgentSpec, tool: ToolName): ModelResolution {
  const extras = toolExtrasFor(spec, tool);
  const extrasModel = extras?.['model'];
  if (extrasModel !== undefined) {
    return { ok: true, step: 'extras', ...(typeof extrasModel === 'string' ? { model: extrasModel } : {}) };
  }
  if (spec.model === undefined) return { ok: true, step: 'default' };
  return resolveModelValue(aliases, spec.model, tool, extras);
}

/**
 * What `tool` receives for a model value, an alias or a model name. `extras`
 * are the tool extras of the agent that names it: an effort they set wins
 * over the alias's.
 */
export function resolveModelValue(aliases: ModelAliases, model: string, tool: ToolName, extras?: Record<string, unknown>): ModelResolution {
  // An unreadable team file may define any name, so no model can be told literal.
  if (!aliases.ok) return aliases;
  if (!aliases.names.has(model)) return { ok: true, step: 'literal', model };
  if (aliases.localFailure !== undefined) return { ok: false, reason: aliases.localFailure };

  const switched = aliases.switches[tool];
  if (switched?.ok === false) {
    return { ok: false, reason: `Cannot tell whether a tool is switched to a model profile: ${switched.reason}` };
  }
  const resolution = fromEntries(aliases, model, tool, extras);
  return switched?.switched ? throughSwitch(resolution, tool, extras) : resolution;
}

/** What the member's local entry, else the team entry, gives `tool` for `alias`. */
function fromEntries(aliases: ModelAliases & { ok: true }, alias: string, tool: ToolName, extras: Record<string, unknown> | undefined): ModelResolution {
  const localPath = localAliasesPath();
  const local = toolEntry(aliases.local.get(alias), tool);
  if (local === null || local === LOCAL_DEFAULT) return { ok: true, step: 'local', source: localPath };
  if (local !== undefined) return fromOption('local', local, tool, extras, localPath);
  const team = aliases.team.get(alias);
  const entry = toolEntry(team?.entries, tool);
  if (team === undefined) return { ok: true, step: 'default' };
  if (entry === undefined || entry === null) return { ok: true, step: 'default', source: team.source };
  return fromOption('team', entry, tool, extras, team.source);
}

/**
 * What a switched tool keeps of `resolution`: the gateway receives only what
 * the switch routes, and no effort at all: step `switched` also drops the
 * effort field the tool's extras set (only an extras `model`, a step above,
 * keeps them). A resolution with no model, such as the member's opt-out, has
 * nothing to filter and keeps its step, unless there is such an effort.
 */
function throughSwitch(resolution: ModelResolution, tool: ToolName, extras: Record<string, unknown> | undefined): ModelResolution {
  if (!resolution.ok) return resolution;
  const effortField = agentEffortField(tool);
  const extrasEffort = effortField !== undefined && extras?.[effortField] !== undefined;
  if (resolution.model === undefined && !extrasEffort) return resolution;
  const source = resolution.source !== undefined ? { source: resolution.source } : {};
  if (resolution.model === undefined) return { ok: true, step: 'switched', ...source };
  return tool === 'claude' && SWITCH_ROUTED_CLAUDE_MODELS.has(resolution.model)
    ? { ok: true, step: 'switched', model: resolution.model, ...source }
    : { ok: true, step: 'switched', ...source };
}

/** `tool`'s entry in one file's alias, its own key before the tool it inherits from. */
function toolEntry(entries: AliasEntries | undefined, tool: ToolName): AliasEntry | undefined {
  const key = entryKey(entries, tool);
  return key === undefined ? undefined : entries![key];
}

/** The key of `tool`'s entry in one file's alias. */
function entryKey(entries: AliasEntries | undefined, tool: ToolName): string | undefined {
  if (entries === undefined) return undefined;
  if (Object.hasOwn(entries, tool)) return tool;
  const base = ALIAS_BASE_TOOL[tool];
  return base !== undefined && Object.hasOwn(entries, base) ? base : undefined;
}

/**
 * What the first option of `entry` gives `tool`. The effort is kept only for
 * a tool with an effort field that its extras do not set.
 */
function fromOption(
  step: 'local' | 'team',
  entry: AliasOption | AliasOption[],
  tool: ToolName,
  extras: Record<string, unknown> | undefined,
  source: string,
): ModelResolution {
  const first = Array.isArray(entry) ? entry[0]! : entry;
  const option = typeof first === 'string' ? { model: first } : first;
  const effortField = agentEffortField(tool);
  const effort = option.effort !== undefined && effortField !== undefined && extras?.[effortField] === undefined
    ? option.effort
    : undefined;
  return { ok: true, step, model: option.model, ...(effort !== undefined ? { effort } : {}), source };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

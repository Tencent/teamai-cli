import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  LocalConfig,
  TeamaiConfig,
  McpServerDef,
  ManagedMcpManifest,
  ManagedMcpRecord,
  ToolId,
} from './types.js';
import {
  DEFAULT_TOOL_PATHS,
  getMcpSharing,
  isAgentExcluded,
  getDataHome,
  isGitExcludeEnabled,
  isSelfMode,
  MUSE_TOOL_ID,
  managedMcpManifestPath,
  managedMcpManifestKey,
  resolveBaseDir,
} from './types.js';
import YAML from 'yaml';
import {
  supportsTransport,
  supportsEnvExpansion,
  renderJsonEntry,
  renderCodexBlock,
  resolvePlaceholders,
  referencedVars,
  entryHash,
  museEntryHash,
  MCP_SERVER_KEY,
  sameServerKey,
  type McpFormat,
} from './resources/mcp-format.js';
import { mcpEntryReader, parseTeamMcpServers, teamMcpToDef } from './resources/mcp.js';
import { historicalContents } from './utils/team-history.js';
import { describeMembersFile, keepsTrackedCopy } from './resources/delivered-copies.js';
import { envName, envTable } from './resources/env-key.js';
import { isReservedTeamEnvKey, reservedTeamEnvWarning } from './env-reserved.js';
import { declaredSecretKeys, type SecretDeclarations } from './resources/secrets.js';
import { appliedTeamEnv, resolvesTeamEnv, resolveTeamEnv, variablesKeptWarning, type TeamEnv } from './env-resolution.js';
import { readEnvBackup } from './resources/env.js';
import { isEnvShMarker } from './env-sh-exports.js';
import { memberEnvironmentWithoutScope } from './member-env.js';
import { cleanupOf, installOf, locate, ownOf, writable, type EntryPlace, type Install } from './locate.js';
import { channelsOf, isToolId, mcpFormatOf, hasDefaultHomeLeftovers, TOOLS, type McpProject } from './tools.js';
import { realHost, type Host } from './tool-home.js';
import { KNOWN_AGENTS } from './known-agents.js';
import { entryLayout, reportEntryResolution, resolveEntriesFor } from './namespaced-entries.js';
import {
  readJson,
  writeJsonAtomic,
  symlinkTarget,
  readFileSafe,
  readFileIfExists,
  pathExists,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';
import { loadProjectMcpManifest } from './utils/mcp-manifest.js';
import { isOnPath, SAFE_BIN_RE, type LookPathOptions } from './utils/lookpath.js';
import {
  carriesLocalAgentCredential,
  carriesResolvedValue,
  ensureExcludedFromGit,
  excludeFromGit,
  findMcpGitExcludes,
  mcpExcludePatternPath,
  removeMcpGitExclude,
  resolvedVariableIn,
  type GitExclusion,
} from './mcp-git-exclude.js';
import { gitTracks, gitUntracked, realFilePath } from './git-exclude.js';
import { opencodeDeliversThroughPlugin } from './opencode-hooks.js';
import { createGit, getFileContentAtRev } from './utils/git.js';
import {
  readResolvedMcpFiles,
  recordUnverifiedMcpServers,
  settleResolvedMcpFiles,
  trackResolvedMcpFiles,
  untrackResolvedMcpFiles,
  type McpFileObservation,
} from './mcp-resolved-files.js';
import { hasWorkspaceChildren } from './workspace-children.js';

// ─── Reconcile engine ────────────────────────────────────────
//
//  Injects team MCP servers into each tool's own config file, idempotently.
//
//  The files here are NOT owned by teamai — ~/.claude.json also holds the OAuth
//  session and all per-project state, and ~/.codex/config.toml holds model and
//  trust settings. So every write is key-level surgery on an existing document,
//  never a regenerate-from-scratch, and never a whole-file TOML round-trip
//  (which would silently drop the user's comments).
//
//  Ownership lives in ~/.teamai/managed-mcp.json rather than a marker inside the
//  entry, because MCP entries have no field we can safely stamp. Only keys the
//  manifest claims are ever rewritten or removed; anything the user added by
//  hand is left strictly alone.

export interface McpReconcileOptions {
  /** Remove all teamai-managed servers instead of injecting the desired set. */
  removeAll?: boolean;
  /** Report intended changes without touching disk. */
  dryRun?: boolean;
  /** Overwrite user-owned servers that collide by name. */
  force?: boolean;
  /**
   * Override PATH lookup for `requires`. Production inject omits this and
   * reads `process.env` / `process.platform`. Tests inject win32 + PATHEXT
   * without mutating the host platform.
   */
  lookPath?: LookPathOptions;
  /** This scope's env, when the caller already resolved it (env-resolution.ts). */
  teamEnv?: TeamEnv;
}

export interface McpChange {
  tool: string;
  server: string;
  action: 'added' | 'updated' | 'removed' | 'skipped';
  reason?: string;
  /** Skipped because `file` holds the member's own server of this name (#993). */
  member?: true;
  file?: string;
}

const UNRECORDED_SERVER_REASON = 'a server with this name already exists and is not managed by teamai';

/** The dry-run line for an unrecorded copy of a server the team removed, which a run would remove (#993). */
function describeRemovedServerPreview(target: McpTarget, name: string): string {
  return `Would remove MCP server ${name} from ${target.file}: it equals a server the team has removed.`;
}

/** The dry-run line for an unrecorded server pull would record as teamai's without rewriting it (#993). */
function describeAdoptionPreview(target: McpTarget, name: string): string {
  return `Would record MCP server ${name} in ${target.file} as teamai's: it already holds the team's ${name}.`;
}

/**
 * The line naming a member's own server a reconcile kept (#993): one with a
 * team server's name that teamai has no record of and that matches no team
 * version of it.
 */
export function describeKeptMemberServer(server: string, file: string): string {
  return describeMembersFile(`MCP server ${server} in ${file}`, server);
}

export interface McpReconcileResult {
  changes: McpChange[];
  /** True when any file was actually written. */
  wrote: boolean;
  /**
   * Set when the team's servers, or the secrets they may need, could not be
   * resolved (a file that does not parse, a name twice): nothing was changed,
   * and the reason was reported.
   */
  unresolved?: true;
  /**
   * Set when a tool's own MCP config did not parse, so that tool was left as it
   * was. The team's servers were read, so this is not `unresolved`: pull still
   * warns and continues. `env set` and `env unset` treat it as not reconciled.
   */
  unparsed?: true;
}

// ─── Manifest ────────────────────────────────────────────────

async function readManifest(manifestPath: string): Promise<ManagedMcpManifest> {
  const data = await readJson<ManagedMcpManifest>(expandHome(manifestPath));
  return data && typeof data === 'object' ? data : {};
}

// ─── Secret lookup ───────────────────────────────────────────

/**
 * Build the ${VAR} lookup table: the team env variables this member receives
 * (root plus active namespace files, the same set pull writes env.sh from),
 * each with the member's value for this team when they set one, then process
 * env for every other key; it no longer overrides a team variable (#875).
 * A declared secret (#875) resolves from the
 * member's value for this team, then their value for the machine, then their
 * own environment (not a value a teamai env.sh exported); its env.yaml value,
 * if the team also sets one, is ignored.
 *
 * The variables are what `env exec` applies (`appliedTeamEnv`): the user
 * variables a project inherits under its own, each part by its own scope's
 * state, and the installed env backup of a part that can't be resolved
 * (pull then keeps env.sh as it is, so MCP sees what the shell sees). The
 * backup is read too when the team has no repo tree to resolve it from (HTTP
 * mode, which declares no secrets, unless a project inherits the user scope:
 * see `resolvesTeamEnv`).
 *
 * `teamEnv` is for a caller that already resolved it, so one command reads
 * each file once. HTTP mode without that inheritance ignores it.
 */
export async function buildVarTable(localConfig: LocalConfig, teamEnv?: TeamEnv): Promise<Record<string, string>> {
  const table = envTable<string>();
  const resolved = resolvesTeamEnv(localConfig) ? teamEnv ?? await resolveTeamEnv(localConfig) : null;
  const secretKeys = resolved ? declaredSecretKeys(resolved.declarations) : new Set<string>();
  const reservedWarning = reservedTeamEnvWarning([
    ...(resolved?.variables.kind === 'resolved' ? resolved.variables.entries.map(({ name }) => name) : []),
    ...(secretKeys ?? []),
  ]);
  if (reservedWarning) warnOnce(reservedWarning);
  const isSecret = (key: string): boolean => !isReservedTeamEnvKey(key) && (secretKeys?.has(key) ?? false);
  if (resolved) {
    // Each part by its own scope's state, as `env exec` applies it: one that
    // can't be resolved keeps what its last pull wrote, as its shells do.
    for (const values of [resolved.variableValues, resolved.inheritedValues]) {
      if (values.kind === 'store-unreadable') warnOnce(variablesKeptWarning(values.reason));
    }
    for (const [key, value] of appliedTeamEnv(resolved).variables) table[key] = value;
  } else {
    for (const [key, value] of Object.entries(await readEnvBackup(localConfig))) if (!isReservedTeamEnvKey(key)) table[key] = value;
  }
  // The environment fills only what the team sets nothing for (#875): a
  // member overrides a team variable with `teamai env set`, for that team.
  // Only the member's own value (member-env.ts), as `env exec` gives a command:
  // a shell that left another directory still carries that scope's env.sh (#1018).
  // An env.sh marker says what a shell sourced, and is no server's value.
  // On Windows `api_url` is the team's `API_URL`: names compare as the platform does.
  const teamSet = new Set(Object.keys(table).map(envName));
  const member = resolved?.member ?? await memberEnvironmentWithoutScope([getDataHome(localConfig)]);
  for (const k of Object.keys(process.env)) {
    const v = member(k);
    if (v !== undefined && !isSecret(k) && !isEnvShMarker(k) && !teamSet.has(envName(k))) table[k] = v;
  }
  if (!resolved || !secretKeys || secretKeys.size === 0) return table;
  if (resolved.secrets.kind === 'store-unreadable') {
    warnOnce(`${resolved.secrets.reason} Team secrets have no value until it is fixed.`);
    return table;
  }
  for (const [key, secret] of resolved.secrets.values) if (!isReservedTeamEnvKey(key)) table[key] = secret.value;
  return table;
}

// ─── Security gate ───────────────────────────────────────────

function hostAllowed(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allowedHosts.some((pattern) =>
    pattern.startsWith('*.')
      ? host === pattern.slice(2) || host.endsWith(pattern.slice(1))
      : host === pattern,
  );
}

/** Reject a server that the team's security policy disallows. Returns a reason, or null when OK. */
function policyViolation(def: McpServerDef, sharing: ReturnType<typeof getMcpSharing>): string | null {
  if (def.transport === 'stdio') {
    const { allowedCommands } = sharing;
    if (allowedCommands.length > 0 && def.command && !allowedCommands.includes(def.command)) {
      return `command "${def.command}" is not in sharing.mcp.allowedCommands`;
    }
  } else if (def.url && !hostAllowed(def.url, sharing.allowedHosts)) {
    return `host is not in sharing.mcp.allowedHosts`;
  }
  return null;
}

/** True when every executable in `requires` is on PATH. Returns a reason, or null when OK. */
function requirementsMet(def: McpServerDef, lookPath?: LookPathOptions): string | null {
  if (!def.requires?.length) return null;
  for (const bin of def.requires) {
    // `requires` comes from the team repo's mcp.yaml. Reject anything that is
    // not a bare executable name so a value like `npx; rm -rf ~` is never
    // interpolated into a PATH entry or handed to a shell.
    if (!SAFE_BIN_RE.test(bin)) {
      return `required executable "${bin}" has an invalid name`;
    }
    if (!isOnPath(bin, lookPath)) {
      return `required executable "${bin}" not found on PATH`;
    }
  }
  return null;
}

// ─── Tool targeting ──────────────────────────────────────────

export interface McpTarget {
  tool: string;
  format: McpFormat;
  /** Absolute path of the config file to edit. */
  file: string;
  projectScope: boolean;
  /**
   * Added by `includeUndetected`: the built-in location of a tool the team maps
   * elsewhere or not at all. No mapping of today's reaches it for this tool.
   */
  builtinFallback?: true;
  /** Added by `includeUndetected`: a tool not installed on this machine, so no pull of this checkout delivers to it. */
  undetected?: true;
  /**
   * Set when `file` is the first existing of the files the tool reads
   * (#993), or OpenCode's plugin file: the file its mapping names, where a
   * record with no `file` has its server (every teamai before #993 wrote there).
   */
  mappedFile?: string;
  /** With `mappedFile`: every file of the tool's lookup order, in order. */
  lookupFiles?: string[];
  /** OpenCode's project file its V2 plugin delivers from (#915): the one of `mappedFile` and this that `file` is not holds no team server. */
  alternateFile?: string;
  /** Files an earlier release wrote the tool's servers to, under their key then, which it no longer reads: teamai moves its servers out of them. */
  retired?: Array<{ file: string; key: McpKey }>;
  /** OpenCode, Muse, Pi and CodeBuddy: the file under their default home, where a record with no `file` has its server, when a home move puts `file` elsewhere. */
  unmovedFile?: string;
  /**
   * A local scope (#915): `file` is Claude Code's user config or CodeBuddy's
   * `.codebuddy.json`, and the servers are in `projects[projectKey].mcpServers`
   * there, under the key the tool files the checkout under
   * (`claudeProjectKey`, `codebuddyProjectKey`). Outside the working tree, so
   * no git exclusion applies to it.
   */
  projectKey?: string;
  /** The claude project `.mcp.json`, which Muse Code reads too while it has no target of its own (`mcpTargetAgents`). */
  museReads?: true;
  /** Where the servers sit in `file` when not under the format's key: ZCode's `mcp.servers`. */
  key?: McpKey;
}

export type McpKey = EntryPlace['key'];

export function mcpKeyOf(target: Pick<McpTarget, 'format' | 'key'>): McpKey {
  return target.key ?? (target.format === 'codex' ? ['mcp_servers'] : [MCP_SERVER_KEY[target.format]]);
}

/**
 * The key Claude Code files a checkout under in the `projects` map of its
 * user config (#915), as Claude Code 2.1 derives it: the checkout's real
 * path, or for a linked worktree the repository's common git directory, read
 * from the worktree's `.git` file and `commondir`, without its trailing
 * `.git` segment. So every worktree of an ordinary repository shares the main
 * checkout's key, while a linked worktree of a `--separate-git-dir`
 * repository is filed under the git directory, and one of a submodule under
 * its `.git/modules/<name>` directory. NFC, as Claude Code normalizes it.
 */
export async function claudeProjectKey(checkoutRoot: string): Promise<string> {
  const root = await fs.promises.realpath(checkoutRoot).catch(() => path.resolve(checkoutRoot));
  try {
    const dotGit = (await fs.promises.readFile(path.join(root, '.git'), 'utf8')).trim();
    if (!dotGit.startsWith('gitdir:')) return root.normalize('NFC');
    const gitDir = path.resolve(root, dotGit.slice('gitdir:'.length).trim());
    const common = await fs.promises.realpath(
      path.resolve(gitDir, (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()),
    );
    return (path.basename(common) === '.git' ? path.dirname(common) : common).normalize('NFC');
  } catch {
    // A `.git` directory, or a `.git` file of a checkout that is not a linked worktree (no `commondir`).
    return root.normalize('NFC');
  }
}

/** What sets a local scope's manifest key (`<tool>:local:<key>`) apart from a file's. */
const LOCAL_KEY_INFIX = ':local:';

/** Where `target`'s records live in the MCP manifest: a local scope by its tool and key, apart from any checkout's own. */
export function mcpManifestKey(target: Pick<McpTarget, 'tool' | 'projectScope' | 'projectKey'>): string {
  return target.projectKey !== undefined
    ? `${target.tool}${LOCAL_KEY_INFIX}${target.projectKey}` : managedMcpManifestKey(target.tool, target.projectScope);
}

/** A file or a local scope, as a member finds it. */
export function describeMcpLocation(target: Pick<McpTarget, 'file' | 'projectKey'>): string {
  return target.projectKey ? `${target.file} (projects[${JSON.stringify(target.projectKey)}])` : target.file;
}

/**
 * How `tool` files a project's servers in its local scope (#915), if it has
 * one: while sharing.gitExclude is on, and in a workspace with children
 * (#913), they go there, as these tools load a parent folder's project MCP
 * file in a child, not its local scope.
 */
function localMcpScopeOf(tool: string): McpProject['localScope'] {
  const { project } = channelsOf(tool).mcp;
  return typeof project === 'object' ? project.localScope : undefined;
}

/**
 * The key CodeBuddy files a checkout under in the `projects` map of its
 * `.codebuddy.json` (#915): the real path of the directory it runs in, with
 * no walk up to a repository root. So each worktree's root has a key of its own.
 */
async function codebuddyProjectKey(checkoutRoot: string): Promise<string> {
  return fs.promises.realpath(checkoutRoot).catch(() => path.resolve(checkoutRoot));
}

function toolLabel(tool: string): string {
  return KNOWN_AGENTS.find((agent) => agent.id === tool)?.displayName ?? tool;
}

/**
 * The file `tool` keeps its local scope in (#915), as `locate` places it
 * under `toolRoots` with every team mapping at its default; null for a tool
 * with none. `projectRoot` is any directory: the key is not wanted here.
 */
async function localMcpFileOf(tool: string, projectRoot: string, toolRoots: Readonly<Record<string, string>> = {}): Promise<string | null> {
  const where = await locate(tool, 'mcp', {
    toolPaths: DEFAULT_TOOL_PATHS, agents: {}, toolRoots, gitExclude: true, scope: 'project', projectRoot, repo: 'team', workspaceChildren: false,
  });
  if (where.channel !== 'files') return null;
  return [where.own, ...where.retired.map((retired) => retired.place)].find((place) => place?.projectKey !== undefined)?.path ?? null;
}

/**
 * `host` as every release before #1221 saw it for OpenCode, Muse and Pi,
 * which wrote their servers under the default home whatever moved it.
 */
function unmovedHost(host: Host): Host {
  return { ...host, env: {}, toolHomes: { kind: 'missing' } };
}

function mcpTargetAt(tool: string, format: McpFormat, place: EntryPlace, projectScope: boolean): McpTarget {
  const ownKey = format !== 'codex' && isDeepStrictEqual(place.key, [MCP_SERVER_KEY[format]]);
  return {
    tool, format, file: place.path, projectScope,
    ...(place.projectKey === undefined ? {} : { projectKey: place.projectKey }),
    ...(format === 'codex' || ownKey ? {} : { key: place.key }),
  };
}

/**
 * A tool's two places for this project's team MCP servers (#915), as
 * `locate` names them: the project's file (`tree`) and the tool's local scope
 * outside the working tree (`local`), keyed as the tool files the checkout,
 * and the one it reads them from now (`active`). Null for a tool with no
 * local scope, outside project scope, or when the team maps no project MCP
 * file (for Claude, or no user MCP file).
 */
export async function projectMcpLocations(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  tool: string,
): Promise<{ tree: McpTarget; local: McpTarget; active: 'tree' | 'local' } | null> {
  const format = mcpFormatOf(tool);
  if (localConfig.scope !== 'project' || !localMcpScopeOf(tool) || format === null) return null;
  const where = await locate(tool, 'mcp', installOf(teamConfig, localConfig));
  const own = ownOf(where);
  const other = where.retired.find((retired) => retired.was === 'other-scope')?.place;
  if (own === null || other === undefined) return null;
  const [tree, local] = own.projectKey === undefined ? [own, other] : [other, own];
  return { tree: { ...mcpTargetAt(tool, format, tree, true), retired: where.retired.filter(({ was }) => was === 'default').map(({ place }) => ({ file: place.path, key: place.key })) }, local: mcpTargetAt(tool, format, local, true), active: own === local ? 'local' : 'tree' };
}

/** Whether `tool`'s project MCP servers go to its local scope now (#915): `projectMcpLocations`' `active`. */
export async function mcpRelocated(teamConfig: TeamaiConfig, localConfig: LocalConfig, tool: string): Promise<boolean> {
  return (await projectMcpLocations(teamConfig, localConfig, tool))?.active === 'local';
}

/**
 * The tools with no project MCP file of their own that read `writer`'s
 * (`writtenBy`: Muse Code and tclaude read the claude target's
 * `<root>/.mcp.json`), selected and installed here, and reading `file`: not
 * while the team maps `writer`'s file elsewhere.
 */
async function mcpFileReaders(writer: string, file: string, install: Install, host: Host): Promise<string[]> {
  const readers: string[] = [];
  for (const reader of Object.keys(TOOLS)) {
    const { project } = channelsOf(reader).mcp;
    if (typeof project !== 'object' || project.writtenBy !== writer || install.toolPaths[reader] === undefined) continue;
    const where = await locate(reader, 'mcp', install, host);
    if (writable(where) === null || where.channel !== 'files' || where.reads === 'unknown') continue;
    if (where.reads.some((read) => read.path === file)) readers.push(reader);
  }
  return readers;
}

/**
 * The file `record` holds its server in: the one it notes. An older teamai
 * noted none and wrote under the default home of OpenCode, Muse, Pi and
 * CodeBuddy, the mapped file of a lookup target, and every other tool's file.
 */
export function recordedFileOf(target: Pick<McpTarget, 'file' | 'mappedFile' | 'unmovedFile'>, record: ManagedMcpRecord): string {
  return record.file ?? target.unmovedFile ?? target.mappedFile ?? target.file;
}

/** `target` at the place `record` holds its server in: its file, and the key it notes there. */
function recordedPlaceOf(target: McpTarget, record: ManagedMcpRecord): McpTarget {
  return { ...target, file: recordedFileOf(target, record), ...record.key === undefined ? {} : { key: record.key } };
}

/** The recorded file and server key, including the retired place an earlier release's record, noting no file, holds its server in (`retiredPlaceOf`). */
export async function recordedMcpTarget(target: McpTarget, record: ManagedMcpRecord): Promise<McpTarget> {
  const retired = record.file === undefined ? await retiredPlaceOf(target, record) : undefined;
  return retired === undefined ? recordedPlaceOf(target, record) : { ...target, ...retired };
}

/** Whether two targets name one place: one file by real path, one key in it, and one project under that key. */
export async function sameMcpPlace(a: McpTarget, b: McpTarget): Promise<boolean> {
  return isDeepStrictEqual(mcpKeyOf(a), mcpKeyOf(b)) && a.projectKey === b.projectKey && await sameMcpFile(a.file, b.file);
}

/**
 * Whether two paths name one file: a lookup path may be a symlink to another
 * (`~/.codebuddy/.mcp.json` -> `mcp.json`), and is then not another file (#993).
 */
export async function sameMcpFile(a: string, b: string): Promise<boolean> {
  return a === b || await realFilePath(a) === await realFilePath(b);
}

/**
 * For a target whose tool reads the first of several files (#993): teamai's
 * servers its records place in another file, which the tool does not read,
 * by file. Read-only; for `doctor` and `teamai mcp list`.
 */
export async function shadowedMcpRecords(localConfig: LocalConfig, target: McpTarget): Promise<Map<string, string[]>> {
  const shadowed = new Map<string, string[]>();
  if (!target.mappedFile) return shadowed;
  const { manifest } = await loadMcpManifest(localConfig, true);
  for (const record of manifest[managedMcpManifestKey(target.tool, target.projectScope)] ?? []) {
    const file = recordedFileOf(target, record);
    if (await sameMcpFile(file, target.file) || !(await installedMcpEntries({ ...target, file }))?.has(record.name)) continue;
    shadowed.set(file, [...shadowed.get(file) ?? [], record.name]);
  }
  return shadowed;
}

/**
 * Every file in or beside the project teamai may hold `localConfig`'s MCP
 * servers in (`cleanupOf`), for each tool the team maps or teamai builds in:
 * where the git exclusions an uninstall removes are. Not a local scope (#915),
 * which is outside the working tree.
 */
export async function mcpCleanupFiles(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const install = installOf(teamConfig, localConfig);
  const host = realHost();
  const files = new Set<string>();
  for (const tool of new Set([...Object.keys(teamConfig.toolPaths), ...Object.keys(DEFAULT_TOOL_PATHS)])) {
    for (const place of cleanupOf(await locate(tool, 'mcp', install, host))) {
      if (place.kind === 'entry' && place.projectKey === undefined) files.add(place.path);
    }
  }
  return [...files];
}

/**
 * Resolve which tools to write, and where: the place `locate` names for each
 * tool the team maps.
 *
 * A tool is detected by its install gate, NOT its MCP path: Claude's
 * project-scope MCP file is <root>/.mcp.json, whose first path segment is
 * the file itself, so a directory probe there would report "not installed"
 * for a perfectly good Claude install.
 */
export async function resolveMcpTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  /**
   * Also the tools not detected here, and in project scope the built-in
   * location of a tool the team dropped or moved: a file an earlier pull
   * wrote outlives its tool and its mapping.
   */
  options: { includeUndetected?: boolean } = {},
): Promise<McpTarget[]> {
  const projectScope = localConfig.scope === 'project';
  const install = installOf(teamConfig, localConfig);
  const host = realHost();
  const fallbacks = options.includeUndetected && projectScope;
  const targets: McpTarget[] = [];
  const builtins: McpTarget[] = [];
  const tools = new Set([...Object.keys(teamConfig.toolPaths), ...fallbacks ? Object.keys(DEFAULT_TOOL_PATHS) : []]);
  for (const tool of tools) {
    const channel = channelsOf(tool).mcp[install.scope];
    if (typeof channel !== 'object') continue;
    const where = await locate(tool, 'mcp', install, host);
    if (where.channel !== 'files' || where.writtenBy !== null) continue;
    // The selected gate is `mcpTargetExcluded`'s: uninstall still reaches a tool the member turned off.
    const installed = where.gates.every((gate) => gate.kind === 'selected' || gate.met);
    if (fallbacks) {
      for (const { place, was } of where.retired) {
        if (was === 'builtin') builtins.push({ ...mcpTargetAt(tool, channel.format, place, true), builtinFallback: true, ...installed ? {} : { undetected: true } });
      }
    }
    const { own } = where;
    if (own === null || !Object.hasOwn(teamConfig.toolPaths, tool)) continue;

    // Claude and CodeBuddy read a project's servers from their local scope while it is in use (#915). Not the
    // undetected view: it lists the files in the project, for the git exclusion of what an earlier pull wrote there.
    const tree = own.projectKey === undefined ? own : where.retired.find((retired) => retired.was === 'other-scope')?.place ?? own;
    const place = options.includeUndetected ? tree : own;
    // Muse Code reads the <root>/.mcp.json the claude target writes, so the
    // target stays while Muse runs here, in a project with no <root>/.claude
    // too, and takes Muse's transports while no Claude Code reads the file.
    const readers = projectScope ? await mcpFileReaders(tool, tree.path, install, host) : [];
    const museReads = readers.includes(MUSE_TOOL_ID);
    const museOnly = museReads && (!installed || isAgentExcluded(localConfig, tool)) && !readers.includes('tclaude');
    if (!options.includeUndetected && !installed && !museReads) {
      log.debug(`Skipping MCP sync for ${tool}: tool not installed`);
      continue;
    }
    // OpenCode V2 takes a project's servers from teamai's own file, through its plugin (#915).
    const plugin = where.alternate !== null && await opencodeDeliversThroughPlugin(teamConfig, localConfig);
    const inTree = place.projectKey === undefined;
    const lookup = inTree ? where.lookup : null;
    const retired = inTree ? where.retired.filter(({ was }) => was === 'default').map(({ place }) => ({ file: place.path, key: place.key })) : [];
    // Every release before #1221 wrote there under the default home: a lookup tool's mapped file (#993).
    const unmoved = inTree && isToolId(tool) && hasDefaultHomeLeftovers(tool) ? await locate(tool, 'mcp', install, unmovedHost(host)) : null;
    const unmovedFile = unmoved?.channel === 'files' ? unmoved.lookup?.mapped ?? ownOf(unmoved)?.path : undefined;
    targets.push({
      ...mcpTargetAt(tool, museOnly ? 'muse' : channel.format, plugin && where.alternate ? where.alternate : place, projectScope),
      ...museReads && !museOnly ? { museReads: true as const } : {},
      ...installed || museReads ? {} : { undetected: true as const },
      ...lookup ? { mappedFile: lookup.mapped, lookupFiles: [...lookup.files] } : {},
      ...where.alternate ? { mappedFile: place.path, alternateFile: where.alternate.path } : {},
      ...retired.length > 0 ? { retired } : {},
      ...unmovedFile !== undefined && unmovedFile !== (lookup?.mapped ?? place.path) ? { unmovedFile } : {},
    });
  }
  return [...targets, ...builtins];
}

/**
 * Whether a missing record of `target`'s tool makes its file's unclaimed servers suspect (#882): a tool the
 * team maps there, installed, or not installed while no installed tool maps that file or while
 * managed-mcp-files.json lists it as having written a resolved value there (`writers`).
 */
export function unrecordedMcpTool(target: McpTarget, targets: McpTarget[], writers: readonly string[] = []): boolean {
  if (target.builtinFallback) return false;
  return !target.undetected || writers.includes(target.tool)
    || !targets.some((other) => other.file === target.file && !other.undetected);
}

/**
 * The built-in fallbacks among `targets` their own tool's current mapping does
 * not reach (#882): the team moved or dropped the tool, so its manifest
 * records describe another file, or none, while an earlier pull may have
 * written this one. In one another tool maps today (CodeBuddy's `.mcp.json`,
 * which Claude maps), that tool's records tell its own servers.
 */
export async function unmappedMcpDefaults(targets: McpTarget[]): Promise<Set<McpTarget>> {
  const unmapped = new Set<McpTarget>();
  for (const target of targets) {
    if (!target.builtinFallback) continue;
    const own = await Promise.all(targets.filter((t) => t.tool === target.tool && !t.builtinFallback).map((t) => realFilePath(t.file)));
    if (!own.includes(await realFilePath(target.file))) unmapped.add(target);
  }
  return unmapped;
}

/**
 * The files of `unmapped` (`unmappedMcpDefaults`) that exist and `cfg`'s
 * worktree has not recorded for their tool, as `earlierMappedMcpTargets`
 * returns its files: judged as one an earlier mapping reached. `known`: the
 * other targets.
 */
export async function unrecordedUnmappedMcpDefaults(
  cfg: LocalConfig,
  unmapped: Iterable<McpTarget>,
  known: McpTarget[],
): Promise<Array<McpTarget & { tracked: boolean; mappedBy: string[] }>> {
  const reach = await Promise.all(known.map(async ({ tool, file }) => ({ tool, real: await realFilePath(file) })));
  const recorded = await Promise.all(Object.entries((await readResolvedMcpFiles(cfg)).files)
    .flatMap(([file, { tools }]) => tools.map(async (tool) => ({ tool, real: await realFilePath(file) }))));
  const found: Array<McpTarget & { tracked: boolean; mappedBy: string[] }> = [];
  for (const target of unmapped) {
    const real = await realFilePath(target.file);
    if (recorded.some((r) => r.tool === target.tool && r.real === real) || !await pathExists(target.file)) continue;
    const mappedBy = [...new Set(reach.filter((r) => r.real === real && r.tool !== target.tool).map((r) => r.tool))];
    found.push({ ...target, tracked: (await gitTracks(target.file)).kind === 'tracked', mappedBy });
  }
  return found;
}

// ─── JSON target I/O ─────────────────────────────────────────

export interface JsonDoc {
  data: Record<string, unknown>;
  servers: Record<string, unknown>;
  /** The existing document stores server names directly at the top level. */
  bare: boolean;
  /**
   * A Copilot project file holding `serverKey` as well: the servers at its top level beside it.
   * These may belong to the member or come from a previous bare write (#882).
   */
  beside?: Record<string, unknown>;
  /** A local scope (#915): the servers are under `projects[projectKey]`, not at the top level. */
  projectKey?: string;
}

const SERVER_KEYS = new Set<string>(Object.values(MCP_SERVER_KEY));

/**
 * Read a JSON MCP config. Returns null when the file exists but cannot be
 * parsed — we abandon the injection rather than risk clobbering a file we do
 * not understand (it may hold the user's OAuth session). Copilot project files
 * additionally allow a bare top-level server map, whose shape we preserve.
 */
export async function readJsonDoc(
  file: string,
  serverKey: string | McpKey,
  allowBare = false,
  /** A local scope (#915): read the servers of `projects[projectKey]`. */
  projectKey?: string,
): Promise<JsonDoc | null> {
  const local = projectKey === undefined ? {} : { projectKey };
  const keys = typeof serverKey === 'string' ? [serverKey] : serverKey;
  if (!await pathExists(file)) return { data: {}, servers: {}, bare: false, ...local };
  const raw = await readFileSafe(file);
  if (raw === null) return null;
  if (raw.trim() === '') return { data: {}, servers: {}, bare: allowBare, ...local };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    if (projectKey !== undefined) {
      const projects = data.projects ?? {};
      if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) return null;
      const project = (projects as Record<string, unknown>)[projectKey] ?? {};
      if (!isJsonObject(project)) return null;
      const servers = valueAt(project, keys) ?? {};
      if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
      return { data, servers: { ...servers }, bare: false, projectKey };
    }
    const bare = allowBare && !(keys[0] in data);
    const servers = bare ? data : valueAt(data, keys) ?? {};
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    const beside = allowBare && !bare ? Object.fromEntries(Object.entries(data).filter(([key, value]) =>
      !SERVER_KEYS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value))) : {};
    return { data, servers: { ...servers }, bare, ...Object.keys(beside).length > 0 ? { beside } : {} };
  } catch {
    return null;
  }
}

/**
 * Write a parsed JSON MCP config while preserving its original container
 * shape, and its mode unless `options.mode` forces one.
 */
export async function writeJsonDoc(
  file: string,
  serverKey: string | McpKey,
  doc: JsonDoc,
  options?: { mode?: number },
): Promise<void> {
  if (doc.bare) {
    await writeMcpJson(file, doc.servers, options);
    return;
  }
  const keys = typeof serverKey === 'string' ? [serverKey] : serverKey;
  if (doc.projectKey !== undefined) {
    // Every other key of the project's entry and of the file is carried over. An entry left holding
    // nothing but an empty server map goes: the tool reads a missing one as the same.
    const projects = (doc.data.projects ?? {}) as Record<string, Record<string, unknown>>;
    const project = withValueAt(projects[doc.projectKey] ?? {}, keys, doc.servers);
    if (Object.keys(doc.servers).length === 0 && Object.keys(project).length === 1) delete projects[doc.projectKey];
    else projects[doc.projectKey] = project;
    doc.data.projects = projects;
    await writeMcpJson(file, doc.data, options);
    return;
  }
  doc.data = withValueAt(doc.data, keys, doc.servers);
  await writeMcpJson(file, doc.data, options);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What `data` holds under `keys`: undefined where a key is missing, and the first value on the way that is not an object. */
function valueAt(data: Record<string, unknown>, keys: readonly string[]): unknown {
  let value: unknown = data;
  for (const key of keys) {
    if (!isJsonObject(value)) return value;
    value = value[key];
  }
  return value;
}

/** `data` with `value` under `keys`, every other key on the way kept. */
function withValueAt(data: Record<string, unknown>, keys: readonly string[], value: unknown): Record<string, unknown> {
  const [key, ...rest] = keys;
  if (key === undefined) return data;
  const inner = data[key];
  return { ...data, [key]: rest.length === 0 ? value : withValueAt(isJsonObject(inner) ? inner : {}, rest, value) };
}

/** Whether `data` holds nothing but an empty server map under `keys`. */
function holdsOnlyEmptyServers(data: Record<string, unknown>, keys: readonly string[]): boolean {
  const [key, ...rest] = keys;
  if (key === undefined) return isJsonObject(data) && Object.keys(data).length === 0;
  const inner = data[key];
  return Object.keys(data).every((other) => other === key) && (inner === undefined || (isJsonObject(inner) && holdsOnlyEmptyServers(inner, rest)));
}

/**
 * Write a JSON MCP config atomically. A symlink at `file` is the member's (a
 * dotfiles setup): the write lands in the file it points to and the link
 * stays, and the git checks judge that file (`realFilePath`).
 */
export async function writeMcpJson(file: string, data: unknown, options?: { mode?: number }): Promise<void> {
  await writeJsonAtomic(await symlinkTarget(file), data, options);
}

/** Undo a write that created `file`: the file created goes, and a symlink at `file` stays. */
async function removeCreatedMcpFile(file: string): Promise<void> {
  await fs.promises.rm(await symlinkTarget(file), { force: true });
}

// ─── Codex TOML target I/O ───────────────────────────────────

/**
 * Replace or delete a `[mcp_servers.<name>]` block by text surgery, leaving the
 * rest of config.toml byte-identical (comments included). A written block
 * always ends in a blank line, appended or replaced, so splicing the same
 * block again changes nothing.
 */
export function spliceCodexBlock(source: string, name: string, block: string | null): string {
  const re = codexBlockRe(name);
  const match = source.match(re);
  const padded = block === null ? null : block.endsWith('\n') ? block + '\n' : block + '\n\n';

  if (match) {
    if (padded === null) {
      const cleaned = source.replace(re, '');
      return cleaned.replace(/\n{3,}/g, '\n\n');
    }
    return source.replace(re, padded);
  }

  if (padded === null) return source;
  const sep = source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return source + sep + padded;
}

/**
 * Matches one `[mcp_servers.<name>]` block, from its header to the next table
 * header that is not one of its own sub-tables (e.g. [mcp_servers.<name>.env]),
 * or to end-of-input. End-of-input must be spelled `(?![\s\S])`: JS has no `\z`,
 * and under the `m` flag `$` only means end-of-line, which would truncate the
 * match early.
 */
function codexBlockRe(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    String.raw`^\[mcp_servers\.${escaped}\]\s*$[\s\S]*?(?=^\[(?!mcp_servers\.${escaped}[.\]])|(?![\s\S]))`,
    'm',
  );
}

/**
 * The text of one `[mcp_servers.<name>]` block, trimmed to the single trailing
 * newline `renderCodexBlock` emits so the two forms compare directly — the
 * splice pads a written block with a blank line to separate it from the next
 * table.
 */
export function codexBlockIn(source: string, name: string): string | null {
  const match = source.match(codexBlockRe(name));
  return match === null ? null : match[0].trimEnd() + '\n';
}

/** Extract the names of all `[mcp_servers.X]` tables present in a config.toml. */
export function codexServerNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)) names.add(m[1]);
  return [...names];
}

// ─── Desired set ─────────────────────────────────────────────

/** One team server in the rendered form that lands in a tool's own config. */
export interface DesiredMcpEntry {
  entry: unknown;
  hash: string;
  /** Codex alone stores a TOML block rather than a JSON value. */
  block?: string;
  /** The entry holds a `${VAR}` value teamai resolved, which may be a team secret. */
  resolvedValue: boolean;
}

/** Everything the per-server filters need, resolved once per run. */
export interface DesiredMcpContext {
  sharing: ReturnType<typeof getMcpSharing>;
  excluded: Set<string>;
  vars: Record<string, string>;
  /** Which `${VAR}` names are declared secrets, whose missing value keeps an entry (#875). */
  secrets: SecretDeclarations;
  lookPath?: McpReconcileOptions['lookPath'];
}

export async function buildDesiredMcpContext(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: McpReconcileOptions = {},
): Promise<DesiredMcpContext> {
  // HTTP mode has no repo tree to declare secrets in; a project that inherits the user scope has the user scope's.
  const teamEnv = resolvesTeamEnv(localConfig) ? options.teamEnv ?? await resolveTeamEnv(localConfig) : undefined;
  return {
    sharing: getMcpSharing(teamConfig),
    excluded: new Set(localConfig.excludedSkills ?? []),
    vars: await buildVarTable(localConfig, teamEnv),
    secrets: teamEnv?.declarations ?? { kind: 'absent' },
    lookPath: options.lookPath,
  };
}

/**
 * Which of `teamDefs` apply to `target`, rendered the way they land in the
 * tool's config, and a skip entry naming why each of the rest does not.
 *
 * Exported so `doctor` can check what should have arrived without restating
 * the filters (#624). A second copy of them is how an MCP server ends up
 * skipped for `unresolved variable(s)` during one pull and reported as
 * correctly delivered forever after.
 *
 * `kept` names the skipped servers whose only missing variables are declared
 * secrets (#875): the session-start pull inherits the agent's environment, so
 * a secret that lives in the member's shell is there for one pull and gone for
 * the next, and an entry an earlier pull wrote stays as it is. With
 * declarations that failed, every skipped server is kept.
 */
export function desiredMcpForTarget(
  target: McpTarget,
  teamDefs: McpServerDef[],
  ctx: DesiredMcpContext,
): { desired: Map<string, DesiredMcpEntry>; skipped: McpChange[]; kept: Set<string> } {
  const desired = new Map<string, DesiredMcpEntry>();
  const skipped: McpChange[] = [];
  const kept = new Set<string>();
  // Declarations that failed can't say which variables are secrets, so every
  // missing one may be: pull keeps every installed entry then.
  const declared = declaredSecretKeys(ctx.secrets);

  for (const raw of teamDefs) {
    if (!mcpTargetTakes(target, raw.tools)) continue;
    if (ctx.excluded.has(raw.name)) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: 'excluded by user' });
      continue;
    }
    if (!supportsTransport(target.format, raw.transport)) {
      skipped.push({
        tool: target.tool,
        server: raw.name,
        action: 'skipped',
        reason: `${mcpTargetAgent(target)} does not support ${raw.transport} transport`,
      });
      continue;
    }
    const violation = policyViolation(raw, ctx.sharing);
    if (violation) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: violation });
      continue;
    }
    const missingBin = requirementsMet(raw, ctx.lookPath);
    if (missingBin) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: missingBin });
      continue;
    }

    const rendered = renderMcpEntry(target, raw, ctx.vars);
    if ('missing' in rendered) {
      const { missing } = rendered;
      skipped.push({
        tool: target.tool,
        server: raw.name,
        action: 'skipped',
        reason: `unresolved variable(s): ${missing.join(', ')}`,
      });
      if (missing.every((key) => declared?.has(key) ?? true)) kept.add(raw.name);
      continue;
    }
    if (rendered.passthrough && referencedVars(raw).length > 0) {
      log.debug(`${raw.name}: passing ${referencedVars(raw).join(', ')} through to ${target.tool}`);
    }
    desired.set(raw.name, rendered.entry);
  }

  return { desired, skipped, kept };
}

/**
 * `raw` rendered as it lands in `target`'s config, or the variables it needs
 * that `vars` has no value for.
 *
 * Pass ${VAR} through where the tool expands it itself, so the secret never
 * lands on disk; otherwise resolve and require every var to exist. A resolved
 * value is written verbatim into the target file; a project file gets one only
 * once it is kept out of git (#882, reconcileTargets).
 */
function renderMcpEntry(
  target: McpTarget,
  raw: McpServerDef,
  vars: Record<string, string>,
): { entry: DesiredMcpEntry; passthrough: boolean } | { missing: string[] } {
  const passthrough = supportsEnvExpansion(target.format, target.projectScope, raw);
  let def = raw;
  if (!passthrough) {
    const { def: resolved, missing } = resolvePlaceholders(raw, vars);
    if (missing.length > 0) return { missing };
    def = resolved;
  }
  const resolvedValue = !passthrough && referencedVars(raw).length > 0;
  if (target.format === 'codex') {
    const block = renderCodexBlock(def);
    return { entry: { entry: block, hash: entryHash(block), block, resolvedValue }, passthrough };
  }
  const entry = renderJsonEntry(target.format, def);
  return { entry: { entry, hash: entryHash(entry), resolvedValue }, passthrough };
}

/** Every revision of the team repo's MCP files (#993), or null when unreadable or an HTTP-mode team. */
type TeamMcpHistory = Array<{ path: string; content: Buffer }> | null;

/** The team's MCP history, read once, on first use. One per reconcile run, shared by every target. */
function teamMcpHistory(localConfig: LocalConfig): () => Promise<TeamMcpHistory> {
  return once(async () => (localConfig.repo.kind === 'http'
    ? null
    : historicalContents(localConfig.repo.localPath, entryLayout('mcp').dir)));
}

/** Whose an entry is that `target`'s own MCP record does not claim (#993). */
export type UnrecordedMcpOwner = 'teamai' | 'another tool' | 'member';

/**
 * The names the MCP records of the other tools reading `target`'s file under
 * the same key claim: an entry one of them wrote is not the member's, and is
 * left to that tool, as before #993.
 */
export async function claimedByOtherTools(
  targets: readonly McpTarget[],
  target: McpTarget,
  manifest: Readonly<Record<string, ManagedMcpRecord[]>>,
): Promise<Set<string>> {
  const claimed = new Set<string>();
  for (const t of targets) {
    // By real path: a tool whose path links to another's file reads that file.
    if (t.tool === target.tool || !sameServerKey(t.format, target.format) || !await sameMcpFile(t.file, target.file)) continue;
    for (const record of manifest[mcpManifestKey(t)] ?? []) claimed.add(record.name);
  }
  return claimed;
}

/**
 * Whose an entry is that `target`'s record does not claim, `entry` under
 * `name` in `target`'s file (#993): another tool's when that tool's record
 * claims it (`claimed`); teamai's when it equals what teamai renders there for
 * the team server `name` today (`desired`) or at any revision in the team
 * repo's history of its MCP files, rendered with today's variables; otherwise
 * the member's. The history is read once per target, for the first entry
 * today's render does not prove; when it cannot be read, nothing more is
 * proven.
 */
function judgeUnrecordedMcpEntry(
  localConfig: LocalConfig,
  target: McpTarget,
  desired: ReadonlyMap<string, DesiredMcpEntry>,
  vars: Record<string, string>,
  claimed: ReadonlySet<string>,
  history: () => Promise<TeamMcpHistory> = teamMcpHistory(localConfig),
): McpEntryJudge {
  const renders = once(async (): Promise<Map<string, unknown[]> | null> => {
    const layout = entryLayout('mcp');
    const versions = await history();
    if (versions === null) return null;
    const entries = new Map<string, unknown[]>();
    for (const version of versions) {
      if (path.posix.basename(version.path) !== layout.file) continue;
      for (const server of parseTeamMcpServers(version.content.toString('utf8')) ?? []) {
        if (!mcpTargetTakes(target, server.tools)) continue;
        const def = teamMcpToDef(server);
        if (!supportsTransport(target.format, def.transport)) continue;
        const rendered = renderMcpEntry(target, def, vars);
        if (!('missing' in rendered)) entries.set(def.name, [...entries.get(def.name) ?? [], rendered.entry.entry]);
      }
    }
    return entries;
  });
  // Equal as values, as doctor compares them: key order is not ownership.
  return async (name, entry, recordedHash) => {
    if (claimed.has(name)) return 'another tool';
    const matches = (rendered: unknown) => (recordedHash === undefined || entryHash(rendered) === recordedHash)
      && isDeepStrictEqual(rendered, entry);
    if (desired.has(name) && matches(desired.get(name)?.entry)) return 'teamai';
    return (await renders())?.get(name)?.some(matches) ? 'teamai' : 'member';
  };
}

/**
 * The servers of `desired` that `target`'s file holds as the member's own
 * (#993): no record in teamai's MCP manifest, and an entry no team version of
 * the server renders to (`judgeUnrecordedMcpEntry`). A pull keeps them and
 * does not write the team's server there. Read-only, for `doctor`.
 */
export async function memberMcpServers(
  localConfig: LocalConfig,
  targets: readonly McpTarget[],
  target: McpTarget,
  desired: ReadonlyMap<string, DesiredMcpEntry>,
  vars: Record<string, string>,
): Promise<string[]> {
  const installed = await installedMcpEntries(target, { underKeyOnly: true });
  if (!installed) return [];
  const { manifest } = await loadMcpManifest(localConfig, true);
  const { owned: ownedRecords } = await splitByFile(target, manifest[mcpManifestKey(target)] ?? []);
  const owned = new Set(ownedRecords.map((r) => r.name));
  const judge = judgeUnrecordedMcpEntry(localConfig, target, desired, vars, await claimedByOtherTools(targets, target, manifest));
  const member: string[] = [];
  for (const name of desired.keys()) {
    const entry = installed.get(name);
    if (entry !== undefined && !owned.has(name) && await judge(name, entry) === 'member') member.push(name);
  }
  return member;
}

/**
 * The MCP server entries already present in `target`'s own config file, in the
 * same rendered form `desiredMcpForTarget` produces, or null when the file
 * exists and cannot be parsed — the same condition that makes the write path
 * abandon the injection rather than clobber a file it does not understand.
 *
 * Entries rather than names, because a name being present does not mean the
 * team's server arrived: the appliers refuse to overwrite an entry teamai does
 * not own, so an unrelated server of the same name leaves the key there and the
 * team's definition undelivered. Only the value tells those two apart.
 * A Copilot project file's bare servers beside `mcpServers` count as well
 * (#882): what the file holds, not only what the tool reads.
 *
 * Read-only. An MCP server is an entry inside a tool's config rather than a
 * file of its own, so this, not a destination path, is what "delivered" means.
 */
export async function installedMcpEntries(
  target: McpTarget,
  /** Only the servers under the format's key, as the tool reads them: not a Copilot file's bare ones beside it. */
  options: { underKeyOnly?: boolean } = {},
): Promise<Map<string, unknown> | null> {
  if (target.format === 'codex') {
    const raw = await readCodexConfig(target.file);
    if (raw === undefined) return null;
    if (raw === null) return new Map();
    return new Map(codexServerNames(raw).map((name) => [name, codexBlockIn(raw, name)]));
  }
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, mcpKeyOf(target), allowBare, target.projectKey);
  if (doc === null) return null;
  normalizeMuseServers(target, doc.servers);
  return new Map([...options.underKeyOnly ? [] : Object.entries(doc.beside ?? {}), ...Object.entries(doc.servers)]);
}

/** In a Copilot project file that also holds `mcpServers`, a bare server whose value differs from the one of its name there. */
async function shadowedBareCopilotServer(target: McpTarget): Promise<string | undefined> {
  if (target.format !== 'copilot' || !target.projectScope) return undefined;
  const doc = await readJsonDoc(target.file, MCP_SERVER_KEY.copilot, true).catch(() => null);
  if (!doc?.beside) return undefined;
  return Object.keys(doc.beside).find((name) => doc.servers[name] !== undefined
    && JSON.stringify(doc.servers[name]) !== JSON.stringify(doc.beside?.[name]));
}

/**
 * The manifest of the servers teamai wrote for this scope. Project scope uses a
 * PER-WORKTREE manifest under the partition (migrating this worktree's records
 * out of any legacy shared file on first read, unless `dryRun`); user scope
 * keeps the single global file. Either way a reconcile owns exactly one file.
 * Project scope also holds the records of the local scopes for this
 * checkout's key (`mcpManifestKey`), kept apart (`saveMcpManifest`).
 */
export async function loadMcpManifest(
  localConfig: LocalConfig,
  dryRun: boolean | undefined,
): Promise<{ manifestPath: string; manifest: ManagedMcpManifest }> {
  const dataHome = getDataHome(localConfig);
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const loaded = await loadProjectMcpManifest(dataHome, localConfig.projectRoot, { dryRun });
    const local = await readManifest(localMcpManifestPath(localConfig));
    const ours = await localMcpKeyOf(localConfig);
    for (const [key, records] of Object.entries(local)) if (ours(key) && Array.isArray(records)) loaded.manifest[key] = records;
    return loaded;
  }
  const manifestPath = managedMcpManifestPath(dataHome);
  return { manifestPath, manifest: await readManifest(manifestPath) };
}

/** The manifest `loadMcpManifest` reads, without writing anything. For `teamai mcp list`. */
export async function readMcpManifest(localConfig: LocalConfig): Promise<ManagedMcpManifest> {
  return (await loadMcpManifest(localConfig, true)).manifest;
}

/**
 * The records of the local scopes (#915), by tool and key: one file for every
 * checkout of the project. Every worktree of a repository shares the main
 * checkout's Claude key, so no checkout's own manifest can speak for it; and
 * a pull drops the CodeBuddy key of a worktree that is gone, whose own
 * manifest no pull reads again.
 */
function localMcpManifestPath(localConfig: LocalConfig): string {
  return path.join(getDataHome(localConfig), 'managed-local-mcp.json');
}

/** Whether a manifest key is one of the local-scope keys of `localConfig`'s checkout. */
async function localMcpKeyOf(localConfig: LocalConfig): Promise<(key: string) => boolean> {
  if (localConfig.scope !== 'project' || !localConfig.projectRoot) return () => false;
  const keys = new Set<string>();
  for (const tool of Object.keys(TOOLS)) {
    const scope = localMcpScopeOf(tool);
    if (scope === undefined) continue;
    const projectKey = scope.key === 'git-common-root' ? await claudeProjectKey(localConfig.projectRoot) : await codebuddyProjectKey(localConfig.projectRoot);
    keys.add(mcpManifestKey({ tool, projectScope: true, projectKey }));
  }
  return (key) => keys.has(key);
}

/**
 * Write what `loadMcpManifest` read: the checkout's own records to its
 * manifest, and its local-scope records into the shared file, re-read so
 * another checkout's keys there stay as they are. Another key's records the
 * reconcile took in (`leaveGoneCheckouts`, `leaveOtherLocalScopes`) are
 * written back there too; an empty list drops the key.
 */
export async function saveMcpManifest(localConfig: LocalConfig, manifestPath: string, manifest: ManagedMcpManifest): Promise<void> {
  const ours = await localMcpKeyOf(localConfig);
  const local = (key: string): boolean => key.includes(LOCAL_KEY_INFIX);
  await writeJsonAtomic(manifestPath, Object.fromEntries(Object.entries(manifest).filter(([key]) => !local(key))));
  if (localConfig.scope !== 'project') return;
  const file = localMcpManifestPath(localConfig);
  const shared = await readManifest(file);
  const before = JSON.stringify(shared);
  for (const key of Object.keys(shared)) if (ours(key) || (local(key) && key in manifest)) delete shared[key];
  for (const [key, records] of Object.entries(manifest)) if (local(key) && records.length > 0) shared[key] = records;
  if (JSON.stringify(shared) !== before) await writeJsonAtomic(file, shared);
}

/**
 * The team servers whose entry an earlier pull wrote and a pull now keeps,
 * because a declared secret has no value (#875), with the tools holding one.
 * Read-only: for the note that such an entry may hold an old value.
 */
export async function keptMcpEntries(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  teamEnv?: TeamEnv,
): Promise<Map<string, string[]>> {
  const kept = new Map<string, string[]>();
  if (localConfig.repo.kind === 'http') return kept;
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  if (resolution.kind === 'failed' || resolution.entries.length === 0) return kept;
  const teamDefs = resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  const targets = await resolveMcpTargets(teamConfig, localConfig);
  if (targets.length === 0) return kept;
  const ctx = await buildDesiredMcpContext(teamConfig, localConfig, { teamEnv });
  if (ctx.secrets.kind !== 'resolved') return kept;
  const { manifest } = await loadMcpManifest(localConfig, true);

  for (const target of targets) {
    if (mcpTargetExcluded(localConfig, target)) continue;
    const owned = new Set((manifest[mcpManifestKey(target)] ?? []).map((r) => r.name));
    const installed = await installedMcpEntries(target);
    for (const name of desiredMcpForTarget(target, teamDefs, ctx).kept) {
      if (!owned.has(name) || !installed?.has(name)) continue;
      kept.set(name, [...kept.get(name) ?? [], target.tool]);
    }
  }
  return kept;
}

/**
 * Why `target`'s file may hold a value teamai resolved (#882), or null when it
 * is missing or proven not to. Judged by what is on disk and in the manifest
 * (`owned`: the records it holds for the file's tool), never by delivery: an
 * owned entry whose definition cannot be read, or has left the team's servers,
 * is unproven, and so is one still as a pull wrote it with a resolved value,
 * whatever its definition says now. So is a server `unverified` names
 * (managed-mcp-files.json): one in the file when teamai rebuilt its lost
 * record. A file that does not parse is judged by the ledger alone. `ctx` is
 * asked for only by a record an older teamai wrote.
 */
export async function resolvedValueEvidence(
  target: McpTarget,
  teamDefs: McpServerDef[] | null,
  ledger: { owned: ManagedMcpRecord[]; unverified?: string[] },
  vars: Record<string, string>,
  ctx: () => Promise<DesiredMcpContext>,
): Promise<string | null> {
  const raw = await readFileSafe(target.file);
  if (raw === null) return null;
  const installed = await installedMcpEntries(target);
  const records = installed ? ledger.owned.filter((record) => installed.has(record.name)) : ledger.owned;
  const present = records.map((record) => record.name);
  const unverified = (ledger.unverified ?? []).find((name) => !installed || installed.has(name));
  if (unverified) return `${unverified}, which was in the file when teamai rebuilt its lost record, so teamai cannot tell whether a pull wrote it`;
  // A Copilot file's bare server beside a different one of its name under mcpServers: the merged view reads the
  // latter, and the bare copy may be one an earlier pull wrote with a value since resolved away (#882).
  const shadowed = await shadowedBareCopilotServer(target);
  if (shadowed) return `a bare ${shadowed} beside a different ${shadowed} under mcpServers, which may be an earlier pull's`;
  if (!teamDefs) return present.length > 0 ? `teamai's ${present.join(', ')}, and the team's MCP servers cannot be read` : null;
  const dropped = present.find((name) => !teamDefs.some((def) => def.name === name));
  if (dropped) return `teamai's ${dropped}, which has left the team's MCP servers`;
  const needing = present.find((name) => carriesResolvedValue(target, teamDefs, [name]));
  if (needing) return `teamai's ${needing}, which needs a resolved \${VAR}`;
  // An entry as a pull wrote it holds what that pull resolved, whatever its definition says now.
  let desired: Map<string, DesiredMcpEntry> | undefined;
  for (const record of installed ? records : []) {
    if (entryHash(installed?.get(record.name)) !== record.hash) continue;
    if (record.resolved === true) return `teamai's ${record.name}, as a pull wrote it with a resolved \${VAR}`;
    if (record.resolved !== undefined) continue;
    // An older teamai did not note it: stale, unless today's definition writes the same entry.
    desired ??= desiredMcpForTarget(target, teamDefs, await ctx()).desired;
    if (desired.get(record.name)?.hash !== record.hash) {
      return `teamai's ${record.name}, which an earlier pull wrote and its current definition no longer produces`;
    }
  }
  const variable = resolvedVariableIn(target, teamDefs, vars, raw);
  return variable ? `the value of $${variable}` : null;
}

/**
 * The servers in `target`'s file that none of `claimed` names, in a file git
 * does not track (#882): judged while the worktree has no managed-mcp.json
 * (`claimed`: the records a pull wrote there since, if any), when any of them
 * may be one teamai wrote. None for a file git tracks: no line protects it.
 */
export async function unclaimedMcpServers(target: McpTarget, claimed: readonly string[]): Promise<string[]> {
  const unclaimed = [...(await installedMcpEntries(target))?.keys() ?? []].filter((name) => !claimed.includes(name));
  return unclaimed.length === 0 || (await gitTracks(target.file)).kind === 'tracked' ? [] : unclaimed;
}

/**
 * Tools whose project MCP config is not judged teamai-only (#915): Claude's
 * and CodeBuddy's `.mcp.json`, whose servers have a per-member place outside
 * the project, and Qoder's `settings.json`, which also holds its settings.
 * In a single-repo team Claude keeps `.mcp.json` (`mcpRelocated`), and it is
 * judged.
 */
const NOT_TEAMAI_ONLY_MCP_TOOLS = new Set<string>(['claude', 'tclaude', 'codebuddy', 'qoder', 'qoder-cn'] satisfies ToolId[]);

/**
 * Each project MCP config of this checkout that holds anything, and whether
 * it holds only teamai's servers (#915): every top-level key is the server key
 * of a tool writing the file, every server under it is one teamai's MCP
 * records claim for that file, whichever tool's, and there is at least one. A
 * `.codex/config.toml` holds nothing but teamai's `[mcp_servers.<name>]`
 * blocks. Run after the reconcile, which records the unrecorded servers that
 * equal a team render and removes the ones of servers the team deleted (#993),
 * so a server no record claims is the member's or another program's. A
 * symlink is the member's and is not judged. Read-only.
 */
export async function judgeTeamaiOnlyMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
): Promise<Array<{ file: string; teamaiOnly: boolean }>> {
  if (localConfig.scope !== 'project') return [];
  const targets = await resolveMcpTargets(teamConfig, localConfig);
  const { manifest } = await loadMcpManifest(localConfig, true);
  const verdicts: Array<{ file: string; teamaiOnly: boolean }> = [];
  for (const file of new Set(targets.map((t) => t.file))) {
    const writers = targets.filter((t) => t.file === file);
    if (writers.some((t) => NOT_TEAMAI_ONLY_MCP_TOOLS.has(t.tool) && !(t.tool === 'claude' && isSelfMode(localConfig)))) continue;
    if (!(await fs.promises.lstat(file).catch(() => null))?.isFile()) continue;
    const raw = await readFileSafe(file);
    if (raw === null || raw.trim() === '') continue;
    // The file OpenCode V2 gets the servers from through teamai's plugin is teamai's whole.
    if (writers.some((t) => t.tool === 'opencode' && t.mappedFile !== undefined && t.file !== t.mappedFile)) {
      verdicts.push({ file, teamaiOnly: true });
      continue;
    }
    // The names teamai's records claim in this file, for the tools keeping their servers under `key`.
    const claimed = (key: McpKey | null): Set<string> => new Set(writers
      .filter((t) => isDeepStrictEqual(t.format === 'codex' ? null : mcpKeyOf(t), key))
      .flatMap((t) => manifest[managedMcpManifestKey(t.tool, true)] ?? [])
      .map((record) => record.name));
    if (writers.every((t) => t.format === 'codex')) {
      const names = codexServerNames(raw);
      const ours = claimed(null);
      const rest = names.filter((name) => ours.has(name)).reduce((source, name) => spliceCodexBlock(source, name, null), raw);
      verdicts.push({ file, teamaiOnly: names.some((name) => ours.has(name)) && rest.trim() === '' });
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      verdicts.push({ file, teamaiOnly: false });
      continue;
    }
    const keys = Object.keys(data);
    if (keys.length === 0) continue;
    // A Copilot project file may hold its servers bare, at the top level (#882).
    const bare = writers.every((t) => t.format === 'copilot') && !(MCP_SERVER_KEY.copilot in data);
    const serverKeys = writers.map(mcpKeyOf);
    let owned = 0;
    let foreign = false;
    const inspect = (value: unknown, keys: readonly string[]): void => {
      if (!isJsonObject(value)) {
        foreign = true;
        return;
      }
      const serverKey = serverKeys.find((key) => isDeepStrictEqual(key, keys));
      if (serverKey !== undefined) {
        const ours = claimed(serverKey);
        for (const name of Object.keys(value)) {
          if (ours.has(name)) owned++;
          else foreign = true;
        }
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        const next = [...keys, key];
        if (serverKeys.some((serverKey) => next.every((part, i) => serverKey[i] === part))) inspect(child, next);
        else foreign = true;
      }
    };
    inspect(bare ? { [MCP_SERVER_KEY.copilot]: data } : data, []);
    verdicts.push({ file, teamaiOnly: owned > 0 && !foreign });
  }
  return verdicts;
}

/**
 * On OpenCode V2 with teamai's plugin (#915): teamai's servers a pull left in
 * the project MCP file OpenCode V1 reads, as git tracks it or it holds
 * something else, with that file. Null when there are none. Read-only, for doctor.
 */
export async function opencodeV1Servers(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<{ file: string; names: string[] } | null> {
  const target = (await resolveMcpTargets(teamConfig, localConfig)).find((t) => t.tool === 'opencode' && t.projectScope);
  if (!target?.mappedFile || target.file === target.mappedFile || mcpTargetExcluded(localConfig, target)) return null;
  const { manifest } = await loadMcpManifest(localConfig, true);
  const installed = await installedMcpEntries({ ...target, file: target.mappedFile });
  const names = (manifest[managedMcpManifestKey(target.tool, true)] ?? [])
    .filter((record) => recordedFileOf(target, record) === target.mappedFile && installed?.has(record.name))
    .map((record) => record.name);
  return names.length > 0 ? { file: target.mappedFile, names: [...new Set(names)] } : null;
}

/** Whether any target's file, or another file of its tool's lookup order (#993), holds an MCP server, recorded or not. */
async function someMcpEntryInstalled(targets: readonly McpTarget[]): Promise<boolean> {
  for (const target of targets) {
    for (const file of [target.file, ...target.lookupFiles ?? []]) {
      if (((await installedMcpEntries({ ...target, file }))?.size ?? 0) > 0) return true;
    }
  }
  return false;
}

/**
 * `records` split by where their server is: in `target`'s file, by real path
 * (#993); in a file teamai moved them out of (`elsewhere`: another file of the
 * lookup order, the mapped or alternate file, a retired one); or still in a
 * file the tool took them from before its home or mapping moved, or one
 * that cannot be read (`left`), which a pull leaves as it is (#1221). A record that notes no file, of an
 * earlier release, is in a retired file holding its entry unchanged or that cannot be read, or in `target`'s file when the file it
 * guesses lacks the entry. A record of a file that holds no such entry is dropped: nothing of it is left.
 */
async function splitByFile(
  target: McpTarget,
  records: readonly ManagedMcpRecord[],
): Promise<{ owned: ManagedMcpRecord[]; elsewhere: ManagedMcpRecord[]; left: ManagedMcpRecord[] }> {
  const owned: ManagedMcpRecord[] = [];
  const elsewhere: ManagedMcpRecord[] = [];
  const left: ManagedMcpRecord[] = [];
  const relocations = [target.mappedFile, target.alternateFile, ...target.lookupFiles ?? [], ...(target.retired ?? []).map(({ file }) => file)];
  for (const record of records) {
    const retired = record.file === undefined ? await retiredPlaceOf(target, record) : undefined;
    if (retired !== undefined) {
      const { file, key } = retired;
      elsewhere.push({ ...record, file, ...isDeepStrictEqual(key, mcpKeyOf(target)) ? {} : { key } });
      continue;
    }
    const recorded = recordedPlaceOf(target, record);
    const { file } = recorded;
    if (await sameMcpPlace(recorded, target)) owned.push(record);
    else if (relocations.includes(file)) elsewhere.push(record);
    else {
      const installed = await installedMcpEntries(recorded);
      if (installed === null || installed.has(record.name)) left.push(record);
      else if (record.file === undefined) owned.push(record);
    }
  }
  return { owned, elsewhere, left };
}

/**
 * The retired place holding `record`'s server unchanged, or else one that cannot be read and so may hold it:
 * the record stays tied to that place until a run reads it.
 */
async function retiredPlaceOf(target: McpTarget, record: ManagedMcpRecord): Promise<{ file: string; key: McpKey } | undefined> {
  let unread: { file: string; key: McpKey } | undefined;
  for (const place of target.retired ?? []) {
    const installed = await installedMcpEntries({ ...target, ...place });
    if (installed === null) unread ??= place;
    const entry = installed?.get(record.name);
    if (entry !== undefined && entryHash(entry) === record.hash) return place;
  }
  return unread;
}

function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => value ??= load();
}

/** A file `recordedMcpTargets` returns. */
export interface RecordedMcpFile {
  /** A target per tool it was recorded for whose mapping in `known` no longer reaches it. */
  targets: McpTarget[];
  /** The tools whose target in `known` reaches it: their manifest records tell their own servers there. */
  mappedBy: string[];
  /** Recorded as one git tracked (managed-mcp-files.json): no line protects it while git does. */
  tracked: boolean;
}

/**
 * The files `cfg`'s worktree recorded writing a resolved value to (#882) for
 * a tool no target in `known` reaches them for: the team has since changed or
 * removed the toolPaths mapping they were written under. A file another
 * tool's target reaches is among them while a tool it was recorded for is not
 * one of those.
 */
export async function recordedMcpTargets(cfg: LocalConfig, known: McpTarget[]): Promise<Map<string, RecordedMcpFile>> {
  const reach = await Promise.all(known.map(async (target) => ({ tool: target.tool, real: await realFilePath(target.file) })));
  const recorded = new Map<string, RecordedMcpFile>();
  for (const [file, entry] of Object.entries((await readResolvedMcpFiles(cfg)).files)) {
    const real = await realFilePath(file);
    const mappedBy = [...new Set(reach.filter((r) => r.real === real).map((r) => r.tool))];
    const targets = entry.tools.filter((tool) => !mappedBy.includes(tool)).flatMap((tool): McpTarget[] => {
      const format = mcpFormatOf(tool);
      const channel = channelsOf(tool).mcp.project;
      return format ? [{ tool, format, file, projectScope: true, ...(typeof channel === 'object' && channel.key !== undefined ? { key: channel.key } : {}) }] : [];
    });
    if (targets.length > 0) recorded.set(file, { targets, mappedBy, tracked: entry.tracked === true });
  }
  return recorded;
}

// Built-in mcpProject defaults an older teamai wrote to and no longer maps:
// no teamai.yaml revision names them.
const EARLIER_BUILTIN_MCP_PROJECT = {
  codebuddy: { mcpProject: '.codebuddy/mcp.json' }, // before 57636a27
};

/**
 * The files earlier revisions of the team's teamai.yaml mapped a tool's
 * project MCP config to (`toolPaths.<tool>.mcpProject`) that exist under the
 * project root, and that neither the tool's own target in `known` nor a file
 * `cfg`'s worktree recorded for the tool is (#882), each saying whether git
 * tracks it (no exclude line applies to one it does) and which other tools'
 * targets in `known` reach it: a teamai from before managed-mcp-files.json may have
 * written a resolved value there, under a mapping the team changed before
 * this member's first pull on a teamai that records one, plus those under a
 * built-in default teamai has since changed. Read from the team
 * repo's history of teamai.yaml, as far as the clone has it (a shallow clone
 * has less). Null when git cannot read it: not a repository, no commits, a
 * git error.
 */
export async function earlierMappedMcpTargets(
  cfg: LocalConfig,
  known: McpTarget[],
  /** `history: false`: only the built-in defaults, for a team with no teamai.yaml (HTTP-backed). */
  options: { history?: boolean } = {},
): Promise<Array<McpTarget & { tracked: boolean; mappedBy: string[] }> | null> {
  const { projectRoot } = cfg;
  if (!projectRoot) return [];
  const repoPath = cfg.repo.localPath;
  let revisions: string[] = [];
  if (options.history !== false) {
    try {
      revisions = (await createGit(repoPath).raw(['log', '--format=%H', 'HEAD', '--', 'teamai.yaml'])).split('\n').filter(Boolean);
    } catch (e) {
      log.debug(`Could not read the history of teamai.yaml in ${repoPath}: ${e instanceof Error ? e.message : String(e)}. The next pull tries again.`);
      return null;
    }
  }
  const root = await realFilePath(projectRoot);
  // Each path, by real path, with the tools today's targets or the record reach it for.
  const mapped = await Promise.all(known.map(async ({ tool, file }) => ({ tool, real: await realFilePath(file) })));
  const recorded = await Promise.all(Object.entries((await readResolvedMcpFiles(cfg)).files)
    .flatMap(([file, { tools }]) => tools.map(async (tool) => ({ tool, real: await realFilePath(file) }))));
  const reached = (tool: string, real: string): boolean => [...mapped, ...recorded].some((r) => r.tool === tool && r.real === real);
  const found = new Map<string, McpTarget & { tracked: boolean; mappedBy: string[] }>();
  // Each revision's teamai.yaml is read while earlier ones are judged, at most
  // eight reads at a time. A read that fails is null, skipped as an empty file is.
  const reads: Array<Promise<Buffer | null>> = [];
  for (const [i, revision] of [null, ...revisions].entries()) {
    while (reads.length < Math.min(i + 7, revisions.length)) {
      reads.push(getFileContentAtRev(repoPath, revisions[reads.length], './teamai.yaml').catch(() => null));
    }
    let toolPaths: unknown = EARLIER_BUILTIN_MCP_PROJECT;
    if (revision !== null) {
      try {
        toolPaths = (YAML.parse((await reads[i - 1])?.toString() ?? '') as { toolPaths?: unknown } | null)?.toolPaths;
      } catch {
        continue;
      }
    }
    if (typeof toolPaths !== 'object' || toolPaths === null) continue;
    for (const [tool, paths] of Object.entries(toolPaths)) {
      const rel: unknown = typeof paths === 'object' && paths !== null ? (paths as { mcpProject?: unknown }).mcpProject : undefined;
      const format = mcpFormatOf(tool);
      if (typeof rel !== 'string' || !format) continue;
      const file = path.resolve(resolveBaseDir(cfg), rel);
      const key = `${tool}\0${file}`;
      if (found.has(key)) continue;
      const real = await realFilePath(file);
      const inside = path.relative(root, real);
      if (inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) continue;
      if (reached(tool, real) || !await pathExists(file)) continue;
      const mappedBy = [...new Set(mapped.filter((r) => r.real === real).map((r) => r.tool))];
      const channel = channelsOf(tool).mcp.project;
      found.set(key, { tool, format, file, projectScope: true, ...(typeof channel === 'object' && channel.key !== undefined ? { key: channel.key } : {}), tracked: (await gitTracks(file)).kind === 'tracked', mappedBy });
    }
  }
  return [...found.values()];
}

/** What one file, read in the format of each of `targets` (all for that file), holds. */
async function mcpFileState(targets: McpTarget[]): Promise<McpFileObservation['state']> {
  const servers = new Set<string>();
  for (const target of targets) {
    if (!await pathExists(target.file)) return { kind: 'missing' };
    const installed = await installedMcpEntries(target);
    if (!installed) return { kind: 'unparsable' };
    for (const name of installed.keys()) servers.add(name);
  }
  return { kind: 'parsed', servers: [...servers] };
}

/**
 * Why a file `recordedMcpTargets` returned may still hold a value teamai
 * resolved, or null once it is gone or holds no server: with no tool's
 * definitions to judge its entries by, any server it holds may be teamai's.
 * `owned`, for a file other tools' targets now reach: the servers their
 * manifest records say they wrote there, which their own rules judge. Any
 * other server may be what teamai wrote for `targets`' tools.
 */
export async function recordedMcpFileEvidence(targets: McpTarget[], owned?: McpOwnedFor): Promise<string | null> {
  const state = await mcpFileState(targets);
  if (state.kind === 'unparsable') return 'it does not parse';
  if (state.kind !== 'parsed') return null;
  if (!owned) {
    return state.servers.length > 0
      ? 'teamai may have written a resolved value to it under an earlier toolPaths mapping, and it still holds MCP servers'
      : null;
  }
  // Each target's key read alone: another key's owner proves nothing of it (OpenCode's `mcp` beside `mcpServers`).
  for (const target of targets) {
    const placed = await mcpEntriesByPlacement(target);
    const other = [...placed?.keyed.keys() ?? []].find((name) => !owned(target).includes(name))
      ?? [...placed?.bare.keys() ?? []].find((name) => !owned(target, { bare: true }).includes(name));
    if (other !== undefined) {
      return `teamai may have written a resolved value to it for ${targets.map((t) => t.tool).join(', ')} under an earlier toolPaths mapping, `
        + `and it holds ${other}, which no tool that maps it now owns`;
    }
  }
  return null;
}

/**
 * `target`'s servers under its format's key, and apart, a Copilot project file's bare ones, or null when
 * the file does not parse (#882). `installedMcpEntries` merges the two by name, the keyed one winning: a
 * bare server beside one of its name under `mcpServers` is judged on its own here.
 */
async function mcpEntriesByPlacement(target: McpTarget): Promise<{ keyed: Map<string, unknown>; bare: Map<string, unknown> } | null> {
  if (target.format !== 'copilot' || !target.projectScope) {
    const keyed = await installedMcpEntries(target);
    return keyed && { keyed, bare: new Map() };
  }
  const doc = await readJsonDoc(target.file, MCP_SERVER_KEY.copilot, true);
  if (!doc) return null;
  const entries = (servers: Record<string, unknown> | undefined): Map<string, unknown> => new Map(Object.entries(servers ?? {}));
  return doc.bare ? { keyed: new Map(), bare: entries(doc.servers) } : { keyed: entries(doc.servers), bare: entries(doc.beside) };
}

/**
 * For a target of a file other tools map today, the servers their records own under its key, or, with
 * `bare`, at a Copilot project file's top level, where only Copilot writes.
 */
export type McpOwnedFor = (target: McpTarget, options?: { bare?: boolean }) => readonly string[];

/**
 * `McpOwnedFor` from `mappedBy`, the tools a file's mapping reaches today: only the records of those that
 * keep their servers under the judged target's key count (#882). Undefined when no tool maps it today.
 */
export function ownedByMappers(mappedBy: readonly string[], manifest: ManagedMcpManifest | undefined): McpOwnedFor | undefined {
  if (mappedBy.length === 0) return undefined;
  return (target, options = {}) => mappedBy
    .filter((tool) => {
      const format = mcpFormatOf(tool);
      return format !== null && (options.bare ? format === 'copilot' : sameServerKey(format, target.format));
    })
    .flatMap((tool) => manifest?.[managedMcpManifestKey(tool, true)] ?? []).map((record) => record.name);
}

/**
 * Why a file `earlierMappedMcpTargets` returned may hold a value an older
 * teamai resolved, or null: judged as a recorded file is, since the
 * manifest's records for its tool describe the file today's mapping reaches,
 * not this one, plus the value scan. `owned`: for one other tools' targets
 * reach today, the servers their manifest records say they wrote there.
 */
export async function earlierMappedMcpFileEvidence(
  target: McpTarget,
  teamDefs: McpServerDef[] | null,
  vars: Record<string, string>,
  ctx: () => Promise<DesiredMcpContext>,
  owned?: McpOwnedFor,
): Promise<string | null> {
  return await recordedMcpFileEvidence([target], owned) ?? await resolvedValueEvidence(target, teamDefs, { owned: [] }, vars, ctx);
}

/**
 * What each of this worktree's project MCP configs holds, for
 * `settleResolvedMcpFiles`: each of `targets`' files, judged by `holds`, and
 * each file `recordedMcpTargets` returns, by `recordedMcpFileEvidence`, but
 * for one recorded as tracked that git still tracks: no line protects it.
 */
async function observeMcpConfigs(
  localConfig: LocalConfig,
  targets: McpTarget[],
  manifest: ManagedMcpManifest,
  holds: (target: McpTarget, owned: ManagedMcpRecord[]) => Promise<boolean>,
): Promise<McpFileObservation[]> {
  const observations: McpFileObservation[] = [];
  for (const target of targets) {
    const owned = manifest[managedMcpManifestKey(target.tool, true)] ?? [];
    const state = await mcpFileState([target]);
    observations.push({ file: target.file, tool: target.tool, state, holding: await holds(target, owned), owned: owned.map((r) => r.name) });
  }
  for (const [file, { targets: group, mappedBy, tracked }] of await recordedMcpTargets(localConfig, targets)) {
    const state = await mcpFileState(group);
    // Only git saying it no longer tracks the file, or no repository holding it, ends that: a failed probe is no answer.
    const stillTracked = tracked && !(await gitUntracked(file));
    const owned = ownedByMappers(mappedBy, manifest);
    const holding = !stillTracked && await recordedMcpFileEvidence(group, owned) !== null;
    for (const target of group) {
      observations.push({
        file, tool: target.tool, state, holding, owned: owned ? [...owned(target)] : [],
        ...tracked ? { tracked: stillTracked } : {},
        ...owned && !stillTracked ? { remapped: true as const } : {},
      });
    }
  }
  return observations;
}

/** `settleResolvedMcpFiles`, which only ever brings the record closer to the disk: a failure waits for the next pull. */
async function settleRecordedMcpConfigs(
  localConfig: LocalConfig,
  observations: McpFileObservation[],
  options?: { earlierMappingsRead?: boolean },
): Promise<void> {
  const result = await settleResolvedMcpFiles(localConfig, observations, options).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  if (result !== 'written' && result !== 'unchanged') {
    log.debug(`Did not update managed-mcp-files.json: ${result === 'locked' ? 'another teamai command held it past the wait' : result}. The next pull tries again.`);
  }
}

/**
 * `localConfig` and, in project scope, one config per other checkout of the
 * project (`projectCheckouts`, so also the main checkout of a
 * `--separate-git-dir` repo or a submodule): each has its own MCP configs and
 * managed-mcp manifest.
 */
export async function projectWorktreeConfigs(localConfig: LocalConfig): Promise<LocalConfig[]> {
  const configs: LocalConfig[] = [localConfig];
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const { resolveProjectDataHome } = await import('./config.js');
    const { projectCheckouts } = await import('./pull.js');
    for (const wt of await projectCheckouts(localConfig)) {
      if (wt === localConfig.projectRoot) continue;
      configs.push({ ...localConfig, projectRoot: wt, dataHome: await resolveProjectDataHome(wt) });
    }
  }
  return configs;
}

/** A project worktree's managed-mcp.json: `{}` when it is gone, empty or does not parse. */
async function readProjectMcpManifest(cfg: LocalConfig, projectRoot: string): Promise<ManagedMcpManifest> {
  return (await loadProjectMcpManifest(getDataHome(cfg), projectRoot, { dryRun: true })).manifest;
}

/**
 * The files of `groups` (the checkouts of one exclude line) not proven free of
 * a value teamai resolved (#882), each with why. A missing file is clean; so is
 * one a tool reads that parses and holds no server at all, and one in a nested
 * repository's linked worktree, read as the file of its line this project maps
 * is, that parses and holds none, and one a worktree recorded writing a
 * resolved value to under a toolPaths mapping since changed (managed-mcp-files.json)
 * that parses and holds none, as is a tool's built-in location no mapping reaches today. One a tool reads
 * holding servers is clean only when its worktree's manifest
 * records what teamai wrote to that tool's file (an empty list once teamai took
 * its last server out), and the file holds none of the team's servers that need
 * a resolved `${VAR}` there, none of teamai's own entries the manifest records
 * and cleanup left (their definition may have left mcp.yaml), and none of the
 * values of the variables set in this environment. Anything else (no tool reads
 * it, it does not parse, the team's servers cannot be read, the manifest is
 * lost, empty, does not parse, has no record for the tool (for a file
 * managed-mcp-files.json does not list, for any tool mapping it today), or a record rebuilt
 * without noting the file's other servers in managed-mcp-files.json) is not: a server
 * teamai wrote, since dropped from mcp.yaml, with a value no longer set, looks
 * like the member's own.
 * `before` is `localConfig`'s manifest as it stood before a reconcile rewrote it.
 * With `otherWorktrees: 'empty'` another worktree's file is clean only when it
 * holds no server at all: today's definitions and values cannot judge an entry
 * that worktree's last pull wrote (a `${VAR}` since made a literal), only a
 * pull there can.
 */
export async function mcpConfigsNotProvenClean(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  groups: Array<{ pattern: string; files: string[] }>,
  options: { before?: ManagedMcpManifest; otherWorktrees?: 'judged' | 'empty' } = {},
): Promise<Map<string, string>> {
  const { before, otherWorktrees = 'judged' } = options;
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  const teamDefs = resolution.kind === 'failed' ? null : resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  // Keyed by real path: the protected paths come from git, which resolves symlinks (macOS /var).
  const targets = new Map<string, {
    target: McpTarget; owned: ManagedMcpRecord[]; unverified: string[]; recorded: boolean; foreign: boolean;
    mappers: Set<string>; mapsToday: Set<string>; proven: Set<string>; writers: Set<string>;
    /** Every tool's target on this file: tools of different formats read different keys of it. */
    all: McpTarget[];
    /** What each of those tools' records own there, by format. */
    ownedByFormat: Array<{ format: McpFormat; names: string[] }>;
  }>();
  const realRoot = (root: string | undefined): Promise<string | undefined> =>
    root ? fs.promises.realpath(root).catch(() => root) : Promise.resolve(undefined);
  const ownRoot = await realRoot(localConfig.projectRoot);
  const recordedBy = new Map<LocalConfig, McpTarget[]>();
  // A built-in location no mapping reaches today, in each worktree: judged as a file an earlier mapping reached.
  const unmappedBy = new Map<LocalConfig, McpTarget[]>();
  for (const cfg of await projectWorktreeConfigs(localConfig)) {
    const manifest = cfg === localConfig && before ? before
      : cfg.projectRoot ? await readProjectMcpManifest(cfg, cfg.projectRoot)
      : {};
    // This checkout listed again under its real path is not another worktree.
    const foreign = cfg !== localConfig && await realRoot(cfg.projectRoot) !== ownRoot;
    const cfgTargets: McpTarget[] = [];
    recordedBy.set(cfg, cfgTargets);
    const { files: ledger } = await readResolvedMcpFiles(cfg);
    const unmapped = [...await unmappedMcpDefaults(await resolveMcpTargets(teamConfig, cfg, { includeUndetected: true }))];
    unmappedBy.set(cfg, unmapped);
    for (const target of await resolveMcpTargets(teamConfig, cfg, { includeUndetected: true })) {
      const key = await realFilePath(target.file);
      cfgTargets.push(target);
      // Judged below, as a file an earlier mapping reached.
      if (unmapped.some((t) => t.tool === target.tool && t.file === target.file)) continue;
      const records = manifest[managedMcpManifestKey(target.tool, true)];
      const owned = Array.isArray(records) ? records : [];
      // A rebuilt record whose file's other servers could not be noted says nothing of them yet.
      const recorded = Array.isArray(records) && !records.some((record) => record.unnoted);
      // One file reached twice (two tools share it, or a checkout through a symlink) merges what each says.
      // It counts as recorded only while every tool managed-mcp-files.json says wrote a resolved value
      // there still has its record: another tool's intact one proves nothing of that tool's entries.
      // (A writer that no longer maps the file is judged by the remapped rule below.) With no such list
      // (a file no pull on this version recorded), every tool whose mapping reaches it today needs one.
      const seen = targets.get(key);
      const mappers = new Set([...seen?.mappers ?? [], target.tool]);
      const mapsToday = new Set([...seen?.mapsToday ?? [], ...target.builtinFallback ? [] : [target.tool]]);
      const proven = new Set([...seen?.proven ?? [], ...recorded ? [target.tool] : []]);
      const writers = new Set([...seen?.writers ?? [], ...ledger[target.file]?.tools ?? []]);
      targets.set(key, {
        target,
        owned: [...seen?.owned ?? [], ...owned],
        unverified: [...seen?.unverified ?? [], ...ledger[target.file]?.unverified ?? []],
        recorded: proven.size > 0 && (writers.size > 0
          ? [...writers].every((tool) => proven.has(tool) || !mappers.has(tool))
          : [...mapsToday].every((tool) => proven.has(tool))),
        mappers,
        mapsToday,
        proven,
        writers,
        all: [...seen?.all ?? [], target],
        ownedByFormat: [...seen?.ownedByFormat ?? [], { format: target.format, names: owned.map((record) => record.name) }],
        foreign: foreign || seen?.foreign === true,
      });
    }
  }
  // Files a pull wrote under a mapping since changed, in any worktree: nothing but the file itself can judge them,
  // and in one another tool now maps, nothing but that tool's records.
  const recorded = new Map<string, McpTarget[]>();
  const remapped = new Map<string, McpTarget[]>();
  for (const [cfg, cfgTargets] of recordedBy) {
    const groups = [...(await recordedMcpTargets(cfg, cfgTargets)).values()].map(({ targets: group }) => group);
    for (const group of [...groups, ...[...unmappedBy.get(cfg) ?? []].map((target) => [target])]) {
      const key = await realFilePath(group[0].file);
      const map = targets.has(key) ? remapped : recorded;
      const known = map.get(key) ?? [];
      map.set(key, [...known, ...group.filter((t) => !known.some((k) => k.tool === t.tool && k.file === t.file))]);
    }
  }
  // Short values, paths and the login name turn up in ordinary configs, so they prove nothing.
  const identity = new Set(['USER', 'LOGNAME', 'USERNAME']);
  const vars = await buildVarTable(localConfig);
  const ctx = once(() => buildDesiredMcpContext(teamConfig, localConfig));
  const values = Object.entries(vars)
    .filter(([name, value]) => value.length >= 8 && !identity.has(name) && !/^([/~]|[A-Za-z]:[\\/])/.test(value));
  const held = new Map<string, string>();
  for (const { pattern, files } of groups) {
    // A file no worktree of this project maps, in a checkout of the same repository as
    // one it does: a nested repository's linked worktree, read as that one is.
    const siblingFile = files.find((file) => targets.has(file));
    const sibling = siblingFile === undefined ? undefined : targets.get(siblingFile);
    const nested = siblingFile && path.join(siblingFile, ...mcpExcludePatternPath(pattern).split('/').map(() => '..'));
    for (const file of files) {
      if (!await pathExists(file)) continue;
      const earlier = recorded.get(file);
      if (earlier) {
        const why = await recordedMcpFileEvidence(earlier);
        if (why) held.set(file, why);
        continue;
      }
      const moved = remapped.get(file);
      const mappedHereNow = targets.get(file);
      const movedWhy = moved && await recordedMcpFileEvidence(moved, (target) => (mappedHereNow?.ownedByFormat ?? [])
        .filter((o) => sameServerKey(o.format, target.format)).flatMap((o) => o.names));
      if (movedWhy) {
        held.set(file, movedWhy);
        continue;
      }
      const mappedHere = targets.get(file);
      const knownHere = mappedHere
        ?? (sibling && nested ? { target: { ...sibling.target, file }, owned: [], unverified: [], recorded: false, foreign: true, nested } : undefined);
      const raw = (await readFileSafe(file)) ?? '';
      // Judged in the format of every tool that maps it: one tool's key may hold what another's doesn't.
      const judge = async (known: NonNullable<typeof knownHere>, target: McpTarget): Promise<string | undefined> => {
        const installed = await installedMcpEntries(target);
        const named = installed && teamDefs
          ? [...installed.keys()].find((name) => carriesResolvedValue(target, teamDefs, [name]))
          : undefined;
        return !installed ? 'it does not parse'
          : installed.size === 0 ? undefined
          : 'nested' in known ? `it holds MCP servers in a linked worktree of the repository at ${known.nested}, which teamai cannot judge`
          : known.foreign && otherWorktrees === 'empty' ? 'it holds MCP servers in another worktree, which only a pull there can judge'
          : !teamDefs ? 'the team\'s MCP servers cannot be read'
          : named ? `it holds the team's ${named}, which needs a resolved \${VAR}`
          : await resolvedValueEvidence(target, teamDefs, known, vars, ctx).then((e) => e && `it holds ${e}`)
            ?? values.filter(([, value]) => raw.includes(value)).map(([name]) => `it holds the value of $${name}`)[0]
            ?? (known.recorded ? undefined : 'it holds MCP servers, and managed-mcp.json, teamai\'s record of which it wrote there, is gone, does not parse, has no entry for it or was rebuilt without noting its other servers');
      };
      let why = knownHere ? undefined : 'no tool teamai knows reads it';
      const formats = mappedHere ? mappedHere.all.filter((t, i, all) => all.findIndex((o) => o.format === t.format) === i)
        : knownHere ? [knownHere.target] : [];
      for (const target of formats) {
        why = knownHere && await judge(knownHere, target);
        if (why) break;
      }
      if (why) held.set(file, why);
    }
  }
  return held;
}

// ─── Main entry ──────────────────────────────────────────────

/** The agent `target`'s servers are for: its tool, or Muse Code for the claude target only Muse reads (Muse's format). */
export function mcpTargetAgent(target: McpTarget): string {
  return target.format === 'muse' ? MUSE_TOOL_ID : target.tool;
}

/** Every agent that reads `target`'s file: `mcpTargetAgent`, and Muse Code beside Claude Code (`museReads`). */
export function mcpTargetAgents(target: McpTarget): string[] {
  return target.museReads ? [target.tool, MUSE_TOOL_ID] : [mcpTargetAgent(target)];
}

/** Whether a team server limited to `tools`, when it is, goes to `target`: one of the agents reading its file is listed. */
export function mcpTargetTakes(target: McpTarget, tools: readonly string[] | undefined): boolean {
  return !tools || mcpTargetAgents(target).some((agent) => tools.includes(agent));
}

export function mcpTargetExcluded(localConfig: LocalConfig, target: McpTarget): boolean {
  if (!isAgentExcluded(localConfig, target.tool)) return false;
  // tclaude and Muse Code have no project-scope MCP file: they read the
  // <root>/.mcp.json the claude target writes, so that target stays live
  // while tclaude is enabled, or while Muse Code reads it (`resolveMcpTargets`
  // probed its install and the file, `mcpTargetAgents`).
  // Trae CN needs no such clause: its own target maps the shared
  // <root>/.trae/mcp.json under trae's ownership key (#904).
  return !(target.projectScope && target.tool === 'claude'
    && (!isAgentExcluded(localConfig, 'tclaude') || mcpTargetAgents(target).includes(MUSE_TOOL_ID)));
}

/**
 * The places teamai's records put a server in that cannot be read or parsed, among the records of the tools a
 * reconcile of `localConfig` reaches: its own, and in project scope every checkout's local scope of such a tool,
 * a gone one's included (`leaveGoneCheckouts`, `leaveOtherLocalScopes`). After a removal these are the records it
 * kept for a retry: uninstall keeps the data home holding them.
 */
export async function unreadMcpPlaces(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const { manifest } = await loadMcpManifest(localConfig, true);
  const shared = localConfig.scope === 'project' ? await readManifest(localMcpManifestPath(localConfig)) : {};
  const places = new Map<string, McpTarget>();
  for (const target of await resolveMcpTargets(teamConfig, localConfig)) {
    const both = target.projectScope && localMcpScopeOf(target.tool) ? await projectMcpLocations(teamConfig, localConfig, target.tool) : null;
    for (const place of both ? [both.tree, both.local] : [target]) places.set(mcpManifestKey(place), place);
    if (!both) continue;
    const prefix = `${both.local.tool}${LOCAL_KEY_INFIX}`;
    for (const key of Object.keys(shared)) {
      if (key.startsWith(prefix) && !places.has(key)) places.set(key, { ...both.local, projectKey: key.slice(prefix.length) });
    }
  }
  for (const [key, records] of Object.entries(shared)) if (manifest[key] === undefined && Array.isArray(records)) manifest[key] = records;
  const unread = new Set<string>();
  for (const [key, target] of places) {
    for (const record of manifest[key] ?? []) {
      const recorded = await recordedMcpTarget(target, record);
      if (await installedMcpEntries(recorded) === null) unread.add(describeMcpLocation(recorded));
    }
  }
  return [...unread];
}

/**
 * Reconcile one scope's tool configs to the team's desired MCP server set.
 * Idempotent: unchanged servers produce no write at all.
 */
export async function reconcileMcpForConfig(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: McpReconcileOptions = {},
): Promise<McpReconcileResult> {
  // Each project config's exclusion from git, established before a resolved value is written into it.
  const exclusions = new Map<string, GitExclusion>();
  // The project configs this run wrote: a line it added for one stays, whatever fails after.
  const written = new Set<string>();
  // The (file, tool) pairs managed-mcp-files.json first recorded this run, before their write, until that
  // tool's records hold a resolved value there: another tool's write to the same file proves nothing of it.
  const recorded: McpTarget[] = [];
  // One snapshot per file, before any tool writes it, until ownership is saved.
  const restoreConfigs = new Map<string, () => Promise<void>>();
  const protect = !options.removeAll && !options.dryRun;
  // Read before the reconcile records what it writes: a manifest it recreates says nothing of what came before.
  const before = protect && localConfig.projectRoot ? await readProjectMcpManifest(localConfig, localConfig.projectRoot) : undefined;
  try {
    return await reconcileTargets(teamConfig, localConfig, options, exclusions, written, recorded, restoreConfigs);
  } catch (error) {
    const failures: string[] = [];
    for (const [real, restore] of restoreConfigs) {
      try {
        await restore();
        // `written` names files by the path a tool writes them at; the snapshot, by real path.
        for (const file of written) if (file === real || await realFilePath(file) === real) written.delete(file);
      } catch (restoreError) {
        failures.push(`${real}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `MCP sync failed (${error instanceof Error ? error.message : String(error)}), and restoring configs failed (${failures.join('; ')}). `
        + 'Their ownership records may not match. Repair the configs and ownership records before retrying the command.',
        { cause: error },
      );
    }
    throw error;
  } finally {
    // A record this run added for a tool that then wrote no value goes, as its exclude line does. The settle
    // below records the file again if it holds a resolved value all the same (an earlier pull wrote it).
    await forgetUnwrittenMcpConfigs(localConfig, recorded);
    // Also after a failed write: what earlier pulls wrote is on disk either way.
    if (protect) await protectResolvedMcpConfigs(teamConfig, localConfig, exclusions, written, before);
  }
}

/**
 * List each project MCP config holding a value teamai resolved in
 * `.git/info/exclude` (#882), and take out the line of one proven clean. It
 * covers what is on disk, whether or not this run delivered to it: the file of
 * a disabled or undetected tool, or one written before the team turned
 * delivery off, still holds what a pull wrote. For an HTTP-backed team, whose
 * servers no pull writes, each config that may hold a credential its local
 * agent wrote (`protectLocalAgentMcpConfigs`).
 */
async function protectResolvedMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
  before: ManagedMcpManifest | undefined,
): Promise<void> {
  const { projectRoot } = localConfig;
  if (localConfig.scope !== 'project' || !projectRoot) return;
  try {
    await (localConfig.repo.kind === 'http'
      ? protectLocalAgentMcpConfigs(teamConfig, localConfig)
      : protectProjectMcpConfigs(teamConfig, localConfig, projectRoot, exclusions, written, before));
  } catch (e) {
    log.warn(
      `Could not check this project's MCP configs for resolved values to keep out of git: ${e instanceof Error ? e.message : String(e)}. `
      + 'Run `teamai doctor` to see whether git would commit one.',
    );
  }
}

/**
 * The targets among `targets`, those managed-mcp-files.json recorded under
 * a mapping another teamai.yaml made, and the built-in defaults teamai has
 * since changed, whose project MCP config may hold a credential an HTTP-backed
 * team's local agent wrote (#882). No mcp.yaml to judge by: a server its
 * install recorded as carrying a credential, or an older install's entry
 * carrying one (a header, env value, argument or URL), or one whose record was
 * lost while another server's remains. Each entry is judged on its own, a
 * Copilot file's bare one apart from the one of its name under mcpServers. With no record
 * of the tool at all, a file managed-mcp-files.json lists holds while it holds
 * any server, or doesn't parse: nothing says which of them the local agent
 * wrote. A file two tools map may appear once for each. Read-only.
 */
export async function localAgentCredentialFiles(localConfig: LocalConfig, targets: McpTarget[]): Promise<McpTarget[]> {
  const { projectRoot } = localConfig;
  if (localConfig.scope !== 'project' || !projectRoot) return [];
  const { manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
  const ledger = (await readResolvedMcpFiles(localConfig)).files;
  const recorded = [...(await recordedMcpTargets(localConfig, targets)).values()].flatMap((file) => file.targets);
  // An older agent wrote to a built-in default teamai has since changed; an HTTP team has no teamai.yaml history.
  const earlier = await earlierMappedMcpTargets(localConfig, targets, { history: false }) ?? [];
  const held: McpTarget[] = [];
  for (const target of [...targets, ...recorded, ...earlier]) {
    if (!await pathExists(target.file)) continue;
    const placed = await mcpEntriesByPlacement(target);
    const entries = placed && [...placed.keyed, ...placed.bare];
    const records = manifest[managedMcpManifestKey(target.tool, true)];
    if (records === undefined) {
      if (ledger[target.file] !== undefined && (entries === null || entries.length > 0)) held.push(target);
      continue;
    }
    const byName = new Map(records.map((record) => [record.name, record]));
    const credential = entries === null
      ? records.some((record) => record.resolved !== false)
      : entries.some(([name, entry]) => {
        const record = byName.get(name);
        // `resolved: false` speaks for the entry its install wrote: an older one a failed write left is judged by what it holds.
        const noted = record && (record.resolved === true || entryHash(entry) === record.hash) ? record.resolved : undefined;
        return noted ?? carriesLocalAgentCredential(entry);
      });
    if (credential) held.push(target);
  }
  return held;
}

/**
 * For an HTTP-backed team: list in `.git/info/exclude` each project MCP
 * config that may hold a credential its local agent wrote
 * (`localAgentCredentialFiles`), and record it in managed-mcp-files.json
 * (#882). An older local agent wrote one without listing it, and no install
 * runs again for a server already in place. Only `teamai uninstall` takes
 * such a line out. The caller skips a dry run.
 */
export async function protectLocalAgentMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: { rerun?: string } = {},
): Promise<void> {
  const mapped = await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true });
  const unmapped = await unmappedMcpDefaults(mapped);
  const held = await localAgentCredentialFiles(localConfig, mapped.filter((target) => !unmapped.has(target)));
  if (held.length === 0) return;
  for (const file of new Set(held.map((target) => target.file))) await excludeFromGit(file, { rerun: options.rerun, holds: 'a credential' });
  // A failure does not undo the line: the exclusion protects the file.
  const result = await trackResolvedMcpFiles(localConfig, held.map(({ tool, file }) => ({ tool, file })))
    .catch((e: unknown) => e instanceof Error ? e.message : String(e));
  if (result !== 'written' && result !== 'unchanged') {
    log.debug(`Did not record ${held.map((target) => target.file).join(', ')} in managed-mcp-files.json: ${result === 'locked' ? 'another teamai command held it past the wait' : result}.`);
  }
}

async function protectProjectMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  projectRoot: string,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
  before: ManagedMcpManifest | undefined,
): Promise<void> {
  const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
  const teamDefs = resolution.kind === 'failed' ? null : resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  const { manifestPath, manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
  const vars = await buildVarTable(localConfig);
  const ctx = once(() => buildDesiredMcpContext(teamConfig, localConfig));
  const mapped = await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true });
  const unmapped = await unmappedMcpDefaults(mapped);
  // Tried before its write this run, and reported there.
  const targets = mapped.filter((target) => !unmapped.has(target) && exclusions.get(target.file)?.kind !== 'failed');
  const { files: ledger, earlierMappingsRead } = await readResolvedMcpFiles(localConfig);
  // No managed-mcp.json when this pull began, or a record of a tool mapping the file still marked unnoted:
  // a server no record claims may be one teamai wrote. Noted after the settle, as a rebuild of a lost record
  // notes the servers it did not write.
  const lost = Object.keys(before ?? manifest).length === 0;
  // So, too, a tool the team maps there whose record alone is missing (lost, or never written): an installed
  // one, or one uninstalled since that left the file behind, when no installed tool maps that file (CodeBuddy
  // never installed beside Claude's .mcp.json would otherwise hold every member's own servers there).
  const unnoted = (file: string): boolean => lost || targets.some((t) => t.file === file
    && ((unrecordedMcpTool(t, targets, ledger[t.file]?.tools) && (before ?? manifest)[managedMcpManifestKey(t.tool, true)] === undefined)
      || [before, manifest].some((m) => m?.[managedMcpManifestKey(t.tool, true)]?.some((record) => record.unnoted))));
  const unclaimed = new Map<string, string[]>();
  const holds = async (target: McpTarget, owned: ManagedMcpRecord[]): Promise<boolean> => {
    // One file two tools map under one key: what either's record claims. A tool that reads another key of the
    // file (OpenCode's `mcp` beside `mcpServers`) proves nothing of this one's.
    const claimed = targets.filter((t) => t.file === target.file && sameServerKey(t.format, target.format))
      .flatMap((t) => manifest[managedMcpManifestKey(t.tool, true)] ?? []).map((record) => record.name);
    const names = unnoted(target.file) ? await unclaimedMcpServers(target, claimed) : [];
    // Tools of different formats sharing the file each find their own: every one is noted.
    if (names.length > 0) unclaimed.set(target.file, [...new Set([...unclaimed.get(target.file) ?? [], ...names])]);
    return names.length > 0
      || await resolvedValueEvidence(target, teamDefs, { owned, unverified: ledger[target.file]?.unverified }, vars, ctx) !== null;
  };
  const observations = await observeMcpConfigs(localConfig, targets, manifest, holds);
  // Once per worktree, what a teamai that kept no record of paths wrote under a mapping the team has since changed.
  const earlier = earlierMappingsRead ? [] : await earlierMappedMcpTargets(localConfig, mapped).catch((e: unknown) => {
    log.debug(`Did not read the MCP configs earlier toolPaths mappings reach: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  // And on every pull, a built-in location no mapping reaches today that no record of this version covers yet.
  const fallbacks = await unrecordedUnmappedMcpDefaults(localConfig, unmapped, mapped.filter((target) => !unmapped.has(target)));
  // Held through the release, which reads only what was recorded before this run.
  const found: string[] = [];
  for (const { tracked, mappedBy, ...target } of [...earlier ?? [], ...fallbacks]) {
    const state = await mcpFileState([target]);
    // No line protects a file git tracks: recorded as tracked, whatever it holds, and judged once git no longer tracks it.
    if (tracked) {
      observations.push({ file: target.file, tool: target.tool, state, holding: false, owned: [], tracked });
      continue;
    }
    // In a file other tools map today, their records tell their own servers.
    const owned = ownedByMappers(mappedBy, manifest);
    const holding = await earlierMappedMcpFileEvidence(target, teamDefs, vars, ctx, owned) !== null;
    if (holding) found.push(target.file);
    observations.push({ file: target.file, tool: target.tool, state, holding, owned: owned ? [...owned(target)] : [], ...owned ? { remapped: true as const } : {} });
  }
  const holding = new Set(observations.filter((o) => o.holding).map((o) => o.file));
  const unproven = new Set(observations.filter((o) => !o.holding).map((o) => o.file));
  // Also a file listed before its write: a concurrent uninstall may have taken its line out since.
  // And readable by this user only (#879), written this run or not: a disabled or moved tool's too.
  for (const file of holding) {
    await excludeFromGit(file);
    await tightenMode(file).catch((e: unknown) => log.debug(`Could not make ${file} 0600: ${e instanceof Error ? e.message : String(e)}`));
  }
  // A line this run added for a file it then did not write restores the file's state before the run.
  // One it wrote holds the value even when no scan finds it (shorter than eight characters).
  const addedNow = [...unproven].filter((file) => {
    const exclusion = exclusions.get(file);
    return !holding.has(file) && !written.has(file) && exclusion?.kind === 'excluded' && exclusion.added;
  });
  await releaseMcpGitExcludes(teamConfig, localConfig, projectRoot, addedNow, before, found);
  // After the release, which reads the files recorded before this run; also lists one an older teamai wrote.
  await settleRecordedMcpConfigs(localConfig, observations, { earlierMappingsRead: !earlierMappingsRead && earlier !== null });
  const noted = await noteUnclaimedMcpServers(localConfig, unclaimed);
  // A file that parses with no server left unclaimed has nothing to note.
  const parses = (target: McpTarget): boolean =>
    observations.some((o) => o.file === target.file && o.tool === target.tool && o.state.kind !== 'unparsable');
  await markMcpRecordsNoted(manifestPath, manifest, targets.filter((target) => unnoted(target.file)
    && (unclaimed.has(target.file) ? noted.has(target.file) : parses(target))));
}

/**
 * Note the servers no record claimed in each config a pull that found no
 * managed-mcp.json listed for them (#882): once its manifest is back, a stale
 * entry teamai wrote looks like the member's own. After the settle, which
 * records the file. Returns the files whose servers are noted now.
 */
async function noteUnclaimedMcpServers(localConfig: LocalConfig, unclaimed: Map<string, string[]>): Promise<Set<string>> {
  if (unclaimed.size === 0) return new Set();
  const found = [...unclaimed].map(([file, names]) => ({ file, names }));
  const result = await recordUnverifiedMcpServers(localConfig, found).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  // Read back: a file the settle did not record takes no note.
  const { files } = await readResolvedMcpFiles(localConfig);
  const noted = new Set(found.filter(({ file, names }) => names.every((name) => files[file]?.unverified?.includes(name))).map((f) => f.file));
  const missed = found.filter((f) => !noted.has(f.file)).map((f) => f.file);
  if (missed.length > 0) {
    const why = result === 'locked' ? 'another teamai command held managed-mcp-files.json past the wait'
      : result === 'written' || result === 'unchanged' ? 'managed-mcp-files.json has no record of the file' : result;
    log.debug(
      `Did not note the MCP servers teamai found in ${missed.join(', ')} that no managed-mcp.json record claims: ${why}. `
      + 'They keep their .git/info/exclude lines while they hold MCP servers; the next pull tries again.',
    );
  }
  return noted;
}

/**
 * Take the unnoted mark off the records of `targets`' tools, whose files'
 * other servers are noted (#882). A failed write keeps it: the file keeps its
 * line while it holds a server, and the next pull notes them again.
 */
async function markMcpRecordsNoted(manifestPath: string, manifest: ManagedMcpManifest, targets: McpTarget[]): Promise<void> {
  let changed = false;
  for (const { tool } of targets) {
    for (const record of manifest[managedMcpManifestKey(tool, true)] ?? []) {
      changed ||= record.unnoted === true;
      delete record.unnoted;
    }
  }
  if (!changed) return;
  await writeJsonAtomic(manifestPath, manifest).catch((e: unknown) => {
    log.debug(`Did not update ${manifestPath}: ${e instanceof Error ? e.message : String(e)}. The next pull notes its MCP configs' other servers again.`);
  });
}

/**
 * Take out of teamai's block in `.git/info/exclude` the line of each project
 * MCP config proven free of a value teamai resolved (#882), in every worktree
 * sharing it: `teamai mcp remove` leaves nothing of teamai's to protect. A
 * config not proven clean keeps its line.
 */
export async function releaseCleanMcpGitExcludes(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<void> {
  const { projectRoot } = localConfig;
  if (localConfig.scope !== 'project' || !projectRoot || localConfig.repo.kind === 'http') return;
  try {
    await releaseMcpGitExcludes(teamConfig, localConfig, projectRoot, []);
    const { manifest } = await loadProjectMcpManifest(getDataHome(localConfig), projectRoot, { dryRun: true });
    const mapped = await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true });
    const unmapped = await unmappedMcpDefaults(mapped);
    const targets = mapped.filter((target) => !unmapped.has(target));
    await settleRecordedMcpConfigs(localConfig, await observeMcpConfigs(localConfig, targets, manifest, async () => false));
  } catch (e) {
    log.warn(
      `Could not check whether this project's MCP configs still need their .git/info/exclude lines: ${e instanceof Error ? e.message : String(e)}. `
      + 'The lines stay; `teamai uninstall` removes them.',
    );
  }
}

/**
 * Remove each line of teamai's block whose files are all proven clean or in
 * `addedNow`: files this run listed and holds no evidence for, whose line it
 * takes back out even when they cannot be proven clean (one that does not parse).
 * A line of a file in `kept` stays: this run found it holding by a record it
 * has not written yet.
 */
async function releaseMcpGitExcludes(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  projectRoot: string,
  addedNow: string[],
  before?: ManagedMcpManifest,
  kept: string[] = [],
): Promise<void> {
  // Every checkout sharing a line judges it, also the main checkout `git worktree list` leaves out (#915).
  const { projectCheckouts } = await import('./pull.js');
  const dirs = [projectRoot, ...await projectCheckouts(localConfig)];
  const files = [
    ...(await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true })).map((target) => target.file),
    ...Object.keys((await readResolvedMcpFiles(localConfig)).files),
  ];
  // Also where a symlink there points: the line of a linked file is in its target's repository.
  for (const file of files) dirs.push(path.dirname(file), path.dirname(await realFilePath(file)));
  const excludes = await findMcpGitExcludes(dirs);
  if (excludes.size === 0) return;
  // Keyed as findMcpGitExcludes keys them: by real path (macOS /var).
  const exempt = new Set(await Promise.all(addedNow.map(realFilePath)));
  const keep = new Set(await Promise.all(kept.map(realFilePath)));
  const held = await mcpConfigsNotProvenClean(
    teamConfig,
    localConfig,
    [...excludes.values()].flat(),
    { before, otherWorktrees: 'empty' },
  );
  for (const [excludeFile, entries] of excludes) {
    const cleanEntries = entries.filter((entry) => entry.files.every((file) => (!held.has(file) || exempt.has(file)) && !keep.has(file)));
    const clean = cleanEntries.map((entry) => entry.pattern);
    if (clean.length === 0) continue;
    const result = await removeMcpGitExclude(excludeFile, clean);
    if (result === 'written') {
      // A line this run added and took back out is no change the member saw.
      const rolledBack = cleanEntries.filter((entry) => entry.files.some((file) => exempt.has(file))).map((entry) => entry.pattern);
      const released = clean.filter((pattern) => !rolledBack.includes(pattern));
      if (released.length > 0) log.info(`Removed ${released.join(', ')} from ${excludeFile}: no MCP config there holds a value teamai resolved.`);
      if (rolledBack.length > 0) log.debug(`Took ${rolledBack.join(', ')} back out of ${excludeFile}: this run wrote no resolved value there.`);
    }
    // Left as it is: the next pull tries again.
    if (result === 'locked') log.debug(`Kept ${clean.join(', ')} in ${excludeFile}: another teamai command held it past the wait.`);
  }
}

async function reconcileTargets(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  options: McpReconcileOptions,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
  recorded: McpTarget[],
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<McpReconcileResult> {
  const changes: McpChange[] = [];
  let wrote = false;
  let unparsed = false;

  const sharing = getMcpSharing(teamConfig);
  const removeAll = options.removeAll === true;

  // HTTP-mode teams have no repo tree: team MCP servers are delivered through
  // the local-agent install_mcp channel and recorded in the same
  // managed-mcp.json this function prunes against. Running the desired-set
  // reconcile here would see an always-empty desired set and delete every
  // HTTP-installed server on each session-start sync. Skip it — the explicit
  // removeAll teardown (teamai uninstall) must still run.
  if (localConfig.repo.kind === 'http' && !removeAll) {
    return { changes, wrote };
  }

  let teamDefs: McpServerDef[] = [];
  // The servers a workspace holds back (#913): each tool keeps what it has installed for them.
  let held = new Set<string>();
  if (!removeAll) {
    // A file that does not parse, or a server name defined twice, keeps every
    // installed server as it is: reconciling to an empty set would remove them.
    const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
    reportEntryResolution(resolution);
    if (resolution.kind === 'failed') return { changes, wrote, unresolved: true };
    teamDefs = resolution.entries.map((entry) => teamMcpToDef(entry.entry));
    held = new Set(resolution.held);
  }
  if (!removeAll && teamDefs.length > 0 && !sharing.autoApply) {
    log.info(`${teamDefs.length} team MCP server(s) available. Run \`teamai mcp inject\` to apply.`);
    return { changes, wrote };
  }
  const targets = await resolveMcpTargets(teamConfig, localConfig);
  if (targets.length === 0) return { changes, wrote };
  // Whose entries a file holds is judged with every tool mapping it, detected or not (#993):
  // detection decides where teamai writes, never what it may delete.
  const claimTargets = await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true });

  const { manifestPath, manifest } = await loadMcpManifest(localConfig, options.dryRun);
  // An adoption (#993) records a server without writing its file: the manifest must still be saved.
  const manifestBefore = JSON.stringify(manifest);

  // An empty desired set still has to run: it is how servers dropped from
  // mcp.yaml get cleaned out of the tools we previously injected them into.
  // Other checkouts' local scopes count too: `leaveGoneCheckouts` and `leaveOtherLocalScopes` take theirs out below.
  const others = localConfig.scope === 'project' ? Object.values(await readManifest(localMcpManifestPath(localConfig))) : [];
  const nothingOwned = [...Object.values(manifest), ...others].every((r) => !Array.isArray(r) || r.length === 0);
  // A server the team deleted can still sit unrecorded in a tool's file (#993): only target
  // files with no server at all prove there is nothing to look for, without reading the history.
  if (teamDefs.length === 0 && nothingOwned && !await someMcpEntryInstalled(targets)) return { changes, wrote };
  const history = teamMcpHistory(localConfig);
  // The files an earlier pull recorded, and each record this run rebuilds after it was lost (#882).
  const ledger = localConfig.scope === 'project' && !options.dryRun ? (await readResolvedMcpFiles(localConfig)).files : {};
  const listed = new Set(Object.keys(ledger));
  const rebuilt: Array<{ target: McpTarget; records: ManagedMcpRecord[] }> = [];
  // The tools with no record in managed-mcp.json when this pull began (#882): theirs are marked below.
  const unrecorded = new Set(localConfig.scope === 'project' && !options.dryRun
    ? targets.filter((t) => !t.projectKey && manifest[managedMcpManifestKey(t.tool, true)] === undefined).map((t) => t.tool) : []);

  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig, options);
  // A failed declaration is not "no secrets": read as none, every server whose
  // secret the member left in their shell would be removed. Keep what is
  // installed rather than guess which variables are secrets. `removeAll`
  // (mcp remove, uninstall) still removes everything.
  if (!removeAll && desiredContext.secrets.kind === 'failed') {
    reportEntryResolution(desiredContext.secrets);
    return { changes, wrote, unresolved: true };
  }

  // Which of this team's servers apply to each tool, and in what rendered
  // form. Targets that share one file under one ownership record
  // (MCP_MANIFEST_KEY_ALIAS) reconcile as one: their per-tool desired sets
  // differ (`tools:` on a server), and either alone would read the shared
  // record, find the sibling's entry unwanted, and remove it from the file —
  // so every sharer works from the union of their desired sets.
  const desiredOf = new Map<McpTarget, ReturnType<typeof desiredMcpForTarget>>();
  const live = targets.filter((t) => removeAll || !mcpTargetExcluded(localConfig, t));
  for (const target of live) {
    const desired = desiredMcpForTarget(target, teamDefs, desiredContext);
    for (const name of held) desired.kept.add(name);
    desiredOf.set(target, desired);
  }
  for (const target of live) {
    const mine = desiredOf.get(target)!;
    for (const other of live) {
      if (other === target || other.file !== target.file) continue;
      if (mcpManifestKey(other) !== mcpManifestKey(target)) continue;
      for (const [name, entry] of desiredOf.get(other)!.desired) mine.desired.set(name, entry);
      for (const name of desiredOf.get(other)!.kept) mine.kept.add(name);
    }
  }

  for (const resolved of targets) {
    // Same enabledAgents / disabledAgents gate as the other resource syncs. The
    // manifest entry is left as is: an excluded tool is skipped, not cleaned,
    // and `removeAll` (uninstall) still reaches every tool.
    if (!removeAll && mcpTargetExcluded(localConfig, resolved)) continue;
    const manifestKey = mcpManifestKey(resolved);

    // Which of this team's servers apply to this tool, and in what rendered form.
    const { desired, skipped, kept } = desiredOf.get(resolved)!;
    changes.push(...skipped);
    // Whose an unrecorded entry is in each file this run reads for the tool. A held server's is not
    // this run's to judge (#913): an entry of it whose record was lost stays where it is, except one
    // equal to the entry a held move brings to that file, which is adopted as a relocation adopts one.
    const judgeIn = async (
      t: McpTarget,
      { moved = new Map(), others }: { moved?: ReadonlyMap<string, DesiredMcpEntry>; others?: ReadonlySet<string> } = {},
    ): Promise<McpEntryJudge> => {
      const otherTools = others ?? await claimedByOtherTools(claimTargets, t, manifest);
      const judgeHere = judgeUnrecordedMcpEntry(localConfig, t, desired, desiredContext.vars, new Set([...otherTools, ...held]), history);
      return async (name, entry, recordedHash) => !otherTools.has(name) && moved.has(name)
        && (recordedHash === undefined || moved.get(name)?.hash === recordedHash) && isDeepStrictEqual(moved.get(name)?.entry, entry)
        ? 'teamai' : judgeHere(name, entry, recordedHash);
    };
    const judge = await judgeIn(resolved);
    // A file an earlier teamai created that hides a later one, holding only teamai's servers, is left (#993).
    const leaving = removeAll ? null : await leaveFormerMcpFile(resolved, manifest[manifestKey] ?? [], judge);
    const target = leaving ? { ...resolved, file: leaving.next } : resolved;
    const records = [...manifest[manifestKey] ?? [], ...leaving?.adopted ?? []];
    // Records of servers in another file the tool does not read (#993) are moved out of it below.
    const split = await splitByFile(target, records);
    const { owned, left } = split;
    // Uninstall takes teamai's servers out of a file the tool left too; a copy the member changed stays.
    const elsewhere = removeAll ? [...split.elsewhere, ...left] : split.elsewhere;
    const ownedNames = new Set(owned.map((r) => r.name));
    const moving = removeAll ? new Map<string, DesiredMcpEntry>()
      : await heldMcpEntriesToMove(teamConfig, localConfig, target, held, manifest, elsewhere.filter((r) => !ownedNames.has(r.name)), history);
    const nextRecords: ManagedMcpRecord[] = [];
    // Their old records, so a manifest this run writes still claims them.
    const keep = new Map(owned.filter((r) => kept.has(r.name)).map((r) => [r.name, r]));

    // A resolved value lands only in a file git leaves out of a commit (#882).
    // Otherwise the file stays as it was, its manifest entry with it. A held
    // server moved as installed holds one when its record says so (#913).
    if (carriesResolvedValue(target, teamDefs, desired.keys())
      || (target.projectScope && !target.projectKey && [...moving.values()].some((entry) => entry.resolvedValue))) {
      const exclusion = exclusions.get(target.file) ?? await ensureExcludedFromGit(target.file, { dryRun: options.dryRun });
      exclusions.set(target.file, exclusion);
      if (exclusion.kind === 'failed') {
        const reason = `${target.file} is not kept out of git: ${exclusion.reason}`;
        for (const server of desired.keys()) changes.push({ tool: target.tool, server, action: 'skipped', reason });
        log.warn(
          `Did not write ${target.tool}'s MCP servers to ${target.file}: it would hold resolved values, and teamai could not `
          + `keep it out of git first: ${exclusion.reason}. The file is left as it was. ${exclusion.fix}`,
        );
        continue;
      }
      // Recorded before the write, so a later change to toolPaths still finds the file.
      if (!options.dryRun) {
        await recordResolvedMcpFile(localConfig, target);
        if (!ledger[target.file]?.tools.includes(target.tool)) recorded.push(target);
      }
    }

    // A held server leaves where it was installed only once this file holds it under a record (#913):
    // another entry of that name here is the member's, and the server stays where it is, with its record.
    const blocked = new Set<string>();
    const step = await applyMcpFileThenOthers({
      file: target.file, nextRecords, options,
      apply: async () => {
        const result = await applyMcpFile(target, moving.size > 0 ? new Map([...desired, ...moving]) : desired, keep, owned, ownedNames, nextRecords, changes,
          moving.size > 0 ? await judgeIn(target, { moved: moving }) : judge, options, restoreConfigs);
        if (result) {
          written.add(target.file);
          // A project config a pull leaves with no team server goes, as one a cleanup empties.
          if (!removeAll && target.projectScope && target.projectKey === undefined) {
            await deleteEmptiedMcpFile(target.file, target.format === 'codex' ? null : mcpKeyOf(target));
          }
        }
        return result;
      },
      cleanOthers: async () => {
        if (!removeAll) logLeftMcpFiles(localConfig, target, left);
        for (const [name, { hash }] of moving) if (!nextRecords.some((r) => r.name === name && r.hash === hash)) blocked.add(name);
        const leavingElsewhere = elsewhere.filter((r) => !blocked.has(r.name));
        let cleaned = false;
        // Every record is cleaned in the file it names: OpenCode's other project file, or any other.
        let apart = leavingElsewhere;
        if (target.mappedFile && target.alternateFile) {
          const other = target.file === target.mappedFile ? target.alternateFile : target.mappedFile;
          const inOther: ManagedMcpRecord[] = [];
          apart = [];
          for (const r of leavingElsewhere) (await sameMcpFile(recordedFileOf(target, r), other) ? inOther : apart).push(r);
          cleaned = await moveOpencodeServers(target, other, inOther, nextRecords, changes, await judgeIn({ ...target, file: other }), options, restoreConfigs) || cleaned;
        }
        if ((target.mappedFile && !target.alternateFile) || apart.length > 0) {
          // Each file is judged with the records of the tools that write it: a lookup file may link to another tool's.
          const judgeFor = (place: McpTarget): Promise<McpEntryJudge> => judgeIn({ ...resolved, file: place.file, key: mcpKeyOf(place) });
          cleaned = await removeFromOtherFiles(target, apart, nextRecords, changes, judgeFor, options, restoreConfigs, leaving?.former) || cleaned;
          if (leaving) {
            const names: string[] = [];
            for (const r of apart) if (await sameMcpFile(recordedFileOf(target, r), leaving.former)) names.push(r.name);
            cleaned = await deleteLeftMcpFile(target, leaving.former, names, options, restoreConfigs) || cleaned;
          }
        }
        nextRecords.push(...elsewhere.filter((r) => blocked.has(r.name)));
        return cleaned;
      },
    });
    // Not read: its records stay as they were, or absent. An empty one would say teamai owns nothing there (#882).
    if (step === null || !step.read) unparsed = true;
    if (step === null) continue;
    wrote = step.wrote || wrote;

    // The unnoted mark stays until a note of what else is in the file lands.
    const marked = manifest[manifestKey]?.some((record) => record.unnoted) ?? false;
    // Whether each entry holds a resolved value: once its definition stops
    // needing one, what this pull wrote still does (#882).
    if (target.projectScope) {
      for (const record of nextRecords) {
        // A record kept in a file this run did not write says what it said: an older one's silence keeps the credential hold.
        if (!elsewhere.includes(record)) record.resolved ??= moving.get(record.name)?.resolvedValue || carriesResolvedValue(target, teamDefs, [record.name]);
        if (marked) record.unnoted = true;
        else delete record.unnoted;
      }
    }
    // Rebuilt this run, or by one that could not note what else was in the file.
    const unnoted = manifest[manifestKey] === undefined || manifest[manifestKey].some((record) => record.unnoted);
    if (!step.read) nextRecords.unshift(...owned);
    else if (listed.has(target.file) && unnoted && nextRecords.length > 0) rebuilt.push({ target, records: nextRecords });
    // An emptied project record stays: it says teamai owns nothing left in that
    // file, which a lost record cannot, and so lets its exclude line go (#882).
    // Not while the file's other servers are unnoted: it would say the same.
    if (nextRecords.length > 0 || (target.projectScope && manifest[manifestKey] !== undefined && !marked)) manifest[manifestKey] = nextRecords;
    else delete manifest[manifestKey];

    // The tool's other place for them (#915): what teamai wrote there goes, as sharing.gitExclude moved them.
    if (localMcpScopeOf(target.tool) && target.projectScope) {
      wrote = await leaveMcpLocation(teamConfig, localConfig, target, {
        kept: new Set([...kept].filter((name) => !moving.has(name) || blocked.has(name))), manifest, claimTargets, changes, judgeIn, options, restoreConfigs,
      }) || wrote;
      // The local scope of a worktree that is gone, for a tool that files each worktree under a key of its own (#915).
      const local = localMcpScopeOf(target.tool)?.key === 'realpath' ? (await projectMcpLocations(teamConfig, localConfig, target.tool))?.local : undefined;
      if (local) {
        wrote = await leaveGoneCheckouts(localConfig, manifest, local, {
          desired, changes, vars: desiredContext.vars, history, options, restoreConfigs,
        }) || wrote;
      }
      if (removeAll || !target.projectKey) {
        wrote = await leaveOtherLocalScopes(teamConfig, localConfig, target.tool, { manifest, changes, options, restoreConfigs }) || wrote;
      }
    }
  }

  // A record of a tool that had none when this pull began, of a file holding a server no record claims, is
  // unnoted until protectProjectMcpConfigs notes that server, after its settle records the file.
  for (const target of targets.filter((t) => unrecorded.has(t.tool))) {
    const records = manifest[managedMcpManifestKey(target.tool, true)] ?? [];
    // Only tools reading the same key claim: another key's owner proves nothing of this one's (#882).
    const claimed = targets.filter((t) => t.file === target.file && sameServerKey(t.format, target.format))
      .flatMap((t) => manifest[managedMcpManifestKey(t.tool, true)] ?? []).map((record) => record.name);
    if (records.length > 0 && (await unclaimedMcpServers(target, claimed)).length > 0) {
      for (const record of records) record.unnoted = true;
    }
  }
  if (!options.dryRun && (wrote || rebuilt.length > 0 || JSON.stringify(manifest) !== manifestBefore)) {
    // Before the manifest: once it is written, only a record marked unnoted says it was rebuilt.
    const failed = await noteUnverifiedMcpServers(localConfig, rebuilt);
    for (const { records } of rebuilt) {
      for (const record of records) {
        if (failed.includes(records)) record.unnoted = true;
        else delete record.unnoted;
      }
    }
    await saveMcpManifest(localConfig, manifestPath, manifest);
  }
  // Only committed ownership retains a file record added by this run. On failure,
  // the outer cleanup removes it before inspecting the restored configs.
  for (let index = recorded.length - 1; index >= 0; index--) {
    const target = recorded[index];
    if (manifest[mcpManifestKey(target)]?.some((record) => record.resolved === true)) recorded.splice(index, 1);
  }
  return unparsed ? { changes, wrote, unparsed } : { changes, wrote };
}

/**
 * Note, for each file whose lost record this run rebuilt, the servers in it
 * the new record does not claim: a stale entry teamai wrote looks like the
 * member's own once its value is no longer set (#882). Returns the records of
 * each file it could not note them for: the manifest write marks them
 * unnoted, so the file keeps its line and the next pull tries again, and
 * still owns what this one wrote.
 */
async function noteUnverifiedMcpServers(
  localConfig: LocalConfig,
  rebuilt: Array<{ target: McpTarget; records: ManagedMcpRecord[] }>,
): Promise<ManagedMcpRecord[][]> {
  const found: Array<{ file: string; names: string[]; records: ManagedMcpRecord[] }> = [];
  for (const { target, records } of rebuilt) {
    const installed = await installedMcpEntries(target);
    const names = [...installed?.keys() ?? []].filter((name) => !records.some((record) => record.name === name));
    if (names.length > 0) found.push({ file: target.file, names, records });
  }
  if (found.length === 0) return [];
  const result = await recordUnverifiedMcpServers(localConfig, found).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  if (result === 'written' || result === 'unchanged') return [];
  log.debug(
    `Did not note the MCP servers teamai found in ${found.map((f) => f.file).join(', ')} while rebuilding its lost record of them: `
    + `${result === 'locked' ? 'another teamai command held managed-mcp-files.json past the wait' : result}. `
    + 'They keep their .git/info/exclude lines while they hold MCP servers; the next pull tries again.',
  );
  return found.map((f) => f.records);
}

/**
 * `trackResolvedMcpFiles` for a file about to get a resolved value. A failure
 * does not stop the write: the exclusion protects the file, and the next pull
 * records it.
 */
async function recordResolvedMcpFile(localConfig: LocalConfig, target: McpTarget): Promise<void> {
  const result = await trackResolvedMcpFiles(localConfig, [target]).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  if (result !== 'written' && result !== 'unchanged') {
    log.debug(`Did not record ${target.file} in managed-mcp-files.json: ${result === 'locked' ? 'another teamai command held it past the wait' : result}. The next pull records it.`);
  }
}

/**
 * `untrackResolvedMcpFiles`. A failure leaves the record, and the file its
 * line while it holds a server once no mapping reaches it.
 */
async function forgetUnwrittenMcpConfigs(localConfig: LocalConfig, targets: McpTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const result = await untrackResolvedMcpFiles(localConfig, targets).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  if (result !== 'written' && result !== 'unchanged') {
    log.debug(`Did not take ${targets.map((t) => t.file).join(', ')} back out of managed-mcp-files.json: ${result === 'locked' ? 'another teamai command held it past the wait' : result}.`);
  }
}

/**
 * Whether the bare Copilot server `name` beside `mcpServers` is the copy a teamai write left before another tool
 * added the key (#882): a completed bare write in `owned`, with matching content. A member's own server of that name,
 * or one edited since, is left alone.
 */
export function isTeamaiBareCopy(doc: { beside?: Record<string, unknown> }, name: string, owned: readonly ManagedMcpRecord[]): boolean {
  const bare = doc.beside?.[name];
  return bare !== undefined && owned.some((record) => record.name === name && record.bare === true && record.hash === entryHash(bare));
}

/** Copilot project ownership without placement needs a matching, unambiguous entry. */
export function ownsJsonMcpEntry(
  doc: Pick<JsonDoc, 'bare' | 'servers' | 'beside'>,
  name: string,
  owned: readonly ManagedMcpRecord[],
  allowBare: boolean,
): boolean {
  return owned.some((record) => {
    if (record.name !== name) return false;
    if (!allowBare) return record.bare !== true;
    if (record.bare !== undefined) return record.bare === doc.bare;
    const entry = doc.servers[name];
    const beside = doc.beside?.[name];
    return entry !== undefined && record.hash === entryHash(entry)
      && (beside === undefined || record.hash !== entryHash(beside));
  });
}

/** Muse saves stdio entries without the inferred type; retain the original render for ownership hashes. */
function normalizeMuseServers(target: McpTarget, servers: Record<string, unknown>): void {
  if (target.format !== 'muse') return;
  for (const [name, value] of Object.entries(servers)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry.type === undefined && typeof entry.command === 'string' && entry.url === undefined) {
      servers[name] = { type: 'stdio', ...entry };
    }
  }
}

// ─── Appliers ────────────────────────────────────────────────

/** `judgeUnrecordedMcpEntry` for one target. */
type McpEntryJudge = (name: string, entry: unknown, recordedHash?: string) => Promise<UnrecordedMcpOwner>;

/**
 * A server this tool's record does not claim, left as it is: another tool's,
 * or the member's own under a team server's name, whose team server is then
 * not written to that file (#993).
 */
function unrecordedServerKept(target: McpTarget, name: string, owner: Exclude<UnrecordedMcpOwner, 'teamai'>): McpChange {
  const change: McpChange = { tool: target.tool, server: name, action: 'skipped', reason: UNRECORDED_SERVER_REASON };
  return owner === 'member' ? { ...change, file: target.file, member: true } : change;
}

/**
 * Reconcile `target`'s file in its format: every write to a tool's MCP file goes through here, the
 * cleanup of a file the tool no longer reads too (a Codex config.toml a moved root left, #1221).
 */
async function applyMcpFile(...args: Parameters<typeof applyJson>): ReturnType<typeof applyJson> {
  return args[0].format === 'codex' ? await applyCodex(...args) : await applyJson(...args);
}

/** Whether it wrote `target`'s file; null when the file does not parse, and so was not read. */
async function applyJson(
  target: McpTarget,
  desired: Map<string, DesiredMcpEntry>,
  keep: Map<string, ManagedMcpRecord>,
  owned: ManagedMcpRecord[],
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  judge: McpEntryJudge,
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<boolean | null> {
  const serverKey = mcpKeyOf(target);
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, serverKey, allowBare, target.projectKey);
  if (!doc) {
    log.warn(`Could not parse ${target.file} — skipping MCP injection for ${target.tool}`);
    return null;
  }
  const existed = await pathExists(target.file);
  const previousData = structuredClone(doc.data);
  const comparable = { ...doc, servers: { ...doc.servers } };
  normalizeMuseServers(target, comparable.servers);

  const ownedHere = owned.filter((record) => ownsJsonMcpEntry(comparable, record.name, [record], allowBare));
  const ownedHash = new Map(ownedHere.map((r) => [r.name, r.hash]));
  let dirty = false;
  // A kept entry holds the value an earlier pull resolved (desiredMcpForTarget).
  let holdsResolvedValue = false;

  for (const [name, { entry, hash, resolvedValue }] of desired) {
    const existing = doc.servers[name];
    // An entry with no record is teamai's when it equals a team render of `name` (#993), and is adopted.
    const unrecorded = existing !== undefined && !ownsJsonMcpEntry(comparable, name, owned, allowBare) && !options.force;
    const owner = unrecorded ? await judge(name, comparable.servers[name]) : 'teamai';
    if (owner !== 'teamai') {
      changes.push(unrecordedServerKept(target, name, owner));
      const previous = owned.find((record) => record.name === name);
      if (previous) nextRecords.push(previous);
      continue;
    }
    const record: ManagedMcpRecord = { name, hash };
    if (target.format === 'muse') record.valueHash = museEntryHash(entry);
    if (allowBare && !doc.bare) record.bare = false;
    if (doc.bare && owned.some((r) => r.name === name && r.bare === true)) record.bare = true;
    nextRecords.push(record);
    holdsResolvedValue ||= resolvedValue;
    // The copy a bare write left before another tool added the key would keep the old value beside this one (#882).
    if (isTeamaiBareCopy(doc, name, owned)) {
      delete doc.data[name];
      dirty = true;
    }
    if (existing !== undefined && (unrecorded ? entryHash(comparable.servers[name]) : ownedHash.get(name)) === hash) {
      if (unrecorded && options.dryRun) log.info(describeAdoptionPreview(target, name));
      continue;
    }
    doc.servers[name] = entry;
    if (doc.bare) record.bare = true;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: existing === undefined ? 'added' : 'updated' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    const previous = ownedHere.find((record) => record.name === name);
    // Muse's content fingerprint survives native key reordering. Legacy records
    // need a historical render with both the recorded hash and the installed value.
    if (options.removeAll && previous && doc.servers[name] !== undefined && entryHash(comparable.servers[name]) !== previous.hash
      && !(target.format === 'muse' && (previous.valueHash !== undefined
        ? previous.valueHash === museEntryHash(doc.servers[name])
        : await judge(name, comparable.servers[name], previous.hash) === 'teamai'))) {
      log.warn(`Kept MCP server ${name} in ${describeMcpLocation(target)}: you changed it since teamai wrote it. `
        + 'Remove it there when you no longer need it.');
      continue;
    }
    const kept = keep.get(name);
    if (kept && ((ownsJsonMcpEntry(comparable, name, owned, allowBare) && doc.servers[name] !== undefined) || isTeamaiBareCopy(doc, name, owned))) {
      nextRecords.push(kept);
      holdsResolvedValue = true;
      continue;
    }
    if (ownsJsonMcpEntry(comparable, name, owned, allowBare) && doc.servers[name] !== undefined) {
      delete doc.servers[name];
      dirty = true;
    }
    // One a bare write left before another tool added the key goes too (#882).
    if (isTeamaiBareCopy(doc, name, owned)) {
      delete doc.data[name];
      dirty = true;
    }
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  // An unrecorded entry of a server the team deleted is teamai's when it equals a render of that
  // server from the team history (#993), and goes like any other server teamai no longer delivers.
  for (const [name, entry] of Object.entries(doc.servers)) {
    if (desired.has(name) || ownedNames.has(name) || await judge(name, comparable.servers[name] ?? entry) !== 'teamai') continue;
    if (options.dryRun) log.info(describeRemovedServerPreview(target, name));
    delete doc.servers[name];
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  if (options.dryRun) return false;
  if (!dirty) {
    if (holdsResolvedValue) await tightenMode(target.file);
    return false;
  }

  // Key-level surgery: every unrelated top-level key is carried over untouched.
  // Some tools (OpenCode) key the server map under `mcp`, not `mcpServers`;
  // writing the wrong key would strip the servers and, worse, leave a phantom
  // empty `mcpServers` in a file the tool never reads under that name.
  // A file that holds a resolved value is the member's alone, an existing one tightened.
  // Keyed by real path: two tools' paths may reach one file, which keeps the state before its first write.
  const snapshotKey = await realFilePath(target.file);
  // Muse Code refuses a settings.json without `schema_version: 1`.
  if (target.format === 'muse' && !target.projectScope && doc.data.schema_version === undefined) {
    doc.data = { schema_version: 1, ...doc.data };
  }
  await writeJsonDoc(target.file, serverKey, doc, holdsResolvedValue ? { mode: 0o600 } : undefined);
  if (!restoreConfigs.has(snapshotKey)) {
    restoreConfigs.set(snapshotKey, existed
      ? () => writeMcpJson(target.file, previousData)
      : () => removeCreatedMcpFile(target.file));
  }
  return true;
}

/**
 * Reconcile a tool's current MCP file with `apply`, then the other files its
 * records name with `cleanOthers`: the order every place teamai's servers are
 * in follows (#1221). A current file that does not parse, or cannot be read,
 * keeps its records, which the caller puts back after noting what this run
 * wrote. A pull then stops: it moves nothing out of another file while the one
 * it moves them to is not read. Uninstall cleans the other files anyway, as
 * what happens there does not depend on the current one. Null when the pull
 * stopped; else whether it read the current file, and whether it wrote a file.
 */
async function applyMcpFileThenOthers(step: {
  file: string;
  nextRecords: ManagedMcpRecord[];
  options: McpReconcileOptions;
  apply: () => Promise<boolean | null>;
  cleanOthers: () => Promise<boolean>;
}): Promise<{ read: boolean; wrote: boolean } | null> {
  const current = await step.apply();
  if (current === null && !step.options.removeAll) return null;
  for (const record of step.nextRecords) record.file = step.file;
  const cleaned = await step.cleanOthers();
  return { read: current !== null, wrote: current === true || cleaned };
}

/**
 * Take teamai's servers out of the files its records `elsewhere` place them
 * in, and out of the other files of the tool's lookup order, none of which
 * `target`'s tool reads (#993): a pull writes them to the file it reads,
 * uninstall and `teamai mcp remove` remove them. Only entries those records
 * claim, or that `judge` proves teamai's (a lost record), are touched; a file
 * is compared by real path, so an alias of `target.file` is never touched. A
 * file that does not parse keeps them, and their records (`nextRecords`).
 * Whether it wrote a file.
 */
async function removeFromOtherFiles(
  target: McpTarget,
  elsewhere: ManagedMcpRecord[],
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  judgeFor: (place: McpTarget) => Promise<McpEntryJudge>,
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
  /** A file `deleteLeftMcpFile` deletes and reports. */
  leaving?: string,
): Promise<boolean> {
  // By place: a retired key in `target`'s own file is another place (ZCode's `mcpServers` beside `mcp.servers`).
  const byPlace = new Map<string, { place: McpTarget; real: string; records: ManagedMcpRecord[] }>();
  const add = async (place: McpTarget, records: ManagedMcpRecord[]): Promise<void> => {
    if (await sameMcpPlace(place, target)) return;
    const real = await realFilePath(place.file);
    const id = JSON.stringify([real, mcpKeyOf(place)]);
    const group = byPlace.get(id) ?? { place, real, records: [] };
    group.records.push(...records);
    byPlace.set(id, group);
  };
  for (const record of elsewhere) await add(recordedPlaceOf(target, record), [record]);
  // With no record left there, an entry teamai wrote is still found by `judge`; a file holding no server is not read.
  for (const file of target.lookupFiles ?? []) {
    if (((await installedMcpEntries({ ...target, file }))?.size ?? 0) > 0) await add({ ...target, file }, []);
  }
  const left = leaving ? await realFilePath(leaving) : undefined;
  let wrote = false;
  for (const { place, real, records } of byPlace.values()) {
    const { file } = place;
    const names = new Set(records.map((r) => r.name));
    const removed: McpChange[] = [];
    const result = await applyMcpFile(place, new Map(), new Map(), records, names, [], removed, await judgeFor(place), options, restoreConfigs);
    if (result === null) {
      nextRecords.push(...records);
      continue;
    }
    wrote ||= result;
    changes.push(...removed);
    if (!options.removeAll && removed.length > 0 && real !== left) {
      const inTargetFile = await sameMcpFile(file, target.file);
      const why = target.lookupFiles?.includes(file)
        ? `${target.tool} reads only ${target.file}, the first of its ${target.projectScope ? 'project' : 'user'} MCP files that exists.`
        : `${target.tool} reads them from ${inTargetFile ? `${mcpKeyOf(target).join('.')} there` : target.file} now.`;
      const from = inTargetFile ? `${mcpKeyOf(place).join('.')} in ${file}` : file;
      log.info(`${options.dryRun ? 'Would take' : 'Took'} teamai's MCP servers for ${target.tool} (${removed.map((c) => c.server).join(', ')}) out of ${from}: ${why}`);
    }
  }
  return wrote;
}

/**
 * Name, once, the servers `left` records in a file `target`'s tool no longer
 * takes them from (#1221): their record goes, so the next pull does not.
 */
export function logLeftMcpFiles(localConfig: LocalConfig, target: McpTarget, left: readonly ManagedMcpRecord[]): void {
  const byFile = new Map<string, string[]>();
  for (const record of left) {
    const file = recordedFileOf(target, record);
    byFile.set(file, [...byFile.get(file) ?? [], record.name]);
  }
  for (const [file, names] of byFile) {
    log.info(`[${localConfig.scope}] ${target.tool} takes MCP servers from ${describeMcpLocation(target)} now, so teamai no longer updates its entries in ${file} `
      + `(${names.join(', ')}). Remove them once no tool reads that file.`);
  }
}

/** Why a tool reads its servers from `active`, as the start of a sentence. */
function movedBecause(teamConfig: TeamaiConfig, localConfig: LocalConfig, active: Pick<McpTarget, 'projectKey'>): string {
  if (active.projectKey) {
    return isGitExcludeEnabled(localConfig, teamConfig) ? 'with sharing.gitExclude on, ' : 'in a workspace with children, so that a session in a child does not load them, ';
  }
  // In a workspace with children the servers come back for a tool that reads `.mcp.json`, whatever git exclude says (#913).
  if (!isGitExcludeEnabled(localConfig, teamConfig) && !hasWorkspaceChildren(localConfig)) return 'with sharing.gitExclude off, ';
  return isSelfMode(localConfig) ? 'in a single-repo team, where each worktree has its own servers, ' : '';
}

/**
 * Take teamai's servers out of the place for them of `active`'s tool (Claude
 * or CodeBuddy) that `active` is not (#915): the project's `.mcp.json` while
 * sharing.gitExclude moves them to the tool's local scope, that local scope
 * once it is off; `removeAll` takes them out of both. Only entries teamai's
 * records claim there, or that equal a render of their name today or in the
 * team's history (`judgeUnrecordedMcpEntry`), go: a name the other tool's
 * record claims in `.mcp.json`, which it still writes (Claude while tclaude
 * reads that file), stays with it, a server kept for a missing secret stays
 * where it is, and a member's own server stays. A local scope teamai holds
 * no record of is not read. A `.mcp.json` left holding nothing is deleted,
 * unless git tracks it. Whether it wrote a file.
 */
async function leaveMcpLocation(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  active: McpTarget,
  ctx: {
    kept: ReadonlySet<string>;
    manifest: ManagedMcpManifest;
    /** Every tool mapping a file, detected or not: whose entries it holds (#993). */
    claimTargets: readonly McpTarget[];
    changes: McpChange[];
    /** The judge of a file for this run, with the names other tools' records there claim. */
    judgeIn: (t: McpTarget, claims: { others: ReadonlySet<string> }) => Promise<McpEntryJudge>;
    options: McpReconcileOptions;
    restoreConfigs: Map<string, () => Promise<void>>;
  },
): Promise<boolean> {
  const places = await projectMcpLocations(teamConfig, localConfig, active.tool);
  if (!places) return false;
  const other = active.projectKey ? places.tree : places.local;
  const key = mcpManifestKey(other);
  const records = ctx.manifest[key];
  const split = await splitByFile(other, records ?? []);
  if (other.projectKey && !records?.length) return false;
  const claimed = other.projectKey
    ? new Set<string>()
    : await claimedByOtherTools(ctx.claimTargets, other, ctx.manifest);
  // A copy the member changed since teamai wrote it is theirs: it stays where it is, named, and its record goes.
  const installed = await installedMcpEntries(other);
  const edited = split.owned.filter((r) => !claimed.has(r.name) && installed?.has(r.name) && entryHash(installed.get(r.name)) !== r.hash);
  for (const { name } of ctx.options.removeAll ? [] : edited) {
    log.warn(`Kept MCP server ${name} in ${describeMcpLocation(other)}: you changed it since teamai wrote it. teamai writes the team's ${name} `
      + `to ${describeMcpLocation(active)} now; remove ${name} from ${describeMcpLocation(other)} when you no longer need it.`);
  }
  const owned = split.owned.filter((record) => !claimed.has(record.name) && (ctx.options.removeAll || !edited.includes(record)));
  const keep = new Map(ctx.options.removeAll ? [] : owned.filter((r) => ctx.kept.has(r.name)).map((r) => [r.name, r]));
  const judge = await ctx.judgeIn(other, { others: claimed });
  const next: ManagedMcpRecord[] = [];
  const removed: McpChange[] = [];
  // As for a target: uninstall takes teamai's servers out of a file the tool left too.
  const elsewhere = ctx.options.removeAll ? [...split.elsewhere, ...split.left] : split.elsewhere;
  const leaving = elsewhere.filter((record) => ctx.options.removeAll || !ctx.kept.has(record.name));
  const step = await applyMcpFileThenOthers({
    file: other.file, nextRecords: next, options: ctx.options,
    apply: () => applyMcpFile(other, new Map(), keep, owned, new Set(owned.map((r) => r.name)), next, removed, judge, ctx.options, ctx.restoreConfigs),
    cleanOthers: () => {
      next.push(...elsewhere.filter((record) => !leaving.includes(record)));
      return removeFromOtherFiles(other, leaving, next, ctx.changes,
        (place) => ctx.judgeIn({ ...other, file: place.file, key: mcpKeyOf(place) }, { others: claimed }), ctx.options, ctx.restoreConfigs);
    },
  });
  if (step === null) return false;
  // Not read: its records stay.
  if (!step.read) next.unshift(...split.owned);
  const { wrote } = step;
  if (!ctx.options.removeAll) logLeftMcpFiles(localConfig, other, split.left);
  ctx.changes.push(...removed);
  // As for a target: an emptied project record says teamai owns nothing left in that file (#882).
  if (next.length > 0 || (!other.projectKey && records !== undefined && !records.some((r) => r.unnoted))) ctx.manifest[key] = next;
  else delete ctx.manifest[key];
  if (removed.length === 0 || ctx.options.removeAll) return wrote;
  log.info(`${ctx.options.dryRun ? 'Would take' : 'Took'} teamai's MCP servers for ${active.tool} (${removed.map((c) => c.server).join(', ')}) `
    + `out of ${describeMcpLocation(other)}: ${movedBecause(teamConfig, localConfig, active)}`
    + `${toolLabel(active.tool)} reads them from ${describeMcpLocation(active)}.`);
  return wrote && !other.projectKey ? await deleteEmptiedMcpFile(other.file) || wrote : wrote;
}

/**
 * The held servers (#913) teamai installed where `active`'s tool does not
 * read them now, unchanged since, as installed, so they move to `active.file`
 * as the servers the workspace delivers do: those its records `elsewhere`
 * place in another file of the tool (OpenCode's two project files, #915), and
 * for Claude and CodeBuddy those in their other place: their local scope in a
 * workspace with children, so that a session in a child does not load them,
 * and the project's `.mcp.json` again once a file reader (Muse Code, tclaude)
 * or self mode puts them there.
 */
async function heldMcpEntriesToMove(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  active: McpTarget,
  held: ReadonlySet<string>,
  manifest: ManagedMcpManifest,
  elsewhere: readonly ManagedMcpRecord[],
  history: () => Promise<TeamMcpHistory>,
): Promise<Map<string, DesiredMcpEntry>> {
  const moving = new Map<string, DesiredMcpEntry>();
  if (held.size === 0) return moving;
  const add = async (record: ManagedMcpRecord, installed: Map<string, unknown> | null, fromLocalScope = false): Promise<void> => {
    const entry = installed?.get(record.name);
    if (held.has(record.name) && entry !== undefined && entryHash(entry) === record.hash) {
      // A local scope's record never notes a resolved value: git sees no file there. Into the project's
      // file, the entry is judged as a delivery is, by the server's definitions, now and before.
      const resolvedValue = record.resolved === true || (fromLocalScope && await definedWithResolvedValue(active, record.name, history));
      moving.set(record.name, { entry, hash: record.hash, resolvedValue });
    }
  };
  for (const record of elsewhere.filter((r) => held.has(r.name))) {
    await add(record, await installedMcpEntries(recordedPlaceOf(active, record)));
  }
  if (!active.projectScope || !localMcpScopeOf(active.tool)) return moving;
  const places = await projectMcpLocations(teamConfig, localConfig, active.tool);
  if (!places) return moving;
  const other = active.projectKey ? places.tree : places.local;
  const installed = await installedMcpEntries(other);
  for (const record of manifest[mcpManifestKey(other)] ?? []) await add(record, installed, other.projectKey !== undefined);
  return moving;
}

/**
 * Whether a definition of `name` the team has now or had (its MCP history)
 * needs a resolved `${VAR}` in `target`'s file (`carriesResolvedValue`). A
 * history that cannot be read counts as yes.
 */
async function definedWithResolvedValue(target: McpTarget, name: string, history: () => Promise<TeamMcpHistory>): Promise<boolean> {
  const versions = await history();
  if (versions === null) return true;
  const file = entryLayout('mcp').file;
  return versions.some((version) => path.posix.basename(version.path) === file
    && (parseTeamMcpServers(version.content.toString('utf8')) ?? []).some((server) => {
      const def = teamMcpToDef(server);
      return def.name === name && mcpTargetTakes(target, server.tools) && carriesResolvedValue(target, [def], [name]);
    }));
}

/**
 * Take teamai's servers out of `local`'s tool's local scope of each checkout
 * of this project that is gone (#915): a key teamai holds records of that names
 * no checkout `projectCheckouts` finds (a removed worktree). Only entries
 * those records claim, or that equal a render of their name today or in the
 * team's history, go; a copy the member changed stays, named, and so does
 * the member's own server. Their
 * records go through `manifest` (`saveMcpManifest`); a `.codebuddy.json` that
 * does not parse keeps them. Whether it wrote the file.
 */
async function leaveGoneCheckouts(
  localConfig: LocalConfig,
  manifest: ManagedMcpManifest,
  local: McpTarget,
  ctx: {
    desired: ReadonlyMap<string, DesiredMcpEntry>;
    changes: McpChange[];
    vars: Record<string, string>;
    history: () => Promise<TeamMcpHistory>;
    options: McpReconcileOptions;
    restoreConfigs: Map<string, () => Promise<void>>;
  },
): Promise<boolean> {
  let wrote = false;
  const prefix = mcpManifestKey({ tool: local.tool, projectScope: true, projectKey: '' });
  const shared = await readManifest(localMcpManifestPath(localConfig));
  const keys = Object.keys(shared).filter((key) => key.startsWith(prefix) && manifest[key] === undefined && Array.isArray(shared[key]));
  if (keys.length === 0) return false;
  const { projectCheckouts } = await import('./pull.js');
  const live = new Set(await projectCheckouts(localConfig));
  for (const key of keys) {
    const root = key.slice(prefix.length);
    if (live.has(root)) continue;
    const kept: ManagedMcpRecord[] = [];
    for (const [file, records] of recordsByFile(shared[key], local.file)) {
      const target: McpTarget = { ...local, file, projectKey: root };
      const installed = await installedMcpEntries(target);
      const edited = ctx.options.removeAll ? []
        : records.filter((r) => installed?.has(r.name) && entryHash(installed.get(r.name)) !== r.hash);
      for (const { name } of edited) {
        log.warn(`Kept MCP server ${name} in ${describeMcpLocation(target)}: you changed it since teamai wrote it, and that worktree is gone. `
          + `Remove ${name} from ${describeMcpLocation(target)} when you no longer need it.`);
      }
      const owned = records.filter((record) => !edited.includes(record));
      const judge = judgeUnrecordedMcpEntry(localConfig, target, ctx.desired, ctx.vars, new Set(), ctx.history);
      const removed: McpChange[] = [];
      const result = await applyMcpFile(target, new Map(), new Map(), owned, new Set(owned.map((r) => r.name)), [], removed, judge, ctx.options, ctx.restoreConfigs);
      // Not read: its records stay, for the next pull.
      if (result === null) {
        kept.push(...records);
        continue;
      }
      wrote ||= result;
      ctx.changes.push(...removed);
      if (removed.length > 0 && !ctx.options.removeAll) {
        log.info(`${ctx.options.dryRun ? 'Would take' : 'Took'} teamai's MCP servers for ${local.tool} (${removed.map((c) => c.server).join(', ')}) `
          + `out of ${describeMcpLocation(target)}: that worktree is gone.`);
      }
    }
    if (kept.length < shared[key].length) manifest[key] = kept;
  }
  return wrote;
}

/**
 * Take teamai's servers out of `tool`'s local scope under every other key
 * its records name (#915), on `removeAll` and while sharing.gitExclude is off:
 * another checkout's key, and a key no checkout has any more, as a removed
 * linked worktree of a `--separate-git-dir` repository leaves for Claude,
 * whose servers no pull would ever take out. Only recorded entries go; one
 * the member changed since teamai wrote it stays, named, unless `removeAll`.
 * Their records go through `ctx.manifest` (`saveMcpManifest`). Whether it
 * wrote a file.
 */
async function leaveOtherLocalScopes(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  tool: string,
  ctx: {
    manifest: ManagedMcpManifest;
    changes: McpChange[];
    options: McpReconcileOptions;
    restoreConfigs: Map<string, () => Promise<void>>;
  },
): Promise<boolean> {
  const local = (await projectMcpLocations(teamConfig, localConfig, tool))?.local;
  if (!local) return false;
  const prefix = `${local.tool}${LOCAL_KEY_INFIX}`;
  const ours = await localMcpKeyOf(localConfig);
  let wrote = false;
  for (const [key, records] of Object.entries(await readManifest(localMcpManifestPath(localConfig)))) {
    if (!key.startsWith(prefix) || ours(key) || key in ctx.manifest || !Array.isArray(records) || records.length === 0) continue;
    const kept: ManagedMcpRecord[] = [];
    for (const [file, owned] of recordsByFile(records, local.file)) {
      const target: McpTarget = { ...local, file, projectKey: key.slice(prefix.length) };
      const result = await leaveLocalScope(target, owned, ctx.options, ctx.restoreConfigs);
      // Not read: its records stay.
      if (result === null) {
        kept.push(...owned);
        continue;
      }
      const { removed } = result;
      wrote ||= result.wrote;
      ctx.changes.push(...removed);
      if (removed.length === 0 || ctx.options.removeAll) continue;
      log.info(`${ctx.options.dryRun ? 'Would take' : 'Took'} teamai's MCP servers for ${local.tool} (${removed.map((c) => c.server).join(', ')}) `
        + `out of ${describeMcpLocation(target)}: ${movedBecause(teamConfig, localConfig, { projectKey: undefined })}`
        + `${toolLabel(local.tool)} reads them from each checkout's MCP file.`);
    }
    if (kept.length < records.length) ctx.manifest[key] = kept;
  }
  return wrote;
}

/** `records` by the file each notes, `file` for one an earlier release wrote without one. */
function recordsByFile(records: readonly ManagedMcpRecord[], file: string): Map<string, ManagedMcpRecord[]> {
  const byFile = new Map<string, ManagedMcpRecord[]>();
  for (const record of records) {
    const recordedFile = record.file ?? file;
    byFile.set(recordedFile, [...byFile.get(recordedFile) ?? [], record]);
  }
  return byFile;
}

/**
 * Take the servers `records` claim out of the local scope `target` (#915).
 * Only an entry that still equals what teamai wrote goes; one the member
 * changed since stays, named, and so does the member's own
 * server. What it removed, and whether it wrote the file; null when the file
 * does not parse, and so was not read.
 */
async function leaveLocalScope(
  target: McpTarget,
  records: readonly ManagedMcpRecord[],
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<{ removed: McpChange[]; wrote: boolean } | null> {
  const installed = await installedMcpEntries(target);
  const present = records.filter((record) => installed?.has(record.name));
  const edited = options.removeAll ? [] : present.filter((record) => entryHash(installed?.get(record.name)) !== record.hash);
  for (const { name } of edited) {
    log.warn(`Kept MCP server ${name} in ${describeMcpLocation(target)}: you changed it since teamai wrote it. `
      + `Remove it there when you no longer need it.`);
  }
  const owned = present.filter((record) => !edited.includes(record));
  const removed: McpChange[] = [];
  const wrote = await applyMcpFile(target, new Map(), new Map(), owned, new Set(owned.map((r) => r.name)), [], removed,
    async () => 'member', options, restoreConfigs);
  return wrote === null ? null : { removed, wrote };
}

/**
 * Take teamai's servers out of every local scope the records in `dataHome`
 * name (#915), for an uninstall that finds no configuration and so deletes
 * those records with the data home, each where `locate` places it: Claude's
 * in its user config (as `toolRoots` places it), CodeBuddy's and WorkBuddy's
 * in `.codebuddy.json`. Only an entry
 * that still equals what teamai wrote goes; a copy the member changed stays,
 * named. The records of a scope it cleaned go; those of one it could not
 * read or write stay. The files it could not clean.
 */
export async function removeLocalScopeMcpServers(dataHome: string, toolRoots?: Record<string, string>): Promise<string[]> {
  const manifestPath = path.join(dataHome, 'managed-local-mcp.json');
  const manifest = await readManifest(manifestPath);
  const recorded = Object.keys(manifest).length > 0;
  const left = new Set<string>();
  let removedTotal = 0;
  for (const [key, records] of Object.entries(manifest)) {
    const at = key.indexOf(LOCAL_KEY_INFIX);
    const tool = key.slice(0, at);
    const format = mcpFormatOf(tool);
    const file = at < 0 ? null : await localMcpFileOf(tool, dataHome, toolRoots);
    if (!Array.isArray(records) || !format || !file) continue;
    const kept: ManagedMcpRecord[] = [];
    for (const [recordedFile, owned] of recordsByFile(records, file)) {
      const target: McpTarget = { tool, format, file: recordedFile, projectScope: true, projectKey: key.slice(at + LOCAL_KEY_INFIX.length) };
      try {
        const result = await leaveLocalScope(target, owned, { removeAll: false }, new Map());
        if (result === null) {
          left.add(recordedFile);
          kept.push(...owned);
          continue;
        }
        removedTotal += result.removed.length;
      } catch (error) {
        log.warn(`Could not remove teamai's MCP servers from ${describeMcpLocation(target)}: ${error instanceof Error ? error.message : String(error)}`);
        left.add(recordedFile);
        kept.push(...owned);
      }
    }
    if (kept.length > 0) manifest[key] = kept;
    else delete manifest[key];
  }
  if (removedTotal > 0) log.info(`Removed ${removedTotal} teamai-managed MCP server(s)`);
  if (recorded) await writeJsonAtomic(manifestPath, manifest);
  return [...left];
}

/**
 * Delete a project MCP file a cleanup or a pull just emptied, when it holds
 * nothing at all, no other key either, so nothing but teamai's servers made
 * it (#915). `serverKey` is null for a Codex config.toml, which then holds no
 * text. A symlink is the member's, and a file git tracks, or cannot say it
 * does not, stays.
 */
export async function deleteEmptiedMcpFile(file: string, serverKey: string | McpKey | null = MCP_SERVER_KEY.claude): Promise<boolean> {
  if (await fs.promises.lstat(file).then((stat) => stat.isSymbolicLink(), () => true)) return false;
  if (serverKey === null) {
    if ((await readFileSafe(file))?.trim() !== '') return false;
  } else {
    const doc = await readJsonDoc(file, serverKey);
    if (!doc || !holdsOnlyEmptyServers(doc.data, typeof serverKey === 'string' ? [serverKey] : serverKey)) return false;
  }
  if (await keepsTrackedCopy(file) || (await gitTracks(file)).kind === 'unknown') return false;
  await fs.promises.rm(file, { force: true });
  return true;
}

/**
 * The later file of `target`'s user lookup order to write to instead of the
 * mapped file, which every teamai before #993 created, when that file is the
 * one the tool reads and holds nothing but teamai's servers: no other key,
 * and every server recorded for it or equal to a team render (`judge`),
 * which it then adopts. Otherwise null, and the file stays chosen.
 */
async function leaveFormerMcpFile(
  target: McpTarget,
  records: readonly ManagedMcpRecord[],
  judge: McpEntryJudge,
): Promise<{ former: string; next: string; adopted: ManagedMcpRecord[] } | null> {
  const former = target.mappedFile;
  const index = former === undefined || target.projectScope ? -1 : target.lookupFiles?.indexOf(former) ?? -1;
  if (index === -1 || target.file !== former) return null;
  // A symlink there is the member's, never deleted: the tool keeps reading it, and teamai writes through it.
  if (await fs.promises.lstat(former).then((stat) => stat.isSymbolicLink(), () => false)) return null;
  let next: string | undefined;
  for (const candidate of target.lookupFiles?.slice(index + 1) ?? []) {
    // A later path that is a link to `former` is not another file: moving there would move nothing.
    if (await pathExists(candidate) && !await sameMcpFile(candidate, former)) {
      next = candidate;
      break;
    }
  }
  if (!next) return null;
  const [serverKey] = mcpKeyOf(target);
  const doc = await readJsonDoc(former, serverKey);
  if (!doc || Object.keys(doc.data).some((key) => key !== serverKey)) return null;
  const adopted: ManagedMcpRecord[] = [];
  for (const [name, entry] of Object.entries(doc.servers)) {
    if (records.some((r) => r.name === name && recordedFileOf(target, r) === former)) continue;
    if (await judge(name, entry) !== 'teamai') return null;
    adopted.push({ name, hash: entryHash(entry), file: former });
  }
  return { former, next, adopted };
}

/**
 * Delete `former`, once `removeFromOtherFiles` took teamai's servers out of it
 * and it holds nothing (#993), so the tool reads `target.file`. Reported
 * once: the file is gone after. Whether it deleted it.
 */
async function deleteLeftMcpFile(
  target: McpTarget,
  former: string,
  /** The servers taken out of it. */
  names: readonly string[],
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<boolean> {
  // Never a link, and never the file `target.file` writes to through one.
  if (await fs.promises.lstat(former).then((stat) => stat.isSymbolicLink(), () => false)
    || await sameMcpFile(former, target.file)) return false;
  const [serverKey] = mcpKeyOf(target);
  const raw = await readFileSafe(former);
  const doc = await readJsonDoc(former, serverKey);
  if (!options.dryRun && (raw === null || !doc || Object.keys(doc.servers).length > 0
    || Object.keys(doc.data).some((key) => key !== serverKey))) return false;
  log.info(`${options.dryRun ? 'Would move' : 'Moved'} teamai's MCP servers for ${target.tool} (${names.length > 0 ? names.join(', ') : 'none'}) `
    + `from ${former}, which held nothing else, to ${target.file}, and ${options.dryRun ? 'delete' : 'deleted'} ${former}: `
    + `${target.tool} reads only the first of its user MCP files that exists, so ${former} hid the servers in ${target.file}.`);
  if (options.dryRun || raw === null) return false;
  const snapshotKey = await realFilePath(former);
  await fs.promises.rm(former, { force: true });
  if (!restoreConfigs.has(snapshotKey)) restoreConfigs.set(snapshotKey, () => fs.promises.writeFile(former, raw));
  return true;
}

/**
 * Take teamai's OpenCode servers out of `other` (#915), the project MCP file
 * OpenCode does not get them from now: on V2 with teamai's plugin, the root
 * opencode.json V1 reads, as V2 reads it too and would load them twice; back
 * on V1, `.opencode/teamai-mcp.json`. Teamai's servers are those `elsewhere`
 * records there, or that `judge` proves teamai's (a lost record). Only from a
 * file git does not track, where the member's servers and keys stay: a file
 * git tracks is left, its records with it, and doctor names it. A file
 * left with nothing is deleted, never one git tracks. `uninstall` and
 * `teamai mcp remove` clear either file. Whether it wrote a file.
 */
/**
 * Delete an OpenCode project MCP file a reconcile left holding no server and
 * nothing else, unless git tracks it; `raw` is what it held before, for the
 * restore. Whether it deleted it.
 */
async function deleteEmptiedOpencodeFile(file: string, raw: string, restoreConfigs: Map<string, () => Promise<void>>): Promise<boolean> {
  const serverKey = MCP_SERVER_KEY.opencode;
  const left = await readJsonDoc(file, serverKey);
  if (!left || !await pathExists(file) || Object.keys(left.servers).length > 0 || Object.keys(left.data).some((key) => key !== serverKey)
    || (await gitTracks(file, 'entry')).kind !== 'untracked') return false;
  const snapshotKey = await realFilePath(file);
  await fs.promises.rm(file, { force: true });
  if (!restoreConfigs.has(snapshotKey)) restoreConfigs.set(snapshotKey, () => fs.promises.writeFile(file, raw));
  return true;
}

async function moveOpencodeServers(
  target: McpTarget,
  other: string,
  elsewhere: ManagedMcpRecord[],
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  judge: McpEntryJudge,
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<boolean> {
  const v2 = target.file !== target.mappedFile;
  // teamai's own file, once it holds no server.
  const own = v2 && !options.dryRun && nextRecords.length === 0 ? await readFileSafe(target.file) : null;
  const ownDeleted = own !== null && await deleteEmptiedOpencodeFile(target.file, own, restoreConfigs);
  return await moveOpencodeServersOut(target, other, elsewhere, nextRecords, changes, judge, options, restoreConfigs) || ownDeleted;
}

/** `moveOpencodeServers` for the file the servers leave. */
async function moveOpencodeServersOut(
  target: McpTarget,
  other: string,
  elsewhere: ManagedMcpRecord[],
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  judge: McpEntryJudge,
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<boolean> {
  const v2 = target.file !== target.mappedFile;
  const keep = (): false => {
    nextRecords.push(...elsewhere);
    return false;
  };
  const stat = await fs.promises.lstat(other).catch(() => null);
  // Gone: nothing of teamai's is left there. A symlink is the member's.
  if (!stat || await sameMcpFile(other, target.file)) return false;
  if (!stat.isFile()) return keep();
  const untracked = async (): Promise<boolean> => (await gitTracks(other, 'entry')).kind === 'untracked';
  if (!options.removeAll && !await untracked()) return keep();
  const serverKey = MCP_SERVER_KEY.opencode;
  const doc = await readJsonDoc(other, serverKey);
  if (!doc) return keep();
  const raw = await readFileSafe(other);
  const removed: McpChange[] = [];
  const names = new Set(elsewhere.map((record) => record.name));
  const result = await applyMcpFile({ ...target, file: other }, new Map(), new Map(), elsewhere, names, [], removed, judge, options, restoreConfigs);
  if (result === null) return keep();
  if (options.removeAll) changes.push(...removed);
  const deleted = !options.dryRun && raw !== null && await deleteEmptiedOpencodeFile(other, raw, restoreConfigs);
  if (!options.removeAll && removed.length > 0) {
    const servers = removed.map((change) => change.server).join(', ');
    log.info(v2
      ? `${options.dryRun ? 'Would take' : 'Took'} teamai's MCP servers for opencode (${servers}) out of ${other}${deleted ? ' and deleted it, as it held nothing else' : ''}: `
        + `OpenCode V2 gets them from ${target.file} through teamai's plugin.`
      : `${options.dryRun ? 'Would move' : 'Moved'} teamai's MCP servers for opencode (${servers}) from ${other} back to ${target.file}${deleted ? ` and deleted ${other}` : ''}: `
        + 'teamai\'s plugin adds them only on OpenCode V2 with sharing.gitExclude on.');
  }
  return result || deleted;
}

/** A Codex config.toml: null when it does not exist, undefined when it cannot be read. */
async function readCodexConfig(file: string): Promise<string | null | undefined> {
  return await readFileIfExists(file).catch(() => undefined);
}

async function applyCodex(
  target: McpTarget,
  desired: Map<string, DesiredMcpEntry>,
  keep: Map<string, ManagedMcpRecord>,
  owned: ManagedMcpRecord[],
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  judge: McpEntryJudge,
  options: McpReconcileOptions,
  restoreConfigs: Map<string, () => Promise<void>>,
): Promise<boolean | null> {
  const previous = await readCodexConfig(target.file);
  if (previous === undefined) {
    log.warn(`Could not read ${target.file} — skipping MCP injection for ${target.tool}`);
    return null;
  }
  let source = previous ?? '';
  const present = new Set(codexServerNames(source));
  let dirty = false;
  let holdsResolvedValue = false;

  for (const [name, { hash, block, resolvedValue }] of desired) {
    // An entry with no record is teamai's when it equals a team render of `name` (#993), and is adopted.
    const unrecorded = present.has(name) && !ownedNames.has(name) && !options.force;
    const owner = unrecorded ? await judge(name, codexBlockIn(source, name)) : 'teamai';
    if (owner !== 'teamai') {
      changes.push(unrecordedServerKept(target, name, owner));
      continue;
    }
    nextRecords.push({ name, hash });
    holdsResolvedValue ||= resolvedValue;
    const next = spliceCodexBlock(source, name, block!);
    if (next === source) {
      if (unrecorded && options.dryRun) log.info(describeAdoptionPreview(target, name));
      continue;
    }
    source = next;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: present.has(name) ? 'updated' : 'added' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    const previous = owned.find((record) => record.name === name);
    if (options.removeAll && previous && present.has(name) && entryHash(codexBlockIn(source, name)) !== previous.hash) {
      log.warn(`Kept MCP server ${name} in ${describeMcpLocation(target)}: you changed it since teamai wrote it. `
        + 'Remove it there when you no longer need it.');
      continue;
    }
    const kept = keep.get(name);
    if (kept && present.has(name)) {
      nextRecords.push(kept);
      holdsResolvedValue = true;
      continue;
    }
    const next = spliceCodexBlock(source, name, null);
    if (next !== source) {
      source = next;
      dirty = true;
    }
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  // An unrecorded block of a server the team deleted is teamai's when it equals a render of that
  // server from the team history (#993), and goes like any other server teamai no longer delivers.
  for (const name of codexServerNames(source)) {
    if (desired.has(name) || ownedNames.has(name) || await judge(name, codexBlockIn(source, name)) !== 'teamai') continue;
    const next = spliceCodexBlock(source, name, null);
    if (next === source) continue;
    if (options.dryRun) log.info(describeRemovedServerPreview(target, name));
    source = next;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  if (options.dryRun) return false;
  if (!dirty) {
    if (holdsResolvedValue) await tightenMode(target.file);
    return false;
  }

  const snapshotKey = await realFilePath(target.file);
  await writeCodexAtomic(target.file, source);
  if (!restoreConfigs.has(snapshotKey)) {
    restoreConfigs.set(snapshotKey, previous === null
      ? () => removeCreatedMcpFile(target.file)
      : () => writeCodexAtomic(target.file, previous));
  }
  return true;
}

/**
 * Make an unchanged config readable by this user only, without rewriting it:
 * an entry a CLI before #879 wrote holds its resolved value in a file that may
 * still be 0644. A symlink is followed, as the value sits in its target; a
 * target another user owns is left as it is, and named.
 */
async function tightenMode(file: string): Promise<void> {
  const { mode, uid } = await fs.promises.stat(file);
  if ((mode & 0o077) === 0) return;
  const self = process.getuid?.();
  if (self !== undefined && uid !== self) {
    log.warn(`${await realFilePath(file)} holds a value teamai resolved and other users can read it, but it is not yours, so teamai `
      + `left its mode as it is. Ask its owner to make it readable by you only, or point ${file} at a file you own.`);
    return;
  }
  await fs.promises.chmod(file, 0o600);
}

/**
 * Write a Codex config.toml atomically, readable by this user only: it may
 * hold resolved values. A symlink at `file` is the member's: the write lands
 * in the file it points to and the link stays, and the git checks judge that
 * file (`realFilePath`).
 */
export async function writeCodexAtomic(file: string, content: string): Promise<void> {
  file = await symlinkTarget(file);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
}

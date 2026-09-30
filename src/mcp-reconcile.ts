import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  LocalConfig,
  TeamaiConfig,
  McpServerDef,
  ManagedMcpManifest,
  ManagedMcpRecord,
} from './types.js';
import {
  getMcpSharing,
  getEnvBackupPath,
  isAgentExcluded,
  getDataHome,
  managedMcpManifestPath,
  managedMcpManifestKey,
  resolveToolBaseDir,
  scopedToolPaths,
  TeamaiConfigSchema,
} from './types.js';
import YAML from 'yaml';
import {
  detectMcpFormat,
  supportsTransport,
  supportsEnvExpansion,
  renderJsonEntry,
  renderCodexBlock,
  resolvePlaceholders,
  referencedVars,
  entryHash,
  MCP_SERVER_KEY,
  sameServerKey,
  type McpFormat,
} from './resources/mcp-format.js';
import { mcpEntryReader, teamMcpToDef } from './resources/mcp.js';
import { envName, envTable } from './resources/env-key.js';
import { declaredSecretKeys, type SecretDeclarations } from './resources/secrets.js';
import { resolveTeamEnv, variablesKeptWarning, type TeamEnv } from './env-resolution.js';
import { isEnvShMarker } from './env-sh-exports.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { reportEntryResolution, resolveEntriesFor } from './namespaced-entries.js';
import {
  readJson,
  writeJsonAtomic,
  readFileSafe,
  pathExists,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';
import { loadProjectMcpManifest } from './utils/mcp-manifest.js';
import { isOnPath, SAFE_BIN_RE, type LookPathOptions } from './utils/lookpath.js';
import {
  carriesResolvedValue,
  ensureExcludedFromGit,
  excludeFromGit,
  findMcpGitExcludes,
  gitTracks,
  mcpExcludePatternPath,
  realFilePath,
  removeMcpGitExclude,
  resolvedVariableIn,
  type GitExclusion,
} from './mcp-git-exclude.js';
import { createGit, getFileContentAtRev, listWorktrees } from './utils/git.js';
import {
  readResolvedMcpFiles,
  recordUnverifiedMcpServers,
  settleResolvedMcpFiles,
  trackResolvedMcpFiles,
  untrackResolvedMcpFiles,
  type McpFileObservation,
} from './mcp-resolved-files.js';

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
 * The installed KEY=value backup is read instead only when that set cannot be
 * resolved, or the secret declarations or the member's values cannot (pull
 * then keeps env.sh as it is, so MCP sees what the shell sees), or the team has no repo tree to
 * resolve it from (HTTP mode, which declares no secrets).
 *
 * `teamEnv` is for a caller that already resolved it, so one command reads
 * each file once. HTTP mode ignores it.
 */
export async function buildVarTable(localConfig: LocalConfig, teamEnv?: TeamEnv): Promise<Record<string, string>> {
  const table = envTable<string>();
  const resolved = localConfig.repo.kind === 'http' ? null : teamEnv ?? await resolveTeamEnv(localConfig);
  const secretKeys = resolved ? declaredSecretKeys(resolved.declarations) : new Set<string>();
  const isSecret = (key: string): boolean => secretKeys?.has(key) ?? false;
  const variables = resolved?.variables.kind === 'resolved' && secretKeys ? resolved.variableValues : null;
  if (variables?.kind === 'resolved') {
    for (const [key, variable] of variables.values) table[key] = variable.value;
  } else {
    if (variables) warnOnce(variablesKeptWarning(variables.reason));
    for (const [key, value] of Object.entries(await readEnvBackup(localConfig))) if (!isSecret(key)) table[key] = value;
  }
  // The environment fills only what the team sets nothing for (#875): a
  // member overrides a team variable with `teamai env set`, for that team.
  // An env.sh marker says what a shell sourced, and is no server's value.
  // On Windows `api_url` is the team's `API_URL`: names compare as the platform does.
  const teamSet = new Set(Object.keys(table).map(envName));
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isSecret(k) && !isEnvShMarker(k) && !teamSet.has(envName(k))) table[k] = v;
  }
  if (!resolved || !secretKeys || secretKeys.size === 0) return table;
  if (resolved.secrets.kind === 'store-unreadable') {
    warnOnce(`${resolved.secrets.reason} Team secrets have no value until it is fixed.`);
    return table;
  }
  for (const [key, secret] of resolved.secrets.values) table[key] = secret.value;
  return table;
}

/** The KEY=value file the env channel last wrote. */
async function readEnvBackup(localConfig: LocalConfig): Promise<Record<string, string>> {
  const table = envTable<string>();
  // Must use the same path the env channel wrote (getEnvBackupPath) — self mode
  // uses env.local, not env (which is a committed directory there).
  const envFile = getEnvBackupPath(localConfig);
  const content = await readFileSafe(envFile);
  if (content) {
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      table[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }
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
}

/**
 * Resolve which tools to write, and where.
 *
 * Installation is detected from the tool's skills/settings path, NOT its MCP
 * path: Claude's project-scope MCP file is <root>/.mcp.json, whose first path
 * segment is the file itself, so the usual directory probe would report "not
 * installed" for a perfectly good Claude install.
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
  const targets: McpTarget[] = [];

  // Skills/settings/agents probe paths must reflect the active scope: OpenCode's
  // user-scope resources live under ~/.config/opencode, not ~/.opencode.
  const toolPaths = scopedToolPaths(teamConfig, localConfig);
  const entries: Array<[string, (typeof toolPaths)[string], boolean?]> = Object.entries(toolPaths);
  if (options.includeUndetected && projectScope) {
    for (const [tool, paths] of Object.entries(TeamaiConfigSchema.shape.toolPaths.parse(undefined))) {
      if (paths.mcpProject && toolPaths[tool]?.mcpProject !== paths.mcpProject) entries.push([tool, paths, true]);
    }
  }
  for (const [tool, paths, builtinFallback] of entries) {
    const format = detectMcpFormat(tool);
    if (!format) continue;

    // No fallback between scopes: a tool's project-scope location is a
    // different thing from its user-scope one, not a default for it. Absent
    // `mcpProject` means the tool has no project-scope MCP support (codex), or
    // is already covered by a sibling target writing the shared file (tclaude
    // reads the <root>/.mcp.json that `claude` writes).
    const rel = projectScope ? paths.mcpProject : paths.mcp;
    if (!rel) continue;

    const baseDir = resolveToolBaseDir(tool, localConfig);
    const file = path.join(baseDir, rel);

    const probe = paths.skills ?? paths.settings ?? paths.agents;
    if (!probe) continue;
    const installed = await isToolInstalledForConfig(tool, probe, localConfig, file);
    if (!options.includeUndetected && !installed) {
      log.debug(`Skipping MCP sync for ${tool}: tool not installed`);
      continue;
    }

    targets.push({
      tool, format, file, projectScope,
      ...builtinFallback ? { builtinFallback: true as const } : {},
      ...installed ? {} : { undetected: true as const },
    });
  }
  return targets;
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
}

/**
 * Read a JSON MCP config. Returns null when the file exists but cannot be
 * parsed — we abandon the injection rather than risk clobbering a file we do
 * not understand (it may hold the user's OAuth session). Copilot project files
 * additionally allow a bare top-level server map, whose shape we preserve.
 */
export async function readJsonDoc(
  file: string,
  serverKey: string,
  allowBare = false,
): Promise<JsonDoc | null> {
  if (!await pathExists(file)) return { data: {}, servers: {}, bare: false };
  const raw = await readFileSafe(file);
  if (raw === null) return null;
  if (raw.trim() === '') return { data: {}, servers: {}, bare: allowBare };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const bare = allowBare && !(serverKey in data);
    const servers = bare ? data : (data[serverKey] as Record<string, unknown>) ?? {};
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    return { data, servers: { ...servers }, bare };
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
  serverKey: string,
  doc: JsonDoc,
  options?: { mode?: number },
): Promise<void> {
  if (doc.bare) {
    await writeJsonAtomic(file, doc.servers, options);
    return;
  }
  doc.data[serverKey] = doc.servers;
  await writeJsonAtomic(file, doc.data, options);
}

// ─── Codex TOML target I/O ───────────────────────────────────

/**
 * Replace or delete a `[mcp_servers.<name>]` block by text surgery, leaving the
 * rest of config.toml byte-identical (comments included).
 */
export function spliceCodexBlock(source: string, name: string, block: string | null): string {
  const re = codexBlockRe(name);
  const match = source.match(re);

  if (match) {
    if (block === null) {
      const cleaned = source.replace(re, '');
      return cleaned.replace(/\n{3,}/g, '\n\n');
    }
    return source.replace(re, block.endsWith('\n') ? block + '\n' : block + '\n\n');
  }

  if (block === null) return source;
  const sep = source.length === 0 || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return source + sep + block;
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
  // HTTP mode has no repo tree to declare secrets in.
  const teamEnv = localConfig.repo.kind === 'http' ? undefined : options.teamEnv ?? await resolveTeamEnv(localConfig);
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
    if (raw.tools && !raw.tools.includes(target.tool)) continue;
    if (ctx.excluded.has(raw.name)) {
      skipped.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: 'excluded by user' });
      continue;
    }
    if (!supportsTransport(target.format, raw.transport)) {
      skipped.push({
        tool: target.tool,
        server: raw.name,
        action: 'skipped',
        reason: `${target.tool} does not support ${raw.transport} transport`,
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

    // Pass ${VAR} through where the tool expands it itself, so the secret
    // never lands on disk; otherwise resolve and require every var to exist.
    // A resolved value is written verbatim into the target file; a project
    // file gets one only once it is kept out of git (#882, reconcileTargets).
    const passthrough = supportsEnvExpansion(target.format, target.projectScope, raw);
    let def = raw;
    if (!passthrough) {
      const { def: resolved, missing } = resolvePlaceholders(raw, ctx.vars);
      if (missing.length > 0) {
        skipped.push({
          tool: target.tool,
          server: raw.name,
          action: 'skipped',
          reason: `unresolved variable(s): ${missing.join(', ')}`,
        });
        if (missing.every((key) => declared?.has(key) ?? true)) kept.add(raw.name);
        continue;
      }
      def = resolved;
    } else if (referencedVars(raw).length > 0) {
      log.debug(`${raw.name}: passing ${referencedVars(raw).join(', ')} through to ${target.tool}`);
    }

    const resolvedValue = !passthrough && referencedVars(raw).length > 0;
    if (target.format === 'codex') {
      const block = renderCodexBlock(def);
      desired.set(raw.name, { entry: block, hash: entryHash(block), block, resolvedValue });
    } else {
      const entry = renderJsonEntry(target.format, def);
      desired.set(raw.name, { entry, hash: entryHash(entry), resolvedValue });
    }
  }

  return { desired, skipped, kept };
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
 *
 * Read-only. An MCP server is an entry inside a tool's config rather than a
 * file of its own, so this, not a destination path, is what "delivered" means.
 */
export async function installedMcpEntries(target: McpTarget): Promise<Map<string, unknown> | null> {
  if (target.format === 'codex') {
    const raw = await readFileSafe(target.file);
    if (raw === null) return new Map();
    return new Map(codexServerNames(raw).map((name) => [name, codexBlockIn(raw, name)]));
  }
  const serverKey = MCP_SERVER_KEY[target.format as Exclude<McpFormat, 'codex'>];
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, serverKey, allowBare);
  return doc === null ? null : new Map(Object.entries(doc.servers));
}

/**
 * The manifest of the servers teamai wrote for this scope. Project scope uses a
 * PER-WORKTREE manifest under the partition (migrating this worktree's records
 * out of any legacy shared file on first read, unless `dryRun`); user scope
 * keeps the single global file. Either way a reconcile owns exactly one file.
 */
async function loadMcpManifest(
  localConfig: LocalConfig,
  dryRun: boolean | undefined,
): Promise<{ manifestPath: string; manifest: ManagedMcpManifest }> {
  const dataHome = getDataHome(localConfig);
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    return loadProjectMcpManifest(dataHome, localConfig.projectRoot, { dryRun });
  }
  const manifestPath = managedMcpManifestPath(dataHome);
  return { manifestPath, manifest: await readManifest(manifestPath) };
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
    const owned = new Set((manifest[managedMcpManifestKey(target.tool, target.projectScope)] ?? []).map((r) => r.name));
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

/** `load`, run once, on the first call. */
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
      const format = detectMcpFormat(tool);
      return format ? [{ tool, format, file, projectScope: true }] : [];
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
): Promise<Array<McpTarget & { tracked: boolean; mappedBy: string[] }> | null> {
  const { projectRoot } = cfg;
  if (!projectRoot) return [];
  const repoPath = cfg.repo.localPath;
  let revisions: string[];
  try {
    revisions = (await createGit(repoPath).raw(['log', '--format=%H', 'HEAD', '--', 'teamai.yaml'])).split('\n').filter(Boolean);
  } catch (e) {
    log.debug(`Could not read the history of teamai.yaml in ${repoPath}: ${e instanceof Error ? e.message : String(e)}. The next pull tries again.`);
    return null;
  }
  const root = await realFilePath(projectRoot);
  // Each path, by real path, with the tools today's targets or the record reach it for.
  const mapped = await Promise.all(known.map(async ({ tool, file }) => ({ tool, real: await realFilePath(file) })));
  const recorded = await Promise.all(Object.entries((await readResolvedMcpFiles(cfg)).files)
    .flatMap(([file, { tools }]) => tools.map(async (tool) => ({ tool, real: await realFilePath(file) }))));
  const reached = (tool: string, real: string): boolean => [...mapped, ...recorded].some((r) => r.tool === tool && r.real === real);
  const found = new Map<string, McpTarget & { tracked: boolean; mappedBy: string[] }>();
  for (const revision of [null, ...revisions]) {
    let toolPaths: unknown = EARLIER_BUILTIN_MCP_PROJECT;
    if (revision !== null) {
      try {
        toolPaths = (YAML.parse((await getFileContentAtRev(repoPath, revision, './teamai.yaml'))?.toString() ?? '') as { toolPaths?: unknown } | null)?.toolPaths;
      } catch {
        continue;
      }
    }
    if (typeof toolPaths !== 'object' || toolPaths === null) continue;
    for (const [tool, paths] of Object.entries(toolPaths)) {
      const rel: unknown = typeof paths === 'object' && paths !== null ? (paths as { mcpProject?: unknown }).mcpProject : undefined;
      const format = detectMcpFormat(tool);
      if (typeof rel !== 'string' || !format) continue;
      const file = path.resolve(resolveToolBaseDir(tool, cfg), rel);
      const key = `${tool}\0${file}`;
      if (found.has(key)) continue;
      const real = await realFilePath(file);
      const inside = path.relative(root, real);
      if (inside === '' || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) continue;
      if (reached(tool, real) || !await pathExists(file)) continue;
      const mappedBy = [...new Set(mapped.filter((r) => r.real === real).map((r) => r.tool))];
      found.set(key, { tool, format, file, projectScope: true, tracked: (await gitTracks(file)).kind === 'tracked', mappedBy });
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
export async function recordedMcpFileEvidence(targets: McpTarget[], owned?: readonly string[]): Promise<string | null> {
  const state = await mcpFileState(targets);
  if (state.kind === 'unparsable') return 'it does not parse';
  if (state.kind !== 'parsed') return null;
  if (!owned) {
    return state.servers.length > 0
      ? 'teamai may have written a resolved value to it under an earlier toolPaths mapping, and it still holds MCP servers'
      : null;
  }
  const other = state.servers.find((name) => !owned.includes(name));
  return other === undefined ? null
    : `teamai may have written a resolved value to it for ${targets.map((t) => t.tool).join(', ')} under an earlier toolPaths mapping, `
      + `and it holds ${other}, which no tool that maps it now owns`;
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
  owned?: readonly string[],
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
    const stillTracked = tracked && (await gitTracks(file)).kind === 'tracked';
    const owned = mappedBy.length === 0 ? undefined
      : mappedBy.flatMap((tool) => manifest[managedMcpManifestKey(tool, true)] ?? []).map((record) => record.name);
    const holding = !stillTracked && await recordedMcpFileEvidence(group, owned) !== null;
    for (const { tool } of group) {
      observations.push({
        file, tool, state, holding, owned: owned ?? [],
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
 * `localConfig` and, in project scope, one config per other linked worktree:
 * each worktree has its own MCP configs and managed-mcp manifest.
 */
export async function projectWorktreeConfigs(localConfig: LocalConfig): Promise<LocalConfig[]> {
  const configs: LocalConfig[] = [localConfig];
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const { resolveProjectDataHome } = await import('./config.js');
    for (const wt of await listWorktrees(localConfig.projectRoot)) {
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
      const movedWhy = moved && await recordedMcpFileEvidence(moved, targets.get(file)?.owned.map((record) => record.name) ?? []);
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

export function mcpTargetExcluded(localConfig: LocalConfig, target: McpTarget): boolean {
  if (!isAgentExcluded(localConfig, target.tool)) return false;
  // tclaude has no project-scope MCP file: it reads the <root>/.mcp.json the
  // claude target writes, so that target stays live while tclaude is enabled.
  return !(target.projectScope && target.tool === 'claude' && !isAgentExcluded(localConfig, 'tclaude'));
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
  const protect = !options.removeAll && !options.dryRun;
  // Read before the reconcile records what it writes: a manifest it recreates says nothing of what came before.
  const before = protect && localConfig.projectRoot ? await readProjectMcpManifest(localConfig, localConfig.projectRoot) : undefined;
  try {
    return await reconcileTargets(teamConfig, localConfig, options, exclusions, written, recorded);
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
 * delivery off, still holds what a pull wrote.
 */
async function protectResolvedMcpConfigs(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  exclusions: Map<string, GitExclusion>,
  written: Set<string>,
  before: ManagedMcpManifest | undefined,
): Promise<void> {
  const { projectRoot } = localConfig;
  if (localConfig.scope !== 'project' || !projectRoot || localConfig.repo.kind === 'http') return;
  try {
    await protectProjectMcpConfigs(teamConfig, localConfig, projectRoot, exclusions, written, before);
  } catch (e) {
    log.warn(
      `Could not check this project's MCP configs for resolved values to keep out of git: ${e instanceof Error ? e.message : String(e)}. `
      + 'Run `teamai doctor` to see whether git would commit one.',
    );
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
    const owned = mappedBy.length === 0 ? undefined
      : mappedBy.flatMap((tool) => manifest[managedMcpManifestKey(tool, true)] ?? []).map((record) => record.name);
    const holding = await earlierMappedMcpFileEvidence(target, teamDefs, vars, ctx, owned) !== null;
    if (holding) found.push(target.file);
    observations.push({ file: target.file, tool: target.tool, state, holding, owned: owned ?? [], ...owned ? { remapped: true as const } : {} });
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
  const dirs = [projectRoot];
  for (const target of await resolveMcpTargets(teamConfig, localConfig, { includeUndetected: true })) dirs.push(path.dirname(target.file));
  for (const file of Object.keys((await readResolvedMcpFiles(localConfig)).files)) dirs.push(path.dirname(file));
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
): Promise<McpReconcileResult> {
  const changes: McpChange[] = [];
  let wrote = false;

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
  if (!removeAll) {
    // A file that does not parse, or a server name defined twice, keeps every
    // installed server as it is: reconciling to an empty set would remove them.
    const resolution = await resolveEntriesFor(mcpEntryReader, localConfig);
    reportEntryResolution(resolution);
    if (resolution.kind === 'failed') return { changes, wrote, unresolved: true };
    teamDefs = resolution.entries.map((entry) => teamMcpToDef(entry.entry));
  }
  if (!removeAll && teamDefs.length > 0 && !sharing.autoApply) {
    log.info(`${teamDefs.length} team MCP server(s) available. Run \`teamai mcp inject\` to apply.`);
    return { changes, wrote };
  }
  const targets = await resolveMcpTargets(teamConfig, localConfig);
  if (targets.length === 0) return { changes, wrote };

  const { manifestPath, manifest } = await loadMcpManifest(localConfig, options.dryRun);

  // An empty desired set still has to run: it is how servers dropped from
  // mcp.yaml get cleaned out of the tools we previously injected them into.
  const nothingOwned = Object.values(manifest).every((r) => r.length === 0);
  if (teamDefs.length === 0 && nothingOwned) return { changes, wrote };
  // The files an earlier pull recorded, and each record this run rebuilds after it was lost (#882).
  const ledger = localConfig.scope === 'project' && !options.dryRun ? (await readResolvedMcpFiles(localConfig)).files : {};
  const listed = new Set(Object.keys(ledger));
  const rebuilt: Array<{ target: McpTarget; records: ManagedMcpRecord[] }> = [];
  // The tools with no record in managed-mcp.json when this pull began (#882): theirs are marked below.
  const unrecorded = new Set(localConfig.scope === 'project' && !options.dryRun
    ? targets.filter((t) => manifest[managedMcpManifestKey(t.tool, true)] === undefined).map((t) => t.tool) : []);

  const desiredContext = await buildDesiredMcpContext(teamConfig, localConfig, options);
  // A failed declaration is not "no secrets": read as none, every server whose
  // secret the member left in their shell would be removed. Keep what is
  // installed rather than guess which variables are secrets. `removeAll`
  // (mcp remove, uninstall) still removes everything.
  if (!removeAll && desiredContext.secrets.kind === 'failed') {
    reportEntryResolution(desiredContext.secrets);
    return { changes, wrote, unresolved: true };
  }

  for (const target of targets) {
    // Same enabledAgents / disabledAgents gate as the other resource syncs. The
    // manifest entry is left as is: an excluded tool is skipped, not cleaned,
    // and `removeAll` (uninstall) still reaches every tool.
    if (!removeAll && mcpTargetExcluded(localConfig, target)) continue;
    const manifestKey = managedMcpManifestKey(target.tool, target.projectScope);
    const owned = manifest[manifestKey] ?? [];
    const ownedNames = new Set(owned.map((r) => r.name));
    const nextRecords: ManagedMcpRecord[] = [];

    // Which of this team's servers apply to this tool, and in what rendered form.
    const { desired, skipped, kept } = desiredMcpForTarget(target, teamDefs, desiredContext);
    changes.push(...skipped);
    // Their old records, so a manifest this run writes still claims them.
    const keep = new Map(owned.filter((r) => kept.has(r.name)).map((r) => [r.name, r]));

    // A resolved value lands only in a file git leaves out of a commit (#882).
    // Otherwise the file stays as it was, its manifest entry with it.
    if (carriesResolvedValue(target, teamDefs, desired.keys())) {
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

    const wroteTarget = target.format === 'codex'
      ? await applyCodex(target, desired, keep, ownedNames, nextRecords, changes, options)
      : await applyJson(target, desired, keep, owned, ownedNames, nextRecords, changes, options);
    if (wroteTarget) written.add(target.file);
    wrote = wroteTarget || wrote;
    // Not read: its record stays as it was, or absent. An empty one would say teamai owns nothing there (#882).
    if (wroteTarget === null) continue;

    // The unnoted mark stays until a note of what else is in the file lands.
    const marked = manifest[manifestKey]?.some((record) => record.unnoted) ?? false;
    // Whether each entry holds a resolved value: once its definition stops
    // needing one, what this pull wrote still does (#882).
    if (target.projectScope) {
      for (const record of nextRecords) {
        record.resolved ??= carriesResolvedValue(target, teamDefs, [record.name]);
        if (marked) record.unnoted = true;
        else delete record.unnoted;
      }
      const at = recorded.indexOf(target);
      if (at >= 0 && nextRecords.some((record) => record.resolved === true)) recorded.splice(at, 1);
    }
    // Rebuilt this run, or by one that could not note what else was in the file.
    const unnoted = manifest[manifestKey] === undefined || manifest[manifestKey].some((record) => record.unnoted);
    if (listed.has(target.file) && unnoted && nextRecords.length > 0) rebuilt.push({ target, records: nextRecords });
    // An emptied project record stays: it says teamai owns nothing left in that
    // file, which a lost record cannot, and so lets its exclude line go (#882).
    // Not while the file's other servers are unnoted: it would say the same.
    if (nextRecords.length > 0 || (target.projectScope && manifest[manifestKey] !== undefined && !marked)) manifest[manifestKey] = nextRecords;
    else delete manifest[manifestKey];
  }

  // A record of a tool that had none when this pull began, of a file holding a server no record claims, is
  // unnoted until protectProjectMcpConfigs notes that server, after its settle records the file.
  for (const target of targets.filter((t) => unrecorded.has(t.tool))) {
    const records = manifest[managedMcpManifestKey(target.tool, true)] ?? [];
    const claimed = targets.filter((t) => t.file === target.file)
      .flatMap((t) => manifest[managedMcpManifestKey(t.tool, true)] ?? []).map((record) => record.name);
    if (records.length > 0 && (await unclaimedMcpServers(target, claimed)).length > 0) {
      for (const record of records) record.unnoted = true;
    }
  }
  if (!options.dryRun && (wrote || rebuilt.length > 0)) {
    // Before the manifest: once it is written, only a record marked unnoted says it was rebuilt.
    const failed = await noteUnverifiedMcpServers(localConfig, rebuilt);
    for (const { records } of rebuilt) {
      for (const record of records) {
        if (failed.includes(records)) record.unnoted = true;
        else delete record.unnoted;
      }
    }
    await writeJsonAtomic(manifestPath, manifest);
  }
  return { changes, wrote };
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

// ─── Appliers ────────────────────────────────────────────────

/** Whether it wrote `target`'s file; null when the file does not parse, and so was not read. */
async function applyJson(
  target: McpTarget,
  desired: Map<string, DesiredMcpEntry>,
  keep: Map<string, ManagedMcpRecord>,
  owned: ManagedMcpRecord[],
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean | null> {
  const serverKey = MCP_SERVER_KEY[target.format as Exclude<McpFormat, 'codex'>];
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, serverKey, allowBare);
  if (!doc) {
    log.warn(`Could not parse ${target.file} — skipping MCP injection for ${target.tool}`);
    return null;
  }

  const ownedHash = new Map(owned.map((r) => [r.name, r.hash]));
  let dirty = false;
  // A kept entry holds the value an earlier pull resolved (desiredMcpForTarget).
  let holdsResolvedValue = false;

  for (const [name, { entry, hash, resolvedValue }] of desired) {
    const existing = doc.servers[name];
    if (existing !== undefined && !ownedNames.has(name) && !options.force) {
      changes.push({
        tool: target.tool,
        server: name,
        action: 'skipped',
        reason: 'a server with this name already exists and is not managed by teamai',
      });
      continue;
    }
    nextRecords.push({ name, hash });
    holdsResolvedValue ||= resolvedValue;
    if (existing !== undefined && ownedHash.get(name) === hash) continue;
    doc.servers[name] = entry;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: existing === undefined ? 'added' : 'updated' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    const kept = keep.get(name);
    if (kept && doc.servers[name] !== undefined) {
      nextRecords.push(kept);
      holdsResolvedValue = true;
      continue;
    }
    if (doc.servers[name] !== undefined) {
      delete doc.servers[name];
      dirty = true;
    }
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
  await writeJsonDoc(target.file, serverKey, doc, holdsResolvedValue ? { mode: 0o600 } : undefined);
  return true;
}

async function applyCodex(
  target: McpTarget,
  desired: Map<string, DesiredMcpEntry>,
  keep: Map<string, ManagedMcpRecord>,
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean> {
  let source = (await readFileSafe(target.file)) ?? '';
  const present = new Set(codexServerNames(source));
  let dirty = false;
  let holdsResolvedValue = false;

  for (const [name, { hash, block, resolvedValue }] of desired) {
    if (present.has(name) && !ownedNames.has(name) && !options.force) {
      changes.push({
        tool: target.tool,
        server: name,
        action: 'skipped',
        reason: 'a server with this name already exists and is not managed by teamai',
      });
      continue;
    }
    nextRecords.push({ name, hash });
    holdsResolvedValue ||= resolvedValue;
    const next = spliceCodexBlock(source, name, block!);
    if (next === source) continue;
    source = next;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: present.has(name) ? 'updated' : 'added' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
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

  if (options.dryRun) return false;
  if (!dirty) {
    if (holdsResolvedValue) await tightenMode(target.file);
    return false;
  }

  await writeCodexAtomic(target.file, source);
  return true;
}

/**
 * Make an unchanged config readable by this user only, without rewriting it:
 * an entry a CLI before #879 wrote holds its resolved value in a file that may
 * still be 0644.
 */
async function tightenMode(file: string): Promise<void> {
  const { mode } = await fs.promises.stat(file);
  if ((mode & 0o077) !== 0) await fs.promises.chmod(file, 0o600);
}

/**
 * Write a Codex config.toml atomically, readable by this user only: it may
 * hold resolved values. A symlink at `file` is replaced, as `writeJsonAtomic`
 * does for the JSON configs: git protection judges `file`, so a value must
 * never land in the file it links to (#882).
 */
export async function writeCodexAtomic(file: string, content: string): Promise<void> {
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

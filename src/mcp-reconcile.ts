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
} from './types.js';
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
  type McpFormat,
} from './resources/mcp-format.js';
import { mcpEntryReader, teamMcpToDef } from './resources/mcp.js';
import { envTable } from './resources/env-key.js';
import { declaredSecretKeys, type SecretDeclarations } from './resources/secrets.js';
import { resolveTeamEnv, variablesKeptWarning, type TeamEnv } from './env-resolution.js';
import { isToolInstalledForConfig } from './resources/base.js';
import { reportEntryResolution, resolveEntriesFor } from './namespaced-entries.js';
import {
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  readFileSafe,
  pathExists,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';
import { loadProjectMcpManifest } from './utils/mcp-manifest.js';
import { isOnPath, SAFE_BIN_RE, type LookPathOptions } from './utils/lookpath.js';

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
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isSecret(k) && !Object.hasOwn(table, k)) table[k] = v;
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

interface McpTarget {
  tool: string;
  format: McpFormat;
  /** Absolute path of the config file to edit. */
  file: string;
  projectScope: boolean;
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
): Promise<McpTarget[]> {
  const projectScope = localConfig.scope === 'project';
  const targets: McpTarget[] = [];

  // Skills/settings/agents probe paths must reflect the active scope: OpenCode's
  // user-scope resources live under ~/.config/opencode, not ~/.opencode.
  for (const [tool, paths] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
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
    if (!await isToolInstalledForConfig(tool, probe, localConfig, file)) {
      log.debug(`Skipping MCP sync for ${tool}: tool not installed`);
      continue;
    }

    targets.push({ tool, format, file, projectScope });
  }
  return targets;
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
    // A resolved value is written verbatim into the target file, including
    // project-scope files that get committed — the team has opted into that
    // by declaring the server with a ${VAR} a tool cannot expand itself.
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

    if (target.format === 'codex') {
      wrote = await applyCodex(target, desired, keep, ownedNames, nextRecords, changes, options) || wrote;
    } else {
      wrote = await applyJson(target, desired, keep, owned, ownedNames, nextRecords, changes, options) || wrote;
    }

    if (nextRecords.length > 0) manifest[manifestKey] = nextRecords;
    else delete manifest[manifestKey];
  }

  if (!options.dryRun && wrote) {
    await writeJsonAtomic(manifestPath, manifest);
  }
  return { changes, wrote };
}

// ─── Appliers ────────────────────────────────────────────────

async function applyJson(
  target: McpTarget,
  desired: Map<string, DesiredMcpEntry>,
  keep: Map<string, ManagedMcpRecord>,
  owned: ManagedMcpRecord[],
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean> {
  const serverKey = MCP_SERVER_KEY[target.format as Exclude<McpFormat, 'codex'>];
  const allowBare = target.format === 'copilot' && target.projectScope;
  const doc = await readJsonDoc(target.file, serverKey, allowBare);
  if (!doc) {
    log.warn(`Could not parse ${target.file} — skipping MCP injection for ${target.tool}`);
    return false;
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

/** Write a Codex config.toml atomically, readable by this user only: it may hold resolved values. */
export async function writeCodexAtomic(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content, { mode: 0o600 });
}

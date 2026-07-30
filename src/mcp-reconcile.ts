import path from 'node:path';
import fse from 'fs-extra';
import type {
  LocalConfig,
  TeamaiConfig,
  McpServerDef,
  ManagedMcpManifest,
  ManagedMcpRecord,
} from './types.js';
import {
  getMcpSharing,
  getTeamaiHome,
  managedMcpManifestPath,
  resolveBaseDir,
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
  type McpFormat,
} from './resources/mcp-format.js';
import { parseTeamMcpServers } from './resources/mcp.js';
import {
  readJson,
  writeJsonAtomic,
  readFileSafe,
  pathExists,
  expandHome,
} from './utils/fs.js';
import { log } from './utils/logger.js';

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
}

// ─── Manifest ────────────────────────────────────────────────

async function readManifest(manifestPath: string): Promise<ManagedMcpManifest> {
  const data = await readJson<ManagedMcpManifest>(expandHome(manifestPath));
  return data && typeof data === 'object' ? data : {};
}

// ─── Secret lookup ───────────────────────────────────────────

/**
 * Build the ${VAR} lookup table: process env first, then values the team's env
 * channel already wrote to <teamaiHome>/env (KEY=value per line).
 */
export async function buildVarTable(localConfig: LocalConfig): Promise<Record<string, string>> {
  const table: Record<string, string> = {};
  const envFile = path.join(getTeamaiHome(localConfig.scope, localConfig.projectRoot), 'env');
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
  // process.env wins: it lets a user override a team-provided value locally.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) table[k] = v;
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

/** An executable name — no path separators or shell metacharacters. */
const SAFE_BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when every executable in `requires` is on PATH. */
async function requirementsMet(def: McpServerDef): Promise<string | null> {
  if (!def.requires?.length) return null;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const bin of def.requires) {
    // `requires` comes from the team repo's mcp.yaml. `command -v` runs under a
    // shell (builtin), so an unvalidated name like `npx; rm -rf ~` would be
    // executed. A bare executable name has no shell metacharacters, so reject
    // anything else rather than pass it to the shell.
    if (!SAFE_BIN_RE.test(bin)) {
      return `required executable "${bin}" has an invalid name`;
    }
    try {
      await run('command', ['-v', bin], { shell: '/bin/sh' });
    } catch {
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
  const baseDir = resolveBaseDir(localConfig);
  const projectScope = localConfig.scope === 'project';
  const targets: McpTarget[] = [];

  for (const [tool, paths] of Object.entries(teamConfig.toolPaths)) {
    const format = detectMcpFormat(tool);
    if (!format) continue;

    // No fallback between scopes: a tool's project-scope location is a
    // different thing from its user-scope one, not a default for it. Absent
    // `mcpProject` means the tool has no project-scope MCP support (codex), or
    // is already covered by a sibling target writing the shared file (tclaude
    // reads the <root>/.mcp.json that `claude` writes).
    const rel = projectScope ? paths.mcpProject : paths.mcp;
    if (!rel) continue;

    const probe = paths.skills ?? paths.settings ?? paths.agents;
    if (!probe) continue;
    const toolRoot = path.join(baseDir, probe.split('/')[0]);
    if (!await pathExists(toolRoot)) {
      log.debug(`Skipping MCP sync for ${tool}: tool not installed`);
      continue;
    }

    targets.push({ tool, format, file: path.join(baseDir, rel), projectScope });
  }
  return targets;
}

// ─── JSON target I/O ─────────────────────────────────────────

interface JsonDoc {
  data: Record<string, unknown>;
  servers: Record<string, unknown>;
}

/**
 * Read a JSON MCP config. Returns null when the file exists but cannot be
 * parsed — we abandon the injection rather than risk clobbering a file we do
 * not understand (it may hold the user's OAuth session).
 */
async function readJsonDoc(file: string): Promise<JsonDoc | null> {
  if (!await pathExists(file)) return { data: {}, servers: {} };
  const raw = await readFileSafe(file);
  if (raw === null) return null;
  if (raw.trim() === '') return { data: {}, servers: {} };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const servers = (data.mcpServers as Record<string, unknown>) ?? {};
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return null;
    return { data, servers: { ...servers } };
  } catch {
    return null;
  }
}

// ─── Codex TOML target I/O ───────────────────────────────────

/**
 * Replace or delete a `[mcp_servers.<name>]` block by text surgery, leaving the
 * rest of config.toml byte-identical (comments included).
 */
export function spliceCodexBlock(source: string, name: string, block: string | null): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The block runs from its header to the next table header that is not one of
  // its own sub-tables (e.g. [mcp_servers.<name>.env]), or to end-of-input.
  // End-of-input must be spelled `(?![\s\S])`: JS has no \z, and under the `m`
  // flag `$` only means end-of-line, which would truncate the match early.
  const re = new RegExp(
    String.raw`^\[mcp_servers\.${escaped}\]\s*$[\s\S]*?(?=^\[(?!mcp_servers\.${escaped}[.\]])|(?![\s\S]))`,
    'm',
  );
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

/** Extract the names of all `[mcp_servers.X]` tables present in a config.toml. */
export function codexServerNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)) names.add(m[1]);
  return [...names];
}

// ─── Main entry ──────────────────────────────────────────────

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

  const teamDefs = removeAll ? [] : await parseTeamMcpServers(localConfig.repo.localPath);
  if (!removeAll && teamDefs.length > 0 && !sharing.autoApply) {
    log.info(`${teamDefs.length} team MCP server(s) available. Run \`teamai mcp inject\` to apply.`);
    return { changes, wrote };
  }

  const excluded = new Set(localConfig.excludedSkills ?? []);
  const targets = await resolveMcpTargets(teamConfig, localConfig);
  if (targets.length === 0) return { changes, wrote };

  const manifestPath = managedMcpManifestPath(localConfig.scope, localConfig.projectRoot);
  const manifest = await readManifest(manifestPath);

  // An empty desired set still has to run: it is how servers dropped from
  // mcp.yaml get cleaned out of the tools we previously injected them into.
  const nothingOwned = Object.values(manifest).every((r) => r.length === 0);
  if (teamDefs.length === 0 && nothingOwned) return { changes, wrote };

  const vars = await buildVarTable(localConfig);

  for (const target of targets) {
    const manifestKey = `${target.tool}${target.projectScope ? ':project' : ''}`;
    const owned = manifest[manifestKey] ?? [];
    const ownedNames = new Set(owned.map((r) => r.name));
    const nextRecords: ManagedMcpRecord[] = [];

    // Which of this team's servers apply to this tool, and in what rendered form.
    const desired = new Map<string, { entry: unknown; hash: string; block?: string }>();

    for (const raw of teamDefs) {
      if (raw.tools && !raw.tools.includes(target.tool)) continue;
      if (excluded.has(raw.name)) {
        changes.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: 'excluded by user' });
        continue;
      }
      if (!supportsTransport(target.format, raw.transport)) {
        changes.push({
          tool: target.tool,
          server: raw.name,
          action: 'skipped',
          reason: `${target.tool} does not support ${raw.transport} transport`,
        });
        continue;
      }
      const violation = policyViolation(raw, sharing);
      if (violation) {
        changes.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: violation });
        continue;
      }
      const missingBin = await requirementsMet(raw);
      if (missingBin) {
        changes.push({ tool: target.tool, server: raw.name, action: 'skipped', reason: missingBin });
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
        const { def: resolved, missing } = resolvePlaceholders(raw, vars);
        if (missing.length > 0) {
          changes.push({
            tool: target.tool,
            server: raw.name,
            action: 'skipped',
            reason: `unresolved variable(s): ${missing.join(', ')}`,
          });
          continue;
        }
        def = resolved;
      } else if (referencedVars(raw).length > 0) {
        log.debug(`${raw.name}: passing ${referencedVars(raw).join(', ')} through to ${target.tool}`);
      }

      if (target.format === 'codex') {
        const block = renderCodexBlock(def);
        desired.set(raw.name, { entry: block, hash: entryHash(block), block });
      } else {
        const entry = renderJsonEntry(target.format, def);
        desired.set(raw.name, { entry, hash: entryHash(entry) });
      }
    }

    if (target.format === 'codex') {
      wrote = await applyCodex(target, desired, ownedNames, nextRecords, changes, options) || wrote;
    } else {
      wrote = await applyJson(target, desired, owned, ownedNames, nextRecords, changes, options) || wrote;
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
  desired: Map<string, { entry: unknown; hash: string }>,
  owned: ManagedMcpRecord[],
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean> {
  const doc = await readJsonDoc(target.file);
  if (!doc) {
    log.warn(`Could not parse ${target.file} — skipping MCP injection for ${target.tool}`);
    return false;
  }

  const ownedHash = new Map(owned.map((r) => [r.name, r.hash]));
  let dirty = false;

  for (const [name, { entry, hash }] of desired) {
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
    if (existing !== undefined && ownedHash.get(name) === hash) continue;
    doc.servers[name] = entry;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: existing === undefined ? 'added' : 'updated' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    if (doc.servers[name] !== undefined) {
      delete doc.servers[name];
      dirty = true;
    }
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  if (!dirty || options.dryRun) return false;

  // Key-level surgery: every unrelated top-level key is carried over untouched.
  doc.data.mcpServers = doc.servers;
  await writeJsonAtomic(target.file, doc.data);
  return true;
}

async function applyCodex(
  target: McpTarget,
  desired: Map<string, { entry: unknown; hash: string; block?: string }>,
  ownedNames: Set<string>,
  nextRecords: ManagedMcpRecord[],
  changes: McpChange[],
  options: McpReconcileOptions,
): Promise<boolean> {
  let source = (await readFileSafe(target.file)) ?? '';
  const present = new Set(codexServerNames(source));
  let dirty = false;

  for (const [name, { hash, block }] of desired) {
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
    const next = spliceCodexBlock(source, name, block!);
    if (next === source) continue;
    source = next;
    dirty = true;
    changes.push({ tool: target.tool, server: name, action: present.has(name) ? 'updated' : 'added' });
  }

  for (const name of ownedNames) {
    if (desired.has(name)) continue;
    const next = spliceCodexBlock(source, name, null);
    if (next !== source) {
      source = next;
      dirty = true;
    }
    changes.push({ tool: target.tool, server: name, action: 'removed' });
  }

  if (!dirty || options.dryRun) return false;

  await fse.ensureDir(path.dirname(target.file));
  const tmp = `${target.file}.${process.pid}.tmp`;
  await fse.writeFile(tmp, source, 'utf-8');
  await fse.chmod(tmp, 0o600);
  await fse.rename(tmp, target.file);
  return true;
}

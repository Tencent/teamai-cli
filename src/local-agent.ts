import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fse from 'fs-extra';
import { log } from './utils/logger.js';
import { detachChild } from './utils/exec.js';
import { parseFrontmatter } from './utils/frontmatter.js';
import {
  ensureDir,
  fileHash,
  listDirs,
  listFilesRecursive,
  pruneEmptyDirs,
  pathExists,
  readFileSafe,
  readFileIfExists,
  readJson,
  remove,
  writeFile,
  writeJson,
  writeJsonAtomic,
} from './utils/fs.js';
import { RulesHandler, SkillsHandler } from './resources/index.js';
import { injectHooksToAllTools, applyAgentHook, removeAgentHook, isAgentHookSupportedTool, isAgentHookEvent, OPENCLAW_TOOLS } from './hooks.js';
import { parseHookEvent } from './dashboard-collector.js';
import { resolveHookCwd } from './utils/hook-cwd.js';
import { isInteractive } from './utils/prompt.js';
import { getAgentVersion } from './agent-version.js';
import { getMachineId, deriveLocalAgentId } from './machine-id.js';
import { EXCLUDED_RULE_NAMES } from './builtin-rules.js';
import { ruleStemFromFilename } from './resources/rule-format.js';
import { resolveTeamaiEntryScript } from './builtin-hooks.js';
import { resolveOpenclawWorkspaceDir } from './openclaw-hooks.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import {
  detectMcpFormat,
  supportsTransport,
  renderJsonEntry,
  renderCodexBlock,
  entryHash,
  MCP_SERVER_KEY,
} from './resources/mcp-format.js';
import {
  readJsonDoc,
  isTeamaiBareCopy,
  ownsJsonMcpEntry,
  writeJsonDoc,
  writeMcpJson,
  writeCodexAtomic,
  spliceCodexBlock,
  codexServerNames,
  recordedFileOf,
  sameMcpFile,
  userMcpFile,
  USER_MCP_LOOKUP,
  claimedByOtherTools,
  deleteEmptiedMcpFile,
  describeMcpLocation,
  loadMcpManifest,
  mcpManifestKey,
  mcpRelocated,
  projectMcpLocations,
  resolveMcpTargets,
  saveMcpManifest,
  type McpTarget,
} from './mcp-reconcile.js';
import { normalizeAgentType } from './utils/tool-names.js';
import { logHttpRequest, logHttpResponse } from './utils/http-log.js';
import {
  applyInstructionPlan, deliversInstructionsByHook, holdsInstructionBlocks, instructionHookChannel, instructionHookText, instructionHookTextFor,
  instructionTargetAt, instructionTargetFile, isInstructionToolInstalled, planInstructionFiles, registerOpencodeContext, resolveInstructionTargets,
  retiredFilesOfReached, nativeProjectInstructions,
} from './instruction-targets.js';
import { opencodeClaudeFallback } from './resources/opencode-config.js';
import { reconcilePlugins, teardownAllPlugins, parseGetConfig, substituteVars, unresolvedPlaceholders, type ReconcileDeps, type PluginState } from './plugin-lifecycle.js';
import {
  resolveBaseDir,
  resolveToolBaseDir,
  scopedToolPaths,
  applyToolRoots,
  getDataHome,
  isGitExcludeEnabled,
  isUnmigratedDataHome,
  resolveGitExclude,
  resolveToolRootDir,
  CLAUDE_TOOL_ID,
  DEFAULT_CLAUDE_ROOT,
  getTokenPath,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TeamaiConfigSchema,
  managedMcpManifestPath,
  managedMcpManifestKey,
  managedMcpWorkspaceId,
  type DashboardEvent,
  type DeliveryTarget,
  type LocalConfig,
  type ManagedMcpManifest,
  type ManagedMcpRecord,
  type McpServerDef,
  type McpTransport,
  type ResourceItem,
  type TeamaiConfig,
} from './types.js';
import { getUserHome } from './utils/home.js';
import { completeWorktreeList, gitCommonDir, isLiveCheckout, listWorktrees, resolveAnchors } from './utils/git.js';
import {
  ensure as ensureGitExclude, gitExcludeFile, gitTracks, gitUntracked, remove as removeGitExclude, report as reportGitExclude, stateHomeRecord,
  sync as syncGitExclude, type GitExcludeOwner,
} from './git-exclude.js';
import {
  clearGitExcludeFailure, localAgentGitExcludeNotices, noticeGitExclude, recordGitExcludeFailure,
} from './git-exclude-notices.js';
import { blockingEntries, contentHash, deliveredSkillFiles, describeMembersDirLeft, isLink, keepsTrackedCopy, ownsSkillDir } from './resources/delivered-copies.js';
import { skillOrigin, withSkillFrontmatter } from './resources/skills.js';
import { acquireLock, releaseLock } from './update.js';

const execFileAsync = promisify(execFile);

const LOCAL_AGENT_DIR = 'local-agent';
const CONFIG_FILE = 'config.json';
const MANIFEST_FILE = 'manifest.json';
const MODEL_MANIFEST_FILE = 'model-manifest.json';
const REPORTER_ERROR_LOG = 'reporter/errors.jsonl';

/**
 * Abort timeout for local-agent network calls.
 *
 * Prevents a fetch from hanging indefinitely when the endpoint is unreachable,
 * which would otherwise keep a socket pending on the event loop and stall the
 * hook subprocess until the host IDE's default hook timeout fires.
 */
const LOCAL_AGENT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Per-fetch timeout to use while running inside a *foreground* hook. Foreground
 * hooks block the host IDE and must finish under its per-event hook timeout
 * (UserPromptSubmit/PostToolUse = 10s). Kept under 5s — and safely below the
 * foreground handler's dispatch budget (LOCAL_AGENT_FG_TIMEOUT_MS = 4.5s) — so a
 * slow/unreachable endpoint fails fast and the whole handler returns before the
 * host aborts it. Healthy endpoints answer in well under a second, so this is
 * invisible in normal use and never degrades the experience.
 */
const LOCAL_AGENT_HOOK_FETCH_TIMEOUT_MS = 3_000;

/** Active per-fetch timeout; overridden to the hook value inside foreground hooks. */
let activeFetchTimeoutMs = LOCAL_AGENT_FETCH_TIMEOUT_MS;

type LocalAgentScope = 'instance' | 'user' | 'project';
type ResourceKind = 'skills' | 'rules' | 'claudemd';
type CommandResourceKind = 'skill' | 'rule' | 'claudemd';

// Command types recognized but not yet implemented by this reporter. Skipped
// silently (see isUnimplementedCommand) so the suffix logic in commandKind()
// cannot misfire (e.g. uninstall_hook_rule ends in _rule and would otherwise be
// treated as a destructive rule uninstall). uninstall_teamai is NOT here — it
// carries a `cmd` and is executed by runCmdCommand (see executeCommand), so the
// local agent actually uninstalls itself and acks.
// install_hook_rule / uninstall_hook_rule are now implemented (see runHookRuleCommand) and are NOT skipped.
const UNIMPLEMENTED_COMMAND_TYPES = new Set<string>([]);

/** Hook commands this reporter implements (see runHookRuleCommand). Excluded from
 *  the handle_type==='hook' skip so they dispatch instead of being silently dropped. */
const IMPLEMENTED_HOOK_COMMAND_TYPES = new Set<string>(['install_hook_rule', 'uninstall_hook_rule']);

interface WorkspaceBinding {
  projectId: number;
  projectName?: string;
  boundAt: string;
  /** Normalized owning tool (via normalizeAgentType). Optional for back-compat with existing config.json;
   * absent means "not yet attributed". */
  ideType?: string;
}

export interface LocalAgentConfig {
  endpoint: string;
  token?: string;
  /**
   * @deprecated No longer the id source. local_agent_id is now derived at
   * runtime per detected tool via resolveLocalAgentId(). Kept optional so
   * older config.json files still load without a rewrite.
   */
  localAgentId?: string;
  createdAt: string;
  userGroupId?: number;
  userGroupName?: string;
  workspaceBindings: Record<string, WorkspaceBinding>;
  /**
   * Optional per-endpoint path overrides. Maps a logical route name to a custom
   * path so a backend that does not use the default `/api/local-agent/*` layout
   * can be pointed at its own routes. Unspecified routes fall back to DEFAULT_ROUTES.
   * Example: { "getConfig": "/api/plugins/config", "sync": "/v2/agent/sync" }
   */
  routes?: Partial<Record<RouteName, string>>;
}

/**
 * Logical names for every backend endpoint the local agent talks to, mapped to
 * their default paths. A deployment can override any of these via config.routes
 * (see LocalAgentConfig.routes) without touching call sites.
 */
export const DEFAULT_ROUTES = {
  projects: '/api/projects/mine',
  report: '/api/local-agent/report',
  sync: '/api/local-agent/sync',
  ack: '/api/local-agent/commands/ack',
  getConfig: '/api/local-agent/get-config',
} as const;

export type RouteName = keyof typeof DEFAULT_ROUTES;

interface LocalAgentProject {
  id: number;
  name: string;
  description?: string;
}

interface ManifestResource {
  slug: string;
  version?: string;
  display_name?: string;
  source?: string;
  installed_at: string;
  /**
   * Actual on-disk directory name for skills. Equals the SKILL.md `name:` when
   * it differs from the server slug, else the slug. Used at uninstall time to
   * locate the directory by slug (the manifest key stays the slug).
   */
  dir_name?: string;
  /**
   * The tools this entry was written to (#915). An entry an older CLI wrote
   * has none: it counts as recorded for a tool whose copy equals the installed
   * version or sits under `dir_name`, and gains the field on its next install.
   * For a claudemd entry, the tools the compiled block reached.
   */
  tools?: string[];
}

interface ManifestScope {
  skills: Record<string, ManifestResource>;
  rules: Record<string, ManifestResource>;
  claudemd: Record<string, ManifestResource>;
}

interface LocalAgentManifest {
  scopes: Record<string, ManifestScope>;
}

interface LocalAgentCommand {
  id: number;
  type?: string;
  scope?: string;
  workspace_path?: string;
  download_url?: string;
  skill_slug?: string;
  skill_version?: string;
  rule_slug?: string;
  rule_version?: string;
  rule_type?: string;
  handle_type?: string;
  claudemd_slug?: string;
  claudemd_version?: string;
  resource_slug?: string;
  resource_version?: string;
  slug?: string;
  name?: string;
  version?: string;
  display_name?: string;
  cmd?: string;
  event?: string;
  matcher?: string;
  timeout?: number;
  mcp_config?: {
    transport: string;
    url?: string;
    headers?: Record<string, string>;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;
    requires?: string[];
  };
}

interface DeliveredModel {
  provider: string;
  model_id: string;
  name: string;
  base_url: string;
  api_key: string;
  max_tokens?: number;
  context_window?: number;
}

interface BuddyModelManifest {
  codebuddy?: Record<string, string>;
  workbuddy?: Record<string, string>;
  providersByAgent?: Record<string, Record<string, string>>;
  /** Project scope: teamai created the project's models file, so it deletes it once nothing is left in it (#915). */
  createdModelsFile?: boolean;
}

interface ModelConfigManifest extends BuddyModelManifest {
  claudeEnv?: Record<string, string>;
  /**
   * model_id → provider for every model this reporter has applied. Claude
   * stores its gateway as plain ANTHROPIC_* env vars that carry no provider,
   * so this is the only way to report back the provider the server sent.
   */
  providers?: Record<string, string>;
  workspaceModels?: Record<string, BuddyModelManifest>;
}

type ModelAgentKind = 'codebuddy' | 'workbuddy' | 'claude';
type BuddyAgentKind = 'codebuddy' | 'workbuddy';

function modelAgentKind(tool: string | undefined): ModelAgentKind | undefined {
  const normalized = normalizeAgentType(tool ?? '');
  if (normalized === 'codebuddy' || normalized === 'codebuddy-internal') return 'codebuddy';
  if (normalized === 'workbuddy') return 'workbuddy';
  if (normalized === 'claude') return 'claude';
  return undefined;
}

/**
 * Whether a sync command is recognized-but-unimplemented and must be skipped
 * before dispatch. Matches both the known unimplemented type strings and any
 * hook command (handle_type === 'hook'), so a future hook `type` outside
 * UNIMPLEMENTED_COMMAND_TYPES still skips silently instead of falling through
 * to commandKind() and being acked as a failure.
 */
function isUnimplementedCommand(command: LocalAgentCommand): boolean {
  const type = command.type ?? '';
  if (IMPLEMENTED_HOOK_COMMAND_TYPES.has(type)) return false;
  return UNIMPLEMENTED_COMMAND_TYPES.has(type) || command.handle_type === 'hook';
}

interface LocalAgentContext {
  cwd?: string;
  tool?: string;
  status?: string;
  event?: DashboardEvent;
}

function getTeamaiHomePath(): string {
  return path.join(getUserHome(), '.teamai');
}

function getLocalAgentHome(): string {
  return path.join(getTeamaiHomePath(), LOCAL_AGENT_DIR);
}

function localAgentLockPath(): string {
  // Source cleanup removes the local-agent directory's contents, so keep its lock outside it.
  return path.join(getTeamaiHomePath(), '.local-agent-sync-lock');
}

/** Set on a command a sync runs while it holds the lock: the pid of that sync. */
const LOCK_HOLDER_ENV = 'TEAMAI_LOCAL_AGENT_LOCK_HOLDER';

/** Whether this process runs as a command of the sync that holds the lock, so holds it too. */
async function holdsParentLocalAgentLock(): Promise<boolean> {
  if (process.env[LOCK_HOLDER_ENV] !== String(process.ppid)) return false;
  return (await readJson<{ pid?: number }>(localAgentLockPath()))?.pid === process.ppid;
}

async function acquireLocalAgentLock(waitMs = 0): Promise<boolean> {
  if (await acquireLock(localAgentLockPath())) return true;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await acquireLock(localAgentLockPath())) return true;
  }
  return false;
}

function getConfigPath(): string {
  return path.join(getLocalAgentHome(), CONFIG_FILE);
}

function getManifestPath(): string {
  return path.join(getLocalAgentHome(), MANIFEST_FILE);
}

function getModelManifestPath(): string {
  return path.join(getLocalAgentHome(), MODEL_MANIFEST_FILE);
}

function getErrorLogPath(): string {
  return path.join(getTeamaiHomePath(), REPORTER_ERROR_LOG);
}

function compileClaudemdBlock(contents: string[]): string | null {
  const parts = contents.map((content) => content.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return [
    TEAMAI_CLAUDEMD_START,
    '<!-- DO NOT EDIT: This section is auto-managed by teamai -->',
    '',
    parts.join('\n\n'),
    '',
    TEAMAI_CLAUDEMD_END,
  ].join('\n');
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

/** Normalize a route override so it is a leading-slash path (endpoint has no trailing slash). */
function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Resolve a logical route name to its path, applying config.routes overrides
 * over DEFAULT_ROUTES. A blank/whitespace override is ignored (falls back to default).
 */
export function resolveRoute(config: Pick<LocalAgentConfig, 'routes'>, name: RouteName): string {
  const override = config.routes?.[name];
  if (override && override.trim()) return normalizeRoute(override);
  return DEFAULT_ROUTES[name];
}

/**
 * Resolve the per-tool install directory that seeds the local_agent_id hash.
 *
 * This must match the historical status-report口径 — `~/.<tool>` — so that a
 * machine upgrading from the status-report era keeps the same id instead of
 * drifting. It is derived from the same toolPaths map buildReportPayload uses:
 * `~/<dirname(skills)>` (e.g. `.codebuddy/skills` → `~/.codebuddy`). Unknown
 * tools fall back to `~/.<tool>`, still deterministic and distinct per tool.
 * Note: install_path only feeds the local hash — it never leaves the machine.
 */
function resolveAgentInstallPath(agentType: string): string {
  const home = getUserHome();
  const skillsRel = createLocalAgentTeamConfig('').toolPaths[agentType]?.skills;
  const rel = skillsRel ? path.dirname(skillsRel) : `.${agentType}`;
  return path.join(home, rel);
}

/**
 * Resolve the local_agent_id for the current invocation.
 *
 * Deterministic per (detected tool + machine + install dir) — same tool on the
 * same machine always yields the same id, so the backend sees a stable agent
 * instead of a fresh random one every hook fire. The tool is auto-detected from
 * the hook's --tool flag (context.tool); different tools (claude / codebuddy /
 * workbuddy) get different ids because agent_type AND the per-tool install dir
 * (~/.<tool>) both feed the hash. install_path uses the tool's own dir (not the
 * teamai home) to stay byte-for-byte identical to the historical status-report
 * derivation, avoiding an id change on upgrade. TEAMAI_LOCAL_AGENT_ID still
 * overrides for explicit pinning.
 */
function resolveLocalAgentId(context: LocalAgentContext): string {
  const envOverride = process.env.TEAMAI_LOCAL_AGENT_ID;
  if (envOverride) return envOverride;
  const agentType = context.tool ?? 'workbuddy';
  return deriveLocalAgentId(agentType, getMachineId(), resolveAgentInstallPath(agentType));
}

/**
 * Detect whether we are running inside a CloudStudio container sandbox.
 *
 * WorkBuddy can spawn a CloudStudio Linux container that runs its own teamai
 * hooks. That container has a different machine_id than the macOS host, so it
 * derives a second local_agent_id and reports a duplicate agent card. Both
 * signals below are absent on a normal Linux user machine, so this never
 * suppresses reporting for legitimate standalone Linux users.
 */
function isCloudStudioSandbox(): boolean {
  if (process.env.X_IDE_IS_CLOUDSTUDIO === 'TRUE') return true;
  try {
    return fs.existsSync('/var/run/cloudstudio');
  } catch {
    return false;
  }
}

/**
 * Build the unified log tag for local-agent debug output: `[<id6>] [<tool>]` —
 * the last 6 chars of the derived agent id plus the agent name (tool), so every
 * line (HTTP request/response, report/sync, command ack) reads the same way.
 */
function localAgentTag(context: LocalAgentContext): string {
  const tool = context.tool ?? 'workbuddy';
  return `[${resolveLocalAgentId(context).slice(-6)}] [${tool}]`;
}

function scopeKey(scope: LocalAgentScope, workspacePath?: string): string {
  return scope === 'project' ? `project:${workspacePath ?? ''}` : scope;
}

function emptyManifestScope(): ManifestScope {
  return { skills: {}, rules: {}, claudemd: {} };
}

async function loadManifest(): Promise<LocalAgentManifest> {
  const manifest = await readJson<LocalAgentManifest>(getManifestPath());
  return manifest ?? { scopes: {} };
}

async function saveManifest(manifest: LocalAgentManifest): Promise<void> {
  await writeJson(getManifestPath(), manifest);
}

/** One HTTP-source agent hook recorded locally so teardown can find & remove it
 *  across all formats (codex has no in-file marker, so its command is stored). */
interface AgentHookRecord {
  tool: string;
  event: string;
  command: string;
  matcher?: string;
  timeout?: number;
}

/** slug → record. Kept separate from the resource manifest and from the team
 *  managed-hooks.json so a team pull never treats agent hooks as stale. */
type AgentHookManifest = Record<string, AgentHookRecord>;

function getAgentHookManifestPath(): string {
  return path.join(getLocalAgentHome(), 'agent-hooks.json');
}

async function loadAgentHookManifest(): Promise<AgentHookManifest> {
  const data = await readJson<AgentHookManifest>(getAgentHookManifestPath());
  return data && typeof data === 'object' ? data : {};
}

async function saveAgentHookManifest(manifest: AgentHookManifest): Promise<void> {
  await writeJsonAtomic(getAgentHookManifestPath(), manifest);
}

/**
 * The member's per-machine tool roots, from the teamai config that governs this
 * directory: the project one when there is one, else the user-scope one.
 *
 * The local agent carries no LocalConfig — it addresses tool roots under $HOME
 * directly — but it writes the same files `teamai pull` does, so a root the
 * member relocated (CLAUDE_CONFIG_DIR, recorded by `teamai init`) has to reach
 * them too. No config, or no entry, leaves the paths exactly as they were.
 */
async function memberToolRoots(workspacePath?: string): Promise<Record<string, string> | undefined> {
  const { resolveMemberToolRoots } = await import('./config.js');
  return resolveMemberToolRoots(workspacePath ?? process.cwd());
}

/** Claude Code's user root on this machine, honoring a relocated CLAUDE_CONFIG_DIR. */
async function claudeUserRoot(): Promise<string> {
  return resolveToolRootDir(CLAUDE_TOOL_ID, DEFAULT_CLAUDE_ROOT, await memberToolRoots());
}

/** Resolve the current tool's settings file absolute path (user scope, $HOME base). */
async function resolveToolSettingsPath(config: LocalAgentConfig | null, tool: string): Promise<string> {
  // Hook cleanup also runs after the source configuration has been cleared.
  const teamConfig = createLocalAgentTeamConfig(config?.endpoint ?? 'local-agent');
  const toolPath = applyToolRoots(teamConfig.toolPaths, await memberToolRoots())[tool];
  if (!toolPath?.settings) {
    throw new Error(`unsupported tool: ${tool} (no settings path)`);
  }
  return path.join(getUserHome(), toolPath.settings);
}

function getPluginStatePath(): string {
  return path.join(getLocalAgentHome(), 'plugins.json');
}

async function readPluginState(): Promise<Record<string, PluginState>> {
  return (await readJson<Record<string, PluginState>>(getPluginStatePath())) ?? {};
}

/**
 * Atomically mutate the plugin-state file under an exclusive lock. If the lock
 * cannot be acquired within the timeout, throws (the caller skips this cycle
 * rather than writing without the lock — reconcile is throttled, so skipping is safe).
 */
async function withPluginStateLock(mutate: (m: Record<string, PluginState>) => void): Promise<void> {
  const statePath = getPluginStatePath();
  const lockPath = `${statePath}.lock`;
  await ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + 5000;
  let acquired = false;
  while (Date.now() <= deadline) {
    try { const fd = await fs.promises.open(lockPath, 'wx'); await fd.close(); acquired = true; break; }
    catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      try {
        const st = await fs.promises.stat(lockPath);
        if (Date.now() - st.mtimeMs > 30_000) { await fs.promises.rm(lockPath, { force: true }); continue; }
      } catch { /* lock vanished */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!acquired) throw new Error('could not acquire plugin-state lock');
  try {
    const m = await readPluginState();
    mutate(m);
    await writeJson(statePath, m);
  } finally {
    await fs.promises.rm(lockPath, { force: true });
  }
}

function getManifestScope(
  manifest: LocalAgentManifest,
  scope: LocalAgentScope,
  workspacePath?: string,
): ManifestScope {
  const key = scopeKey(scope, workspacePath);
  manifest.scopes[key] ??= emptyManifestScope();
  return manifest.scopes[key];
}

/**
 * Canonicalize a workspace path to its physical on-disk form via realpath.
 * On case-insensitive filesystems (macOS) this collapses casing variants of the
 * same physical directory to one identity; it also resolves symlinks. Falls back
 * to the resolved absolute path when the target does not exist (dead binding) or
 * realpath fails for any other reason.
 */
async function canonicalizeWorkspacePath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await fs.promises.realpath(absolute);
  } catch {
    return absolute;
  }
}

function mergeWorkspaceBindings(
  existing: WorkspaceBinding | undefined,
  incoming: WorkspaceBinding,
  canonicalKey: string,
): WorkspaceBinding {
  if (!existing) return incoming;
  // pick base = whichever has a non-zero projectId; prefer existing on tie
  const existingReal = existing.projectId !== 0;
  const incomingReal = incoming.projectId !== 0;
  if (existingReal && incomingReal && existing.projectId !== incoming.projectId) {
    log.warn(
      `local-agent: workspace ${canonicalKey} has conflicting project bindings ` +
        `(${existing.projectId} vs ${incoming.projectId}); keeping ${existing.projectId}`,
    );
  }
  const base = existingReal || !incomingReal ? { ...existing } : { ...incoming };
  // A physical workspace tracks one owning tool (same single-owner model as
  // stampWorkspaceTool). Only backfill ideType when the base lacks one; if two
  // aliases were stamped by different tools, the base's ideType wins — the
  // other tool re-stamps itself on its next report from the canonical path.
  if (!base.ideType) base.ideType = existing.ideType ?? incoming.ideType;
  return base;
}

export async function loadLocalAgentConfig(options: { dryRun?: boolean } = {}): Promise<LocalAgentConfig | null> {
  const fileConfig = await readJson<LocalAgentConfig | { disabled: true }>(getConfigPath());
  // A removed source must not reconnect through legacy config or environment fallback.
  if (fileConfig && 'disabled' in fileConfig && fileConfig.disabled === true) return null;
  if (fileConfig && 'endpoint' in fileConfig && fileConfig.endpoint) {
    const config = {
      ...fileConfig,
      endpoint: normalizeEndpoint(fileConfig.endpoint),
      workspaceBindings: fileConfig.workspaceBindings ?? {},
    };
    // Migrate: clear legacy group-based bindings (groupId without projectId)
    const removedLegacyPaths: string[] = [];
    for (const [wsPath, binding] of Object.entries(config.workspaceBindings)) {
      if ('groupId' in binding && !('projectId' in (binding as Record<string, unknown>))) {
        delete config.workspaceBindings[wsPath];
        removedLegacyPaths.push(wsPath);
      }
    }
    if (removedLegacyPaths.length > 0 && options.dryRun) {
      log.info(`[dry-run] Would remove ${removedLegacyPaths.length} legacy group-based workspace binding(s).`);
    } else if (removedLegacyPaths.length > 0) {
      log.warn(
        `Removed ${removedLegacyPaths.length} legacy group-based workspace binding(s); ` +
          `you will be prompted to re-bind on the next session.`,
      );
      try {
        await saveLocalAgentConfig(config);
      } catch (e) {
        log.debug(`local-agent: failed to persist binding cleanup: ${(e as Error).message}`);
      }
    }
    // Migrate: canonicalize binding keys to their physical on-disk path so
    // case-only / symlink aliases of the same workspace collapse to one entry.
    const migrated: Record<string, WorkspaceBinding> = {};
    let migrationChanged = false;
    for (const [wsPath, binding] of Object.entries(config.workspaceBindings)) {
      const canonicalKey = await canonicalizeWorkspacePath(wsPath);
      if (canonicalKey !== wsPath) migrationChanged = true;
      if (migrated[canonicalKey]) migrationChanged = true;
      migrated[canonicalKey] = mergeWorkspaceBindings(migrated[canonicalKey], binding, canonicalKey);
    }
    config.workspaceBindings = migrated;
    if (migrationChanged && !options.dryRun) {
      await saveLocalAgentConfig(config);
    }
    return config;
  }

  // Backfill: if config.json is missing but a legacy ~/.teamai/config.yaml has
  // an HTTP team repo, auto-create config.json so v0.17.x upgraders keep capability.
  const { loadLocalConfig } = await import('./config.js');
  const { resolveApiKey } = await import('./api-key.js');
  // Under `dryRun` the migrations above and this backfill stay in memory: nothing is written.
  const legacy = await loadLocalConfig(options);
  if (legacy?.repo?.kind === 'http' && legacy.repo.url) {
    const endpoint = normalizeEndpoint(legacy.repo.url);
    const token = resolveApiKey() ?? undefined;
    const backfilled: LocalAgentConfig = {
      endpoint,
      token,
      createdAt: new Date().toISOString(),
      workspaceBindings: {},
    };
    if (options.dryRun) return backfilled;
    try {
      await saveLocalAgentConfig(backfilled);
      log.debug('local-agent: backfilled config.json from legacy ~/.teamai/config.yaml (http repo)');
    } catch (e) {
      log.debug(`local-agent: backfill persist failed, using in-memory config: ${(e as Error).message}`);
    }
    return backfilled;
  }

  const envEndpoint =
    process.env.TEAMAI_HTTP_ENDPOINT ??
    process.env.TEAMAI_ENDPOINT ??
    process.env.TEAMAI_API_BASE_URL;
  if (!envEndpoint) return null;

  return {
    endpoint: normalizeEndpoint(envEndpoint),
    token: process.env.TEAMAI_API_TOKEN ?? process.env.TEAMAI_TOKEN,
    createdAt: new Date().toISOString(),
    workspaceBindings: {},
  };
}

async function saveLocalAgentConfig(config: LocalAgentConfig): Promise<void> {
  await writeJsonAtomic(getConfigPath(), {
    ...config,
    endpoint: normalizeEndpoint(config.endpoint),
    workspaceBindings: config.workspaceBindings ?? {},
  });
}

function createLocalAgentTeamConfig(endpoint: string): TeamaiConfig {
  return TeamaiConfigSchema.parse({
    team: 'local-agent',
    repo: endpoint,
    description: 'HTTP local agent resource cache',
  });
}

/**
 * Whether the member keeps what teamai delivers into `workspacePath` out of
 * git (#915): the resolved flag of the config governing it, its project's,
 * else the user scope's. Unknown when that config, or the git-mode team's
 * teamai.yaml with no override in the config, cannot be read: `cause` says
 * which, `fix` what to do (`resolveGitExclude`).
 */
async function gitExcludeEnabledFor(workspacePath: string): Promise<boolean | { cause: string; fix: string }> {
  const { loadTeamConfig, resolveConfigForDir } = await import('./config.js');
  let unreadable: { cause: string; fix: string } | undefined;
  const config = await resolveConfigForDir(workspacePath, (configPath, error) => {
    unreadable = { cause: `teamai could not read ${configPath} (${error})`, fix: `Fix ${configPath}` };
  });
  if (unreadable) return unreadable;
  if (!config) return false;
  const enabled = resolveGitExclude(config, await loadTeamConfig(config.repo.localPath));
  if (enabled !== undefined) return enabled;
  const override = isUnmigratedDataHome(config) ? '' : `, or set \`gitExcludeEnabled\` in ${path.join(getDataHome(config), 'config.yaml')}`;
  return {
    cause: `teamai could not read sharing.gitExclude from the team's teamai.yaml (${path.join(config.repo.localPath, 'teamai.yaml')})`,
    fix: `Fix or restore teamai.yaml in the team repository${override}`,
  };
}

/**
 * The resource cache's team config for one install, carrying the workspace's
 * git exclude flag so every writer and the instruction targets read the same
 * value (#915). While the flag is unknown nothing is written: either value
 * could move a file the other placed. `change` names what was refused
 * ("install <slug>", "uninstall <slug>").
 */
async function localAgentTeamConfig(endpoint: string, scope: LocalAgentScope, workspacePath: string | undefined, change: string): Promise<TeamaiConfig> {
  const teamConfig = createLocalAgentTeamConfig(endpoint);
  if (scope !== 'project' || !workspacePath) return teamConfig;
  const enabled = await gitExcludeEnabledFor(workspacePath);
  if (typeof enabled === 'object') {
    throw new Error(`${enabled.cause}, so the local agent did not ${change} in ${workspacePath}: it wrote nothing there. ${enabled.fix}.`);
  }
  if (!enabled) return teamConfig;
  return { ...teamConfig, sharing: { ...teamConfig.sharing, gitExclude: { enabled: true } } };
}

/** The block of the skills and rules this agent installs in projects, its exclude files recorded in its state home (#915). */
function localAgentGitExcludeOwner(): GitExcludeOwner {
  return { name: 'local-agent', record: stateHomeRecord(getLocalAgentHome(), 'local-agent') };
}

/**
 * Whether `entry` records `tool`'s copy at `dest` (#915): by its `tools`, or,
 * for an entry an older CLI wrote without them, by its `dir_name` naming the
 * path or by a copy equal to the installed version.
 */
async function recordsCopy(
  entry: ManifestResource | undefined, tool: string, dest: string, equalsInstalled: () => Promise<boolean>,
): Promise<boolean> {
  if (!entry) return false;
  if (entry.tools) return entry.tools.includes(tool);
  if (entry.dir_name !== undefined && path.basename(dest) === entry.dir_name) return true;
  return equalsInstalled();
}

/** Why the local agent did not install `slug` at `dest`: the file there is the member's (#915). */
function keptMembersFile(dest: string, slug: string): string {
  return `Kept ${dest}: it is not teamai's (not in the local agent's records). `
    + `Rename or delete it; the local agent installs ${slug} on its next sync.`;
}

/** The tools an older CLI's `entry` counts as written to, by `recordsCopy` (#915). */
async function legacyTools(
  entry: ManifestResource,
  fullTeamConfig: TeamaiConfig,
  targetsFor: (teamConfig: TeamaiConfig) => Promise<DeliveryTarget[]>,
  equalsInstalled: (target: DeliveryTarget) => Promise<boolean>,
): Promise<string[]> {
  const tools: string[] = [];
  for (const [tool, toolPath] of Object.entries(fullTeamConfig.toolPaths)) {
    for (const target of await targetsFor({ ...fullTeamConfig, toolPaths: { [tool]: toolPath } })) {
      if (await pathExists(target.dest) && await recordsCopy(entry, tool, target.dest, () => equalsInstalled(target))) {
        tools.push(tool);
        break;
      }
    }
  }
  return tools;
}

/** `tools`, with `tool` when every one of its `targets` is on disk after the write. */
async function withToolIfWritten(tools: string[], tool: string, targets: DeliveryTarget[]): Promise<string[]> {
  const written = targets.length > 0 && (await Promise.all(targets.map(({ dest }) => pathExists(dest)))).every(Boolean);
  return [...new Set(written ? [...tools, tool] : tools)].sort();
}

/**
 * The first destination of `item` for the one tool of `teamConfig` that holds
 * the member's rule (#915): a file that is neither the render of `item` nor
 * recorded in `entry` (for a legacy entry, equal to the render of `installed`,
 * the version in the cache).
 */
async function membersRuleCopy(
  teamConfig: TeamaiConfig, localConfig: LocalConfig, item: ResourceItem, entry: ManifestResource | undefined,
  tool: string, installed: ResourceItem | undefined,
): Promise<string | null> {
  const handler = new RulesHandler();
  for (const { dest, content } of await handler.deliveryTargets(teamConfig, localConfig, item)) {
    const disk = await fileHash(dest);
    if (disk === null || (content !== undefined && disk === contentHash(content))) continue;
    const equalsInstalled = async (): Promise<boolean> => {
      if (!installed || !await pathExists(installed.sourcePath)) return false;
      const render = (await handler.deliveryTargets(teamConfig, localConfig, installed)).find((target) => target.dest === dest)?.content;
      return render !== undefined && disk === contentHash(render);
    };
    if (await recordsCopy(entry, tool, dest, equalsInstalled)) continue;
    return dest;
  }
  return null;
}

/**
 * Which files of `dest`, a tool's copy of the local agent's skill or rule
 * `name` (a skill: its directory name), are teamai's (#915). Null when no
 * manifest entry records that copy for `tool`; an entry an older CLI wrote,
 * without tools, counts for every tool. Otherwise `teamais` are the files
 * equal to what the agent writes there today from its cached source, and
 * `members` every other entry (a file the member added or edited, a link, a
 * repository). Read-only; judge before the cache is deleted. `config`: the
 * source's, when a teardown already disabled it.
 */
export async function localAgentCopyFiles(
  kind: 'skill' | 'rule', name: string, tool: string, dest: string, config?: LocalAgentConfig,
): Promise<{ teamais: string[]; members: string[] } | null> {
  config ??= await loadLocalAgentConfig({ dryRun: true }) ?? undefined;
  if (!config) return null;
  const fullTeamConfig = createLocalAgentTeamConfig(config.endpoint);
  const toolPath = fullTeamConfig.toolPaths[tool];
  if (!toolPath) return null;
  const real = async (file: string): Promise<string> => fs.promises.realpath(file).catch(() => path.resolve(file));
  const at = await real(dest);
  for (const [key, scopeManifest] of Object.entries((await loadManifest()).scopes)) {
    const entries = Object.entries((kind === 'skill' ? scopeManifest.skills : scopeManifest.rules) ?? {});
    const entry = entries.find(([slug, e]) => (kind === 'skill' ? e.dir_name ?? slug : slug) === name)?.[1];
    if (!entry || (entry.tools && !entry.tools.includes(tool))) continue;
    const { scope, workspacePath } = parseScopeKey(key);
    const repoPath = await getResourceRepoPath(scope, workspacePath);
    const localConfig = await createResourceLocalConfig(config, scope, repoPath, workspacePath);
    const teamConfig = { ...fullTeamConfig, toolPaths: { [tool]: toolPath } };
    const sourcePath = path.join(repoPath, kind === 'skill' ? 'skills' : 'rules', kind === 'skill' ? name : `${name}.md`);
    const item: ResourceItem = { name, type: kind === 'skill' ? 'skills' : 'rules', sourcePath, relativePath: path.relative(repoPath, sourcePath).split(path.sep).join('/') };
    const handler = kind === 'skill' ? new SkillsHandler() : new RulesHandler();
    let target: DeliveryTarget | undefined;
    for (const candidate of await handler.deliveryTargets(teamConfig, localConfig, item)) {
      if (await real(candidate.dest) === at) target = candidate;
    }
    if (!target) continue;
    if (kind === 'rule') {
      const disk = await fileHash(dest);
      const teamais = disk !== null && ((target.content !== undefined && disk === contentHash(target.content)) || disk === await fileHash(sourcePath));
      return teamais ? { teamais: [dest], members: [] } : { teamais: [], members: [dest] };
    }
    if (await isLink(dest)) return { teamais: [], members: [dest] };
    // What the agent writes there today: each cached file, SKILL.md with its frontmatter repaired.
    const expected = new Map<string, string>();
    for (const rel of await pathExists(sourcePath) ? await listFilesRecursive(sourcePath) : []) {
      const bytes = await fse.readFile(path.join(sourcePath, rel));
      const text = bytes.toString('utf-8');
      const written = rel === 'SKILL.md' ? withSkillFrontmatter(text, name) : text;
      expected.set(rel.split(path.sep).join('/'), contentHash(written === text ? bytes : written));
    }
    const result = { teamais: [] as string[], members: [] as string[] };
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const entry of await fse.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, entry.name);
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(file, entryRel);
        else if (entry.isFile() && expected.get(entryRel) === await fileHash(file)) result.teamais.push(file);
        else result.members.push(file);
      }
    };
    await walk(dest, '');
    return result;
  }
  return null;
}

async function createResourceLocalConfig(
  config: LocalAgentConfig,
  scope: LocalAgentScope,
  repoPath: string,
  workspacePath?: string,
): Promise<LocalConfig> {
  const projectScope = scope === 'project';
  return {
    repo: { localPath: repoPath, remote: config.endpoint },
    username: os.userInfo().username,
    scope: projectScope ? 'project' : 'user',
    projectRoot: projectScope ? workspacePath : undefined,
    additionalRoles: [],
    // User-scope paths resolve under $HOME here, so a tool the member relocated
    // must be addressed at its recorded root — the same one `teamai pull` uses.
    ...(projectScope ? {} : { toolRoots: await memberToolRoots(workspacePath) }),
    // State a sync records (OpenCode's instructions entry) goes to the
    // project's data home, where uninstall reads it.
    ...(projectScope && workspacePath
      ? { dataHome: await (await import('./config.js')).resolveDataHomeForScope('project', workspacePath) }
      : {}),
  };
}

async function getResourceRepoPath(scope: LocalAgentScope, workspacePath?: string): Promise<string> {
  if (scope === 'project' && workspacePath) {
    // Project resource cache is A1 (per-project) AND per-worktree: the resource
    // cache (claudemd/skills/rules fragments) is what each worktree installs
    // independently, and syncClaudemd merges EVERY file in this dir. The partition
    // data home is shared by all linked worktrees, so the cache must live in a
    // per-worktree subdir — otherwise worktree B's CLAUDE.md would merge in
    // worktree A's instructions. Mirror managed-mcp's per-worktree layout.
    const { resolveDataHomeForScope } = await import('./config.js');
    const dataHome = await resolveDataHomeForScope('project', workspacePath);
    return path.join(dataHome, 'workspaces', managedMcpWorkspaceId(workspacePath), LOCAL_AGENT_DIR, 'resources');
  }
  return path.join(getLocalAgentHome(), 'resources', scope);
}

const WORKSPACE_CACHE_GITIGNORE = ['# teamai local state', 'local-agent/', ''].join('\n');

async function ensureProjectGitignore(workspacePath: string): Promise<void> {
  const teamaiDir = path.join(workspacePath, '.teamai');
  await ensureDir(teamaiDir);
  const gitignorePath = path.join(teamaiDir, '.gitignore');
  const existing = await readFileSafe(gitignorePath);
  if (!existing) {
    await writeFile(gitignorePath, WORKSPACE_CACHE_GITIGNORE);
    return;
  }
  if (!existing.split('\n').some((line) => line.trim() === 'local-agent/')) {
    await writeFile(gitignorePath, existing.trimEnd() + '\nlocal-agent/\n');
  }
}

/**
 * The `.gitignore` that hides the cache the agent keeps inside a workspace
 * with no project config of its own, while the cache lives there and the file
 * is as the agent wrote it (#915). A `.gitignore` the member had, which the
 * agent only appended to, is theirs.
 */
async function workspaceCacheGitignore(workspacePath: string, repoPath: string): Promise<string | null> {
  const teamaiDir = path.join(workspacePath, '.teamai');
  if (!repoPath.startsWith(teamaiDir + path.sep)) return null;
  const file = path.join(teamaiDir, '.gitignore');
  return await readFileSafe(file) === WORKSPACE_CACHE_GITIGNORE ? file : null;
}

function authHeaders(config: LocalAgentConfig, json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
    headers['X-API-Token'] = config.token;
  }
  return headers;
}

async function localAgentFetch<T>(
  config: LocalAgentConfig,
  tag: string,
  route: RouteName,
  init?: RequestInit,
  opts?: { redactResponseLog?: boolean },
): Promise<T> {
  const method = init?.method ?? 'GET';
  const url = `${config.endpoint}${resolveRoute(config, route)}`;
  const headers: Record<string, string> = {
    ...authHeaders(config, init?.body !== undefined),
    ...(init?.headers as Record<string, string> | undefined),
  };
  logHttpRequest(tag, method, url, headers, init?.body);

  const response = await fetch(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(activeFetchTimeoutMs),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  logHttpResponse(tag, method, url, response.status, response.statusText, opts?.redactResponseLog ? '<redacted>' : body);
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : text || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

async function appendErrorLog(entry: unknown): Promise<void> {
  try {
    await ensureDir(path.dirname(getErrorLogPath()));
    await fs.promises.appendFile(
      getErrorLogPath(),
      JSON.stringify({ at: new Date().toISOString(), entry }) + '\n',
      'utf-8',
    );
  } catch {
    // Best-effort; hook execution must not fail on I/O.
  }
}

export async function fetchUserProjects(config: LocalAgentConfig): Promise<LocalAgentProject[]> {
  const response = await localAgentFetch<{ ok?: boolean; projects?: LocalAgentProject[] }>(
    config,
    localAgentTag({}),
    'projects',
    { method: 'GET' },
  );
  return response.projects ?? [];
}

/** Mask secret values (CLI flags / key=value / bearer tokens) so they don't reach logs. */
function redactSecrets(s: string): string {
  // Secret-bearing identifiers, matched case-insensitively in flag and key=value forms.
  const names = 'secret[_-]?(?:key|id)|api[_-]?key|access[_-]?token|token|password|passwd|pwd';
  return s
    .replace(new RegExp(`(--(?:${names})[= ]+)\\S+`, 'gi'), '$1***')
    .replace(new RegExp(`((?:${names})"?\\s*[:=]\\s*"?)[^"\\s,}]+`, 'gi'), '$1***')
    .replace(/(bearer\s+)[\w.-]+/gi, '$1***');
}

/**
 * Execute a shell command string with a timeout.
 *
 * Completion is gated on the process 'exit' event, NOT 'close': a setup command that
 * daemonizes and leaves the inherited stderr pipe open in a background process would never
 * emit 'close', producing a false timeout even though the command itself finished.
 * Rejects on non-zero exit, termination by signal, or timeout.
 */
export async function execPluginCommand(cmd: string, timeoutMs: number): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', cmd], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn('bash', ['-lc', cmd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachChild(child);
      fn();
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    child.on('error', (e) => finish(() => reject(e)));
    child.on('exit', (code, signal) =>
      finish(() => {
        if (signal) return reject(new Error(`command killed by ${signal}`));
        if (code === 0) return resolve();
        const tail = stderr ? ' :: ' + redactSecrets(stderr.slice(0, 200).trim()) : '';
        reject(new Error(`command failed (exit ${code})${tail}`));
      }),
    );
  });
}

/**
 * Fetch backend plugin config.
 * Route = 'getConfig' (default path /api/local-agent/get-config, overridable via config.routes).
 * localAgentFetch builds `url = config.endpoint + resolveRoute(...)`, matching report/sync pattern.
 */
async function fetchPluginConfig(config: LocalAgentConfig, tag: string): Promise<unknown> {
  return localAgentFetch<unknown>(config, tag, 'getConfig', { method: 'GET' }, { redactResponseLog: true });
}

const PLUGIN_PULL_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PLUGIN_FAIL_BACKOFF_MS = 60 * 60 * 1000;

function getPluginPullStatePath(): string {
  return path.join(getLocalAgentHome(), 'plugin-pull.json');
}

function buildReconcileDeps(config: LocalAgentConfig, tag: string): ReconcileDeps {
  return {
    readPlugins: () => readPluginState(),
    mutatePlugins: (fn) => withPluginStateLock(fn),
    execCommand: (cmd, t) => execPluginCommand(cmd, t),
    now: () => Date.now(),
    log: {
      debug: (msg) => log.debug(`${tag} ${msg}`),
      // The reconcile worker runs detached (stdio: 'ignore'), so console-only log.warn
      // output is discarded. Mirror warnings to debug.log so failures are traceable.
      warn: (msg) => {
        log.warn(`${tag} ${msg}`);
        log.debug(`${tag} WARN: ${msg}`);
      },
    },
  };
}

/** On session start, throttle-check and spawn a detached worker for plugin reconcile. Never blocks. */
async function maybeReconcilePlugins(context: LocalAgentContext): Promise<void> {
  try {
    const state = (await readJson<{ lastPullAt?: number; lastFailAt?: number }>(getPluginPullStatePath())) ?? {};
    const now = Date.now();
    if (state.lastPullAt && now - state.lastPullAt < PLUGIN_PULL_INTERVAL_MS) return;
    if (state.lastFailAt && now - state.lastFailAt < PLUGIN_FAIL_BACKOFF_MS) return;
    const tool = context.tool ?? 'workbuddy';
    const localAgentId = `${tool}-${resolveLocalAgentId(context)}`;
    const { spawn } = await import('node:child_process');
    if (!process.argv[1]) { log.debug('[local-agent] plugin reconcile: no CLI entrypoint (argv[1]), skipping'); return; }
    const child = spawn(process.execPath, [process.argv[1], 'source', 'reconcile-plugins'],
      { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, TEAMAI_PLUGIN_LOCAL_AGENT_ID: localAgentId } });
    child.unref();
  } catch (e) { log.debug(`[local-agent] plugin reconcile spawn skipped: ${(e as Error).message}`); }
}

/** Detached worker: reconcile plugins while sharing the HTTP source lifecycle lock. */
export async function runPluginReconcileWorker(): Promise<void> {
  if (!await loadLocalAgentConfig({ dryRun: true })) return;
  // A session-start sync spawns this worker while holding the same lifecycle lock.
  if (!await acquireLocalAgentLock(30_000)) return;
  try {
    const config = await loadLocalAgentConfig();
    if (!config) return;
    const tag = '[local-agent] [plugin-reconcile]';
    const statePath = getPluginPullStatePath();
    try {
      const resp = await fetchPluginConfig(config, tag);
      const { vars, plugins } = parseGetConfig(resp);
      const declaredSlugs = plugins.length ? ` [${plugins.map((p) => p.slug).join(', ')}]` : '';
      log.debug(`${tag} get-config: ${plugins.length} plugin(s) declared${declaredSlugs}`);
      const laid = process.env.TEAMAI_PLUGIN_LOCAL_AGENT_ID;
      if (!laid) log.debug(tag + ' no local_agent_id in env; plugins needing it will be skipped');
      const allVars = { ...vars, ...(laid ? { local_agent_id: laid } : {}) };
      const resolved: typeof plugins = [];
      for (const p of plugins) {
        const rp = {
          ...p,
          installCmd: substituteVars(p.installCmd, allVars),
          updateCmd: p.updateCmd ? substituteVars(p.updateCmd, allVars) : undefined,
          uninstallCmd: substituteVars(p.uninstallCmd, allVars),
          runCmd: substituteVars(p.runCmd, allVars),
        };
        const missing = [...new Set([
          ...unresolvedPlaceholders(rp.installCmd),
          ...unresolvedPlaceholders(rp.runCmd),
          ...unresolvedPlaceholders(rp.uninstallCmd),
          ...(rp.updateCmd ? unresolvedPlaceholders(rp.updateCmd) : []),
        ])];
        if (missing.length) {
          log.warn(`${tag} plugin ${p.slug}: unresolved placeholders [${missing.join(',')}], skipping`);
          log.debug(`${tag} WARN: plugin ${p.slug}: unresolved placeholders [${missing.join(',')}], skipping`);
          continue;
        }
        resolved.push(rp);
      }
      await reconcilePlugins(resolved, buildReconcileDeps(config, tag));
      log.debug(`${tag} reconcile complete (${resolved.length} plugin(s) processed)`);
      await writeJson(statePath, { lastPullAt: Date.now() });
    } catch (e) {
      const prev = (await readJson<{ lastPullAt?: number; lastFailAt?: number }>(statePath)) ?? {};
      await writeJson(statePath, { ...prev, lastFailAt: Date.now() });
      log.debug(`${tag} reconcile failed: ${(e as Error).message}`);
    }
  } finally {
    await releaseLock(localAgentLockPath());
  }
}

async function askViaTty(prompt: string): Promise<string | null> {
  // Only prompt on a real interactive terminal (e.g. the user running
  // `teamai bind-project` directly). In non-interactive contexts such as an
  // IDE-invoked hook, stdin is piped; opening /dev/tty there succeeds when the
  // host GUI keeps a controlling terminal, and readline then blocks forever
  // waiting for input that never comes — hanging the hook until the host's
  // timeout and stalling the IDE. Callers fall back to injecting a stdout
  // binding hint when this returns null, so degrade to that instead.
  // The decline stays synchronous — this runs on the hook path, where loading
  // the prompt module only to say no is work nobody asked for.
  if (!isInteractive()) return null;
  const { askQuestion } = await import('./utils/prompt.js');
  return askQuestion(prompt, '');
}

async function promptForProjectBinding(
  workspacePath: string,
  projects: LocalAgentProject[],
): Promise<LocalAgentProject | null> {
  if (projects.length === 0) return null;

  log.debug(`local-agent: workspace not bound: ${workspacePath}`);
  const answer = await askViaTty('是否绑定到一个项目？[y/N] ');
  if (!answer || answer.toLowerCase() !== 'y') return null;

  if (projects.length === 1) return projects[0];

  log.info('可用项目:');
  projects.forEach((project, index) => {
    const desc = project.description ? ` - ${project.description}` : '';
    log.info(`  ${index + 1}. ${project.name}${desc} [id=${project.id}]`);
  });

  const selection = await askViaTty(`选择项目编号（1-${projects.length}，0 跳过）: `);
  if (selection === null || selection === '0') return null;
  const index = selection ? Number.parseInt(selection, 10) : 0;
  if (Number.isNaN(index) || index < 1 || index > projects.length) return null;
  return projects[index - 1];
}

/**
 * Persist a ClawPro binding decision for the current checkout.
 *
 * Binding is a per-project decision, so it is recorded on the `projectAnchor`
 * (the main checkout, shared by a repo and all of its git worktrees — issue
 * #374 / #387). It is ALSO stamped on the current `workspaceRoot` so this
 * checkout is reported with the project_id immediately and its resources land
 * in the current worktree (#387's workspaceRoot model — every AI tool discovers
 * resources by scanning up from the launch dir, never via git-common-dir). For a
 * plain repo the two anchors coincide and this writes a single entry. Falls back
 * to `resolvedPath` when `cwd` is not inside a git repo.
 *
 * Existing fields (e.g. a stamped `ideType`) on any touched entry are preserved.
 */
async function persistWorkspaceBinding(
  config: LocalAgentConfig,
  cwd: string | undefined,
  resolvedPath: string,
  projectId: number,
  projectName: string,
): Promise<void> {
  const anchors = await resolveAnchors(cwd);
  const keys = new Set<string>([resolvedPath]);
  if (anchors) {
    keys.add(anchors.projectAnchor);
    keys.add(anchors.workspaceRoot);
  }
  const boundAt = new Date().toISOString();
  for (const key of keys) {
    config.workspaceBindings[key] = {
      ...config.workspaceBindings[key],
      projectId,
      projectName,
      boundAt,
    };
  }
  await saveLocalAgentConfig(config);
}

/**
 * If the current checkout is an unbound git worktree whose main checkout
 * (`projectAnchor`) is already bound or skipped, copy that decision onto the
 * current `workspaceRoot` and report success — so a repo is never re-prompted
 * for binding once per new worktree (a `--skip` on the main checkout silences
 * all of them too). Returns true when the worktree inherited a binding.
 */
async function inheritWorktreeBinding(
  config: LocalAgentConfig,
  cwd: string | undefined,
  resolvedPath: string,
): Promise<boolean> {
  const anchors = await resolveAnchors(cwd);
  if (!anchors || anchors.projectAnchor === anchors.workspaceRoot) return false;
  const anchorBinding = config.workspaceBindings[anchors.projectAnchor];
  if (!anchorBinding) return false;
  config.workspaceBindings[resolvedPath] = {
    ...config.workspaceBindings[resolvedPath],
    projectId: anchorBinding.projectId,
    projectName: anchorBinding.projectName,
    boundAt: new Date().toISOString(),
  };
  await saveLocalAgentConfig(config);
  return true;
}

export async function bindWorkspaceToProject(
  workspacePath: string,
  projectId?: number,
): Promise<WorkspaceBinding | null> {
  const config = await loadLocalAgentConfig();
  if (!config) {
    throw new Error('HTTP local agent is not initialized. Run `teamai init --http <ENDPOINT> --token <API_TOKEN>` first.');
  }

  const projects = await fetchUserProjects(config);
  const project = projectId
    ? projects.find((item) => item.id === projectId)
    : await promptForProjectBinding(workspacePath, projects);
  if (!project) return null;

  const binding: WorkspaceBinding = {
    projectId: project.id,
    projectName: project.name,
    boundAt: new Date().toISOString(),
  };
  // Record on the projectAnchor (shared across the repo's worktrees) and the
  // current workspaceRoot; workspacePath is already the resolved checkout root.
  await persistWorkspaceBinding(config, workspacePath, workspacePath, project.id, project.name);
  log.success(`已将工作区绑定到项目：${project.name} [id=${project.id}]`);
  return binding;
}

async function ensureWorkspaceBinding(
  config: LocalAgentConfig,
  workspacePath: string,
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  if (config.workspaceBindings[workspacePath]) return;
  // A worktree inherits its main checkout's binding/skip decision — never prompt.
  if (await inheritWorktreeBinding(config, cwd, workspacePath)) return;

  const markerKey = sessionId || `ppid-${process.ppid}`;
  const hintMarker = path.join(os.tmpdir(), `teamai-bind-session-${markerKey}`);
  if (fs.existsSync(hintMarker)) return;
  try { fs.writeFileSync(hintMarker, ''); } catch {}

  let projects: LocalAgentProject[];
  try {
    projects = await fetchUserProjects(config);
  } catch (e) {
    log.debug(`local-agent: failed to load user projects: ${(e as Error).message}`);
    return;
  }

  if (projects.length === 0) return;

  const project = await promptForProjectBinding(workspacePath, projects);
  if (project) {
    await persistWorkspaceBinding(config, cwd, workspacePath, project.id, project.name);
    return;
  }

  // TTY prompt failed (running as hook in background) — output context for AI to prompt user
  const projectList = projects.map((p) => `${p.name} (id=${p.id})`).join(', ');
  const context = [
    '[teamai] 当前工作区尚未绑定项目，无法接收项目下发的 skills/rules/claudemd 资源。',
    `可用项目: ${projectList}`,
    `请提示用户运行: teamai bind-project`,
    `或指定项目: teamai bind-project --project-id <id>`,
  ].join('\n');
  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  });
  process.stdout.write(hookOutput + '\n');
}

/**
 * The organization-binding prompt (TTY prompt + injected hook context) is
 * on by default. Disable it explicitly with `TEAMAI_BIND_PROMPT_ENABLED=0`
 * (or `false`). The manual `teamai bind-project` command is always available
 * regardless.
 */
function isBindPromptEnabled(): boolean {
  const flag = process.env.TEAMAI_BIND_PROMPT_ENABLED;
  if (flag === undefined) return true;
  const normalized = flag.toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

/**
 * ClawPro project binding only backs CodeBuddy/WorkBuddy (the ClawPro-native
 * agents); the prompt is noise for every other host (Claude, Cursor, Codex, …),
 * which drove the poor UX. Gate the whole prompt — both the SessionStart TTY
 * prompt and the UserPromptSubmit hint — on the current tool being a buddy
 * agent. Reuses `modelAgentKind` so tool-name variants like `codebuddy-internal`
 * still match (a raw Set would miss them).
 */
function isBindPromptTool(tool: string | undefined): boolean {
  const kind = modelAgentKind(tool);
  return kind === 'codebuddy' || kind === 'workbuddy';
}

async function emitBindingHint(
  config: LocalAgentConfig,
  workspacePath: string,
  sessionId?: string,
  cwd?: string,
): Promise<void> {
  if (config.workspaceBindings[workspacePath]) return;
  // A worktree inherits its main checkout's binding/skip decision — never hint.
  if (await inheritWorktreeBinding(config, cwd, workspacePath)) return;

  // Only hint once per session — use a temp marker file keyed by sessionId
  const markerKey = sessionId || `ppid-${process.ppid}`;
  const hintMarker = path.join(os.tmpdir(), `teamai-bind-hint-${markerKey}`);
  if (fs.existsSync(hintMarker)) return;
  try { fs.writeFileSync(hintMarker, ''); } catch {}

  let projects: LocalAgentProject[];
  try {
    projects = await fetchUserProjects(config);
  } catch {
    return;
  }
  if (projects.length === 0) return;

  const skipNum = projects.length + 1;
  const choices = projects.map((p, i) => `${i + 1}. 绑定到「${p.name}」项目`);
  const actions = projects.map((p, i) => `- 用户回复 ${i + 1} → 执行 \`teamai bind-project --project-id ${p.id}\`，完成后回复"绑定完成，请开新会话生效"`);
  const context = [
    '[ClawPro项目 绑定提示] 你必须原样展示下面的选项列表，不得修改编号或内容。等用户回复数字后执行对应命令。',
    '',
    '---',
    '当前工作区未绑定ClawPro项目。绑定后可同步团队 skills/rules。请回复数字选择：',
    '',
    ...choices,
    `${skipNum}. 不绑定，以后也不再提示`,
    '---',
    '',
    '执行规则（不要展示给用户）：',
    ...actions,
    `- 用户回复 ${skipNum} → 执行 \`teamai bind-project --skip\`，完成后回复"已跳过，以后不再提示"`,
  ].join('\n');
  const hookOutput = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  });
  process.stdout.write(hookOutput + '\n');
}

function isEphemeralTaskDir(dir: string): boolean {
  const segments = dir.split(path.sep);
  const wbIdx = segments.lastIndexOf('WorkBuddy');
  if (wbIdx < 0 || wbIdx >= segments.length - 1) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(segments[wbIdx + 1]);
}

async function resolveWorkspacePath(cwd?: string): Promise<string | undefined> {
  if (!cwd) return undefined;
  const absolute = path.resolve(cwd);
  if (isEphemeralTaskDir(absolute)) return undefined;
  try {
    const { stdout } = await execFileAsync('git', ['-C', absolute, 'rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    return await canonicalizeWorkspacePath(root || absolute);
  } catch {
    return await canonicalizeWorkspacePath(absolute);
  }
}

interface ReportedResource {
  slug: string;
  version?: string;
  display_name?: string;
  source: string;
}

/**
 * Resolve a resource's source by looking it up in the local-agent manifest:
 * slugs recorded there were installed via HTTP distribution (`enterprise`);
 * everything else present only on disk is treated as `local`.
 */
function resolveSource(slug: string, manifestSlugs: Set<string>): string {
  return manifestSlugs.has(slug) ? 'enterprise' : 'local';
}

/**
 * Scan a tool's on-disk skills directory. Each sub-directory containing a
 * SKILL.md is one installed skill; slug/version/display_name come from its
 * front-matter (falling back to the directory name).
 */
async function scanSkillsFromDisk(
  skillsDir: string,
  manifestSlugs: Set<string>,
): Promise<ReportedResource[]> {
  if (!(await pathExists(skillsDir))) return [];
  const dirs = (await listDirs(skillsDir)).filter((name) => !name.startsWith('.') && !name.startsWith('_'));
  const results: ReportedResource[] = [];
  for (const dir of dirs) {
    const skillMd = path.join(skillsDir, dir, 'SKILL.md');
    if (!(await pathExists(skillMd))) continue;
    const fm = await readFrontmatter(skillMd);
    const slug = typeof fm.name === 'string' && fm.name ? fm.name : dir;
    const version = fm.version != null ? String(fm.version) : undefined;
    results.push({
      slug,
      version,
      display_name: slug,
      source: resolveSource(slug, manifestSlugs),
    });
  }
  return results.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Scan a tool's on-disk rules directory. Every `.md` file (recursively) is one
 * installed rule; the slug is its path relative to the rules dir without the
 * `.md` extension.
 */
async function scanRulesFromDisk(
  rulesDir: string,
  manifestSlugs: Set<string>,
): Promise<ReportedResource[]> {
  if (!(await pathExists(rulesDir))) return [];
  // Cursor stores rules as `.mdc`, every other tool as `.md`; match by stem so
  // a Cursor agent still reports its installed rules.
  const files = await listFilesRecursive(rulesDir);
  const results: ReportedResource[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const slug = ruleStemFromFilename(file);
    if (slug === null) continue;
    if (seen.has(slug)) continue; // Same rule under both extensions
    seen.add(slug);
    // Skip CLI built-in / legacy rules (e.g. teamai-recall) so they are not
    // reported as user-installed resources — mirrors the pull/uninstall filter.
    if (EXCLUDED_RULE_NAMES.has(path.basename(slug)) || EXCLUDED_RULE_NAMES.has(slug)) continue;
    results.push({
      slug,
      display_name: slug,
      source: resolveSource(slug, manifestSlugs),
    });
  }
  return results.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Collect every skill/rule slug recorded across all manifest scopes.
 * For skills, also includes dir_name (the on-disk SKILL.md name) so that
 * scanSkillsFromDisk — which uses SKILL.md name as the reported slug —
 * correctly resolves source as 'enterprise' even when dir_name ≠ slug.
 */
function collectManifestSlugs(manifest: LocalAgentManifest): { skills: Set<string>; rules: Set<string> } {
  const skills = new Set<string>();
  const rules = new Set<string>();
  for (const scope of Object.values(manifest.scopes)) {
    for (const [slug, entry] of Object.entries(scope.skills ?? {})) {
      skills.add(slug);
      if (entry.dir_name) skills.add(entry.dir_name);
    }
    for (const slug of Object.keys(scope.rules ?? {})) rules.add(slug);
  }
  return { skills, rules };
}

/**
 * Scan the managed-mcp manifest for a given scope and return MCP servers as
 * ReportedResource entries. Only servers tracked in managed-mcp.json (i.e.
 * installed via HTTP distribution) are reported with source = 'enterprise'.
 *
 * Results are scoped to the current `tool` so a report never leaks another
 * tool's MCP inventory. The manifest is keyed by the same key the installer
 * writes under (see `installMcpServer`): `tool` at user scope, `${tool}:project`
 * at project scope. `tool` is the raw hook-context value (not run through
 * normalizeAgentType), matching how the installer keys the manifest.
 */
async function scanMcpFromManifest(
  scope: 'user' | 'project',
  tool: string,
  projectRoot?: string,
): Promise<ReportedResource[]> {
  const { resolveDataHomeForScope } = await import('./config.js');
  const dataHome = await resolveDataHomeForScope(scope, projectRoot);

  // Project scope reads THIS worktree's own manifest file (per-worktree under the
  // partition; migrates legacy shared records on first read). User scope reads the
  // single global file. Either way every record in the loaded file belongs to this
  // scope, so no key filtering is needed.
  let manifest: ManagedMcpManifest;
  if (scope === 'project' && projectRoot) {
    const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');
    ({ manifest } = await loadProjectMcpManifest(dataHome, projectRoot));
  } else {
    manifest = (await readJson<ManagedMcpManifest>(managedMcpManifestPath(dataHome))) ?? {};
  }

  const manifestKey = `${tool}${scope === 'project' ? ':project' : ''}`;
  const records = manifest[manifestKey];
  if (!Array.isArray(records)) return [];

  const seen = new Set<string>();
  const results: ReportedResource[] = [];
  for (const rec of records) {
    if (!rec.name || seen.has(rec.name)) continue;
    seen.add(rec.name);
    results.push({ slug: rec.name, source: 'enterprise' });
  }
  return results.sort((a, b) => a.slug.localeCompare(b.slug));
}

interface ReportedModel {
  provider: string;
  model_id: string;
  name?: string;
  source: string;
}

/**
 * Scan the models a tool can currently use, as configured on disk. The server
 * requires both `provider` and `model_id`, so entries that cannot supply them
 * are dropped rather than reported as incomplete. `source` is derived from the
 * model manifest, mirroring how skills/rules classify enterprise vs local.
 *
 * Only CodeBuddy, WorkBuddy, and Claude keep a discoverable model config;
 * every other tool reports nothing. User-owned models are omitted: the
 * backend cannot resolve them, so only entries still matching a TeamAI
 * delivery are reported.
 */
function buddyModelsPath(agentKind: BuddyAgentKind, workspacePath?: string): string {
  return workspacePath
    ? path.join(workspacePath, '.codebuddy', 'models.json')
    : path.join(getUserHome(), `.${agentKind}`, 'models.json');
}

function modelConfigDisplayPath(filePath: string): string {
  if (filePath.endsWith(`${path.sep}.codebuddy${path.sep}models.json`)) {
    return '.codebuddy/models.json';
  }
  if (filePath.endsWith(`${path.sep}.workbuddy${path.sep}models.json`)) {
    return '~/.workbuddy/models.json';
  }
  return path.basename(filePath);
}

async function scanModelsFromDisk(tool: string, workspacePath?: string): Promise<ReportedModel[]> {
  const manifest = (await readJson<ModelConfigManifest>(getModelManifestPath())) ?? {};
  const agentKind = modelAgentKind(tool);

  if (agentKind === 'codebuddy' || agentKind === 'workbuddy') {
    const scopeManifest = workspacePath ? manifest.workspaceModels?.[workspacePath] : manifest;
    const providers = scopeManifest?.providersByAgent?.[agentKind]
      ?? (!workspacePath && agentKind !== 'workbuddy' ? manifest.providers : undefined)
      ?? {};
    const raw = await readJson<unknown>(buddyModelsPath(agentKind, workspacePath));
    const entries = Array.isArray(raw)
      ? raw
      : (Array.isArray((raw as { models?: unknown } | null)?.models)
        ? (raw as { models: unknown[] }).models
        : []);
    const owned = (agentKind === 'codebuddy'
      ? scopeManifest?.codebuddy
      : scopeManifest?.workbuddy) ?? {};
    const results: ReportedModel[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { id, vendor, name } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || !id) continue;
      if (typeof vendor !== 'string' || !vendor) continue;
      // CodeBuddy / WorkBuddy may normalize a model entry by adding capability
      // metadata. The manifest's model id is the durable proof that TeamAI
      // delivered it; requiring an exact object hash would hide such entries.
      if (owned[id] === undefined || providers[id] !== vendor) continue;
      results.push({
        provider: vendor,
        model_id: id,
        ...(typeof name === 'string' && name ? { name } : {}),
        source: 'enterprise',
      });
    }
    return results;
  }

  if (agentKind === 'claude' && !workspacePath) {
    const providers = manifest.providersByAgent?.claude ?? manifest.providers ?? {};
    const settings = await readJson<{ env?: unknown }>(
      path.join(await claudeUserRoot(), 'settings.json'),
    );
    const env = settings?.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return [];
    const { ANTHROPIC_CUSTOM_MODEL_OPTION: modelId, ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: name } =
      env as Record<string, unknown>;
    if (typeof modelId !== 'string' || !modelId) return [];
    const managed = manifest.claudeEnv?.ANTHROPIC_CUSTOM_MODEL_OPTION;
    if (managed === undefined || entryHash(modelId) !== managed) return [];
    const provider = providers[modelId];
    if (!provider) return [];
    return [{
      provider,
      model_id: modelId,
      ...(typeof name === 'string' && name ? { name } : {}),
      source: 'enterprise',
    }];
  }

  return [];
}

/**
 * Remove workspace bindings whose directory no longer exists on disk.
 *
 * Workspace bindings are only ever added, never removed, so a deleted
 * project directory would otherwise be reported forever and the server
 * (full-sync snapshot) could never drop it. This prunes such stale
 * entries in place. Applies to skipped ('__skipped__', projectId 0)
 * entries too — a deleted directory should not leave a permanent sentinel.
 *
 * @param config - Loaded local-agent config; its workspaceBindings map is mutated in place.
 * @returns True if at least one binding was removed.
 */
export async function pruneDeadWorkspaceBindings(config: LocalAgentConfig): Promise<boolean> {
  let changed = false;
  for (const workspacePath of Object.keys(config.workspaceBindings)) {
    try {
      await fs.promises.stat(workspacePath);
    } catch (error) {
      // Only prune when the directory is confirmed gone (ENOENT). Transient
      // failures — permission errors, unreachable network mounts — must NOT
      // delete a still-valid binding, or the server's full-sync snapshot
      // would drop that workspace's resources.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        delete config.workspaceBindings[workspacePath];
        changed = true;
      } else {
        log.debug(
          `local-agent: keeping workspace binding ${workspacePath} despite stat error: ${(error as Error).message}`,
        );
      }
    }
  }
  return changed;
}

/**
 * Stamps the workspace binding's owning tool when the hook fires from that tool's own process.
 * Because hooks are invoked from within the tool's process, cwd === binding.path is the
 * authoritative signal that this binding belongs to the triggering tool.
 *
 * Returns true if the binding was modified (caller should persist config), false otherwise.
 */
export function stampWorkspaceTool(
  config: LocalAgentConfig,
  currentPath: string | null | undefined,
  tool: string,
): boolean {
  if (!currentPath) return false;
  const binding = config.workspaceBindings[currentPath];
  if (!binding) return false;
  const normalized = normalizeAgentType(tool);
  if (binding.ideType === normalized) return false;
  binding.ideType = normalized;
  return true;
}

/**
 * Select the workspace paths that belong to the current tool for reporting.
 *
 * A binding belongs to the current tool when its stamped ideType matches, or —
 * for the not-yet-attributed current cwd — when it is the workspace the hook
 * fired from. An empty/absent ideType on a non-cwd binding is treated as
 * unattributed and excluded (it self-heals once its owning tool reports from it).
 */
function selectToolWorkspaces(
  config: LocalAgentConfig,
  currentPath: string | null | undefined,
  currentTool: string,
): string[] {
  const paths = new Set<string>(Object.keys(config.workspaceBindings));
  if (currentPath) paths.add(currentPath);
  return Array.from(paths).filter((wsPath) => {
    const b = config.workspaceBindings[wsPath];
    const wsTool = (b?.ideType || undefined) ?? (wsPath === currentPath ? currentTool : undefined);
    return wsTool === currentTool;
  });
}

export async function buildReportPayload(
  config: LocalAgentConfig,
  context: LocalAgentContext,
): Promise<Record<string, unknown>> {
  const manifest = await loadManifest();

  // Resource discovery scans the tool's on-disk skills/rules directories rather
  // than the manifest, so locally-installed resources (not just HTTP-distributed
  // ones) are reported. `source` is derived from the manifest: slugs recorded
  // there are `enterprise`, the rest `local`.
  const tool = context.tool ?? 'workbuddy';
  const teamConfig = createLocalAgentTeamConfig(config.endpoint);
  const manifestSlugs = collectManifestSlugs(manifest);

  // Resolve paths through the same user-scope seam the installers use: tools
  // that relocate their user customization root (copilot via $COPILOT_HOME) or
  // lay user scope out differently from project scope declare a `userScope`
  // block. Reading the raw toolPaths map against $HOME would scan the project
  // layout under the wrong base — e.g. ~/.github/skills for copilot, a path
  // teamai never writes to — and silently report nothing.
  const scanScope = async (workspacePath?: string): Promise<{ skills: ReportedResource[]; rules: ReportedResource[] }> => {
    const scope: LocalAgentScope = workspacePath ? 'project' : 'user';
    const localConfig = await createResourceLocalConfig(config, scope, workspacePath ?? getUserHome(), workspacePath);
    const toolPath = scopedToolPaths(teamConfig, localConfig)[tool];
    if (!toolPath) return { skills: [], rules: [] };
    const baseDir = resolveToolBaseDir(tool, localConfig);
    const skills = toolPath.skills
      ? await scanSkillsFromDisk(path.join(baseDir, toolPath.skills), manifestSlugs.skills)
      : [];
    const rules = toolPath.rules
      ? await scanRulesFromDisk(path.join(baseDir, toolPath.rules), manifestSlugs.rules)
      : [];
    return { skills, rules };
  };

  const userScope = await scanScope();

  const userLevel: Record<string, unknown> = { group_id: config.userGroupId };
  if (userScope.skills.length > 0) userLevel.skills = userScope.skills;
  if (userScope.rules.length > 0) userLevel.rules = userScope.rules;
  const userMcps = await scanMcpFromManifest('user', tool);
  if (userMcps.length > 0) userLevel.mcps = userMcps;
  // Omitted when empty for the same full-sync reason as skills/rules: the
  // server treats a present array as a snapshot, so [] would wipe the models.
  const userModels = await scanModelsFromDisk(tool);
  if (userModels.length > 0) userLevel.models = userModels;

  const payload: Record<string, unknown> = {
    agent_type: normalizeAgentType(tool),
    agent_version: await getAgentVersion(tool),
    local_agent_id: resolveLocalAgentId(context),
    host_name: os.hostname(),
    os: os.platform(),
    started_at: config.createdAt,
    last_status: context.status ?? 'running',
    // Instance-level skills/rules are a phase-1 legacy concept. They are
    // deliberately omitted (not sent as []): the server treats present arrays
    // as a full-sync snapshot ("消失即删"), so an empty array would wipe any
    // instance-level resources. Omitting the field leaves them untouched.
    user_level: userLevel,
  };

  const currentPath = await resolveWorkspacePath(context.cwd);
  const currentTool = normalizeAgentType(tool);
  const targetPaths = selectToolWorkspaces(config, currentPath, currentTool);
  if (targetPaths.length > 0) {
    const workspaceResults = await Promise.all(
      targetPaths.map(async (wsPath) => {
        const wsScope = await scanScope(wsPath);
        const wsBinding = config.workspaceBindings[wsPath];
        const workspace: Record<string, unknown> = {
          path: wsPath,
          name: path.basename(wsPath),
          ide_type: currentTool,
          project_id: wsBinding?.projectId,
        };
        if (wsScope.skills.length > 0) workspace.skills = wsScope.skills;
        if (wsScope.rules.length > 0) workspace.rules = wsScope.rules;
        const wsMcps = await scanMcpFromManifest('project', tool, wsPath);
        if (wsMcps.length > 0) workspace.mcps = wsMcps;
        const wsModels = await scanModelsFromDisk(tool, wsPath);
        if (wsModels.length > 0) workspace.models = wsModels;
        return workspace;
      }),
    );
    payload.workspaces = workspaceResults;
  }

  return payload;
}

export async function buildSyncPayload(
  config: LocalAgentConfig,
  context: LocalAgentContext,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    agent_type: normalizeAgentType(context.tool ?? 'workbuddy'),
    local_agent_id: resolveLocalAgentId(context),
    status: context.status ?? 'running',
  };
  const currentPath = await resolveWorkspacePath(context.cwd);
  const currentTool = normalizeAgentType(context.tool ?? 'workbuddy');
  const targetPaths = selectToolWorkspaces(config, currentPath, currentTool);
  if (targetPaths.length > 0) {
    payload.workspaces = targetPaths.map((wsPath) => {
      const wsBinding = config.workspaceBindings[wsPath];
      return {
        path: wsPath,
        name: path.basename(wsPath),
        ide_type: currentTool,
        project_id: wsBinding?.projectId,
      };
    });
  }
  return payload;
}

function commandKind(command: LocalAgentCommand): CommandResourceKind | null {
  // Unified cmds[] carries handle_type; legacy commands[] carries rule_type.
  // Both map a prompt rule to the claudemd resource kind.
  if (command.rule_type === 'prompt' || command.handle_type === 'prompt') return 'claudemd';
  if (command.handle_type === 'rule') return 'rule';
  if (command.handle_type === 'hook') return null; // defensive; skipped before dispatch
  const type = command.type ?? '';
  if (type.endsWith('_skill') || type === '') return 'skill';
  if (type.endsWith('_claudemd') || type.endsWith('_claude_md')) return 'claudemd';
  if (type.endsWith('_rule')) return 'rule';
  return null;
}

function commandAction(command: LocalAgentCommand): 'install' | 'uninstall' | null {
  const type = command.type ?? '';
  if (type === '') return 'install';
  if (type.startsWith('install_')) return 'install';
  if (type.startsWith('uninstall_')) return 'uninstall';
  return null;
}

/**
 * Reject slugs that could escape the resource directory. Slugs come from
 * backend sync commands and are used directly in filesystem paths, so a value
 * like `../../.ssh/authorized_keys` would otherwise write outside the repo.
 */
function validateSlug(slug: string): string {
  if (
    !slug ||
    slug.includes('/') ||
    slug.includes('\\') ||
    slug.includes('..') ||
    path.isAbsolute(slug)
  ) {
    throw new Error(`Invalid resource slug: ${slug}`);
  }
  return slug;
}

function commandSlug(command: LocalAgentCommand, kind: CommandResourceKind): string {
  const slug =
    kind === 'skill' ? command.skill_slug :
    kind === 'rule' ? command.rule_slug :
    (command.claudemd_slug ?? command.rule_slug);
  const resolved = slug ?? command.resource_slug ?? command.slug ?? command.name;
  if (!resolved) {
    throw new Error(`Missing ${kind} slug`);
  }
  return validateSlug(resolved);
}

function commandVersion(command: LocalAgentCommand, kind: CommandResourceKind): string | undefined {
  return (
    kind === 'skill' ? command.skill_version :
    kind === 'rule' ? command.rule_version :
    (command.claudemd_version ?? command.rule_version)
  ) ?? command.resource_version ?? command.version;
}

/**
 * Normalize a backend-sent scope string to an internal LocalAgentScope.
 *
 * The backend emits `user` / `workspace` (see clawpro local-agent-api.md);
 * the deprecated `instance` is no longer sent. Internally project-level
 * resources use the `project` scope, so `workspace` maps to `project`.
 * Any unrecognized value falls back to `user` (global install).
 *
 * This only maps the scope; presence of `workspace_path` for project scope
 * is validated by the caller (executeCommand throws if it is missing).
 */
function normalizeScope(raw?: string): LocalAgentScope {
  if (raw === 'workspace' || raw === 'project') return 'project';
  if (raw !== undefined && raw !== 'user' && raw !== 'instance') {
    log.debug(`local-agent: unknown scope "${raw}", defaulting to user`);
  }
  return 'user';
}

function manifestKind(kind: CommandResourceKind): ResourceKind {
  return kind === 'skill' ? 'skills' : kind === 'rule' ? 'rules' : 'claudemd';
}

/** Only http(s) downloads are allowed — reject file:, ftp:, gopher:, etc. */
function assertHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid download URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported download URL scheme: ${parsed.protocol}`);
  }
  return parsed;
}

/**
 * Fetch a resource by URL. download_url comes from backend sync commands, so it
 * is treated as untrusted: only http(s) is honoured (no file:// / local-path
 * copy, which would be arbitrary local file read), and redirects are followed
 * manually so every hop's scheme is re-validated instead of blindly trusting
 * whatever Location the server returns.
 */
async function downloadResource(downloadUrl: string): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'teamai-local-agent-'));
  const filePath = path.join(tmpDir, 'resource');

  let current = assertHttpUrl(downloadUrl);
  let response: Response;
  const maxRedirects = 5;
  // One timeout budget for the whole download (all redirect hops combined), so a
  // chain of slow redirects cannot exceed the intended bound.
  const signal = AbortSignal.timeout(activeFetchTimeoutMs);
  for (let hop = 0; ; hop++) {
    response = await fetch(current, { redirect: 'manual', signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) break;
      if (hop >= maxRedirects) {
        throw new Error(`Download failed: too many redirects (${downloadUrl})`);
      }
      current = assertHttpUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

async function isZipFile(filePath: string): Promise<boolean> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    return buf.equals(ZIP_MAGIC);
  } finally {
    await fd.close();
  }
}

async function resolveMarkdownFromDownload(downloadedPath: string, slug: string): Promise<string> {
  if (await isZipFile(downloadedPath)) {
    const extractDir = await extractZip(downloadedPath);
    return findMarkdownFile(extractDir, slug);
  }
  return downloadedPath;
}

async function extractZip(zipPath: string): Promise<string> {
  const extractDir = path.join(path.dirname(zipPath), 'extracted');
  await ensureDir(extractDir);
  await execFileAsync('unzip', ['-q', zipPath, '-d', extractDir]);
  return extractDir;
}

async function findFirst(
  dir: string,
  predicate: (absolutePath: string, name: string) => Promise<boolean>,
): Promise<string | null> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (await predicate(absolute, entry.name)) return absolute;
    if (entry.isDirectory()) {
      const nested = await findFirst(absolute, predicate);
      if (nested) return nested;
    }
  }
  return null;
}

async function findSkillRoot(extractDir: string): Promise<string> {
  if (await pathExists(path.join(extractDir, 'SKILL.md'))) return extractDir;
  const skillMd = await findFirst(extractDir, async (absolute, name) => name === 'SKILL.md' && (await pathExists(absolute)));
  if (!skillMd) throw new Error('Downloaded skill package does not contain SKILL.md');
  return path.dirname(skillMd);
}

async function findMarkdownFile(extractDir: string, preferredName: string): Promise<string> {
  const preferred = await findFirst(
    extractDir,
    async (_absolute, name) => name === `${preferredName}.md` || name === preferredName,
  );
  if (preferred) return preferred;

  const firstMd = await findFirst(extractDir, async (_absolute, name) => name.endsWith('.md'));
  if (!firstMd) throw new Error('Downloaded package does not contain a markdown file');
  return firstMd;
}

async function readFrontmatter(filePath: string): Promise<Record<string, unknown>> {
  const content = await readFileSafe(filePath);
  if (!content) return {};
  return parseFrontmatter(content).data;
}

/**
 * Decide the on-disk directory name for a skill. The SKILL.md `name:` field is
 * the source of truth for how the skill is identified by the AI tool, so use it
 * when it differs from the server-provided slug (matching the git-path behaviour
 * in skill-command.ts / #144). Falls back to the slug when the name is missing,
 * empty, equal to the slug, or fails path-safety validation.
 */
async function resolveSkillDirName(skillRoot: string, slug: string): Promise<string> {
  const fm = await readFrontmatter(path.join(skillRoot, 'SKILL.md'));
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  if (!name || name === slug) return slug;
  try {
    assertSafeResourceName(name);
    return name;
  } catch {
    log.debug(`[local-agent] keeping slug "${slug}" as skill dir (SKILL.md name "${name}" failed safety check)`);
    return slug;
  }
}

async function installDownloadedResource(input: {
  config: LocalAgentConfig;
  command: LocalAgentCommand;
  kind: CommandResourceKind;
  slug: string;
  scope: LocalAgentScope;
  workspacePath?: string;
  tool?: string;
}): Promise<string | undefined> {
  if (!input.command.download_url) {
    throw new Error(`Missing download_url for ${input.command.type ?? 'install_skill'}`);
  }

  const repoPath = await getResourceRepoPath(input.scope, input.workspacePath);
  if (input.scope === 'project' && input.workspacePath
      && repoPath.startsWith(path.join(input.workspacePath, '.teamai') + path.sep)) {
    // Only gitignore when the cache actually lands inside the workspace (no
    // project config there, or a legacy, un-migrated install). A partitioned
    // install keeps it under ~/.teamai, so there is nothing in the workspace to ignore.
    await ensureProjectGitignore(input.workspacePath);
  }
  await ensureDir(repoPath);

  const downloadedPath = await downloadResource(input.command.download_url);
  try {
    const fullTeamConfig = await localAgentTeamConfig(input.config.endpoint, input.scope, input.workspacePath, `install ${input.slug}`);
    const tool = input.tool ?? 'workbuddy';
    const toolPath = fullTeamConfig.toolPaths[tool];
    if (!toolPath) {
      throw new Error(`Unknown tool "${tool}": no toolPaths entry found`);
    }
    const teamConfig = { ...fullTeamConfig, toolPaths: { [tool]: toolPath } };
    const localConfig = await createResourceLocalConfig(input.config, input.scope, repoPath, input.workspacePath);
    // Ensure the tool root directory exists before dispatch so isToolInstalled
    // gate does not skip the resource when the workspace is freshly bound.
    // Restricted to project scope: user-scope installs use $HOME as baseDir and
    // should continue to rely on isToolInstalled as the gate.
    if (localConfig.scope === 'project') {
      try {
        const baseDir = resolveBaseDir(localConfig);
        const resourceToolPath =
          input.kind === 'skill' ? toolPath.skills :
          input.kind === 'rule'  ? toolPath.rules  :
          // Default branch covers the 'claudemd' kind; if a new CommandResourceKind
          // is added, revisit this mapping so it doesn't silently fall through to claudemd.
          toolPath.claudemd;
        if (resourceToolPath && resourceToolPath.includes('/')) {
          const rootSegment = resourceToolPath.split('/')[0];
          await ensureDir(path.join(baseDir, rootSegment));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('resolveBaseDir')) {
          log.warn(`Cannot resolve base dir to pre-create tool root: ${msg}`);
        } else {
          log.debug(`Failed to pre-create tool root directory: ${msg}`);
        }
      }
    }
    const now = new Date().toISOString();
    let displayName = input.command.display_name ?? input.slug;
    // On-disk skill directory name (SKILL.md name when it differs from slug).
    // Stays the slug for rules/claudemd. Recorded in the manifest so uninstall
    // can find the directory by slug.
    let skillDirName = input.slug;
    // The tools this install wrote to, and every other rule entry it wrote (#915).
    let tools: string[] | undefined;
    const reachedRules: string[] = [];
    // The tools the compiled claudemd block reached: it carries every other prompt of the scope too.
    let reachedPrompts: string[] = [];
    const recorded = getManifestScope(await loadManifest(), input.scope, input.workspacePath)[manifestKind(input.kind)][input.slug];

    if (input.kind === 'skill') {
      const extractDir = await extractZip(downloadedPath);
      const skillRoot = await findSkillRoot(extractDir);
      skillDirName = await resolveSkillDirName(skillRoot, input.slug);
      const dest = path.join(repoPath, 'skills', skillDirName);
      const handler = new SkillsHandler();
      const item: ResourceItem = { name: skillDirName, type: 'skills', sourcePath: dest, relativePath: `skills/${skillDirName}` };
      const downloaded: ResourceItem = { ...item, sourcePath: skillRoot };
      // A copy the record does not name is the member's unless it equals the
      // download (#915); the cache is no git repo, so no history proves more.
      const origin = skillOrigin(repoPath, skillDirName);
      const equalsInstalled = async (copy: string): Promise<boolean> => await pathExists(dest) && ownsSkillDir(undefined, copy, origin, [item]);
      const targets = await handler.deliveryTargets(teamConfig, localConfig, downloaded);
      for (const { dest: copy } of targets) {
        if (!await pathExists(copy) || await ownsSkillDir(undefined, copy, origin, [downloaded])) continue;
        if (!await recordsCopy(recorded, tool, copy, () => equalsInstalled(copy))) throw new Error(keptMembersFile(copy, input.slug));
      }
      const previousTools = recorded?.tools ?? (recorded
        ? await legacyTools(recorded, fullTeamConfig, (config) => handler.deliveryTargets(config, localConfig, item), ({ dest: copy }) => equalsInstalled(copy))
        : []);
      await remove(dest);
      await fse.copy(skillRoot, dest, { overwrite: true });
      const fm = await readFrontmatter(path.join(dest, 'SKILL.md'));
      displayName = typeof fm.name === 'string' ? fm.name : displayName;
      await handler.pullItem(item, teamConfig, localConfig);
      tools = await withToolIfWritten(previousTools, tool, targets);
    } else if (input.kind === 'rule') {
      const ruleFile = await resolveMarkdownFromDownload(downloadedPath, input.slug);
      const dest = path.join(repoPath, 'rules', `${input.slug}.md`);
      const handler = new RulesHandler();
      const item: ResourceItem = { name: input.slug, type: 'rules', sourcePath: dest, relativePath: `rules/${input.slug}.md` };
      const downloaded: ResourceItem = { ...item, sourcePath: ruleFile };
      const members = await membersRuleCopy(teamConfig, localConfig, downloaded, recorded, tool, item);
      if (members) throw new Error(keptMembersFile(members, input.slug));
      // Before the cache takes the download: the render of the installed version.
      const previousTools = recorded?.tools ?? (recorded
        ? await legacyTools(recorded, fullTeamConfig, (config) => handler.deliveryTargets(config, localConfig, item),
          async ({ dest: copy, content }) => content !== undefined && await fileHash(copy) === contentHash(content))
        : []);
      await fse.ensureDir(path.dirname(dest));
      await fse.copyFile(ruleFile, dest);
      // Every rule in the cache reaches this tool; one whose copy here is the
      // member's is left out, as the installed one would be (#915).
      const scope = getManifestScope(await loadManifest(), input.scope, input.workspacePath);
      const deliver: ResourceItem[] = [];
      for (const cached of await handler.scanTeamForPull(teamConfig, localConfig)) {
        const kept = cached.name === input.slug ? null
          : await membersRuleCopy(teamConfig, localConfig, cached, scope.rules[cached.name], tool, cached);
        if (kept) log.warn(keptMembersFile(kept, cached.name));
        else deliver.push(cached);
      }
      await handler.pullAllRules(teamConfig, localConfig, deliver);
      tools = await withToolIfWritten(previousTools, tool, await handler.deliveryTargets(teamConfig, localConfig, item));
      reachedRules.push(...deliver.map((rule) => rule.name).filter((name) => name !== input.slug));
    } else {
      const mdFile = await resolveMarkdownFromDownload(downloadedPath, input.slug);
      const dest = path.join(repoPath, 'claudemd', `${input.slug}.md`);
      await fse.ensureDir(path.dirname(dest));
      const previous = await readFileSafe(dest);
      await fse.copyFile(mdFile, dest);
      try {
        reachedPrompts = await syncClaudemd(teamConfig, localConfig, repoPath, input.workspacePath, fullTeamConfig);
      } catch (error) {
        // Session hooks read the cache directly: a prompt that was not
        // delivered must not reach them, nor push out the ones that were.
        if (previous === null) await remove(dest);
        else await fse.writeFile(dest, previous);
        throw error;
      }
      tools = recorded?.tools ?? [];
    }

    const version = commandVersion(input.command, input.kind);
    const manifest = await loadManifest();
    const scopeManifest = getManifestScope(manifest, input.scope, input.workspacePath);
    scopeManifest[manifestKind(input.kind)][input.slug] = {
      slug: input.slug,
      version,
      display_name: displayName,
      source: 'enterprise',
      installed_at: now,
      ...(input.kind === 'skill' && skillDirName !== input.slug ? { dir_name: skillDirName } : {}),
      ...(tools ? { tools } : {}),
    };
    for (const name of reachedRules) {
      const entry = scopeManifest.rules[name];
      if (entry?.tools && !entry.tools.includes(tool)) entry.tools = [...entry.tools, tool].sort();
    }
    recordPromptReach(scopeManifest, reachedPrompts);
    await saveManifest(manifest);
    return version;
  } finally {
    await remove(path.dirname(downloadedPath));
  }
}

/**
 * Delete teamai's files of the skill copy at `dest` (#915): the directory
 * when every file in it is teamai's, else those files only, naming each the
 * member's. A file git tracks stays (named).
 */
async function removeSkillCopy(dest: string, name: string, files: { teamais: string[]; members: string[] }): Promise<void> {
  if (files.members.length === 0) {
    if (!await keepsTrackedCopy(dest)) await remove(dest);
    return;
  }
  for (const file of files.teamais) if (!await keepsTrackedCopy(file)) await remove(file);
  await pruneEmptyDirs(dest);
  for (const file of files.members) {
    log.warn(describeMembersDirLeft(file, `skills/${name}/${path.relative(dest, file).split(path.sep).join('/')}`, 'the local agent'));
  }
}

/**
 * Fail an uninstall, before it removes anything, while git cannot say whether
 * the repository tracks a copy on disk: the removal would keep the copy but
 * drop what proves it teamai's. The entry, its cache and records stay for the retry.
 */
async function failOnUnjudgedCopies(dests: readonly string[]): Promise<void> {
  for (const dest of dests) {
    if (!await pathExists(dest) || await gitUntracked(dest, 'entry')) continue;
    const tracks = await gitTracks(dest, 'entry');
    if (tracks.kind === 'unknown') throw new Error(`kept ${dest}: git could not say whether this repository tracks it (${tracks.error})`);
  }
}

async function uninstallResource(input: {
  config: LocalAgentConfig;
  kind: CommandResourceKind;
  slug: string;
  scope: LocalAgentScope;
  workspacePath?: string;
  tool?: string;
}): Promise<void> {
  const repoPath = await getResourceRepoPath(input.scope, input.workspacePath);
  const fullTeamConfig = await localAgentTeamConfig(input.config.endpoint, input.scope, input.workspacePath, `uninstall ${input.slug}`);
  if (input.tool && !fullTeamConfig.toolPaths[input.tool]) {
    throw new Error(`Unknown tool "${input.tool}": no toolPaths entry found`);
  }
  const localConfig = await createResourceLocalConfig(input.config, input.scope, repoPath, input.workspacePath);
  const manifest = await loadManifest();
  const scopeManifest = getManifestScope(manifest, input.scope, input.workspacePath);
  // The entry and its cached source go, and with them each copy the entry
  // records (#915): for the tools it names, or, for an older CLI's entry,
  // every tool. A copy goes only while it is what the agent writes today from
  // the cached source, judged before the source is deleted; a skill file by
  // file. Without an entry no copy is the agent's.
  // A claudemd entry's block is synced again for every tool it reached, or, for an older CLI's entry, the command's.
  const entry = scopeManifest[manifestKind(input.kind)][input.slug];
  const tools = input.kind === 'claudemd' ? entry?.tools ?? [input.tool ?? 'workbuddy']
    : entry ? entry.tools ?? Object.keys(fullTeamConfig.toolPaths) : [];
  const teamConfig = {
    ...fullTeamConfig,
    toolPaths: Object.fromEntries(tools.flatMap((tool) => fullTeamConfig.toolPaths[tool] ? [[tool, fullTeamConfig.toolPaths[tool]]] : [])),
  };

  if (input.kind === 'skill') {
    // The directory was created under the SKILL.md name (recorded as dir_name);
    // remove by that name, falling back to the slug for older installs.
    const dirName = entry?.dir_name ?? input.slug;
    const sourcePath = path.join(repoPath, 'skills', dirName);
    const item: ResourceItem = { name: dirName, type: 'skills', sourcePath, relativePath: `skills/${dirName}` };
    const copies: Array<{ dest: string; files: { teamais: string[]; members: string[] } }> = [];
    for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
      for (const { dest } of await new SkillsHandler().deliveryTargets({ ...teamConfig, toolPaths: { [tool]: toolPath } }, localConfig, item)) {
        const files = await pathExists(dest) ? await localAgentCopyFiles('skill', dirName, tool, dest, input.config) : null;
        if (files) copies.push({ dest, files });
      }
    }
    // The cache goes last: a copy that cannot go fails the entry while the
    // cache still proves which of its files are teamai's, for the retry.
    await failOnUnjudgedCopies(copies.map(({ dest }) => dest));
    for (const { dest, files } of copies) await removeSkillCopy(dest, dirName, files);
    await remove(sourcePath);
  } else if (input.kind === 'rule') {
    const item: ResourceItem = { name: input.slug, type: 'rules', sourcePath: path.join(repoPath, 'rules', `${input.slug}.md`), relativePath: `rules/${input.slug}.md` };
    await failOnUnjudgedCopies((await new RulesHandler().deliveryTargets(teamConfig, localConfig, item)).map(({ dest }) => dest));
    // removeItem deletes the cached rule before its copies: one that cannot go
    // gets the cache back, which proves it teamai's on the retry.
    const cached = await readFileSafe(item.sourcePath);
    try {
      await new RulesHandler().removeItem(input.slug, teamConfig, localConfig);
    } catch (error) {
      if (cached !== null && !await pathExists(item.sourcePath)) await fse.outputFile(item.sourcePath, cached);
      throw error;
    }
  } else {
    const dest = path.join(repoPath, 'claudemd', `${input.slug}.md`);
    const previous = await readFileSafe(dest);
    await remove(dest);
    try {
      recordPromptReach(scopeManifest, await syncClaudemd(teamConfig, localConfig, repoPath, input.workspacePath, fullTeamConfig));
    } catch (error) {
      if (previous !== null) await fse.writeFile(dest, previous);
      throw error;
    }
  }

  delete scopeManifest[manifestKind(input.kind)][input.slug];
  await saveManifest(manifest);
}

/**
 * Add the tools a claudemd sync reached to every claudemd entry of the scope
 * (#915): the block it delivered compiles all of them.
 */
function recordPromptReach(scope: ManifestScope, reached: readonly string[]): void {
  for (const entry of Object.values(scope.claudemd ?? {})) {
    entry.tools = [...new Set([...entry.tools ?? [], ...reached])].sort();
  }
}

/**
 * Whether `workspacePath` is a live checkout (#915). A directory a removed
 * worktree left inside another checkout is not, though git places it there;
 * nor is a subdirectory the agent keyed by its cwd while git could not answer.
 */
async function isLiveWorkspace(workspacePath: string): Promise<boolean> {
  const commonDir = await gitCommonDir(workspacePath);
  return commonDir !== null && isLiveCheckout(workspacePath, commonDir);
}

/** The copies the manifest records in one project workspace, for each tool it names (#915). */
async function recordedProjectCopies(config: LocalAgentConfig, workspacePath: string, scope: ManifestScope): Promise<string[]> {
  const repoPath = await getResourceRepoPath('project', workspacePath);
  const fullTeamConfig = createLocalAgentTeamConfig(config.endpoint);
  const localConfig = await createResourceLocalConfig(config, 'project', repoPath, workspacePath);
  const copies: string[] = [];
  const collect = async (
    entries: Record<string, ManifestResource>,
    itemFor: (slug: string, entry: ManifestResource) => ResourceItem,
    handler: SkillsHandler | RulesHandler,
  ) => {
    for (const [slug, entry] of Object.entries(entries ?? {})) {
      const item = itemFor(slug, entry);
      for (const tool of entry.tools ?? []) {
        const toolPath = fullTeamConfig.toolPaths[tool];
        if (!toolPath) continue;
        for (const { dest } of await handler.deliveryTargets({ ...fullTeamConfig, toolPaths: { [tool]: toolPath } }, localConfig, item)) {
          // A skill is the files the agent installed from its cache, never the directory: a file the member adds there stays visible.
          const files = item.type === 'skills' ? await deliveredSkillFiles(item.sourcePath, dest, await blockingEntries(dest, item.sourcePath)) : [dest];
          for (const file of files) if (await pathExists(file)) copies.push(file);
        }
      }
    }
  };
  await collect(scope.skills, (slug, entry) => {
    const name = entry.dir_name ?? slug;
    return { name, type: 'skills', sourcePath: path.join(repoPath, 'skills', name), relativePath: `skills/${name}` };
  }, new SkillsHandler());
  await collect(scope.rules, (slug) => ({ name: slug, type: 'rules', sourcePath: path.join(repoPath, 'rules', `${slug}.md`), relativePath: `rules/${slug}.md` }),
    new RulesHandler());
  // The instruction file teamai owns of each tool the claudemd block reached, while it holds teamai's blocks, as pull lists its own.
  for (const tool of new Set(Object.values(scope.claudemd ?? {}).flatMap((entry) => entry.tools ?? []))) {
    const toolPath = fullTeamConfig.toolPaths[tool];
    const file = toolPath && await instructionTargetFile(tool, toolPath, 'project', true);
    if (!file) continue;
    const target = await instructionTargetAt(tool, path.resolve(resolveToolBaseDir(tool, localConfig), file), 'project', toolPath, true);
    if (target.owned && await holdsInstructionBlocks(target.path)) copies.push(target.path);
  }
  const gitignore = await workspaceCacheGitignore(workspacePath, repoPath);
  if (gitignore) copies.push(gitignore);
  const dataHome = getDataHome(localConfig);
  if (dataHome.startsWith(path.join(workspacePath, '.teamai') + path.sep) || dataHome === path.join(workspacePath, '.teamai')) {
    const projectManifest = managedMcpManifestPath(dataHome, workspacePath);
    const { resolvedMcpFilesPath } = await import('./mcp-resolved-files.js');
    for (const file of [path.join(dataHome, 'managed-local-mcp.json'), projectManifest,
      resolvedMcpFilesPath(localConfig)]) {
      if (file && await pathExists(file)) copies.push(file);
    }
  }
  return copies;
}

/**
 * Make the `local-agent` git exclude blocks list exactly the skills and rules
 * the manifest records in project workspaces that are live checkouts and keep
 * teamai's deliveries out of git (#915). Each copy's line goes to the exclude
 * file of the repository it lands in; a block no workspace needs any more goes.
 * Nobody may watch the run, so a failure is also kept until the next sync
 * succeeds, for the next interactive pull and `doctor`, and a path no line can
 * name is kept as a notice. `without` leaves those workspaces out (a project
 * `teamai uninstall` removes), so a file another workspace shares keeps only
 * that workspace's lines; `dryRun` writes and keeps nothing and says what each
 * exclude file would drop.
 */
async function syncLocalAgentGitExclude(
  config: LocalAgentConfig, options: { without?: readonly string[]; dryRun?: boolean; rerun?: string } = {},
): Promise<Array<{ excludeFile: string; dropped: string[] }>> {
  const { without = [], dryRun = false, rerun = 'The next session start tries again.' } = options;
  const notices = localAgentGitExcludeNotices();
  const failures: string[] = [];
  const changed: Array<{ excludeFile: string; dropped: string[] }> = [];
  try {
    const paths: string[] = [];
    const unknown: string[] = [];
    const scopes = (await loadManifest()).scopes;
    for (const [key, scope] of Object.entries(scopes)) {
      const { scope: kind, workspacePath } = parseScopeKey(key);
      if (kind !== 'project' || !workspacePath || without.includes(workspacePath) || !await isLiveWorkspace(workspacePath)) continue;
      const enabled = await gitExcludeEnabledFor(workspacePath);
      if (enabled === false) continue;
      const copies = await recordedProjectCopies(config, workspacePath, scope);
      if (enabled === true) {
        paths.push(...copies);
        continue;
      }
      unknown.push(...copies);
      failures.push(`${enabled.cause}, so it left the local agent's git exclude lines for ${workspacePath} as they were. `
        + `${enabled.fix}, then start a new session.`);
    }
    // A workspace whose flag is unknown keeps the lines it has: neither added nor dropped.
    // A path git cannot place is passed on too, so the sync only adds and drops no line.
    if (unknown.length > 0) {
      const current = await reportGitExclude(localAgentGitExcludeOwner(), unknown);
      paths.push(...current.files.flatMap((file) => file.listed), ...current.gitFailed.map((failed) => failed.path));
    }
    const result = await syncGitExclude(localAgentGitExcludeOwner(), paths, { dryRun });
    for (const { excludeFile, dropped } of result.files) if (dropped.length > 0) changed.push({ excludeFile, dropped });
    if (dryRun) return changed;
    for (const { excludeFile, write, reincluded } of result.files) {
      const why = write.kind === 'locked' ? 'another teamai command held it past the wait'
        : write.kind === 'notWritable' || write.kind === 'notReadable' ? write.message
        : write.kind === 'writeFailed' ? write.error
        : null;
      if (why !== null) failures.push(`Could not update the local agent's git exclude block in ${excludeFile}: ${why}. ${rerun}`);
      for (const { path: seen, rule } of reincluded) {
        failures.push(`git still sees ${seen}: ${rule ? `\`${rule.pattern}\` (${rule.source}:${rule.line}) re-includes it` : 'a rule in your git ignore files re-includes it'}. Remove that rule.`);
      }
    }
    for (const { message } of result.refused) {
      log.warn(message);
      await noticeGitExclude(notices, message, { silent: true });
    }
    for (const { path: failed, error } of result.gitFailed) {
      failures.push(`Could not keep ${failed} out of git: git could not place it (${error}). ${rerun}`);
    }
  } catch (e) {
    failures.push(`Could not update the local agent's git exclude blocks: ${(e as Error).message}. ${rerun}`);
  }
  if (dryRun) return changed;
  for (const failure of failures) log.warn(failure);
  if (failures.length > 0) await recordGitExcludeFailure(notices, failures.join(' '));
  else await clearGitExcludeFailure(notices);
  return changed;
}

/**
 * For a project `teamai uninstall` that leaves the local agent in place:
 * rebuild its `local-agent` blocks from its records without `workspaces`, so
 * other workspaces keep their lines, in a shared exclude file too (#915).
 * `null` when no local agent is set up on this machine. `dryRun` says what
 * each exclude file would drop.
 */
export async function rebuildLocalAgentGitExcludeWithout(
  workspaces: readonly string[], options: { dryRun?: boolean } = {},
): Promise<Array<{ excludeFile: string; dropped: string[] }> | null> {
  const config = await loadLocalAgentConfig({ dryRun: true });
  if (!config) return null;
  return syncLocalAgentGitExclude(config, { ...options, without: workspaces, rerun: 'The next session start tries again.' });
}

/**
 * What the `local-agent` blocks are built from, short of asking git (#915):
 * the manifest's project entries, and every config a workspace's flag can be
 * read from (each project partition's and the user scope's).
 */
async function localAgentGitExcludeInput(): Promise<string> {
  const { projectsRootDir } = await import('./utils/partition.js');
  const projects = (await loadManifest()).scopes;
  const entries = Object.keys(projects).filter((key) => parseScopeKey(key).scope === 'project').sort()
    .map((key) => [key, projects[key].skills, projects[key].rules, projects[key].claudemd]);
  const configs = [path.join(getTeamaiHomePath(), 'config.yaml'),
    ...(await listDirs(projectsRootDir())).sort().map((dir) => path.join(projectsRootDir(), dir, 'config.yaml'))];
  const parts = [JSON.stringify(entries)];
  for (const file of configs) parts.push(file, (await readFileSafe(file)) ?? '');
  return contentHash(parts.join('\0'));
}

/**
 * Bring the `local-agent` blocks in step with the manifest and each
 * workspace's flag (#915). `force` (a session start, or a batch that installed
 * or removed a project skill or rule) always syncs; any other run syncs only
 * when the input changed since the last sync, so it costs no git call.
 */
async function keepLocalAgentGitExclude(config: LocalAgentConfig, force: boolean): Promise<void> {
  // An uninstall_teamai in this run removed the agent: nothing to keep, and nothing to recreate.
  if (!await pathExists(getConfigPath())) return;
  const synced = path.join(getLocalAgentHome(), 'git-exclude-synced.json');
  const input = await localAgentGitExcludeInput().catch((e: unknown) => {
    log.persist(`git exclude: could not read the local agent's git exclude input: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (!force && input !== null && (await readJson<Record<string, string>>(synced))?.['local-agent'] === input) return;
  await syncLocalAgentGitExclude(config);
  if (input === null) return;
  await writeJson(synced, { 'local-agent': input }).catch((e: unknown) => {
    log.persist(`git exclude: could not write ${synced}: ${e instanceof Error ? e.message : String(e)}`);
  });
}

/**
 * Remove the `local-agent` block from every exclude file the state home
 * records, naming any it cannot write (#915). A line stays while a file it
 * names is still on disk untracked (a copy the teardown kept) in a checkout reading that
 * exclude file, among `roots` and those git lists for its repository, or when
 * none of them does; the record then keeps that exclude file.
 */
async function removeLocalAgentGitExclude(roots: string[]): Promise<string[]> {
  const left: string[] = [];
  try {
    const checkouts = new Set(roots);
    for (const file of await localAgentGitExcludeOwner().record?.files() ?? []) {
      // `<common dir>/info/exclude`: git lists the checkouts from the common directory.
      for (const root of await listWorktrees(path.dirname(path.dirname(file)))) checkouts.add(root);
    }
    const keep = async ({ line, excludeFile }: { line: string; excludeFile: string }): Promise<boolean> => {
      const left = await modelFilesBehind(line, excludeFile, { roots: [...checkouts] });
      if (left === null) return true;
      // A file the repository tracks is not hidden by its line.
      for (const file of left) if ((await gitTracks(file, 'entry')).kind !== 'tracked') return true;
      return false;
    };
    for (const { excludeFile, write, removed } of await removeGitExclude(localAgentGitExcludeOwner(), { keep })) {
      const why = write.kind === 'locked' ? 'another teamai command held it past the wait'
        : write.kind === 'notWritable' || write.kind === 'notReadable' ? write.message
        : write.kind === 'writeFailed' ? write.error
        : null;
      const lines = removed.flatMap((block) => block.lines);
      if (why !== null) {
        left.push(excludeFile);
        log.warn(`Kept the local agent's git exclude block in ${excludeFile}: ${why}. Delete it yourself, from \`# [teamai:local-agent:start]\` `
          + `to \`# [teamai:local-agent:end]\`${lines.length > 0 ? ` (${lines.join(', ')})` : ''}.`);
      }
    }
  } catch (e) {
    left.push(path.join(getLocalAgentHome(), 'git-exclude.json'));
    log.warn(`Could not remove the local agent's git exclude blocks: ${(e as Error).message}`);
  }
  return left;
}

/** The claudemd fragments in an HTTP resource cache, compiled into one block. */
async function cachedClaudemdBlock(repoPath: string): Promise<{ files: string[]; block: string | null }> {
  const claudemdDir = path.join(repoPath, 'claudemd');
  const files = (await pathExists(claudemdDir))
    ? (await fse.readdir(claudemdDir)).filter((file) => file.endsWith('.md')).sort()
    : [];
  const contents: string[] = [];
  for (const file of files) {
    const content = await readFileSafe(path.join(claudemdDir, file));
    if (content) contents.push(content);
  }
  return { files, block: compileClaudemdBlock(contents) };
}

/**
 * The HTTP agent's claudemd instructions for the project at `cwd`, as text a
 * session hook adds (#945): Pi, OMP and Hermes have no project file of their
 * own. Empty outside a project the agent delivered to.
 */
export async function localAgentInstructionText(cwd: string, tool = ''): Promise<string> {
  const workspacePath = await resolveWorkspacePath(cwd);
  if (!workspacePath) return '';
  const native = await nativeProjectInstructions(tool, workspacePath);
  if (native.includes(TEAMAI_CLAUDEMD_START) || native.includes(TEAMAI_CLAUDEMD_END)) return '';
  const { block } = await cachedClaudemdBlock(await getResourceRepoPath('project', workspacePath));
  return block ? instructionHookText({ claudemd: block }, false) : '';
}

/**
 * Deliver the HTTP agent's claudemd block to `teamConfig`'s tools, and
 * strip the blocks earlier releases left in files no installed tool of
 * `fullTeamConfig` reads now, as pull does (#945). Returns the tools whose
 * target holds the block now (#915).
 */
async function syncClaudemd(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  repoPath: string,
  workspacePath: string | undefined,
  fullTeamConfig: TeamaiConfig,
): Promise<string[]> {
  const { files, block } = await cachedClaudemdBlock(repoPath);
  let syncedAny = false;
  // Why each tool got nothing, for the ACK when none did.
  const skipped: string[] = [];
  const reached: string[] = [];
  // The targets resolveInstructionTargets checks below (#915: Copilot's moves with the flag).
  const gitExclude = isGitExcludeEnabled(localConfig, fullTeamConfig);

  for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
    // Pi, OMP and Hermes in a project take the cache from their extension or
    // plugin through `hook-dispatch instructions` (localAgentInstructionText).
    if (deliversInstructionsByHook(tool, localConfig.scope)) {
      const problem = await hookDeliveryProblem(teamConfig, localConfig, tool, block);
      if (problem) {
        log.debug(`local-agent: skipped CLAUDE.md sync for ${tool}: ${problem}`);
        skipped.push(problem);
        continue;
      }
      log.debug(`local-agent: ${tool} adds the CLAUDE.md instructions through its extension`);
      syncedAny = true;
      reached.push(tool);
      continue;
    }
    const targetFile = await instructionTargetFile(tool, toolPath, localConfig.scope, gitExclude)
      // A server-sent workspace can exist where OpenClaw's own lookup finds none.
      ?? (tool === 'openclaw' && localConfig.scope !== 'project' && workspacePath ? toolPath.claudemd : undefined);
    if (!targetFile) continue;

    let baseDir = resolveToolBaseDir(tool, localConfig);
    let resolvedAbsPath: string | null = null;

    if (tool === 'openclaw' && localConfig.scope !== 'project') {
      const openclawWs = await resolveOpenclawWorkspaceDir(workspacePath);
      if (openclawWs) {
        resolvedAbsPath = path.join(openclawWs, path.basename(targetFile));
      }
    }

    // Probed through the tool's own paths, as pull does: WorkBuddy's project
    // target sits under .codebuddy, which says nothing about WorkBuddy.
    const toolInstalled = resolvedAbsPath
      ? await pathExists(path.dirname(resolvedAbsPath))
      : await isInstructionToolInstalled(tool, toolPath, localConfig);
    if (!toolInstalled) {
      log.debug(`Skipped CLAUDE.md sync for ${tool}: target not found`);
      continue;
    }

    const claudeMdPath = resolvedAbsPath ?? path.resolve(baseDir, targetFile);
    // OpenCode V1's Claude fallback already carries the blocks, as in pull
    // (#945), so OpenCode's file is written for V2's plugin but not listed.
    const claudeUserFile = path.join(getUserHome(), '.claude', 'CLAUDE.md');
    const viaClaude = tool === 'opencode' && localConfig.scope === 'user'
      && (await readFileSafe(claudeUserFile))?.includes(TEAMAI_CLAUDEMD_START) === true
      && await opencodeClaudeFallback(getUserHome(), [claudeUserFile]) !== null;
    const target = await instructionTargetAt(tool, claudeMdPath, localConfig.scope, toolPath, gitExclude);
    const plan = await planInstructionFiles([target], { claudemd: block });
    // A warning means the file was left as it was: nothing reached the tool.
    if (plan.warnings.length > 0) {
      for (const warning of plan.warnings) log.warn(warning);
      skipped.push(...plan.warnings);
      continue;
    }
    const { failures, files } = await applyInstructionPlan(plan, { dryRun: false });
    if (failures.length > 0) {
      log.warn(`Failed to sync CLAUDE.md instructions to ${tool}: ${failures.join(' ')}`);
      skipped.push(...failures);
      continue;
    }
    if (tool === 'opencode') {
      await registerOpencodeContext(teamConfig, localConfig, { targets: [target], stale: [], opencodeFallback: viaClaude ? claudeUserFile : null }, false, files);
      // OpenCode V1 reads the file only through its `instructions` entry.
      if (block && !viaClaude) {
        const { opencodeContextReference, readOpencodeInstructionList } = await import('./resources/opencode-config.js');
        const { config, entry } = opencodeContextReference(claudeMdPath, localConfig.scope, baseDir);
        if (!(await readOpencodeInstructionList(config))?.includes(entry)) {
          const problem = `OpenCode does not load ${claudeMdPath}: teamai could not add "${entry}" to the instructions of ${config} `
            + '(the file is missing, unreadable or not plain JSON). Add the entry by hand, or run `teamai doctor`.';
          log.warn(problem);
          skipped.push(problem);
          continue;
        }
      }
    }
    log.debug(`local-agent: ${block ? 'synced' : 'removed'} CLAUDE.md instructions for ${tool}`);
    syncedAny = true;
    reached.push(tool);
  }

  // Commands deliver to one tool at a time, but earlier commands may already
  // have reached the other writers. Verify current destinations rather than
  // forgetting those deliveries or trusting a receipt for an older prompt.
  const resolved = await resolveInstructionTargets(fullTeamConfig, localConfig);
  for (const hook of resolved.hooks) {
    if (!reached.includes(hook.tool) && !await hookDeliveryProblem(fullTeamConfig, localConfig, hook.tool, block)) {
      reached.push(hook.tool);
    }
  }
  for (const target of resolved.targets) {
    if (target.tools.every((tool) => reached.includes(tool))) continue;
    // A failed write in this command cannot become a previous delivery.
    if (target.tools.some((tool) => teamConfig.toolPaths[tool] && !reached.includes(tool))) continue;
    try {
      await readFileIfExists(target.path);
    } catch (error) {
      log.debug(`local-agent: retained retired instructions because ${target.path} could not be verified: ${(error as Error).message}`);
      continue;
    }
    const verification = await planInstructionFiles([target], { claudemd: block });
    if (verification.files[0]?.status !== 'current') continue;
    for (const tool of target.tools) {
      if (tool === 'opencode' && block && !resolved.opencodeFallback) {
        const { opencodeContextReference, readOpencodeInstructionList } = await import('./resources/opencode-config.js');
        const { config, entry } = opencodeContextReference(target.path, localConfig.scope, resolveToolBaseDir(tool, localConfig));
        if (!(await readOpencodeInstructionList(config))?.includes(entry)) continue;
      }
      reached.push(tool);
    }
  }
  const cleanup = await planInstructionFiles([], {}, await retiredFilesOfReached(fullTeamConfig, localConfig, reached), { claudemd: block });
  for (const warning of cleanup.warnings) log.warn(warning);
  const { report, failures } = await applyInstructionPlan(cleanup, { dryRun: false });
  for (const line of report) log.info(`${line}: no installed tool loads them from this file`);
  for (const failure of failures) log.warn(failure);

  if (cleanup.warnings.length > 0 || failures.length > 0) {
    throw new Error(['CLAUDE.md sync could not remove the retired instructions. Repair the files and retry.',
      ...cleanup.warnings, ...failures].join(' '));
  }

  // Removing the last prompt fails too when a target kept it.
  if (!syncedAny && (files.length > 0 || skipped.length > 0)) {
    throw new Error(['CLAUDE.md sync landed on no tool: every configured target was skipped.', ...skipped].join(' '));
  }
  return reached;
}

/**
 * Why a hook tool cannot add the HTTP agent's instructions in this scope, or
 * null when it can: not installed, its extension or plugin not ready, or the
 * text over its prompt section's limit. The text counts the team's blocks the
 * same hook adds for this project, when a team repo governs it.
 */
async function hookDeliveryProblem(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  tool: string,
  block: string | null,
): Promise<string | null> {
  const hook = (await resolveInstructionTargets(teamConfig, localConfig)).hooks.find((entry) => entry.tool === tool);
  if (!hook) return `${tool} is not installed here.`;
  const channel = await instructionHookChannel(tool, { teamConfig, localConfig });
  if (!channel.ready) return channel.fix;
  if (hook.limit === undefined) return null;
  const parts = [block ? instructionHookText({ claudemd: block }, false) : ''];
  const { loadTeamConfig, resolveConfigForDir } = await import('./config.js');
  const memberConfig = localConfig.projectRoot ? await resolveConfigForDir(localConfig.projectRoot) : null;
  const memberTeam = memberConfig ? await loadTeamConfig(memberConfig.repo.localPath) : null;
  if (memberConfig && memberTeam) parts.unshift(await instructionHookTextFor(memberTeam, memberConfig, tool));
  const length = parts.filter(Boolean).join('\n\n').length;
  return length > hook.limit
    ? `${tool} cannot load this project's instructions: with the HTTP prompts they are ${length} characters, over the `
      + `${hook.limit}-character limit of its prompt section, so ${tool} skips them. Shorten the prompts for this project.`
    : null;
}

async function ackCommand(
  config: LocalAgentConfig,
  tag: string,
  command: LocalAgentCommand,
  status: 'success' | 'failed',
  version?: string,
  error?: string,
): Promise<void> {
  await localAgentFetch(config, tag, 'ack', {
    method: 'POST',
    body: JSON.stringify({
      id: command.id,
      type: command.type ?? '',
      status,
      error: error ?? '',
      version,
    }),
  });
}

function requireModelString(
  value: unknown,
  field: keyof Pick<DeliveredModel, 'provider' | 'model_id' | 'name' | 'base_url' | 'api_key'>,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`apply_model_config: ${field} must be a non-empty string`);
  }
  return value.trim();
}

/** CodeBuddy maxOutputTokens when the backend omits max_tokens or sends 0 (Go zero value). */
const DEFAULT_MAX_TOKENS = 4096;

function optionalPositiveInteger(value: unknown, field: 'max_tokens' | 'context_window'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new Error(`apply_model_config: ${field} must be a positive integer`);
  }
  // 0 is the Go zero value for an unset int, not a real output/context cap.
  if ((normalized as number) === 0) return undefined;
  return normalized as number;
}

function parseDeliveredModels(raw: string | undefined): { models: DeliveredModel[]; fullSnapshot: boolean } {
  if (!raw) throw new Error('apply_model_config: missing cmd');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('apply_model_config: cmd must be valid JSON');
  }
  const fullSnapshot = (
    typeof parsed === 'object' &&
    parsed !== null &&
    'models' in parsed
  );
  const values = fullSnapshot ? (parsed as { models?: unknown }).models : [parsed];
  if (!Array.isArray(values)) {
    throw new Error('apply_model_config: models must be an array');
  }

  const seen = new Set<string>();
  const models = values.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('apply_model_config: each model must be an object');
    }
    const input = value as Record<string, unknown>;
    const modelId = requireModelString(input.model_id, 'model_id');
    if (modelId === '__proto__' || modelId === 'prototype' || modelId === 'constructor') {
      throw new Error(`apply_model_config: reserved model_id "${modelId}"`);
    }
    const model: DeliveredModel = {
      provider: requireModelString(input.provider, 'provider'),
      model_id: modelId,
      name: requireModelString(input.name, 'name'),
      base_url: requireModelString(input.base_url, 'base_url'),
      api_key: requireModelString(input.api_key, 'api_key'),
      max_tokens: optionalPositiveInteger(input.max_tokens, 'max_tokens') ?? DEFAULT_MAX_TOKENS,
      context_window: optionalPositiveInteger(input.context_window, 'context_window'),
    };
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(model.base_url);
    } catch {
      throw new Error('apply_model_config: base_url must be a valid URL');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('apply_model_config: base_url must use http or https');
    }
    if (seen.has(model.model_id)) {
      throw new Error(`apply_model_config: duplicate model_id "${model.model_id}"`);
    }
    seen.add(model.model_id);
    return model;
  });
  return { models, fullSnapshot };
}

function buddyModelEntry(model: DeliveredModel): Record<string, unknown> {
  const baseUrl = model.base_url.replace(/\/+$/, '');
  return {
    id: model.model_id,
    name: model.name,
    vendor: model.provider,
    apiKey: model.api_key,
    ...(model.context_window === undefined ? {} : { maxInputTokens: model.context_window }),
    ...(model.max_tokens === undefined ? {} : { maxOutputTokens: model.max_tokens }),
    url: baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`,
    supportsToolCall: true,
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const source = await readFileSafe(filePath);
  if (source === null) return {};
  try {
    const parsed = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('root must be an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `apply_model_config: cannot parse ${modelConfigDisplayPath(filePath)}: ${(error as Error).message}`,
    );
  }
}

/** Atomically update a model dotfile without replacing a user-managed symlink. */
async function writeModelJson(filePath: string, data: unknown): Promise<void> {
  let targetPath = filePath;
  try {
    if ((await fs.promises.lstat(filePath)).isSymbolicLink()) {
      targetPath = await fs.promises.realpath(filePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Set the temp file's mode before the atomic rename. A post-rename chmod
  // would introduce a symlink-following TOCTOU window.
  await writeJsonAtomic(targetPath, data, { mode: 0o600 });
}

// ─── Model API keys out of git (#915) ─────────────────────────

/** The `credentials` git exclude owner: model API keys written into a project, kept out of git whatever the flag. */
function credentialsGitExcludeOwner(): GitExcludeOwner {
  return { name: 'credentials', record: stateHomeRecord(getLocalAgentHome(), 'credentials') };
}

const MODEL_KEY_RERUN = 'apply the model config again';

/**
 * List `file` in the `credentials` block before a model API key goes into it.
 * Only git confirming that it ignores the file, or the file being in no git
 * repository, lets the key through; anything else throws why git could still
 * commit it and how to fix that, so the key is not written.
 */
async function keepModelKeyOutOfGit(file: string): Promise<void> {
  const [{ result }] = await ensureGitExclude(credentialsGitExcludeOwner(), [file], { rerun: MODEL_KEY_RERUN });
  // Excluded, or outside any repository, where nothing could commit it.
  if (!('reason' in result)) return;
  throw new Error(`apply_model_config: withheld the model API key from ${file}: teamai could not keep the file out of git: ${result.reason}. `
    + `The file is left as it was. ${result.fix}`);
}

const TEAMAI_MODEL_GITIGNORE = ['# Local model credentials', 'models.json'];

/**
 * Delete the `.codebuddy/.gitignore` an older teamai created for `models.json`,
 * while it holds only those two lines and git says it does not track it. One the
 * member or the team edited, or committed, stays, and so does one git cannot judge.
 */
async function removeTeamaiModelGitignore(workspacePath: string): Promise<void> {
  const file = path.join(workspacePath, '.codebuddy', '.gitignore');
  const content = await readFileSafe(file);
  if (content === null) return;
  const lines = content.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (lines.length !== TEAMAI_MODEL_GITIGNORE.length || lines.some((line, i) => line !== TEAMAI_MODEL_GITIGNORE[i])) return;
  if (!await gitUntracked(file)) return;
  await remove(file);
}

/** Whether a reconciled models document holds nothing: no model, and no other setting of the member's. */
function holdsNoModels(document: unknown): boolean {
  if (Array.isArray(document)) return document.length === 0;
  return Object.entries(document as Record<string, unknown>).every(([key, value]) =>
    (key === 'models' || key === 'availableModels') && Array.isArray(value) && value.length === 0);
}

/** Whether a models file may hold an API key: it exists and is not proven to hold none. */
async function mayHoldModelKey(file: string): Promise<boolean> {
  let content: string | null;
  try {
    content = await readFileSafe(file);
  } catch {
    return true;
  }
  if (content === null) return false;
  try {
    const parsed: unknown = JSON.parse(content);
    const entries = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown } | null)?.models;
    if (entries === undefined && typeof parsed === 'object' && parsed !== null) return false;
    if (!Array.isArray(entries)) return true;
    return entries.some((entry) => typeof entry !== 'object' || entry === null
      || ((entry as { apiKey?: unknown }).apiKey !== undefined && (entry as { apiKey?: unknown }).apiKey !== ''));
  } catch {
    return true;
  }
}

/**
 * The checkouts the local agent knows: every workspace it was bound to,
 * installed skills or rules in, or wrote models into, and the other checkouts
 * of each one's repository when git names them all. Read it before a teardown
 * deletes those records.
 */
export async function localAgentCheckouts(): Promise<string[]> {
  const config = await loadLocalAgentConfig().catch(() => null);
  const manifest = (await readJson<ModelConfigManifest>(getModelManifestPath()).catch(() => null)) ?? {};
  const installed = Object.keys((await loadManifest().catch(() => null))?.scopes ?? {}).flatMap((key) => parseScopeKey(key).workspacePath ?? []);
  const workspaces = new Set([...Object.keys(config?.workspaceBindings ?? {}), ...Object.keys(manifest.workspaceModels ?? {}), ...installed]);
  const roots = new Set(workspaces);
  for (const workspace of workspaces) {
    const commonDir = await gitCommonDir(workspace);
    for (const root of commonDir ? await completeWorktreeList(workspace, commonDir) ?? [] : []) roots.add(root);
  }
  return [...roots];
}

/**
 * The files a line of `excludeFile` (a `credentials` line: model files) still keeps out of
 * git: in each checkout that reads that exclude file, among `roots` and the
 * ones the local agent knows, the file the line names when it is there
 * (`withKey`: when it may hold a key). Null when none of those checkouts reads
 * that exclude file, so nothing here can judge the line.
 */
export async function modelFilesBehind(
  line: string,
  excludeFile: string,
  options: { roots?: string[]; withKey?: boolean } = {},
): Promise<string[] | null> {
  const { mcpExcludePatternPath } = await import('./mcp-git-exclude.js');
  const rel = mcpExcludePatternPath(line);
  let judged = false;
  const files = new Set<string>();
  for (const root of new Set([...options.roots ?? [], ...await localAgentCheckouts()])) {
    const placed = await gitExcludeFile(root);
    if (placed?.excludeFile !== excludeFile) continue;
    judged = true;
    const file = path.join(placed.root, rel);
    const there = options.withKey
      ? await mayHoldModelKey(file)
      : await fs.promises.lstat(file).then(() => true, () => false);
    if (there) files.add(file);
  }
  return judged ? [...files] : null;
}

/**
 * Remove the `credentials` lines whose models file is gone from every checkout
 * that reads their exclude file. Run once a models file was deleted. The
 * exclude files it could not update.
 */
async function releaseModelKeyLines(): Promise<string[]> {
  const left: string[] = [];
  try {
    // The checkouts reading each recorded exclude file, for a retry that no longer has the workspaces' records.
    const roots: string[] = [];
    for (const file of await credentialsGitExcludeOwner().record?.files() ?? []) roots.push(...await listWorktrees(path.dirname(path.dirname(file))));
    const results = await removeGitExclude(credentialsGitExcludeOwner(), {
      keep: async ({ line, excludeFile }) => (await modelFilesBehind(line, excludeFile, { roots }))?.length !== 0,
    });
    for (const { excludeFile, write, removed } of results) {
      const why = write.kind === 'locked' ? 'another teamai command held it past the wait'
        : write.kind === 'notWritable' || write.kind === 'notReadable' ? write.message
        : write.kind === 'writeFailed' ? write.error
        : null;
      const lines = removed.flatMap((block) => block.lines);
      if (why !== null && lines.length > 0) {
        left.push(excludeFile);
        log.warn(`Kept ${lines.join(', ')} in ${excludeFile}: ${why}. Delete it yourself, with the block's \`# [teamai:credentials:start]\` `
          + 'and `# [teamai:credentials:end]` lines once it holds no other line.');
      }
    }
  } catch (e) {
    left.push(path.join(getLocalAgentHome(), 'git-exclude.json'));
    log.warn(`Could not remove the git exclude lines of deleted model files: ${(e as Error).message}`);
  }
  return left;
}

/**
 * Local-agent removal: take teamai's models out of every project's models
 * file. A file left with nothing goes, and then its git exclude line. The
 * models files it could not clean, whose record the teardown then keeps.
 */
async function removeWorkspaceModels(): Promise<string[]> {
  let manifest: ModelConfigManifest;
  try {
    const raw = await readFileIfExists(getModelManifestPath());
    manifest = raw === null ? {} : JSON.parse(raw) as ModelConfigManifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('not a JSON object');
  } catch (e) {
    // Without it nothing says which models are teamai's: none is taken out, and it stays.
    log.warn(`Could not read teamai's model record ${getModelManifestPath()}: ${(e as Error).message}. `
      + 'No project models file was changed.');
    return [getModelManifestPath()];
  }
  const left: string[] = [];
  for (const [workspacePath, scopeManifest] of Object.entries(manifest.workspaceModels ?? {})) {
    for (const agentKind of ['codebuddy', 'workbuddy'] as const) {
      if (scopeManifest[agentKind] === undefined) continue;
      try {
        await reconcileBuddyModels([], true, scopeManifest, agentKind, workspacePath);
      } catch (e) {
        left.push(buddyModelsPath(agentKind, workspacePath));
        log.warn(`Could not remove teamai's models from ${buddyModelsPath(agentKind, workspacePath)}: ${(e as Error).message}`);
      }
    }
  }
  return left;
}

async function readBuddyModelEntries(
  filePath: string,
): Promise<{ existing: unknown[]; doc?: Record<string, unknown> }> {
  const source = await readFileSafe(filePath);
  // The current WorkBuddy / CodeBuddy documentation uses an object wrapper.
  // Product releases also accept the legacy top-level array, so preserve that
  // shape when a user already has one instead of forcing a migration.
  if (source === null) return { existing: [], doc: {} };
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return { existing: parsed };
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('root must be an object or array');
    }
    const doc = parsed as Record<string, unknown>;
    const existing = doc.models === undefined ? [] : doc.models;
    if (!Array.isArray(existing)) {
      throw new Error('models must be an array');
    }
    return { existing, doc };
  } catch (error) {
    throw new Error(
      `apply_model_config: cannot parse ${modelConfigDisplayPath(filePath)}: ${(error as Error).message}`,
    );
  }
}

async function reconcileBuddyModels(
  models: DeliveredModel[],
  fullSnapshot: boolean,
  scopeManifest: BuddyModelManifest,
  agentKind: BuddyAgentKind,
  workspacePath?: string,
): Promise<void> {
  const targetFile = buddyModelsPath(agentKind, workspacePath);
  const { existing, doc } = await readBuddyModelEntries(targetFile);
  const previouslyManaged = (agentKind === 'codebuddy'
    ? scopeManifest.codebuddy
    : scopeManifest.workbuddy) ?? {};
  const nextManaged: Record<string, string> = fullSnapshot ? {} : { ...previouslyManaged };
  const incomingIds = new Set(models.map((model) => model.model_id));
  const removedManaged = new Set<string>();
  const preserved: unknown[] = [];
  const occupiedIds = new Set<string>();
  for (const entry of existing) {
    const id = typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string'
      ? (entry as { id: string }).id
      : undefined;
    if (id && previouslyManaged[id] && entryHash(entry) === previouslyManaged[id]) {
      if (fullSnapshot || incomingIds.has(id)) {
        removedManaged.add(id);
        continue;
      }
      preserved.push(entry);
      occupiedIds.add(id);
      continue;
    }
    preserved.push(entry);
    if (id) occupiedIds.add(id);
    if (id && previouslyManaged[id]) delete nextManaged[id];
  }

  for (const model of models) {
    if (occupiedIds.has(model.model_id)) continue;
    const entry = buddyModelEntry(model);
    preserved.push(entry);
    nextManaged[model.model_id] = entryHash(entry);
  }

  if (doc) {
    doc.models = preserved;
    if (Array.isArray(doc.availableModels) && doc.availableModels.length > 0) {
      const available = doc.availableModels.filter(
        (id): id is string => typeof id === 'string' && !removedManaged.has(id),
      );
      for (const id of Object.keys(nextManaged)) {
        if (!available.includes(id)) available.push(id);
      }
      doc.availableModels = available;
    }
  }
  const document = doc ?? preserved;
  const present = await fs.promises.lstat(targetFile).catch(() => null);
  if (workspacePath && Object.keys(nextManaged).length === 0 && holdsNoModels(document)) {
    if (!present || (scopeManifest.createdModelsFile && !present.isSymbolicLink() && await gitUntracked(targetFile))) {
      // Nothing left in a file teamai created, or no file: it goes, then its git exclude line.
      await remove(targetFile);
      delete scopeManifest.createdModelsFile;
      await removeTeamaiModelGitignore(workspacePath);
      await releaseModelKeyLines();
    } else {
      // A file teamai did not create, one git tracks, or a member's link stays, and so does its line.
      await writeModelJson(targetFile, document);
    }
  } else {
    if (workspacePath && Object.keys(nextManaged).length > 0) await keepModelKeyOutOfGit(targetFile);
    await writeModelJson(targetFile, document);
    if (workspacePath && !present) scopeManifest.createdModelsFile = true;
    if (workspacePath && Object.keys(nextManaged).length > 0) await removeTeamaiModelGitignore(workspacePath);
  }
  if (agentKind === 'codebuddy') scopeManifest.codebuddy = nextManaged;
  else scopeManifest.workbuddy = nextManaged;
}

function claudeEnvForModel(model: DeliveredModel): Record<string, string> {
  const baseUrl = model.base_url.replace(/\/+$/, '').replace(/\/v1$/, '');
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: model.api_key,
    ANTHROPIC_CUSTOM_MODEL_OPTION: model.model_id,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: model.name,
  };
}

/**
 * Drop the gateway env and model profile the agent delivered into `claudeRoot`,
 * and forget them in the manifest. For `teamai init` moving the Claude root:
 * the credentials would otherwise stay in a profile nothing syncs any more.
 * No-op when the agent never delivered a model.
 */
export async function releaseClaudeModelConfig(claudeRoot: string): Promise<void> {
  const manifest = (await readJson<ModelConfigManifest>(getModelManifestPath())) ?? {};
  if (Object.keys(manifest.claudeEnv ?? {}).length === 0) return;
  await reconcileClaudeModels([], manifest, claudeRoot);
  await writeJsonAtomic(getModelManifestPath(), manifest);
  log.info(`Removed the delivered Claude model config from ${claudeRoot}`);
}

async function reconcileClaudeModels(
  models: DeliveredModel[],
  manifest: ModelConfigManifest,
  claudeRoot?: string,
): Promise<void> {
  claudeRoot ??= await claudeUserRoot();
  const settingsPath = path.join(claudeRoot, 'settings.json');
  const profilePath = path.join(claudeRoot, 'teamai-models.json');
  const previousHashes = manifest.claudeEnv ?? {};
  const settings = await readJsonObject(settingsPath);
  const rawEnv = settings.env === undefined ? {} : settings.env;
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new Error(`apply_model_config: env must be an object in ${settingsPath}`);
  }
  const env = { ...(rawEnv as Record<string, unknown>) };

  if (models.length === 0) {
    const canRemoveGateway = Object.entries(previousHashes).every(
      ([key, hash]) => entryHash(env[key]) === hash,
    );
    if (canRemoveGateway && Object.keys(previousHashes).length > 0) {
      for (const key of Object.keys(previousHashes)) delete env[key];
      settings.env = env;
      await writeModelJson(settingsPath, settings);
    }
    await remove(profilePath);
    manifest.claudeEnv = {};
    return;
  }

  // Claude supports one active custom gateway in settings. The first model
  // seeds that gateway; other candidates remain discoverable from its
  // /v1/models endpoint when the gateway implements model discovery.
  const desired = claudeEnvForModel(models[0]);
  await writeModelJson(profilePath, { env: desired });

  // Any of these keys, if the user already set them, means they have their own
  // Claude gateway/model config we must not silently take over. Beyond the keys
  // we write, this also covers auth the gateway swap would break
  // (ANTHROPIC_API_KEY, ANTHROPIC_CUSTOM_HEADERS) and the user's model choice
  // (ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL).
  const conflictKeys = new Set([
    ...Object.keys(desired),
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]);
  // A value is TeamAI-managed if it matches what we recorded last time or the
  // value currently in settings.json (settings.json is our own output, so a
  // process.env var equal to it is Claude re-injecting settings.json.env into
  // the hook, not a user's independent shell config).
  const isManagedValue = (key: string, value: unknown): boolean => (
    (previousHashes[key] !== undefined && entryHash(value) === previousHashes[key]) ||
    (env[key] !== undefined && entryHash(value) === entryHash(env[key]))
  );
  // The guard must see config the user set outside settings.json too. Users who
  // run Claude via shell `export ANTHROPIC_*` keep no gateway in settings.json,
  // so a settings-only check reads env[key] === undefined and wrongly seizes the
  // slot — settings.json then outranks the shell env and breaks their setup.
  // But Claude injects settings.json.env into the hook's own environment, so we
  // must NOT treat our own re-injected managed values as a user conflict — doing
  // so would block every follow-up sync and strand the user on stale config.
  const userOwnsInShell = (key: string): boolean => {
    const value = process.env[key];
    if (typeof value !== 'string' || value.trim() === '') return false;
    return !isManagedValue(key, value);
  };
  const shellConflicts = [...conflictKeys].filter(userOwnsInShell);
  if (shellConflicts.length > 0) {
    // The user has their own gateway/model config in the shell. Skip the write,
    // but keep manifest.claudeEnv intact: this is not the user editing our
    // managed settings.json entry, so we must stay able to reconcile once the
    // shell config goes away.
    await appendErrorLog({
      apply_model_config: 'skipped claude gateway: user owns conflicting shell env',
      conflicts: shellConflicts,
    });
    return;
  }

  const canManage = [...conflictKeys].every((key) => (
    env[key] === undefined ||
    (previousHashes[key] !== undefined && entryHash(env[key]) === previousHashes[key])
  ));
  if (!canManage) {
    manifest.claudeEnv = {};
    return;
  }

  for (const [key, hash] of Object.entries(previousHashes)) {
    if (entryHash(env[key]) === hash) delete env[key];
  }
  Object.assign(env, desired);
  settings.env = env;
  await writeModelJson(settingsPath, settings);
  manifest.claudeEnv = Object.fromEntries(
    Object.entries(desired).map(([key, value]) => [key, entryHash(value)]),
  );
}

async function applyModelConfig(
  config: LocalAgentConfig,
  command: LocalAgentCommand,
  context: LocalAgentContext,
): Promise<void> {
  const { models, fullSnapshot } = parseDeliveredModels(command.cmd);
  const manifest = (await readJson<ModelConfigManifest>(getModelManifestPath())) ?? {};
  const agentKind = modelAgentKind(context.tool);
  if (!agentKind) {
    throw new Error(`apply_model_config: unsupported agent "${context.tool ?? ''}"`);
  }

  const scope = normalizeScope(command.scope);
  const workspacePath = scope === 'project'
    ? await resolveWorkspacePath(command.workspace_path ?? context.cwd)
    : undefined;
  if (scope === 'project' && !workspacePath) {
    throw new Error('apply_model_config: workspace command is missing workspace_path');
  }
  if (workspacePath && config.workspaceBindings[workspacePath] === undefined) {
    throw new Error(
      `apply_model_config: workspace "${path.basename(workspacePath)}" is not a registered binding`,
    );
  }
  if (agentKind === 'claude' && workspacePath) {
    throw new Error('apply_model_config: workspace scope is unsupported for claude');
  }
  if (!workspacePath) {
    // An explicit profile switch takes precedence over server delivery. Keep
    // both the Agent config and delivery manifest intact for a later restore.
    const { isModelProfileManaged } = await import('./models/switch.js');
    if (await isModelProfileManaged(agentKind)) return;
  }

  let scopeManifest: BuddyModelManifest = manifest;
  if (workspacePath) {
    manifest.workspaceModels ??= {};
    manifest.workspaceModels[workspacePath] ??= {};
    scopeManifest = manifest.workspaceModels[workspacePath];
  }
  const previousProviders = scopeManifest.providersByAgent?.[agentKind]
    ?? (!workspacePath && agentKind !== 'workbuddy' ? manifest.providers : undefined)
    ?? {};
  const providers = {
    ...(fullSnapshot ? {} : previousProviders),
    ...Object.fromEntries(models.map((model) => [model.model_id, model.provider])),
  };
  scopeManifest.providersByAgent = {
    ...scopeManifest.providersByAgent,
    [agentKind]: providers,
  };
  if (agentKind === 'claude') {
    await reconcileClaudeModels(models, manifest);
  } else {
    await reconcileBuddyModels(models, fullSnapshot, scopeManifest, agentKind, workspacePath);
  }
  await writeJsonAtomic(getModelManifestPath(), manifest);
}

/**
 * Tokenize a restricted `teamai` command string into an argv array.
 *
 * Supports single and double quotes so arguments containing spaces survive
 * (e.g. `--name "a b"`). No variable expansion, no globbing; shell
 * metacharacters like `;`, `|`, `&`, `$`, `(`, `)` are treated as literals.
 * Throws when the string is empty, has an unterminated quote, or its first
 * token is not exactly `teamai` — so a backend can never launch anything but
 * a teamai subcommand.
 */
export function parseTeamaiCmd(raw: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of raw) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasToken) {
        argv.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote) {
    throw new Error('Unterminated quote in cmd');
  }
  if (hasToken) {
    argv.push(current);
  }
  if (argv.length === 0) {
    throw new Error('Empty cmd');
  }
  if (argv[0] !== 'teamai') {
    throw new Error(`Rejected cmd: only "teamai" subcommands are allowed, got "${argv[0]}"`);
  }
  return argv;
}

/**
 * Resolve the teamai entry script to run a pushed cmd. Prefers the current
 * process entry (`process.argv[1]`) so the running teamai is reused, and
 * falls back to resolving `dist/index.js` from this bundle when argv[1] is
 * unavailable (some sandboxed hook launchers). Returns null when neither
 * resolves.
 */
function resolveCmdEntry(): string | null {
  const argvEntry = process.argv[1];
  if (argvEntry) {
    return argvEntry;
  }
  return resolveTeamaiEntryScript();
}

/**
 * Execute an `uninstall_teamai` command's `cmd` string pushed via sync. Runs a
 * teamai subcommand once with the current Node binary (`process.execPath`) and
 * the resolved entry script — no shell, so there is no metacharacter injection
 * and no PATH dependency (works inside sandboxes with a bundled Node). The
 * whole `process.env` is forwarded so bundled-node runtime variables survive.
 *
 * Throws (which the caller acks as `failed`) when remote cmd is disabled, the
 * cmd is missing/rejected, the entry cannot be resolved, or the subprocess
 * exits non-zero or times out. Returns undefined on success (no version to
 * report for a cmd).
 */
async function runCmdCommand(
  command: LocalAgentCommand,
  context: LocalAgentContext,
): Promise<string | undefined> {
  if (process.env.TEAMAI_DISABLE_REMOTE_CMD === '1') {
    throw new Error('remote cmd disabled by client');
  }
  if (!command.cmd) {
    throw new Error('cmd command is missing the "cmd" field');
  }
  const argv = parseTeamaiCmd(command.cmd);
  const entry = resolveCmdEntry();
  if (!entry) {
    throw new Error('Cannot resolve teamai entry script to run cmd');
  }
  const tag = localAgentTag(context);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [entry, ...argv.slice(1)],
      // The sync holds the lifecycle lock until this returns; an uninstall must not wait for it.
      { timeout: 120_000, env: { ...process.env, [LOCK_HOLDER_ENV]: String(process.pid) }, maxBuffer: 4 * 1024 * 1024 },
    );
    const summary = stdout.trim().split('\n').slice(0, 3).join(' | ');
    log.debug(`${tag} cmd OK: ${command.cmd}${summary ? ` — ${summary}` : ''}`);
    return undefined;
  } catch (e) {
    const err = e as { stderr?: string; message?: string; killed?: boolean; code?: string };
    const detail = (err.stderr?.trim() || err.message || 'unknown error')
      .split('\n')
      .slice(0, 3)
      .join(' | ')
      .slice(0, 200);
    // `killed` is also set on maxBuffer overflow, so disambiguate before labeling.
    const prefix = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      ? 'cmd output too large'
      : err.killed
        ? 'cmd timed out'
        : 'cmd failed';
    throw new Error(`${prefix}: ${detail}`);
  }
}

/**
 * Execute an install_hook_rule / uninstall_hook_rule sync command (issue #238):
 * write or remove a single HTTP-source agent hook in the CURRENT tool's settings,
 * tracked in the agent-hook manifest. Each tool family has its own hook format:
 * claude/codex use settings.json, hermes uses config.yaml, openclaw-family uses
 * HOOK.md + handler.ts. cursor is rejected. Throws on validation failure so
 * the caller acks 'failed' with the message.
 *
 * Gated by the same TEAMAI_DISABLE_REMOTE_CMD kill-switch as runCmdCommand: an
 * agent hook writes a backend-supplied command that the tool auto-runs on session
 * events, so the client's single remote-command opt-out disables this surface too.
 */
async function runHookRuleCommand(
  config: LocalAgentConfig,
  command: LocalAgentCommand,
  context: LocalAgentContext,
): Promise<string | undefined> {
  if (process.env.TEAMAI_DISABLE_REMOTE_CMD === '1') {
    throw new Error('remote cmd disabled by client');
  }
  const tool = context.tool;
  if (!tool) {
    throw new Error('install_hook_rule: missing current tool in context');
  }
  if (!isAgentHookSupportedTool(tool)) {
    throw new Error(`unsupported tool: ${tool}`);
  }
  const slug = command.slug;
  if (!slug) {
    throw new Error(`${command.type}: missing slug`);
  }
  const manifest = await loadAgentHookManifest();

  if (command.type === 'uninstall_hook_rule') {
    const rec = manifest[slug];
    if (rec) {
      if (rec.tool === 'hermes') {
        const { removeHermesAgentHook } = await import('./hermes-hooks.js');
        await removeHermesAgentHook({ slug, event: rec.event, command: rec.command });
      } else if (OPENCLAW_TOOLS.has(rec.tool)) {
        const { removeOpenClawAgentHook } = await import('./openclaw-hooks.js');
        await removeOpenClawAgentHook({ slug, tool: rec.tool });
      } else if (rec.tool === 'opencode') {
        const { removeOpencodeAgentHook } = await import('./opencode-hooks.js');
        await removeOpencodeAgentHook({ slug, baseDir: getUserHome(), scope: 'user' });
      } else if (rec.tool === 'pi') {
        const { removePiAgentHook } = await import('./pi-hooks.js');
        await removePiAgentHook(slug);
      } else {
        const settingsPath = await resolveToolSettingsPath(config, rec.tool);
        await removeAgentHook(settingsPath, rec.tool, { slug, command: rec.command });
      }
      delete manifest[slug];
      await saveAgentHookManifest(manifest);
    }
    return undefined;
  }

  // install_hook_rule
  const event = command.event;
  const cmd = command.cmd;
  if (!event || !cmd) {
    throw new Error('install_hook_rule: missing event or cmd');
  }
  if (!isAgentHookEvent(event)) {
    throw new Error(`unsupported event: ${event}`);
  }
  const timeout = command.timeout ?? 10;
  const matcher = command.matcher; // may be undefined → applyAgentHook defaults to '*'

  // If this slug was previously installed, remove the old entry first so re-install
  // never leaves a stale hook behind. This must run even when the tool is unchanged:
  // applyAgentHook only replaces within the new event (claude) or by the new command
  // (codex), so a same-tool re-install that changes the event or command would
  // otherwise orphan the old entry. removeAgentHook scans all events by slug (claude)
  // and matches prior.command (codex), covering both cases.
  const prior = manifest[slug];
  if (prior) {
    try {
      if (prior.tool === 'hermes') {
        const { removeHermesAgentHook } = await import('./hermes-hooks.js');
        await removeHermesAgentHook({ slug, event: prior.event, command: prior.command });
      } else if (OPENCLAW_TOOLS.has(prior.tool)) {
        const { removeOpenClawAgentHook } = await import('./openclaw-hooks.js');
        await removeOpenClawAgentHook({ slug, tool: prior.tool });
      } else if (prior.tool === 'opencode') {
        const { removeOpencodeAgentHook } = await import('./opencode-hooks.js');
        await removeOpencodeAgentHook({ slug, baseDir: getUserHome(), scope: 'user' });
      } else if (prior.tool === 'pi') {
        const { removePiAgentHook } = await import('./pi-hooks.js');
        await removePiAgentHook(slug);
      } else {
        const priorPath = await resolveToolSettingsPath(config, prior.tool);
        await removeAgentHook(priorPath, prior.tool, { slug, command: prior.command });
      }
    } catch (e) {
      log.debug(`agent hook [${slug}] prior cleanup failed: ${(e as Error).message}`);
    }
  }

  if (tool === 'hermes') {
    const { applyHermesAgentHook } = await import('./hermes-hooks.js');
    await applyHermesAgentHook({ slug, event, command: cmd, matcher, timeout });
  } else if (OPENCLAW_TOOLS.has(tool)) {
    const { applyOpenClawAgentHook } = await import('./openclaw-hooks.js');
    await applyOpenClawAgentHook({ slug, event, command: cmd, tool, matcher, timeout });
  } else if (tool === 'opencode') {
    // OpenCode loads plugins from ~/.config/opencode/plugin (user scope).
    const { applyOpencodeAgentHook } = await import('./opencode-hooks.js');
    await applyOpencodeAgentHook({ slug, event, command: cmd, baseDir: getUserHome(), scope: 'user', matcher });
  } else if (tool === 'pi') {
    const { applyPiAgentHook } = await import('./pi-hooks.js');
    await applyPiAgentHook({ slug, event, command: cmd, matcher, timeout });
  } else {
    const settingsPath = await resolveToolSettingsPath(config, tool);
    await applyAgentHook(settingsPath, tool, { slug, event, command: cmd, matcher, timeout });
  }
  manifest[slug] = { tool, event, command: cmd, matcher, timeout };
  await saveAgentHookManifest(manifest);
  return undefined;
}

// ─── MCP server install / uninstall (HTTP distribution) ─────

const VALID_MCP_TRANSPORTS = new Set<string>(['stdio', 'http', 'sse']);

function mcpConfigToDef(slug: string, cfg: NonNullable<LocalAgentCommand['mcp_config']>): McpServerDef {
  if (!VALID_MCP_TRANSPORTS.has(cfg.transport)) {
    throw new Error(`install_mcp: unsupported transport "${cfg.transport}" for server "${slug}"`);
  }
  return {
    name: slug,
    transport: cfg.transport as McpTransport,
    command: cfg.command,
    args: cfg.args,
    url: cfg.url,
    headers: cfg.headers,
    env: cfg.env,
    timeout: cfg.timeout,
    requires: cfg.requires,
  };
}

function updateManifestRecord(
  manifest: ManagedMcpManifest,
  key: string,
  name: string,
  hash: string,
  /** Project scope: whether the entry carries a credential, as `resolved` notes for a pull's (#882). */
  resolved?: boolean,
  bare?: boolean,
  /** User scope, CodeBuddy: the file it wrote (#993). */
  file?: string,
): void {
  const records = manifest[key] ?? [];
  const idx = records.findIndex((r: ManagedMcpRecord) => r.name === name);
  const record: ManagedMcpRecord = {
    name, hash, ...resolved === undefined ? {} : { resolved }, ...bare === undefined ? {} : { bare }, ...file === undefined ? {} : { file },
  };
  if (idx >= 0) {
    records[idx] = record;
  } else {
    records.push(record);
  }
  manifest[key] = records;
}

/**
 * `tool`'s two places for a workspace's project MCP servers (#915), as a pull
 * resolves them: the project's file (`tree`) and, for Claude and CodeBuddy,
 * the tool's local scope (`local`), with `config`, the workspace's config the
 * places were resolved with (the member's tool roots: Claude's local scope is
 * in its user config). Null for a tool that has no local scope.
 */
async function workspaceMcpLocations(
  config: LocalAgentConfig, localConfig: LocalConfig, tool: string, workspacePath: string,
): Promise<{ tree: McpTarget; local: McpTarget; config: LocalConfig } | null> {
  const withRoots = { ...localConfig, toolRoots: await memberToolRoots(workspacePath) };
  const places = await projectMcpLocations(createLocalAgentTeamConfig(config.endpoint), withRoots, tool);
  return places && { ...places, config: withRoots };
}

/**
 * The MCP records of `localConfig`'s scope, as `install_mcp` and
 * `uninstall_mcp` keep them, and how to save them. Project scope: the
 * workspace's own manifest under the partition (it migrates legacy shared
 * records on first read), with the records of its local scopes (#915), which
 * every checkout of the project shares (`saveMcpManifest`). User scope: the
 * single global file. The ownership key needs no workspace segment.
 */
async function loadLocalAgentMcpManifest(
  localConfig: LocalConfig, dataHome: string,
): Promise<{ manifestPath: string; manifest: ManagedMcpManifest; save: () => Promise<void> }> {
  if (localConfig.scope === 'project' && localConfig.projectRoot) {
    const scoped = { ...localConfig, dataHome };
    const { manifestPath, manifest } = await loadMcpManifest(scoped, false);
    return { manifestPath, manifest, save: () => saveMcpManifest(scoped, manifestPath, manifest) };
  }
  const manifestPath = managedMcpManifestPath(dataHome);
  const manifest = (await readJson<ManagedMcpManifest>(manifestPath)) ?? {};
  return { manifestPath, manifest, save: () => writeJsonAtomic(manifestPath, manifest) };
}

/**
 * Take the servers of `records` out of `other`, the place for them in a
 * workspace the git exclude flag does not pick now (#915), once they are
 * written and recorded in the other place (`target`): a copy the member
 * changed stays, named. From the project's file, a server another tool's
 * record there still claims stays too (Claude while tclaude reads
 * `.mcp.json`), and a file left holding nothing is deleted, unless git
 * tracks it.
 */
async function leaveOtherMcpLocation(
  config: LocalAgentConfig,
  places: { tree: McpTarget; config: LocalConfig },
  other: McpTarget,
  serverKey: string,
  records: readonly ManagedMcpRecord[],
  target: string,
  manifest: ManagedMcpManifest,
): Promise<void> {
  const fromTree = other.projectKey === undefined;
  const claimed = fromTree
    ? await claimedByOtherTools(
      await resolveMcpTargets(createLocalAgentTeamConfig(config.endpoint), places.config, { includeUndetected: true }), places.tree, manifest)
    : new Set<string>();
  let removed = false;
  for (const record of records) {
    if (!claimed.has(record.name)) removed = await removeMovedMcpEntry(other, serverKey, record.name, target, record.hash) || removed;
  }
  if (removed && fromTree) await deleteEmptiedMcpFile(other.file).catch(() => false);
}

async function installMcpServer(
  config: LocalAgentConfig,
  command: LocalAgentCommand,
  tool: string,
  slug: string,
  scope: LocalAgentScope,
  workspacePath?: string,
): Promise<string | undefined> {
  if (!command.mcp_config) {
    throw new Error('install_mcp: missing mcp_config');
  }

  const def = mcpConfigToDef(slug, command.mcp_config);
  const fullTeamConfig = createLocalAgentTeamConfig(config.endpoint);
  // Resolved through the scope seam, so the user-scope MCP file follows a root
  // the member relocated (`toolRoots`) the way `teamai pull` writes it. Project
  // scope returns `mcpProject` unchanged — it belongs to the workspace.
  const localConfig = await createResourceLocalConfig(config, scope, getUserHome(), workspacePath);
  const toolPath = scopedToolPaths(fullTeamConfig, localConfig)[tool];
  if (!toolPath) {
    throw new Error(`install_mcp: unknown tool "${tool}"`);
  }

  const projectScope = scope === 'project';
  const mcpRel = projectScope ? toolPath.mcpProject : toolPath.mcp;
  if (!mcpRel) {
    throw new Error(`install_mcp: tool "${tool}" has no MCP config path for scope "${scope}"`);
  }

  const format = detectMcpFormat(tool);
  if (!format) {
    throw new Error(`install_mcp: tool "${tool}" has no known MCP format`);
  }
  if (!supportsTransport(format, def.transport)) {
    throw new Error(`install_mcp: tool "${tool}" does not support ${def.transport} transport`);
  }

  const baseDir = resolveToolBaseDir(tool, localConfig);
  const mappedFile = path.join(baseDir, mcpRel);
  // Claude's and CodeBuddy's go to the tool's local scope while the workspace's git exclude flag moves them, as a
  // pull's do (#915); the other place is where an earlier install may have left this server.
  const places = projectScope && workspacePath ? await workspaceMcpLocations(config, localConfig, tool, workspacePath) : null;
  const relocated = places !== null
    && await mcpRelocated(await localAgentTeamConfig(config.endpoint, scope, workspacePath, `install ${slug}`), places.config, tool);
  const active = places && (relocated ? places.local : places.tree);
  const other = places && (relocated ? places.tree : places.local);
  // CodeBuddy reads only the first of its user MCP files that exists (#993), as a pull writes it.
  const lookup = !projectScope && USER_MCP_LOOKUP[tool] !== undefined;
  const targetFile = active?.file ?? (lookup ? await userMcpFile(tool, mcpRel, baseDir) : mappedFile);
  const target = describeMcpLocation({ file: targetFile, projectKey: active?.projectKey });
  const fileOf = (record: ManagedMcpRecord): string =>
    recordedFileOf({ file: targetFile, ...(lookup ? { mappedFile } : {}) }, record);

  const { resolveDataHomeForScope } = await import('./config.js');
  const dataHome = await resolveDataHomeForScope(projectScope ? 'project' : 'user', projectScope ? workspacePath : undefined);
  const { manifestPath, manifest, save } = await loadLocalAgentMcpManifest(localConfig, dataHome);
  const manifestKey = active ? mcpManifestKey(active) : managedMcpManifestKey(tool, projectScope);
  // Only records of this file: a server an earlier install left in a file CodeBuddy no longer reads moves below.
  // By real path, as reconciliation compares them: a lookup file linked to another is that file.
  const records = manifest[manifestKey] ?? [];
  const inTarget = await Promise.all(records.map((r: ManagedMcpRecord) => sameMcpFile(fileOf(r), targetFile)));
  const owned = records.filter((_, i) => inTarget[i]);
  const ownedNames = new Set(owned.map((r: ManagedMcpRecord) => r.name));
  const otherKey = other ? mcpManifestKey(other) : undefined;
  const movedFrom = records.find((r: ManagedMcpRecord, i) => r.name === slug && !inTarget[i])
    ?? (otherKey ? manifest[otherKey]?.find((r) => r.name === slug) : undefined);
  const file = lookup ? targetFile : undefined;

  if (format === 'codex') {
    const block = renderCodexBlock(def);
    const hash = entryHash(block);
    let source = (await readFileIfExists(targetFile)) ?? '';
    const present = new Set(codexServerNames(source));
    if (present.has(slug) && !ownedNames.has(slug)) {
      throw new Error(`install_mcp: server "${slug}" exists in ${tool} config and is not managed by teamai`);
    }
    updateManifestRecord(manifest, manifestKey, slug, hash);
    await save();
    source = spliceCodexBlock(source, slug, block);
    await writeCodexAtomic(targetFile, source);
  } else {
    const entry = renderJsonEntry(format, def);
    const serverKey = MCP_SERVER_KEY[format];
    const hash = entryHash(entry);
    const allowBare = format === 'copilot' && projectScope;
    const doc = await readJsonDoc(targetFile, serverKey, allowBare, active?.projectKey);
    if (!doc) {
      throw new Error(`install_mcp: cannot parse ${targetFile}`);
    }
    if (doc.servers[slug] !== undefined && !ownsJsonMcpEntry(doc, slug, owned, allowBare)) {
      throw new Error(`install_mcp: server "${slug}" exists in ${tool} config${active?.projectKey ? ` (${target})` : ''} and is not managed by teamai`);
    }
    // The copy a bare install left before another tool added the key would keep the old value beside this one (#882).
    // Judged by the record as it was before this install updates it.
    const bareCopy = isTeamaiBareCopy(doc, slug, owned);
    // Check Git without changing it until ownership is persisted. Recheck protection before writing the credential (#882).
    // A local scope is outside the working tree: no git exclusion applies to it.
    const credential = projectScope && !active?.projectKey && await keepCredentialOutOfGit({ ...localConfig, dataHome }, tool, slug, targetFile, entry, true);
    // A record of this server in the file CodeBuddy no longer reads is existing ownership too (#993).
    const previousRecord = owned.find((record) => record.name === slug) ?? movedFrom;
    const previousData = previousRecord ? structuredClone(doc.data) : undefined;
    // Existing ownership stays valid until the config write completes. New installs
    // still persist a provisional record before adding a Git exclusion (#882).
    if (!previousRecord) {
      updateManifestRecord(manifest, manifestKey, slug, hash, projectScope ? credential : undefined, undefined, file);
      await save();
    }
    if (credential) await keepCredentialOutOfGit({ ...localConfig, dataHome }, tool, slug, targetFile, entry);
    if (bareCopy) delete doc.data[slug];
    doc.servers[slug] = entry;
    await writeJsonDoc(targetFile, serverKey, doc);
    if (allowBare || previousRecord) {
      // Placement is evidence of a completed write, not just an attempted install.
      updateManifestRecord(manifest, manifestKey, slug, hash, projectScope ? credential : undefined, allowBare ? doc.bare : undefined, file);
      // A record in the tool's other place goes with the copy there, once this write holds the server.
      if (otherKey && manifest[otherKey]) {
        manifest[otherKey] = manifest[otherKey].filter((r) => r.name !== slug);
        if (manifest[otherKey].length === 0) delete manifest[otherKey];
      }
      try {
        await save();
      } catch (error) {
        if (previousData) {
          try {
            await writeMcpJson(targetFile, previousData);
          } catch (restoreError) {
            throw new Error(
              `install_mcp: ownership write failed (${error instanceof Error ? error.message : String(error)}), and restoring ${targetFile} failed `
              + `(${restoreError instanceof Error ? restoreError.message : String(restoreError)}). The config may not match ${manifestPath}. Repair the config and ownership record after fixing both write errors, then install the server again.`,
              { cause: error },
            );
          }
        }
        throw error;
      }
    }
    if (movedFrom && places && other) {
      await leaveOtherMcpLocation(config, places, other, serverKey, [movedFrom], target, manifest);
    } else if (movedFrom) {
      await removeMovedMcpEntry({ file: fileOf(movedFrom) }, serverKey, slug, target, movedFrom.hash);
    }
  }
  if (projectScope && workspacePath) {
    const resources = await loadManifest();
    getManifestScope(resources, 'project', workspacePath);
    await saveManifest(resources);
  }
  log.debug(`local-agent: installed MCP server "${slug}" for ${tool} (scope=${scope})`);
  return command.version;
}

/**
 * Take `slug` out of `from`, where an earlier install wrote it and which the
 * tool no longer gets it from: a user MCP file CodeBuddy no longer reads
 * (#993), or a project's `.mcp.json` or the tool's local scope, the place for
 * it the git exclude flag no longer picks (#915). This install wrote it to
 * `target` and recorded it there. A failure leaves the old entry, and says
 * where. Whether it took it out.
 */
async function removeMovedMcpEntry(
  from: Pick<McpTarget, 'file' | 'projectKey'>, serverKey: string, slug: string, target: string, recordedHash: string,
): Promise<boolean> {
  const file = describeMcpLocation(from);
  try {
    const doc = await readJsonDoc(from.file, serverKey, false, from.projectKey);
    if (!doc) throw new Error('it does not parse');
    if (doc.servers[slug] === undefined) return false;
    // A copy the member changed since teamai installed it is theirs: left where it is (#993).
    if (entryHash(doc.servers[slug]) !== recordedHash) {
      log.warn(`Installed MCP server ${slug} in ${target}, and kept the copy in ${file}: you changed it since teamai installed it. `
        + `Remove ${slug} from ${file} when you no longer need it.`);
      return false;
    }
    delete doc.servers[slug];
    await writeJsonDoc(from.file, serverKey, doc);
    return true;
  } catch (error) {
    log.warn(`Installed MCP server ${slug} in ${target}, but could not remove the copy an earlier install left in ${file}: `
      + `${error instanceof Error ? error.message : String(error)}. Remove ${slug} from ${file} yourself.`);
    return false;
  }
}

/**
 * For a project-scope install: whether `entry` carries a credential and, if
 * so, list `file` in `.git/info/exclude` and record it in
 * managed-mcp-files.json, as a pull does before writing a resolved value
 * (#882). With dryRun, checks protection without adding an exclusion or file record.
 * Throws when git protection fails; the MCP config is left unchanged.
 */
async function keepCredentialOutOfGit(
  localConfig: LocalConfig,
  tool: string,
  slug: string,
  file: string,
  entry: unknown,
  dryRun = false,
): Promise<boolean> {
  const { carriesLocalAgentCredential, ensureExcludedFromGit } = await import('./mcp-git-exclude.js');
  if (!carriesLocalAgentCredential(entry)) return false;
  // Commands come from the server: no pull replays one.
  const exclusion = await ensureExcludedFromGit(file, { dryRun, rerun: 'install the MCP server again' });
  if (exclusion.kind === 'failed') {
    throw new Error(
      `install_mcp: withheld "${slug}" from ${file}: it may carry a credential (a header, env value, argument or URL), and teamai could not keep the file `
      + `out of git: ${exclusion.reason}. The file is left as it was. ${exclusion.fix}`,
    );
  }
  if (dryRun) return true;
  const { trackResolvedMcpFiles } = await import('./mcp-resolved-files.js');
  // A failure does not stop the write: the exclusion protects the file.
  const result = await trackResolvedMcpFiles(localConfig, [{ tool, file }]).catch((e: unknown) => e instanceof Error ? e.message : String(e));
  if (result !== 'written' && result !== 'unchanged') {
    log.debug(`Did not record ${file} in managed-mcp-files.json: ${result === 'locked' ? 'another teamai command held it past the wait' : result}.`);
  }
  return true;
}

async function uninstallMcpServer(
  config: LocalAgentConfig,
  tool: string,
  slug: string,
  scope: LocalAgentScope,
  workspacePath?: string,
): Promise<void> {
  const fullTeamConfig = createLocalAgentTeamConfig(config.endpoint);
  // Removal has to look where the install wrote: same scope seam, same root.
  const localConfig = await createResourceLocalConfig(config, scope, getUserHome(), workspacePath);
  const toolPath = scopedToolPaths(fullTeamConfig, localConfig)[tool];
  if (!toolPath) return;

  const projectScope = scope === 'project';
  const mcpRel = projectScope ? toolPath.mcpProject : toolPath.mcp;
  if (!mcpRel) return;

  const format = detectMcpFormat(tool);
  if (!format) return;

  const baseDir = resolveToolBaseDir(tool, localConfig);

  const { resolveDataHomeForScope } = await import('./config.js');
  const dataHome = await resolveDataHomeForScope(projectScope ? 'project' : 'user', projectScope ? workspacePath : undefined);
  const { manifestPath, manifest, save } = await loadLocalAgentMcpManifest(localConfig, dataHome);
  // Claude's and CodeBuddy's may be in the tool's local scope or in the project's file, whichever the git exclude
  // flag picked when it was installed (#915): taken out wherever a record places it.
  const places = projectScope && workspacePath ? await workspaceMcpLocations(config, localConfig, tool, workspacePath) : null;
  const locations: Array<{ manifestKey: string; file?: string; projectKey?: string }> = places
    ? [places.local, places.tree].map((place) => ({ manifestKey: mcpManifestKey(place), file: place.file, projectKey: place.projectKey }))
    : [{ manifestKey: managedMcpManifestKey(tool, projectScope) }];

  for (const { manifestKey, file, projectKey } of locations) {
    const owned = manifest[manifestKey] ?? [];
    if (!owned.some((r: ManagedMcpRecord) => r.name === slug)) continue;
    // CodeBuddy's user servers are where the install recorded them (#993); an older one recorded no file.
    const recordedFile = !projectScope && USER_MCP_LOOKUP[tool] ? owned.find((r) => r.name === slug)?.file : undefined;
    const targetFile = file ?? recordedFile ?? path.join(baseDir, mcpRel);
    const where = describeMcpLocation({ file: targetFile, projectKey });

    let restoreConfig: (() => Promise<void>) | undefined;
    if (format === 'codex') {
      const source = (await readFileIfExists(targetFile)) ?? '';
      const next = spliceCodexBlock(source, slug, null);
      if (next !== source) {
        await writeCodexAtomic(targetFile, next);
        restoreConfig = () => writeCodexAtomic(targetFile, source);
      }
    } else {
      const serverKey = MCP_SERVER_KEY[format];
      const allowBare = format === 'copilot' && projectScope;
      const doc = await readJsonDoc(targetFile, serverKey, allowBare, projectKey);
      if (!doc) throw new Error(`uninstall_mcp: cannot parse ${targetFile}. Ownership was kept; repair the config and uninstall the server again.`);
      // Also a bare entry another tool's mcpServers now sits beside (#882).
      const bareCopy = isTeamaiBareCopy(doc, slug, owned);
      const ownsEntry = ownsJsonMcpEntry(doc, slug, owned, allowBare);
      if ((ownsEntry && doc.servers[slug] !== undefined) || bareCopy) {
        const previousData = structuredClone(doc.data);
        if (ownsEntry) delete doc.servers[slug];
        if (bareCopy) delete doc.data[slug];
        await writeJsonDoc(targetFile, serverKey, doc);
        restoreConfig = () => writeMcpJson(targetFile, previousData);
      }
    }
    manifest[manifestKey] = owned.filter((r: ManagedMcpRecord) => r.name !== slug);
    if (manifest[manifestKey].length === 0) delete manifest[manifestKey];
    try {
      await save();
    } catch (error) {
      if (restoreConfig) {
        try {
          await restoreConfig();
        } catch (restoreError) {
          throw new Error(
            `uninstall_mcp: ownership write failed (${error instanceof Error ? error.message : String(error)}), and restoring ${where} failed `
            + `(${restoreError instanceof Error ? restoreError.message : String(restoreError)}). The config may not match ${manifestPath}. Repair the config and ownership record after fixing both write errors, then uninstall the server again.`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }
  log.debug(`local-agent: uninstalled MCP server "${slug}" from ${tool} (scope=${scope})`);
}

async function runMcpCommand(
  config: LocalAgentConfig,
  command: LocalAgentCommand,
  context: LocalAgentContext,
): Promise<string | undefined> {
  const tool = context.tool;
  if (!tool) {
    throw new Error(`${command.type}: cannot determine current tool`);
  }
  const slug = command.slug;
  if (!slug) {
    throw new Error(`${command.type}: missing slug`);
  }
  assertSafeResourceName(slug);

  const scope = normalizeScope(command.scope);
  const workspacePath = scope === 'project'
    ? await resolveWorkspacePath(command.workspace_path ?? context.cwd)
    : undefined;
  if (scope === 'project' && !workspacePath) {
    throw new Error(`${command.type}: workspace command is missing workspace_path`);
  }

  if (command.type === 'install_mcp') {
    return installMcpServer(config, command, tool, slug, scope, workspacePath);
  }

  await uninstallMcpServer(config, tool, slug, scope, workspacePath);
  return command.version;
}

async function executeCommand(
  config: LocalAgentConfig,
  command: LocalAgentCommand,
  context: LocalAgentContext,
): Promise<string | undefined> {
  if (command.type === 'apply_model_config') {
    await applyModelConfig(config, command, context);
    return;
  }
  // uninstall_teamai (clawpro three-phase: cmd = "teamai uninstall --force
  // --agent <tool>") executes its `cmd` string as a restricted teamai subcommand.
  if (command.type === 'uninstall_teamai') {
    return runCmdCommand(command, context);
  }
  if (command.type === 'install_hook_rule' || command.type === 'uninstall_hook_rule') {
    return runHookRuleCommand(config, command, context);
  }
  if (command.type === 'install_mcp' || command.type === 'uninstall_mcp') {
    return runMcpCommand(config, command, context);
  }
  const kind = commandKind(command);
  const action = commandAction(command);
  if (!kind || !action) {
    throw new Error(`Unsupported command type: ${command.type ?? ''}`);
  }

  const scope = normalizeScope(command.scope);
  const workspacePath = scope === 'project'
    ? await resolveWorkspacePath(command.workspace_path ?? context.cwd)
    : undefined;
  if (scope === 'project' && !workspacePath) {
    throw new Error('Project command is missing workspace_path');
  }

  const slug = commandSlug(command, kind);
  const tool = context.tool;
  if (action === 'install') {
    return installDownloadedResource({ config, command, kind, slug, scope, workspacePath, tool });
  }

  await uninstallResource({ config, kind, slug, scope, workspacePath, tool });
  return commandVersion(command, kind);
}

async function processCommands(
  config: LocalAgentConfig,
  commands: LocalAgentCommand[],
  context: LocalAgentContext,
): Promise<boolean> {
  const tag = localAgentTag(context);
  let modelConfigApplied = false;
  for (const command of commands) {
    // Keep these special types aligned with executeCommand's direct branches.
    // Resource commands are recognized generically by commandKind/action;
    // everything else is a future protocol extension and must be skipped.
    if (isUnimplementedCommand(command) || (
      command.type !== 'apply_model_config' &&
      command.type !== 'uninstall_teamai' &&
      command.type !== 'install_hook_rule' &&
      command.type !== 'uninstall_hook_rule' &&
      command.type !== 'install_mcp' &&
      command.type !== 'uninstall_mcp' &&
      (!commandKind(command) || !commandAction(command))
    )) {
      log.debug(`${tag} skipping unimplemented command ${command.id} (${command.type})`);
      continue;
    }
    try {
      const version = await executeCommand(config, command, context);
      await ackCommand(config, tag, command, 'success', version);
      if (command.type === 'apply_model_config') modelConfigApplied = true;
      log.debug(`${tag} command ${command.id} (${command.type ?? ''}) succeeded`);
      // Uninstall succeeded — skip remaining commands; the hook process exits naturally.
      if (command.type === 'uninstall_teamai') {
        log.debug(`${tag} uninstall_teamai completed — remaining commands skipped`);
        return modelConfigApplied;
      }
    } catch (e) {
      const error = (e as Error).message;
      log.error(`${tag} command ${command.id} failed: ${error}`);
      try {
        await ackCommand(config, tag, command, 'failed', undefined, error);
      } catch (ackError) {
        log.debug(`${tag} failed to ack command ${command.id}: ${(ackError as Error).message}`);
      }
    }
  }
  return modelConfigApplied;
}

/** Whether `command` installs or removes a project skill, rule or prompt, which the `local-agent` block lists (#915). */
function changesProjectCopies(command: LocalAgentCommand): boolean {
  return normalizeScope(command.scope) === 'project'
    && ((commandKind(command) !== null && commandAction(command) !== null) || command.type === 'install_mcp' || command.type === 'uninstall_mcp');
}

export async function reportAndSyncLocalAgent(context: LocalAgentContext): Promise<boolean> {
  if (!await loadLocalAgentConfig({ dryRun: true })) return false;
  if (!await acquireLocalAgentLock()) {
    log.debug('[local-agent] sync skipped: could not acquire the HTTP source lock');
    return false;
  }
  try {
    return await syncLocalAgent(context);
  } finally {
    await releaseLock(localAgentLockPath());
  }
}

async function syncLocalAgent(context: LocalAgentContext): Promise<boolean> {
  const config = await loadLocalAgentConfig();
  if (!config) return false;

  // Binding prompt is injected via stdout hook context (not HTTP), so it must run
  // even inside the CloudStudio sandbox — the sandbox guard below only skips the
  // HTTP report/sync that would produce a duplicate card. Resolve the workspace
  // only when the prompt is enabled AND the host is a buddy agent, so every other
  // path (disabled flag, or a non-buddy tool like Claude/Cursor/Codex) forks no
  // git process.
  if (isBindPromptEnabled() && isBindPromptTool(context.tool)) {
    const workspacePath = await resolveWorkspacePath(context.cwd);
    if (workspacePath) {
      const sid = context.event?.sessionId;
      if (context.event?.type === 'session_start') {
        await ensureWorkspaceBinding(config, workspacePath, sid, context.cwd);
      }
      if (context.event?.type === 'prompt_submit') {
        await emitBindingHint(config, workspacePath, sid, context.cwd);
      }
    }
  }

  // CloudStudio sandbox reports a duplicate agent card (different machine id
  // than the host), so we skip the report POST here. Sync + command execution
  // must still run so sandboxed agents can receive pushed cmds (e.g. uninstall);
  // sync produces no card, so there is no duplicate risk.
  // TEAMAI_ALLOW_SANDBOX_REPORT=1 restores the report too (backward compatible).
  const skipReport = isCloudStudioSandbox() && process.env.TEAMAI_ALLOW_SANDBOX_REPORT !== '1';
  if (skipReport) {
    log.debug(
      '[local-agent] CloudStudio sandbox detected; skipping HTTP report ' +
        '(sync still runs; set TEAMAI_ALLOW_SANDBOX_REPORT=1 to report too)',
    );
  }

  const tag = localAgentTag(context);
  log.debug(`${tag} run: endpoint=${config.endpoint}`);

  // Report-side bookkeeping (plugin reconcile + binding prune + tool stamp) is
  // tied to the report path and must stay skipped inside the CloudStudio sandbox,
  // exactly as before this branch stopped returning early. In particular,
  // pruneDeadWorkspaceBindings would wrongly drop host bindings whose paths are
  // not mounted in the container. Only sync + command execution run when
  // skipReport is set.
  if (!skipReport) {
    if (context.event?.type === 'session_start') {
      await maybeReconcilePlugins(context);
    }

    const pruned = await pruneDeadWorkspaceBindings(config);
    // Resolve the current workspace independently here rather than reusing an
    // earlier local, so tool attribution does not depend on the binding-prompt
    // block above keeping a `workspacePath` in scope.
    const currentPath = await resolveWorkspacePath(context.cwd);
    const stamped = stampWorkspaceTool(config, currentPath, context.tool ?? 'workbuddy');
    if (pruned || stamped) {
      await saveLocalAgentConfig(config);
    }
  }

  let changedProjectCopies = false;
  try {
    if (!skipReport) {
      const reportPayload = await buildReportPayload(config, context);
      await localAgentFetch(config, tag, 'report', {
        method: 'POST',
        body: JSON.stringify(reportPayload),
      });
      log.debug(`${tag} report OK`);
    }

    const syncPayload = await buildSyncPayload(config, context);
    const syncResponse = await localAgentFetch<{
      ok?: boolean;
      cmds?: LocalAgentCommand[];
      commands?: LocalAgentCommand[];
    }>(
      config,
      tag,
      'sync',
      { method: 'POST', body: JSON.stringify(syncPayload) },
      { redactResponseLog: true },
    );
    // Prefer the unified cmds[] (source of truth). Fall back to the legacy
    // commands[] for older backends that do not yet emit cmds. An empty cmds[]
    // is treated as "cmds not available" and falls back too — the backend sends
    // identical data in both arrays, so this only affects old backends where
    // cmds is genuinely absent/empty while commands still carries the work.
    // TODO(jiahe, cmds-migration): drop the `commands` fallback once the backend
    // guarantees `cmds` on all sync responses (clawpro iwiki ch.7).
    const cmds = syncResponse.cmds;
    const commands = cmds && cmds.length > 0 ? cmds : (syncResponse.commands ?? []);
    if (commands.length > 0) {
      log.debug(`${tag} sync returned ${commands.length} command(s): ${commands.map((c) => `${c.type}#${c.id}`).join(', ')}`);
      changedProjectCopies = commands.some(changesProjectCopies);
      const modelConfigApplied = await processCommands(config, commands, context);
      if (modelConfigApplied && !skipReport) {
        const reportPayload = await buildReportPayload(config, context);
        await localAgentFetch(config, tag, 'report', {
          method: 'POST',
          body: JSON.stringify(reportPayload),
        });
        log.debug(`${tag} model config report OK`);
      }
    }
    log.debug(`${tag} sync OK (${commands.length} command(s))`);
  } catch (e) {
    const error = (e as Error).message;
    log.error(`${tag} sync FAILED: ${error}`);
    await appendErrorLog({ error, context });
  }
  // Every session start, and after project installs and uninstalls, failed ones included (a failure may have
  // written part of its copies), also when the sync failed: the manifest and the flags decide, not the backend.
  // Also when the sync failed: what an install wrote is on disk either way. Also after an uninstall_teamai:
  // one that removed teamai's servers and records leaves nothing to list, and one that failed or kept the
  // shared files (another agent remains) leaves what still needs keeping out of git.
  await protectWorkspaceMcpConfigs(config, context.cwd);
  await keepLocalAgentGitExclude(config, context.event?.type === 'session_start' || changedProjectCopies);

  return true;
}

/**
 * List in `.git/info/exclude` each MCP config of the current workspace that
 * may hold a credential an install wrote (#882). An older local agent wrote
 * one without listing it, and the server sends no install again for a server
 * already in place. The workspace and its files resolve as `install_mcp`
 * resolves them.
 */
async function protectWorkspaceMcpConfigs(config: LocalAgentConfig, cwd?: string): Promise<void> {
  const workspacePath = await resolveWorkspacePath(cwd);
  if (!workspacePath) return;
  // First, what an earlier install left in a file the tool no longer gets it from (#915).
  await moveWorkspaceMcpServers(config, workspacePath);
  try {
    const { resolveDataHomeForScope } = await import('./config.js');
    const dataHome = await resolveDataHomeForScope('project', workspacePath);
    const localConfig = await createResourceLocalConfig(config, 'project', getUserHome(), workspacePath);
    const { protectLocalAgentMcpConfigs } = await import('./mcp-reconcile.js');
    // The sync at the next session start checks again, not a pull.
    await protectLocalAgentMcpConfigs(createLocalAgentTeamConfig(config.endpoint), { ...localConfig, dataHome }, { rerun: 'start a new session' });
  } catch (e) {
    log.warn(
      `Could not check ${workspacePath}'s MCP configs for a credential to keep out of git: ${e instanceof Error ? e.message : String(e)}. `
      + 'The next session checks again; do not commit them meanwhile.',
    );
  }
}

/**
 * Move the project MCP servers earlier installs recorded in a workspace's
 * `.mcp.json` to the tool's local scope (#915), for Claude and CodeBuddy
 * while the workspace's git exclude flag moves them there, as a pull does.
 * The server sends no install again for a server already in place. A copy
 * the member changed stays, named, and is theirs from then on; so does a
 * server of the same name the member has in the local scope. A server
 * another tool's record there still claims stays in `.mcp.json` for that
 * tool. With the flag off or unknown, nothing moves.
 */
async function moveWorkspaceMcpServers(config: LocalAgentConfig, workspacePath: string): Promise<void> {
  // An uninstall_teamai in this run removed the agent: nothing to move.
  if (!await loadLocalAgentConfig({ dryRun: true })) return;
  try {
    const localConfig = await createResourceLocalConfig(config, 'project', getUserHome(), workspacePath);
    const { loadProjectMcpManifest } = await import('./utils/mcp-manifest.js');
    // Read first without writing anything: most syncs find nothing to move.
    const { manifest: recorded } = await loadProjectMcpManifest(getDataHome(localConfig), workspacePath, { dryRun: true });
    const tools = Object.keys(createLocalAgentTeamConfig(config.endpoint).toolPaths)
      .filter((tool) => (recorded[managedMcpManifestKey(tool, true)]?.length ?? 0) > 0);
    if (tools.length === 0 || await gitExcludeEnabledFor(workspacePath) !== true) return;
    const teamConfig = await localAgentTeamConfig(config.endpoint, 'project', workspacePath, 'move MCP servers');
    const { manifest, save } = await loadLocalAgentMcpManifest(localConfig, getDataHome(localConfig));
    for (const tool of tools) {
      const places = await workspaceMcpLocations(config, localConfig, tool, workspacePath);
      if (!places || !await mcpRelocated(teamConfig, places.config, tool)) continue;
      await moveToLocalScope(config, tool, places, manifest, save);
    }
  } catch (e) {
    log.warn(`Could not move the MCP servers the local agent installed in ${workspacePath} out of the project: `
      + `${e instanceof Error ? e.message : String(e)}. The next session start tries again.`);
  }
}

/** `moveWorkspaceMcpServers` for one tool. */
async function moveToLocalScope(
  config: LocalAgentConfig,
  tool: string,
  places: { tree: McpTarget; local: McpTarget; config: LocalConfig },
  manifest: ManagedMcpManifest,
  save: () => Promise<void>,
): Promise<void> {
  const { tree, local } = places;
  const treeKey = mcpManifestKey(tree);
  const localKey = mcpManifestKey(local);
  const records = manifest[treeKey] ?? [];
  if (records.length === 0 || tree.format === 'codex') return;
  const serverKey = MCP_SERVER_KEY[tree.format];
  const there = describeMcpLocation(local);
  const from = await readJsonDoc(tree.file, serverKey);
  const to = await readJsonDoc(local.file, serverKey, false, local.projectKey);
  if (!from || !to) {
    log.warn(`Did not move the local agent's MCP servers for ${tool} from ${tree.file} to ${there}: `
      + `${from ? local.file : tree.file} does not parse. Fix it; the next session start moves them.`);
    return;
  }
  const owned = new Set((manifest[localKey] ?? []).map((record) => record.name));
  const moved: ManagedMcpRecord[] = [];
  const edited: string[] = [];
  const left: ManagedMcpRecord[] = [];
  for (const record of records) {
    const entry = from.servers[record.name];
    // Gone from the file: nothing to move, and the record goes.
    if (entry === undefined) continue;
    // A copy the member changed since teamai installed it is theirs: it stays where it is, and its record goes.
    if (entryHash(entry) !== record.hash) {
      edited.push(record.name);
      continue;
    }
    const held = to.servers[record.name];
    if (held !== undefined && !owned.has(record.name) && entryHash(held) !== record.hash) {
      log.warn(`Kept MCP server ${record.name} in ${tree.file}: ${there} holds a server of that name that is not teamai's. `
        + `Rename or remove one of them; the local agent moves ${record.name} at its next sync.`);
      left.push(record);
      continue;
    }
    if (!owned.has(record.name)) to.servers[record.name] = entry;
    moved.push(record);
  }
  if (left.length === records.length) return;

  const previous = structuredClone(to.data);
  const wrote = moved.some((record) => !owned.has(record.name));
  if (wrote) await writeJsonDoc(local.file, serverKey, to);
  for (const record of moved) {
    if (!owned.has(record.name)) updateManifestRecord(manifest, localKey, record.name, record.hash, false);
  }
  if (left.length > 0) manifest[treeKey] = left;
  else delete manifest[treeKey];
  try {
    await save();
  } catch (error) {
    if (wrote) await writeMcpJson(local.file, previous).catch(() => undefined);
    throw error;
  }
  for (const name of edited) {
    log.warn(`Kept MCP server ${name} in ${tree.file}: you changed it since teamai installed it, so the local agent did not move it to ${there}. `
      + `It is yours now; remove ${name} from ${tree.file} when you no longer need it.`);
  }
  if (moved.length === 0) return;
  await leaveOtherMcpLocation(config, places, tree, serverKey, moved, there, manifest);
  log.info(`Moved the local agent's MCP servers for ${tool} (${moved.map((record) => record.name).join(', ')}) from ${tree.file} to ${there}: `
    + 'with sharing.gitExclude on, the tool reads them there.');
}

function statusFromEvent(event?: DashboardEvent): string {
  if (!event) return 'running';
  if (event.type === 'stop' || event.type === 'process_exit') return 'stopped';
  return 'running';
}

/**
 * Hook-handler adapter: run local-agent report/sync (incl. workspace binding
 * prompts) from within the unified hook dispatcher. Accepts pre-parsed STDIN
 * data so the dispatcher reads STDIN only once.
 */
export async function reportAndSyncFromHook(
  stdin: Record<string, unknown>,
  tool: string,
): Promise<string | null> {
  const raw = JSON.stringify(stdin);
  const event = await parseHookEvent(raw, tool);
  // parseHookEvent resolves cwd via resolveHookCwd too, so event?.cwd would be
  // identical here — resolve once and fall back to process.cwd().
  const cwd = resolveHookCwd(stdin) ?? process.cwd();

  // SessionStart and UserPromptSubmit run this handler in the *foreground*, where
  // it blocks the host IDE's hook (UserPromptSubmit cap = 10s). Narrow the
  // per-fetch timeout so a slow/unreachable endpoint fails fast and the handler
  // returns before the host aborts the hook. Stop / PostToolUse run detached in
  // the background, so they keep the full interactive timeout to complete real
  // resource syncs/downloads.
  const isForegroundEvent = event?.type === 'session_start' || event?.type === 'prompt_submit';
  activeFetchTimeoutMs = isForegroundEvent
    ? LOCAL_AGENT_HOOK_FETCH_TIMEOUT_MS
    : LOCAL_AGENT_FETCH_TIMEOUT_MS;
  try {
    await reportAndSyncLocalAgent({
      cwd,
      tool,
      status: statusFromEvent(event ?? undefined),
      event: event ?? undefined,
    });
    return null;
  } finally {
    activeFetchTimeoutMs = LOCAL_AGENT_FETCH_TIMEOUT_MS;
  }
}

/**
 * Persist the API token as a credential file with owner-only (0o600)
 * permissions. chmod after write so an already-existing token file (whose perms
 * mode-on-create would not touch) is also tightened.
 */
export async function writeTokenFile(tokenPath: string, token: string): Promise<void> {
  await fs.promises.writeFile(tokenPath, token + '\n', { mode: 0o600 });
  await fs.promises.chmod(tokenPath, 0o600);
}

export async function initLocalAgentHttp(options: {
  endpoint: string;
  token?: string;
  force?: boolean;
  filterAgents?: string[];
}): Promise<void> {
  const endpoint = normalizeEndpoint(options.endpoint);
  if (!endpoint) {
    throw new Error('HTTP endpoint is required.');
  }

  const existing = await loadLocalAgentConfig();
  if (existing && !options.force) {
    throw new Error('HTTP local agent is already initialized. Re-run with --force to overwrite.');
  }

  const config: LocalAgentConfig = {
    endpoint,
    token: options.token,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    workspaceBindings: existing?.workspaceBindings ?? {},
    userGroupId: existing?.userGroupId,
    userGroupName: existing?.userGroupName,
  };

  await ensureDir(getLocalAgentHome());
  await saveLocalAgentConfig(config);
  if (options.token) {
    await writeTokenFile(getTokenPath(), options.token);
  }

  const teamConfig = createLocalAgentTeamConfig(endpoint);
  // The local agent is always user-scope and always rooted at HOME, so resolve
  // the user-scope paths (Qoder CN's user config lives under ~/.qoder-cn).
  const toolRoots = await memberToolRoots();
  await injectHooksToAllTools(
    scopedToolPaths(teamConfig, { scope: 'user', toolRoots }),
    getUserHome(),
    options.filterAgents,
    toolRoots,
  );
  log.success(`HTTP local agent initialized at ${getConfigPath()}`);
}

export async function pullLocalAgentForCwd(context?: LocalAgentContext): Promise<boolean> {
  return reportAndSyncLocalAgent({
    cwd: context?.cwd ?? process.cwd(),
    tool: context?.tool ?? 'workbuddy',
    status: context?.status ?? 'running',
    event: context?.event,
  });
}

/** Summary of the configured HTTP local-agent bypass, for `teamai source list`. */
export interface LocalAgentSummary {
  endpoint: string;
  boundProjects: Array<{ path: string; projectName?: string; projectId: number }>;
  resourceCounts: { skills: number; rules: number; claudemd: number };
}

/**
 * Describe the configured HTTP local-agent bypass (report/sync/ack), or null when
 * none is configured. Used by `teamai source list` to show the HTTP side channel
 * alongside git cross-team sources.
 */
export async function describeLocalAgent(options: { dryRun?: boolean } = {}): Promise<LocalAgentSummary | null> {
  const config = await loadLocalAgentConfig(options);
  if (!config) return null;

  const boundProjects = Object.entries(config.workspaceBindings)
    .filter(([, b]) => b.projectId !== 0)
    .map(([workspacePath, b]) => ({ path: workspacePath, projectName: b.projectName, projectId: b.projectId }));

  const manifest = await loadManifest();
  const counts = { skills: 0, rules: 0, claudemd: 0 };
  for (const scope of Object.values(manifest.scopes)) {
    counts.skills += Object.keys(scope.skills ?? {}).length;
    counts.rules += Object.keys(scope.rules ?? {}).length;
    counts.claudemd += Object.keys(scope.claudemd ?? {}).length;
  }

  return { endpoint: config.endpoint, boundProjects, resourceCounts: counts };
}

/** Parse a manifest scope key back into (scope, workspacePath). */
function parseScopeKey(key: string): { scope: LocalAgentScope; workspacePath?: string } {
  if (key.startsWith('project:')) {
    return { scope: 'project', workspacePath: key.slice('project:'.length) || undefined };
  }
  return { scope: key === 'instance' ? 'instance' : 'user' };
}

/**
 * Run each installed plugin's uninstall_cmd (stop daemons, deregister autostart,
 * remove packages) using the persisted plugin manifest. No-op when no HTTP source
 * is configured.
 *
 * Best-effort: failures are logged, never thrown, so teardown of the rest of teamai
 * is never blocked. Must run BEFORE ~/.teamai is deleted — it reads the plugin
 * manifest and endpoint config from ~/.teamai/local-agent/.
 */
export async function teardownLocalAgentPlugins(): Promise<void> {
  try {
    const config = await loadLocalAgentConfig();
    if (!config) return;
    await teardownAllPlugins(buildReconcileDeps(config, '[local-agent] [uninstall]'));
  } catch (e) {
    log.warn(`[local-agent] plugin teardown failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Remove every HTTP-source agent hook recorded in the agent-hook manifest from
 * each tool's settings, then forget the ones removed. Used by `source remove-http`
 * and `teamai uninstall` teardown (issue #238). Safe to call when no config / no
 * manifest exists. A hook that could not be removed (its settings file does not
 * parse, say) keeps its record, so a later run finds it (#993); its slug and tool
 * are returned.
 */
export async function removeAllAgentHooks(): Promise<Array<{ slug: string; tool: string }>> {
  // Removal can leave hook records after disabling the source.
  const config = await loadLocalAgentConfig();
  const manifest = await loadAgentHookManifest();
  const slugs = Object.keys(manifest);
  if (slugs.length === 0) return [];
  const left: typeof manifest = {};
  for (const slug of slugs) {
    const rec = manifest[slug];
    try {
      if (rec.tool === 'hermes') {
        const { removeHermesAgentHook } = await import('./hermes-hooks.js');
        await removeHermesAgentHook({ slug, event: rec.event, command: rec.command });
      } else if (OPENCLAW_TOOLS.has(rec.tool)) {
        const { removeOpenClawAgentHook } = await import('./openclaw-hooks.js');
        await removeOpenClawAgentHook({ slug, tool: rec.tool });
      } else if (rec.tool === 'opencode') {
        const { removeOpencodeAgentHook } = await import('./opencode-hooks.js');
        await removeOpencodeAgentHook({ slug, baseDir: getUserHome(), scope: 'user' });
      } else if (rec.tool === 'pi') {
        const { removePiAgentHook } = await import('./pi-hooks.js');
        await removePiAgentHook(slug);
      } else {
        const settingsPath = await resolveToolSettingsPath(config, rec.tool);
        await removeAgentHook(settingsPath, rec.tool, { slug, command: rec.command });
      }
    } catch (e) {
      log.warn(`Could not remove agent hook ${slug} for ${rec.tool}: ${(e as Error).message}`);
      left[slug] = rec;
    }
  }
  await saveAgentHookManifest(left);
  return Object.entries(left).map(([slug, rec]) => ({ slug, tool: rec.tool }));
}

export async function removeLocalAgentHttp(): Promise<void> {
  if (await shutdownLocalAgentHttp('teamai source remove-http') === 'none') {
    log.info('No HTTP source configured — nothing to remove.');
  }
}

/**
 * Tear down the HTTP local-agent bypass: uninstall every resource recorded in the
 * manifest (skills/rules/claudemd, across all scopes) from the AI tool dirs, then
 * clear its config and caches. Keep a disabled config to prevent fallback from
 * reconnecting, and any remaining hook ownership records for a retry.
 *
 * Holds the lifecycle lock that sync and plugin reconciliation take, so neither
 * can reinstall what this removes. A failure names `retry` as the command to
 * repeat: `locked` removed nothing, `incomplete` kept hook records.
 *
 * Best-effort per resource: a single failed uninstall is logged and skipped so a
 * stale entry cannot block the teardown.
 */
export async function shutdownLocalAgentHttp(retry: string): Promise<'none' | 'removed' | 'incomplete' | 'locked'> {
  if (!await loadLocalAgentConfig({ dryRun: true }) && !await disabledSourceLeftovers()) return 'none';
  // A server-pushed uninstall runs while its sync holds the lock.
  const inherited = await holdsParentLocalAgentLock();
  if (!inherited && !await acquireLocalAgentLock()) {
    log.info('Waiting for the HTTP source sync lock before removal.');
    if (!await acquireLocalAgentLock(30_000)) {
      log.error(`Could not lock HTTP source state at ${localAgentLockPath()}; nothing was removed. `
        + `Wait for other HTTP source operations to finish, check directory permissions, then retry \`${retry}\`.`);
      process.exitCode = 1;
      return 'locked';
    }
  }
  try {
    return await removeLocalAgentHttpLocked(retry);
  } finally {
    if (!inherited) await releaseLock(localAgentLockPath());
  }
}

/**
 * The config of a source an earlier removal disabled before it could uninstall
 * every entry: the disabled marker keeps it for the retry, and nothing else
 * reads it (`loadLocalAgentConfig` sees only the marker).
 */
async function interruptedRemovalConfig(): Promise<LocalAgentConfig | null> {
  const marker = await readJson<{ disabled?: boolean; removing?: LocalAgentConfig }>(getConfigPath());
  return marker?.disabled === true && marker.removing?.endpoint ? marker.removing : null;
}

async function removeLocalAgentHttpLocked(retry: string): Promise<'none' | 'removed' | 'incomplete'> {
  const config = await loadLocalAgentConfig() ?? await interruptedRemovalConfig();
  if (!config) {
    if (!await disabledSourceLeftovers()) return 'none';
    // A retry: the caches an earlier run could not delete are still in the manifest.
    const cachesLeft: string[] = [];
    for (const [key, scopeManifest] of Object.entries((await loadManifest()).scopes)) {
      const { scope, workspacePath } = parseScopeKey(key);
      if (scope === 'project' && workspacePath && emptiedWorkspace(scopeManifest) && !await removeWorkspaceCache(workspacePath)) {
        cachesLeft.push(workspacePath);
      }
    }
    const blocks = await removeLocalAgentGitExclude(await localAgentCheckouts());
    const models = await removeWorkspaceModels();
    return finishAgentHookTeardown(retry, { models, caches: cachesLeft, blocks: [...blocks, ...await releaseModelKeyLines()] });
  }
  // Read before the marker and the teardown below delete what names them (#915).
  const checkouts = await localAgentCheckouts();

  // No sync or plugin worker can write after this point until teardown finishes.
  // The marker keeps the config until every entry is uninstalled, for a retry.
  await writeJsonAtomic(getConfigPath(), { disabled: true, removing: config });

  // Tear down installed plugins before removing teamai's local-agent state.
  try {
    await teardownAllPlugins(buildReconcileDeps(config, '[local-agent] [uninstall]'));
  } catch (e) { log.warn(`[local-agent] plugin teardown failed: ${(e as Error).message}`); }

  const kinds: CommandResourceKind[] = ['skill', 'rule', 'claudemd'];
  const manifest = await loadManifest();
  const cachesLeft: string[] = [];
  for (const [key, scopeManifest] of Object.entries(manifest.scopes)) {
    const { scope, workspacePath } = parseScopeKey(key);
    for (const kind of kinds) {
      for (const slug of Object.keys(scopeManifest[manifestKind(kind)] ?? {})) {
        try {
          await uninstallResource({ config, kind, slug, scope, workspacePath });
        } catch (e) {
          log.warn(`Could not uninstall ${kind} ${slug}: ${(e as Error).message}`);
        }
      }
    }
    const left = (await loadManifest()).scopes[key];
    if (scope === 'project' && workspacePath && emptiedWorkspace(left) && !await removeWorkspaceCache(workspacePath)) {
      cachesLeft.push(workspacePath);
    }
  }
  const entriesLeft = Object.entries((await loadManifest()).scopes).flatMap(([key, left]) =>
    kinds.flatMap((kind) => Object.keys(left?.[manifestKind(kind)] ?? {}).map((slug) => `${kind} ${slug} (${key})`)));

  // Before the state home goes: it records which exclude files hold the block (#915).
  const blocks = await removeLocalAgentGitExclude(checkouts);
  const models = await removeWorkspaceModels();
  return finishAgentHookTeardown(retry, {
    models, caches: cachesLeft, entries: entriesLeft, removing: entriesLeft.length > 0 ? config : undefined,
    // The lines of models files the teardown deleted, with any an earlier run could not write.
    blocks: [...blocks, ...await releaseModelKeyLines()],
  });
}

/** Whether the teardown uninstalled every entry of a workspace, so its cache can go. */
function emptiedWorkspace(scopeManifest: ManifestScope | undefined): boolean {
  return (['skill', 'rule', 'claudemd'] as const).every((kind) => Object.keys(scopeManifest?.[manifestKind(kind)] ?? {}).length === 0);
}

/**
 * Remove the cache the agent kept inside a workspace with no project config,
 * with the untracked `.gitignore` it wrote for it and the directories left
 * empty, once the teardown uninstalled every entry of the workspace (#915). A
 * cache an entry could not be removed from stays, hidden by that file, whose
 * line then stays too. False when the cache could not be deleted.
 */
async function removeWorkspaceCache(workspacePath: string): Promise<boolean> {
  const teamaiDir = path.join(workspacePath, '.teamai');
  const repoPath = await getResourceRepoPath('project', workspacePath);
  if (!repoPath.startsWith(teamaiDir + path.sep)) return true;
  const cache = path.dirname(repoPath);
  try {
    await remove(cache);
    const gitignore = await workspaceCacheGitignore(workspacePath, repoPath);
    // One the member committed is theirs now; one git cannot judge stays, with the record for the retry.
    if (gitignore && (await gitTracks(gitignore, 'entry')).kind !== 'tracked') {
      if (!await gitUntracked(gitignore, 'entry')) {
        log.warn(`Kept ${gitignore}: git could not say whether this repository tracks it.`);
        return false;
      }
      await remove(gitignore);
    }
    for (let dir = path.dirname(cache); dir.startsWith(teamaiDir); dir = path.dirname(dir)) {
      if ((await fse.readdir(dir)).length > 0) break;
      await fse.rmdir(dir);
    }
    return true;
  } catch (e) {
    log.warn(`Could not remove the local agent's cache in ${teamaiDir}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * What an earlier run that disabled the source could not remove: agent hooks
 * (#993), or the `local-agent` block in an exclude file it records (#915).
 */
async function disabledSourceLeftovers(): Promise<boolean> {
  if (Object.keys(await loadAgentHookManifest()).length > 0) return true;
  // A teardown keeps these only for what it could not remove.
  if (await pathExists(getModelManifestPath()) || await pathExists(getManifestPath())) return true;
  for (const owner of [localAgentGitExcludeOwner(), credentialsGitExcludeOwner()]) {
    // A record that cannot be read may name blocks still in place.
    const files = await owner.record?.files().then((list) => list, () => null);
    if (files === null || (files?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Clear the HTTP source, preserving failed hook records for a retry, and the
 * record of exclude files still holding a teamai block (#915), so the next
 * `source remove-http` or `teamai uninstall` finds them. So do models files
 * and workspace caches `left` names: the manifests that name them stay.
 */
async function finishAgentHookTeardown(
  retry: string,
  left: { models: string[]; caches: string[]; entries?: string[]; removing?: LocalAgentConfig; blocks?: string[] } = { models: [], caches: [] },
): Promise<'removed' | 'incomplete'> {
  const entries = left.entries ?? [];
  const blocks = [...new Set(left.blocks ?? [])];
  const hooksLeft = await removeAllAgentHooks();
  const home = getLocalAgentHome();
  const keep = new Set([path.basename(getConfigPath())]);
  if (hooksLeft.length > 0) keep.add(path.basename(getAgentHookManifestPath()));
  if (left.models.length > 0) keep.add(path.basename(getModelManifestPath()));
  if (left.caches.length > 0 || entries.length > 0) keep.add(path.basename(getManifestPath()));
  const gitExcludeRecord = path.join(home, 'git-exclude.json');
  // A record that cannot be read may name blocks still in place: it stays.
  const recorded = await readFileIfExists(gitExcludeRecord).then((raw) => raw === null ? {} : JSON.parse(raw) as unknown).catch(() => null);
  if (!recorded || typeof recorded !== 'object' || Object.keys(recorded).length > 0) keep.add(path.basename(gitExcludeRecord));
  await writeJsonAtomic(getConfigPath(), left.removing ? { disabled: true, removing: left.removing } : { disabled: true });
  for (const entry of await fse.readdir(home)) {
    if (!keep.has(entry)) await remove(path.join(home, entry));
  }
  const held = [
    ...hooksLeft.length > 0 ? [`agent hooks ${hooksLeft.map((h) => `${h.slug} (${h.tool})`).join(', ')}`] : [],
    ...left.models.length > 0 ? [`teamai's models in ${left.models.join(', ')}`] : [],
    ...left.caches.length > 0 ? [`the local agent's cache in ${left.caches.map((dir) => path.join(dir, '.teamai')).join(', ')}`] : [],
    ...entries.length > 0 ? [`the installs ${entries.join(', ')}`] : [],
    ...blocks.length > 0 ? [`teamai's git exclude blocks in ${blocks.join(', ')}`] : [],
  ];
  if (held.length > 0) {
    log.warn(`HTTP source disabled, but removal is incomplete: kept the record of ${held.join('; ')} `
      + `in ${home}, as they could not be removed. Fix the files named above, then run \`${retry}\` again.`);
    process.exitCode = 1;
    return 'incomplete';
  }
  log.success('HTTP source removed (resources uninstalled, config cleared).');
  return 'removed';
}

export async function bindCurrentProject(options?: { projectId?: number; skip?: boolean; cwd?: string }): Promise<void> {
  const workspacePath = await resolveWorkspacePath(options?.cwd ?? process.cwd());
  if (!workspacePath) {
    throw new Error('Cannot resolve current workspace path.');
  }
  if (options?.skip) {
    const config = await loadLocalAgentConfig();
    if (!config) {
      throw new Error('Local agent not initialized. Run `teamai init --http` first.');
    }
    // Skip the whole project (main checkout + all its worktrees), not just this
    // one checkout, so sibling worktrees are not re-prompted.
    await persistWorkspaceBinding(config, options?.cwd ?? process.cwd(), workspacePath, 0, '__skipped__');
    log.info(`已跳过绑定，以后不再提示此工作区。`);
    return;
  }
  const binding = await bindWorkspaceToProject(workspacePath, options?.projectId);
  if (!binding) {
    log.info('未绑定项目。');
  }
}

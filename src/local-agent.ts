import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fse from 'fs-extra';
import YAML from 'yaml';
import { log } from './utils/logger.js';
import {
  ensureDir,
  listDirs,
  listFilesRecursive,
  pathExists,
  readFileSafe,
  readJson,
  remove,
  writeFile,
  writeJson,
} from './utils/fs.js';
import { ResourceHandler } from './resources/base.js';
import { RulesHandler, SkillsHandler } from './resources/index.js';
import { injectHooksToAllTools } from './hooks.js';
import { parseHookEvent } from './dashboard-collector.js';
import { getAgentVersion } from './agent-version.js';
import { getMachineId, deriveLocalAgentId } from './machine-id.js';
import { EXCLUDED_RULE_NAMES } from './builtin-rules.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import { logHttpRequest, logHttpResponse } from './utils/http-log.js';
import { reconcilePlugins, teardownAllPlugins, parseGetConfig, substituteVars, unresolvedPlaceholders, type ReconcileDeps, type PluginState } from './plugin-lifecycle.js';
import {
  TEAMAI_HOME,
  TEAMAI_TOKEN_PATH,
  TEAMAI_CLAUDEMD_START,
  TEAMAI_CLAUDEMD_END,
  TeamaiConfigSchema,
  type DashboardEvent,
  type LocalConfig,
  type Scope,
  type TeamaiConfig,
} from './types.js';

const execFileAsync = promisify(execFile);

const LOCAL_AGENT_DIR = 'local-agent';
const CONFIG_FILE = 'config.json';
const MANIFEST_FILE = 'manifest.json';
const REPORTER_ERROR_LOG = 'reporter/errors.jsonl';

type LocalAgentScope = 'instance' | 'user' | 'project';
type ResourceKind = 'skills' | 'rules' | 'claudemd';
type CommandResourceKind = 'skill' | 'rule' | 'claudemd';

interface WorkspaceBinding {
  groupId: number;
  groupName?: string;
  boundAt: string;
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
  userGroups: '/api/user-groups/mine',
  report: '/api/local-agent/report',
  sync: '/api/local-agent/sync',
  ack: '/api/local-agent/commands/ack',
  getConfig: '/api/local-agent/get-config',
} as const;

export type RouteName = keyof typeof DEFAULT_ROUTES;

interface LocalAgentGroup {
  id: number;
  name: string;
  is_primary?: boolean;
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
  scope?: LocalAgentScope;
  workspace_path?: string;
  download_url?: string;
  skill_slug?: string;
  skill_version?: string;
  rule_slug?: string;
  rule_version?: string;
  rule_type?: string;
  claudemd_slug?: string;
  claudemd_version?: string;
  resource_slug?: string;
  resource_version?: string;
  slug?: string;
  name?: string;
  version?: string;
  display_name?: string;
}

interface LocalAgentContext {
  cwd?: string;
  tool?: string;
  status?: string;
  event?: DashboardEvent;
}

function getTeamaiHomePath(): string {
  return path.join(process.env.HOME ?? '', '.teamai');
}

function getLocalAgentHome(): string {
  return path.join(getTeamaiHomePath(), LOCAL_AGENT_DIR);
}

function getConfigPath(): string {
  return path.join(getLocalAgentHome(), CONFIG_FILE);
}

function getManifestPath(): string {
  return path.join(getLocalAgentHome(), MANIFEST_FILE);
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
  const home = process.env.HOME ?? '';
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

export async function loadLocalAgentConfig(): Promise<LocalAgentConfig | null> {
  const fileConfig = await readJson<LocalAgentConfig>(getConfigPath());
  if (fileConfig?.endpoint) {
    return {
      ...fileConfig,
      endpoint: normalizeEndpoint(fileConfig.endpoint),
      workspaceBindings: fileConfig.workspaceBindings ?? {},
    };
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
  await writeJson(getConfigPath(), {
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

function createResourceLocalConfig(
  config: LocalAgentConfig,
  scope: LocalAgentScope,
  repoPath: string,
  workspacePath?: string,
): LocalConfig {
  const projectScope = scope === 'project';
  return {
    repo: { localPath: repoPath, remote: config.endpoint },
    username: os.userInfo().username,
    scope: projectScope ? 'project' : 'user',
    projectRoot: projectScope ? workspacePath : undefined,
    additionalRoles: [],
  };
}

function getResourceRepoPath(scope: LocalAgentScope, workspacePath?: string): string {
  if (scope === 'project' && workspacePath) {
    return path.join(workspacePath, '.teamai', LOCAL_AGENT_DIR, 'resources');
  }
  return path.join(getLocalAgentHome(), 'resources', scope);
}

async function ensureProjectGitignore(workspacePath: string): Promise<void> {
  const teamaiDir = path.join(workspacePath, '.teamai');
  await ensureDir(teamaiDir);
  const gitignorePath = path.join(teamaiDir, '.gitignore');
  const existing = await readFileSafe(gitignorePath);
  if (!existing) {
    await writeFile(gitignorePath, ['# teamai local state', 'local-agent/', ''].join('\n'));
    return;
  }
  if (!existing.split('\n').some((line) => line.trim() === 'local-agent/')) {
    await writeFile(gitignorePath, existing.trimEnd() + '\nlocal-agent/\n');
  }
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
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  logHttpRequest(tag, method, url, headers, init?.body);

  const response = await fetch(url, { ...init, headers });
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

export async function fetchUserGroups(config: LocalAgentConfig): Promise<LocalAgentGroup[]> {
  const response = await localAgentFetch<{ ok?: boolean; groups?: LocalAgentGroup[] }>(
    config,
    localAgentTag({}),
    'userGroups',
    { method: 'GET' },
  );
  return response.groups ?? [];
}

/** Mask secret values (CLI flags / key=value / bearer tokens) so they don't reach logs. */
function redactSecrets(s: string): string {
  // Secret-bearing identifiers, matched case-insensitively in flag and key=value forms.
  const names = 'secret[_-]?(?:key|id)|api[_-]?key|access[_-]?token|token|password|passwd|pwd';
  return s
    .replace(new RegExp(`(--(?:${names})[= ]+)\\S+`, 'gi'), '$1***')
    .replace(new RegExp(`((?:${names})"?\\s*[:=]\\s*"?)[^"\\s,}]+`, 'gi'), '$1***')
    .replace(/(bearer\s+)[\w.\-]+/gi, '$1***');
}

/**
 * Execute a shell command string with a timeout.
 *
 * Completion is gated on the process 'exit' event, NOT 'close': a setup command that
 * daemonizes and leaves the inherited stderr pipe open in a background process would never
 * emit 'close', producing a false timeout even though the command itself finished.
 * Rejects on non-zero exit, termination by signal, or timeout.
 */
async function execPluginCommand(cmd: string, timeoutMs: number): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', cmd], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn('/bin/sh', ['-lc', cmd], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-8192); });
    const detachStderr = (): void => {
      // Drain and unref the stderr pipe without closing it: a daemonized child may still hold
      // the write end, and closing our read end would send it SIGPIPE. Unref-ing lets this
      // worker process exit without waiting on — or killing — the daemon.
      child.stderr?.removeAllListeners('data');
      child.stderr?.resume();
      (child.stderr as unknown as { unref?: () => void } | undefined)?.unref?.();
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachStderr();
      child.unref();
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
      { detached: true, stdio: 'ignore', env: { ...process.env, TEAMAI_PLUGIN_LOCAL_AGENT_ID: localAgentId } });
    child.unref();
  } catch (e) { log.debug(`[local-agent] plugin reconcile spawn skipped: ${(e as Error).message}`); }
}

/** Detached worker: pull get-config and reconcile plugins once, guarded by a reconcile lock. */
export async function runPluginReconcileWorker(): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (!config) return;
  const lockPath = path.join(getLocalAgentHome(), 'plugin-reconcile.lock');
  await ensureDir(path.dirname(lockPath));
  let acquired = false;
  try {
    try {
      const fd = await fs.promises.open(lockPath, 'wx');
      await fd.close();
      acquired = true;
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      try {
        const st = await fs.promises.stat(lockPath);
        if (Date.now() - st.mtimeMs > 30 * 60 * 1000) {
          await fs.promises.rm(lockPath, { force: true });
          const fd = await fs.promises.open(lockPath, 'wx');
          await fd.close();
          acquired = true;
        }
      } catch { /* ignore */ }
      if (!acquired) return;
    }
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
    if (acquired) await fs.promises.rm(lockPath, { force: true });
  }
}

async function askViaTty(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) {
    const { askQuestion } = await import('./utils/prompt.js');
    return askQuestion(prompt, '');
  }

  if (process.platform === 'win32') return null;

  let fd: number | null = null;
  let input: fs.ReadStream | null = null;
  let output: fs.WriteStream | null = null;
  let rl: readline.Interface | null = null;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
    input = fs.createReadStream('', { fd, autoClose: false });
    output = fs.createWriteStream('', { fd, autoClose: false });
    rl = readline.createInterface({ input, output });
    return await new Promise<string>((resolve) => {
      rl!.question(prompt, (answer) => resolve(answer.trim()));
    });
  } catch {
    return null;
  } finally {
    rl?.close();
    input?.destroy();
    output?.destroy();
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

async function promptForGroupBinding(
  workspacePath: string,
  groups: LocalAgentGroup[],
): Promise<LocalAgentGroup | null> {
  if (groups.length === 0) return null;

  log.debug(`local-agent: workspace not bound: ${workspacePath}`);
  const answer = await askViaTty('是否绑定到一个组织？[y/N] ');
  if (!answer || answer.toLowerCase() !== 'y') return null;

  if (groups.length === 1) return groups[0];

  log.info('可用组织:');
  groups.forEach((group, index) => {
    const suffix = group.is_primary ? ' (默认)' : '';
    log.info(`  ${index + 1}. ${group.name}${suffix} [id=${group.id}]`);
  });

  const primary = groups.find((group) => group.is_primary) ?? groups[0];
  const defaultIndex = groups.indexOf(primary) + 1;
  const selection = await askViaTty(`选择组织编号（默认 ${defaultIndex}，0 跳过）: `);
  if (selection === null || selection === '0') return null;
  const index = selection ? Number.parseInt(selection, 10) : defaultIndex;
  if (Number.isNaN(index) || index < 1 || index > groups.length) return null;
  return groups[index - 1];
}

export async function bindWorkspaceToGroup(
  workspacePath: string,
  groupId?: number,
): Promise<WorkspaceBinding | null> {
  const config = await loadLocalAgentConfig();
  if (!config) {
    throw new Error('HTTP local agent is not initialized. Run `teamai init --http <ENDPOINT> --token <API_TOKEN>` first.');
  }

  const groups = await fetchUserGroups(config);
  const group = groupId
    ? groups.find((item) => item.id === groupId)
    : await promptForGroupBinding(workspacePath, groups);
  if (!group) return null;

  const binding: WorkspaceBinding = {
    groupId: group.id,
    groupName: group.name,
    boundAt: new Date().toISOString(),
  };
  config.workspaceBindings[workspacePath] = binding;
  await saveLocalAgentConfig(config);
  log.success(`已将项目绑定到组织：${group.name} [id=${group.id}]`);
  return binding;
}

async function ensureWorkspaceBinding(
  config: LocalAgentConfig,
  workspacePath: string,
): Promise<void> {
  if (config.workspaceBindings[workspacePath]) return;

  let groups: LocalAgentGroup[];
  try {
    groups = await fetchUserGroups(config);
  } catch (e) {
    log.debug(`local-agent: failed to load user groups: ${(e as Error).message}`);
    return;
  }

  if (groups.length === 0) return;

  const group = await promptForGroupBinding(workspacePath, groups);
  if (group) {
    config.workspaceBindings[workspacePath] = {
      groupId: group.id,
      groupName: group.name,
      boundAt: new Date().toISOString(),
    };
    await saveLocalAgentConfig(config);
    return;
  }

  // TTY prompt failed (running as hook in background) — output context for AI to prompt user
  const groupList = groups.map((g) => `${g.name} (id=${g.id})`).join(', ');
  const context = [
    '[teamai] 当前项目尚未绑定组织，无法接收组织下发的 skills/rules/claudemd 资源。',
    `可用组织: ${groupList}`,
    `请提示用户运行: teamai bind-project`,
    `或指定组织: teamai bind-project --group-id <id>`,
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
 * off by default. Enable it explicitly with `TEAMAI_BIND_PROMPT_ENABLED=1`.
 * The manual `teamai bind-project` command is always available regardless.
 */
function isBindPromptEnabled(): boolean {
  const flag = process.env.TEAMAI_BIND_PROMPT_ENABLED;
  return flag === '1' || flag === 'true';
}

async function emitBindingHint(
  config: LocalAgentConfig,
  workspacePath: string,
): Promise<void> {
  if (config.workspaceBindings[workspacePath]) return;

  // Only hint once per session — use a temp marker file
  const hintMarker = path.join(os.tmpdir(), `teamai-bind-hint-${process.ppid}`);
  if (fs.existsSync(hintMarker)) return;
  try { fs.writeFileSync(hintMarker, ''); } catch {}

  let groups: LocalAgentGroup[];
  try {
    groups = await fetchUserGroups(config);
  } catch {
    return;
  }
  if (groups.length === 0) return;

  const skipNum = groups.length + 1;
  const choices = groups.map((g, i) => `${i + 1}. 绑定到「${g.name}」组织`);
  const actions = groups.map((g, i) => `- 用户回复 ${i + 1} → 执行 \`teamai bind-project --group-id ${g.id}\`，完成后回复"绑定完成，请开新会话生效"`);
  const context = [
    '[ClawPro组织 绑定提示] 你必须原样展示下面的选项列表，不得修改编号或内容。等用户回复数字后执行对应命令。',
    '',
    '---',
    '当前项目未绑定ClawPro组织。绑定后可同步团队 skills/rules。请回复数字选择：',
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

async function resolveWorkspacePath(cwd?: string): Promise<string | undefined> {
  if (!cwd) return undefined;
  const absolute = path.resolve(cwd);
  try {
    const { stdout } = await execFileAsync('git', ['-C', absolute, 'rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    return root ? path.resolve(root) : absolute;
  } catch {
    return absolute;
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
  const files = (await listFilesRecursive(rulesDir)).filter((f) => f.endsWith('.md'));
  const results: ReportedResource[] = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
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


export async function buildReportPayload(
  config: LocalAgentConfig,
  context: LocalAgentContext,
): Promise<Record<string, unknown>> {
  const manifest = await loadManifest();
  const workspacePath = await resolveWorkspacePath(context.cwd);
  const binding = workspacePath ? config.workspaceBindings[workspacePath] : undefined;

  // Resource discovery scans the tool's on-disk skills/rules directories rather
  // than the manifest, so locally-installed resources (not just HTTP-distributed
  // ones) are reported. `source` is derived from the manifest: slugs recorded
  // there are `enterprise`, the rest `local`.
  const tool = context.tool ?? 'workbuddy';
  const toolPaths = createLocalAgentTeamConfig(config.endpoint).toolPaths;
  const toolPath = toolPaths[tool];
  const manifestSlugs = collectManifestSlugs(manifest);

  const scanScope = async (baseDir: string): Promise<{ skills: ReportedResource[]; rules: ReportedResource[] }> => {
    if (!toolPath) return { skills: [], rules: [] };
    const skills = toolPath.skills
      ? await scanSkillsFromDisk(path.join(baseDir, toolPath.skills), manifestSlugs.skills)
      : [];
    const rules = toolPath.rules
      ? await scanRulesFromDisk(path.join(baseDir, toolPath.rules), manifestSlugs.rules)
      : [];
    return { skills, rules };
  };

  const userScope = await scanScope(process.env.HOME ?? '');

  const payload: Record<string, unknown> = {
    agent_type: tool,
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
    user_level: {
      group_id: config.userGroupId,
      skills: userScope.skills,
      rules: userScope.rules,
    },
  };

  if (workspacePath) {
    const wsScope = await scanScope(workspacePath);
    payload.workspaces = [
      {
        path: workspacePath,
        name: path.basename(workspacePath),
        ide_type: tool,
        group_id: binding?.groupId,
        skills: wsScope.skills,
        rules: wsScope.rules,
      },
    ];
  }

  return payload;
}

async function buildSyncPayload(
  config: LocalAgentConfig,
  context: LocalAgentContext,
): Promise<Record<string, unknown>> {
  const workspacePath = await resolveWorkspacePath(context.cwd);
  const binding = workspacePath ? config.workspaceBindings[workspacePath] : undefined;
  const payload: Record<string, unknown> = {
    agent_type: context.tool ?? 'workbuddy',
    local_agent_id: resolveLocalAgentId(context),
    status: context.status ?? 'running',
  };
  if (workspacePath) {
    payload.workspaces = [
      {
        path: workspacePath,
        name: path.basename(workspacePath),
        ide_type: context.tool ?? 'workbuddy',
        group_id: binding?.groupId,
      },
    ];
  }
  return payload;
}

function commandKind(command: LocalAgentCommand): CommandResourceKind | null {
  if (command.rule_type === 'prompt') return 'claudemd';
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
  for (let hop = 0; ; hop++) {
    response = await fetch(current, { redirect: 'manual' });
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
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
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

  const repoPath = getResourceRepoPath(input.scope, input.workspacePath);
  if (input.scope === 'project' && input.workspacePath) {
    await ensureProjectGitignore(input.workspacePath);
  }
  await ensureDir(repoPath);

  const downloadedPath = await downloadResource(input.command.download_url);
  try {
    const fullTeamConfig = createLocalAgentTeamConfig(input.config.endpoint);
    const tool = input.tool ?? 'workbuddy';
    const toolPath = fullTeamConfig.toolPaths[tool];
    if (!toolPath) {
      throw new Error(`Unknown tool "${tool}": no toolPaths entry found`);
    }
    const teamConfig = { ...fullTeamConfig, toolPaths: { [tool]: toolPath } };
    const localConfig = createResourceLocalConfig(input.config, input.scope, repoPath, input.workspacePath);
    const now = new Date().toISOString();
    let displayName = input.command.display_name ?? input.slug;
    // On-disk skill directory name (SKILL.md name when it differs from slug).
    // Stays the slug for rules/claudemd. Recorded in the manifest so uninstall
    // can find the directory by slug.
    let skillDirName = input.slug;

    if (input.kind === 'skill') {
      const extractDir = await extractZip(downloadedPath);
      const skillRoot = await findSkillRoot(extractDir);
      skillDirName = await resolveSkillDirName(skillRoot, input.slug);
      const dest = path.join(repoPath, 'skills', skillDirName);
      await remove(dest);
      await fse.copy(skillRoot, dest, { overwrite: true });
      const fm = await readFrontmatter(path.join(dest, 'SKILL.md'));
      displayName = typeof fm.name === 'string' ? fm.name : displayName;
      await new SkillsHandler().pullItem({
        name: skillDirName,
        type: 'skills',
        sourcePath: dest,
        relativePath: `skills/${skillDirName}`,
      }, teamConfig, localConfig);
    } else if (input.kind === 'rule') {
      const ruleFile = await resolveMarkdownFromDownload(downloadedPath, input.slug);
      const dest = path.join(repoPath, 'rules', `${input.slug}.md`);
      await fse.ensureDir(path.dirname(dest));
      await fse.copyFile(ruleFile, dest);
      await new RulesHandler().pullAllRules(teamConfig, localConfig);
    } else {
      const mdFile = await resolveMarkdownFromDownload(downloadedPath, input.slug);
      const dest = path.join(repoPath, 'claudemd', `${input.slug}.md`);
      await fse.ensureDir(path.dirname(dest));
      await fse.copyFile(mdFile, dest);
      await syncClaudemd(teamConfig, localConfig, repoPath);
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
    };
    await saveManifest(manifest);
    return version;
  } finally {
    await remove(path.dirname(downloadedPath));
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
  const repoPath = getResourceRepoPath(input.scope, input.workspacePath);
  const fullTeamConfig = createLocalAgentTeamConfig(input.config.endpoint);
  const tool = input.tool ?? 'workbuddy';
  const toolPath = fullTeamConfig.toolPaths[tool];
  if (!toolPath) {
    throw new Error(`Unknown tool "${tool}": no toolPaths entry found`);
  }
  const teamConfig = { ...fullTeamConfig, toolPaths: { [tool]: toolPath } };
  const localConfig = createResourceLocalConfig(input.config, input.scope, repoPath, input.workspacePath);
  const manifest = await loadManifest();
  const scopeManifest = getManifestScope(manifest, input.scope, input.workspacePath);

  if (input.kind === 'skill') {
    // The directory was created under the SKILL.md name (recorded as dir_name);
    // remove by that name, falling back to the slug for older installs.
    const dirName = scopeManifest.skills[input.slug]?.dir_name ?? input.slug;
    await new SkillsHandler().removeItem(dirName, teamConfig, localConfig);
  } else if (input.kind === 'rule') {
    await new RulesHandler().removeItem(input.slug, teamConfig, localConfig);
  } else {
    await remove(path.join(repoPath, 'claudemd', `${input.slug}.md`));
    await syncClaudemd(teamConfig, localConfig, repoPath);
  }

  delete scopeManifest[manifestKind(input.kind)][input.slug];
  await saveManifest(manifest);
}

async function syncClaudemd(
  teamConfig: TeamaiConfig,
  localConfig: LocalConfig,
  repoPath: string,
): Promise<void> {
  const claudemdDir = path.join(repoPath, 'claudemd');
  const files = (await pathExists(claudemdDir))
    ? (await fse.readdir(claudemdDir)).filter((file) => file.endsWith('.md')).sort()
    : [];
  const contents: string[] = [];
  for (const file of files) {
    const content = await readFileSafe(path.join(claudemdDir, file));
    if (content) contents.push(content);
  }
  const block = compileClaudemdBlock(contents);

  const baseDir = localConfig.scope === 'project' && localConfig.projectRoot
    ? localConfig.projectRoot
    : process.env.HOME ?? '';

  for (const [tool, toolPath] of Object.entries(teamConfig.toolPaths)) {
    if (!toolPath.claudemd) continue;
    if (!await ResourceHandler.isToolInstalled(toolPath.claudemd, baseDir)) continue;
    const claudeMdPath = path.join(baseDir, toolPath.claudemd);
    try {
      const { injectClaudeMdSection } = await import('./utils/claudemd.js');
      if (block) {
        await injectClaudeMdSection(claudeMdPath, TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END, block);
        log.debug(`local-agent: synced CLAUDE.md instructions to ${tool}`);
      } else {
        await removeClaudeMdSection(claudeMdPath, TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END);
        log.debug(`local-agent: removed CLAUDE.md instructions from ${tool}`);
      }
    } catch (e) {
      log.warn(`Failed to sync CLAUDE.md instructions to ${tool}: ${(e as Error).message}`);
    }
  }
}

async function removeClaudeMdSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): Promise<void> {
  const existing = await readFileSafe(filePath);
  if (!existing) return;
  const startIdx = existing.indexOf(startMarker);
  const endIdx = existing.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return;
  const before = existing.substring(0, startIdx).replace(/\n+$/, '\n');
  const after = existing.substring(endIdx + endMarker.length).replace(/^\n+/, '\n');
  await writeFile(filePath, (before + after).trimEnd() + '\n');
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

async function executeCommand(
  config: LocalAgentConfig,
  command: LocalAgentCommand,
  context: LocalAgentContext,
): Promise<string | undefined> {
  const kind = commandKind(command);
  const action = commandAction(command);
  if (!kind || !action) {
    throw new Error(`Unsupported command type: ${command.type ?? ''}`);
  }

  const scope = command.scope ?? 'user';
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
): Promise<void> {
  const tag = localAgentTag(context);
  for (const command of commands) {
    try {
      const version = await executeCommand(config, command, context);
      await ackCommand(config, tag, command, 'success', version);
      log.debug(`${tag} command ${command.id} (${command.type ?? ''}) succeeded`);
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
}

export async function reportAndSyncLocalAgent(context: LocalAgentContext): Promise<boolean> {
  const config = await loadLocalAgentConfig();
  if (!config) return false;

  const workspacePath = await resolveWorkspacePath(context.cwd);
  if (isBindPromptEnabled() && workspacePath) {
    if (context.event?.type === 'session_start') {
      await ensureWorkspaceBinding(config, workspacePath);
    }
    if (context.event?.type === 'prompt_submit') {
      await emitBindingHint(config, workspacePath);
    }
  }

  const tag = localAgentTag(context);
  log.debug(`${tag} run: endpoint=${config.endpoint}`);

  if (context.event?.type === 'session_start') {
    await maybeReconcilePlugins(context);
  }

  try {
    const reportPayload = await buildReportPayload(config, context);
    await localAgentFetch(config, tag, 'report', {
      method: 'POST',
      body: JSON.stringify(reportPayload),
    });
    log.debug(`${tag} report OK`);

    const syncPayload = await buildSyncPayload(config, context);
    const syncResponse = await localAgentFetch<{ ok?: boolean; commands?: LocalAgentCommand[] }>(
      config,
      tag,
      'sync',
      { method: 'POST', body: JSON.stringify(syncPayload) },
    );
    const commands = syncResponse.commands ?? [];
    if (commands.length > 0) {
      log.debug(`${tag} sync returned ${commands.length} command(s): ${commands.map((c) => `${c.type}#${c.id}`).join(', ')}`);
      await processCommands(config, commands, context);
    }
    log.debug(`${tag} sync OK (${commands.length} command(s))`);
  } catch (e) {
    const error = (e as Error).message;
    log.error(`${tag} sync FAILED: ${error}`);
    await appendErrorLog({ error, context });
  }

  return true;
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
  const cwd = typeof stdin.cwd === 'string' ? stdin.cwd : event?.cwd ?? process.cwd();
  await reportAndSyncLocalAgent({
    cwd,
    tool,
    status: statusFromEvent(event ?? undefined),
    event: event ?? undefined,
  });
  return null;
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
    await writeTokenFile(TEAMAI_TOKEN_PATH, options.token);
  }

  const teamConfig = createLocalAgentTeamConfig(endpoint);
  await injectHooksToAllTools(teamConfig.toolPaths, process.env.HOME ?? '', options.filterAgents);
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
  boundGroups: Array<{ path: string; groupName?: string; groupId: number }>;
  resourceCounts: { skills: number; rules: number; claudemd: number };
}

/**
 * Describe the configured HTTP local-agent bypass (report/sync/ack), or null when
 * none is configured. Used by `teamai source list` to show the HTTP side channel
 * alongside git cross-team sources.
 */
export async function describeLocalAgent(): Promise<LocalAgentSummary | null> {
  const config = await loadLocalAgentConfig();
  if (!config) return null;

  const boundGroups = Object.entries(config.workspaceBindings)
    // groupId 0 is the "__skipped__" sentinel — not a real binding.
    .filter(([, b]) => b.groupId !== 0)
    .map(([workspacePath, b]) => ({ path: workspacePath, groupName: b.groupName, groupId: b.groupId }));

  const manifest = await loadManifest();
  const counts = { skills: 0, rules: 0, claudemd: 0 };
  for (const scope of Object.values(manifest.scopes)) {
    counts.skills += Object.keys(scope.skills ?? {}).length;
    counts.rules += Object.keys(scope.rules ?? {}).length;
    counts.claudemd += Object.keys(scope.claudemd ?? {}).length;
  }

  return { endpoint: config.endpoint, boundGroups, resourceCounts: counts };
}

/** Parse a manifest scope key back into (scope, workspacePath). */
function parseScopeKey(key: string): { scope: LocalAgentScope; workspacePath?: string } {
  if (key.startsWith('project:')) {
    return { scope: 'project', workspacePath: key.slice('project:'.length) || undefined };
  }
  return { scope: key === 'instance' ? 'instance' : 'user' };
}

/**
 * Tear down the HTTP local-agent bypass: uninstall every resource recorded in the
 * manifest (skills/rules/claudemd, across all scopes) from the AI tool dirs, then
 * remove the whole ~/.teamai/local-agent/ directory (config + manifest).
 *
 * Best-effort per resource: a single failed uninstall is logged and skipped so a
 * stale entry cannot block the teardown.
 */
export async function removeLocalAgentHttp(): Promise<void> {
  const config = await loadLocalAgentConfig();
  if (!config) {
    log.info('No HTTP source configured — nothing to remove.');
    return;
  }

  // Tear down installed plugins before removing teamai's local-agent state.
  try {
    await teardownAllPlugins(buildReconcileDeps(config, '[local-agent] [uninstall]'));
  } catch (e) { log.warn(`[local-agent] plugin teardown failed: ${(e as Error).message}`); }

  const kinds: CommandResourceKind[] = ['skill', 'rule', 'claudemd'];
  const manifest = await loadManifest();
  for (const [key, scopeManifest] of Object.entries(manifest.scopes)) {
    const { scope, workspacePath } = parseScopeKey(key);
    for (const kind of kinds) {
      for (const slug of Object.keys(scopeManifest[manifestKind(kind)] ?? {})) {
        try {
          await uninstallResource({ config, kind, slug, scope, workspacePath });
        } catch (e) {
          log.debug(`local-agent: failed to uninstall ${kind} "${slug}": ${(e as Error).message}`);
        }
      }
    }
  }

  await remove(getLocalAgentHome());
  log.success('HTTP source removed (resources uninstalled, config cleared).');
}

export async function bindCurrentProject(options?: { groupId?: number; skip?: boolean; cwd?: string }): Promise<void> {
  const workspacePath = await resolveWorkspacePath(options?.cwd ?? process.cwd());
  if (!workspacePath) {
    throw new Error('Cannot resolve current workspace path.');
  }
  if (options?.skip) {
    const config = await loadLocalAgentConfig();
    if (!config) {
      throw new Error('Local agent not initialized. Run `teamai init --http` first.');
    }
    config.workspaceBindings[workspacePath] = { groupId: 0, groupName: '__skipped__', boundAt: new Date().toISOString() };
    await saveLocalAgentConfig(config);
    log.info(`已跳过绑定，以后不再提示此项目。`);
    return;
  }
  const binding = await bindWorkspaceToGroup(workspacePath, options?.groupId);
  if (!binding) {
    log.info('未绑定项目。');
  }
}

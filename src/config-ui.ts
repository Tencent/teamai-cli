/**
 * Config WebUI server — a local, zero-dependency console for the team
 * configuration repository (`teamai config ui`, binds 127.0.0.1:3722).
 *
 * Security posture (each item has a test):
 *   1. Binds 127.0.0.1 only — never 0.0.0.0.
 *   2. No Access-Control-Allow-Origin header at all (POST writes must never
 *      be reachable cross-origin).
 *   3. POST only with absent/same-origin Origin; else 403.
 *   4. Host header must be 127.0.0.1/localhost (DNS-rebinding guard); else 403.
 *   5. JSON bodies only, 1 MB cap.
 *   6. Tokens/API keys are never read, hence never returned.
 *   7. All config writes go through applyConfigPatch (zod rejects unknown keys).
 *
 * Read-only toward the team repo clone; the only writes are local config,
 * state.json, and git pin/checkout inside the clone via branch-manager.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import matter from 'gray-matter';
import type { Scope, LocalConfig, TeamaiConfig } from './types.js';
import {
  CONFIG_UI_DEFAULT_PORT,
  getTeamaiHome,
  getHooksSharing,
  resolveBaseDir,
  isAgentDisabled,
  scopedToolPaths,
} from './types.js';
import {
  loadLocalConfigForScope,
  loadStateForScope,
  saveStateForScope,
  detectProjectConfig,
} from './config.js';
import { readConfigBundle, applyConfigPatch, resolveDefaultBranch, NotInitializedError } from './config-service.js';
import { createJobRunner, type JobRunner, type ReinitPlan, JobBusyError } from './config-ui-jobs.js';
import { getConfigUiHtml } from './config-ui-html.js';
import { createGit } from './utils/git.js';
import { loadRolesManifest, listRoleIds, resolveRoleResourceNamespaces } from './roles.js';
import { loadTagsConfig, filterByTags } from './utils/tags.js';
import { getHandler } from './resources/index.js';
import { parseHooksYaml } from './resources/hooks.js';
import { parseTeamMcpServers } from './resources/mcp.js';
import { loadIndex, buildIndex, search, isLegacyIndex } from './utils/search-index.js';
import { assertSafePath } from './utils/path-safety.js';
import { listFilesRecursive, pathExists, readFileSafe } from './utils/fs.js';
import { log } from './utils/logger.js';

const BODY_LIMIT_BYTES = 1024 * 1024; // 1 MB
const LIST_CAP = 500;
const PREVIEW_CAP_BYTES = 200 * 1024; // 200 KB
const RECALL_BUILD_TIMEOUT_MS = 30_000;

// ─── JSON helpers ─────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return; // keep draining so the client can read the response
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        rejected = true;
        chunks.length = 0;
        resolve({ ok: false, status: 413, error: 'request body exceeds 1 MB limit' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve({ ok: true, body: chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid JSON body' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request read error' }));
  });
}

// ─── Server factory ───────────────────────────────────────

export interface ConfigUiDeps {
  port?: number;
  jobs?: JobRunner;
  scope?: Scope;
  projectRoot?: string;
}

export interface ConfigUiServer {
  server: http.Server;
  /** Actual listening port (resolved after start; useful with port 0). */
  port: number;
  scope: Scope;
  projectRoot?: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createConfigUiServer(deps: ConfigUiDeps = {}): Promise<ConfigUiServer> {
  const jobs = deps.jobs ?? createJobRunner();
  const serverCwd = process.cwd();

  // Resolve the server's default scope once: explicit > project config in cwd > user.
  let scope: Scope = deps.scope ?? 'user';
  let projectRoot: string | undefined = deps.projectRoot;
  if (!deps.scope) {
    const project = await detectProjectConfig(serverCwd);
    if (project) {
      scope = 'project';
      projectRoot = serverCwd;
    }
  } else if (scope === 'project' && !projectRoot) {
    projectRoot = serverCwd;
  }

  const listenPort = deps.port ?? CONFIG_UI_DEFAULT_PORT;
  let boundPort = listenPort;

  function requestScope(queryScope: string | null): { scope: Scope; projectRoot?: string } {
    if (queryScope === 'user' || queryScope === 'project') {
      return queryScope === 'project' ? { scope: 'project', projectRoot: projectRoot ?? serverCwd } : { scope: 'user' };
    }
    return { scope, projectRoot };
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
    const method = (req.method ?? 'GET').toUpperCase();

    // ─── Guard: Host + Origin + content-type (see header comment) ───
    const host = String(req.headers.host ?? '');
    const hostOk =
      host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}` ||
      host === '127.0.0.1' || host === 'localhost' || host === `[::1]:${boundPort}` || host === '[::1]';
    if (!hostOk) {
      sendJson(res, 403, { error: 'Forbidden: Host header is not a local address' });
      return;
    }
    if (method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const originOk =
          origin === `http://127.0.0.1:${boundPort}` ||
          origin === `http://localhost:${boundPort}` ||
          origin === `http://[::1]:${boundPort}`;
        if (!originOk) {
          sendJson(res, 403, { error: 'Forbidden: cross-origin POST rejected' });
          return;
        }
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      if (contentType !== 'application/json') {
        sendJson(res, 415, { error: 'Unsupported Media Type: application/json required' });
        return;
      }
    }
    if (method !== 'GET' && method !== 'POST') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    const route = url.pathname;

    // ─── HTML ─────────────────────────────────────────────
    if (route === '/' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getConfigUiHtml(boundPort));
      return;
    }

    try {
      // ─── Repo overview ─────────────────────────────────
      if (route === '/api/repo' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 200, { initialized: false, scope: s, remote: null, provider: null, kind: null, localPath: null, username: null, trackedBranch: null, defaultBranch: null, state: null, health: null });
          return;
        }
        const teamConfig = await loadTeamConfigSafe(localConfig);
        const state = await loadStateForScope(s, pr);
        const { configuredBranch } = await import('./utils/branch-manager.js');
        const trackedBranch = configuredBranch(localConfig);
        const defaultBranch = state.teamRepoDefaultBranch
          ?? (await resolveDefaultBranch(localConfig.repo.localPath, localConfig.repo.kind));
        const health = await repoHealth(localConfig, trackedBranch, defaultBranch);
        sendJson(res, 200, {
          initialized: true,
          scope: s,
          remote: localConfig.repo.remote,
          provider: teamConfig?.provider ?? null,
          kind: localConfig.repo.kind ?? 'git',
          localPath: localConfig.repo.localPath,
          username: localConfig.username,
          trackedBranch,
          defaultBranch,
          state: {
            lastPull: state.lastPull,
            lastPush: state.lastPush,
            pendingPushes: state.pendingPushes.length,
          },
          health,
        });
        return;
      }

      // ─── Remote branches ───────────────────────────────
      if (route === '/api/repo/branches' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        const kind = localConfig.repo.kind ?? 'git';
        if (kind !== 'git') {
          sendJson(res, 409, { error: `branch listing requires a git team repo (current kind: ${kind})` });
          return;
        }
        const { configuredBranch } = await import('./utils/branch-manager.js');
        const state = await loadStateForScope(s, pr);
        try {
          const branches = await lsRemoteHeads(localConfig.repo.localPath);
          sendJson(res, 200, {
            kind,
            currentTracked: configuredBranch(localConfig),
            defaultBranch: state.teamRepoDefaultBranch
              ?? (await resolveDefaultBranch(localConfig.repo.localPath, kind)),
            branches,
          });
        } catch (e) {
          sendJson(res, 502, { error: `git ls-remote failed: ${(e as Error).message}` });
        }
        return;
      }

      // ─── Re-init job ───────────────────────────────────
      if (route === '/api/repo/reinit' && method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        const body = parsed.body as { branch?: unknown; scope?: unknown; force?: unknown };
        const { scope: s, projectRoot: pr } = requestScope(typeof body.scope === 'string' ? body.scope : null);
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        const kind = localConfig.repo.kind ?? 'git';
        if (kind !== 'git') {
          sendJson(res, 400, { error: `branch re-init requires a git team repo (current kind: ${kind})` });
          return;
        }
        const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : null;
        const force = body.force === true;

        // Ref-injection guard: user input only ever reaches git as a value
        // validated against the ls-remote whitelist.
        let branches: Array<{ name: string; sha: string }>;
        try {
          branches = await lsRemoteHeads(localConfig.repo.localPath);
        } catch (e) {
          sendJson(res, 502, { error: `git ls-remote failed: ${(e as Error).message}` });
          return;
        }
        if (branch !== null && !branches.some((b) => b.name === branch)) {
          sendJson(res, 400, { error: `invalid branch "${branch}"`, branches: branches.map((b) => b.name) });
          return;
        }

        // Snapshot the remote default branch once, so "return to default"
        // stays resolvable after the clone is pinned.
        const state = await loadStateForScope(s, pr);
        if (!state.teamRepoDefaultBranch) {
          const def = await resolveDefaultBranch(localConfig.repo.localPath, kind);
          if (def) {
            state.teamRepoDefaultBranch = def;
            await saveStateForScope(state, s, pr);
          }
        }

        // Dirty-worktree check (mirror semantics; discarded commits stay in reflog).
        let dirtyFiles: string[] = [];
        try {
          const git = createGit(localConfig.repo.localPath);
          const statusOut = await git.raw(['status', '--porcelain']);
          dirtyFiles = statusOut.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        } catch {
          dirtyFiles = [];
        }
        if (dirtyFiles.length > 0 && !force) {
          sendJson(res, 409, {
            error: 'team repo clone has uncommitted changes; retry with force to discard them',
            dirtyFiles: dirtyFiles.slice(0, 50),
          });
          return;
        }

        const plan: ReinitPlan = {
          remote: localConfig.repo.remote, // pinned — the API accepts no repo URL
          branch,
          scope: s,
          primaryRole: localConfig.primaryRole,
          agents: localConfig.enabledAgents ?? [],
          cwd: serverCwd,
        };
        try {
          const jobId = jobs.startReinit(plan);
          sendJson(res, 202, { jobId });
        } catch (e) {
          if (e instanceof JobBusyError) {
            sendJson(res, 409, { error: 'another job is already running' });
          } else {
            throw e;
          }
        }
        return;
      }

      // ─── Sync job ──────────────────────────────────────
      if (route === '/api/sync' && method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        try {
          const jobId = jobs.startSync(serverCwd);
          sendJson(res, 202, { jobId });
        } catch (e) {
          if (e instanceof JobBusyError) {
            sendJson(res, 409, { error: 'another job is already running' });
          } else {
            throw e;
          }
        }
        return;
      }

      // ─── Job polling ───────────────────────────────────
      const jobMatch = route.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
      if (jobMatch && method === 'GET') {
        const job = jobs.get(jobMatch[1]);
        if (!job) {
          sendJson(res, 404, { error: 'job not found' });
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      // ─── Config bundle / patch ─────────────────────────
      if (route === '/api/config' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        try {
          const bundle = await readConfigBundle(s, pr);
          sendJson(res, 200, bundle);
        } catch (e) {
          if (e instanceof NotInitializedError) {
            sendJson(res, 400, { error: e.message });
          } else {
            throw e;
          }
        }
        return;
      }

      if (route === '/api/config' && method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        const body = parsed.body as { scope?: unknown; updates?: unknown; sync?: unknown };
        const { scope: s, projectRoot: pr } = requestScope(typeof body.scope === 'string' ? body.scope : null);
        if (!body.updates || typeof body.updates !== 'object' || Array.isArray(body.updates)) {
          sendJson(res, 400, { error: 'updates must be an object of {field: value}' });
          return;
        }
        try {
          const result = await applyConfigPatch(s, body.updates as Record<string, unknown>, pr);
          if (!result.ok) {
            sendJson(res, 400, result);
            return;
          }
          const response: Record<string, unknown> = { ok: true, config: result.config, errors: result.errors };
          if (body.sync === true) {
            try {
              response.jobId = jobs.startSync(serverCwd);
            } catch {
              response.syncSkipped = 'another job is already running';
            }
          }
          sendJson(res, 200, response);
        } catch (e) {
          if (e instanceof NotInitializedError) {
            sendJson(res, 400, { error: e.message });
          } else {
            throw e;
          }
        }
        return;
      }

      // ─── Roles ─────────────────────────────────────────
      if (route === '/api/roles' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        let manifest;
        try {
          manifest = await loadRolesManifest(localConfig.repo.localPath);
        } catch (e) {
          sendJson(res, 404, { error: `roles manifest unavailable: ${(e as Error).message}` });
          return;
        }
        sendJson(res, 200, await rolesView(manifest, localConfig));
        return;
      }

      if (route === '/api/roles/bind' && method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) {
          sendJson(res, parsed.status, { error: parsed.error });
          return;
        }
        const body = parsed.body as { scope?: unknown; primaryRole?: unknown; additionalRoles?: unknown };
        const { scope: s, projectRoot: pr } = requestScope(typeof body.scope === 'string' ? body.scope : null);
        const updates: Record<string, unknown> = {};
        if ('primaryRole' in body) updates.primaryRole = body.primaryRole;
        if ('additionalRoles' in body) updates.additionalRoles = body.additionalRoles;
        if (Object.keys(updates).length === 0) {
          sendJson(res, 400, { error: 'nothing to bind: provide primaryRole or additionalRoles' });
          return;
        }
        let localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        try {
          const result = await applyConfigPatch(s, updates, pr);
          if (!result.ok) {
            let roleIds: string[] = [];
            try {
              roleIds = listRoleIds(await loadRolesManifest(localConfig.repo.localPath));
            } catch { /* manifest unavailable */ }
            sendJson(res, 400, { ok: false, errors: result.errors, roles: roleIds });
            return;
          }
          localConfig = result.config ?? localConfig;
          let manifest;
          try {
            manifest = await loadRolesManifest(localConfig.repo.localPath);
          } catch {
            sendJson(res, 200, { binding: bindingView(localConfig), hint: 'changes take effect on next pull' });
            return;
          }
          sendJson(res, 200, {
            binding: bindingView(localConfig),
            effective: effectiveView(manifest, localConfig),
            hint: 'changes take effect on next pull',
          });
        } catch (e) {
          if (e instanceof NotInitializedError) {
            sendJson(res, 400, { error: e.message });
          } else {
            throw e;
          }
        }
        return;
      }

      // ─── Resources inventory ───────────────────────────
      if (route === '/api/resources' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        const teamConfig = await loadTeamConfigSafe(localConfig);
        sendJson(res, 200, await scanResources(localConfig, teamConfig, s, pr));
        return;
      }

      // ─── Resource preview (dual gate) ──────────────────
      if (route === '/api/resources/preview' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        const type = url.searchParams.get('type') ?? '';
        const id = url.searchParams.get('id') ?? '';
        if (!type || !id) {
          sendJson(res, 400, { error: 'type and id query params are required' });
          return;
        }
        const teamConfig = await loadTeamConfigSafe(localConfig);
        const result = await previewResource(type, id, localConfig, teamConfig, s, pr);
        sendJson(res, result.status, result.body);
        return;
      }

      // ─── Recall search playground ──────────────────────
      if (route === '/api/recall/search' && method === 'GET') {
        const { scope: s, projectRoot: pr } = requestScope(url.searchParams.get('scope'));
        const localConfig = await loadLocalConfigForScope(s, pr);
        if (!localConfig) {
          sendJson(res, 400, { error: 'teamai is not initialized. Run `teamai init` first.' });
          return;
        }
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 5) || 5, 1), 20);
        sendJson(res, 200, await recallSearch(localConfig, s, pr, q, limit));
        return;
      }

      sendJson(res, 404, { error: `not found: ${method} ${route}` });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  }

  return {
    server,
    /** Requested port; re-read after start() to get the actual bound port. */
    get port() { return boundPort; },
    scope,
    projectRoot,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', () => {
          const addr = server.address();
          boundPort = typeof addr === 'object' && addr ? addr.port : listenPort;
          resolve();
        });
      });
    },
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** CLI entry: foreground server with graceful shutdown (mirrors dashboard.ts). */
export async function startConfigUi(port?: number, scopeFlag?: string): Promise<void> {
  const serverPort = port ?? CONFIG_UI_DEFAULT_PORT;
  const scope = scopeFlag === 'user' || scopeFlag === 'project' ? scopeFlag : undefined;

  let ui: ConfigUiServer;
  try {
    ui = await createConfigUiServer({ port: serverPort, scope });
    await ui.start();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      log.error(`Port ${serverPort} is already in use.`);
      log.info(`Try a different port: teamai config ui --port ${serverPort + 1}`);
      log.info(`Or check what's using it: lsof -i :${serverPort}`);
      process.exit(1);
    }
    throw err;
  }

  log.success(`Config WebUI running at http://127.0.0.1:${ui.port}`);
  log.info(`Scope: ${ui.scope}${ui.projectRoot ? ` (${ui.projectRoot})` : ''} — the server only listens on this machine.`);
  log.info('Press Ctrl+C to stop.');

  const shutdown = () => {
    log.info('\nShutting down Config WebUI...');
    void ui.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Shared helpers ───────────────────────────────────────

async function loadTeamConfigSafe(localConfig: LocalConfig): Promise<TeamaiConfig | null> {
  const { loadTeamConfig } = await import('./config.js');
  return loadTeamConfig(localConfig.repo.localPath);
}

async function lsRemoteHeads(localPath: string): Promise<Array<{ name: string; sha: string }>> {
  const git = createGit(localPath);
  const out = await git.raw(['ls-remote', '--heads', 'origin']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return { sha, name: ref.replace(/^refs\/heads\//, '') };
    });
}

async function repoHealth(
  localConfig: LocalConfig,
  trackedBranch: string | null,
  defaultBranch: string | null,
): Promise<{
  checkoutOk: boolean | null;
  trackingOk: boolean | null;
  originHeadOk: boolean | null;
  ahead: number | null;
  behind: number | null;
} | null> {
  const kind = localConfig.repo.kind ?? 'git';
  if (kind !== 'git') return null;
  const git = createGit(localConfig.repo.localPath);
  const target = trackedBranch ?? defaultBranch;
  if (!target) {
    return { checkoutOk: null, trackingOk: null, originHeadOk: null, ahead: null, behind: null };
  }
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try { return await fn(); } catch { return null; }
  };
  const current = await safe(() => git.revparse(['--abbrev-ref', 'HEAD']));
  const checkoutOk = current === null ? null : current.trim() === target;
  const branches = await safe(() => git.branch());
  const tracking = branches === null ? null : (branches.branches[target] as { tracking?: string } | undefined)?.tracking ?? null;
  const trackingOk = tracking === null ? null : tracking === `origin/${target}`;
  const head = await safe(() => git.revparse(['--abbrev-ref', 'origin/HEAD']));
  const originHeadOk = head === null ? null : head.trim() === `origin/${target}`;
  const counts = await safe(() => git.raw(['rev-list', '--left-right', '--count', `HEAD...origin/${target}`]));
  let ahead: number | null = null;
  let behind: number | null = null;
  if (counts) {
    const [a, b] = counts.trim().split(/\s+/).map(Number);
    ahead = Number.isFinite(a) ? a : null;
    behind = Number.isFinite(b) ? b : null;
  }
  return { checkoutOk, trackingOk, originHeadOk, ahead, behind };
}

// ─── Roles view ───────────────────────────────────────────

function bindingView(localConfig: LocalConfig) {
  return {
    primaryRole: localConfig.primaryRole ?? null,
    additionalRoles: localConfig.additionalRoles ?? [],
    resourceProfileVersion: localConfig.resourceProfileVersion ?? null,
  };
}

function effectiveView(manifest: NonNullable<Awaited<ReturnType<typeof loadRolesManifest>>>, localConfig: LocalConfig) {
  if (!localConfig.primaryRole) return null;
  try {
    const ns = resolveRoleResourceNamespaces({
      manifest,
      primaryRole: localConfig.primaryRole,
      additionalRoles: localConfig.additionalRoles ?? [],
    });
    return { skills: ns.skills, knowledge: ns.knowledge };
  } catch {
    return null;
  }
}

async function rolesView(manifest: NonNullable<Awaited<ReturnType<typeof loadRolesManifest>>>, localConfig: LocalConfig) {
  return {
    version: manifest.version,
    roles: manifest.roles.map((r) => ({
      id: r.id,
      description: r.description,
      skillNamespaces: r.resources.skills,
      knowledgeNamespaces: r.resources.knowledge,
    })),
    binding: {
      ...bindingView(localConfig),
      stale: localConfig.resourceProfileVersion !== undefined
        ? manifest.version !== localConfig.resourceProfileVersion
        : true,
    },
    effective: effectiveView(manifest, localConfig),
  };
}

// ─── Resources scan ───────────────────────────────────────

interface SkillItem { namespace: string | null; name: string; description: string; active: boolean; installed: boolean; excluded: boolean }
interface RuleItem { namespace: string | null; name: string; active: boolean }
interface DocItem { name: string; title: string }
interface EnvItem { name: string; injectShellProfile: boolean }
interface AgentItem { name: string; description: string }
interface HookItem { name: string; description: string; autoApply: boolean; requireTeamScripts: boolean; command: string }
interface McpItem { name: string; transport: string }
interface RecallEntry { title: string; path: string; domain: string | null; updatedAt: string }

export interface ResourcesResponse {
  skills: { count: number; truncated?: boolean; items: SkillItem[] };
  rules: { count: number; truncated?: boolean; items: RuleItem[] };
  docs: { count: number; truncated?: boolean; items: DocItem[] };
  env: { count: number; truncated?: boolean; items: EnvItem[] };
  agents: { count: number; truncated?: boolean; items: AgentItem[] };
  hooks: { count: number; truncated?: boolean; items: HookItem[] };
  mcp: { count: number; truncated?: boolean; items: McpItem[] };
  culture: { present: boolean; path?: string };
  roles: { count: number; ids: string[] };
  recall: { indexStatus: 'fresh' | 'stale' | 'missing'; entries: RecallEntry[] };
}

function cap<T>(items: T[]): { items: T[]; truncated: boolean } {
  return items.length > LIST_CAP ? { items: items.slice(0, LIST_CAP), truncated: true } : { items, truncated: false };
}

/** Active skill namespaces for the current binding; null = no roles (all active). */
async function activeSkillNamespaces(localConfig: LocalConfig): Promise<string[] | null> {
  if (!localConfig.primaryRole) return null;
  try {
    const manifest = await loadRolesManifest(localConfig.repo.localPath);
    return resolveRoleResourceNamespaces({
      manifest,
      primaryRole: localConfig.primaryRole,
      additionalRoles: localConfig.additionalRoles ?? [],
    }).skills;
  } catch {
    return [localConfig.primaryRole, ...(localConfig.additionalRoles ?? [])];
  }
}

export async function scanResources(
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig | null,
  scope: Scope,
  projectRoot?: string,
): Promise<ResourcesResponse> {
  const repo = localConfig.repo.localPath;
  const excluded = new Set(localConfig.excludedSkills ?? []);

  // ── skills ──
  const skillItemsFull: SkillItem[] = [];
  try {
    const raw = await getHandler('skills').scanTeamForPull((teamConfig ?? {}) as TeamaiConfig, localConfig);
    const activeNs = await activeSkillNamespaces(localConfig);
    const baseDir = resolveBaseDir(localConfig);
    for (const item of raw) {
      const skillMd = await readFileSafe(path.join(item.sourcePath, 'SKILL.md'));
      let description = '';
      if (skillMd) {
        try { description = String(matter(skillMd).data.description ?? ''); } catch { description = ''; }
      }
      let installed = false;
      if (teamConfig) {
        for (const [tool, toolPath] of Object.entries(scopedToolPaths(teamConfig, localConfig))) {
          if (!toolPath.skills || isAgentDisabled(localConfig, tool)) continue;
          if (await pathExists(path.join(baseDir, toolPath.skills, item.name))) {
            installed = true;
            break;
          }
        }
      }
      skillItemsFull.push({
        namespace: item.namespace ?? null,
        name: item.name,
        description: description.slice(0, 200),
        active: activeNs === null ? true : item.namespace ? activeNs.includes(item.namespace) : true,
        installed,
        excluded: excluded.has(item.name),
      });
    }
  } catch { /* skills dir missing */ }
  const skillsCapped = cap(skillItemsFull.sort((a, b) => a.name.localeCompare(b.name)));

  // ── rules ──
  const ruleItemsFull: RuleItem[] = [];
  try {
    const raw = await getHandler('rules').scanTeamForPull((teamConfig ?? {}) as TeamaiConfig, localConfig);
    const tagsConfig = await loadTagsConfig(repo);
    const { included } = filterByTags(raw, tagsConfig, localConfig.subscribedTags, 'rules');
    const activeSet = new Set(included.map((i) => i.name));
    for (const item of raw) {
      ruleItemsFull.push({
        namespace: item.name.includes('/') ? item.name.split('/')[0] : null,
        name: item.name,
        active: activeSet.has(item.name),
      });
    }
  } catch { /* rules dir missing */ }
  const rulesCapped = cap(ruleItemsFull);

  // ── docs ──
  const docItemsFull: DocItem[] = [];
  try {
    const docsDir = path.join(repo, 'docs');
    if (await pathExists(docsDir)) {
      const files = await listFilesRecursive(docsDir);
      for (const file of files) {
        if (!file.endsWith('.md') || file.startsWith('.')) continue;
        let title = '';
        const content = await readFileSafe(path.join(docsDir, file));
        if (content) {
          try { title = String(matter(content).data.title ?? ''); } catch { title = ''; }
        }
        docItemsFull.push({ name: file.replace(/\.md$/, ''), title: title.slice(0, 120) });
      }
    }
  } catch { /* docs dir missing */ }
  const docsCapped = cap(docItemsFull);

  // ── env (names + policy only — values are NEVER included) ──
  const envItemsFull: EnvItem[] = [];
  try {
    const envYaml = await readFileSafe(path.join(repo, 'env', 'env.yaml'));
    if (envYaml) {
      const parsedEnv = YAML.parse(envYaml) as { variables?: Array<{ key?: unknown }> } | null;
      const inject = teamConfig?.sharing.env.injectShellProfile ?? true;
      for (const v of parsedEnv?.variables ?? []) {
        if (typeof v.key === 'string' && v.key) {
          envItemsFull.push({ name: v.key, injectShellProfile: inject });
        }
      }
    }
  } catch { /* env.yaml missing */ }
  const envCapped = cap(envItemsFull);

  // ── agents ──
  const agentItemsFull: AgentItem[] = [];
  try {
    const raw = await getHandler('agents').scanTeamForPull((teamConfig ?? {}) as TeamaiConfig, localConfig);
    for (const item of raw) {
      let description = '';
      const content = await readFileSafe(item.sourcePath);
      if (content) {
        try {
          const data = YAML.parse(content) as { description?: unknown } | null;
          if (typeof data?.description === 'string') description = data.description;
        } catch { /* unparseable — leave empty */ }
      }
      agentItemsFull.push({ name: item.name, description: description.slice(0, 200) });
    }
  } catch { /* agents dir missing */ }
  const agentsCapped = cap(agentItemsFull);

  // ── hooks ──
  const hookItemsFull: HookItem[] = [];
  try {
    const parsed = await parseHooksYaml(repo);
    const policy = getHooksSharing(teamConfig ?? {});
    for (const h of parsed?.hooks ?? []) {
      hookItemsFull.push({
        name: h.id,
        description: h.description,
        autoApply: policy.autoApply,
        requireTeamScripts: policy.requireTeamScripts,
        command: h.command,
      });
    }
  } catch { /* hooks.yaml missing */ }
  const hooksCapped = cap(hookItemsFull);

  // ── mcp ──
  const mcpItemsFull: McpItem[] = [];
  try {
    const servers = await parseTeamMcpServers(repo);
    for (const s of servers) {
      mcpItemsFull.push({ name: s.name, transport: s.transport });
    }
  } catch { /* mcp.yaml missing */ }
  const mcpCapped = cap(mcpItemsFull);

  // ── culture ──
  const culturePath = path.join(repo, 'culture.md');
  const culturePresent = await pathExists(culturePath);

  // ── roles ──
  let roleIds: string[] = [];
  try {
    roleIds = listRoleIds(await loadRolesManifest(repo));
  } catch { roleIds = []; }

  // ── recall ──
  const indexPath = path.join(getTeamaiHome(scope, projectRoot), 'search-index.json');
  const index = await loadIndex(indexPath);
  const indexStatus = !index ? 'missing' : isLegacyIndex(index) ? 'stale' : 'fresh';
  const entries = (index?.entries ?? []).slice(0, LIST_CAP).map((e) => ({
    title: e.title,
    path: e.path ?? e.filename,
    domain: e.domain ?? null,
    updatedAt: e.date,
  }));

  return {
    skills: { count: skillItemsFull.length, ...skillsCapped },
    rules: { count: ruleItemsFull.length, ...rulesCapped },
    docs: { count: docItemsFull.length, ...docsCapped },
    env: { count: envItemsFull.length, ...envCapped },
    agents: { count: agentItemsFull.length, ...agentsCapped },
    hooks: { count: hookItemsFull.length, ...hooksCapped },
    mcp: { count: mcpItemsFull.length, ...mcpCapped },
    culture: culturePresent ? { present: true, path: culturePath } : { present: false },
    roles: { count: roleIds.length, ids: roleIds },
    recall: { indexStatus, entries },
  };
}

// ─── Resource preview (dual gate) ─────────────────────────

const PREVIEW_TYPES = new Set(['skill', 'rule', 'doc', 'agent', 'hook', 'mcp', 'culture', 'role', 'learning', 'env']);

export async function previewResource(
  type: string,
  id: string,
  localConfig: LocalConfig,
  teamConfig: TeamaiConfig | null,
  scope: Scope,
  projectRoot?: string,
): Promise<{ status: number; body: unknown }> {
  if (!PREVIEW_TYPES.has(type)) {
    return { status: 404, body: { error: `unknown preview type "${type}"` } };
  }
  // env values must never be exposed — not even parsed.
  if (type === 'env') {
    return { status: 403, body: { error: 'env variable values cannot be previewed' } };
  }

  const repo = localConfig.repo.localPath;

  // Inline previews (no filesystem access): hook / mcp definitions.
  if (type === 'hook') {
    const parsed = await parseHooksYaml(repo);
    const hook = parsed?.hooks.find((h) => h.id === id);
    if (!hook) return { status: 404, body: { error: `hook "${id}" not found` } };
    return {
      status: 200,
      body: {
        type, id,
        path: 'hooks/hooks.yaml',
        language: 'yaml',
        content: YAML.stringify({ hooks: [stripUndefined(hook)] }),
        truncated: false,
      },
    };
  }
  if (type === 'mcp') {
    const servers = await parseTeamMcpServers(repo);
    const server = servers.find((s) => s.name === id);
    if (!server) return { status: 404, body: { error: `mcp server "${id}" not found` } };
    return {
      status: 200,
      body: {
        type, id,
        path: 'mcp/mcp.yaml',
        language: 'yaml',
        content: YAML.stringify(server),
        truncated: false,
      },
    };
  }

  // Filesystem previews: whitelist from the scan, then assertSafePath.
  let resolvedPath: string;
  let allowedRoots: string[];
  let language = 'markdown';
  try {
    if (type === 'skill') {
      const items = await getHandler('skills').scanTeamForPull((teamConfig ?? {}) as TeamaiConfig, localConfig);
      const item = items.find((i) => i.name === id);
      if (!item) throw new NotFoundError(`skill "${id}" not found`);
      resolvedPath = path.join(item.sourcePath, 'SKILL.md');
      allowedRoots = [path.join(repo, 'skills')];
    } else if (type === 'rule') {
      const items = await getHandler('rules').scanTeamForPull((teamConfig ?? {}) as TeamaiConfig, localConfig);
      const item = items.find((i) => i.name === id);
      if (!item) throw new NotFoundError(`rule "${id}" not found`);
      resolvedPath = item.sourcePath;
      allowedRoots = [path.join(repo, 'rules')];
    } else if (type === 'doc') {
      resolvedPath = path.join(repo, 'docs', `${id}.md`);
      allowedRoots = [path.join(repo, 'docs')];
      const docs = await listFilesRecursive(path.join(repo, 'docs')).catch(() => [] as string[]);
      if (!docs.includes(`${id}.md`)) throw new NotFoundError(`doc "${id}" not found`);
    } else if (type === 'agent') {
      const items = await getHandler('agents').scanTeamForPull((teamConfig ?? {}) as TeamaiConfig, localConfig);
      const item = items.find((i) => i.name === id);
      if (!item) throw new NotFoundError(`agent "${id}" not found`);
      resolvedPath = item.sourcePath;
      allowedRoots = [path.join(repo, 'agents')];
      language = item.sourcePath.endsWith('.yaml') ? 'yaml' : 'markdown';
    } else if (type === 'culture') {
      resolvedPath = path.join(repo, 'culture.md');
      allowedRoots = [path.join(repo, 'culture.md')];
      if (!(await pathExists(resolvedPath))) throw new NotFoundError('culture.md not found');
    } else if (type === 'role') {
      const manifest = await loadRolesManifest(repo);
      if (!listRoleIds(manifest).includes(id)) throw new NotFoundError(`role "${id}" not found`);
      resolvedPath = path.join(repo, 'manifest', 'roles.yaml');
      allowedRoots = [path.join(repo, 'manifest', 'roles.yaml')];
      language = 'yaml';
    } else { // learning
      const indexPath = path.join(getTeamaiHome(scope, projectRoot), 'search-index.json');
      const index = await loadIndex(indexPath);
      const entry = index?.entries.find((e) => e.filename === id || e.path === id);
      if (!entry) throw new NotFoundError(`learning "${id}" not found`);
      resolvedPath = entry.path ?? path.join(repo, 'learnings', entry.filename);
      allowedRoots = [
        path.join(repo, 'learnings'),
        path.join(repo, 'docs'),
        path.join(repo, 'rules'),
        path.join(repo, 'skills'),
        path.join(getTeamaiHome(scope, projectRoot), 'learnings'),
      ];
    }
  } catch (e) {
    if (e instanceof NotFoundError || (e as Error).name === 'NotFoundError') {
      return { status: 404, body: { error: (e as Error).message } };
    }
    return { status: 500, body: { error: (e as Error).message } };
  }

  // Dual gate part (b): symlink-resolved containment check.
  try {
    assertSafePath(resolvedPath, allowedRoots);
  } catch (e) {
    return { status: 404, body: { error: `preview rejected: ${(e as Error).message}` } };
  }

  const content = await readFileSafe(resolvedPath);
  if (content === null) {
    return { status: 404, body: { error: `file not found: ${resolvedPath}` } };
  }
  const rawBuf = Buffer.from(content, 'utf8');
  const truncated = rawBuf.byteLength > PREVIEW_CAP_BYTES;
  const safeContent = truncated ? rawBuf.subarray(0, PREVIEW_CAP_BYTES).toString('utf8') : content;
  return {
    status: 200,
    body: {
      type,
      id,
      path: resolvedPath,
      language,
      content: safeContent,
      truncated,
    },
  };
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ─── Recall search ────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function recallSearch(
  localConfig: LocalConfig,
  scope: Scope,
  projectRoot: string | undefined,
  q: string,
  limit: number,
): Promise<{ status: 'fresh' | 'rebuilt' | 'missing'; results: Array<{ title: string; path: string; score: number; snippet: string }>; hint?: string }> {
  const teamaiHome = getTeamaiHome(scope, projectRoot);
  const indexPath = path.join(teamaiHome, 'search-index.json');
  const repo = localConfig.repo.localPath;

  let index = await loadIndex(indexPath);
  let status: 'fresh' | 'rebuilt' | 'missing' = !index ? 'missing' : isLegacyIndex(index) ? 'missing' : 'fresh';

  // Missing/legacy index → one rebuild attempt with a hard latency cap.
  if (status === 'missing') {
    try {
      // Mirror recall.ts source resolution: user scope prefers the local
      // copy under <teamaiHome>/learnings, else the repo's learnings dir.
      const learningsLocal = path.join(teamaiHome, 'learnings');
      const learningsRepo = path.join(repo, 'learnings');
      const learningsDir = scope === 'user' && (await pathExists(learningsLocal))
        ? learningsLocal
        : (await pathExists(learningsRepo)) ? learningsRepo : undefined;
      await withTimeout(buildIndex({
        learningsDir,
        docsDir: (await pathExists(path.join(repo, 'docs'))) ? path.join(repo, 'docs') : undefined,
        rulesDir: (await pathExists(path.join(repo, 'rules'))) ? path.join(repo, 'rules') : undefined,
        skillsDir: (await pathExists(path.join(repo, 'skills'))) ? path.join(repo, 'skills') : undefined,
        indexPath,
      }), RECALL_BUILD_TIMEOUT_MS);
      index = await loadIndex(indexPath);
      status = index && !isLegacyIndex(index) ? 'rebuilt' : 'missing';
    } catch {
      status = 'missing';
    }
  }

  if (!index) {
    return {
      status: 'missing',
      results: [],
      hint: 'knowledge index is missing — run `teamai pull` (or `teamai recall <query>`) to build it',
    };
  }

  if (!q.trim()) {
    return { status, results: [] };
  }

  const results = search(q, index, limit).map((r) => ({
    title: r.entry.title,
    path: r.entry.path ?? r.entry.filename,
    score: Math.round(r.score * 10) / 10,
    snippet: snippetFor(r.entry.path ?? '', r.entry.title),
  }));
  return { status, results };
}

function snippetFor(filePath: string, fallback: string): string {
  if (!filePath) return fallback;
  let content: string | null;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    content = null;
  }
  if (!content) return fallback;
  const body = matter(content).content || content;
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

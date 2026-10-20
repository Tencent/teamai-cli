import type http from 'node:http';
import { dashboardWorkspaces, workspaceEvents, type DashboardWorkspace } from './dashboard/workspaces.js';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { ensureDir } from './utils/fs.js';
import { readEvents, rebuildSessions, appendEvent } from './dashboard-collector.js';
import { isProcessAlive } from './pid-monitor.js';
import {
  DASHBOARD_DEFAULT_PORT,
  DASHBOARD_PID_CHECK_INTERVAL_MS,
  type DashboardEvent,
  type LocalConfig,
} from './types.js';
import { getDashboardHtml } from './dashboard-html.js';
import { getUserHome } from './utils/home.js';
import type { VizSummary } from './viz.js';
import { aggregateDailySessions, computeDailyStatsDelta, summarizeTrendWindow, summarizeSessionCosts } from './session-trends.js';
import { HttpError, isLocalWrite, readJsonBody } from './dashboard/http.js';
import type { ReportedHistory } from './dashboard/workflow-runs.js';

// ─── Dashboard server architecture ──────────────────────
//
//  events.jsonl ──fs.watch, stat each second──▶ rebuildSessions()
//                                    │
//                                    ▼
//                             DashboardSession[]
//                                    │
//                    ┌───────────────┼───────────────┐
//                    ▼               ▼               ▼
//               GET /          GET /api/sessions  GET /events
//               (HTML)         (JSON)             (SSE stream)
//

type SSEClient = http.ServerResponse;

const KB_SUMMARY_TTL_MS = 30_000;
let kbSummaryCache: { ts: number; data: VizSummary } | null = null;

/**
 * Start the dashboard HTTP server.
 * Serves: HTML UI, sessions API, and SSE stream for real-time updates.
 */
export async function startDashboard(port?: number): Promise<void> {
  const serverPort = port ?? DASHBOARD_DEFAULT_PORT;
  const eventsPath = path.join(getUserHome(), '.teamai', 'dashboard', 'events.jsonl');

  // Ensure events directory exists
  await ensureDir(path.dirname(eventsPath));

  // Touch events file if it doesn't exist
  try {
    await fs.promises.access(eventsPath);
  } catch {
    await fs.promises.writeFile(eventsPath, '', 'utf-8');
  }

  // Workspace membership is re-derived on a short TTL rather than frozen at startup,
  // so a project installed (or first seen in events) after boot appears without a
  // restart instead of its sessions silently folding elsewhere (PR #604 review #3).
  let workspacesCache: { ts: number; data: DashboardWorkspace[] } | null = null;
  const getWorkspaces = async (events: DashboardEvent[]): Promise<DashboardWorkspace[]> => {
    if (!workspacesCache || Date.now() - workspacesCache.ts > KB_SUMMARY_TTL_MS) {
      workspacesCache = { ts: Date.now(), data: await dashboardWorkspaces(events) };
    }
    return workspacesCache.data;
  };
  const scopedEvents = async (id: string | null) => {
    const events = await readEvents(eventsPath);
    const workspaces = await getWorkspaces(events);
    const workspace = workspaces.find(w => w.id === id);
    return workspace ? workspaceEvents(events, workspace, workspaces) : events;
  };
  const clientScopes = new Map<SSEClient, string | null>();
  const contextRequests = new Map<string, Promise<unknown>>();
  const contextCaches = new Map<string, { ts: number; data: unknown }>();

  // SSE clients
  const clients: Set<SSEClient> = new Set();

  // Watch events file and push updates to SSE clients
  /** The events file as last pushed: its inode, size and last change. */
  let pushedStamp = '';
  const eventsStamp = (): Promise<string> =>
    fs.promises.stat(eventsPath).then((s) => `${s.ino}:${s.size}:${s.mtimeMs}`, () => '');
  const pushSessions = async () => {
    pushedStamp = await eventsStamp();
    try {
      const events = await readEvents(eventsPath);
      const workspaces = await getWorkspaces(events);
      const sessions = rebuildSessions(events);
      const data = JSON.stringify(sessions);
      for (const client of clients) {
        const workspace = workspaces.find(w => w.id === clientScopes.get(client));
        client.write(`data: ${workspace ? JSON.stringify(rebuildSessions(workspaceEvents(events, workspace, workspaces))) : data}\n\n`);
      }
    } catch (e) {
      log.debug(`dashboard: SSE push error: ${(e as Error).message}`);
    }
  };
  let watchDebounce: ReturnType<typeof setTimeout> | null = null;
  // Compaction atomically replaces events.jsonl. Watching the file itself
  // follows the old inode on Linux and macOS, so watch its directory instead.
  const eventsFileName = path.basename(eventsPath);
  const schedulePush = (): void => {
    // Debounce rapid file changes (multiple hooks firing near-simultaneously)
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      void pushSessions();
    }, 200);
  };
  const watcher = fs.watch(path.dirname(eventsPath), (_eventType, filename) => {
    if (filename && filename.toString() !== eventsFileName) return;
    schedulePush();
  });
  // fs.watch on macOS (FSEvents) falls behind on a busy disk: an append went
  // unreported for over 20s. A stat every second pushes what it has not said.
  void eventsStamp().then((stamp) => { pushedStamp ||= stamp; });
  const eventsPoll = setInterval(() => {
    void eventsStamp().then((stamp) => { if (stamp !== pushedStamp && !watchDebounce) schedulePush(); });
  }, 1000);

  // ─── PID liveness monitor ────────────────────────────
  //
  //  Periodically check if monitored PIDs are still alive.
  //  If a session's AI tool process has exited without a subsequent
  //  prompt_submit or tool_use event, emit a 'process_exit' event
  //  to mark the session as truly stopped.
  //
  //  This complements the Stop hook (which only means "LLM finished
  //  responding") by detecting actual process exit.
  //
  const checkPids = async () => {
    try {
      const events = await readEvents(eventsPath);
      const sessions = rebuildSessions(events);

      for (const session of sessions) {
        // Only check non-stopped sessions with a monitorPid
        if (session.status === 'stopped') continue;
        if (!session.monitorPid) continue;

        if (!isProcessAlive(session.monitorPid)) {
          const exitEvent: DashboardEvent = {
            type: 'process_exit',
            timestamp: new Date().toISOString(),
            sessionId: session.sessionId,
            processExitAfter: session.lastActivity,
            tool: session.tool,
            cwd: session.cwd,
            // The session's own data home, so its scope's report still sees it end.
            dataHomeKey: events.find((e) => e.sessionId === session.sessionId && e.dataHomeKey)?.dataHomeKey,
            // And its repo, which the cwd may no longer lead to (a removed worktree).
            projectAnchor: [...events].reverse().find((e) => e.sessionId === session.sessionId && e.projectAnchor)?.projectAnchor,
          };
          await appendEvent(exitEvent);
          log.info(
            `dashboard: detected process exit for session ${session.sessionId.slice(0, 16)}` +
            ` (monitorPid ${session.monitorPid})`,
          );
        }
      }
    } catch (e) {
      log.debug(`dashboard: PID check error: ${(e as Error).message}`);
    }
  };
  const pidCheckInterval = setInterval(() => void checkPids(), DASHBOARD_PID_CHECK_INTERVAL_MS);

  // Distribution (#1124): read, preview, and save a workspace's roles and
  // projects. The workspace's config is read fresh, not from the TTL cache.
  // Saves run one at a time, each reading the config, checking its revision,
  // and writing it in turn, so two saves cannot both pass the check against
  // one old config and the second overwrite the first.
  let distributionWrites: Promise<unknown> = Promise.resolve();
  const freshConfig = async (scopeId: string | null) => {
    workspacesCache = null;
    return (await getWorkspaces(await readEvents(eventsPath))).find(w => w.id === scopeId)?.config ?? null;
  };
  const handleDistribution = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, scopeId: string | null) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const route = pathname.slice('/api/distribution'.length);
    const writeRoutes = ['/preview', '/roles', '/projects'];
    if (route === '' ? req.method !== 'GET' : !writeRoutes.includes(route) || req.method !== 'POST') {
      json(route === '' || writeRoutes.includes(route) ? 405 : 404, { error: 'Not supported.' });
      return;
    }
    const distribution = await import('./dashboard/distribution.js');
    try {
      if (route === '') {
        const config = await freshConfig(scopeId);
        json(200, config ? await distribution.readDistribution(config) : { configured: false });
        return;
      }
      const body = await readJsonBody(req);
      if (route === '/preview') {
        const config = await freshConfig(scopeId);
        if (!config) throw new HttpError(400, 'Select a workspace with a teamai config.');
        json(200, await distribution.previewDistribution(config, body));
        return;
      }
      const save = async () => {
        const config = await freshConfig(scopeId);
        if (!config) throw new HttpError(400, 'Select a workspace with a teamai config.');
        if (route === '/roles') await distribution.saveRoles(config, body);
        else await distribution.saveProjects(config, body);
        const saved = await freshConfig(scopeId);
        return saved ? distribution.readDistribution(saved) : { configured: false };
      };
      const result = distributionWrites.then(save, save);
      distributionWrites = result.catch(() => undefined);
      json(200, await result);
    } catch (e) {
      if (e instanceof HttpError) {
        json(e.status, { error: e.message });
        return;
      }
      log.debug(`dashboard: ${pathname} failed: ${(e as Error).message}`);
      json(500, { error: 'Failed to update distribution.' });
    }
  };

  // Workflow Runs (#1088). The team history refreshes the reports checkout
  // from origin, so it is cached like the KB report; local runs are read fresh.
  const loadReportedHistory = async (config: LocalConfig): Promise<ReportedHistory> => {
    try {
      const { listReportedRuns } = await import('./dashboard/workflow-runs.js');
      return { state: 'ok', runs: await listReportedRuns(config) };
    } catch (e) {
      log.debug(`dashboard: reported workflow runs failed: ${e instanceof Error ? e.message : String(e)}`);
      return { state: 'unavailable' };
    }
  };
  const reportedCaches = new Map<string, { ts: number; last: Promise<ReportedHistory>; refreshing: boolean }>();
  // The last history answers while a refresh fetches, so a slow or unreachable origin holds the live local runs only
  // on the first load.
  const reportedHistory = (key: string, config: LocalConfig): Promise<ReportedHistory> => {
    const cached = reportedCaches.get(key);
    if (cached && (cached.refreshing || Date.now() - cached.ts <= KB_SUMMARY_TTL_MS)) return cached.last;
    const refresh = loadReportedHistory(config);
    const entry = { ts: Date.now(), last: cached?.last ?? refresh, refreshing: true };
    reportedCaches.set(key, entry);
    void refresh.then((data) => Object.assign(entry, { ts: Date.now(), last: Promise.resolve(data), refreshing: false }));
    return entry.last;
  };
  const handleWorkflows = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL, workspace: DashboardWorkspace | undefined) => {
    const config = workspace?.config ?? null;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const route = url.pathname.slice('/api/workflows'.length);
    const method = route === '/respond' ? 'POST' : 'GET';
    if (!['', '/run', '/respond'].includes(route)) {
      json(404, { error: 'Not supported.' });
      return;
    }
    if (req.method !== method) {
      json(405, { error: 'Not supported.' });
      return;
    }
    const runs = await import('./dashboard/workflow-runs.js');
    try {
      if (route === '') {
        json(200, workspace?.config
          ? { configured: true, local: await runs.listLocalRuns(workspace.config), reported: await reportedHistory(workspace.id, workspace.config) }
          : { configured: false });
        return;
      }
      if (!config) throw new HttpError(400, 'Select a workspace with a teamai config.');
      if (route === '/run') {
        const source = url.searchParams.get('source') === 'reported' ? 'reported' : 'local';
        const detail = await runs.workflowRunDetail(config, source, url.searchParams.get('id') ?? '');
        if (detail) json(200, detail);
        else json(404, { error: 'This run is not in the selected workspace.' });
        return;
      }
      // A browser sends Origin with every fetch POST, so a request without one
      // did not come from the dashboard page. Like the TTY channel, this is a
      // convention, not protection against a local process that sets it.
      if (req.headers.origin === undefined) throw new HttpError(403, 'Answer HITL requests from the dashboard page.');
      json(200, await runs.answerFromDashboard(config, await readJsonBody(req)));
    } catch (e) {
      if (e instanceof HttpError) {
        json(e.status, { error: e.message });
        return;
      }
      log.debug(`dashboard: ${url.pathname} failed: ${(e as Error).message}`);
      json(500, { error: 'Failed to load workflow runs.' });
    }
  };

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${serverPort}`);

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Any origin may read (CORS *), so every other method is a write and must
    // come from this dashboard's own page, whichever route it is for (#1124).
    // A browser's preflight (OPTIONS) is refused here too, so a cross-site
    // write is never sent.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isLocalWrite(req, serverPort)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Write requests must come from the local dashboard.' }));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Serve dashboard HTML
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getDashboardHtml(serverPort));
      return;
    }

    const scopeId = url.searchParams.get('workspace');
    const workspaces = await getWorkspaces(await readEvents(eventsPath));
    const workspace = workspaces.find(w => w.id === scopeId);
    if (scopeId && !workspace) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown workspace' }));
      return;
    }
    if (url.pathname === '/api/workspaces') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(workspaces.map(({ config, roots, ...item }) => item)));
      return;
    }

    if (url.pathname === '/api/sessions') {
      // Return current sessions as JSON
      try {
        const events = await scopedEvents(scopeId);
        const sessions = rebuildSessions(events);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === '/api/trends') {
      try {
        const events = await scopedEvents(scopeId);
        const snapshots = aggregateDailySessions(events);
        const daily = computeDailyStatsDelta(snapshots, {}).delta;
        const trends = summarizeTrendWindow(daily);
        const costs = summarizeSessionCosts(snapshots);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          current: { ...trends.current, ...costs.current },
          previous: { ...trends.previous, ...costs.previous },
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === '/api/resources/rules') {
      // Rules inventory for the Resources page (#1028): names and metadata
      // only, never rule bodies or environment values. The user scope and the
      // unassigned bucket pull no team repo, so they get an explicit state.
      try {
        const ownConfig = workspace?.config ?? null;
        if (!ownConfig) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ configured: false, rules: [] }));
          return;
        }
        const [{ loadTeamConfig }, { buildRolePullContext }, { collectRulesInventory }, { readWorkspaceChildren }] = await Promise.all([
          import('./config.js'), import('./resources/desired.js'), import('./dashboard/resources.js'), import('./workspace-children.js'),
        ]);
        // What pull delivers to a workspace includes its children's selections (#913).
        // Read here, for this request only: session and workspace listing never walk them.
        const config = await readWorkspaceChildren(ownConfig);
        const teamConfig = await loadTeamConfig(config.repo.localPath);
        // A scope whose clone carries no teamai.yaml pulls no rules.
        const rules = teamConfig
          ? await collectRulesInventory(teamConfig, config, await buildRolePullContext(config))
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ configured: true, rules }));
      } catch (e) {
        log.debug(`dashboard: /api/resources/rules failed: ${(e as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load rules.' }));
      }
      return;
    }

    if (url.pathname === '/api/distribution' || url.pathname.startsWith('/api/distribution/')) {
      await handleDistribution(req, res, url.pathname, scopeId);
      return;
    }

    if (url.pathname === '/api/workflows' || url.pathname.startsWith('/api/workflows/')) {
      await handleWorkflows(req, res, url, workspace);
      return;
    }

    if (url.pathname === '/api/resources/skills') {
      // Skills inventory for the Resources page (#1123): names and metadata
      // only, never SKILL.md bodies or environment values. The user scope and
      // the unassigned bucket pull no team repo, so they get an explicit state.
      try {
        const ownConfig = workspace?.config ?? null;
        if (!ownConfig) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ configured: false, skills: [] }));
          return;
        }
        const [{ loadTeamConfig }, { buildRolePullContext }, { collectSkillsInventory }, { readWorkspaceChildren }] = await Promise.all([
          import('./config.js'), import('./resources/desired.js'), import('./dashboard/resources-skills.js'), import('./workspace-children.js'),
        ]);
        const config = await readWorkspaceChildren(ownConfig);
        const teamConfig = await loadTeamConfig(config.repo.localPath);
        const inventory = teamConfig
          ? await collectSkillsInventory(teamConfig, config, await buildRolePullContext(config))
          : { skills: [], skillConflict: null };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ configured: true, skills: inventory.skills, skillConflict: inventory.skillConflict }));
      } catch (e) {
        log.debug(`dashboard: /api/resources/skills failed: ${(e as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load skills.' }));
      }
      return;
    }

    if (url.pathname === '/api/resources/skills/detail') {
      // One skill's full metadata (#1123). The name must resolve in the
      // inventory, so an unknown name is an explicit error, not an empty row.
      try {
        const ownConfig = workspace?.config ?? null;
        const name = url.searchParams.get('name') ?? '';
        // The inventory's own source identity, so a same-name root and its
        // namespaced replacement each answer their own detail (#1123).
        const sourcePath = url.searchParams.get('path') ?? undefined;
        if (!ownConfig || name === '') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ configured: !!ownConfig, skill: null }));
          return;
        }
        const [{ loadTeamConfig }, { buildRolePullContext }, { skillDetail }, { readWorkspaceChildren }] = await Promise.all([
          import('./config.js'), import('./resources/desired.js'), import('./dashboard/resources-skills.js'), import('./workspace-children.js'),
        ]);
        const config = await readWorkspaceChildren(ownConfig);
        const teamConfig = await loadTeamConfig(config.repo.localPath);
        const skill = teamConfig
          ? await skillDetail(teamConfig, config, await buildRolePullContext(config), name, sourcePath)
          : null;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ configured: true, skill }));
      } catch (e) {
        log.debug(`dashboard: /api/resources/skills/detail failed: ${(e as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load the skill.' }));
      }
      return;
    }

    if (url.pathname === '/api/resources/skills/exclusions' && req.method === 'POST') {
      // Write one skill's personal exclusion for the selected workspace only
      // (#1123): never the team repo, never a pull. The response carries the
      // updated entry; the client explains the next-pull application.
      try {
        const body = await new Promise<string>((resolve) => {
          let data = '';
          req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          req.on('end', () => resolve(data));
        });
        let parsed: { name?: unknown; excluded?: unknown };
        try {
          parsed = JSON.parse(body) as { name?: unknown; excluded?: unknown };
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
          return;
        }
        const name = parsed.name;
        const excluded = parsed.excluded;
        const ownConfig = workspace?.config ?? null;
        if (typeof name !== 'string' || name === '' || typeof excluded !== 'boolean' || !ownConfig) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid_request' }));
          return;
        }
        const [{ loadTeamConfig }, { buildRolePullContext }, { setSkillExclusion }, { readWorkspaceChildren }] = await Promise.all([
          import('./config.js'), import('./resources/desired.js'), import('./dashboard/resources-skills.js'), import('./workspace-children.js'),
        ]);
        const config = await readWorkspaceChildren(ownConfig);
        const teamConfig = await loadTeamConfig(config.repo.localPath);
        if (!teamConfig) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unknown_skill' }));
          return;
        }
        // The same role context the GET endpoints use, so the response's
        // delivered flag matches the inventory the client reloads next.
        const result = await setSkillExclusion(teamConfig, config, name, excluded, await buildRolePullContext(config));
        if (!result.ok) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        // The saved config changes what this workspace delivers; drop the
        // workspace cache so the next request re-reads it from disk instead
        // of answering from the pre-exclusion in-memory copy.
        workspacesCache = null;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...result, note: 'applies on the next pull' }));
      } catch (e) {
        log.debug(`dashboard: /api/resources/skills/exclusions failed: ${(e as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Failed to save the exclusion.' }));
      }
      return;
    }

    if (url.pathname === '/events') {
      // SSE stream
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('\n');
      clients.add(res);
      clientScopes.set(res, scopeId);

      // Send initial state immediately
      try {
        const events = await scopedEvents(scopeId);
        const sessions = rebuildSessions(events);
        res.write(`data: ${JSON.stringify(sessions)}\n\n`);
      } catch {
        // Ignore initial send errors
      }

      req.on('close', () => {
        clients.delete(res);
        clientScopes.delete(res);
      });
      return;
    }

    if (url.pathname === '/kb-report') {
      // Knowledge-base health report (reuses the viz aggregation + renderer)
      try {
        const { generateReportHtml } = await import('./viz.js');
        const html = await generateReportHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Failed to generate KB health report: ' + (e instanceof Error ? e.message : String(e)));
      }
      return;
    }

    if (url.pathname === '/api/context') {
      try {
        const key = scopeId ?? 'all';
        let cached = contextCaches.get(key);
        if (!cached || Date.now() - cached.ts > KB_SUMMARY_TTL_MS) {
          let pending = contextRequests.get(key);
          if (!pending) {
            pending = import('./viz.js').then(({ getDashboardContext }) => getDashboardContext(workspace ? { config: workspace.config } : {}));
            contextRequests.set(key, pending);
          }
          try { cached = { ts: Date.now(), data: await pending }; }
          finally { contextRequests.delete(key); }
          contextCaches.set(key, cached);
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(cached.data));
      } catch (e) {
        log.debug(`dashboard: /api/context failed: ${(e as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load knowledge base health.' }));
      }
      return;
    }

    if (url.pathname === '/api/kb-summary') {
      // Compact KB summary for the preview card, cached briefly so we don't
      // re-aggregate the whole knowledge base on every dashboard page load
      try {
        const now = Date.now();
        if (!kbSummaryCache || now - kbSummaryCache.ts > KB_SUMMARY_TTL_MS) {
          const { getVizSummary } = await import('./viz.js');
          kbSummaryCache = { ts: now, data: await getVizSummary() };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(kbSummaryCache.data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  };

  // Loaded here, not at the top: importing node:http loads undici for its
  // WebSocket exports, a few milliseconds every other command paid.
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((e: unknown) => {
      log.debug(`dashboard: request error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
  });

  // Handle port conflict
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${serverPort} is already in use.`);
      log.info(`Try a different port: teamai dashboard --port ${serverPort + 1}`);
      log.info(`Or check what's using it: lsof -i :${serverPort}`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(serverPort, '127.0.0.1', () => {
    log.success(`Dashboard running at http://localhost:${serverPort}`);
    log.info('Watching for AI coding session events...');
    log.info('Press Ctrl+C to stop.');
  });

  // Graceful shutdown
  const shutdown = () => {
    log.info('\nShutting down dashboard...');
    watcher.close();
    clearInterval(eventsPoll);
    clearInterval(pidCheckInterval);
    for (const client of clients) {
      client.end();
    }
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Handle uncaught errors to prevent silent crash
  process.on('uncaughtException', (err) => {
    log.error(`Dashboard crashed: ${err.message}`);
    shutdown();
  });
}

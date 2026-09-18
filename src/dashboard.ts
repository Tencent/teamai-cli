import http from 'node:http';
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
} from './types.js';
import { getDashboardHtml } from './dashboard-html.js';
import { getUserHome } from './utils/home.js';
import type { VizSummary } from './viz.js';
import { aggregateDailySessions, computeDailyStatsDelta, summarizeTrendWindow, summarizeSessionCosts } from './session-trends.js';

// ─── Dashboard server architecture ──────────────────────
//
//  events.jsonl ──fs.watch──▶ rebuildSessions()
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
  let watchDebounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(eventsPath, () => {
    // Debounce rapid file changes (multiple hooks firing near-simultaneously)
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(async () => {
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
    }, 200);
  });

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
  const pidCheckInterval = setInterval(async () => {
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
            tool: session.tool,
            cwd: session.cwd,
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
  }, DASHBOARD_PID_CHECK_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${serverPort}`);

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');

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

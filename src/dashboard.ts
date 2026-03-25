import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { ensureDir } from './utils/fs.js';
import { readEvents, rebuildSessions } from './dashboard-collector.js';
import {
  DASHBOARD_DEFAULT_PORT,
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_EVENTS_DIR,
} from './types.js';
import { getDashboardHtml } from './dashboard-html.js';

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

/**
 * Start the dashboard HTTP server.
 * Serves: HTML UI, sessions API, and SSE stream for real-time updates.
 */
export async function startDashboard(port?: number): Promise<void> {
  const serverPort = port ?? DASHBOARD_DEFAULT_PORT;
  const eventsPath = path.join(process.env.HOME ?? '', '.teamai', 'dashboard', 'events.jsonl');

  // Ensure events directory exists
  await ensureDir(path.dirname(eventsPath));

  // Touch events file if it doesn't exist
  try {
    await fs.promises.access(eventsPath);
  } catch {
    await fs.promises.writeFile(eventsPath, '', 'utf-8');
  }

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
        const sessions = rebuildSessions(events);
        const data = JSON.stringify(sessions);
        for (const client of clients) {
          client.write(`data: ${data}\n\n`);
        }
      } catch (e) {
        log.debug(`dashboard: SSE push error: ${(e as Error).message}`);
      }
    }, 200);
  });

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

    if (url.pathname === '/api/sessions') {
      // Return current sessions as JSON
      try {
        const events = await readEvents(eventsPath);
        const sessions = rebuildSessions(events);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessions));
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

      // Send initial state immediately
      try {
        const events = await readEvents(eventsPath);
        const sessions = rebuildSessions(events);
        res.write(`data: ${JSON.stringify(sessions)}\n\n`);
      } catch {
        // Ignore initial send errors
      }

      req.on('close', () => {
        clients.delete(res);
      });
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

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './utils/logger.js';
import { ensureDir } from './utils/fs.js';
import { readEvents, rebuildSessions, appendEvent } from './dashboard-collector.js';
import { isProcessAlive } from './pid-monitor.js';
import {
  DASHBOARD_DEFAULT_PORT,
  DASHBOARD_EVENTS_PATH,
  DASHBOARD_EVENTS_DIR,
  DASHBOARD_PID_CHECK_INTERVAL_MS,
  type DashboardEvent,
} from './types.js';
import { getDashboardHtml } from './dashboard-html.js';
import { scorePrompt, ScorerConfigError, ScorerServiceError } from './prompt-scorer.js';

let judgeInFlight = 0;
const MAX_JUDGE_CONCURRENT = 5;

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

    if (url.pathname === '/api/judge' && req.method === 'POST') {
      const MAX_BODY_BYTES = 65_536;
      let body = '';
      let oversized = false;
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > MAX_BODY_BYTES) {
          oversized = true;
          req.destroy();
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'request body too large' }));
        }
      });
      req.on('end', async () => {
        if (oversized) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        const prompt = parsed.prompt;
        if (!prompt || typeof prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'prompt is required and must be a string' }));
          return;
        }
        const lang = typeof parsed.lang === 'string' ? parsed.lang : undefined;
        if (judgeInFlight >= MAX_JUDGE_CONCURRENT) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'too many concurrent requests, try again later' }));
          return;
        }
        judgeInFlight++;
        try {
          const result = await scorePrompt(prompt, lang);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          if (err instanceof ScorerConfigError) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          } else if (err instanceof ScorerServiceError) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'LLM service unavailable' }));
          } else {
            const message = err instanceof Error ? err.message : 'unknown error';
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: message }));
          }
        } finally {
          judgeInFlight--;
        }
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

/**
 * Dashboard HTML UI — single-file with SSE and status cards.
 * Embedded as a TypeScript template to avoid bundling static files.
 */
export function getDashboardHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeamAI Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --surface-hover: #1c2129;
      --border: #30363d;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
      --gray: #484f58;
      --blue: #58a6ff;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    header h1 {
      font-size: 20px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .connection-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .connection-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--gray);
    }
    .connection-dot.connected { background: var(--green); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      transition: border-color 0.2s;
    }
    .card:hover {
      border-color: var(--blue);
      background: var(--surface-hover);
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .status-light {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-light.running {
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s infinite;
    }
    .status-light.waiting_for_input {
      background: var(--yellow);
      box-shadow: 0 0 8px var(--yellow);
      animation: pulse 1s infinite;
    }
    .status-light.error {
      background: var(--red);
      box-shadow: 0 0 8px var(--red);
    }
    .status-light.idle {
      background: var(--gray);
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .tool-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--border);
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-text {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: auto;
    }
    .cwd {
      font-size: 13px;
      color: var(--blue);
      font-family: 'SF Mono', 'Fira Code', monospace;
      margin-bottom: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .prompt-summary {
      font-size: 13px;
      color: var(--text);
      margin-bottom: 8px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
    .last-tool {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 11px;
      color: var(--text-muted);
      background: var(--bg);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      color: var(--text-muted);
    }
    .empty-state h2 {
      font-size: 18px;
      margin-bottom: 8px;
      color: var(--text);
    }
    .empty-state p {
      font-size: 14px;
      max-width: 420px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .empty-state code {
      background: var(--surface);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <header>
    <h1>⚡ TeamAI Dashboard</h1>
    <div class="connection-status">
      <span class="connection-dot" id="conn-dot"></span>
      <span id="conn-text">Connecting...</span>
    </div>
  </header>
  <div id="app"></div>

  <script>
    const app = document.getElementById('app');
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');
    let sessions = [];

    function timeAgo(isoStr) {
      const diff = Date.now() - new Date(isoStr).getTime();
      if (diff < 5000) return 'just now';
      if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      return Math.floor(diff / 3600000) + 'h ago';
    }

    function shortPath(fullPath) {
      if (!fullPath) return '—';
      const parts = fullPath.split('/');
      return parts.length > 2 ? '~/' + parts.slice(-2).join('/') : fullPath;
    }

    function statusLabel(status) {
      switch (status) {
        case 'running': return 'Running';
        case 'waiting_for_input': return 'Waiting';
        case 'error': return 'Error';
        case 'idle': return 'Idle';
        default: return status;
      }
    }

    function render() {
      if (sessions.length === 0) {
        app.innerHTML = \`
          <div class="empty-state">
            <h2>No active sessions</h2>
            <p>Start a Claude Code session and it will appear here automatically.
            Make sure <code>teamai pull</code> has been run to inject dashboard hooks.</p>
          </div>\`;
        return;
      }

      app.innerHTML = '<div class="grid">' + sessions.map(s => \`
        <div class="card">
          <div class="card-header">
            <span class="status-light \${s.status}"></span>
            <span class="tool-badge">\${s.tool}</span>
            <span class="status-text">\${statusLabel(s.status)}</span>
          </div>
          <div class="cwd" title="\${s.cwd}">\${shortPath(s.cwd)}</div>
          \${s.promptSummary ? \`<div class="prompt-summary">\${escapeHtml(s.promptSummary)}</div>\` : ''}
          <div class="card-footer">
            <span>\${timeAgo(s.lastActivity)}</span>
            \${s.lastTool ? \`<span class="last-tool">\${s.lastTool}</span>\` : ''}
          </div>
        </div>
      \`).join('') + '</div>';
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // SSE connection with auto-reconnect
    function connect() {
      const es = new EventSource('/events');

      es.onopen = () => {
        connDot.classList.add('connected');
        connText.textContent = 'Connected';
      };

      es.onmessage = (e) => {
        try {
          sessions = JSON.parse(e.data);
          render();
        } catch {}
      };

      es.onerror = () => {
        connDot.classList.remove('connected');
        connText.textContent = 'Reconnecting...';
        es.close();
        setTimeout(connect, 3000);
      };
    }

    // Refresh time-ago labels every 10 seconds
    setInterval(render, 10000);

    connect();
  </script>
</body>
</html>`;
}

/**
 * Dashboard HTML UI — single-file with SSE, status cards, expandable details,
 * stats bar, session grouping, and stopped session display with fade-out.
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
      margin-bottom: 16px;
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

    /* Stats bar */
    .stats-bar {
      display: flex;
      gap: 16px;
      margin-bottom: 20px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .stat-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .stat-dot.running { background: var(--green); }
    .stat-dot.waiting { background: var(--yellow); }
    .stat-dot.idle { background: var(--gray); }
    .stat-dot.stopped { background: var(--text-muted); }

    /* Section headers */
    .section-header {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin: 20px 0 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-header:first-of-type { margin-top: 0; }

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
      transition: border-color 0.2s, opacity 0.5s;
      cursor: pointer;
    }
    .card:hover {
      border-color: var(--blue);
      background: var(--surface-hover);
    }
    .card.stopped {
      opacity: 0.6;
      border-color: var(--border);
    }
    .card.stopped:hover {
      opacity: 0.85;
    }
    .card.fading {
      opacity: 0;
      transition: opacity 5s;
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
    .status-light.stopped {
      background: var(--text-muted);
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
    .duration {
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'SF Mono', 'Fira Code', monospace;
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
    .stopped-output {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 8px;
      padding: 8px;
      background: var(--bg);
      border-radius: 4px;
      border-left: 3px solid var(--blue);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 80px;
      overflow: hidden;
    }
    .stopped-output.waiting-output {
      border-left-color: var(--yellow);
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

    /* Expandable detail panel */
    .card-detail {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    .card-detail.open { display: block; }
    .detail-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 6px;
      margin-top: 10px;
    }
    .detail-label:first-child { margin-top: 0; }
    .prompt-item {
      font-size: 12px;
      color: var(--text);
      padding: 6px 8px;
      background: var(--bg);
      border-radius: 4px;
      margin-bottom: 4px;
      word-break: break-word;
    }
    .ai-output {
      font-size: 12px;
      color: var(--text);
      padding: 8px;
      background: var(--bg);
      border-radius: 4px;
      border-left: 3px solid var(--green);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
    }
    .expand-hint {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
      margin-top: 4px;
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
    <h1>TeamAI Dashboard</h1>
    <div class="connection-status">
      <span class="connection-dot" id="conn-dot"></span>
      <span id="conn-text">Connecting...</span>
    </div>
  </header>
  <div id="stats"></div>
  <div id="app"></div>

  <script>
    const app = document.getElementById('app');
    const statsEl = document.getElementById('stats');
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');
    let sessions = [];
    const expandedCards = new Set();

    function timeAgo(isoStr) {
      const diff = Date.now() - new Date(isoStr).getTime();
      if (diff < 5000) return 'just now';
      if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      return Math.floor(diff / 3600000) + 'h ago';
    }

    function durationStr(startIso, endIso) {
      const start = new Date(startIso).getTime();
      const end = endIso ? new Date(endIso).getTime() : Date.now();
      const ms = end - start;
      if (ms < 60000) return Math.floor(ms / 1000) + 's';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
      return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
    }

    function shortPath(fullPath) {
      if (!fullPath) return '';
      const parts = fullPath.split('/');
      return parts.length > 2 ? '~/' + parts.slice(-2).join('/') : fullPath;
    }

    function statusLabel(status) {
      switch (status) {
        case 'running': return 'AI Working';
        case 'waiting_for_input': return 'Your Turn';
        case 'error': return 'Error';
        case 'idle': return 'Idle';
        case 'stopped': return 'Ended';
        default: return status;
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function escapeAttr(str) {
      return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function toggleCard(sessionId) {
      if (expandedCards.has(sessionId)) {
        expandedCards.delete(sessionId);
      } else {
        expandedCards.add(sessionId);
      }
      render();
    }

    // Event delegation for card clicks (avoids inline onclick with unescaped data)
    document.addEventListener('click', function(e) {
      const card = e.target.closest('[data-session-id]');
      if (card) toggleCard(card.dataset.sessionId);
    });

    function renderStats() {
      const running = sessions.filter(s => s.status === 'running').length;
      const waiting = sessions.filter(s => s.status === 'waiting_for_input').length;
      const idle = sessions.filter(s => s.status === 'idle').length;
      const stopped = sessions.filter(s => s.status === 'stopped').length;
      const total = sessions.length;

      if (total === 0) {
        statsEl.innerHTML = '';
        return;
      }

      statsEl.innerHTML = '<div class="stats-bar">' +
        (running > 0 ? '<div class="stat-item"><span class="stat-dot running"></span>' + running + ' working</div>' : '') +
        (waiting > 0 ? '<div class="stat-item"><span class="stat-dot waiting"></span>' + waiting + ' your turn</div>' : '') +
        (idle > 0 ? '<div class="stat-item"><span class="stat-dot idle"></span>' + idle + ' idle</div>' : '') +
        (stopped > 0 ? '<div class="stat-item"><span class="stat-dot stopped"></span>' + stopped + ' ended</div>' : '') +
        '</div>';
    }

    function renderCard(s) {
      const isExpanded = expandedCards.has(s.sessionId);
      const isStopped = s.status === 'stopped';
      const dur = durationStr(s.startedAt, isStopped ? s.stoppedAt || s.lastActivity : null);

      let detail = '';
      if (isExpanded) {
        let promptsHtml = '';
        if (s.prompts && s.prompts.length > 0) {
          promptsHtml = '<div class="detail-label">Prompts (' + s.prompts.length + ')</div>' +
            s.prompts.map(p => '<div class="prompt-item">' + escapeHtml(p) + '</div>').join('');
        }
        let outputHtml = '';
        if (s.stoppedOutput) {
          outputHtml = '<div class="detail-label">AI Output</div>' +
            '<div class="ai-output">' + escapeHtml(s.stoppedOutput) + '</div>';
        }
        detail = '<div class="card-detail open">' + promptsHtml + outputHtml + '</div>';
      }

      const hasOutputPreview = (isStopped || s.status === 'waiting_for_input') && s.stoppedOutput && !isExpanded;
      const outputPreviewClass = s.status === 'waiting_for_input' ? 'stopped-output waiting-output' : 'stopped-output';
      const stoppedOutputPreview = hasOutputPreview
        ? '<div class="' + outputPreviewClass + '">' + escapeHtml(s.stoppedOutput) + '</div>'
        : '';

      return '<div class="card ' + (isStopped ? 'stopped' : '') + '" data-session-id="' + escapeAttr(s.sessionId) + '">'+
        '<div class="card-header">' +
          '<span class="status-light ' + escapeAttr(s.status) + '"></span>' +
          '<span class="tool-badge">' + escapeHtml(s.tool) + '</span>' +
          '<span class="duration">' + dur + '</span>' +
          '<span class="status-text">' + statusLabel(s.status) + '</span>' +
        '</div>' +
        '<div class="cwd" title="' + escapeAttr(s.cwd) + '">' + escapeHtml(shortPath(s.cwd)) + '</div>' +
        (s.promptSummary ? '<div class="prompt-summary">' + escapeHtml(s.promptSummary) + '</div>' : '') +
        stoppedOutputPreview +
        '<div class="card-footer">' +
          '<span>' + timeAgo(s.lastActivity) + '</span>' +
          (s.lastTool ? '<span class="last-tool">' + s.lastTool + '</span>' : '') +
        '</div>' +
        (isExpanded ? '<div class="expand-hint">click to collapse</div>' : '') +
        detail +
      '</div>';
    }

    function render() {
      renderStats();

      if (sessions.length === 0) {
        app.innerHTML =
          '<div class="empty-state">' +
            '<h2>No active sessions</h2>' +
            '<p>Start a Claude Code session and it will appear here automatically. ' +
            'Dashboard hooks are injected automatically. Try restarting your session.</p>' +
          '</div>';
        return;
      }

      const active = sessions.filter(s => s.status !== 'stopped');
      const stopped = sessions.filter(s => s.status === 'stopped');

      let html = '';

      if (active.length > 0) {
        html += '<div class="section-header">Active</div>';
        html += '<div class="grid">' + active.map(renderCard).join('') + '</div>';
      }

      if (stopped.length > 0) {
        html += '<div class="section-header">Recently Ended</div>';
        html += '<div class="grid">' + stopped.map(renderCard).join('') + '</div>';
      }

      app.innerHTML = html;
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

    // Refresh time-ago labels and durations every 5 seconds
    setInterval(render, 5000);

    connect();
  </script>
</body>
</html>`;
}

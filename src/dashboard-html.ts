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
    .intervention-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      font-weight: 600;
      cursor: help;
    }
    .convo-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(59, 130, 246, 0.15);
      color: #3b82f6;
      font-weight: 600;
      cursor: help;
    }
    .token-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      font-weight: 600;
      cursor: help;
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
      word-break: break-word;
      max-height: 150px;
      overflow: hidden;
    }
    .stopped-output.waiting-output {
      border-left-color: var(--yellow);
    }

    /* Card section labels */
    .card-section { margin-bottom: 8px; }
    .card-section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    /* Markdown rendered output inside cards */
    .md-output { font-size: 12px; color: var(--text); line-height: 1.5; }
    .md-output h1 { font-size: 14px; font-weight: 600; margin: 6px 0 4px; }
    .md-output h2 { font-size: 13px; font-weight: 600; margin: 5px 0 3px; }
    .md-output h3 { font-size: 12px; font-weight: 600; margin: 4px 0 2px; }
    .md-output h4 { font-size: 12px; font-weight: 600; margin: 3px 0 2px; color: var(--text-muted); }
    .md-output p { margin: 4px 0; }
    .md-output ul { margin: 4px 0; padding-left: 18px; }
    .md-output li { margin: 2px 0; }
    .md-output code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 11px;
      background: var(--surface);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .md-output pre {
      background: var(--surface);
      border-radius: 4px;
      padding: 8px;
      margin: 4px 0;
      overflow-x: auto;
      font-size: 11px;
      line-height: 1.4;
    }
    .md-output pre code { background: none; padding: 0; }
    .md-output table {
      border-collapse: collapse;
      margin: 4px 0;
      font-size: 11px;
      width: 100%;
    }
    .md-output th, .md-output td {
      border: 1px solid var(--border);
      padding: 3px 6px;
      text-align: left;
    }
    .md-output th {
      background: var(--surface);
      font-weight: 600;
    }
    .md-output b, .md-output strong { font-weight: 600; }
    .md-output em, .md-output i { font-style: italic; color: var(--text-muted); }
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
      word-break: break-word;
      max-height: 300px;
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

    // ─── Lightweight inline markdown parser ─────────────
    // Backtick char via hex escape (cannot use literal backtick inside TS template)
    var BT = '\\x60';
    var FENCE = BT + BT + BT;
    var reInlineCode = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');

    function inlineMarkdown(text) {
      return text
        .replace(reInlineCode, '<code>\$1</code>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<b>\$1</b>')
        .replace(/\\*(.+?)\\*/g, '<i>\$1</i>');
    }

    function renderMarkdown(raw) {
      if (!raw) return '';
      var safe = escapeHtml(raw);
      var lines = safe.split('\\n');
      var out = '';
      var i = 0;

      while (i < lines.length) {
        var line = lines[i];

        // Fenced code block
        if (line.trimStart().startsWith(FENCE)) {
          var codeLines = [];
          i++;
          while (i < lines.length && !lines[i].trimStart().startsWith(FENCE)) {
            codeLines.push(lines[i]);
            i++;
          }
          i++; // skip closing fence
          out += '<pre><code>' + codeLines.join('\\n') + '</code></pre>';
          continue;
        }

        // Table row (starts with |)
        if (line.trim().startsWith('|')) {
          var tableRows = [];
          while (i < lines.length && lines[i].trim().startsWith('|')) {
            var row = lines[i].trim();
            // Skip separator rows (|---|---|)
            if (/^\\|[\\s:|-]+\\|$/.test(row)) { i++; continue; }
            var cells = row.split('|').filter(function(c, idx, arr) {
              return idx > 0 && idx < arr.length - 1;
            }).map(function(c) { return c.trim(); });
            tableRows.push(cells);
            i++;
          }
          if (tableRows.length > 0) {
            out += '<table>';
            out += '<tr>' + tableRows[0].map(function(c) { return '<th>' + inlineMarkdown(c) + '</th>'; }).join('') + '</tr>';
            for (var r = 1; r < tableRows.length; r++) {
              out += '<tr>' + tableRows[r].map(function(c) { return '<td>' + inlineMarkdown(c) + '</td>'; }).join('') + '</tr>';
            }
            out += '</table>';
          }
          continue;
        }

        // Headers
        if (line.startsWith('#### ')) { out += '<h4>' + inlineMarkdown(line.slice(5)) + '</h4>'; i++; continue; }
        if (line.startsWith('### '))  { out += '<h3>' + inlineMarkdown(line.slice(4)) + '</h3>'; i++; continue; }
        if (line.startsWith('## '))   { out += '<h2>' + inlineMarkdown(line.slice(3)) + '</h2>'; i++; continue; }
        if (line.startsWith('# '))    { out += '<h1>' + inlineMarkdown(line.slice(2)) + '</h1>'; i++; continue; }

        // Unordered list
        if (/^[\\-\\*] /.test(line.trim())) {
          out += '<ul>';
          while (i < lines.length && /^[\\-\\*] /.test(lines[i].trim())) {
            out += '<li>' + inlineMarkdown(lines[i].trim().slice(2)) + '</li>';
            i++;
          }
          out += '</ul>';
          continue;
        }

        // Blank line
        if (!line.trim()) { i++; continue; }

        // Plain paragraph
        out += '<p>' + inlineMarkdown(line) + '</p>';
        i++;
      }
      return out;
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

    function interventionTitle(s) {
      const iv = s.interventions || { interrupt: 0, toolReject: 0, correction: 0 };
      return '人工干预 ' + (s.interventionCount || 0) + ' 次 — ' +
        '中断 ' + (iv.interrupt || 0) + ' · 拒绝 ' + (iv.toolReject || 0) + ' · 纠偏 ' + (iv.correction || 0);
    }

    function fmtTokens(n) {
      n = n || 0;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(n);
    }

    function tokenTotal(t) {
      t = t || {};
      return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreation || 0);
    }

    function tokenTitle(t) {
      t = t || {};
      return 'Token 总量 ' + fmtTokens(tokenTotal(t)) + ' — ' +
        '输入 ' + fmtTokens(t.input) + ' · 输出 ' + fmtTokens(t.output) +
        ' · 缓存读 ' + fmtTokens(t.cacheRead) + ' · 缓存写 ' + fmtTokens(t.cacheCreation);
    }

    function renderCard(s) {
      const isExpanded = expandedCards.has(s.sessionId);
      const isStopped = s.status === 'stopped';
      const dur = durationStr(s.startedAt, isStopped ? s.stoppedAt || s.lastActivity : null);
      const interventionBadge = (s.interventionCount > 0)
        ? '<span class="intervention-badge" title="' + escapeAttr(interventionTitle(s)) + '">⚠ ' + s.interventionCount + '</span>'
        : '';
      const convoBadge = (s.promptCount > 0)
        ? '<span class="convo-badge" title="人工对话 ' + s.promptCount + ' 轮">💬 ' + s.promptCount + '</span>'
        : '';
      const tokenSum = tokenTotal(s.tokens);
      const tokenBadge = (tokenSum > 0)
        ? '<span class="token-badge" title="' + escapeAttr(tokenTitle(s.tokens)) + '">⛁ ' + fmtTokens(tokenSum) + '</span>'
        : '';

      // ─── Expanded detail panel ───
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
            '<div class="ai-output md-output">' + renderMarkdown(s.stoppedOutput) + '</div>';
        }
        detail = '<div class="card-detail open">' + promptsHtml + outputHtml + '</div>';
      }

      // ─── Default card sections (always visible) ───
      // 1. AI Output (with markdown rendering)
      const outputBorderClass = s.status === 'waiting_for_input' ? 'stopped-output waiting-output' : 'stopped-output';
      const aiOutputSection = s.stoppedOutput
        ? '<div class="card-section">' +
            '<div class="card-section-label">AI Output</div>' +
            '<div class="' + outputBorderClass + ' md-output">' + renderMarkdown(s.stoppedOutput) + '</div>' +
          '</div>'
        : '';

      // 2. First question
      const firstQuestionSection = s.promptSummary
        ? '<div class="card-section">' +
            '<div class="card-section-label">First Question</div>' +
            '<div class="prompt-summary">' + escapeHtml(s.promptSummary) + '</div>' +
          '</div>'
        : '';

      // 3. Last question (only if different from first)
      const lastPrompt = s.prompts && s.prompts.length > 1 ? s.prompts[s.prompts.length - 1] : '';
      const lastQuestionSection = lastPrompt
        ? '<div class="card-section">' +
            '<div class="card-section-label">Last Question</div>' +
            '<div class="prompt-summary">' + escapeHtml(lastPrompt) + '</div>' +
          '</div>'
        : '';

      return '<div class="card ' + (isStopped ? 'stopped' : '') + '" data-session-id="' + escapeAttr(s.sessionId) + '">'+
        '<div class="card-header">' +
          '<span class="status-light ' + escapeAttr(s.status) + '"></span>' +
          '<span class="tool-badge">' + escapeHtml(s.tool) + '</span>' +
          '<span class="duration">' + dur + '</span>' +
          convoBadge +
          tokenBadge +
          interventionBadge +
          '<span class="status-text">' + statusLabel(s.status) + '</span>' +
        '</div>' +
        '<div class="cwd" title="' + escapeAttr(s.cwd) + '">' + escapeHtml(shortPath(s.cwd)) + '</div>' +
        aiOutputSection +
        firstQuestionSection +
        lastQuestionSection +
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

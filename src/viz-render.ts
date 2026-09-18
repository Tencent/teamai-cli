// -*- coding: utf-8 -*-
/**
 * TeamAI knowledge base visualization — pure HTML report renderer.
 *
 * No I/O, no external dependencies. Returns a complete standalone HTML document string.
 * All user-supplied data strings are HTML-escaped before insertion to prevent XSS.
 */
import type { VizData, EntryMetric, CoverageStat, TrendPoint, AuthorStat } from './viz.js';
import type { PromotionCandidate } from './maintenance/promote.js';
import type { PruneCandidate } from './maintenance/prune.js';
import type { StaleEntry } from './maintenance/quality-update.js';

// ─── XSS helpers ─────────────────────────────────────────────────────────────

/**
 * Escape a string for safe insertion into HTML content and attribute values.
 * Converts &, <, >, ", and ' to their HTML entity equivalents.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── SVG chart helpers ────────────────────────────────────────────────────────

/** Truncate a string to a maximum length, appending '…' if trimmed. */
function trunc(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

/**
 * Render a horizontal SVG bar chart from a list of labelled numeric values.
 *
 * @param items  - Array of { label, value, badge } tuples.
 */
function renderBarChart(items: Array<{ label: string; value: number; badge: string }>): string {
  if (items.length === 0) return '<p>No data.</p>';

  const BAR_H = 22;
  const GAP = 10;
  const LABEL_W = 220;
  const BAR_AREA = 300;
  const VALUE_W = 50;
  const BADGE_W = 70;
  const ROW_H = BAR_H + GAP;
  const W = LABEL_W + BAR_AREA + VALUE_W + BADGE_W + 20;
  const H = items.length * ROW_H + 10;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const mono = 'font-family:var(--mono)';

  const rows = items.map((item, idx) => {
    const y = idx * ROW_H + 5;
    const barW = Math.max(2, Math.round((item.value / maxVal) * BAR_AREA));
    const textY = y + BAR_H / 2 + 5;
    const labelEl =
      `<text x="0" y="${textY}"` +
      ` style="${mono};font-size:12px;fill:var(--text2)">` +
      `${escapeHtml(trunc(item.label, 30))}</text>`;
    const barEl =
      `<rect x="${LABEL_W}" y="${y}" width="${barW}" height="${BAR_H}"` +
      ` style="fill:var(--accent);opacity:0.9" rx="4"/>`;
    const valEl =
      `<text x="${LABEL_W + BAR_AREA + 6}" y="${textY}"` +
      ` style="${mono};font-size:12px;fill:var(--accent)">${item.value}</text>`;
    const badgeEl =
      `<text x="${LABEL_W + BAR_AREA + VALUE_W + 10}" y="${textY}"` +
      ` style="${mono};font-size:11px;fill:var(--text2)">${escapeHtml(item.badge)}</text>`;
    return labelEl + barEl + valEl + badgeEl;
  });

  return [
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"` +
      ` style="width:100%;max-width:${W}px">`,
    ...rows,
    '</svg>',
  ].join('\n');
}

/**
 * Render an SVG line chart from monthly trend data points.
 *
 * @param points - Array of TrendPoint sorted ascending by period.
 */
function renderLineChart(points: TrendPoint[]): string {
  if (points.length < 2) {
    return '<p class="muted">Not enough data (need at least 2 months of activity).</p>';
  }

  const W = 600;
  const H = 180;
  const PAD_L = 50;
  const PAD_R = 20;
  const PAD_T = 15;
  const PAD_B = 40;
  const PLOT_W = W - PAD_L - PAD_R;
  const PLOT_H = H - PAD_T - PAD_B;

  const maxY = Math.max(...points.map((p) => p.count), 1);
  const n = points.length;

  const toX = (i: number): number => PAD_L + Math.round((i / (n - 1)) * PLOT_W);
  const toY = (v: number): number => PAD_T + PLOT_H - Math.round((v / maxY) * PLOT_H);

  const polyPoints = points.map((p, i) => `${toX(i)},${toY(p.count)}`).join(' ');

  // Area fill polygon: bottom-left → data points → bottom-right
  const bottomY = PAD_T + PLOT_H;
  const areaPoints = [
    `${PAD_L},${bottomY}`,
    ...points.map((p, i) => `${toX(i)},${toY(p.count)}`),
    `${W - PAD_R},${bottomY}`,
  ].join(' ');

  const mono = 'font-family:var(--mono)';

  // Y-axis ticks (0, mid, max)
  const yTicks = [0, Math.round(maxY / 2), maxY].map((v) => {
    const y = toY(v);
    return (
      `<line x1="${PAD_L - 4}" y1="${y}" x2="${PAD_L}" y2="${y}"` +
      ` style="stroke:var(--border)" stroke-width="1"/>` +
      `<text x="${PAD_L - 8}" y="${y + 4}" text-anchor="end"` +
      ` style="${mono};font-size:11px;fill:var(--text2)">${v}</text>`
    );
  });

  // X-axis labels (show every Nth label to avoid overlap)
  const step = Math.max(1, Math.ceil(n / 8));
  const xLabels = points
    .map((p, origIdx) => ({ p, origIdx }))
    .filter(({ origIdx }) => origIdx % step === 0 || origIdx === n - 1)
    .map(({ p, origIdx }) => {
      const x = toX(origIdx);
      return (
        `<text x="${x}" y="${H - 8}" text-anchor="middle"` +
        ` style="${mono};font-size:10px;fill:var(--text2)">${escapeHtml(p.period)}</text>`
      );
    });

  const axisVert =
    `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${bottomY}"` +
    ` style="stroke:var(--border)" stroke-width="1"/>`;
  const axisHoriz =
    `<line x1="${PAD_L}" y1="${bottomY}" x2="${W - PAD_R}" y2="${bottomY}"` +
    ` style="stroke:var(--border)" stroke-width="1"/>`;
  const areaEl = `<polygon points="${areaPoints}" style="fill:var(--accent);opacity:0.08"/>`;
  const lineEl =
    `<polyline points="${polyPoints}" fill="none"` +
    ` style="stroke:var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
  const dots = points.map(
    (p, i) => `<circle cx="${toX(i)}" cy="${toY(p.count)}" r="3.5" style="fill:var(--accent)"/>`,
  );

  return [
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"` +
      ` style="width:100%;max-width:${W}px">`,
    axisVert,
    axisHoriz,
    ...yTicks,
    ...xLabels,
    areaEl,
    lineEl,
    ...dots,
    '</svg>',
  ].join('\n');
}

// ─── Section renderers ────────────────────────────────────────────────────────

/** Render the four overview metric cards (total entries, recalls, coverage, contributors) as an HTML section. */
function renderOverviewCards(data: VizData): string {
  const cards = [
    { label: 'Total Entries', value: String(data.totalEntries) },
    { label: 'Total Recalls', value: String(data.totalRecalls) },
    { label: 'Overall Coverage', value: `${data.overallCoveragePct}%` },
    { label: 'Contributors', value: String(data.contributorCount) },
  ];
  const cardHtml = cards
    .map(
      (c) =>
        `<div class="card">` +
        `<div class="card-label" data-i18n>${escapeHtml(c.label)}</div>` +
        `<div class="card-value">${escapeHtml(c.value)}</div>` +
        `</div>`,
    )
    .join('');
  return `<section id="overview"><h2 data-i18n>Overview</h2><div class="cards">${cardHtml}</div></section>`;
}

/** Render the coverage-by-type progress bar section as an HTML string. */
function renderCoverageSection(coverage: CoverageStat[]): string {
  const rows = coverage
    .map((stat) => {
      const label = escapeHtml(stat.type);
      const pct = stat.coveragePct;
      return [
        `<div class="cov-row">`,
        `  <div class="cov-label">${label}</div>`,
        `  <div class="cov-bar-wrap">`,
        `    <div class="cov-bar" style="width:${pct}%"></div>`,
        `  </div>`,
        `  <div class="cov-stat">${stat.covered}/${stat.total} (${pct}%)</div>`,
        `</div>`,
      ].join('');
    })
    .join('');
  return `<section id="coverage"><h2 data-i18n>Coverage by Type</h2>${rows}</section>`;
}

/** Render the top-recalled entries bar chart section as an HTML string. */
function renderTopRecalledSection(topRecalled: EntryMetric[]): string {
  const items = topRecalled.map((m) => ({
    label: m.title || m.docId,
    value: m.recalledCount,
    badge: m.type,
  }));
  const chart = renderBarChart(items);
  return `<section id="top-recalled"><h2 data-i18n>Top Recalled Entries</h2>${chart}</section>`;
}

/** Render the never-recalled entries section, grouped by type with collapsible details, as an HTML string. */
function renderSilentSection(silent: EntryMetric[]): string {
  if (silent.length === 0) {
    return (
      `<section id="silent"><h2 data-i18n>Never-Recalled Entries</h2>` +
      `<p data-i18n>All entries have been recalled at least once.</p></section>`
    );
  }

  const byType = new Map<string, EntryMetric[]>();
  for (const m of silent) {
    const list = byType.get(m.type) ?? [];
    list.push(m);
    byType.set(m.type, list);
  }

  const groups = Array.from(byType.entries())
    .map(([type, entries]) => {
      const rows = entries
        .map(
          (m) =>
            `<li><span class="entry-title">${escapeHtml(m.title || m.docId)}</span>` +
            ` <span class="muted">— ${escapeHtml(m.author || 'unknown')}</span></li>`,
        )
        .join('');
      return [
        `<details>`,
        `  <summary><span data-i18n>${escapeHtml(type)}</span> (${entries.length})</summary>`,
        `  <ul>${rows}</ul>`,
        `</details>`,
      ].join('');
    })
    .join('');

  return [
    `<section id="silent">`,
    `  <h2><span data-i18n>Never-Recalled Entries</span> (${silent.length})</h2>`,
    `  ${groups}`,
    `</section>`,
  ].join('');
}

/** Render the monthly last-recall trend line chart section as an HTML string. */
function renderTrendSection(trend: TrendPoint[]): string {
  const chart = renderLineChart(trend);
  const note = '<p class="muted" data-i18n>Each entry is counted once, in the month it was last recalled.</p>';
  return `<section id="trend"><h2 data-i18n>Entries by Last-Recall Month</h2>${note}${chart}</section>`;
}

/** Render the author contributions table section as an HTML string. */
function renderAuthorsSection(authors: AuthorStat[]): string {
  if (authors.length === 0) {
    return `<section id="authors"><h2 data-i18n>Author Contributions</h2><p data-i18n>No author data.</p></section>`;
  }
  const header = '<tr><th data-i18n>Author</th><th data-i18n>Entries</th><th data-i18n>Total Recalled</th></tr>';
  const rows = authors
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.author)}</td><td>${a.entries}</td><td>${a.totalRecalled}</td></tr>`,
    )
    .join('');
  return [
    `<section id="authors">`,
    `  <h2 data-i18n>Author Contributions</h2>`,
    `  <table><thead>${header}</thead><tbody>${rows}</tbody></table>`,
    `</section>`,
  ].join('');
}

/** Render the promotable learnings maintenance block as an HTML string. */
function renderPromotionBlock(promote: PromotionCandidate[]): string {
  const intro =
    '<p class="muted">Learnings with high confidence (&ge;0.90) and adoption across ' +
    'multiple users — good candidates to promote to formal skills, rules, or docs.</p>';
  const guide =
    '<div class="maint-guide"><strong>How to promote</strong>' +
    ' — Review a candidate below, then run (each entry shows its own ready-to-copy command):' +
    '<code>teamai recall promote &lt;learning-id&gt; --category skill|rule|doc</code></div>';
  if (promote.length === 0) {
    return `<div class="maint-block"><h3 data-i18n>Promotable Learnings</h3>${intro}${guide}<p data-i18n>None right now.</p></div>`;
  }
  const rows = promote
    .map((c) => {
      const cmd =
        `teamai recall promote ${escapeHtml(c.docId)} --category ${escapeHtml(c.suggestedCategory)}`;
      return [
        `<div class="maint-item">`,
        `  <div><strong>${escapeHtml(c.title)}</strong>`,
        `    <span class="badge" data-i18n>${escapeHtml(c.suggestedCategory)}</span></div>`,
        `  <div class="muted"><span data-i18n>Confidence</span>: ${(c.confidence * 100).toFixed(0)}%`,
        ` | <span data-i18n>Upvotes</span>: ${c.upvotedCount} | <span data-i18n>Users</span>: ${c.userCount}</div>`,
        `  <code>${cmd}</code>`,
        `</div>`,
      ].join('');
    })
    .join('');
  return `<div class="maint-block"><h3 data-i18n>Promotable Learnings</h3>${intro}${guide}${rows}</div>`;
}

/** Render the suggested-for-archive maintenance block as an HTML string. */
function renderPruneBlock(prune: PruneCandidate[]): string {
  const intro =
    '<p class="muted">Learnings below confidence threshold or inactive for &gt;180 days.</p>';
  const guide =
    '<div class="maint-guide"><strong>How to archive</strong>' +
    ' — These are batch-archived together. Review the list below, then run:' +
    '<code>teamai recall maintenance --prune --archive</code></div>';
  if (prune.length === 0) {
    return `<div class="maint-block"><h3 data-i18n>Suggested for Archive</h3>${intro}${guide}<p data-i18n>None right now.</p></div>`;
  }
  const rows = prune
    .map((c) => {
      const activity = c.lastActivity ? escapeHtml(c.lastActivity.substring(0, 10)) : 'unknown';
      return [
        `<div class="maint-item">`,
        `  <div><strong>${escapeHtml(c.filename)}</strong></div>`,
        `  <div class="muted"><span data-i18n>Confidence</span>: ${(c.confidence * 100).toFixed(0)}%`,
        ` | <span data-i18n>Last activity</span>: ${activity} | <span data-i18n>Reason</span>: ${escapeHtml(c.reason)}</div>`,
        `</div>`,
      ].join('');
    })
    .join('');
  return `<div class="maint-block"><h3 data-i18n>Suggested for Archive</h3>${intro}${guide}${rows}</div>`;
}

/** Render the stale-entries (needs quality update) maintenance block as an HTML string. */
function renderStaleBlock(stale: StaleEntry[]): string {
  const intro =
    '<p class="muted">Entries recalled frequently but rarely upvoted — ' +
    'likely stale or low quality. Run the command below to review and refresh them.</p>';
  const guide =
    '<div class="maint-guide"><strong>How to update</strong>' +
    ' — Run the command below to review and refresh these entries:' +
    '<code>teamai recall maintenance --update-quality</code></div>';
  if (stale.length === 0) {
    return (
      `<div class="maint-block"><h3 data-i18n>Stale (Needs Quality Update)</h3>` +
      `${intro}${guide}<p data-i18n>None right now.</p></div>`
    );
  }
  const header =
    '<tr><th data-i18n>Doc ID</th><th data-i18n>Type</th><th data-i18n>Recalls</th><th data-i18n>Upvotes</th><th data-i18n>Users</th></tr>';
  const rows = stale
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.docId)}</td><td>${escapeHtml(s.type)}</td>` +
        `<td>${s.recalledCount}</td><td>${s.upvotedCount}</td><td>${s.userCount}</td></tr>`,
    )
    .join('');
  return [
    `<div class="maint-block">`,
    `  <h3 data-i18n>Stale (Needs Quality Update)</h3>`,
    `  ${intro}`,
    `  ${guide}`,
    `  <table><thead>${header}</thead><tbody>${rows}</tbody></table>`,
    `</div>`,
  ].join('');
}

/** Render the full maintenance console section combining promote, prune, and stale blocks. */
function renderMaintenanceSection(data: VizData): string {
  const promote = renderPromotionBlock(data.maintenance.promote);
  const prune = renderPruneBlock(data.maintenance.prune);
  const stale = renderStaleBlock(data.maintenance.stale);
  return `<section id="maintenance"><h2 data-i18n>Maintenance Console</h2>${promote}${prune}${stale}</section>`;
}

/** Reuse every existing KB report section inside the unified dashboard. */
export function renderDashboardReport(data: VizData): { context: string; maintenance: string } {
  return {
    context: renderOverviewCards(data) + renderCoverageSection(data.coverage)
      + renderTopRecalledSection(data.topRecalled) + renderSilentSection(data.silent)
      + renderTrendSection(data.trend) + renderAuthorsSection(data.authors),
    maintenance: renderMaintenanceSection(data),
  };
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

/**
 * Return the complete inline <style> block for the report.
 *
 * Design direction: refined technical instrument — monospace data readouts,
 * structured hierarchy, electric-blue (#38bdf8 dark / #0284c7 light) as sole accent.
 * Zero external resources; all styles self-contained.
 */
function renderStyles(): string {
  return `
<style>
  /* === Design tokens === */
  /* Dark palette aligned with the dashboard (dashboard-html.ts) */
  :root {
    --bg:         #0d1117;
    --bg2:        #161b22;
    --bg3:        #1c2129;
    --text:       #e6edf3;
    --text2:      #8b949e;
    --accent:     #58a6ff;
    --accent-dim: #1f6feb;
    --border:     #30363d;
    --badge-bg:   #1c2129;
    --badge-text: #58a6ff;
    --code-bg:    #0d1117;
    --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  }

  .source-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 12px;
    background: var(--badge-bg);
    color: var(--badge-text);
  }
  /* team scope uses the default .source-badge style; only local needs an override */
  .source-local {
    background: #3d2e12;
    color: #d29922;
  }

  /* === Reset === */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 15px; }
  body {
    font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.65;
  }

  /* === Header — instrument panel with dot-matrix texture === */
  header {
    background-color: var(--bg2);
    background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
    background-size: 24px 24px;
    border-bottom: 1px solid var(--border);
    padding: 32px 40px;
    position: relative;
  }
  header::after {
    content: '';
    position: absolute;
    bottom: -1px;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), transparent 70%);
  }
  .header-inner {
    position: relative;
    max-width: 960px;
    margin: 0 auto;
  }
  header h1 {
    font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
    font-size: 1.65rem;
    font-weight: 700;
    letter-spacing: -0.025em;
    color: var(--text);
    margin-bottom: 10px;
  }
  .header-meta {
    font-family: var(--mono);
    font-size: 0.74rem;
    color: var(--text2);
    display: flex;
    flex-wrap: wrap;
    gap: 4px 20px;
  }
  .header-meta span::before {
    content: '◆ ';
    color: var(--accent);
    font-size: 0.6em;
    vertical-align: middle;
  }

  /* === Main layout + section counter === */
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 32px 40px;
    counter-reset: section-num;
  }
  section {
    margin-bottom: 52px;
    counter-increment: section-num;
    animation: fadeInUp 0.45s ease both;
  }
  section:nth-child(1) { animation-delay: 0.04s; }
  section:nth-child(2) { animation-delay: 0.10s; }
  section:nth-child(3) { animation-delay: 0.16s; }
  section:nth-child(4) { animation-delay: 0.22s; }
  section:nth-child(5) { animation-delay: 0.28s; }
  section:nth-child(6) { animation-delay: 0.34s; }
  section:nth-child(7) { animation-delay: 0.40s; }
  @keyframes fadeInUp {
    from { opacity: 0; transform: translateY(10px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    section { animation: none; }
  }

  /* === Headings === */
  section > h2 {
    font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text);
    border-bottom: 1px solid var(--border);
    padding-bottom: 10px;
    margin-bottom: 22px;
  }
  section > h2::before {
    content: counter(section-num, decimal-leading-zero) ' ── ';
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--accent);
    letter-spacing: 0.06em;
    opacity: 0.85;
  }
  h3 {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 12px;
  }
  p  { margin-bottom: 10px; }
  .muted { color: var(--text2); font-size: 0.875rem; }

  /* === Overview cards — instrument readout === */
  .cards { display: flex; gap: 16px; flex-wrap: wrap; }
  .card {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-top: 2px solid var(--accent);
    border-radius: 6px;
    padding: 20px 24px;
    min-width: 150px;
    flex: 1;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  }
  .card-label {
    font-family: var(--mono);
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text2);
    margin-bottom: 10px;
  }
  .card-value {
    font-family: var(--mono);
    font-size: 2.1rem;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
  }

  /* === Coverage bars === */
  .cov-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .cov-label {
    font-family: var(--mono);
    width: 110px;
    font-size: 0.76rem;
    text-align: right;
    color: var(--text2);
  }
  .cov-bar-wrap {
    flex: 1;
    height: 8px;
    background: var(--bg3);
    border-radius: 4px;
    overflow: hidden;
  }
  .cov-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    border-radius: 4px;
    transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .cov-stat {
    font-family: var(--mono);
    width: 130px;
    font-size: 0.76rem;
    color: var(--text2);
  }

  /* === Tables === */
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th, td { padding: 9px 12px; border-bottom: 1px solid var(--border); text-align: left; }
  th {
    font-family: var(--mono);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: var(--bg2);
    font-weight: 600;
    color: var(--text2);
  }
  td { color: var(--text); }
  tr:hover td { background: var(--bg3); }

  /* === Silent entries (details/summary) === */
  details { margin-bottom: 8px; }
  summary {
    cursor: pointer;
    padding: 8px 12px;
    border-radius: 6px;
    font-weight: 500;
    font-size: 0.875rem;
    background: var(--bg2);
    border: 1px solid var(--border);
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }
  summary::marker, summary::-webkit-details-marker { display: none; }
  summary::before {
    content: '▶';
    font-size: 0.55rem;
    color: var(--accent);
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }
  details[open] summary::before { transform: rotate(90deg); }
  summary:hover { background: var(--bg3); }
  ul { list-style: none; padding: 4px 16px 8px; }
  li { padding: 5px 0; font-size: 0.875rem; border-bottom: 1px solid var(--border); }
  li:last-child { border-bottom: none; }
  .entry-title { color: var(--text); }

  /* === Badges === */
  .badge {
    display: inline-block;
    font-family: var(--mono);
    font-size: 0.66rem;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--badge-bg);
    color: var(--badge-text);
    margin-left: 6px;
    letter-spacing: 0.04em;
  }

  /* === Maintenance blocks === */
  .maint-block {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 20px;
  }
  .maint-item {
    border-top: 1px solid var(--border);
    padding: 12px 0;
  }
  .maint-item:first-of-type { border-top: none; padding-top: 4px; }

  /* === Maintenance guide bars === */
  .maint-guide {
    border-left: 3px solid var(--accent);
    background: var(--bg3);
    border-radius: 0 6px 6px 0;
    padding: 10px 16px;
    margin: 10px 0 16px;
    font-size: 0.845rem;
    color: var(--text2);
  }
  .maint-guide code {
    display: block;
    margin-top: 8px;
    font-size: 0.82rem;
    border-left: 3px solid var(--accent);
    border-radius: 0 4px 4px 0;
    padding: 7px 14px;
    color: var(--accent);
    background: var(--code-bg);
  }
  .maint-guide code::before {
    content: '$ ';
    opacity: 0.5;
    user-select: none;
  }

  /* === Inline code === */
  code {
    display: inline-block;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 10px;
    font-family: var(--mono);
    font-size: 0.76rem;
    color: var(--accent);
    margin-top: 6px;
    transition: border-color 0.15s;
  }
  code:hover { border-color: var(--accent); }
</style>`;
}

// ─── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render a complete standalone HTML report from the given VizData payload.
 *
 * @param data - Aggregated knowledge base metrics produced by buildVizData.
 * @returns A complete HTML document string, safe to write directly to a .html file.
 */
export function renderReport(data: VizData): string {
  const ts = escapeHtml(data.generatedAt);
  const root = escapeHtml(data.root);

  const sections = [
    renderOverviewCards(data),
    renderCoverageSection(data.coverage),
    renderTopRecalledSection(data.topRecalled),
    renderSilentSection(data.silent),
    renderTrendSection(data.trend),
    renderAuthorsSection(data.authors),
    renderMaintenanceSection(data),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeamAI Knowledge Base Report</title>
  ${renderStyles()}
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>TeamAI Knowledge Base Report</h1>
      <div class="header-meta">
        <span>Generated: ${ts}</span>
        <span>Root: ${root}</span>
        <span class="source-badge source-${data.source.scope}">${escapeHtml(data.source.label)}</span>
      </div>
    </div>
  </header>
  <main>
    ${sections}
  </main>
</body>
</html>`;
}

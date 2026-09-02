/**
 * Config WebUI frontend — one template-literal HTML page with six tabs
 * (仓库 / 分支 / 角色 / 资源 / 设置 / 同步), served by src/config-ui.ts.
 *
 * 界面文案以中文为主(用户要求);代码与 CLI 输出保持英文。
 *
 * Same posture as dashboard-html.ts: zero dependencies, CSS variables,
 * lightweight markdown renderer, escapeHtml/escapeAttr discipline on every
 * interpolated value. Embedded JS deliberately uses NO template literals —
 * string concatenation only — so the TypeScript template is never confused.
 */
export function getConfigUiHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TeamAI 配置台</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface-hover: #1c2129; --border: #30363d;
    --text: #e6edf3; --text-muted: #8b949e; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --gray: #484f58; --blue: #58a6ff; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px 24px;
  }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  header h1 { font-size: 19px; font-weight: 600; }
  .conn { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gray); }
  .dot.on { background: var(--green); }
  .header-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .scope-badge { font-size: 12px; color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; border-radius: 12px; }

  .tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
  .tab {
    padding: 7px 16px; font-size: 13px; border: 1px solid var(--border); border-bottom: none;
    border-radius: 8px 8px 0 0; background: var(--surface); color: var(--text-muted); cursor: pointer;
  }
  .tab.active { color: var(--text); background: var(--surface-hover); border-color: var(--blue); font-weight: 600; }
  .panel { display: none; border: 1px solid var(--border); border-radius: 0 8px 8px 8px; background: var(--surface); padding: 18px; min-height: 400px; }
  .panel.active { display: block; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 14px; }
  .card h3 { font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .kv { display: grid; grid-template-columns: 180px 1fr; gap: 6px 14px; font-size: 13px; }
  .kv .k { color: var(--text-muted); }
  .kv .v { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; word-break: break-all; }

  .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; margin: 2px 4px 2px 0; }
  .badge.ok { background: rgba(63,185,80,.15); color: var(--green); }
  .badge.warn { background: rgba(210,153,34,.15); color: var(--yellow); }
  .badge.err { background: rgba(248,81,73,.15); color: var(--red); }
  .badge.dim { background: var(--border); color: var(--text-muted); }
  .badge.info { background: rgba(88,166,255,.15); color: var(--blue); }
  .badge.purple { background: rgba(188,140,255,.15); color: var(--purple); }

  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 7px 8px; border-bottom: 1px solid rgba(48,54,61,.5); vertical-align: top; }
  tr.rowbtn { cursor: pointer; }
  tr.rowbtn:hover td { background: var(--surface-hover); }
  td.mono, .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11.5px; }

  button {
    background: #21262d; color: var(--text); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 14px; font-size: 12.5px; cursor: pointer;
  }
  button:hover { border-color: var(--blue); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
  button.primary:hover { background: #388bfd; }
  button.danger { background: #da3633; border-color: #da3633; color: #fff; }
  button.small { padding: 3px 10px; font-size: 11.5px; }

  input[type=text], select, textarea {
    background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 10px; font-size: 12.5px; font-family: inherit;
  }
  input[type=text]:focus, select:focus, textarea:focus { outline: none; border-color: var(--blue); }
  textarea { width: 100%; min-height: 60px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 14px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
  .chip.on { border-color: var(--blue); color: var(--blue); background: rgba(88,166,255,.1); }

  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .muted { color: var(--text-muted); font-size: 12px; }
  .hint { font-size: 11.5px; color: var(--text-muted); margin-top: 4px; }

  pre.log {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px;
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11.5px; line-height: 1.5;
    max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 10px;
  }

  .drawer { position: fixed; top: 0; right: -620px; width: 600px; max-width: 92vw; height: 100vh; background: var(--surface); border-left: 1px solid var(--border); transition: right .2s; z-index: 50; display: flex; flex-direction: column; }
  .drawer.open { right: 0; }
  .drawer-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .drawer-head .title { font-size: 13px; font-weight: 600; flex: 1; word-break: break-all; }
  .drawer-body { padding: 16px; overflow-y: auto; flex: 1; }

  .md-output { font-size: 13px; color: var(--text); line-height: 1.6; }
  .md-output h1 { font-size: 18px; font-weight: 600; margin: 12px 0 6px; }
  .md-output h2 { font-size: 16px; font-weight: 600; margin: 10px 0 5px; }
  .md-output h3 { font-size: 14px; font-weight: 600; margin: 8px 0 4px; }
  .md-output h4 { font-size: 13px; font-weight: 600; margin: 6px 0 3px; color: var(--text-muted); }
  .md-output p { margin: 6px 0; }
  .md-output ul { margin: 6px 0; padding-left: 20px; }
  .md-output li { margin: 3px 0; }
  .md-output code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11.5px; background: var(--bg); padding: 1px 5px; border-radius: 3px; }
  .md-output pre { background: var(--bg); border-radius: 6px; padding: 10px; margin: 6px 0; overflow-x: auto; font-size: 11.5px; line-height: 1.45; }
  .md-output pre code { background: none; padding: 0; }
  .md-output table { border-collapse: collapse; margin: 6px 0; font-size: 11.5px; width: 100%; }
  .md-output th, .md-output td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
  .md-output th { background: var(--bg); font-weight: 600; }
  .md-output b, .md-output strong { font-weight: 600; }
  .md-output em, .md-output i { font-style: italic; color: var(--text-muted); }

  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .field .desc { font-size: 11.5px; color: var(--text-muted); margin-bottom: 6px; }
  .field input[type=text], .field select { width: 100%; max-width: 420px; }
  .field .err { color: var(--red); font-size: 11.5px; margin-top: 4px; }
  .field.readonly label:after { content: '（只读）'; color: var(--text-muted); font-weight: 400; font-size: 11px; }

  .diffbox { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; font-size: 12px; font-family: 'SF Mono','Fira Code',monospace; margin-bottom: 14px; }
  .diffrow { display: flex; gap: 8px; margin: 3px 0; }
  .diffkey { width: 200px; color: var(--text-muted); flex-shrink: 0; }
  .diffold { color: var(--red); text-decoration: line-through; }
  .diffnew { color: var(--green); }

  .banner { border: 1px solid var(--border); border-left: 3px solid var(--blue); border-radius: 6px; padding: 10px 14px; font-size: 12.5px; margin-bottom: 12px; background: var(--bg); }
  .banner.warn { border-left-color: var(--yellow); }
  .banner.err { border-left-color: var(--red); }

  .res-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .res-chip { border: 1px solid var(--border); border-radius: 18px; padding: 5px 14px; font-size: 12.5px; cursor: pointer; color: var(--text-muted); }
  .res-chip.active { color: var(--blue); border-color: var(--blue); background: rgba(88,166,255,.08); font-weight: 600; }
  .res-chip .cnt { background: var(--border); border-radius: 9px; padding: 0 7px; font-size: 10.5px; margin-left: 5px; }

  .modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-mask.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; width: 520px; max-width: 92vw; max-height: 84vh; overflow-y: auto; }
  .modal h3 { font-size: 15px; margin-bottom: 12px; }
  .modal .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }

  .empty { text-align: center; color: var(--text-muted); padding: 48px 20px; font-size: 13px; }
  a { color: var(--blue); }
</style>
</head>
<body>
<header>
  <h1>TeamAI 配置台</h1>
  <div class="conn"><span class="dot" id="connDot"></span><span id="connText">连接中…</span></div>
  <div class="header-right">
    <span class="scope-badge" id="scopeBadge"></span>
    <button class="small" id="btnRefreshAll">刷新</button>
  </div>
</header>

<div class="tabs" id="tabs"></div>
<div id="panels"></div>

<!-- 预览抽屉 -->
<div class="drawer" id="drawer">
  <div class="drawer-head">
    <span class="title" id="drawerTitle"></span>
    <span class="muted mono" id="drawerPath"></span>
    <button class="small" id="drawerClose">关闭</button>
  </div>
  <div class="drawer-body" id="drawerBody"></div>
</div>

<!-- 确认对话框 -->
<div class="modal-mask" id="modalMask">
  <div class="modal" id="modalBox"></div>
</div>

<script>
'use strict';
// ─── 基础工具 ──────────────────────────────────────────────
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

var BT = String.fromCharCode(96); // backtick,避免模板字面量
var FENCE = BT + BT + BT;
var reInlineCode = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');

function inlineMd(text) {
  return text
    .replace(reInlineCode, '<code>' + '$1' + '</code>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<b>' + '$1' + '</b>')
    .replace(/(^|[^*])\\*([^*]+?)\\*(?![*])/g, '$1' + '<i>' + '$2' + '</i>');
}

function renderMd(raw) {
  if (!raw) return '';
  var safe = esc(raw);
  var lines = safe.split('\\n');
  var out = '';
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.trimStart().indexOf(FENCE) === 0) {
      var codeLines = [];
      i++;
      while (i < lines.length && lines[i].trimStart().indexOf(FENCE) !== 0) { codeLines.push(lines[i]); i++; }
      i++;
      out += '<pre><code>' + codeLines.join('\\n') + '</code></pre>';
      continue;
    }
    if (line.trim().charAt(0) === '|') {
      var rows = [];
      while (i < lines.length && lines[i].trim().charAt(0) === '|') {
        var row = lines[i].trim();
        if (!/^\\|[\\s:|-]+\\|$/.test(row)) {
          var cells = row.split('|');
          cells = cells.slice(1, cells.length - 1).map(function (c) { return c.trim(); });
          rows.push(cells);
        }
        i++;
      }
      if (rows.length > 0) {
        out += '<table><tr>' + rows[0].map(function (c) { return '<th>' + inlineMd(c) + '</th>'; }).join('') + '</tr>';
        for (var r = 1; r < rows.length; r++) {
          out += '<tr>' + rows[r].map(function (c) { return '<td>' + inlineMd(c) + '</td>'; }).join('') + '</tr>';
        }
        out += '</table>';
      }
      continue;
    }
    if (line.indexOf('#### ') === 0) { out += '<h4>' + inlineMd(line.slice(5)) + '</h4>'; i++; continue; }
    if (line.indexOf('### ') === 0) { out += '<h3>' + inlineMd(line.slice(4)) + '</h3>'; i++; continue; }
    if (line.indexOf('## ') === 0) { out += '<h2>' + inlineMd(line.slice(3)) + '</h2>'; i++; continue; }
    if (line.indexOf('# ') === 0) { out += '<h1>' + inlineMd(line.slice(2)) + '</h1>'; i++; continue; }
    if (/^[\\-\\*] /.test(line.trim())) {
      out += '<ul>';
      while (i < lines.length && /^[\\-\\*] /.test(lines[i].trim())) {
        out += '<li>' + inlineMd(lines[i].trim().slice(2)) + '</li>';
        i++;
      }
      out += '</ul>';
      continue;
    }
    if (!line.trim()) { i++; continue; }
    out += '<p>' + inlineMd(line) + '</p>';
    i++;
  }
  return out;
}

function $(id) { return document.getElementById(id); }

async function apiGet(path) {
  const res = await fetch(path);
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}
async function apiPost(path, data) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(function () { return {}; });
  return { ok: res.ok, status: res.status, body: body };
}

// ─── 中文文案映射 ──────────────────────────────────────────
var TABS = [
  { id: 'repo', zh: '仓库' },
  { id: 'branches', zh: '分支' },
  { id: 'roles', zh: '角色' },
  { id: 'resources', zh: '资源' },
  { id: 'settings', zh: '设置' },
  { id: 'sync', zh: '同步' },
];
var GROUP_ZH = { Repo: '仓库', Roles: '角色', Tags: '标签', Sync: '同步', Recall: '知识召回', Agents: '智能体' };
var SOURCE_ZH = { user: '用户配置', project: '项目配置', 'team-default': '团队默认', unset: '未设置' };
var FIELD_ZH = {
  'updatePolicy': ['更新策略', 'teamai update 的行为:auto 自动 / prompt 询问 / skip 跳过'],
  'repo.branch': ['跟踪分支', '团队仓库的跟踪分支;留空表示跟随远端默认分支。保存后将切换本地克隆的检出分支'],
  'inheritUserScope': ['继承用户作用域', '项目作用域下,同时同步安全的用户级资源并检索其知识库'],
  'primaryRole': ['主角色', '决定可访问的技能/知识命名空间'],
  'additionalRoles': ['附加角色', '在主角色之外合并的角色命名空间'],
  'subscribedTags': ['订阅标签', '只同步匹配标签的技能/规则;留空同步全部'],
  'excludedSkills': ['排除技能', '本地同步时跳过的技能(逗号分隔,不影响团队仓库)'],
  'recallEnabled': ['知识召回', '覆盖团队的召回默认值:未设置=跟随团队 / 开 / 关。切换会增删各 AI 工具中的召回规则与子代理文件'],
  'coAuthorEnabled': ['协作署名', '覆盖团队 Co-Authored-By 默认值:未设置=跟随团队 / 开 / 关'],
  'username': ['用户名', '团队成员用户名'],
  'repo.localPath': ['克隆路径', '团队仓库本地克隆路径'],
  'repo.remote': ['远程地址', '团队仓库远程 URL'],
  'repo.kind': ['仓库类型', 'git / http / self'],
  'scope': ['作用域', '本配置的安装作用域'],
  'enabledAgents': ['已启用工具', '本安装同步的 AI 工具列表'],
  'disabledAgents': ['已禁用工具', '被排除在 teamai 同步之外的工具'],
};
var RES_TYPE_ZH = {
  skills: '技能', rules: '规则', docs: '文档', env: '环境变量', agents: '智能体',
  hooks: '钩子', mcp: 'MCP', culture: '团队文化', roles: '角色', recall: '知识库',
};

// ─── 全局状态 ──────────────────────────────────────────────
var state = {
  activeTab: 'repo',
  scope: null,          // 当前查看的作用域(user|project)
  serverScope: null,
  repo: null, branches: null, roles: null, resources: null, config: null,
  form: {},             // 设置表单草稿 key -> value
  formErrors: {},
  selBranch: null,      // 分支页选中的分支名(null=默认)
  resType: 'skills',    // 资源页当前类型
  jobTimer: null, jobId: null,
};

function scopeQuery() {
  return state.scope ? ('?scope=' + encodeURIComponent(state.scope)) : '';
}
function scopeProject() {
  // 项目作用域的 config 请求交给服务端解析(服务器 cwd)
  return state.scope === 'project' ? { scope: 'project' } : { scope: state.scope || 'user' };
}

// ─── 标签页框架 ────────────────────────────────────────────
function renderTabs() {
  var html = '';
  for (var i = 0; i < TABS.length; i++) {
    var t = TABS[i];
    html += '<div class="tab' + (state.activeTab === t.id ? ' active' : '') + '" data-tab="' + t.id + '">' + t.zh + '</div>';
  }
  $('tabs').innerHTML = html;
  var panels = '';
  for (var j = 0; j < TABS.length; j++) {
    panels += '<div class="panel' + (state.activeTab === TABS[j].id ? ' active' : '') + '" id="panel-' + TABS[j].id + '"></div>';
  }
  $('panels').innerHTML = panels;
}
document.addEventListener('click', function (e) {
  var tab = e.target.closest('[data-tab]');
  if (tab) {
    state.activeTab = tab.dataset.tab;
    renderTabs();
    renderActivePanel();
  }
});

function panel(id) { return $('panel-' + id); }

// ─── 数据加载 ──────────────────────────────────────────────
async function loadRepo() { state.repo = await apiGet('/api/repo' + scopeQuery()); if (state.serverScope === null) state.serverScope = state.repo.scope; if (state.scope === null) state.scope = state.repo.scope; }
async function loadBranches() { try { state.branches = await apiGet('/api/repo/branches' + scopeQuery()); } catch (e) { state.branches = { error: e.message }; } }
async function loadRoles() { try { state.roles = await apiGet('/api/roles' + scopeQuery()); } catch (e) { state.roles = { error: e.message }; } }
async function loadResources() { try { state.resources = await apiGet('/api/resources' + scopeQuery()); } catch (e) { state.resources = { error: e.message }; } }
async function loadConfig() {
  try {
    state.config = await apiGet('/api/config' + scopeQuery());
    state.scope = state.config.scope;
    initFormFromConfig();
  } catch (e) {
    state.config = { error: e.message };
  }
}

async function refreshAll() {
  setConn(true, '已连接');
  try {
    await loadRepo();
    await Promise.all([loadConfig(), loadRoles(), loadResources(), loadBranches()]);
  } catch (e) {
    setConn(false, '加载失败: ' + e.message);
    return;
  }
  renderScopeBadge();
  renderActivePanel();
}
function setConn(on, text) {
  $('connDot').className = 'dot' + (on ? ' on' : '');
  $('connText').textContent = text;
}
function renderScopeBadge() {
  var s = state.scope || '?';
  $('scopeBadge').textContent = '作用域: ' + (s === 'project' ? '项目' : '用户');
}
$('btnRefreshAll').addEventListener('click', function () { refreshAll(); });

// ─── 仓库页 ────────────────────────────────────────────────
function boolBadge(ok, zhOk, zhBad) {
  if (ok === null || ok === undefined) return '<span class="badge dim">' + esc(zhBad || '未知') + '</span>';
  return ok ? '<span class="badge ok">' + esc(zhOk) + '</span>' : '<span class="badge err">' + esc(zhBad) + '</span>';
}
function renderRepo() {
  var p = panel('repo');
  var r = state.repo;
  if (!r) { p.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (!r.initialized) {
    p.innerHTML =
      '<div class="banner warn">尚未初始化 teamai。请先在终端运行初始化命令,然后刷新本页面:</div>' +
      '<pre class="log">teamai init &lt;团队仓库&gt; --scope user   # 用户级安装\\n' +
      'teamai init &lt;团队仓库&gt; --scope project # 项目级安装(在项目根目录执行)</pre>' +
      '<div class="hint">出于安全考虑,配置台不允许直接提交任意仓库地址;初始化请走 CLI。当前作用域:' + esc(r.scope === 'project' ? '项目' : '用户') + '</div>';
    return;
  }
  var h = r.health || {};
  var healthHtml =
    boolBadge(h.checkoutOk, '检出分支正确', '检出分支异常') +
    boolBadge(h.trackingOk, '上游跟踪正常', '上游跟踪异常') +
    boolBadge(h.originHeadOk, 'origin/HEAD 正常', 'origin/HEAD 异常') +
    '<span class="badge ' + ((h.ahead || 0) > 0 ? 'warn' : 'dim') + '">本地领先 ' + esc(h.ahead === null ? '?' : h.ahead) + '</span>' +
    '<span class="badge ' + ((h.behind || 0) > 0 ? 'warn' : 'dim') + '">落后远端 ' + esc(h.behind === null ? '?' : h.behind) + '</span>';

  p.innerHTML =
    '<div class="card"><h3>仓库信息</h3><div class="kv">' +
    kvRow('远程地址', r.remote) + kvRow('提供商', r.provider) + kvRow('类型', r.kind) +
    kvRow('本地克隆', r.localPath) + kvRow('用户名', r.username) +
    kvRow('作用域', r.scope === 'project' ? '项目' : '用户') +
    kvRow('跟踪分支', r.trackedBranch || '(默认分支)') +
    kvRow('默认分支', r.defaultBranch || '未知') +
    '</div></div>' +
    '<div class="card"><h3>分支健康</h3>' + healthHtml + '</div>' +
    '<div class="card"><h3>同步状态</h3><div class="kv">' +
    kvRow('上次拉取', fmtTime(r.state && r.state.lastPull)) +
    kvRow('上次推送', fmtTime(r.state && r.state.lastPush)) +
    kvRow('待处理 PR', String(r.state ? r.state.pendingPushes : 0)) +
    '</div></div>';
}
function kvRow(k, v) {
  return '<div class="k">' + esc(k) + '</div><div class="v">' + esc(v === null || v === undefined || v === '' ? '(空)' : v) + '</div>';
}
function fmtTime(iso) {
  if (!iso) return '(从未)';
  try {
    var d = new Date(iso);
    var diff = Date.now() - d.getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    return d.toLocaleString('zh-CN');
  } catch (e) { return iso; }
}

// ─── 分支页 ────────────────────────────────────────────────
function renderBranches() {
  var p = panel('branches');
  var b = state.branches;
  if (!b) { p.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (b.error) { p.innerHTML = '<div class="banner err">无法列出分支:' + esc(b.error) + '</div><div class="hint">仅 git 类型团队仓库支持分支管理。</div>'; return; }

  var rows = '';
  var list = b.branches || [];
  if (list.length === 0) {
    rows = '<tr><td colspan="4" class="muted">远端没有任何分支</td></tr>';
  }
  for (var i = 0; i < list.length; i++) {
    var br = list[i];
    var marks = '';
    if (b.currentTracked && br.name === b.currentTracked) marks += '<span class="badge info">当前跟踪</span> ';
    if (b.defaultBranch && br.name === b.defaultBranch) marks += '<span class="badge purple">默认</span> ';
    var checked = '';
    var isDefaultTarget = state.selBranch === null && (!b.currentTracked || br.name === b.defaultBranch);
    var isSelTarget = state.selBranch === br.name;
    if (isDefaultTarget || isSelTarget) checked = ' checked';
    rows += '<tr><td><input type="radio" name="selbranch" value="' + escAttr(br.name) + '"' + checked + '></td>' +
      '<td class="mono">' + esc(br.name) + '</td>' +
      '<td class="muted mono">' + esc(String(br.sha).slice(0, 8)) + '</td>' +
      '<td>' + marks + '</td></tr>';
  }
  // “回到默认分支”选项
  var defaultOption = '<tr><td><input type="radio" name="selbranch" value=""' + (state.selBranch === null ? ' checked' : '') + '></td>' +
    '<td class="mono">(默认分支' + (b.defaultBranch ? ': ' + esc(b.defaultBranch) : '') + ')</td><td></td><td><span class="badge dim">取消固定分支</span></td></tr>';

  p.innerHTML =
    '<div class="toolbar"><span class="muted">选择一个分支后点击「重新初始化」。操作将以后台任务执行:init --branch → pull --force,并保留当前角色与工具配置。</span></div>' +
    '<table><tr><th></th><th>分支</th><th>HEAD</th><th>标记</th></tr>' + defaultOption + rows + '</table>' +
    '<div class="toolbar" style="margin-top:14px">' +
    '<button class="primary" id="btnReinit">用所选分支重新初始化</button>' +
    '<span class="muted" id="reinitStatus"></span>' +
    '</div>' +
    '<pre class="log" id="jobLog" style="display:none"></pre>';

  p.querySelectorAll('input[name=selbranch]').forEach(function (input) {
    input.addEventListener('change', function () {
      state.selBranch = input.value === '' ? null : input.value;
    });
  });
  $('btnReinit').addEventListener('click', confirmReinit);
}

function confirmReinit() {
  var b = state.branches;
  var cfg = state.config && state.config.localConfig ? state.config.localConfig : null;
  var branchLabel = state.selBranch === null ? ('默认分支' + (b.defaultBranch ? '(' + b.defaultBranch + ')' : '')) : state.selBranch;
  var keepRole = cfg && cfg.primaryRole ? cfg.primaryRole : '(无)';
  var keepAgents = cfg && cfg.enabledAgents && cfg.enabledAgents.length ? cfg.enabledAgents.join(', ') : '(全部已安装工具)';
  var body =
    '<h3>确认重新初始化</h3>' +
    '<div class="kv">' +
    kvRow('目标分支', branchLabel) +
    kvRow('作用域', state.scope === 'project' ? '项目' : '用户') +
    kvRow('保留主角色', keepRole) +
    kvRow('保留工具', keepAgents) +
    '</div>' +
    '<div class="banner warn" style="margin-top:12px">重新初始化会用所选分支覆盖本地配置与已同步资源;若本地克隆有未提交改动,任务会被拒绝(可选择强制丢弃,丢弃的提交仍可在 reflog 中找回)。</div>' +
    '<div class="actions"><button id="modalCancel">取消</button><button class="primary" id="modalOk">开始执行</button></div>';
  openModal(body);
  $('modalCancel').addEventListener('click', closeModal);
  $('modalOk').addEventListener('click', function () { closeModal(); startReinit(false); });
}

async function startReinit(force) {
  var st = $('reinitStatus');
  st.textContent = '提交中…';
  var res = await apiPost('/api/repo/reinit', { branch: state.selBranch, scope: state.scope, force: force });
  if (res.status === 409 && res.body.dirtyFiles) {
    st.textContent = '';
    var files = res.body.dirtyFiles.map(esc).join('\\n');
    var body =
      '<h3>本地克隆有未提交改动</h3>' +
      '<pre class="log">' + files + (res.body.dirtyFiles.length >= 50 ? '\\n…' : '') + '</pre>' +
      '<div class="banner warn">强制继续会丢弃这些改动(提交记录保留在 reflog)。是否强制执行?</div>' +
      '<div class="actions"><button id="modalCancel">取消</button><button class="danger" id="modalForce">强制继续(丢弃改动)</button></div>';
    openModal(body);
    $('modalCancel').addEventListener('click', closeModal);
    $('modalForce').addEventListener('click', function () { closeModal(); startReinit(true); });
    return;
  }
  if (!res.ok) {
    st.textContent = '失败:' + (res.body.error || res.status);
    return;
  }
  st.textContent = '';
  followJob(res.body.jobId, 'jobLog', 'reinitStatus', function () {
    refreshAll();
  });
}

// ─── 任务轮询 ──────────────────────────────────────────────
var JOB_STATUS_ZH = { queued: '排队中', running: '执行中', done: '已完成', error: '失败' };
function followJob(jobId, logEl, statusEl, onDone) {
  if (state.jobTimer) clearInterval(state.jobTimer);
  state.jobId = jobId;
  var log = $(logEl);
  var st = $(statusEl);
  if (log) { log.style.display = 'block'; log.textContent = '任务 ' + jobId + ' 启动中…'; }
  state.jobTimer = setInterval(async function () {
    try {
      var job = await apiGet('/api/jobs/' + encodeURIComponent(jobId));
      if (log) {
        log.textContent = job.log || '(暂无输出)';
        log.scrollTop = log.scrollHeight;
      }
      if (st) {
        var label = JOB_STATUS_ZH[job.status] || job.status;
        st.textContent = '任务状态:' + label + (job.exitCode !== null && job.exitCode !== 0 ? '(退出码 ' + job.exitCode + ')' : '');
      }
      if (job.status === 'done' || job.status === 'error') {
        clearInterval(state.jobTimer);
        state.jobTimer = null;
        if (onDone) onDone(job.status === 'done');
      }
    } catch (e) {
      clearInterval(state.jobTimer);
      state.jobTimer = null;
      if (st) st.textContent = '任务查询失败:' + e.message;
    }
  }, 1000);
}

// ─── 角色页 ────────────────────────────────────────────────
function renderRoles() {
  var p = panel('roles');
  var d = state.roles;
  if (!d) { p.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (d.error) { p.innerHTML = '<div class="banner err">' + esc(d.error) + '</div><div class="hint">团队仓库缺少 manifest/roles.yaml 时无法使用角色功能。</div>'; return; }

  var binding = d.binding || {};
  var rows = '';
  var list = d.roles || [];
  if (list.length === 0) rows = '<tr><td colspan="4" class="muted">清单中没有角色</td></tr>';
  for (var i = 0; i < list.length; i++) {
    var role = list[i];
    var bindState = '';
    if (binding.primaryRole === role.id) bindState += '<span class="badge info">主角色</span> ';
    if ((binding.additionalRoles || []).indexOf(role.id) >= 0) bindState += '<span class="badge dim">附加</span>';
    if (!bindState) bindState = '<span class="muted">—</span>';
    rows += '<tr><td class="mono">' + esc(role.id) + '</td><td>' + esc(role.description) + '</td>' +
      '<td class="mono">' + esc((role.skillNamespaces || []).join(', ')) + '</td>' +
      '<td>' + bindState + '</td></tr>';
  }

  var staleBadge = binding.stale ? ' <span class="badge warn">资源档案版本过期</span>' : '';
  var primaryOpts = '<option value="">(未选择)</option>';
  var additionalChips = '';
  for (var j = 0; j < list.length; j++) {
    var r2 = list[j];
    var sel = binding.primaryRole === r2.id ? ' selected' : '';
    primaryOpts += '<option value="' + escAttr(r2.id) + '"' + sel + '>' + esc(r2.id) + (r2.description ? ' — ' + esc(r2.description) : '') + '</option>';
    var on = (binding.additionalRoles || []).indexOf(r2.id) >= 0 ? ' on' : '';
    additionalChips += '<span class="chip' + on + '" data-role="' + escAttr(r2.id) + '">' + esc(r2.id) + '</span>';
  }

  var effHtml = '';
  if (d.effective) {
    effHtml = '<div class="card"><h3>生效的命名空间</h3><div class="kv">' +
      kvRow('技能命名空间', (d.effective.skills || []).join(', ')) +
      kvRow('知识命名空间', (d.effective.knowledge || []).join(', ')) +
      '</div></div>';
  }

  p.innerHTML =
    '<div class="banner">角色清单版本:v' + esc(d.version) + staleBadge + '</div>' +
    '<table><tr><th>ID</th><th>描述</th><th>技能命名空间</th><th>绑定状态</th></tr>' + rows + '</table>' +
    '<div class="card" style="margin-top:14px"><h3>绑定编辑</h3>' +
    '<div class="field"><label>主角色</label><select id="bindPrimary">' + primaryOpts + '</select></div>' +
    '<div class="field"><label>附加角色(点击切换)</label><div class="chips" id="bindAdditional">' + additionalChips + '</div></div>' +
    '<div class="toolbar"><button class="primary" id="btnBindSave">保存绑定</button><span class="muted" id="bindStatus"></span></div>' +
    '</div>' + effHtml +
    '<div class="banner" id="bindBanner" style="display:none">绑定已保存。变更将在下次 pull 时生效。<button class="small" id="btnBindSync" style="margin-left:10px">立即同步</button></div>';

  $('bindPrimary').value = binding.primaryRole || '';
  var chips = p.querySelectorAll('#bindAdditional .chip');
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () { chip.classList.toggle('on'); });
  });
  $('btnBindSave').addEventListener('click', saveBind);
  $('btnBindSync').addEventListener('click', function () {
    $('bindBanner').style.display = 'none';
    switchTab('sync');
    startSync();
  });
}

async function saveBind() {
  var st = $('bindStatus');
  st.textContent = '保存中…';
  var primary = $('bindPrimary').value;
  var additional = [];
  document.querySelectorAll('#bindAdditional .chip.on').forEach(function (chip) {
    additional.push(chip.dataset.role);
  });
  var payload = { scope: state.scope, additionalRoles: additional };
  if (primary) payload.primaryRole = primary;
  var res = await apiPost('/api/roles/bind', payload);
  if (!res.ok) {
    var errs = (res.body.errors || []).map(function (e) { return esc(e.key + ': ' + e.message); }).join('<br>');
    st.innerHTML = '<span style="color:var(--red)">保存失败</span>';
    if (errs) {
      openModal('<h3>保存失败</h3><div class="banner err">' + errs + '</div>' +
        (res.body.roles ? '<div class="hint">有效角色:' + esc(res.body.roles.join(', ')) + '</div>' : '') +
        '<div class="actions"><button id="modalCancel">知道了</button></div>');
      $('modalCancel').addEventListener('click', closeModal);
    }
    return;
  }
  st.textContent = '已保存';
  $('bindBanner').style.display = 'block';
  await loadRoles();
  await loadConfig();
  renderRoles();
}

// ─── 资源页 ────────────────────────────────────────────────
function renderResources() {
  var p = panel('resources');
  var d = state.resources;
  if (!d) { p.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (d.error) { p.innerHTML = '<div class="banner err">' + esc(d.error) + '</div>'; return; }

  var chips = '';
  var defs = [
    ['skills', d.skills.count], ['rules', d.rules.count], ['docs', d.docs.count], ['env', d.env.count],
    ['agents', d.agents.count], ['hooks', d.hooks.count], ['mcp', d.mcp.count],
    ['culture', d.culture.present ? 1 : 0], ['roles', d.roles.count], ['recall', d.recall.entries.length],
  ];
  for (var i = 0; i < defs.length; i++) {
    var active = state.resType === defs[i][0] ? ' active' : '';
    chips += '<span class="res-chip' + active + '" data-res="' + defs[i][0] + '">' + RES_TYPE_ZH[defs[i][0]] + '<span class="cnt">' + defs[i][1] + '</span></span>';
  }
  p.innerHTML = '<div class="res-chips" id="resChips">' + chips + '</div><div id="resBody"></div>';
  p.querySelectorAll('[data-res]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      state.resType = chip.dataset.res;
      renderResources();
    });
  });
  renderResourceBody();
}

function renderResourceBody() {
  var el = $('resBody');
  if (!el) return;
  var d = state.resources;
  var t = state.resType;
  var html = '';

  if (t === 'skills') {
    var rows = '';
    var items = d.skills.items;
    if (items.length === 0) rows = '<tr><td colspan="5" class="muted">无</td></tr>';
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      rows += '<tr class="rowbtn" data-preview="skill" data-id="' + escAttr(s.name) + '">' +
        '<td class="mono">' + esc(s.namespace || '(根)') + '</td><td class="mono">' + esc(s.name) + '</td>' +
        '<td>' + esc(s.description) + '</td>' +
        '<td>' + (s.active ? '<span class="badge ok">生效</span>' : '<span class="badge dim">未激活</span>') +
        (s.excluded ? ' <span class="badge err">已排除</span>' : '') + '</td>' +
        '<td>' + (s.installed ? '<span class="badge ok">已安装</span>' : '<span class="badge dim">未安装</span>') + '</td></tr>';
    }
    html = truncNote(d.skills) + '<table><tr><th>命名空间</th><th>名称</th><th>描述</th><th>状态</th><th>安装</th></tr>' + rows + '</table>';
  } else if (t === 'rules') {
    var rows2 = '';
    var items2 = d.rules.items;
    if (items2.length === 0) rows2 = '<tr><td colspan="3" class="muted">无</td></tr>';
    for (var j = 0; j < items2.length; j++) {
      var ru = items2[j];
      rows2 += '<tr class="rowbtn" data-preview="rule" data-id="' + escAttr(ru.name) + '">' +
        '<td class="mono">' + esc(ru.namespace || '(根)') + '</td><td class="mono">' + esc(ru.name) + '</td>' +
        '<td>' + (ru.active ? '<span class="badge ok">生效</span>' : '<span class="badge dim">被标签过滤</span>') + '</td></tr>';
    }
    html = truncNote(d.rules) + '<table><tr><th>命名空间</th><th>名称</th><th>状态</th></tr>' + rows2 + '</table>';
  } else if (t === 'docs') {
    var rows3 = '';
    var items3 = d.docs.items;
    if (items3.length === 0) rows3 = '<tr><td colspan="2" class="muted">无</td></tr>';
    for (var k = 0; k < items3.length; k++) {
      rows3 += '<tr class="rowbtn" data-preview="doc" data-id="' + escAttr(items3[k].name) + '">' +
        '<td class="mono">' + esc(items3[k].name) + '</td><td>' + esc(items3[k].title) + '</td></tr>';
    }
    html = truncNote(d.docs) + '<table><tr><th>名称</th><th>标题</th></tr>' + rows3 + '</table>';
  } else if (t === 'env') {
    var rows4 = '';
    var items4 = d.env.items;
    if (items4.length === 0) rows4 = '<tr><td colspan="2" class="muted">无</td></tr>';
    for (var m = 0; m < items4.length; m++) {
      rows4 += '<tr><td class="mono">' + esc(items4[m].name) + '</td>' +
        '<td>' + (items4[m].injectShellProfile ? '<span class="badge info">注入 Shell 配置</span>' : '<span class="badge dim">仅 env.sh</span>') + '</td></tr>';
    }
    html = '<div class="banner warn">出于安全考虑,环境变量只显示名称与注入策略,永不显示值。</div>' +
      truncNote(d.env) + '<table><tr><th>变量名</th><th>注入策略</th></tr>' + rows4 + '</table>';
  } else if (t === 'agents') {
    var rows5 = '';
    var items5 = d.agents.items;
    if (items5.length === 0) rows5 = '<tr><td colspan="2" class="muted">无</td></tr>';
    for (var n = 0; n < items5.length; n++) {
      rows5 += '<tr class="rowbtn" data-preview="agent" data-id="' + escAttr(items5[n].name) + '">' +
        '<td class="mono">' + esc(items5[n].name) + '</td><td>' + esc(items5[n].description) + '</td></tr>';
    }
    html = truncNote(d.agents) + '<table><tr><th>名称</th><th>描述</th></tr>' + rows5 + '</table>';
  } else if (t === 'hooks') {
    var rows6 = '';
    var items6 = d.hooks.items;
    if (items6.length === 0) rows6 = '<tr><td colspan="4" class="muted">无</td></tr>';
    for (var o = 0; o < items6.length; o++) {
      var hk = items6[o];
      rows6 += '<tr class="rowbtn" data-preview="hook" data-id="' + escAttr(hk.name) + '">' +
        '<td class="mono">' + esc(hk.name) + '</td><td>' + esc(hk.description) + '</td>' +
        '<td>' + (hk.autoApply ? '<span class="badge ok">pull 自动应用</span>' : '<span class="badge dim">需手动 inject</span>') +
        (hk.requireTeamScripts ? ' <span class="badge warn">限制 team-scripts</span>' : '') + '</td>' +
        '<td class="mono">' + esc(hk.command) + '</td></tr>';
    }
    html = truncNote(d.hooks) + '<table><tr><th>ID</th><th>描述</th><th>策略</th><th>命令</th></tr>' + rows6 + '</table>';
  } else if (t === 'mcp') {
    var rows7 = '';
    var items7 = d.mcp.items;
    if (items7.length === 0) rows7 = '<tr><td colspan="2" class="muted">无</td></tr>';
    for (var q = 0; q < items7.length; q++) {
      rows7 += '<tr class="rowbtn" data-preview="mcp" data-id="' + escAttr(items7[q].name) + '">' +
        '<td class="mono">' + esc(items7[q].name) + '</td><td>' + esc(items7[q].transport) + '</td></tr>';
    }
    html = truncNote(d.mcp) + '<table><tr><th>名称</th><th>传输</th></tr>' + rows7 + '</table>';
  } else if (t === 'culture') {
    if (d.culture.present) {
      html = '<div class="muted" style="margin-bottom:8px">路径:' + esc(d.culture.path) + '</div><button class="primary" data-preview="culture" data-id="culture.md">预览 culture.md</button>';
    } else {
      html = '<div class="empty">团队仓库中没有 culture.md</div>';
    }
  } else if (t === 'roles') {
    var rows8 = '';
    var ids = d.roles.ids;
    if (ids.length === 0) rows8 = '<tr><td class="muted">无</td></tr>';
    for (var w = 0; w < ids.length; w++) {
      rows8 += '<tr class="rowbtn" data-preview="role" data-id="' + escAttr(ids[w]) + '"><td class="mono">' + esc(ids[w]) + '</td></tr>';
    }
    html = '<table><tr><th>角色 ID</th></tr>' + rows8 + '</table><div class="hint">点击行可预览 roles.yaml 清单。绑定请前往「角色」页。</div>';
  } else if (t === 'recall') {
    var statusBadge = d.recall.indexStatus === 'fresh' ? '<span class="badge ok">索引最新</span>'
      : d.recall.indexStatus === 'stale' ? '<span class="badge warn">索引过期</span>'
      : '<span class="badge err">索引缺失</span>';
    var rows9 = '';
    var entries = d.recall.entries;
    if (entries.length === 0) rows9 = '<tr><td colspan="4" class="muted">暂无条目。运行 teamai pull 构建索引。</td></tr>';
    for (var z = 0; z < entries.length; z++) {
      var en = entries[z];
      rows9 += '<tr class="rowbtn" data-preview="learning" data-id="' + escAttr(en.path.split('/').pop()) + '">' +
        '<td>' + esc(en.title) + '</td><td class="mono">' + esc(en.path) + '</td>' +
        '<td>' + esc(en.domain || '-') + '</td><td class="muted">' + esc(fmtTime(en.updatedAt)) + '</td></tr>';
    }
    html = '<div class="card"><h3>知识库检索 ' + statusBadge + '</h3>' +
      '<div class="toolbar"><input type="text" id="recallQ" placeholder="输入关键词,回车检索…" style="flex:1">' +
      '<button class="primary" id="recallGo">检索</button></div>' +
      '<div id="recallResults"></div></div>' +
      '<h3 style="font-size:12px;color:var(--text-muted);margin:14px 0 8px">全部条目(' + entries.length + ')</h3>' +
      '<table><tr><th>标题</th><th>路径</th><th>领域</th><th>更新时间</th></tr>' + rows9 + '</table>';
  }
  el.innerHTML = html;

  el.querySelectorAll('[data-preview]').forEach(function (row) {
    row.addEventListener('click', function () {
      openPreview(row.dataset.preview, row.dataset.id);
    });
  });
  var recallGo = $('recallGo');
  if (recallGo) {
    recallGo.addEventListener('click', runRecallSearch);
    $('recallQ').addEventListener('keydown', function (e) { if (e.key === 'Enter') runRecallSearch(); });
  }
}
function truncNote(section) {
  return section.truncated ? '<div class="hint">列表已截断,仅显示前 ' + section.items.length + ' 条(共 ' + section.count + ' 条)。</div>' : '';
}

async function runRecallSearch() {
  var q = $('recallQ').value.trim();
  var box = $('recallResults');
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="muted">检索中…</div>';
  try {
    var res = await apiGet('/api/recall/search?q=' + encodeURIComponent(q) + '&limit=8' + scopeQuery());
    if (res.status === 'missing') {
      box.innerHTML = '<div class="banner warn">' + esc(res.hint || '索引缺失') + '</div>';
      return;
    }
    if (!res.results || res.results.length === 0) {
      box.innerHTML = '<div class="muted">没有匹配结果。</div>';
      return;
    }
    var html = '<table><tr><th>标题</th><th>得分</th><th>摘要</th></tr>';
    for (var i = 0; i < res.results.length; i++) {
      var r = res.results[i];
      html += '<tr class="rowbtn" data-preview="learning" data-id="' + escAttr(r.path.split('/').pop()) + '">' +
        '<td>' + esc(r.title) + '</td><td class="mono">' + esc(r.score) + '</td>' +
        '<td class="muted">' + esc(r.snippet) + '</td></tr>';
    }
    html += '</table>';
    box.innerHTML = html;
    box.querySelectorAll('[data-preview]').forEach(function (row) {
      row.addEventListener('click', function () { openPreview(row.dataset.preview, row.dataset.id); });
    });
  } catch (e) {
    box.innerHTML = '<div class="banner err">检索失败:' + esc(e.message) + '</div>';
  }
}

// ─── 预览抽屉 ──────────────────────────────────────────────
async function openPreview(type, id) {
  $('drawerTitle').textContent = (RES_TYPE_ZH[type] || type) + ' · ' + id;
  $('drawerPath').textContent = '';
  $('drawerBody').innerHTML = '<div class="empty">加载中…</div>';
  $('drawer').classList.add('open');
  try {
    var res = await apiGet('/api/resources/preview?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id) + scopeQuery());
    $('drawerPath').textContent = res.path || '';
    var body = '';
    if (res.truncated) body += '<div class="banner warn">内容超过 200 KB,已截断。</div>';
    if (res.language === 'markdown') {
      body += '<div class="md-output">' + renderMd(res.content) + '</div>';
    } else {
      body += '<pre class="log" style="max-height:none">' + esc(res.content) + '</pre>';
    }
    $('drawerBody').innerHTML = body;
  } catch (e) {
    $('drawerBody').innerHTML = '<div class="banner err">无法预览:' + esc(e.message) + '</div>';
  }
}
$('drawerClose').addEventListener('click', function () { $('drawer').classList.remove('open'); });

// ─── 设置页 ────────────────────────────────────────────────
function initFormFromConfig() {
  state.form = {};
  state.formErrors = {};
  var fields = state.config && state.config.fields ? state.config.fields : [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.spec.type === 'boolean-tri') {
      state.form[f.spec.key] = f.value === undefined ? 'unset' : String(f.value);
    } else if (f.spec.type === 'string[]') {
      state.form[f.spec.key] = Array.isArray(f.value) ? f.value.join(', ') : '';
    } else if (f.spec.type === 'boolean') {
      state.form[f.spec.key] = f.value === undefined ? false : !!f.value;
    } else {
      state.form[f.spec.key] = f.value === undefined || f.value === null ? '' : String(f.value);
    }
  }
}

function formFieldValue(key, spec) {
  var raw = state.form[key];
  if (spec.type === 'boolean-tri') return raw; // 'unset' | 'true' | 'false'
  if (spec.type === 'boolean') return raw === true || raw === 'true';
  if (spec.type === 'string[]') {
    return String(raw || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }
  return raw;
}

function computeDiff() {
  if (!state.config || !state.config.fields) return [];
  var diffs = [];
  var fields = state.config.fields;
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.spec.readOnly) continue;
    var oldVal = f.value;
    var newVal = formFieldValue(f.spec.key, f.spec.type);
    var oldStr = specEquals(oldVal, newVal, f.spec.type) ? null : stringifyVal(oldVal, f.spec.type);
    if (oldStr === null) continue;
    diffs.push({ key: f.spec.key, old: oldStr, neu: stringifyVal(newVal, f.spec.type) });
  }
  return diffs;
}
function stringifyVal(v, type) {
  if (type === 'boolean-tri') return v === 'unset' || v === undefined ? '(未设置)' : String(v);
  if (type === 'string[]') return Array.isArray(v) ? (v.length ? v.join(', ') : '(空)') : String(v);
  if (v === undefined || v === null || v === '') return type === 'string' && arguments[2] ? '' : '(空)';
  return String(v);
}
function specEquals(oldVal, newVal, type) {
  if (type === 'boolean-tri') {
    var o = oldVal === undefined ? 'unset' : String(oldVal);
    return o === newVal;
  }
  if (type === 'string[]') {
    var o2 = Array.isArray(oldVal) ? oldVal : [];
    var n2 = Array.isArray(newVal) ? newVal : [];
    return JSON.stringify(o2.slice().sort()) === JSON.stringify(n2.slice().sort());
  }
  var os = oldVal === undefined || oldVal === null ? '' : String(oldVal);
  var ns = newVal === undefined || newVal === null ? '' : String(newVal);
  return os === ns;
}

function renderSettings() {
  var p = panel('settings');
  if (!state.config) { p.innerHTML = '<div class="empty">加载中…</div>'; return; }
  if (state.config.error) {
    p.innerHTML = '<div class="banner err">' + esc(state.config.error) + '</div><div class="hint">请先在终端运行 teamai init 初始化后再使用设置页。</div>';
    return;
  }

  var scopeSwitch =
    '<div class="toolbar">' +
    '<span class="muted">作用域:</span>' +
    '<select id="scopeSwitch">' +
    '<option value="user"' + (state.scope === 'user' ? ' selected' : '') + '>用户(~/.teamai)</option>' +
    '<option value="project"' + (state.scope === 'project' ? ' selected' : '') + '>项目(&lt;项目&gt;/.teamai)</option>' +
    '</select>' +
    '<span class="muted" id="settingsStatus"></span>' +
    '</div>';

  var diffs = computeDiff();
  var diffHtml = '';
  if (diffs.length > 0) {
    diffHtml = '<div class="diffbox"><strong>未保存的变更(' + diffs.length + ')</strong>';
    for (var i = 0; i < diffs.length; i++) {
      diffHtml += '<div class="diffrow"><span class="diffkey">' + esc(diffs[i].key) + '</span>' +
        '<span class="diffold">' + esc(diffs[i].old) + '</span><span>→</span>' +
        '<span class="diffnew">' + esc(diffs[i].neu) + '</span></div>';
    }
    diffHtml += '</div>';
  }

  var groups = {};
  var fields = state.config.fields;
  for (var j = 0; j < fields.length; j++) {
    var f = fields[j];
    var g = f.spec.group;
    if (!groups[g]) groups[g] = [];
    groups[g].push(f);
  }

  var formHtml = '';
  var order = ['Sync', 'Repo', 'Roles', 'Tags', 'Recall', 'Agents'];
  for (var k = 0; k < order.length; k++) {
    var gname = order[k];
    var gfields = groups[gname];
    if (!gfields || gfields.length === 0) continue;
    formHtml += '<div class="card"><h3>' + esc(GROUP_ZH[gname] || gname) + '</h3>';
    for (var m = 0; m < gfields.length; m++) {
      formHtml += renderField(gfields[m]);
    }
    formHtml += '</div>';
  }

  p.innerHTML = scopeSwitch + diffHtml +
    '<div class="toolbar"><button class="primary" id="btnSaveSettings"' + (diffs.length === 0 ? ' disabled' : '') + '>保存设置</button>' +
    '<button id="btnResetSettings">放弃变更</button></div>' +
    '<div id="saveBanner"></div>' + formHtml;

  $('scopeSwitch').addEventListener('change', async function () {
    state.scope = this.value;
    renderScopeBadge();
    await loadConfig();
    await Promise.all([loadRepo(), loadRoles(), loadResources(), loadBranches()]);
    renderActivePanel();
  });
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnResetSettings').addEventListener('click', async function () {
    initFormFromConfig();
    renderSettings();
  });
  bindFieldEvents(p);
}

function renderField(f) {
  var spec = f.spec;
  var zh = FIELD_ZH[spec.key] || [spec.label, spec.description];
  var err = state.formErrors[spec.key];
  var errHtml = err ? '<div class="err">' + esc(err) + '</div>' : '';
  var sourceNote = ' <span class="badge dim" title="当前取值来源">' + esc(SOURCE_ZH[f.source] || f.source) + '</span>';
  var html = '<div class="field' + (spec.readOnly ? ' readonly' : '') + '" data-key="' + escAttr(spec.key) + '">' +
    '<label>' + esc(zh[0]) + sourceNote + '</label>' +
    '<div class="desc">' + esc(zh[1] || '') + '</div>';

  if (spec.readOnly) {
    var roVal = f.value;
    var roStr = Array.isArray(roVal) ? roVal.join(', ') : (roVal === undefined || roVal === null ? '(未设置)' : String(roVal));
    html += '<input type="text" value="' + escAttr(roStr) + '" disabled>' +
      (spec.readOnlyHint ? '<div class="hint">由 ' + esc(spec.readOnlyHint) + ' 管理</div>' : '');
  } else if (spec.type === 'boolean') {
    html += '<select data-field="' + escAttr(spec.key) + '">' +
      '<option value="true"' + (state.form[spec.key] === true || state.form[spec.key] === 'true' ? ' selected' : '') + '>开启</option>' +
      '<option value="false"' + (state.form[spec.key] === false || state.form[spec.key] === 'false' ? ' selected' : '') + '>关闭</option>' +
      '</select>';
  } else if (spec.type === 'boolean-tri') {
    var tri = state.form[spec.key] || 'unset';
    html += '<select data-field="' + escAttr(spec.key) + '">' +
      '<option value="unset"' + (tri === 'unset' ? ' selected' : '') + '>未设置(跟随团队)</option>' +
      '<option value="true"' + (tri === 'true' ? ' selected' : '') + '>开启</option>' +
      '<option value="false"' + (tri === 'false' ? ' selected' : '') + '>关闭</option>' +
      '</select>';
  } else if (spec.type === 'enum') {
    html += '<select data-field="' + escAttr(spec.key) + '">';
    var opts = spec.enumValues || dynOptions(spec.dynamicOptions);
    if (spec.dynamicOptions) {
      var cur = state.form[spec.key];
      if (cur && opts.indexOf(cur) < 0) html += '<option value="' + escAttr(cur) + '" selected>' + esc(cur) + '</option>';
      if (!cur) html += '<option value="" selected>(未选择)</option>';
    }
    for (var i = 0; i < opts.length; i++) {
      var sel = state.form[spec.key] === opts[i] ? ' selected' : '';
      html += '<option value="' + escAttr(opts[i]) + '"' + sel + '>' + esc(opts[i]) + '</option>';
    }
    html += '</select>';
  } else if (spec.type === 'string[]' && spec.dynamicOptions && dynOptions(spec.dynamicOptions).length > 0 && dynOptions(spec.dynamicOptions).length <= 30) {
    var chips = '';
    var list = dynOptions(spec.dynamicOptions);
    var curArr = String(state.form[spec.key] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    for (var c = 0; c < list.length; c++) {
      var on = curArr.indexOf(list[c]) >= 0 ? ' on' : '';
      chips += '<span class="chip' + on + '" data-chip="' + escAttr(spec.key) + '" data-val="' + escAttr(list[c]) + '">' + esc(list[c]) + '</span>';
    }
    html += '<div class="chips">' + chips + '</div><div class="hint">点击切换选中项;当前:' + esc(curArr.join(', ') || '(空)') + '</div>';
  } else {
    var val = state.form[spec.key];
    html += '<input type="text" data-field="' + escAttr(spec.key) + '" value="' + escAttr(val === undefined || val === null ? '' : String(val)) + '">' +
      (spec.type === 'string[]' ? '<div class="hint">多个值用英文逗号分隔</div>' : '') +
      (spec.key === 'repo.branch' ? '<div class="hint">留空 = 跟随远端默认分支;保存后自动切换本地克隆检出分支</div>' : '');
  }
  html += errHtml + '</div>';
  return html;
}

function dynOptions(kind) {
  if (!state.config || !state.config.options) return [];
  return state.config.options[kind] || [];
}

function bindFieldEvents(root) {
  root.querySelectorAll('[data-field]').forEach(function (el) {
    var key = el.dataset.field;
    var event = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(event, function () {
      var spec = null;
      var fields = state.config.fields;
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].spec.key === key) { spec = fields[i].spec; break; }
      }
      if (spec && spec.type === 'boolean-tri') {
        state.form[key] = el.value; // 'unset' | 'true' | 'false'
      } else if (spec && spec.type === 'boolean') {
        state.form[key] = el.value === 'true';
      } else {
        state.form[key] = el.value;
      }
      delete state.formErrors[key];
      refreshDiffOnly();
    });
  });
  root.querySelectorAll('[data-chip]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var key = chip.dataset.chip;
      var val = chip.dataset.val;
      var curArr = String(state.form[key] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var idx = curArr.indexOf(val);
      if (idx >= 0) curArr.splice(idx, 1); else curArr.push(val);
      state.form[key] = curArr.sort().join(', ');
      chip.classList.toggle('on');
      delete state.formErrors[key];
      refreshDiffOnly();
    });
  });
}

/** 只重绘 diff 面板与保存按钮,避免整个表单重绘丢失焦点 */
function refreshDiffOnly() {
  var diffs = computeDiff();
  var p = panel('settings');
  var toolbar = p.querySelector('.toolbar');
  var existing = p.querySelector('.diffbox');
  if (diffs.length === 0) {
    if (existing) existing.remove();
  } else {
    var html = '<strong>未保存的变更(' + diffs.length + ')</strong>';
    for (var i = 0; i < diffs.length; i++) {
      html += '<div class="diffrow"><span class="diffkey">' + esc(diffs[i].key) + '</span>' +
        '<span class="diffold">' + esc(diffs[i].old) + '</span><span>→</span>' +
        '<span class="diffnew">' + esc(diffs[i].neu) + '</span></div>';
    }
    if (existing) {
      existing.innerHTML = html;
    } else {
      var div = document.createElement('div');
      div.className = 'diffbox';
      div.innerHTML = html;
      toolbar.insertAdjacentElement('afterend', div);
    }
  }
  var saveBtn = $('btnSaveSettings');
  if (saveBtn) saveBtn.disabled = diffs.length === 0;
}

async function saveSettings() {
  var st = $('settingsStatus');
  st.textContent = '保存中…';
  $('saveBanner').innerHTML = '';
  var updates = {};
  var diffs = computeDiff();
  for (var i = 0; i < diffs.length; i++) {
    var key = diffs[i].key;
    var spec = null;
    var fields = state.config.fields;
    for (var j = 0; j < fields.length; j++) {
      if (fields[j].spec.key === key) { spec = fields[j].spec; break; }
    }
    if (spec) updates[key] = formFieldValue(key, spec);
  }
  var res = await apiPost('/api/config', { scope: state.scope, updates: updates });
  if (!res.ok) {
    st.textContent = '';
    state.formErrors = {};
    var errs = res.body.errors || [];
    for (var k = 0; k < errs.length; k++) {
      state.formErrors[errs[k].key] = errs[k].message;
    }
    renderSettings();
    var banner = $('saveBanner');
    if (banner) {
      var msg = '';
      for (var l = 0; l < errs.length; l++) {
        msg += '<div>' + esc(errs[l].key + ': ' + errs[l].message) + '</div>';
      }
      banner.innerHTML = '<div class="banner err"><strong>保存失败,配置文件未改动:</strong><br>' + msg + '</div>';
    }
    return;
  }
  st.textContent = '已保存';
  var afterSaveWarnings = res.body.errors || [];
  var okHtml = '<div class="banner"><strong>已保存。</strong>' +
    (afterSaveWarnings.length ? '<br>' + afterSaveWarnings.map(function (e) { return esc(e.key + ': ' + e.message); }).join('<br>') : '') +
    '<br><span class="muted">角色/分支/排除列表的变更需要执行 pull 后才会作用到本地 AI 工具。</span> ' +
    '<button class="small" id="btnSaveSync" style="margin-left:8px">立即同步</button></div>';
  $('saveBanner').innerHTML = okHtml;
  $('btnSaveSync').addEventListener('click', function () {
    switchTab('sync');
    startSync();
  });
  await loadConfig();
  renderSettings();
}

// ─── 同步页 ────────────────────────────────────────────────
function renderSync() {
  var p = panel('sync');
  var r = state.repo;
  var s = r && r.state ? r.state : null;
  p.innerHTML =
    '<div class="card"><h3>同步状态(state.json)</h3><div class="kv">' +
    kvRow('上次拉取', fmtTime(s && s.lastPull)) +
    kvRow('上次推送', fmtTime(s && s.lastPush)) +
    kvRow('待处理 PR 数', String(s ? s.pendingPushes : 0)) +
    '</div></div>' +
    '<div class="toolbar"><button class="primary" id="btnSyncNow">立即同步(pull --force)</button>' +
    '<span class="muted" id="syncStatus"></span></div>' +
    '<pre class="log" id="syncLog" style="display:none"></pre>';
  $('btnSyncNow').addEventListener('click', startSync);
}

async function startSync() {
  var st = $('syncStatus');
  var res = await apiPost('/api/sync', {});
  if (!res.ok) {
    if (st) st.textContent = '失败:' + (res.body.error || res.status);
    return;
  }
  followJob(res.body.jobId, 'syncLog', 'syncStatus', function (ok) {
    if (ok) refreshAll();
  });
}

// ─── 弹窗 ──────────────────────────────────────────────────
function openModal(inner) {
  $('modalBox').innerHTML = inner;
  $('modalMask').classList.add('open');
}
function closeModal() {
  $('modalMask').classList.remove('open');
}
$('modalMask').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});

// ─── 渲染入口 ──────────────────────────────────────────────
function switchTab(id) {
  state.activeTab = id;
  renderTabs();
  renderActivePanel();
}
function renderActivePanel() {
  if (state.activeTab === 'repo') renderRepo();
  else if (state.activeTab === 'branches') renderBranches();
  else if (state.activeTab === 'roles') renderRoles();
  else if (state.activeTab === 'resources') renderResources();
  else if (state.activeTab === 'settings') renderSettings();
  else if (state.activeTab === 'sync') renderSync();
}

renderTabs();
renderActivePanel();
refreshAll();
</script>
</body>
</html>`;
}

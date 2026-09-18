/** Browser application, embedded in the standalone dashboard HTML by tsup. */
export const dashboardClient = `(() => {
'use strict';
const $ = id => document.getElementById(id);
const messages = window.dashboardMessages;
const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
let language = read('teamai-dashboard-language', navigator.language.startsWith('zh') ? 'zh-CN' : 'en');
if (!['en', 'zh-CN'].includes(language)) language = 'en';
const t = text => language === 'zh-CN' ? (Object.hasOwn(messages,text) ? messages[text] : text) : text;
const e = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const label = text => e(t(text));
const escapeHtml = e;
const pageNames = { overview: 'Overview', execution: 'Team Execution', context: 'Team Context', improvement: 'Team Improvement' };
const statusNames = { running:'Working', waiting_for_input:'Your turn', error:'Error', idle:'Idle', stopped:'Ended' };
let page = Object.hasOwn(pageNames,location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let sessions = [], haveSessions = false, connected = false, trends = null, kb = null;
let trendError = false, kbError = false, selectedSession = null, selectedSnapshot = null, focusBeforeDialog = null;
let trendLoading = false, kbLoading = false, eventSource = null, reconnectTimer = null, fallbackGeneration = 0;
let workspaceId = '', workspaceGeneration = 0, workspaces = [];
const api = route => route + (workspaceId ? '?workspace=' + encodeURIComponent(workspaceId) : '');
function workspaceLabel(w) { return w.scope==='user'?label('User scope'):w.scope==='unassigned'?label('Unassigned sessions'):e(w.label)+' · '+label('Project'); }
function workspaceOptions() { $('workspace').innerHTML=workspaces.map(w=>'<option value="'+e(w.id)+'">'+workspaceLabel(w)+'</option>').join('');$('workspace').value=workspaceId;const w=workspaces.find(w=>w.id===workspaceId);$('workspace-root').textContent=w?w.root:''; }
const icons = {
 overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 execution:'<path d="M4 12h4l3-8 4 16 3-8h3"/>',context:'<path d="M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4zM12 6v15"/>',improvement:'<path d="M4 17l6-6 4 3 6-10M14 4h6v6"/>'
};
const icon = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'+icons[key]+'</svg>';
const link = (key, text) => '<button class="link" data-page="'+key+'">'+label(text)+' →</button>';
const number = value => new Intl.NumberFormat(language).format(value || 0);
const when = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(language); };
const count = s => s.interventionCount || 0;
const tokens = s => Object.values(s.tokens || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
function duration(s) { const ms = Date.parse(s.status === 'stopped' ? s.stoppedAt || s.lastActivity : new Date().toISOString()) - Date.parse(s.startedAt); if (!Number.isFinite(ms)) return '—'; const seconds = Math.max(0, Math.floor(ms/1000)); return seconds < 60 ? seconds+'s' : seconds < 3600 ? Math.floor(seconds/60)+'m' : Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m'; }
function ago(value) { const ms = Date.now()-Date.parse(value); if (!Number.isFinite(ms)) return '—'; if (ms<5000) return t('Just now'); return (ms<60000?Math.floor(ms/1000)+'s':ms<3600000?Math.floor(ms/60000)+'m':Math.floor(ms/3600000)+'h')+' '+t('ago'); }
function status(s) { return label(statusNames[s.status] || s.status); }
function scopeSessions() { return sessions.filter(s => (!$('repo').value || s.cwd === $('repo').value) && (!$('agent').value || s.tool === $('agent').value)); }
function filters() {
 for (const [id, field, title] of [['repo','cwd','All repositories'],['agent','tool','All AI tools']]) {
  const selected = $(id).value;
  const values = [...new Set(sessions.map(s => s[field]).filter(Boolean))].sort();
  if (selected && !values.includes(selected)) values.push(selected);
  $(id).innerHTML = '<option value="">'+label(title)+'</option>'+values.map(value=>'<option value="'+e(value)+'">'+e(value)+'</option>').join('');
  $(id).value = selected === 'all' ? '' : selected;
 }
}
function connection() { $('connection').classList.toggle('connected', connected); $('connection').textContent = t(connected ? 'Connected · local live' : haveSessions ? 'Reconnecting…' : 'Connecting…'); }
function source() { if (!kb) return ''; return '<div class="source">'+label(kb.source.label || (kb.source.scope==='team'?'Team repo · aggregated across the team':'Local knowledge · your recalls only'))+'<br>'+label('Report generated')+': '+e(when(kb.generatedAt))+'</div>'; }
function errorPanel(text, action) { return '<div class="error-panel" role="status"><p>'+label(text)+'</p><button class="link" data-retry="'+action+'">'+label('Retry')+'</button></div>'; }
function overview() {
 const working=sessions.filter(s=>s.status==='running').length;
 const waiting=sessions.filter(s=>s.status==='waiting_for_input').length;
 const maintenance=kb?Object.values(kb.maintenanceCounts).reduce((a,b)=>a+b,0):null;
 return '<div class="cards"><article class="card"><div class="cardtop">'+label('Team Execution')+icon('execution')+'</div><div class="source">'+label('Local live sessions')+'</div><div class="big summary-value">'+(haveSessions?number(sessions.length):'—')+'<small>'+label('sessions on this machine')+'</small></div><div class="statusline">'+number(working)+' '+label('Working')+' · '+number(waiting)+' '+label('Your turn')+'</div><div class="cardfoot">'+link('execution','View sessions')+'</div></article>'+
 '<article class="card"><div class="cardtop">'+label('Team Context')+'</div>'+source()+'<div class="big summary-value">'+(kb?number(kb.overallCoveragePct)+'%':'—')+'<small>'+label('Knowledge coverage')+'</small></div><div class="statusline">'+(kb?number(kb.totalEntries)+' '+label('Entries')+' · '+number(kb.silentCount)+' '+label('Never recalled'):label(kbError?'Unavailable':'Loading…'))+'</div><div class="cardfoot">'+link('context','View KB Health')+'</div></article>'+
 '<article class="card"><div class="cardtop">'+label('Team Improvement')+'</div><div class="source">'+label('KB Health maintenance candidates')+'</div><div class="big summary-value">'+(maintenance===null?'—':number(maintenance))+'<small>'+label('candidates for review')+'</small></div><div class="statusline">'+(kb?number(kb.maintenanceCounts.promote)+' '+label('Promotion')+' · '+number(kb.maintenanceCounts.prune)+' '+label('Archive')+' · '+number(kb.maintenanceCounts.stale)+' '+label('Stale'):label(kbError?'Unavailable':'Loading…'))+'</div><div class="cardfoot">'+link('improvement','View maintenance')+'</div></article></div>'+
 (kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'')+trendPanel()+sessionTable(sessions);
}
function formatMetric(value, kind) { if (value===null || value===undefined) return trends ? '—' : label(trendError?'Unavailable':'Loading…'); if(kind==='pct')return number(Math.round(value*100))+'%'; if(kind==='cost')return new Intl.NumberFormat(language,{style:'currency',currency:'USD',minimumFractionDigits:3}).format(value/1000000)+' '+label('est.');return Number(value).toFixed(1); }
function trendPanel() {
 const metrics=[['Prompts / session','avgPrompts','number'],['Cost / session','avgSessionCostMicros','cost'],['Cache read share','cacheReadShare','pct'],['Correction rate','correctionRate','pct']];
 return '<h2 class="section-label">'+label('7 days vs prior 7 days')+' <span class="tag">'+label('Local · UTC')+'</span></h2>'+(trendError?errorPanel('Could not refresh trends. Any displayed values are the last successful result.','trends'):'')+'<div class="trends">'+metrics.map(([title,key,kind])=>'<article class="card trend"><h2>'+label(title)+'</h2><div class="big">'+formatMetric(trends?.current[key],kind)+'</div><span class="label">'+label('Prior')+': '+(trends && trends.previous[key]==null ? label(!trends.previous.sessionsEnded?'No ended sessions in prior period':kind==='cost'?'No priced sessions':'No usage data') : formatMetric(trends?.previous[key],kind))+'</span>'+(kind==='cost'?'<p class="label cost-note">'+label('Average known cost per priced session; first-stop cohort.')+' '+(trends?number(trends.current.pricedSessions)+' / '+number(trends.current.sessionsEnded)+' '+label('sessions priced'):'')+'</p>':'')+'</article>').join('')+'</div>';
}
function sessionTable(data) {
 if(!haveSessions) return '<div class="empty" role="status">'+label('Loading local sessions…')+'</div>';
 if(!data.length) return '<section class="panel"><div class="empty"><h2>'+label(sessions.length?'No sessions match these filters.':'No active sessions')+'</h2><p>'+label('Start a supported AI tool in a TeamAI project. Dashboard hooks report sessions automatically.')+'</p></div></section>';
 const groups=[['Active',data.filter(s=>s.status!=='stopped')],['Recently Ended',data.filter(s=>s.status==='stopped')]];
 return groups.filter(([,rows])=>rows.length).map(([title,rows])=>'<section class="panel sessions"><div class="panelhead"><h2>'+label(title)+' <span class="count">'+number(rows.length)+'</span></h2><span class="label">'+label('Local sessions')+'</span></div><div class="table-scroll"><table class="session-table"><thead><tr>'+['FIRST USER PROMPT / DIRECTORY','AI TOOL','STATUS','PROMPTS','INTERVENTIONS','Tokens',''].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(s=>'<tr class="'+(s.status==='stopped'?'row-ended':'')+'"><td><span data-verbatim>'+e(s.promptSummary || t('No prompt captured'))+'</span><small data-verbatim>'+e(s.cwd)+'</small>'+(s.prompts?.length>1?'<span class="session-excerpt"><b>'+label('Latest user prompt')+': </b><span data-verbatim>'+e(s.prompts.at(-1))+'</span></span>':'')+(s.stoppedOutput?'<span class="session-excerpt"><b>'+label('AI output')+': </b><span data-verbatim>'+e(s.stoppedOutput)+'</span></span>':'')+'<small>'+e(duration(s))+' · '+e(ago(s.lastActivity))+' · <span data-verbatim>'+e(s.lastTool)+'</span></small></td><td data-verbatim>'+e(s.tool)+'</td><td class="'+(['error','waiting_for_input'].includes(s.status)?'amber':s.status==='running'?'good':'')+'">'+status(s)+'</td><td>'+number(s.promptCount)+'</td><td title="'+e(t('Interrupt')+': '+(s.interventions?.interrupt||0)+' · '+t('Tool reject')+': '+(s.interventions?.toolReject||0)+' · '+t('Correction')+': '+(s.interventions?.correction||0))+'">'+number(count(s))+'</td><td title="'+e(t('Input')+': '+(s.tokens?.input||0)+' · '+t('Output')+': '+(s.tokens?.output||0)+' · '+t('Cache read')+': '+(s.tokens?.cacheRead||0)+' · '+t('Cache creation')+': '+(s.tokens?.cacheCreation||0))+'">'+number(tokens(s))+'</td><td><button class="link" data-session="'+e(s.sessionId)+'">'+label('Details')+' ↗<span class="sr-only"> '+e(s.promptSummary)+'</span></button></td></tr>').join('')+'</tbody></table></div></section>').join('');
}
function execution() { const data=scopeSessions(); return '<div class="statusline">'+Object.entries(statusNames).map(([status,title])=>'<span>'+number(data.filter(s=>s.status===status).length)+' '+label(title)+'</span>').join('')+'</div>'+sessionTable(data); }
function knowledge() {
 return '<div class="actions">'+source()+'<button class="link" data-retry="kb">'+label('Refresh report')+'</button>'+link('improvement','View maintenance')+'</div>'+(kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'')+(kb?'<div class="report" id="kb-content">'+kb.context+'</div>':kbError?'':'<div class="empty">'+label('Loading…')+'</div>');
}
function improvement() { return trendPanel()+'<div class="actions">'+source()+'<button class="link" data-retry="kb">'+label('Refresh report')+'</button></div>'+(kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'')+(kb?'<div class="report" id="kb-content">'+kb.maintenance+'</div>':'<div class="empty">'+label('Loading…')+'</div>'); }
// Translate static report labels only; never translate knowledge titles, authors, commands or session text.
function localizeReport() {
 const root=$('kb-content');if(!root)return;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()) {
  const node=walker.currentNode;
  if(!node.parentElement.matches('[data-i18n]') && node.parentElement.closest('code,svg,td,.entry-title,.maint-item,li'))continue;
  const text=node.nodeValue.trim();
  // Parametrized titles now wrap their translatable text in <span data-i18n> with the
  // count outside, so a whole-string message match covers every case — the old
  // regex special-cases for "Never-Recalled Entries (N total)" / "type (N)" are gone.
  if(messages[text]) node.nodeValue=node.nodeValue.replace(text,t(text));
 }
}
function render() {
 const focus=document.activeElement;
 const focusKey=focus?.dataset.session, retryKey=focus?.dataset.retry;
 const opened=[...document.querySelectorAll('#kb-content details[open]')].map(d=>[...d.parentElement.children].indexOf(d));
 $('nav').innerHTML=Object.keys(pageNames).map(key=>'<button data-page="'+key+'" class="'+(page===key?'active':'')+'" '+(page===key?'aria-current="page"':'')+'>'+icon(key)+label(pageNames[key])+'</button>').join('');
 $('title').textContent=t(pageNames[page]);$('crumb').textContent=t(pageNames[page]);
 document.querySelector('.filters').hidden=page!=='execution';
 $('view').innerHTML=({overview,execution,context:knowledge,improvement})[page]();
 localizeReport();connection();
 document.querySelectorAll('#kb-content details').forEach(d=>{if(opened.includes([...d.parentElement.children].indexOf(d)))d.open=true;});
 if(focusKey) [...document.querySelectorAll('[data-session]')].find(el=>el.dataset.session===focusKey)?.focus({preventScroll:true});
 else if(retryKey) document.querySelector('[data-retry="'+retryKey+'"]')?.focus({preventScroll:true});
}
    // ─── Lightweight inline markdown parser ─────────────
    // Backtick char via hex escape (cannot use literal backtick inside TS template)
    var BT = '\\x60';
    var FENCE = BT + BT + BT;
    var reInlineCode = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');

    function inlineMarkdown(text) {
      return text
        .replace(reInlineCode, '<code>$1</code>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>')
        .replace(/\\*(.+?)\\*/g, '<i>$1</i>');
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

function detailSection(title, html) { return '<section><h3>'+label(title)+'</h3>'+html+'</section>'; }
function showDetails(sessionId) {
 const s=sessions.find(s=>s.sessionId===sessionId) || selectedSnapshot;
 if(!s)return;
 selectedSession=sessionId;selectedSnapshot=s;
 const dialog=$('session-dialog');
 if(!dialog.open) focusBeforeDialog=document.activeElement;
 const iv=s.interventions||{},usage=s.tokens||{};
 $('detail').innerHTML='<div class="caption">'+label('Local session')+'</div><h2 id="detailTitle" data-verbatim>'+e(s.promptSummary||t('No prompt captured'))+'</h2><div class="tag"><span data-verbatim>'+e(s.tool)+'</span> · '+status(s)+'</div>'+
 detailSection('Session activity','<p data-verbatim>'+e(s.cwd)+'</p><p>'+label('Started')+': '+e(when(s.startedAt))+'<br>'+label('Last activity')+': '+e(when(s.lastActivity))+'<br>'+label('Duration')+': '+e(duration(s))+' · '+label('Last tool')+': '+e(s.lastTool)+'</p>')+
 detailSection('Human interventions','<p>'+label('Interrupt')+': '+number(iv.interrupt)+' · '+label('Tool reject')+': '+number(iv.toolReject)+' · '+label('Correction')+': '+number(iv.correction)+'</p>')+
 detailSection('Token usage','<p>'+label('Input')+': '+number(usage.input)+' · '+label('Output')+': '+number(usage.output)+'<br>'+label('Cache read')+': '+number(usage.cacheRead)+' · '+label('Cache creation')+': '+number(usage.cacheCreation)+'</p>')+
 detailSection('User prompts','<p>'+number(s.promptCount)+' '+label('Prompt turns')+'</p>'+(s.prompts||[]).map((p,i)=>'<p data-verbatim><b>'+number(i+1)+'.</b> '+e(p)+'</p>').join(''))+
 detailSection('AI output','<div class="md-output" data-verbatim>'+ (s.stoppedOutput?renderMarkdown(s.stoppedOutput):'<p>'+label('No output captured yet.')+'</p>')+'</div>');
 if(!dialog.open)dialog.showModal();
}
async function json(url) { const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('HTTP '+response.status);return response.json(); }
async function loadTrends() { if(trendLoading)return;const generation=workspaceGeneration;trendLoading=true;try{const data=await json(api('/api/trends'));if(generation===workspaceGeneration){trends=data;trendError=false;}}catch{if(generation===workspaceGeneration)trendError=true;}finally{if(generation===workspaceGeneration){trendLoading=false;if(['overview','improvement'].includes(page))render();}} }
async function loadKb() { if(kbLoading)return;const generation=workspaceGeneration;kbLoading=true;try{const data=await json(api('/api/context'));if(generation===workspaceGeneration){kb=data;kbError=false;}}catch{if(generation===workspaceGeneration)kbError=true;}finally{if(generation===workspaceGeneration){kbLoading=false;render();}} }
function receive(data) {
 if(!Array.isArray(data))return;
 if(haveSessions && JSON.stringify(sessions)===JSON.stringify(data))return;
 sessions=data;haveSessions=true;filters();
 if(['overview','execution'].includes(page))render();
 if(selectedSession&&$('session-dialog').open){
  const updated=sessions.find(s=>s.sessionId===selectedSession);
  if(updated&&JSON.stringify(updated)!==JSON.stringify(selectedSnapshot)){const scroll=$('session-dialog').scrollTop;showDetails(selectedSession);$('session-dialog').scrollTop=scroll;}
 }
}
function connect() {
 const generation=++fallbackGeneration, scope=workspaceGeneration;
 eventSource=new EventSource(api('/events'));
 eventSource.onopen=()=>{if(scope!==workspaceGeneration)return;connected=true;connection();};
 eventSource.onmessage=event=>{if(scope!==workspaceGeneration)return;try{fallbackGeneration++;receive(JSON.parse(event.data));}catch{}};
 eventSource.onerror=()=>{if(scope!==workspaceGeneration)return;connected=false;connection();eventSource.close();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,3000);};
 json(api('/api/sessions')).then(data=>{if(generation===fallbackGeneration)receive(data);}).catch(()=>{if(scope===workspaceGeneration&&!haveSessions){$('view').innerHTML=errorPanel('Could not load local sessions.','sessions');}});
}
const staticText=new WeakMap();
function preferences() {
 document.documentElement.lang=language;document.title=t('TeamAI Dashboard');
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()) {
  const node=walker.currentNode;
  if(node.parentElement.closest('#view,#nav,#detail,script,style'))continue;
  if(!staticText.has(node))staticText.set(node,node.nodeValue);
  const original=staticText.get(node), trimmed=original.trim();
  if(messages[trimmed])node.nodeValue=original.replace(trimmed,t(trimmed));
  if(trimmed.startsWith('Workspace') && trimmed.includes('/'))node.nodeValue=t('Workspace')+' / ';
 }
 for(const [id,key] of [['workspace','Workspace'],['language','Language'],['theme','Theme'],['repo','Repository'],['agent','AI tool']])$(id).setAttribute('aria-label',t(key));
 document.querySelector('[data-close]').setAttribute('aria-label',t('Close details'));
 workspaceOptions();filters();render();if(selectedSession&&$('session-dialog').open)showDetails(selectedSession);
}
$('language').value=language;
$('language').onchange=()=>{language=$('language').value;save('teamai-dashboard-language',language);preferences();};
const system=matchMedia('(prefers-color-scheme: dark)');
const preferredTheme=read('teamai-dashboard-theme','system');
$('theme').value=['system','light','dark'].includes(preferredTheme)?preferredTheme:'system';
function theme(){document.documentElement.dataset.theme=$('theme').value==='system'?(system.matches?'dark':'light'):$('theme').value;}
$('theme').onchange=()=>{save('teamai-dashboard-theme',$('theme').value);theme();};system.addEventListener('change',theme);theme();
$('repo').value='';$('agent').value='';for(const id of ['repo','agent'])$(id).onchange=render;
document.addEventListener('click',event=>{
 const nav=event.target.closest('[data-page]'),session=event.target.closest('[data-session]'),retry=event.target.closest('[data-retry]');
 if(nav){const key=nav.dataset.page;location.hash=key;if(key===page){render();$('title').focus();}}
 if(session)showDetails(session.dataset.session);
 if(event.target.closest('[data-close]'))$('session-dialog').close();
 if(retry){if(retry.dataset.retry==='trends')loadTrends();else if(retry.dataset.retry==='kb')loadKb();else{eventSource?.close();clearTimeout(reconnectTimer);connect();}}
});
$('title').tabIndex=-1;
window.addEventListener('hashchange',()=>{page=Object.hasOwn(pageNames,location.hash.slice(1))?location.hash.slice(1):'overview';render();$('title').focus();});
$('session-dialog').addEventListener('close',()=>{const id=selectedSession;selectedSession=null;selectedSnapshot=null;const button=[...document.querySelectorAll('[data-session]')].find(el=>el.dataset.session===id);(button||focusBeforeDialog)?.focus({preventScroll:true});});
function switchWorkspace(id) {
 workspaceGeneration++;fallbackGeneration++;workspaceId=id;save('teamai-dashboard-workspace',id);
 eventSource?.close();clearTimeout(reconnectTimer);$('session-dialog').close();selectedSession=null;selectedSnapshot=null;
 sessions=[];haveSessions=false;connected=false;trends=null;kb=null;trendLoading=false;kbLoading=false;trendError=false;kbError=false;
 $('repo').value='';$('agent').value='';workspaceOptions();filters();render();connect();loadTrends();loadKb();
}
$('workspace').onchange=()=>switchWorkspace($('workspace').value);
preferences();
json('/api/workspaces').then(data=>{workspaces=data;const saved=read('teamai-dashboard-workspace','');const fallback=(workspaces.find(w=>w.scope==='project')||workspaces[0])?.id;switchWorkspace(workspaces.some(w=>w.id===saved)?saved:(fallback??''));}).catch(()=>{workspaceOptions();connect();loadTrends();loadKb();});
setInterval(loadTrends,30000);
// Reconcile idle/ended expiry even when no hook emits another SSE event.
setInterval(()=>{
 const generation=fallbackGeneration;
 json(api('/api/sessions')).then(data=>{if(generation===fallbackGeneration)receive(data);}).catch(()=>{});
},15000);
// Refresh only changing time labels without replacing focused rows or selected text.
setInterval(()=>{if(!['overview','execution'].includes(page)||$('session-dialog').open)return;document.querySelectorAll('[data-session]').forEach(button=>{const s=sessions.find(s=>s.sessionId===button.dataset.session);if(!s)return;const cell=button.closest('tr').firstElementChild;const small=cell.lastElementChild;if(small?.tagName==='SMALL')small.innerHTML=e(duration(s))+' · '+e(ago(s.lastActivity))+' · <span data-verbatim>'+e(s.lastTool)+'</span>';});},5000);
window.addEventListener('pagehide',()=>{eventSource?.close();clearTimeout(reconnectTimer);});
window.addEventListener('pageshow',event=>{if(event.persisted)connect();});
})();
`;

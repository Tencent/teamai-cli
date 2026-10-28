import { scorersClient } from './scorers-client.js';
import { sessionSharingView } from './session-sharing-view.js';

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
const pageNames = { overview: 'Overview', execution: 'Team Execution', workflows: 'Workflow Runs', scorers: 'Scorers', context: 'Team Context', resources: 'Resources', distribution: 'Distribution', improvement: 'Team Improvement' };
const statusNames = { running:'Working', waiting_for_input:'Your turn', error:'Error', idle:'Idle', stopped:'Ended' };
let page = Object.hasOwn(pageNames,location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let sessions = [], haveSessions = false, connected = false, trends = null, kb = null;
let trendError = false, kbError = false, selectedSession = null, selectedSnapshot = null, focusBeforeDialog = null;
let trendLoading = false, kbLoading = false, eventSource = null, reconnectTimer = null, fallbackGeneration = 0;
let rules = null, rulesError = false, rulesLoading = false;
let sharing = null, sharingError = false, sharingLoading = false;
let dist = null, distError = false, distLoading = false, distDraft = null, preview = null, previewError = '', previewing = false, saving = false, saveError = '', savedNote = ''; let distVersion = 0;
let skills = null, skillsError = false, skillsLoading = false, skillBusy = '';
let skillFilterDelivery = '', skillFilterNamespace = '', skillFilterAgent = '';
let workflows = null, workflowsHtml = '', workflowsError = false, workflowsLoading = false, runKey = null, runDetail = null, runHtml = '', answering = '', answerError = '';
let outcomeSummary = null, outcomesError = false, outcomesLoading = false;
let workspaceId = '', workspaceGeneration = 0, workspaces = [];
const api = route => route + (workspaceId ? '?workspace=' + encodeURIComponent(workspaceId) : '');
const apiQuery = (route, params) => { const query=new URLSearchParams(params); if(workspaceId)query.set('workspace',workspaceId); return route+'?'+query; };
function workspaceLabel(w) { return w.scope==='user'?label('User scope'):w.scope==='unassigned'?label('Unassigned sessions'):e(w.label)+' · '+label('Workspace'); }
function workspaceOptions() { $('workspace').innerHTML='<button><selectedcontent></selectedcontent></button>'+workspaces.map(w=>'<option value="'+e(w.id)+'">'+workspaceLabel(w)+'</option>').join('');$('workspace').value=workspaceId;const w=workspaces.find(w=>w.id===workspaceId);$('workspace-root').textContent=w?w.root:''; }
const icons = {
 overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 execution:'<path d="M4 12h4l3-8 4 16 3-8h3"/>',workflows:'<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.5 6h2a4 4 0 0 1 4 4v.5M8.5 18h2a4 4 0 0 0 4-4v-.5"/>',scorers:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/><path d="M14.5 7.5l2 2 4-4"/>',context:'<path d="M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4zM12 6v15"/>',resources:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',distribution:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',improvement:'<path d="M4 17l6-6 4 3 6-10M14 4h6v6"/>'
};
const icon = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'+icons[key]+'</svg>';
const link = (key, text) => '<button class="link" data-page="'+key+'">'+label(text)+' →</button>';
const number = value => new Intl.NumberFormat(language).format(value || 0);
const when = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(language); };
const count = s => s.interventionCount || 0;
const tokens = s => Object.values(s.tokens || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
function elapsed(ms) { if (!Number.isFinite(ms)) return '—'; const seconds = Math.max(0, Math.floor(ms/1000)); return seconds < 60 ? seconds+'s' : seconds < 3600 ? Math.floor(seconds/60)+'m' : Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m'; }
function duration(s) { return elapsed(Date.parse(s.status === 'stopped' ? s.stoppedAt || s.lastActivity : new Date().toISOString()) - Date.parse(s.startedAt)); }
function ago(value) { const ms = Date.now()-Date.parse(value); if (!Number.isFinite(ms)) return '—'; if (ms<5000) return t('Just now'); return (ms<60000?Math.floor(ms/1000)+'s':ms<3600000?Math.floor(ms/60000)+'m':Math.floor(ms/3600000)+'h')+' '+t('ago'); }
function status(s) { return label(statusNames[s.status] || s.status); }
function scopeSessions() { return sessions.filter(s => (!$('repo').value || s.repoKey === $('repo').value) && (!$('agent').value || s.tool === $('agent').value)); }
function filters() {
 for (const [id, field, text, title] of [['repo','repoKey','repoLabel','All repositories'],['agent','tool','tool','All AI tools']]) {
  const selected = $(id).value;
  const names = new Map(sessions.map(s => [s[field], s[text]]));
  const values = [...names.keys()].filter(Boolean).sort();
  if (selected && !values.includes(selected)) values.push(selected);
  $(id).innerHTML = '<option value="">'+label(title)+'</option>'+values.map(value=>'<option value="'+e(value)+'">'+e(names.get(value) ?? value)+'</option>').join('');
  $(id).value = selected === 'all' ? '' : selected;
 }
}
function connection() { $('connection').classList.toggle('connected', connected); $('connection').textContent = t(connected ? 'Connected · local live' : haveSessions ? 'Reconnecting…' : 'Connecting…'); }
function source() { if (!kb) return ''; return '<div class="source">'+label(kb.source.label || (kb.source.scope==='team'?'Team repo · aggregated across the team':'Local knowledge · your recalls only'))+'<br>'+label('Report generated')+': '+e(when(kb.generatedAt))+'</div>'; }
function errorPanel(text, action) { return '<div class="error-panel" role="status"><p>'+label(text)+'</p><button class="link" data-retry="'+action+'">'+label('Retry')+'</button></div>'; }
${sessionSharingView}
function sharingSection() { return (sharingError?errorPanel('Could not load session sharing.','sharing'):'')+(sharing?sessionSharingPanel(sharing):sharingError?'':'<section class="panel sharing"><div class="empty" role="status">'+label('Loading session sharing…')+'</div></section>'); }
function overview() {
 const working=sessions.filter(s=>s.status==='running').length;
 const waiting=sessions.filter(s=>s.status==='waiting_for_input').length;
 const maintenance=kb?Object.values(kb.maintenanceCounts).reduce((a,b)=>a+b,0):null;
 return '<div class="cards"><article class="card"><div class="cardtop">'+label('Team Execution')+icon('execution')+'</div><div class="source">'+label('Local live sessions')+'</div><div class="big summary-value">'+(haveSessions?number(sessions.length):'—')+'<small>'+label('sessions on this machine')+'</small></div><div class="statusline">'+number(working)+' '+label('Working')+' · '+number(waiting)+' '+label('Your turn')+'</div><div class="cardfoot">'+link('execution','View sessions')+'</div></article>'+
 '<article class="card"><div class="cardtop">'+label('Team Context')+'</div>'+source()+'<div class="big summary-value">'+(kb?number(kb.overallCoveragePct)+'%':'—')+'<small>'+label('Knowledge coverage')+'</small></div><div class="statusline">'+(kb?number(kb.totalEntries)+' '+label('Entries')+' · '+number(kb.silentCount)+' '+label('Never recalled'):label(kbError?'Unavailable':'Loading…'))+'</div><div class="cardfoot">'+link('context','View KB Health')+'</div></article>'+
 '<article class="card"><div class="cardtop">'+label('Team Improvement')+'</div><div class="source">'+label('KB Health maintenance candidates')+'</div><div class="big summary-value">'+(maintenance===null?'—':number(maintenance))+'<small>'+label('candidates for review')+'</small></div><div class="statusline">'+(kb?number(kb.maintenanceCounts.promote)+' '+label('Promotion')+' · '+number(kb.maintenanceCounts.prune)+' '+label('Archive')+' · '+number(kb.maintenanceCounts.stale)+' '+label('Stale'):label(kbError?'Unavailable':'Loading…'))+'</div><div class="cardfoot">'+link('improvement','View maintenance')+'</div></article></div>'+
 (kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'')+sharingSection()+trendPanel()+outcomePanel()+sessionTable(sessions);
}
function formatMetric(value, kind) { if (value===null || value===undefined) return trends ? '—' : label(trendError?'Unavailable':'Loading…'); if(kind==='pct')return number(Math.round(value*100))+'%'; if(kind==='cost')return new Intl.NumberFormat(language,{style:'currency',currency:'USD',minimumFractionDigits:3}).format(value/1000000)+' '+label('est.');return Number(value).toFixed(1); }
function trendPanel() {
 const metrics=[['Prompts / session','avgPrompts','number'],['Cost / session','avgSessionCostMicros','cost'],['Cache read share','cacheReadShare','pct'],['Correction rate','correctionRate','pct']];
 return '<h2 class="section-label">'+label('7 days vs prior 7 days')+' <span class="tag">'+label('Local · UTC')+'</span></h2>'+(trendError?errorPanel('Could not refresh trends. Any displayed values are the last successful result.','trends'):'')+'<div class="trends">'+metrics.map(([title,key,kind])=>'<article class="card trend"><h2>'+label(title)+'</h2><div class="big">'+formatMetric(trends?.current[key],kind)+'</div><span class="label">'+label('Prior')+': '+(trends && trends.previous[key]==null ? label(!trends.previous.sessionsEnded?'No ended sessions in prior period':kind==='cost'?'No priced sessions':'No usage data') : formatMetric(trends?.previous[key],kind))+'</span>'+(kind==='cost'?'<p class="label cost-note">'+label('Average known cost per priced session; first-stop cohort.')+' '+(trends?number(trends.current.pricedSessions)+' / '+number(trends.current.sessionsEnded)+' '+label('sessions priced'):'')+'</p>':'')+'</article>').join('')+'</div>'
  +(trends?.runModes?'<p class="label">'+label('Sessions ended by run mode')+': '+label('Attended')+' '+number(trends.runModes.attended)+' · '+label('Unattended')+' '+number(trends.runModes.unattended)+' · '+label('Not recorded')+' '+number(trends.runModes.notRecorded)+'</p>':'');
}
const outcomeModes = { attended:'Attended', unattended:'Unattended', notRecorded:'Not recorded' };
const outcomeKinds = { pr:'Pull request', commit:'Commit', learning:'Learning', none:'Nothing delivered' };
function outcomePanel() {
 const o=outcomeSummary, head='<h2 class="section-label">'+label('What finished sessions delivered')+' <span class="tag">'+label('Local · last 30 days')+'</span></h2>';
 if(!o) return head+(outcomesError?errorPanel('Could not load session outcomes.','outcomes'):'<div class="empty" role="status">'+label('Loading…')+'</div>');
 const retry=outcomesError?errorPanel('Could not refresh session outcomes. Any displayed values are the last successful result.','outcomes'):'';
 if(!o.sessions) return head+retry+'<section class="panel"><div class="empty"><h2>'+label('No finished session counted yet')+'</h2><p>'+label('The usage report counts a session 6 hours after it goes quiet, when teamai pull reports usage. Its commits, pull requests and learnings then show here.')+'</p></div></section>';
 const rows=Object.keys(outcomeModes).flatMap(mode=>Object.keys(outcomeKinds).filter(kind=>o.rows[mode]?.[kind]).map(kind=>[mode,kind,o.rows[mode][kind]]));
 const perSession=(r,value)=>value/r.sessions;
 return head+retry+'<div class="outcome-summary"><article class="card"><div class="cardtop">'+label('Delivered')+'</div><div class="source">'+label('Finished sessions with a commit, pull request or learning')+'</div><div class="big summary-value">'+number(Math.round(o.delivered/o.sessions*100))+'%</div><div class="statusline">'+number(o.delivered)+' / '+number(o.sessions)+' '+label('sessions')+'</div></article>'
  +'<section class="panel sessions"><div class="panelhead"><h2>'+label('By run mode and outcome')+'</h2><span class="label">'+label('A session in two rows counts in both, so rows do not add up.')+'</span></div><div class="table-scroll"><table class="outcome-table"><thead><tr>'+['RUN MODE','OUTCOME','SESSIONS','Tokens / session','Interventions / session'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +rows.map(([mode,kind,r])=>'<tr><td>'+label(outcomeModes[mode])+'</td><td class="'+(kind==='none'?'muted':'good')+'">'+label(outcomeKinds[kind])+'</td><td>'+number(r.sessions)+'</td><td>'+number(Math.round(perSession(r,r.tokens.input+r.tokens.output)))+'</td><td>'+perSession(r,r.interventions).toFixed(1)+'</td></tr>').join('')+'</tbody></table></div></section></div>'
  +'<section class="panel sessions"><div class="panelhead"><h2>'+label('Recently finished')+' <span class="count">'+number(o.recent.length)+'</span></h2><span class="label">'+label('Local only: ids, shas and links never leave this machine')+'</span></div><div class="table-scroll"><table><thead><tr>'+['COUNTED','AI TOOL','RUN MODE','OUTCOMES','Tokens','INTERVENTIONS'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +o.recent.map(s=>'<tr><td>'+e(when(s.countedAt))+'</td><td data-verbatim>'+e(s.tool||'—')+'</td><td>'+label(outcomeModes[s.runMode||'notRecorded'])+'</td><td>'+outcomesHtml(s.outcomes)+'</td><td>'+number(s.counted.tokens.input+s.counted.tokens.output)+'</td><td>'+number(s.counted.interventions)+'</td></tr>').join('')+'</tbody></table></div></section>';
}
function sessionTable(data) {
 if(!haveSessions) return '<div class="empty" role="status">'+label('Loading local sessions…')+'</div>';
 if(!data.length) return '<section class="panel"><div class="empty"><h2>'+label(sessions.length?'No sessions match these filters.':'No active sessions')+'</h2><p>'+label('Start a supported AI tool in a TeamAI workspace. Dashboard hooks report sessions automatically.')+'</p></div></section>';
 const groups=[['Active',data.filter(s=>s.status!=='stopped')],['Recently Ended',data.filter(s=>s.status==='stopped')]];
 return groups.filter(([,rows])=>rows.length).map(([title,rows])=>'<section class="panel sessions"><div class="panelhead"><h2>'+label(title)+' <span class="count">'+number(rows.length)+'</span></h2><span class="label">'+label('Local sessions')+'</span></div><div class="table-scroll"><table class="session-table"><thead><tr>'+['FIRST USER PROMPT / DIRECTORY','AI TOOL','STATUS','PROMPTS','INTERVENTIONS','Tokens','OUTCOMES',''].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(s=>'<tr class="'+(s.status==='stopped'?'row-ended':'')+'"><td><span data-verbatim>'+e(s.promptSummary || t('No prompt captured'))+'</span><small data-verbatim>'+e(s.cwd)+'</small>'+(s.prompts?.length>1?'<span class="session-excerpt"><b>'+label('Latest user prompt')+': </b><span data-verbatim>'+e(s.prompts.at(-1))+'</span></span>':'')+(s.stoppedOutput?'<span class="session-excerpt"><b>'+label('AI output')+': </b><span data-verbatim>'+e(s.stoppedOutput)+'</span></span>':'')+'<small>'+e(duration(s))+' · '+e(ago(s.lastActivity))+' · <span data-verbatim>'+e(s.lastTool)+'</span></small></td><td data-verbatim>'+e(s.tool)+'</td><td class="'+(['error','waiting_for_input'].includes(s.status)?'amber':s.status==='running'?'good':'')+'">'+status(s)+'</td><td>'+number(s.promptCount)+'</td><td title="'+e(t('Interrupt')+': '+(s.interventions?.interrupt||0)+' · '+t('Tool reject')+': '+(s.interventions?.toolReject||0)+' · '+t('Correction')+': '+(s.interventions?.correction||0))+'">'+number(count(s))+'</td><td title="'+e(t('Input')+': '+(s.tokens?.input||0)+' · '+t('Output')+': '+(s.tokens?.output||0)+' · '+t('Cache read')+': '+(s.tokens?.cacheRead||0)+' · '+t('Cache creation')+': '+(s.tokens?.cacheCreation||0))+'">'+number(tokens(s))+'</td><td>'+outcomesHtml(s.outcomes,true)+'</td><td><button class="link" data-session="'+e(s.sessionId)+'">'+label('Details')+' ↗<span class="sr-only"> '+e(s.promptSummary)+'</span></button></td></tr>').join('')+'</tbody></table></div></section>').join('');
}
function execution() { const data=scopeSessions(); return '<div class="statusline">'+Object.entries(statusNames).map(([status,title])=>'<span>'+number(data.filter(s=>s.status===status).length)+' '+label(title)+'</span>').join('')+'</div>'+sessionTable(data); }
function knowledge() {
 return '<div class="actions">'+source()+'<button class="link" data-retry="kb">'+label('Refresh report')+'</button>'+link('improvement','View maintenance')+'</div>'+(kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'')+(kb?'<div class="report" id="kb-content">'+kb.context+'</div>':kbError?'':'<div class="empty">'+label('Loading…')+'</div>');
}
function improvement() { return trendPanel()+'<div class="actions">'+source()+'<button class="link" data-retry="kb">'+label('Refresh report')+'</button></div>'+(kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'')+(kb?'<div class="report" id="kb-content">'+kb.maintenance+'</div>':'<div class="empty">'+label('Loading…')+'</div>'); }
// Rules the current workspace receives, and why the rest stay out (#1028).
function ruleState(r) {
 if(r.delivered)return '<span class="good">'+label('Delivered')+'</span>';
 var reasons={namespace:'Outside the active namespaces',tags:'Omitted by tag subscriptions',replaced:'Replaced by an active namespace rule'};
 return '<span class="amber">'+label('Not delivered')+'</span><small>'+label(reasons[r.undeliveredReason]||'')+'</small>';
}
function skillState(k) {
 if(k.excluded)return '<span class="amber">'+label('Excluded by you')+'</span><small>'+label('Applies on the next pull')+'</small>';
 if(k.delivered)return '<span class="good">'+label('Delivered')+'</span>';
 var reasons={namespace:'Outside the active namespaces',tags:'Omitted by tag subscriptions',replaced:'Replaced by an active namespace skill',excluded:'Excluded by you'};
 return '<span class="amber">'+label('Not delivered')+'</span><small>'+label(reasons[k.undeliveredReason]||'')+'</small>';
}
function skillAgents(k) {
 if(!k.installedAgents||!k.installedAgents.length)return '—';
 return k.installedAgents.map(e).join(', ');
}
function skillExcludeButton(k) {
 var excluding=!k.excluded;
 return '<button class="ghost" data-skill-exclude="'+e(k.name)+'" data-excluded="'+(excluding?'true':'false')+'"'+(skillBusy===k.name?' disabled':'')+'>'+(excluding?label('Exclude'):label('Include'))+'</button>';
}
function skillsPanel() {
 if(skillsError)return errorPanel('Could not load skills.','skills');
 if(!skills)return '<section class="panel"><div class="empty" role="status">'+label('Loading skills…')+'</div></section>';
 if(!skills.configured)return '';
 var conflictBanner=skills.skillConflict?'<div class="error-panel"><p>'+e(skills.skillConflict)+'</p><p>'+label('Pull keeps what is installed until the copies are made equal or renamed.')+'</p></div>':'';
 if(!skills.skills.length)return conflictBanner+'<section class="panel"><div class="empty"><h2>'+label('No skills in the team repo')+'</h2></div></section>';
 var namespaces=[...new Set(skills.skills.map(k=>k.namespace).filter(Boolean))].sort();
 var agents=[...new Set(skills.skills.flatMap(k=>k.installedAgents||[]))].sort();
 var shown=skills.skills.filter(k=>(!skillFilterDelivery||(skillFilterDelivery==='delivered')===k.delivered)&&(!skillFilterNamespace||k.namespace===skillFilterNamespace)&&(!skillFilterAgent||(k.installedAgents||[]).includes(skillFilterAgent)));
 var delivered=skills.skills.filter(k=>k.delivered).length;
 return conflictBanner+'<section class="panel sessions"><div class="panelhead"><h2>'+label('Skills')+' <span class="count">'+number(skills.skills.length)+'</span></h2><span class="label">'+number(delivered)+' '+label('delivered to this workspace')+'</span></div>'
 +'<div class="filters"><select id="skill-delivery"><option value="">'+label('All delivery states')+'</option><option value="delivered"'+(skillFilterDelivery==='delivered'?' selected':'')+'>'+label('Delivered')+'</option><option value="undelivered"'+(skillFilterDelivery==='undelivered'?' selected':'')+'>'+label('Not delivered')+'</option></select>'
 +'<select id="skill-namespace"><option value="">'+label('All namespaces')+'</option>'+namespaces.map(ns=>'<option value="'+e(ns)+'"'+(skillFilterNamespace===ns?' selected':'')+'>'+e(ns)+'</option>').join('')+'</select>'
 +'<select id="skill-agent"><option value="">'+label('All agents')+'</option>'+agents.map(a=>'<option value="'+e(a)+'"'+(skillFilterAgent===a?' selected':'')+'>'+e(a)+'</option>').join('')+'</select></div>'
 +'<div class="table-scroll"><table class="session-table"><thead><tr>'+['SKILL','NAMESPACE','DESCRIPTION','AGENTS','DELIVERY',''].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
 +shown.map(k=>'<tr><td data-verbatim>'+e(k.name)+'</td><td>'+(k.namespace?e(k.namespace):label('Root'))+'</td><td>'+e(k.description||'—')+'</td><td>'+skillAgents(k)+'</td><td>'+skillState(k)+'</td><td>'+skillExcludeButton(k)+'</td></tr>').join('')
 +(shown.length?'':'<tr><td colspan="6"><div class="empty">'+label('No skills match these filters')+'</div></td></tr>')
 +'</tbody></table></div><p class="hint">'+label('Exclusions apply to this workspace only, on the next pull. They never touch the team repository.')+'</p></section>';
}
function rulesPanel() {
 if(rulesError)return errorPanel('Could not load rules.','rules');
 if(!rules)return '<div class="empty" role="status">'+label('Loading rules…')+'</div>';
 if(!rules.configured)return '';
 if(!rules.rules.length)return '<section class="panel"><div class="empty"><h2>'+label('No rules in the team repo')+'</h2></div></section>';
 var delivered=rules.rules.filter(r=>r.delivered).length;
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Rules')+' <span class="count">'+number(rules.rules.length)+'</span></h2><span class="label">'+number(delivered)+' '+label('delivered to this workspace')+'</span></div><div class="table-scroll"><table class="session-table"><thead><tr>'+['RULE','NAMESPACE','DESCRIPTION','DELIVERY'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rules.rules.map(r=>'<tr><td data-verbatim>'+e(r.name)+'</td><td>'+(r.namespace?e(r.namespace):label('Root'))+'</td><td>'+e(r.description||'—')+'</td><td>'+ruleState(r)+'</td></tr>').join('')+'</tbody></table></div></section>';
}
function resources() {
 // The two panels load and fail independently: a rules outage must not hide
 // the skills list or block its exclusions, and vice versa.
 if((rules&&rules.configured===false)||(skills&&skills.configured===false))return '<section class="panel"><div class="empty"><h2>'+label('No TeamAI scope in this workspace')+'</h2><p>'+label('Pick a project workspace above, or set one up with teamai init.')+'</p></div></section>';
 return skillsPanel()+rulesPanel();
}
// The Distribution page: what pull delivers to the chosen workspace, and the
// role and project picks that filter it (#1028). Reads never write; a save
// posts the previewed revision and the page never runs pull itself. A save that
// changes both roles and projects chains the fresh revision the roles post
// returns into the projects post, so one click lands both halves.
const namespaceTypes = ['skills','knowledge','agents','learnings'];
function namespaceChips(ns) { return ns ? namespaceTypes.map(type=>'<span class="tag">'+label(type)+' · '+number(ns[type].length)+'</span>').join(' ') : '<span class="tag">'+label('All namespaces (flat delivery)')+'</span>'; }
function diffNames(diff) { const parts=[]; if(diff.entering.length)parts.push('<span class="good">+'+diff.entering.map(e).join(', ')+'</span>'); if(diff.leaving.length)parts.push('<span class="amber">−'+diff.leaving.map(e).join(', ')+'</span>'); return parts.join(' · ')||label('No change'); }
function diffCounts(diff) { const parts=[]; if(diff.entering.length)parts.push('<span class="good">+'+number(diff.entering.length)+' '+label('entering')+'</span>'); if(diff.leaving.length)parts.push('<span class="amber">−'+number(diff.leaving.length)+' '+label('leaving')+'</span>'); return parts.join(' · ')||label('No change'); }
function distribution() {
 if(page==='distribution'&&!dist&&!distLoading&&!distError)loadDistribution();
 if(distError)return errorPanel('Could not load distribution.','distribution');
 if(!dist)return '<div class="empty" role="status">'+label('Loading distribution…')+'</div>';
 if(!dist.configured)return '<section class="panel"><div class="empty"><h2>'+label('No TeamAI scope in this workspace')+'</h2><p>'+label('Pick a project workspace above, or set one up with teamai init.')+'</p></div></section>';
 if(!distDraft)distDraft={primary:dist.selection.primaryRole,extra:[...dist.selection.additionalRoles],projects:[...dist.selection.projects]};
 const draft=distDraft, sel=dist.selection, effective=dist.effective&&!dist.effective.error?dist.effective:null;
 const rolesLine=sel.primaryRole?e(sel.primaryRole)+(sel.additionalRoles.length?' + '+sel.additionalRoles.map(e).join(', '):''):label('None');
 const projectsLine=sel.projects.length?sel.projects.map(e).join(', '):label('None');
 const top='<section class="panel"><div class="panelhead"><h2>'+label('Effective for this workspace')+'</h2><span class="label">'+label('Selection changes take effect on the next pull')+'</span></div><div class="resource">'
  +'<h3>'+label('Primary role')+': '+rolesLine+'</h3>'
  +'<p>'+label('Active projects')+': '+projectsLine+'</p>'
  +(effective
    ?'<p>'+label('Effective namespaces')+': '+namespaceChips(effective.namespaces)+'</p><p>'+label('Next pull delivers')+' <b>'+number(effective.skills.length)+'</b> '+label('skills')+' · <b>'+number(effective.rules.length)+'</b> '+label('rules')+(effective.heldSkills.length?' · <span class="amber">'+number(effective.heldSkills.length)+' '+label('held back by a copy conflict')+'</span>':'')+'</p>'
    :'<div class="error-panel"><p>'+e(dist.effective.error)+'</p></div>')
  +(dist.children.length?'<p>'+label('Delivered with child workspaces')+':<br>'+dist.children.map(child=>e(child.path)+' · '+(child.primaryRole?e(child.primaryRole):label('None'))+(child.projects.length?' + '+child.projects.map(e).join(', '):'')).join('<br>')+'</p>':'')
  +'</div></section>';
 const assigned=dist.rolesAssigned;
 const held=role=>sel.primaryRole===role.id||sel.additionalRoles.includes(role.id);
 const rolesPanel=dist.roles.state==='invalid'?'<div class="error-panel"><p>'+e(dist.roles.error)+'</p></div>'
  :dist.roles.state==='missing'?''
  :'<section class="panel sessions"><div class="panelhead"><h2>'+label('Roles')+' <span class="count">'+number(dist.roles.items.length)+'</span></h2><span class="label">'+(assigned?label('Assigned in the team repo')+': '+e(assigned.file):label('Pick one primary role and any additional roles'))+'</span></div>'
  +dist.roles.items.map(role=>'<div class="resource"><h3>'+(assigned
    ?e(role.id)+(held(role)?' <span class="tag">'+label('Yours')+'</span>':'')
    :'<label><input type="radio" name="primary-role" data-role-primary="'+e(role.id)+'"'+(draft.primary===role.id?' checked':'')+'/> '+e(role.id)+'</label> <label class="tag"><input type="checkbox" data-role-extra="'+e(role.id)+'"'+(draft.extra.includes(role.id)?' checked':'')+'/> '+label('Additional')+'</label>')
    +'</h3><p>'+e(role.description||'—')+'</p><small>'+namespaceChips(role.namespaces)+'</small></div>').join('')+'</section>';
 const projectsPanel=dist.projects.state==='invalid'?'<div class="error-panel"><p>'+e(dist.projects.error)+'</p></div>'
  :dist.projects.state==='missing'?''
  :'<section class="panel sessions"><div class="panelhead"><h2>'+label('Projects')+' <span class="count">'+number(dist.projects.items.length)+'</span></h2><span class="label">'+label('Saving replaces the active project list')+'</span></div>'
  +dist.projects.items.map(project=>'<div class="resource"><h3><label><input type="checkbox" data-project="'+e(project.id)+'"'+(draft.projects.includes(project.id)?' checked':'')+'/> '+e(project.name||project.id)+'</label></h3><p>'+e(project.description||'—')+'</p><small>'+namespaceChips(project.namespaces)+'</small></div>').join('')+'</section>';
 const previewPanel=preview?'<section class="panel"><div class="panelhead"><h2>'+label('Preview for the next pull')+'</h2><span class="label">'+label('Nothing is written until you save')+'</span></div><div class="resource">'
  +namespaceTypes.map(type=>'<p>'+label(type)+': '+diffNames(preview.namespaces[type])+'</p>').join('')
  +'<p>'+label('skills')+': '+diffCounts(preview.skills)+'</p><p>'+label('rules')+': '+diffCounts(preview.rules)+'</p>'
  +(preview.skills.held&&preview.skills.held.length?'<p class="amber">'+label('held back by a copy conflict')+': '+preview.skills.held.map(e).join(', ')+'</p>':'')
  +(preview.skillConflict?'<div class="error-panel"><p>'+e(preview.skillConflict)+'</p></div>':'')
  +'</div></section>':'';
 const actions='<div class="actions"><button class="primary" data-preview-button'+(previewing||saving?' disabled':'')+'>'+(previewing?label('Previewing…'):label('Preview changes'))+'</button>'
  +'<button class="primary" data-save-button'+(saving||!preview?' disabled':'')+'>'+(saving?label('Saving…'):label('Save selection'))+'</button>'
  +(savedNote?'<span class="good">'+label('Saved. Takes effect on the next pull.')+'</span>':'')
  +(saveError?'<span class="amber">'+e(saveError)+'</span>':'')
  +(previewError?'<span class="amber">'+e(previewError)+'</span>':'')+'</div>';
 return top+rolesPanel+projectsPanel+actions+previewPanel;
}
async function previewSelection() { if(!dist||!distDraft)return; const generation=workspaceGeneration, version=distVersion; previewing=true;previewError='';saveError='';savedNote='';render(); try{ const data=await postJson('/api/distribution/preview',dist.rolesAssigned?{projects:distDraft.projects}:{primaryRole:distDraft.primary,additionalRoles:distDraft.extra,projects:distDraft.projects}); if(generation!==workspaceGeneration||version!==distVersion)return; preview=data; } catch(error){ if(generation!==workspaceGeneration||version!==distVersion)return; preview=null; previewError=error.message; } finally{ if(generation===workspaceGeneration){ previewing=false; if(page==='distribution')render(); } } }
async function saveSelection() { if(!dist||!distDraft||!preview)return; const generation=workspaceGeneration, version=distVersion; saving=true;saveError='';savedNote='';render(); try{ let revision=dist.revision; if(dist.roles.state==='ok'&&!dist.rolesAssigned){ const fresh=await postJson('/api/distribution/roles',{primaryRole:distDraft.primary,additionalRoles:distDraft.extra,revision}); // A workspace switch or draft edit mid-save must stop the chain before
      // the second write: the revision belongs to the old workspace/selection.
      if(generation!==workspaceGeneration)return; if(version!==distVersion){ saveError='The selection changed while saving. Preview again to save the rest.'; return; } revision=fresh.revision; } if(dist.projects.state==='ok')await postJson('/api/distribution/projects',{projects:distDraft.projects,revision}); if(generation!==workspaceGeneration||version!==distVersion)return; savedNote='Saved. Takes effect on the next pull.'; } catch(error){ if(generation!==workspaceGeneration)return; saveError=error.message; } finally{ if(generation===workspaceGeneration){ saving=false; const note=savedNote, err=saveError; await loadDistribution(); savedNote=note; saveError=err; if(page==='distribution')render(); } } }
// The Workflow Runs page (#1088): this machine's runs, live, beside the run
// records the team published. Rows carry only run-record fields, and a HITL
// answer posts the pass the page showed so a replaced request is refused.
const runStatusNames = { running:'Running', succeeded:'Succeeded', failed:'Failed', cancelled:'Cancelled' };
const stepStatusNames = { pending:'Pending', waiting:'Waiting for an answer', leased:'Leased', running:'Running', delivering:'Delivering PR', succeeded:'Succeeded', failed:'Failed', skipped:'Skipped', cancelled:'Cancelled' };
function runStatus(status) { return '<span class="'+(status==='running'||status==='succeeded'?'good':status==='failed'||status==='waiting'?'amber':'')+'">'+label(runStatusNames[status]||stepStatusNames[status]||status)+'</span>'; }
// A running run's duration is filled by tickRunDurations, so a poll that changes nothing leaves the HTML, and the buttons in it, alone.
function runDurationHtml(r) { return r.durationMs==null&&r.status==='running'?'<span data-run-started="'+e(r.startedAt)+'"></span>':e(elapsed(r.durationMs ?? NaN)); }
function tickRunDurations() { document.querySelectorAll('[data-run-started]').forEach(span=>{span.textContent=elapsed(Date.now()-Date.parse(span.dataset.runStarted));}); }
const shortHash = hash => e(String(hash).slice(0,12));
function prLink(url) { return '<a class="link" href="'+e(url)+'" target="_blank" rel="noopener noreferrer" title="'+e(url)+'" data-verbatim>#'+e(url.split('/').filter(Boolean).pop())+'</a>'; }
function outcomeHtml(o, brief) { return o.kind==='pr'?prLink(o.url):o.kind==='commit'?'<span class="tag outcome" title="'+e(o.sha)+'">'+(brief?'':label('Commit')+' ')+'<span data-verbatim>'+e(o.sha.slice(0,7))+'</span></span>':'<span class="tag outcome" title="'+e(o.id)+'">'+label('Learning')+(brief?'':' <span data-verbatim>'+e(o.id.split('/').pop().replace(/-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+$/,''))+'</span>')+'</span>'; }
function outcomesHtml(list, brief) { return list&&list.length?'<span class="outcomes">'+list.map(o=>outcomeHtml(o,brief)).join('')+'</span>':'—'; }
function revision(r) { return (r.teamRevision?'<span title="'+e(r.teamRevision)+'" data-verbatim>'+shortHash(r.teamRevision)+'</span>':'<span class="muted">'+label('No team revision')+'</span>')+(r.sourceHash?' <small title="'+e(r.sourceHash)+'">'+label('Source')+' <span data-verbatim>'+shortHash(r.sourceHash)+'</span></small>':''); }
function prLinks(r) { return r.prs.length ? r.prs.map(prLink).join(' ') : '—'; }
function currentSteps(r) { const parts=[...r.waiting.map(step=>'<span class="amber">'+label('Waiting')+': <span data-verbatim>'+e(step)+'</span></span>'),...r.current.map(step=>'<span data-verbatim>'+e(step)+'</span>')]; return parts.length?parts.join('<br>'):'—'; }
function recordState(r) { return r.record==='pending'?'<span class="amber">'+label('Pending publication')+'</span>':label('Published'); }
function runTable(rows, local) {
 const heads=['WORKFLOW / RUN','STATUS',...(local?['CURRENT STEP']:[]),'END','DURATION','Tokens','TEAM REVISION','PULL REQUESTS'];
 return '<div class="table-scroll"><table class="session-table"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr class="'+(r.status==='running'?'':'row-ended')+'"><td><button class="link" data-run="'+e(r.run)+'" data-run-source="'+e(r.source)+'"><span class="sr-only">'+label('Details')+' </span><span data-verbatim>'+e(r.workflow)+'</span> ↗</button><small><span data-verbatim>'+e(r.run)+'</span>'+(local?'':' · <span data-verbatim>'+e(r.username)+'</span>')+' · '+e(when(r.startedAt))+'</small></td><td>'+runStatus(r.status)+'<small><span data-verbatim>'+e(r.driver||'—')+'</span>'+(r.record?' · '+recordState(r):'')+'</small></td>'+(local?'<td>'+currentSteps(r)+'</td>':'')+'<td data-verbatim>'+e(r.end||'—')+'</td><td>'+runDurationHtml(r)+'</td><td>'+number(r.tokens)+'</td><td>'+revision(r)+'</td><td>'+prLinks(r)+'</td></tr>').join('')+'</tbody></table></div>';
}
function runPanel(title, source, rows, local, empty) { return '<section class="panel sessions"><div class="panelhead"><h2>'+label(title)+' <span class="count">'+number(rows.length)+'</span></h2><span class="tag">'+label(source)+'</span></div>'+(rows.length?runTable(rows,local):'<div class="empty"><p>'+label(empty)+'</p></div>')+'</section>'; }
function workflowRuns() {
 if(page==='workflows'&&!workflows&&!workflowsLoading&&!workflowsError)loadWorkflows();
 if(workflowsError&&!workflows)return errorPanel('Could not load workflow runs.','workflows');
 if(!workflows)return '<div class="empty" role="status">'+label('Loading workflow runs…')+'</div>';
 if(!workflows.configured)return '<section class="panel"><div class="empty"><h2>'+label('No TeamAI scope in this workspace')+'</h2><p>'+label('Pick a project workspace above, or set one up with teamai init.')+'</p></div></section>';
 const waiting=workflows.local.reduce((sum,r)=>sum+r.waiting.length,0), reported=workflows.reported;
 return (workflowsError?errorPanel('Could not refresh workflow runs. Any displayed runs are the last successful result.','workflows'):'')
  +'<div class="statusline"><span>'+number(workflows.local.filter(r=>r.status==='running').length)+' '+label('Running here')+'</span><span class="'+(waiting?'amber':'')+'">'+number(waiting)+' '+label('Waiting for an answer')+'</span>'+(reported.state==='ok'?'<span>'+number(reported.runs.length)+' '+label('Reported by the team')+'</span>':'')+'</div>'
  +runPanel('Local runs','Local live · this machine',workflows.local,true,'No workflow runs on this machine in this workspace. Start one with teamai workflow start.')
  +(reported.state==='ok'?runPanel('Team-reported history','Team reports · teamai-reports branch',reported.runs,false,'No run records published yet.'):errorPanel('Could not read the team run records. Local runs are unaffected.','workflows'));
}
function gate(s) {
 return '<div class="resource"><h3 data-verbatim>'+e(s.step)+'</h3><p>'+label(s.gate.kind==='approve'?'Approve':'Choose')+' · '+label('Pass')+' '+number(s.pass)+(s.gate.required?' · <span class="amber">'+label('Required: a person must answer')+'</span>':'')+'</p><div class="actions">'
  +s.gate.options.map(choice=>'<button class="primary" data-answer-step="'+e(s.step)+'" data-answer-pass="'+e(s.pass)+'" data-answer-choice="'+e(choice)+'"'+(answering?' disabled':'')+' data-verbatim>'+e(choice)+'</button>').join('')+'</div></div>';
}
function runDetailHtml(d) {
 const r=d.run, local=r.source==='local', gates=d.steps.filter(s=>s.gate), counts=r.stepCounts;
 return '<div class="caption">'+label(local?'Local run':'Team-reported run')+'</div><h2 id="detailTitle" data-verbatim>'+e(r.workflow)+'</h2><div class="tag"><span data-verbatim>'+e(r.run)+'</span> · '+label(runStatusNames[r.status]||r.status)+'</div>'
  +(gates.length?detailSection('Waiting for an answer','<p>'+label('Read the question where the driver of this run asks it. The dashboard does not show HITL messages, because they can include step outputs.')+'</p>'+gates.map(gate).join('')+(answering?'<p role="status">'+label('Answering…')+'</p>':'')+(answerError?'<p class="amber" role="alert">'+e(answerError)+'</p>':'')):(answerError?'<p class="amber" role="alert">'+e(answerError)+'</p>':''))
  +detailSection('Run','<p>'+label('Driver')+': <span data-verbatim>'+e(r.driver||'—')+'</span> · '+label('End')+': <span data-verbatim>'+e(r.end||'—')+'</span><br>'+label('Started')+': '+e(when(r.startedAt))+(r.endedAt?'<br>'+label('Ended')+': '+e(when(r.endedAt)):'')+'<br>'+label('Duration')+': '+runDurationHtml(r)+' · '+label('Tokens')+': '+number(r.tokens)+(local?'':'<br>'+label('Member')+': <span data-verbatim>'+e(r.username)+'</span>')+'</p><p>'+label('Team revision')+': '+revision(r)+'</p>'+(counts?'<p>'+number(counts.total)+' '+label('Steps')+' · '+number(counts.succeeded)+' '+label('Succeeded')+' · '+number(counts.failed)+' '+label('Failed')+' · '+number(counts.skipped)+' '+label('Skipped')+' · '+number(counts.cancelled)+' '+label('Cancelled')+'</p>':'')+(r.prs.length?'<p>'+label('Pull requests')+': '+prLinks(r)+'</p>':''))
  +detailSection('Steps','<div class="table-scroll"><table><thead><tr>'+['STEP','PASS','STATUS','Tokens','ANSWER','SCORES','OUTCOMES'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+d.steps.map(s=>'<tr><td data-verbatim>'+e(s.step)+'</td><td>'+number(s.pass)+'</td><td>'+runStatus(s.status)+'</td><td>'+(s.tokens?number((s.tokens.input||0)+(s.tokens.output||0)):'—')+'</td><td>'+(s.answer?'<span data-verbatim>'+e(s.answer.choice)+'</span><small data-verbatim>'+e(s.answer.channel)+'</small>':'—')+'</td><td>'+(s.scores?.length?s.scores.map(x=>'<span class="'+(x.passed?'good':'amber')+'" data-verbatim>'+e(x.scorer)+': '+e(x.label)+'</span>').join('<br>'):'—')+'</td><td>'+outcomesHtml(s.outcomes)+'</td></tr>').join('')+'</tbody></table></div>'+(d.scoring&&d.scoring.judged?'<p>'+label('Scoring')+': '+number(d.scoring.judged)+' '+label('judged')+' · '+label('Tokens')+': '+number(d.scoring.inputTokens+d.scoring.outputTokens)+'</p>':''))
  +'<p class="label">'+label('The dashboard shows only what a run record publishes: never prompts, inputs, outputs, or HITL messages.')+'</p>';
}
function renderRun() { if(!runDetail||!runKey||!$('session-dialog').open)return; const html=runDetailHtml(runDetail); if(html===runHtml)return; runHtml=html; const scroll=$('session-dialog').scrollTop; $('detail').innerHTML=html; tickRunDurations(); $('session-dialog').scrollTop=scroll; }
function showRun(source, id) {
 const dialog=$('session-dialog');
 if(!dialog.open)focusBeforeDialog=document.activeElement;
 selectedSession=null;selectedSnapshot=null;runKey={source,id};runDetail=null;runHtml='';answerError='';
 $('detail').innerHTML='<div class="empty" role="status">'+label('Loading…')+'</div>';
 if(!dialog.open)dialog.showModal();
 loadRunDetail();
}
async function loadRunDetail() {
 const key=runKey, generation=workspaceGeneration;
 if(!key)return;
 try { const data=await json(apiQuery('/api/workflows/run',{source:key.source,id:key.id})); if(generation!==workspaceGeneration||key!==runKey)return; runDetail=data; renderRun(); }
 catch { if(generation===workspaceGeneration&&key===runKey&&!runDetail)$('detail').innerHTML=errorPanel('Could not load this run.','run'); }
}
async function answerGate(step, pass, choice) {
 if(answering||!runKey)return;
 const key=runKey, generation=workspaceGeneration;
 answering=step;answerError='';renderRun();
 try { await postJson('/api/workflows/respond',{run:key.id,step,pass:Number(pass),choice}); }
 catch(error) { if(generation===workspaceGeneration&&key===runKey)answerError=error.message; }
 finally { if(generation===workspaceGeneration){ answering=''; await Promise.all([loadRunDetail(),loadWorkflows()]); renderRun(); } }
}
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
${scorersClient}
function render() {
 const focus=document.activeElement;
 const focusKey=focus?.dataset.session, retryKey=focus?.dataset.retry, runFocus=focus?.dataset.run;
 const fieldId=focus?.id&&focus.closest('#view')?focus.id:'', caret=fieldId&&typeof focus.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd]:null;
 const opened=[...document.querySelectorAll('#kb-content details[open]')].map(d=>[...d.parentElement.children].indexOf(d));
 $('nav').innerHTML=Object.keys(pageNames).map(key=>'<button data-page="'+key+'" class="'+(page===key?'active':'')+'" '+(page===key?'aria-current="page"':'')+'>'+icon(key)+label(pageNames[key])+'</button>').join('');
 $('title').textContent=t(pageNames[page]);$('crumb').textContent=t(pageNames[page]);
 document.querySelector('.filters').hidden=page!=='execution';
 $('view').innerHTML=({overview,execution,workflows:workflowRuns,scorers:scorersPage,context:knowledge,resources,distribution,improvement})[page]();tickRunDurations();
 localizeReport();connection();
 document.querySelectorAll('#kb-content details').forEach(d=>{if(opened.includes([...d.parentElement.children].indexOf(d)))d.open=true;});
 if(focusKey) [...document.querySelectorAll('[data-session]')].find(el=>el.dataset.session===focusKey)?.focus({preventScroll:true});
 else if(retryKey) document.querySelector('[data-retry="'+retryKey+'"]')?.focus({preventScroll:true});
 else if(runFocus) [...document.querySelectorAll('[data-run]')].find(el=>el.dataset.run===runFocus)?.focus({preventScroll:true});
 else if(fieldId){const field=$(fieldId);field?.focus({preventScroll:true});if(caret&&field?.setSelectionRange)field.setSelectionRange(caret[0],caret[1]);}
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
 detailSection('Outcomes','<p>'+outcomesHtml(s.outcomes)+'</p><p class="label">'+label('A learning shows here once contribute records it. Commits and pull requests are counted 6 hours after the session goes quiet, and show under What finished sessions delivered on the Overview.')+'</p>')+
 detailSection('User prompts','<p>'+number(s.promptCount)+' '+label('Prompt turns')+'</p>'+(s.prompts||[]).map((p,i)=>'<p data-verbatim><b>'+number(i+1)+'.</b> '+e(p)+'</p>').join(''))+
 detailSection('AI output','<div class="md-output" data-verbatim>'+ (s.stoppedOutput?renderMarkdown(s.stoppedOutput):'<p>'+label('No output captured yet.')+'</p>')+'</div>');
 if(!dialog.open)dialog.showModal();
}
async function json(url) { const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('HTTP '+response.status);return response.json(); }
async function loadTrends() { if(trendLoading)return;const generation=workspaceGeneration;trendLoading=true;try{const data=await json(api('/api/trends'));if(generation===workspaceGeneration){trends=data;trendError=false;}}catch{if(generation===workspaceGeneration)trendError=true;}finally{if(generation===workspaceGeneration){trendLoading=false;if(['overview','improvement'].includes(page))render();}} }
async function loadOutcomes() { if(outcomesLoading)return;const generation=workspaceGeneration;outcomesLoading=true;try{const data=await json(api('/api/outcomes'));if(generation===workspaceGeneration){outcomeSummary=data;outcomesError=false;}}catch{if(generation===workspaceGeneration)outcomesError=true;}finally{if(generation===workspaceGeneration){outcomesLoading=false;if(page==='overview')render();}} }
async function loadKb() { if(kbLoading)return;const generation=workspaceGeneration;kbLoading=true;try{const data=await json(api('/api/context'));if(generation===workspaceGeneration){kb=data;kbError=false;}}catch{if(generation===workspaceGeneration)kbError=true;}finally{if(generation===workspaceGeneration){kbLoading=false;render();}} }
async function loadSharing() { if(sharingLoading)return;const generation=workspaceGeneration;sharingLoading=true;try{const data=await json(api('/api/session-sharing'));if(generation===workspaceGeneration){const changed=sharingError||JSON.stringify(data)!==JSON.stringify(sharing);sharing=data;sharingError=false;if(changed&&page==='overview')render();}}catch{if(generation===workspaceGeneration){sharingError=true;if(page==='overview')render();}}finally{if(generation===workspaceGeneration)sharingLoading=false;} }
async function loadRules() { if(rulesLoading)return;const generation=workspaceGeneration;rulesLoading=true;try{const data=await json(api('/api/resources/rules'));if(generation===workspaceGeneration){rules=data;rulesError=false;}}catch{if(generation===workspaceGeneration)rulesError=true;}finally{if(generation===workspaceGeneration){rulesLoading=false;if(page==='resources')render();}} }
async function postJson(route, body) { const response=await fetch(api(route),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}); const data=await response.json().catch(()=>null); if(!response.ok)throw Error(data&&data.error?data.error:'HTTP '+response.status); return data; }
async function loadDistribution() { if(distLoading)return;const generation=workspaceGeneration;distLoading=true;try{const data=await json(api('/api/distribution'));if(generation===workspaceGeneration){dist=data;distError=false;distDraft=null;preview=null;previewError='';saveError='';savedNote='';}}catch{if(generation===workspaceGeneration)distError=true;}finally{if(generation===workspaceGeneration){distLoading=false;if(page==='distribution')render();}} }
async function loadWorkflows() { if(workflowsLoading)return;const generation=workspaceGeneration;workflowsLoading=true;try{const data=await json(api('/api/workflows'));if(generation===workspaceGeneration){workflows=data;workflowsError=false;}}catch{if(generation===workspaceGeneration)workflowsError=true;}finally{if(generation===workspaceGeneration){workflowsLoading=false;if(page==='workflows'){const html=workflowRuns();if(html!==workflowsHtml){workflowsHtml=html;render();}}}} }
async function loadSkills() { if(skillsLoading)return;const generation=workspaceGeneration;skillsLoading=true;try{const data=await json(api('/api/resources/skills'));if(generation===workspaceGeneration){skills=data;skillsError=false;}}catch{if(generation===workspaceGeneration)skillsError=true;}finally{if(generation===workspaceGeneration){skillsLoading=false;if(page==='resources')render();}} }
async function toggleSkillExclude(name, excluded) {
 if(skillBusy)return;skillBusy=name;render();
 const generation=workspaceGeneration;
 try {
  const response=await fetch(api('/api/resources/skills/exclusions'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,excluded})});
  if(!response.ok)throw new Error('exclude failed');
  await loadSkills();
 } catch { if(generation===workspaceGeneration)skillsError=true; } finally { if(generation===workspaceGeneration){skillBusy='';if(page==='resources')render();} }
}
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
document.addEventListener('change',event=>{
 const primary=event.target.closest('[data-role-primary]'),extra=event.target.closest('[data-role-extra]'),project=event.target.closest('[data-project]');
 if((!primary&&!extra&&!project)||!distDraft)return;
 if(primary)distDraft.primary=primary.dataset.rolePrimary;
 if(extra){const id=extra.dataset.roleExtra;distDraft.extra=extra.checked?[...new Set([...distDraft.extra,id])]:distDraft.extra.filter(x=>x!==id);}
 if(project){const id=project.dataset.project;distDraft.projects=project.checked?[...new Set([...distDraft.projects,id])]:distDraft.projects.filter(x=>x!==id);}
 preview=null;previewError='';savedNote='';saveError='';distVersion++;
 render();
});
document.addEventListener('click',event=>{
 const nav=event.target.closest('[data-page]'),session=event.target.closest('[data-session]'),retry=event.target.closest('[data-retry]'),run=event.target.closest('[data-run]'),answer=event.target.closest('[data-answer-step]');
 if(nav){const key=nav.dataset.page;location.hash=key;if(key===page){render();$('title').focus();}}
 if(session)showDetails(session.dataset.session);
 if(run)showRun(run.dataset.runSource,run.dataset.run);
 if(answer)answerGate(answer.dataset.answerStep,answer.dataset.answerPass,answer.dataset.answerChoice);
 if(event.target.closest('[data-close]'))$('session-dialog').close();
 if(retry){if(retry.dataset.retry==='trends')loadTrends();else if(retry.dataset.retry==='outcomes')loadOutcomes();else if(retry.dataset.retry==='kb')loadKb();else if(retry.dataset.retry==='rules')loadRules();else if(retry.dataset.retry==='sharing')loadSharing();else if(retry.dataset.retry==='skills')loadSkills();else if(retry.dataset.retry==='distribution')loadDistribution();else if(retry.dataset.retry==='workflows')loadWorkflows();else if(retry.dataset.retry==='run')loadRunDetail();else if(retry.dataset.retry==='scorers'){scorerError='';loadScorers();}else{eventSource?.close();clearTimeout(reconnectTimer);connect();}}
 if(event.target.closest('[data-preview-button]'))previewSelection();
 if(event.target.closest('[data-save-button]'))saveSelection();
});
$('title').tabIndex=-1;
window.addEventListener('hashchange',()=>{page=Object.hasOwn(pageNames,location.hash.slice(1))?location.hash.slice(1):'overview';render();$('title').focus();});
$('session-dialog').addEventListener('close',()=>{const id=selectedSession;selectedSession=null;selectedSnapshot=null;runKey=null;runDetail=null;answerError='';const button=[...document.querySelectorAll('[data-session]')].find(el=>el.dataset.session===id);(button||focusBeforeDialog)?.focus({preventScroll:true});});
function switchWorkspace(id) {
 workspaceGeneration++;fallbackGeneration++;workspaceId=id;save('teamai-dashboard-workspace',id);
 eventSource?.close();clearTimeout(reconnectTimer);$('session-dialog').close();selectedSession=null;selectedSnapshot=null;
 sessions=[];haveSessions=false;connected=false;trends=null;kb=null;trendLoading=false;kbLoading=false;trendError=false;kbError=false;
 outcomeSummary=null;outcomesError=false;outcomesLoading=false;
 rules=null;rulesError=false;rulesLoading=false;
 sharing=null;sharingError=false;sharingLoading=false;
 dist=null;distError=false;distLoading=false;distDraft=null;preview=null;previewError='';previewing=false;saving=false;saveError='';savedNote='';
 workflows=null;workflowsHtml='';workflowsError=false;workflowsLoading=false;runKey=null;runDetail=null;answering='';answerError='';
 resetScorers();
 skills=null;skillsError=false;skillsLoading=false;skillBusy='';skillFilterDelivery='';skillFilterNamespace='';skillFilterAgent='';
 $('repo').value='';$('agent').value='';workspaceOptions();filters();render();connect();loadTrends();loadOutcomes();loadKb();loadSharing();loadRules();loadSkills();
}
$('workspace').onchange=()=>switchWorkspace($('workspace').value);
document.addEventListener('click',event=>{const button=event.target.closest('[data-skill-exclude]');if(button){toggleSkillExclude(button.dataset.skillExclude,button.dataset.excluded==='true');}});
document.addEventListener('change',event=>{if(event.target.id==='skill-delivery'){skillFilterDelivery=event.target.value;if(page==='resources')render();}else if(event.target.id==='skill-namespace'){skillFilterNamespace=event.target.value;if(page==='resources')render();}else if(event.target.id==='skill-agent'){skillFilterAgent=event.target.value;if(page==='resources')render();}});
preferences();
json('/api/workspaces').then(data=>{workspaces=data;const saved=read('teamai-dashboard-workspace','');const fallback=(workspaces.find(w=>w.scope==='project')||workspaces[0])?.id;switchWorkspace(workspaces.some(w=>w.id===saved)?saved:(fallback??''));}).catch(()=>{workspaceOptions();connect();loadTrends();loadOutcomes();loadKb();loadSharing();loadRules();loadSkills();});
setInterval(()=>{loadTrends();loadOutcomes();},30000);
setInterval(loadSharing,30000);
// Workflow runs change without a hook event, so their page polls while it is open.
setInterval(()=>{if(page!=='workflows')return;tickRunDurations();loadWorkflows();if(runKey&&!answering)loadRunDetail();},5000);
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

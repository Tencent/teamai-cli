/**
 * Which definition of each resource applies in the workspace (#1787), as browser code. `layeredResourcesPanel(data,
 * open)` lists, per type, every definition with its layer, form, state and what it replaces, and teamai's default
 * hooks against the team's; `open` holds the keys of the rows whose detail is shown. `layeredResourcesNotice(data)`
 * tells the Overview how many problems there are and links to that list. `data` is what `/api/resources/layered`
 * serves. The dashboard client embeds it after the handoff view, and so supplies `e`, `label`, `number`, `link` and
 * `command`.
 */
export const layeredResourcesView = `
function layeredProblems(data) {
 const counts={conflict:0,invalid:0,refused:0};
 if(!data||!data.configured)return counts;
 for(const list of data.types){
  for(const r of list.resources)if(r.state.kind in counts)counts[r.state.kind]++;
  counts.invalid+=list.problems.length;
 }
 counts.refused+=data.defaultHooks.filter(h=>h.state.kind==='refused').length;
 return counts;
}
function layeredResourcesNotice(data) {
 const c=layeredProblems(data),total=c.conflict+c.invalid+c.refused;
 if(!total)return '';
 const parts=[[c.conflict,'conflict','conflicts'],[c.invalid,'invalid','invalid'],[c.refused,'refused','refused']].filter(([n])=>n).map(([n,one,many])=>number(n)+' '+label(n===1?one:many));
 return '<div class="error-panel skipped-notice layered-notice" role="status"><p><strong><span class="amber" aria-hidden="true">⚠</span> '+number(total)+' '+label(total===1?'resource problem':'resource problems')+'</strong> · '+parts.join(' · ')+'. '+label('Pull keeps what is installed, the last valid version, or teamai\\'s default in their place.')+'</p>'
  +link('resources','View resource layers')+'</div>';
}
const layeredTypeNames={workflows:'Workflows',hooks:'Hooks',mcp:'MCP servers',benchmarks:'Benchmark suites',rules:'Rule folders'};
const layeredStateNames={'in-force':'In force',replaced:'Replaced',inactive:'Not active here',unsubscribed:'Not subscribed',off:'Off',invalid:'Invalid',refused:'Refused',blocked:'Held this pull'};
const layeredConflicts={duplicate:['Defined twice','Keep one of them in the team repo, and push.'],'two-namespaces':['In two active namespaces','Rename or remove it in one namespace, and push.']};
const layeredFallbacks={kept:'The last valid version still runs',default:'teamai\\'s default runs instead',installed:'Your installed copy stays',none:'Nothing runs in its place'};
const layeredFixes={invalid:'Fix it in the team repo, and push.',refused:'Fix it in the team repo, and push.',blocked:'Another definition holds this one back. Fix that one, and pull again.',inactive:'It applies to members whose roles or projects use its namespace.',unsubscribed:'Omitted by tag subscriptions'};
const layeredReach={worktree:'Reads it in the worktree',grant:'Reads the data home: teamai adds it to permissions.additionalDirectories',copy:'May ask before it reads the data home',none:'Reads the data home'};
function layeredLadder(layer) { return '<span class="ladder" data-layer="'+e(layer.kind)+'" aria-hidden="true"><i></i><i></i><i></i></span>'; }
function layeredLayer(layer) { return layeredLadder(layer)+(layer.kind==='namespace'?label('Namespace')+' <code data-verbatim>'+e(layer.namespace)+'</code>':label(layer.kind==='root'?'Team root':'teamai default')); }
function layeredForm(r) { return r.form==='entry'?label('Entry in')+' '+e(r.path):label(r.form==='folder'?'Folder':'File'); }
function layeredSize(bytes) { return bytes<1024?number(bytes)+' B':bytes<1048576?number(Math.round(bytes/102.4)/10)+' KB':number(Math.round(bytes/104857.6)/10)+' MB'; }
function layeredSays(message) { return '<small class="pull-says" data-verbatim>'+e(message)+'</small>'; }
function layeredState(s) {
 if(s.kind==='conflict'){const [name,fix]=layeredConflicts[s.reason];return '<span class="state s-problem">'+label(name)+'</span>'+layeredSays(s.message)+'<small class="fix">'+label(fix)+'</small>';}
 const badge='<span class="state s-'+(s.kind==='invalid'||s.kind==='refused'?'problem':s.kind)+'">'+label(layeredStateNames[s.kind])+'</span>';
 if(s.kind==='replaced')return badge+'<small>'+label('by')+' <code data-verbatim>'+e(s.by)+'</code></small>';
 if(s.kind==='invalid')return badge+'<small class="fallback">'+label(layeredFallbacks[s.fallback])+'</small>'+layeredSays(s.message)+'<small class="fix">'+label(layeredFixes.invalid)+'</small>';
 if(s.kind==='refused'||s.kind==='blocked')return badge+layeredSays(s.message)+'<small class="fix">'+label(layeredFixes[s.kind])+'</small>';
 if(s.kind==='inactive'||s.kind==='unsubscribed')return badge+'<small>'+label(layeredFixes[s.kind])+'</small>';
 if(s.kind==='off')return badge+'<small>'+label('Recall is off for this member.')+'</small>'+command('teamai recall enable');
 return badge;
}
function layeredToggle(key, open, text) { return '<button class="link layered-toggle" data-layered-toggle="'+e(key)+'" aria-expanded="'+(open?'true':'false')+'">'+label(open?'Hide':text)+'</button>'; }
function layeredFolder(f) {
 const files='<ul class="folder-files">'+f.files.map(x=>'<li><code data-verbatim>'+e(x.path)+'</code>'+(x.executable?'<span class="tag" title="'+label('Executable')+'">'+label('Executable')+'</span>':'')+'<small>'+layeredSize(x.bytes)+'</small></li>').join('')+'</ul>';
 const total='<p class="folder-total">'+label('Total')+' <b>'+layeredSize(f.bytes)+'</b>'+(f.limit?' · '+label('Workflow folder limit')+' '+layeredSize(f.limit)+'<span class="meter" aria-hidden="true"><i style="width:'+Math.min(100,Math.max(1,Math.round(f.bytes/f.limit*100)))+'%"></i></span>':'')+'</p>';
 const d=f.delivered;
 const delivered=d?'<p class="folder-at">'+label(d.by==='run'?'Each run keeps this version at':'Pull delivers it to')+' <code data-verbatim>'+e(d.path)+'</code> '+(d.present?'<span class="tag good">'+label(d.by==='run'?'Kept':'Delivered')+'</span>':'<span class="tag amber">'+label(d.by==='run'?'Not kept yet: the next run keeps it':'Not delivered yet: run teamai pull')+'</span>')+'</p>':'';
 const quote=a=>/[\\s"']/.test(a)?JSON.stringify(a):a;
 const runs=f.runs?'<p class="folder-runs">'+label('Runs')+'</p><code class="command" data-verbatim>'+e([f.runs.command].concat(f.runs.args.map(quote)).join(' '))+'</code>'+(f.runs.env.length?'<p class="folder-env">'+label('Env')+' '+f.runs.env.map(n=>'<code data-verbatim>'+e(n)+'</code>').join(' ')+' <small>'+label('Values are not shown')+'</small></p>':''):'';
 const variant=f.variant?'<p class="folder-variant">'+label('Rule text from')+' <code data-verbatim>'+e(f.variant)+'</code></p>':'';
 const reads=f.reads&&f.reads.length?'<p class="folder-runs">'+label('Where each tool reads')+' <code data-verbatim>\${TEAMAI_RULE_DIR}</code></p><ul class="folder-reads">'+f.reads.map(x=>'<li><b data-verbatim>'+e(x.tool)+'</b><code data-verbatim>'+e(x.path)+'</code><small>'+label(layeredReach[x.reach])+'</small></li>').join('')+'</ul>':'';
 return files+total+variant+delivered+reads+runs;
}
function layeredRow(list, r, open) {
 // teamai's definition can share its path with the team's that replaces it, as rules/teamai-recall/ does.
 const key=list.type+':'+(r.layer.kind==='teamai'?'teamai:':'')+r.path+'#'+r.name,shown=open.has(key);
 const replaces=r.replaces?layeredLayer(r.replaces.layer)+'<small><code data-verbatim>'+e(r.replaces.path)+'</code></small>':'<span class="muted">—</span>';
 return '<tr data-row="'+e(key)+'" class="'+(r.state.kind==='conflict'||r.state.kind==='invalid'||r.state.kind==='refused'?'problem-row':'')+'"><td data-verbatim><b>'+e(r.name)+'</b><small><code>'+e(r.path)+'</code></small></td>'
  +'<td data-label="'+label('LAYER')+'">'+layeredLayer(r.layer)+'</td><td data-label="'+label('FORM')+'">'+layeredForm(r)+'</td><td data-label="'+label('STATE')+'">'+layeredState(r.state)+'</td>'
  +'<td data-label="'+label('REPLACES')+'">'+replaces+'</td><td class="toggle-cell">'+(r.folder?layeredToggle(key,shown,'Files'):'')+'</td></tr>'
  +(r.folder&&shown?'<tr class="layered-detail" data-detail="'+e(key)+'"><td colspan="6">'+layeredFolder(r.folder)+'</td></tr>':'');
}
function layeredType(list, open) {
 // teamai's defaults in force fold into one row; one that is held shows on its own.
 const folded=r=>r.layer.kind==='teamai'&&r.state.kind==='in-force',team=list.resources.filter(r=>!folded(r)),defaults=list.resources.filter(folded);
 const key=list.type+':teamai',shown=open.has(key);
 const head='<h3>'+label(layeredTypeNames[list.type])+' <span class="count">'+number(team.length)+'</span> <code class="marker" data-verbatim>'+e(list.marker)+'</code></h3>';
 const defaultsRow=defaults.length?'<tr data-row="'+e(key)+'" class="defaults-row"><td colspan="5">'+layeredLadder({kind:'teamai'})+number(defaults.length)+' '+label(defaults.length===1?'teamai default in force':'teamai defaults in force')
  +(shown?'<span class="default-names">'+defaults.map(r=>'<code data-verbatim>'+e(r.name)+'</code>').join(' ')+'</span>':'')+'</td><td class="toggle-cell">'+layeredToggle(key,shown,'Show')+'</td></tr>':'';
 const table=team.length||defaults.length?'<div class="table-scroll"><table class="session-table layered-table"><thead><tr>'+['NAME','LAYER','FORM','STATE','REPLACES',''].map(x=>'<th>'+(x?label(x):'')+'</th>').join('')+'</tr></thead><tbody>'+team.map(r=>layeredRow(list,r,open)).join('')+defaultsRow+'</tbody></table></div>':'<p class="layered-none">'+label('No team definitions')+'</p>';
 const problems=list.problems.length?'<div class="layered-problems"><p class="amber">'+label('Pull cannot read these')+'</p><ul>'+list.problems.map(x=>'<li><code data-verbatim>'+e(x.path)+'</code>'+layeredSays(x.message)+'</li>').join('')+'</ul></div>':'';
 const notes=list.notes.length?'<ul class="layered-notes">'+list.notes.map(n=>'<li data-verbatim>'+e(n)+'</li>').join('')+'</ul>':'';
 return '<div class="layered-type">'+head+table+problems+notes+'</div>';
}
function layeredValue(value) { return value===null?'<span class="muted">—</span>':e(typeof value==='object'?JSON.stringify(value):String(value)); }
function defaultHookSource(h) {
 if(h.state.kind==='teamai')return layeredLayer({kind:'teamai'});
 if(h.state.kind==='replaced')return layeredLadder({kind:'root'})+label('Team folder')+' <code data-verbatim>'+e(h.state.path)+'</code>';
 return '<span class="state s-problem">'+label('Refused')+'</span> <code data-verbatim>'+e(h.state.path)+'</code>'+h.state.messages.map(layeredSays).join('')+'<small class="fix">'+label(layeredFixes.refused)+'</small>';
}
function defaultHookRow(h, language, open) {
 const key='default-hooks:'+h.name,shown=open.has(key);
 const changed=h.params.filter(p=>p.team!==null&&JSON.stringify(p.team)!==JSON.stringify(p.teamai));
 const variant=language?h.texts.filter(x=>x.file.endsWith('.'+language+'.md')).length:0;
 const params=h.params.length?number(changed.length)+' '+label('of')+' '+number(h.params.length)+' '+label('parameters changed'):label('No parameters');
 const texts=number(h.texts.filter(x=>x.replaced).length)+' '+label('of')+' '+number(h.texts.length)+' '+label('texts changed')+(language?'<small>'+label('Language')+' <code data-verbatim>'+e(language)+'</code>: '+number(variant)+' '+label('of')+' '+number(h.texts.length)+' '+label('from a variant')+'</small>':'');
 const detail=shown?'<tr class="layered-detail" data-detail="'+e(key)+'"><td colspan="5">'
  +(h.params.length?'<table class="params-table"><thead><tr>'+['PARAMETER','TEAMAI','TEAM'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+h.params.map(p=>'<tr'+(changed.includes(p)?' class="changed"':'')+'><td><code data-verbatim>'+e(p.key)+'</code></td><td>'+layeredValue(p.teamai)+'</td><td>'+layeredValue(p.team)+'</td></tr>').join('')+'</tbody></table>':'')
  +'<ul class="hook-texts">'+h.texts.map(x=>'<li><code data-verbatim>'+e(x.text)+'</code> <code data-verbatim>'+e(x.file)+'</code>'+(x.replaced?' <span class="tag amber">'+label('Changed by the team')+'</span>':'')+(language&&!x.file.endsWith('.'+language+'.md')?' <small>'+label('Base text: this folder has no variant for the language')+'</small>':'')+'</li>').join('')+'</ul>'
  +(h.delivered?'<p class="folder-at">'+label('Pull delivers it to')+' <code data-verbatim>'+e(h.delivered.path)+'</code> '+(h.delivered.present?'<span class="tag good">'+label('Delivered')+'</span>':'<span class="tag amber">'+label('Not delivered yet: run teamai pull')+'</span>')+'</p>':'')
  +'</td></tr>':'';
 return '<tr data-row="'+e(key)+'" class="'+(h.state.kind==='refused'?'problem-row':'')+'"><td data-verbatim><b>'+e(h.name)+'</b></td><td data-label="'+label('SOURCE')+'">'+defaultHookSource(h)+'</td><td data-label="'+label('PARAMETERS')+'">'+params+'</td><td data-label="'+label('TEXTS')+'">'+texts+'</td><td class="toggle-cell">'+layeredToggle(key,shown,'Details')+'</td></tr>'+detail;
}
function defaultHooksPanel(data, open) {
 if(!data.defaultHooks.length)return '';
 return '<section class="panel layered default-hooks" aria-labelledby="default-hooks-title"><div class="panelhead"><h2 id="default-hooks-title">'+label('Default hooks')+' <span class="count">'+number(data.defaultHooks.length)+'</span></h2><span class="label">'+label('teamai\\'s hints, and the team folders at the root that replace them')+'</span></div>'
  +'<div class="table-scroll"><table class="session-table layered-table hooks-table"><thead><tr>'+['HOOK','SOURCE','PARAMETERS','TEXTS',''].map(x=>'<th>'+(x?label(x):'')+'</th>').join('')+'</tr></thead><tbody>'+data.defaultHooks.map(h=>defaultHookRow(h,data.language,open)).join('')+'</tbody></table></div></section>';
}
function layeredResourcesPanel(data, open) {
 if(!data||!data.configured)return '';
 const total=data.types.reduce((n,list)=>n+list.resources.filter(r=>r.layer.kind!=='teamai').length,0);
 const legend='<p class="layer-legend">'+layeredLayer({kind:'teamai'})+' <span aria-hidden="true">‹</span> '+layeredLayer({kind:'root'})+' <span aria-hidden="true">‹</span> '+layeredLadder({kind:'namespace'})+label('Active namespace')+'<small>'+label('A later layer replaces an earlier one of the same name.')+'</small></p>';
 return '<section class="panel layered" aria-labelledby="layered-title"><div class="panelhead"><h2 id="layered-title">'+label('Resource layers')+' <span class="count">'+number(total)+'</span></h2><span class="label">'+label('Which definition of each name applies to this workspace')+'</span></div>'
  +legend+data.types.map(list=>layeredType(list,open)).join('')+'</section>'+defaultHooksPanel(data,open);
}
`;

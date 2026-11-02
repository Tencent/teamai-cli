/**
 * The Self-improvement page of the dashboard client (#1249), embedded in `dashboardClient`'s closure after the Scorers
 * page, whose helpers it uses besides the closure's: `pct`, `short`, `meter`, `sparkline`, `kpiCard`, `scorerQuery` and
 * `scorerData`. Every value from the API is escaped with `e`. A run opens through the Workflow Runs dialog, and a
 * scorer on the Scorers page with its failing labels.
 */
export const selfImprovementClient = `
let loopData=null, loopError='', loopLoading=false, loopHtml='', loopRequest=0;
let loopFilter=['all','proposed','landed','closed'].includes(read('teamai-dashboard-loop-filter','all'))?read('teamai-dashboard-loop-filter','all'):'all';
function resetLoop(){loopData=null;loopError='';loopLoading=false;loopHtml='';}
const loopDelta=(from,to)=>from==null||to==null?null:Math.round((to-from)*100);
const loopRate=r=>r.planned?r.passed/r.planned:null;
function loopPts(d){ return d===null?'':'<b class="'+(d>0?'good':d<0?'amber':'muted')+'">'+(d>0?'+':'')+number(d)+' '+label('pts')+'</b>'; }
/** The team asset a file belongs to: its directory under the team root, and the name under it, such as skills/review. */
function loopAsset(file){ const parts=file.replace(/^\\.teamai\\//,'').split('/'); return parts.length>2?parts[0]+'/'+parts[1]:parts.length===2?parts[0]+'/'+parts[1].replace(/\\.[a-z]+$/,''):parts[0]; }
function loopAssets(c){
 const tasks=new Set(c.tasks), seen=new Map();
 for(const file of c.files){ if(tasks.has(file))continue; const asset=loopAsset(file); seen.set(asset,[...(seen.get(asset)||[]),file]); }
 const chips=[...seen.entries()];
 return chips.length?chips.slice(0,4).map(([asset,files])=>'<span class="tag" data-verbatim title="'+e(files.join('\\n'))+'">'+e(asset)+'</span>').join(' ')+(chips.length>4?' <span class="muted">+'+number(chips.length-4)+'</span>':''):'<span class="muted">'+label('Only regression tasks')+'</span>';
}
function loopProof(c){
 if(!c.proof)return '<span class="muted">'+label('Not run yet')+'</span>'+(loopData.setup.jobs.proof?'':'<small>'+label('No CI job proves changes yet')+'</small>');
 if(!c.proof.comparisons.length)return '<span class="muted">'+label('No arm pair to compare')+'</span>';
 return c.proof.comparisons.map(x=>'<div class="loop-proof"><span class="tag" data-verbatim>'+e(x.to.tool)+'</span> '+number(x.rates.from.passed)+'/'+number(x.rates.from.planned)+' → '+number(x.rates.to.passed)+'/'+number(x.rates.to.planned)+' '+loopPts(loopDelta(loopRate(x.rates.from),loopRate(x.rates.to)))+'</div>').join('')
  +'<small><button class="link" data-run="'+e(c.proof.run)+'" data-run-source="'+e(c.proof.source)+'"><span data-verbatim>'+e(c.proof.suite)+'</span> · '+e(when(c.proof.startedAt))+' ↗</button></small>';
}
function loopImpact(c){
 if(c.state==='proposed')return '<span class="muted">'+label('Measured once it lands')+'</span>';
 const i=c.impact; if(!i)return '<span class="muted">'+label('No labels for this scorer')+'</span>';
 if(!i.after.n)return '<span class="muted">'+label('Waiting for labelled work on it')+'</span><small>'+label('Before')+' '+pct(i.before.rate)+' · '+number(i.before.n)+' '+label('labels')+'</small>';
 return pct(i.before.rate)+' → '+pct(i.after.rate)+' '+loopPts(loopDelta(i.before.rate,i.after.rate))+'<small>'+number(i.before.n)+' / '+number(i.after.n)+' '+label('labels')+'</small>';
}
function loopLink(url,text){ return /^https?:\\/\\//.test(url)?'<a class="link" href="'+e(url)+'" target="_blank" rel="noopener noreferrer">'+label(text)+' ↗</a>':'<span data-verbatim>'+e(url)+'</span>'; }
function loopOpen(c){
 if(c.state==='closed')return loopLink(c.url,'Pull request');
 if(c.state==='landed')return '<span class="tag" data-verbatim title="'+e(c.commit)+'">'+short(c.commit)+'</span>';
 const r=c.request;
 if(r.kind==='open')return loopLink(r.url,'Pull request');
 return (r.kind==='not_open'?'<span class="amber">'+label('No open pull request')+'</span>':'<span class="muted">'+label('Branch')+'</span>')+'<small data-verbatim>'+e(c.branch)+'</small>';
}
function loopState(c){ return c.state==='landed'?'<span class="tag good">'+label('Landed')+'</span>':c.state==='closed'?'<span class="tag muted">'+label('Closed')+'</span>':'<span class="tag amber">'+label('Proposed')+'</span>'; }
/** When the change happened: a request's opening while proposed, its closing once closed, else its commit. */
function loopWhen(c){
 if(c.state==='proposed'&&c.request.kind==='open')return e(when(c.request.openedAt))+'<small>'+label('Opened')+'</small>';
 if(c.state==='closed')return e(when(c.at))+'<small>'+label('Closed without merging')+'</small>';
 return e(when(c.at));
}
function loopCells(c){
 const scorer='<button class="link" data-loop-scorer="'+e(c.scorer)+'" data-verbatim>'+e(c.scorer)+'</button>';
 if(c.state==='closed')return [loopState(c)+' <span data-verbatim>'+e(c.title)+'</span>',scorer,'<span class="muted">—</span>','<span class="muted">—</span>','<span class="muted">'+label('Never landed')+'</span>',loopWhen(c),loopOpen(c)];
 return [loopState(c)+' <span data-verbatim>'+e(c.title)+'</span><small>'+number(c.tasks.length)+' '+(c.tasks.length===1?label('regression task'):label('regression tasks'))+'</small>',scorer,loopAssets(c),loopProof(c),loopImpact(c),loopWhen(c),loopOpen(c)];
}
function loopChanges(d){
 const counts={all:d.changes.length}; for(const k of ['proposed','landed','closed'])counts[k]=d.changes.filter(c=>c.state===k).length;
 const rows=d.changes.filter(c=>loopFilter==='all'||c.state===loopFilter);
 const tabs='<div class="imp-tabs" role="tablist">'+[['all','All'],['proposed','Proposed'],['landed','Landed'],['closed','Closed']].filter(([k])=>k!=='closed'||counts.closed).map(([k,n])=>'<button role="tab" data-loop-filter="'+k+'" aria-selected="'+(k===loopFilter)+'" class="'+(k===loopFilter?'active':'')+'">'+label(n)+' <span>'+number(counts[k])+'</span></button>').join('')+'</div>';
 const heads=['CHANGE','SCORER','ASSETS','PROOF ON THE REGRESSION SUITE','PASS RATE BEFORE → AFTER','WHEN','OPEN'];
 const body=rows.length?'<div class="table-scroll"><table class="session-table loop-changes"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +rows.map(c=>{const cells=loopCells(c);
   return '<tr>'+cells.map((x,i)=>'<td data-label="'+e(t(heads[i]))+'">'+x+'</td>').join('')+'</tr>';}).join('')+'</tbody></table></div>'
  :'<div class="empty"><p>'+(d.changes.length?label('None in this view.'):label('No change yet. A run proposes one once a scorer has two failures a regression task can start from.'))+'</p></div>';
 return '<section class="panel sessions" id="loop-changes"><div class="panelhead"><h2>'+label('Changes')+' <span class="count">'+number(d.changes.length)+'</span></h2><span class="label">'+label('Proposed on origin, landed on the default branch in the last 180 days, or closed without merging')+'</span></div>'+tabs+body+'</section>';
}
function loopNext(s){
 if(s.isReady)return '<div class="imp-cmd"><code data-verbatim>'+e(s.command)+'</code><button class="link copy" data-copy="'+e(s.command)+'" aria-label="'+label('Copy command')+'">'+label('Copy')+'</button></div>';
 if(!s.stats.failed)return '<span class="muted">'+label('Nothing failing')+'</span>';
 return '<span class="muted">'+(s.startable===1?label('Waiting for a second failure a task can start from'):label('No failure a task can start from'))+'</span>';
}
function loopQueue(s){
 const refused=[['tracked_changes','uncommitted changes'],['not_recorded','start not recorded'],['not_in_checkout','commit not in this checkout']].filter(([k])=>s.refused[k]).map(([k,n])=>number(s.refused[k])+' '+label(n));
 return '<b class="good">'+number(s.startable)+'</b> '+label('can become a task')+' · <b>'+number(s.covered.length)+'</b> '+label('covered')+(refused.length?'<small>'+label('Not usable')+': '+refused.join(' · ')+'</small>':'');
}
function loopScorers(d){
 const heads=['SCORER','PASS RATE, 30 DAYS','TREND','FAILURES','NEXT RUN','CHANGES'];
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Scorers in the loop')+' <span class="count">'+number(d.scorers.length)+'</span></h2><span class="label">'+label('What teamai self-improvement run would start from now')+'</span></div>'
  +(d.scorers.length?'<div class="table-scroll"><table class="session-table loop-scorers"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +d.scorers.map(s=>{const mine=d.changes.filter(c=>c.scorer===s.scorer), open=mine.filter(c=>c.state==='proposed').length;
   const cells=['<button class="link" data-loop-scorer="'+e(s.scorer)+'" data-verbatim>'+e(s.scorer)+'</button><small>'+label('Failing labels')+' →</small>',meter(s.stats.rate)+' '+pct(s.stats.rate)+'<small>'+number(s.stats.n)+' '+label('labels')+'</small>',sparkline(s.trend),loopQueue(s),loopNext(s),'<div class="loop-counts">'+(s.requests?[[s.requests.open,'open'],[s.requests.merged,'merged'],[s.requests.closed,'closed']]:[[open,'open'],[mine.filter(c=>c.state==='landed').length,'landed']]).map(([n,name])=>'<span>'+number(n)+' '+label(name)+'</span>').join('')+'</div>'];
   return '<tr>'+cells.map((x,i)=>'<td data-label="'+e(t(heads[i]))+'">'+x+'</td>').join('')+'</tr>';}).join('')+'</tbody></table></div>'
  :'<div class="empty"><p>'+label('No score labels yet. Labels appear once a scorer judges work and they reach teamai-reports.')+'</p></div>')+'</section>';
}
function loopFlow(d){
 const failing=d.scorers.reduce((n,s)=>n+s.stats.failed,0), covered=d.scorers.reduce((n,s)=>n+s.covered.length,0), proposed=d.changes.filter(c=>c.state==='proposed'), landed=d.changes.filter(c=>c.state==='landed');
 const better=landed.filter(c=>c.impact&&c.impact.after.n&&c.impact.before.rate!=null&&c.impact.after.rate>c.impact.before.rate).length;
 const steps=[[failing,'Failing labels','last 30 days'],[covered,'Regression tasks','from those failures'],[proposed.length,'Proposed','open on origin'],[d.changes.filter(c=>c.proof).length,'Proven','on the regression suite'],[landed.length,'Landed','last 180 days'],[better,'Better after','pass rate went up']];
 return '<ol class="loop-flow" aria-label="'+label('The loop')+'">'+steps.map(([n,name,sub])=>'<li><b>'+number(n)+'</b><span>'+label(name)+'</span><small>'+label(sub)+'</small></li>').join('')+'</ol>';
}
/** How the host ended the proposals' pull requests: merged against all that ended. */
function loopReview(r,proposed){
 if(r.kind!=='answered')return kpiCard(label('Open proposals'),number(proposed.length),number(proposed.filter(c=>c.proof).length)+' '+label('proven on the regression suite'));
 const ended=r.merged+r.closed;
 return kpiCard(label('Pull requests merged'),number(r.merged)+' <small>/ '+number(ended)+(ended?' · '+pct(r.merged/ended):'')+'</small>',number(r.closed)+' '+label('closed without merging')+' · '+number(r.open)+' '+label('open'));
}
function loopKpis(d){
 const landed=d.changes.filter(c=>c.state==='landed'), proposed=d.changes.filter(c=>c.state==='proposed');
 const deltas=landed.flatMap(c=>c.impact&&c.impact.after.n?[loopDelta(c.impact.before.rate,c.impact.after.rate)]:[]).filter(x=>x!==null);
 const mean=deltas.length?Math.round(deltas.reduce((a,b)=>a+b,0)/deltas.length):null;
 const failing=d.scorers.reduce((n,s)=>n+s.stats.failed,0), covered=d.scorers.reduce((n,s)=>n+s.covered.length,0), startable=d.scorers.reduce((n,s)=>n+s.startable,0);
 return '<div class="kpis loop-kpis">'
  +kpiCard(label('Landed'),number(landed.length),deltas.length?label('Pass rate after them')+' '+loopPts(mean)+' '+label('on average'):label('No labelled work after them yet'))
  +loopReview(d.requests,proposed)
  +kpiCard(label('Failures with a regression task'),number(covered)+' <small>/ '+number(failing)+'</small>',number(startable)+' '+label('can become a task'))
  +kpiCard(label('Ready to run'),number(d.scorers.filter(s=>s.isReady).length)+' <small>/ '+number(d.scorers.length)+'</small>',label('scorers with enough failures'))
  +'</div>';
}
function loopCheck(ok,title,detail){ return '<li class="'+(ok?'done':'todo')+'"><span class="loop-check" aria-hidden="true">'+(ok?'✓':'○')+'</span><div><strong>'+label(title)+'</strong><p>'+detail+'</p></div></li>'; }
function loopSetup(d){
 const s=d.setup, regressions=s.suites.filter(x=>x.regressions);
 const items=[
  loopCheck(d.scorers.length>0,'Scorer labels reach teamai-reports',d.scorers.length?number(d.scorers.length)+' '+label('scorers with labels in the last 30 days'):label('Push a scorer and let it label work, then publish with teamai score --push.')),
  loopCheck(s.suites.length>0,'A regression suite',s.suites.length?s.suites.map(x=>'<span class="tag" data-verbatim title="'+e(x.path)+'">'+e(x.name)+'</span> '+number(x.tasks)+' '+label('tasks')+', '+number(x.regressions)+' '+label('from failures')).join(' · '):label('Push benchmarks/regressions/suite.yaml with team: [main, pulled].')),
  loopCheck(!!s.jobs.improve,'A CI job runs the loop',s.jobs.improve?'<span data-verbatim>'+e(s.jobs.improve)+'</span>':label('Add a scheduled job that runs teamai self-improvement run on a runner it throws away.')),
  loopCheck(!!s.jobs.proof,'A CI job proves each change',s.jobs.proof?'<span data-verbatim>'+e(s.jobs.proof)+'</span>':label('Add a pull request job that runs teamai benchmark run on the regression suite.')),
  loopCheck(s.workflow.source!=='missing','The workflow',s.workflow.source==='team'?label('The team\\'s')+' <span data-verbatim>'+e(s.workflow.path)+'</span>':s.workflow.source==='default'?label('teamai\\'s default teamai-self-improvement'):label('Not found. Run teamai pull.')),
 ];
 const done=[d.scorers.length>0,s.suites.length>0,!!s.jobs.improve,!!s.jobs.proof,s.workflow.source!=='missing'].filter(Boolean).length;
 return '<section class="panel loop-setup"><div class="panelhead"><h2>'+label('Setup')+' <span class="count">'+number(done)+' / 5</span></h2><span class="label">'+(regressions.length?number(regressions.reduce((n,x)=>n+x.regressions,0))+' '+label('regression tasks guard the harness'):label('See docs/guide/self-improvement.md'))+'</span></div><ul>'+items.join('')+'</ul></section>';
}
function loopRuns(d){
 const heads=['STARTED','STATUS','BY','RUN'];
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Recent runs')+' <span class="count">'+number(d.runs.length)+'</span></h2><span class="label" data-verbatim>teamai-self-improvement</span></div>'
  +(d.runs.length?'<div class="table-scroll"><table class="session-table compact loop-runs"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +d.runs.map(r=>'<tr><td>'+e(when(r.startedAt))+'</td><td>'+runStatus(r.status)+'</td><td data-verbatim>'+e(r.username||t('This machine'))+'</td><td><button class="link" data-run="'+e(r.run)+'" data-run-source="'+e(r.source)+'"><span data-verbatim>'+e(r.run)+'</span> ↗</button></td></tr>').join('')
  +'</tbody></table></div>':'<div class="empty"><p>'+label('No run yet.')+'</p></div>')+'</section>';
}
function loopStatus(d){
 const last=d.runs[0], s=d.setup, active=!!s.jobs.improve;
 return '<div class="statusline loop-status"><span class="'+(active?'good':'amber')+'"><span class="connection-dot"></span>'+(active?label('Runs in CI'):label('Not scheduled'))+'</span>'
  +(last?'<span>'+label('Last run')+' <button class="link" data-run="'+e(last.run)+'" data-run-source="'+e(last.source)+'">'+e(when(last.startedAt))+'</button> · '+runStatus(last.status)+'</span>':'<span>'+label('No run yet.')+'</span>')
  +'<span>'+label('Window')+': '+e(when(d.window.from))+' – '+e(when(d.window.to))+'</span></div>';
}
function selfImprovementPage(){
 if(page==='self-improvement'&&!loopData&&!loopLoading&&!loopError)loadLoop();
 if(loopError&&!loopData)return errorPanel(loopError,'self-improvement');
 if(!loopData)return '<div class="empty" role="status">'+label('Loading self-improvement…')+'</div>';
 if(!loopData.configured)return '<section class="panel"><div class="empty"><h2>'+label('No TeamAI scope in this workspace')+'</h2><p>'+label('Pick a project workspace above, or set one up with teamai init.')+'</p></div></section>';
 const d=loopData;
 return '<p class="loop-lede">'+label('A scorer\\'s repeated failures become one pull request that changes the team\\'s harness and adds a regression task for each. The regression suite proves the change on every tool before it lands, and the scorer shows whether work passes more after it.')+'</p>'
  +loopStatus(d)+loopFlow(d)+loopKpis(d)+loopChanges(d)+loopScorers(d)+'<div class="loop-two">'+loopSetup(d)+loopRuns(d)+'</div>';
}
async function loadLoop(){
 const generation=workspaceGeneration, request=++loopRequest, current=()=>generation===workspaceGeneration&&request===loopRequest; loopLoading=true;
 try{
  const response=await fetch(apiQuery('/api/self-improvement',{}),{signal:AbortSignal.timeout(60000)});
  const data=await response.json().catch(()=>null);
  if(!current())return;
  if(!response.ok)loopError=data&&data.error?data.error:t('Could not load self-improvement.');
  else{loopData=data;loopError='';}
 }catch{if(current())loopError=t('Could not load self-improvement.');}
 finally{if(current()){loopLoading=false;if(page==='self-improvement'){const html=selfImprovementPage();if(html!==loopHtml){loopHtml=html;render();}}}}
}
document.addEventListener('click',event=>{
 const filter=event.target.closest('[data-loop-filter]'), scorer=event.target.closest('[data-loop-scorer]');
 if(filter){loopFilter=filter.dataset.loopFilter;save('teamai-dashboard-loop-filter',loopFilter);render();}
 else if(scorer){scorerQuery={...scorerQuery,scorer:scorer.dataset.loopScorer,cohort:'',group:'',failing:'',commit:''};scorerData=null;scorerError='';scorerHtml='';location.hash='scorers';}
});
`;

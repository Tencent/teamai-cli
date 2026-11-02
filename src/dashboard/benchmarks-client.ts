/**
 * The Benchmarks page of the dashboard client (#1180), embedded in `dashboardClient`'s closure after the Scorers page,
 * whose helpers it uses: `$`, `e`, `t`, `label`, `number`, `when`, `read`, `save`, `apiQuery`, `errorPanel`, `render`,
 * `page`, `workspaceGeneration`, `pct`, `short`, `sparkline`, `kpiCard` and `meter`. Every value from the API is escaped
 * with `e`. A run opens through the Workflow Runs dialog.
 */
import { BENCHMARK_WINDOWS } from '../benchmark/history.js';

export const benchmarksClient = `
let benchData=null, benchError='', benchLoading=false, benchHtml='', benchRequest=0, benchAxis='tokens', benchDimension='', benchComparison='', benchConfig='', benchRevision='';
const savedBenchView=read('teamai-dashboard-benchmark-view','arms');
let benchView=['arms','compare','team'].includes(savedBenchView)?savedBenchView:'arms';
const benchWindows=${JSON.stringify(BENCHMARK_WINDOWS.map(String))};
const savedBenchWindow=read('teamai-dashboard-benchmark-window','90');
let benchQuery={window:benchWindows.includes(savedBenchWindow)?savedBenchWindow:'90',suite:''};
function resetSelection(){benchComparison='';benchConfig='';benchRevision='';}
function resetBenchmarks(){benchData=null;benchError='';benchLoading=false;benchHtml='';benchQuery={...benchQuery,suite:''};resetSelection();}
const passOf=r=>r&&r.planned?r.passed/r.planned:null;
const rateCell=r=>r&&r.planned?pct(r.passed/r.planned)+' <small>'+number(r.passed)+'/'+number(r.planned)+'</small>':'<span class="muted">—</span>';
const armColor=i=>'var(--arm'+(i%12+1)+')';
const teamText=team=>!team||team.kind==='pulled'?t('pulled team'):team.kind==='none'?t('no team assets'):team.kind==='ref'?team.ref:t('without')+' '+team.paths.join(', ');
const armConfig=a=>a.tool+(a.model?' · '+a.model:'')+(a.effort?' · '+a.effort:'')+(a.team&&a.team.kind!=='pulled'?' · '+teamText(a.team):'');
const armTitle=a=>a.arm+' ('+armConfig(a)+')';
const swatch=i=>'<i class="swatch" style="background:'+armColor(i)+'"></i>';
function armName(a,i){ return swatch(i)+'<span data-verbatim>'+e(a.arm)+'</span><small data-verbatim>'+e(armConfig(a))+'</small>'; }
function heat(rate){ return rate==null?'':'background:color-mix(in oklab,color-mix(in oklab,var(--green) '+Math.round(rate*100)+'%,var(--error)) '+Math.round(30+Math.abs(rate-0.5)*80)+'%,var(--panel))'; }
const chartWidth=()=>window.innerWidth<700?440:760;
function costText(cost){
 if(!cost||cost.kind==='unknown')return '<span class="muted">—</span>';
 if(cost.kind==='mixed')return label('Mixed units');
 const amount=Math.round(cost.amount*10000)/10000+' <span data-verbatim>'+e(cost.unit)+'</span>';
 return cost.kind==='known'?amount:amount+' <small class="amber">'+label('incomplete')+'</small>';
}
function secondsText(ms){ return ms==null?'—':(ms>=60000?(Math.round(ms/6000)/10)+' min':(Math.round(ms/100)/10)+' s'); }
const overlaps=(a,b)=>a.pooled.low<=b.pooled.high&&b.pooled.low<=a.pooled.high;

const cardRow=(cls,heads,cells)=>'<tr class="'+cls+'">'+cells.map((cell,i)=>'<td data-label="'+e(heads[i])+'">'+cell+'</td>').join('')+'</tr>';
function suitesPanel(d){
 const heads=['SUITE','RUNS','LAST RUN','TASKS × ARMS','LEADER IN THE LAST RUN','PASS RATE PER RUN'];
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Suites')+' <span class="count">'+number(d.suites.length)+'</span></h2><span class="label">'+label('Pass rate is passed trials over planned trials, as each run\\'s own table prints it.')+'</span></div><div class="table-scroll"><table class="session-table bench-cards"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +d.suites.map(s=>{const selected=d.selected&&d.selected.suite===s.suite; return cardRow(selected?'selected-row':'',heads.map(t),['<button class="link" data-bench-suite="'+e(s.suite)+'" aria-pressed="'+selected+'" data-verbatim>'+e(s.suite)+'</button>',number(s.runs),e(when(s.lastRunAt)),number(s.tasks)+' × '+number(s.arms),s.leader?'<span data-verbatim>'+e(s.leader.arm)+'</span> '+rateCell(s.leader):'—',sparkline(s.trend.map(p=>({rate:passOf(p)})))]);}).join('')
  +'</tbody></table></div></section>';
}
function benchKpis(sel){
 const pooled=sel.arms.filter(a=>a.pooled).sort((a,b)=>passOf(b.pooled)-passOf(a.pooled));
 const [first,second]=pooled, last=sel.runs[0], trials=pooled.reduce((sum,a)=>sum+a.pooled.planned,0);
 const close=first&&second&&overlaps(first,second);
 return '<div class="kpis bench-kpis">'
  +kpiCard(label('Runs'),number(sel.runs.length),number(sel.versions[0].runs)+' '+label('on the current suite version'))
  +kpiCard(label('Trials'),number(trials),label('pooled on the current suite version'))
  +kpiCard(label('Leading arm'),first?'<span data-verbatim>'+e(first.arm)+'</span>':'—',first?pct(passOf(first.pooled))+' · 95% '+pct(first.pooled.low)+'–'+pct(first.pooled.high)+(close?' · <b class="amber">'+label('not separated from')+' <span data-verbatim>'+e(second.arm)+'</span></b>':''):'')
  +kpiCard(label('Last run'),'<span class="kpi-date">'+e(when(last.startedAt))+'</span>',last.username?'<span data-verbatim>'+e(last.username)+'</span>':'')
  +'</div>';
}
function armBars(sel){
 const arms=sel.arms.filter(a=>a.pooled);
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Pass rate by arm')+'</h2><span class="label">'+label('Pooled over the runs of the current suite version. The line is the 95% interval: two arms whose lines overlap are not told apart by these runs.')+'</span></div><div class="arm-bars">'
  +arms.map(a=>{const i=sel.arms.indexOf(a), rate=passOf(a.pooled); return '<div class="arm-bar" title="'+e(armTitle(a)+': '+Math.round(rate*100)+'% ('+a.pooled.passed+'/'+a.pooled.planned+'), 95% '+Math.round(a.pooled.low*100)+'–'+Math.round(a.pooled.high*100)+'%')+'"><div class="arm-label">'+armName(a,i)+'</div><div class="arm-track" role="img" aria-label="'+e(armTitle(a)+' '+Math.round(rate*100)+'%')+'"><span class="arm-fill" style="width:'+(rate*100).toFixed(1)+'%;background:'+armColor(i)+'"></span><span class="arm-ci" style="left:'+(a.pooled.low*100).toFixed(1)+'%;width:'+((a.pooled.high-a.pooled.low)*100).toFixed(1)+'%"></span></div><div class="arm-value"><b>'+pct(rate)+'</b><small>'+number(a.pooled.passed)+'/'+number(a.pooled.planned)+' · '+number(a.pooled.runs)+' '+label('runs')+'</small>'+(a.pooled.deviations?'<small class="amber">'+number(a.pooled.deviations)+' '+label('deviations')+'</small>':'')+(a.pooled.notVerified?'<small class="muted">'+number(a.pooled.notVerified)+' '+label('not verified')+'</small>':'')+'</div></div>';}).join('')
  +'</div></section>';
}
function historyChart(sel){
 const runs=[...sel.runs].reverse(), index=new Map(runs.map((r,i)=>[r.run,i]));
 const W=window.innerWidth>=1300?1100:chartWidth(),H=W<500?274:284,pl=40,pr=16,pt=54,pb=34,pw=W-pl-pr,ph=H-pt-pb;
 const x=i=>pl+(runs.length<2?pw/2:i*pw/(runs.length-1)), y=r=>pt+(1-r)*ph;
 const toolChange=(r,i)=>i>0?Object.entries(r.toolVersions).filter(([tool,version])=>runs[i-1].toolVersions[tool]&&runs[i-1].toolVersions[tool]!==version):[];
 const every=Math.max(1,Math.ceil(runs.length/(W<500?4:8)));
 let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+e(t('Pass rate per run'))+'">'
  +[0,0.25,0.5,0.75,1].map(v=>'<line class="grid" x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="axis" x="'+(pl-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+Math.round(v*100)+'%</text>').join('');
 const labelled=W>=500;
 runs.forEach((r,i)=>{ const mx=i>0?(x(i-1)+x(i))/2:0, flip=mx>W*0.7, anchor=flip?' text-anchor="end"':'', tx=flip?mx-4:mx+4;
  const tools=toolChange(r,i); if(tools.length)svg+='<line class="tool-change" x1="'+mx+'" x2="'+mx+'" y1="'+(pt-42)+'" y2="'+(H-pb)+'"/>'+(labelled?'<text class="tool-label" x="'+tx+'" y="'+(pt-34)+'"'+anchor+'>'+e(t('Tool updated'))+' · '+e(tools.map(([tool,version])=>tool+' '+version).join(', '))+'</text>':'');
  if(i>0&&r.sourceHash!==runs[i-1].sourceHash)svg+='<line class="version" x1="'+mx+'" x2="'+mx+'" y1="'+(pt-28)+'" y2="'+(H-pb)+'"/>'+(labelled?'<text class="version-label" x="'+tx+'" y="'+(pt-20)+'"'+anchor+'>'+e(t('Suite changed'))+' · '+short(r.sourceHash)+'</text>':'');
  if(i>0&&r.teamRevision!==runs[i-1].teamRevision)svg+='<line class="team-change" x1="'+mx+'" x2="'+mx+'" y1="'+(pt-14)+'" y2="'+(H-pb)+'"/>'+(labelled?'<text class="team-label" x="'+tx+'" y="'+(pt-6)+'"'+anchor+'>'+e(t('Team assets changed'))+' · '+short(r.teamRevision)+'</text>':''); if(i%every===0||i===runs.length-1)svg+='<text class="axis" x="'+x(i)+'" y="'+(H-pb+18)+'" text-anchor="middle">'+e(r.startedAt.slice(5,10))+'</text>'; });
 sel.arms.forEach((a,ai)=>{
  const pts=a.points.filter(p=>p.planned&&index.has(p.run)).map(p=>({p,cx:x(index.get(p.run)),cy:y(passOf(p))}));
  if(pts.length>1)svg+='<polyline class="series'+(a.isCurrent?'':' earlier')+'" style="stroke:'+armColor(ai)+'" points="'+pts.map(q=>q.cx.toFixed(1)+','+q.cy.toFixed(1)).join(' ')+'"/>';
  svg+=pts.map(q=>'<circle class="point" cx="'+q.cx.toFixed(1)+'" cy="'+q.cy.toFixed(1)+'" r="4.5" style="fill:'+armColor(ai)+'"><title>'+e(armTitle(a)+' · '+when(q.p.startedAt)+' · '+Math.round(passOf(q.p)*100)+'% ('+q.p.passed+'/'+q.p.planned+') · '+q.p.run)+'</title></circle>').join('');
 });
 svg+='</svg>';
 const marks=(runs.some((r,i)=>i>0&&r.sourceHash!==runs[i-1].sourceHash)?'<span><i class="mark version"></i>'+label('Suite changed')+'</span>':'')+(runs.some((r,i)=>i>0&&r.teamRevision!==runs[i-1].teamRevision)?'<span><i class="mark team-change"></i>'+label('Team assets changed')+'</span>':'')+(runs.some((r,i)=>toolChange(r,i).length)?'<span><i class="mark tool-change"></i>'+label('Tool updated')+'</span>':'');
 const legend='<div class="legend">'+sel.arms.map((a,i)=>'<span class="'+(a.isCurrent?'':'muted')+'">'+armName(a,i)+(a.isCurrent?'':' <small>'+label('earlier configuration')+'</small>')+'</span>').join('')+marks+'</div>';
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Pass rate per run')+'</h2><span class="label">'+label('Each point is one run of one arm. A dashed line marks a change to the suite\\'s files: runs on either side measured different tasks.')+'</span></div><div class="chart-scroll">'+svg+'</div>'+legend+'</section>';
}
const usedBy=n=>number(n)+' '+t('trials reported it');
function usageX(a,axis){ return a.pooled?usageAt(a.pooled.usage,axis):null; }
function usageAt(u,axis){
 if(axis==='duration')return u.durationMs.value==null?null:u.durationMs.value/1000;
 if(axis==='cost')return u.cost.kind==='known'&&u.cost.used?u.cost.amount/u.cost.used:null;
 return u.tokens.value==null?null:u.tokens.value;
}
function usageUsed(a,axis){ const u=a.pooled.usage; return axis==='duration'?u.durationMs.used:axis==='cost'?u.cost.used:u.tokens.used; }
function costUnit(arms){ return usageUnit(arms.map(a=>a.pooled&&a.pooled.usage)); }
function usageUnit(usages){ const units=[...new Set(usages.map(u=>u&&u.cost.kind==='known'?u.cost.unit:null))]; return units.length===1&&units[0]?units[0]:null; }
function axisToggle(axis,unit){
 const axes=[['tokens',t('Tokens')],['duration',t('Duration')],['cost',t('Cost')]];
 return '<div class="chips" role="group" aria-label="'+e(t('Compare with'))+'">'+axes.map(([key,name])=>'<button class="chip'+(axis===key?' active':'')+'" data-bench-axis="'+key+'" aria-pressed="'+(axis===key)+'"'+(key==='cost'&&!unit?' disabled title="'+e(t('Every arm needs a cost its tool stated, in one unit.'))+'"':'')+'>'+e(name)+'</button>').join('')+'</div>';
}
const usageFormat=axis=>v=>axis==='tokens'?(v>=1000?(Math.round(v/100)/10)+'k':String(Math.round(v))):axis==='cost'?String(Number(v.toPrecision(2))):String(Math.round(v));
/** The pass rate grid, the usage ticks and the axis name of a chart of pass rate against usage. */
function usageGrid({W,H,pl,pr,pb,pw,x,y,max,axis,unit}){
 const fmt=usageFormat(axis), axisName=axis==='duration'?t('Median duration per trial (s)'):axis==='cost'?t('Cost per trial')+' ('+unit+')':t('Median tokens per trial (input + output)');
 return [0,0.25,0.5,0.75,1].map(v=>'<line class="grid" x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="axis" x="'+(pl-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+Math.round(v*100)+'%</text>').join('')
  +[0,0.25,0.5,0.75,1].map(f=>f*max/1.15).map(v=>'<text class="axis" x="'+x(v)+'" y="'+(H-pb+18)+'" text-anchor="middle">'+e(fmt(v))+'</text>').join('')
  +'<text class="axis-name" x="'+(pl+pw/2)+'" y="'+(H-8)+'" text-anchor="middle">'+e(axisName)+'</text>';
}
function scatterPanel(sel){
 const arms=sel.arms.filter(a=>a.pooled), unit=costUnit(arms);
 const axis=benchAxis==='cost'&&!unit?'tokens':benchAxis;
 const toggle=axisToggle(axis,unit);
 const placed=arms.map(a=>({a,i:sel.arms.indexOf(a),vx:usageX(a,axis),vy:passOf(a.pooled)})).filter(q=>q.vx!=null);
 if(!placed.length)return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Pass rate against cost')+'</h2>'+toggle+'</div><div class="empty"><p>'+label('No arm reported this value.')+'</p></div></section>';
 const W=chartWidth(),H=300,pl=44,pr=20,pt=20,pb=46,pw=W-pl-pr,ph=H-pt-pb, max=Math.max(...placed.map(q=>q.vx))*1.15||1;
 const x=v=>pl+v/max*pw, y=r=>pt+(1-r)*ph;
 const sorted=[...placed].sort((p,q)=>p.vx-q.vx||q.vy-p.vy), frontier=[]; let best=-1; for(const q of sorted){ if(q.vy>best){frontier.push(q);best=q.vy;} }
 const fmt=usageFormat(axis);
 let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+e(t('Pass rate against cost'))+'">'
  +usageGrid({W,H,pl,pr,pb,pw,x,y,max,axis,unit})
  +'<text class="better" x="'+(pl+8)+'" y="'+(pt+14)+'">↖ '+e(t('better: higher pass rate for less'))+'</text>'
  +(frontier.length>1?'<polyline class="frontier" points="'+frontier.map(q=>x(q.vx).toFixed(1)+','+y(q.vy).toFixed(1)).join(' ')+'"/>':'')
  +placed.map(q=>'<g><title>'+e(armTitle(q.a)+': '+Math.round(q.vy*100)+'% ('+q.a.pooled.passed+'/'+q.a.pooled.planned+'), 95% '+Math.round(q.a.pooled.low*100)+'–'+Math.round(q.a.pooled.high*100)+'% · '+fmt(q.vx)+' · '+usedBy(usageUsed(q.a,axis)))+'</title><line class="ci" x1="'+x(q.vx)+'" x2="'+x(q.vx)+'" y1="'+y(q.a.pooled.low)+'" y2="'+y(q.a.pooled.high)+'" style="stroke:'+armColor(q.i)+'"/><circle cx="'+x(q.vx)+'" cy="'+y(q.vy)+'" r="7" style="fill:'+armColor(q.i)+'"/><text class="point-label" x="'+(x(q.vx)>W*0.7?x(q.vx)-11:x(q.vx)+11)+'" y="'+(y(q.vy)+4)+'"'+(x(q.vx)>W*0.7?' text-anchor="end"':'')+'>'+e(q.a.arm)+'</text></g>').join('')
  +'</svg>';
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Pass rate against cost')+'</h2>'+toggle+'</div><div class="chart-scroll">'+svg+'</div><p class="scorer-hint">'+label('The dashed line joins the arms nothing beats on both: each is the cheapest way to reach its pass rate. Usage is the median over the trials whose tool reported it.')+'</p></section>';
}
function heatmapPanel(sel){
 const arms=sel.arms.filter(a=>a.isCurrent), runs=sel.versions[0].runs;
 return '<section class="panel sessions bench-panel"><div class="panelhead"><h2>'+label('Tasks by arm')+' <span class="count">'+number(sel.tasks.length)+'</span></h2><span class="label">'+label('Pooled over the runs of the current suite version. Find the task that separates the arms, or that no arm passes.')+'</span></div><div class="table-scroll"><table class="session-table heatmap"><thead><tr><th>'+label('TASK')+'</th>'+arms.map(a=>'<th><div class="arm-label">'+armName(a,sel.arms.indexOf(a))+'</div></th>').join('')+'<th title="'+e(t('In these runs, one arm both passed and failed this task, so a single trial of it says little.'))+'">'+label('UNSTABLE RUNS')+'</th></tr></thead><tbody>'
  +sel.tasks.map(task=>'<tr><td><span data-verbatim>'+e(task.task)+'</span>'+''+(task.unmeasuredRuns?' <span class="tag muted" title="'+e(t('Its check passed before any change or could not run, or the run ended first, so its trials did not run.'))+'">'+label('not measured in')+' '+number(task.unmeasuredRuns)+'/'+number(runs)+'</span>':'')+'</td>'
   +arms.map(a=>{const cell=task.arms.find(c=>c.key===a.key), rate=passOf(cell); return '<td class="heat" style="'+heat(rate)+'">'+rateCell(cell)+'</td>';}).join('')+'<td class="'+(task.disagreedRuns*2>=runs?'amber':'muted')+'">'+number(task.disagreedRuns)+'/'+number(runs)+'</td></tr>').join('')
  +'</tbody></table></div></section>';
}
function taskRunsPanel(sel){
 const runs=sel.runs.filter(r=>r.sourceHash===sel.versions[0].sourceHash).reverse();
 if(runs.length<2)return '';
 return '<section class="panel sessions bench-panel"><div class="panelhead"><h2>'+label('Tasks per run')+'</h2><span class="label">'+label('Every arm together, oldest run first. A task that turns red after a team change is the one to read.')+'</span></div><div class="table-scroll"><table class="session-table heatmap task-runs"><thead><tr><th>'+label('TASK')+'</th>'+runs.map(r=>'<th title="'+e(r.run+' · '+when(r.startedAt))+'">'+e(r.startedAt.slice(5,10))+'</th>').join('')+'</tr></thead><tbody>'
  +sel.tasks.map(task=>'<tr><td data-verbatim>'+e(task.task)+'</td>'+runs.map(r=>{const cell=task.runs.find(c=>c.run===r.run); if(!cell)return '<td class="muted">·</td>'; if(cell.baseline!=='valid'&&cell.baseline!=='not_needed')return '<td class="heat not-measured" title="'+e(t('Not measured: the check passed before any change or could not run, or the run ended first.'))+'">—</td>'; const rate=passOf(cell); return '<td class="heat" style="'+heat(rate)+'" title="'+e(r.run+': '+(rate==null?'—':Math.round(rate*100)+'% ('+cell.passed+'/'+cell.planned+')'))+'">'+(rate==null?'—':pct(rate))+'</td>';}).join('')+'</tr>').join('')
  +'</tbody></table></div></section>';
}
function latestPanel(sel){
 const table=sel.latest.table, run=sel.runs[0];
 const parts=[['passed','Passed'],['failed','Failed'],['error','Error'],['unscored','Unscored'],['not_run','Not run']];
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Last run')+' <span class="tag" data-verbatim>'+e(sel.latest.run)+'</span></h2><button class="link" data-run="'+e(sel.latest.run)+'" data-run-source="'+e(sel.latest.source)+'">'+label('Open the run')+' ↗</button></div><div class="latest">'
  +table.results.map((r,i)=>{const usage=table.usage[i], idx=sel.arms.findIndex(a=>a.arm===r.arm&&a.isCurrent); return '<div class="latest-arm"><div class="arm-label">'+armName(sel.arms[idx]||{arm:r.arm,tool:r.tool,model:r.model,effort:r.effort},idx<0?i:idx)+'</div><div class="stack" role="img" aria-label="'+e(parts.map(([key,name])=>t(name)+' '+r.counts[key]).join(', '))+'">'+parts.map(([key,name])=>r.counts[key]?'<span class="seg '+key+'" style="flex:'+r.counts[key]+'" title="'+e(t(name)+': '+r.counts[key])+'">'+number(r.counts[key])+'</span>':'').join('')+'</div><div class="latest-usage"><b>'+rateCell(r.passRate)+'</b><small><span title="'+e(usedBy(usage.tokens.used))+'">'+(usage.tokens.value==null?'—':number(Math.round(usage.tokens.value)))+' '+label('tokens')+'</span> · <span title="'+e(usedBy(usage.durationMs.used))+'">'+secondsText(usage.durationMs.value)+'</span> · <span title="'+e(usedBy(usage.cost.used||0))+'">'+costText(usage.cost)+'</span></small>'+(r.deviations||r.notVerified||r.stoppedByLimit?'<small>'+(r.deviations?'<span class="amber">'+number(r.deviations)+' '+label('deviations')+'</span> ':'')+(r.notVerified?'<span class="muted">'+number(r.notVerified)+' '+label('not verified')+'</span> ':'')+(r.stoppedByLimit?'<span class="muted">'+number(r.stoppedByLimit)+' '+label('stopped by a limit')+'</span>':'')+'</small>':'')+'</div></div>';}).join('')
  +'<div class="legend">'+parts.map(([key,name])=>'<span><i class="swatch seg '+key+'"></i>'+label(name)+'</span>').join('')+'</div>'
  +(table.invalid.length?'<p class="scorer-hint amber">'+label('Not measured in this run')+': '+table.invalid.map(x=>'<span data-verbatim>'+e(x.task)+'</span> ('+(x.baseline==='invalid'?label('check passes without changes'):label('check could not run'))+')').join(', ')+'</p>':'')
  +'</div><p class="scorer-hint">'+label('Started')+' '+e(when(run.startedAt))+(run.username?' · <span data-verbatim>'+e(run.username)+'</span>':'')+' · '+label('These results hold for these tasks, this run and this machine.')+'</p></section>';
}
function runsPanel(sel){
 const arms=sel.arms.filter(a=>a.isCurrent), heads=['STARTED','MEMBER','FROM','SUITE VERSION','TEAM REVISION','PASS RATE'];
 const names=heads.map(t).concat(arms.map(a=>a.arm));
 return '<section class="panel sessions bench-panel"><div class="panelhead"><h2>'+label('Runs')+' <span class="count">'+number(sel.runs.length)+'</span></h2><span class="label">'+label('Newest first. A team revision marked changed installed other team assets than the run before it.')+'</span></div><div class="table-scroll"><table class="session-table bench-cards"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+arms.map(a=>'<th title="'+e(armTitle(a))+'"><div class="arm-label">'+swatch(sel.arms.indexOf(a))+'<span data-verbatim>'+e(a.arm)+'</span></div></th>').join('')+'</tr></thead><tbody>'
  +sel.runs.map((r,i)=>{const older=sel.runs[i+1], current=r.sourceHash===sel.versions[0].sourceHash; return cardRow('',names,[
   '<button class="link" data-run="'+e(r.run)+'" data-run-source="'+e(r.source)+'">'+e(when(r.startedAt))+' ↗</button><small data-verbatim>'+e(r.run)+'</small>',
   '<span data-verbatim>'+e(r.username||'—')+'</span>',
   r.source==='local'?label('This machine'):label('Team'),
   '<span title="'+e(r.sourceHash)+'" data-verbatim>'+short(r.sourceHash)+'</span>'+(current?' <span class="tag">'+label('current')+'</span>':''),
   '<span title="'+e(r.teamRevision)+'" data-verbatim>'+short(r.teamRevision)+'</span>'+(older&&older.teamRevision!==r.teamRevision?' <span class="tag amber">'+label('changed')+'</span>':''),
   meter(passOf(r))+' '+rateCell(r)+(r.unmeasuredTasks?'<small class="amber">'+number(r.unmeasuredTasks)+' '+label('not measured')+'</small>':''),
  ].concat(arms.map(a=>rateCell(r.arms.find(c=>c.key===a.key)))));}).join('')
  +'</tbody></table></div></section>';
}
const BENCH_VIEWS=[['arms','Arms'],['compare','Compare'],['team','Team changes']];
const DIMENSIONS=[['team','Team assets'],['tool','Tool'],['model','Model'],['workflow','Workflow']];
const pp=v=>{const n=Math.round(v*100); return (n>0?'+':n<0?'−':'')+number(Math.abs(n))+' pp';};
const costNumber=v=>String(Number(v.toPrecision(2)));
const seriesBy=(sel,key)=>sel.arms.find(a=>a.key===key);
const comparisonId=c=>c.from+'>'+c.to;
const diffClass=d=>d.low>0?'up':d.high<0?'down':'amber';
function sideName(sel,key,dimension){
 const a=seriesBy(sel,key); if(!a)return '?';
 return dimension==='team'?teamText(a.team):dimension==='tool'?a.tool:dimension==='workflow'?(a.workflow||t('one prompt')):a.model?a.model+(a.effort?' '+a.effort:''):t('tool default');
}
function facetOf(sel,c){
 const a=seriesBy(sel,c.from); if(!a)return '';
 return [c.dimension!=='tool'?a.tool:'',c.dimension!=='model'&&a.model?a.model+(a.effort?' '+a.effort:''):'',c.dimension!=='team'&&a.team.kind!=='pulled'?teamText(a.team):'',c.dimension!=='workflow'&&a.workflow?a.workflow:''].filter(Boolean).join(' · ');
}
function benchTabs(sel){
 const counts={compare:sel.comparisons.length,team:sel.teamChanges.revisions.length};
 return '<div class="bench-tabs" role="tablist" aria-label="'+e(t('Benchmark views'))+'">'+BENCH_VIEWS.map(([key,name])=>'<button role="tab" class="bench-tab'+(benchView===key?' active':'')+'" data-bench-view="'+key+'" aria-selected="'+(benchView===key)+'">'+label(name)+(counts[key]?' <span class="count">'+number(counts[key])+'</span>':'')+'</button>').join('')+'</div>';
}
function emptyView(title,text,example,after){
 return '<section class="panel"><div class="empty bench-empty"><h2>'+label(title)+'</h2><p>'+label(text)+'</p><pre class="command" data-verbatim>'+e(example)+'</pre>'+(after?'<p class="label">'+label(after)+'</p>':'')+'</div></section>';
}
function comparePanel(sel){
 if(!sel.comparisons.length)return emptyView('No two arms of this suite differ in one thing only','Compare puts two arms side by side, trial by trial, when they differ only in the team assets, the tool or the model. Cross them with a matrix, such as each tool with and without the team\\'s assets:','matrix:\\n  tool: [claude, codex]\\n  team: [pulled, none]','Each arm of a matrix differs from its neighbours in one value, so every difference here has one cause.');
 const dims=DIMENSIONS.filter(([key])=>sel.comparisons.some(c=>c.dimension===key));
 const dim=dims.some(([key])=>key===benchDimension)?benchDimension:dims[0][0];
 const list=sel.comparisons.filter(c=>c.dimension===dim);
 const chosen=list.find(c=>comparisonId(c)===benchComparison)||list[0];
 const chips='<div class="chips" role="group" aria-label="'+e(t('Compare by'))+'">'+dims.map(([key,name])=>'<button class="chip'+(dim===key?' active':'')+'" data-bench-dimension="'+key+'" aria-pressed="'+(dim===key)+'">'+label(name)+'</button>').join('')+'</div>';
 return '<div class="bench-compare-head"><span class="label">'+label('Compare by')+'</span>'+chips+'</div>'+compareKpis(sel,chosen)+'<div class="bench-grid">'+forestPanel(sel,list,chosen)+arrowPanel(sel,list,chosen)+'</div>'+taskDeltaPanel(sel,chosen);
}
function compareKpis(sel,c){
 const d=c.difference, sides=['from','to'];
 const up=c.tasks.filter(x=>passOf(x.to)>passOf(x.from)).length, down=c.tasks.filter(x=>passOf(x.to)<passOf(x.from)).length;
 const unit=usageUnit(sides.map(side=>c.usage[side]));
 const costs=unit?sides.map(side=>c.rates[side].passed>0?c.usage[side].cost.amount/c.rates[side].passed:null):[null,null], hasCost=costs.every(v=>v!=null)&&costs[0]>0;
 const tokens=sides.map(side=>usageAt(c.usage[side],'tokens')), hasTokens=tokens.every(v=>v!=null&&v>0);
 const change=(a,b)=>(b>=a?'+':'−')+number(Math.abs(Math.round((b/a-1)*100)))+'%';
 const third=hasCost?kpiCard(label('Cost per passed trial'),'<span class="'+(costs[1]<=costs[0]?'up':'down')+'">'+change(costs[0],costs[1])+'</span>',e(costNumber(costs[0])+' → '+costNumber(costs[1])+' '+unit))
  :kpiCard(label('Median tokens per trial'),hasTokens?change(tokens[0],tokens[1]):'—',hasTokens?number(Math.round(tokens[0]))+' → '+number(Math.round(tokens[1])):label('Not every arm reported it'));
 return '<div class="kpis bench-kpis">'
  +kpiCard('<span><span data-verbatim>'+e(sideName(sel,c.to,c.dimension))+'</span> '+label('against')+' <span data-verbatim>'+e(sideName(sel,c.from,c.dimension))+'</span></span>','<span class="'+diffClass(d)+'">'+pp(d.value)+'</span>','95% '+pp(d.low)+' '+label('to')+' '+pp(d.high)+(diffClass(d)==='amber'?' · <b class="amber">'+label('not separated')+'</b>':''))
  +kpiCard(label('Pass rate'),pct(passOf(c.rates.from))+' → '+pct(passOf(c.rates.to)),number(c.pairs)+' '+label('paired trials'))
  +third
  +kpiCard(label('Tasks'),number(up)+' <span class="up">↑</span> · '+number(down)+' <span class="down">↓</span> · '+number(c.tasks.length-up-down)+' =',label('pass rate on each task, against the arm it is measured from'))
  +'</div>';
}
function forestPanel(sel,list,chosen){
 const at=v=>((v+1)/2*100).toFixed(1)+'%';
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Difference per pair of arms')+'</h2><span class="label">'+label('Two arms that differ only in this, trial by trial. The line is the 95% interval of the difference: one that crosses the middle does not tell them apart.')+'</span></div><div class="forest">'
  +'<div class="forest-row forest-axis" aria-hidden="true"><span></span><span class="forest-scale"><small>−100</small><small>0</small><small>+100 pp</small></span><span></span></div>'
  +list.map(c=>{const d=c.difference, active=c===chosen, cls=diffClass(d); return '<button class="forest-row'+(active?' active':'')+'" data-bench-comparison="'+e(comparisonId(c))+'" aria-pressed="'+active+'" title="'+e(pp(d.value)+', 95% '+pp(d.low)+' – '+pp(d.high))+'"><span class="forest-label"><b data-verbatim>'+e(sideName(sel,c.from,c.dimension))+' → '+e(sideName(sel,c.to,c.dimension))+'</b><small data-verbatim>'+e(facetOf(sel,c))+'</small></span><span class="forest-track"><i class="forest-zero"></i><i class="forest-ci '+cls+'" style="left:'+at(d.low)+';width:'+((d.high-d.low)/2*100).toFixed(1)+'%"></i><i class="forest-dot '+cls+'" style="left:'+at(d.value)+'"></i></span><span class="forest-value '+cls+'"><b>'+pp(d.value)+'</b><small>'+number(c.pairs)+' '+label('pairs')+'</small></span></button>';}).join('')
  +'</div></section>';
}
function arrowPanel(sel,list,chosen){
 const unit=usageUnit(list.flatMap(c=>[c.usage.from,c.usage.to])), axis=benchAxis==='cost'&&!unit?'tokens':benchAxis;
 const head='<div class="panelhead"><h2>'+label('Pass rate against cost, from one arm to the other')+'</h2>'+axisToggle(axis,unit)+'</div>';
 const placed=list.map(c=>({c,fx:usageAt(c.usage.from,axis),tx:usageAt(c.usage.to,axis),fy:passOf(c.rates.from),ty:passOf(c.rates.to)})).filter(q=>q.fx!=null&&q.tx!=null);
 if(!placed.length)return '<section class="panel bench-panel">'+head+'<div class="empty"><p>'+label('No arm reported this value.')+'</p></div></section>';
 const W=chartWidth(),H=300,pl=44,pr=20,pt=20,pb=46,pw=W-pl-pr,ph=H-pt-pb, max=Math.max(...placed.flatMap(q=>[q.fx,q.tx]))*1.15||1;
 const x=v=>pl+v/max*pw, y=r=>pt+(1-r)*ph;
 const svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+e(t('Pass rate against cost, from one arm to the other'))+'"><defs>'+[['up','green'],['down','error'],['amber','amber']].map(([cls,color])=>'<marker id="bench-arrow-'+cls+'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" style="fill:var(--'+color+')"/></marker>').join('')+'</defs>'
  +usageGrid({W,H,pl,pr,pb,pw,x,y,max,axis,unit})
  +placed.map(q=>{const active=q.c===chosen, x1=x(q.fx), y1=y(q.fy), x2=x(q.tx), y2=y(q.ty), len=Math.hypot(x2-x1,y2-y1)||1, k=Math.max(0,(len-9)/len), flip=x2>W*0.7;
   return '<g class="arrow'+(active?' active':'')+'" data-bench-comparison="'+e(comparisonId(q.c))+'"><title>'+e(sideName(sel,q.c.from,q.c.dimension)+' → '+sideName(sel,q.c.to,q.c.dimension)+' · '+facetOf(sel,q.c)+': '+Math.round(q.fy*100)+'% → '+Math.round(q.ty*100)+'%')+'</title><line class="'+diffClass(q.c.difference)+'" x1="'+x1.toFixed(1)+'" y1="'+y1.toFixed(1)+'" x2="'+(x1+(x2-x1)*k).toFixed(1)+'" y2="'+(y1+(y2-y1)*k).toFixed(1)+'" marker-end="url(#bench-arrow-'+diffClass(q.c.difference)+')"/><circle class="from" cx="'+x1.toFixed(1)+'" cy="'+y1.toFixed(1)+'" r="5"/><circle class="to" cx="'+x2.toFixed(1)+'" cy="'+y2.toFixed(1)+'" r="6"/>'+(active?'<text class="point-label" x="'+(flip?x2-10:x2+10)+'" y="'+(y2+4)+'"'+(flip?' text-anchor="end"':'')+'>'+e(facetOf(sel,q.c)||sideName(sel,q.c.to,q.c.dimension))+'</text>':'')+'</g>';}).join('')
  +'</svg>';
 return '<section class="panel bench-panel">'+head+'<div class="chart-scroll">'+svg+'</div><p class="scorer-hint">'+label('Hollow: the arm the difference is measured from. Filled: the other. An arrow up and to the left passes more for less.')+'</p></section>';
}
function taskDeltaPanel(sel,c){
 const rows=c.tasks.map(x=>({x,f:passOf(x.from),to:passOf(x.to)}));
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Each task')+' · <span data-verbatim>'+e(sideName(sel,c.from,c.dimension))+' → '+e(sideName(sel,c.to,c.dimension))+'</span></h2><span class="label">'+label('Hollow: the arm the difference is measured from. Green where the task passed more often, red where less.')+'</span></div><div class="dumbbells">'
  +rows.map(r=>{const lo=Math.min(r.f,r.to), hi=Math.max(r.f,r.to), cls=r.to>r.f?'up':r.to<r.f?'down':'same'; return '<div class="dumbbell"><span class="dumbbell-task" data-verbatim>'+e(r.x.task)+'</span><span class="dumbbell-track"><i class="dumbbell-line '+cls+'" style="left:'+(lo*100).toFixed(1)+'%;width:'+((hi-lo)*100).toFixed(1)+'%"></i><i class="dumbbell-from" style="left:'+(r.f*100).toFixed(1)+'%"></i><i class="dumbbell-to '+cls+'" style="left:'+(r.to*100).toFixed(1)+'%"></i></span><span class="dumbbell-value '+cls+'"><b>'+pp(r.to-r.f)+'</b><small>'+number(r.x.from.passed)+'/'+number(r.x.from.planned)+' → '+number(r.x.to.passed)+'/'+number(r.x.to.planned)+'</small></span></div>';}).join('')
  +'<div class="dumbbell dumbbell-axis" aria-hidden="true"><span></span><span class="forest-scale"><small>0%</small><small>50%</small><small>100%</small></span><span></span></div></div></section>';
}
const configName=c=>c.tool+(c.model?' · '+c.model:'')+(c.effort?' · '+c.effort:'')+(c.workflow?' · '+c.workflow:'');
function teamPanel(sel){
 const tc=sel.teamChanges;
 if(!tc.revisions.length)return emptyView('No tool and model ran on two team revisions yet','Team changes follows one tool and model across the team revisions it ran on, so you see what a change to the team\\'s skills, rules or agents did. Add an arm on another revision of the team repo:','arms:\\n  - name: team          # the revision you pulled\\n  - name: main\\n    team: main          # a branch, tag or commit of the team repo','Or run the suite again after each change to the team repo: each run installs the revision you pulled.');
 const config=tc.configs.find(c=>c.key===benchConfig)||tc.configs[0];
 const points=tc.revisions.flatMap(r=>{const c=r.configs.find(x=>x.key===config.key); return c?[{r,c}]:[];});
 const chosen=points.find(q=>q.r.revision===benchRevision)||points[points.length-1];
 const chips=tc.configs.length>1?'<div class="chips" role="group" aria-label="'+e(t('Tool and model'))+'">'+tc.configs.map(c=>'<button class="chip'+(c===config?' active':'')+'" data-bench-config="'+e(c.key)+'" aria-pressed="'+(c===config)+'" data-verbatim>'+e(configName(c))+'</button>').join('')+'</div>':'<span class="tag" data-verbatim>'+e(configName(config))+'</span>';
 return '<div class="bench-compare-head"><span class="label">'+label('Tool and model')+'</span>'+chips+'</div>'+revisionChart(points,chosen)+revisionDetail(points,chosen);
}
const separatedFrom=(q,prev)=>prev&&(q.c.high<prev.c.low?'down':q.c.low>prev.c.high?'up':'');
function revisionChart(points,chosen){
 const W=window.innerWidth>=1300?1100:chartWidth(),H=300,pl=40,pr=24,pt=34,pb=64,pw=W-pl-pr,ph=H-pt-pb;
 const inset=Math.min(90,pw/6), x=i=>pl+(points.length<2?pw/2:inset+i*(pw-2*inset)/(points.length-1)), y=r=>pt+(1-r)*ph, commits=benchData.teamCommits||{};
 const every=Math.max(1,Math.ceil(points.length/(W<500?3:7)));
 let svg='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+e(t('Pass rate per team revision'))+'">'
  +[0,0.25,0.5,0.75,1].map(v=>'<line class="grid" x1="'+pl+'" x2="'+(W-pr)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="axis" x="'+(pl-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+Math.round(v*100)+'%</text>').join('');
 if(points.length>1)svg+='<polyline class="series" style="stroke:var(--arm1)" points="'+points.map((q,i)=>x(i).toFixed(1)+','+y(passOf(q.c)).toFixed(1)).join(' ')+'"/>';
 svg+=points.map((q,i)=>{const sep=separatedFrom(q,points[i-1]), commit=commits[q.r.revision], rate=passOf(q.c), active=q===chosen, cx=x(i).toFixed(1);
  const subject=commit?(commit.subject.length>26?commit.subject.slice(0,25)+'…':commit.subject):'';
  return '<g class="revision'+(active?' active':'')+(sep?' '+sep:'')+'" data-bench-revision="'+e(q.r.revision)+'"><title>'+e(short(q.r.revision)+(commit?' · '+commit.subject:'')+': '+Math.round(rate*100)+'% ('+q.c.passed+'/'+q.c.planned+'), 95% '+Math.round(q.c.low*100)+'–'+Math.round(q.c.high*100)+'% · '+q.c.runs+' '+t('runs'))+'</title>'
   +'<rect class="hit" x="'+(x(i)-18).toFixed(1)+'" y="'+pt+'" width="36" height="'+(ph+pb-8)+'"/>'
   +'<line class="ci" x1="'+cx+'" x2="'+cx+'" y1="'+y(q.c.low).toFixed(1)+'" y2="'+y(q.c.high).toFixed(1)+'"/><circle class="point" cx="'+cx+'" cy="'+y(rate).toFixed(1)+'" r="'+(active?7:5.5)+'"/>'
   +'<text class="rate" x="'+cx+'" y="'+(y(q.c.high)-8).toFixed(1)+'" text-anchor="middle">'+Math.round(rate*100)+'%'+(sep==='down'?' ↓':sep==='up'?' ↑':'')+'</text>'
   +(i%every===0||i===points.length-1||active?'<text class="axis" x="'+cx+'" y="'+(H-pb+18)+'" text-anchor="middle" data-verbatim>'+short(q.r.revision)+'</text>'+(subject&&W>=500?'<text class="axis-name" x="'+cx+'" y="'+(H-pb+33)+'" text-anchor="middle">'+e(subject)+'</text>':'')+'<text class="axis" x="'+cx+'" y="'+(H-pb+(W>=500?48:33))+'" text-anchor="middle">'+e((commit?commit.committedAt:q.r.firstRunAt).slice(5,10))+'</text>':'')
   +'</g>';}).join('');
 svg+='</svg>';
 return '<section class="panel bench-panel"><div class="panelhead"><h2>'+label('Pass rate per team revision')+'</h2><span class="label">'+label('Each point pools the runs on one team revision, in commit order. The line is the 95% interval; ↓ or ↑ marks a revision told apart from the one before it. Click one to see what changed.')+'</span></div><div class="chart-scroll">'+svg+'</div></section>';
}
function revisionDetail(points,q){
 const index=points.indexOf(q), prev=points[index-1], commit=(benchData.teamCommits||{})[q.r.revision], sep=separatedFrom(q,prev);
 const tasks=[...new Set([...(prev?prev.c.tasks:[]),...q.c.tasks].map(x=>x.task))];
 const heads=['TASK',prev?short(prev.r.revision):'',short(q.r.revision),'CHANGE'].filter(Boolean);
 const rows=tasks.map(task=>{const before=prev&&prev.c.tasks.find(x=>x.task===task), after=q.c.tasks.find(x=>x.task===task), delta=before&&after?passOf(after)-passOf(before):null;
  return cardRow('',heads.map(h=>h===heads[0]||h==='CHANGE'?t(h):h),['<span data-verbatim>'+e(task)+'</span>',...(prev?[rateCell(before)]:[]),rateCell(after),delta==null?'—':'<span class="'+(delta>0?'up':delta<0?'down':'')+'">'+pp(delta)+'</span>']);}).join('');
 const diff=prev?(benchData.teamDiffs||{})[prev.r.revision+'..'+q.r.revision]:undefined;
 const changes=diff?'<ul class="changed-files">'+diff.files.map(f=>'<li><code data-verbatim>'+e(f.path)+'</code><small><span class="up">+'+number(f.added)+'</span> <span class="down">−'+number(f.removed)+'</span></small></li>').join('')+(diff.more?'<li class="muted">'+label('and')+' '+number(diff.more)+' '+label('more files')+'</li>':'')+(diff.files.length?'':'<li class="muted">'+label('No file outside benchmarks/ changed.')+'</li>')+'</ul>'
  :'<p class="muted">'+(prev?label('This machine\\'s team clone lacks one of the two revisions, so it cannot list what changed.'):label('The first team revision in the window.'))+'</p>';
 return '<section class="panel bench-panel"><div class="panelhead"><h2><span data-verbatim>'+short(q.r.revision)+'</span>'+(commit?' · <span data-verbatim>'+e(commit.subject)+'</span>':'')+(prev?' <span class="label">'+label('against')+' <span data-verbatim>'+short(prev.r.revision)+'</span></span>':'')+'</h2>'+(sep?'<span class="tag '+(sep==='down'?'down':'up')+'">'+label(sep==='down'?'told apart: lower':'told apart: higher')+'</span>':'')+'</div><h3 class="caption">'+label('Team files changed')+'</h3>'+changes+'<div class="table-scroll"><table class="session-table bench-cards"><thead><tr>'+heads.map(h=>'<th'+(h===heads[0]||h==='CHANGE'?'':' data-verbatim')+'>'+(h===heads[0]||h==='CHANGE'?label(h):e(h))+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div></section>';
}
function benchmarksPage(){
 if(page==='benchmarks'&&!benchData&&!benchLoading&&!benchError)loadBenchmarks();
 if(benchError&&!benchData)return errorPanel(benchError,'benchmarks');
 if(!benchData)return '<div class="empty" role="status">'+label('Loading benchmark runs…')+'</div>';
 if(!benchData.configured)return '<section class="panel"><div class="empty"><h2>'+label('No TeamAI scope in this workspace')+'</h2><p>'+label('Pick a project workspace above, or set one up with teamai init.')+'</p></div></section>';
 const w=benchData.window, sel=benchData.selected;
 const controls='<form class="scorer-controls" onsubmit="return false"><label>'+label('Window')+'<select id="bench-window">'+benchWindows.map(x=>'<option value="'+x+'"'+(benchQuery.window===x?' selected':'')+'>'+number(Number(x))+' '+label('days')+'</option>').join('')+'</select></label></form>';
 if(!benchData.suites.length)return controls+'<section class="panel"><div class="empty bench-empty"><h2>'+label('No benchmark runs in this window')+'</h2><p>'+label('A benchmark gives your team\\'s own tasks to several tools, models or team revisions, checks each result, and shows here once it ends, from this machine or from teamai-reports. Run one in CI or a container:')+'</p><code class="command" data-verbatim>teamai benchmark run fix-auth --sandbox</code><p class="label">'+label('Then compare its arms, follow each task across runs, and see what a change to the team\\'s skills did.')+'</p></div></section>';
 return (benchError?'<div class="error-panel" role="alert"><p>'+e(benchError)+'</p></div>':'')
  +'<div class="statusline"><span>'+label('Window')+': '+e(when(w.from))+' – '+e(when(w.to))+'</span><span>'+label('Runs by when they started.')+'</span></div>'
  +controls+suitesPanel(benchData)
  +(sel?'<h2 class="section-label"><span data-verbatim>'+e(sel.suite)+'</span> <span class="tag" title="'+e(sel.versions[0].sourceHash)+'">'+label('suite version')+' <span data-verbatim>'+short(sel.versions[0].sourceHash)+'</span></span>'+(sel.versions.length>1?' <span class="tag">'+number(sel.versions.length)+' '+label('versions in the window')+'</span>':'')+'</h2>'
   +benchTabs(sel)+(benchView==='compare'?comparePanel(sel):benchView==='team'?teamPanel(sel):benchKpis(sel)+'<div class="bench-grid">'+armBars(sel)+scatterPanel(sel)+'</div>'+historyChart(sel)+heatmapPanel(sel)+taskRunsPanel(sel)+latestPanel(sel)+runsPanel(sel)):'');
}
async function loadBenchmarks(){
 const generation=workspaceGeneration, request=++benchRequest, current=()=>generation===workspaceGeneration&&request===benchRequest; benchLoading=true;
 const params={window:benchQuery.window}; if(benchQuery.suite)params.suite=benchQuery.suite;
 try{
  const response=await fetch(apiQuery('/api/benchmarks',params),{signal:AbortSignal.timeout(30000)});
  const data=await response.json().catch(()=>null);
  if(!current())return;
  if(!response.ok)benchError=data&&data.error?data.error:t('Could not load benchmark runs.');
  else{benchData=data;benchError='';if(data.selected)benchQuery.suite=data.selected.suite;}
 }catch{if(current())benchError=t('Could not load benchmark runs.');}
 finally{if(current()){benchLoading=false;if(page==='benchmarks'){const html=benchmarksPage();if(html!==benchHtml){benchHtml=html;render();}}}}
}
function setBenchQuery(changes){ if(changes.suite!==undefined&&changes.suite!==benchQuery.suite)resetSelection(); benchQuery={...benchQuery,...changes}; save('teamai-dashboard-benchmark-window',benchQuery.window); loadBenchmarks(); }
document.addEventListener('change',event=>{ if(event.target.id==='bench-window')setBenchQuery({window:event.target.value}); });
document.addEventListener('click',event=>{
 const suite=event.target.closest('[data-bench-suite]'), axis=event.target.closest('[data-bench-axis]'), view=event.target.closest('[data-bench-view]');
 const dimension=event.target.closest('[data-bench-dimension]'), comparison=event.target.closest('[data-bench-comparison]'), config=event.target.closest('[data-bench-config]'), revision=event.target.closest('[data-bench-revision]');
 const rerender=()=>{if(page==='benchmarks')render();};
 if(suite)setBenchQuery({suite:suite.dataset.benchSuite});
 else if(axis&&!axis.disabled){benchAxis=axis.dataset.benchAxis;rerender();}
 else if(view){benchView=view.dataset.benchView;save('teamai-dashboard-benchmark-view',benchView);rerender();}
 else if(dimension){benchDimension=dimension.dataset.benchDimension;benchComparison='';rerender();}
 else if(comparison){benchComparison=comparison.dataset.benchComparison;rerender();}
 else if(config){benchConfig=config.dataset.benchConfig;benchRevision='';rerender();}
 else if(revision){benchRevision=revision.dataset.benchRevision;rerender();}
});
`;

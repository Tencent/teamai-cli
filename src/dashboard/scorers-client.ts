/**
 * The Scorers page of the dashboard client (#1182), embedded in `dashboardClient`'s closure, whose helpers it uses:
 * `$`, `e`, `t`, `label`, `number`, `when`, `json`, `read`, `save`, `apiQuery`, `errorPanel`, `render`, `page`,
 * `workspaceGeneration`, `agentHarness`, `harnessPartsHtml`, `harnessLine` and `chartWidth`. Every value from the API is
 * escaped with `e`. A workflow row opens its run through the Workflow Runs dialog. Another page opens this one on a
 * group with `openScorers`. Grouped by role, a role links to the benchmark arms that ran with it, from
 * `/api/benchmarks` in the Benchmarks page's window (`benchQuery`), and opens one with `openBenchmarks`.
 */
import type { Decider } from '../scorers/label.js';
import { DIMENSIONS_OFFERED, FAILING_MAX, FAILING_PAGE, SCORER_WINDOWS, type Dimension } from '../scorers/results.js';

/** The name the page gives each dimension, in English; `label` translates it. */
const DIMENSION_NAMES: Record<Dimension, string> = {
  tool: 'Tool',
  model: 'Model',
  teamRevision: 'Team revision',
  definition: 'Agent definition',
  role: 'Role',
  project: 'Project',
  tag: 'Tag',
  fingerprint: 'Fingerprint',
  skill: 'Skill used',
  decidedBy: 'Decided by',
};

/** The name the page gives each stage that decides a workflow label (#1247), and a hand label, in English; `label` translates it. */
const DECIDER_NAMES: Record<Decider | 'hand' | 'not recorded', string> = {
  check: 'Scorer check',
  ci: 'Pull request CI',
  protected: 'Protected paths',
  judge: 'Judge',
  hand: 'Hand label',
  'not recorded': 'Not recorded',
};

export const scorersClient = `
let scorerData=null, scorerError='', scorerLoading=false, scorerHtml='', scorerRequest=0, scorerCommitDraft='', scorerReveal='', scorerArms=null;
const failingPage=${FAILING_PAGE}, failingMax=${FAILING_MAX};
const scorerWindows=${JSON.stringify(SCORER_WINDOWS.map(String))};
const scorerDimensions=${JSON.stringify(Object.fromEntries(DIMENSIONS_OFFERED.map((dimension) => [dimension, DIMENSION_NAMES[dimension]])))};
const deciderNames=${JSON.stringify(DECIDER_NAMES)};
const deciderText=by=>'<span class="decider decider-'+e(by.replace(' ','-'))+'">'+label(deciderNames[by]||by)+'</span>';
const savedWindow=read('teamai-dashboard-scorer-window','30'), savedGroup=read('teamai-dashboard-scorer-group','');
let scorerQuery={window:scorerWindows.includes(savedWindow)?savedWindow:'30',scorer:'',cohort:'',groupBy:Object.hasOwn(scorerDimensions,savedGroup)?savedGroup:'',commit:'',group:'',failing:''};
function resetScorers(){scorerCommitDraft='';scorerArms=null;scorerData=null;scorerError='';scorerLoading=false;scorerHtml='';scorerQuery={...scorerQuery,scorer:'',cohort:'',commit:'',group:'',failing:''};}
const pct=rate=>rate==null?'—':number(Math.round(rate*100))+'%';
const short=hash=>e(String(hash||'').slice(0,7));
function judgeText(j){ if(j.kind==='human')return label('Hand label'); if(j.kind==='stage')return label('Decided by a stage'); return '<span data-verbatim>'+e(j.tool)+'</span> / '+(j.model?'<span data-verbatim>'+e(j.model.id)+'</span>'+(j.model.isReported?'':' <small>'+label('requested')+'</small>')+(j.model.alias?' <small data-verbatim>'+e(j.model.alias)+'</small>':''):label('model not recorded')); }
function runModeText(mode){ return mode==='attended'?label('Attended'):mode==='unattended'?label('Unattended'):label('Not recorded'); }
function rubricText(c){ return label('Rubric')+' <span title="'+e(c.rubric.sourceHash)+'" data-verbatim>'+short(c.rubric.sourceHash)+'</span>'+(c.rubric.teamRevision?' · '+label('Team revision')+' <span title="'+e(c.rubric.teamRevision)+'" data-verbatim>'+short(c.rubric.teamRevision)+'</span>':' · <span class="amber">'+label('No team revision')+'</span>'); }
function cohortText(c){ return rubricText(c)+' · '+(c.source==='session'?label('Session labels'):label('Workflow labels'))+' · '+runModeText(c.runMode)+' · '+judgeText(c.judge); }
function sparkline(weeks){
 if(!weeks||!weeks.length)return '';
 const w=Math.max(1,weeks.length-1), points=weeks.map((week,i)=>week.rate==null?null:(i/w*96+2).toFixed(1)+','+(26-week.rate*22).toFixed(1));
 const runs=[]; let current=[]; for(const p of points){ if(p===null){ if(current.length)runs.push(current); current=[]; } else current.push(p); } if(current.length)runs.push(current);
 return '<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">'+runs.map(run=>run.length===1?'<circle cx="'+run[0].split(',')[0]+'" cy="'+run[0].split(',')[1]+'" r="1.8"/>':'<polyline points="'+run.join(' ')+'"/>').join('')+'</svg>';
}
function trendChart(weeks){
 const width=chartWidth('trend',1100), height=120, slot=width/Math.max(1,weeks.length), bar=Math.min(64,slot*0.72), gap=slot-bar;
 const every=Math.max(1,Math.ceil(weeks.length/Math.max(2,Math.floor(width/76))));
 return '<div class="trend-chart"><svg data-chart="trend" viewBox="0 0 '+width+' '+(height+34)+'" role="img" aria-label="'+e(t('Weekly pass rate'))+'">'
  +[0,0.5,1].map(y=>'<line class="grid" x1="0" x2="'+width+'" y1="'+(10+(1-y)*height)+'" y2="'+(10+(1-y)*height)+'"/>').join('')
  +weeks.map((week,i)=>{const x=i*(bar+gap)+gap/2; const tip=e(week.week)+': '+(week.rate==null?e(t('No labels')):pct(week.rate)+' · '+number(week.passed)+'/'+number(week.n));
   const shape=week.rate==null?'<rect class="gap" x="'+x+'" y="10" width="'+bar+'" height="'+height+'" rx="3"/>':'<rect class="bar'+(week.rate<0.5?' low':'')+'" x="'+x+'" y="'+(10+(1-week.rate)*height)+'" width="'+bar+'" height="'+Math.max(2,week.rate*height)+'" rx="3"/><text x="'+(x+bar/2)+'" y="'+Math.max(9,4+(1-week.rate)*height)+'" class="value">'+pct(week.rate)+'</text>';
   return '<g><title>'+tip+'</title>'+shape+(i%every===0?'<text x="'+(x+bar/2)+'" y="'+(height+28)+'" class="axis">'+e(week.week.slice(5))+'</text>':'')+'</g>';}).join('')
  +'</svg><p class="label">'+label('Weeks start on Monday, UTC. A dashed week had no labels: it is a gap, not 0%.')+'</p></div>';
}
const kpiCard=(title, value, foot)=>'<article class="card kpi"><div class="cardtop">'+title+'</div><div class="big">'+value+'</div>'+(foot?'<div class="statusline">'+foot+'</div>':'')+'</article>';
function kpis(stats){
 return '<div class="kpis">'+kpiCard(label('Pass rate'),pct(stats.rate),number(stats.n)+' '+label(stats.n===1?'label':'labels'))+kpiCard(label('Passed'),'<span class="good">'+number(stats.passed)+'</span>')+kpiCard(label('Failed'),'<span class="amber">'+number(stats.failed)+'</span>')+'</div>';
}
function splitCards(split){
 const delta=split.after.rate!=null&&split.before.rate!=null?Math.round((split.after.rate-split.before.rate)*100):null;
 return '<h2 class="section-label" id="scorer-split" tabindex="-1">'+label('Before and after team commit')+' <span class="tag" title="'+e(split.commit)+'" data-verbatim>'+short(split.commit)+'</span></h2><div class="kpis">'
  +kpiCard(label('Before'),pct(split.before.rate),number(split.before.n)+' '+label(split.before.n===1?'label':'labels'))
  +kpiCard(label('After'),pct(split.after.rate),number(split.after.n)+' '+label(split.after.n===1?'label':'labels')+(delta===null?'':' · <b class="'+(delta>=0?'good':'amber')+'">'+(delta>=0?'+':'')+number(delta)+' '+label(Math.abs(delta)===1?'pt':'pts')+'</b>'))
  +kpiCard(label('Not recorded'),'<span class="muted">'+number(split.notRecorded.n)+'</span>',label('labels'))+'</div>'
  +'<p class="label">'+label('After means the team revision contains the commit, checked in this machine\\'s team clone. A label on a revision this clone does not have is not recorded.')+'</p>';
}
function cohortPicker(data, sel){
 const cohorts=data.scorers.find(s=>s.scorer===sel.cohort.scorer).cohorts, rubrics=[];
 for(const c of cohorts){ let r=rubrics.find(r=>r.hash===c.rubric.sourceHash); if(!r){r={hash:c.rubric.sourceHash,first:c,list:[]};rubrics.push(r);} r.list.push(c); }
 return '<div class="cohorts" role="group" aria-label="'+e(t('Measurements'))+'">'+rubrics.map(r=>'<div class="rubric-row"><span class="label">'+rubricText(r.first)+'</span><div class="chips">'
  +r.list.map(c=>'<button class="chip'+(c.id===sel.cohort.id?' active':'')+'" data-cohort="'+e(c.id)+'" aria-pressed="'+(c.id===sel.cohort.id)+'">'+(c.source==='session'?label('Session labels'):label('Workflow labels'))+' · '+runModeText(c.runMode)+' · '+judgeText(c.judge)+' <b>'+number(c.stats.n)+'</b></button>').join('')+'</div></div>').join('')+'</div>';
}
function meter(rate){ return '<span class="meter" aria-hidden="true"><span style="width:'+(rate==null?0:Math.round(rate*100))+'%"></span></span>'; }
function groupName(g){ if(g.kind==='none')return label('None'); if(g.kind==='not recorded')return '<span class="muted">'+label('Not recorded')+'</span>'; if(scorerData.selected.groupBy==='decidedBy')return deciderText(g.value); const long=['teamRevision','fingerprint'].includes(scorerData.selected.groupBy); return '<span data-verbatim title="'+e(g.value)+'">'+(long?short(g.value):e(g.value))+'</span>'+(g.isReported===false?' <small>'+label('requested')+'</small>':'')+(g.localChanges?' <small class="amber">'+label('local changes')+'</small>':'')+(g.roleOf?' <span class="role-of '+e(g.roleOf)+'">'+label(g.roleOf)+'</span>':''); }
/** The benchmark arms that ran with each role, in the Benchmarks page's window (\`benchQuery\`): what By Role links a role to. */
async function loadScorerArms(){
 const key=benchQuery.window, generation=workspaceGeneration, current=()=>generation===workspaceGeneration&&scorerArms&&scorerArms.key===key;
 scorerArms={key,state:'loading',arms:[]};
 try{
  const response=await fetch(apiQuery('/api/benchmarks',{window:key}),{signal:AbortSignal.timeout(30000)});
  const data=await response.json().catch(()=>null);
  if(current())scorerArms=response.ok&&data&&Array.isArray(data.roleArms)?{key,state:'ready',arms:data.roleArms}:{key,state:'error',arms:[]};
 }catch{if(current())scorerArms={key,state:'error',arms:[]};}
 finally{if(current()&&page==='scorers'){const html=scorersPage();if(html!==scorerHtml){scorerHtml=html;render();}}}
}
function roleArms(role){
 const arms=scorerArms?scorerArms.arms.filter(a=>a.role===role):[];
 return arms.length?'<div class="role-arms">'+label('Benchmark arms')+': '+arms.map(a=>'<button class="link" type="button" data-scorer-arm="'+e(JSON.stringify([a.suite,a.arm]))+'"><span data-verbatim>'+e(a.suite)+' · '+e(a.arm)+'</span> ↗</button>').join(' ')+'</div>':'';
}
function groupsPanel(sel){
 if(!sel.groups)return '';
 const byRole=sel.groupBy==='role';
 if(byRole&&page==='scorers'&&(!scorerArms||scorerArms.key!==benchQuery.window))loadScorerArms();
 const split=!!sel.split;
 const heads=['VALUE','LABELS','PASSED','FAILED','PASS RATE'].concat(split?['BEFORE','AFTER','NOT RECORDED']:[]);
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('By')+' '+label(scorerDimensions[sel.groupBy])+' <span class="count">'+number(sel.groups.length)+'</span></h2><span class="label">'+label('A label that lists two values counts under both. Select a row to list its failing labels.')+'</span></div><div class="table-scroll card-table"><table class="session-table scorer-groups"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +sel.groups.map(g=>'<tr class="'+(scorerQuery.group===g.key?'selected-row':'')+'">'+['<button class="link" data-scorer-group="'+e(g.key)+'" aria-pressed="'+(scorerQuery.group===g.key)+'"'+(scorerQuery.group===g.key?' id="scorer-selected-group"':'')+'>'+groupName(g)+'</button>'+(byRole&&g.kind==='value'?roleArms(g.value):''),number(g.stats.n),number(g.stats.passed),number(g.stats.failed),meter(g.stats.rate)+' '+pct(g.stats.rate)].concat(split?['before','after','notRecorded'].map(side=>pct(g.split[side].rate)+' <small>'+number(g.split[side].n)+'</small>'):[]).map((cell,i)=>'<td data-label="'+e(t(heads[i]))+'">'+cell+'</td>').join('')+'</tr>').join('')
  +'</tbody></table></div>'+(byRole&&scorerArms&&scorerArms.state==='error'?'<p class="scorer-hint muted">'+label('Could not load benchmark runs.')+'</p>':'')+'</section>';
}
function decidedPanel(sel){
 const d=sel.decided;
 if(!d)return '';
 const n=sel.cohort.stats.n, judged=d.rows.find(r=>r.by==='judge');
 const selected=key=>scorerQuery.groupBy==='decidedBy'&&scorerQuery.group===key;
 return '<section class="panel sessions decided"><div class="panelhead"><h2>'+label('What decided these labels')+'</h2><span class="label">'+label('A delivered pull request is decided by the first stage that fails it: the scorer check, the pull request CI, then the protected-path refusal. The judge only reads work every stage passed.')+'</span></div>'
  +'<div class="kpis">'+kpiCard(label('Decided before the judge'),pct(n?d.beforeJudge/n:null),number(d.beforeJudge)+' / '+number(n)+' '+label('labels')+' · '+label('no judge call'))
  +kpiCard(label('Judge pass rate'),pct(judged?judged.stats.rate:null),judged?number(judged.stats.n)+' '+label('labels reached the judge'):label('No label reached the judge'))+'</div>'
  +'<div class="table-scroll"><table class="session-table compact"><thead><tr>'+['DECIDED BY','LABELS','PASSED','FAILED','SHARE'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +d.rows.map(r=>'<tr class="'+(selected(r.key)?'selected-row':'')+'"><td><button class="link" data-decided="'+e(r.key)+'" aria-pressed="'+selected(r.key)+'">'+deciderText(r.by)+'</button></td><td>'+number(r.stats.n)+'</td><td>'+number(r.stats.passed)+'</td><td>'+number(r.stats.failed)+'</td><td>'+meter(n?r.stats.n/n:null)+' '+pct(n?r.stats.n/n:null)+'</td></tr>').join('')
  +'</tbody></table></div><p class="scorer-hint">'+label('Select a stage to list its failing labels. Many labels decided by CI or a check point at the work, not the rubric; fix those first.')+'</p></section>';
}
function valuesPanel(sel){
 if(!sel.cohort.values.length)return '';
 const n=sel.cohort.stats.n;
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Labels by value')+' <span class="count">'+number(sel.cohort.values.length)+'</span></h2><span class="label">'+label('Each value as the labels stored it, highest score first. Read precision or recall from these counts.')+'</span></div><div class="table-scroll"><table class="session-table compact"><thead><tr>'+['LABEL','SCORE','LABELS','SHARE'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +sel.cohort.values.map(v=>'<tr><td data-verbatim>'+e(v.label)+'</td><td>'+number(v.score)+'</td><td>'+number(v.n)+'</td><td>'+meter(n?v.n/n:null)+' '+pct(n?v.n/n:null)+'</td></tr>').join('')
  +'</tbody></table></div></section>';
}
function subjectCell(r){
 return r.run?(r.run.source?'<button class="link" data-run="'+e(r.run.id)+'" data-run-source="'+e(r.run.source)+'"><span data-verbatim>'+e(r.run.id)+'</span> ↗</button>':'<span data-verbatim>'+e(r.run.id)+'</span> <span class="muted">'+label('Run not found')+'</span>')+'<small data-verbatim>'+e(r.run.step)+' #'+e(r.run.pass)+'</small>'
  :(r.sessionName?'<code class="command" data-verbatim>teamai session resume '+e(r.sessionName)+' --platform '+e(r.platform)+'</code>':'<span class="muted">'+label('Not pushed to the team archive')+'</span>');
}
function agreementCell(a){
 if(!a||!a.paired)return '<span class="muted" title="'+e(t('No hand labels to compare with yet'))+'">—</span>';
 return meter(a.agree/a.paired)+' '+pct(a.agree/a.paired)+'<small>'+number(a.agree)+' / '+number(a.paired)+' '+label('paired')+'</small>';
}
const verdict=(value,passed)=>'<span class="label-value '+(passed?'good':'amber')+'" data-verbatim>'+e(value)+'</span> <small>'+(passed?label('passed'):label('failed'))+'</small>';
const sameJudge=(a,b)=>a.kind===b.kind&&(a.kind==='human'||a.kind==='stage'||(a.tool===b.tool&&(a.model?a.model.id:'')===(b.model?b.model.id:'')&&(a.model?a.model.isReported:true)===(b.model?b.model.isReported:true)));
function agreementPanel(sel){
 const a=sel.agreement, c=sel.cohort;
 if(c.source!=='session'&&!a.handLabelled)return '';
 const how='<p class="scorer-hint">'+label('Label the session you are in, or one a teammate pushed (from teamai session list):')+'</p><code class="command" data-verbatim>teamai score --scorer '+e(c.scorer)+' --label &lt;value&gt; --push\\nteamai score --team-session &lt;name&gt; --scorer '+e(c.scorer)+' --label &lt;value&gt; --push</code>';
 const head='<div class="panelhead"><h2>'+label('Judge agreement with hand labels')+' <span class="count">'+number(a.handLabelled)+' '+label(a.handLabelled===1?'hand-labelled session':'hand-labelled sessions')+'</span></h2><span class="label">'+label('Does the judge pass and fail the sessions members do?')+'</span></div>';
 if(!a.handLabelled)return '<section class="panel sessions agreement">'+head+'<div class="empty agreement-empty"><p>'+label('No hand label this rubric can pair with yet. A few hand labels show whether to trust this pass rate.')+'</p>'+how+'</div></section>';
 const rows=a.judges.map(j=>'<tr class="'+(sameJudge(j.judge,c.judge)?'selected-row':'')+'"><td class="judge">'+judgeText(j.judge)+'</td><td>'+number(j.labels)+'</td><td>'+number(j.paired)+'</td><td>'+number(j.agree)+'</td><td>'+(j.paired?meter(j.agree/j.paired)+' '+pct(j.agree/j.paired):'—')+'</td><td'+(j.judgePassedHumanFailed?' class="amber"':'')+'>'+number(j.judgePassedHumanFailed)+'</td><td'+(j.judgeFailedHumanPassed?' class="amber"':'')+'>'+number(j.judgeFailedHumanPassed)+'</td></tr>').join('')
  +'<tr><td>'+label('Hand label')+'</td><td>'+number(a.handLabelled)+'</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>';
 const off=a.disagreements;
 const list=off.length?'<h3 class="agreement-sub">'+label('Where they disagree')+' <span class="count">'+number(off.length)+'</span></h3><div class="table-scroll"><table class="session-table compact"><thead><tr>'+['HAND LABEL','BY','JUDGE SAID','JUDGE','SCORED','OPEN'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +off.map(d=>'<tr><td>'+verdict(d.hand.label,d.hand.passed)+'</td><td data-verbatim>'+e(d.hand.author)+'</td><td>'+verdict(d.judged.label,d.judged.passed)+'</td><td class="judge">'+judgeText(d.judge)+'</td><td>'+e(when(d.judged.scoredAt))+'</td><td>'+subjectCell(d)+'</td></tr>').join('')
  +'</tbody></table></div>':'';
 return '<section class="panel sessions agreement">'+head+'<div class="table-scroll"><table class="session-table compact"><thead><tr>'+['JUDGE','LABELS','PAIRED','AGREE','AGREEMENT','JUDGE PASSED, HUMAN FAILED','JUDGE FAILED, HUMAN PASSED'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>'
  +'<p class="scorer-hint">'+label('A judge label in the window pairs with the newest hand label of its session, whoever gave it and whenever, while this rubric lists its value. Judge passed, human failed: the judge is more lenient than members. Judge failed, human passed: it is stricter.')+'</p>'
  +list+how+'</section>';
}
function harnessCell(h){ return h?agentHarness(h):'<span class="harness muted">'+label('Harness not recorded')+'</span>'; }
function splitButton(revision){ return '<button class="link" type="button" data-scorer-split="'+e(revision)+'" title="'+e(t('Split at team commit')+' '+revision)+'" data-verbatim>'+short(revision)+'</button>'; }
function harnessFailures(byHarness){
 if(!byHarness||!byHarness.length)return '';
 return '<div class="harness-failures"><h3>'+label('Failures by harness')+'</h3><ul>'+byHarness.map(f=>'<li><b class="amber">'+number(f.failed)+' '+label('failing')+'</b> '
  +(f.harness?'<span class="harness">'+harnessLine(harnessPartsHtml(f.harness),f.harness.teamRevision?'<span class="harness-part">'+splitButton(f.harness.teamRevision)+'</span>':'')+'</span>':'<span class="harness muted">'+label('Harness not recorded')+'</span>')+'</li>').join('')+'</ul></div>';
}
function revisionChangeHint(change){
 return change?'<p class="scorer-hint revision-change">'+label('First failed at team revision')+' '+splitButton(change.firstFailed)+' · '+label('last passed on')+' <span title="'+e(change.lastPassed)+'" data-verbatim>'+short(change.lastPassed)+'</span></p>':'';
}
function regressionCell(r){
 if(r.task)return '<span class="tag good" data-verbatim title="'+e(r.task)+'">'+e(r.task.split('/').pop().replace(/\\.yaml$/,''))+'</span><small>'+label('Regression task')+'</small>';
 if(r.start&&r.start.commit)return '<span class="good">'+label('Can become a task')+'</span><small data-verbatim>'+e(r.start.commit.slice(0,7))+'</small>';
 return '<span class="muted">'+(r.start&&r.start.refused==='tracked_changes'?label('Started with uncommitted changes'):label('Start not recorded'))+'</span>';
}
function learningsCell(r){
 return r.learnings&&r.learnings.length?r.learnings.map(id=>'<span class="tag" data-verbatim title="'+e(id)+'">'+e(id.split('/').pop().replace(/-\\d{4}-\\d{2}-\\d{2}-[a-z0-9]+$/,''))+'</span>').join(' '):'—';
}
function improveHint(sel){
 const f=sel.failing;
 const counts='<span class="label">'+number(f.covered)+' '+label('with a regression task')+' · '+number(f.startable)+' '+label('can become one')+'</span>';
 return '<div class="improve-hint">'+counts+'<p class="scorer-hint">'+link('self-improvement','Turn them into a pull request that changes the team\\'s harness, and see what earlier ones proved')+'</p></div>';
}
function failingPanel(sel){
 const rows=sel.failing.labels, total=sel.failing.total, staged=!!sel.decided, heads=['SCORED','AUTHOR','LABEL'].concat(staged?['DECIDED BY']:[],['HARNESS','PLATFORM','SKILLS','REGRESSION','LEARNINGS','OPEN']), group=scorerQuery.group&&sel.groups?sel.groups.find(g=>g.key===scorerQuery.group):undefined;
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Failing labels')+(group?' · '+groupName(group):'')+' <span class="count">'+number(total)+'</span></h2>'+(scorerQuery.group?'<button class="link" data-scorer-group="">'+label('Show every group')+'</button>':'<span class="label">'+label('Newest first')+'</span>')+'</div>'
  +revisionChangeHint(sel.failing.revisionChange)+harnessFailures(sel.failing.byHarness)
  +(total?improveHint(sel):'')
  +(rows.length?'<div class="table-scroll card-table"><table class="session-table failing-labels"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +rows.map(r=>'<tr>'+[e(when(r.scoredAt)),'<span data-verbatim>'+e(r.author)+'</span>','<span class="amber" data-verbatim>'+e(r.label)+'</span>'].concat(staged?[deciderText(r.decidedBy||'not recorded')]:[],[harnessCell(r.harness),'<span data-verbatim>'+e(r.platform||(r.run?t('Workflow run'):'—'))+'</span>',r.skills?r.skills.map(s=>'<span class="tag" data-verbatim>'+e(s)+'</span>').join(' '):'—',regressionCell(r),learningsCell(r),subjectCell(r)]).map((cell,i)=>'<td data-label="'+e(t(heads[i]))+'">'+cell+'</td>').join('')+'</tr>').join('')
  +'</tbody></table></div>'+(rows.length<total?'<div class="cardfoot scorer-foot"><span class="label">'+number(rows.length)+' / '+number(total)+'</span> '+(rows.length<failingMax?'<button class="link" data-scorer-more>'+label('Show more')+'</button>':'<span class="label">'+label('Pick a group or a shorter window to list the rest.')+'</span>')+'</div>':''):'<div class="empty"><p>'+label('No failing labels in this window.')+'</p></div>')+'</section>';
}
function remindersPanel(sel){
 if(!sel.reminders)return '';
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Friction reminder')+'</h2><span class="tag">'+label('Sessions run on this machine')+' · '+label('last')+' '+number(sel.reminders.days)+' '+label('days')+'</span></div><div class="table-scroll"><table class="session-table compact"><thead><tr>'+['REMINDER FIRED','SESSIONS','LABELLED','PASSED'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +sel.reminders.rows.map(r=>'<tr><td>'+(r.reminder==='yes'?label('Yes'):r.reminder==='no'?label('No'):label('Not recorded'))+'</td><td>'+number(r.sessions)+'</td><td>'+number(r.labelled)+'</td><td>'+(r.rate==null?'—':meter(r.rate)+' '+pct(r.rate))+'</td></tr>').join('')
  +'</tbody></table></div><p class="scorer-hint">'+label('Sessions are your own sessions that started on this machine in the window, at most the 30 days this machine keeps reminder decisions. The pass rate is over labelled sessions only. A session with no reminder state here is not recorded.')+'</p></section>';
}
function scorerSummary(data){
 const heads=['SCORER','MEASUREMENT','LABELS','PASS RATE','AGREES WITH HAND LABELS','TREND'];
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Scorers')+' <span class="count">'+number(data.scorers.length)+'</span></h2><span class="label">'+label('Each scorer opens on its newest committed rubric.')+'</span></div><div class="table-scroll card-table"><table class="session-table scorer-summary"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +data.scorers.map(s=>{const c=s.cohorts.find(c=>c.id===s.defaultCohort)||s.cohorts[0]; const selected=data.selected&&data.selected.cohort.scorer===s.scorer; return '<tr class="'+(selected?'selected-row':'')+'">'+['<button class="link" data-scorer="'+e(s.scorer)+'" aria-pressed="'+selected+'" data-verbatim>'+e(s.scorer)+'</button><small>'+number(s.cohorts.length)+' '+(s.cohorts.length===1?label('measurement'):label('measurements'))+'</small>','<small>'+cohortText(c)+'</small>',number(c.stats.n),meter(c.stats.rate)+' '+pct(c.stats.rate),agreementCell(s.agreement),sparkline(c.trend)].map((cell,i)=>'<td data-label="'+e(t(heads[i]))+'">'+cell+'</td>').join('')+'</tr>';}).join('')
  +'</tbody></table></div></section>';
}
function scorerControls(data){
 const sel=data.selected;
 return '<form class="scorer-controls" data-scorer-form>'
  +'<label>'+label('Window')+'<select id="scorer-window">'+scorerWindows.map(w=>'<option value="'+w+'"'+(scorerQuery.window===w?' selected':'')+'>'+number(Number(w))+' '+label('days')+'</option>').join('')+'</select></label>'
  +'<label>'+label('Group by')+'<select id="scorer-group"><option value="">'+label('No grouping')+'</option>'+Object.keys(scorerDimensions).map(k=>'<option value="'+k+'"'+(scorerQuery.groupBy===k?' selected':'')+'>'+label(scorerDimensions[k])+'</option>').join('')+'</select></label>'
  +'<label>'+label('Split at team commit')+'<span class="inline"><input id="scorer-commit" name="commit" autocomplete="off" spellcheck="false" placeholder="'+e(t('commit SHA'))+'" value="'+e(scorerCommitDraft)+'" pattern="[0-9a-fA-F]{4,64}"><button class="primary" type="submit">'+label('Split')+'</button>'+(scorerQuery.commit?'<button class="ghost" type="button" data-scorer-clear>'+label('Clear')+'</button>':'')+'</span></label>'
  +'</form>'
  +(sel?cohortPicker(data,sel):'');
}
function scorersPage(){
 if(page==='scorers'&&!scorerData&&!scorerLoading&&!scorerError)loadScorers();
 if(scorerError&&!scorerData)return errorPanel(scorerError,'scorers');
 if(!scorerData)return '<div class="empty" role="status">'+label('Loading scorer results…')+'</div>';
 if(!scorerData.configured)return '<section class="panel"><div class="empty"><h2>'+label('No TeamAI scope in this workspace')+'</h2><p>'+label('Pick a project workspace above, or set one up with teamai init.')+'</p></div></section>';
 const sel=scorerData.selected, w=scorerData.window;
 const note='<p class="label scorer-note">'+label('Labels from sessions and workflow runs show how the tools did on the work that came along. To compare tools, models or team assets on the same tasks, run a benchmark.')+'</p>';
 if(!scorerData.scorers.length)return '<section class="panel"><div class="empty"><h2>'+label('No score labels yet')+'</h2><p>'+label('Labels appear here once a workflow scorer or teamai score labels work and the labels reach teamai-reports.')+'</p></div></section>'+note;
 return (scorerError?'<div class="error-panel" role="alert"><p>'+e(scorerError)+'</p></div>':'')
  +'<div class="statusline"><span>'+label('Window')+': '+e(when(w.from))+' – '+e(when(w.to))+'</span><span>'+label('Counted by when labels were scored, not when the work happened.')+'</span><span>'+label('Pass or fail as each label stored it.')+'</span></div>'
  +scorerSummary(scorerData)+scorerControls(scorerData)
  +(sel?'<h2 class="section-label"><span data-verbatim>'+e(sel.cohort.scorer)+'</span> <span class="tag">'+(sel.cohort.source==='session'?label('Session labels'):label('Workflow labels'))+'</span></h2>'+kpis(sel.cohort.stats)+decidedPanel(sel)+agreementPanel(sel)+valuesPanel(sel)+(sel.split?splitCards(sel.split):'')
   +'<section class="panel trend-panel"><div class="panelhead"><h2>'+label('Weekly pass rate')+'</h2><span class="label">'+cohortText(sel.cohort)+'</span></div>'+trendChart(sel.cohort.trend)+'</section>'
   +groupsPanel(sel)+failingPanel(sel)+remindersPanel(sel):'')
  +note;
}
async function loadScorers(){
 const generation=workspaceGeneration, request=++scorerRequest, current=()=>generation===workspaceGeneration&&request===scorerRequest; scorerLoading=true;
 const params={window:scorerQuery.window}; for(const key of ['scorer','cohort','groupBy','commit','group','failing'])if(scorerQuery[key])params[key]=scorerQuery[key];
 try{
  const response=await fetch(apiQuery('/api/scorers',params),{signal:AbortSignal.timeout(30000)});
  const data=await response.json().catch(()=>null);
  if(!current())return;
  if(!response.ok){scorerError=data&&data.error?data.error:t('Could not load scorer results.');if(response.status===400)scorerQuery.commit=scorerData&&scorerData.selected&&scorerData.selected.split?scorerData.selected.split.commit:'';}
  else{scorerData=data;scorerError='';if(data.selected){scorerQuery.scorer=data.selected.cohort.scorer;scorerQuery.cohort=data.selected.cohort.id;}if(!data.selected||!data.selected.groups)scorerQuery.group='';}
 }catch{if(current())scorerError=t('Could not load scorer results.');}
 finally{if(current()){scorerLoading=false;if(page==='scorers'){const html=scorersPage();if(html!==scorerHtml){scorerHtml=html;render();}revealAsked();}}}
}
/**
 * After the load a link asked for, takes the reader to what it opened, which a phone shows far from the link: the Before
 * and after cards of a split asked from a failing harness (\`scorerReveal\` 'split'), or the group another page opened
 * this one on ('group').
 */
function revealAsked(){
 const asked=scorerReveal; scorerReveal='';
 const sel=scorerData&&scorerData.selected;
 const target=asked==='split'&&sel&&sel.split?$('scorer-split'):asked==='group'&&sel&&sel.groups&&scorerQuery.group?$('scorer-selected-group'):null;
 if(!target)return;
 target.scrollIntoView({block:asked==='split'?'start':'center'}); target.focus({preventScroll:true});
}
function setScorerQuery(changes){ scorerQuery={...scorerQuery,group:'',failing:'',...changes}; save('teamai-dashboard-scorer-window',scorerQuery.window); save('teamai-dashboard-scorer-group',scorerQuery.groupBy); loadScorers(); }
/** Opens the Scorers page on \`changes\`, such as a role group another page links to, with no commit split, and takes the reader to that group. */
function openScorers(changes){ scorerData=null;scorerError='';scorerCommitDraft='';scorerReveal=changes.group?'group':'';setScorerQuery({commit:'',...changes});location.hash='scorers'; }
document.addEventListener('change',event=>{
 if(event.target.id==='scorer-window')setScorerQuery({window:event.target.value});
 else if(event.target.id==='scorer-group')setScorerQuery({groupBy:event.target.value});
});
document.addEventListener('input',event=>{ if(event.target.id==='scorer-commit')scorerCommitDraft=event.target.value; });
document.addEventListener('submit',event=>{ if(!event.target.closest('[data-scorer-form]'))return; event.preventDefault(); scorerCommitDraft=$('scorer-commit').value.trim(); setScorerQuery({commit:scorerCommitDraft}); });
document.addEventListener('click',event=>{
 const scorer=event.target.closest('[data-scorer]'), cohort=event.target.closest('[data-cohort]'), group=event.target.closest('[data-scorer-group]'), decided=event.target.closest('[data-decided]'), split=event.target.closest('[data-scorer-split]'), arm=event.target.closest('[data-scorer-arm]');
 if(decided){const again=scorerQuery.groupBy==='decidedBy'&&scorerQuery.group===decided.dataset.decided; save('teamai-dashboard-scorer-group','decidedBy'); scorerQuery={...scorerQuery,groupBy:'decidedBy',failing:'',group:again?'':decided.dataset.decided}; loadScorers();}
 else if(arm){const [suite,name]=JSON.parse(arm.dataset.scorerArm);openBenchmarks({suite,arm:name});}
 else if(split){scorerCommitDraft=split.dataset.scorerSplit;scorerReveal='split';setScorerQuery({commit:scorerCommitDraft,group:scorerQuery.group});}
 else if(scorer)setScorerQuery({scorer:scorer.dataset.scorer,cohort:''});
 else if(cohort)setScorerQuery({cohort:cohort.dataset.cohort});
 else if(group)setScorerQuery({group:scorerQuery.group===group.dataset.scorerGroup?'':group.dataset.scorerGroup});
 else if(event.target.closest('[data-scorer-more]'))setScorerQuery({group:scorerQuery.group,failing:String(Math.min(scorerData.selected.failing.labels.length+failingPage,failingMax))});
 else if(event.target.closest('[data-scorer-clear]')){scorerCommitDraft='';setScorerQuery({commit:''});}
});
`;

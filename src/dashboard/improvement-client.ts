/**
 * The Improvement page of the dashboard client, embedded in `dashboardClient`'s closure, whose helpers it uses:
 * `e`, `t`, `label`, `number`, `when`, `read`, `save`, `kb`, `kbError`, `source`, `errorPanel`, `link`, `trendPanel`
 * and `language`. Data comes from `kb.improvement` (`/api/context`); every value from the API is escaped with `e`.
 */
export const improvementClient = `
let impRange = Number(read('teamai-dashboard-improvement-range','30')); if(![7,30,90].includes(impRange))impRange=30;
let impPriorOk = true;
const impMoney = micros => new Intl.NumberFormat(language,{style:'currency',currency:'USD',maximumFractionDigits:micros>=100e6?0:2}).format((micros||0)/1e6);
const impPct = v => v==null?'—':(Math.round(v*1000)/10)+'%';
const impDay = d => d.slice(5).replace('-','/');
function impSum(days){ const n=days.length; const s={ended:0,succeeded:0,corrected:0,prompts:0,durationMs:0,costMicros:0,priced:0,cacheRead:0,cacheEligible:0}; for(const d of days)for(const k in s)s[k]+=d[k]||0; s.days=n; return s; }
function impRates(s){ return { costPerDay:s.days?s.costMicros/s.days:null, success:s.ended?s.succeeded/s.ended:null, correction:s.ended?s.corrected/s.ended:null,  promptsPer:s.ended?s.prompts/s.ended:null, cache:s.cacheEligible?s.cacheRead/s.cacheEligible:null, minutes:s.ended?s.durationMs/s.ended/60000:null }; }
function impDelta(cur, prev, kind, betterUp){
  if(!impPriorOk)return '<span class="imp-delta">'+label('Too few sessions in prior period to compare')+'</span>';
  if(cur==null||prev==null||(kind!=='pp'&&!prev))return '<span class="imp-delta">'+label('No prior data')+'</span>';
  const d=kind==='pp'?(cur-prev)*100:(cur-prev)/prev*100; if(Math.abs(d)<0.5)return '<span class="imp-delta">'+label('Flat vs prior')+'</span>';
  const up=d>0, good=betterUp==null?null:(up===betterUp);
  return '<span class="imp-delta'+(good===true?' good':good===false?' bad':'')+'">'+(up?'▲ ':'▼ ')+(Math.round(Math.abs(d)*10)/10)+(kind==='pp'?' pp':'%')+' '+label('vs prior')+'</span>';
}
function impTile(title, value, sub, delta){ return '<article class="imp-tile"><div class="imp-tile-title">'+label(title)+'</div><div class="imp-tile-value">'+value+'</div>'+(sub?'<div class="imp-tile-sub">'+sub+'</div>':'')+(delta||'')+'</article>'; }

function impChart(id, title, days, series, fmt, note){
  const W=560,H=180,L=44,B=22,T=10,R=6; const w=W-L-R, h=H-T-B; const n=days.length||1;
  const totals=days.map(d=>series.reduce((a,s)=>a+(s.value(d)||0),0)); const max=Math.max(1,...totals);
  const step=Math.pow(10,Math.floor(Math.log10(max))); const nice=[1,2,2.5,5,10].map(m=>m*step).find(v=>v*4>=max)||max; const top=nice*4;
  const bw=Math.max(1,w/n-2), grid=[0,1,2,3,4].map(i=>{const v=nice*i,y=T+h-h*v/top;return '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" class="imp-grid"/><text x="'+(L-6)+'" y="'+(y+3)+'" class="imp-axis" text-anchor="end">'+e(fmt(v,true))+'</text>';}).join('');
  const bars=days.map((d,i)=>{ let y=T+h; const x=L+i*(w/n)+1; let out=''; series.forEach((s,si)=>{ const v=s.value(d)||0; if(!v)return; const bh=Math.max(1,h*v/top); y-=bh; out+='<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+Math.max(0,bh-(si<series.length-1?0:0))+'" rx="'+(si===series.length-1||series.slice(si+1).every(o=>!(o.value(d))) ? Math.min(3,bw/2) : 0)+'" class="imp-bar s'+si+'"/>'; if(si<series.length-1)y-=2; });
    const tip=e(d.date)+' · '+series.map(s=>t(s.name)+' '+fmt(s.value(d)||0)).join(' · ');
    return '<g class="imp-hit" data-tip="'+tip+'"><rect x="'+(L+i*(w/n))+'" y="'+T+'" width="'+(w/n)+'" height="'+h+'" fill="transparent"/>'+out+'</g>'; }).join('');
  const ticks=days.map((d,i)=>i%Math.ceil(n/6)===0||i===n-1?'<text x="'+(L+i*(w/n)+w/n/2)+'" y="'+(H-6)+'" class="imp-axis" text-anchor="middle">'+impDay(d.date)+'</text>':'').join('');
  const legend=series.length>1?'<div class="imp-legend">'+series.map((s,i)=>'<span><i class="s'+i+'"></i>'+label(s.name)+'</span>').join('')+'</div>':'';
  const table='<details class="imp-table" data-imp-key="table-'+id+'"><summary>'+label('Show as table')+'</summary><table><thead><tr><th>'+label('Date')+'</th>'+series.map(s=>'<th>'+label(s.name)+'</th>').join('')+'</tr></thead><tbody>'+days.slice().reverse().map(d=>'<tr><td>'+e(d.date)+'</td>'+series.map(s=>'<td>'+e(fmt(s.value(d)||0))+'</td>').join('')+'</tr>').join('')+'</tbody></table></details>';
  return '<article class="imp-chart" id="'+id+'"><div class="imp-chart-head"><h3>'+label(title)+'</h3>'+legend+'</div><div class="imp-plot"><svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+label(title)+'">'+grid+bars+ticks+'</svg><div class="imp-tip" hidden></div></div>'+(note?'<p class="imp-note">'+note+'</p>':'')+table+'</article>';
}

function impActions(d, cur, prev){
  const a=[], m=d.maintenance, cr=impRates(cur), pr=impRates(prev);
  const add=(kind,title,why,cmd,target)=>a.push({kind,title,why,cmd,target});
  if(impPriorOk&&cr.correction!=null&&pr.correction!=null&&cr.correction-pr.correction>=0.02)add('Watch',t('Correction rate rose')+' '+impPct(pr.correction)+' → '+impPct(cr.correction),t('Sessions that needed a correction went up in this period. Open recent sessions to see where agents went off track.'),'','execution');
  if(impPriorOk&&cr.costPerDay!=null&&pr.costPerDay&&cr.costPerDay/pr.costPerDay>=1.2)add('Watch',t('Known cost per day rose')+' '+impMoney(pr.costPerDay)+' → '+impMoney(cr.costPerDay),t('Average known cost per day grew by 20% or more. Only requests with a known price count, so pricing more models also raises it.'),'','imp-cost');
  if(m.prune.length)add('To do',number(m.prune.length)+' '+t('learnings suggested for archive'),t('Below the confidence threshold or inactive for more than 180 days.'),'teamai recall maintenance --prune --archive','imp-maint');
  if(m.stale.length)add('To do',number(m.stale.length)+' '+t('entries recalled often but rarely upvoted'),t('Likely stale or low quality; refresh them.'),'teamai recall maintenance --update-quality','imp-maint');
  if(m.promote.length)add('Opportunity',number(m.promote.length)+' '+t('learnings ready to promote'),t('High confidence and adopted by several people.'),'teamai recall promote '+m.promote[0].docId+' --category '+m.promote[0].category,'imp-maint');
  if(d.skills.unused.length)add('Review',number(d.skills.unused.length)+' / '+number(d.skills.teamTotal)+' '+t('team skills unused in 30 days'),t('Check whether they are still needed, discoverable, or should be merged.'),'teamai skill list','imp-skills');
  if(d.skills.outside.length)add('Opportunity',number(d.skills.outside.length)+' '+t('skills used by several members but no longer in the team repo'),t('Published before the team-skill filter or since removed from the repo. Restore them to the repo or retire them.'),'','imp-skills');
  if(m.silent)add('Review',number(m.silent)+' '+t('knowledge entries never recalled'),t('Never recalled does not mean useless; check their tags and wording.'),'','context');
  return a;
}

function improvement(){
  const head='<div class="actions">'+source()+'<button class="link" data-retry="kb">'+label('Refresh report')+'</button></div>'+(kbError?errorPanel('Could not refresh KB Health. Any displayed report is the last successful result.','kb'):'');
  if(!kb)return head+'<div class="empty">'+label('Loading…')+'</div>';
  const d=kb.improvement;
  if(!d)return head+'<div class="report" id="kb-content">'+kb.maintenance+'</div>';
  const all=d.daily||[], cur=impSum(all.slice(-impRange)), prev=impSum(all.slice(-impRange*2,-impRange)), cr=impRates(cur), pr=impRates(prev), days=all.slice(-impRange);
  // A team that started publishing recently has a near-empty prior window; a % change against it says nothing.
  impPriorOk=prev.ended>=Math.max(20,cur.ended*0.25);
  const peak=Math.max(0,...days.map(x=>x.members));
  const range='<div class="imp-range" role="group" aria-label="'+label('Time range')+'">'+[7,30,90].map(r=>'<button data-imp-range="'+r+'" class="'+(r===impRange?'active':'')+'" aria-pressed="'+(r===impRange)+'">'+number(r)+' '+label('days')+'</button>').join('')+'</div>';
  const scope='<p class="imp-scope">'+label('Team stats published on teamai-reports')+' · '+number(d.members)+' '+label('members')+' · '+label('Data through')+' '+e(d.window.to)+' · '+label('Prior period')+' '+number(prev.ended)+' '+label('sessions')+(d.window.latestStats?' · '+label('Latest member sync')+' '+e(when(d.window.latestStats)):'')+'</p>';
  const tiles='<div class="imp-tiles">'
    +impTile('Sessions ended',number(cur.ended),label('Peak active members / day')+' '+number(peak),impDelta(cur.ended,prev.ended,'rel',null))
    +impTile('Success rate',impPct(cr.success),number(cur.succeeded)+' '+label('succeeded'),impDelta(cr.success,pr.success,'pp',true))
    +impTile('Correction rate',impPct(cr.correction),number(cur.corrected)+' '+label('sessions corrected'),impDelta(cr.correction,pr.correction,'pp',false))
    +impTile('Known cost',impMoney(cur.costMicros),label('Per day')+' '+(cr.costPerDay==null?'—':impMoney(cr.costPerDay)),impDelta(cur.costMicros,prev.costMicros,'rel',null))
    +impTile('Prompt turns',number(cur.prompts),label('Per session')+' '+(cr.promptsPer==null?'—':(Math.round(cr.promptsPer*10)/10)),impDelta(cur.prompts,prev.prompts,'rel',null))
    +impTile('Cache read share',impPct(cr.cache),label('Avg session')+' '+(cr.minutes==null?'—':Math.round(cr.minutes)+' '+label('min')),impDelta(cr.cache,pr.cache,'pp',true))
    +'</div>';
  const n=v=>number(Math.round(v));
  const charts='<div class="imp-charts">'
    +impChart('imp-sessions','Sessions per day',days,[{name:'Without correction',value:x=>x.ended-x.corrected},{name:'Needed correction',value:x=>x.corrected}],n)
    +impChart('imp-cost','Known cost per day',days,[{name:'Cost',value:x=>x.costMicros}],(v,axis)=>axis&&v%1e6===0?'$'+n(v/1e6):impMoney(v),label('Only requests with a known price are counted.'))
    +impChart('imp-prompts','Prompt turns per day',days,[{name:'Prompt turns',value:x=>x.prompts}],n)
    +impChart('imp-members','Active members per day',days,[{name:'Members',value:x=>x.members}],n,label('Members who ended at least one session that day.'))
    +'</div>';
  const actions=impActions(d,cur,prev);
  const actionHtml='<section class="panel imp-section"><div class="panelhead"><h2>'+label('Suggested next steps')+' <span class="count">'+number(actions.length)+'</span></h2><span class="tag">'+label('Derived from the data on this page')+'</span></div>'
    +(actions.length?'<ol class="imp-actions">'+actions.map(x=>'<li><span class="imp-kind">'+label(x.kind)+'</span><div><strong>'+e(x.title)+'</strong><p>'+e(x.why)+'</p>'+(x.cmd?'<div class="imp-cmd"><code>'+e(x.cmd)+'</code><button class="link copy" data-copy="'+e(x.cmd)+'" aria-label="'+label('Copy command')+'">'+label('Copy')+'</button></div>':'')+'</div>'+(x.target?(x.target.startsWith('imp-')?'<a class="link" href="#improvement" data-imp-jump="'+x.target+'">'+label('View')+' →</a>':link(x.target,'View')):'')+'</li>').join('')+'</ol>':'<div class="empty">'+label('Nothing needs attention right now.')+'</div>')+'</section>';
  const skillRow=s=>'<tr><td>'+e(s.name)+(s.namespace?' <span class="imp-ns">'+e(s.namespace)+'</span>':'')+'</td><td>'+number(s.users)+'</td><td>'+number(s.uses)+'</td><td>'+(s.lastUsed?e(s.lastUsed.slice(0,10)):'—')+'</td></tr>';
  const skillTable=(key,rows,limit)=>'<table><thead><tr><th>'+label('Skill')+'</th><th>'+label('Members')+'</th><th>'+label('All-time uses')+'</th><th>'+label('Last used')+'</th></tr></thead><tbody>'+rows.slice(0,limit).map(skillRow).join('')+'</tbody></table>'+(rows.length>limit?'<details class="imp-more" data-imp-key="more-'+e(key)+'"><summary>'+label('Show all')+' ('+number(rows.length)+')</summary><table><tbody>'+rows.slice(limit).map(skillRow).join('')+'</tbody></table></details>':'');
  const usedPct=d.skills.teamTotal?Math.round(d.skills.used.length/d.skills.teamTotal*100):0;
  const skillsHtml='<section class="panel imp-section" id="imp-skills"><div class="panelhead"><h2>'+label('Team skill adoption')+'</h2><span class="tag">'+label('Last 30 days')+' · '+number(d.skills.used.length)+' / '+number(d.skills.teamTotal)+' '+label('used')+' ('+usedPct+'%)</span></div>'
    +'<div class="imp-meter" role="img" aria-label="'+usedPct+'%"><span style="width:'+usedPct+'%"></span></div>'
    +'<div class="imp-cols"><div><h3>'+label('Most used team skills')+'</h3>'+(d.skills.used.length?skillTable('used',d.skills.used,8):'<p class="imp-note">'+label('No team skill was used in this period.')+'</p>')+'</div>'
    +'<div><h3>'+label('Used by several members, no longer in the team repo')+'</h3>'+(d.skills.outside.length?skillTable('outside',d.skills.outside,8):'<p class="imp-note">'+label('None right now.')+'</p>')+'</div></div>'
    +'<details class="imp-more imp-unused" data-imp-key="unused"><summary>'+label('Team skills unused in 30 days')+' ('+number(d.skills.unused.length)+')</summary><div class="imp-chips">'+d.skills.unused.map(s=>'<span>'+e(s.name)+(s.namespace?' <small>'+e(s.namespace)+'</small>':'')+'</span>').join('')+'</div></details></section>';
  const f=d.friction, per=v=>f.sessions?(Math.round(v/f.sessions*1000)/10)+'%':'—', fmax=Math.max(1,f.interrupt,f.toolReject,f.correction);
  const fRow=(name,v,why)=>'<div class="imp-frow"><div><strong>'+label(name)+'</strong><p>'+label(why)+'</p></div><div class="imp-fbar"><span style="width:'+(v/fmax*100)+'%"></span></div><div class="imp-fval">'+number(v)+'<small>'+per(v)+' '+label('of sessions')+'</small></div></div>';
  const frictionHtml='<section class="panel imp-section"><div class="panelhead"><h2>'+label('Friction signals')+'</h2><span class="tag">'+label('Cumulative')+' · '+number(f.sessions)+' '+label('sessions')+' · '+number(f.members)+' '+label('members')+'</span></div><div class="imp-friction">'
    +fRow('Corrections',f.correction,'The user told the agent it was wrong.')+fRow('Interrupts',f.interrupt,'The user stopped the agent mid-turn.')+fRow('Rejected tool calls',f.toolReject,'The user declined a tool the agent wanted to run.')+'</div></section>';
  const m=d.maintenance; const tab=read('teamai-dashboard-improvement-tab','prune');
  const tabs=[['prune','Archive',m.prune.length],['stale','Needs refresh',m.stale.length],['promote','Promote',m.promote.length]];
  const lists={
    prune:['teamai recall maintenance --prune --archive','<table><thead><tr><th>'+label('Learning')+'</th><th>'+label('Confidence')+'</th><th>'+label('Last activity')+'</th><th>'+label('Reason')+'</th></tr></thead><tbody>'+m.prune.map(c=>'<tr><td>'+e(c.name)+'</td><td>'+Math.round(c.confidence*100)+'%</td><td>'+e((c.lastActivity||'').slice(0,10)||'—')+'</td><td>'+e(c.reason)+'</td></tr>').join('')+'</tbody></table>'],
    stale:['teamai recall maintenance --update-quality','<table><thead><tr><th>'+label('Entry')+'</th><th>'+label('Type')+'</th><th>'+label('Recalls')+'</th><th>'+label('Upvotes')+'</th><th>'+label('Members')+'</th></tr></thead><tbody>'+m.stale.map(c=>'<tr><td>'+e(c.docId)+'</td><td>'+e(c.type)+'</td><td>'+number(c.recalled)+'</td><td>'+number(c.upvoted)+'</td><td>'+number(c.users)+'</td></tr>').join('')+'</tbody></table>'],
    promote:['teamai recall promote <learning-id> --category skills|rules|docs','<table><thead><tr><th>'+label('Learning')+'</th><th>'+label('Category')+'</th><th>'+label('Confidence')+'</th><th>'+label('Upvotes')+'</th><th>'+label('Command')+'</th></tr></thead><tbody>'+m.promote.map(c=>{const cmd='teamai recall promote '+c.docId+' --category '+c.category;return '<tr><td>'+e(c.title)+'</td><td>'+e(c.category)+'</td><td>'+Math.round(c.confidence*100)+'%</td><td>'+number(c.upvoted)+'</td><td><button class="link copy" data-copy="'+e(cmd)+'">'+label('Copy')+'</button></td></tr>';}).join('')+'</tbody></table>'],
  };
  const sel=lists[tab]?tab:'prune', count=tabs.find(x=>x[0]===sel)[2];
  const maintHtml='<section class="panel imp-section" id="imp-maint"><div class="panelhead"><h2>'+label('Knowledge maintenance')+' <span class="count">'+number(m.prune.length+m.stale.length+m.promote.length)+'</span></h2><span class="tag">'+label('Candidates, not actions taken')+'</span></div>'
    +'<div class="imp-tabs" role="tablist">'+tabs.map(([k,n,c])=>'<button role="tab" data-imp-tab="'+k+'" aria-selected="'+(k===sel)+'" class="'+(k===sel?'active':'')+'">'+label(n)+' <span>'+number(c)+'</span></button>').join('')+'</div>'
    +'<div class="imp-cmd imp-cmd-wide"><code>'+e(lists[sel][0])+'</code><button class="link copy" data-copy="'+e(lists[sel][0])+'" aria-label="'+label('Copy command')+'">'+label('Copy')+'</button></div>'
    +(count?'<div class="imp-scroll">'+lists[sel][1]+'</div>':'<div class="empty">'+label('None right now.')+'</div>')+'</section>';
  const share=[['teamai session save --push','Share a summary of this session with the team.'],['teamai digest','Generate the weekly team activity digest.'],['teamai contribute','Publish a learning to the team knowledge base.'],['teamai recall feedback --positive <doc-id>','Tell the team a recalled entry helped.']];
  const shareHtml='<section class="panel imp-section"><div class="panelhead"><h2>'+label('Turn experience into team knowledge')+'</h2><span class="tag">'+label('Command reference')+'</span></div><div class="imp-share">'+share.map(([c,w])=>'<div><div class="imp-cmd"><code>'+e(c)+'</code><button class="link copy" data-copy="'+e(c)+'" aria-label="'+label('Copy command')+'">'+label('Copy')+'</button></div><p>'+label(w)+'</p></div>').join('')+'</div></section>';
  const local='<details class="imp-local" data-imp-key="local"><summary>'+label('This machine: 7 days vs prior 7 days')+'</summary>'+trendPanel()+'</details>';
  return head+'<div class="imp-toolbar"><h2 class="section-label">'+label('Team usage')+'</h2>'+range+'</div>'+scope+tiles+charts+actionHtml+skillsHtml+frictionHtml+maintHtml+shareHtml+local;
}
document.addEventListener('click',event=>{
  const r=event.target.closest('[data-imp-range]'); if(r){impRange=Number(r.dataset.impRange);save('teamai-dashboard-improvement-range',String(impRange));render();return;}
  const tb=event.target.closest('[data-imp-tab]'); if(tb){save('teamai-dashboard-improvement-tab',tb.dataset.impTab);render();return;}
  const j=event.target.closest('[data-imp-jump]'); if(j){event.preventDefault();document.getElementById(j.dataset.impJump)?.scrollIntoView({behavior:'smooth',block:'start'});}
});
document.addEventListener('mousemove',event=>{
  const g=event.target.closest?.('.imp-hit'); const plots=document.querySelectorAll('.imp-tip');
  plots.forEach(tip=>{ if(!g||!tip.parentElement.contains(g)){tip.hidden=true;return;} const box=tip.parentElement.getBoundingClientRect(); tip.textContent=g.dataset.tip; tip.hidden=false; const x=Math.min(event.clientX-box.left+12, box.width-tip.offsetWidth-4); tip.style.left=Math.max(4,x)+'px'; tip.style.top=Math.max(0,event.clientY-box.top-36)+'px'; });
});
`;

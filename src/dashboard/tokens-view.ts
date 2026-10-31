/**
 * The Tokens & cost page as browser code: `tokensPage()` renders what `/api/tokens` answers
 * (`src/dashboard/token-costs.ts`). The dashboard client embeds it, and so supplies `t`, `e`,
 * `label`, `number`, `when`, `language`, `json`, `apiQuery`, `errorPanel`, `render`, `page`,
 * `sessions` and `workspaceGeneration`.
 */
export const tokensView = `
let tokenDays = 7, tokenData = null, tokenError = false, tokenLoading = false;
function resetTokens() { tokenData=null;tokenError=false;tokenLoading=false; }
async function loadTokens() {
 if(tokenLoading)return; const generation=workspaceGeneration, days=tokenDays; tokenLoading=true;
 try{ const data=await json(apiQuery('/api/tokens',{days:String(days)})); if(generation===workspaceGeneration&&days===tokenDays){tokenData=data;tokenError=false;} }
 catch{ if(generation===workspaceGeneration)tokenError=true; }
 finally{ if(generation===workspaceGeneration){tokenLoading=false;if(page==='tokens')render();} }
}
const usd = micros => new Intl.NumberFormat(language,{style:'currency',currency:'USD',minimumFractionDigits:micros>0&&micros<1000000?4:2,maximumFractionDigits:micros>0&&micros<1000000?4:2}).format((micros||0)/1000000);
const tokenSum = tokens => tokens.input+tokens.output+tokens.cacheRead+tokens.cacheCreation;
const compact = value => new Intl.NumberFormat(language,{notation:'compact',maximumFractionDigits:1}).format(value||0);
function tokenChange(now, before) {
 if(!before)return '<span class="label">'+label('No cost in the prior period')+'</span>';
 const change=Math.round((now-before)/before*100);
 return '<span class="label">'+label('Prior')+': '+usd(before)+' · <span class="'+(change>0?'amber':'good')+'">'+(change>0?'+':'')+number(change)+'%</span></span>';
}
function tokenChart(daily) {
 const max=Math.max(...daily.map(d=>d.costMicros),1), w=720, h=180, pad=22, step=(w-pad*2)/daily.length, bar=Math.max(2,step*0.7);
 const every=daily.length>30?14:daily.length>7?5:1;
 const bars=daily.map((d,i)=>{const height=d.costMicros?Math.max(2,(h-pad*2)*d.costMicros/max):0, x=pad+i*step+(step-bar)/2;
  return '<g><title>'+e(d.date)+': '+e(usd(d.costMicros))+' · '+e(compact(d.tokens))+' '+e(t('tokens'))+' · '+e(number(d.requests))+' '+e(t('requests'))+'</title>'
   +(height?'<rect class="bar" x="'+x.toFixed(1)+'" y="'+(h-pad-height).toFixed(1)+'" width="'+bar.toFixed(1)+'" height="'+height.toFixed(1)+'" rx="2"/>':'<rect class="gap" x="'+x.toFixed(1)+'" y="'+(h-pad-1)+'" width="'+bar.toFixed(1)+'" height="1"/>')
   +((daily.length-1-i)%every===0?'<text x="'+(x+bar/2).toFixed(1)+'" y="'+(h-6)+'">'+e(d.date.slice(5))+'</text>':'')+'</g>';}).join('');
 return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" role="img" aria-label="'+e(t('Estimated cost per day'))+'"><line class="grid" x1="'+pad+'" x2="'+(w-pad)+'" y1="'+pad+'" y2="'+pad+'"/><text class="value" x="'+(pad+30)+'" y="'+(pad-6)+'">'+e(usd(max))+'</text>'+bars+'</svg>';
}
function tokenShare(part, whole) { const pct=whole?Math.round(part/whole*100):0; return '<span class="meter" aria-hidden="true"><span style="width:'+pct+'%"></span></span>'+number(pct)+'%'; }
function tokenCost(row) { return row.pricedRequests?usd(row.costMicros)+(row.pricedRequests<row.requests?'<small class="amber">'+number(row.requests-row.pricedRequests)+' '+label('unpriced')+'</small>':''):'<span class="tag amber">'+label('Tokens only')+'</span>'; }
// Each row is a list of cells; on a narrow screen a cell shows its column name above it.
function tokenTable(heads, rows) { return '<div class="table-scroll"><table class="session-table compact tokens-table"><thead><tr>'+heads.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(cells=>'<tr>'+cells.map((cell,i)=>'<td data-label="'+label(heads[i])+'">'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'; }
// A session the dashboard knows is named by its first prompt and opens its details.
function tokenSessionCell(s) {
 const known=sessions.find(x=>x.sessionId===s.sessionId), prompt=known&&known.prompts&&known.prompts[0];
 const name=prompt?e(prompt.length>70?prompt.slice(0,69)+'…':prompt):'<span data-verbatim>'+e(s.sessionId.slice(0,12))+'</span>';
 const meta='<small>'+(known&&known.repoLabel&&known.repoLabel!=='no_repo'?'<span data-verbatim>'+e(known.repoLabel)+'</span> · ':'')+e(when(s.lastAt))+'</small>';
 return (known?'<button class="link" data-session="'+e(s.sessionId)+'">'+name+' ↗</button>':name)+meta;
}
function tokensPage() {
 if(page==='tokens'&&!tokenData&&!tokenLoading&&!tokenError)loadTokens();
 const windows='<div class="chips token-window" role="group" aria-label="'+e(t('Window'))+'">'+[7,30,90].map(d=>'<button class="chip'+(d===tokenDays?' active':'')+'" data-token-days="'+d+'" aria-pressed="'+(d===tokenDays)+'">'+label(d+' days')+'</button>').join('')+'</div>';
 if(tokenError&&!tokenData)return windows+errorPanel('Could not load token usage.','tokens');
 if(!tokenData)return windows+'<div class="empty" role="status">'+label('Loading token usage…')+'</div>';
 const s=tokenData, all=s.totals, used=tokenSum(all.tokens);
 if(!all.requests)return windows+'<section class="panel"><div class="empty"><h2>'+label('No requests in this window')+'</h2><p>'+label('Token usage appears here after a session of a supported AI tool stops. See the Tokens & cost column of the tool support page.')+'</p></div></section>';
 const unpriced=s.byModel.filter(m=>!m.pricedRequests);
 const kpis='<div class="kpis token-kpis">'
  +'<article class="card kpi"><h2>'+label('Estimated cost')+'</h2><div class="big">'+usd(all.costMicros)+'</div>'+tokenChange(all.costMicros,s.previous.costMicros)+'</article>'
  +'<article class="card kpi"><h2>'+label('Tokens')+'</h2><div class="big">'+compact(used)+'</div><span class="label">'+label('Input')+' '+compact(all.tokens.input)+' · '+label('Output')+' '+compact(all.tokens.output)+' · '+label('Cache')+' '+compact(all.tokens.cacheRead+all.tokens.cacheCreation)+'</span></article>'
  +'<article class="card kpi"><h2>'+label('Saved by caching')+'</h2><div class="big good">'+usd(all.cacheSavingsMicros)+'</div><span class="label">'+label('Cache reads')+': '+tokenShare(all.tokens.cacheRead,all.tokens.input+all.tokens.cacheRead+all.tokens.cacheCreation)+' '+label('of the prompt')+'</span></article>'
  +'<article class="card kpi"><h2>'+label('Requests priced')+'</h2><div class="big">'+tokenShare(all.pricedRequests,all.requests)+'</div><span class="label">'+number(all.pricedRequests)+' / '+number(all.requests)+(all.reportedCostMicros?' · '+usd(all.reportedCostMicros)+' '+label('reported by the tool'):'')+'</span></article>'
  +'</div>';
 const chart='<section class="panel trend-panel"><div class="panelhead"><h2>'+label('Estimated cost per day')+'</h2><span class="tag">'+e(s.from)+' – '+e(s.to)+' · UTC</span></div><div class="trend-chart">'+tokenChart(s.daily)+'</div></section>';
 const tools='<section class="panel sessions"><div class="panelhead"><h2>'+label('By AI tool')+' <span class="count">'+number(s.byTool.length)+'</span></h2></div>'
  +tokenTable(['AI TOOL','REQUESTS','TOKENS','COST','SHARE'],s.byTool.map(r=>['<span data-verbatim>'+e(r.tool)+'</span>',number(r.requests),compact(tokenSum(r.tokens)),tokenCost(r),tokenShare(r.costMicros,all.costMicros)]))+'</section>';
 const models='<section class="panel sessions"><div class="panelhead"><h2>'+label('By model')+' <span class="count">'+number(s.byModel.length)+'</span></h2></div>'
  +tokenTable(['MODEL','AI TOOL','REQUESTS','TOKENS','COST'],s.byModel.map(r=>['<span data-verbatim>'+e(r.model)+'</span>','<span data-verbatim>'+r.tools.map(e).join(', ')+'</span>',number(r.requests),compact(tokenSum(r.tokens)),tokenCost(r)]))
  +(unpriced.length?'<p class="scorer-hint">'+label('No price list knows')+' <span data-verbatim>'+unpriced.map(m=>e(m.model)).join(', ')+'</span>. '+label('If one is another name for a listed model, map it under modelAliases in your teamai config, for example')+' <code class="cmd">'+e(unpriced[0].model)+': claude-sonnet-5-5</code></p>':'')+'</section>';
 const top='<section class="panel sessions"><div class="panelhead"><h2>'+label('Sessions that cost the most')+'</h2></div>'
  +tokenTable(['SESSION','AI TOOL','REQUESTS','TOKENS','COST'],s.topSessions.map(r=>[tokenSessionCell(r),'<span data-verbatim>'+e(r.tool)+'</span>',number(r.requests),compact(tokenSum(r.tokens)),tokenCost(r)]))+'</section>';
 return windows+(tokenError?errorPanel('Could not refresh token usage. Any displayed values are the last successful result.','tokens'):'')+kpis+chart+'<div class="token-split">'+tools+models+'</div>'+top
  +'<p class="label scorer-note">'+label('Estimated at API list prices from the LiteLLM price list')+' <span data-verbatim>'+e(s.catalogVersion)+'</span>. '+label('A request keeps the price it was recorded with; a cost the tool reported is used as is. A subscription plan bills differently.')+'</p>';
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-token-days]');if(button){tokenDays=Number(button.dataset.tokenDays);tokenData=null;tokenError=false;render();}});
`;

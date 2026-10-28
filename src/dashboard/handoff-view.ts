/**
 * The Handed-off runs panel (#1390) as browser code: `handoffPanel(rows, local)` renders the `handoffs` that
 * `/api/workflows` answers, with the command that takes each run, where `local` holds the ids of the runs this machine
 * has. `needsPerson(offer)` says whether an offered run waits for a person. The dashboard client embeds it, and so
 * supplies `e`, `label`, `number` and `when`.
 */
export const handoffView = `
function needsPerson(o) { return Boolean(o.refusal)||o.needs.length>0; }
function command(text) { return '<span class="cmd-line"><code class="cmd" data-verbatim>'+e(text)+'</code><button class="link copy" data-copy="'+e(text)+'" aria-label="'+label('Copy command')+'">'+label('Copy')+'</button></span>'; }
// What the steps left need of whichever machine takes the run, so the team can set a runner up for it.
function uses(o, title) {
 const env=o.uses.env.map(k=>label('env')+' <code data-verbatim>'+e(k)+'</code>'), prompts=o.uses.prompts.length?[label('a tool for')+' <span data-verbatim>'+o.uses.prompts.map(e).join(', ')+'</span>']:[];
 return env.length||prompts.length?'<div class="need"><span>'+label(title)+'</span><small>'+env.concat(prompts).join('<br>')+'</small></div>':'';
}
// Each lack, then what gives it, on a line of its own.
function lacks(o) { return o.lacks.length?'<div class="need"><span class="amber">'+label('Not on this machine')+'</span>'+o.lacks.map(l=>'<small data-verbatim>'+e(l.reason)+'</small><small class="fix" data-verbatim>→ '+e(l.fix)+'</small>').join('')+'</div>':''; }
function handoffRow(h, local) {
 const o=h.offer, who=h.isMine?label('You'):'<span data-verbatim>'+e(h.owner.user)+'</span>', repo=h.repository?'<span data-verbatim>'+e(h.repository)+'</span>':label('its business repository');
 const name=local.has(h.run)?'<button class="link" data-run="'+e(h.run)+'" data-run-source="local"><span class="sr-only">'+label('Details')+' </span><span data-verbatim>'+e(h.workflow)+'</span> ↗</button>':'<span data-verbatim>'+e(h.workflow)+'</span>';
 const state=(o?'<span class="good">'+label('Offered')+'</span>':'<span>'+label('Held')+'</span>')+'<small>'+who+' · '+e(when(o?o.at:h.ownedAt))+'</small>';
 const needs=!o?'—':o.refusal?'<span class="amber" data-verbatim>'+e(o.refusal.message)+'</span>'
  :(o.needs.length?'<div class="need"><span class="amber">'+label('Needs a person')+'</span><small data-verbatim>'+o.needs.map(e).join('<br>')+'</small></div>'+uses(o,'Their machine needs')
   :uses(o,'A runner needs')||'<span class="good">'+label('Nothing: a runner can finish it')+'</span>')+lacks(o);
 // A runner's --next never takes this install's own offer, and --claim takes another install's run over even on a
 // machine that still holds an earlier copy of it.
 const next=o?(h.isMine?command('teamai workflow resume '+h.run)+'<small>'+label('Takes it back here, and the offer away')+'</small>'
  :needsPerson(o)?command('teamai workflow resume '+h.run+' --claim')+'<small>'+label('A person takes it over, in a checkout of')+' '+repo+'</small>'
  :command('teamai workflow resume --next')+'<small>'+label('A runner takes it, in a checkout of')+' '+repo+'</small>')
  :h.isMine?'<span class="muted">'+label('This install drives it')+'</span>':command('teamai workflow resume '+h.run+' --claim')+'<small>'+label('Takes it over from')+' '+who+'</small>';
 return '<tr><td>'+name+'<small><span data-verbatim>'+e(h.run)+'</span></small></td><td data-label="'+label('HAND-OFF')+'">'+state+'</td><td data-label="'+label('WHAT IT NEEDS')+'">'+needs+'</td><td data-label="'+label('NEXT STEP')+'">'+next+'</td></tr>';
}
function handoffPanel(rows, local) {
 const body=rows.length?'<div class="table-scroll"><table class="session-table handoffs"><thead><tr>'+['WORKFLOW / RUN','HAND-OFF','WHAT IT NEEDS','NEXT STEP'].map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(h=>handoffRow(h, local)).join('')+'</tbody></table></div>'
  :'<div class="empty"><p>'+label('No run is offered or held on teamai-reports. Offer a running run with teamai workflow publish <run>.')+'</p></div>';
 return '<section class="panel sessions"><div class="panelhead"><h2>'+label('Handed-off runs')+' <span class="count">'+number(rows.length)+'</span></h2><span class="tag">'+label('Hand-offs · teamai-reports branch')+'</span></div>'+body+'</section>';
}
`;

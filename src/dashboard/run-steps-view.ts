import type { HarnessChange } from '../agent-observation.js';

/** What the page calls a change to each part of a harness, in English; `label` translates it. */
const HARNESS_CHANGED: Record<HarnessChange['part'], string> = {
  tool: 'tool changed',
  model: 'model changed',
  effort: 'effort changed',
  role: 'role changed',
  teamRevision: 'team revision changed',
};

/**
 * The Steps of a run's details as browser code: `runStepsTable(steps, run)` renders the `steps` of `/api/workflows/run`,
 * each pass with its harness, what changed in it since the step's previous pass, status and why it was skipped, tokens, answer, how judging
 * stands on it and outcomes. Each cell names its column, so a drawer narrower than the table shows each pass as a card.
 * The dashboard client embeds it after `judgingView`, and so supplies `e`, `t`, `label`, `number`, `runStatus`,
 * `outcomesHtml`, `agentHarness`, `harnessRole` and `passJudgingHtml`.
 * A pass whose attempt ran on a step runtime shows the runtime, how far the attempt got, and what the runtime shows of the
 * place (a label, its link, its fields), under the step, and the attempt holding a login the pass waits for. The handle,
 * the runtime's own id for the place, shows only while the runtime shows nothing of it, and stays in the name's title.
 */
export const runStepsView = `
const RUN_STEP_HEADS=['STEP','PASS','STATUS','TOKENS','ANSWER','SCORES','OUTCOMES'];
const HARNESS_CHANGED=${JSON.stringify(HARNESS_CHANGED)};
function changedValue(part,value) {
 if(value===undefined)return '<span class="muted">'+label('not recorded')+'</span>';
 if(part==='role')return harnessRole(value);
 return part==='teamRevision'?'<span title="'+e(value)+'" data-verbatim>'+e(value.slice(0,7))+'</span>':'<span data-verbatim>'+e(value)+'</span>';
}
function harnessChanged(changes) {
 return changes?.length?'<ul class="harness-changed">'+changes.map(c=>'<li><b>'+label(HARNESS_CHANGED[c.part])+':</b> '+changedValue(c.part,c.from)+' → '+changedValue(c.part,c.to)+'</li>').join('')+'</ul>':'';
}
function runtimeShown(d) {
 if(!d)return '';
 const name=d.url?'<a href="'+e(d.url)+'" target="_blank" rel="noopener noreferrer" data-verbatim>'+e(d.label)+'</a>':'<span data-verbatim>'+e(d.label)+'</span>';
 const fields=Object.entries(d.fields||{}).map(([k,v])=>'<span data-verbatim>'+e(k)+': '+e(v)+'</span>').join(' · ');
 return '<br><b>'+label('Place')+':</b> '+name+(fields?'<br>'+fields:'');
}
function runtimeLine(r) {
 if(!r)return '';
 const handle=r.display?'':'<span data-verbatim>'+(r.handle?e(r.handle):label('no handle yet'))+'</span> · ';
 return '<div class="runtime-line"><b>'+label('Runtime')+':</b> <span title="'+e(r.handle||'')+'" data-verbatim>'+e(r.name)+'</span> · '+handle+label(r.phase)+runtimeShown(r.display)+'</div>';
}
function notClosedLine(r) {
 return r?.closeFailed?'<div class="runtime-line amber"><b>'+label('Not closed')+':</b> <span data-verbatim>'+e(r.closeFailed.code)+'</span> · <span data-verbatim>'+e(r.closeFailed.message)+'</span></div>':'';
}
function loginWaitLine(w) {
 return w?'<div class="runtime-line amber"><b>'+label('Waits for login')+':</b> <span data-verbatim>'+e(w.tool)+'</span> · '+label('held by attempt')+' <span data-verbatim>'+e(w.holder.attempt)+'</span> '+label('of run')+' <span data-verbatim>'+e(w.holder.run)+'</span></div>':'';
}
function runStepsTable(steps, run) {
 return '<div class="table-scroll card-table"><table class="run-steps"><thead><tr>'+RUN_STEP_HEADS.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +steps.map(s=>'<tr>'+['<span data-verbatim>'+e(s.step)+'</span>'+agentHarness(s.harness)+harnessChanged(s.harnessChanges)+runtimeLine(s.runtime)+notClosedLine(s.runtime)+loginWaitLine(s.loginWait),number(s.pass),runStatus(s.status)+(s.message?'<small data-verbatim>'+e(s.message)+'</small>':''),s.tokens?number((s.tokens.input||0)+(s.tokens.output||0)):'—',s.answer?'<span data-verbatim>'+e(s.answer.choice)+'</span><small data-verbatim>'+e(s.answer.channel)+'</small>':'—',passJudgingHtml(s,run),outcomesHtml(s.outcomes)].map((cell,i)=>'<td data-label="'+label(RUN_STEP_HEADS[i])+'">'+cell+'</td>').join('')+'</tr>').join('')
  +'</tbody></table></div>';
}
`;

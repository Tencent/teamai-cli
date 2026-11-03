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
function runStepsTable(steps, run) {
 return '<div class="table-scroll card-table"><table class="run-steps"><thead><tr>'+RUN_STEP_HEADS.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +steps.map(s=>'<tr>'+['<span data-verbatim>'+e(s.step)+'</span>'+agentHarness(s.harness)+harnessChanged(s.harnessChanges),number(s.pass),runStatus(s.status)+(s.message?'<small data-verbatim>'+e(s.message)+'</small>':''),s.tokens?number((s.tokens.input||0)+(s.tokens.output||0)):'—',s.answer?'<span data-verbatim>'+e(s.answer.choice)+'</span><small data-verbatim>'+e(s.answer.channel)+'</small>':'—',passJudgingHtml(s,run),outcomesHtml(s.outcomes)].map((cell,i)=>'<td data-label="'+label(RUN_STEP_HEADS[i])+'">'+cell+'</td>').join('')+'</tr>').join('')
  +'</tbody></table></div>';
}
`;

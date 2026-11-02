/**
 * The Steps of a run's details as browser code: `runStepsTable(steps)` renders the `steps` of `/api/workflows/run`, each
 * pass with its harness, status, tokens, answer, scores and outcomes. Each cell names its column, so a drawer narrower
 * than the table shows each pass as a card. The dashboard client embeds it, and so supplies
 * `e`, `label`, `number`, `runStatus`, `outcomesHtml`, `agentHarness` and `deciderText`.
 */
export const runStepsView = `
const RUN_STEP_HEADS=['STEP','PASS','STATUS','Tokens','ANSWER','SCORES','OUTCOMES'];
function runStepsTable(steps) {
 return '<div class="table-scroll card-table"><table class="run-steps"><thead><tr>'+RUN_STEP_HEADS.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +steps.map(s=>'<tr>'+['<span data-verbatim>'+e(s.step)+'</span>'+agentHarness(s.harness),number(s.pass),runStatus(s.status),s.tokens?number((s.tokens.input||0)+(s.tokens.output||0)):'—',s.answer?'<span data-verbatim>'+e(s.answer.choice)+'</span><small data-verbatim>'+e(s.answer.channel)+'</small>':'—',s.scores?.length?s.scores.map(x=>'<span class="'+(x.passed?'good':'amber')+'" data-verbatim>'+e(x.scorer)+': '+e(x.label)+'</span>'+(x.decidedBy&&x.decidedBy!=='judge'?' '+deciderText(x.decidedBy):'')).join('<br>'):'—',outcomesHtml(s.outcomes)].map((cell,i)=>'<td data-label="'+label(RUN_STEP_HEADS[i])+'">'+cell+'</td>').join('')+'</tr>').join('')
  +'</tbody></table></div>';
}
`;

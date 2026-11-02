/**
 * The browser code that renders an `AgentHarness`, which `agentHarnessOf` in agent-observation.ts builds on the server,
 * as one line, `agentHarness(harness)`: tool · model · effort · role, marking whether the role was the step's own or the
 * member's, with the team revision on hover. `agentHarness(harness, { inlineRevision: true })` ends the line with the
 * short team revision, for a list read without hovering. The runs view shows it under each pass, and the Scorers page
 * beside each failing label. The dashboard client embeds this code, and so supplies `t`, `e` and `label`.
 */
export const agentHarnessView = `
function agentHarness(h, how) {
 if(!h)return '';
 const parts=[h.tool,h.model,h.effort].filter(Boolean).map(x=>'<span data-verbatim>'+e(x)+'</span>');
 if(h.role)parts.push('<span data-verbatim>'+e(h.role.names.join(', '))+'</span> <span class="role-of'+(h.role.of==='step'?' step':'')+'">'+label(h.role.of==='step'?'step role':'member role')+'</span>');
 if(h.teamRevision&&how&&how.inlineRevision)parts.push('<span data-verbatim>'+e(h.teamRevision.slice(0,7))+'</span>');
 return '<small class="harness"'+(h.teamRevision?' title="'+e(t('Team revision')+' '+h.teamRevision)+'"':'')+'>'+parts.join(' · ')+'</small>';
}
`;

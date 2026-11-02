/**
 * The browser code that renders an `AgentHarness`, which `agentHarnessOf` in agent-observation.ts builds on the server,
 * as one line, `agentHarness(harness)`: tool · model · effort · role · short team revision, the full revision on hover.
 * The role carries a marker saying whether it was the step's own or the member's. Each part stays whole and the line
 * wraps between parts. A run's Steps show it under each pass, and the Scorers page beside each failing label.
 * `harnessParts(harness)` is each part but the team revision, for a line that shows the revision its own way. The
 * dashboard client embeds this code, and so supplies `t`, `e` and `label`.
 */
export const agentHarnessView = `
function harnessParts(h) {
 const parts=[h.tool,h.model,h.effort].filter(Boolean).map(x=>'<span class="harness-part" data-verbatim>'+e(x)+'</span>');
 if(h.role)parts.push('<span class="harness-part">'+harnessRole(h.role)+'</span>');
 return parts;
}
function harnessRole(role) { return '<span data-verbatim>'+e(role.names.join(', '))+'</span> <span class="role-of '+e(role.of)+'">'+label(role.of==='step'?'step role':'member role')+'</span>'; }
function agentHarness(h) {
 if(!h)return '';
 const parts=harnessParts(h);
 if(h.teamRevision)parts.push('<span class="harness-part" data-verbatim>'+e(h.teamRevision.slice(0,7))+'</span>');
 return '<span class="harness"'+(h.teamRevision?' title="'+e(t('Team revision')+' '+h.teamRevision)+'"':'')+'>'+parts.join(' · ')+'</span>';
}
`;

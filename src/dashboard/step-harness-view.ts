/**
 * The harness line under each pass of a run's Steps table, as browser code: `stepHarness(harness)` renders the
 * `harness` a step row of `/api/workflows/run` carries as tool · model · effort · role, marking whether the role was the
 * step's own or the member's, with the team revision delivered on hover. The dashboard client embeds it, and so supplies
 * `t`, `e` and `label`.
 */
export const stepHarnessView = `
function stepHarness(h) {
 if(!h)return '';
 const parts=[h.tool,h.model,h.effort].filter(Boolean).map(x=>'<span data-verbatim>'+e(x)+'</span>');
 if(h.role)parts.push('<span data-verbatim>'+e(h.role.names.join(', '))+'</span> <span class="role-of'+(h.role.of==='step'?' step':'')+'">'+label(h.role.of==='step'?'step role':'member role')+'</span>');
 return '<small class="harness"'+(h.teamRevision?' title="'+e(t('Team revision')+' '+h.teamRevision)+'"':'')+'>'+parts.join(' · ')+'</small>';
}
`;

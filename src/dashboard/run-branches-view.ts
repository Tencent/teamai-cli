import type { KeptBranchReason } from '../workflow/types.js';

/** What the page calls the reason a branch stays, in English; `label` translates it. */
const KEPT_BECAUSE: Record<KeptBranchReason, string> = {
  pr: 'Pull request',
  final: 'Final copy',
  unmerged: 'Not held by a kept branch',
  host: 'Checked out by the host',
};

/**
 * The Branches of a settled run's details (#1689) as browser code: `runBranchesHtml(branches)` renders the `branches` of
 * `/api/workflows/run`: what a succeeded run kept and deleted as it settled, what `doctor --fix` removed past
 * `workflows.retention`, or what a failed or cancelled run keeps and from when `doctor --fix` removes it. The dashboard
 * client embeds it, and so supplies `e`, `label`, `when` and `command`.
 */
export const runBranchesView = `
const KEPT_BECAUSE=${JSON.stringify(KEPT_BECAUSE)};
function branchItem(branch, note, cls) { return '<li'+(cls?' class="'+cls+'"':'')+'><code data-verbatim>'+e(branch)+'</code>'+(note?' '+note:'')+'</li>'; }
function branchList(title, items) { return items.length?'<p class="label">'+label(title)+'</p><ul class="run-branches">'+items.join('')+'</ul>':''; }
function runBranchesHtml(b) {
 if(b.state==='kept') {
  const items=b.branches.map(x=>branchItem(x.branch, x.isPullRequest?'<span class="tag">'+label('Pull request')+'</span>':''));
  const never=b.retention.kind==='never';
  const why=never?label('workflows.retention is never, so teamai doctor --fix keeps them.')
   :label('teamai doctor --fix removes them, except pull request branches.')+' '+label('Eligible from')+' '+e(when(b.eligibleAt))+'<br><small data-verbatim>workflows.retention '+e(b.retention.text)+' · '+e(b.retention.file||t('the default'))+'</small>';
  return branchList('Kept for inspection', items)+'<p>'+why+'</p>'+(never?'':command('teamai doctor --fix'));
 }
 const kept=b.kept.map(x=>branchItem(x.branch, '<span class="tag">'+label(KEPT_BECAUSE[x.why])+'</span>'));
 const deleted=b.deleted.map(x=>branchItem(x, '', 'muted'));
 const failed=b.failed.map(x=>branchItem(x.branch, '<small class="amber" data-verbatim>'+e(x.reason)+'</small>'));
 return '<p>'+label(b.by==='success'?'Cleaned up when the run succeeded':'Removed by teamai doctor --fix, past workflows.retention')+' · '+e(when(b.at))+'</p>'
  +branchList('Kept', kept)+branchList('Deleted', deleted)
  +(failed.length?branchList('Not deleted: teamai doctor --fix tries again', failed)+command('teamai doctor --fix'):'');
}
`;

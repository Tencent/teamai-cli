/**
 * The Session sharing panel (#1385) as browser code: `sessionSharingPanel(sharing)` renders what
 * `/api/session-sharing` answers. The dashboard client embeds it, and so supplies `t`, `e`, `label` and `number`.
 */
export const sessionSharingView = `
const sharingModeNames = { attended: 'Attended', unattended: 'Unattended' };
const sharingModeSources = { TEAMAI_MODE: 'set by TEAMAI_MODE', CI: 'set by CI', default: 'neither TEAMAI_MODE nor CI is set' };
const sharingWhen = { attended: 'in the background, once a session has been idle for 6 hours', unattended: 'by teamai score --drain before the job ends' };
const sharingStates = {
 attended: [['active','active'],['finished','kept on this machine'],['waitingToArchive','waiting to be archived'],['archived','archived']],
 unattended: [['waitingForDrain','waiting for a drain'],['finished','kept on this machine'],['waitingToArchive','waiting to be archived'],['archived','archived']]
};
function sharingVerdict(published, scored) { return published&&scored?'Published and scored':published?'Published, not scored':scored?'Scored, not published':'Neither published nor scored'; }
function sharingSource(source) { return source.kind==='setting'?e(source.key):label(source.kind==='http-team'?'an HTTP team repo, which keeps no session archive':'the default'); }
function sharingPolicy(name, cell, note) { return '<dt>'+label(name)+'</dt><dd><b data-verbatim>'+e(cell.policy)+'</b>'+(note?'<small>'+label(note)+'</small>':'')+'<small>'+label('Set by')+' <span data-verbatim>'+sharingSource(cell.source)+'</span></small></dd>'; }
function sharingMode(s, mode) {
 const publish=s.publish[mode], scoring=s.scoring.state==='ok'?s.scoring:null, score=scoring&&scoring.policies[mode];
 const published=publish.policy==='auto', judged=!!score&&score.policy==='auto'&&scoring.scorers.length>0, counts=s.captured[mode], steps=s.stepSessionsWaitingToArchive[mode];
 const scoreRow=score?sharingPolicy('Score',score,score.policy==='ask'?'acts as off for now':score.policy==='auto'&&!scoring.scorers.length?'no scorer sets sessions: true':'')
  :'<dt>'+label('Score')+'</dt><dd><b>off</b><small class="amber">'+label('Scoring is unavailable here')+'</small></dd>';
 return '<article class="sharing-mode'+(s.runMode.mode===mode?' here':'')+'"><h3>'+label(sharingModeNames[mode])+'</h3>'
  +'<p class="verdict'+(published||judged?' on':'')+'">'+label(sharingVerdict(published,judged))+'</p>'
  +(published||judged?'<p class="label">'+label(sharingWhen[mode])+'</p>':'')
  +'<dl class="sharing-policies">'+sharingPolicy('Publish',publish,publish.policy==='ask'?'acts as off for now':'')+scoreRow+'</dl>'
  +'<ul class="sharing-counts">'+sharingStates[mode].map(([key,name])=>'<li class="'+(!counts[key]?'muted':key.startsWith('waiting')?'amber':'')+'"><b>'+number(counts[key])+'</b> '+label(name)+'</li>').join('')
  +(steps?'<li class="amber"><b>'+number(steps)+'</b> '+label(steps===1?'step session waiting to be archived':'step sessions waiting to be archived')+'</li>':'')+'</ul></article>';
}
function sharingNext(s) {
 if(!s.next.length)return '';
 const drainsUnattended=s.next.some(step=>step.mode==='unattended');
 const waiting=[
  [drainsUnattended?s.captured.unattended.waitingForDrain:0,'Unattended sessions waiting for a drain'],
  [s.captured.attended.waitingToArchive+s.captured.unattended.waitingToArchive,'Sessions waiting to be archived'],
  [s.stepSessionsWaitingToArchive.attended+s.stepSessionsWaitingToArchive.unattended,'Step sessions waiting to be archived'],
  [s.pendingLabels,'Labels waiting to be published']
 ].filter(([count])=>count>0);
 return '<div class="sharing-next"><h3>'+label('Waiting')+'</h3><ul>'+waiting.map(([count,what])=>'<li>'+label(what)+label(': ')+'<b>'+number(count)+'</b></li>').join('')+'</ul>'
  +'<p>'+label('Run in a terminal in this workspace:')+'</p>'+s.next.map(step=>'<code class="command">'+step.command.split(' ').map(word=>'<span class="nowrap">'+e(word)+'</span>').join(' ')+'</code>').join('')
  +(s.next.some(step=>step.mode!==s.runMode.mode)?'<p class="label">'+label('A drain finishes and publishes only the sessions of its own run mode, so the command sets TEAMAI_MODE for the sessions that wait.')+'</p>':'')+'</div>';
}
function sharingFacts(s) {
 const rows=[['Archive',s.archive==='teamai-reports'?label('teamai-reports, scrubbed'):'<span class="amber">'+label('None: an HTTP team repo keeps no session archive')+'</span>']];
 rows.push(['Judging',s.scoring.state==='ok'
  ?label('Up to')+' <b>'+number(s.scoring.dailyLimit)+'</b> '+label('sessions a day on this machine (daily_limit)')+'<small>'+(s.scoring.scorers.length?label('Scorers that judge sessions')+label(': ')+'<span data-verbatim>'+s.scoring.scorers.map(e).join(', ')+'</span>':label('No scorer sets sessions: true, so no session is judged.'))+'</small>'
  :'<span class="amber">'+e(s.scoring.reason)+'</span>']);
 if(s.pendingLabels&&!s.next.length)rows.push(['Labels','<b>'+number(s.pendingLabels)+'</b> '+label('pending on this machine')]);
 if(s.unreadTools.length)rows.push(['Never captured','<span data-verbatim>'+s.unreadTools.map(e).join(', ')+'</span><small>'+label('teamai reads no sessions from these tools, so their sessions are never published or scored.')+'</small>']);
 if(s.problems.length)rows.push(['Settings problems','<ul>'+s.problems.map(problem=>'<li class="amber" data-verbatim>'+e(problem)+'</li>').join('')+'</ul>']);
 return '<dl class="sharing-facts">'+rows.map(([name,value])=>'<dt>'+label(name)+'</dt><dd>'+value+'</dd>').join('')+'</dl>';
}
function sessionSharingPanel(s) {
 if(!s.configured)return '';
 const ignored=s.runMode.ignored!==undefined?' · '+label('TEAMAI_MODE ignored')+label(': ')+'<span data-verbatim>'+e(s.runMode.ignored)+'</span>':'';
 return '<section class="panel sharing" aria-labelledby="sharing-title"><div class="panelhead"><h2 id="sharing-title">'+label('Session sharing')+'</h2>'
  +'<span class="tag">'+label('This machine')+label(': ')+label(sharingModeNames[s.runMode.mode])+' · '+label(sharingModeSources[s.runMode.source])+ignored+'</span></div>'
  +'<div class="sharing-modes">'+sharingMode(s,'attended')+sharingMode(s,'unattended')+'</div>'+sharingNext(s)+sharingFacts(s)+'</section>';
}
`;

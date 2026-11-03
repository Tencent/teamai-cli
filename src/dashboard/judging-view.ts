import type { JudgeFailureCode } from '../scorers/label.js';
import { MARK_LAPSES } from '../scorers/marks.js';
import type { Unlabelled } from '../scorers/run-judging.js';

/** What happened when a scorer's judging failed with each code, and what to do about it, in English; `label` translates it. */
const FAILED: Record<JudgeFailureCode, string> = {
  judge_failed: 'The judge step failed or gave no answer, or a scoring step broke, so no label was written. Read the score run\'s failed step, then judge it again.',
  judge_answer_invalid: 'The judge\'s answer did not match the scorer\'s answer schema, so no label was written. Check the scorer\'s labels, then judge it again.',
  judge_tool_unavailable: 'No judge tool on this machine runs the scorer\'s model. Install one, or map the model alias in models/aliases.yaml, then judge it again.',
  check_could_not_run: 'The scorer\'s check could not run on the delivered commit. Fix the check, then judge it again.',
  evidence_empty: 'Nothing of the pass\'s transcript or diff was kept, so there was nothing to judge.',
  lease_expired: 'An earlier teamai\'s judge lease lapsed before anyone answered it.',
};

/** The state line of each reason a scorer has no label, in English; `label` translates it. */
const STATE: Record<Unlabelled['kind'], string> = {
  queued: 'Not judged yet',
  not_sampled: 'Not sampled at',
  judging: 'Judging in',
  waiting_ci: 'Waiting for CI',
  lapsed: 'Lapsed',
  failed: 'Failed',
  expired: 'Expired',
};

/** What a state means when its line alone does not say, in English. */
const MEANS: Partial<Record<Unlabelled['kind'], string>> = {
  waiting_ci: 'The pull request\'s CI has not finished. The next teamai-finished-sessions judges it once CI has.',
  lapsed: 'Score runs ended without labelling it. The next teamai-finished-sessions starts it again, and the fourth lapse closes it.',
  expired: 'Not judged within 14 days of the run\'s last change, so automatic judging no longer starts it.',
};

/** The states a person can act on with a named rescore, which opens a failed or expired mark again. */
const RESCORED: ReadonlyArray<Unlabelled['kind']> = ['lapsed', 'failed', 'not_sampled', 'expired'];

/**
 * How judging stands on a pass, as browser code: `passJudgingHtml(step, run)` renders a pass's labels, each scorer
 * without one and why, the command that judges it again, and the pass's score runs. The dashboard client embeds it, and
 * so supplies `e`, `label`, `number`, `when`, `runStatus`, `deciderText` and the handoff view's `command`. For Workflow Runs,
 * `judgingHealthPanel(health)` renders `judging` of `/api/workflows`; it also needs `language`, `pct` and `kpiCard`.
 */
export const judgingView = `
const JUDGE_FAILED=${JSON.stringify(FAILED)}, JUDGING_STATE=${JSON.stringify(STATE)}, JUDGING_MEANS=${JSON.stringify(MEANS)}, RESCORED=${JSON.stringify(RESCORED)}, MARK_LAPSES=${MARK_LAPSES};
function runLink(id) { return '<button class="link" data-run="'+e(id)+'" data-run-source="local"><span data-verbatim>'+e(id)+'</span></button>'; }
function judgingState(state) {
 const line='<span class="'+(state.kind==='queued'||state.kind==='judging'?'':state.kind==='not_sampled'?'muted':'amber')+'">'+label(JUDGING_STATE[state.kind])+'</span>';
 if(state.kind==='not_sampled')return line+' '+number(state.samplingRate)+'%';
 if(state.kind==='judging')return line+' '+runLink(state.run)+' '+label('since')+' '+e(when(state.since));
 if(state.kind==='lapsed')return line+' '+number(state.lapses)+'/'+number(MARK_LAPSES)+' · '+label('expires')+' '+e(when(state.expiresAt));
 if(state.kind==='failed')return line+' · <span data-verbatim>'+e(state.code)+'</span>';
 return line;
}
function judgingMeans(state) { const means=state.kind==='failed'?JUDGE_FAILED[state.code]:JUDGING_MEANS[state.kind]; return means?'<small>'+label(means)+'</small>':''; }
function judgingWhy(state, run, step, pass, scorer) { return judgingState(state)+judgingMeans(state)+(RESCORED.includes(state.kind)?command('teamai score --run '+run+' --step '+step+' --pass '+pass+' --scorer '+scorer):''); }
function passJudgingHtml(s, run) {
 const labelled=(s.scores||[]).map(x=>'<li><span class="'+(x.passed?'good':'amber')+'" data-verbatim>'+e(x.scorer)+': '+e(x.label)+'</span> · '+label('score')+' '+number(x.score)+(x.decidedBy?' '+deciderText(x.decidedBy):'')+'</li>');
 const missing=(s.unlabelled||[]).map(u=>'<li class="judging-missing"><span data-verbatim>'+e(u.scorer)+':</span> '+judgingWhy(u.state,run,s.step,s.pass,u.scorer)+'</li>');
 if(!labelled.length&&!missing.length)return '—';
 const runs=s.scoreRuns?.length?'<small class="score-runs">'+label('Score runs')+': '+s.scoreRuns.map(r=>runLink(r.run)+' '+runStatus(r.status)).join(' · ')+'</small>':'';
 return '<ul class="pass-judging">'+labelled.join('')+missing.join('')+'</ul>'+runs;
}
const JUDGING_DECIDERS=['judge','check','ci','protected','hand'];
const MISSING_HEADS=['RUN','PASS','SCORER','WHY'];
function launchDays(sessions) {
 const limit=sessions.dailyLimit, most=Math.max(1,...sessions.days.map(d=>d.launches));
 const days=sessions.days.map(d=>{ const full=limit===undefined?d.launches/most:limit?Math.min(1,d.launches/limit):0, day=new Date(d.day+'T12:00:00').toLocaleDateString(language,{month:'numeric',day:'numeric'}); return '<div class="launch-day'+(limit!==undefined&&d.launches>=limit?' at-limit':'')+'" title="'+e(d.day)+'"><span class="launch-bar" aria-hidden="true"><span style="height:'+Math.round(full*100)+'%"></span></span><b>'+number(d.launches)+'</b><small>'+e(day)+'</small></div>'; });
 return '<section class="launches"><h3>'+label('Session launches per day')+(limit===undefined?'':' <span class="tag" data-verbatim>daily_limit '+number(limit)+'</span>')+'</h3><div class="launch-days">'+days.join('')+'</div></section>';
}
function missingTable(missing) {
 if(!missing.length)return '<div class="empty"><p>'+label('Every scored pass of the runs listed here has its labels.')+'</p></div>';
 return '<div class="table-scroll card-table"><table class="judging-missing-labels"><thead><tr>'+MISSING_HEADS.map(x=>'<th>'+label(x)+'</th>').join('')+'</tr></thead><tbody>'
  +missing.map(m=>'<tr>'+['<button class="link" data-run="'+e(m.run)+'" data-run-source="local"><span data-verbatim>'+e(m.alias||m.workflow)+'</span></button><small data-verbatim>'+e(m.run)+'</small>','<span data-verbatim>'+e(m.step)+'</span> #'+number(m.pass),'<span data-verbatim>'+e(m.scorer)+'</span>',judgingWhy(m.state,m.run,m.step,m.pass,m.scorer)].map((cell,i)=>'<td data-label="'+label(MISSING_HEADS[i])+'">'+cell+'</td>').join('')+'</tr>').join('')
  +'</tbody></table></div>';
}
function judgingHealthPanel(h) {
 const l=h.labels, s=h.states, amber=n=>'<span class="'+(n?'amber':'')+'">'+number(n)+'</span>';
 const deciders=JUDGING_DECIDERS.filter(by=>l.byDecider[by]).map(by=>deciderText(by)+' '+number(l.byDecider[by])).join(' ');
 const failures=h.failures.length?'<ul class="judging-failures">'+h.failures.map(f=>'<li><span class="amber" data-verbatim>'+e(f.code)+'</span> '+number(f.count)+'<small>'+label(JUDGE_FAILED[f.code])+'</small></li>').join('')+'</ul>':'';
 return '<section class="panel judging-health"><div class="panelhead"><h2>'+label('Judging on this machine')+'</h2><span class="tag">'+label('Local · last 7 days')+'</span></div>'
  +'<div class="kpis judging-kpis">'
  +kpiCard(label('Labels this week'),number(l.total),pct(l.total?l.passed/l.total:null)+' '+label('passed'))
  +kpiCard(label('Judge tokens this week'),number(l.inputTokens+l.outputTokens),number(l.inputTokens)+' '+label('input')+' · '+number(l.outputTokens)+' '+label('output'))
  +kpiCard(label('Judging now'),number(s.judging),number(s.queued)+' '+label('Not judged yet'))
  +kpiCard(label('Waiting for CI'),number(s.waiting_ci))
  +kpiCard(label('Lapsed'),amber(s.lapsed),number(s.expired)+' '+label('Expired'))
  +kpiCard(label('Failed'),amber(s.failed),h.failures.map(f=>'<span data-verbatim>'+e(f.code)+'</span> '+number(f.count)).join(' · '))
  +'</div><div class="judging-detail">'
  +(deciders?'<p class="judging-deciders">'+label('Decided by')+' '+deciders+'</p>':'')
  +failures+launchDays(h.sessions)+'</div>'
  +'<h3 class="judging-missing-title">'+label('Missing labels')+'</h3>'+missingTable(h.missing)
  +'</section>';
}
`;

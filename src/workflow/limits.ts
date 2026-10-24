/**
 * The limits of a run: the deadlines of the run, its steps and their leases, and the tokens its workflows spend
 * against their budgets. Both count from where the run or the workflow step recorded that its limits start.
 */
import { isItem } from './fan-out.js';
import { isUnder, runPasses } from './loop.js';
import { topScope, type Scope } from './scope.js';
import { stopAttempt, stopWhere, timeOut, type LeasedStep, type LimitsFrom, type StepState, type StoppedAttempt } from './step-state.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import type { WorkflowResult } from './engine.js';
import type { RunState, WorkflowStep } from './types.js';

function after(from: string, ms: number): string {
  return new Date(Date.parse(from) + ms).toISOString();
}

function passed(deadline: string, now: string): boolean {
  return Date.parse(deadline) <= Date.parse(now);
}

/**
 * When instance `state` of `step`, leased or started at `now`, must settle: by its own `timeout`, and when it runs a
 * workflow file, by that file's if it is shorter. A `for_each` step's `timeout` bounds the whole fan-out, so it is its
 * own instance's alone; each item runs the file, so the file's is the item's.
 */
export function ownDeadline(run: RunState, state: StepState, step: WorkflowStep, now: string): string | undefined {
  const item = step.forEach !== undefined && isItem(state);
  const file = typeof step.workflow === 'string' && (!step.forEach || item) ? run.workflows?.[step.workflow]?.timeout : undefined;
  const limits = [item ? undefined : step.timeout, file].filter((ms) => ms !== undefined);
  return limits.length > 0 ? after(now, Math.min(...limits)) : undefined;
}

/**
 * The input and output tokens spent by the steps `under` selects: every pass, current or archived,
 * and every released attempt. Cached input is shown, not budgeted: tools report it inside or beside input differently.
 */
export function spentTokens(run: RunState, under: (id: string) => boolean): number {
  const used = [...runPasses(run), ...run.releasedTokens ?? []].filter((entry) => under(entry.step));
  return used.reduce((sum, { tokens }) => sum + budgeted(tokens), 0);
}

function budgeted(tokens: TokenUsage | undefined): number {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0);
}

/**
 * Counts the tokens a stopped attempt's driver reported after the stop, and forgets the attempt, so they count once. A
 * budget that started counting at or after the stop, such as the run's once a retry reopened it, did not run the
 * attempt, so the tokens join what it counts from rather than what it spent.
 */
export function countLateTokens(run: RunState, stopped: StoppedAttempt, tokens: TokenUsage): void {
  run.stoppedAttempts = run.stoppedAttempts?.filter((entry) => entry.attempt !== stopped.attempt);
  (run.releasedTokens ??= []).push({ step: stopped.step, attempt: stopped.attempt, tokens });
  const later = (from: LimitsFrom | undefined): void => {
    if (from && Date.parse(from.at) >= Date.parse(stopped.stoppedAt)) from.tokens += budgeted(tokens);
  };
  later(run.limitsFrom);
  for (const step of run.steps) if (step.status === 'running' && isUnder(step.id)(stopped.step)) later(step.limitsFrom);
}

/**
 * What a workflow step, or `for_each` item, starting at `now` records: when its timeout ends it, and where the budget of
 * what it runs counts from. What it ran before, such as an earlier pass a loop archived, is not counted again.
 */
export function startLimits(run: RunState, state: StepState, step: WorkflowStep, now: string): { expiresAt?: string; limitsFrom: LimitsFrom } {
  const expiresAt = ownDeadline(run, state, step, now);
  return { ...(expiresAt !== undefined ? { expiresAt } : {}), limitsFrom: { at: now, tokens: spentTokens(run, isUnder(state.id)) } };
}

/** Where the limits of a workflow of the run count from: the run's, or those its running step recorded when it started. */
function limitsFrom(run: RunState, scope: Scope): LimitsFrom {
  const recorded = scope.runner ? (scope.runner.status === 'running' ? scope.runner.limitsFrom : undefined) : run.limitsFrom;
  return recorded ?? { at: run.createdAt, tokens: 0 };
}

/** The tokens a workflow of the run has spent against its budget: what it spent since its limits started counting. */
export function budgetSpent(run: RunState, scope: Scope): number {
  return spentTokens(run, (id) => id.startsWith(scope.prefix)) - limitsFrom(run, scope).tokens;
}

/** The tokens the items of a `for_each` step have spent together since the step started, against the step's own budget. */
export function itemsSpent(run: RunState, state: StepState): number {
  return spentTokens(run, isUnder(state.id)) - (state.status === 'running' ? state.limitsFrom?.tokens ?? 0 : 0);
}

/** The run's own deadline, from when it started or a retry reopened it. */
function runDeadline(run: RunState): string | undefined {
  return run.definition.timeout === undefined ? undefined : after(limitsFrom(run, topScope(run)).at, run.definition.timeout);
}

/** When a lease ends: the first of its own deadline, that of every running step it is under, fan-out items included, and the run's. */
export function leaseDeadline(run: RunState, state: LeasedStep): string | undefined {
  const deadlines = [
    state.lease.expiresAt,
    runDeadline(run),
    ...run.steps.map((step) => (step.status === 'running' && isUnder(step.id)(state.id) ? step.expiresAt : undefined)),
  ].filter((deadline) => deadline !== undefined);
  return deadlines.sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

/**
 * Applies every deadline `now` has passed, outer first, so what an expired step stops does not time out on its own.
 * The run's own deadline cancels every open step and settles the run. A step's fails it with `timeout`, so a step that
 * reads its outcome can recover, and cancels what it runs. Applying it again with the same `now` changes nothing.
 */
export function expire(run: RunState, now: string): WorkflowResult | undefined {
  const runEnds = runDeadline(run);
  if (runEnds !== undefined && passed(runEnds, now)) {
    const failure = { code: 'timeout', message: `Run ${run.id} passed its timeout at ${runEnds}` };
    stopWhere(run, () => true, failure, run.revision, now);
    return { outcome: 'failed', failure, settledAt: run.revision };
  }
  // A step's instance comes before the instances of what it runs, so an outer deadline applies first.
  for (const state of run.steps) {
    const expiresAt = state.status === 'running' ? state.expiresAt : state.status === 'leased' ? state.lease.expiresAt : undefined;
    if (expiresAt === undefined || !passed(expiresAt, now)) continue;
    const failure = { code: 'timeout', message: `Step "${state.id}" passed its timeout at ${expiresAt}` } as const;
    if (state.status === 'running') stopWhere(run, isUnder(state.id), { code: 'timeout', message: `Cancelled: ${failure.message}` }, run.revision, now);
    else if (state.status === 'leased') stopAttempt(run, state, now);
    if (state.status === 'running' || state.status === 'leased') timeOut(state, failure, run.revision);
  }
  return undefined;
}

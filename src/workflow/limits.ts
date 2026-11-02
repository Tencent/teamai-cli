/**
 * The limits of a run: the deadlines of the run, its steps and their leases, and the tokens its workflows spend
 * against their budgets. Both count from where the run or the workflow step recorded that its limits start.
 */
import { isItem } from './fan-out.js';
import { isUnder, passesWithin, runPasses } from './loop.js';
import type { Limit, TurnLimits } from './requirements.js';
import { stepDefinitions, topScope, type GrantedAllowance, type Scope } from './scope.js';
import { passOf, settled, stopAttempt, stopWhere, timeOut, type LeasedStep, type LimitsFrom, type StepState, type StoppedAttempt } from './step-state.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import type { WorkflowResult } from './engine.js';
import { isWorkflowFile, workflowRunBy, type RunState, type WorkflowStep } from './types.js';

function after(from: string, ms: number): string {
  return new Date(Date.parse(from) + ms).toISOString();
}

function passed(deadline: string, now: string): boolean {
  return Date.parse(deadline) <= Date.parse(now);
}

/**
 * When instance `state` of `step`, leased or started at `now`, must settle: by its own `timeout`, and when it runs a
 * workflow file, by that file's if it is shorter. A `for_each` step's `timeout` bounds the whole fan-out, so it is its
 * own instance's alone; each item runs the file, so the file's is the item's. Under `on_limit: end_turn` the step's
 * own `timeout` is no deadline: it ends a prompt's turn, or is the allowance a workflow step's prompts spend.
 */
export function ownDeadline(run: RunState, state: StepState, step: WorkflowStep, now: string): string | undefined {
  const item = step.forEach !== undefined && isItem(state);
  const runs = !step.forEach || item ? workflowRunBy(run, step, state.id.slice(0, state.id.lastIndexOf('.') + 1)) : undefined;
  const file = runs && isWorkflowFile(runs) ? runs.timeout : undefined;
  const limits = [item || step.onLimit === 'end_turn' ? undefined : step.timeout, file].filter((ms) => ms !== undefined);
  return limits.length > 0 ? after(now, Math.min(...limits)) : undefined;
}

/**
 * The input and output tokens spent by the steps `under` selects: every pass, current or archived,
 * and every released attempt. Cached input is shown, not budgeted: tools report it inside or beside input differently.
 */
export function spentTokens(run: RunState, under: (id: string) => boolean): number {
  // A step with no pass yet spent nothing, so `under` reads only the others.
  return spentBy(run.steps.filter((state) => (settled(state) || state.passes?.length) && under(state.id)), run, under);
}

/** The tokens `states` spent, and those archived or released under `under`. A step with no pass yet is not parsed. */
function spentBy(states: readonly StepState[], run: RunState, under: (id: string) => boolean): number {
  let spent = 0;
  for (const state of states) {
    for (const pass of state.passes ?? []) spent += budgeted(pass.tokens);
    const current = settled(state) ? passOf(state) : undefined;
    if (current) spent += budgeted(current.tokens);
  }
  for (const entry of [...run.archive ?? [], ...run.releasedTokens ?? []]) if (under(entry.step)) spent += budgeted(entry.tokens);
  return spent;
}

/**
 * The tokens spent under instance `state`. Its instances sit right after it in the run's steps, since a workflow's and a
 * fan-out's are inserted right after the step that runs them (`insertChildren`, `addItems`), so only they are read:
 * every workflow step that starts counts this.
 */
function spentUnder(run: RunState, state: StepState): number {
  const under = isUnder(state.id);
  const at = run.steps.indexOf(state) + 1;
  let end = at;
  while (end < run.steps.length && under(run.steps[end]?.id ?? '')) end += 1;
  return spentBy(run.steps.slice(at, end), run, under);
}

/** What a budget counts of `tokens`: input plus output. Cached input is shown, never counted. */
export function budgeted(tokens: TokenUsage | undefined): number {
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
  return { ...(expiresAt !== undefined ? { expiresAt } : {}), limitsFrom: { at: now, tokens: spentUnder(run, state) } };
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

/**
 * The run's own deadline: the shorter of its workflow's `timeout` and `workflow start --timeout`, from when it started or
 * a retry reopened it. While its `finally` steps run, the deadline they have.
 */
export function runDeadline(run: RunState): string | undefined {
  if (run.finalizing) return run.finalizing.until;
  const limits = [run.definition.timeout, run.timeout].filter((ms) => ms !== undefined);
  return limits.length === 0 ? undefined : after(limitsFrom(run, topScope(run)).at, Math.min(...limits));
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
    const failure = { code: 'timeout', message: run.finalizing ? `Run ${run.id} passed the deadline of its finally steps at ${runEnds}` : `Run ${run.id} passed its timeout at ${runEnds}` };
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

/** What an allowance has left once the prompt turns inside its step's current pass spent their measured duration and tokens. */
export interface Allowance {
  step: string;
  timeoutMs?: number;
  tokens?: number;
  /** Nothing is left, or a turn ended at what was. */
  spent: boolean;
}

/** What `granted` has left. Commands spend none of it. */
function allowanceLeft(run: RunState, granted: GrantedAllowance): Allowance {
  const state = run.steps.find((item) => item.id === granted.step);
  if (state?.status !== 'running') return { ...granted, spent: true };
  const definitionOf = stepDefinitions(run);
  const turns = passesWithin(run, runPasses(run), state.id, state.pass ?? 1).filter((pass) => definitionOf(pass.step)?.prompt !== undefined);
  const timeoutMs = granted.timeoutMs === undefined ? undefined : granted.timeoutMs - turns.reduce((sum, pass) => sum + (pass.durationMs ?? 0), 0);
  const tokens = granted.tokens === undefined ? undefined : granted.tokens - itemsSpent(run, state);
  const spent = state.allowanceSpent === true || (timeoutMs !== undefined && timeoutMs <= 0) || (tokens !== undefined && tokens <= 0);
  return { step: granted.step, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(tokens !== undefined ? { tokens } : {}), spent };
}

/** The steps whose allowances, among those workflow `scope` runs inside, are spent: nothing pending under them starts. */
export function spentAllowances(run: RunState, scope: Scope): string[] {
  return scope.allowances.flatMap((granted) => (allowanceLeft(run, granted).spent ? [granted.step] : []));
}

/**
 * The step whose allowance, among those workflow `scope` runs inside, a leased prompt turn is spending, or undefined.
 * Another prompt under it waits, so it is leased what that turn left rather than what was left before it.
 */
export function allowanceInUse(run: RunState, scope: Scope): string | undefined {
  const definitionOf = stepDefinitions(run);
  return scope.allowances.find((granted) => run.steps.some((state) => state.status === 'leased'
    && isUnder(granted.step)(state.id) && definitionOf(state.id)?.prompt !== undefined))?.step;
}

/** The smallest of `limits`, or undefined when none is set. An allowance with nothing left leases nothing more. */
function least(...limits: ReadonlyArray<number | undefined>): number | undefined {
  const set = limits.filter((limit) => limit !== undefined);
  return set.length > 0 ? Math.min(...set) : undefined;
}

/**
 * The limits that end the turn of prompt `step` in workflow `scope`: its own `timeout`, `max_turns` and `budget` under
 * `on_limit: end_turn`, each lowered to what the allowances it is inside have left. Undefined when nothing ends its turn.
 */
export function turnLimits(run: RunState, scope: Scope, step: WorkflowStep): TurnLimits | undefined {
  const own = step.onLimit === 'end_turn';
  if (step.prompt === undefined || (!own && scope.allowances.length === 0)) return undefined;
  const allowances = scope.allowances.map((granted) => allowanceLeft(run, granted));
  const timeoutMs = least(own ? step.timeout : undefined, ...allowances.map((allowance) => allowance.timeoutMs));
  const tokens = least(own ? step.budget?.tokens : undefined, ...allowances.map((allowance) => allowance.tokens));
  const maxTurns = own ? step.maxTurns : undefined;
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(tokens !== undefined ? { budget: { tokens } } : {}), onLimit: 'end_turn',
  };
}

/** What `limit` is in `limits`, and what of it `allowance` has left. */
function limitOf(limit: Limit, limits: TurnLimits): { leased?: number; left: (allowance: Allowance) => number | undefined } {
  switch (limit) {
    case 'timeout':
      return { leased: limits.timeoutMs, left: (allowance) => allowance.timeoutMs };
    case 'budget':
      return { leased: limits.budget?.tokens, left: (allowance) => allowance.tokens };
    // No allowance caps turns.
    case 'max_turns':
      return { left: () => undefined };
    default: {
      const unhandled: never = limit;
      return unhandled;
    }
  }
}

/**
 * Spends the allowances, among those workflow `scope` runs inside, whose remainder set `limit` on a prompt lease that
 * carried `limits`: a turn ended at what an allowance had left spends it, whatever it measured. A turn ended at a
 * limit of its own below every remainder spends none.
 */
export function spendAllowances(run: RunState, scope: Scope, limits: TurnLimits, limit: Limit): void {
  const { leased, left } = limitOf(limit, limits);
  if (leased === undefined) return;
  for (const granted of scope.allowances) {
    const remainder = left(allowanceLeft(run, granted));
    const state = run.steps.find((item) => item.id === granted.step);
    if (state?.status === 'running' && remainder !== undefined && remainder <= leased) state.allowanceSpent = true;
  }
}

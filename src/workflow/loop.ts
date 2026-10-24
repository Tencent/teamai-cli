/**
 * Loops. A step with `loop` runs its range again after it succeeds: `back_to`, the step, and every step between them.
 * A workflow with `loop` runs all of its steps again, round after round. These rules are shared by pull, which rejects
 * loops a run could not settle, and by the engine, which settles them.
 */
import { branchNames, type ExpressionPass, type ExpressionStep } from './expression.js';
import { endLoop, exhaust, nextRound, passOf, repend, type StepPass, type StepState } from './step-state.js';
import type { RunState, StepLoop, WorkflowFailure, WorkflowLoop, WorkflowStep } from './types.js';

type LoopStep = Pick<WorkflowStep, 'id' | 'needs' | 'loop' | 'end' | 'break' | 'forEach'>;

/** The steps of one workflow that loops run again, and what waits for those loops. */
export interface StepLoops {
  /** Each loop's range, by the id of the step that owns it. */
  ranges: Map<string, Set<string>>;
  /** The loop owners a step waits for besides what it needs and reads: the loops outside whose range it needs or reads a step inside it. */
  waitsFor(id: string, reads: Iterable<string>): string[];
  /**
   * The steps a step reads in their previous pass: those in its own range that need it, directly or not. Such a read
   * sees the target's latest archived pass, nothing on pass 1, and never waits.
   */
  previous(id: string): Set<string>;
}

/** A step loop pull rejects, at the key of the step it is reported on. */
export interface LoopProblem {
  id: string;
  key: 'loop' | 'loop.back_to' | 'needs' | 'break' | 'for_each';
  message: string;
}

/** The ids `id` needs, directly or through their needs. */
export function ancestors(needs: Map<string, string[]>, id: string): Set<string> {
  const found = new Set<string>();
  const pending = [...needs.get(id) ?? []];
  for (let need = pending.pop(); need !== undefined; need = pending.pop()) {
    if (found.has(need)) continue;
    found.add(need);
    pending.push(...needs.get(need) ?? []);
  }
  return found;
}

/** R(X): `back_to`, the owner X, and every step that needs `back_to` and that X needs, directly or not. */
function rangeOf(needs: Map<string, string[]>, owner: string, backTo: string): Set<string> {
  const before = ancestors(needs, owner);
  return new Set([backTo, ...[...before].filter((id) => ancestors(needs, id).has(backTo)), owner]);
}

export function stepLoops(steps: LoopStep[]): StepLoops {
  const needs = new Map(steps.map((step) => [step.id, step.needs ?? []]));
  const ranges = new Map(steps.flatMap((step) => (step.loop ? [[step.id, rangeOf(needs, step.id, step.loop.backTo)] as const] : [])));
  return {
    ranges,
    waitsFor: (id, reads) => {
      const used = [...needs.get(id) ?? [], ...reads];
      return [...ranges].filter(([, range]) => !range.has(id) && used.some((read) => range.has(read))).map(([owner]) => owner);
    },
    previous: (id) => {
      const range = [...ranges.values()].find((members) => members.has(id)) ?? [];
      return new Set([...range].filter((member) => ancestors(needs, member).has(id)));
    },
  };
}

/** The first cycle through `edges`, starting at the id listed first, or undefined when there is none. */
export function firstCycle(ids: string[], edges: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 'open' | 'closed'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 'open');
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 'open') return [...path.slice(path.indexOf(next)), next];
      const found = state.has(next) || !edges.has(next) ? undefined : visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'closed');
    return undefined;
  };
  for (const id of ids) {
    const found = state.has(id) ? undefined : visit(id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The step loops and breaks of one workflow that pull rejects. `reads` holds the steps of this workflow each step reads
 * in the current pass, and `looping` is whether the workflow has a loop of its own. A needs cycle is reported elsewhere,
 * so a wait cycle is reported only when `needs` alone has none.
 */
export function loopProblems(steps: LoopStep[], reads: Map<string, Set<string>>, looping: boolean): LoopProblem[] {
  const problems: LoopProblem[] = [];
  const needs = new Map(steps.map((step) => [step.id, step.needs ?? []]));
  const { ranges, waitsFor } = stepLoops(steps);
  const claimed = new Map<string, string>();
  for (const step of steps) {
    const other = step.forEach && (['loop', 'end', 'break'] as const).find((key) => step[key] !== undefined);
    if (!other) continue;
    const why = other === 'loop' ? 'put the loop in a sub-workflow' : 'a step that runs once per item cannot end its workflow';
    problems.push({ id: step.id, key: 'for_each', message: `step "${step.id}" has for_each and ${other}; ${why}` });
  }
  for (const step of steps) {
    if (!step.loop || step.forEach) continue;
    if (looping) {
      problems.push({ id: step.id, key: 'loop', message: `step "${step.id}" has loop in a workflow that loops; put one of the two loops in a sub-workflow` });
      continue;
    }
    const { backTo } = step.loop;
    if (backTo !== step.id && !ancestors(needs, step.id).has(backTo)) {
      problems.push({ id: step.id, key: 'loop.back_to', message: `step "${step.id}" loop.back_to is "${backTo}", which is not "${step.id}" or a step it needs, directly or through its needs` });
      continue;
    }
    if (step.end !== undefined) {
      problems.push({ id: step.id, key: 'loop', message: `step "${step.id}" has loop and end; a step that ends its workflow cannot run again` });
      continue;
    }
    const range = ranges.get(step.id) ?? new Set<string>();
    const shared = [...range].find((id) => claimed.has(id));
    if (shared !== undefined) {
      problems.push({
        id: step.id,
        key: 'loop',
        message: `step "${step.id}" loop runs "${shared}" again, which the loop of step "${claimed.get(shared)}" also runs; loops in one workflow share no step, so put the inner one in a sub-workflow`,
      });
      continue;
    }
    for (const id of range) claimed.set(id, step.id);
  }
  for (const step of steps) {
    const owner = claimed.get(step.id);
    if (step.break === undefined || step.forEach || owner === undefined) continue;
    problems.push({ id: step.id, key: 'break', message: `step "${step.id}" has break inside the loop of step "${owner}", where its if and while already end the loop` });
  }
  if (problems.length > 0 || firstCycle(steps.map((step) => step.id), needs)) return problems;
  const waits = new Map(steps.map((step) => [step.id, [...needs.get(step.id) ?? [], ...waitsFor(step.id, reads.get(step.id) ?? [])]]));
  const cycle = firstCycle(steps.map((step) => step.id), waits);
  if (cycle) {
    problems.push({
      id: cycle[0]!,
      key: 'needs',
      message: `step "${cycle[0]}" waits in a cycle: ${cycle.join(' -> ')}; a step that needs or reads a step inside a loop waits until the loop ends`,
    });
  }
  return problems;
}

/** A loop owner whose loop runs no more in this activation: skipped, failed or cancelled, or succeeded and decided final. */
export function loopSettled(owner: StepState | undefined): boolean {
  if (!owner) return false;
  if (owner.status === 'succeeded') return owner.loopFinal === true;
  return owner.status === 'skipped' || owner.status === 'failed' || owner.status === 'cancelled';
}

function exhausted(owner: StepState, loop: StepLoop): WorkflowFailure {
  return { code: 'loop_exhausted', message: `Loop of step "${owner.id}" is exhausted: it ran ${loop.maxIterations} times, its max_iterations` };
}

/**
 * Decides, once per run of a succeeded loop owner, what follows it. `holds` is its `while`, or true when it has none.
 * The loop ends when `while` is false. While it holds, the range runs again, unless the owner has already run
 * `max_iterations` times: then it fails `loop_exhausted` and keeps its outputs. A loop without `while` always runs
 * again, and `exhaustedAtStart` stops the run that would go past the limit.
 */
export function decideStepLoop(run: RunState, owner: Extract<StepState, { status: 'succeeded' }>, loop: StepLoop, holds: boolean, range: StepState[]): void {
  const runs = (owner.iteration ?? 0) + 1;
  if (!holds) {
    endLoop(owner, runs);
  } else if (loop.while !== undefined && runs >= loop.maxIterations) {
    exhaust(owner, exhausted(owner, loop), owner.settledAt, runs);
  } else {
    for (const state of range) {
      archiveUnder(run, state.id);
      repend(state, state === owner ? runs : undefined);
    }
  }
}

/**
 * A loop owner about to start an action it has already run `max_iterations` times fails instead, with the outputs of
 * its latest pass. Returns whether it did.
 */
export function exhaustedAtStart(owner: Extract<StepState, { status: 'pending' }>, loop: StepLoop, settledAt: number): boolean {
  if ((owner.iteration ?? 0) < loop.maxIterations) return false;
  exhaust(owner, exhausted(owner, loop), settledAt);
  return true;
}

/**
 * Decides what follows a round of a looping workflow that reached no end and no break. `holds` is its `while`, or true
 * when it has none. The workflow ends when `while` is false. While it holds, every step of the workflow runs again in
 * the next round, kept on `runner`, the step that runs the workflow, or on the run at the top. After `max_iterations`
 * rounds, the workflow fails `loop_exhausted` instead, with what its last round returned.
 */
export function decideRound(
  run: RunState,
  runner: StepState | undefined,
  loop: WorkflowLoop,
  holds: boolean,
  label: string,
  states: StepState[],
): 'ended' | 'again' | WorkflowFailure {
  const round = (runner ? runner.round : run.round) ?? 1;
  if (!holds) return 'ended';
  if (round >= loop.maxIterations) {
    return { code: 'loop_exhausted', message: `Loop of ${label} is exhausted: it ran ${loop.maxIterations} rounds, its max_iterations` };
  }
  for (const state of states) {
    archiveUnder(run, state.id);
    repend(state);
  }
  if (!runner) run.round = round + 1;
  else if (runner.status === 'running') nextRound(runner);
  return 'again';
}

/** Matches descendants of a step, including fan-out items and nested workflow instances. */
export function isUnder(path: string): (id: string) => boolean {
  return (id) => id.startsWith(`${path}.`) || id.startsWith(`${path}[`);
}

/** Moves the instances under a step, those of the workflow it ran, from the run's steps to its archive, with every pass they had. */
export function archiveUnder(run: RunState, path: string): void {
  const under = isUnder(path);
  const within = { step: path, pass: run.steps.find((state) => state.id === path)?.pass ?? 1 };
  for (const state of run.steps) {
    if (!under(state.id)) continue;
    const current = passOf(state);
    for (const pass of [...state.passes ?? [], ...(current ? [current] : [])]) (run.archive ??= []).push({ step: state.id, ...pass, within });
  }
  run.steps = run.steps.filter((state) => !under(state.id));
}

/** A pass of the run, current or archived, with the path of the instance it belongs to. */
export type RunPass = StepPass & { step: string; within?: { step: string; pass: number } };

/** Every pass of the run, current and archived, with each step's current pass as `current` reads it. */
export function runPasses(run: RunState, currentPass: (state: StepState) => StepPass | undefined = passOf): RunPass[] {
  return [
    ...run.steps.flatMap((state) => {
      const current = currentPass(state);
      return [...state.passes ?? [], ...(current ? [current] : [])].map((pass) => ({ ...pass, step: state.id }));
    }),
    ...(run.archive ?? []),
  ];
}

/** The commits a pass changed, or read, from the one it started at to the one it left. */
export function passRange(pass: StepPass): { branch: string; from: string; to: string; source: 'changes' | 'read' } | undefined {
  if (pass.changes) return { branch: pass.changes.branch, from: pass.changes.from, to: pass.changes.to, source: 'changes' };
  if (pass.read) return { branch: pass.read.branch, from: pass.read.base, to: pass.read.commit, source: 'read' };
  return undefined;
}

/**
 * The pass of `passes` that settled first. Passes record no settle time, so the order comes from what they record: a
 * step's passes settle in pass order, and a pass whose range starts where another's non-empty range ends settled after
 * it. Of the passes nothing orders, the first listed.
 */
export function firstSettled<T extends RunPass>(passes: readonly T[]): T | undefined {
  const before = (earlier: T, later: T): boolean => {
    if (earlier.step === later.step) return earlier.pass < later.pass;
    const [from, to] = [passRange(earlier), passRange(later)];
    return from !== undefined && to !== undefined && from.from !== from.to && from.to === to.from;
  };
  return passes.find((pass) => !passes.some((other) => other !== pass && before(other, pass)));
}

/**
 * The passes inside pass `pass` of step `step`, among `all`: those under it while that pass is current, and archived
 * ones whose `within` leads to it, through the passes of nested workflows a loop archived on the way.
 */
export function passesWithin(run: RunState, all: readonly RunPass[], step: string, pass: number): RunPass[] {
  const current = run.steps.find((state) => state.id === step)?.pass ?? 1;
  const under = isUnder(step);
  const reaches = (child: RunPass, seen: Set<RunPass>): boolean => {
    if (seen.has(child)) return false;
    seen.add(child);
    const { within } = child;
    if (!within) return current === pass && run.steps.some((state) => state.id === child.step);
    if (within.step === step && within.pass === pass) return true;
    return all.some((parent) => parent.step === within.step && parent.pass === within.pass && reaches(parent, seen));
  };
  return all.filter((child) => under(child.step) && reaches(child, new Set()));
}

/** The pass a new instance at `path` starts at: after every pass the archive holds for that path, so a pass id is never reused. */
export function firstPass(run: RunState, path: string): number {
  return 1 + Math.max(0, ...(run.archive ?? []).filter((entry) => entry.step === path).map((entry) => entry.pass));
}

function expressionPasses(passes: StepPass[]): ExpressionPass[] {
  return passes.map(({ pass, outcome, outputs, end, results, answer }) => ({
    pass, outcome, ...(answer ? { choice: answer.choice, note: answer.note } : {}), ...(outputs !== undefined ? { outputs } : {}), ...(end !== undefined ? { end } : {}), ...(results !== undefined ? { results } : {}),
  }));
}

/** `steps.<id>.passes`: the passes a loop archived on the instance, then its current pass once it settled. */
export function passesOf(state: StepState): ExpressionPass[] {
  const current = passOf(state);
  return expressionPasses([...state.passes ?? [], ...(current ? [current] : [])]);
}

/** What a previous-pass read of a step sees: its latest archived pass, nothing of a pass on pass 1, and the archived passes. */
export function previousPass(state: StepState): ExpressionStep {
  const passes = expressionPasses(state.passes ?? []);
  const { pass: _pass, ...latest } = passes.at(-1) ?? {};
  const branches = branchNames('results' in latest ? latest.results : undefined);
  return { ...latest, passes, ...(branches ? { branches } : {}) };
}

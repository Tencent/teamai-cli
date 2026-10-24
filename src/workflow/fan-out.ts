/**
 * Fan-out. A step with `for_each` runs its action once per item of a list, each as an instance such as `build[2]`,
 * and settles once every item has, keeping how each one went in `results`. These rules decide the items and the
 * step's result; the engine settles and leases the items.
 */
import { isRecord } from './expression.js';
import { firstCycle, firstPass } from './loop.js';
import { parseStepPath } from './step-path.js';
import { passOf, stopped, type ItemResult, type StepState } from './step-state.js';
import type { RunState, WorkflowFailure } from './types.js';

/** Whether an instance is one item of a `for_each` step, such as `build[2]`. */
export function isItem(state: StepState): boolean {
  return parseStepPath(state.id).at(-1)?.index !== undefined;
}

/** The items of a `for_each` step, in item order. */
export function itemsOf(run: RunState, state: StepState): StepState[] {
  return run.steps.filter((item) => item.id.startsWith(`${state.id}[`) && !item.id.slice(state.id.length).includes('.'));
}

/** Adds an instance per item right after the `for_each` step, each after every archived pass of its id. */
export function addItems(run: RunState, state: StepState, items: unknown[]): void {
  const at = run.steps.indexOf(state) + 1;
  run.steps = [...run.steps.slice(0, at), ...items.map((item, index): StepState => {
    const id = `${state.id}[${index}]`;
    const pass = firstPass(run, id);
    return { id, status: 'pending', item, ...(pass > 1 ? { pass } : {}) };
  }), ...run.steps.slice(at)];
}

function kindOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** The items the `for_each` of step `id` gives, or why the step cannot run them. */
export function expandItems(id: string, value: unknown): unknown[] | WorkflowFailure {
  if (!Array.isArray(value)) return { code: 'invalid_items', message: `step "${id}" for_each gives ${kindOf(value)}, not a list of items` };
  const after = itemsAfter(id, value);
  if (!Array.isArray(after)) return after;
  // `after` names only items with an id, so only they can be in a cycle.
  const edges = new Map(after.flatMap((indexes, index) => {
    const name = idOf(value[index]);
    return name === undefined ? [] : [[name, indexes.map((other) => idOf(value[other]) ?? '')] as const];
  }));
  const cycle = firstCycle([...edges.keys()], edges);
  if (cycle) return { code: 'item_cycle', message: `step "${id}" has items that run after each other in a cycle: ${cycle.join(' -> ')}` };
  return value;
}

function idOf(item: unknown): string | undefined {
  return isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
}

/**
 * For each item of step `id`, the indexes of the items its `after` names, or why they cannot be read: two items with
 * the same id, an `after` that is not a list of ids, or an id no item has.
 */
export function itemsAfter(id: string, items: unknown[]): number[][] | WorkflowFailure {
  const invalid = (message: string): WorkflowFailure => ({ code: 'invalid_items', message: `step "${id}" ${message}` });
  const indexes = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const own = idOf(item);
    if (own === undefined) continue;
    const earlier = indexes.get(own);
    if (earlier !== undefined) return invalid(`items ${earlier} and ${index} have the same id "${own}"`);
    indexes.set(own, index);
  }
  const after: number[][] = [];
  for (const [index, item] of items.entries()) {
    const names: unknown = isRecord(item) ? item.after : undefined;
    if (names === undefined) {
      after.push([]);
      continue;
    }
    if (!Array.isArray(names) || !names.every((name): name is string => typeof name === 'string')) {
      return invalid(`item ${index} after must be a list of item ids`);
    }
    const unknown = names.find((name) => !indexes.has(name));
    if (unknown !== undefined) return invalid(`item ${index} runs after "${unknown}", which is not the id of an item`);
    after.push(names.map((name) => indexes.get(name)!));
  }
  return after;
}

/**
 * Where a pending item stands on the items its `after` names: it can start once all of them succeeded, and it is
 * skipped once one of them failed, was skipped, or was cancelled.
 */
export function afterStanding(after: StepState[]): 'ready' | 'waiting' | 'skip' {
  if (after.some((item) => stopped(item) || item.status === 'skipped')) return 'skip';
  return after.every((item) => item.status === 'succeeded') ? 'ready' : 'waiting';
}

/** How many items have an agent or workflow at work, which `max_parallel` bounds. An item that delivers has none. */
export function startedItems(items: StepState[]): number {
  return items.filter((item) => item.status === 'leased' || item.status === 'running').length;
}

/**
 * How a `for_each` step settles at `settledAt` once every item has: failed when an item stopped, with each item's
 * outcome and outputs. With no items, it succeeds.
 */
export function itemsSettled(
  items: StepState[], settledAt: number, run?: RunState,
): { outcome: 'succeeded' | 'failed'; settledAt: number; results: ItemResult[] } {
  const fromChildren = run ? branchesFromChildren(run) : undefined;
  const results = items.map((state): ItemResult => {
    const pass = passOf(state);
    const branch = pass?.changes?.branch ?? fromChildren?.get(state.id);
    return {
      item: state.item,
      outcome: pass?.outcome ?? 'skipped',
      ...(pass?.outputs !== undefined ? { outputs: pass.outputs } : {}),
      ...(branch ? { branch } : {}),
    };
  });
  return {
    outcome: items.some(stopped) ? 'failed' : 'succeeded',
    settledAt,
    results,
  };
}

/** One pass over the run: the change branch each item's latest child kept. */
function branchesFromChildren(run: RunState): Map<string, string> {
  const best = new Map<string, { branch: string; settledAt: number }>();
  for (const step of run.steps) {
    if (step.status === 'cancelled') continue;
    const branch = 'changes' in step ? step.changes?.branch : undefined;
    if (!branch) continue;
    const settledAt = 'settledAt' in step ? step.settledAt : 0;
    let acc = '';
    for (const segment of parseStepPath(step.id)) {
      const part = segment.index === undefined ? segment.id : `${segment.id}[${segment.index}]`;
      acc = acc === '' ? part : `${acc}.${part}`;
      if (segment.index === undefined || acc === step.id) continue;
      const current = best.get(acc);
      if (!current || settledAt >= current.settledAt) best.set(acc, { branch, settledAt });
    }
  }
  return new Map([...best].map(([id, item]) => [id, item.branch]));
}

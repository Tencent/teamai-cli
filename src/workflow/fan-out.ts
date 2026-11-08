/**
 * Fan-out. A step with `for_each` runs its action once per item of a list, each as an instance such as `build[2]`,
 * and settles once every item has, keeping how each one went in `results`. These rules decide the items and the
 * step's result; the engine settles and leases the items.
 */
import { z } from 'zod';
import type { JsonValue } from '../types.js';
import { isRecord, jsonType } from './expression.js';
import { firstCycle, firstPass } from './loop.js';
import { parseStepPath } from './step-path.js';
import { passOf, stopped, type ItemResult, type StepState } from './step-state.js';
import { parseTemplate, renderValue } from './template.js';
import { stepWorkflow, type RunState, type WorkflowFailure, type WorkflowStep } from './types.js';

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

    const added: StepState = { id, status: 'pending', item };

    if (pass > 1) added.pass = pass;

    return added;
  }), ...run.steps.slice(at)];
}

function kindOf(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return 'null';
  const type = jsonType(value);

  return type === 'object' ? 'an object' : `a ${type}`;
}

/** The items the `for_each` of step `id` gives, or why the step cannot run them. */
export function expandItems(id: string, value: JsonValue | undefined): unknown[] | WorkflowFailure {
  if (!Array.isArray(value)) return { code: 'invalid_items', message: `step "${id}" for_each gives ${kindOf(value)}, not a list of items` };
  const after = itemsAfter(id, value);

  if (!Array.isArray(after)) return after;

  // `after` names only items with an id, so only they can be in a cycle.
  const ids = itemIds(value);

  const edges = new Map(after.flatMap((indexes, index) => {
    const name = ids[index];

    return name === undefined ? [] : [[name, indexes.map((other) => ids[other] ?? '')] as const];
  }));

  const cycle = firstCycle([...edges.keys()], edges);

  if (cycle) return { code: 'item_cycle', message: `step "${id}" has items that run after each other in a cycle: ${cycle.join(' -> ')}` };

  return value;
}

const ItemIdSchema = z.object({ id: z.string() });

const ItemAfterSchema = z.array(z.string());

/** The `id` of each item, in item order: undefined for an item that has none. */
function itemIds(items: unknown[]): Array<string | undefined> {
  return items.map((item) => {
    const named = ItemIdSchema.safeParse(item);

    return named.success ? named.data.id : undefined;
  });
}

/**
 * For each item of step `id`, the indexes of the items its `after` names, or why they cannot be read: two items with
 * the same id, an `after` that is not a list of ids, or an id no item has.
 */
export function itemsAfter(id: string, items: unknown[]): number[][] | WorkflowFailure {
  const invalid = (message: string): WorkflowFailure => ({ code: 'invalid_items', message: `step "${id}" ${message}` });
  const indexes = new Map<string, number>();
  const ids = itemIds(items);

  for (const [index, own] of ids.entries()) {
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

    const listed = ItemAfterSchema.safeParse(names);

    if (!listed.success) return invalid(`item ${index} after must be a list of item ids`);

    const unknown = listed.data.find((name) => !indexes.has(name));

    if (unknown !== undefined) return invalid(`item ${index} runs after "${unknown}", which is not the id of an item`);
    after.push(listed.data.map((name) => indexes.get(name)!));
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
 * The most items of `step` started at once: its `max_parallel`, a template rendered from `inputs`, or undefined when it
 * declares none; why not, when a template renders anything but a whole number from 1.
 */
export function itemLimit(step: Pick<WorkflowStep, 'id' | 'forEach'>, inputs: RunState['inputs']): { ok: true; limit: number | undefined } | { ok: false; message: string } {
  const max = step.forEach?.maxParallel;

  if (!(max instanceof Object)) return { ok: true, limit: max };
  const parsed = parseTemplate(max.template, false);
  const rendered = parsed.ok ? renderValue(parsed.template, { inputs, steps: {} }) : undefined;
  const limit = z.number().int().positive().safeParse(rendered);

  return limit.success ? { ok: true, limit: limit.data }
    : { ok: false, message: `Step "${step.id}" for_each.max_parallel ${max.template} renders ${JSON.stringify(rendered ?? null)}, which is not a whole number from 1. Pass a whole number from 1 for the input it reads.` };
}

/**
 * Why `inputs` cannot start `steps`, a workflow's own and those of the inline workflows in it: a `max_parallel` template
 * that renders anything but a whole number from 1. A workflow a step runs by name is checked when it starts.
 */
export function itemLimitMismatch(steps: readonly WorkflowStep[], inputs: RunState['inputs']): string | undefined {
  for (const step of steps) {
    const limited = itemLimit(step, inputs);

    if (!limited.ok) return limited.message;
    const child = stepWorkflow(step);
    const inner = child?.kind === 'inline' ? itemLimitMismatch(child.workflow.steps, inputs) : undefined;

    if (inner !== undefined) return inner;
  }

  return undefined;
}

/** How a `for_each` step settled, with how each of its items went. */
export interface SettledItems {
  outcome: 'succeeded' | 'failed';
  settledAt: number;
  results: ItemResult[];
}

/**
 * How a `for_each` step settles at `settledAt` once every item has: failed when an item stopped, with each item's
 * outcome and outputs. With no items, it succeeds.
 */
export function itemsSettled(
  items: StepState[], settledAt: number, run?: RunState,
): SettledItems {
  return {
    outcome: items.some(stopped) ? 'failed' : 'succeeded',
    settledAt,
    results: itemResults(items, run),
  };
}

/**
 * The results a `for_each` step under `continue_on_failure` keeps when a timeout or a cancel stops it, read once its
 * items were stopped. Any other step keeps none.
 */
export function keptResults(run: RunState, state: StepState, definition: WorkflowStep | undefined): ItemResult[] | undefined {
  return definition?.continueOnFailure && definition.forEach && !isItem(state) ? itemResults(itemsOf(run, state), run) : undefined;
}

/** How each item went, with the change branch its latest child kept when `run` is given. */
function itemResults(items: StepState[], run: RunState | undefined): ItemResult[] {
  const fromChildren = run ? branchesFromChildren(run) : undefined;

  return items.map((state): ItemResult => {
    const pass = passOf(state);
    const branch = pass?.changes?.branch ?? fromChildren?.get(state.id);

    const result: ItemResult = { item: state.item, outcome: pass?.outcome ?? 'skipped' };

    if (pass?.outputs !== undefined) result.outputs = pass.outputs;

    if (branch) result.branch = branch;

    if (pass?.pr) result.pr = pass.pr;

    return result;
  });
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

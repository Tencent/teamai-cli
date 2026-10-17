/**
 * Scopes: the workflows inside a run, and the step instances directly in each. The instances of a scope are read from an
 * index kept per `run.steps` array, so settling one scope does not scan every step of the run.
 */
import type { ExpressionStep } from './expression.js';
import { isItem } from './fan-out.js';
import { passesOf, previousPass, stepLoops, type StepLoops } from './loop.js';
import { parseStepPath } from './step-path.js';
import { settled, VISIBLE_OUTCOMES, type StepState } from './step-state.js';
import type { TemplateContext } from './template.js';
import type { InlineWorkflow, RunState, WorkflowDefinition, WorkflowStep } from './types.js';

/** A workflow inside a run: the top-level one, or the sub-workflow a step runs. */
export interface Scope {
  /** What every step path inside it starts with: '' at the top, `<workflow step path>.` inside a sub-workflow. */
  prefix: string;
  definition: WorkflowDefinition | InlineWorkflow;
  inputs: Record<string, unknown> | undefined;
  /** For an inline workflow: the enclosing workflows' steps, by id, which its own steps hide. */
  outer?: Record<string, ExpressionStep>;
  loops: StepLoops;
  /** The step that runs this workflow, which keeps its round. The top-level workflow keeps its round on the run. */
  runner?: StepState;
  /** In the inline workflow of a `for_each` item, at any depth: that item, which its steps read as `item`. */
  item?: unknown;
  /** The `defaults.model` in effect: the workflow file's own, else the enclosing scope's. */
  defaultModel?: string;
}

export function topScope(run: RunState): Scope {
  return {
    prefix: '', definition: run.definition, inputs: run.inputs, loops: stepLoops(run.definition.steps), defaultModel: run.definition.defaults?.model,
  };
}

/**
 * The scope of the workflow a step runs, or undefined when the run did not keep that workflow.
 * An inline workflow reads the inputs and the steps of the workflow `scope` around it.
 */
export function childScope(run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep): Scope | undefined {
  if (typeof step.workflow === 'object') {
    return {
      prefix: `${state.id}.`, definition: step.workflow, inputs: scope.inputs, outer: expressionSteps(scope, states, state),
      loops: stepLoops(step.workflow.steps), runner: state, ...itemOf(scope, state), defaultModel: scope.defaultModel,
    };
  }
  const definition = step.workflow === undefined ? undefined : run.workflows?.[step.workflow];
  return definition && {
    prefix: `${state.id}.`, definition, inputs: state.inputs, loops: stepLoops(definition.steps), runner: state,
    defaultModel: definition.defaults?.model ?? scope.defaultModel,
  };
}

/**
 * Finds the definition of the step at a path in the run's workflow definitions alone, so a path still resolves after
 * a loop archived the instances along it. Each workflow's steps are indexed by id once, when a path first reaches it.
 */
export function stepDefinitions(run: RunState): (path: string) => WorkflowStep | undefined {
  const indexes = new Map<WorkflowDefinition | InlineWorkflow, Map<string, WorkflowStep>>();
  return (path) => {
    let workflow: WorkflowDefinition | InlineWorkflow | undefined = run.definition;
    let step: WorkflowStep | undefined;
    for (const { id } of parseStepPath(path)) {
      if (!workflow) return undefined;
      const index: Map<string, WorkflowStep> = indexes.get(workflow) ?? new Map(workflow.steps.map((item) => [item.id, item]));
      indexes.set(workflow, index);
      step = index.get(id);
      workflow = typeof step?.workflow === 'string' ? run.workflows?.[step.workflow] : step?.workflow;
    }
    return step;
  };
}

/** For each `run.steps` array, its instances by the prefix of the scope they are directly inside. */
const scopeIndex = new WeakMap<readonly StepState[], Map<string, StepState[]>>();

/** `states` by the prefix of the scope each is directly inside, in their order. A `for_each` item such as `build[0]` is in none. */
function byScope(states: readonly StepState[]): Map<string, StepState[]> {
  const index = new Map<string, StepState[]>();
  for (const state of states) {
    const prefix = state.id.slice(0, state.id.lastIndexOf('.') + 1);
    if (parseStepPath(state.id.slice(prefix.length))[0]?.index !== undefined) continue;
    const group = index.get(prefix);
    if (group) group.push(state);
    else index.set(prefix, [state]);
  }
  return index;
}

/** The step instances directly inside a scope, in declaration order. A `for_each` item such as `build[0]` is not one. */
export function statesIn(run: RunState, scope: Scope): StepState[] {
  let index = scopeIndex.get(run.steps);
  if (!index) {
    index = byScope(run.steps);
    scopeIndex.set(run.steps, index);
  }
  return [...index.get(scope.prefix) ?? []];
}

/**
 * Puts the instances of the workflow `runner` runs right after it. The old array's index carries over to the new one
 * with them as the group of their scope, so starting a workflow inside each item does not index every step again.
 */
export function insertChildren(run: RunState, runner: StepState, children: StepState[]): void {
  const old = run.steps;
  const at = old.indexOf(runner) + 1;
  run.steps = [...old.slice(0, at), ...children, ...old.slice(at)];
  const index = scopeIndex.get(old);
  if (!index) return;
  scopeIndex.delete(old);
  for (const [prefix, group] of byScope(children)) index.set(prefix, [...group, ...index.get(prefix) ?? []]);
  scopeIndex.set(run.steps, index);
}

/** The step id an instance has inside its own workflow. */
export function localId(scope: Scope, state: StepState): string {
  const [segment] = parseStepPath(state.id.slice(scope.prefix.length));
  return segment?.id ?? state.id;
}

function itemOf(scope: Scope, state: StepState | undefined): { item?: unknown } {
  if (state && isItem(state)) return { item: state.item };
  return Object.hasOwn(scope, 'item') ? { item: scope.item } : {};
}

/** What an expression or template in a scope reads; for `reader`, what that step instance reads. */
export function contextOf(scope: Scope, states: StepState[], reader?: StepState): TemplateContext {
  return { inputs: scope.inputs, steps: expressionSteps(scope, states, reader), ...itemOf(scope, reader) };
}

/**
 * What expressions in a workflow read as `steps.<id>`: its own step instances, by their id in that workflow,
 * and, in an inline workflow, the enclosing steps its own steps do not hide. For `reader`, a step it reads in the
 * previous pass is that pass.
 */
function expressionSteps(scope: Scope, states: StepState[], reader?: StepState): Record<string, ExpressionStep> {
  const previous = reader ? scope.loops.previous(localId(scope, reader)) : new Set<string>();
  return { ...scope.outer, ...Object.fromEntries(states.map((step) => [localId(scope, step), previous.has(localId(scope, step)) ? previousPass(step) : {
    ...(settled(step) ? { outcome: VISIBLE_OUTCOMES[step.status] } : {}),
    ...('end' in step && step.end !== undefined ? { end: step.end } : {}),
    ...('outputs' in step && step.outputs !== undefined ? { outputs: step.outputs } : {}),
    ...('results' in step && step.results !== undefined ? { results: step.results } : {}),
    passes: passesOf(step),
  }])) };
}

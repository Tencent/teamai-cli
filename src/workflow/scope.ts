/**
 * Scopes: the workflows inside a run, and the step instances directly in each. The instances of a scope are read from an
 * index kept per `run.steps` array, so settling one scope does not scan every step of the run.
 */
import { branchNames, type ExpressionStep } from './expression.js';
import { isItem } from './fan-out.js';
import { passesOf, previousPass, stepLoops, type StepLoops } from './loop.js';
import { parseStepPath } from './step-path.js';
import { settled, visibleOutcome, type StepState } from './step-state.js';
import type { TemplateContext } from './template.js';
import { isWorkflowFile, stepWorkflow, workflowRunBy, type Budget, type InlineWorkflow, type RunState, type WorkflowDefinition, type WorkflowStep } from './types.js';
import { mergeRequirements, type InEffect, type Setup } from './requirements.js';

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
  /** The requirements every step here has: the enclosing scope's, the workflow step's own, then the file's `defaults.requires`. */
  requires: InEffect;
  /** The tokens this workflow may spend: the file's budget, or the workflow step's when that is smaller. */
  budget?: number;
  /** Whether this workflow or one around it has a budget. */
  budgeted: boolean;
  /** The `setup` in effect: the workflow file's own, else the enclosing scope's. */
  setup?: Setup;
  /** The workflow steps under `on_limit: end_turn` this workflow runs inside, outermost first: allowances its prompt turns spend. */
  allowances: GrantedAllowance[];
}

/** What a workflow step under `on_limit: end_turn` grants the prompt turns inside it: its `timeout` and `budget`. */
export interface GrantedAllowance {
  step: string;
  timeoutMs?: number;
  tokens?: number;
}

/** The allowances inside the workflow `state` runs: those around it, then its own under `on_limit: end_turn`. */
function allowancesOf(scope: Scope, state: StepState, step: WorkflowStep): Pick<Scope, 'allowances'> {
  if (step.onLimit !== 'end_turn') return { allowances: scope.allowances };
  const own = { step: state.id, ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}), ...(step.budget ? { tokens: step.budget.tokens } : {}) };
  return { allowances: [...scope.allowances, own] };
}

export function topScope(run: RunState): Scope {
  return {
    prefix: '', definition: run.definition, inputs: run.inputs, loops: stepLoops(run.definition.steps), defaultModel: run.definition.defaults?.model,
    requires: mergeRequirements(run.definition.defaults?.requires),
    ...budgetOf(false, run.definition.budget), ...setupOf(run.definition.setup), allowances: [],
  };
}

/**
 * The run's `finally` steps, as a workflow at the top level beside the run's own. It reads the inputs, and the run's steps
 * besides its own, so the run's outputs read both once it settles.
 */
export function finallyScope(run: RunState): Scope {
  const top = topScope(run);
  const steps = run.definition.finally ?? [];
  return {
    prefix: '', definition: { steps }, inputs: run.inputs, outer: expressionSteps(top, statesIn(run, top)), loops: stepLoops(steps),
    requires: top.requires, budgeted: false, allowances: [],
  };
}

function setupOf(setup: Setup | undefined): Pick<Scope, 'setup'> {
  return setup ? { setup } : {};
}

/**
 * A workflow step's budget, which a `for_each` step spends over all its items instead of giving each item its own.
 * Under `on_limit: end_turn` it is an allowance its prompts spend, which never fails it.
 */
function ownBudget(step: WorkflowStep): Budget | undefined {
  return step.forEach || step.onLimit === 'end_turn' ? undefined : step.budget;
}

function budgetOf(outer: boolean, ...budgets: ReadonlyArray<Budget | undefined>): Pick<Scope, 'budget' | 'budgeted'> {
  const limits = budgets.flatMap((budget) => (budget ? [budget.tokens] : []));
  return limits.length > 0 ? { budget: Math.min(...limits), budgeted: true } : { budgeted: outer };
}

/**
 * The scope of the workflow a step runs, or undefined when the run did not keep that workflow.
 * An inline workflow reads the inputs and the steps of the workflow `scope` around it.
 */
export function childScope(run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep): Scope | undefined {
  const runs = stepWorkflow(step);
  if (runs?.kind === 'inline') {
    return {
      prefix: `${state.id}.`, definition: runs.workflow, inputs: scope.inputs, outer: expressionSteps(scope, states, state),
      loops: stepLoops(runs.workflow.steps), runner: state, ...itemOf(scope, state), defaultModel: scope.defaultModel,
      requires: mergeRequirements(scope.requires, step.requires),
      ...budgetOf(scope.budgeted || step.budget !== undefined, ownBudget(step)), ...setupOf(scope.setup), ...allowancesOf(scope, state, step),
    };
  }
  const definition = workflowRunBy(run, step, scope.prefix);
  return definition && isWorkflowFile(definition) ? {
    prefix: `${state.id}.`, definition, inputs: state.inputs, loops: stepLoops(definition.steps), runner: state,
    defaultModel: definition.defaults?.model ?? scope.defaultModel,
    requires: mergeRequirements(scope.requires, step.requires, definition.defaults?.requires),
    ...budgetOf(scope.budgeted || step.budget !== undefined, ownBudget(step), definition.budget), ...setupOf(definition.setup ?? scope.setup),
    ...allowancesOf(scope, state, step),
  } : undefined;
}

/**
 * Finds the definition of the step at a path in the run's workflow definitions alone, so a path still resolves after
 * a loop archived the instances along it. Each workflow's steps are indexed by id once, when a path first reaches it.
 */
export function stepDefinitions(run: Pick<RunState, 'definition' | 'workflows' | 'admitted'>): (path: string) => WorkflowStep | undefined {
  const indexes = new Map<WorkflowDefinition | InlineWorkflow, Map<string, WorkflowStep>>();
  return (path) => {
    let workflow: WorkflowDefinition | InlineWorkflow | undefined = run.definition;
    let step: WorkflowStep | undefined;
    let prefix = '';
    for (const segment of path.split('.')) {
      const { id } = parseStepPath(segment)[0] ?? { id: segment };
      if (!workflow) return undefined;
      const index: Map<string, WorkflowStep> = indexes.get(workflow) ?? new Map(workflow.steps.map((item) => [item.id, item]));
      indexes.set(workflow, index);
      step = index.get(id);
      workflow = step && workflowRunBy(run, step, prefix);
      prefix = `${prefix}${segment}.`;
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
  const group = index.get(scope.prefix) ?? [];
  // The run's steps and its `finally` steps share the top level, so each of the two scopes takes only its own.
  if (scope.prefix !== '' || (!run.definition.finally && scope.definition === run.definition)) return [...group];
  const own = new Set(scope.definition.steps.map((step) => step.id));
  return group.filter((state) => own.has(state.id));
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
    ...(settled(step) ? { outcome: visibleOutcome(step) } : {}),
    ...('end' in step && step.end !== undefined ? { end: step.end } : {}),
    ...('outputs' in step && step.outputs !== undefined ? { outputs: step.outputs } : {}),
    ...('results' in step && step.results !== undefined ? { results: step.results } : {}),
    ...('results' in step && branchNames(step.results) ? { branches: branchNames(step.results) } : {}),
    ...(step.answer ? { choice: step.answer.choice, note: step.answer.note } : {}),
    passes: passesOf(step),
  }])) };
}

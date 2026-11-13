/**
 * A `workflow:` step that goes to one runtime whole, as one attempt (case 24): a fleet member drives its sub-graph as a
 * nested run in the attempt's clone, and the owner settles the step from how that run ended. Only a step whose
 * sub-graph a member can run on its own goes whole, a workflow file or an inline workflow that reads nothing around it
 * but the inputs; every other workflow step is started where it stands, as before.
 */
import { z } from 'zod';
import { DefaultWorkflows } from '../default-workflows.js';
import { JsonValueSchema, type JsonValue } from '@teamai/shared/json';
import { expressionPaths, isRecord, parseExpression, type ExpressionPath } from './expression.js';
import { isPinnedToHost, mergeRequirements, type InEffect } from './requirements.js';
import { renderStrings, stepPaths, type TemplateContext } from './template.js';
import { isWorkflowFile, stepWorkflow, type InlineWorkflow, type WorkflowDefinition, type WorkflowStep } from './types.js';
import { TokenUsageSchema } from './step-state.js';

/** A step of a workflow that goes whole that runs something, with the `requires` in effect for it. */
export type WholeRun = { step: WorkflowStep; executor: 'command' | 'prompt'; requires: InEffect };

/**
 * Whether workflow step `step` of workflow file `around`, which runs workflow `child` with `requires` in effect, goes
 * whole: why not, or its workflow and the steps of it that run something, each with the `requires` in effect for it.
 * An inline workflow is given as a workflow file named after the step. The one fit rule: the owner's engine leaves only
 * such a step unexpanded and judges a runtime's offer on these steps, and a fleet member judges whether it can run them
 * before it claims the step.
 */
export function wholeFit(
  step: WorkflowStep, child: WorkflowDefinition | InlineWorkflow | undefined, { requires, around }: { requires: InEffect; around: string },
): { unfit: string } | { child: WorkflowDefinition; runs: WholeRun[] } {
  if (child === undefined) return { unfit: 'it runs no workflow this run kept' };
  const unfit = notWhole(step, child);

  if (unfit !== undefined) return { unfit };
  const file = isWorkflowFile(child) ? child : inlineFile(step, child);
  const inEffect = (inner: WorkflowStep): InEffect => mergeRequirements(requires, file.defaults?.requires, inner.requires);

  // A gate step runs nothing: the member asks its question through the attempt's record.
  const runs = file.steps.flatMap((inner): WholeRun[] => {
    if (inner.command !== undefined) return [{ step: inner, executor: 'command', requires: inEffect(inner) }];

    // An answer is a prompt the member's tool answers on this host, so the pin below holds it here.
    return inner.prompt === undefined && inner.answer === undefined ? [] : [{ step: inner, executor: 'prompt', requires: inEffect(inner) }];
  });

  // A step pinned to this machine (`isPinnedToHost`) runs on no member. An inline workflow's steps are steps of the file
  // it is written in.
  const inShippedWorkflow = DefaultWorkflows.isShipped(isWorkflowFile(child) ? child.name : around);
  const pinned = runs.find((run) => isPinnedToHost({ step: run.step, executor: run.executor, inShippedWorkflow, requires: run.requires }));

  if (pinned !== undefined) return { unfit: `step "${pinned.step.id}" runs only on this machine` };

  return { child: file, runs };
}

/** Inline workflow `inline` of step `step` as the workflow file a nested run runs: named after the step, with no inputs of its own. */
function inlineFile(step: WorkflowStep, inline: InlineWorkflow): WorkflowDefinition {
  return { schemaVersion: 'v1alpha1', name: step.id, description: `The inline workflow of step "${step.id}".`, ...inline };
}

/**
 * The workflow a member runs as the nested run of whole workflow step `step`: `child`, as the owner's engine gives that
 * workflow (scope.ts `childScope`), with the budget the step's children spend together, the smallest of the step's own,
 * the workflow's, and `budgetLeft`, what the budgets around the step had left as the owner offered it, and the
 * `defaults.model` in effect around the step, `defaultModel`, when the workflow sets none. A `for_each` step's budget
 * covers all its items, so the owner counts it in `budgetLeft`.
 */
export function wholeRunDefinition(
  step: WorkflowStep, child: WorkflowDefinition, { defaultModel, budgetLeft }: { defaultModel: string | undefined; budgetLeft: number | undefined },
): WorkflowDefinition {
  const own = step.forEach === undefined ? step.budget?.tokens : undefined;
  const budgets = [own, child.budget?.tokens, budgetLeft].filter((tokens) => tokens !== undefined);
  const model = child.defaults?.model ?? defaultModel;

  return {
    ...child,
    ...(budgets.length > 0 && { budget: { tokens: Math.min(...budgets) } }),
    ...(model !== undefined && { defaults: { ...child.defaults, model } }),
  };
}

/**
 * Why the workflow `child`, which step `step` runs, does not go whole, or undefined when it
 * does: its children are command, prompt or gate steps that work in the copy the step works in, with nothing a member
 * cannot run on its own: a gate the member asks the owner through the attempt's record. An inline workflow also reads
 * nothing around it but the inputs.
 */
function notWhole(step: WorkflowStep, child: WorkflowDefinition | InlineWorkflow): string | undefined {
  // A workflow a `from` step wrote is in no definition, so a member could not check what it runs.
  if (stepWorkflow(step)?.kind === 'from') return 'it runs the workflow a step wrote';

  if (!isWorkflowFile(child)) {
    const read = readAround(child);

    if (read !== undefined) return read;
  }

  if (isRecord(step.workspace)) return 'it opens a clone, the team repo or a confined directory';

  // A header's `workspace: new` opens a copy at the step only when none is around it, which the step alone does not say.
  if (isWorkflowFile(child) && step.workspace === undefined && child.workspace === 'new') return 'its workflow opens a copy of its own';

  if (isWorkflowFile(child) && child.setup !== undefined) return 'its workflow has a setup of its own';

  // An allowance its prompts end their turn at is counted by the owner's engine across them, which a nested run is not.
  if (step.onLimit === 'end_turn') return 'it gives its prompts a turn allowance (on_limit: end_turn)';

  for (const inner of child.steps) {
    const what = `step "${inner.id}"`;

    // A gate the member asks the owner through the attempt's record, whose person answers it.
    if (inner.command === undefined && inner.prompt === undefined && inner.answer === undefined && inner.hitl === undefined) return `${what} is neither a command, a prompt, an answer nor a gate`;

    if (stepWorkflow(inner) !== undefined) return `${what} runs a workflow`;

    if (inner.interactive) return `${what} needs a person at its tool`;

    if (inner.workspace !== undefined && inner.workspace !== 'continue' && inner.workspace !== 'read-only') return `${what} opens a copy of its own`;

    if (inner.role !== undefined) return `${what} runs with a team role`;

    if (inner.deliver !== undefined) return `${what} delivers`;
  }

  return undefined;
}

/**
 * What step of inline workflow `inline` reads around it, which the nested run of a member has none of, as the owner's
 * engine gives it (scope.ts childScope): a step outside it, or the item of a `for_each`. Undefined when its steps read
 * only the inputs and their own steps.
 */
function readAround(inline: InlineWorkflow): string | undefined {
  const own = new Set(inline.steps.map((inner) => inner.id));

  for (const { what, paths } of inlineReads(inline)) {
    for (const read of paths) {
      if (read.root === 'item') return `${what} of its inline workflow reads the item`;

      if (read.root === 'steps' && !own.has(read.step)) return `${what} of its inline workflow reads step "${read.step}" around it`;
    }
  }

  return undefined;
}

/**
 * The paths inline workflow `inline` reads, by what reads them: each of its steps, and its `loop.while`. Its templates
 * are read as if an item were bound, so an item read is one.
 */
export function inlineReads(inline: InlineWorkflow): Array<{ what: string; paths: ExpressionPath[] }> {
  const loop = inline.loop?.while === undefined ? undefined : parseExpression(inline.loop.while);

  return [
    ...inline.steps.map((inner) => ({ what: `step "${inner.id}"`, paths: stepPaths(inner, true) })),
    ...(loop?.ok ? [{ what: 'loop.while', paths: expressionPaths(loop.expression) }] : []),
  ];
}

/**
 * The inputs workflow `child` starts with when step `step` runs it in `context`: its `with` rendered, over the defaults
 * the workflow declares, as the engine starts a workflow step. Or why it does not render.
 */
export function wholeInputs(step: Pick<WorkflowStep, 'with'>, child: Pick<WorkflowDefinition, 'defaults'>, context: TemplateContext): { inputs: JsonValue } | { error: string } {
  const rendered = renderStrings(step.with ?? {}, context);

  if (!rendered.ok) return { error: `with ${rendered.error.source}: ${rendered.error.message}` };
  const given = isRecord(rendered.value) ? { ...child.defaults?.inputs, ...rendered.value } : rendered.value;
  const parsed = JsonValueSchema.safeParse(given);

  return parsed.success ? { inputs: parsed.data } : { error: 'with does not render to JSON' };
}

/**
 * How a whole workflow ended where it ran, as its runtime's exec answers it on stdout: the outcome, the end it reached,
 * the workflow's outputs, and the failure that ended it.
 */
export const WholeEndSchema = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  end: z.string().min(1).optional(),
  outputs: z.record(z.string(), JsonValueSchema).optional(),
  failure: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  /** The tokens its steps spent, which the budgets around the step count. */
  tokens: TokenUsageSchema.optional(),
});

export type WholeEnd = z.infer<typeof WholeEndSchema>;

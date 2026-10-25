import type { Invoke, OutputSchema, StepHitl, WorkflowDefinition, WorkflowStep } from './types.js';
import { runsInCheckout } from './workspace.js';

/** What a workflow will do, read from its definition before any run, as far as choosing how to start it needs. */
export interface WorkflowDescription {
  name: string;
  description: string;
  alias?: string;
  invoke: Invoke;
  /** Every input `start --inputs` must pass. */
  inputs: Record<string, OutputSchema>;
  facts: {
    /** Prompt steps, by path: an agent works in them. */
    prompts: string[];
    /** Interactive prompt steps, by path: a person works in them with the agent. */
    interactive: string[];
    /** The most steps a run may have leased at once, at most `ceiling`. */
    width: number;
    /** The questions asked before a step runs, by path. */
    gates: Array<{ step: string; kind: StepHitl['kind']; required: boolean; hasDefault: boolean }>;
    /** Steps that run in a workspace copy rather than in the checkout, by path. */
    inWorkspace: string[];
    /** Steps whose succeeded passes a scorer judges, by path, with the scorers it lists. */
    scored: Array<{ step: string; scorers: string[] }>;
  };
}

/**
 * Describes `definition`, which runs the workflows in `workflows` by name. A `for_each` with no `max_parallel` counts as
 * `ceiling` wide, and so does a run wider than it.
 */
export function describeWorkflow(input: { definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition>; ceiling: number }): WorkflowDescription {
  const { definition, workflows, ceiling } = input;
  const facts: WorkflowDescription['facts'] = { prompts: [], interactive: [], width: 0, gates: [], inWorkspace: [], scored: [] };
  const childOf = (step: WorkflowStep): { steps: WorkflowStep[] } | undefined => (typeof step.workflow === 'string' ? workflows[step.workflow] : step.workflow);
  const visit = (steps: WorkflowStep[], ancestors: WorkflowStep[], prefix: string): number => {
    const levels = new Map<string, number>();
    const widths: number[] = [];
    for (const step of steps) {
      const path = `${prefix}${step.id}`;
      const child = childOf(step);
      if (step.hitl) facts.gates.push({ step: path, kind: step.hitl.kind, required: step.hitl.required, hasDefault: step.hitl.default !== undefined });
      if (!child && step.end === undefined && !runsInCheckout(step, ancestors)) facts.inWorkspace.push(path);
      if (step.prompt !== undefined || step.promptFile !== undefined) facts.prompts.push(path);
      if (step.interactive) facts.interactive.push(path);
      if (step.scorers && step.scorers.names.length > 0) facts.scored.push({ step: path, scorers: step.scorers.names });
      const own = child ? visit(child.steps, [...ancestors, step], `${path}.`) : step.command !== undefined || step.prompt !== undefined || step.promptFile !== undefined ? 1 : 0;
      const level = Math.max(-1, ...(step.needs ?? []).map((need) => levels.get(need) ?? -1)) + 1;
      levels.set(step.id, level);
      widths[level] = (widths[level] ?? 0) + (step.forEach ? (step.forEach.maxParallel ?? ceiling) * own : own);
    }
    return Math.max(0, ...widths.map((width) => width ?? 0));
  };
  facts.width = Math.min(ceiling, visit(definition.steps, [], ''));
  const { name, description, alias, invoke, inputs } = definition;
  return { name, description, ...(alias ? { alias } : {}), invoke: invoke ?? 'deny', inputs: inputs ?? {}, facts };
}

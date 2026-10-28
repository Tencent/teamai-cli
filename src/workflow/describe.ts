import { sameEnvName } from '../resources/env-key.js';
import { mergeRequirements, negotiate, requiredEnvKeys, type Allow, type DriverCan, type EnvFacts, type Missing, type Requirements, type Setup } from './requirements.js';
import type { Invoke, OutputSchema, WorkflowDefinition, WorkflowStep } from './types.js';
import { opensCopy, resolveMode, runsInCheckout } from './workspace.js';

/**
 * Why a driver cannot run a workflow to its end: a step it takes works in the workspace copy `opener` opened, and a
 * later step it is held from for `missing` works in that copy too, which only the driver that took it may continue.
 */
export interface LocalRoute {
  opener: string;
  held: string;
  missing: 'env' | 'tokens';
}

/** What a gated step does once its question is answered. */
export type GateGuards =
  | { kind: 'command'; line: string }
  | { kind: 'prompt' }
  | { kind: 'interactive' }
  /** `name`: the workflow it runs; absent when that workflow is inline. */
  | { kind: 'workflow'; name?: string }
  /** `workflow`: the workflow step whose workflow it ends, by path; absent when it ends the run. */
  | { kind: 'end'; end: string; workflow?: string }
  /** `waiting`: the steps whose needs list it, by path. */
  | { kind: 'none'; waiting: string[] };

/** The most characters of a command a gate shows before it cuts the rest. */
const COMMAND_SHOWN = 80;

/** `command` as a gate shows it: its first line, whitespace collapsed, cut after `COMMAND_SHOWN` characters. */
function commandLine(command: string): string {
  const line = (command.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  return line.length > COMMAND_SHOWN ? `${line.slice(0, COMMAND_SHOWN)}…` : line;
}

/** What `step`, gated, guards; `steps` is the list it sits in, whose paths start with `prefix`. */
function guardsOf(step: WorkflowStep, steps: WorkflowStep[], prefix: string): GateGuards {
  if (step.command !== undefined) return { kind: 'command', line: commandLine(step.command) };
  if (step.interactive) return { kind: 'interactive' };
  if (step.prompt !== undefined || step.promptFile !== undefined) return { kind: 'prompt' };
  if (step.workflow !== undefined) return { kind: 'workflow', ...(typeof step.workflow === 'string' ? { name: step.workflow } : {}) };
  if (step.end !== undefined) return { kind: 'end', end: step.end, ...(prefix !== '' ? { workflow: prefix.slice(0, -1) } : {}) };
  return { kind: 'none', waiting: steps.filter((other) => other.needs?.includes(step.id)).map((other) => `${prefix}${other.id}`) };
}

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
    /**
     * Prompt steps, by path, whose child runs a model resolved for the session's tool: the step's `model`, or the
     * `defaults.model` in effect for a step that names no `agent`.
     */
    modeled: string[];
    /** The most steps a run may have leased at once, at most `ceiling`. */
    width: number;
    /** The questions asked before a step runs, by path, with what the step does once answered. */
    gates: Array<{ step: string; required: boolean; guards: GateGuards } & ({ kind: 'approve'; deliver?: true } | { kind: 'choose'; options: string[]; default?: string })>;
    /** Steps that run in a workspace copy rather than in the checkout, by path. */
    inWorkspace: string[];
    /** Steps whose succeeded passes a scorer judges, by path, with the scorers it lists. */
    scored: Array<{ step: string; scorers: string[] }>;
    /**
     * Steps that open a pull request once they succeed, by path. `onto`: the delivering step whose branch the step's
     * own starts from, whose pull request it targets; without it, the pull request targets `base`.
     */
    deliver: Array<{ step: string; onto?: string }>;
    /** The branch of the checkout a run would start from. Absent on a detached HEAD, from which no run delivers. */
    base?: string;
    /** The `requires.env` keys of every step and setup, by name, and those with no value on this machine. */
    requiresEnv: { keys: string[]; missingHere: string[] };
    /** Milliseconds a run may take. */
    timeout?: number;
    /** The tokens a run may spend, and those a workflow step may each time it starts, by path. */
    budgets: Array<{ step?: string; tokens: number }>;
    /**
     * Each step that runs a command or a prompt, by path, with what the machine that runs it needs: the `requires.env`
     * keys of the step and its setup, and the agent of a prompt step, whose tool the driver picks.
     */
    runs: Array<{ step: string; executor: 'command' | 'prompt'; env: string[]; agent?: string }>;
    /** Steps the describing driver is held from, by path, with what it lacks, and the `requires.env` keys they need. */
    held: Array<{ step: string; missing: Missing[]; env: string[] }>;
    localRoute?: LocalRoute;
  };
}

/** What the steps of one workflow in the tree run under, as the engine's scopes give it. */
interface Scope {
  prefix: string;
  /** The workflow steps around it, outermost first. */
  ancestors: WorkflowStep[];
  requires: Requirements;
  budgeted: boolean;
  setup?: Setup;
  /** The step that opened the copy its steps work in, by path. */
  copy?: string;
  /** The `defaults.model` in effect, as the engine's scope keeps it. */
  defaultModel?: string;
}

/** Whether `step` leaves commits on a branch: it writes in a copy, or a step of the workflow it runs does. */
function writes(step: WorkflowStep, ancestors: WorkflowStep[], childOf: (step: WorkflowStep) => { steps: WorkflowStep[] } | undefined): boolean {
  const child = childOf(step);
  if (child) return child.steps.some((inner) => writes(inner, [...ancestors, step], childOf));
  return (step.prompt !== undefined || step.promptFile !== undefined || step.workspace === 'new' || step.workspace === 'continue') && resolveMode(step, ancestors) !== 'read-only';
}

/**
 * Describes `definition`, which runs the workflows in `workflows` by name, for a driver that declares `can`, under the
 * member's `allow` and this machine's `env`. A `for_each` with no `max_parallel` counts as `ceiling` wide, and so does a
 * run wider than it.
 */
export function describeWorkflow(input: {
  definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition>; ceiling: number; can: DriverCan; allow: Allow; env: EnvFacts; base?: string;
}): WorkflowDescription {
  const { definition, workflows, ceiling, can, allow, env, base } = input;
  const runEnvKeys = requiredEnvKeys([definition, ...Object.values(workflows)]);
  const facts: WorkflowDescription['facts'] = {
    prompts: [], interactive: [], modeled: [], width: 0, gates: [], inWorkspace: [], scored: [], deliver: [], ...(base !== undefined ? { base } : {}),
    requiresEnv: { keys: [...runEnvKeys], missingHere: [...runEnvKeys].filter((key) => sameEnvName(env.present, key) === undefined) },
    ...(definition.timeout !== undefined ? { timeout: definition.timeout } : {}),
    budgets: definition.budget ? [{ tokens: definition.budget.tokens }] : [],
    runs: [],
    held: [],
  };
  /** By the step that opened each copy: whether the driver takes a step in it, and the first step in it the driver is held from. */
  const copies = new Map<string, { taken: boolean; held?: { step: string; missing: LocalRoute['missing'] } }>();
  const childOf = (step: WorkflowStep): { steps: WorkflowStep[] } | undefined => (typeof step.workflow === 'string' ? workflows[step.workflow] : step.workflow);
  /** As the engine's `offerTerms` asks `negotiate`, so describe holds exactly what `next` would hold. */
  const offer = (step: WorkflowStep, path: string, scope: Scope): void => {
    const hasContract = !runsInCheckout(step, scope.ancestors);
    const requires = mergeRequirements(scope.requires, step.requires);
    const executor = step.command !== undefined ? 'command' : 'prompt';
    const setupEnv = hasContract ? scope.setup?.requires?.env ?? [] : [];
    facts.runs.push({ step: path, executor, env: [...new Set([...requires.env ?? [], ...setupEnv])], ...(executor === 'prompt' && step.agent !== undefined ? { agent: step.agent } : {}) });
    const negotiation = negotiate({
      step: path, executor, requires,
      interactive: step.interactive === true, hasContract, envKeys: Object.keys(step.env ?? {}), runEnvKeys, budgeted: step.prompt !== undefined && scope.budgeted,
      ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}), ...(hasContract && scope.setup ? { setup: scope.setup } : {}),
    }, can, allow, env);
    if (negotiation.kind === 'hold') facts.held.push({ step: path, missing: negotiation.missing, env: requires.env ?? [] });
    if (scope.copy === undefined || negotiation.kind === 'fail') return;
    const copy = copies.get(scope.copy) ?? { taken: false };
    copies.set(scope.copy, copy);
    if (negotiation.kind === 'grant') copy.taken = true;
    const missing = negotiation.kind === 'hold' ? (['env', 'tokens'] as const).find((lack) => negotiation.missing.includes(lack)) : undefined;
    if (missing && !copy.held) copy.held = { step: path, missing };
  };
  const visit = (steps: WorkflowStep[], scope: Scope): number => {
    const levels = new Map<string, number>();
    const widths: number[] = [];
    const byId = new Map(steps.map((step) => [step.id, step]));
    /** The first need of `step`, in `needs` order and through needs that write nothing, whose branch its copy starts from. */
    const startsFrom = (step: WorkflowStep, seen: Set<string>): WorkflowStep | undefined => {
      for (const need of step.needs ?? []) {
        const found = byId.get(need);
        if (!found || seen.has(need)) continue;
        seen.add(need);
        const writer = writes(found, scope.ancestors, childOf) ? found : startsFrom(found, seen);
        if (writer) return writer;
      }
      return undefined;
    };
    for (const step of steps) {
      const path = `${scope.prefix}${step.id}`;
      const child = childOf(step);
      if (step.hitl) {
        const { kind, options, required, default: defaultOption } = step.hitl;
        facts.gates.push({
          step: path, required, guards: guardsOf(step, steps, scope.prefix),
          ...(kind === 'choose' ? { kind, options, ...(defaultOption !== undefined ? { default: defaultOption } : {}) } : { kind, ...(step.deliver === 'pr' ? { deliver: true as const } : {}) }),
        });
      }
      if (!child && step.end === undefined && !runsInCheckout(step, scope.ancestors)) facts.inWorkspace.push(path);
      if (step.prompt !== undefined || step.promptFile !== undefined) facts.prompts.push(path);
      if (step.interactive) facts.interactive.push(path);
      if ((step.prompt !== undefined || step.promptFile !== undefined) && (step.model !== undefined || (step.agent === undefined && scope.defaultModel !== undefined))) facts.modeled.push(path);
      if (step.scorers && step.scorers.names.length > 0) facts.scored.push({ step: path, scorers: step.scorers.names });
      if (step.deliver === 'pr') {
        const seen = new Set<string>();
        let from = startsFrom(step, seen);
        while (from && from.deliver !== 'pr') from = startsFrom(from, seen);
        facts.deliver.push({ step: path, ...(from ? { onto: `${scope.prefix}${from.id}` } : {}) });
      }
      let own = 0;
      if (child) {
        const named = typeof step.workflow === 'string' ? workflows[step.workflow] : undefined;
        const setup = named?.setup ?? scope.setup;
        const defaultModel = named?.defaults?.model ?? scope.defaultModel;
        const limits = [step.forEach ? undefined : step.budget, named?.budget].flatMap((budget) => (budget ? [budget.tokens] : []));
        if (limits.length > 0) facts.budgets.push({ step: path, tokens: Math.min(...limits) });
        own = visit(child.steps, {
          prefix: `${path}.`, ancestors: [...scope.ancestors, step],
          requires: mergeRequirements(scope.requires, step.requires, named?.defaults?.requires),
          budgeted: scope.budgeted || step.budget !== undefined || named?.budget !== undefined,
          ...(setup ? { setup } : {}),
          ...(opensCopy(step) ? { copy: path } : scope.copy !== undefined ? { copy: scope.copy } : {}),
          ...(defaultModel !== undefined ? { defaultModel } : {}),
        });
      } else if (step.command !== undefined || step.prompt !== undefined || step.promptFile !== undefined) {
        own = 1;
        offer(step, path, scope);
      }
      const level = Math.max(-1, ...(step.needs ?? []).map((need) => levels.get(need) ?? -1)) + 1;
      levels.set(step.id, level);
      widths[level] = (widths[level] ?? 0) + (step.forEach ? (step.forEach.maxParallel ?? ceiling) * own : own);
    }
    return Math.max(0, ...widths.map((width) => width ?? 0));
  };
  facts.width = Math.min(ceiling, visit(definition.steps, {
    prefix: '', ancestors: [], requires: mergeRequirements(definition.defaults?.requires), budgeted: definition.budget !== undefined,
    ...(definition.setup ? { setup: definition.setup } : {}),
    ...(definition.defaults?.model !== undefined ? { defaultModel: definition.defaults.model } : {}),
  }));
  const route = [...copies].find(([, copy]) => copy.taken && copy.held);
  if (route?.[1].held) facts.localRoute = { opener: route[0], held: route[1].held.step, missing: route[1].held.missing };
  const { name, description, alias, invoke, inputs } = definition;
  return { name, description, ...(alias ? { alias } : {}), invoke: invoke ?? 'deny', inputs: inputs ?? {}, facts };
}

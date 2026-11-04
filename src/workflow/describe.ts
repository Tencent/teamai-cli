import { z } from 'zod';
import { sameEnvName } from '../resources/env-key.js';
import { mergeRequirements, negotiate, requiredEnvKeys, type Allow, type DriverCan, type EnvFacts, type InEffect, type Missing, type Setup } from './requirements.js';
import { stepWorkflow, workflowRunBy, type Invoke, type OutputSchema, type WorkflowDefinition, type WorkflowSource, type WorkflowStep } from './types.js';
import { confinedOf, copyOf, isRunLevel, levelsInside, opensCopy, roleLevelOf, runLevels, runsInCheckout, writesBranch, writtenRole, type RoleLevel } from './workspace.js';

/**
 * Why a driver cannot run a workflow to its end: a step it takes works in a workspace copy, the one the run opened
 * (`copy: 'run'`) or the one step `opener` opened (`copy: 'step'`), and a later step it is held from for `missing`
 * works in that copy too, which only the driver that took it may continue.
 */
export type LocalRoute = { held: string; missing: 'env' | 'tokens' } & ({ copy: 'run' } | { copy: 'step'; opener: string });

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

  if (step.prompt !== undefined || step.promptFile !== undefined || step.answer !== undefined) return { kind: 'prompt' };
  const child = stepWorkflow(step);

  if (child) return child.kind === 'named' ? { kind: 'workflow', name: child.name } : { kind: 'workflow' };

  if (step.end !== undefined) return prefix !== '' ? { kind: 'end', end: step.end, workflow: prefix.slice(0, -1) } : { kind: 'end', end: step.end };

  return { kind: 'none', waiting: steps.flatMap((other) => (other.needs?.includes(step.id) ? [`${prefix}${other.id}`] : [])) };
}

/** What a workflow will do, read from its definition before any run, as far as choosing how to start it needs. */
export interface WorkflowDescription {
  name: string;
  description: string;
  alias?: string;
  /** Whether the team's file or teamai's default runs under this name. */
  source: WorkflowSource;
  invoke: Invoke;
  /** Every input `start --inputs` must pass. */
  inputs: Record<string, OutputSchema>;
  facts: {
    /** Prompt steps, by path: an agent works in them. */
    prompts: string[];
    /** Interactive prompt steps, by path: a person works in them with the agent. */
    interactive: string[];
    /**
     * Prompt steps, by path, whose child runs a model resolved for the session's tool: the step's `model` as written,
     * or the `defaults.model` in effect for a step that names no `agent` or model. An exact model resolves for no tool.
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
    /** Prompt steps confined to a directory, by path, which only a confined tool or a fresh child answers. */
    confined: string[];
    /**
     * Steps that open a pull request once they succeed, by path. `onto`: the delivering step whose branch the step's
     * own starts from, whose pull request it targets; without it, the pull request targets `base`.
     */
    deliver: Array<{ step: string; onto?: string }>;
    /** The branch of the checkout a run would start from. Absent on a detached HEAD, from which no run delivers. */
    base?: string;
    /** The `requires.env` keys of every step and setup, by name, those with no value on this machine, and the declared subset. */
    requiresEnv: { keys: string[]; missingHere: string[]; declaredHere: string[] };
    /** Milliseconds a run may take. */
    timeout?: number;
    /** The tokens a run may spend, and those a workflow step may each time it starts, by path. */
    budgets: Array<{ step?: string; tokens: number }>;
    /**
     * Each step that runs a command or a prompt, by path, with what the machine that runs it needs: the `requires.env`
     * keys of the step and its setup, and the agent and `tool` of a prompt step, from which the driver picks its tool.
     */
    /** `answer`: the step is an answer step, which the local driver runs on the member's AI tool rather than a workflow tool. */
    runs: Array<{ step: string; executor: 'command' | 'prompt'; env: string[]; agent?: string; tool?: string; answer?: true }>;
    /** Steps the describing driver is held from, by path, with what it lacks, and the `requires.env` keys they need. */
    held: Array<{ step: string; missing: Missing[]; env: string[] }>;
    localRoute?: LocalRoute;
  };
}

type Facts = WorkflowDescription['facts'];

type Gate = Facts['gates'][number];

/** What the steps of one workflow in the tree run under, as the engine's scopes give it. */
interface Scope {
  prefix: string;
  requires: InEffect;
  budgeted: boolean;
  setup?: Setup;
  /** Who opened the copy its steps work in. */
  copy?: CopyOpener;
  /** The `defaults.model` in effect, as the engine's scope keeps it. */
  defaultModel?: string;
  /**
   * The levels around its steps, outermost first, the run's own copy included (`runLevels`), as the engine places a
   * step and resolves its role from them, and the `defaults.role` in effect.
   */
  around: RoleLevel[];
  defaultRole?: string;
}

/** The step that opened a copy, by path, or the run, as its workflow's header says `workspace: new`. */
type CopyOpener = { kind: 'run' } | { kind: 'step'; path: string };

/**
 * Describes `definition`, which runs the workflows in `workflows` by name, for a driver that declares `can`, under the
 * member's `allow` and this machine's `env`. A `for_each` with no `max_parallel`, or a template one its inputs decide at
 * start, counts as `ceiling` wide, and so does a run wider than it.
 */
export function describeWorkflow(input: {
  definition: WorkflowDefinition; source: WorkflowSource; workflows: Record<string, WorkflowDefinition>; ceiling: number; can: DriverCan; allow: Allow; env: EnvFacts; base?: string;
}): WorkflowDescription {
  const { definition, source, workflows, ceiling, can, allow, env, base } = input;
  const runEnvKeys = requiredEnvKeys([definition, ...Object.values(workflows)]);
  const branch: Pick<Facts, 'base'> = {};

  if (base !== undefined) branch.base = base;
  const limit: Pick<Facts, 'timeout'> = {};

  if (definition.timeout !== undefined) limit.timeout = definition.timeout;

  const facts: Facts = {
    prompts: [], interactive: [], modeled: [], width: 0, gates: [], inWorkspace: [], scored: [], confined: [], deliver: [], ...branch,
    requiresEnv: {
      keys: [...runEnvKeys],
      missingHere: [...runEnvKeys].filter((key) => sameEnvName(env.present, key) === undefined),
      declaredHere: [...runEnvKeys].filter((key) => sameEnvName(env.declared, key) !== undefined),
    },
    ...limit,
    budgets: definition.budget ? [{ tokens: definition.budget.tokens }] : [],
    runs: [],
    held: [],
  };

  /**
   * By the opener of each copy, the one object every scope in that copy shares: whether the driver takes a step in it,
   * and the first step in it the driver is held from.
   */
  const copies = new Map<CopyOpener, { taken: boolean; held?: { step: string; missing: LocalRoute['missing'] } }>();
  // Before a run, a `from` step's workflow does not exist yet.
  const childOf = (step: WorkflowStep) => workflowRunBy({ workflows }, step, '');

  /** As the engine's `offerTerms` asks `negotiate`, so describe holds exactly what `next` would hold. */
  const offer = (step: WorkflowStep, path: string, scope: Scope): void => {
    const hasContract = step.answer === undefined && !runsInCheckout(step, scope.around.map((level) => level.step));
    const requires = mergeRequirements(scope.requires, step.requires);
    const executor = step.command !== undefined ? 'command' : 'prompt';
    // The role of the copy it runs in, as the engine's `stepRoleOf` finds it; a role template stands for its item's role.
    const runsWith = copyOf([...scope.around, roleLevelOf(step, scope.defaultRole)])?.runsWith;
    const role = runsWith?.kind === 'role' ? writtenRole(runsWith.role) : undefined;
    const setupEnv = hasContract ? scope.setup?.requires?.env ?? [] : [];
    const run: Facts['runs'][number] = { step: path, executor, env: [...new Set([...requires.env ?? [], ...setupEnv])] };

    if (executor === 'prompt' && step.agent !== undefined) run.agent = step.agent;

    if (executor === 'prompt' && step.tool !== undefined) run.tool = step.tool;

    if (step.answer !== undefined) run.answer = true;
    facts.runs.push(run);

    const negotiation = negotiate({
      // Whether the driver calls next --prepare is not part of its can: a step in a clone, or with a role, is described as a
      // driver with clone, or with role, takes it.
      step: path, executor, requires, prepare: role !== undefined, clone: false, role,
      interactive: step.interactive === true, hasContract, envKeys: Object.keys(step.env ?? {}), runEnvKeys, budgeted: step.prompt !== undefined && scope.budgeted,
      maxTurns: step.maxTurns, setup: hasContract ? scope.setup : undefined,
      tool: step.tool,
      unattended: step.permissions === 'unattended',
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
        const writer = writesBranch(found, scope.around, childOf) ? found : startsFrom(found, seen);

        if (writer) return writer;
      }

      return undefined;
    };

    for (const step of steps) {
      const path = `${scope.prefix}${step.id}`;
      const child = childOf(step);

      if (step.hitl) {
        const { kind, options, required, default: defaultOption } = step.hitl;
        const asked = { step: path, required, guards: guardsOf(step, steps, scope.prefix) };

        if (kind === 'choose') {
          const gate: Extract<Gate, { kind: 'choose' }> = { ...asked, kind, options };

          if (defaultOption !== undefined) gate.default = defaultOption;
          facts.gates.push(gate);
        } else {
          const gate: Extract<Gate, { kind: 'approve' }> = { ...asked, kind };

          if (step.deliver === 'pr') gate.deliver = true;
          facts.gates.push(gate);
        }
      }

      if (!child && step.end === undefined && step.answer === undefined && !runsInCheckout(step, scope.around.map((level) => level.step))) facts.inWorkspace.push(path);

      if (step.prompt !== undefined || step.promptFile !== undefined || step.answer !== undefined) facts.prompts.push(path);

      if (step.interactive) facts.interactive.push(path);

      if ((step.prompt !== undefined || step.promptFile !== undefined) && (z.string().safeParse(step.model).success || (step.model === undefined && step.agent === undefined && scope.defaultModel !== undefined))) facts.modeled.push(path);

      if (step.scorers && step.scorers.names.length > 0) facts.scored.push({ step: path, scorers: step.scorers.names });

      if (confinedOf(step) !== undefined) facts.confined.push(path);

      if (step.deliver === 'pr') {
        const seen = new Set<string>();
        let from = startsFrom(step, seen);

        while (from && from.deliver !== 'pr') from = startsFrom(from, seen);
        const delivery: Facts['deliver'][number] = { step: path };

        if (from) delivery.onto = `${scope.prefix}${from.id}`;
        facts.deliver.push(delivery);
      }

      let own = 0;

      if (child) {
        const runs = stepWorkflow(step);
        const named = runs?.kind === 'named' ? workflows[runs.name] : undefined;
        const setup = named?.setup ?? scope.setup;
        const defaultModel = named?.defaults?.model ?? scope.defaultModel;
        const defaultRole = named?.defaults?.role ?? scope.defaultRole;
        const limits = [step.forEach ? undefined : step.budget, named?.budget].flatMap((budget) => (budget ? [budget.tokens] : []));

        if (limits.length > 0) facts.budgets.push({ step: path, tokens: Math.min(...limits) });
        const around = levelsInside(scope.around, roleLevelOf(step, scope.defaultRole), child);
        const placed = around.at(-1)?.step;
        own = visit(child.steps, {
          prefix: `${path}.`,
          requires: mergeRequirements(scope.requires, step.requires, named?.defaults?.requires),
          budgeted: scope.budgeted || step.budget !== undefined || named?.budget !== undefined,
          setup,
          copy: placed && opensCopy(placed) ? { kind: 'step', path } : scope.copy,
          defaultModel,
          around,
          defaultRole,
        });
      } else if (step.command !== undefined || step.prompt !== undefined || step.promptFile !== undefined || step.answer !== undefined) {
        own = 1;
        offer(step, path, scope);
      } else if (stepWorkflow(step)?.kind === 'from') {
        // Its workflow does not exist yet, but every step of it inherits what this one requires: a driver that lacks
        // that is held from the step itself, as from a step that runs in a copy of its own.
        const requires = mergeRequirements(scope.requires, step.requires);

        const negotiation = negotiate({
          step: path, executor: 'command', requires, prepare: true, clone: false,
          interactive: false, hasContract: true, envKeys: [], runEnvKeys, budgeted: false, unattended: false,
        }, can, allow, env);

        if (negotiation.kind === 'hold') facts.held.push({ step: path, missing: negotiation.missing, env: requires.env ?? [] });
      }

      const level = Math.max(-1, ...(step.needs ?? []).map((need) => levels.get(need) ?? -1)) + 1;
      levels.set(step.id, level);
      const declared = step.forEach?.maxParallel;
      const itemWidth = declared === undefined || declared instanceof Object ? ceiling : declared;
      widths[level] = (widths[level] ?? 0) + (step.forEach ? itemWidth * own : own);
    }

    return Math.max(0, ...widths.map((width) => width ?? 0));
  };

  const top: Scope = {
    prefix: '', requires: mergeRequirements(definition.defaults?.requires), budgeted: definition.budget !== undefined,
    setup: definition.setup,
    defaultModel: definition.defaults?.model,
    around: runLevels(definition).map((step) => roleLevelOf(step, definition.defaults?.role)),
    defaultRole: definition.defaults?.role,
  };

  if (top.around.some((level) => isRunLevel(level.step))) top.copy = { kind: 'run' };

  // The finally steps run under the same scope once the steps settled, never beside them.
  facts.width = Math.min(ceiling, Math.max(visit(definition.steps, top), visit(definition.finally ?? [], top)));
  const route = [...copies].find(([, copy]) => copy.taken && copy.held);

  if (route?.[1].held) {
    const [opener, { held }] = route;

    switch (opener.kind) {
      case 'run':
        facts.localRoute = { copy: 'run', held: held.step, missing: held.missing };
        break;
      case 'step':
        facts.localRoute = { copy: 'step', opener: opener.path, held: held.step, missing: held.missing };
        break;
      default: {
        const unhandled: never = opener;

        return unhandled;
      }
    }
  }

  const { name, description, alias, invoke, inputs } = definition;

  const aliased: Pick<WorkflowDescription, 'alias'> = {};

  if (alias) aliased.alias = alias;

  return { name, description, ...aliased, source, invoke: invoke ?? 'deny', inputs: inputs ?? {}, facts };
}

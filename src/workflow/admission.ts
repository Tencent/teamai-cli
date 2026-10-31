/**
 * Admission: what a run takes in before it runs a workflow. `startRun` admits a workflow from the cache; a `from` step's
 * producer gets its workflow output admitted when it reports. Either way the run gets the definitions it runs, the
 * scorers their steps list pinned, and no secret value, and its delivery is checked.
 */
import { stringify } from 'yaml';
import { z } from 'zod';
import { secretKey } from '../env-resolution.js';
import { pinScorers, syncScorerDefinitions } from '../scorers/cache.js';
import { PinnedScorerSchema, type PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import { redactJson } from '../utils/redact.js';
import { withTeamRevision, workflowsRunBy } from './cache.js';
import { formatDiagnostic, parseWorkflow } from './parse.js';
import type { WorkflowFiles } from './parse-context.js';
import { mergeRequirements, type InEffect } from './requirements.js';
import { stepWorkflow, type RunState, type WorkflowDefinition, type WorkflowFailure, type WorkflowStep } from './types.js';
import { deliveryProblem } from './workspace.js';

/** A workflow admitted for a run: its definition, the workflows it runs by name, and the scorers their steps list, pinned. */
export interface Admitted {
  definition: WorkflowDefinition;
  workflows: Record<string, WorkflowDefinition>;
  scorers: Record<string, PinnedScorer>;
}

/**
 * What is admitted: a workflow the cache holds, with every workflow it runs; or the output of step `step`, whose field
 * `field` holds a workflow bundle that `from` steps run under the requirements `runsUnder` lists, one for each.
 */
export type Candidate =
  | { kind: 'cached'; definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition> }
  | { kind: 'output'; step: string; field: string; output: Record<string, unknown>; runsUnder: readonly InEffect[] };

/**
 * A workflow bundle as a step prints it: the definition, the workflows it runs by name under the keys it names them by,
 * the scorers generated for it, whose names hold a colon, and the team commit its team scorers are pinned at.
 */
const BundleSchema = z.object({
  definition: z.record(z.string(), z.unknown()),
  workflows: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  scorers: z.record(z.string().regex(/:/), PinnedScorerSchema.extend({ generated: z.literal(true) }), { error: (issue) => issue.code === 'invalid_key' ? 'a generated scorer name holds a colon, such as teamai:correctness:<task>' : undefined }).optional(),
  teamRevision: z.string().min(1).optional(),
}).strict();

/**
 * Admits `candidate` for a run whose workspaces start from `base`. The team scorers its steps list are pinned as the
 * member's cache holds them, or, for a bundle with `teamRevision`, as that team commit stores them; a name without a
 * valid version is left out. Refused when a bundle does not parse as workflow files, when it cannot deliver what its
 * steps declare, or when what it pins holds one of `secrets`, which a run never stores.
 */
export async function admitWorkflow(
  config: LocalConfig, candidate: Candidate, { secrets, base }: { secrets: Record<string, string>; base?: RunState['base'] },
): Promise<{ admitted: Admitted } | { failure: WorkflowFailure }> {
  if (candidate.kind === 'cached') {
    const { definition, workflows } = candidate;
    const scorers = await pinScorers(config, listedScorers([definition, ...Object.values(workflows)]));
    const pinned = Object.fromEntries([
      ...[definition, ...Object.values(workflows)].map((pinnedDefinition) => [`workflows/${pinnedDefinition.name}.yaml`, pinnedDefinition]),
      ...Object.entries(scorers).map(([scorerName, scorer]) => [`scorer ${scorerName}`, scorer]),
    ]);
    const secret = pinnedSecret(pinned, secrets);
    if (secret) {
      return { failure: { code: 'invalid_inputs', message: `${secret.label} holds the value of ${secret.name}, a secret on this machine, which a run never stores. Replace the value with requires.env: [${secret.name}], then pull again.` } };
    }
    const unsandboxed = unattendedUnsandboxed(definition, workflows, {});
    if (unsandboxed !== undefined) return { failure: { code: 'unattended_unsandboxed', message: `Step "${unsandboxed}" ${UNATTENDED_NEEDS}` } };
    return checked({ definition, workflows, scorers }, base);
  }
  const { step, field, output, runsUnder } = candidate;
  const refuse = (why: string): { failure: WorkflowFailure } => ({
    failure: { code: 'invalid_output', message: `Step "${step}" output ${field} is not a workflow this run can admit: ${why}` },
  });
  const secret = pinnedSecret({ output }, secrets);
  if (secret) return refuse(`the output holds the value of ${secret.name}, a secret on this machine, which a run never stores. Print requires.env: [${secret.name}] in its place.`);
  const bundle = BundleSchema.safeParse(output[field]);
  if (!bundle.success) {
    const issues = bundle.error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
    return refuse(`${issues.join('; ')}; a bundle is { definition, workflows?, scorers?, teamRevision? }`);
  }
  const parsed = parseBundle(bundle.data.definition, bundle.data.workflows ?? {});
  if ('failed' in parsed) return refuse(parsed.failed);
  // A bundle no `from` step runs is checked as one with no floor, so it never brings an unattended step unchecked.
  const unsandboxed = (runsUnder.length > 0 ? runsUnder : [{}]).map((outer) => unattendedUnsandboxed(parsed.definition, parsed.workflows, outer)).find((path) => path !== undefined);
  if (unsandboxed !== undefined) return refuse(`step "${unsandboxed}" ${UNATTENDED_NEEDS}`);
  const listed = listedScorers([parsed.definition, ...Object.values(parsed.workflows)]);
  const { teamRevision } = bundle.data;
  const team = teamRevision === undefined ? { pins: await pinScorers(config, listed) } : await withTeamRevision(config, teamRevision, async (at) => {
    await syncScorerDefinitions(at, { scopeLabel: `team commit ${teamRevision.slice(0, 7)}` });
    return { pins: await pinScorers(at, listed) };
  });
  if ('failed' in team) return refuse(`its team scorers could not be read at team commit ${teamRevision}: ${team.failed}`);
  // The output was checked, not the team scorers it names, which the run stores as they are.
  const pinnedTeamSecret = pinnedSecret(Object.fromEntries(Object.entries(team.pins).map(([scorerName, scorer]) => [`scorer ${scorerName}`, scorer])), secrets);
  if (pinnedTeamSecret) return refuse(`${pinnedTeamSecret.label} holds the value of ${pinnedTeamSecret.name}, a secret on this machine, which a run never stores. Take the value out of that team scorer, then pull again.`);
  return checked({ ...parsed, scorers: { ...team.pins, ...bundle.data.scorers } }, base);
}

/** `admitted`, unless it cannot deliver what its steps declare from `base`. */
function checked(admitted: Admitted, base: RunState['base']): { admitted: Admitted } | { failure: WorkflowFailure } {
  const undeliverable = deliveryProblem(admitted.definition, admitted.workflows, base);
  return undeliverable ? { failure: undeliverable } : { admitted };
}

/** The first of `pinned`, by label, that holds a value of `secrets`, with the name of that secret. */
function pinnedSecret(pinned: Record<string, unknown>, secrets: Record<string, string>): { label: string; name: string } | undefined {
  for (const [label, value] of Object.entries(pinned)) {
    const held = heldSecret(value, secrets);
    const name = held && secretKey(held);
    if (name) return { label, name };
  }
  return undefined;
}

/**
 * A bundle's definition and its workflows, each written as YAML and parsed as the workflow file `workflows/<key>.yaml`,
 * so a step that runs one by name is checked against it, as a pull checks the team's files. A bundle's workflows run
 * no `from` step and read no prompt file: the run has no producer for the one, and no team file for the other.
 */
function parseBundle(
  definition: Record<string, unknown>, workflows: Record<string, Record<string, unknown>>,
): { definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition> } | { failed: string } {
  const sources = new Map<string, string>(Object.entries(workflows).map(([key, value]) => [key, stringify(value, { aliasDuplicateObjects: false })]));
  const name = typeof definition.name === 'string' ? definition.name : 'definition';
  // Each file alone first, so the check of a step that runs one by name has the definition it runs.
  const alone = new Map([...sources].flatMap(([key, content]) => {
    const parsed = parseWorkflow(`workflows/${key}.yaml`, content);
    return parsed.ok ? [[key, parsed.definition] as const] : [];
  }));
  const runs = (workflow: string): WorkflowDefinition | null => alone.get(workflow) ?? null;
  const cycleBack = (from: string, to: string): string[] | undefined => {
    const seen = new Set<string>();
    const walk = (workflow: string, through: string[]): string[] | undefined => {
      if (workflow === to) return [...through, workflow];
      if (seen.has(workflow)) return undefined;
      seen.add(workflow);
      const runsNext = runs(workflow);
      for (const { workflow: next } of runsNext ? workflowsRunBy(runsNext) : []) {
        const cycle = walk(next, [...through, workflow]);
        if (cycle) return cycle;
      }
      return undefined;
    };
    return walk(from, [to]);
  };
  const parse = (key: string, content: string): WorkflowDefinition | string => {
    const files: WorkflowFiles = { runnable: runs, cycle: (workflow) => cycleBack(workflow, key) };
    const parsed = parseWorkflow(`workflows/${key}.yaml`, content, files);
    if (!parsed.ok) return parsed.diagnostics.map(formatDiagnostic).join('; ');
    const unrunnable = unrunnableStep(parsed.definition.steps);
    return unrunnable ? `workflows/${key}.yaml: ${unrunnable}` : parsed.definition;
  };
  const top = parse(name, stringify(definition, { aliasDuplicateObjects: false }));
  if (typeof top === 'string') return { failed: top };
  const parsed: Record<string, WorkflowDefinition> = {};
  for (const [key, content] of sources) {
    const child = parse(key, content);
    if (typeof child === 'string') return { failed: child };
    parsed[key] = child;
  }
  return { definition: top, workflows: parsed };
}

/** Why a step of a bundle cannot run, inline workflows included: it runs a `from` step, or reads a prompt file. */
function unrunnableStep(steps: readonly WorkflowStep[], prefix = ''): string | undefined {
  for (const step of steps) {
    const child = stepWorkflow(step);
    if (child?.kind === 'from') return `step "${prefix}${step.id}" runs workflow: { from }, which a workflow output may not`;
    if (step.promptFile !== undefined) return `step "${prefix}${step.id}" has prompt_file, which a workflow output may not; print the prompt as prompt`;
    const inner = child?.kind === 'inline' ? unrunnableStep(child.workflow.steps, `${prefix}${step.id}.`) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

const UNATTENDED_NEEDS = 'sets permissions: unattended, which only a strict sandbox allows. Add requires: { isolation: sandbox, strict: true } to it, to a step around it, to defaults, or to the step that runs its workflow.';

/**
 * The path of the first step of `definition`, run under `outer`, whose `permissions: unattended` no strict
 * `isolation: sandbox` floor covers, as the engine's scopes merge requirements: the step's own, the steps around it,
 * `defaults`, and the step that runs a workflow file by name.
 */
function unattendedUnsandboxed(definition: WorkflowDefinition, workflows: Record<string, WorkflowDefinition>, outer: InEffect): string | undefined {
  const visit = (steps: readonly WorkflowStep[], scope: InEffect, prefix: string): string | undefined => {
    for (const step of steps) {
      const path = `${prefix}${step.id}`;
      const requires = mergeRequirements(scope, step.requires);
      if (step.permissions === 'unattended' && requires.floor?.isolation !== 'sandbox') return path;
      const child = stepWorkflow(step);
      const named = child?.kind === 'named' ? workflows[child.name] : undefined;
      const inner = child?.kind === 'inline' ? visit(child.workflow.steps, requires, `${path}.`)
        : named ? visit(named.steps, mergeRequirements(requires, named.defaults?.requires), `${path}.`) : undefined;
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return visit(definition.steps, mergeRequirements(outer, definition.defaults?.requires), '');
}

/** The name of the first of `secrets` whose value `value` holds, as the run file would mask it. */
export function heldSecret(value: unknown, secrets: Record<string, string>): string | undefined {
  const text = JSON.stringify(value);
  return Object.entries(secrets).find(([name, secret]) => JSON.stringify(redactJson(value, { [name]: secret })) !== text)?.[0];
}

/** Every scorer name a step of `definitions` lists, inline workflows included. */
function listedScorers(definitions: ReadonlyArray<{ steps: WorkflowStep[] }>): string[] {
  return definitions.flatMap((definition) => definition.steps.flatMap((step) => {
    const child = stepWorkflow(step);
    return [...step.scorers?.names ?? [], ...(child?.kind === 'inline' ? listedScorers([child.workflow]) : [])];
  }));
}

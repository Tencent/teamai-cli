/**
 * Admission: what a run takes in before it runs a workflow. `startRun` admits a workflow from the cache; a `from` step's
 * producer gets its workflow output admitted when it reports. Either way the run gets the definitions it runs and no
 * secret value, and its delivery is checked.
 */
import { stringify } from 'yaml';
import { z } from 'zod';
import { secretKey } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { redactJson } from '../utils/redact.js';
import { workflowsRunBy } from './cache.js';
import { formatDiagnostic, parseWorkflow } from './parse.js';
import type { WorkflowFiles } from './parse-context.js';
import { mergeRequirements, type InEffect } from './requirements.js';
import { stepWorkflow, type AdmittedWorkflow, type RunState, type WorkflowDefinition, type WorkflowFailure, type WorkflowStep } from './types.js';
import { deliveryProblem } from './workspace.js';

/** A workflow admitted for a run: its definition, and the workflows it runs by name. */
export interface Admitted {
  definition: WorkflowDefinition;
  workflows: Record<string, WorkflowDefinition>;
}

/**
 * What is admitted: a workflow the cache holds, with every workflow it runs; or the output of step `step`, whose field
 * `field` holds a workflow bundle that `from` steps run under the requirements `runsUnder` lists, one for each.
 */
export type Candidate =
  | { kind: 'cached'; definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition> }
  | { kind: 'output'; step: string; field: string; output: AdmittedWorkflow['output']; runsUnder: readonly InEffect[] };

/** A workflow bundle as a step prints it: the definition, and the workflows it runs by name under the keys it names them by. */
const BundleSchema = z.object({
  definition: z.record(z.string(), z.unknown()),
  workflows: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).strict();

type Bundle = z.infer<typeof BundleSchema>;

/** Why a candidate was not admitted. */
type Refusal = { failure: WorkflowFailure };

/**
 * Admits `candidate` for a run whose workspaces start from `base`. Refused when a bundle does not parse as workflow
 * files, when it cannot deliver what its steps declare, or when what it pins holds one of `secrets`, which a run never
 * stores.
 */
export async function admitWorkflow(
  config: LocalConfig, candidate: Candidate, { secrets, base }: { secrets: Record<string, string>; base?: RunState['base'] },
): Promise<{ admitted: Admitted } | Refusal> {
  if (candidate.kind === 'cached') {
    const { definition, workflows } = candidate;
    const pinned = Object.fromEntries([definition, ...Object.values(workflows)].map((pinnedDefinition) => [`workflows/${pinnedDefinition.name}.yaml`, pinnedDefinition]));

    const secret = pinnedSecret(pinned, secrets);

    if (secret) {
      return { failure: { code: 'invalid_inputs', message: `${secret.label} holds the value of ${secret.name}, a secret on this machine, which a run never stores. Replace the value with requires.env: [${secret.name}], then pull again.` } };
    }

    const unsandboxed = unattendedUnsandboxed(definition, workflows, {});

    if (unsandboxed !== undefined) return { failure: { code: 'unattended_unsandboxed', message: `Step "${unsandboxed}" ${UNATTENDED_NEEDS}` } };

    return checked({ definition, workflows }, base);
  }

  const { step, field, output, runsUnder } = candidate;

  const refuse = (why: string): Refusal => ({
    failure: { code: 'invalid_output', message: `Step "${step}" output ${field} is not a workflow this run can admit: ${why}` },
  });

  const secret = pinnedSecret({ output }, secrets);

  if (secret) return refuse(`the output holds the value of ${secret.name}, a secret on this machine, which a run never stores. Print requires.env: [${secret.name}] in its place.`);
  const bundle = BundleSchema.safeParse(output[field]);

  if (!bundle.success) {
    const issues = bundle.error.issues.map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`);

    return refuse(`${issues.join('; ')}; a bundle is { definition, workflows? }`);
  }

  const parsed = parseBundle(bundle.data.definition, bundle.data.workflows ?? {});

  if ('failed' in parsed) return refuse(parsed.failed);
  // A bundle no `from` step runs is checked as one with no floor, so it never brings an unattended step unchecked.
  const unsandboxed = (runsUnder.length > 0 ? runsUnder : [{}]).map((outer) => unattendedUnsandboxed(parsed.definition, parsed.workflows, outer)).find((path) => path !== undefined);

  if (unsandboxed !== undefined) return refuse(`step "${unsandboxed}" ${UNATTENDED_NEEDS}`);

  return checked(parsed, base);
}

/** `admitted`, unless it cannot deliver what its steps declare from `base`. */
function checked(admitted: Admitted, base: RunState['base']): { admitted: Admitted } | Refusal {
  const undeliverable = deliveryProblem(admitted.definition, admitted.workflows, base);

  return undeliverable ? { failure: undeliverable } : { admitted };
}

/** The first of `pinned`, by label, that holds a value of `secrets`, with the name of that secret. */
function pinnedSecret<TPinned>(pinned: Record<string, TPinned>, secrets: Record<string, string>): { label: string; name: string } | undefined {
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
 * no `from` step, read no prompt file, and have no `finally`: the run has no producer for the first, no team file for
 * the second, and runs only its own workflow's `finally`.
 */
function parseBundle(
  definition: Bundle['definition'], workflows: NonNullable<Bundle['workflows']>,
): { definition: WorkflowDefinition; workflows: Record<string, WorkflowDefinition> } | { failed: string } {
  const sources = new Map<string, string>(Object.entries(workflows).map(([key, value]) => [key, stringify(value, { aliasDuplicateObjects: false })]));
  const name = z.string().safeParse(definition.name).data ?? 'definition';

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

  const parse = (key: string, content: string): { definition: WorkflowDefinition } | { failed: string } => {
    const files: WorkflowFiles = { runnable: runs, cycle: (workflow) => cycleBack(workflow, key) };
    const parsed = parseWorkflow(`workflows/${key}.yaml`, content, files);

    if (!parsed.ok) return { failed: parsed.diagnostics.map(formatDiagnostic).join('; ') };

    if (parsed.definition.finally) return { failed: `workflows/${key}.yaml has finally steps, which a workflow output may not; only a run of that workflow runs them` };
    const unrunnable = unrunnableStep(parsed.definition.steps);

    return unrunnable ? { failed: `workflows/${key}.yaml: ${unrunnable}` } : { definition: parsed.definition };
  };

  const top = parse(name, stringify(definition, { aliasDuplicateObjects: false }));

  if ('failed' in top) return top;
  const parsed: Record<string, WorkflowDefinition> = {};

  for (const [key, content] of sources) {
    const child = parse(key, content);

    if ('failed' in child) return child;
    parsed[key] = child.definition;
  }

  return { definition: top.definition, workflows: parsed };
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
export function heldSecret<TValue>(value: TValue, secrets: Record<string, string>): string | undefined {
  const text = JSON.stringify(value);

  return Object.entries(secrets).find(([name, secret]) => JSON.stringify(redactJson(value, { [name]: secret })) !== text)?.[0];
}

/**
 * The attempt a score verb runs in: a leased step of a `teamai-score` instance, found from the attempt marker and the run
 * directory the engine gives a step's process. A root run of `teamai-score` is an instance, and so is a step of another
 * workflow that runs it. A verb an agent calls from its own shell finds no attempt, so it writes nothing.
 */
import path from 'node:path';
import { z } from 'zod';
import { ATTEMPT_ENV, RUN_DIR_ENV } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { isSameRealPath } from '../utils/fs.js';
import { findRunConfig } from '../workflow/run-location.js';
import { parseStepPath } from '../workflow/step-path.js';
import { AttemptIdSchema, RunIdSchema, runScratchDir } from '../workflow/store.js';
import { SCORE_WORKFLOW } from './judging-workflows.js';
import { isWorkflowFile, workflowRunBy, type InlineWorkflow, type RunState, type WorkflowDefinition, type WorkflowStep } from '../workflow/types.js';

/** A `teamai-score` instance: its definition, what each of its step paths starts with, and the inputs it was given. */
export interface ScoreInstance {
  prefix: string;
  definition: WorkflowDefinition;
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- the run stores the inputs its start or its `with` checked as Record<string, unknown>
  inputs: Record<string, unknown>;
}

export interface ScoreAttempt {
  /** The scope that holds the root run. */
  config: LocalConfig;
  /** The root run: its id is the one every workflow inside it reads as `run.id`. */
  run: RunState;
  attempt: string;
  /** The path of the leased step. */
  step: string;
  instance: ScoreInstance;
  /** `$TEAMAI_RUN_DIR/<attempt>`: the attempt's own directory, which no parallel item shares. */
  dir: string;
  /** The instance's `label` input, a hand label; '' for none. */
  hand: string;
  /** The instance's `files` input: scorer files it labels with in place of named scorers. */
  files: string[];
  /** The instance's `store` input: false when its labels are only tried. A run started before the input existed stores. */
  storesLabels: boolean;
  /** The instance's `control` input: it judges a session's first prompt alone. */
  isControl: boolean;
}

/** Why a verb that runs only inside a leased attempt was refused. */
type AttemptRefused = { ok: false; code: 'score_attempt_required'; message: string };

export type ScoreAttemptRead = { ok: true; attempt: ScoreAttempt } | AttemptRefused;

function refused(verb: string, why: string, workflow = SCORE_WORKFLOW): AttemptRefused {
  return {
    ok: false,
    code: 'score_attempt_required',
    message: `teamai score ${verb} runs only as a step of a ${workflow} run, in the attempt the engine leased it: ${why}. Nothing was written.`,
  };
}

/** A leased attempt of any workflow: the scope and the root run, the leased step, and the attempt's own directory. */
type Leased = Omit<ScoreAttempt, 'instance' | 'hand' | 'files' | 'storesLabels' | 'isControl'>;

/** The attempt `env` names, when `$TEAMAI_RUN_DIR` is its run's directory and it holds a lease of that run; else why not. */
async function leasedAttempt(env: NodeJS.ProcessEnv, current: LocalConfig | undefined): Promise<{ ok: true; leased: Leased } | { ok: false; why: string }> {
  const [runPart, attemptPart, ...rest] = (env[ATTEMPT_ENV] ?? '').split('/');
  const runId = RunIdSchema.safeParse(runPart);
  const attemptId = AttemptIdSchema.safeParse(attemptPart);
  const runDir = env[RUN_DIR_ENV];

  if (!runId.success || !attemptId.success || rest.length > 0 || !runDir) return { ok: false, why: `${ATTEMPT_ENV} and ${RUN_DIR_ENV} name no workflow attempt` };
  const found = await findRunConfig(runId.data, current);

  if ('error' in found) return { ok: false, why: `run ${runId.data} is not on this machine (${found.error.code}: ${found.error.message})` };
  const { config, run } = found;

  if (!await isSameRealPath(runScratchDir(config, run.id), runDir)) return { ok: false, why: `${RUN_DIR_ENV} is not the directory of run ${run.id}` };
  const leased = run.steps.find((state) => state.status === 'leased' && state.attempt === attemptId.data);

  if (!leased) return { ok: false, why: `attempt ${attemptId.data} holds no lease of run ${run.id}` };

  return { ok: true, leased: { config, run, attempt: attemptId.data, step: leased.id, dir: path.join(runDir, attemptId.data) } };
}

/** The innermost `teamai-score` workflow file the step at `stepPath` is in, with the path its steps start with. */
function instanceOf(run: RunState, stepPath: string): Omit<ScoreInstance, 'inputs'> | undefined {
  let workflow: WorkflowDefinition | InlineWorkflow | undefined = run.definition;
  let prefix = '';
  let found: Omit<ScoreInstance, 'inputs'> | undefined;

  for (const segment of stepPath.split('.')) {
    if (!workflow) return undefined;

    if (isWorkflowFile(workflow) && workflow.name === SCORE_WORKFLOW) found = { prefix, definition: workflow };
    const { id } = parseStepPath(segment)[0] ?? { id: segment };
    const step: WorkflowStep | undefined = workflow.steps.find((each) => each.id === id);
    workflow = step && workflowRunBy(run, step, prefix);
    prefix = `${prefix}${segment}.`;
  }

  return found;
}

/** The inputs of the instance at `prefix`: the root run's, or those the step that runs it passed. */
function inputsAt(run: RunState, prefix: string): ScoreInstance['inputs'] {
  if (prefix === '') return run.inputs ?? {};

  return run.steps.find((state) => state.id === prefix.slice(0, -1))?.inputs ?? {};
}

export const ScoreAttempt = {
  /**
   * The attempt `env` names, when the run its `$TEAMAI_RUN_DIR` belongs to holds that attempt as the lease of a step
   * inside a `teamai-score` instance. `current` is the scope of the verb's directory, searched first.
   */
  async read(verb: string, env: NodeJS.ProcessEnv, current: LocalConfig | undefined): Promise<ScoreAttemptRead> {
    const found = await leasedAttempt(env, current);

    if (!found.ok) return refused(verb, found.why);
    const { leased } = found;
    const instance = instanceOf(leased.run, leased.step);

    if (!instance) return refused(verb, `step ${leased.step} of run ${leased.run.id} is not inside a ${SCORE_WORKFLOW} instance`);

    const inputs = inputsAt(leased.run, instance.prefix);

    return {
      ok: true,
      attempt: {
        ...leased, instance: { ...instance, inputs },
        hand: z.string().catch('').parse(inputs.label),
        files: z.array(z.string()).catch([]).parse(inputs.files),
        storesLabels: z.boolean().catch(true).parse(inputs.store),
        isControl: z.boolean().catch(false).parse(inputs.control),
      },
    };
  },

  /** The leased attempt of a step of `workflow` that `env` names, for a verb that reads what teamai-score instances of its run wrote. */
  async leased(verb: string, workflow: string, env: NodeJS.ProcessEnv, current: LocalConfig | undefined): Promise<{ ok: true; leased: Leased } | AttemptRefused> {
    const found = await leasedAttempt(env, current);

    return found.ok ? found : refused(verb, found.why, workflow);
  },

  /** Whether the instance keeps a step `id`, at any depth of its inline workflows, so a team file that drops it drops that stage. */
  keepsStep(instance: ScoreInstance, id: string): boolean {
    const keeps = (steps: readonly WorkflowStep[]): boolean => steps.some((step) => step.id === id
      || (step.workflow instanceof Object && 'steps' in step.workflow && keeps(step.workflow.steps)));

    return keeps(instance.definition.steps);
  },
} as const;

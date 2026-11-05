/**
 * What a team's `teamai-score.yaml` may change, checked at pull against teamai's default. A team may reword the judge
 * prompt around the rubric and the schema, reorder the stages or drop `ci` and `protected`. It may not change what the
 * run takes or gives, run anything but the score verbs as the default runs them, drop a verb that keeps a label honest,
 * or let a prompt read anything but the evidence an earlier step wrote. A refusal is a coded diagnostic, so no older
 * version of the file keeps running: the default does.
 */
import { REPORTS_BRANCH, type LocalConfig } from '../types.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { stepWorkflow, type WorkflowDefaults, type WorkflowDefinition, type WorkflowDiagnostic, type WorkflowStep } from '../workflow/types.js';
import { confinedOf } from '../workflow/workspace.js';
import { anyScorerChecks, cachedScorerNames } from './cache.js';
import { JUDGING_WORKFLOWS, SCORE_WORKFLOW, type ScoreItemStep } from './judging-workflows.js';

/** Why pull refuses a team teamai-score.yaml, one code per part of this contract. */
export type ScoreOverrideCode = 'score_override_contract' | 'score_override_command' | 'score_override_workflow_step' | 'score_override_prompt' | 'score_override_confined_dir' | 'score_override_judge_prompt' | 'score_override_step_missing' | 'score_override_publish';

const LABELS_GO_THROUGH = 'which every label of teamai\'s default teamai-score goes through';

/** The steps a team file must keep, by path, with why; `score.check` too while a scorer here has a check. */
const KEPT = {
  plan: 'which teamai score and its drain read the groups of a run from',
  'score.evidence': LABELS_GO_THROUGH,
  'score.judge': 'which teamai score and its drain read a judge still open from',
  'score.label': LABELS_GO_THROUGH,
  'score.write': LABELS_GO_THROUGH,
  'score.publish': LABELS_GO_THROUGH,
  'score.settle': LABELS_GO_THROUGH,
} as const satisfies Record<'plan' | `score.${ScoreItemStep}`, string>;

const PUBLISH = 'teamai score publish';

/** The condition that keeps a run that only tries scorers (`store: false`) from publishing the scope's pending labels. */
const PUBLISH_IF = 'inputs.store';

/** One refusal, before pull locates it in the file. */
type Problem = Pick<WorkflowDiagnostic, 'field' | 'message'> & { code: ScoreOverrideCode };

/** The keys of a workflow file that hold a list of steps. */
type StepList = { [K in keyof WorkflowDefinition]-?: NonNullable<WorkflowDefinition[K]> extends WorkflowStep[] ? K : never }[keyof WorkflowDefinition];

/** Every step list a workflow file has, so a list added to the schema fails the type check until it is walked. */
const STEP_LISTS = { steps: 'steps', finally: 'finally' } as const satisfies { [K in StepList]: K };

/**
 * A step of the file: its list, and its path there, such as `score.judge` inside the inline workflow of `score`.
 * `field` is where pull locates it, such as `steps.score.judge`.
 */
interface Walked {
  list: StepList;
  path: string;
  field: string;
  step: WorkflowStep;
}

function walkSteps(list: StepList, steps: readonly WorkflowStep[], prefix = ''): Walked[] {
  return steps.flatMap((step) => {
    const path = `${prefix}${step.id}`;
    const child = stepWorkflow(step);

    return [{ list, path, field: `${list}.${path}`, step }, ...(child?.kind === 'inline' ? walkSteps(list, child.workflow.steps, `${path}.`) : [])];
  });
}

/** Every step of `definition`, in each of its step lists and the inline workflows they run. */
function walk(definition: WorkflowDefinition): Walked[] {
  return Object.values(STEP_LISTS).flatMap((list) => walkSteps(list, definition[list] ?? []));
}

/** The `outputs` of each inline workflow, by the path of the step that runs it. */
function inlineOutputs(definition: WorkflowDefinition): Map<string, string> {
  return new Map(walk(definition).flatMap(({ path, step }) => {
    const child = stepWorkflow(step);

    return child?.kind === 'inline' ? [[path, canonicalJson(child.workflow.outputs ?? {})]] : [];
  }));
}

const CONFINED_TO_OUTPUT = /^\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/;

/** Why the prompt step at `path` of the override reads more than the evidence of a step before it, one reason each. */
function promptProblems({ path, field, step }: Walked): Problem[] {
  const dir = confinedOf(step);
  const refusals: Problem[] = [];

  if (dir === undefined) {
    refusals.push({ code: 'score_override_prompt', field: `${field}.workspace`, message: `step "${path}" runs a prompt that is not confined to a directory, so its tool could read the checkout and the session it judges. Give it workspace: { confined: "{{ steps.evidence.outputs.dir }}" }` });
  } else {
    const from = CONFINED_TO_OUTPUT.exec(dir)?.[1];

    if (from === undefined || !(step.needs ?? []).includes(from)) {
      refusals.push({ code: 'score_override_confined_dir', field: `${field}.workspace`, message: `step "${path}" is confined to ${dir}, which is not an output of a step it needs. Confine it to the directory the evidence step wrote: "{{ steps.evidence.outputs.dir }}"` });
    }
  }

  if (step.scorers) refusals.push({ code: 'score_override_prompt', field: `${field}.scorers`, message: `step "${path}" lists scorers, so judging it would start another teamai-score run from inside one. Remove scorers from it` });
  const prompt = step.prompt ?? '';

  for (const read of ['steps.evidence.outputs.rubric', 'steps.evidence.outputs.schema']) {
    if (!prompt.includes(read)) refusals.push({ code: 'score_override_judge_prompt', field: `${field}.prompt`, message: `step "${path}" has a prompt that does not read {{ ${read} }}, so its judge would answer without the scorer's rubric or its answer schema. Keep {{ ${read} }} in it` });
  }

  return refusals;
}

/** Whether `step` publishes the labels as the default does: `teamai score publish`, delivered to teamai-reports. */
function publishesLabels(step: WorkflowStep): boolean {
  const branch = step.workspace instanceof Object && 'team' in step.workspace ? step.workspace.team.branch : undefined;

  return step.command === PUBLISH && step.deliver === 'publish' && branch === REPORTS_BRANCH;
}

/** Why the step at `walked` publishes, or runs the publish verb, other than as the default publishes the labels, or in a run that stores none. */
function publishProblems({ path, field, step }: Walked): Problem[] {
  if (step.command !== PUBLISH && step.deliver !== 'publish') return [];
  const found: Problem[] = [];

  if (!publishesLabels(step)) found.push({ code: 'score_override_publish', field, message: `step "${path}" runs ${PUBLISH} without deliver: publish in workspace: { team: { branch: ${REPORTS_BRANCH} } }, where every member's labels are. Give it both, as teamai's default teamai-score does` });

  if (step.if !== PUBLISH_IF) found.push({ code: 'score_override_publish', field: `${field}.if`, message: `step "${path}" publishes without if: ${PUBLISH_IF}, so a run that only tries scorers would publish the scope's pending labels. Give it if: ${PUBLISH_IF}, as teamai's default teamai-score does` });

  return found;
}

/** Whether a header field of the team file is the default's, either absent counting as `{}`. */
function same<TField extends WorkflowDefinition['inputs'] | WorkflowDefinition['outputs'] | WorkflowDefinition['setup'] | WorkflowDefaults['inputs']>(team: TField, shipped: TField): boolean {
  return canonicalJson(team ?? {}) === canonicalJson(shipped ?? {});
}

/** Why `team` changes what teamai's default `shipped` takes or gives, a workflow step's outputs included. */
function contractProblems(team: WorkflowDefinition, shipped: WorkflowDefinition): Problem[] {
  const found: Problem[] = [];
  const contract = (field: string, message: string) => found.push({ code: 'score_override_contract', field, message });

  if (!same(team.inputs, shipped.inputs)) contract('inputs', 'changes the inputs teamai\'s default teamai-score takes, which every workflow that runs it passes. Declare them as it ships them');

  // A default a caller relies on, such as store: true, decides what a run that leaves the input out writes.
  if (!same(team.defaults?.inputs, shipped.defaults?.inputs)) contract('defaults.inputs', 'changes the input defaults teamai\'s default teamai-score gives, which every workflow that runs it may leave the inputs to. Give them as it ships them');

  if (!same(team.outputs, shipped.outputs)) contract('outputs', 'changes the outputs teamai\'s default teamai-score gives. Keep them as it ships them: no output may carry a judge\'s reasoning');
  const shippedInline = inlineOutputs(shipped);

  for (const [path, outputs] of inlineOutputs(team)) {
    if (shippedInline.has(path) && shippedInline.get(path) !== outputs) contract(`steps.${path}.workflow.outputs`, `changes the outputs of the workflow step "${path}" runs. Keep them as teamai's default teamai-score ships them: no output may carry a judge's reasoning`);
  }

  return found;
}

/** Why `team` runs other than teamai's default `shipped`: off this machine, started by an agent, or with a setup command. */
function runProblems(team: WorkflowDefinition, shipped: WorkflowDefinition): Problem[] {
  const found: Problem[] = [];
  const invoke = team.invoke ?? 'deny';

  if (team.private !== true) found.push({ code: 'score_override_contract', field: 'private', message: 'is not private, so its steps\' sessions and outputs could leave this machine. Set private: true' });

  if (invoke !== 'deny') found.push({ code: 'score_override_contract', field: 'invoke', message: `sets invoke: ${invoke}, so an agent session could start it and label its own work. Set invoke: deny` });

  if (!same(team.setup, shipped.setup)) {
    found.push({ code: 'score_override_command', field: 'setup', message: `runs setup ${team.setup?.command ?? 'none'} in the workspace of each step, where teamai's default teamai-score runs ${shipped.setup?.command ?? 'none'}. Give it the setup it ships` });
  }

  return found;
}

/** The commands of each step list of the default, each with its `env`, which a step of the same list must run as it ships them. */
type Verbs = Record<StepList, ReadonlyMap<string, string>>;

function verbsOf(shipped: WorkflowDefinition): Verbs {
  const steps = walk(shipped);
  const verbsIn = (list: StepList) => new Map(steps.flatMap(({ list: at, step }) => (at !== list || step.command === undefined ? [] : [[step.command, canonicalJson(step.env ?? {})]])));

  return { steps: verbsIn('steps'), finally: verbsIn('finally') };
}

/** Why the step at `walked` runs a command other than a verb its list of the default runs, with the `env` it gives it. */
function commandProblem({ list, path, field, step }: Walked, verbs: Verbs): Problem | undefined {
  const listVerbs = verbs[list];

  if (step.command === undefined) return undefined;

  if (!listVerbs.has(step.command)) {
    const message = listVerbs.size === 0
      ? `step "${path}" runs ${step.command} under ${list}, where teamai's default teamai-score runs no command. Remove the step`
      : `step "${path}" runs ${step.command}, which is not a score verb as teamai's default teamai-score runs it. Run the verbs with the arguments it ships`;

    return { code: 'score_override_command', field: `${field}.command`, message };
  }

  return listVerbs.get(step.command) === canonicalJson(step.env ?? {}) ? undefined
    : { code: 'score_override_command', field: `${field}.env`, message: `step "${path}" gives ${step.command} other env than teamai's default teamai-score does. Give it the env it ships` };
}

/** Why the step at `walked` is refused: its command, a workflow it runs, its prompt, or how it publishes. */
function stepProblems(walked: Walked, verbs: Verbs): Problem[] {
  const { path, field, step } = walked;
  const child = stepWorkflow(step);
  const command = commandProblem(walked, verbs);
  const found: Problem[] = command ? [command] : [];

  if (child !== undefined && !(path === 'score' && child.kind === 'inline')) {
    found.push({ code: 'score_override_workflow_step', field: `${field}.workflow`, message: `step "${path}" runs a workflow, and only the inline workflow of step "score" labels the groups. Remove it` });
  }

  if (step.prompt !== undefined || step.promptFile !== undefined) found.push(...promptProblems(walked));

  return [...found, ...publishProblems(walked)];
}

/** The steps of `KEPT` the override's `steps` do not have; `score.check` too while `scorerHasCheck`. */
function missingSteps(steps: readonly Walked[], scorerHasCheck: boolean): Problem[] {
  const kept = new Set(steps.flatMap(({ list, path }) => (list === 'steps' ? [path] : [])));
  const required: Array<[string, string]> = Object.entries(KEPT);

  if (scorerHasCheck) required.push(['score.check', `${LABELS_GO_THROUGH} while a scorer here has a check`]);

  return required.flatMap(([path, why]): Problem[] => (kept.has(path) ? [] : [{ code: 'score_override_step_missing', field: 'steps', message: `drops step ${path}, ${why}. Keep it` }]));
}

/**
 * Why `team`, a team file named like teamai's default `shipped`, is refused at pull, one diagnostic each, located at
 * `file`; none when it may replace the default. While a scorer `config` caches has a `check`, the override keeps the step
 * that runs it. Scorers sync before workflows, so the cache holds this pull's.
 */
async function problems({ team, shipped, file, config }: { team: WorkflowDefinition; shipped: WorkflowDefinition; file: string; config: LocalConfig }): Promise<WorkflowDiagnostic[]> {
  const verbs = verbsOf(shipped);
  const steps = walk(team);
  const keepsCheck = steps.some(({ list, path }) => list === 'steps' && path === 'score.check');
  const scorerHasCheck = !keepsCheck && await anyScorerChecks(config, await cachedScorerNames(config));
  const found = [...contractProblems(team, shipped), ...runProblems(team, shipped), ...steps.flatMap((walked) => stepProblems(walked, verbs)), ...missingSteps(steps, scorerHasCheck)];

  return found.map((problem) => ({ file, line: 1, column: 1, ...problem }));
}

/**
 * Why a step of `definition`, at `file`, may hold its run open: it runs teamai-score with no `timeout`, and a judge
 * step no driver here can take keeps teamai-score open until a timeout ends it, whatever its own says as a step.
 */
function callerWarnings(file: string, definition: WorkflowDefinition): string[] {
  return walk(definition).flatMap(({ path, step }) => {
    const child = stepWorkflow(step);

    if (child?.kind !== 'named' || child.name !== SCORE_WORKFLOW || step.timeout !== undefined) return [];

    return [`${file}: step "${path}" runs teamai-score with no timeout, so a judge no driver here can take holds it open until the run ends. Give it a timeout, such as timeout: 30m, and continue_on_failure: true.`];
  });
}

/** Why pull refuses `definition`, at `file`: a step runs a workflow that judges and lists scorers, which would judge it. */
function callerProblems(file: string, definition: WorkflowDefinition): WorkflowDiagnostic[] {
  return walk(definition).flatMap(({ path, field, step }) => {
    const child = stepWorkflow(step);

    if (child?.kind !== 'named' || !JUDGING_WORKFLOWS.includes(child.name) || step.scorers === undefined) return [];

    return [{ file, line: 1, column: 1, field: `${field}.scorers`, code: 'judging_scored', message: `step "${path}" runs ${child.name} and lists scorers, so its judging would be judged in turn. Remove scorers from the step` }];
  });
}

export const ScoreOverride = { problems, callerWarnings, callerProblems } as const;

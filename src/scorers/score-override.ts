/**
 * What a team's `teamai-score.yaml` may change, checked at pull against teamai's default. A team may reword the judge
 * prompt around the rubric and the schema, reorder the stages or drop `ci` and `protected`. It may not change what the
 * run takes or gives, run anything but the score verbs as the default runs them, drop a verb that keeps a label honest,
 * or let a prompt read anything but the evidence an earlier step wrote. A refusal is a coded diagnostic, so no older
 * version of the file keeps running: the default does.
 */
import { canonicalJson } from '../utils/canonical-json.js';
import { stepWorkflow, type ScoreOverrideCode, type WorkflowDefinition, type WorkflowDiagnostic, type WorkflowStep } from '../workflow/types.js';
import { confinedOf } from '../workflow/workspace.js';

/** The steps of the inline `score` workflow a team file must keep; `check` too while a scorer here has a check. */
const KEPT = ['evidence', 'label', 'write', 'settle'] as const;

/** One refusal, before pull locates it in the file. */
type Problem = Pick<WorkflowDiagnostic, 'field' | 'message'> & { code: ScoreOverrideCode };

/** A step of the file, by its path, such as `score.judge` inside the inline workflow of `score`. */
interface Walked {
  path: string;
  step: WorkflowStep;
}

function walk(steps: readonly WorkflowStep[], prefix = ''): Walked[] {
  return steps.flatMap((step) => {
    const path = `${prefix}${step.id}`;
    const child = stepWorkflow(step);

    return [{ path, step }, ...(child?.kind === 'inline' ? walk(child.workflow.steps, `${path}.`) : [])];
  });
}

/** The `outputs` of each inline workflow, by the path of the step that runs it. */
function inlineOutputs(definition: WorkflowDefinition): Map<string, string> {
  return new Map(walk(definition.steps).flatMap(({ path, step }) => {
    const child = stepWorkflow(step);

    return child?.kind === 'inline' ? [[path, canonicalJson(child.workflow.outputs ?? {})]] : [];
  }));
}

const CONFINED_TO_OUTPUT = /^\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+\s*\}\}$/;

/** Why the prompt step at `path` of the override reads more than the evidence of a step before it, one reason each. */
function promptProblems({ path, step }: Walked): Problem[] {
  const dir = confinedOf(step);
  const refusals: Problem[] = [];

  if (dir === undefined) {
    refusals.push({ code: 'score_override_prompt', field: `steps.${path}.workspace`, message: `step "${path}" runs a prompt that is not confined to a directory, so its tool could read the checkout and the session it judges. Give it workspace: { confined: "{{ steps.evidence.outputs.dir }}" }` });
  } else {
    const from = CONFINED_TO_OUTPUT.exec(dir)?.[1];

    if (from === undefined || !(step.needs ?? []).includes(from)) {
      refusals.push({ code: 'score_override_confined_dir', field: `steps.${path}.workspace`, message: `step "${path}" is confined to ${dir}, which is not an output of a step it needs. Confine it to the directory the evidence step wrote: "{{ steps.evidence.outputs.dir }}"` });
    }
  }

  if (step.scorers) refusals.push({ code: 'score_override_prompt', field: `steps.${path}.scorers`, message: `step "${path}" lists scorers, so judging it would start another teamai-score run from inside one. Remove scorers from it` });
  const prompt = step.prompt ?? '';

  for (const read of ['steps.evidence.outputs.rubric', 'steps.evidence.outputs.schema']) {
    if (!prompt.includes(read)) refusals.push({ code: 'score_override_judge_prompt', field: `steps.${path}.prompt`, message: `step "${path}" has a prompt that does not read {{ ${read} }}, so its judge would answer without the scorer's rubric or its answer schema. Keep {{ ${read} }} in it` });
  }

  return refusals;
}

/**
 * Why `team`, a team file named like teamai's default `shipped`, is refused at pull, one diagnostic each, located at
 * `file`; none when it may replace the default. `scorerHasCheck`: a scorer cached here has a `check`, so the override
 * keeps the step that runs it.
 */
function problems({ team, shipped, file, scorerHasCheck }: { team: WorkflowDefinition; shipped: WorkflowDefinition; file: string; scorerHasCheck: boolean }): WorkflowDiagnostic[] {
  const found: Problem[] = [];
  const contract = (field: string, message: string) => found.push({ code: 'score_override_contract', field, message });

  if (canonicalJson(team.inputs ?? {}) !== canonicalJson(shipped.inputs ?? {})) contract('inputs', 'changes the inputs teamai\'s default teamai-score takes, which every workflow that runs it passes. Declare them as it ships them');

  if (canonicalJson(team.outputs ?? {}) !== canonicalJson(shipped.outputs ?? {})) contract('outputs', 'changes the outputs teamai\'s default teamai-score gives. Keep them as it ships them: no output may carry a judge\'s reasoning');
  const shippedInline = inlineOutputs(shipped);

  for (const [path, outputs] of inlineOutputs(team)) {
    if (shippedInline.has(path) && shippedInline.get(path) !== outputs) contract(`steps.${path}.workflow.outputs`, `changes the outputs of the workflow step "${path}" runs. Keep them as teamai's default teamai-score ships them: no output may carry a judge's reasoning`);
  }

  if (team.private !== true) contract('private', 'is not private, so its steps\' sessions and outputs could leave this machine. Set private: true');

  if ((team.invoke ?? 'deny') !== 'deny') contract('invoke', `sets invoke: ${team.invoke ?? 'deny'}, so an agent session could start it and label its own work. Set invoke: deny`);
  const shippedSteps = walk(shipped.steps);
  const verbs = new Map(shippedSteps.flatMap(({ step }) => (step.command === undefined ? [] : [[step.command, canonicalJson(step.env ?? {})]])));
  const steps = walk(team.steps);

  for (const walked of steps) {
    const { path, step } = walked;
    const child = stepWorkflow(step);

    if (step.command !== undefined && !verbs.has(step.command)) {
      found.push({ code: 'score_override_command', field: `steps.${path}.command`, message: `step "${path}" runs ${step.command}, which is not a score verb as teamai's default teamai-score runs it. Run the verbs with the arguments it ships` });
    } else if (step.command !== undefined && verbs.get(step.command) !== canonicalJson(step.env ?? {})) {
      found.push({ code: 'score_override_command', field: `steps.${path}.env`, message: `step "${path}" gives ${step.command} other env than teamai's default teamai-score does. Give it the env it ships` });
    }

    if (child !== undefined && !(path === 'score' && child.kind === 'inline')) {
      found.push({ code: 'score_override_workflow_step', field: `steps.${path}.workflow`, message: `step "${path}" runs a workflow, and only the inline workflow of step "score" labels the groups. Remove it` });
    }

    if (step.prompt !== undefined || step.promptFile !== undefined) found.push(...promptProblems(walked));
  }

  const kept = new Set(steps.map(({ path }) => path));

  for (const id of [...KEPT, ...(scorerHasCheck ? ['check'] : [])]) {
    if (!kept.has(`score.${id}`)) found.push({ code: 'score_override_step_missing', field: 'steps', message: `drops step score.${id}, which every label of teamai's default teamai-score goes through${id === 'check' ? ' while a scorer here has a check' : ''}. Keep it` });
  }

  return found.map((problem) => ({ file, line: 1, column: 1, ...problem }));
}

/**
 * Why a step of `definition`, at `file`, may hold its run open: it runs teamai-score with no `timeout`, and a judge
 * step no driver here can take keeps teamai-score open until a timeout ends it, whatever its own says as a step.
 */
function callerWarnings(file: string, definition: WorkflowDefinition): string[] {
  return walk(definition.steps).flatMap(({ path, step }) => {
    const child = stepWorkflow(step);

    if (child?.kind !== 'named' || child.name !== 'teamai-score' || step.timeout !== undefined) return [];

    return [`${file}: step "${path}" runs teamai-score with no timeout, so a judge no driver here can take holds it open until the run ends. Give it a timeout, such as timeout: 30m, and continue_on_failure: true.`];
  });
}

export const ScoreOverride = { problems, callerWarnings } as const;

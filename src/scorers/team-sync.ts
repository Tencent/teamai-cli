/**
 * Pull's sync of the team's scorers and workflows: scorers first, then the workflows, whose steps' scorer names the
 * engine only parses and this sync checks against the scorers it found valid.
 */
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { syncWorkflowDefinitions, type SyncWorkflowResult } from '../workflow/cache.js';
import { stepWorkflow, type WorkflowDefinition, type WorkflowStep } from '../workflow/types.js';
import { syncScorerDefinitions, type SyncScorerOptions, type SyncScorerResult } from './cache.js';
import { SCORE_WORKFLOW } from './judging-workflows.js';

export type UnknownScorer = { file: string; scorer: string } & (
  /** `step` is the step's path, such as `check.review`. */
  | { kind: 'step'; step: string }
  | { kind: 'suite'; suite: string }
  | { kind: 'task'; suite: string; task: string }
);

export function formatUnknownScorer(unknown: UnknownScorer): string {
  const { file, scorer } = unknown;

  switch (unknown.kind) {
    case 'step':
      return `${file}: step "${unknown.step}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the step runs without it`;
    case 'suite':
      return `${file}: suite "${unknown.suite}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the benchmark does not start without it`;
    case 'task':
      return `${file}: task "${unknown.task}" of suite "${unknown.suite}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the benchmark does not start without it`;
    default: {
      const unhandled: never = unknown;

      return unhandled;
    }
  }
}

/** The scorers a definition's steps list, including inside its inline workflows, with each step's path. */
function scorersListedBy(definition: { steps: WorkflowStep[] }, prefix = ''): Array<{ step: string; scorer: string }> {
  return definition.steps.flatMap((step) => {
    const child = stepWorkflow(step);

    return [
      ...(step.scorers?.names ?? []).map((scorer) => ({ step: `${prefix}${step.id}`, scorer })),
      ...(child?.kind === 'inline' ? scorersListedBy(child.workflow, `${prefix}${step.id}.`) : []),
    ];
  });
}

export interface SyncScoredWorkflowsResult extends SyncWorkflowResult {
  /** The scorers of the same tree, synced first. */
  scorers: SyncScorerResult;
  /**
   * Scorers a step or a suite lists that `scorers` has no valid version of. A workflow still runs, and its step without
   * them; a suite does not start.
   */
  unknownScorers: UnknownScorer[];
}

/** Whether `step` runs `teamai score subjects` for step `id`, as `--step id` or `--step=id`, quoted or not. */
function listsSubjectsOf(step: WorkflowStep, id: string): boolean {
  const words = (step.command ?? '').split(/\s+/).map((word) => word.replace(/^["']|["']$/g, ''));
  const at = words.findIndex((word, index) => word === 'teamai' && words[index + 1] === 'score' && words[index + 2] === 'subjects');

  return at >= 0 && words.slice(at + 3).some((word, index, rest) => word === `--step=${id}` || (word === '--step' && rest[index + 1] === id));
}

/** The ids of `steps` that step `id` needs, directly or through a step it needs. */
function neededBy(steps: readonly WorkflowStep[], id: string): Set<string> {
  const needsOf = new Map(steps.map((step) => [step.id, step.needs ?? []]));
  const found = new Set<string>();
  const queue = [...(needsOf.get(id) ?? [])];

  for (const next of queue) {
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(needsOf.get(next) ?? []));
  }

  return found;
}

/** Whether a `workflow: teamai-score` step of `steps` needs a step that lists the subjects of step `id`. */
function isScoredInWorkflow(steps: readonly WorkflowStep[], id: string): boolean {
  const listing = new Set(steps.flatMap((step) => (listsSubjectsOf(step, id) ? [step.id] : [])));

  return steps.some((step) => {
    const child = stepWorkflow(step);

    return child?.kind === 'named' && child.name === SCORE_WORKFLOW && [...neededBy(steps, step.id)].some((need) => listing.has(need));
  });
}

/** The `start: workflow` steps of `steps`, and of every inline workflow inside them, that no teamai-score step scores, by path. */
function unscored(steps: readonly WorkflowStep[], prefix: string): string[] {
  return steps.flatMap((step) => {
    const child = stepWorkflow(step);
    const own = step.scorers?.start === 'workflow' && !isScoredInWorkflow(steps, step.id) ? [`${prefix}${step.id}`] : [];

    return [...own, ...(child?.kind === 'inline' ? unscored(child.workflow.steps, `${prefix}${step.id}.`) : [])];
  });
}

/**
 * Why pull warns about `definition`, at `file`: a step says `scorers.start: workflow`, so the scoring module starts no
 * run for its passes, and no `workflow: teamai-score` step after it reads `teamai score subjects` for that step, so
 * they wait for `score subjects --lapsed` once the run ended.
 */
function unreadWarnings(file: string, definition: WorkflowDefinition): string[] {
  return unscored(definition.steps, '').map((path) => {
    const id = path.split('.').at(-1) ?? path;

    return `${file}: step "${path}" says scorers.start: workflow, and no workflow: teamai-score step after it reads teamai score subjects --step ${id}, so its passes are scored only after the run ended, by the next teamai-finished-sessions that teamai score --drain or a session start runs. Add those steps, or drop start: workflow.`;
  });
}

/**
 * Syncs `scorers/`, then `workflows/` of the same tree, and checks the scorer names their steps list against the scorers
 * this sync found valid. The engine only parses those names. Nothing here fails the caller.
 */
export async function syncScorersThenWorkflows(config: LocalConfig, options: SyncScorerOptions = {}): Promise<SyncScoredWorkflowsResult> {
  const scorers = await syncScorerDefinitions(config, options);
  const workflows = await syncWorkflowDefinitions(config, { scopeLabel: options.scopeLabel, dryRun: options.dryRun });
  const valid = new Set(scorers.cached);

  const unknownScorers = workflows.settled.flatMap(({ relativePath, definition }) => scorersListedBy(definition)
    .filter(({ scorer }) => !valid.has(scorer))
    .map(({ step, scorer }): UnknownScorer => ({ kind: 'step', file: relativePath, step, scorer })));

  for (const unknown of unknownScorers) log.warn(`[workflows] ${formatUnknownScorer(unknown)}`);

  for (const { relativePath, definition } of workflows.settled) {
    for (const warning of unreadWarnings(relativePath, definition)) log.warn(`[workflows] ${warning}`);
  }

  return { ...workflows, scorers, unknownScorers };
}

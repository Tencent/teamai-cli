/**
 * Pull's sync of the team's scorers and workflows: scorers first, then the workflows, whose steps' scorer names the
 * engine only parses and this sync checks against the scorers it found valid.
 */
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { syncWorkflowDefinitions, type SyncWorkflowResult } from '../workflow/cache.js';
import { stepWorkflow, type WorkflowStep } from '../workflow/types.js';
import { syncScorerDefinitions, type SyncScorerOptions, type SyncScorerResult } from './cache.js';
import { ScoreSubjects } from './score-subjects.js';

export type UnknownScorer = { file: string; scorer: string } & (
  /** `step` is the step's path, such as `check.review`. */
  | { kind: 'step'; step: string }
  | { kind: 'suite'; suite: string }
);

export function formatUnknownScorer(unknown: UnknownScorer): string {
  const { file, scorer } = unknown;

  switch (unknown.kind) {
    case 'step':
      return `${file}: step "${unknown.step}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the step runs without it`;
    case 'suite':
      return `${file}: suite "${unknown.suite}" lists scorer "${scorer}", which has no valid scorers/${scorer}.md; the benchmark does not start without it`;
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
    for (const warning of ScoreSubjects.unreadWarnings(relativePath, definition)) log.warn(`[workflows] ${warning}`);
  }

  return { ...workflows, scorers, unknownScorers };
}

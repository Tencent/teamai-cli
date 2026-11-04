/**
 * The passes of a run that are judge work: what a judge can judge, and which of those this install judges for the
 * scorers their steps list. A feature reads a run's judge work here, from the run file alone, rather than through the
 * engine.
 */
import { firstSettled, passesWithin, runPasses, type RunPass } from './loop.js';
import { stepDefinitions } from './scope.js';
import { agentPassOf, agentSucceeded } from './step-state.js';
import { parseStepPath } from './step-path.js';
import type { RunState, WorkflowStep } from './types.js';

/** A succeeded pass of a step that lists scorers, by name: whether each has a valid version is the scoring module's to read. */
export interface ScorablePass {
  subject: { runId: string; step: string; pass: number };
  scorers: string[];
}

/** Whether this install settled `pass`: its stamp, or, for a pass settled before stamps, a run no other install handed over. */
export function settledHere(run: RunState, pass: RunPass, install: string): boolean {
  return pass.installId === undefined ? run.publication === undefined : pass.installId === install;
}

/**
 * The passes a judge can judge: passes of prompt and workflow steps whose agent succeeded, delivering or not, and of a
 * `for_each` step only its items.
 */
export function judgeablePasses(run: RunState): Array<{ pass: RunPass; definition: WorkflowStep }> {
  const definitionOf = stepDefinitions(run);

  return runPasses(run, agentPassOf).flatMap((pass) => {
    const definition: WorkflowStep | undefined = definitionOf(pass.step);

    if (!agentSucceeded(pass) || !definition) return [];

    if (definition.forEach && parseStepPath(pass.step).at(-1)?.index === undefined) return [];

    return [{ pass, definition }];
  });
}

/**
 * The passes of `run` this install may judge: judgeable passes of steps that list a scorer. A prompt pass
 * belongs to the install that settled it; a workflow pass to the install that settled its first child that has a
 * stamp. Sampling is left to the caller.
 */
export function scoredPasses(run: RunState, install: string): ScorablePass[] {
  const all = runPasses(run, agentPassOf);

  return judgeablePasses(run).flatMap(({ pass, definition }) => {
    const scorers = definition.scorers?.names ?? [];

    if (scorers.length === 0) return [];

    const owner = definition.workflow === undefined ? pass
      : firstSettled(passesWithin(run, all, pass.step, pass.pass).filter((child) => child.installId !== undefined));

    if (!settledHere(run, owner ?? pass, install)) return [];

    return [{ subject: { runId: run.id, step: pass.step, pass: pass.pass }, scorers }];
  });
}

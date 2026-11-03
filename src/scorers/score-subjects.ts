/**
 * `teamai score subjects`: the subjects a workflow starts `teamai-score` on itself. `--run` lists the passes of a run
 * whose steps say `scorers.start: workflow`; `--lapsed` lists what automatic judging starts again on this machine.
 */
import { ATTEMPT_ENV } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { scoredPasses } from '../workflow/judge-work.js';
import { findRunConfig } from '../workflow/run-location.js';
import { stepDefinitions } from '../workflow/scope.js';
import { installOwner, RunIdSchema } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { Marks } from './marks.js';
import { markFacts, type Refusal } from './score-plan.js';
import { ciStage, passOf } from './scoring-stages.js';
import { Subject } from './subject.js';

/** The step path every path of the calling attempt's workflow starts with, when that attempt is a step of run `runId`. */
function callerPrefix(env: NodeJS.ProcessEnv, run: RunState): string {
  const [runPart, attempt] = (env[ATTEMPT_ENV] ?? '').split('/');

  if (RunIdSchema.safeParse(runPart).data !== run.id || attempt === undefined) return '';
  const leased = run.steps.find((state) => state.status === 'leased' && state.attempt === attempt);
  const segments = leased?.id.split('.').slice(0, -1) ?? [];

  return segments.length === 0 ? '' : `${segments.join('.')}.`;
}

/** Whether `path` is `step` or a step inside it, such as an item `step[0]` or `step.child`. */
function isWithin(path: string, step: string): boolean {
  return path === step || path.startsWith(`${step}.`) || path.startsWith(`${step}[`);
}

export const ScoreSubjects = {
  /**
   * The judge-work passes of run `runId` settled on this install whose step says `start: workflow`, oldest first. With
   * `step`, only those of that step and of every step inside it, the path read from the calling attempt's workflow.
   */
  async ofRun(current: LocalConfig | undefined, env: NodeJS.ProcessEnv, { runId, step }: { runId: string; step: string | undefined }): Promise<{ ok: true; list: string[] } | Refusal> {
    const found = await findRunConfig(runId, current);

    if ('error' in found) return { ok: false, code: found.error.code, message: found.error.message };
    const { config, run } = found;
    const definitionOf = stepDefinitions(run);
    const within = step === undefined ? undefined : `${callerPrefix(env, run)}${step}`;

    const list = scoredPasses(run, (await installOwner(config)).id)
      .filter(({ subject }) => definitionOf(subject.step)?.scorers?.start === 'workflow' && (within === undefined || isWithin(subject.step, within)))
      .map(({ subject }) => Subject.format({ kind: 'run', subject }));

    return { ok: true, list };
  },

  /** The subjects whose mark is a lapse automatic judging starts again, or waits on CI that has since finished, once each, sorted. */
  async lapsed(config: LocalConfig, now: string): Promise<string[]> {
    const marks = await Marks.restartable(config, markFacts(config, now));
    const list = new Set<string>();

    for (const { key, state } of marks) {
      if (state.kind === 'waiting' && key.subject.kind === 'run') {
        const found = await findRunConfig(key.subject.subject.runId, config);

        if ('error' in found) continue;
        const ci = await ciStage(found.run, key.subject.subject, passOf(found.run, key.subject.subject));

        if (ci.kind === 'pending') continue;
      }

      list.add(Subject.format(key.subject));
    }

    return [...list].sort();
  },
} as const;

/**
 * `teamai score subjects`: the subjects a workflow starts `teamai-score` on itself. `--run` lists the passes of a run
 * whose steps say `scorers.start: workflow`, and with `--calibration` the benchmark trials its judges are calibrated on;
 * `--lapsed` lists what automatic judging starts again on this machine.
 */
import { calibrationSubjects, type CalibrationSubject } from '../benchmark/calibration.js';
import { planOfRun } from '../benchmark/run-plan.js';
import { ATTEMPT_ENV } from '../launch-context.js';
import { SessionWork } from '../session-flow/session-work.js';
import type { LocalConfig } from '../types.js';
import { scoredPasses } from '../workflow/judge-work.js';
import { findRunConfig } from '../workflow/run-location.js';
import { stepDefinitions } from '../workflow/scope.js';
import { installOwner, readRuns, RunIdSchema } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import type { RunSubject } from './label.js';
import { isEvidenceReady, removeSubjectEvidence, subjectEvidenceDirOf } from './evidence.js';
import { scoresDir } from './home.js';
import { MARK_WINDOW_MS, Marks, type MarkFacts, type MarkKey } from './marks.js';
import { PassScoring } from './pass-scoring.js';
import { pinnedDefinition, type PinnedScorer } from './pin.js';
import { RunScorers, type RunScorerPins } from './run-scorers.js';
import { isSampled } from './sampling.js';
import { markFacts, type Refusal } from './score-plan.js';
import { ScoreStage } from './score-stage.js';
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

/** Whether scorer `name`, as `pins` holds it, samples pass `subject`, every pass of a step that samples all. */
function samples(pins: Readonly<Record<string, PinnedScorer>>, name: string, subject: RunSubject, all: boolean): boolean {
  const pin = pins[name];
  const definition = pin && pinnedDefinition(name, pin);

  return definition !== undefined && (all || isSampled(name, subject, definition.samplingRate));
}

/** Whether `score subjects --lapsed` takes a pass: of an ended run or one whose teamai-score run the scoring module started. */
async function isLeftToLapsed(config: LocalConfig, pass: { ended: boolean; subject: RunSubject }): Promise<boolean> {
  return pass.ended || PassScoring.started(config, pass.subject);
}

/**
 * The passes of `run` that no teamai-score run planned, for a scorer that samples them: a pass whose scoring the scoring
 * module started but whose run never planned it, and, once `run` ended, any other pass, such as one of a `start:
 * workflow` step that no step of its workflow scored.
 */
async function unplannedOf(config: LocalConfig, run: RunState, install: string, facts: MarkFacts): Promise<LapsedSubject[]> {
  const definitionOf = stepDefinitions(run);
  const ended = run.status !== 'running';
  const list: LapsedSubject[] = [];

  // Read only once a pass has an unmarked scorer: most passes of most runs are marked, and the read clones the team pin.
  let pins: Promise<RunScorerPins> | undefined;

  for (const { subject, scorers } of scoredPasses(run, install)) {
    const own = definitionOf(subject.step)?.scorers;
    const all = own?.sampling === 'all';

    if (!await isLeftToLapsed(config, { ended, subject })) continue;
    const states = await Marks.states(config, scorers.map((scorer) => ({ scorer, subject: { kind: 'run' as const, subject } })), facts);
    const unmarked = scorers.filter((_, at) => states[at]?.kind === 'unmarked');

    if (unmarked.length === 0) continue;
    const read = await (pins ??= RunScorers.of(config, run));

    const sampled = read.ok ? unmarked.filter((name) => samples(read.pins, name, subject, all)) : [];

    if (sampled.length > 0) list.push({ subject: Subject.format({ kind: 'run', subject }), scorers: sampled });
  }

  return list;
}

/** The passes settled here of each run past its 14 days with no mark `live` holds, whichever scorer it is for. */
function expiredUnmarked(runs: readonly RunState[], install: string, { now, live }: { now: string; live: ReadonlySet<string> }): RunSubject[] {
  const aged = runs.filter((run) => Date.parse(run.updatedAt) + MARK_WINDOW_MS <= Date.parse(now));

  return aged.flatMap((run) => scoredPasses(run, install)).flatMap(({ subject }) => (live.has(Subject.format({ kind: 'run', subject })) ? [] : [subject]));
}

/** The marks keys of the scorers `subject`'s step lists, while what was staged for it is there and its run inside its 14 days. */
async function listedKeys(config: LocalConfig, subject: RunSubject, now: string): Promise<MarkKey[]> {
  if (!await isEvidenceReady(subjectEvidenceDirOf(scoresDir(config), subject))) return [];
  const found = await findRunConfig(subject.runId, config);

  if ('error' in found || Date.parse(found.run.updatedAt) + MARK_WINDOW_MS <= Date.parse(now)) return [];

  return (stepDefinitions(found.run)(subject.step)?.scorers?.names ?? []).map((scorer) => ({ scorer, subject: { kind: 'run', subject } }));
}

/** A subject automatic judging starts again, with the scorers to start it for. */
// A type, not an interface, so it is a JSON value the verb prints.
export type LapsedSubject = { subject: string; scorers: string[] };

export const ScoreSubjects = {
  /**
   * Of `passes`, each of whose marks closed or expired, those whose staged evidence no judge reads again: none whose run
   * is inside its 14 days still has a scorer its step lists without a mark.
   */
  async settled(config: LocalConfig, passes: readonly RunSubject[], facts: MarkFacts): Promise<RunSubject[]> {
    const keys = (await Promise.all(passes.map((subject) => listedKeys(config, subject, facts.now)))).flat();
    const states = await Marks.states(config, keys, facts);
    const awaited = new Set(keys.flatMap((key, at) => (states[at]?.kind === 'unmarked' ? [Subject.format(key.subject)] : [])));

    return passes.filter((subject) => !awaited.has(Subject.format({ kind: 'run', subject })));
  },

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

  /**
   * The trials of benchmark run `runId` to calibrate its correctness judges on: those of `step` and of every step inside
   * it, the path read from the calling attempt's workflow, that the run's plan samples (`calibrationSubjects`).
   */
  async calibration(current: LocalConfig | undefined, env: NodeJS.ProcessEnv, { runId, step }: { runId: string; step: string | undefined }): Promise<{ ok: true; list: CalibrationSubject[] } | Refusal> {
    const found = await findRunConfig(runId, current);

    if ('error' in found) return { ok: false, code: found.error.code, message: found.error.message };
    const planned = planOfRun(found.run);

    if ('failure' in planned) return { ok: false, code: planned.failure.code, message: planned.failure.message };

    return { ok: true, list: calibrationSubjects(found.run, planned.found, step === undefined ? undefined : `${callerPrefix(env, found.run)}${step}`) };
  },

  /**
   * The subjects automatic judging starts again, once each, sorted, each with the scorers to start it for: those whose
   * mark is a lapse, or waits on CI that has since finished or outwaited the ci step's `--wait`, and those of a pass that
   * no teamai-score run planned, of each run inside its 14 days, that sample it. A scorer someone named is among them, and
   * one nobody asked for that the subject's policy would take now is not. The evidence staged for a pass whose marks all
   * closed or expired and that no scorer its step lists waits for, or whose run is past its 14 days unmarked, is removed.
   */
  async lapsed(config: LocalConfig, now: string): Promise<LapsedSubject[]> {
    const facts = markFacts(config, now);
    const marked = await Marks.passes(config, facts);
    await removeSubjectEvidence(scoresDir(config), await ScoreSubjects.settled(config, marked.closed, facts));
    const marks = await Marks.restartable(config, facts);
    const list = new Map<string, Set<string>>();
    const add = (subject: string, scorers: readonly string[]) => list.set(subject, new Set([...list.get(subject) ?? [], ...scorers]));
    const install = (await installOwner(config)).id;

    const runs = await readRuns(config);

    // A pass of a run that last changed 14 days ago reads as expired, not unmarked.
    for (const run of runs) {
      for (const { subject, scorers } of await unplannedOf(config, run, install, facts)) add(subject, scorers);
    }

    // A pass no scorer sampled has no mark, so closing marks never removes what was staged for it.
    await removeSubjectEvidence(scoresDir(config), expiredUnmarked(runs, install, { now, live: marked.live }));

    for (const { key, state } of marks) {
      if (state.kind === 'waiting' && key.subject.kind === 'run') {
        const found = await findRunConfig(key.subject.subject.runId, config);

        if ('error' in found) continue;
        const ci = await ciStage(found.run, key.subject.subject, passOf(found.run, key.subject.subject));

        if (ci.kind === 'pending' && !await ScoreStage.isCiWaitOver(config, ci.head, now)) continue;
      }

      // A session scorer the team removed would make plan refuse the whole rescore; its mark stays a lapse should it return.
      if (key.subject.kind !== 'run' && (await SessionWork.pinsOf(config, key.subject, [key.scorer])).pins[key.scorer] === undefined) continue;

      add(Subject.format(key.subject), [key.scorer]);
    }

    return [...list].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([subject, scorers]) => ({ subject, scorers: [...scorers] }));
  },
} as const;

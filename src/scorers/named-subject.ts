/**
 * The subject a person names to `teamai score --run`, `--session` or `--team-session`, found and checked before a
 * `teamai-score` run starts, so a pass, a session or a scorer that cannot be labelled starts no run and writes nothing.
 */
import { knownSecrets } from '../env-resolution.js';
import { pushedSession, nativeSession, type NamedSession, type SessionDemand } from '../session-flow/scoring.js';
import { safeText } from '../session-flow/session-cmd-shared.js';
import { firstPrompt } from '../session-flow/session-work.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { redact } from '@teamai/shared/redact';
import { judgeablePasses } from '../workflow/judge-work.js';
import { findRunConfig } from '../workflow/run-location.js';
import { stepDefinitions } from '../workflow/scope.js';
import { parseStepPath } from '../workflow/step-path.js';
import type { RunState } from '../workflow/types.js';
import { cachedScorerNames, pinScorers } from './cache.js';
import { RunScorers } from './run-scorers.js';
import { isScorerFile, type ScorerDefinition } from './definition.js';
import { scoringUnavailable } from './home.js';
import { pinnedDefinition, type PinnedScorer } from './pin.js';
import { missingEvidence } from './scoring-evidence.js';
import { scopeScoring } from './settings.js';
import { GeneratedQuestions } from './generated-questions.js';
import type { Subject } from './subject.js';

type Refusal = { ok: false; code: string; message: string };

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/** A subject that can be labelled, the scope its run starts in, and the definition of each named scorer that has one here. */
export interface NamedSubject {
  config: LocalConfig;
  subject: Subject;
  /** By scorer name; a routing question of a session has none until plan resolves it. */
  definitions: ReadonlyMap<string, ScorerDefinition>;
}

/** What `teamai score --run <id> [--step <path>] [--pass <n>] --scorer <name>…` names. */
export interface NamedPass {
  run: string;
  /** Omitted: the one step whose definition lists every named scorer. */
  step?: string;
  /** Omitted: the step's latest pass whose agent succeeded. */
  pass?: number;
  scorers: readonly string[];
}

async function scoringRefusal(config: LocalConfig): Promise<Refusal | undefined> {
  const unavailable = scoringUnavailable(config);

  if (unavailable) return refused('scoring_unavailable', unavailable);
  const scoring = await scopeScoring(config);

  return scoring.ok ? undefined : refused('scoring_settings_invalid', scoring.reason);
}

/** The step path `named` leaves out: the one step whose definition lists every scorer, whether or not it ran. */
function onlyListingStep(run: RunState, scorers: readonly string[], succeeded: readonly string[]): { ok: true; step: string } | Refusal {
  const named = scorers.join(', ');
  const definitionOf = stepDefinitions(run);

  const listing = [...new Set(run.steps.map((state) => state.id).filter((stepPath) => {
    const definition = definitionOf(stepPath);

    if (!definition || (definition.forEach && parseStepPath(stepPath).at(-1)?.index === undefined)) return false;

    return scorers.every((scorer) => definition.scorers?.names.includes(scorer));
  }))];

  if (listing.length > 1) return refused('step_ambiguous', `Run ${run.id} lists scorer ${named} on steps ${listing.join(', ')}. Pass --step <path> to pick one.`);
  const [step] = listing;

  if (step !== undefined) return { ok: true, step };

  return refused('step_not_found', `Run ${run.id} lists scorer ${named} on no step. ${succeeded.length > 0 ? `Pass --step <path> to pick one: ${succeeded.join(', ')}.` : 'No step of it succeeded.'}`);
}

/** The step and pass of `run` that `named` asks for, of those that succeeded: by default the latest of the step. */
function passIn(run: RunState, named: NamedPass): { ok: true; step: string; pass: number } | Refusal {
  const judgeable = judgeablePasses(run).map(({ pass }) => pass);
  const succeeded = [...new Set(judgeable.map((pass) => pass.step))];
  const chosen = named.step === undefined ? onlyListingStep(run, named.scorers, succeeded) : { ok: true as const, step: named.step };

  if (!chosen.ok) return chosen;
  const { step } = chosen;
  const ofStep = judgeable.filter((pass) => pass.step === step).map((pass) => pass.pass).sort((left, right) => left - right);
  const latest = ofStep.at(-1);

  if (latest === undefined) {
    return refused('step_not_found', `Step ${step} has no succeeded pass in run ${run.id}. ${succeeded.length > 0 ? `Steps with one: ${succeeded.join(', ')}.` : 'No step of it succeeded.'}`);
  }

  const pass = named.pass ?? latest;

  return ofStep.includes(pass) ? { ok: true, step, pass } : refused('pass_not_found', `Pass ${pass} of step ${step} did not succeed in run ${run.id}. Succeeded passes: ${ofStep.join(', ')}.`);
}

/** The pass `named` asks for, whose evidence is still here, and the definitions of its scorers at the run's team pin. */
async function ofPass(current: LocalConfig | undefined, named: NamedPass): Promise<({ ok: true } & NamedSubject) | Refusal> {
  const file = named.scorers.find(isScorerFile);

  if (file !== undefined) return refused('invalid_arguments', `--run takes scorer names, not the file ${file}: a run reads its scorers at the team revision it started from`);
  const found = await findRunConfig(named.run, current);

  if ('error' in found) return refused(found.error.code, found.error.message);
  const { config, run } = found;
  const unready = await scoringRefusal(config);

  if (unready) return unready;
  const chosen = passIn(run, named);

  if (!chosen.ok) return chosen;
  const { step, pass } = chosen;
  const subject = { runId: run.id, step, pass };
  const missing = await missingEvidence(run, subject);

  if (missing.length > 0) {
    return refused('evidence_missing', `Pass ${pass} of step ${step} in run ${run.id} cannot be scored: no longer on this machine: ${missing.join('; ')}. Restore what is missing, or score another pass. No label was written.`);
  }

  const read = await RunScorers.of(config, run);

  if (!read.ok) return refused('scorer_not_found', `${read.reason} No label was written.`);
  const pinned = definitionsOf(named.scorers, read.pins);

  if (!pinned.ok) {
    const listed = Object.keys(read.pins).sort();

    return refused('scorer_not_found', `Scorer ${pinned.unpinned} is not a scorer of run ${run.id} at the team revision it started from, so it has no rubric to judge its passes with. ${listed.length > 0 ? `Its scorers: ${listed.join(', ')}.` : 'Its steps list no scorer it can read.'}`);
  }

  return { ok: true, config, subject: { kind: 'run', subject }, definitions: pinned.definitions };
}

/** The label checks that need no session: a hand label is the value of one cached scorer, and runs no judge. */
function handLabelRefusal(demand: SessionDemand): Refusal | undefined {
  if (demand.label === undefined) return undefined;

  if (new Set(demand.scorers).size > 1) return refused('invalid_arguments', '--label is a value of one scorer. Pass one --scorer.');

  return demand.batch ? refused('invalid_arguments', '--label runs no judge. Leave out --batch.') : undefined;
}

/** The definition of each of `scorers` as `pins` pins it, or the first scorer it pins no definition of. */
function definitionsOf(scorers: readonly string[], pins: Readonly<Record<string, PinnedScorer>>): { ok: true; definitions: Map<string, ScorerDefinition> } | { ok: false; unpinned: string } {
  const definitions = new Map<string, ScorerDefinition>();

  for (const scorer of scorers) {
    const pin = pins[scorer];
    const definition = pin && pinnedDefinition(scorer, pin);

    if (!definition) return { ok: false, unpinned: scorer };
    definitions.set(scorer, definition);
  }

  return { ok: true, definitions };
}

/**
 * The session `demand` names, on this machine or pushed by a member, in the scope its labels are kept in, with each
 * named scorer cached there; a scorer file is read by the run that tries it. A hand label must be one of its scorer's values. Says which session it is and its first
 * prompt, redacted, as the person reads before a label is written.
 */
async function ofSession(from: LocalConfig, demand: SessionDemand): Promise<({ ok: true } & NamedSubject) | Refusal> {
  const unfit = handLabelRefusal(demand);

  if (unfit) return unfit;
  const named = demand.teamSession ? await pushedSession(from, demand.teamSession) : await nativeSession(from, demand);

  if ('error' in named) return refused(named.error.code, named.error.message);
  const { platform, found: { session }, config, pushedBy } = named;
  const unready = await scoringRefusal(config);

  if (unready) return unready;
  const teamScorers = demand.scorers.filter((name) => !GeneratedQuestions.isGenerated(name) && !isScorerFile(name));
  const pinned = definitionsOf(teamScorers, await pinScorers(config, teamScorers));

  if (!pinned.ok) return notCached(config, pinned.unpinned);
  const { definitions } = pinned;
  const invalid = labelRefusal(demand, definitions);

  if (invalid) return invalid;
  await introduce(named, demand.label !== undefined);

  const subject: Subject = demand.teamSession && pushedBy !== undefined
    ? { kind: 'team-session', subject: { author: pushedBy, name: demand.teamSession.name } }
    : { kind: 'session', subject: { platform, sessionId: session.sessionId } };

  return { ok: true, config, subject, definitions };
}

/** The refusal of `scorer`, which is not cached in `config`'s scope, with the scorers that are. */
async function notCached(config: LocalConfig, scorer: string): Promise<Refusal> {
  const known = await cachedScorerNames(config);

  return refused('scorer_not_found', `Scorer ${scorer} is not cached here. ${known.length > 0 ? `Scorers: ${known.join(', ')}.` : 'Run teamai pull to cache the team\'s scorers.'}`);
}

/** The refusal of a hand label that is not a value of its scorer, of those in `definitions`. */
function labelRefusal(demand: SessionDemand, definitions: ReadonlyMap<string, ScorerDefinition>): Refusal | undefined {
  const [scorer] = demand.scorers;
  const hand = demand.label === undefined ? undefined : definitions.get(scorer);

  if (!hand || hand.labels.some((label) => label.value === demand.label)) return undefined;

  return refused('label_invalid', `"${demand.label ?? ''}" is not a label of scorer ${scorer}. Use one of: ${hand.labels.map((label) => label.value).join(', ')}.`);
}

/** Says which session the person named, who pushed it, and its first prompt, redacted, before a label is written. */
async function introduce({ platform, found: { session }, config, pushedBy }: NamedSession, labelling: boolean): Promise<void> {
  log.info(safeText(`${labelling ? 'Labelling' : 'Scoring'} ${platform} session ${session.sessionId} in ${session.cwd || '(directory unknown)'}`));

  if (pushedBy !== undefined) log.info(`Pushed by ${safeText(pushedBy)}`);
  const envSecrets = await knownSecrets(config);
  log.info(`First prompt: ${safeText(redact(firstPrompt(session), { envSecrets })) || '(none)'}`);
}

export const NamedSubject = { ofPass, ofSession } as const;

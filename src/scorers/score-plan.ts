/**
 * `teamai score plan`: the groups a `teamai-score` instance labels its subject in. Each scorer is sampled on its own,
 * then the sampled ones that may share one judge launch are grouped, and the marks of every group are opened for the
 * root run, so a parallel run sees them taken.
 */
import { loadModelAliases } from '../models/aliases.js';
import { installedConfinedTools } from '../tool-launch/confined.js';
import type { LocalConfig } from '../types.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { SessionWork } from '../session-flow/session-work.js';
import { judgeablePasses } from '../workflow/judge-work.js';
import { findRunConfig } from '../workflow/run-location.js';
import { workflowBatch } from '../workflow/scope.js';
import { readRun } from '../workflow/store.js';
import type { RunPass } from '../workflow/loop.js';
import type { RunState, StepScorers, WorkflowStep } from '../workflow/types.js';
import { batchesScorers } from './batch.js';
import { STAGES, type ScorerDefinition, type Stage } from './definition.js';
import { chooseJudgeModel, type JudgeModelChoice } from './judge-model.js';
import type { RunSubject } from './label.js';
import { Marks, type Demand, type Launch, type MarkFacts, type MarkKey } from './marks.js';
import { pinnedDefinition, type PinnedScorer } from './pin.js';
import { RunScorers } from './run-scorers.js';
import { isSampled } from './sampling.js';
import { ScoreAttempt } from './score-attempt.js';
import { isDelivered } from './scoring-evidence.js';
import { scopeScoring } from './settings.js';
import { isRoutingScorer } from './skill-routing.js';
import { Subject } from './subject.js';

/** One judge launch: the scorers it labels, joined by `,`, and the stages its steps run. */
export interface PlanGroup {
  subject: string;
  /** The hand label, which skips the stages and the judge; '' for none. */
  hand: string;
  scorers: string;
  /** The scorers' `model`, which the judge step renders; '' for the tool's default. */
  model: string;
  ci: boolean;
  protected: boolean;
}

export type Refusal = { ok: false; code: string; message: string };

export interface PlanRequest {
  attempt: ScoreAttempt;
  subject: Subject;
  /** The scorers asked for; none takes those the subject's step pinned. */
  scorers: readonly string[];
  label: string;
  batch: boolean;
  demand: Demand;
  now: string;
}

/** A scorer of the subject, as pinned for it. */
interface Candidate {
  name: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
}

/** What the subject's kind decides: its scorers, which of them sample it, and the stages and batch default that apply. */
interface Judged {
  candidates: Candidate[];
  sampled: (candidate: Candidate) => boolean;
  batch: boolean | undefined;
  /** The tool that ran the work, which judges it when it can. */
  prefer: string[];
  /** The stages each scorer takes on this subject: none unless it delivered. */
  stagesOf: (candidate: Candidate) => Stage[];
  /** Whether a scorer is judged in a launch of its own: its check runs for it alone. */
  alone: (candidate: Candidate) => boolean;
  key: (candidate: Candidate) => MarkKey;
}

/**
 * Whether a plan of `request` starts a mark again: on an automatic demand with no hand label, a lapse or a wait for CI on
 * its subject of a scorer an earlier launch took, which may be one someone named, that does not judge sessions or does
 * not sample the subject, so sampling skips none.
 */
async function restartsOf(request: PlanRequest, facts: MarkFacts): Promise<(key: MarkKey) => boolean> {
  if (request.demand !== 'auto' || request.label !== '') return () => false;
  const id = Subject.format(request.subject);
  const restartable = (await Marks.restartable(request.attempt.config, facts)).flatMap(({ key }) => (Subject.format(key.subject) === id ? [key] : []));

  return (key) => restartable.some((mark) => mark.scorer === key.scorer && mark.sourceHash === key.sourceHash);
}

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

/** What the store needs of a run: whether it ended, and when it last changed; a run gone reads as undefined. */
export function markFacts(config: LocalConfig, now: string): MarkFacts {
  return {
    now,
    readRun: async (runId) => {
      const run = await readRun(config, runId);

      return run === 'missing' || run === 'corrupt' ? undefined : { ended: run.status !== 'running', changedAt: run.updatedAt };
    },
  };
}

/** The stages a scorer takes where they apply: those it lists, else all three, that the instance keeps a step for. */
export function scorerStages(attempt: ScoreAttempt, definition: Pick<ScorerDefinition, 'stages' | 'check'>): Stage[] {
  return (definition.stages ?? STAGES).filter((stage) => (stage !== 'check' || definition.check !== undefined) && ScoreAttempt.keepsStep(attempt.instance, stage));
}

function pinned(names: readonly string[], pins: Readonly<Record<string, PinnedScorer>>, where: string): Candidate[] | Refusal {
  const candidates: Candidate[] = [];

  for (const name of names) {
    const pin = pins[name];
    const definition = pin && pinnedDefinition(name, pin);

    if (!pin || !definition) return refused('scorer_not_found', `Scorer ${name} is not ${where}. Name one that is, or run teamai pull for the team's newest scorers.`);
    candidates.push({ name, pin, definition });
  }

  return candidates;
}

/** The run of `subject` on this machine, the config of its scope, and its pass, when its agent succeeded, so the pass has work to judge. */
export async function judgeablePass(config: LocalConfig, subject: RunSubject): Promise<{ ok: true; config: LocalConfig; run: RunState; pass: RunPass; step: WorkflowStep } | Refusal> {
  const found = await findRunConfig(subject.runId, config);

  if ('error' in found) return refused(found.error.code, found.error.message);
  const judgeable = judgeablePasses(found.run).find(({ pass }) => pass.step === subject.step && pass.pass === subject.pass);

  if (!judgeable) return refused('pass_not_found', `Run ${subject.runId} has no pass ${subject.pass} of step ${subject.step} whose agent succeeded, so it has nothing to judge.`);

  return { ok: true, config: found.config, run: found.run, pass: judgeable.pass, step: judgeable.definition };
}

async function runJudged(request: PlanRequest, subject: RunSubject, teamBatch: boolean | undefined): Promise<Judged | Refusal> {
  const found = await judgeablePass(request.attempt.config, subject);

  if (!found.ok) return found;
  const { run, pass } = found;
  const own: StepScorers = found.step.scorers ?? { names: [] };
  const read = await RunScorers.of(found.config, run);

  if (!read.ok) return refused('scorer_not_found', `${read.reason} Nothing was planned.`);
  const candidates = pinned(request.scorers.length > 0 ? request.scorers : own.names, read.pins, `a scorer of run ${run.id} at the team revision it started from`);

  if (!Array.isArray(candidates)) return candidates;
  const delivered = isDelivered(run, subject);
  const all = own.sampling === 'all';

  return {
    candidates,
    sampled: (candidate) => all || isSampled(candidate.name, subject, candidate.definition.samplingRate),
    batch: batchesScorers({ step: own.batch, workflow: workflowBatch(run, subject.step), team: teamBatch }),
    prefer: pass.tool === undefined ? [] : [pass.tool],
    stagesOf: (candidate) => (delivered ? scorerStages(request.attempt, candidate.definition) : []),
    alone: (candidate) => delivered && candidate.definition.check !== undefined,
    key: (candidate) => ({ scorer: candidate.name, subject: { kind: 'run', subject } }),
  };
}

/**
 * The scorers of a session: those named, else every scorer that judges sessions and, while `skill_routing` is on, a
 * routing question per team skill its captures delivered.
 */
async function sessionPins(config: LocalConfig, subject: Exclude<Subject, { kind: 'run' }>, { names, isRouting }: { names: readonly string[]; isRouting: boolean }): Promise<Candidate[] | Refusal> {
  if (names.length === 0) {
    const scorers = [...await SessionWork.sessionScorers(config), ...(isRouting ? await SessionWork.routingQuestions(config, subject) : [])];

    return scorers.map(({ scorer, pin, definition }) => ({ name: scorer, pin, definition }));
  }

  const { pins, unpinned } = await SessionWork.pinsOf(config, subject, names);
  const [routing, why] = [...unpinned][0] ?? [];

  return routing === undefined ? pinned(names, pins, 'a scorer teamai pull cached') : refused('scorer_not_found', `Scorer ${routing} is not a routing question of ${Subject.format(subject)}. ${why}`);
}

async function sessionJudged(request: PlanRequest, subject: Exclude<Subject, { kind: 'run' }>, scoring: { batch: boolean | undefined; skillRouting: boolean }): Promise<Judged | Refusal> {
  const candidates = await sessionPins(request.attempt.config, subject, { names: request.scorers, isRouting: scoring.skillRouting });

  if (!Array.isArray(candidates)) return candidates;
  const structured = subject.kind === 'session' ? subject.subject : undefined;

  return {
    candidates,
    sampled: (candidate) => structured === undefined || isRoutingScorer(candidate.name) || isSampled(candidate.name, structured, candidate.definition.samplingRate),
    batch: batchesScorers({ team: scoring.batch }),
    prefer: [],
    stagesOf: () => [],
    alone: () => false,
    key: (candidate) => ({ scorer: candidate.name, subject, sourceHash: candidate.pin.sourceHash }),
  };
}

/** The one group of a hand label: the person's value of the one scorer asked for, when a person started the root run. */
function handGroup(request: PlanRequest, judged: Judged): { ok: true; groups: PlanGroup[] } | Refusal {
  const [only, ...others] = judged.candidates;

  if (!only || others.length > 0) return refused('invalid_arguments', `A hand label is the value of one scorer, and ${judged.candidates.length} were asked for. Name one scorer with the label.`);

  if (request.attempt.run.startedBy !== 'person') {
    return refused('hand_label_refused', `Run ${request.attempt.run.id} was not started by a person, so its label input is not a hand label. Label by hand from your own terminal: teamai score --scorer ${only.name} --label ${request.label}.`);
  }

  if (!only.definition.labels.some((label) => label.value === request.label)) {
    return refused('label_invalid', `"${request.label}" is not a label of scorer ${only.name}. Use one of: ${only.definition.labels.map((label) => label.value).join(', ')}.`);
  }

  return { ok: true, groups: [{ subject: Subject.format(request.subject), hand: request.label, scorers: only.name, model: '', ci: false, protected: false }] };
}

/**
 * What `candidate` shares with the scorers one judge call takes with it: the tool and model `chosen` for it, and its
 * stages. A model no judge here runs gets a group of its own, whose judge step waits for a driver that can run it.
 */
function batchKey(candidate: Candidate, judged: Judged, chosen: JudgeModelChoice): string {
  if (!chosen.ok) return `${candidate.name}\n`;
  const { tool, model, by, noModel } = chosen.choice;

  return canonicalJson({ tool, model: model ?? null, by, noModel: noModel ?? null, stages: judged.stagesOf(candidate) });
}

/**
 * The group `candidate` joins: its own; under `batch`, that of the scorers sharing its judge and stages; and for a
 * routing question, that of the session's other routing questions sharing its judge, which only `batch` lets team
 * scorers join.
 */
function groupKey(candidate: Candidate, judged: Judged, { batch, choose }: { batch: boolean; choose: () => JudgeModelChoice }): string {
  const routing = isRoutingScorer(candidate.name);

  if (!(batch || routing) || judged.alone(candidate)) return `${candidate.name}\n`;
  const shared = batchKey(candidate, judged, choose());

  return routing && !batch ? `routing\n${shared}` : shared;
}

/**
 * The sampled scorers, every one on a named demand, grouped: a scorer with a check alone, else those that resolve to one
 * judge and take the same stages. A session's routing questions share a group whatever `batch` says, and its team
 * scorers join them only under `batch`.
 */
async function grouped(request: PlanRequest, judged: Judged, restarts: (key: MarkKey) => boolean): Promise<Candidate[][]> {
  const aliases = await loadModelAliases(request.attempt.config);
  const tools = installedConfinedTools(judged.prefer);
  const groups = new Map<string, Candidate[]>();
  const batch = request.batch || judged.batch === true;

  for (const candidate of judged.candidates.filter((one) => request.demand === 'named' || judged.sampled(one) || restarts(judged.key(one)))) {
    const key = groupKey(candidate, judged, { batch, choose: () => chooseJudgeModel(aliases, candidate.definition, tools) });
    groups.set(key, [...groups.get(key) ?? [], candidate]);
  }

  return [...groups.values()];
}

function groupOf(request: PlanRequest, judged: Judged, members: readonly Candidate[]): PlanGroup {
  const stages = new Set(members.flatMap(judged.stagesOf));

  return {
    subject: Subject.format(request.subject),
    hand: '',
    scorers: members.map((member) => member.name).join(','),
    model: members[0]?.definition.model ?? '',
    ci: stages.has('ci'),
    protected: stages.has('protected'),
  };
}

export async function planGroups(request: PlanRequest): Promise<{ ok: true; groups: PlanGroup[] } | Refusal> {
  const { config, run } = request.attempt;
  const scoring = await scopeScoring(config);

  if (!scoring.ok) return refused('scoring_settings_invalid', scoring.reason);
  const { subject } = request;
  const facts = markFacts(config, request.now);
  const restarts = await restartsOf(request, facts);
  const judged = subject.kind === 'run' ? await runJudged(request, subject.subject, scoring.batch) : await sessionJudged(request, subject, scoring);

  if ('ok' in judged) return judged;

  if (request.label !== '') return handGroup(request, judged);
  const groups = await grouped(request, judged, restarts);

  const launch: Launch = {
    run: run.id,
    demand: request.demand,
    groups: groups.map((members) => ({ group: members.map((member) => member.name).join(','), keys: members.map(judged.key) })),
    dailyLimit: scoring.sessions.dailyLimit,
  };

  const opened = await Marks.open(config, launch, facts);

  if (opened.status === 'busy') return refused('busy', 'Another teamai process is writing the scoring marks of this data home. Nothing was planned; run the step again.');

  return {
    ok: true,
    groups: opened.opened.map(({ keys }) => groupOf(request, judged, keys.flatMap((key) => judged.candidates.filter((candidate) => candidate.name === key.scorer)))),
  };
}

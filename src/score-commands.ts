import { z } from 'zod';
import { autoDetectInit, loadLocalConfigForScope } from './config.js';
import { resolveRunMode } from './launch-context.js';
import { AttemptStore, isRunAttempt } from './scorers/attempts.js';
import { isScorerFile } from './scorers/definition.js';
import { parseLeaseRef } from './scorers/entry.js';
import { labelId, labelVersion, type ScoreLabel } from './scorers/label.js';
import { NamedSubject, type NamedPass } from './scorers/named-subject.js';
import { Subject } from './scorers/subject.js';
import { scoreSession, type OwnJudge, type SessionDemand, type TeamSession } from './session-flow/scoring.js';
import type { JsonValue, LocalConfig } from './types.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from './scorers/label-store.js';
import { log, setStderrOnly } from './utils/logger.js';
import { findRunConfig, partitionConfig, projectPartitions } from './workflow/run-location.js';
import { nextJudgeLease, parseJudgeRequest, parseJudgeSubmission, runJudgeLease, submitJudgeLease } from './workflow/scoring.js';
import { readRun } from './workflow/store.js';
import type { RunState, WorkflowEnvelope } from './workflow/types.js';
import { startWorkflow } from './workflow-commands.js';

export interface ScoreOptions {
  next?: boolean;
  lease?: string;
  submit?: boolean;
  json?: string;
  stdin?: boolean;
  run?: string;
  step?: string;
  pass?: string;
  scorer?: string[];
  driver?: string;
  batch?: boolean;
  session?: string;
  source?: string;
  push?: boolean;
  drain?: boolean;
  label?: string;
  teamSession?: string;
  author?: string;
}

function writeEnvelope(envelope: WorkflowEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);

  if ('error' in envelope) process.exitCode = 1;
}

function failure(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));

  return Buffer.concat(chunks).toString('utf8');
}

async function payloadOf(options: ScoreOptions): Promise<{ ok: true; value: JsonValue } | { ok: false; envelope: WorkflowEnvelope }> {
  if (options.json !== undefined && options.stdin) return { ok: false, envelope: failure('invalid_json', 'Pass the payload with --json or --stdin, not both') };
  const text = options.stdin ? await readStdin() : options.json;

  if (text === undefined || text.trim() === '') return { ok: false, envelope: failure('invalid_json', 'Pass the payload with --json <payload> or --stdin') };

  try {
    const value: JsonValue = JSON.parse(text);

    return { ok: true, value };
  } catch {
    return { ok: false, envelope: failure('invalid_json', 'Could not parse the payload as JSON') };
  }
}

/** The pass `--run` names, or the failure that says what is missing. */
function passOf(options: ScoreOptions): NamedPass | WorkflowEnvelope {
  if (options.next || options.lease !== undefined || options.json !== undefined || options.stdin) {
    return failure('invalid_arguments', '--run takes no --next, --lease or payload: teamai score --run <id> [--step <path>] [--pass <n>] --scorer <name> [--batch] [--driver <driver>]');
  }

  const [scorer, ...scorers] = options.scorer ?? [];

  if (options.run === undefined || scorer === undefined) {
    return failure('invalid_arguments', 'Pass --run <id> --scorer <name> to judge a pass on demand; --step <path> picks the step when the run lists the scorer on several, --pass <n> a pass, else the latest that succeeded');
  }

  const pass = options.pass === undefined ? undefined : Number(options.pass);

  if (pass !== undefined && (!/^\d+$/.test(options.pass ?? '') || !Number.isSafeInteger(pass) || pass < 1)) {
    return failure('invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge');
  }

  const named: NamedPass = { run: options.run, scorers: [scorer, ...scorers] };

  if (options.step !== undefined) named.step = options.step;

  if (pass !== undefined) named.pass = pass;

  return named;
}

/** The session `--session` asks for, or the failure that says what is missing. */
function sessionDemandOf(options: ScoreOptions): SessionDemand | WorkflowEnvelope {
  if (options.next || options.lease !== undefined) {
    return failure('invalid_arguments', '--session takes no --next or --lease: teamai score [--session <id>] [--source <platform>] --scorer <name> [--batch] [--json <driver>]');
  }

  const [scorer, ...scorers] = options.scorer ?? [];

  if (scorer === undefined && options.label !== undefined) return failure('invalid_arguments', 'Pass --scorer <name> with --label: the scorer the value is a label of.');

  if (scorer === undefined) return failure('invalid_arguments', 'Pass --scorer <name> to judge a session: teamai score [--session <id>] [--source <platform>] --scorer <name> [--batch]');

  if (options.teamSession !== undefined && (options.session !== undefined || options.source !== undefined)) {
    return failure('invalid_arguments', '--team-session names a pushed session, and --session and --source one on this machine. Pass one of them.');
  }

  if (options.author !== undefined && options.teamSession === undefined) return failure('invalid_arguments', '--author picks who pushed --team-session <name>. Pass it with --team-session.');

  let demand: SessionDemand;

  if (options.teamSession !== undefined) {
    const teamSession: TeamSession = { name: options.teamSession };

    if (options.author !== undefined) teamSession.author = options.author;
    demand = { scorers: [scorer, ...scorers], teamSession };
  } else {
    const local: SessionDemand & { teamSession?: never } = { scorers: [scorer, ...scorers] };

    if (options.session !== undefined) local.session = options.session;

    if (options.source !== undefined) local.source = options.source;
    demand = local;
  }

  if (options.label !== undefined) demand.label = options.label;

  if (options.batch) demand.batch = true;

  if (options.push) demand.push = true;

  return demand;
}

async function localConfig(): Promise<{ ok: true; config: LocalConfig } | { ok: false; envelope: WorkflowEnvelope }> {
  try {
    // oxlint-disable-next-line teamai/config-load-options -- scoring retains normal config migration; its command has no preview mode
    return { ok: true, config: (await autoDetectInit()).localConfig };
  } catch (e) {
    return { ok: false, envelope: failure('not_initialized', e instanceof Error ? e.message : String(e)) };
  }
}

/**
 * The config of the scope that holds run `run`, whatever the cwd, as `workflow` calls on a run find it: a driver asks
 * for a run's judge work from the run's place or from outside the checkout it started in.
 */
async function runConfig(run: string): Promise<{ ok: true; config: LocalConfig } | { ok: false; envelope: WorkflowEnvelope }> {
  const current = await localConfig();
  const found = await findRunConfig(run, current.ok ? current.config : undefined);

  return 'config' in found ? { ok: true, config: found.config } : { ok: false, envelope: found };
}

/**
 * The config of the scope that holds judge lease `ref`, in the scopes `runConfig` searches: this directory's, the user
 * scope's, else a project's, as a run's lease is found from any directory. A run's lease is read in its run's scope.
 */
async function leaseConfig(ref: string): Promise<{ ok: true; config: LocalConfig } | { ok: false; envelope: WorkflowEnvelope }> {
  const current = await localConfig();
  const lease = parseLeaseRef(ref);

  if (lease === undefined) return current;
  const held = (config: LocalConfig) => AttemptStore.get(config, lease.entry, lease.attempt);

  if (current.ok && await held(current.config)) return current;
  const user = await loadLocalConfigForScope('user', undefined, { dryRun: true });

  if (user && await held(user)) return { ok: true, config: user };

  for (const partition of await projectPartitions()) {
    const attempt = await held(partition);

    if (!attempt) continue;

    if (isRunAttempt(attempt)) return runConfig(attempt.subject.runId);
    const config = await partitionConfig(partition);

    if (config) return { ok: true, config };
  }

  return current;
}

/** A teamai-score run the command starts: its subject, found here, and the inputs the person gave. */
interface ScoreStart {
  named: NamedSubject;
  scorers: readonly string[];
  label?: string;
  batch: boolean;
  push: boolean;
}

function refusedWith(refusal: { code: string; message: string }): WorkflowEnvelope {
  // oxlint-disable-next-line teamai/workflow-failure-codes -- forwards a code from a classified workflow or scorer producer
  return failure(refusal.code, refusal.message);
}

async function score(options: ScoreOptions): Promise<WorkflowEnvelope | { start: ScoreStart }> {
  if (options.drain) return failure('invalid_arguments', '--drain goes alone and takes no payload: teamai score --drain');
  const asksForPass = options.run !== undefined || options.step !== undefined || options.pass !== undefined;
  const namesSession = options.session !== undefined || options.source !== undefined || options.teamSession !== undefined || options.author !== undefined || options.label !== undefined;
  const asksForSession = namesSession || (!asksForPass && (options.scorer?.length || options.batch));

  if (asksForPass && namesSession) return failure('invalid_arguments', 'Pass --run to judge a workflow pass, or --session, --team-session or --label to score a session, not both');

  if (options.push && (options.next || options.lease !== undefined)) {
    return failure('invalid_arguments', '--push goes alone, or with a pass or a session: teamai score --push, or teamai score --run <id> | --session <id> --scorer <name> --push');
  }

  const file = options.push ? options.scorer?.find(isScorerFile) : undefined;

  if (file !== undefined) return failure('invalid_arguments', `--push publishes stored labels, and the label of the scorer file ${file} is never stored. Leave out --push to try the file`);

  if (asksForSession) {
    const demand = sessionDemandOf(options);

    if (!('scorers' in demand)) return demand;
    let ownJudge: OwnJudge | undefined;

    if (options.json !== undefined || options.stdin) {
      const payload = await payloadOf(options);

      if (!payload.ok) return payload.envelope;
      const request = parseJudgeRequest(payload.value);

      // The parser answers a string when the payload is not a request.
      if (!(request instanceof Object)) return failure('invalid_json', request);

      if (request.run !== undefined || request.canTakeLease !== undefined) {
        return failure('invalid_json', 'A --session payload leases the session it names: leave out run and canTakeLease.');
      }

      ownJudge = { driver: request.driver, judge: request.judge, running: request.running };
    }

    const loaded = await localConfig();

    if (!loaded.ok) return loaded.envelope;

    // A scorer file's label is only tried, never stored, so it is judged here and starts no teamai-score run.
    if (ownJudge || demand.scorers.some(isScorerFile)) {
      if (options.driver !== undefined) return failure('invalid_arguments', '--driver picks who drives a teamai-score run, and a scorer file or --json judges here without one. Leave out --driver.');

      return scoreSession(loaded.config, ownJudge ? { ...demand, ownJudge } : demand);
    }

    const named = await NamedSubject.ofSession(loaded.config, demand);

    return named.ok ? { start: { named, scorers: demand.scorers, label: demand.label, batch: demand.batch === true, push: demand.push === true } } : refusedWith(named);
  }

  if (asksForPass) {
    const demand = passOf(options);

    if (!('run' in demand)) return demand;
    const loaded = await localConfig();
    const named = await NamedSubject.ofPass(loaded.ok ? loaded.config : undefined, demand);

    return named.ok ? { start: { named, scorers: demand.scorers, batch: options.batch === true, push: options.push === true } } : refusedWith(named);
  }

  if (options.push) {
    if (options.json !== undefined || options.stdin) return failure('invalid_arguments', '--push takes no payload: teamai score --push');
    const loaded = await localConfig();

    return loaded.ok ? LabelStore.push(loaded.config) : loaded.envelope;
  }

  if (options.driver !== undefined) return failure('invalid_arguments', '--driver picks who drives the teamai-score run that --run, --session or --team-session starts. Pass one of them.');

  if (options.next === (options.lease !== undefined)) {
    return failure('invalid_arguments', 'Pass --next to take judge work, --lease <ref> to judge it here, --lease <ref> --submit to settle it, --run <id> --scorer <name> [--step <path>] to judge a pass on demand, --scorer <name> [--session <id>] to judge a session, or --push to publish pending labels');
  }

  const payload = await payloadOf(options);

  if (!payload.ok) return payload.envelope;

  if (options.next) {
    const request = parseJudgeRequest(payload.value);

    // The parser answers a string when the payload is not a request.
    if (!(request instanceof Object)) return failure('invalid_json', request);
    const scoped = request.run !== undefined ? await runConfig(request.run) : await localConfig();

    return scoped.ok ? nextJudgeLease(scoped.config, request) : scoped.envelope;
  }

  const loaded = await leaseConfig(options.lease ?? '');

  if (!loaded.ok) return loaded.envelope;
  const { config } = loaded;

  if (options.lease !== undefined && !options.submit) return runJudgeLease(config, options.lease, payload.value);
  const submission = parseJudgeSubmission(payload.value);

  // The parser answers a string when the payload is not a submission.
  if (!(submission instanceof Object)) return failure('invalid_json', submission);

  return submitJudgeLease(config, options.lease ?? '', submission);
}

/** `teamai score --drain`: drains every scope this directory reaches, in this run mode, and prints what it did. */
async function drainHere(): Promise<void> {
  const [{ Drain }, { reachedScopes }] = await Promise.all([import('./score-drain.js'), import('./score-sessions.js')]);
  const drained = await Drain.run(await reachedScopes(process.cwd()), { mode: resolveRunMode(process.env) });
  Drain.print(drained);

  if (Drain.hasFailed(drained)) process.exitCode = 1;
}

/** `teamai score`: judge work for any driver. Prints one JSON envelope, or with `--drain` the lines of what it did. */
export async function scoreCommand(options: ScoreOptions): Promise<void> {
  const { drain, scorer = [], ...others } = options;

  if (drain && scorer.length === 0 && Object.values(others).every((value) => value === undefined || value === false)) {
    await drainHere();

    return;
  }

  setStderrOnly(true);
  const scored = await score(options);

  if ('start' in scored) await startScore(scored.start, options.driver);
  else writeEnvelope(scored);
}

export const SCORE_WORKFLOW = 'teamai-score';

/**
 * Starts teamai-score for the subject a person named, with `demand: named`, on the local driver unless `driver` names
 * another; `none` leaves the run to any driver's `workflow next`. The local driver drives it to its end, or until only a
 * judge step no tool here can run is left, and the answer is the labels the run wrote.
 */
async function startScore(start: ScoreStart, driver: string | undefined): Promise<void> {
  const { named } = start;
  const inputs = { subject: Subject.format(named.subject), scorers: start.scorers, label: start.label ?? '', batch: start.batch, demand: 'named' };
  const chosen = driver ?? 'local';

  await startWorkflow(SCORE_WORKFLOW, { driver: chosen === 'none' ? undefined : chosen, inputs: JSON.stringify(inputs) }, {
    scope: named.config,
    answer: async (config, runId, driven) => {
      const answered = await scoredAnswer(config, runId, driven, start);

      return answered && start.push && 'data' in answered ? pushed(config, answered) : answered;
    },
  });
}

async function pushed(config: LocalConfig, answered: Extract<WorkflowEnvelope, { data: unknown }>): Promise<WorkflowEnvelope> {
  const delivery = await LabelStore.push(config);

  return 'data' in delivery ? { data: { ...answered.data, ...delivery.data } } : delivery;
}

const DoneSchema = z.object({ outcome: z.string() });

const LabelEntriesSchema = z.object({ labels: z.array(z.object({ scorer: z.string(), label: z.string(), code: z.string() })) });

const GroupsSchema = z.object({ groups: z.array(z.object({ scorers: z.string() })) });

const NOT_PLANNED = 'it was not planned: another run holds its judge work, or no judge tool here runs its model';

/** Why a scorer of the run got no label, as the member reads it. */
const UNLABELLED = new Map([
  ['check_could_not_run', 'its check could not run, so no judge ran'],
  ['ci_pending', 'the CI of its pull request has not finished; the next teamai score --drain labels it once CI finishes'],
  ['judge_failed', 'its judge failed'],
  ['judge_answer_invalid', 'its judge answered outside the answer schema'],
  ['judge_tool_unavailable', 'no judge tool here runs it'],
  ['not_planned', NOT_PLANNED],
]);

type Outcome = { scorer: string } & ({ kind: 'labelled'; label: ScoreLabel | undefined; value: string } | { kind: 'unlabelled'; code: string; message: string } | { kind: 'pending' });

/** What run `run` gave each scorer the person named: a label, a code, or a judge step still open. */
function outcomesOf(run: RunState, scorers: readonly string[], stored: readonly ScoreLabel[]): Outcome[] {
  const plan = run.steps.find((step) => step.id === 'plan');
  const groups = GroupsSchema.safeParse(plan?.status === 'succeeded' ? plan.outputs : undefined).data?.groups ?? [];
  const entries = new Map<string, { label: string; code: string; why?: string }>();
  const settled = new Map<string, string | undefined>();

  groups.forEach((group, index) => {
    const inItem = run.steps.filter((step) => step.id.startsWith(`score[${index}].`));
    const labelled = inItem.find((step) => step.id === `score[${index}].label`);
    const listed = LabelEntriesSchema.safeParse(labelled?.status === 'succeeded' ? labelled.outputs : undefined);

    const judge = inItem.find((step) => step.id === `score[${index}].judge`);
    const why = judge && 'message' in judge && judge.message ? judge.message : undefined;

    for (const entry of listed.data?.labels ?? []) entries.set(entry.scorer, why === undefined || entry.code !== 'judge_failed' ? entry : { ...entry, why });
    const broke = inItem.find((step) => step.status === 'failed' || step.status === 'cancelled');
    const open = inItem.some((step) => ['pending', 'waiting', 'leased', 'running'].includes(step.status));

    for (const name of group.scorers.split(',')) settled.set(name, open ? undefined : broke ? `step ${broke.id} ${broke.status}${'message' in broke && broke.message ? `: ${broke.message}` : ''}` : '');
  });

  return scorers.map((scorer): Outcome => {
    const entry = entries.get(scorer);

    if (entry && entry.code === '') {
      const label = stored.filter((one) => one.scorer === scorer && one.scoredAt >= run.createdAt).sort((left, right) => (left.scoredAt < right.scoredAt ? 1 : -1))[0];

      return { scorer, kind: 'labelled', label, value: entry.label };
    }

    if (entry) return { scorer, kind: 'unlabelled', code: entry.code, message: `${UNLABELLED.get(entry.code) ?? entry.code}${entry.why === undefined ? '' : `: ${entry.why}`}` };

    if (!settled.has(scorer)) return { scorer, kind: 'unlabelled', code: 'not_planned', message: NOT_PLANNED };
    const broke = settled.get(scorer);

    if (broke === undefined) return { scorer, kind: 'pending' };

    return { scorer, kind: 'unlabelled', code: 'score_step_failed', message: broke === '' ? 'the run wrote no label for it' : broke };
  });
}

/** What the answer of teamai score carries of one label it wrote. */
type ScoreAnswer = Pick<ScoreLabel, 'scorer' | 'subject' | 'label' | 'score' | 'passed'> & {
  labelId: string;
  judge: { kind: 'human' } | { kind: 'model'; tool: string };
  decidedBy?: string;
  reasoning?: string;
};

/** What the person reads of one label, and what the answer carries of it. */
function answerOf(config: LocalConfig, label: ScoreLabel): ScoreAnswer {
  const verdict = `${label.label} (score ${label.score}, ${label.passed ? 'passed' : 'did not pass'})`;
  const answer: ScoreAnswer = { scorer: label.scorer, subject: label.subject, label: label.label, score: label.score, passed: label.passed, labelId: labelId(label), judge: { kind: 'human' } };

  if (label.judge.kind === 'human') {
    log.info(`${label.scorer}: ${verdict}, by hand. No judge ran.`);

    return answer;
  }

  const reasoning = reasoningPath(config, labelVersion(label));
  log.info(`${label.scorer}: ${verdict}. Reasoning: ${reasoning}`);

  if (!label.passed) log.info(shareFailedLabelHint(reasoning, label.source === 'session' ? label.subject.sessionId : undefined));
  answer.judge = { kind: 'model', tool: label.judge.tool };
  answer.reasoning = reasoning;

  if (label.source === 'workflow' && label.decidedBy) answer.decidedBy = label.decidedBy;

  return answer;
}

/**
 * The answer of a teamai-score run the local driver drove: the labels it wrote, or, when a scorer got none, the code
 * that says why, with the labels the others got. Undefined when the run did not end succeeded and no judge step holds
 * it, so the driver's own answer is printed.
 */
async function scoredAnswer(config: LocalConfig, runId: string, driven: WorkflowEnvelope, start: ScoreStart): Promise<WorkflowEnvelope | undefined> {
  const held = 'error' in driven && driven.error.code === 'confined_pending' ? driven.error.message : undefined;

  if (held === undefined && ('error' in driven || DoneSchema.safeParse(driven.data.done).data?.outcome !== 'succeeded')) return undefined;
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return undefined;
  const outcomes = outcomesOf(run, start.scorers, await LabelStore.local(config));
  const labels = outcomes.flatMap((outcome) => (outcome.kind === 'labelled' && outcome.label ? [answerOf(config, outcome.label)] : outcome.kind === 'labelled' ? [{ scorer: outcome.scorer, label: outcome.value }] : []));
  const kept = outcomes.flatMap((outcome) => (outcome.kind === 'labelled' ? [`${outcome.scorer}: ${outcome.value}`] : []));
  const keeping = kept.length > 0 ? ` Kept the label of ${kept.join(', ')}.` : '';
  const pending = outcomes.filter((outcome) => outcome.kind === 'pending').map((outcome) => outcome.scorer);

  if (held !== undefined || pending.length > 0) {
    return { error: { code: 'judge_pending', message: `Run ${runId} left the judge of ${pending.join(', ') || 'a scorer'} open for a driver that can run it: ${held ?? 'its judge step is still open'} The run waits for one until its timeout, and teamai score --drain lists it.${keeping}`, labels } };
  }

  const unlabelled = outcomes.flatMap((outcome) => (outcome.kind === 'unlabelled' ? [outcome] : []));
  const [first] = unlabelled;

  if (first) {
    for (const one of unlabelled) log.warn(`${one.scorer}: no label, ${one.message}`);

    return { error: { code: first.code, message: `Run ${runId}: ${unlabelled.map((one) => `${one.scorer} got no label (${one.code}): ${one.message}.`).join(' ')}${keeping}`, labels } };
  }

  const [only, ...more] = labels;

  return { data: only && more.length === 0 ? { run: runId, label: only } : { run: runId, labels } };
}

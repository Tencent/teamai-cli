import { autoDetectInit, loadLocalConfigForScope } from './config.js';
import { resolveRunMode } from './launch-context.js';
import { AttemptStore, isRunAttempt } from './scorers/attempts.js';
import { isScorerFile } from './scorers/definition.js';
import { parseLeaseRef } from './scorers/entry.js';
import { NamedSubject, type NamedPass } from './scorers/named-subject.js';
import { ScoreAnswer } from './scorers/score-answer.js';
import { Subject } from './scorers/subject.js';
import { scoreSession, type OwnJudge, type SessionDemand } from './session-flow/scoring.js';
import type { JsonValue, LocalConfig } from './types.js';
import { LabelStore } from './scorers/label-store.js';
import { setStderrOnly } from './utils/logger.js';
import { shellQuoteValue } from './utils/shell-profile.js';
import { findRunConfig, partitionConfig, projectPartitions } from './workflow/run-location.js';
import { nextJudgeLease, parseJudgeRequest, parseJudgeSubmission, runJudgeLease, submitJudgeLease } from './workflow/scoring.js';
import type { WorkflowEnvelope } from './workflow/types.js';
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

/** Whether `options` take or settle judge work, which a named subject does not. */
function asksForWork(options: ScoreOptions): boolean {
  return options.next === true || options.lease !== undefined;
}

/** `named` at the pass `--pass` names, or the failure that says it is not a positive whole number. */
function atPass(named: NamedPass, text: string | undefined): NamedPass | WorkflowEnvelope {
  if (text === undefined) return named;
  const pass = Number(text);

  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(pass) || pass < 1) return failure('invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge');

  return { ...named, pass };
}

/** The pass `--run` names, or the failure that says what is missing. */
function passOf(options: ScoreOptions): NamedPass | WorkflowEnvelope {
  if (asksForWork(options) || options.json !== undefined || options.stdin) {
    return failure('invalid_arguments', '--run takes no --next, --lease or payload: teamai score --run <id> [--step <path>] [--pass <n>] --scorer <name> [--batch] [--driver <driver>]');
  }

  const [scorer, ...scorers] = options.scorer ?? [];

  if (options.run === undefined || scorer === undefined) {
    return failure('invalid_arguments', 'Pass --run <id> --scorer <name> to judge a pass on demand; --step <path> picks the step when the run lists the scorer on several, --pass <n> a pass, else the latest that succeeded');
  }

  return atPass({ run: options.run, step: options.step, scorers: [scorer, ...scorers] }, options.pass);
}

/** Why `options` name no one session: a pushed one and one on this machine at once, or an author of neither. */
function placeMisuseOf(options: ScoreOptions): WorkflowEnvelope | undefined {
  if (options.teamSession === undefined) {
    return options.author === undefined ? undefined : failure('invalid_arguments', '--author picks who pushed --team-session <name>. Pass it with --team-session.');
  }

  return options.session === undefined && options.source === undefined ? undefined : failure('invalid_arguments', '--team-session names a pushed session, and --session and --source one on this machine. Pass one of them.');
}

/** The session `--session` asks for, or the failure that says what is missing. */
function sessionDemandOf(options: ScoreOptions): SessionDemand | WorkflowEnvelope {
  if (asksForWork(options)) return failure('invalid_arguments', '--session takes no --next or --lease: teamai score [--session <id>] [--source <platform>] --scorer <name> [--batch] [--json <driver>]');
  const [scorer, ...scorers] = options.scorer ?? [];

  if (scorer === undefined) {
    return options.label === undefined
      ? failure('invalid_arguments', 'Pass --scorer <name> to judge a session: teamai score [--session <id>] [--source <platform>] --scorer <name> [--batch]')
      : failure('invalid_arguments', 'Pass --scorer <name> with --label: the scorer the value is a label of.');
  }

  const misuse = placeMisuseOf(options);

  if (misuse !== undefined) return misuse;
  const { teamSession: name, author, session, source } = options;
  const flags = { scorers: [scorer, ...scorers] as const, label: options.label, batch: options.batch === true, push: options.push === true };

  return name === undefined ? { ...flags, session, source } : { ...flags, teamSession: { name, author } };
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

/** `value` as one shell word: as it is when the shell reads nothing special in it, else single-quoted. */
function shellWord(value: string): string {
  return /^[\w.:/@%+=-]+$/u.test(value) ? value : shellQuoteValue(value);
}

/** The flags of `teamai score` that name `subject`. */
function subjectWords(subject: Subject): string[] {
  switch (subject.kind) {
    case 'run':
      return ['--run', subject.subject.runId, '--step', subject.subject.step, '--pass', String(subject.subject.pass)];
    case 'session':
      return ['--session', subject.subject.sessionId, '--source', subject.subject.platform];
    case 'team-session':
      return ['--team-session', subject.subject.name, '--author', subject.subject.author];
    default: {
      const unhandled: never = subject;

      return unhandled;
    }
  }
}

/**
 * What an agent session runs in place of `start`, which it may not make: the person runs the same `teamai score` in
 * their own terminal, naming the subject in full, and the agent judges its own session with /teamai-share-session.
 */
function insteadOf(start: ScoreStart, driver: string | undefined): string {
  const { subject } = start.named;
  const words = ['teamai', 'score', ...subjectWords(subject), ...start.scorers.flatMap((scorer) => ['--scorer', scorer])];

  words.push(...(start.label === undefined ? [] : ['--label', start.label]), ...(start.batch ? ['--batch'] : []), ...(driver === undefined ? [] : ['--driver', driver]), ...(start.push ? ['--push'] : []));
  const person = `The person runs ${words.map(shellWord).join(' ')} in their own terminal`;

  return subject.kind === 'session' ? `${person}, and the agent judges this session with /teamai-share-session.` : `${person}.`;
}

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
    instead: insteadOf(start, driver),
    answer: async (config, runId, driven) => {
      const answered = await ScoreAnswer.of(config, runId, driven, start.scorers);

      return answered && start.push && 'data' in answered ? pushed(config, answered) : answered;
    },
  });
}

async function pushed(config: LocalConfig, answered: Extract<WorkflowEnvelope, { data: unknown }>): Promise<WorkflowEnvelope> {
  const delivery = await LabelStore.push(config);

  return 'data' in delivery ? { data: { ...answered.data, ...delivery.data } } : delivery;
}

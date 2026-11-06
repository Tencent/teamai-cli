import { autoDetectInit } from './config.js';
import { resolveRunMode } from './launch-context.js';
import { isScorerFile } from './scorers/definition.js';
import { NamedSubject, type NamedPass } from './scorers/named-subject.js';
import { ScoreAnswer } from './scorers/score-answer.js';
import { Subject } from './scorers/subject.js';
import type { SessionDemand } from './session-flow/scoring.js';
import { TryScorer, type TryInputs } from './scorers/try-scorer.js';
import { JsonObjectSchema, type LocalConfig } from './types.js';
import { LabelStore } from './scorers/label-store.js';
import { DataBranches } from './utils/data-branches.js';
import { log, setStderrOnly } from './utils/logger.js';
import { shellQuoteValue } from './utils/shell-profile.js';
import type { WorkflowEnvelope } from './workflow/types.js';
import { shortcutDriver, startWorkflow } from './workflow-commands.js';
import { SCORE_WORKFLOW, TRY_SCORER_WORKFLOW } from './scorers/judging-workflows.js';
import { z } from 'zod';

export interface ScoreOptions {
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

/** `named` at the pass `--pass` names, or the failure that says it is not a positive whole number. */
function atPass(named: NamedPass, text: string | undefined): NamedPass | WorkflowEnvelope {
  if (text === undefined) return named;
  const pass = Number(text);

  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(pass) || pass < 1) return failure('invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge');

  return { ...named, pass };
}

/** The pass `--run` names, or the failure that says what is missing. */
function passOf(options: ScoreOptions): NamedPass | WorkflowEnvelope {
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

/** What a `teamai score` call answers: an envelope, or the teamai-score run it starts. */
/** A teamai-try-scorer run that tries the scorer files `files` names, as given, on a session. */
interface TryStart {
  config: LocalConfig;
  subject: Subject;
  files: readonly string[];
  inputs: TryInputs;
}

type Scored = WorkflowEnvelope | { start: ScoreStart } | { tryFiles: TryStart };

/** Whether `options` name a pass: `--run`, `--step` or `--pass`. */
function namesPass(options: ScoreOptions): boolean {
  return [options.run, options.step, options.pass].some((flag) => flag !== undefined);
}

/** Whether `options` name a session: on this machine, pushed, or labelled by hand. */
function namesSession(options: ScoreOptions): boolean {
  return [options.session, options.source, options.teamSession, options.author, options.label].some((flag) => flag !== undefined);
}

/** The refusal of `--label` beside a pass and no session, with the teamai-score start that labels that pass by hand. */
function passLabelRefusal(options: ScoreOptions): WorkflowEnvelope | undefined {
  const { label } = options;

  if (!namesPass(options) || label === undefined || [options.session, options.source, options.teamSession, options.author].some((flag) => flag !== undefined)) return undefined;
  const run = options.run ?? '<run id>';
  const step = options.step ?? '<step path>';
  const pass = options.pass ?? '<pass>';
  const inputs = { subject: `run:${run}:${step}:${pass}`, scorers: options.scorer ?? ['<scorer>'], label, batch: false, demand: 'named' };

  return failure('invalid_arguments', `--label labels a session. To label pass ${pass} of step ${step} of run ${run} by hand, run in your own terminal: teamai workflow start teamai-score --driver local --inputs ${shellWord(JSON.stringify(inputs))}`);
}

/** Why the flags of `options` cannot go together, or undefined. */
function flagConflict(options: ScoreOptions): WorkflowEnvelope | undefined {
  if (options.drain) return failure('invalid_arguments', '--drain goes alone: teamai score --drain');
  const passLabel = passLabelRefusal(options);

  if (passLabel) return passLabel;

  if (namesPass(options) && namesSession(options)) return failure('invalid_arguments', 'Pass --run to judge a workflow pass, or --session, --team-session or --label to score a session, not both');
  const file = options.push ? options.scorer?.find(isScorerFile) : undefined;

  return file === undefined ? undefined : failure('invalid_arguments', `--push publishes stored labels, and the label of the scorer file ${file} is never stored. Leave out --push to try the file`);
}

/** What the flags of `options` ask for: a scorer with no pass flag judges a session, the one the agent session names. */
function askOf(options: ScoreOptions): 'pass' | 'session' | 'push' | 'none' {
  if (namesSession(options)) return 'session';

  if (namesPass(options)) return 'pass';

  if ((options.scorer ?? []).length > 0 || options.batch === true) return 'session';

  return options.push ? 'push' : 'none';
}

/** The teamai-score run that judges the session `options` name, or the teamai-try-scorer run that tries scorer files on it. */
async function sessionScore(options: ScoreOptions): Promise<Scored> {
  const demand = sessionDemandOf(options);

  if (!('scorers' in demand)) return demand;
  const loaded = await localConfig();

  if (!loaded.ok) return loaded.envelope;

  // A scorer file's label is only tried, never stored: a teamai-try-scorer run judges it, and stores nothing.
  if (demand.scorers.some(isScorerFile)) {
    const cached = demand.scorers.find((scorer) => !isScorerFile(scorer));

    if (cached !== undefined) return failure('invalid_arguments', `A scorer file is tried by a teamai-try-scorer run, which stores nothing, and --scorer ${cached} is judged by a teamai-score run. Score them in separate commands.`);

    if (demand.label !== undefined) return failure('invalid_arguments', `--label is stored, and the label of the scorer file ${demand.scorers.find(isScorerFile)} is never stored. Pass the name of a scorer teamai pull cached.`);
    const prepared = await TryScorer.prepare(loaded.config, demand);

    return prepared.ok ? { tryFiles: { config: prepared.config, subject: prepared.subject, files: demand.scorers, inputs: prepared.inputs } } : refusedWith(prepared);
  }

  const named = await NamedSubject.ofSession(loaded.config, demand);

  return named.ok ? { start: { named, scorers: demand.scorers, label: demand.label, batch: demand.batch === true, push: demand.push === true } } : refusedWith(named);
}

/** The teamai-score run that judges the pass `options` name. */
async function passScore(options: ScoreOptions): Promise<Scored> {
  const demand = passOf(options);

  if (!('run' in demand)) return demand;
  const loaded = await localConfig();
  const named = await NamedSubject.ofPass(loaded.ok ? loaded.config : undefined, demand);

  return named.ok ? { start: { named, scorers: demand.scorers, batch: options.batch === true, push: options.push === true } } : refusedWith(named);
}

async function score(options: ScoreOptions): Promise<Scored> {
  const conflict = flagConflict(options);

  if (conflict !== undefined) return conflict;
  const ask = askOf(options);

  switch (ask) {
    case 'session':
      return sessionScore(options);
    case 'pass':
      return passScore(options);
    case 'push': {
      const loaded = await localConfig();

      return loaded.ok ? pushPending(loaded.config) : loaded.envelope;
    }

    case 'none':
      return options.driver === undefined
        ? failure('invalid_arguments', 'Pass --run <id> --scorer <name> [--step <path>] to judge a pass on demand, --scorer <name> [--session <id>] to judge a session, or --push to publish pending labels')
        : failure('invalid_arguments', '--driver picks who drives the teamai-score run that --run, --session or --team-session starts. Pass one of them.');
    default: {
      const unhandled: never = ask;

      return unhandled;
    }
  }
}

/** `teamai score --drain`: drains every scope this directory reaches, in this run mode, and prints what it did. */
async function drainHere(): Promise<void> {
  const [{ Drain }, { FinishedSessions }] = await Promise.all([import('./score-drain.js'), import('./session-flow/finished-sessions.js')]);
  const drained = await Drain.run(await FinishedSessions.reachedScopes(process.cwd()), { mode: resolveRunMode(process.env) });
  Drain.print(drained);

  if (Drain.hasFailed(drained)) process.exitCode = 1;
}

/** `teamai score`: labels a pass or a session. Prints one JSON envelope, or with `--drain` the lines of what it did. */
export async function scoreCommand(options: ScoreOptions): Promise<void> {
  const { drain, scorer = [], ...others } = options;

  if (drain && scorer.length === 0 && Object.values(others).every((value) => value === undefined || value === false)) {
    await drainHere();

    return;
  }

  setStderrOnly(true);
  const scored = await score(options);

  if ('start' in scored) await startScore(scored.start, options.driver);
  else if ('tryFiles' in scored) await startTry(scored.tryFiles, options.driver);
  else writeEnvelope(scored);
}

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
 * Starts teamai-score for the subject a person named, with `demand: named`, on the driver `driver` names, else on the
 * one `workflows.driver` names, else on the local driver; `none` leaves the run to any driver's `workflow next`, and a
 * driver this machine does not run leaves it awaiting that driver. The local driver drives it to its end, or until only
 * a judge step no tool here can run is left, and the answer is the labels the run wrote.
 */
async function startScore(start: ScoreStart, driver: string | undefined): Promise<void> {
  const { named } = start;
  const inputs = { subject: Subject.format(named.subject), scorers: start.scorers, label: start.label ?? '', batch: start.batch, demand: 'named' };
  const { driver: chosen, byDefault } = await shortcutDriver(named.config, driver);

  await startWorkflow(SCORE_WORKFLOW, { driver: chosen === 'none' ? undefined : chosen, inputs: JSON.stringify(inputs) }, {
    scope: named.config,
    byDefault,
    instead: insteadOf(start, driver),
    answer: async (config, runId, driven) => {
      const answered = await ScoreAnswer.of(config, runId, driven, start.scorers);

      return answered && start.push && 'data' in answered ? pushed(config, answered) : answered;
    },
  });
}

/** What a teamai-try-scorer run ends with: the envelope `teamai score` prints, and the lines a person reads. */
const TriedSchema = z.object({ data: z.object({ done: z.object({ outputs: z.object({
  answer: z.union([z.object({ data: JsonObjectSchema }), z.object({ error: z.object({ code: z.string(), message: z.string() }) })]),
  text: z.string(),
  // A team's own teamai-try-scorer may not output warnings.
  warnings: z.string().default(''),
}) }) }) });

/**
 * Starts teamai-try-scorer on the session, on the driver `driver` names or the default one, as `startScore` does. The
 * answer is the envelope its report gave, with each file's lines on stderr; a run that did not end says why it stopped.
 */
async function startTry(start: TryStart, driver: string | undefined): Promise<void> {
  const { driver: chosen, byDefault } = await shortcutDriver(start.config, driver);
  const words = ['teamai', 'score', ...subjectWords(start.subject), ...start.files.flatMap((file) => ['--scorer', file]), ...(start.inputs.batch ? ['--batch'] : [])];

  await startWorkflow(TRY_SCORER_WORKFLOW, { driver: chosen === 'none' ? undefined : chosen, inputs: JSON.stringify(start.inputs) }, {
    scope: start.config,
    byDefault,
    instead: `The person runs ${words.map(shellWord).join(' ')} in their own terminal, and the agent drafts and tries a scorer with /teamai-new-scorer.`,
    answer: async (_config, _runId, driven) => {
      const tried = TriedSchema.safeParse(driven);

      if (!tried.success) return undefined;
      const { answer, text, warnings } = tried.data.data.done.outputs;

      for (const line of text.split('\n').filter(Boolean)) log.info(line);

      for (const line of warnings.split('\n').filter(Boolean)) log.warn(line);

      return answer;
    },
  });
}

/**
 * `teamai score --push`: publishes the pending labels, then pushes what a `deliver: publish` step left on this machine's
 * checkout of a data branch while origin could not take it. `published` is false while any of it stays pending.
 */
async function pushPending(config: LocalConfig): Promise<{ data: { published: boolean } } | { error: { code: string; message: string } }> {
  const labels = await LabelStore.push(config);

  if (!('data' in labels)) return labels;
  // Labels that stay pending leave their commit on teamai-reports, and their own line says so, as the drain's does.
  const stuck = (await DataBranches.sendPending(config)).filter(({ branch }) => labels.data.published || branch !== 'teamai-reports');

  for (const { message } of stuck) log.warn(message);

  return stuck.length === 0 ? labels : { data: { published: false } };
}

async function pushed(config: LocalConfig, answered: Extract<WorkflowEnvelope, { data: unknown }>): Promise<WorkflowEnvelope> {
  const delivery = await pushPending(config);

  return 'data' in delivery ? { data: { ...answered.data, ...delivery.data } } : delivery;
}

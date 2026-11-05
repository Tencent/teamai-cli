/**
 * `teamai session list --finished`: the finished sessions of one data home that `teamai-finished-sessions` archives and
 * judges, each with whether to publish it and the scorers to judge it with. The session-start hook and `teamai score
 * --drain` start that workflow once for each scope a directory reaches, so every item runs in its session's data home.
 */
import { z } from 'zod';
import { readContributeState } from '../contribute-check.js';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from '../config.js';
import { ATTEMPT_ENV, RUN_MODES, type RunMode } from '../launch-context.js';
import { pinScorers } from '../scorers/cache.js';
import { scoringUnavailable } from '../scorers/home.js';
import { FINISHED_WORKFLOW } from '../scorers/judging-workflows.js';
import { Marks, type Demand, type MarkKey } from '../scorers/marks.js';
import { pinnedDefinition } from '../scorers/pin.js';
import { markFacts } from '../scorers/score-plan.js';
import { ScoreSubjects } from '../scorers/score-subjects.js';
import { scopeScoring, type ScopeScoring } from '../scorers/settings.js';
import { GeneratedQuestions } from '../scorers/generated-questions.js';
import { driverIdentity } from '../driver-identity.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { pathExists } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { runDeadline } from '../workflow/limits.js';
import { durationMs } from '../workflow/parse.js';
import { startAsCli, type WorkflowClient } from '../workflow/protocol.js';
import { findRunConfig } from '../workflow/run-location.js';
import { wasLeased } from '../workflow/step-state.js';
import { readRuns, RunIdSchema, type RunId } from '../workflow/store.js';
import type { DriverName } from '../workflow/driver-name.js';
import type { RunState, WorkflowFailure } from '../workflow/types.js';
import { SessionCaptures } from './captures.js';
import { SessionPolicy } from './session-policy.js';
import { SessionPublish } from './session-publish.js';
import { SessionWork, type SessionScorer } from './session-work.js';

/** A finished session to archive, judge, or both, in the data home that lists it. */
export interface FinishedSession {
  session: string;
  source: string;
  publish: boolean;
  scorers: string[];
  /** `named` when a person named the scorers: they judge it unsampled, and `daily_limit` counts it but never refuses it. */
  demand: Demand;
}

const PUBLISH = ['policy', 'always', 'never'] as const;

/** The flags of `session list --finished`, as the command line gives them. */
export interface ListOptions {
  idle?: string;
  publish?: string;
  /** A JSON array, as a run's `scorers` input renders. */
  scorers?: string;
}

/** Where the listing runs: the process's environment, the scope of its directory, and the time it reads as now. */
export interface ListContext {
  env: NodeJS.ProcessEnv;
  current: LocalConfig | undefined;
  now: string;
}

type Refusal = { ok: false; code: string; message: string };

export type Listed = { ok: true; list: FinishedSession[] } | Refusal;

/** A finished session a person may share learnings from: when something last happened in it, and its first prompt, redacted. */
export interface ShareableSession {
  session: string;
  source: string;
  ended: string;
  prompt: string;
}

/** The flags of `session list --finished --all`, as the command line gives them: `--publish` and `--scorers` are refused. */
export interface ShareOptions extends ListOptions {
  within?: string;
}

export type Shareable = { ok: true; list: ShareableSession[] } | Refusal;

interface Request {
  idleMs: number;
  publish: (typeof PUBLISH)[number];
  scorers: string[];
}

function refused(code: string, message: string): Refusal {
  return { ok: false, code, message };
}

const ScorersSchema = z.array(z.string().min(1));

/** `--scorers` read as a JSON array of names, or undefined when it is none. */
function scorerNames(text: string): string[] | undefined {
  try {
    return ScorersSchema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

function requestOf({ idle = '6h', publish = 'policy', scorers = '[]' }: ListOptions): Request | Refusal {
  const idleMs = durationMs(idle);

  if (idleMs === undefined) return refused('invalid_arguments', `--idle ${idle} is not a duration. Pass a whole number of s, m or h, such as 6h.`);
  const policy = z.enum(PUBLISH).safeParse(publish);

  if (!policy.success) return refused('invalid_arguments', `--publish ${publish} is not one of ${PUBLISH.join(', ')}.`);
  const names = scorerNames(scorers);

  if (!names) return refused('invalid_arguments', `--scorers ${scorers} is not a JSON array of scorer names, such as ["review-quality"].`);

  return { idleMs, publish: policy.data, scorers: names };
}

/**
 * The scope the listing reads, and whether its request may replace the policies. Inside a workflow attempt it is the
 * scope of the attempt's run, and only a run a person started may pass anything but `policy` and `[]`.
 */
async function scopeOf(request: Request, ctx: ListContext): Promise<{ ok: true; config: LocalConfig } | Extract<Listed, { ok: false }>> {
  const marker = ctx.env[ATTEMPT_ENV];

  if (!marker) return ctx.current ? { ok: true, config: ctx.current } : { ok: false, code: 'not_initialized', message: 'teamai is not set up in this directory, so it has no sessions to list. Run teamai init.' };
  const [runId = ''] = marker.split('/');
  const found = await findRunConfig(runId, ctx.current);

  if ('error' in found) return { ok: false, code: found.error.code, message: found.error.message };
  const overrides = request.publish !== 'policy' || request.scorers.length > 0;

  if (overrides && found.run.startedBy !== 'person') {
    return {
      ok: false,
      code: 'policy_override_refused',
      message: `Run ${found.run.id} was not started from a person's terminal, so it lists sessions only as the team's session policies say: --publish policy --scorers '[]'. Start teamai-finished-sessions from your own terminal to pass other inputs.`,
    };
  }

  return { ok: true, config: found.config };
}

/** The scorers a request names, each as cached here; refused for a name teamai pull cached no scorer of. */
async function namedScorers(config: LocalConfig, names: readonly string[]): Promise<SessionScorer[] | Extract<Listed, { ok: false }>> {
  const pins = await pinScorers(config, names);
  const missing = names.find((name) => pins[name] === undefined);

  if (missing !== undefined) return { ok: false, code: 'scorer_not_found', message: `Scorer ${missing} is not a scorer teamai pull cached. Name one that is, or run teamai pull for the team's newest scorers.` };

  return names.flatMap((name) => {
    const pin = pins[name];
    const definition = pin && pinnedDefinition(name, pin);

    return pin && definition ? [{ scorer: name, pin, definition }] : [];
  });
}

/** Of `scorers`, those whose mark of the session automatic judging still starts: never marked, or a lapse before the fourth. */
async function unmarked(config: LocalConfig, scorers: readonly SessionScorer[], key: { platform: string; sessionId: string }, now: string): Promise<string[]> {
  const keys = scorers.map((one): MarkKey => ({ scorer: one.scorer, sourceHash: one.pin.sourceHash, subject: { kind: 'session', subject: key } }));
  const states = await Marks.states(config, keys, markFacts(config, now));

  return scorers.flatMap((one, index) => {
    const state = states[index];

    return state && Marks.startsAgain(state) ? [one.scorer] : [];
  });
}

async function list(options: ListOptions, ctx: ListContext): Promise<Listed> {
  const request = requestOf(options);

  if ('ok' in request) return request;
  const scope = await scopeOf(request, ctx);

  return scope.ok ? listIn(scope.config, request, ctx.now) : scope;
}

/** How far back `session list --finished --all` looks unless `--within` says otherwise. */
const SHARE_WITHIN = '7d';

/**
 * Every finished session of the scope, of any run mode, last active within `within`, that no learning was contributed
 * from yet, whatever the session policies and archive marks say: it publishes and judges nothing, so any run may list
 * them. Each comes with its first prompt as `teamai session show` redacts it; a session with nothing to read is left out.
 */
async function shareable({ within = SHARE_WITHIN, ...options }: ShareOptions, ctx: ListContext): Promise<Shareable> {
  if (options.publish !== undefined || options.scorers !== undefined) {
    return refused('invalid_arguments', '--finished --all lists every finished session to share learnings from, whatever the session policies say, so it takes no --publish or --scorers. Drop them, or drop --all to list the sessions to archive and judge.');
  }

  const request = requestOf(options);

  if ('ok' in request) return request;
  const withinMs = durationMs(within);

  if (withinMs === undefined) return refused('invalid_arguments', `--within ${within} is not a duration. Pass a whole number of s, m, h or d, such as 7d.`);
  const scope = await scopeOf(request, ctx);

  if (!scope.ok) return scope;
  const since = Date.parse(ctx.now) - withinMs;
  const found: ShareableSession[] = [];

  for (const session of await SessionWork.finished(await SessionCaptures.list(scope.config), ctx.now, () => true, request.idleMs)) {
    if (session.activeAt < since || (await readContributeState(session.sessionId)).contributed) continue;
    const read = await SessionWork.read(scope.config, { platform: session.platform, sessionId: session.sessionId });

    if (read.ok) found.push({ session: session.sessionId, source: session.platform, ended: new Date(session.activeAt).toISOString(), prompt: read.judged.context.prompt });
  }

  return { ok: true, list: found };
}

/** What a request asks of the sessions of each run mode: whether to judge them, with which scorers, and to publish them. */
interface Wants {
  scores: (mode: RunMode) => boolean;
  publishes: (mode: RunMode) => boolean;
  candidates: (session: Finished) => Promise<SessionScorer[]>;
  demand: Demand;
}

type Finished = Awaited<ReturnType<typeof SessionWork.finished>>[number];

async function wantsOf(config: LocalConfig, request: Request): Promise<Wants | Extract<Listed, { ok: false }>> {
  const scoring = await scoringOf(config);

  if (scoring?.ok === false) return { ok: false, code: 'scoring_settings_invalid', message: scoring.reason };
  const judging = scoring && judgingOf(scoring);
  const publishing = SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies;
  const chosen = await candidatesOf(config, { names: request.scorers, judging });

  if ('ok' in chosen) return chosen;

  return {
    ...chosen,
    scores: (mode) => chosen.demand === 'named' || judging?.policies[mode].policy === 'auto',
    publishes: (mode) => request.publish === 'always' || (request.publish === 'policy' && publishing[mode].policy === 'auto'),
  };
}

/** The scoring settings of `config`, or why they do not load; none while scoring is unavailable here. */
async function scoringOf(config: LocalConfig) {
  return scoringUnavailable(config) ? undefined : scopeScoring(config);
}

/** The session judging policies of loaded `scoring`, and which generated questions its switches ask. */
function judgingOf(scoring: Extract<ScopeScoring, { ok: true }>) {
  return { policies: scoring.sessions.policies, switches: { skillRouting: scoring.skillRouting, recallAdoption: scoring.recallAdoption } };
}

/**
 * Which scorers judge a session: the scorers `names` names, whatever a policy says, or else, while `judging`, those
 * that sample it and the generated questions its switches ask: routing per delivered team skill, adoption per recalled
 * doc it never opened.
 */
async function candidatesOf(config: LocalConfig, { names, judging }: { names: readonly string[]; judging: ReturnType<typeof judgingOf> | undefined }): Promise<Pick<Wants, 'candidates' | 'demand'> | Extract<Listed, { ok: false }>> {
  if (names.length === 0 && judging === undefined) return { candidates: async () => [], demand: 'auto' };

  if (names.length === 0) {
    const sampling = await SessionWork.samplingScorers(config);
    const generated = async (session: Finished) => (judging ? GeneratedQuestions.questions(config, { subject: { platform: session.platform, sessionId: session.sessionId }, captures: session.captures }, judging.switches) : []);

    return { candidates: async (session) => [...await sampling(session), ...await generated(session)], demand: 'auto' };
  }

  const named = await namedScorers(config, names);

  return 'ok' in named ? named : { candidates: async () => named, demand: 'named' };
}

/** `session` as the listing gives it, or undefined when `wants` leaves nothing to archive or judge in it. */
async function itemOf(config: LocalConfig, { wants, session, now }: { wants: Wants; session: Finished; now: string }): Promise<FinishedSession | undefined> {
  const mode = SessionCaptures.runModeOf(session.captures) ?? 'attended';
  const key = { platform: session.platform, sessionId: session.sessionId };
  const publish = wants.publishes(mode) && !((await SessionPublish.archivedAt(config, key) ?? -Infinity) >= session.activeAt);
  const scorers = wants.scores(mode) ? await unmarked(config, await wants.candidates(session), key, now) : [];

  return publish || scorers.length > 0 ? { session: session.sessionId, source: session.platform, publish, scorers, demand: wants.demand } : undefined;
}

/** The finished sessions of `config` that `request` asks for, at `now`. */
async function listIn(config: LocalConfig, request: Request, now: string): Promise<Listed> {
  const wants = await wantsOf(config, request);

  if ('ok' in wants) return wants;
  const wanted = (mode: RunMode) => wants.scores(mode) || wants.publishes(mode);
  const listed: FinishedSession[] = [];

  if (!RUN_MODES.some(wanted)) return { ok: true, list: listed };

  for (const session of await SessionWork.finished(await SessionCaptures.list(config), now, wanted, request.idleMs)) {
    const item = await itemOf(config, { wants, session, now });

    if (item) listed.push(item);
  }

  return { ok: true, list: listed };
}

/**
 * The scopes `cwd` reaches: its project scope, with its workspace children, whose namespaces set scoring too, then the
 * user scope, each data home once. A directory that no longer exists reaches the user scope only.
 */
async function reachedScopes(cwd: string): Promise<LocalConfig[]> {
  const detected = await pathExists(cwd) ? await detectProjectConfig(cwd).catch(() => null) : null;
  const project = detected && await readWorkspaceChildren(detected);
  // oxlint-disable-next-line teamai/config-load-options -- scoring scope discovery retains its existing migration policy and has no preview option
  const user = await loadLocalConfig();
  const homes = new Set<string>();
  const scopes: LocalConfig[] = [];

  for (const config of [project, user]) {
    if (config === null || homes.has(getDataHome(config))) continue;
    homes.add(getDataHome(config));
    scopes.push(config);
  }

  return scopes;
}

/**
 * Whether `config` judges or publishes its attended sessions automatically. Unattended ones are `auto` unless a policy
 * says otherwise, and a drain at the end of each unattended job takes them.
 */
async function worksOnAttended(config: LocalConfig): Promise<boolean> {
  const scoring = await scoringOf(config);

  if (scoring?.ok === false) log.warn(`[${config.scope}] Finished sessions are not judged here: ${scoring.reason}`);

  return (scoring?.ok === true && scoring.sessions.policies.attended.policy === 'auto')
    || SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies.attended.policy === 'auto';
}

/** The scopes `cwd` reaches that judge or publish attended sessions automatically, which the session-start hook works on. */
async function backgroundScopes(cwd: string): Promise<LocalConfig[]> {
  const scopes: LocalConfig[] = [];

  for (const config of await reachedScopes(cwd)) {
    if (await worksOnAttended(config)) scopes.push(config);
  }

  return scopes;
}

/** How long a run of it may work before a start takes the data home again: its own timeout, which ends it. */
const PASS_MS = 30 * 60 * 1000;

/**
 * Who has an open run: a driver that took it, none yet while it awaits the driver `workflows.driver` names, or none yet
 * while it is left to any driver.
 */
export type RunHolder = { kind: 'driven' } | { kind: 'awaits'; driver: DriverName } | { kind: 'unassigned' };

/**
 * What a start of teamai-finished-sessions did in a data home: started a run, found one already holding it, or found
 * nothing for a run to do. `cwd` is the directory a driver of the run works from.
 */
export type FinishedStart =
  | { kind: 'started'; run: RunId; cwd: string }
  | { kind: 'working'; run: RunId; cwd: string; holder: RunHolder }
  | { kind: 'idle' }
  | { kind: 'failed'; failure: WorkflowFailure };

/** When a running teamai-finished-sessions run stops holding the data home: its own deadline, else `PASS_MS` after it started. */
function holdsUntil(run: RunState): number {
  const deadline = runDeadline(run);

  return deadline === undefined ? Date.parse(run.createdAt) + PASS_MS : Date.parse(deadline);
}

/** The run of teamai-finished-sessions this data home started that has not ended and still holds it, and who has it. */
async function workingRun(config: LocalConfig, now: number): Promise<Pick<Extract<FinishedStart, { kind: 'working' }>, 'run' | 'holder'> | undefined> {
  const run = (await readRuns(config)).findLast((one) => one.name === FINISHED_WORKFLOW && one.status === 'running' && holdsUntil(one) > now);

  if (!run) return undefined;
  // A driver that only asked for the run's next step, and took no lease, is recorded on it as well: only a lease drives it.
  const isDriven = run.steps.some(wasLeased) || (run.archive ?? []).some((pass) => pass.attempt !== undefined);
  const holder: RunHolder = run.awaits ? { kind: 'awaits', driver: run.awaits.driver } : isDriven ? { kind: 'driven' } : { kind: 'unassigned' };

  return { run: RunIdSchema.parse(run.id), holder };
}

/**
 * Ends each run of teamai-finished-sessions in `config` that no longer holds the data home with nothing driving it, so
 * the marks it held lapse and a later run starts them again: through the engine's own deadline, or, for a team copy that
 * sets no timeout, by cancelling it.
 */
async function endExpired(config: LocalConfig, { client, cwd }: { client: Pick<WorkflowClient, 'next' | 'cancel'>; cwd: string }): Promise<void> {
  const now = Date.now();
  const expired = (await readRuns(config)).filter((run) => run.name === FINISHED_WORKFLOW && run.status === 'running' && holdsUntil(run) <= now);

  for (const run of expired) {
    const answer = runDeadline(run) === undefined
      ? await client.cancel(run.id)
      : await client.next(run.id, { driver: driverIdentity('local', cwd), canTakeLease: false });

    if ('error' in answer) log.warn(`Run ${run.id} of ${FINISHED_WORKFLOW} passed its timeout and could not be ended, so the sessions it was judging wait for the next start: ${answer.error.message}`);
  }
}

/**
 * Whether a run would find work in `config` whatever idle time its file sets: a session it would list once idle at all,
 * or a lapse. Nothing prunes ended runs, so a start that would find none starts none.
 */
async function hasWork(config: LocalConfig, now: string): Promise<boolean> {
  const listed = await listIn(config, { idleMs: 1, publish: 'policy', scorers: [] }, now);

  if (!listed.ok || listed.list.length > 0) return true;

  // Its marks would land inside the repository: reading them first writes the carried ones.
  return !scoringUnavailable(config) && (await ScoreSubjects.lapsed(config, now)).length > 0;
}

/**
 * Starts teamai-finished-sessions in `config` as the CLI's own start, with the session policies as its inputs and no
 * agent evidence, whatever process calls it, from the directory whose teamai resolves to this data home. A run that
 * already works on this data home is answered instead, so two passes never archive one session twice.
 */
async function start(config: LocalConfig, { client, mode, awaits }: { client: Pick<WorkflowClient, 'start' | 'next' | 'cancel'>; mode: RunMode; awaits?: RunState['awaits'] }): Promise<FinishedStart> {
  const cwd = SessionWork.scopeCwd(config);
  await endExpired(config, { client, cwd });
  const working = await workingRun(config, Date.now());

  if (working) return { kind: 'working', cwd, ...working };

  if (!await hasWork(config, new Date().toISOString())) return { kind: 'idle' };

  const answer = await startAsCli(client, FINISHED_WORKFLOW, { inputs: { publish: 'policy', scorers: [] }, checkout: cwd, mode, awaits });

  if ('error' in answer) return { kind: 'failed', failure: answer.error };
  const run = RunIdSchema.safeParse(answer.data.run);

  return run.success ? { kind: 'started', run: run.data, cwd } : { kind: 'failed', failure: { code: 'run_unreadable', message: `The new ${FINISHED_WORKFLOW} run id was missing` } };
}

export const FinishedSessions = { list, shareable, start, reachedScopes, backgroundScopes } as const;

/**
 * `teamai session list --finished`: the finished sessions of one data home that `teamai-finished-sessions` archives and
 * judges, each with whether to publish it and the scorers to judge it with. The session-start hook and `teamai score
 * --drain` start that workflow once for each scope a directory reaches, so every item runs in its session's data home.
 */
import { z } from 'zod';
import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from '../config.js';
import { ATTEMPT_ENV, RUN_MODES, type RunMode } from '../launch-context.js';
import { pinScorers } from '../scorers/cache.js';
import { scoringUnavailable } from '../scorers/home.js';
import { Marks, type Demand, type MarkKey } from '../scorers/marks.js';
import { pinnedDefinition } from '../scorers/pin.js';
import { markFacts } from '../scorers/score-plan.js';
import { scopeScoring } from '../scorers/settings.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { pathExists } from '../utils/fs.js';
import { readWorkspaceChildren } from '../workspace-children.js';
import { durationMs } from '../workflow/parse.js';
import { findRunConfig } from '../workflow/run-location.js';
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

export type Listed = { ok: true; list: FinishedSession[] } | { ok: false; code: string; message: string };

interface Request {
  idleMs: number;
  publish: (typeof PUBLISH)[number];
  scorers: string[];
}

function refused(code: string, message: string): Listed {
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

function requestOf(options: ListOptions): Request | Listed {
  const idleMs = durationMs(options.idle ?? '6h');

  if (idleMs === undefined) return refused('invalid_arguments', `--idle ${options.idle ?? ''} is not a duration. Pass a whole number of s, m or h, such as 6h.`);
  const publish = z.enum(PUBLISH).safeParse(options.publish ?? 'policy');

  if (!publish.success) return refused('invalid_arguments', `--publish ${options.publish ?? ''} is not one of ${PUBLISH.join(', ')}.`);
  const scorers = scorerNames(options.scorers ?? '[]');

  if (!scorers) return refused('invalid_arguments', `--scorers ${options.scorers ?? ''} is not a JSON array of scorer names, such as ["review-quality"].`);

  return { idleMs, publish: publish.data, scorers };
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

  if (!scope.ok) return scope;
  const { config } = scope;
  const scoring = scoringUnavailable(config) ? undefined : await scopeScoring(config);
  const publishing = SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies;
  const named = request.scorers.length > 0 ? await namedScorers(config, request.scorers) : undefined;

  if (named && 'ok' in named) return named;
  const sampling = scoring?.ok === true && !named ? await SessionWork.samplingScorers(config) : undefined;
  const scores = (mode: RunMode) => named !== undefined || (scoring?.ok === true && scoring.sessions.policies[mode].policy === 'auto');
  const publishes = (mode: RunMode) => request.publish === 'always' || (request.publish === 'policy' && publishing[mode].policy === 'auto');
  const wanted = (mode: RunMode) => scores(mode) || publishes(mode);
  const found: FinishedSession[] = [];

  if (!RUN_MODES.some(wanted)) return { ok: true, list: found };

  for (const session of await SessionWork.finished(await SessionCaptures.list(config), ctx.now, wanted, request.idleMs)) {
    const mode = SessionCaptures.runModeOf(session.captures) ?? 'attended';
    const key = { platform: session.platform, sessionId: session.sessionId };
    const publish = publishes(mode) && !((await SessionPublish.archivedAt(config, key) ?? -Infinity) >= session.activeAt);
    const candidates = !scores(mode) ? [] : named ?? await sampling?.(session) ?? [];
    const scorers = await unmarked(config, candidates, key, ctx.now);

    if (publish || scorers.length > 0) found.push({ session: session.sessionId, source: session.platform, publish, scorers, demand: named ? 'named' : 'auto' });
  }

  return { ok: true, list: found };
}

/**
 * The scopes `cwd` reaches: its project scope, with its workspace children, whose namespaces set scoring too, then the
 * user scope, each data home once. A directory that no longer exists reaches the user scope only.
 */
async function reachedScopes(cwd?: string): Promise<LocalConfig[]> {
  const detected = cwd === undefined || await pathExists(cwd) ? await detectProjectConfig(cwd).catch(() => null) : null;
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
  const scoring = scoringUnavailable(config) ? undefined : await scopeScoring(config);

  return (scoring?.ok === true && scoring.sessions.policies.attended.policy === 'auto')
    || SessionPolicy.publish(config, await loadTeamConfig(config.repo.localPath)).policies.attended.policy === 'auto';
}

/** The scopes `cwd` reaches that judge or publish attended sessions automatically, which the session-start hook works on. */
async function backgroundScopes(cwd?: string): Promise<LocalConfig[]> {
  const scopes: LocalConfig[] = [];

  for (const config of await reachedScopes(cwd)) {
    if (await worksOnAttended(config)) scopes.push(config);
  }

  return scopes;
}

export const FinishedSessions = { list, reachedScopes, backgroundScopes } as const;

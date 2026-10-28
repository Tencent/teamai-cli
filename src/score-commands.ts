import { autoDetectInit, loadLocalConfigForScope } from './config.js';
import { resolveRunMode } from './launch-context.js';
import { AttemptStore, isRunAttempt } from './scorers/attempts.js';
import { isScorerFile } from './scorers/definition.js';
import { parseLeaseRef } from './scorers/entry.js';
import { scoreSession, type OwnJudge, type SessionDemand } from './session-flow/scoring.js';
import type { LocalConfig } from './types.js';
import { LabelStore } from './scorers/label-store.js';
import { setStderrOnly } from './utils/logger.js';
import { findRunConfig, partitionConfig, projectPartitions } from './workflow/run-location.js';
import { nextJudgeLease, parseJudgeRequest, parseJudgeSubmission, runJudgeLease, scoreOnDemand, submitJudgeLease, type ScoreDemand } from './workflow/scoring.js';
import type { WorkflowEnvelope } from './workflow/types.js';

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
  queue?: boolean;
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

async function payloadOf(options: ScoreOptions): Promise<{ ok: true; value: unknown } | { ok: false; envelope: WorkflowEnvelope }> {
  if (options.json !== undefined && options.stdin) return { ok: false, envelope: failure('invalid_json', 'Pass the payload with --json or --stdin, not both') };
  const text = options.stdin ? await readStdin() : options.json;
  if (text === undefined || text.trim() === '') return { ok: false, envelope: failure('invalid_json', 'Pass the payload with --json <payload> or --stdin') };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, envelope: failure('invalid_json', 'Could not parse the payload as JSON') };
  }
}

/** The on-demand request `--run` asks for, or the failure that says what is missing. */
function demandOf(options: ScoreOptions): ScoreDemand | WorkflowEnvelope {
  if (options.next || options.lease !== undefined || options.json !== undefined || options.stdin) {
    return failure('invalid_arguments', '--run takes no --next, --lease or payload: teamai score --run <id> --step <path> [--pass <n>] --scorer <name> [--queue] [--batch]');
  }
  const [scorer, ...scorers] = options.scorer ?? [];
  const file = options.scorer?.find(isScorerFile);
  if (file !== undefined) return failure('invalid_arguments', `--run takes scorer names, not the file ${file}: a run pins its scorers when it starts`);
  if (options.run === undefined || options.step === undefined || scorer === undefined) {
    return failure('invalid_arguments', 'Pass --run <id> --step <path> --scorer <name> to judge a pass on demand; --pass <n> picks a pass, else the latest that succeeded');
  }
  const pass = options.pass === undefined ? undefined : Number(options.pass);
  if (pass !== undefined && (!/^\d+$/.test(options.pass ?? '') || !Number.isSafeInteger(pass) || pass < 1)) {
    return failure('invalid_pass', 'Pass --pass as a positive integer: the pass of the step to judge');
  }
  return {
    run: options.run, step: options.step, scorers: [scorer, ...scorers],
    ...(pass !== undefined ? { pass } : {}), ...(options.queue ? { queue: true } : {}), ...(options.batch ? { batch: true } : {}),
  };
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
  const named = options.teamSession !== undefined
    ? { teamSession: { name: options.teamSession, ...(options.author !== undefined ? { author: options.author } : {}) } }
    : { ...(options.session !== undefined ? { session: options.session } : {}), ...(options.source !== undefined ? { source: options.source } : {}) };
  return {
    scorers: [scorer, ...scorers],
    ...named,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.batch ? { batch: true } : {}), ...(options.push ? { push: true } : {}),
  };
}

async function localConfig(): Promise<{ ok: true; config: LocalConfig } | { ok: false; envelope: WorkflowEnvelope }> {
  try {
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

async function score(options: ScoreOptions): Promise<WorkflowEnvelope> {
  if (options.drain) return failure('invalid_arguments', '--drain goes alone and takes no payload: teamai score --drain');
  const asksForPass = options.run !== undefined || options.step !== undefined || options.pass !== undefined || options.queue;
  const namesSession = options.session !== undefined || options.source !== undefined || options.teamSession !== undefined || options.author !== undefined || options.label !== undefined;
  const asksForSession = namesSession || (!asksForPass && (options.scorer?.length || options.batch));
  if (asksForPass && namesSession) return failure('invalid_arguments', 'Pass --run to judge a workflow pass, or --session, --team-session or --label to score a session, not both');
  if (options.push && (asksForPass || options.next || options.lease !== undefined)) {
    return failure('invalid_arguments', '--push goes alone or with a session: teamai score --push, or teamai score [--session <id>] --scorer <name> --push');
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
      if (typeof request === 'string') return failure('invalid_json', request);
      if (request.run !== undefined || request.canTakeLease !== undefined) {
        return failure('invalid_json', 'A --session payload leases the session it names: leave out run and canTakeLease.');
      }
      ownJudge = { driver: request.driver, judge: request.judge, running: request.running };
    }
    const loaded = await localConfig();
    if (!loaded.ok) return loaded.envelope;
    return scoreSession(loaded.config, ownJudge ? { ...demand, ownJudge } : demand);
  }
  if (options.push) {
    if (options.json !== undefined || options.stdin) return failure('invalid_arguments', '--push takes no payload: teamai score --push');
    const loaded = await localConfig();
    return loaded.ok ? LabelStore.push(loaded.config) : loaded.envelope;
  }
  if (asksForPass) {
    const demand = demandOf(options);
    if (!('run' in demand)) return demand;
    const loaded = await localConfig();
    return loaded.ok ? scoreOnDemand(loaded.config, demand) : loaded.envelope;
  }
  if (options.next === (options.lease !== undefined)) {
    return failure('invalid_arguments', 'Pass --next to take judge work, --lease <ref> to judge it here, --lease <ref> --submit to settle it, --run <id> --step <path> --scorer <name> to judge a pass on demand, --scorer <name> [--session <id>] to judge a session, or --push to publish pending labels');
  }
  const payload = await payloadOf(options);
  if (!payload.ok) return payload.envelope;
  if (options.next) {
    const request = parseJudgeRequest(payload.value);
    if (typeof request === 'string') return failure('invalid_json', request);
    const scoped = request.run !== undefined ? await runConfig(request.run) : await localConfig();
    return scoped.ok ? nextJudgeLease(scoped.config, request) : scoped.envelope;
  }
  const loaded = await leaseConfig(options.lease ?? '');
  if (!loaded.ok) return loaded.envelope;
  const { config } = loaded;
  if (options.lease !== undefined && !options.submit) return runJudgeLease(config, options.lease, payload.value);
  const submission = parseJudgeSubmission(payload.value);
  if (typeof submission === 'string') return failure('invalid_json', submission);
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
  writeEnvelope(await score(options));
}

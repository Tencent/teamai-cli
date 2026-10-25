/**
 * The runner of one attempt: a detached `teamai workflow report <run> --driver skill --attempt <a>` that prepares the
 * attempt's place, runs its command outside the run lock, and reports it. It holds `runner.lock` for its whole life,
 * which is how a tick tells it is alive.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveCliEntry } from '../../../builtin-hooks.js';
import { stepEnvironment } from '../../../env-exec.js';
import type { LocalConfig } from '../../../types.js';
import { writeFileAtomic } from '../../../utils/fs.js';
import { redact } from '../../../utils/redact.js';
import { attemptEnv } from '../../attempt-marker.js';
import { commandOutputs } from '../../protocol.js';
import { attemptDir, runnerAlive, withRunnerLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import { runnerArgs } from './literals.js';
import { writeSkillState, readSkillState, type ReportBody, type SkillState } from './skill-state.js';
import { readJob, RUNNER_POLL_MS, sendReport, take, WAIT_BOUND_MS, type Job } from './tick.js';
import { openAttempt } from './transitions.js';
import type { Runners, SkillContext } from './skill-driver.js';
import type { SkillAnswer } from './turn.js';

/** Runners as detached teamai processes, alive while they hold their runner lock. */
export function detachedRunners(config: LocalConfig): Runners {
  return {
    spawn: async ({ run, attempt, checkout }) => {
      const entry = resolveCliEntry();
      if (!entry) throw new Error('The teamai entry script is unknown, so the runner of a workflow step cannot start. Reinstall teamai.');
      spawn(process.execPath, [entry, ...runnerArgs(run, attempt)], {
        cwd: checkout, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...attemptEnv(run, attempt) },
      }).unref();
    },
    alive: (run, attempt) => runnerAlive(config, run, attempt),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

type Stage =
  /** `env` is the environment the command starts from: the job's `envScope` applied, else this process's. */
  | { kind: 'run'; dir: string; job: Job; env: NodeJS.ProcessEnv }
  /** The engine refused the report; it stays stored, and the runner sends it again. */
  | { kind: 'retry' }
  /** Nothing is left for this runner: its attempt was reported, or is no longer open. */
  | { kind: 'gone'; status: 'reported' | 'gone' };

/** Runs attempt `attempt` of `run` to its report, unless another live runner of it holds its lock. */
export async function runRunner(context: SkillContext, run: RunId, attempt: AttemptId): Promise<SkillAnswer> {
  const result = await withRunnerLock(context.config, run, attempt, () => runAttempt(context, run, attempt));
  return result === 'held' ? { data: { runner: { attempt, status: 'held' } } } : result;
}

async function runAttempt(context: SkillContext, run: RunId, attempt: AttemptId): Promise<SkillAnswer> {
  for (;;) {
    const stage = await locked(context, run, (lock) => prepare(context, lock, attempt));
    if (stage.kind === 'gone') return { data: { runner: { attempt, status: stage.status } } };
    if (stage.kind === 'retry') {
      await context.runners.sleep(RUNNER_POLL_MS);
      continue;
    }
    const exited = await runCommand(context, run, attempt, stage);
    const sent = await locked(context, run, (lock) => report(context, lock, attempt, exited));
    if (sent.kind === 'gone') return { data: { runner: { attempt, status: sent.status } } };
    await context.runners.sleep(RUNNER_POLL_MS);
  }
}

/** Runs `body` under the run lock, waiting `RUNNER_POLL_MS` between tries while another process holds it. */
async function locked(context: SkillContext, run: RunId, body: (lock: RunLock) => Promise<Stage>): Promise<Stage> {
  for (;;) {
    const result = await context.locks.take(run, body, WAIT_BOUND_MS);
    if (!('error' in result)) return result;
    await context.runners.sleep(RUNNER_POLL_MS);
  }
}

async function readState(context: SkillContext, lock: RunLock): Promise<SkillState | undefined> {
  const read = await readSkillState(context.config, lock.run);
  if ('kind' in read) return undefined;
  return take(context, read, { kind: 'runner-call' })?.state ?? read;
}

/** Sends the report a row stored, and saves what the engine's answer left. */
async function send(context: SkillContext, lock: RunLock, state: SkillState, attempt: AttemptId, body: ReportBody): Promise<Stage> {
  const sent = await sendReport(context, lock, state, attempt, body);
  await writeSkillState(context.config, lock, sent.state, context.env.secrets);
  if (sent.refused) return { kind: 'retry' };
  return { kind: 'gone', status: sent.state.settled.includes(attempt) ? 'reported' : 'gone' };
}

function failedBody(state: SkillState, attempt: AttemptId, revision: number, failure: WorkflowFailure): ReportBody {
  return { attempt, revision, outcome: 'failed', driver: state.driver, message: failure.message, failure };
}

/** Under the lock: prepares the attempt's place and its env (C1, C7), or sends the report it already has. */
async function prepare(context: SkillContext, lock: RunLock, attempt: AttemptId): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);
  if (!state || !open) return { kind: 'gone', status: state?.settled.includes(attempt) ? 'reported' : 'gone' };
  if (open.phase === 'reporting') return send(context, lock, state, attempt, open.body);
  const failed = async (failure: WorkflowFailure): Promise<Stage> => {
    const body = failedBody(state, attempt, open.revision, failure);
    const reporting = take(context, state, { kind: 'prepare-failed', attempt, body });
    return reporting?.state ? send(context, lock, reporting.state, attempt, body) : { kind: 'gone', status: 'gone' };
  };
  const prepared = await context.client.prepare(lock, { attempt, executor: 'command' });
  if (prepared.kind === 'failed') return failed(prepared.failure);
  const job = await readJob(context.config, lock.run, attempt);
  if (!job) {
    return failed({ code: 'run_unreadable', message: `The command of attempt ${attempt} was not saved where its runner reads it, so the step did not run. Retry it with teamai workflow retry ${lock.run} ${open.step}.` });
  }
  const scoped = job.envScope ? await stepEnvironment(context.env.values, job.envScope) : { ok: true as const, env: process.env };
  if (!scoped.ok) return failed(scoped.failure);
  // A runner that restarts a command already running starts it again in the place it was prepared in.
  const running = open.phase === 'preparing' ? take(context, state, { kind: 'prepared', attempt })?.state ?? state : state;
  await writeSkillState(context.config, lock, running, context.env.secrets);
  return { kind: 'run', dir: prepared.dir, job, env: scoped.env };
}

interface Exited {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The masked output, as it came, stdout and stderr together. */
  output: string;
}

/** Runs the job's command in `dir`, outside the run lock, and keeps its masked output in `output.log`. */
async function runCommand(context: SkillContext, run: RunId, attempt: AttemptId, stage: Extract<Stage, { kind: 'run' }>): Promise<Exited> {
  const exited = await new Promise<Omit<Exited, 'output'> & { raw: string }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let raw = '';
    const child = spawn(stage.job.command, {
      shell: true, cwd: stage.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...stage.env, ...stage.job.env, ...attemptEnv(run, attempt) },
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; raw += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; raw += chunk; });
    child.on('error', (error) => resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}`, raw }));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr, raw }));
  });
  const output = redact(exited.raw, { envSecrets: context.env.secrets, patterns: false });
  await writeFileAtomic(path.join(attemptDir(context.config, run, attempt), 'output.log'), output);
  return { exitCode: exited.exitCode, stdout: exited.stdout, stderr: exited.stderr, output };
}

/** Under the lock: stores the report of the exited command (C8), then sends it. */
async function report(context: SkillContext, lock: RunLock, attempt: AttemptId, exited: Exited): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);
  if (!state || open?.phase !== 'running') return { kind: 'gone', status: 'gone' };
  const outputs = commandOutputs(exited.stdout);
  const snippet = exited.stderr.trim().slice(0, 400);
  const body: ReportBody = {
    attempt, revision: open.revision, outcome: exited.exitCode === 0 ? 'success' : 'failed', driver: state.driver, exitCode: exited.exitCode,
    ...(outputs !== undefined ? { outputs } : {}),
    ...(exited.exitCode !== 0 ? { message: snippet === '' ? `command exited with status ${exited.exitCode}` : `command exited with status ${exited.exitCode}: ${snippet}` } : {}),
  };
  const tail = exited.output.trim().slice(-400);
  const reporting = take(context, state, { kind: 'exited', attempt, body, ...(tail ? { tail } : {}) });
  return reporting?.state ? send(context, lock, reporting.state, attempt, body) : { kind: 'gone', status: 'gone' };
}

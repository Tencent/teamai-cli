/**
 * The runner of one attempt: a detached `teamai workflow report <run> --driver skill --attempt <a>` that prepares the
 * attempt's place and runs its setup outside the run lock, then runs its command and reports it, or offers its prompt
 * to the agent. It holds `runner.lock` for its whole life, which is how a tick tells it is alive.
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
import { pickChildModel } from './child-model.js';
import { writeChildBrief } from './child-brief.js';
import { reportLiteral } from './literals.js';
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
  /** The place is prepared; `prompt` is the step's prompt with what the place adds to it, a merge conflict to resolve. */
  | { kind: 'prepared'; dir: string; job: Job; prompt?: string }
  /** `env` is the environment the command runs with: the job's `envScope` applied, else this process's, and its own env. */
  | { kind: 'run'; dir: string; command: string; env: NodeJS.ProcessEnv }
  /** The engine refused the report; it stays stored, and the runner sends it again. */
  | { kind: 'retry' }
  /** Nothing is left for this runner: its attempt waits for a place, waits for the agent, or was reported or closed. */
  | { kind: 'gone'; status: 'reported' | 'offered' | 'queued' | 'gone' };

/** Runs attempt `attempt` of `run` to its report, unless another live runner of it holds its lock. */
export async function runRunner(context: SkillContext, run: RunId, attempt: AttemptId): Promise<SkillAnswer> {
  const result = await withRunnerLock(context.config, run, attempt, () => runAttempt(context, run, attempt));
  return result === 'held' ? { data: { runner: { attempt, status: 'held' } } } : result;
}

async function runAttempt(context: SkillContext, run: RunId, attempt: AttemptId): Promise<SkillAnswer> {
  for (;;) {
    const prepared = await locked(context, run, (lock) => prepare(context, lock, attempt));
    if (prepared.kind === 'gone') return { data: { runner: { attempt, status: prepared.status } } };
    if (prepared.kind === 'prepared') {
      const failure = await context.client.setup(run, attempt);
      const stage = await locked(context, run, (lock) => (failure ? setupFailed(context, lock, attempt, failure) : begin(context, lock, attempt, prepared)));
      if (stage.kind === 'gone') return { data: { runner: { attempt, status: stage.status } } };
      if (stage.kind === 'run') {
        const exited = await runCommand(context, run, attempt, stage);
        const sent = await locked(context, run, (lock) => report(context, lock, attempt, exited));
        if (sent.kind === 'gone') return { data: { runner: { attempt, status: sent.status } } };
      }
    }
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

/** Takes the row `failed` names for a failure before the step ran (C3, C7), and sends its report. */
async function fail(context: SkillContext, lock: RunLock, input: { state: SkillState; attempt: AttemptId; revision: number; failure: WorkflowFailure; kind: 'prepare-failed' | 'model-failed' }): Promise<Stage> {
  const { state, attempt, revision, failure, kind } = input;
  const body = failedBody(state, attempt, revision, failure);
  const reporting = take(context, state, { kind, attempt, body });
  return reporting?.state ? send(context, lock, reporting.state, attempt, body) : { kind: 'gone', status: 'gone' };
}

/** Under the lock: prepares the attempt's place (C4, C7), or sends the report it already has. */
async function prepare(context: SkillContext, lock: RunLock, attempt: AttemptId): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);
  if (!state || !open) return { kind: 'gone', status: state?.settled.includes(attempt) ? 'reported' : 'gone' };
  if (open.phase === 'reporting') return send(context, lock, state, attempt, open.body);
  if (open.phase !== 'preparing' && open.phase !== 'running') return { kind: 'gone', status: 'gone' };
  const failed = (failure: WorkflowFailure): Promise<Stage> => fail(context, lock, { state, attempt, revision: open.revision, failure, kind: 'prepare-failed' });
  const job = await readJob(context.config, lock.run, attempt);
  if (!job) {
    return failed({ code: 'run_unreadable', message: `The lease of attempt ${attempt} was not saved where its runner reads it, so the step did not run. Retry it with teamai workflow retry ${lock.run} ${open.step}.` });
  }
  const prepared = await context.client.prepare(lock, job.raw);
  if (prepared.kind === 'failed') return failed(prepared.failure);
  if (prepared.kind === 'busy') {
    const queued = take(context, state, { kind: 'place-busy', attempt, behind: prepared.behind });
    if (queued?.state) await writeSkillState(context.config, lock, queued.state, context.env.secrets);
    return { kind: 'gone', status: 'queued' };
  }
  return { kind: 'prepared', dir: prepared.dir, job, ...(prepared.prompt !== undefined ? { prompt: prepared.prompt } : {}) };
}

/** Under the lock: reports a setup that failed (C7). */
async function setupFailed(context: SkillContext, lock: RunLock, attempt: AttemptId, failure: WorkflowFailure): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);
  if (!state || (open?.phase !== 'preparing' && open?.phase !== 'running')) return { kind: 'gone', status: 'gone' };
  return fail(context, lock, { state, attempt, revision: open.revision, failure, kind: 'prepare-failed' });
}

/**
 * Under the lock, once the place is set up: a command gets its env (C1), and a prompt its child's model and brief,
 * which offer it to the agent (C2, C3).
 */
async function begin(context: SkillContext, lock: RunLock, attempt: AttemptId, prepared: Extract<Stage, { kind: 'prepared' }>): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);
  if (!state || (open?.phase !== 'preparing' && open?.phase !== 'running')) return { kind: 'gone', status: 'gone' };
  const { dir, job: { lease } } = prepared;
  const failed = (failure: WorkflowFailure, kind: 'prepare-failed' | 'model-failed'): Promise<Stage> => fail(context, lock, { state, attempt, revision: open.revision, failure, kind });
  if (lease.executor === 'command') {
    const scoped = lease.envScope ? await stepEnvironment(context.env.values, lease.envScope) : { ok: true as const, env: process.env };
    if (!scoped.ok) return failed(scoped.failure, 'prepare-failed');
    // A runner that restarts a command already running starts it again in the place it was prepared in.
    const running = open.phase === 'preparing' ? take(context, state, { kind: 'prepared', attempt })?.state ?? state : state;
    await writeSkillState(context.config, lock, running, context.env.secrets);
    return { kind: 'run', dir, command: lease.command, env: { ...scoped.env, ...lease.env } };
  }
  if (open.phase !== 'preparing') return { kind: 'gone', status: 'gone' };
  const { agent, model, defaultModel, output, place } = lease;
  const picked = await pickChildModel({
    config: context.config, step: open.step, tool: context.tool,
    ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}), ...(defaultModel !== undefined ? { defaultModel } : {}),
  });
  if (!picked.ok) return failed(picked.failure, 'model-failed');
  const brief = await writeChildBrief({
    config: context.config, run: lock.run, attempt, step: open.step, dir, prompt: prepared.prompt ?? lease.prompt,
    ...(output !== undefined ? { output } : {}), report: reportLiteral(state.invocation, lock.run, attempt), secrets: context.env.secrets,
  });
  const offered = take(context, state, { kind: 'offer', attempt, dispatch: { place, dir, brief, ...(agent !== undefined ? { agent } : {}), model: picked.model } });
  if (offered?.state) await writeSkillState(context.config, lock, offered.state, context.env.secrets);
  return { kind: 'gone', status: 'offered' };
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
    const child = spawn(stage.command, {
      shell: true, cwd: stage.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...stage.env, ...attemptEnv(run, attempt) },
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

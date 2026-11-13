/**
 * The runner of one attempt: a detached `teamai workflow report <run> --driver skill --attempt <a>` that prepares the
 * attempt's place and runs its setup outside the run lock, then runs its command and reports it, or offers its prompt
 * to the agent. It holds `runner.lock` for its whole life, which is how a tick tells it is alive. While its command
 * runs it checks the run as its driver, and it alone stops that command when the engine stopped the attempt.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveCliEntry } from '../../../builtin-hooks.js';
import { stepEnvironment, withRunningCli } from '../../../env-exec.js';
import { startGroupedCommand, stopRecordedGroup, type CommandExit } from '../../../tool-launch/process-stop.js';
import type { RunMode } from '../../../launch-context.js';
import type { LocalConfig } from '../../../types.js';
import { writeFileAtomic } from '../../../utils/fs.js';
import { redact } from '@teamai/shared/redact';
import { attemptEnv } from '../../attempt-marker.js';
import { runConfinedStep, type ConfinedStepEnd, type ConfinedStepLease } from '../../confined-step.js';
import { commandEnd, refuseDirtyAdoptedCommand, type WorkflowClient } from '../../protocol.js';
import { attemptDir, runnerAlive, withRunnerLock, type AttemptId, type RunId, type RunLock } from '../../store.js';
import type { WorkflowFailure } from '../../types.js';
import { HOST_PROFILES } from './host-profiles.js';
import { writeSkillState, readSkillState, type AttemptState, type Dispatch, type ReportBody, type SkillState } from './skill-state.js';
import { pickChildModel } from './child-model.js';
import { writeChildBrief } from './child-brief.js';
import { reportLiteral, runnerArgs } from './literals.js';
import { readJob, type Job } from './job.js';
import { applyEffects, RUNNER_POLL_MS, runTick, traced, WAIT_BOUND_MS } from './tick.js';
import {
  confinedEndedRow, exitedRow, offerRow, openAttempt, placeBusyRow, placingRow, preparedRow, prepareFailedRow, resendRow, runnerCallRow, runnerStopRow, type MovedWithEffects, type RowId,
} from './transitions.js';
import type { Runners, SkillContext } from './skill-driver.js';
import type { SkillAnswer } from './turn.js';

/** Runners as detached teamai processes, alive while they hold their runner lock. */
export function detachedRunners(config: LocalConfig): Runners {
  return {
    spawn: async ({ run, attempt, checkout, mode }) => {
      const entry = resolveCliEntry();

      if (!entry) throw new Error('The teamai entry script is unknown, so the runner of a workflow step cannot start. Reinstall teamai.');

      const child = spawn(process.execPath, [entry, ...runnerArgs(run, attempt)], {
        cwd: checkout, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true, env: { ...process.env, ...attemptEnv(config, run, attempt, mode) },
      });

      const failed = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => { child.once('spawn', () => resolve(undefined)).once('error', resolve); });

      if (failed) {
        // The node running this call exists, so the only path a spawn can miss is the directory it starts in.
        const cause = failed.code === 'ENOENT' ? 'it does not exist' : failed.message;
        throw new Error(`The runner of attempt ${attempt} cannot start in ${checkout}, the checkout run ${run} started from: ${cause}. Restore that checkout at that path, then run the same call again, or end the run with teamai workflow cancel ${run}.`);
      }

      child.unref();
    },
    alive: (run, attempt) => runnerAlive(config, run, attempt),
    // A process group of its own, so a stop reaches every process the command started.
    command: ({ run, attempt, command, cwd, env }) => startGroupedCommand({ command, cwd, env, detached: process.platform !== 'win32', group: attemptDir(config, run, attempt) }),
    stopLeft: (run, attempt) => stopRecordedGroup(attemptDir(config, run, attempt)),
    sleep: (ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
  };
}

type Stage =
  /**
   * The place is prepared; `prompt` is the step's prompt with what the place adds to it, a merge conflict to resolve.
   * `mode` is the run's, which its setup gets. `expiresAt` is the lease's deadline, when it has one.
   */
  | { kind: 'prepared'; dir: string; job: Job; mode: RunMode; prompt?: string; expiresAt?: string }
  /**
   * `env` is the environment the command runs with: the job's `envScope` applied, else this process's, and its own env.
   * `mode` is the run's. `expiresAt` is the lease's deadline, when it has one.
   */
  | { kind: 'run'; dir: string; command: string; env: NodeJS.ProcessEnv; mode: RunMode; expiresAt?: string }
  /** A step confined to a directory, which this runner runs on a confined tool. `expiresAt` is the lease's deadline. */
  | { kind: 'confined'; lease: ConfinedStepLease; expiresAt?: string }
  /** The engine refused the report; it stays stored, and the runner sends it again. */
  | { kind: 'retry' }
  /**
   * Nothing is left for this runner: its attempt waits for a place another attempt holds, waits for the agent to adopt
   * one or to start its child, or was reported or closed.
   */
  | { kind: 'gone'; status: 'reported' | 'offered' | 'queued' | 'placing' | 'gone' };

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
      const failure = await setUp(context, run, attempt, prepared);
      const stage = await locked(context, run, (lock) => (failure ? setupFailed(context, lock, attempt, failure) : begin(context, lock, attempt, prepared)));

      if (stage.kind === 'gone') return { data: { runner: { attempt, status: stage.status } } };

      if (stage.kind === 'run') {
        const refusal = await refuseDirtyAdoptedCommand({ config: context.config, run, attempt });

        if (refusal) {
          const sent = await locked(context, run, (lock) => setupFailed(context, lock, attempt, refusal, []));

          if (sent.kind === 'gone') return { data: { runner: { attempt, status: sent.status } } };
        } else {
          const exited = await runCommand(context, run, attempt, stage);
          const sent = await locked(context, run, (lock) => report(context, lock, attempt, exited));

          if (sent.kind === 'gone') return { data: { runner: { attempt, status: sent.status } } };
        }
      }

      if (stage.kind === 'confined') {
        const ended = await runConfinedHere(context, run, attempt, stage);
        const sent = await locked(context, run, (lock) => confinedReport(context, lock, attempt, ended));

        if (sent.kind === 'gone') return { data: { runner: { attempt, status: sent.status } } };
      }
    }

    await context.runners.sleep(RUNNER_POLL_MS);
  }
}

/** Runs `body` under the run lock, waiting `RUNNER_POLL_MS` between tries while another process holds it. */
async function locked<T>(context: SkillContext, run: RunId, body: (lock: RunLock) => Promise<T>): Promise<T> {
  for (;;) {
    const taken = await context.locks.take(run, body, WAIT_BOUND_MS);

    switch (taken.kind) {
      case 'held':
        return taken.value;
      case 'busy':
        break;
      default: {
        const unhandled: never = taken;

        return unhandled;
      }
    }

    await context.runners.sleep(RUNNER_POLL_MS);
  }
}

async function readState(context: SkillContext, lock: RunLock): Promise<SkillState | undefined> {
  const read = await readSkillState(context.config, lock.run);

  if (read.kind !== 'found') return undefined;
  traced(context, runnerCallRow());

  return read.state;
}

/** Applies the effects of `taken`, a row that stored the report of `attempt`, and saves what the engine's answer left. */
async function send(context: SkillContext, lock: RunLock, taken: MovedWithEffects<RowId> | undefined, attempt: AttemptId): Promise<Stage> {
  const moved = traced(context, taken);

  if (!moved) return { kind: 'gone', status: 'gone' };
  const sent = await applyEffects(context, lock, moved.state, moved.effects);
  await writeSkillState(context.config, lock, sent.state, context.env.secrets);

  if (sent.refused) return { kind: 'retry' };

  return { kind: 'gone', status: sent.state.settled.includes(attempt) ? 'reported' : 'gone' };
}

/** Gives up the attempt the engine stopped, once nothing of it runs (C9). */
function stopped(context: SkillContext, lock: RunLock, state: SkillState, attempt: AttemptId): Promise<Stage> {
  return send(context, lock, runnerStopRow(state, attempt), attempt);
}

function failedBody(state: SkillState, attempt: AttemptId, revision: number, failure: WorkflowFailure): ReportBody {
  return { attempt, revision, outcome: 'failed', driver: state.driver, message: failure.message, failure };
}

/** Takes the row of a failure before the step ran, of its place (C7) or its child's model (C3), and sends its report. */
async function fail(context: SkillContext, lock: RunLock, input: { state: SkillState; attempt: AttemptId; revision: number; failure: WorkflowFailure; cause: 'place' | 'model'; changed?: readonly string[] }): Promise<Stage> {
  const { state, attempt, revision, failure, cause, changed } = input;

  return send(context, lock, prepareFailedRow(state, { attempt, body: failedBody(state, attempt, revision, failure), cause, changed }), attempt);
}

/** Under the lock: prepares the attempt's place (C4 to C7), or sends the report it already has. */
async function prepare(context: SkillContext, lock: RunLock, attempt: AttemptId): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);

  if (!state || !open) return { kind: 'gone', status: state?.settled.includes(attempt) ? 'reported' : 'gone' };

  if (open.phase === 'reporting') return send(context, lock, resendRow(state, attempt), attempt);

  if (open.phase === 'stopping') return stopped(context, lock, state, attempt);

  if (open.phase !== 'preparing' && open.phase !== 'running') return { kind: 'gone', status: 'gone' };
  const failed = (failure: WorkflowFailure): Promise<Stage> => fail(context, lock, { state, attempt, revision: open.revision, failure, cause: 'place' });
  const job = await readJob(context.config, lock.run, attempt);

  if (!job) {
    return failed({ code: 'run_unreadable', message: `The lease of attempt ${attempt} was not saved where its runner reads it, so the step did not run. Retry it with teamai workflow retry ${lock.run} ${open.step}.` });
  }

  const placed = async (prepared: Awaited<ReturnType<WorkflowClient['prepare']>>): Promise<Stage> => {
    // Only a place the host made is refused, and prepareHostPlace answers that as a place to make.
    if (prepared.kind === 'failed' || prepared.kind === 'refused') return failed(prepared.failure);

    if (prepared.kind === 'busy') {
      const queued = traced(context, placeBusyRow(state, { attempt, behind: prepared.behind }));

      if (queued) await writeSkillState(context.config, lock, queued.state, context.env.secrets);

      return { kind: 'gone', status: 'queued' };
    }

    const stage: Stage = { kind: 'prepared', dir: prepared.dir, job, mode: state.options.mode };

    if (prepared.prompt !== undefined) stage.prompt = prepared.prompt;

    if (open.expiresAt !== undefined) stage.expiresAt = open.expiresAt;

    return stage;
  };

  if (open.phase !== 'preparing' || !open.request) return placed(await context.client.prepare(lock, job.raw));
  const hosted = await context.client.prepareHostPlace(lock, job.raw, open.request);

  if (hosted.kind !== 'needs-place') return placed(hosted);
  const { name, branch, start, refused } = hosted;
  const placing = traced(context, placingRow(state, open, { ask: { name, branch, start }, refused }));
  await writeSkillState(context.config, lock, placing.state, context.env.secrets);

  return { kind: 'gone', status: 'placing' };
}

/** Under the lock: reports a setup that failed (C7), or gives up an attempt stopped while it ran (C9). */
async function setupFailed(context: SkillContext, lock: RunLock, attempt: AttemptId, failure: WorkflowFailure, changed?: readonly string[]): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);

  if (state && open?.phase === 'stopping') return stopped(context, lock, state, attempt);

  if (!state || (open?.phase !== 'preparing' && open?.phase !== 'running')) return { kind: 'gone', status: 'gone' };

  return fail(context, lock, { state, attempt, revision: open.revision, failure, cause: 'place', changed });
}

/**
 * Under the lock, once the place is set up: a command gets its env (C1), and a prompt its child's model and brief,
 * which offer it to the agent (C2, C3). The run is checked first, since a cancel or a deadline that passed while setup
 * ran reached only the engine, and an attempt stopped meanwhile is given up before either starts (C9).
 */
async function begin(context: SkillContext, lock: RunLock, attempt: AttemptId, prepared: Extract<Stage, { kind: 'prepared' }>): Promise<Stage> {
  const state = await ticked(context, lock);
  const open = state && openAttempt(state, attempt);

  if (state && open?.phase === 'stopping') return stopped(context, lock, state, attempt);

  if (!state || (open?.phase !== 'preparing' && open?.phase !== 'running')) return { kind: 'gone', status: 'gone' };
  const { dir, job: { lease } } = prepared;
  // The step has not run. An empty list keeps a host file written after adopt out of the commit, and the failure stays the one that stopped the step.
  const failed = (failure: WorkflowFailure, cause: 'place' | 'model'): Promise<Stage> => fail(context, lock, { state, attempt, revision: open.revision, failure, cause, changed: [] });

  if (lease.executor === 'command') {
    const scoped = lease.envScope ? await stepEnvironment(context.env, lease.envScope) : { ok: true as const, env: withRunningCli(process.env) };

    if (!scoped.ok) return failed(scoped.failure, 'place');
    // A runner that restarts a command already running starts it again in the place it was prepared in.
    const running = open.phase === 'preparing' ? traced(context, preparedRow(state, { attempt, row: 'C1' }))?.state ?? state : state;
    await writeSkillState(context.config, lock, running, context.env.secrets);

    const stage: Stage = { kind: 'run', dir, command: lease.command, env: { ...scoped.env, ...lease.env }, mode: state.options.mode };

    if (open.expiresAt !== undefined) stage.expiresAt = open.expiresAt;

    return stage;
  }

  const { agent, model, defaultModel, output, place, writes, interactive, readOnly, isolation, confined } = lease;

  // D28 leased the step to this machine's confined tool, which runs it here, as the local driver does (C12).
  if (open.runs === 'here' && confined) {
    const running = open.phase === 'preparing' ? traced(context, preparedRow(state, { attempt, row: 'C12' }))?.state ?? state : state;
    await writeSkillState(context.config, lock, running, context.env.secrets);
    const stage: Stage = { kind: 'confined', lease: { ...lease, confined } };

    if (open.expiresAt !== undefined) stage.expiresAt = open.expiresAt;

    return stage;
  }

  if (open.phase !== 'preparing') return { kind: 'gone', status: 'gone' };

  const childTool = state.orchestrator.tool ?? context.tool;

  const picked = await pickChildModel({
    config: context.config, toolPaths: context.toolPaths, step: open.step, tool: childTool, agent, model, defaultModel,
  });

  if (!picked.ok) return failed(picked.failure, 'model');

  // A child of a confined step works in its directory, which holds everything it may read.
  const workDir = confined ? confined.dir : dir;

  const brief = await writeChildBrief({
    config: context.config, run: lock.run, attempt, step: open.step, dir: workDir, prompt: prepared.prompt ?? lease.prompt,
    changes: confined ? 'confined' : writes ? 'commit' : interactive && place === 'checkout' && !readOnly ? 'keep' : 'none',
    by: interactive ? 'person' : state.host.kind === 'chosen' && !HOST_PROFILES[state.host.id].startsChildAgent ? 'self' : 'child',
    output, report: reportLiteral(state.invocation, lock.run, attempt), secrets: context.env.secrets,
  });

  const dispatch: Dispatch = { place, dir: workDir, brief, model: picked.model };

  if (confined) dispatch.confined = true;

  if (confined && childTool !== undefined) dispatch.tool = childTool;

  if (interactive) dispatch.person = true;

  if (isolation) dispatch.isolation = isolation;

  if (agent !== undefined) dispatch.agent = agent;
  const offered = traced(context, offerRow(state, { attempt, dispatch }));

  if (offered) await writeSkillState(context.config, lock, offered.state, context.env.secrets);

  return { kind: 'gone', status: 'offered' };
}

/** How long a runner waits for its next check: `RUNNER_POLL_MS`, or less, so one check falls on `expiresAt`. */
function checkIn(context: SkillContext, expiresAt: string | undefined): number {
  const left = expiresAt === undefined ? RUNNER_POLL_MS : Date.parse(expiresAt) - context.now().getTime();

  return left > 0 ? Math.min(left, RUNNER_POLL_MS) : RUNNER_POLL_MS;
}

/**
 * Under the lock: a tick of the run as its driver, which takes no lease (D1), so the runner learns what the engine
 * cancelled while no agent calls. The state it saved.
 */
async function ticked(context: SkillContext, lock: RunLock): Promise<SkillState | undefined> {
  const state = await readState(context, lock);

  if (!state) return undefined;
  const after = (await runTick(context, lock, state, 'runner')).state;
  await writeSkillState(context.config, lock, after, context.env.secrets);

  return after;
}

/** Under the lock: whether the attempt is still in one of `phases`, once the run is ticked. */
async function check(context: SkillContext, lock: RunLock, attempt: AttemptId, phases: readonly AttemptState['phase'][]): Promise<{ open: boolean }> {
  const state = await ticked(context, lock);
  const phase = state && openAttempt(state, attempt)?.phase;

  return { open: phase !== undefined && phases.includes(phase) };
}

/**
 * Waits for `work`, which runs outside the run lock, checking the run every `RUNNER_POLL_MS` and at `expiresAt`, since
 * a cancel or a deadline reaches only the engine. Undefined once a check finds the attempt out of `phases`: stopped.
 */
async function whileOpen<T>(context: SkillContext, run: RunId, attempt: AttemptId, input: { work: Promise<T>; phases: readonly AttemptState['phase'][]; expiresAt?: string }): Promise<T | undefined> {
  for (;;) {
    const checking = new AbortController();
    const ended = await Promise.race([input.work.then((value) => ({ value })), context.runners.sleep(checkIn(context, input.expiresAt), checking.signal).then(() => undefined)]);
    checking.abort();

    if (ended) return ended.value;

    if (!(await locked(context, run, (lock) => check(context, lock, attempt, input.phases))).open) return undefined;
  }
}

/**
 * Runs the setup of the attempt's place until it ends, or a check finds the attempt stopped, which stops it and waits
 * for it to end. A runner that restarts a command already running finds its attempt `running` while setup does nothing.
 */
async function setUp(context: SkillContext, run: RunId, attempt: AttemptId, prepared: Extract<Stage, { kind: 'prepared' }>): Promise<WorkflowFailure | undefined> {
  const stop = new AbortController();
  const setup = context.client.setup(run, attempt, prepared.mode, stop.signal);
  const ended = await whileOpen(context, run, attempt, { work: setup.then((failure) => ({ failure })), phases: ['preparing', 'running'], expiresAt: prepared.expiresAt });

  if (ended) return ended.failure;
  stop.abort();

  return setup;
}

/**
 * Runs the job's command in `dir`, outside the run lock, until it exits or a check finds its attempt stopped, which
 * stops it. Keeps its masked output in `output.log`, and answers with that masked `output`.
 */
async function runCommand(context: SkillContext, run: RunId, attempt: AttemptId, stage: Extract<Stage, { kind: 'run' }>): Promise<CommandExit> {
  const command = context.runners.command({ run, attempt, command: stage.command, cwd: stage.dir, env: { ...stage.env, ...attemptEnv(context.config, run, attempt, stage.mode) } });
  const exited = (await whileOpen(context, run, attempt, { work: command.exit, phases: ['running'], expiresAt: stage.expiresAt })) ?? (await command.stop());
  const output = redact(exited.output, { envSecrets: context.env.secrets, patterns: false });
  await writeFileAtomic(path.join(attemptDir(context.config, run, attempt), 'output.log'), output);

  return { exitCode: exited.exitCode, stdout: exited.stdout, stderr: exited.stderr, output };
}

/**
 * Runs the confined step of `stage` outside the run lock until it ends, or a check finds its attempt stopped, which
 * stops its tool and waits for it to end.
 */
async function runConfinedHere(context: SkillContext, run: RunId, attempt: AttemptId, stage: Extract<Stage, { kind: 'confined' }>): Promise<ConfinedStepEnd> {
  const stop = new AbortController();
  const work = runConfinedStep({ config: context.config, run, lease: stage.lease, signal: stop.signal, secrets: context.env.secrets });
  const ended = await whileOpen(context, run, attempt, { work, phases: ['running'], expiresAt: stage.expiresAt });

  if (ended) return ended;
  stop.abort();

  return work;
}

/** Under the lock: stores the report of the confined run (C13), or gives up a stopped attempt (C9), then sends it. */
async function confinedReport(context: SkillContext, lock: RunLock, attempt: AttemptId, ended: ConfinedStepEnd): Promise<Stage> {
  const state = await readState(context, lock);

  if (!state) return { kind: 'gone', status: 'gone' };

  if (openAttempt(state, attempt)?.phase === 'stopping') return stopped(context, lock, state, attempt);

  return send(context, lock, confinedEndedRow(state, { attempt, ended }), attempt);
}

/** Under the lock: stores the report of the exited command (C8), or gives up a stopped attempt (C9), then sends it. */
async function report(context: SkillContext, lock: RunLock, attempt: AttemptId, exited: CommandExit): Promise<Stage> {
  const state = await readState(context, lock);
  const open = state && openAttempt(state, attempt);

  if (state && open?.phase === 'stopping') return stopped(context, lock, state, attempt);

  if (!state || open?.phase !== 'running') return { kind: 'gone', status: 'gone' };
  const body: ReportBody = { attempt, revision: open.revision, driver: state.driver, ...commandEnd(exited) };
  const tail = exited.output.trim().slice(-400);

  return send(context, lock, exitedRow(state, { attempt, body, tail }), attempt);
}

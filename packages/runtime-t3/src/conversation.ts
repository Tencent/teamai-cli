import fs from 'node:fs';
import path from 'node:path';
import {
  CANCEL_FAILED, PromptResultSchema, RUN_DIR_ENV, WORKFLOW_DIR_ENV,
  type ConfinedPrompt, type OpId, type OpState, type PromptLease, type PromptResult, type RuntimeDisplay, type RuntimeFailure, type RuntimeRequest,
} from '@teamai/runtime-protocol';
import type { OpEnd } from '@teamai/runtime-kit/ledger';
import { WRAPPER_PREFIX } from '@teamai/runtime-kit/outer';
import { NotRegularFileError, readRegularFileSync } from '@teamai/shared/regular-file';
import { stepUsage, UNTIMED_TURN, type StepUsage } from '@teamai/tool-core/step-usage';
import type { InstanceAdder } from './instances.js';
import { cannotReadBecause, FsFailureSchema, isMissing } from '@teamai/shared/fs-failure';
import { unreadableFailure, type LaunchRecord, type OpRecord, type PlaceRecord, type ThreadRecord } from './journal.js';
import { JUDGE_KEPT, JudgeCopyFailed, JudgeReleased, judged, launchJudge } from './judge.js';
import type { Reach, Reached, Serving, Session } from './runtime.js';
import { driverOf, isDefaultToolHome, sessionSince, DRIVERS } from './sessions.js';
import { instanceToolHome, projectSettings, readSettings, type ModelSelection, type T3RuntimeMode } from './settings.js';
import { driverOfProvider } from './tool-instances.js';
import { T3Error, USAGE_LIMIT_TITLE, type Environment, type Launch, type ListedThread, type NewThread, type StepMode, type Provider, type T3, type ThreadShell, type Waited, isActive } from './t3.js';
import { sleep, within } from './within.js';

// ─── A step's conversation ───
//
//  Each prompt runs as a T3 thread: launched once, journaled before T3 answers, followed until its work settles, and
//  stopped by a cancel or a close. The thread stays the runtime's to stop until it saw that thread stop.
//

/** The option names an effort maps to in T3's model options, by provider. */
const EFFORT_OPTIONS = new Set(['effort', 'reasoningEffort', 'reasoning_effort', 'variant']);

/**
 * How long one `t3_thread_wait` holds; the runtime asks again until the run settles. A wait holds through a run that
 * waits for an approval, so an unattended run asks more often, to fail such a step soon after nobody can answer it.
 */
const WAIT_MS = { attended: 25_000, unattended: 5_000 } as const;

/**
 * How long a stop gets, from the moment the runtime reads the cancel, before it counts as not confirmed: a launch still
 * pending, the connection, looking a launch up, and T3's answer to the stop all count. T3 acknowledges a stop before the
 * run ends, and teamai ends a live prompt it cancelled lost when no outcome comes within 15 s.
 */
export const STOP_WAIT_MS = 10_000;

/** How often an interactive step's thread is checked once it is idle without a result: the person may still be in it. */
const IDLE_POLL_MS = 2_000;

/** How often a turn sent to a thread whose earlier run had ended is checked until T3 shows the turn's own run. */
const TURN_POLL_MS = 250;

export const TERMINAL: ReadonlySet<string> = new Set<Waited['status']>(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

/**
 * How the thread's work ended, once its run and the work the run delegated both settled: as the run that answered last,
 * or idle for a thread with no run. Undefined while either still goes, even when the run itself ended.
 */
function settledStatus(waited: Waited): Waited['status'] | undefined {
  if (waited.timedOut || (waited.status !== 'idle' && !TERMINAL.has(waited.status))) return undefined;

  return waited.resultRun?.status ?? waited.status;
}

/** The threads among `listed` of the tasks `threadId` delegated, at any depth: each names the thread that delegated it. */
export function tasksOf(listed: ListedThread[], threadId: string): ListedThread[] {
  const tasks = new Set([threadId]);

  // Delegated tasks start after the thread that delegated them, so a pass per depth finds each one.
  for (let grew = true; grew;) {
    grew = false;

    for (const one of listed) {
      if (one.parentThreadId && tasks.has(one.parentThreadId) && !tasks.has(one.threadId)) {
        tasks.add(one.threadId);
        grew = true;
      }
    }
  }

  return listed.filter((one) => one.threadId !== threadId && tasks.has(one.threadId));
}

/**
 * Whether the thread, or a task it delegated at any depth, holds a request for a person. T3 holds a delegated task's
 * approval on the task's own thread, while the thread that delegated it runs on, waiting for the task.
 */
async function asksForApproval(t3: T3, threadId: string): Promise<{ by: 'thread' | 'task' } | undefined> {
  if ((await t3.thread(threadId)).pendingRequestCount > 0) return { by: 'thread' };

  for (const task of tasksOf(await t3.activeThreads(), threadId)) {
    if (task.status === 'waiting' || (await t3.thread(task.threadId)).pendingRequestCount > 0) return { by: 'task' };
  }

  return undefined;
}

/**
 * An op whose end this process owns, a prompt it follows or a cancel it retries: its place, its thread once launched, the
 * cancel's deadline, and a stop under way.
 */
export interface Running {
  /** The place's handle and run, where the op's end is journaled and what a failed stop names. */
  handle: string;
  run: string;
  /** The thread's title, which a cancel that ends before T3 answered the launch names. */
  title: string;
  /** When teamai cancelled the op: the time, in ms since the epoch, by which the cancel ends. */
  cancelBy?: number;
  /** While the prompt has launched and sent nothing, and asks T3 only what it needs first: a cancel ends it at once. */
  preparing?: boolean;
  thread?: ThreadRecord;
  /** Answers why T3 did not stop the thread, or nothing once it stopped; the stop, not the follow, ends the op then. */
  stopping?: Promise<string | undefined>;
}

export type PromptRequest = Extract<RuntimeRequest, { type: 'prompt' }>;

/** What a prompt runs: a step on its attempt's worktree, or a judge confined to its directory. */
type Work = { kind: 'step'; place: PlaceRecord & { kind: 'worktree' } } | { kind: 'judge'; confined: ConfinedPrompt };

/** What `request` runs in `opened`: teamai opens a confined prompt's place with no view, and sends it nothing else. */
function workOf(request: PromptRequest, opened: PlaceRecord): Work | undefined {
  if (opened.kind === 'worktree') return request.confined ? undefined : { kind: 'step', place: opened };

  return request.confined ? { kind: 'judge', confined: request.confined } : undefined;
}

/**
 * The model selection `lease` asks of `provider`: its model, or the first T3 lists, and the effort as T3 names it. A
 * lease that names no model on the instance of the member's default asks for none, so T3 applies that default, its
 * options, and the member's fallback once its usage is spent.
 */
function modelSelection({ provider, lease, defaultModel, appliedByT3 }: {
  provider: Provider; lease: PromptLease; defaultModel: ModelSelection | undefined;
  /** Whether T3 applies `defaultModel` to a launch that names no model: not on a project teamai added for the checkout's. */
  appliedByT3: boolean;
}): { ok: true; selection: Launch['modelSelection'] } | { ok: false; failure: RuntimeFailure } {
  if (!lease.model && defaultModel?.instanceId === provider.providerInstanceId) return { ok: true, selection: appliedByT3 ? undefined : defaultModel };
  const name = lease.model?.name ?? provider.models[0]?.id;
  const model = provider.models.find((candidate) => candidate.id === name);
  const where = `T3 Code provider instance "${provider.providerInstanceId}" (${provider.displayName})`;

  if (!name || !model) return { ok: false, failure: { code: 'model_unavailable', message: `${where} has no model ${name ?? 'at all'}. Its models: ${provider.models.map((one) => one.id).join(', ') || 'none'}.` } };
  const effort = lease.model?.effort;

  if (effort === undefined) return { ok: true, selection: { instanceId: provider.providerInstanceId, model: model.id } };
  const option = model.options?.find((candidate) => EFFORT_OPTIONS.has(candidate.id) && candidate.values.includes(effort));

  if (!option) return { ok: false, failure: { code: 'model_unavailable', message: `${where} runs ${model.id} with no effort "${effort}".` } };

  return { ok: true, selection: { instanceId: provider.providerInstanceId, model: model.id, options: [{ id: option.id, value: effort }] } };
}

/** Whether two launches name the same model selection: the same model and options, or both the member's default. */
function sameSelection(left: Launch['modelSelection'], right: Launch['modelSelection']): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Where a step's thread is bound in its place: the attempt's worktree of the project, or the project's own folder. */
function workspaceOf(place: PlaceRecord & { kind: 'worktree' }, worktreePath: string): Launch['workspace'] {
  return place.binding === 'root' ? { type: 'root' } : { type: 'existing_worktree', worktreePath };
}

/**
 * The link that opens a thread in T3 Code's desktop app, from a browser, a terminal or `open`. T3 answers a launch
 * with its web UI's link instead.
 */
export function threadLink(environment: Environment, threadId: string): string {
  return `t3code://threads/${environment.environmentId}/${encodeURIComponent(threadId)}`;
}

/** A thread as T3's own chat links it: a message in a T3 thread shows this as a link to that thread. */
function threadMention(environment: Environment, threadId: string): string {
  return `<t3-thread://v2/${environment.environmentId}/${threadId}>`;
}

/** What the run's details show of a thread: its title, its link, its id and model. */
export function threadDisplay(thread: ThreadRecord, environment: Environment): RuntimeDisplay {
  return { label: thread.title.slice(0, 80), url: threadLink(environment, thread.threadId), fields: { thread: thread.threadId.slice(0, 200), model: thread.model, environment: environment.label } };
}

/**
 * The paths of `env` a prompt may name that a thread's shell lacks: T3 runs its tool in T3 Code's environment, so the
 * message carries them. They are this machine's, which holds because options take only `environment: local`.
 */
function pathsOf(env: Readonly<Record<string, string>>): string {
  const scratch = env[RUN_DIR_ENV];
  const folder = env[WORKFLOW_DIR_ENV];

  if (scratch === undefined) return folder === undefined ? '' : ` Its shell has no ${WORKFLOW_DIR_ENV}: the workflow's folder is ${folder}.`;

  return folder === undefined
    ? ` Its shell has no ${RUN_DIR_ENV}: the run's scratch directory is ${scratch}.`
    : ` Its shell has no ${RUN_DIR_ENV} or ${WORKFLOW_DIR_ENV}: the run's scratch directory is ${scratch}, and the workflow's folder ${folder}.`;
}

/** The thread's first message: which run and step it is, where the run started, the paths its shell lacks, then teamai's prompt. */
function firstMessage(place: PlaceRecord, { lease, env }: Pick<PromptRequest, 'lease' | 'env'>, startedFrom: string | undefined): string {
  const origin = startedFrom ? ` It was started from the T3 thread ${startedFrom}.` : '';

  const interactive = lease.interactive
    ? '\n\nThis step is interactive: work through it with the person in this thread. Write the result file only once they say the step is done.'
    : '';

  return `This thread runs step "${lease.step}" of teamai workflow run ${place.run} (attempt ${place.attempt}).${origin}${pathsOf(env)}`
    + ` Work only in this worktree. Do not run teamai workflow commands: teamai commits, pushes and reports the step itself.${interactive}\n\n${lease.prompt}`;
}

/** The result the agent wrote, or why it does not count. */
function readResult(file: string): { ok: true; result: PromptResult } | { ok: false; why: string } {
  let text: string;

  try {
    text = readRegularFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof NotRegularFileError) return { ok: false, why: `left ${error.kind} at the result file ${file}, not a regular file, so teamai did not read it` };
    const parsed = FsFailureSchema.safeParse(error);

    if (!parsed.success) throw error;
    const failure = parsed.data;

    if (isMissing(failure)) return { ok: false, why: `ended without writing the result file ${file}` };

    return { ok: false, why: `wrote the result file ${file}, which teamai cannot read because ${cannotReadBecause(failure)}. Let the user teamai runs as read ${file}, then retry the step` };
  }

  try {
    const parsed = PromptResultSchema.safeParse(JSON.parse(text));

    return parsed.success ? { ok: true, result: parsed.data } : { ok: false, why: `wrote a result file that is not a workflow result ${file}` };
  } catch {
    return { ok: false, why: `wrote a result file that is not JSON ${file}` };
  }
}

/** `conversation` with its thread ended: the runtime saw it stop. */
export function endedIn(conversation: OpRecord): OpRecord {
  const { thread } = conversation;

  return thread && !thread.ended ? { ...conversation, thread: { ...thread, ended: {} } } : conversation;
}

/**
 * Stops a step's thread as its Stop button does, and waits until `deadline` for its run, and the work it delegated, to
 * settle. Answers why it did not stop, logged, while the thread may still run.
 */
export async function whyNotStopped(t3: T3, thread: Pick<ThreadRecord, 'threadId' | 'turnOf'>, deadline: number): Promise<string | undefined> {
  const { threadId } = thread;
  let why: string;

  try {
    // A turn has stopped only once T3 showed its own run and that run ended: right after the send, T3 may still show
    // the earlier run, ended, which is no stop of the turn.
    if (thread.turnOf) {
      const { runsBefore } = thread.turnOf;

      for (;;) {
        const shell = await within(t3.thread(threadId), Math.max(deadline - Date.now(), 0));

        if (shell.answered && shell.value.runCount > runsBefore) break;

        if (Date.now() + TURN_POLL_MS >= deadline) {
          why = `T3 Code showed no run of the turn teamai sent within ${STOP_WAIT_MS / 1_000} s, so teamai could not stop it`;
          process.stderr.write(`Could not stop ${threadId}: ${why}\n`);

          return why;
        }

        await sleep(TURN_POLL_MS);
      }
    }

    const stopped = await within(t3.stop(threadId), Math.max(deadline - Date.now(), 0));

    if (stopped.answered) {
      // T3 answers the stop before the run ends, and stops the delegated work apart, so the thread has stopped only
      // once both settled. T3 answers a thread with nothing left to settle at once; a wait that runs out answers a
      // second before the deadline, so its answer still comes in time.
      const left = Math.max(deadline - Date.now(), 0);
      const waited = await within(t3.wait(threadId, Math.max(left - 1_000, 0)), left);

      if (waited.answered && settledStatus(waited.value) !== undefined) return undefined;

      why = !waited.answered
        ? `T3 Code did not answer whether its run ended within ${STOP_WAIT_MS / 1_000} s`
        : TERMINAL.has(waited.value.status)
        ? `T3 Code stopped its run, but the work it delegated had not settled ${STOP_WAIT_MS / 1_000} s later`
        : `T3 Code acknowledged the stop, but its run was still ${waited.value.status} ${STOP_WAIT_MS / 1_000} s later`;
    } else {
      why = `T3 Code did not answer the stop within ${STOP_WAIT_MS / 1_000} s`;
    }
  } catch (error) {
    if (error instanceof T3Error && error.threadGone) return undefined;
    why = error instanceof Error ? error.message : String(error);
  }

  process.stderr.write(`Could not stop ${threadId}: ${why}\n`);

  return why;
}

/** That a thread still runs after T3 Code did not stop it, and what the person does about it. */
export function stillRuns(s: Reached, thread: ThreadRecord, why: string): string {
  return `The T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}") still runs, and T3 Code did not stop it: ${why.replace(/\.$/, '')}. Stop it in T3 Code with its Stop button`;
}

/** A stop the runtime could not confirm: the op's thread may still run, until a later cancel stops it. */
function unconfirmed(op: OpId, message: string): OpEnd {
  return { op, state: 'failed', failure: { code: CANCEL_FAILED, message } };
}

/** The T3 provider instance `thread` runs on: the one its launch named, else the one the session picked for its tool. */
function instanceIdOf(s: Session, thread: ThreadRecord): string | undefined {
  return thread.instanceId ?? s.instances.get(thread.tool)?.providerInstanceId;
}

/**
 * What a failed run of `thread` says of the usage limit it stopped on: the tool, its instance and T3's own message,
 * which carries the reset time when the provider gave one. Undefined for any other failure, or when T3 does not say.
 */
async function usageLimitOf(s: Session, thread: ThreadRecord, runId: string | undefined): Promise<string | undefined> {
  const error = await s.t3.lastError(thread.threadId, runId).catch(() => undefined);

  if (error?.title !== USAGE_LIMIT_TITLE) return undefined;

  const instanceId = instanceIdOf(s, thread);
  const instance = [...s.instances.values()].find((one) => one.providerInstanceId === instanceId);
  const reset = error.text.trim() || 'T3 Code gave no reset time';

  if (!instance) return `${thread.tool} reached its usage limit in T3 Code: ${reset}`;

  return `${thread.tool} reached its usage limit on T3 Code provider instance "${instance.providerInstanceId}" (${instance.displayName}): ${reset}`;
}

/** The prompts and cancels of a runtime process, which owns a prompt's end while it runs it. */
export function conversations({ serving, adder }: { serving: Serving; adder: InstanceAdder }) {
  const { options, journal, ledger, places, write, notice, fail } = serving;

  let saidFullAccess = false;

  /** The mode a thread inherits from the member's T3 default: theirs, or auto; never full access, which it says once. */
  const inheritedMode = (mode: T3RuntimeMode | undefined, about: { op: OpId; handle: string }): StepMode => {
    if (mode !== 'full-access') return mode ?? 'auto';

    if (!saidFullAccess) notice('T3\'s default mode is Full access; teamai starts its threads in Auto unless runtime_mode says full-access.', about);
    saidFullAccess = true;

    return 'auto';
  };

  /** The mode a thread of `work` starts in: `runtime_mode`, else the member's default; a judge never in full access. */
  const launchMode = (work: Work, mode: T3RuntimeMode | undefined, about: { op: OpId; handle: string }): StepMode => {
    const set = serving.session()?.runtimeMode;

    if (set === 'full-access' && work.kind === 'judge') return 'auto';

    return set ?? inheritedMode(mode, about);
  };

  /**
   * Journals `change` to `op`'s record in the place `handle`, once the place's records can be read; in `opened`, written
   * again first, when its record is missing.
   */
  const journalOp = async ({ handle, op, opened }: { handle: string; op: string; opened?: PlaceRecord }, change: (conversation: OpRecord | undefined) => OpRecord | undefined): Promise<void> => {
    const known = journal.read(handle);

    if (known.kind === 'unreadable' || (known.kind === 'missing' && !opened)) return;

    if (known.kind === 'missing' && opened) journal.open(opened);
    await journal.update({ handle, op }, change);
  };

  /**
   * Journals how an op ended, and, when the runtime saw it stop, that its thread ended, in one write. A place whose
   * records cannot be read is never written over: that throws, so the ledger keeps the end in memory and says so.
   */
  const record = async (handle: string, state: OpState, { threadEnded }: { threadEnded: boolean }): Promise<void> => {
    const known = journal.read(handle);

    if (known.kind === 'unreadable') throw new Error(`${known.file} cannot be read: ${known.why.replace(/\.$/, '')}`);
    await journalOp({ handle, op: state.op }, (conversation) => {
      const withOp: OpRecord = { ...conversation, state };

      return threadEnded ? endedIn(withOp) : withOp;
    });
  };

  /**
   * What a lost launch answers once the member signed in again: T3 finds a launch only under the sign-in that sent it,
   * so nothing here can find or stop its thread, and the place stays until the person did.
   */
  const launchUnconfirmed = (known: PlaceRecord, launch: LaunchRecord): RuntimeFailure => {
    const where = known.kind === 'worktree' ? `in the T3 project "${known.projectTitle}"` : 'under No project in T3 Code';

    return {
      code: 'launch_unconfirmed',
      message: `teamai launched the T3 thread "${launch.title}" ${where} under an earlier T3 Code sign-in, and T3 Code never answered, so it may still run. T3 Code finds that launch only under the sign-in that sent it, so teamai cannot find or stop it. In T3 Code, stop "${launch.title}" with its Stop button if it runs, then delete ${journal.file(known.handle)} and run teamai workflow cancel ${known.run} again.`,
    };
  };

  /** The terminal event of an operation that ended; a running one has none yet. */
  const answerEnded = (op: OpId, state: OpState): void => {
    if (state.state !== 'running') ledger.end(state);
  };

  /**
   * Ends a prompt this process runs, once: a later end, such as a follow that saw the run end after a stop ended the
   * prompt, writes nothing. An end the journal cannot keep is still answered, since nothing would answer it later.
   */
  const endRunning = (state: Running, ended: OpEnd, { threadEnded }: { threadEnded: boolean }): Promise<void> =>
    ledger.finish({ op: ended.op, run: state, ended, keep: () => record(state.handle, ended, { threadEnded }) });

  /**
   * Stops the thread of a prompt this process runs, and answers why it did not stop. A stop ends the prompt cancelled. A
   * cancel T3 did not carry out ends it cancel_failed, while its thread may still run; a close leaves it followed.
   */
  const stopRunning = async ({ s, state, op, thread, cancelling, deadline }: { s: Reached; state: Running; op: OpId; thread: ThreadRecord; cancelling: boolean; deadline: number }): Promise<string | undefined> => {
    const stopping = whyNotStopped(s.t3, thread, deadline);
    state.stopping = stopping;
    const why = await stopping;

    if (state.stopping === stopping) delete state.stopping;

    if (why === undefined) await endRunning(state, { op, state: 'cancelled' }, { threadEnded: true });
    else if (cancelling) await endRunning(state, unconfirmed(op, `${stillRuns(s, thread, why)}, then run teamai workflow cancel ${state.run} again.`), { threadEnded: false });

    return why;
  };

  /** Launches a step's thread on the attempt's folder with its first message, and returns it with the model it runs. */
  const launchStep = async (s: Session, request: PromptRequest, opened: PlaceRecord & { kind: 'worktree' }, thread: NewThread): Promise<{ threadId: string; model: string | undefined }> => {
    const message = firstMessage(opened, request, options.startedFrom && threadMention(s.environment, options.startedFrom));
    const launched = await s.t3.launch({ ...thread, message, projectId: opened.projectId, workspace: workspaceOf(opened, request.cwd) });

    return { threadId: launched.threadId, model: launched.modelSelection?.model };
  };

  /**
   * Sends the step's prompt as a new turn of `turn`'s thread, under the op as its clientRequestId, on the model selection
   * the turn asks for, and returns it.
   */
  const sendTurn = async (s: Session, request: PromptRequest, opened: PlaceRecord & { kind: 'worktree' }, turn: ThreadRecord): Promise<ThreadRecord> => {
    if (turn.turnOf?.configure) await s.t3.configure(turn.threadId, turn.turnOf.configure);
    await s.t3.send(turn.threadId, firstMessage(opened, request, options.startedFrom && threadMention(s.environment, options.startedFrom)), request.op);

    return turn;
  };

  /**
   * The earlier prompt's thread this prompt continues as a new turn, or why it cannot: the runtime holds that thread, its
   * prompt ended, it works in this prompt's folder on the same provider instance, and T3 still has it. A turn that asks
   * for another model selection than the thread's sets it on the thread first.
   */
  const continuable = async ({ s, request, instanceId, selection }: { s: Session; request: PromptRequest; instanceId: string; selection: Launch['modelSelection'] }): Promise<{ ok: true; thread: ThreadRecord; runs: number; configure?: NonNullable<Launch['modelSelection']> } | { ok: false; why: string }> => {
    const earlier = request.lease.continue;

    if (!earlier) return { ok: false, why: 'no earlier prompt named' };
    // The conversation is found by the op that launched it, in the earlier place, which holds it while it is open.
    const kept = journal.conversation(earlier.op);
    const thread = kept.kind === 'found' && kept.record.handle === earlier.handle && journal.read(earlier.handle).kind === 'found' ? kept.record.thread : undefined;

    if (kept.kind !== 'found' || !thread) return { ok: false, why: `runtime t3 holds no T3 thread of ${earlier.op} in ${earlier.handle}` };
    const where = `the T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}") of ${earlier.op}`;

    if (ledger.running(earlier.op) || kept.record.state.state === 'running') return { ok: false, why: `${where} still runs that prompt` };

    if (!thread.conversation) return { ok: false, why: `${where} was launched before runtime t3 kept what a later step needs to continue it` };

    if (thread.conversation.cwd !== request.cwd) return { ok: false, why: `${where} works in ${thread.conversation.cwd}, not in this step's folder ${request.cwd}` };

    // T3 runs a later turn on another model of the same provider instance once the thread is set to it, in the same
    // conversation; a thread cannot move to another instance.
    if (thread.instanceId !== instanceId) return { ok: false, why: `${where} runs on T3 Code provider instance "${thread.instanceId ?? thread.tool}", and this step asks for "${instanceId}"` };
    let shell: ThreadShell;

    try {
      shell = await s.t3.thread(thread.threadId);
    } catch (error) {
      if (error instanceof T3Error && error.threadGone) return { ok: false, why: `${where} is no longer in T3 Code` };

      return { ok: false, why: `T3 Code did not say whether it still has ${where}: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}` };
    }

    // A turn sent to a thread that runs, such as one the person sent a message to, would wait behind that run.
    if (isActive(shell.status)) return { ok: false, why: `${where} runs in T3 Code (${shell.status})` };

    // A chain names its first prompt, and a turn between may have set the thread to another model: T3 says which it
    // runs now, though not its options.
    // A step that names no model goes on in the model the thread was launched on.
    const wanted = selection ?? thread.conversation.launchedOn;
    const moved = shell.model !== undefined && shell.model !== null && shell.model !== wanted?.model;
    const configure = wanted && (moved || (selection !== undefined && !sameSelection(thread.conversation.modelSelection, selection))) ? wanted : undefined;

    return { ok: true, thread, runs: shell.runCount, ...(configure && { configure }) };
  };

  /**
   * Waits for the thread until the step is done, stopped or failed, and returns how it ended, and whether the runtime
   * saw the thread stop on the way: only then does the thread end with the op.
   */
  const follow = async ({ s, request, thread, state, toolHomes }: {
    s: Session;
    request: PromptRequest;
    thread: ThreadRecord;
    state: Running;
    /** Through a sandbox, the attempt's tool homes by the variable each tool reads: the tool keeps its session there. */
    toolHomes: Record<string, string> | undefined;
  }): Promise<{ state: OpEnd; threadEnded: boolean } | undefined> => {
    const where = `The T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}")`;
    const stopped = (ended: OpEnd) => ({ state: ended, threadEnded: true });
    let errors = 0;

    for (;;) {
      // A stop teamai asked for ended the op.
      if (ledger.running(request.op) !== state) return undefined;
      let waited: Waited;

      try {
        waited = await s.t3.wait(thread.threadId, WAIT_MS[s.mode]);
        errors = 0;
      } catch (error) {
        // T3 restarting, or a dropped connection: the thread keeps running, so ask again a few times.
        if (++errors > 5) return { state: unconfirmed(request.op, `${where} could not be followed, so it may still run: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${state.run} to stop it.`), threadEnded: false };

        await sleep(1_000 * errors);
        continue;
      }

      // A stop under way decides how the op ends; once it did not stop the thread, it is followed as before.
      if (state.stopping) {
        await state.stopping;
        continue;
      }

      // A run that ended while the work it delegated still goes has not ended the step.
      const ended = settledStatus(waited);

      // A turn sent to a thread whose earlier run ended has ended only once T3 shows a run of its own.
      if (ended !== undefined && thread.turnOf) {
        let runs: number | undefined;

        try {
          runs = (await s.t3.thread(thread.threadId)).runCount;
        } catch (error) {
          // Asked again a few times, as a wait that failed.
          if (++errors > 5) return { state: unconfirmed(request.op, `${where} could not be followed, so it may still run: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${state.run} to stop it.`), threadEnded: false };
        }

        if (runs === undefined || runs <= thread.turnOf.runsBefore) {
          await sleep(TURN_POLL_MS);
          continue;
        }
      }

      if (ended === undefined || ended === 'idle') {
        // T3 keeps a run that asks for an approval running, with the request pending; nobody answers it unattended.
        const asking = s.mode === 'unattended' ? (waited.status === 'waiting' ? { by: 'thread' } : await asksForApproval(s.t3, thread.threadId)) : undefined;

        if (asking) {
          const why = await whyNotStopped(s.t3, thread, Date.now() + STOP_WAIT_MS);

          const asked = asking.by === 'task'
            ? `${where} delegated a task that asked for an approval, and nobody is there to give it in an unattended run.`
            : `${where} asked for an approval, and nobody is there to give it in an unattended run.`;

          if (why === undefined) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: asked } });

          // The thread may still run, so the op ends as a stop the runtime could not confirm, which a later cancel retries.
          return { state: unconfirmed(request.op, `${asked} It still runs, and T3 Code did not stop it: ${why.replace(/\.$/, '')}. Stop it in T3 Code with its Stop button.`), threadEnded: false };
        }

        // A wait that came back before its time on a run still going (waiting for the person, or idle) is asked again later.
        if (!waited.timedOut) await sleep(IDLE_POLL_MS);
        continue;
      }

      // From here on, the thread's run and the work it delegated settled. A run the provider stopped on its usage limit
      // fails the step as such, so teamai says to retry once the limit resets.
      if (ended === 'failed') {
        const limited = await usageLimitOf(s, thread, waited.resultRun?.runId);

        if (limited) return stopped({ op: request.op, state: 'failed', failure: { code: 'usage_limited', message: limited } });
      }

      if (ended !== 'completed') return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} ended ${ended} before the step was done.` } });

      // An interactive step ends once the person said it is done and the agent wrote the result; until then the
      // thread idles between their turns.
      if (request.lease.interactive && !fs.existsSync(request.lease.result)) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const written = request.confined ? await judged(s.t3, thread) : readResult(request.lease.result);

      if (!written.ok) return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} ${written.why}.` } });
      const cwd = thread.copy ?? request.cwd;
      const served = s.instances.get(thread.tool);
      const driver = served ? driverOfProvider(served) : driverOf(thread.tool);
      // The session is in the tool home of the instance the thread runs on, or through a sandbox in the attempt's, which is
      // the scoring and resume store.
      const instanceId = instanceIdOf(s, thread);
      const variables = driver ? s.homeEnv[DRIVERS[driver].tool] ?? [] : [];
      const attemptHome = variables.map((variable) => toolHomes?.[variable]).find((dir) => dir !== undefined);
      const toolHome = driver && (attemptHome ?? (instanceId !== undefined ? instanceToolHome(readSettings(options.t3Home), { instanceId, driver, userHome: options.t3UserHome }) : undefined));
      // A new thread never resumes the session the lease names (T3 starts each with a new one), so that session, of an
      // earlier thread in this folder the step did not go on in, is not this one's.
      const other = thread.turnOf ? undefined : request.lease.resume;
      const lookup = driver && toolHome !== undefined ? await sessionSince({ driver, toolHome, cwd, since: thread.launchedAt, ...(other !== undefined && { other }) }) : undefined;

      const keptNone = () => {
        // T3 runs the tool in the instance's home path, else in the home its own server's environment names, which
        // teamai cannot read: only the setting makes the two agree.
        const named = driver && attemptHome === undefined && instanceId !== undefined && toolHome !== undefined
          ? ` teamai looks for it in the home path of T3 provider instance "${instanceId}", else in ~/${DRIVERS[driver].home} of the user T3 Code runs as (${toolHome}). If the T3 server runs ${thread.tool} with a ${variables.join(' or ')} of its own, set providerInstances.${instanceId}.config.homePath to that directory in ${path.join(options.t3Home, 'userdata', 'settings.json')} (Settings → Providers in T3 Code), then retry the step.`
          : '';

        return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} finished, but ${thread.tool} kept no session for ${cwd}${toolHome === undefined ? '' : ` in ${toolHome}`}, so the step cannot be scored or resumed.${named}` } });
      };

      if (!driver || toolHome === undefined || lookup === undefined) return keptNone();

      switch (lookup.kind) {
        case 'found':
          break;
        case 'none':
          return keptNone();
        case 'unlistable': {
          const folders = lookup.folders.join(', ');

          return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} finished, but teamai cannot list ${folders}, where ${thread.tool} keeps the step's session, because it has no permission to read ${lookup.folders.length > 1 ? 'them' : 'it'}, so the step cannot be scored or resumed. Let the user teamai runs as read ${folders}, then retry the step.` } });
        }

        case 'failed':
          return stopped({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `${where} finished, but teamai could not look for ${thread.tool}'s session in ${toolHome}: ${lookup.why}. So the step cannot be scored or resumed; retry it.` } });
        default: {
          const unhandled: never = lookup;

          return unhandled;
        }
      }

      const found = lookup.session;
      // teamai reads a tool instance's session only in the home named here: it knows no default home for it.
      const kept = { tool: thread.tool, id: found.id, ...((thread.tool !== DRIVERS[driver].tool || !isDefaultToolHome(driver, toolHome)) && { home: toolHome }) };
      const turnSentAt = thread.turnOf?.sentAt;
      const { transcript } = found;

      const measured: StepUsage = transcript === undefined
        ? { kind: 'unmeasured', why: { cause: `${thread.tool}'s store names no transcript of session ${found.id}, which teamai reads the step's tokens from.`, next: 'Retry the step.' } }
        : thread.turnOf && turnSentAt === undefined
          ? UNTIMED_TURN
          : await stepUsage({ format: DRIVERS[driver].tokens, transcriptPath: transcript, sessionId: found.id, ...(turnSentAt !== undefined && { turnSentAt }) });

      const usage = measured.kind === 'measured' ? { usage: measured.usage } : s.offersTokens ? { unmeasured: measured.why } : {};

      return stopped({ op: request.op, state: 'finished', session: kept, result: written.result, ...usage, ...(request.confined && { confined: JUDGE_KEPT }), ...(thread.turnOf && { resumed: true }) });
    }
  };

  const prompt = async (request: PromptRequest): Promise<void> => {
    const session = serving.session();
    const read = journal.read(request.handle);
    const opened = read.kind === 'found' ? read.place : undefined;
    const ended = ledger.unkept(request.op) ?? opened?.ops[request.op];

    /** The acceptance shows the step's thread when the journal holds it already, so the run details link it during the run. */
    let accepted = false;

    const accept = (thread: ThreadRecord | undefined): void => {
      if (accepted) return;
      accepted = true;
      write({ op: request.op, event: 'accepted', ...(thread && session && { display: threadDisplay(thread, session.environment) }) });
    };

    // An op this process owns ends here, whatever its record says while its owner writes it.
    if (ledger.running(request.op)) {
      accept(opened?.threads[request.op]);

      return;
    }

    if (ended && ended.state !== 'running') {
      accept(opened?.threads[request.op]);
      answerEnded(request.op, ended);

      return;
    }

    if (!session || !opened) {
      accept(undefined);
      // A record that cannot be read may hold the op's thread, which may still run.
      fail(request.op, read.kind === 'unreadable' ? { ...unreadableFailure(request.handle, read), code: CANCEL_FAILED } : { code: 'runtime_protocol', message: session ? `No open place ${request.handle}.` : 'prompt came before a successful init.' });

      return;
    }

    const s = session;

    const end = (state: OpEnd, threadEnded = false): Promise<void> => ledger.settle(state, () => record(request.handle, state, { threadEnded }));

    let thread = opened.threads[request.op];
    const pending = opened.launches[request.op];

    /** The op once it runs in this process, whose end then goes through the ledger's run. */
    let begun: Running | undefined;

    /**
     * Ends an op this process launched no thread for. A thread the journal holds for it, which another process may have
     * launched, or a launch T3 never answered, stays the runtime's to stop: while it may still run, the op ends as a stop
     * the runtime could not confirm, with the refusal as its cause, so a later cancel stops it.
     */
    const refuse = async (refusal: OpEnd): Promise<void> => {
      accept(undefined);
      const close = (outcome: OpEnd): Promise<void> => (begun && ledger.running(request.op) === begun ? endRunning(begun, outcome, { threadEnded: false }) : end(outcome));

      if (refusal.state !== 'failed' || (thread ? thread.ended : !pending)) return close(refusal);
      const { code, message } = refusal.failure;
      const held = thread ? `The T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}")` : `The T3 thread "${pending?.title}", whose launch T3 Code never answered,`;

      await close(unconfirmed(request.op, code === 'launch_unconfirmed' ? message : `${message.replace(/\.$/, '')} (${code}). ${held} may still run: run teamai workflow cancel ${opened.run} to stop it.`));
    };

    // Why teamai's cancel came before this prompt, if it did.
    const mark = ledger.takeMark(request.op);

    if (mark === 'cancelled-unseen') {
      // The mark says only that teamai cancelled the op before this process saw it: a thread or launch the journal holds
      // for it ends the op cancelled once the cancel confirmed its stop, never on the mark alone.
      if ((thread && !thread.ended) || pending) {
        accept(thread);
        await cancel(request.op);
      } else {
        await refuse({ op: request.op, state: 'cancelled' });
      }

      return;
    }

    // A record that holds the op was the one its cancel could not read, and the prompt reconnects to what it holds. One
    // that holds nothing of it says the cancel failed on another place's record, so the cancel stands.
    if (mark === 'cancel-unread' && !ended) {
      await refuse({ op: request.op, state: 'cancelled' });

      return;
    }

    const lease = request.lease;
    // The op runs here from now on, before the runtime asks T3 anything slow: a cancel meanwhile finds it, and ends it at
    // once while nothing was launched or sent.
    const state: Running = { handle: request.handle, run: opened.run, title: pending?.title ?? `${lease.step} · teamai ${opened.run}`, preparing: !thread && !pending };
    ledger.begin(request.op, state);
    begun = state;
    ledger.forget(request.op);
    accept(thread);
    /** Whether teamai cancelled the op while it prepared, which ended it. */
    const gone = (): boolean => ledger.running(request.op) !== state;

    /** A record that cannot be written fails the request with nothing sent, and leaves no run behind to swallow a cancel. */
    const journaledOrAbandoned = async (save: () => Promise<void>): Promise<void> => {
      try {
        await save();
      } catch (error) {
        ledger.abandon(request.op, state);
        throw error;
      }
    };

    // The open adds a tool instance's provider instance; one teamai opened with no tool adds it here.
    const toAdd = s.pending.get(lease.tool);
    const added = await adder.instanceFor(s, lease.tool, { op: request.op });

    if (gone()) return;

    if (added && !added.ok) {
      await refuse({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: adder.notAdded(lease.tool, toAdd, added) } });

      return;
    }

    const through = opened.kind === 'worktree' ? opened.through : undefined;
    // Through a sandbox, the tool runs on the provider instance whose Binary path is teamai's wrapper.
    const wrapped = through && await adder.wrapperFor(s, lease.tool, { op: request.op });

    if (gone()) return;

    if (wrapped && !wrapped.ok) {
      await refuse({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: adder.notAdded(`${WRAPPER_PREFIX}${lease.tool}`, undefined, wrapped) } });

      return;
    }

    const instance = wrapped ? wrapped.provider : s.instances.get(lease.tool);

    if (!instance) {
      await refuse({ op: request.op, state: 'failed', failure: { code: 'tool_unavailable', message: `T3 Code ${s.environment.label} runs ${[...s.instances.keys()].join(', ') || 'no tool this runtime runs'} here, not ${lease.tool}.` } });

      return;
    }

    if (lease.permissions === 'unattended') {
      // The offer says unattended: false, so teamai never sends one: an unattended lease needs a strict sandbox, which a
      // thread on the host is not, even in full access.
      await refuse({ op: request.op, state: 'failed', failure: { code: 'unattended_unsupported', message: 'Runtime t3 runs no step in unattended permissions on this machine.' } });

      return;
    }

    const credentials = Object.keys(request.credentials);

    // The offer says env: false, so teamai sends none: the thread's tool runs in T3 Code's environment, on its sign-in.
    if (credentials.length > 0) {
      await refuse({
        op: request.op, state: 'failed', failure: {
          code: 'credentials_unsupported',
          message: `Runtime t3 got credentials ${credentials.join(', ')}, but a T3 thread runs its tool in T3 Code's environment, on T3 Code's own sign-in, and this runtime cannot pass it a value (its init offers can.env: false). Remove the credentials from the runtime, or run the step on a runtime that offers can.env.`,
        },
      });

      return;
    }

    const settingsProjectId = opened.kind === 'worktree' ? opened.settingsProjectId ?? opened.projectId : undefined;
    const project = projectSettings(readSettings(options.t3Home), settingsProjectId === undefined ? undefined : { id: settingsProjectId });

    // T3 applies only the project's default to a launch that names no model, so a started-from thread's is named.
    const selection = modelSelection({
      provider: instance, lease, defaultModel: s.threadModel ?? project.defaultModel,
      appliedByT3: s.threadModel === undefined && (opened.kind !== 'worktree' || settingsProjectId === opened.projectId),
    });

    if (!selection.ok) {
      await refuse({ op: request.op, state: 'failed', failure: selection.failure });

      return;
    }

    const work = workOf(request, opened);

    if (!work) {
      await refuse({ op: request.op, state: 'failed', failure: { code: 'runtime_protocol', message: opened.kind === 'confined' ? `${request.handle} is a confined prompt's place, and this prompt is not confined.` : `A confined prompt came to ${request.handle}, which was opened with a view.` } });

      return;
    }

    // Launching again under this sign-in would start the step a second time, beside the thread T3 may run.
    if (!thread && pending && pending.signIn !== s.signIn) {
      await refuse({ op: request.op, state: 'failed', failure: launchUnconfirmed(opened, pending) });

      return;
    }

    // A turn of an earlier prompt's conversation is journaled before it is sent, so a restarted runtime finds its thread
    // by op, and sends it again under the same clientRequestId, which T3 answers without a second turn.
    if (!thread && !pending && work.kind === 'step' && lease.continue) {
      const earlier = lease.continue;
      const continuing = await continuable({ s, request, instanceId: instance.providerInstanceId, selection: selection.selection });

      if (gone()) return;

      if (continuing.ok) {
        const { ended: _ended, ...continued } = continuing.thread;
        const { configure } = continuing;

        const turn: ThreadRecord = {
          ...continued, ...(configure && { model: configure.model, conversation: { ...continued.conversation, cwd: request.cwd, modelSelection: configure } }),
          turnOf: { handle: earlier.handle, op: earlier.op, runsBefore: continuing.runs, sentAt: Date.now(), ...(configure && { configure }) },
        };

        state.preparing = false;
        await journaledOrAbandoned(() => journalOp({ handle: request.handle, op: request.op, ...(!places.isReleased(request.handle) && { opened }) }, () => ({ state: { op: request.op, state: 'running' }, thread: turn })));
        thread = turn;
        write({ op: request.op, event: 'display', display: threadDisplay(turn, s.environment) });
      } else {
        notice(`Runtime t3 starts a new T3 thread for step "${lease.step}" rather than continue the conversation of ${earlier.op}: ${continuing.why}.`, { op: request.op, handle: request.handle });
      }
    }

    // A launch T3 never answered is sent again as it was journaled: T3 checks the mode before it looks the launch up,
    // so a repeat in another mode would not find the thread it launched.
    const launch: LaunchRecord = pending ?? {
      title: `${lease.step} · teamai ${opened.run}`, ...(selection.selection && { modelSelection: selection.selection }), runtimeMode: launchMode(work, project.defaultMode, { op: request.op, handle: request.handle }), tool: lease.tool,
      launchedAt: thread?.launchedAt ?? Date.now(), signIn: s.signIn, ...(work.kind === 'step' && opened.kind === 'worktree' && opened.binding === 'existing_worktree' && { worktreePath: request.cwd }),
    };

    const { title, launchedAt } = launch;

    // T3 may launch the thread and still fail to answer, so the launch is journaled before it is sent. One it cannot
    // journal fails the request before the op runs here, as nothing was launched.
    state.preparing = false;

    if (!thread) {
      await journaledOrAbandoned(() => journalOp({ handle: request.handle, op: request.op, ...(!places.isReleased(request.handle) && { opened }) }, (conversation) => ({ ...conversation, state: { op: request.op, state: 'running' }, launch })));
    }

    const finish = (outcome: OpEnd, threadEnded = false): Promise<void> => endRunning(state, outcome, { threadEnded });

    try {
      const newThread: NewThread = { title, ...(launch.modelSelection && { modelSelection: launch.modelSelection }), runtimeMode: launch.runtimeMode, clientRequestId: request.op };

      // Accepted before T3 launches anything, which may take longer than teamai waits for an acceptance.
      accept(thread);

      /** Journals the op running on `threadId`, with the judge's copy once its folder is known, in place of its launch. */
      const journalThread = async (threadId: string, copy: string | undefined, model: string | undefined): Promise<ThreadRecord> => {
        const launchedOn = launch.modelSelection ?? (model === undefined ? undefined : { instanceId: instance.providerInstanceId, model });

        const launched: ThreadRecord = {
          threadId, title, model: model ?? launch.modelSelection?.model ?? 'default', tool: launch.tool, instanceId: instance.providerInstanceId, launchedAt, ...(copy && { copy }),
          ...(work.kind === 'step' && {
            conversation: {
              cwd: request.cwd, ...(launch.modelSelection && { modelSelection: launch.modelSelection }),
              ...(launchedOn && { launchedOn }),
            },
          }),
        };

        // A cancel that ended the op while T3 had not answered the launch keeps that outcome.
        await journalOp({ handle: request.handle, op: request.op, ...(!places.isReleased(request.handle) && { opened }) }, (conversation) => ({ state: conversation?.state ?? { op: request.op, state: 'running' }, thread: launched }));

        state.thread = launched;
        write({ op: request.op, event: 'display', display: threadDisplay(launched, s.environment) });

        return launched;
      };

      // A thread the journal holds is reconnected to by its id: T3 answers a repeated launch with it only under the
      // sign-in that sent the launch, and would start the step again under another.
      if (thread) state.thread = thread;
      const known = thread;

      // A close that comes meanwhile waits for the launch, so it stops the thread the launch started.
      thread = await places.track(request.handle, work.kind === 'judge'
        ? launchJudge({ t3: s.t3, request, confined: work.confined, opened, journalThread, thread: newThread, known, isReleased: () => places.isReleased(request.handle), linkOf: (threadId) => threadLink(s.environment, threadId) })
        : known ? (known.turnOf ? sendTurn(s, request, work.place, known) : Promise.resolve(known)) : launchStep(s, request, work.place, newThread).then(({ threadId, model }) => journalThread(threadId, undefined, model)));
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // Only a check a new launch runs proves T3 launched nothing; a judge's copy fails before its idle thread is briefed.
      const refused = !state.thread && error instanceof T3Error && error.launchedNothing ? error.refusal : undefined;

      if (error instanceof T3Error && error.threadGone && state.thread?.turnOf) {
        await finish({ op: request.op, state: 'failed', failure: { code: 'tool_failed', message: `The T3 thread ${threadLink(s.environment, state.thread.threadId)} ("${state.thread.title}"), whose conversation this step continues, left T3 Code while teamai sent it the step. Run the step again; it starts a new thread.` } }, true);
      } else if (error instanceof JudgeCopyFailed) await finish({ op: request.op, state: 'failed', failure: { code: 'judge_copy_failed', message: why } });
      else if (error instanceof JudgeReleased) await finish({ op: request.op, state: 'failed', failure: { code: 'released', message: why } });
      // T3 caps a thread's mode at the access the member approved teamai with, and says so with this code.
      else if (refused?.code === 'runtime_mode_escalation_denied') {
        await finish({
          op: request.op, state: 'failed', failure: {
            code: 'sign_in_too_narrow',
            message: launch.runtimeMode === 'full-access'
              ? `T3 Code refused to start the step's thread in ${launch.runtimeMode} mode, because teamai's sign-in does not allow it (${refused.message}). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Full access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.`
              : `T3 Code refused to start the step's thread in ${launch.runtimeMode} mode, because teamai's sign-in does not allow it (${refused.message}). Remove ~/.teamai/runtime-state/t3/credentials.json and start the workflow again; teamai signs in again; approve it with Auto access if T3 Code asks. Or set runtime_mode to a mode the sign-in allows.`,
          },
        });
      } else if (refused) await finish({ op: request.op, state: 'failed', failure: { code: 't3_launch_failed', message: `T3 Code did not launch the step's thread: ${why}` } });
      else await finish(unconfirmed(request.op, `teamai launched the T3 thread "${title}", and T3 Code did not confirm the launch, so it may run: ${why.replace(/\.$/, '')}. Run teamai workflow cancel ${opened.run} to find and stop it.`));

      return;
    }

    // teamai cancelled the prompt while T3 launched its thread. Past the cancel's deadline the op has ended, and the stop
    // is sent all the same; the thread stays journaled for a later cancel or close.
    if (state.cancelBy !== undefined) {
      await stopRunning({ s, state, op: request.op, thread, cancelling: true, deadline: state.cancelBy });

      return;
    }

    try {
      const followed = await follow({ s, request, thread, state, toolHomes: through?.toolHome });

      if (followed) await finish(followed.state, followed.threadEnded);
    } catch (error) {
      // The thread may still run in T3, where the person finds it by the link.
      await finish(unconfirmed(request.op, `Lost track of the T3 thread ${threadLink(s.environment, thread.threadId)}, so it may still run: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${opened.run} to stop it.`));
    }
  };

  /**
   * Finds the thread of a launch T3 never answered by repeating it with the same clientRequestId and no message: T3
   * answers a launch it accepted with that thread and starts nothing more, and launches an idle thread otherwise. A
   * launch a new launch's check refuses launched nothing. Answers the place as journaled then, or why a launch another
   * sign-in sent cannot be looked up; throws while T3 does not say.
   */
  const resolveLaunch = async (s: Reached, known: PlaceRecord, op: OpId, launch: LaunchRecord): Promise<{ ok: true; place: PlaceRecord } | { ok: false; failure: RuntimeFailure }> => {
    if (launch.signIn !== s.signIn) return { ok: false, failure: launchUnconfirmed(known, launch) };
    const newThread: NewThread = { title: launch.title, ...(launch.modelSelection && { modelSelection: launch.modelSelection }), runtimeMode: launch.runtimeMode, clientRequestId: op };
    let threadId: string | undefined;
    let model: string | undefined;

    try {
      const launched = known.kind === 'worktree'
        ? await s.t3.launch({ ...newThread, projectId: known.projectId, workspace: workspaceOf(known, launch.worktreePath ?? '') })
        : await s.t3.launchScratch(newThread);

      threadId = launched.threadId;
      model = launched.modelSelection?.model;
    } catch (error) {
      // T3 answers a launch it accepted before any check a new launch needs, so only such a check's refusal proves it
      // launched nothing. Any other answer, such as orchestration_error, may come from the lookup itself.
      if (!(error instanceof T3Error && error.launchedNothing)) throw error;
    }

    // A close may have removed the place while T3 answered: its record is not written again.
    const now = journal.writable(known.handle);
    const base = now ?? known;
    const { [op]: _resolved, ...launches } = base.launches;

    const thread: ThreadRecord | undefined = threadId === undefined ? undefined : {
      threadId, title: launch.title, model: model ?? launch.modelSelection?.model ?? 'default', tool: launch.tool, launchedAt: launch.launchedAt,
      ...(launch.modelSelection && { instanceId: launch.modelSelection.instanceId }),
    };

    const resolved: PlaceRecord = { ...base, launches, ...(thread && { threads: { ...base.threads, [op]: thread } }) };

    if (now) await journalOp({ handle: known.handle, op }, (conversation) => conversation && { state: conversation.state, ...((thread ?? conversation.thread) && { thread: thread ?? conversation.thread }) });

    return { ok: true, place: resolved };
  };

  const cancel = async (op: OpId): Promise<void> => {
    const state = ledger.running(op);
    const session = serving.session();

    if (state?.preparing) return endRunning(state, { op, state: 'cancelled' }, { threadEnded: false });

    if (state) {
      if (state.cancelBy === undefined) {
        const by = Date.now() + STOP_WAIT_MS;
        state.cancelBy = by;

        // Without a thread yet, the prompt stops it once T3 answers the launch, and a stop ends by the deadline itself;
        // a launch T3 has not answered by then ends the op.
        setTimeout(() => {
          if (ledger.running(op) === state && !state.stopping) void endRunning(state, unconfirmed(op, `teamai cancelled the step while T3 Code launched its thread "${state.title}", and the launch had not finished ${STOP_WAIT_MS / 1_000} s later, so the thread may run. Run teamai workflow cancel ${state.run} again.`), { threadEnded: false });
        }, by - Date.now());
      }

      if (state.thread && session) await stopRunning({ s: session, state, op, thread: state.thread, cancelling: true, deadline: state.cancelBy });

      return;
    }

    const handle = ledger.handleOf(op);
    const read = handle ? journal.read(handle) : journal.placeOf(op);

    // A record that cannot be read may hold the op's thread: that is no proof it launched nothing.
    if (read.kind === 'unreadable') {
      ledger.mark(op, 'cancel-unread');

      return fail(op, { ...unreadableFailure(handle ?? read.handle ?? op, read), code: CANCEL_FAILED });
    }

    let known = read.kind === 'found' ? read.place : undefined;
    const retained = ledger.unkept(op) ?? known?.ops[op];

    // A runtime before this one launched the thread and died, maybe before T3 answered the launch, or a stop failed
    // before; teamai cancels before it reattaches.
    if (!known || !(retained?.state === 'running' || (retained?.state === 'failed' && retained.failure.code === CANCEL_FAILED))) {
      if (retained) answerEnded(op, retained);
      else ledger.mark(op, 'cancelled-unseen');

      return;
    }

    const { handle: at, run } = known;
    const deadline = Date.now() + STOP_WAIT_MS;
    const left = (): number => Math.max(deadline - Date.now(), 0);

    // This cancel owns the op's end as a prompt this process runs would, before anything is awaited: a prompt teamai
    // resends meanwhile joins it rather than following the thread, and only one end is written.
    const owner: Running = { handle: at, run, title: (known.threads[op] ?? known.launches[op])?.title ?? op, cancelBy: deadline, thread: known.threads[op] };
    ledger.begin(op, owner);

    // From reading this cancel until its stop is confirmed or fails again, the op runs: a stop that failed before is not
    // this cancel's outcome. A record that cannot be written leaves no owner behind to swallow the next cancel.
    if (retained.state === 'failed') {
      try {
        await record(at, { op, state: 'running' }, { threadEnded: false });
      } catch (error) {
        ledger.abandon(op, owner);
        throw error;
      }
    }

    ledger.forget(op);

    const answer = (ended: OpEnd, threadEnded: boolean): Promise<void> => endRunning(owner, ended, { threadEnded });

    const reaching = await within(serving.reach(), left());
    const reached: Reach = reaching.answered ? reaching.value : { ok: false, failure: { code: 't3_unavailable', message: `T3 Code did not answer within ${STOP_WAIT_MS / 1_000} s` } };

    if (!reached.ok) return answer(unconfirmed(op, `teamai could not reach T3 Code to stop the T3 thread of ${op}, so it may still run (${reached.failure.message.replace(/\.$/, '')}). Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
    const s = reached.reached;
    const launch = known.launches[op];

    if (launch) {
      const lookUp = `teamai launched the T3 thread "${launch.title}" and T3 Code never answered, so it may run`;
      let resolved: Awaited<ReturnType<typeof resolveLaunch>>;

      try {
        // A lookup that answers late still journals the thread it found, unless a close removed the place meanwhile.
        const resolving = await within(resolveLaunch(s, known, op, launch), left());

        if (!resolving.answered) return answer(unconfirmed(op, `${lookUp}, and T3 Code did not say within ${STOP_WAIT_MS / 1_000} s whether it launched it when teamai looked. Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
        resolved = resolving.value;
      } catch (error) {
        return answer(unconfirmed(op, `${lookUp}, and T3 Code did not say whether it launched it when teamai looked: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${run} again once T3 Code answers.`), false);
      }

      // The launch stays journaled, so close keeps the place and says the same.
      if (!resolved.ok) return answer(unconfirmed(op, resolved.failure.message), false);
      known = resolved.place;
    }

    const owned = known.threads[op];

    if (!owned) return answer({ op, state: 'cancelled' }, true);
    owner.thread = owned;
    await stopRunning({ s, state: owner, op, thread: owned, cancelling: true, deadline });
  };

  return { prompt, cancel, journalOp, stopRunning, resolveLaunch };
}

export type Conversations = ReturnType<typeof conversations>;

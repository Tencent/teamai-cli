import { randomBytes } from 'node:crypto';
import { OpIdSchema, type Can, type ConfinedKept, type ExecRequestSchema, type InitCredentials, type InitHomeEnv, type InitInstance, type OpenRequestSchema, type OpId, type OpState, type PromptRequestSchema, type PromptResult, type PromptSessionSchema, type PromptUsageSchema, type RuntimeDisplay, type RuntimeFailure, type RuntimeMode, type RuntimeOptions, type WakeRequest } from './protocol.js';
import type { z } from 'zod';

// ─── Step runtimes ───────────────────────────────────────
//
//  A step runtime is where and how a workflow step's processes run: in teamai's process on the host, or an external
//  program speaking the runtime protocol over stdio (protocol.ts). teamai's local loop reaches each through this one
//  interface, which a runtime package can implement from the protocol alone. Not to be confused with the bundled
//  runtime, the Node and shell that WorkBuddy and CodeBuddy ship, nor with a workflow's executor (`command` or
//  `prompt`), nor with a tool.
//
//  Every operation is accepted first and finishes later. teamai names each with an id it persists before it sends the
//  request, and a runtime answers a repeated id with the same acceptance and the same terminal outcome until `close`.
//

/** A new operation id. */
export function newOpId(): OpId {
  return OpIdSchema.parse(`op-${randomBytes(6).toString('hex')}`);
}

/** An open as the local loop sends it; the protocol's request without its type. */
export type OpenRequest = Omit<z.infer<typeof OpenRequestSchema>, 'type'>;

/** An exec as the local loop sends it; the protocol's request without its type. */
export type ExecRequest = Omit<z.infer<typeof ExecRequestSchema>, 'type'>;

/**
 * What an exec runs, which teamai knows and the protocol does not carry: the workflow's `setup`, the step's `command`, a
 * prompt step's `tool`, or a `workflow:` step leased whole, which only a runtime with `can.workflow` is sent. Only an
 * in-process runtime reads it, such as the fleet, which offers the step's command, or the whole workflow, alone.
 */
export type ExecKind = 'setup' | 'command' | 'tool' | 'workflow';

/** A prompt as the local loop sends it to a runtime that launches agents its own way. */
export type PromptRequest = Omit<z.infer<typeof PromptRequestSchema>, 'type'>;

export type Opened = { kind: 'ready'; handle: string; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

/**
 * Whether `failure` is teamai's, for a runtime that did not answer a request it was sent (`stdio.ts`): it timed out,
 * stopped, or broke the protocol, so it may hold what it was asked to make. Any other failure is the runtime's own
 * answer, or `runtime_not_sent`, for a request teamai never sent to a runtime that had stopped.
 */
export function isUnansweredFailure(failure: RuntimeFailure): boolean {
  return failure.code === 'runtime_unanswered' || failure.code === 'runtime_exited' || failure.code === 'runtime_protocol';
}

/**
 * The runtime stopped answering after it was sent an operation: what that operation started may still run there, so
 * nothing it holds, such as a login, is released.
 */
export type Lost = { kind: 'lost'; failure: RuntimeFailure };

/**
 * How an exec ended. `exited` carries the whole stdout a live run read; one a reattach reports after a restart carries
 * it up to protocol 1's bound, and past that its end. A `cancelled` carries what the exec answered before it stopped, if
 * anything, such as what a whole workflow's steps spent. A `failed` with `isStepOutcome` is how the step itself ended,
 * under its own code, such as a fleet member gone, rather than a runtime that could not run it.
 */
export type ExecEnd = { kind: 'exited'; code: number; stdout: string } | { kind: 'cancelled'; stdout?: string } | { kind: 'failed'; failure: RuntimeFailure; isStepOutcome?: true } | Lost;

type FinishedState = Extract<OpState, { state: 'finished' }>;

/** The limit of a prompt lease's `limits` at which the runtime stopped the tool. */
export type PromptStopped = NonNullable<FinishedState['stopped']>;

/**
 * How a prompt ended: finished with the tool's session, the result the agent wrote, its usage, whether it continued the
 * session the lease asked to resume and, for a confined prompt, what the runtime kept; cancelled; or failed.
 */
export type PromptEnd =
  | { kind: 'finished'; session: z.infer<typeof PromptSessionSchema>; result: PromptResult; usage?: z.infer<typeof PromptUsageSchema>; unmeasured?: FinishedState['unmeasured']; model?: FinishedState['model']; cost?: FinishedState['cost']; confined?: ConfinedKept; resumed?: true; stopped?: PromptStopped }
  | { kind: 'cancelled' }
  | { kind: 'failed'; failure: RuntimeFailure }
  | Lost;

/**
 * How a wake ended: the member launched, on `where`, with what the runtime shows of it; or failed, `wake_unavailable`
 * when the runtime has no machine to wake on, `cancelled` when a cancel stopped it before it launched.
 */
export type WakeEnd = { kind: 'woken'; where: string; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure } | Lost;

/** A reattach: the handle is gone, alive with what the runtime retains, or the runtime could not be asked. */
export type Reattached = { kind: 'gone' } | { kind: 'alive'; ops: OpState[]; display?: RuntimeDisplay } | { kind: 'failed'; failure: RuntimeFailure };

/** What a runtime showed with an operation's acceptance: a display, or none. */
export interface Accepted {
  display?: RuntimeDisplay;
}

/** A gate the work an exec runs reached, which the driver that sent it asks its person (`ExecEvents.ask`). */
export type ExecQuestion = { step: string; kind: 'approve' | 'choose'; message: string; options: string[]; required: boolean; default?: string };

/** The answer to an `ExecQuestion`: the choice and note the person gave, or why none comes, for the work to fail on. */
export type ExecAnswer = { choice: string; note?: string } | { refused: string };

export interface ExecEvents {
  onAccepted?: (accepted: Accepted) => void;
  /**
   * Asks the driver's person a gate the work reached, as a whole workflow a fleet member runs does. Absent: the driver
   * answers none, and such work fails at its gate.
   */
  ask?: (question: ExecQuestion, signal: AbortSignal) => Promise<ExecAnswer>;
  /**
   * A display the runtime gave apart from the acceptance, such as the agent it launched after it accepted a prompt. It
   * neither accepts nor ends the operation, and may come before the acceptance.
   */
  onDisplay?: (display: RuntimeDisplay) => void;
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
}

/**
 * A runtime's offer: what it can, and whether it launches agents its own way, so prompt steps reach it as `prompt`.
 * - `unavailable`: the tools the runtime cannot run now, each with the runtime's reason and next step.
 * - `ownLogins`: the tools whose login the runtime's provider keeps: teamai copies none of their logins, nor sends the
 *   sign-ins it found for them.
 * - `wakes`: it launches a fleet member on another machine it reaches, through `StepRuntime.wake`.
 * - `runsOnToolHome`: it runs each tool in the attempt's tool home, which teamai seeds, copies a login into and reads
 *   sessions in.
 * - `keepsConversations`: a prompt's conversation outlives the prompt in its place, so teamai may hold the place for a
 *   later prompt.
 */
export type Initialized<TCan = Can> =
  | { ok: true; can: TCan; launchesAgents: boolean; unavailable?: Record<string, string>; ownLogins?: string[]; wakes?: true; runsOnToolHome?: true; keepsConversations?: true }
  | { ok: false; failure: RuntimeFailure };

/**
 * One step runtime, as the local loop calls it. Expected failures are values; a runtime that dies fails what it had in
 * flight. `TCan` is what its `init` answers: the protocol's `Can`, or teamai's wider one for an in-process runtime.
 */
export interface StepRuntime<TCan = Can> {
  /** The runtime's name, as a driver definition's `use` names it. */
  readonly name: string;
  /**
   * Whether an exec goes on without the teamai that sent it, as one a fleet member runs: a teamai that stops leaves it
   * running rather than cancelling it, and a restarted one reconnects by sending the same id again rather than stopping
   * it. Absent: an exec stops with its teamai, since the limits it runs under cannot be kept across the gap.
   */
  readonly isExecReconnected?: boolean;
  /**
   * Whether the runtime picks a prompt step's tool, model and login where it runs the step, and renders its prompt there,
   * as a fleet member does: teamai picks none of them here, and sends the prompt step as leased.
   */
  readonly isToolPickedThere?: boolean;
  /**
   * Validates `options` (a bad key fails with `bad_option` naming it) and answers what the runtime offers, knowing the
   * names of the `credentials` its definition gives it, the tool `instances` the member may run, each tool's `homeEnv`,
   * and the run's `checkout`. In `recover` mode it only answers for the handles it recorded.
   */
  init(request: { options: RuntimeOptions; mode: RuntimeMode; credentials?: InitCredentials; instances?: InitInstance[]; homeEnv: InitHomeEnv; checkout?: string }): Promise<Initialized<TCan>>;
  /**
   * Opens the attempt's place. `onAccepted` runs with the handle before `open` settles, so teamai persists it; `open`
   * rejects with its error. A place made in steps (a runtime through another) is accepted at each, with the handle so far.
   */
  open(request: OpenRequest, onAccepted: (handle: string) => Promise<void>): Promise<Opened>;
  exec(request: ExecRequest, events: ExecEvents, kind: ExecKind): Promise<ExecEnd>;
  /** Runs a prompt step on a runtime that launches agents its own way; any other answers it failed. */
  prompt(request: PromptRequest, events: Pick<ExecEvents, 'onAccepted' | 'onDisplay'>): Promise<PromptEnd>;
  /**
   * Launches a fleet member of `pool` on another machine, for a runtime whose `init` answered `wakes`, and forgets it:
   * the runtime never follows, settles or stops what it woke. At-least-once: the fleet record keeps one claim. Nothing
   * bounds a wake once the runtime accepted it, since it has no place and no deadline: the caller cancels one it stops
   * waiting for.
   */
  wake?(request: Omit<WakeRequest, 'type'>, events: Pick<ExecEvents, 'onAccepted' | 'onDisplay'>): Promise<WakeEnd>;
  /** Stops operation `op` and every process it started. Its `exec` or `prompt` then ends `cancelled`. */
  cancel(op: OpId): Promise<void>;
  /** Brings the place's work back to the host, deletions included, never committed; after success and after failure. */
  collect(handle: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /**
   * `credentials`: as the outer of a runtime through it, the prompt's credentials again, which it keeps only in memory.
   * A prompt's end it reports is final: a runtime whose wait still has work to bring back reports it running until it has.
   */
  reattach(handle: string, how?: { credentials: Record<string, string>; unset?: string[] }): Promise<Reattached>;
  /**
   * Ends the handle: the runtime may drop its retained outcomes. A failure says the place, and what runs in it, may
   * remain. `release` says the person let the attempt go, so the runtime forgets the place even when it cannot end it.
   */
  close(handle: string, how?: { release: true }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }>;
  /** Ends this connection to the runtime. Operations the runtime keeps running stay its own. */
  dispose(): Promise<void>;
}

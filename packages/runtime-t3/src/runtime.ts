import type { InitHomeEnv, RUNTIME_MODES, OpId, RuntimeFailure, RuntimeMessage } from '@teamai/runtime-protocol';
import { opLedger, type OpLedger } from '@teamai/runtime-kit/ledger';
import { placeWork, type PlaceWork } from '@teamai/runtime-kit/places';
import { serveRuntime } from '@teamai/runtime-kit/serve';
import type { NewInstance } from './add-instance.js';
import type { AddedProjects } from './added-projects.js';
import type { SignInAccess } from './auth.js';
import { conversations, type Running } from './conversation.js';
import { instanceAdder } from './instances.js';
import type { Journal } from './journal.js';
import { offer } from './offer.js';
import { placeHandlers } from './place.js';
import { wakes } from './wake.js';
import type { ModelSelection } from './settings.js';
import type { Environment, Provider, StepMode, T3 } from './t3.js';
import type { T3Command } from './t3-command.js';

// ─── teamai-runtime-t3 ───
//
//  Runtime protocol 1 for T3 Code: each prompt step runs as a T3 thread of its own, on the worktree teamai prepared,
//  where the person can watch it, steer it or stop it. It runs no command: a command step goes to another runtime of
//  the driver definition, or to the host slot (teamai-t3 declares no other), and a prompt step with setup needs a
//  runtime that runs both.
//
//    init     connect to the environment, signing in when attended; offer the tools its provider instances run, and
//             to judge with them best effort (a confined prompt)
//    open     the checkout must be a T3 project; the place is that project and the attempt's worktree. With no view,
//             the place of a confined prompt, which needs no project
//    prompt   t3_thread_launch (existing_worktree, auto or a tighter runtime_mode, clientRequestId = op), then t3_thread_wait
//             until the run and the work it delegated settle; the result file and the tool's transcript end it
//             confined: an idle scratch thread, its folder filled with a read-only copy of `dir`, then briefed to read
//             only that; its last message is the reply
//    cancel   stop the thread                     reattach  the ops and the thread, from the journal
//    wake     launch a fleet member's thread on a linked environment that has the repository, and forget it (wake.ts)
//    collect  nothing to copy: the worktree, the result and the transcript are already on this machine. A thread that
//             ended stays in the person's active threads, since a later step may continue its conversation
//    close    stop each thread the runtime has not seen stop, whichever process launched it, settle each thread that
//             ended, once T3 holds no run of it, and remove a judge's copy, and each project teamai added
//             for a folder of its own that teamai has removed since
//
//  A thread the journal holds stays the runtime's to stop until it saw that thread stop: no failure path forgets it.
//

type RuntimeMode = (typeof RUNTIME_MODES)[number];

/** A mode the runtime runs steps in. In `recover` it only stops and closes what its journal holds; `check` runs nothing. */
export type WorkMode = Exclude<RuntimeMode, 'recover' | 'check'>;

export interface Connected {
  ok: true;
  t3: T3;
  /** Which sign-in the connection uses, as `signInOf` names it. */
  signIn: string;
}

export interface ServeOptions {
  write(message: RuntimeMessage): void;
  journal: Journal;
  /**
   * Connects to the environment for a run in `mode`, signing in when it has no valid sign-in. `recover`
   * signs in never: it only stops what an earlier run left. A failure names why and what the person does about it.
   */
  connect(how: { mode: WorkMode | 'recover'; access: SignInAccess }): Promise<Connected | { ok: false; error: RuntimeFailure }>;
  /**
   * Whether a run could start now with `access`, for a `check` init: T3 Code answers, and teamai keeps a sign-in that
   * grants it or finds a `t3` command to sign in with. It signs in never, runs no command and writes nothing.
   */
  canStart(how: { access: SignInAccess }): Promise<{ ok: true } | { ok: false; error: RuntimeFailure }>;
  /** The T3 thread the run was started from, when it was (T3 sets T3CODE_THREAD_ID in its sessions). */
  startedFrom?: string;
  /** T3 Code's data directory, where the member's settings are. */
  t3Home: string;
  /** The home of the user T3 Code runs as, where a provider instance with no `homePath` keeps its tool's sessions. */
  t3UserHome: string;
  /** The member's home as teamai runs, which the tool homes teamai gives are under. */
  home: string;
  /**
   * The process's environment: its CLAUDE_CONFIG_DIR or CODEX_HOME moves a base tool's home, and serving removes the
   * variable teamai marks a runtime start with.
   */
  env: Record<string, string | undefined>;
  /** The lock file that keeps two runtimes on this machine from adding the same T3 provider instance. */
  settingsLock: string;
  /** The `t3` command, which adds and removes a project as the member does. */
  t3Cli: T3Command;
  /** The projects teamai added for folders of its own, which it removes once it removed their folder. */
  added: AddedProjects;
  /** Where teamai started the runtime: the checkout of the run when `init` names none. */
  cwd: string;
}

/** What stopping, looking up and settling a thread need of T3: the connection, the environment links name, and the sign-in. */
export interface Reached {
  t3: T3;
  environment: Environment;
  /** Which sign-in this runtime's calls go out under. */
  signIn: string;
}

/** A connection that runs steps, opened by `init` in a mode for new work. */
export interface Session extends Reached {
  mode: WorkMode;
  /** The provider instance each offered tool or tool instance runs on, by its name. */
  instances: Map<string, Provider>;
  /** The tool instances offered with no provider instance yet, which the first open that runs one adds. */
  pending: Map<string, NewInstance>;
  /** The mode `runtime_mode` sets; none: the member's T3 default for the place's project. */
  runtimeMode: StepMode | undefined;
  /** The run's checkout, as `init` names it, else the folder teamai started the runtime in. */
  checkout: string;
  /**
   * The instance and model of the T3 thread the run was started from, which take the place of the member's T3 default:
   * none when they are that default, which T3 applies itself, or when this runtime does not offer that instance.
   */
  threadModel: ModelSelection | undefined;
  /** Whether init offered `tokens`: then a finished prompt whose tokens the runtime cannot read says why. */
  offersTokens: boolean;
  /** Every variable each tool's command reads its home from, by the name a step gives it, as teamai sent it in init. */
  homeEnv: InitHomeEnv;
}

export type Reach = { ok: true; reached: Reached } | { ok: false; failure: RuntimeFailure };

/** What the runtime's modules share of one runtime process: its options, journal, ledger and places, and its session. */
export interface Serving {
  options: ServeOptions;
  journal: Journal;
  /** Each op's one end, and what this process knows of each: the prompts it runs and cancels it retries, by op. */
  ledger: OpLedger<Running>;
  /** The open and the launches under way in each place, and the places the person released. */
  places: PlaceWork;
  write(message: RuntimeMessage): void;
  /** A line for the person, about the operation or the place it names: teamai shows it as it runs. */
  notice(message: string, about: { op?: OpId; handle?: string }): void;
  fail(op: OpId, failure: RuntimeFailure): void;
  /** The connection init opened in a mode for new work, once it did. */
  session(): Session | undefined;
  /** T3, for a request that needs it: the session init opened, or in recover mode a connection made now. */
  reach(): Promise<Reach>;
}

export function serve(options: ServeOptions): Promise<number> {
  const { journal } = options;
  const ledger = opLedger<Running>({ name: 't3', write: options.write });
  const places = placeWork();
  const { write } = ledger;
  let session: Session | undefined;
  /**
   * Opened in recover mode: the connection a cancel or a close makes once it needs T3, which init never does, so a
   * stop starts whatever the sign-in or T3 Code's state. A failed one is tried again by the next request.
   */
  let recovering: { connecting?: Promise<Reach> } | undefined;

  /** A line for the person, about the operation or the place it names: teamai shows it as it runs. */
  const notice = (message: string, about: { op?: OpId; handle?: string }): void => write({ event: 'notice', ...about, message });

  /** Connects in recover mode: with the sign-in teamai keeps, never signing in, since it only stops what an earlier run left. */
  const connectToRecover = async (): Promise<Reach> => {
    const connected = await options.connect({ mode: 'recover', access: 'auto' });

    if (!connected.ok) return { ok: false, failure: connected.error };

    try {
      return { ok: true, reached: { t3: connected.t3, environment: await connected.t3.environment(), signIn: connected.signIn } };
    } catch (error) {
      await connected.t3.close().catch(() => {});

      return { ok: false, failure: { code: 't3_unavailable', message: `T3 Code did not say which environment it runs: ${error instanceof Error ? error.message : String(error)}` } };
    }
  };

  /** T3, for a request that needs it: the session init opened, or in recover mode a connection made now. */
  const reach = async (): Promise<Reach> => {
    if (session) return { ok: true, reached: session };

    if (!recovering) return { ok: false, failure: { code: 't3_unavailable', message: 'Runtime t3 did not start, so it has no connection to T3 Code.' } };
    const connecting = recovering.connecting ?? connectToRecover();
    recovering.connecting = connecting;
    const reached = await connecting;

    if (!reached.ok && recovering.connecting === connecting) delete recovering.connecting;

    return reached;
  };

  const fail = (op: OpId, failure: RuntimeFailure): void => ledger.end({ op, state: 'failed', failure });

  const serving: Serving = { options, journal, ledger, places, write, notice, fail, session: () => session, reach };
  const adder = instanceAdder({ options, notice });
  const talks = conversations({ serving, adder });
  const at = placeHandlers({ serving, adder, conversations: talks });
  const woken = wakes({ serving });

  return serveRuntime({
    name: 't3',
    env: options.env,
    ledger,
    handlers: {
      init: offer({ serving, adder, start: (opened) => { session = opened; }, recover: () => { recovering = {}; } }),
      open: at.open,
      exec: async (request) => {
        write({ op: request.op, event: 'accepted' });
        fail(request.op, { code: 'exec_unsupported', message: 'Runtime t3 runs prompt steps as T3 Code threads and runs no command (can.exec: false).' });
      },
      prompt: talks.prompt,
      wake: woken.wake,
      cancel: async (request) => { if (!woken.cancel(request.op)) await talks.cancel(request.op); },
      collect: at.collect,
      reattach: at.reattach,
      close: at.close,
    },
    // An op a record holds or may hold already has its outcome, or gets it from what runs it.
    holds: (op) => journal.placeOf(op).kind !== 'missing',
    stopped: 'its T3 thread',
    debug: (line) => process.stderr.write(`${line}\n`),
  });
}

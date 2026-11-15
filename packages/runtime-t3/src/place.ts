import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OpState, RuntimeDisplay, RuntimeFailure, RuntimeRequest } from '@teamai/runtime-protocol';
import { registerThrough, WRAPPER_PREFIX } from '@teamai/runtime-kit/outer';
import { endedIn, stillRuns, STOP_WAIT_MS, tasksOf, TERMINAL, threadDisplay, threadLink, whyNotStopped, type Conversations } from './conversation.js';
import type { InstanceAdder } from './instances.js';
import { unreadableFailure, type LaunchRecord, type PlaceRecord, type ThreadRecord } from './journal.js';
import { removeCopies } from './judge.js';
import type { Reach, Reached, Serving } from './runtime.js';
import { CLOCK_SLACK_MS } from './sessions.js';
import { projectSettings, readSettings } from './settings.js';
import { T3Error, type Environment, type ListedThread, type Project, type T3 } from './t3.js';
import { within } from './within.js';

// ─── A place ───
//
//  The place of a step is its T3 project and the attempt's worktree; a judge's place needs no project. Collect leaves
//  the threads that ended there in the person's active threads, since a later step may continue one; close stops each
//  thread the runtime has not seen stop, settles every thread that ended, and removes a judge's copy and each project
//  teamai added for a folder of its own that teamai has removed since.
//

/** How long `t3 project add` may take before an open gives up on it. */
const PROJECT_ADD_MS = 10_000;

const execFileAsync = promisify(execFile);

/** The main checkout of the repository `worktree` belongs to. */
async function mainCheckout(worktree: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);

  return path.dirname(stdout.trim());
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** The T3 project whose folder is `folder`, among `projects`; one T3 deleted does not count. */
function projectOf(projects: Project[], folder: string): Project | undefined {
  return projects.find((candidate) => !candidate.deletedAt && realpath(candidate.workspaceRoot) === realpath(folder));
}

/** The T3 project of the checkout `dir` belongs to, or none when it is no project, or no checkout. */
export async function projectAt(t3: T3, dir: string): Promise<Project | undefined> {
  const [root, projects] = await Promise.all([mainCheckout(dir).catch(() => undefined), t3.projects()]);

  return root === undefined ? undefined : projectOf(projects, root);
}

/** What the run's details show of a place before a thread runs in it. */
function placeDisplay(place: PlaceRecord, environment: Environment): RuntimeDisplay {
  if (place.kind === 'confined') return { label: 'T3 · judge', fields: { environment: environment.label } };

  return { label: `T3 · ${place.projectTitle}`.slice(0, 80), fields: { environment: environment.label, project: place.projectTitle } };
}

/** What `promise` gave within `ms`, or that it had not by then; it may still settle later. */
/** Whether `folder` is gone. One teamai cannot look at, such as one on a volume that is not mounted, may still be in use. */
function isGone(folder: string): boolean {
  try {
    fs.statSync(folder);

    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  }
}

/** The handle of the place `open` makes for a run's attempt. */
export function handleFor({ run, attempt }: { run: string; attempt: string }): string {
  return `t3-${run}-${attempt}`;
}

/** The requests about a place: open, collect, reattach and close. */
export function placeHandlers({ serving, adder, conversations }: { serving: Serving; adder: InstanceAdder; conversations: Conversations }) {
  const { options, journal, ledger, places, write, notice, fail } = serving;
  const { journalOp, stopRunning, resolveLaunch } = conversations;

  /** The connection each place through a sandbox registered its tool on, in this process, by handle. */
  const registrations = new Map<string, { close(): void }>();

  /** Registers the step's tool of `handle` on the attempt socket `outer` names, once in this process; or says why not. */
  const register = async (handle: string, outer: string): Promise<string | undefined> => {
    if (registrations.has(handle)) return undefined;
    const registered = await registerThrough({ outer, agent: null });

    if (!registered.ok) return registered.why;
    registrations.set(handle, registered);

    return undefined;
  };

  const unregister = (handle: string): void => {
    registrations.get(handle)?.close();
    registrations.delete(handle);
  };

  /** Why an open through a sandbox fails when the step's tool could not be registered on its attempt socket. */
  const unregistered = (why: string): RuntimeFailure => ({
    code: 'open_failed',
    message: `Runtime t3 runs a tool through another runtime only on that runtime's attempt socket, and teamai could not register this step's tool on it (${why.replace(/\.$/, '')}), so the sandbox would refuse the tool. Run T3 through a sandbox provider that serves one: sbx, or docker 26.0.0 or later (25.0.5, 23.0.11) on Docker Desktop or on this Linux machine, on an image that holds node.`,
  });

  const open = async (request: Extract<RuntimeRequest, { type: 'open' }>): Promise<void> => {
    const session = serving.session();
    const handle = handleFor(request);
    places.reopen(handle);
    write({ op: request.op, event: 'accepted', handle });

    if (!session) {
      fail(request.op, { code: 'runtime_protocol', message: 'open came before a successful init.' });

      return;
    }

    // The provider instance of a tool instance teamai offered to add, on the first open that runs it.
    const instance = request.tool === undefined ? undefined : session.pending.get(request.tool);
    const ready = request.tool === undefined ? undefined : adder.instanceFor(session, request.tool, { op: request.op });

    if (request.tool !== undefined && ready) {
      const done = await ready;

      if (!done.ok) {
        fail(request.op, { code: 'open_failed', message: adder.notAdded(request.tool, instance, done) });

        return;
      }
    }

    // Through a sandbox, T3 starts teamai's wrapper in place of the step's tool, and the wrapper asks the sandbox to,
    // which starts only the tool registered on its attempt socket. Registered first, so a sandbox that serves no socket
    // leaves T3 with no provider instance for nothing; registered before the app can start the tool, so the sandbox
    // grants the wrapper its first ask.
    if (request.outer !== undefined && request.tool !== undefined) {
      if (adder.driverFor(session, request.tool) === 'codex') {
        return fail(request.op, { code: 'open_failed', message: `Runtime t3 runs only Claude through a sandbox: T3 Code starts Codex as an app server outside the step's folder, and teamai's wrapper cannot yet tell which attempt it belongs to. Run this step on T3 without through: sandbox, or on the sandbox runtime alone.` });
      }

      const why = await register(handle, request.outer);

      if (why !== undefined) return fail(request.op, unregistered(why));
      const wrapped = await adder.wrapperFor(session, request.tool, { op: request.op });

      if (!wrapped.ok) {
        fail(request.op, { code: 'open_failed', message: adder.notAdded(`${WRAPPER_PREFIX}${request.tool}`, undefined, wrapped) });

        return;
      }
    }

    const known = journal.read(handle);

    // Opening it afresh would forget the threads it holds.
    if (known.kind === 'unreadable') {
      fail(request.op, unreadableFailure(handle, known));

      return;
    }

    if (known.kind === 'found') {
      write({ op: request.op, event: 'ready', display: placeDisplay(known.place, session.environment) });

      return;
    }

    const view = request.view;

    // A confined prompt's place: its thread runs in a scratch folder of its own, in no project.
    if (!view) {
      const confined: PlaceRecord = { kind: 'confined', handle, run: request.run, attempt: request.attempt, ops: {}, threads: {}, launches: {} };
      journal.open(confined);
      write({ op: request.op, event: 'ready', display: placeDisplay(confined, session.environment) });

      return;
    }

    const s = session;
    let root: string;
    let projects: Project[];
    let runCheckout: string | undefined;

    try {
      [root, projects, runCheckout] = await Promise.all([mainCheckout(view.worktree), s.t3.projects(), mainCheckout(s.checkout).catch(() => undefined)]);
    } catch (error) {
      fail(request.op, { code: 'open_failed', message: `Could not match the worktree ${view.worktree} to a T3 Code project: ${error instanceof Error ? error.message : String(error)}` });

      return;
    }

    /**
     * The project of `folder`, added as the member adds one when T3 has none, saying so first; or why it could not be.
     * `added`: teamai added it for a folder of its own, not the checkout the run started in, so it removes the project
     * once the folder is gone. A checkout it cannot tell counts as the run's.
     */
    const projectFor = async (folder: string, { title, why }: { title?: string; why: string }): Promise<{ ok: true; project: Project } | { ok: false; reason: string }> => {
      const listed = projectOf(projects, folder);

      if (listed) return { ok: true, project: listed };
      notice(why, { op: request.op, handle });

      let refused: string | undefined;

      const signal = AbortSignal.timeout(PROJECT_ADD_MS);

      try {
        await options.t3Cli.run({ name: 'project add', args: ['project', 'add', '--base-dir', options.t3Home, ...(title ? ['--title', title] : []), folder], signal });
      } catch (error) {
        // A step opening beside this one may have added the folder first, which T3 refuses to add again.
        refused = signal.aborted
          ? `t3 project add did not finish within ${PROJECT_ADD_MS / 1_000} s`
          : (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
      }

      try {
        projects = await s.t3.projects();
      } catch (error) {
        return { ok: false, reason: refused ?? (error instanceof Error ? error.message : String(error)).replace(/\.$/, '') };
      }

      const added = projectOf(projects, folder);

      if (added && runCheckout !== undefined && realpath(folder) !== realpath(runCheckout)) options.added.add({ id: added.id, folder: realpath(folder) });

      if (added) return { ok: true, project: added };

      return { ok: false, reason: refused ?? 't3 project add finished, and T3 Code still lists no such project' };
    };

    const checkout = await projectFor(root, { why: `Adding ${root} to T3 Code as a project, so its steps can run there.` });

    if (!checkout.ok) {
      fail(request.op, { code: 'not_a_t3_project', message: `${root} is not a project in T3 Code ${s.environment.label}, and teamai could not add it (${checkout.reason}). Add it in T3 Code (Add project), or run t3 project add ${root}, then start the workflow again.` });

      return;
    }

    const settings = readSettings(options.t3Home);
    const scripts = projectSettings(settings, checkout.project).scripts;
    // The step's folder is the project's own: the checkout itself, a clone, a team repo's clone.
    const own = realpath(view.worktree) === realpath(root);
    let project = checkout.project;
    let binding: 'existing_worktree' | 'root' = own ? 'root' : 'existing_worktree';

    // T3 runs the project's setup script in every worktree a thread binds, and its output would be committed as the
    // step's work. On a project of its own, the worktree is the project's folder, which T3 runs no setup script in.
    if (!own && scripts.setup !== undefined) {
      const separate = await projectFor(view.worktree, {
        title: `${checkout.project.title} · teamai ${request.run}`,
        why: `T3 Code runs the setup script "${scripts.setup}" of ${checkout.project.title} in each worktree a thread opens on, so teamai adds the step's worktree ${view.worktree} to T3 Code as a project of its own, where that script does not run.`,
      });

      if (!separate.ok) {
        fail(request.op, { code: 'open_failed', message: `T3 Code runs the setup script "${scripts.setup}" of ${checkout.project.title} in each worktree a thread opens on, and teamai could not add the step's worktree ${view.worktree} as a project of its own, where it does not run (${separate.reason}). Run t3 project add ${view.worktree}, or turn off "Run on worktree creation" for "${scripts.setup}" in the project's settings in T3 Code, then start the workflow again.` });

        return;
      }

      project = separate.project;
      binding = 'root';
    }

    const settle = project === checkout.project ? scripts.settle : projectSettings(settings, project).scripts.settle;

    const opened: PlaceRecord = {
      kind: 'worktree', handle, run: request.run, attempt: request.attempt, projectId: project.id, projectTitle: project.title, binding,
      ...(settle !== undefined && { settleScript: settle }), settingsProjectId: checkout.project.id, ops: {}, threads: {}, launches: {},
      ...(request.outer !== undefined && { through: { outer: request.outer, toolHome: view.toolHome } }),
    };

    if (places.isReleased(handle)) {
      fail(request.op, { code: 'open_failed', message: `teamai released ${handle} while T3 Code was still opening it, so the runtime does not keep it.` });

      return;
    }

    journal.open(opened);
    write({ op: request.op, event: 'ready', display: placeDisplay(opened, s.environment) });
  };

  /**
   * Settles the threads of the tasks `thread` delegated, at any depth, that T3 holds no run of: T3 leaves them unsettled
   * when it settles the thread that delegated them. A list or a settle T3 refuses is said in a notice and fails nothing.
   */
  const settleTasks = async (handle: string, s: Reached, thread: ThreadRecord): Promise<void> => {
    const link = `${threadLink(s.environment, thread.threadId)} ("${thread.title}")`;
    let tasks: ListedThread[];

    try {
      // The tasks it delegated started after it, so only threads that changed since its launch can be theirs.
      tasks = tasksOf(await s.t3.unsettledThreadsSince(thread.launchedAt - CLOCK_SLACK_MS), thread.threadId);
    } catch (error) {
      return notice(`teamai could not list the tasks the T3 thread ${link} delegated, so they stay in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}`, { handle });
    }

    for (const task of tasks) {
      if (task.status !== null && task.status !== 'idle' && !TERMINAL.has(task.status)) continue;

      try {
        await s.t3.settle(task.threadId);
      } catch (error) {
        if (!(error instanceof T3Error && error.threadGone)) notice(`teamai could not settle the T3 thread ${threadLink(s.environment, task.threadId)}, a task ${link} delegated, so it stays in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}`, { handle });
      }
    }
  };

  /**
   * Whether close settles `thread`: it ended and was not settled yet, and it is no turn of a conversation whose earlier
   * place is still open, which settles it when it closes.
   */
  const toSettle = (thread: ThreadRecord): boolean => thread.ended !== undefined && !thread.ended.settlement && !(thread.turnOf && journal.read(thread.turnOf.handle).kind === 'found');

  /**
   * Settles each thread of `handle` that close settles and that T3 holds no run of, once, with the tasks it delegated:
   * a thread the runtime has not seen stop, or one the person started again, stays. A settle T3 refuses is said once, in
   * a notice, and fails nothing.
   */
  const settleEnded = async (handle: string, s: Reached): Promise<void> => {
    const known = journal.writable(handle);

    if (!known) return;
    const script = known.kind === 'worktree' ? known.settleScript : undefined;

    for (const [op, thread] of Object.entries(known.threads)) {
      if (!toSettle(thread)) continue;
      let outcome: NonNullable<NonNullable<ThreadRecord['ended']>['settlement']>;

      if (script !== undefined) {
        // T3 would run the script in the step's folder, before teamai commits it, so the thread stays where it is.
        notice(`teamai leaves the T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}") in T3 Code's active threads: settling it would run the project's script "${script}" in the step's folder.`, { handle });
        outcome = 'skipped';
      } else {
        try {
          const { status } = await s.t3.thread(thread.threadId);

          if (status !== null && status !== 'idle' && !TERMINAL.has(status)) continue;
          await s.t3.settle(thread.threadId);
          await settleTasks(handle, s, thread);
          outcome = 'settled';
        } catch (error) {
          // A thread T3 no longer has is in nobody's active threads.
          outcome = error instanceof T3Error && error.threadGone ? 'settled' : 'failed';

          if (outcome === 'failed') notice(`teamai could not settle the T3 thread ${threadLink(s.environment, thread.threadId)} ("${thread.title}"), so it stays in T3 Code's active threads: ${error instanceof Error ? error.message : String(error)}`, { handle });
        }
      }

      await journalOp({ handle, op }, (conversation) => conversation?.thread && { ...conversation, thread: { ...conversation.thread, ended: { settlement: outcome } } });
    }
  };

  /**
   * Removes, with its threads, each project teamai added for a folder of its own that is gone, as far as `deadline`
   * allows: its threads point at nothing. One T3 no longer has is forgotten; one T3 does not remove stays listed for
   * the next close, and is said in a notice about `handle`.
   */
  const removeGoneProjects = async (handle: string, deadline: number): Promise<void> => {
    for (const project of options.added.list()) {
      if (!isGone(project.folder) || deadline <= Date.now()) continue;

      try {
        await options.t3Cli.run({ name: 'project remove', args: ['project', 'remove', '--base-dir', options.t3Home, '--force', project.id], signal: AbortSignal.timeout(deadline - Date.now()) });
        options.added.drop(project.id);
      } catch (error) {
        const reaching = await within(serving.reach(), Math.max(deadline - Date.now(), 0));
        const listing = reaching.answered && reaching.value.ok ? await within(reaching.value.reached.t3.projects().catch(() => undefined), Math.max(deadline - Date.now(), 0)) : undefined;
        const listed = listing?.answered ? listing.value : undefined;

        if (listed && !listed.some((one) => one.id === project.id && !one.deletedAt)) options.added.drop(project.id);
        else notice(`teamai could not remove the T3 project it added for ${project.folder}, which teamai has removed, so its threads stay in T3 Code (${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}). Remove it in T3 Code, or run t3 project remove --force ${project.id}.`, { handle });
      }
    }
  };

  /**
   * Ends the place within STOP_WAIT_MS. Each launch T3 never answered is looked up, and each thread the runtime has not
   * seen stop is stopped first, all at once; while one cannot be, or T3 Code does not answer in time, the place stays,
   * with a judge's copy, and close fails. A lookup or settle that answers late still journals what it found while the
   * place's record is there. With `release`, the person checked that nothing of the attempt runs and let it go: a close
   * that fails still forgets the place, its record and a judge's copy, and says why it failed.
   */
  const close = async (handle: string, { release }: { release: boolean }): Promise<void> => {
    // A released place is forgotten, so its failure no longer says it is kept: the cancel before named its threads.
    const failClose = (failure: RuntimeFailure): void => {
      if (!release) return write({ event: 'close_failed', handle, failure });
      forget(handle);
      write({
        event: 'close_failed', handle,
        failure: { code: failure.code, message: `Runtime t3 forgot ${handle}, as you released it, though T3 Code did not confirm it closed (${failure.code}). If one of its T3 threads still runs, stop it in T3 Code with its Stop button.` },
      });
    };

    const deadline = Date.now() + STOP_WAIT_MS;
    const left = (): number => Math.max(deadline - Date.now(), 0);
    const late = `T3 Code did not answer within ${STOP_WAIT_MS / 1_000} s`;

    // An open or a launch still under way would make what close then never sees: a record, or a thread it starts.
    if (!(await places.settled(handle, left()))) {
      return failClose({ code: 't3_unavailable', message: `teamai was still opening ${handle} or launching a T3 thread in it, and ${late} of the close, so teamai keeps the place. Run teamai workflow cancel again once T3 Code answers.` });
    }

    const read = journal.read(handle);

    if (read.kind === 'unreadable') return failClose(unreadableFailure(handle, read));
    let known = read.kind === 'found' ? read.place : undefined;

    /** T3, or why not: a connection that does not come by the deadline counts as none. */
    const reachInTime = async (): Promise<Reach> => {
      const reaching = await within(serving.reach(), left());

      return reaching.answered ? reaching.value : { ok: false, failure: { code: 't3_unavailable', message: late } };
    };

    if (known) {
      const { run } = known;
      const looked = known;

      // Every launch and thread is journaled with its op.
      const launches = Object.values(looked.ops).flatMap(({ op }) => {
        const launch = looked.launches[op];

        return launch ? [{ op, launch }] : [];
      });

      if (launches.length > 0) {
        const lookUp = (launch: LaunchRecord) => `teamai launched the T3 thread "${launch.title}" and T3 Code never answered, so it may run`;
        const reached = await reachInTime();

        // Nothing here can find the thread without T3 Code.
        if (!reached.ok) return failClose({ code: 't3_unavailable', message: `${lookUp(launches[0].launch)}, and teamai could not reach T3 Code to look for it (${reached.failure.code}). Open T3 Code, then run teamai workflow cancel ${run} again.` });

        const lookups = await Promise.all(launches.map(async ({ op, launch }): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
          try {
            const resolving = await within(resolveLaunch(reached.reached, looked, op, launch), left());

            if (!resolving.answered) return { ok: false, failure: { code: 't3_unavailable', message: `${lookUp(launch)}, and T3 Code did not say within ${STOP_WAIT_MS / 1_000} s whether it launched it when teamai looked. Run teamai workflow cancel ${run} again once T3 Code answers.` } };

            return resolving.value.ok ? { ok: true } : resolving.value;
          } catch (error) {
            return { ok: false, failure: { code: 't3_unavailable', message: `${lookUp(launch)}, and T3 Code did not say whether it launched it when teamai looked: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, '')}. Run teamai workflow cancel ${run} again once T3 Code answers.` } };
          }
        }));

        const refused = lookups.find((one) => !one.ok);

        if (refused && !refused.ok) return failClose(refused.failure);
        known = journal.writable(handle) ?? known;
      }

      const resolved = known;

      const owned = Object.values(resolved.ops).flatMap(({ op }) => {
        const thread = resolved.threads[op];

        return thread && !thread.ended ? [{ op, thread }] : [];
      });

      if (owned.length > 0) {
        const reached = await reachInTime();
        const [{ thread: first }] = owned;

        // Nothing here can stop a thread, or tell that it ended, without T3 Code.
        if (!reached.ok) return failClose({ code: 't3_unavailable', message: `The T3 thread "${first.title}" (${first.threadId}) may still run, and teamai could not reach T3 Code to stop it (${reached.failure.code}). Open T3 Code, then run teamai workflow cancel ${run} again.` });
        const s = reached.reached;

        const stops = await Promise.all(owned.map(async ({ op, thread }) => {
          const live = ledger.running(op);
          // A prompt still running here ends cancelled once its thread stopped, and is followed on while it did not.
          const why = live ? await stopRunning({ s, state: live, op, thread, cancelling: false, deadline }) : await whyNotStopped(s.t3, thread, deadline);

          if (why !== undefined) return { thread, why };
          await journalOp({ handle, op }, (conversation) => conversation && endedIn(conversation));

          return undefined;
        }));

        const still = stops.find((stop) => stop !== undefined);

        if (still) return failClose({ code: 'thread_still_runs', message: `${stillRuns(s, still.thread, still.why)}.` });
      }

      // Every thread of the place has ended now. Without T3 Code, they stay unsettled.
      if (Object.values(journal.writable(handle)?.threads ?? {}).some(toSettle)) {
        const reaching = await within(serving.reach(), left());
        const settling = reaching.answered && reaching.value.ok ? await within(settleEnded(handle, reaching.value.reached), left()) : undefined;

        if (!reaching.answered || settling?.answered === false) return failClose({ code: 't3_unavailable', message: `${late} while teamai settled the place's ended threads, so it keeps the place. Run teamai workflow cancel ${run} again once T3 Code answers.` });
      }

      known = journal.writable(handle) ?? known;
    }

    removeCopies(known);
    await removeGoneProjects(handle, deadline);
    journal.remove(handle);
    unregister(handle);

    for (const { op } of Object.values(known?.ops ?? {})) ledger.forget(op);
    write({ event: 'closed', handle });
  };

  /** Forgets a place the person released: its record, readable or not, and a judge's copy. */
  const forget = (handle: string): void => {
    const known = journal.writable(handle);
    places.release(handle);
    removeCopies(known);
    journal.remove(handle);
    unregister(handle);

    for (const { op } of Object.values(known?.ops ?? {})) ledger.forget(op);
  };

  const collect = async (request: Extract<RuntimeRequest, { type: 'collect' }>): Promise<void> => {
    const read = journal.read(request.handle);

    if (read.kind === 'unreadable') {
      write({ event: 'collect_failed', handle: request.handle, failure: unreadableFailure(request.handle, read) });

      return;
    }

    // A later step may continue a thread that ended here, so close settles it, not collect.
    write({ event: 'collected', handle: request.handle });
  };

  const reattach = async (request: Extract<RuntimeRequest, { type: 'reattach' }>): Promise<void> => {
    // The journal alone answers: only a place it no longer holds is gone, whether or not T3 Code can be reached. One
    // whose record cannot be read may hold live threads, so the reattach fails, saying why.
    const read = journal.read(request.handle);

    if (read.kind === 'missing') {
      write({ event: 'gone', handle: request.handle });

      return;
    }

    if (read.kind === 'unreadable') {
      write({ event: 'failed', handle: request.handle, failure: unreadableFailure(request.handle, read) });

      return;
    }

    const known = read.place;
    const session = serving.session();
    // A restarted runtime registers the step's tool again: the sandbox's runtime may have restarted too, and forgotten it.
    const through = known.kind === 'worktree' ? known.through : undefined;
    const why = through && await register(request.handle, through.outer);

    if (why !== undefined) notice(`teamai could not register the step's tool of ${request.handle} again on the sandbox's attempt socket (${why.replace(/\.$/, '')}), so the sandbox refuses to start that tool until the place is opened again.`, { handle: request.handle });

    const latest = Object.values(known.threads).sort((a, b) => b.launchedAt - a.launchedAt)[0];
    const display = session && (latest ? threadDisplay(latest, session.environment) : placeDisplay(known, session.environment));
    // An op this process owns runs until it ends here, whatever its record says while that is being written.
    const stateOf = (kept: OpState): OpState => (ledger.running(kept.op) ? { op: kept.op, state: 'running' } : ledger.unkept(kept.op) ?? kept);
    write({ event: 'alive', handle: request.handle, ops: Object.values(known.ops).map(stateOf), ...(display && { display }) });
  };

  return {
    // An open that keeps no place, failed or released, ends the connection it registered on the sandbox's attempt socket.
    open: (request: Extract<RuntimeRequest, { type: 'open' }>) => places.track(handleFor(request), open(request).finally(() => {
      if (journal.read(handleFor(request)).kind !== 'found') unregister(handleFor(request));
    })),
    collect,
    reattach,
    close: (request: Extract<RuntimeRequest, { type: 'close' }>) => close(request.handle, { release: request.release === true }),
  };
}

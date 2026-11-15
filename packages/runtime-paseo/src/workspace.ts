import type { RuntimeDisplay, RuntimeFailure, RuntimeRequest } from '@teamai/runtime-protocol';
import type { Daemon } from './daemon/connect.js';
import { resolvedDir, type AgentPrompt, type Place } from './journal.js';
import { isStillRunning, isStopped, late, STOP_SETTLE_MS, withoutDaemon, type Conversations } from './conversation.js';
import type { ProcessState } from './process-state.js';
import type { EnsureProvider } from './providers.js';
import { openThrough } from './sandbox.js';

// ─── An attempt's place ──────────────────────────────────
//
//  The Paseo workspace an attempt runs in: opened once per attempt, one open at a time on a directory, a confined
//  prompt's directory adopted once its prompt comes, and closed once nothing it started runs. The last attempt on a
//  workspace teamai made archives it; one the member works in is never archived.
//

export type ConfinedPlace = Extract<Place, { kind: 'confined' }>;

/** The places of this process: each attempt's workspace, from its open to its close. */
export function workspaces(state: ProcessState, { ensureProvider, conversation }: { ensureProvider: EnsureProvider; conversation: Conversations }) {
  const { journal, ledger, write, fail, waiting, closeStops, opens, turns, creates, targets } = state;
  const { settle, cancelAgent, dispatch, agentDisplay } = conversation;

  /** Runs `task` once every open this process began before on `directory` has ended. */
  function inTurn<T>(directory: string, task: () => Promise<T>): Promise<T> {
    const key = resolvedDir(directory);
    const turn = (turns.get(key) ?? Promise.resolve()).then(task);
    const ended = turn.then(() => undefined, () => undefined);
    turns.set(key, ended);
    void ended.then(() => {
      if (turns.get(key) === ended) turns.delete(key);
    });

    return turn;
  }

  /** What the run's details show of a handle: the latest agent it runs, or the workspace before it runs one. */
  const displayOf = (handle: string, live: Daemon): RuntimeDisplay | undefined => {
    const place = journal.place(handle);

    if (!place) return undefined;
    const latest = journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [record] : [])).at(-1);

    if (latest) return agentDisplay(latest, place.workspace?.id, live);

    if (place.kind === 'confined') return { label: 'Paseo confined prompt, best-effort', fields: { daemon: `Paseo ${live.version}` } };

    // A worktree Paseo has not opened yet shows nothing until it has.
    if (!place.workspace) return undefined;

    return { label: `Paseo workspace ${place.workspace.name}`.slice(0, 80), fields: { workspace: place.workspace.id, daemon: `Paseo ${live.version}` } };
  };

  async function open(live: Daemon, request: Extract<RuntimeRequest, { type: 'open' }>): Promise<void> {
    const { op, run, attempt, view } = request;
    let handle = journal.handleOf(request);

    // A handle per attempt, kept before Paseo opens anything, so the open is accepted at once: two attempts on one
    // worktree share its workspace, and keep their own prompts. A confined prompt's place comes without a view: its
    // workspace adopts the prompt's directory once the prompt comes.
    if (!handle) {
      handle = `${view ? 'worktree' : 'confined'}/${run}/${attempt}`;
      journal.savePlace(handle, view ? { kind: 'worktree', run, attempt, cwd: view.worktree, runDir: view.runDir } : { kind: 'confined', run, attempt });
    }

    write({ op, event: 'accepted', handle });

    // The first open that runs a team instance init offered before its provider existed adds that provider; one through
    // a sandbox runs on the wrapper's provider instead.
    if (request.tool !== undefined && request.outer === undefined) {
      const failure = await ensureProvider(live, request.tool, op);

      if (failure) {
        fail(op, failure);

        return;
      }
    }

    const target = request.tool === undefined ? undefined : targets.get(request.tool);

    if (request.outer !== undefined && target) {
      const through = await openThrough(state, live, { ...request, outer: request.outer }, target);

      if ('code' in through) {
        fail(op, through);

        return;
      }

      const current = journal.place(handle);

      if (current?.kind === 'worktree') journal.savePlace(handle, { ...current, through });
    }

    const opened = handle;
    const place = journal.place(opened);

    if (place?.kind === 'worktree' && !place.workspace) {
      // One open at a time on a directory, in this runtime and across those on this journal, decides whether the
      // workspace there is the member's: an open in flight has made teamai's own before it journals it.
      const opening = inTurn(place.cwd, async (): Promise<RuntimeFailure | undefined> => {
        const unjournaled = (why: string): RuntimeFailure => ({
          code: 'workspace_failed',
          message: `teamai-runtime-paseo could not journal its open of ${place.cwd} before asking Paseo, so it opened nothing: ${why}. Make ${journal.root} writable, then run the step again.`,
        });

        const unopened = (why: string): RuntimeFailure => ({ code: 'workspace_failed', message: `Paseo could not open the worktree as a workspace: ${why}` });
        // A close the person released while Paseo was slow to answer forgot the attempt, and nothing journals it again.
        const isReleased = (): boolean => journal.place(opened) === undefined;
        const releasedBefore: RuntimeFailure = { code: 'workspace_failed', message: `The attempt was released before Paseo opened ${place.cwd}, so nothing was opened there.` };
        const releasedAfter: RuntimeFailure = { code: 'workspace_failed', message: `The attempt was released while Paseo opened ${place.cwd}; archive its workspace in the Paseo app if no other attempt runs there.` };
        let release: () => void;
        let member = place.member;

        try {
          release = await journal.holdOpen(place.cwd);
        } catch (error) {
          return unjournaled(error instanceof Error ? error.message : String(error));
        }

        try {
          // Read under the hold, which every way out of this block releases.
          try {
            member ??= journal.memberOn(place.cwd, handle);
          } catch (error) {
            return unjournaled(error instanceof Error ? error.message : String(error));
          }

          if (member === undefined) {
            let isOpenThere: boolean;

            try {
              isOpenThere = await live.isOpen(place.cwd);
            } catch (error) {
              return unopened(error instanceof Error ? error.message : String(error));
            }

            // An open that took this one's hold over while Paseo was slow to answer decided first, and may have made
            // teamai's own workspace there since, which Paseo then answers open.
            try {
              member = journal.memberOn(place.cwd, handle) ?? isOpenThere;
            } catch (error) {
              return unjournaled(error instanceof Error ? error.message : String(error));
            }
          }

          if (isReleased()) return releasedBefore;

          try {
            journal.savePlace(opened, { ...place, member });
          } catch (error) {
            return unjournaled(error instanceof Error ? error.message : String(error));
          }

          try {
            const workspace = await live.workspace(place.cwd);

            if (isReleased()) return releasedAfter;
            journal.savePlace(opened, { ...place, member, workspace: { id: workspace.id, name: workspace.name }, cwd: workspace.directory });

            return undefined;
          } catch (error) {
            return unopened(error instanceof Error ? error.message : String(error));
          }
        } finally {
          release();
        }
      });

      opens.set(handle, opening.then(() => undefined));
      const failure = await opening;
      opens.delete(handle);

      if (failure) {
        fail(op, failure);

        return;
      }
    }

    const display = displayOf(handle, live);
    write({ op, event: 'ready', ...(display && { display }) });
  }

  /**
   * Opens a confined prompt's directory as its place's workspace, and journals it there. It is kept with the worktree
   * opens, so a close waits for it and archives the workspace, though the prompt that asked for it was stopped.
   */
  const adopt = (live: Daemon, handle: string, place: ConfinedPlace, dir: string): Promise<Awaited<ReturnType<Daemon['workspace']>> | RuntimeFailure> => {
    const adopting = (async () => {
      try {
        const workspace = await live.workspace(dir);

        // A place the person released meanwhile stays forgotten.
        if (journal.place(handle) !== undefined) journal.savePlace(handle, { ...place, workspace: { id: workspace.id, name: workspace.name } });

        return workspace;
      } catch (error) {
        return { code: 'workspace_failed', message: `Paseo could not open the confined prompt's directory as a workspace: ${error instanceof Error ? error.message : String(error)}` };
      }
    })();

    const settled = adopting.then(() => undefined);
    opens.set(handle, settled);
    void settled.then(() => {
      if (opens.get(handle) === settled) opens.delete(handle);
    });

    return adopting;
  };

  /** Cancels a prompt's agent that is still running, or says why it may still run; one already stopped needs nothing. */
  const stopAgent = async (live: Daemon, record: AgentPrompt, deadline: number): Promise<RuntimeFailure | undefined> => {
    if (isStopped(await Promise.race([live.agent(record.create.agentId).catch(() => undefined), late(deadline)]))) return undefined;

    return cancelAgent(live, record, deadline);
  };

  /**
   * Stops what an attempt's place runs, its failed prompts' agents included, since a failed cancel leaves its agent
   * running, or says why something may still run. The last attempt on a Paseo workspace archives it, which stops what
   * still runs there; an attempt that shares it stops only its own agents, as does one on a workspace the member had
   * open, which teamai never archives.
   */
  /**
   * Stops a place's agents: by archiving its workspace when nobody else works there, else one by one. Says what it left on
   * purpose, the agents it stopped in a workspace the member works in, or why it could not stop them.
   */
  async function stopPlace(live: Daemon, handle: string, place: Place, deadline: number): Promise<RuntimeFailure | { kept: string[] } | undefined> {
    // A confined prompt's place before its prompt came: no workspace, so no agent.
    if (!place.workspace) return undefined;
    const agents = journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [record] : []));

    /**
     * Stops this handle's agents and leaves the workspace open: to another handle, whose close archives it, or to the
     * member who works there, where the stopped agents stay.
     */
    const stopOwn = async ({ isMembers }: { isMembers: boolean }): Promise<RuntimeFailure | { kept: string[] }> => {
      const refusals = (await Promise.all(agents.map((record) => stopAgent(live, record, deadline)))).flatMap((failure) => (failure ? [failure.message] : []));

      return refusals.length > 0 ? { code: 'close_failed', message: refusals.join(' ') } : { kept: isMembers ? keptOf(handle) : [] };
    };

    if (place.kind === 'worktree' && place.member) return stopOwn({ isMembers: true });

    if (!journal.handlesIn({ id: place.workspace.id, ...(place.kind === 'worktree' && { directory: place.cwd }) }).every((other) => other === handle)) return stopOwn({ isMembers: false });

    const { id: workspaceId, name } = place.workspace;

    // The member may work there too, as when they open the same directory in the app, which answers this workspace: an
    // archive would stop their agents, so the close stops only its own and leaves the workspace to them.
    const listing = (async (): Promise<{ ids: string[] } | { unlisted: string }> => {
      try {
        return { ids: await live.memberAgentsIn(workspaceId) };
      } catch (error) {
        return { unlisted: error instanceof Error ? error.message : String(error) };
      }
    })();

    const listed = await Promise.race([listing, late(deadline)]);

    if (listed === 'late' || 'unlisted' in listed) {
      const why = listed === 'late' ? `did not answer within ${STOP_SETTLE_MS / 1000} s` : `failed: ${listed.unlisted}`;

      return { code: 'close_failed', message: `Paseo's list of the agents in workspace ${name} (${workspaceId}) ${why}, so teamai cannot tell whether the member works there, and archived nothing. Close the step again; if it still fails, archive the workspace in the Paseo app.` };
    }

    if (listed.ids.length > 0) return stopOwn({ isMembers: true });

    const archiving = (async (): Promise<{ refused?: string }> => {
      try {
        await live.archive(workspaceId);

        return {};
      } catch (error) {
        return { refused: error instanceof Error ? error.message : String(error) };
      }
    })();

    const archived = await Promise.race([archiving, late(deadline)]);

    if (archived === 'late') {
      return { code: 'close_failed', message: `Paseo did not answer the archive of workspace ${name} (${workspaceId}) within ${STOP_SETTLE_MS / 1000} s. Its agents may still run; archive it in the Paseo app.` };
    }

    if (archived.refused !== undefined) {
      return { code: 'close_failed', message: `Paseo did not archive workspace ${name} (${workspaceId}): ${archived.refused}. Its agents may still run; archive it in the Paseo app.` };
    }

    const running = (await Promise.all(agents.map(async ({ create: { agentId } }) => ((await isStillRunning(live, agentId, deadline)) ? [agentId] : [])))).flat();

    if (running.length === 0) return undefined;

    return {
      code: 'close_failed',
      message: `Paseo archived workspace ${place.workspace.name} (${place.workspace.id}), but agent ${running.join(', ')} still ran ${STOP_SETTLE_MS / 1000} s later. It may still change the worktree; stop it in the Paseo app.`,
    };
  }

  /**
   * Why a close keeps a place: a create it sent that Paseo has not shown the agent of, as when the create failed, may still
   * start that agent. A lookup that finds the agent confirms it, so the close stops it; one that finds none, fails or
   * comes late proves nothing. Only the person can tell a create Paseo refused, so the failure names how to release the attempt.
   */
  const unseen = async (live: Daemon, handle: string, place: Place, deadline: number): Promise<RuntimeFailure | undefined> => {
    const sent = journal.promptsOf(handle).flatMap(({ op, record }) => (record.kind === 'agent' && record.dispatched === 'unconfirmed' ? [{ op, record }] : []));

    const missing = (await Promise.all(sent.map(async ({ op, record }) => {
      const agent = await Promise.race([live.agent(record.create.agentId).catch(() => undefined), late(deadline)]);

      if (!agent || agent === 'late') return [record];
      dispatch(op, 'confirmed');

      return [];
    }))).flat();

    if (missing.length === 0) return undefined;

    return {
      code: 'close_failed',
      message: missing.map((record) => [
        `Paseo does not show the ${record.tool} agent ${record.create.agentId} yet, though its create was sent, so it may still start in the worktree.`,
        `Once it appears, run teamai workflow cancel ${place.run} again, which stops it.`,
        `If it never appears in Paseo, the create was refused: check that nothing of the attempt runs in the worktree, then run teamai workflow cancel ${place.run} --release ${place.attempt}.`,
      ].join(' ')).join(' '),
    };
  };

  /** Each agent of a place, as a close names what it leaves: one a failed close of a released place leaves may still run. */
  const keptOf = (handle: string): string[] => journal.promptsOf(handle).flatMap(({ record }) => (record.kind === 'agent' ? [`Paseo agent ${record.create.agentId}`] : []));

  /** Forgets a place the person released though its close failed: its prompts' follows stop, and its record goes. */
  function forgetReleased(handle: string): void {
    for (const { op } of journal.promptsOf(handle)) {
      const following = waiting.get(op);
      waiting.delete(op);
      following?.stop();
      ledger.forget(op);
    }

    journal.forget(handle);
  }

  /**
   * Ends an attempt's place once nothing it started runs. A place whose agent may still run is kept, so teamai can close
   * it again: one the runtime cannot stop, or any place while it reaches no daemon, as after a restart whose init failed.
   * A place the person released (`release`) is forgotten either way, so it no longer counts on its workspace or directory.
   */
  async function closePlace(handle: string, { release }: { release: boolean }): Promise<void> {
    // Its agents' prompts are the close's to end, once their agents stopped; a close that fails leaves them to their wait.
    const stops = journal.promptsOf(handle).flatMap(({ op, record }) => (record.kind === 'agent' && !record.outcome && !closeStops.has(op) ? [op] : []));

    for (const op of stops) closeStops.add(op);

    try {
      await stopAndForget(handle, { release });
    } finally {
      for (const op of stops) closeStops.delete(op);
    }
  }

  /** `closePlace`, once the prompts whose agents it stops are its own to end. */
  async function stopAndForget(handle: string, { release }: { release: boolean }): Promise<void> {
    const deadline = Date.now() + STOP_SETTLE_MS;
    const prompts = journal.promptsOf(handle);

    const closeFailed = (failure: RuntimeFailure): void => {
      if (!release) return write({ event: 'close_failed', handle, failure });
      const kept = keptOf(handle);
      forgetReleased(handle);
      write({ event: 'close_failed', handle, failure, ...(kept.length > 0 && { kept }) });
    };

    // A prompt that has not sent its create yet ends cancelled, and never sends it: the place it would run in closes.
    for (const { op, record } of prompts) {
      if (record.kind === 'pending' && !record.outcome) {
        journal.cancel(op);
        waiting.get(op)?.stop();
      }
    }

    const opening = opens.get(handle);

    // A place whose worktree, or judge's directory, Paseo is still opening is closed once its workspace is known, so the
    // workspace is archived.
    if (opening && (await Promise.race([opening, late(deadline)])) === 'late') {
      closeFailed({ code: 'close_failed', message: `Paseo did not open the worktree of ${handle} as a workspace within ${STOP_SETTLE_MS / 1000} s; close the attempt again.` });

      return;
    }

    // A prompt is accepted before Paseo creates its agent: the close waits until none can still send a create, so one
    // being created is stopped once it exists.
    const creating = prompts.flatMap(({ op }) => creates.get(op) ?? []);

    if (creating.length > 0 && (await Promise.race([Promise.all(creating), late(deadline)])) === 'late') {
      closeFailed({ code: 'close_failed', message: `Paseo did not finish creating an agent of ${handle} within ${STOP_SETTLE_MS / 1000} s, so it may still start in the worktree; close the attempt again.` });

      return;
    }

    const place = journal.place(handle);
    // A place with no Paseo workspace has no agent to stop: it closes without the daemon.
    const live = place?.workspace && (await state.reachBy(deadline));

    const stopped = place?.workspace && (live && !('code' in live)
      ? (await unseen(live, handle, place, deadline)) ?? (await stopPlace(live, handle, place, deadline))
      : withoutDaemon(live, `stop the agents of ${handle} or archive its workspace`, 'close the attempt again'));

    if (stopped && 'code' in stopped) {
      closeFailed(stopped);

      return;
    }

    const kept = stopped ? stopped.kept : [];

    // Its agents stopped: a prompt that has not ended ends cancelled, once, before its record goes. One this process
    // already ended with an end its record could not keep ended so.
    const ops = journal.promptsOf(handle);

    for (const { op, record } of ops) {
      if (record.outcome || ledger.unkept(op) !== undefined) continue;
      const following = waiting.get(op);
      settle(op, { op, state: 'cancelled' });
      following?.stop();
    }

    journal.forget(handle);

    for (const { op } of ops) ledger.forget(op);
    write({ event: 'closed', handle, ...(kept.length > 0 && { kept }) });
  }

  return { open, adopt, displayOf, keptOf, forgetReleased, closePlace };
}

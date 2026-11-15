import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CANCEL_FAILED, type OpId, type OpState, type RuntimeFailure, type RuntimeMessage, type RuntimeRequest } from '@teamai/runtime-protocol';
import { answering } from '@teamai/runtime-kit/answering';
import { opLedger } from '@teamai/runtime-kit/ledger';
import { serveRuntime } from '@teamai/runtime-kit/serve';
import { conversations, isFailedStop, late, STOP_SETTLE_MS } from './conversation.js';
import { daemonUrl } from './daemon/address.js';
import { loadClient } from './daemon/client.js';
import { connect, type Daemon } from './daemon/connect.js';
import { judging } from './judge.js';
import type { Journal } from './journal.js';
import { checkOf, offerOf } from './offer.js';
import { parseOptions } from './options.js';
import type { ProcessState } from './process-state.js';
import { isPaseoTool, PASEO_TOOLS, providerAdds } from './providers.js';
import { wakes } from './wake.js';
import { workspaces } from './workspace.js';

// ─── teamai-runtime-paseo ────────────────────────────────
//
//  A prompt-only step runtime: each prompt step becomes an agent of a Paseo daemon, in a Paseo workspace that adopts
//  teamai's worktree, so a person sees and steers it in Paseo. It runs no command (`can.exec: false`): command steps
//  and setup go to the next runtime in the definition. teamai keeps the result file, the commit, the push and scoring.
//
//    open      accepted at once, handle: worktree/<run>/<attempt>; then workspaces.open(worktree), once per attempt,
//              and ready with the workspace
//    prompt    accepted once journaled pending, before Paseo is asked anything; then the tool's models, a judge's
//              workspace, and agents.create({ agentId: uuid(op), idempotencyKey: op, tool's default mode,
//              teamai's prompt }), and a display event with the agent once it exists; then wait: idle → the result file and the tool's session id, permission → a person answers it in the
//              app (attended) or the step fails naming the mode (unattended), closed without a result → the daemon
//              restarted, and the attempt fails with its work kept
//    cancel    recorded first, then the agent is cancelled: Paseo reports a cancelled agent as idle. A stop it cannot
//              confirm within 10 s ends cancel_failed, which a later cancel tries again
//    wake      accepted, then an agent on the first host saved on the daemon (`paseo host add`) that has a workspace of
//              the repository, its first prompt teamai's message: woken with the host, or wake_unavailable naming why
//              each host could not take it. A cancel before the agent's create went out ends it cancelled
//    recover   init only to stop what it ran: no sign-in or tool check, and the daemon reached only for a cancel or close
//    confined  a judge: a fresh agent whose cwd is the prompt's directory, briefed to read only it, in a mode that asks
//              before it edits or runs anything; any request for permission ends it. Its answer is its last message,
//              reported best-effort: nothing stops a read outside the directory
//
//  This module serves the requests; offer.ts says what init offers, conversation.ts runs a prompt's agent, workspace.ts
//  an attempt's place, wake.ts a fleet member on another host, judge.ts a confined prompt, providers.ts Paseo's providers, sandbox.ts a place that runs through a
//  sandbox, and daemon/ the connection, over the state of process-state.ts.
//

export interface Serving {
  /** Where requests come from, when a test serves another stream; unset, `serveRuntime` reads the process input. */
  input?: Readable;
  /** The runtime process's environment: it serves only when teamai started it (`serveRuntime`). */
  env: NodeJS.ProcessEnv;
  write(message: RuntimeMessage): void;
  /** Writes a line for a person, never for teamai: stderr. */
  note(text: string): void;
  journal: Journal;
  /** The Paseo agent the run was started from, when it was (Paseo sets PASEO_AGENT_ID in its agents). */
  startedFrom?: string;
}

/** `map` holding only `entries`, as init offered them. */
function refill<TKey, TValue>(map: Map<TKey, TValue>, entries: ReadonlyMap<TKey, TValue>): void {
  map.clear();

  for (const [key, value] of entries) map.set(key, value);
}

export async function serve({ input, env, write: emit, note, journal, startedFrom }: Serving): Promise<number> {
  const ledger = opLedger({ name: 'paseo', write: emit });
  const { write } = ledger;
  const fail = (op: OpId, failure: RuntimeFailure): void => ledger.end({ op, state: 'failed', failure });

  const state: ProcessState = {
    journal, ledger, write, fail, startedFrom, daemon: undefined, mode: 'attended', closing: false, reachBy: (deadline) => reachBy(deadline),
    offers: new Map(), targets: new Map(), modeIds: new Map(), sessionHomes: new Map(), offersTokens: false, homeEnv: {}, homeDirs: new Map(), providerHomes: new Map(), toAdd: new Map(),
    waiting: new Map(), stopping: new Set(), closeStops: new Set(), opens: new Map(), turns: new Map(), creates: new Map(),
  };

  /**
   * In recover mode, the daemon's url, or why it could not be read: the runtime connects to it only once a cancel or
   * close needs it.
   */
  let recoverAt: { url: string } | RuntimeFailure | undefined;
  /** The connection a recover-mode cancel or close is making, which the next one shares. */
  let reaching: Promise<Daemon | RuntimeFailure> | undefined;

  /**
   * The daemon a stop needs by `deadline`: the one init connected to, or, in recover mode, one connected on first need,
   * so a daemon that is down or a tool signed out since never keeps teamai from stopping what it ran, or why none
   * answered by then. Undefined: init did not connect to one. A connection that misses a stop's deadline is not shared
   * with the next stop, which connects afresh, so a daemon that is back by then is reached.
   */
  const reachBy = async (deadline: number): Promise<Daemon | RuntimeFailure | undefined> => {
    if (state.daemon) return state.daemon;

    if (!recoverAt || 'code' in recoverAt) return recoverAt;
    const { url } = recoverAt;

    const shared = reaching;
    const abandon = new AbortController();

    const connecting = shared ?? (async () => {
      const client = await loadClient(process.env);
      const connected = 'code' in client ? client : await connect(url, client, abandon.signal);

      if (!('code' in connected)) state.daemon = connected;

      return connected;
    })();

    reaching = connecting;
    const reached = await Promise.race([connecting, late(deadline)]);

    // A connection that failed, or missed this deadline, is not the next stop's; a later one may have replaced it. One
    // this stop began, and it ran out of time for, is dropped then, so none goes on past the stop that wanted it.
    if ((reached === 'late' || 'code' in reached) && reaching === connecting) reaching = undefined;

    // One this stop joined failed, as when the stop that began it ran out of time first: this stop connects again within
    // its own deadline, so a daemon that is back by then is reached.
    if (reached !== 'late' && 'code' in reached && shared && Date.now() < deadline) return reachBy(deadline);

    if (reached !== 'late') return reached;

    if (!shared) abandon.abort();

    return { code: 'daemon_unreachable', message: `No Paseo daemon answered at ${url} within ${STOP_SETTLE_MS / 1000} s. Start it with \`paseo start\`, or set the runtime's url option to the daemon's address.` };
  };

  const ensureProvider = providerAdds(state);
  const conversation = conversations(state, { ensureProvider });
  const { send, track, accept, follow, work, cancel } = conversation;
  const { open, adopt, displayOf, keptOf, forgetReleased, closePlace } = workspaces(state, { ensureProvider, conversation });
  const judge = judging(state, { conversation, adopt });
  const waking = wakes(state);

  async function init(request: Extract<RuntimeRequest, { type: 'init' }>): Promise<void> {
    if (request.mode !== 'check') return initIn(request, { reply: write });
    // A check writes nothing of teamai's: a client it has to unpack from the Paseo app goes into a directory of its own,
    // removed before it answers.
    const unpackInto = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-paseo-check-'));
    const remove = (): void => fs.rmSync(unpackInto, { recursive: true, force: true });

    try {
      await initIn(request, { unpackInto, reply: (line) => { remove(); write(line); } });
    } finally {
      remove();
    }
  }

  /** Answers `init` through `reply`, unpacking a client from the Paseo app into `unpackInto` when it is given. */
  async function initIn(request: Extract<RuntimeRequest, { type: 'init' }>, { unpackInto, reply }: { unpackInto?: string; reply: typeof write }): Promise<void> {
    const parsed = parseOptions(request.options);

    if (!parsed.ok) {
      reply({ type: 'init', ok: false, error: parsed.failure });

      return;
    }

    const { options } = parsed;

    const instances = request.instances ?? [];
    const runsAs = new Set<string>([...PASEO_TOOLS, ...instances.flatMap((instance) => (isPaseoTool(instance.tool) ? [instance.name] : []))]);
    // teamai passes every instance the member may run, so a provider for one it did not pass, such as a team tool this
    // machine has not accepted, leaves that name unavailable rather than failing the other tools.
    const foreign = Object.keys(options.providers ?? {}).filter((name) => !runsAs.has(name));

    // The daemon the definition names, else the one the member's Paseo config names.
    const address = options.url === undefined ? daemonUrl(process.env) : { url: options.url };

    if (request.mode === 'recover') {
      // Only to stop what it ran: no sign-in or tool check, and no connection until a cancel or close needs one. A config
      // it cannot read fails each stop that needs the daemon, naming why, never the init that stops nothing.
      recoverAt = address;
      reply({ type: 'init', ok: true, can: {} });

      return;
    }

    if ('code' in address) {
      reply({ type: 'init', ok: false, error: address });

      return;
    }

    const { url } = address;

    const client = await loadClient(process.env, unpackInto === undefined ? {} : { unpackInto });

    if ('code' in client) {
      reply({ type: 'init', ok: false, error: client });

      return;
    }

    const connected = await connect(url, client);

    if ('code' in connected) {
      reply({ type: 'init', ok: false, error: connected });

      return;
    }

    const modes = Object.fromEntries(Object.entries(options.mode ?? {}).filter(([tool]) => isPaseoTool(tool)));
    const homeEnv = request.homeEnv ?? {};
    const installed = await connected.installedTools({ modes, instances, homeEnv, providers: options.providers ?? {}, isCheck: request.mode === 'check' });
    const found = { installed, instances, foreign, url: connected.url };

    // A check connects and lists, and keeps nothing: providers are added only by an open, and no step will follow.
    if (request.mode === 'check') {
      await connected.close();
      reply(checkOf(found));

      return;
    }

    const offered = offerOf({ ...found, mode: request.mode });
    state.daemon = connected;
    state.mode = request.mode;

    // A tool whose Paseo default never asks starts its steps in a tighter mode, and a provider may move a tool's home
    // away from teamai's own for it: the person is told once.
    for (const message of offered.notices) write({ event: 'notice', message });
    refill(state.offers, offered.offers);
    refill(state.targets, offered.targets);
    refill(state.modeIds, offered.modeIds);
    refill(state.sessionHomes, offered.sessionHomes);
    refill(state.homeDirs, offered.homeDirs);
    refill(state.providerHomes, offered.providerHomes);
    refill(state.toAdd, offered.toAdd);
    state.homeEnv = homeEnv;
    state.offersTokens = offered.init.ok && offered.init.can.tokens === true;
    // A daemon that routes to saved hosts can start a fleet member on one; recover mode returned above.
    write(offered.init.ok && connected.routesHosts ? { ...offered.init, wake: true } : offered.init);
  }

  async function prompt(live: Daemon, request: Extract<RuntimeRequest, { type: 'prompt' }>): Promise<void> {
    const { op } = request;
    const known = journal.prompt(op);

    // A repeated id: the same acceptance, then the outcome it ended with, or a reconnect to its agent.
    if (known?.kind === 'refused') {
      send(known.outcome);

      return;
    }

    if (known?.outcome || (known && state.waiting.has(op))) {
      accept(op, known, live, { exists: Boolean(known.outcome) || state.waiting.get(op)?.created === true });

      if (known.outcome) send(known.outcome);

      return;
    }

    if (known?.kind === 'agent') {
      const following = track(op);
      accept(op, known, live, { exists: false });
      await follow(live, op, known, following);

      return;
    }

    // New, or pending in a runtime that died before it sent a create: launched from the start.
    const place = journal.place(request.handle);
    const { confined } = request;

    if (confined && place?.kind === 'confined') {
      await judge(live, request, confined, place);

      return;
    }

    if (!confined && place?.kind === 'worktree' && place.workspace) {
      await work(live, request, { ...place, workspace: place.workspace });

      return;
    }

    fail(op, {
      code: 'unknown_handle',
      message: confined
        ? `teamai-runtime-paseo has no confined prompt's place ${request.handle}; open the attempt with no view first.`
        : `teamai-runtime-paseo has no worktree place ${request.handle} that Paseo opened; open the attempt on its worktree first.`,
    });
  }

  async function answer(request: RuntimeRequest): Promise<void> {
    if (request.type === 'init') {
      await init(request);

      return;
    }

    const live = state.daemon;

    // What teamai asks to stop a place is answered without a daemon from init too, in recover mode or after an init that
    // could not reach one: reattach and collect from the journal, and a cancel or close reaches the daemon only to stop.
    switch (request.type) {
      case 'collect':
        // The worktree and the result directory already sit on this host, and the transcript stays in the tool's home.
        write({ event: 'collected', handle: request.handle });

        return;
      case 'reattach': {
        // From the journal alone: gone only when it records no place, and a record it cannot read throws, never gone.
        if (!journal.place(request.handle)) {
          write({ event: 'gone', handle: request.handle });

          return;
        }

        const ops = journal.promptsOf(request.handle).map(({ op, record }): OpState => record.outcome ?? ledger.unkept(op) ?? { op, state: 'running' });
        const display = live && displayOf(request.handle, live);
        write({ event: 'alive', handle: request.handle, ops, ...(display && { display }) });

        return;
      }

      case 'close':
        await closePlace(request.handle, { release: request.release === true });

        return;
      case 'cancel':
        if (waking.cancel(request.op)) return;
        await cancel(request.op);

        return;
      default:
        break;
    }

    // A recover-mode process may have reached the daemon for a stop, and still takes no new work.
    if (!live || recoverAt !== undefined) {
      fail(request.op, {
        code: 'not_started',
        message: recoverAt === undefined
          ? `teamai-runtime-paseo got ${request.type} before a successful init.`
          : `teamai-runtime-paseo opened in recover mode only stops what it ran: it got ${request.type}.`,
      });

      return;
    }

    switch (request.type) {
      case 'open':
        await open(live, request);

        return;
      case 'exec':
        fail(request.op, { code: 'exec_unsupported', message: 'teamai-runtime-paseo runs no command (can.exec is false): a command step goes to the next runtime in the definition.' });

        return;
      case 'prompt':
        await prompt(live, request);

        return;
      case 'wake':
        await waking.wake(live, request);

        return;
      default: {
        const unhandled: never = request;
        throw new Error(`Unknown request ${JSON.stringify(unhandled)}`);
      }
    }
  }

  /** The agent a prompt journaled, named for a person, or undefined when it journaled none; one that cannot be read may exist. */
  const agentNamed = (op: OpId): string | undefined => {
    try {
      const record = journal.prompt(op);

      return record?.kind === 'agent' ? `The ${record.tool} agent ${record.create.agentId}` : undefined;
    } catch {
      return 'Its agent';
    }
  };

  /** Whether `op` is one this runtime runs or answered: an answer of its own would end it a second time. One it cannot tell is. */
  const holdsOp = (op: OpId): boolean => {
    if (requests.isAnswering(op) || state.creates.has(op) || ledger.endsOf(op) > 0) return true;

    try {
      return journal.prompt(op) !== undefined;
    } catch {
      return true;
    }
  };

  /** Answers `request` as its type asks, and a request that threw with its own failure: never a second end of its op. */
  const answerOne = async (request: RuntimeRequest): Promise<void> => {
    const endsBefore = 'op' in request ? ledger.endsOf(request.op) : 0;

    // A prompt sent again, or a cancel that tries a failed stop again, may end the op otherwise, so the outcome it could
    // not record is no longer its state. A cancel of any other end answers that end.
    if (request.type === 'prompt' || (request.type === 'cancel' && isFailedStop(ledger.unkept(request.op)))) ledger.forget(request.op);

    try {
      await answer(request);
    } catch (error) {
      const message = `Paseo failed: ${error instanceof Error ? error.message : String(error)}`;

      // Each request gets its own failure, since an error line would fail every request teamai is waiting on. A prompt
      // whose agent exists, or may, ends as an unconfirmed stop, since the agent may still run. A close that failed
      // keeps its place.
      if (request.type === 'prompt' || request.type === 'cancel') {
        // Ended meanwhile, by this request or another: a second line would end it twice.
        if (ledger.endsOf(request.op) !== endsBefore) return;
        // This line is the op's one end: its follow, taken from `waiting`, ends nothing after it.
        const following = state.waiting.get(request.op);
        state.waiting.delete(request.op);
        following?.stop();
        const agent = agentNamed(request.op);
        const failure = agent ? { code: CANCEL_FAILED, message: `${message.replace(/\.$/, '')}. ${agent} may still run in the worktree; stop it in the Paseo app.` } : { code: 'paseo_failed', message };

        // Kept on its record when that can still be read and written, so a reattach or a repeated prompt reports it.
        void ledger.settle({ op: request.op, state: 'failed', failure }, () => {
          const record = journal.prompt(request.op);

          if (record && record.kind !== 'refused' && !record.outcome) journal.savePrompt(request.op, { ...record, outcome: { op: request.op, state: 'failed', failure } });
        });
      } else if ('op' in request) fail(request.op, { code: 'paseo_failed', message });
      else if (request.type === 'close') {
        // A released place is forgotten though its close failed; a journal that cannot remove it is named.
        let unforgotten = '';
        let kept: string[] = [];

        try {
          if (request.release) {
            kept = keptOf(request.handle);
            forgetReleased(request.handle);
          }
        } catch (forgetting) {
          unforgotten = ` teamai-runtime-paseo could not forget the released attempt either (${forgetting instanceof Error ? forgetting.message : String(forgetting)}); make ${journal.root} readable and writable, then release it again.`;
        }

        write({ event: 'close_failed', handle: request.handle, failure: { code: 'paseo_failed', message: `${message}${unforgotten}` }, ...(kept.length > 0 && { kept }) });
      }
      else if (request.type === 'init') write({ type: 'init', ok: false, error: { code: 'paseo_failed', message } });
      else write({ event: 'failed', handle: request.handle, failure: { code: 'paseo_failed', message } });
    }
  };

  const requests = answering({ init: answerOne, open: answerOne, exec: answerOne, prompt: answerOne, wake: answerOne, cancel: answerOne, collect: answerOne, reattach: answerOne, close: answerOne });
  const status = await serveRuntime({ name: 'paseo', input, env, ledger, handlers: requests.handlers, holds: holdsOp, stopped: 'its Paseo agent', debug: note });

  // teamai is gone once stdin ends: the requests in flight get their answers, and an agent goes on in Paseo, which keeps
  // how it ended for the next reattach.
  state.closing = true;

  for (const following of state.waiting.values()) following.stop();
  await requests.settled();
  await state.daemon?.close();

  return status;
}

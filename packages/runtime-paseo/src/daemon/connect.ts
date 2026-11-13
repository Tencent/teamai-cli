import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUserHome } from '@teamai/shared/home';
import { z } from 'zod';
import type { PaseoAgent, PaseoApi } from '@getpaseo/client';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { WebSocketFactory } from '@getpaseo/client/internal/daemon-client-transport-types';
import { RUN_DIR_ENV, type InitHomeEnv, type InitInstance, type RuntimeFailure } from '@teamai/runtime-protocol';
import { paseoKeyOf, type AgentCreate } from '../journal.js';
import { CustomProvidersSchema, daemonRuns, homeDirOf, homeEnvAt, instanceHomeOf, isPaseoTool, keptOf, namedProblem, PASEO_TOOLS, providerOf, shownPath, type CustomProviders, type PaseoTool, type ProviderFound, type ProviderToAdd } from '../providers.js';
import { isOnThisMachine } from './address.js';
import { routedHost, savedHosts, type Host, type SavedHost } from './host.js';
import { atLeast, OLDEST_PASEO, type PaseoClient } from './client.js';
import { claudeHomeIn, codexLoginStatus, isCodexExecutable, signInStep, type RunsIn, type SignIn } from './sign-in.js';

// ─── The Paseo daemon ────────────────────────────────────
//
//  One connection to a Paseo daemon over its WebSocket protocol, through the @getpaseo/client the member's Paseo
//  installed (client.ts). Cancel and wait live on the client's internal driver, which is why the daemon must run the
//  version this runtime was tested against or later.
//

/** What this runtime needs of the daemon: agent creates with caller-chosen ids that a repeated key answers. */
const NEEDED_FEATURES = ['creationLifecycle', 'agentRequestReceipts'] as const;


/**
 * The Paseo mode a step's agent starts in: `unset`, so Paseo starts the tool as it does when it sets no default
 * (OpenCode); `asks`, Paseo's default for the tool, as the member's own agents start in, or the one the runtime's `mode`
 * option names; `tightened`, the nearest mode that asks before a default that never does, which `insteadOf` names for
 * the start to say so; `bypass`, a mode that never asks, taken only when the `mode` option names it.
 */
export type StepMode = { kind: 'unset' } | { kind: 'asks'; id: string } | { kind: 'tightened'; id: string; insteadOf: string } | { kind: 'bypass'; id: string };

/** The Paseo mode the runtime's `mode` option names for each tool it sets. */
export type ConfiguredModes = Partial<Record<PaseoTool, string>>;

/** A mode as Paseo lists it, in its order: `dangerous` is how Paseo marks one that never asks. */
type ListedMode = { id: string; colorTier?: string };

const isBypass = (mode: ListedMode): boolean => mode.colorTier === 'dangerous';

/**
 * The mode a step of `tool` starts in: the one the runtime's `mode` option names, else from Paseo's default and its
 * list, or why the tool cannot be offered.
 */
function stepModeOf(tool: PaseoTool, { defaultMode, configured, modes }: { defaultMode: string | null | undefined; configured: string | undefined; modes: ListedMode[] }): StepMode | { cannot: string } {
  const listed = modes.map((mode) => mode.id).join(', ') || 'none';

  if (configured !== undefined) {
    const named = modes.find((mode) => mode.id === configured);

    if (!named) return { cannot: `the runtime's mode option names ${configured} for it, which Paseo does not list for ${tool} (${listed}); name one of those` };

    return { kind: isBypass(named) ? 'bypass' : 'asks', id: named.id };
  }

  if (defaultMode === null || defaultMode === undefined) return { kind: 'unset' };
  const at = modes.findIndex((mode) => mode.id === defaultMode);

  if (at === -1) return { cannot: `Paseo sets its default mode to ${defaultMode}, which it does not list for ${tool} (${listed}); run \`paseo provider ls\` on the daemon's host to see its modes` };
  const chosen = modes[at];

  if (chosen && !isBypass(chosen)) return { kind: 'asks', id: chosen.id };
  const tighter = modes.slice(0, at).findLast((mode) => !isBypass(mode));

  return tighter
    ? { kind: 'tightened', id: tighter.id, insteadOf: defaultMode }
    : { cannot: `Paseo sets its default mode to ${defaultMode}, which never asks, and lists no mode before it that does (${listed})` };
}

const CONNECT_TIMEOUT_MS = 10_000;

/** What Paseo said of a request it failed: the daemon's own error, without the request details the client adds to it. */
const PaseoSaidSchema = z.union([
  z.object({ userMessage: z.string().min(1) }).transform(({ userMessage }) => userMessage),
  z.instanceof(Error).transform(({ message }) => message),
  z.unknown().transform(String),
]);

/**
 * How long a question an open asks Paseo may go unanswered: an open holds its directory meanwhile, and the two it asks
 * end well within the minute after which another open takes that hold over (`HOLD_STALE_MS`).
 */
const OPEN_QUESTION_TIMEOUT_MS = 20_000;

/**
 * What `asking` answers, or a failure once it gave no answer in `OPEN_QUESTION_TIMEOUT_MS`. Paseo still answers a
 * question teamai gave up on, so `later` says what a person does about what that answer leaves.
 */
async function answeredInTime<T>(asking: Promise<T>, later = ''): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${OPEN_QUESTION_TIMEOUT_MS / 1000} s; check that its daemon answers with \`paseo ls\`, then run the step again${later}`)), OPEN_QUESTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([asking, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}


/** The names under `dir`, newest first by name, as Codex's dated session folders sort; none when it cannot be read. */
const newestFirst = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir).toSorted().toReversed();
  } catch {
    return [];
  }
};

/** Whether the Codex home `home` holds the rollout of thread `threadId`: under `sessions/<yyyy>/<mm>/<dd>/`, or archived. */
function holdsRollout(home: string, threadId: string): boolean {
  const isRollout = (name: string): boolean => name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`);

  if (newestFirst(path.join(home, 'archived_sessions')).some(isRollout)) return true;
  const sessions = path.join(home, 'sessions');

  return newestFirst(sessions).some((year) => newestFirst(path.join(sessions, year)).some((month) => newestFirst(path.join(sessions, year, month))
    .some((day) => newestFirst(path.join(sessions, year, month, day)).some(isRollout))));
}

/**
 * The homes on this machine the daemon's Codex likely writes, in the order to look in. Paseo starts Codex with its
 * provider's env over the daemon's own and reports no Codex home, so they are: the one its Paseo provider's env sets,
 * alone, as Codex writes only there; else the runtime's `CODEX_HOME`, then a team instance's home as teamai resolved it
 * (an absolute `homeDir`), or `.codex` in the account's home, where a daemon the Paseo app started runs, then in `$HOME`.
 */
export function codexHomes({ providerHome, homeDir }: { providerHome: string | undefined; homeDir: string }): string[] {
  if (providerHome !== undefined) return [providerHome];
  const homes: string[] = [];
  // CODEX_HOME moves the Codex home, not a team instance's own.
  const moved = homeDir === '.codex' ? process.env.CODEX_HOME : undefined;

  if (moved && path.isAbsolute(moved)) homes.push(moved);

  if (path.isAbsolute(homeDir)) {
    homes.push(homeDir);
  } else {
    try {
      homes.push(path.join(os.userInfo().homedir, homeDir));
    } catch {
      // No account entry for this user: its home is only $HOME.
    }

    homes.push(path.join(getUserHome(), homeDir));
  }

  return [...new Set(homes)];
}

/** The Codex home on this machine that holds the rollout of thread `threadId`, or undefined when none it can see does. */
function codexHomeHolding(threadId: string, where: { providerHome: string | undefined; homeDir: string }): string | undefined {
  return codexHomes(where).find((home) => holdsRollout(home, threadId));
}

/** When OpenCode's store in data directory `home` last changed, its write-ahead log included; undefined when it has none. */
function storeChangedAt(home: string): number | undefined {
  const times = ['opencode.db', 'opencode.db-wal'].flatMap((name) => {
    try {
      return [fs.statSync(path.join(home, 'opencode', name)).mtimeMs];
    } catch {
      return [];
    }
  });

  return times.length > 0 ? Math.max(...times) : undefined;
}

/**
 * The data directory of the daemon's OpenCode on this machine, its `XDG_DATA_HOME`, or undefined when none it can see
 * holds OpenCode's store. OpenCode 2 keeps every session in one database there, `opencode/opencode.db`, which names no
 * session in a file. The homes looked in are the one the provider's env sets, then the runtime's `XDG_DATA_HOME`, then
 * `.local/share` in `$HOME`, then in the account's home, where a daemon the Paseo app started runs; the first whose
 * store changed since the step's agent was created (`since`) is the one it wrote, else the first that holds a store. So
 * a store teamai's own OpenCode left in its data home before the step never hides the one the daemon wrote.
 */
function openCodeDataHome(providerHome: string | undefined, since: number | undefined): string | undefined {
  const homes = [providerHome, process.env.XDG_DATA_HOME, path.join(getUserHome(), '.local', 'share')];

  try {
    homes.push(path.join(os.userInfo().homedir, '.local', 'share'));
  } catch {
    // No account entry for this user: its home is only $HOME.
  }

  const holding = homes.flatMap((home) => {
    const changedAt = home !== undefined && path.isAbsolute(home) ? storeChangedAt(home) : undefined;

    return home !== undefined && changedAt !== undefined ? [{ home, changedAt }] : [];
  });

  return (holding.find(({ changedAt }) => since !== undefined && changedAt >= since) ?? holding[0])?.home;
}

export interface Model {
  id: string;
  /** The model Paseo starts the tool on when none is named. */
  isDefault: boolean;
  efforts: string[];
}

/** How an agent create ended: created, failed before it was sent, or failed once sent, when its agent may still start. */
export type Creation = { outcome: 'created' } | { outcome: 'unsent' | 'failed'; cause: string };

export type WaitEnd = Awaited<ReturnType<DaemonClient['waitForFinish']>>;

/**
 * What a step names as its tool, as Paseo runs it: `name`, a teamai tool or a team instance of one; `tool`, the tool it
 * is or extends, whose modes, grants and sign-in rule it takes; `provider`, the Paseo provider that runs it.
 */
export interface Target {
  name: string;
  tool: PaseoTool;
  provider: string;
}

/** What Paseo lists for a tool or instance a step can run on: its modes, and the one a step starts in. */
type Runnable = Target & { modes: string[]; stepMode: StepMode };

/**
 * A tool or instance installed on the daemon's host: `runs`, on a provider the daemon has, with the home it signs in and
 * keeps sessions in when that is not teamai's; `to-add`, a team instance offered on the provider teamai adds at its first
 * step, whose homes are known once it is added; or `unavailable`, with why, for a person to read.
 */
export type InstalledTool =
  | (Runnable & { kind: 'runs'; home?: string; providerHome?: ProviderHome })
  | (Runnable & { kind: 'to-add'; toAdd: ProviderToAdd })
  | Unavailable;

/**
 * The tool home a Paseo custom provider's env sets for what it runs: `variable`, the one that moves that tool's home;
 * `dir`, the absolute directory it names; `teamaiHome`, the one teamai keeps that tool or instance's home in.
 */
export interface ProviderHome {
  variable: string;
  dir: string;
  teamaiHome: string;
}

/** A tool or instance the daemon cannot run, and why, before or after a provider is found for it. */
type Unavailable = Pick<Target, 'name' | 'tool'> & { kind: 'unavailable'; reason: string };

/** How init plans to run a tool or instance before it asks Paseo about it: on a provider found, one to add, or neither. */
type Planned = (Target & { kind: 'found' }) | (Target & { kind: 'add'; toAdd: ProviderToAdd }) | Unavailable;

/**
 * How Paseo runs an instance on the provider teamai added for it, or why it cannot; `added` says whether this call added
 * that provider and left it in Paseo's config: one it added for an instance that cannot run on it is removed again,
 * unless Paseo refuses.
 */
export type Added = { provider: string; added: boolean; home?: string; providerHome?: string } | { cannot: string; added: boolean };

/** What a definition and teamai choose of the tools a runtime offers: each tool's mode, the team's instances, and providers named for either. */
export interface ToolChoices {
  modes: ConfiguredModes;
  instances: readonly InitInstance[];
  /** Every variable each tool's command reads its home from, by the name a step gives it, as teamai sent it in init. */
  homeEnv: InitHomeEnv;
  /** A Paseo provider id for a tool or an instance name, over the one the runtime finds. */
  providers: Readonly<Record<string, string>>;
  /** Only to answer a check, which runs nothing: a Codex Paseo resolves counts as one it runs, its sign-in unasked. */
  isCheck?: boolean;
}

export interface Daemon {
  url: string;
  serverId: string;
  version: string;
  /** Whether the daemon routes to the other daemons the member saved on it as hosts (`paseo host add`). */
  routesHosts: boolean;
  /** The other daemons the member saved on it as hosts. */
  hosts(): Promise<SavedHost[]>;
  /** The saved host `serverId`, reached through this daemon. */
  host(serverId: string): Promise<Host>;
  /**
   * The tools whose provider the daemon has installed, and the team instances of them, each one it can run when signed
   * in and Paseo gives it a mode a step can start in.
   */
  installedTools(choices: ToolChoices): Promise<InstalledTool[]>;
  /**
   * Adds `toAdd` to the daemon's `agents.providers` for team instance `instance`, keeping every other entry, unless a
   * provider that runs the instance is there by now, and checks the instance's sign-in on it. Paseo saves and applies the
   * entry at once. Callers hold the daemon's providers across runtimes (`Journal.holdProviders`).
   */
  addProvider(toAdd: ProviderToAdd, instance: InitInstance, homeEnv: readonly string[]): Promise<Added>;
  models(provider: string): Promise<Model[]>;
  /** Whether Paseo has an active workspace on a directory, as one the member opened in the app; fails with no answer in 20 s. */
  isOpen(cwd: string): Promise<boolean>;
  /** The agents of a workspace that no archive closed and teamai did not start (they carry no `teamai-attempt` label): the member's. */
  memberAgentsIn(workspaceId: string): Promise<string[]>;
  /** Adopts a directory as a Paseo workspace; Paseo answers the same workspace for the same directory. Fails with no answer in 20 s. */
  workspace(cwd: string): Promise<{ id: string; name: string; directory: string }>;
  /**
   * Adds to the daemon's `agents.providers` the provider that runs `tool` as teamai's wrapper `id`, from `found` on this
   * machine, unless one that runs it is there, and checks Paseo finds its command. Callers hold the daemon's providers
   * across runtimes (`Journal.holdProviders`).
   */
  wrapperProvider(wrapper: { id: string; tool: PaseoTool; found: string | null }): Promise<Added>;
  /**
   * Creates the agent in the workspace of `cwd`, or answers the one a repeated create made. A create that failed says
   * whether it was sent: one Paseo refused may still start its agent, and only one never sent proves none started.
   * `isIdle`: the agent is created with no prompt, and waits for its first message.
   */
  create(cwd: string, create: AgentCreate, how?: { isIdle: boolean }): Promise<Creation>;
  /** Starts an idle agent's tool: Paseo starts Codex's at the create, and Claude's at the first listing of its commands. */
  start(agentId: string): Promise<void>;
  /** Sends an idle agent a message: the first one of an agent created with no prompt, or a new turn of one that finished. */
  send(agentId: string, text: string): Promise<void>;
  /** Allows the agent's pending permission request `requestId`, as a person who answers it in the app does. */
  allow(agentId: string, requestId: string): Promise<void>;
  /** The ids of the sessions of `provider` in `cwd` that Paseo can import: those it holds and no agent of its has. */
  sessions(cwd: string, provider: string): Promise<string[]>;
  /**
   * Imports session `session` of `provider` as an idle agent in workspace `workspaceId`, which runs nothing until it is
   * sent a message, and answers its id, which Paseo chooses. Paseo imports a session it does not hold all the same, and
   * fails the agent's first turn.
   */
  importSession(session: { provider: string; session: string; cwd: string; workspaceId: string; labels: Record<string, string> }): Promise<string>;
  /** Sets an agent's model, mode and thinking option, as an imported agent starts on Paseo's defaults. */
  configure(agentId: string, config: { model: string; modeId?: string; thinkingOptionId?: string }): Promise<void>;
  /** Deletes an agent, which stops its tool; its logs go with it. */
  remove(agentId: string): Promise<void>;
  agent(agentId: string): Promise<PaseoAgent | null>;
  /** Waits until the agent's turn ends or needs a person. */
  wait(agentId: string): Promise<WaitEnd>;
  cancel(agentId: string): Promise<void>;
  /** Archives a workspace, which stops its agents; Paseo deletes only worktrees it created, so teamai's stays. */
  archive(workspaceId: string): Promise<void>;
  link(agentId: string): string;
  /**
   * The tool home a finished session of `tool` lives in, when the runtime can tell: Claude's from Paseo's diagnostic at
   * init, Codex's found by the session's rollout on a daemon on this machine, in `homeDir`: `.codex` under a home there,
   * or a team instance's own home, absolute, and OpenCode's data directory on a daemon on this machine, its `XDG_DATA_HOME`. The home a
   * Paseo provider's env sets comes first. `where.since`: when the step's agent was created, as Paseo reports it.
   */
  sessionHome(tool: PaseoTool, sessionId: string, where: { claudeHome: string | undefined; providerHome: string | undefined; homeDir: string; since: number | undefined }): string | undefined;
  close(): Promise<void>;
}

/**
 * Whether Paseo has an active workspace that an open of `cwd` finds, reading every page of its workspaces: one on the
 * same path, and not a background one, which Paseo leaves out of that match.
 */
async function isOpenIn(api: PaseoApi, cwd: string): Promise<boolean> {
  const wanted = paseoKeyOf(cwd);

  for (let cursor: string | undefined; ;) {
    const listed = await api.workspaces.list({ page: { limit: 200, ...(cursor !== undefined && { cursor }) } });

    if (listed.entries.some((entry) => entry.archivingAt === null && !entry.background && paseoKeyOf(entry.workspaceDirectory) === wanted)) return true;
    const next = listed.pageInfo.nextCursor;

    if (!listed.pageInfo.hasMore || !next) return false;
    cursor = next;
  }
}

/** A WebSocket from the client's `ws`, as the client binds one: Node 20 has no WebSocket of its own. */
const nodeWebSocket = (WebSocket: PaseoClient['WebSocket']): WebSocketFactory => (target, options) => {
  const socket = new WebSocket(target, options?.protocols, { headers: options?.headers });
  socket.binaryType = 'arraybuffer';

  return {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    on: (event, listener) => {
      socket.on(event, listener);
    },
    off: (event, listener) => {
      socket.off(event, listener);
    },
  };
};

/**
 * Connects to the daemon at `url` through the installed `paseo` client and checks it runs what this runtime needs, or says
 * why it cannot be used. It waits at most 10 s for the daemon's answer, and stops waiting once `abandoned` aborts.
 */
export async function connect(url: string, paseo: PaseoClient, abandoned?: AbortSignal): Promise<Daemon | RuntimeFailure> {
  const client: DaemonClient = new paseo.DaemonClient({
    url,
    clientId: 'teamai-runtime-paseo',
    clientType: 'cli',
    webSocketFactory: nodeWebSocket(paseo.WebSocket),
    // A daemon restart mid-step drops the connection; the client reconnects and a pending wait is asked again.
    reconnect: { enabled: true, baseDelayMs: 250, maxDelayMs: 2000 },
    suppressSendErrors: true,
  });

  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<'timeout' | 'abandoned'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CONNECT_TIMEOUT_MS);
    abandoned?.addEventListener('abort', () => resolve('abandoned'), { once: true });
  });

  try {
    const connected = abandoned?.aborted ? 'abandoned' : await Promise.race([client.connect().then(() => 'connected' as const), timedOut]);

    if (connected === 'timeout') throw new Error(`no answer in ${CONNECT_TIMEOUT_MS / 1000} s`);

    if (connected === 'abandoned') throw new Error('the stop that asked for it ran out of time');
  } catch (error) {
    await client.close().catch(() => {});

    return { code: 'daemon_unreachable', message: `No Paseo daemon answers at ${url} (${error instanceof Error ? error.message : String(error)}). Start it with \`paseo start\`, or set the runtime's url option to the daemon's address.` };
  } finally {
    clearTimeout(timer);
  }

  const info = client.getLastServerInfoMessage();
  const version = info?.version ?? 'unknown';
  const missing = NEEDED_FEATURES.filter((feature) => info?.features?.[feature] !== true);

  if (!info || !atLeast(version, OLDEST_PASEO) || missing.length > 0) {
    await client.close().catch(() => {});
    const lacks = missing.length > 0 ? `, and lacks ${missing.join(', ')}` : '';

    return { code: 'daemon_version', message: `The Paseo daemon at ${url} runs version ${version}${lacks}; teamai-runtime-paseo needs Paseo ${OLDEST_PASEO} or later. Update Paseo, then restart its daemon.` };
  }

  const api: PaseoApi = paseo.createPaseoApi(client);
  const serverId = info.serverId;
  /** The custom providers `installedTools` read last, by id. */
  let custom = new Map<string, CustomProviders[string]>();

  const models = async (provider: string): Promise<Model[]> => {
    const { models: listed = [] } = await api.providers.listModels(provider);

    return listed.map((model) => ({ id: model.id, isDefault: model.isDefault === true, efforts: (model.thinkingOptions ?? []).map((option) => option.id) }));
  };

  /**
   * Why the daemon cannot run `tool`, or the tool home it runs it with when Paseo reports one. Paseo calls a tool
   * available once its binary is on PATH, signed in or not, so each tool's sign-in is read from what Paseo reports of it.
   */
  const signIn = async ({ tool, provider }: Target, { runsIn, command, isCheck }: { runsIn: RunsIn | undefined; command: string | undefined; isCheck: boolean }): Promise<SignIn> => {
    switch (tool) {
      case 'claude': {
        // Claude's diagnostic quotes `claude auth status`, which reports a login and an API key alike as logged in, and,
        // from Claude Code 2.1, the config directory the daemon's Claude keeps its sessions under.
        const { diagnostic } = await api.providers.diagnostic(provider);
        const loggedIn = /"loggedIn":\s*(true|false)\b/.exec(diagnostic)?.[1];

        if (loggedIn === 'true') {
          const home = claudeHomeIn(diagnostic);

          return { canRun: true, ...(home !== undefined && { home }) };
        }

        return {
          canRun: false,
          problem: loggedIn === 'false'
            ? `signed out; run \`${signInStep({ runsIn, command: command ?? 'claude', login: 'auth login' })}\` on the daemon's host`
            : `Paseo does not report whether it is signed in; run \`paseo provider diagnostic ${provider}\` on the daemon's host to see its Auth line`,
        };
      }

      case 'opencode': {
        // Paseo 0.15 runs OpenCode on OpenCode's own background server when one runs on its host, and its diagnostic then
        // names only that server. That server refuses an agent any environment, and each step's agent gets TEAMAI_RUN_DIR.
        const shared = /^OpenCode server: (\S+)/.exec((await api.providers.diagnostic(provider)).diagnostic)?.[1];

        if (shared !== undefined) {
          return { canRun: false, problem: `Paseo runs it on OpenCode's background server at ${shared}, which takes no environment for an agent, and teamai gives each step ${RUN_DIR_ENV}; stop that server with \`opencode service stop\` on the daemon's host, then \`paseo restart\`` };
        }

        // Paseo lists OpenCode's models from the providers it reaches, its free ones included, and none when it reaches none.
        return (await models(provider)).length > 0 ? { canRun: true } : { canRun: false, problem: 'reaches no model provider; run `opencode auth login` on the daemon\'s host, then `paseo restart`' };
      }

      case 'codex': {
        // Paseo reports no Codex sign-in, so teamai asks Codex itself, which it can only where the daemon runs. It asks the
        // codex the daemon's diagnostic resolves on the daemon's PATH, which may not be the one on teamai's.
        if (!isOnThisMachine(url)) return { canRun: false, problem: `teamai checks Codex's sign-in only on a daemon at a loopback address, and ${url} is not one` };
        const resolved = /^\s*Resolved path: (.+)$/m.exec((await api.providers.diagnostic(provider)).diagnostic)?.[1]?.trim();

        if (resolved === undefined || resolved === 'not found') return { canRun: false, problem: `Paseo reports no path for it; run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why` };
        // A custom provider, an instance's or one the providers option names, runs its own command, which answers as Codex does.
        const executable = path.basename(custom.get(provider)?.command?.[0] ?? 'codex');

        if (!isCodexExecutable(resolved, process.platform, executable)) {
          return { canRun: false, problem: `Paseo resolves it to "${resolved}", which is not an absolute path to a ${executable}; run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why` };
        }

        if (isCheck) return { canRun: true };

        let status: Awaited<ReturnType<typeof codexLoginStatus>>;

        try {
          // An instance's Codex, or one whose provider moves its home, keeps its sign-in in that home.
          status = await codexLoginStatus(resolved, runsIn && { ...process.env, ...homeEnvAt(runsIn.variables, runsIn.dir) });
        } catch (error) {
          return { canRun: false, problem: `\`${resolved} login status\` did not answer (${error instanceof Error ? error.message : String(error)}); run it on the daemon's host to see why` };
        }

        // Codex 0.166.0 prints "Logged in using …" with exit 0 when signed in, and "Not logged in" with exit 1 when not.
        const { answer } = status;

        if (status.code === 0 && /^Logged in\b/m.test(answer)) return { canRun: true };

        if (status.code === 1 && /^Not logged in\b/m.test(answer)) return { canRun: false, problem: `signed out; run \`${signInStep({ runsIn, command: command ?? 'codex', login: 'login' })}\` on the daemon's host` };

        // Codex refuses a CODEX_HOME that does not exist, its login too, so the home is made first.
        if (runsIn && !fs.existsSync(runsIn.dir)) {
          return { canRun: false, problem: `signed out, as its home ${runsIn.shown} does not exist yet; run \`mkdir -p ${runsIn.shown} && ${signInStep({ runsIn, command: command ?? 'codex', login: 'login' })}\` on the daemon's host` };
        }

        const said = answer.trim().split('\n')[0]?.slice(0, 120) ?? '';

        return { canRun: false, problem: `\`${resolved} login status\` gave no sign-in answer (exit ${status.code}${said ? `: ${said}` : ''}); run it on the daemon's host to see why` };
      }

      default: {
        const unhandled: never = tool;

        return unhandled;
      }
    }
  };

  /** The absolute home of an instance's own, when it has one. */
  const ownHome = (instance: InitInstance) => ({ home: instance.home ? instanceHomeOf(instance.home) : undefined });

  return {
    url,
    serverId,
    version,
    async installedTools({ modes: configured, instances, homeEnv, providers: named, isCheck = false }) {
      // The snapshot carries each provider's default mode, which the member's own agents start in.
      const [{ providers }, { entries }] = await Promise.all([api.providers.listAvailable(), api.providers.snapshot()]);
      const available = new Set(providers.filter((entry) => entry.available).map((entry) => entry.provider));
      const teamInstances = instances.flatMap((instance) => (isPaseoTool(instance.tool) && !isPaseoTool(instance.name) ? [{ instance, tool: instance.tool }] : []));
      // Read only when an instance or a named provider needs it: a provider's env may hold a secret, and none is kept.
      let unread: string | undefined;
      let parsed: ReturnType<typeof CustomProvidersSchema.safeParse> | undefined;

      try {
        parsed = teamInstances.length > 0 || Object.keys(named).length > 0 ? CustomProvidersSchema.safeParse((await api.config.get()).config.providers) : undefined;
      } catch (error) {
        // Only what needs a custom provider is left out: each tool on its own provider still runs.
        unread = `Paseo did not answer with its providers (${PaseoSaidSchema.parse(error)}); run \`paseo daemon config get agents.providers --json\` on the daemon's host to see why`;
      }

      const customs = keptOf(parsed?.success ? parsed.data : {}, Object.values(homeEnv).flat());
      custom = new Map(Object.entries(customs));

      /** The modes Paseo lists for `provider`, and the one a step of `tool` starts in there, or why it cannot be offered. */
      const modesOf = async (tool: PaseoTool, provider: string): Promise<{ modes: string[]; stepMode: StepMode } | { cannot: string }> => {
        let modes: ListedMode[];

        try {
          modes = (await api.providers.listModes(provider)).modes ?? [];
        } catch (error) {
          return { cannot: `Paseo failed to list its modes (${PaseoSaidSchema.parse(error)}); run \`paseo provider ls\` on the daemon's host to see why` };
        }

        const stepMode = stepModeOf(tool, { defaultMode: entries.find((entry) => entry.provider === provider)?.defaultModeId, configured: configured[tool], modes });

        return 'cannot' in stepMode ? stepMode : { modes: modes.map((mode) => mode.id), stepMode };
      };

      // Each tool on its own provider or the one the definition names, each instance on the one that runs its command.
      const builtins = PASEO_TOOLS.flatMap((tool): Planned[] => {
        const provider = named[tool];

        if (provider === undefined) return available.has(tool) ? [{ kind: 'found', name: tool, tool, provider: tool }] : [];
        const problem = unread ?? namedProblem(provider, tool, customs);

        return [problem === undefined ? { kind: 'found', name: tool, tool, provider } : { kind: 'unavailable', name: tool, tool, reason: problem }];
      });

      const teams = teamInstances.map(({ instance, tool }): Planned => {
        const found = unread === undefined ? providerOf(instance, tool, { custom: customs, named: named[instance.name], homeEnv: homeEnv[instance.name] ?? [], onThisMachine: isOnThisMachine(url), ...ownHome(instance) }) : { cannot: unread };

        if ('cannot' in found) return { kind: 'unavailable', name: instance.name, tool, reason: found.cannot };

        // One teamai adds at the first open that runs it, so the daemon gets an entry only for a team tool a step runs.
        return 'add' in found ? { kind: 'add', name: instance.name, tool, provider: found.add.id, toAdd: found.add } : { kind: 'found', name: instance.name, tool, provider: found.provider };
      });

      return Promise.all([...builtins, ...teams].map(async (target): Promise<InstalledTool> => {
        if (target.kind === 'unavailable') return target;
        const { name, tool, provider } = target;
        const cannotRun = (reason: string): Unavailable => ({ kind: 'unavailable', name, tool, reason });

        // Until it is added, it takes the modes Paseo lists for its tool, as the provider teamai adds extends it; its
        // sign-in is checked once it is added.
        if (target.kind === 'add') {
          const listed = await modesOf(tool, tool);

          return 'cannot' in listed ? cannotRun(listed.cannot) : { kind: 'to-add', name, tool, provider, toAdd: target.toAdd, ...listed };
        }

        if (!available.has(provider)) return cannotRun(`Paseo does not find the command of its provider ${provider} on the daemon's PATH; install it there, then \`paseo daemon reload\``);
        const instance = teamInstances.find((team) => team.instance.name === name)?.instance;
        // A tool's command reads its home from the variables teamai names for it in init, a shipped tool's as an instance's.
        const variables = homeEnv[name] ?? [];
        const teamaiHome = instance?.home ? instanceHomeOf(instance.home) : variables.map((one) => process.env[one]).find((dir) => dir !== undefined && dir !== '') ?? path.join(getUserHome(), homeDirOf(tool));
        const variable = variables.find((one) => custom.get(provider)?.env?.[one] !== undefined);
        const set = variable === undefined ? undefined : custom.get(provider)?.env?.[variable];
        const providerHome = variable !== undefined && set !== undefined && path.isAbsolute(set) ? { variable, dir: set, teamaiHome } : undefined;
        const runsIn = providerHome ? { variables, dir: providerHome.dir, shown: providerHome.dir } : instance?.home && { variables, dir: teamaiHome, shown: shownPath(teamaiHome) };
        // A request Paseo fails for one provider leaves that tool unavailable, never the runtime's other tools.
        let signedIn: SignIn;

        try {
          signedIn = await signIn({ name, tool, provider }, { runsIn, command: instance?.command, isCheck });
        } catch (error) {
          signedIn = { canRun: false, problem: `Paseo failed its diagnostic (${PaseoSaidSchema.parse(error)}); run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why` };
        }

        if (!signedIn.canRun) return cannotRun(signedIn.problem);
        const listed = await modesOf(tool, provider);

        return 'cannot' in listed ? cannotRun(listed.cannot) : { kind: 'runs', name, tool, provider, ...listed, ...(signedIn.home !== undefined && { home: signedIn.home }), ...(providerHome && { providerHome }) };
      }));
    },
    async addProvider({ id, entry }, instance, homeEnv) {
      const tool = entry.extends;
      const home = ownHome(instance);
      let found: ProviderFound;

      try {
        // Read again: another runtime may have added it since this one's init.
        const parsed = CustomProvidersSchema.safeParse((await api.config.get()).config.providers);
        found = providerOf(instance, tool, { custom: parsed.success ? keptOf(parsed.data, homeEnv) : {}, named: undefined, homeEnv, onThisMachine: true, ...home });
      } catch (error) {
        return { cannot: `Paseo did not answer with its providers (${PaseoSaidSchema.parse(error)}); check that its daemon answers with \`paseo ls\`, then run the step again`, added: false };
      }

      if ('cannot' in found) return { ...found, added: false };
      const setUp = entry.command ? `with command ${JSON.stringify(entry.command)}` : `with env ${JSON.stringify(entry.env ?? {})}`;
      let added = false;

      if ('add' in found) {
        try {
          await api.config.patch({ providers: { [id]: entry } });
          added = true;
        } catch (error) {
          return { cannot: `Paseo refused the provider ${id} teamai added for it (${PaseoSaidSchema.parse(error)}); add one on the daemon's host that extends ${tool} ${setUp}, or name one in the runtime's providers option`, added: false };
        }
      }

      const provider = 'add' in found ? id : found.provider;
      const before = custom;
      custom = new Map(custom).set(provider, 'add' in found ? entry : custom.get(provider) ?? { extends: tool });

      /**
       * Why the instance cannot run on `provider`. One this call added is removed again, through the same config change
       * Paseo's app removes a provider with: no agent ran on it yet, so none loses its logs. One Paseo will not remove
       * stays, and the caller says how to remove it. Every add runs under the journal's hold of this daemon's providers,
       * so no other add changed `custom` since `before` was read.
       */
      const cannotRun = async (why: string): Promise<Added> => {
        if (!added) return { cannot: why, added };

        try {
          await api.config.patch({ removeProviders: [id] });
          custom = before;

          return { cannot: why, added: false };
        } catch (error) {
          return { cannot: `${why}. teamai could not remove the provider ${id} it added for it (${PaseoSaidSchema.parse(error)}), so it may stay`, added };
        }
      };

      let signedIn: SignIn;

      try {
        const { providers } = await api.providers.listAvailable();

        if (!providers.some((listed) => listed.provider === provider && listed.available)) {
          return await cannotRun(`Paseo does not find the command of its provider ${provider} on the daemon's PATH; install it there, then \`paseo daemon reload\``);
        }

        signedIn = await signIn({ name: instance.name, tool, provider }, { runsIn: home.home === undefined ? undefined : { variables: homeEnv, dir: home.home, shown: shownPath(home.home) }, command: instance.command, isCheck: false });
      } catch (error) {
        return cannotRun(`Paseo failed its diagnostic (${PaseoSaidSchema.parse(error)}); run \`paseo provider diagnostic ${provider}\` on the daemon's host to see why`);
      }

      if (!signedIn.canRun) return cannotRun(signedIn.problem);

      // The provider it added, or one with no command of its own that it matched, runs in the instance's own home.
      const providerHome = ('add' in found || instance.command === undefined) ? home.home : undefined;

      return { provider, added, ...(signedIn.home !== undefined && { home: signedIn.home }), ...(providerHome !== undefined && { providerHome }) };
    },
    models,
    isOpen: (cwd) => answeredInTime(isOpenIn(api, cwd)),
    async memberAgentsIn(workspaceId) {
      const found: string[] = [];

      for (let cursor: string | undefined; ;) {
        const listed = await api.agents.list({ page: { limit: 200, ...(cursor !== undefined && { cursor }) } });
        found.push(...listed.entries.flatMap(({ agent }) => (agent.workspaceId === workspaceId && !agent.archivedAt && agent.status !== 'closed' && !Object.hasOwn(agent.labels, 'teamai-attempt') ? [agent.id] : [])));
        const next = listed.pageInfo.nextCursor;

        if (!listed.pageInfo.hasMore || !next) return found;
        cursor = next;
      }
    },
    async workspace(cwd) {
      const opened = await answeredInTime(api.workspaces.open({ cwd }), '; if Paseo opens it later, archive that workspace in the Paseo app');
      const current = opened.current();

      return { id: opened.id, name: current?.projectDisplayName ?? opened.name ?? opened.id, directory: opened.directory ?? cwd };
    },
    async wrapperProvider({ id, tool, found }) {
      const cannot = (why: string): Added => ({ cannot: why, added: false });
      let configured: CustomProviders;

      try {
        // Read again: another runtime may have added it since this one's init.
        const parsed = CustomProvidersSchema.safeParse((await api.config.get()).config.providers);
        configured = parsed.success ? parsed.data : {};
      } catch (error) {
        return cannot(`Paseo did not answer with its providers (${PaseoSaidSchema.parse(error)}); check that its daemon answers with \`paseo ls\``);
      }

      const setUp = `add one on the daemon's host that extends ${tool} with command ${JSON.stringify([id])} (\`paseo daemon config set agents.providers …\`, then \`paseo daemon reload\`)`;
      let provider = Object.entries(configured).find(([, entry]) => entry.extends === tool && daemonRuns({ executable: entry.command?.[0], command: id, hostPlatform: isOnThisMachine(url) ? process.platform : undefined }))?.[0];
      let added = false;

      if (provider === undefined) {
        if (!isOnThisMachine(url)) return cannot(`no Paseo provider runs ${id}, and teamai adds one only on a daemon on this machine; ${setUp}`);

        if (found === null) return cannot(`no Paseo provider runs ${id}, and teamai finds no ${id} on its PATH to add one; install teamai-cli where it finds ${id}, or ${setUp}`);
        const taken = configured[id];

        if (taken !== undefined) return cannot(`no Paseo provider runs ${id}, and the Paseo provider ${id} runs ${taken.command?.[0] ?? `${taken.extends ?? tool}'s own command`} instead, so teamai adds none under that name; point that provider at ${found}`);
        const entry = { extends: tool, label: id, command: [found] };

        try {
          await api.config.patch({ providers: { [id]: entry } });
        } catch (error) {
          return cannot(`Paseo refused the provider ${id} teamai added for it (${PaseoSaidSchema.parse(error)}); ${setUp}`);
        }

        provider = id;
        added = true;
        custom = new Map(custom).set(id, entry);
      }

      try {
        const { providers } = await api.providers.listAvailable();

        if (!providers.some((listed) => listed.provider === provider && listed.available)) {
          return { cannot: `Paseo does not find the command of its provider ${provider} on the daemon's PATH; install teamai-cli there, then \`paseo daemon reload\``, added };
        }
      } catch (error) {
        return { cannot: `Paseo did not list its providers (${PaseoSaidSchema.parse(error)}); run \`paseo provider ls\` on the daemon's host to see why`, added };
      }

      return { provider, added };
    },
    async create(cwd, create, { isIdle } = { isIdle: false }) {
      // Paseo keeps a create's env in plain text and applies it again on resume, so it carries no secret, only the run
      // directory's name: tools use the daemon host's own logins.
      let workspace: Awaited<ReturnType<PaseoApi['workspaces']['open']>>;

      try {
        workspace = await api.workspaces.open({ cwd });
      } catch (error) {
        return { outcome: 'unsent', cause: error instanceof Error ? error.message : String(error) };
      }

      try {
        const { prompt, ...withoutPrompt } = create;
        await workspace.agents.create(isIdle ? withoutPrompt : { ...withoutPrompt, prompt });

        return { outcome: 'created' };
      } catch (error) {
        return { outcome: 'failed', cause: error instanceof Error ? error.message : String(error) };
      }
    },
    async agent(agentId) {
      return (await client.fetchAgent(agentId))?.agent ?? null;
    },
    async start(agentId) {
      const { error } = await client.listCommands(agentId);

      if (error) throw new Error(error);
    },
    async send(agentId, text) {
      // Paseo's client throws a message the daemon did not accept.
      await client.sendAgentMessage(agentId, text);
    },
    allow: (agentId, requestId) => client.respondToPermission(agentId, requestId, { behavior: 'allow' }),
    async sessions(cwd, provider) {
      const listed = await client.fetchRecentProviderSessions({ cwd, providers: [provider], limit: 200 });

      return listed.entries.map((entry) => entry.providerHandleId);
    },
    async importSession({ provider, session, cwd, workspaceId, labels }) {
      return (await client.importAgent({ providerId: provider, providerHandleId: session, cwd, workspaceId, labels })).id;
    },
    async configure(agentId, { model, modeId, thinkingOptionId }) {
      await client.setAgentModel(agentId, model);

      if (modeId !== undefined) await client.setAgentMode(agentId, modeId);

      if (thinkingOptionId !== undefined) await client.setAgentThinkingOption(agentId, thinkingOptionId);
    },
    remove: (agentId) => client.deleteAgent(agentId),
    wait: (agentId) => client.waitForFinish(agentId, 0),
    cancel: (agentId) => client.cancelAgent(agentId),
    async archive(workspaceId) {
      // Paseo answers a refused archive with its error rather than throwing it.
      const { error } = await api.workspaces.archive(workspaceId);

      if (error) throw new Error(error);
    },
    link: (agentId) => paseo.buildAgentDeepLink({ serverId, agentId }),
    routesHosts: info.features?.connectedHosts === true,
    hosts: () => savedHosts(api),
    host: (hostId) => routedHost(api, paseo, hostId),
    sessionHome(tool, sessionId, { claudeHome, providerHome, homeDir, since }) {
      switch (tool) {
        case 'claude':
          return claudeHome ?? providerHome;
        case 'codex':
          return isOnThisMachine(url) ? codexHomeHolding(sessionId, { providerHome, homeDir }) : undefined;
        case 'opencode':
          return isOnThisMachine(url) ? openCodeDataHome(providerHome, since) : undefined;
        default: {
          const unhandled: never = tool;

          return unhandled;
        }
      }
    },
    async close() {
      await api.dispose().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  SessionInboundMessageSchema, WSInboundMessageSchema, WSOutboundMessageSchema, type CreationSnapshot, type WorkspaceDescriptorPayload,
} from '@getpaseo/protocol/messages';
import { entriesUnder } from '@teamai/shared/entries-under';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

// ─── A fake Paseo daemon ─────────────────────────────────
//
//  The part of Paseo 0.14.0's WebSocket protocol teamai-runtime-paseo speaks, as the real daemon answers it (recorded
//  against 0.14.0): hello, provider discovery and diagnostics, workspace open, agent create with an idempotency key and a caller-chosen
//  id, wait for finish, fetch and cancel. Every frame it sends and receives is checked against Paseo's own schemas.
//
//  It runs as its own process over a state directory, so a test restarts it as a person restarts Paseo:
//
//    agents.json         its agents, workspaces and create receipts, which a restart reads again; an agent that was
//                        running when it stopped comes back `closed`, as Paseo marks it
//    behaviour.json      how its next agents behave (`Behaviour`), and which version and models it offers
//    requests.jsonl      every agent create, start, message, cancel and delete, workspace archive and config change it
//                        received, for a test to read what crossed
//    stopped.jsonl       each agent a cancel or an archive stopped, once it stopped running, which may be after the answer
//    answers/<agent>     a person answered the agent's permission request in the app, or a client allowed it
//    started.jsonl       each start of a custom provider's command for an agent, with how it ended
//    waited.jsonl        each agent a client asked to wait for, as the request came
//
//  It routes a client to the other daemons it saved as hosts (`hosts`), as `paseo host add` saves one: a route carries
//  the client's frames to that daemon's WebSocket and its answers back, as text frames.
//
//  An agent finds the result file the way a real one does, in teamai's prompt, and writes its output there.
//

const BehaviourSchema = z.object({
  /** The daemon's version in hello. */
  version: z.string().default('0.14.0'),
  /** Features hello leaves out. */
  missing: z.array(z.string()).default([]),
  /** The daemon's server id in hello. */
  server_id: z.string().default('srv_fake0001'),
  /**
   * The other daemons it saved as hosts, as `paseo host add` saves one: listed with their status, and routed to at `url`
   * while online. A route to one that does not answer there fails as Paseo fails a route to a host it lost.
   */
  hosts: z.array(z.object({ label: z.string(), server_id: z.string(), url: z.string(), status: z.enum(['connecting', 'online', 'offline', 'error', 'disabled']).default('online') })).default([]),
  /** The origin URL of the git checkout in each directory, which a workspace there reports as Paseo 0.14.0 does (recorded). */
  repositories: z.record(z.string(), z.string()).default({}),
  /**
   * The models each provider offers; a provider absent here is unavailable. An empty list is OpenCode connected to no
   * model provider: installed, so available, with a catalog that fails.
   */
  models: z.record(z.string(), z.array(z.string())).default({ claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], codex: ['gpt-6.1-sol'], opencode: ['opencode/beam-free'] }),
  /**
   * How a provider's diagnostic reports its sign-in; signed in when absent. Paseo calls a signed-out provider available
   * all the same. `unreported` leaves out the `Auth` row, as Codex's always does.
   */
  sign_in: z.record(z.string(), z.enum(['signed_out', 'unreported'])).default({}),
  /**
   * How `codex login status` answers on the daemon's host, which is this machine: the fake writes there a `codex` that
   * answers as Codex 0.166.0 does (recorded), or, `unknown`, as a codex that has no such command; its diagnostic's
   * resolved path names it. Absent, that path holds no codex.
   */
  codex_login: z.enum(['signed_in', 'signed_out', 'unknown']).optional(),
  /** The Codex home that `codex_login: signed_in` holds: the fake codex answers signed out unless CODEX_HOME names it. */
  codex_login_home: z.string().optional(),
  /** The fake codex refuses a CODEX_HOME that does not exist before it answers, as Codex 0.166.0 does (recorded). */
  codex_needs_home: z.boolean().default(false),
  /**
   * The config directory of the daemon's Claude, which `claude auth status` reports from Claude Code 2.1 on as
   * `configDirectory`, beside its `projectsDirectory` (recorded on 2.1.318). Absent: an older Claude that reports neither.
   */
  claude_home: z.string().optional(),
  /**
   * The Codex home of the daemon's Codex: a Codex agent writes its session's rollout there as Codex does,
   * `sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl` (recorded on codex-cli 0.167.0). Absent: none written.
   */
  codex_home: z.string().optional(),
  /**
   * The data directory of the daemon's OpenCode, its `XDG_DATA_HOME`: an OpenCode agent keeps its session in the
   * database OpenCode 2 writes there, `opencode/opencode.db`. Absent: none written.
   */
  opencode_data_home: z.string().optional(),
  /** The path Codex's diagnostic resolves, as it is, instead of the host's `codex` above. */
  codex_path: z.string().optional(),
  /**
   * The URL of OpenCode's own background server running on the daemon's host, which Paseo 0.15.2 shares instead of
   * starting one per agent; its OpenCode diagnostic then names only that server (recorded).
   */
  opencode_server: z.string().optional(),
  /**
   * The custom providers in the daemon's `agents.providers`, by id, as the member adds them: each extends a built-in
   * provider and runs its own command, as a team tool instance does. Paseo lists one beside the built-in ones, with the
   * modes and models of the provider it extends, and calls it available once its command is on the daemon's PATH. One with
   * no command runs the tool's own.
   */
  custom_providers: z.record(z.string(), z.object({ extends: z.string(), label: z.string().optional(), command: z.array(z.string()).min(1).optional(), env: z.record(z.string(), z.string()).optional() })).default({}),
  /** Directories the member already has open as Paseo workspaces, as the app opens a project. */
  member_workspaces: z.array(z.string()).default([]),
  /**
   * While a step's agent works, the member opens its directory in the Paseo app, which answers the same workspace, and
   * starts an agent of their own there.
   */
  member_joins: z.boolean().default(false),
  /** The default mode the providers snapshot gives a provider, over Paseo 0.14.0's own; null: none, as OpenCode's. */
  default_modes: z.record(z.string(), z.string().nullable()).default({}),
  /** The output the agent writes to the result file; none written when absent. */
  output: z.unknown().optional(),
  /** The agent's last message, which a confined prompt's answer is. */
  reply: z.string().default('Done.'),
  /** A failure the agent writes to the result file instead. */
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  /** The result file the agent writes, as it is, instead of one built from `output` or `failure`. */
  result: z.unknown().optional(),
  /** How long the agent works. */
  hold_ms: z.number().int().nonnegative().default(0),
  /** The agent works until this file exists. */
  release: z.string().optional(),
  /** A file the agent writes in its cwd as soon as it starts: its work. */
  touch: z.string().optional(),
  /** The agent asks for permission to run a command first, and waits for an answer. */
  ask_permission: z.boolean().default(false),
  /**
   * The agent asks for permission before it writes a result file in a directory its create did not allow, as Claude does
   * in Always Ask (recorded on Paseo 0.14.0: a `Write` request whose detail is `{ type: 'write', filePath }`), and waits
   * for an answer, from the app or from `agent_permission_response`.
   */
  asks_outside_grant: z.boolean().default(false),
  /**
   * The sessions the daemon's providers hold, which Paseo lists as importable in any directory until an agent has one.
   * An import of any other session is taken all the same, and its agent's first turn fails, as Paseo 0.14.0 does (recorded).
   */
  provider_sessions: z.array(z.string()).default([]),
  /** The person deletes in the Paseo app the agent each of these creates started (by idempotency key: teamai's op), before the daemon answers the next request. */
  forget_creates: z.array(z.string()).default([]),
  /** The provider reports no session id once the agent is done. */
  no_session: z.boolean().default(false),
  /**
   * The tokens each turn of the agent bills, which its tool records in its session's own usage lines: a Claude agent's
   * assistant message in its transcript under `claude_home`, a Codex agent's response record in its rollout under
   * `codex_home`, with the thread's running total.
   */
  usage: z.object({ input: z.number(), output: z.number(), cache_read: z.number() }).optional(),
  /** The provider fails the agent with this error. */
  error: z.string().optional(),
  /** The daemon refuses a cancel with this error, and the agent goes on. */
  refuse_cancel: z.string().optional(),
  /** How long the daemon takes to answer a refused cancel. */
  refuse_cancel_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to answer a cancel it takes, which stops the agent at once (after `stop_lag_ms`). */
  cancel_reply_ms: z.number().int().nonnegative().default(0),
  /** How long an agent goes on running after the daemon answered a cancel or an archive that stops it. */
  stop_lag_ms: z.number().int().nonnegative().default(0),
  /**
   * The provider requests the daemon fails, by provider: its diagnostic or its modes listing, answered with this error as
   * the daemon answers a request its handler threw on.
   */
  provider_errors: z.record(z.string(), z.object({ request: z.enum(['diagnostic', 'modes']), error: z.string() })).default({}),
  /** How long the daemon takes to save a config change, as one that persists and applies it does. */
  config_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to save a config change that adds one of these providers, by id, over `config_ms`. */
  provider_config_ms: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** The daemon refuses every config change with this error. */
  refuse_config: z.string().optional(),
  /** The daemon refuses every config change that removes a provider with this error. */
  refuse_remove: z.string().optional(),
  /** The daemon fails every read of its config with this error. */
  refuse_config_read: z.string().optional(),
  /** The daemon refuses to archive a workspace with this error. */
  refuse_archive: z.string().optional(),
  /** The daemon answers every agent lookup with this error. */
  refuse_fetch: z.string().optional(),
  /** How long the daemon takes to answer an agent lookup, as a busy daemon does. */
  fetch_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to list a provider's models, as a provider SDK that is slow to start does. */
  models_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to list its workspaces, answering with those open by then. */
  list_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to open a workspace, as a slow host does. */
  open_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to answer an open that makes a workspace, which exists before the answer; one that finds a workspace answers at once. */
  open_reply_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to create an agent, as a provider that is slow to start does. */
  create_ms: z.number().int().nonnegative().default(0),
  /** How long the daemon takes to archive a workspace. */
  archive_ms: z.number().int().nonnegative().default(0),
  /**
   * The daemon answers the create with this error at once, as a dropped connection does, yet creates and starts the agent
   * `create_ms` later: its answer came before the agent existed.
   */
  refuse_create_early: z.string().optional(),
  /** The daemon creates the agent and starts it, but its answer is lost: the create fails as a dropped connection does. */
  lose_create_reply: z.boolean().default(false),
});

export type Behaviour = z.input<typeof BehaviourSchema>;

/** The providers the fake runs, as Paseo names them. */
type Provider = 'claude' | 'codex' | 'opencode';

/** Each provider's modes, in Paseo's order, as Paseo 0.14.0 lists them (recorded): `dangerous` marks a mode that never asks. */
const MODES: Readonly<Record<Provider, Array<{ id: string; label: string; colorTier: string }>>> = {
  claude: [
    { id: 'plan', label: 'Plan Mode', colorTier: 'planning' }, { id: 'default', label: 'Always Ask', colorTier: 'safe' },
    { id: 'acceptEdits', label: 'Accept File Edits', colorTier: 'moderate' }, { id: 'auto', label: 'Auto mode', colorTier: 'moderate' },
    { id: 'bypassPermissions', label: 'Bypass', colorTier: 'dangerous' },
  ],
  codex: [{ id: 'auto', label: 'Default Permissions', colorTier: 'moderate' }, { id: 'auto-review', label: 'Auto-review', colorTier: 'moderate' }, { id: 'full-access', label: 'Full Access', colorTier: 'dangerous' }],
  opencode: [{ id: 'build', label: 'Build', colorTier: 'moderate' }, { id: 'plan', label: 'Plan', colorTier: 'planning' }],
};

/** The mode Paseo 0.14.0 starts each provider in, as its providers snapshot reports it (recorded): none for OpenCode. */
const DEFAULT_MODES: Readonly<Record<Provider, string | null>> = { claude: 'auto', codex: 'auto-review', opencode: null };

const FEATURES = ['creationLifecycle', 'agentRequestReceipts', 'ownedSubscriptions', 'workspaceRequestReceipts', 'connectedHosts'];

const AgentRecordSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  modeId: z.string().nullable(),
  cwd: z.string(),
  workspaceId: z.string(),
  title: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  status: z.enum(['initializing', 'idle', 'running', 'error', 'closed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  sessionId: z.string().nullable(),
  lastError: z.string().optional(),
  permission: z.boolean(),
  /** The file the agent asks to write, when its permission request is to write one outside what its create allowed. */
  asked: z.string().optional(),
  /** The directories its create allowed it to write without asking, as Claude's `Edit(/<dir>/**)` rules name them. */
  allowed: z.array(z.string()).default([]),
  behaviour: BehaviourSchema,
  prompt: z.string(),
});

type AgentRecord = z.infer<typeof AgentRecordSchema>;

/**
 * A Codex agent's turn in its session's rollout, as Codex writes one: the first turn starts the rollout
 * (`sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session id>.jsonl`), and a later turn goes on in it. With `usage`, the
 * turn's response record bills it, counting cached input inside the input tokens, beside the thread's running total.
 */
/** The rollout of `sessionId` under `sessions`, relative to it; none when the store holds none, or has a folder it cannot list. */
function rolloutUnder(sessions: string, sessionId: string): string | undefined {
  try {
    return fs.existsSync(sessions) ? entriesUnder(sessions).find(({ entry }) => entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`))?.relative : undefined;
  } catch {
    // A folder of the store it cannot list, as another user's: Codex finds its session by its id, and writes on.
    return undefined;
  }
}

function writeRollout(agent: AgentRecord, home: string, sessionId: string): void {
  const at = new Date();
  const sessions = path.join(home, 'sessions');
  const kept = rolloutUnder(sessions, sessionId);
  const day = path.join(sessions, String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0'));
  const file = kept === undefined ? path.join(day, `rollout-${at.toISOString().slice(0, 19).replaceAll(':', '-')}-${sessionId}.jsonl`) : path.join(sessions, kept);
  const { usage } = agent.behaviour;
  const turn = kept === undefined ? 1 : fs.readFileSync(file, 'utf8').split('"token_usage_record"').length;

  const counted = (times: number, billed: NonNullable<typeof usage>) => ({
    input_tokens: (billed.input + billed.cache_read) * times, cached_input_tokens: billed.cache_read * times, cache_write_input_tokens: 0,
    output_tokens: billed.output * times, reasoning_output_tokens: 0, total_tokens: (billed.input + billed.cache_read + billed.output) * times,
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, [
    ...(kept === undefined ? [{ timestamp: at.toISOString(), type: 'session_meta', payload: { id: sessionId, cwd: agent.cwd } }] : []),
    { timestamp: at.toISOString(), type: 'turn_context', payload: { turn_id: `turn-${turn}`, cwd: agent.cwd, model: agent.model ?? 'gpt-6.1-sol' } },
    ...(usage ? [{ timestamp: at.toISOString(), type: 'token_usage_record', payload: { thread_id: sessionId, session_id: sessionId, response_id: `resp_${turn}`, usage: counted(1, usage), thread_token_usage: counted(turn, usage) } }] : []),
  ].map((line) => `${JSON.stringify(line)}\n`).join(''));
}

/**
 * A Claude agent's turn in its session's transcript, as Claude Code writes one in `projects/<encoded cwd>/<session>.jsonl`
 * under its config directory: the prompt, then the assistant's message, which bills `usage` when the turn has one.
 */
function writeClaudeTranscript(agent: AgentRecord, home: string, sessionId: string): void {
  const dir = path.join(home, 'projects', encodeCwdClaude(agent.cwd));
  const file = path.join(dir, `${sessionId}.jsonl`);
  const turn = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('"type":"assistant"').length : 1;
  const at = new Date().toISOString();
  const { usage } = agent.behaviour;
  const message = { role: 'assistant', model: agent.model ?? 'claude-opus-5-5', content: [{ type: 'text', text: agent.behaviour.reply }] };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, [
    { type: 'user', sessionId, cwd: agent.cwd, timestamp: at, message: { role: 'user', content: agent.prompt } },
    {
      type: 'assistant', sessionId, cwd: agent.cwd, timestamp: at, requestId: `req_${turn}`,
      message: usage ? { id: `msg_${turn}`, ...message, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cache_read, cache_creation_input_tokens: 0 } } : message,
    },
  ].map((line) => `${JSON.stringify(line)}\n`).join(''));
}

/** The Claude launch options of a create: the tools it may use without asking. */
const AllowedSchema = z.looseObject({ allowedTools: z.array(z.string()) });

const StateSchema = z.object({
  agents: z.record(z.string(), AgentRecordSchema),
  workspaces: z.record(z.string(), z.string()),
  receipts: z.record(z.string(), z.object({ agentId: z.string(), fingerprint: z.string() })),
});

type Inbound = z.infer<typeof SessionInboundMessageSchema>;

type Outbound = z.input<typeof WSOutboundMessageSchema>;

type Reply = Extract<Outbound, { type: 'session' }>['message'];

const isProvider = (provider: string): provider is Provider => Object.hasOwn(MODES, provider);

const modesOf = (provider: string | undefined): Array<{ id: string; label: string; colorTier: string }> => (provider !== undefined && isProvider(provider) ? MODES[provider] : []);

function now(): string {
  return new Date().toISOString();
}

/** Where the fake listens: a TCP port on 127.0.0.1 (0 for any free one), or, with `socket`, that Unix socket instead. */
export async function startFakeDaemon({ state, port, socket: socketPath }: { state: string; port: number; socket?: string }): Promise<{ url: string; close(): Promise<void> }> {
  fs.mkdirSync(path.join(state, 'answers'), { recursive: true });
  const stateFile = path.join(state, 'agents.json');
  const kept = fs.existsSync(stateFile) ? StateSchema.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8'))) : { agents: {}, workspaces: {}, receipts: {} };

  // A restart ends every agent that was working: Paseo keeps nothing that tells completed apart from killed.
  for (const agent of Object.values(kept.agents)) {
    if (agent.status === 'running' || agent.status === 'initializing') Object.assign(agent, { status: 'closed', permission: false, updatedAt: now() });
  }

  const save = (): void => {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(kept));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };

  save();

  const behaviour = (): z.infer<typeof BehaviourSchema> => {
    const file = path.join(state, 'behaviour.json');

    return BehaviourSchema.parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  };

  /** The built-in provider `provider` is or extends, or undefined for one the daemon does not hold. */
  const baseOf = (provider: string): Provider | undefined => {
    const base = isProvider(provider) ? provider : behaviour().custom_providers[provider]?.extends;

    return base !== undefined && isProvider(base) ? base : undefined;
  };

  const waiters = new Map<string, Array<() => void>>();
  const timers = new Set<NodeJS.Timeout>();

  const changed = (agent: AgentRecord): void => {
    agent.updatedAt = now();
    save();

    for (const wake of waiters.get(agent.id)?.splice(0) ?? []) wake();
  };

  const snapshot = (agent: AgentRecord) => {
    const shown = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    model: agent.model,
    features: [],
    thinkingOptionId: agent.thinking,
    effectiveThinkingOptionId: agent.thinking,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.createdAt,
    status: agent.status,
    activeTurn: agent.status === 'running' ? { turnId: 'foreground-turn-1', startedAt: agent.createdAt } : null,
    capabilities: {
      supportsStreaming: true, supportsSessionPersistence: true, supportsSessionListing: true, supportsDynamicModes: true, supportsMcpServers: true,
      supportsReasoningStream: true, supportsToolInvocations: true, supportsRewindConversation: false, supportsRewindFiles: false, supportsRewindBoth: false,
    },
    currentModeId: agent.modeId,
    availableModes: modesOf(agent.provider),
    pendingPermissions: !agent.permission ? [] : agent.asked !== undefined
      ? [{ id: `perm-write-${agent.id}`, provider: agent.provider, name: 'Write', kind: 'tool' as const, input: { file_path: agent.asked }, detail: { type: 'write' as const, filePath: agent.asked } }]
      : [{ id: `perm-${agent.id}`, provider: agent.provider, name: 'Bash', kind: 'tool' as const, title: 'Run npm test' }],
    persistence: null,
    runtimeInfo: { provider: agent.provider, sessionId: agent.sessionId, model: agent.model, modeId: agent.modeId },
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.permission || agent.status !== 'running',
    attentionReason: agent.permission ? 'permission' as const : agent.status === 'error' ? 'error' as const : agent.status === 'running' ? null : 'finished' as const,
    attentionTimestamp: null,
    archivedAt: null,
    };

    return agent.lastError === undefined ? shown : { ...shown, lastError: agent.lastError };
  };

  const finish = (agent: AgentRecord): void => {
    const { behaviour: does } = agent;

    if (does.error !== undefined) {
      Object.assign(agent, { status: 'error', lastError: does.error });
    } else {
      // A real agent reads where to write its result in teamai's prompt.
      const result = /Write the workflow result as JSON to (.+?)\.(?:\s|$)/.exec(agent.prompt)?.[1];

      if (result && (does.result !== undefined || does.output !== undefined || does.failure)) {
        fs.mkdirSync(path.dirname(result), { recursive: true });
        fs.writeFileSync(result, JSON.stringify(does.result ?? (does.failure ? { failure: does.failure } : { output: does.output })));
      }

      Object.assign(agent, { status: 'idle', sessionId: does.no_session ? null : agent.sessionId ?? `fake-session-${agent.id}` });

      if (baseOf(agent.provider) === 'codex' && does.codex_home !== undefined && agent.sessionId) writeRollout(agent, does.codex_home, agent.sessionId);

      if (baseOf(agent.provider) === 'claude' && does.claude_home !== undefined && agent.sessionId) writeClaudeTranscript(agent, does.claude_home, agent.sessionId);

      if (baseOf(agent.provider) === 'opencode' && does.opencode_data_home !== undefined && agent.sessionId) {
        fs.mkdirSync(path.join(does.opencode_data_home, 'opencode'), { recursive: true });
        fs.appendFileSync(path.join(does.opencode_data_home, 'opencode', 'opencode.db'), `${agent.sessionId}\n`);
      }
    }

    changed(agent);
  };

  /** The agents a cancel or an archive is stopping, which no longer finish their turn. */
  const stopping = new Set<string>();

  /** Stops a running agent, once the stop lag has passed, and records when it stopped. */
  const stop = (agent: AgentRecord, status: 'idle' | 'closed'): void => {
    if (agent.status !== 'running' || stopping.has(agent.id)) return;
    stopping.add(agent.id);

    const end = (): void => {
      stopping.delete(agent.id);
      // Paseo reports a cancelled agent as idle, and an archived one as closed.
      Object.assign(agent, { status, permission: false, sessionId: `fake-session-${agent.id}` });
      fs.appendFileSync(path.join(state, 'stopped.jsonl'), `${JSON.stringify({ agentId: agent.id, status })}\n`);
      changed(agent);
    };

    const lag = behaviour().stop_lag_ms;

    if (lag === 0) {
      end();

      return;
    }

    timers.add(setTimeout(end, lag));
  };

  /**
   * Starts the tool of an agent on a custom provider that runs its own command, as Paseo starts it, in the agent's
   * directory with PASEO_AGENT_ID and PASEO_AGENT_CWD set, and resolves to why it did not start: a command that exits
   * non-zero, or cannot run. A built-in provider's tool starts on this host, idle, as Paseo's does: nothing to run here.
   */
  const startTool = (agent: AgentRecord): Promise<string | undefined> => {
    const command = behaviour().custom_providers[agent.provider]?.command;

    if (!command) return Promise.resolve(undefined);
    const [file = '', ...args] = command;

    return new Promise((resolve) => {
      const child = spawn(file, args, { cwd: agent.cwd, env: { ...process.env, PASEO_AGENT_ID: agent.id, PASEO_AGENT_CWD: agent.cwd }, stdio: 'ignore' });

      const ended = (why: string | undefined): void => {
        fs.appendFileSync(path.join(state, 'started.jsonl'), `${JSON.stringify({ agentId: agent.id, command, ...(why !== undefined && { failed: why }) })}\n`);
        resolve(why);
      };

      child.once('error', (error) => ended(error.message));
      child.once('exit', (code, signal) => ended(code === 0 ? undefined : `${file} exited with ${signal ?? `code ${code}`}`));
    });
  };

  /** Runs an agent's turn: its work, a permission it waits on, then its hold or release, then its end. */
  const work = (agent: AgentRecord): void => {
    const { behaviour: does } = agent;
    const result = /Write the workflow result as JSON to (.+?)\.(?:\s|$)/.exec(agent.prompt)?.[1];

    if (does.asks_outside_grant && result && !agent.allowed.includes(path.dirname(result))) {
      fs.rmSync(path.join(state, 'answers', agent.id), { force: true });
      Object.assign(agent, { permission: true, asked: result });
      changed(agent);
    }

    if (does.touch) fs.writeFileSync(path.join(agent.cwd, does.touch), 'work in progress\n');
    const started = Date.now();

    const tick = setInterval(() => {
      if (agent.status !== 'running') {
        clearInterval(tick);
        timers.delete(tick);

        return;
      }

      if (stopping.has(agent.id)) return;

      if (agent.permission) {
        if (!fs.existsSync(path.join(state, 'answers', agent.id))) return;
        Object.assign(agent, { permission: false, asked: undefined });
        changed(agent);
      }

      if (Date.now() - started < does.hold_ms || (does.release && !fs.existsSync(does.release))) return;
      clearInterval(tick);
      timers.delete(tick);
      finish(agent);
    }, 20);

    timers.add(tick);
  };

  const server = socketPath === undefined ? undefined : http.createServer();
  const wss = server ? new WebSocketServer({ server, path: '/ws' }) : new WebSocketServer({ host: '127.0.0.1', port, path: '/ws' });
  await new Promise<void>((resolve, reject) => {
    const listening = server ?? wss;
    listening.once('listening', resolve);
    listening.once('error', reject);
    server?.listen(socketPath);
  });

  wss.on('connection', (socket: WebSocket) => {
    const send = (message: Outbound): void => {
      // A frame Paseo's client would reject fails here, where the fake wrote it.
      socket.send(JSON.stringify(WSOutboundMessageSchema.parse(message)));
    };

    const reply = (message: Reply): void => send({ type: 'session', message });
    /** The routes this client opened to saved hosts, by route id. */
    const routes = new Map<string, WebSocket>();

    socket.on('close', () => {
      const open = [...routes.values()];
      routes.clear();

      for (const route of open) route.close();
    });

    socket.on('message', (data) => {
      const frame = WSInboundMessageSchema.parse(JSON.parse(String(data)));

      if (frame.type === 'ping') {
        send({ type: 'pong' });

        return;
      }

      if (frame.type === 'hello') {
        const does = behaviour();
        reply({
          type: 'status',
          payload: {
            status: 'server_info', protocolVersion: 1, serverId: does.server_id, hostname: 'fake-host', version: does.version, sourceId: 'owner',
            permissions: ['daemon.read', 'workspace.read', 'workspace.write', 'workspace.manage'], desktopManaged: false,
            features: Object.fromEntries(FEATURES.flatMap((feature) => (does.missing.includes(feature) ? [] : [[feature, true]]))),
          },
        });

        return;
      }

      if (frame.type !== 'session') return;

      if (!route(frame.message, reply, routes)) handle(frame.message, reply);
    });
  });

  /**
   * Answers a request about saved hosts, and says whether `message` was one: the host list, and a route a client opens to
   * one of them, sends frames over and closes.
   */
  const route = (message: Inbound, reply: (message: Reply) => void, routes: Map<string, WebSocket>): boolean => {
    switch (message.type) {
      case 'hosts.list.request': {
        const { server_id: serverId, hosts } = behaviour();

        const listed = hosts.map((host, at) => ({
          registrationId: `hst_${at}`, serverId: host.server_id, label: host.label, source: { id: 'owner', key: 'fake' }, metadata: {}, enabled: host.status !== 'disabled',
          status: host.status, targetDescription: `tcp://${new URL(host.url).host}`, lastOnlineAt: null, nextRetryAt: null, error: null,
        }));

        reply({ type: 'hosts.list.response', payload: { requestId: message.requestId, directory: { self: { serverId, label: 'fake-host' }, hosts: listed } } });

        return true;
      }

      case 'hosts.route.open.request': {
        record(message);
        const host = behaviour().hosts.find((one) => one.server_id === message.serverId && one.status === 'online');
        const refuse = (error: string): void => reply({ type: 'rpc_error', payload: { requestId: message.requestId, requestType: message.type, error, code: 'host_offline' } });

        if (!host) {
          refuse(`Host ${message.serverId} is offline`);

          return true;
        }

        const routeId = `rte_${message.scopeId}`;
        const to = new WebSocket(host.url);
        routes.set(routeId, to);
        to.once('open', () => reply({ type: 'hosts.route.open.response', payload: { requestId: message.requestId, routeId } }));
        to.once('error', () => {
          routes.delete(routeId);
          refuse(`Host ${message.serverId} is offline`);
        });
        to.on('message', (data) => reply({ type: 'hosts.route.frame', payload: { subscriptionId: routeId, data: String(data), binary: false } }));
        to.once('close', () => {
          if (routes.delete(routeId)) reply({ type: 'hosts.route.closed', payload: { subscriptionId: routeId, code: 'host_offline', message: `Host ${message.serverId} is offline` } });
        });

        return true;
      }

      case 'hosts.route.frame.request':
        routes.get(message.routeId)?.send(message.data);

        return true;
      case 'hosts.route.close.request':
        for (const [routeId, to] of routes) {
          if (routeId !== message.routeId && routeId !== `rte_${message.scopeId}`) continue;
          routes.delete(routeId);
          to.close();
        }

        return true;
      default:
        return false;
    }
  };

  const record = (message: Inbound): void => {
    fs.appendFileSync(path.join(state, 'requests.jsonl'), `${JSON.stringify(message)}\n`);
  };

  /** The requests `requests.jsonl` keeps. */
  const RECORDED = new Set<Inbound['type']>(['agent.create.request', 'cancel_agent_request', 'archive_workspace_request', 'set_daemon_config_request', 'list_commands_request', 'send_agent_message_request', 'delete_agent_request', 'agent_permission_response', 'import_agent_request', 'set_agent_model_request', 'set_agent_mode_request', 'set_agent_thinking_request']);

  /** The requests already held for the delay `models_ms`, `open_ms`, `create_ms` or `archive_ms` gives them. */
  const held = new WeakSet<Inbound>();

  /** Opens the member's own workspaces once, as the app did before teamai came. */
  const openMembers = (): void => {
    for (const dir of behaviour().member_workspaces) {
      const cwd = path.resolve(dir);
      kept.workspaces[cwd] ??= `wks_${createHash('sha256').update(`member:${cwd}`).digest('hex').slice(0, 16)}`;
    }
  };

  function handle(message: Inbound, reply: (message: Reply) => void): void {
    openMembers();

    for (const key of behaviour().forget_creates) {
      const receipt = kept.receipts[key];

      if (receipt && kept.agents[receipt.agentId]) {
        delete kept.agents[receipt.agentId];
        save();
      }
    }

    const { models_ms: listing, list_ms: listingWorkspaces, open_ms: opening, create_ms: creating, archive_ms: archiving } = behaviour();

    const holds: Partial<Record<Inbound['type'], number>> = {
      list_provider_models_request: listing,
      fetch_workspaces_request: listingWorkspaces,
      open_project_request: opening,
      'agent.create.request': creating,
      archive_workspace_request: archiving,
      set_daemon_config_request: message.type === 'set_daemon_config_request'
        ? Math.max(behaviour().config_ms, ...Object.keys(message.config.providers ?? {}).map((id) => behaviour().provider_config_ms[id] ?? 0))
        : 0,
      fetch_agent_request: behaviour().fetch_ms,
    };

    const hold = holds[message.type] ?? 0;

    /** Whether the daemon fails `provider`'s `request`, as `provider_errors` says, answering it so: as Paseo answers a handler that threw. */
    const handlerFailed = (provider: string, request: 'diagnostic' | 'modes', requestId: string, requestType: string): boolean => {
      const failing = behaviour().provider_errors[provider];

      if (failing?.request !== request) return false;
      reply({ type: 'rpc_error', payload: { requestId, requestType, error: failing.error, code: 'handler_error' } });

      return true;
    };

    // Recorded as it arrives, so a test sees a create the daemon still holds.
    if (!held.has(message) && RECORDED.has(message.type)) record(message);

    if (hold > 0 && !held.has(message)) {
      held.add(message);
      const early = message.type === 'agent.create.request' ? behaviour().refuse_create_early : undefined;

      if (message.type === 'agent.create.request' && early !== undefined) reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: null, error: early } });
      timers.add(setTimeout(() => handle(message, early === undefined ? reply : () => {}), hold));

      return;
    }

    switch (message.type) {
      case 'list_available_providers_request': {
        const { models: offered, custom_providers: custom } = behaviour();
        const providers = [...Object.keys(MODES), ...Object.keys(custom)];
        reply({
          type: 'list_available_providers_response',
          payload: { requestId: message.requestId, providers: providers.map((provider) => ({ provider, available: Object.hasOwn(offered, baseOf(provider) ?? provider), error: null })), error: null, fetchedAt: now() },
        });

        return;
      }

      case 'list_provider_models_request': {
        const models = behaviour().models[baseOf(message.provider) ?? message.provider] ?? [];

        if (models.length === 0) {
          // As Paseo answers a provider whose catalog failed, such as OpenCode connected to no model provider.
          reply({ type: 'list_provider_models_response', payload: { requestId: message.requestId, provider: message.provider, error: `${message.provider} has no connected providers.`, fetchedAt: now() } });

          return;
        }

        reply({
          type: 'list_provider_models_response',
          payload: {
            requestId: message.requestId, provider: message.provider, error: null, fetchedAt: now(),
            models: models.map((id, index) => ({ provider: message.provider, id, label: id, isDefault: index === 0, thinkingOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] })),
          },
        });

        return;
      }

      case 'get_providers_snapshot_request': {
        // A full snapshot, as a daemon answers a client that names no hash it holds.
        const { models: offered, default_modes: defaults, custom_providers: custom } = behaviour();

        const customs = Object.keys(custom).flatMap((id) => {
          const base = baseOf(id);

          return base ? [[id, base, 'custom'] as const] : [];
        });

        const entries = [...Object.keys(MODES).filter(isProvider).map((provider) => [provider, provider, 'builtin'] as const), ...customs]
          .map(([provider, base, source]) => ({
            provider, status: Object.hasOwn(offered, base) ? 'ready' as const : 'unavailable' as const, enabled: true, source, label: provider,
            modes: MODES[base], defaultModeId: Object.hasOwn(defaults, provider) ? defaults[provider] : DEFAULT_MODES[base],
          }));

        reply({ type: 'get_providers_snapshot_response', payload: { requestId: message.requestId, entries, generatedAt: now() } });

        return;
      }

      case 'provider_diagnostic_request': {
        const does = behaviour();

        if (handlerFailed(message.provider, 'diagnostic', message.requestId, message.type)) return;
        const base = baseOf(message.provider) ?? message.provider;
        // A custom provider runs its own command, which Paseo resolves on the daemon's PATH; a Codex one answers `login status` as Codex.
        const command = does.custom_providers[message.provider]?.command?.[0];
        const named = command === undefined ? base : path.basename(command);
        const resolved = base === 'codex' ? does.codex_path ?? hostCodex(state, does.codex_login, { name: named, home: does.codex_login_home, needsHome: does.codex_needs_home }) : `/usr/local/bin/${named}`;
        reply({ type: 'provider_diagnostic_response', payload: { requestId: message.requestId, provider: message.provider, diagnostic: base === 'opencode' && does.opencode_server ? `OpenCode server: ${does.opencode_server}` : diagnosticOf(base, does.sign_in[message.provider], resolved, does.claude_home) } });

        return;
      }

      case 'list_provider_modes_request':
        if (handlerFailed(message.provider, 'modes', message.requestId, message.type)) return;
        reply({ type: 'list_provider_modes_response', payload: { requestId: message.requestId, provider: message.provider, modes: modesOf(baseOf(message.provider)), error: null, fetchedAt: now() } });

        return;
      case 'open_project_request': {
        if (!fs.existsSync(message.cwd)) {
          // As Paseo answers a directory that is gone.
          reply({ type: 'open_project_response', payload: { requestId: message.requestId, workspace: null, error: `Directory not found: ${message.cwd}`, errorCode: 'directory_not_found' } });

          return;
        }

        // As Paseo keys a directory's workspace: by its path, resolved but never through its links.
        const cwd = path.resolve(message.cwd);
        const made = kept.workspaces[cwd] === undefined;
        const id = kept.workspaces[cwd] ?? `wks_${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}`;
        kept.workspaces[cwd] = id;
        save();
        const answer = (): void => reply({ type: 'open_project_response', payload: { requestId: message.requestId, workspace: workspaceOf(id, cwd, behaviour().repositories), error: null } });
        const late = made ? behaviour().open_reply_ms : 0;

        if (late > 0) timers.add(setTimeout(answer, late));
        else answer();

        return;
      }

      case 'fetch_workspaces_request': {
        const { repositories } = behaviour();
        const entries = Object.entries(kept.workspaces).map(([cwd, id]) => workspaceOf(id, cwd, repositories));
        reply({ type: 'fetch_workspaces_response', payload: { requestId: message.requestId, entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } });

        return;
      }

      case 'agent.create.request': {
        const { requestId: _requestId, ...intent } = message;
        const fingerprint = JSON.stringify(intent);
        const key = message.idempotencyKey;

        if (key === undefined) throw new Error('The fake Paseo daemon takes only agent creates with an idempotency key');
        const receipt = kept.receipts[key];

        const creation = (agent: AgentRecord): CreationSnapshot => ({
          kind: 'agent', idempotencyKey: key, revision: 3, phase: 'completed', error: null, workspaceId: agent.workspaceId, agentId: agent.id, agent: snapshot(agent),
        });

        if (receipt) {
          const agent = kept.agents[receipt.agentId];

          if (receipt.fingerprint !== fingerprint || !agent) {
            reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: null, error: 'agent_request_key_conflict' } });

            return;
          }

          reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: snapshot(agent), creation: creation(agent), error: null } });

          return;
        }

        const modes = modesOf(baseOf(message.config.provider));
        const { modeId } = message.config;

        // Paseo refuses a mode its provider does not list, a preset the provider would take included (recorded, 0.14.0).
        if (modeId && !modes.some((mode) => mode.id === modeId)) {
          reply({ type: 'agent.create.response', payload: { requestId: message.requestId, agent: null, error: `Invalid mode '${modeId}' for provider '${message.config.provider}'. Available modes: ${modes.map((mode) => mode.id).join(', ')}` } });

          return;
        }

        const id = message.agentId ?? crypto.randomUUID();
        const [model, thinking] = [message.config.model ?? null, message.config.thinkingOptionId ?? null];

        const agent: AgentRecord = {
          id, provider: message.config.provider, model, thinking, modeId: message.config.modeId ?? null, cwd: fs.realpathSync(message.config.cwd),
          workspaceId: message.workspaceId ?? '', title: message.config.title ?? null, labels: message.labels, status: message.initialPrompt === undefined ? 'idle' : 'running', createdAt: now(), updatedAt: now(),
          sessionId: null, permission: false, behaviour: behaviour(), prompt: message.initialPrompt ?? '',
          allowed: (AllowedSchema.safeParse(message.config.providerOptions).data?.allowedTools ?? []).flatMap((rule) => /^Edit\(\/(.+)\/\*\*\)$/.exec(rule)?.[1] ?? []),
        };

        agent.permission = agent.behaviour.ask_permission;
        kept.agents[id] = agent;

        if (agent.behaviour.member_joins) {
          const member = crypto.randomUUID();
          kept.agents[member] = { ...agent, id: member, title: 'member', labels: {}, status: 'idle', sessionId: null, permission: false, prompt: 'Look around.' };
        }

        kept.receipts[key] = { agentId: id, fingerprint };
        save();
        reply({ type: 'agent.create.update', payload: creation(agent) });
        reply({
          type: 'agent.create.response',
          payload: agent.behaviour.lose_create_reply
            ? { requestId: message.requestId, agent: null, error: 'Connection reset before the create was answered' }
            : { requestId: message.requestId, agent: snapshot(agent), creation: creation(agent), error: null },
        });

        // With no prompt the agent waits, idle, for its first message; Paseo starts Codex's process at create, and
        // Claude's at the first listing of its commands.
        if (message.initialPrompt !== undefined) work(agent);
        else if (baseOf(agent.provider) === 'codex') {
          void startTool(agent).then((failed) => {
            if (failed === undefined) return;
            Object.assign(agent, { status: 'error', lastError: failed });
            changed(agent);
          });
        }

        return;
      }

      case 'list_commands_request': {
        const agent = kept.agents[message.agentId];

        if (!agent) {
          reply({ type: 'list_commands_response', payload: { requestId: message.requestId, agentId: message.agentId, commands: [], error: `Agent not found: ${message.agentId}` } });

          return;
        }

        void (baseOf(agent.provider) === 'claude' ? startTool(agent) : Promise.resolve(undefined)).then((failed) => {
          reply({ type: 'list_commands_response', payload: { requestId: message.requestId, agentId: agent.id, commands: [], error: failed ?? null } });
        });

        return;
      }

      case 'send_agent_message_request': {
        const agent = kept.agents[message.agentId];

        if (!agent) {
          reply({ type: 'send_agent_message_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: false, error: `Agent not found: ${message.agentId}` } });

          return;
        }

        // Each turn works as the daemon's behaviour says by then.
        const does = behaviour();
        Object.assign(agent, { prompt: message.text, status: 'running', behaviour: does, permission: does.ask_permission });
        save();
        changed(agent);
        reply({ type: 'send_agent_message_response', payload: { requestId: message.requestId, agentId: agent.id, accepted: true, error: null } });
        work(agent);

        return;
      }

      case 'fetch_recent_provider_sessions_request': {
        const taken = new Set(Object.values(kept.agents).map((agent) => agent.sessionId));


        const entries = behaviour().provider_sessions.filter((id) => !taken.has(id)).map((id) => ({
          providerId: message.providers?.[0] ?? 'claude', providerLabel: 'Claude', providerHandleId: id, cwd: message.cwd ?? '', title: null, firstPromptPreview: null, lastPromptPreview: null, lastActivityAt: now(),
        }));

        reply({ type: 'fetch_recent_provider_sessions_response', payload: { requestId: message.requestId, entries } });

        return;
      }

      case 'import_agent_request': {
        // As Paseo 0.14.0: an idle agent of an id the daemon chooses, on the provider's default model and mode, whose
        // session is the one imported; a session an agent already has is refused (recorded).
        const session = message.providerHandleId ?? message.sessionId ?? '';
        const provider = message.providerId ?? message.provider ?? '';

        if (Object.values(kept.agents).some((agent) => agent.sessionId === session)) {
          reply({ type: 'status', payload: { status: 'agent_create_failed', requestId: message.requestId, error: `Provider session is already imported: ${session}` } });

          return;
        }

        const id = crypto.randomUUID();


        const agent: AgentRecord = {
          id, provider, model: null, thinking: null, modeId: DEFAULT_MODES[baseOf(provider) ?? 'claude'] ?? null, cwd: fs.realpathSync(message.cwd ?? '.'), workspaceId: message.workspaceId ?? '',
          title: null, labels: message.labels ?? {}, status: 'idle', createdAt: now(), updatedAt: now(), sessionId: session, permission: false, allowed: [], behaviour: behaviour(), prompt: '',
        };

        kept.agents[id] = agent;
        save();
        reply({ type: 'status', payload: { status: 'agent_resumed', requestId: message.requestId, agentId: id, timelineSize: 0, agent: snapshot(agent) } });

        return;
      }

      case 'set_agent_model_request':
      case 'set_agent_mode_request':
      case 'set_agent_thinking_request': {
        const agent = kept.agents[message.agentId];

        if (agent && message.type === 'set_agent_model_request') agent.model = message.modelId;

        if (agent && message.type === 'set_agent_mode_request') agent.modeId = message.modeId;

        if (agent && message.type === 'set_agent_thinking_request') agent.thinking = message.thinkingOptionId;

        if (agent) changed(agent);

        const payload = { requestId: message.requestId, agentId: message.agentId, accepted: agent !== undefined, error: agent ? null : `Agent not found: ${message.agentId}` };

        const type = message.type === 'set_agent_model_request' ? 'set_agent_model_response' as const : message.type === 'set_agent_mode_request' ? 'set_agent_mode_response' as const : 'set_agent_thinking_response' as const;
        reply({ type, payload });

        return;
      }

      case 'agent_permission_response': {
        // As Paseo: a person's answer in the app, sent by a client; an allowed request lets the turn go on.
        if (message.response.behavior === 'allow' && kept.agents[message.agentId]) fs.writeFileSync(path.join(state, 'answers', message.agentId), 'allow');

        return;
      }

      case 'delete_agent_request': {
        delete kept.agents[message.agentId];
        save();
        reply({ type: 'agent_deleted', payload: { requestId: message.requestId, agentId: message.agentId } });

        return;
      }

      case 'set_daemon_config_request': {
        // As Paseo 0.14.0 saves `agents.providers` (recorded): it applies the change at once, persists it, and refuses a
        // custom provider with no label or an id other than lowercase letters, digits and dashes.
        const file = path.join(state, 'behaviour.json');
        const raw = z.record(z.string(), z.unknown()).parse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
        const custom = { ...behaviour().custom_providers };

        const removing = (message.config.removeProviders ?? []).length > 0 ? behaviour().refuse_remove : undefined;

        const refused = behaviour().refuse_config ?? removing ?? Object.entries(message.config.providers ?? {}).flatMap(([id, entry]) => {
          if (!/^[a-z][a-z0-9-]*$/.test(id)) return [`[Config] Invalid config to save:\n  - agents.providers.${id}: Provider ID "${id}" must match /^[a-z][a-z0-9-]*$/.`];

          return entry.label === undefined ? [`[Config] Invalid config to save:\n  - agents.providers.${id}.label: Custom provider "${id}" must declare label.`] : [];
        })[0];

        if (refused !== undefined) {
          reply({ type: 'rpc_error', payload: { requestId: message.requestId, requestType: message.type, error: `Request failed: ${refused}`, code: 'handler_error' } });

          return;
        }

        for (const [id, entry] of Object.entries(message.config.providers ?? {})) custom[id] = BehaviourSchema.shape.custom_providers.unwrap().valueType.parse({ ...custom[id], ...entry });

        for (const id of message.config.removeProviders ?? []) delete custom[id];
        fs.writeFileSync(file, JSON.stringify({ ...raw, custom_providers: custom }));
        reply({ type: 'set_daemon_config_response', payload: { requestId: message.requestId, config: { mcp: { injectIntoAgents: true }, providers: custom } } });

        return;
      }

      case 'get_daemon_config_request':
        if (behaviour().refuse_config_read !== undefined) {
          reply({ type: 'rpc_error', payload: { requestId: message.requestId, requestType: message.type, error: behaviour().refuse_config_read ?? '', code: 'handler_error' } });

          return;
        }

        // Its `providers` are the custom providers of `agents.providers`, as the daemon answers them.
        reply({ type: 'get_daemon_config_response', payload: { requestId: message.requestId, config: { mcp: { injectIntoAgents: true }, providers: behaviour().custom_providers } } });

        return;
      case 'fetch_agent_request': {
        // As Paseo: an unknown agent is a null agent, not an error.
        const agent = kept.agents[message.agentId];
        const refused = behaviour().refuse_fetch;
        reply({ type: 'fetch_agent_response', payload: { requestId: message.requestId, agent: agent && !refused ? snapshot(agent) : null, project: null, error: refused ?? null } });

        return;
      }

      case 'wait_for_finish_request': {
        fs.appendFileSync(path.join(state, 'waited.jsonl'), `${JSON.stringify({ agentId: message.agentId })}\n`);
        const agent = kept.agents[message.agentId];

        if (!agent) {
          reply({ type: 'wait_for_finish_response', payload: { requestId: message.requestId, status: 'error', final: null, error: `Agent not found: ${message.agentId}`, lastMessage: null } });

          return;
        }

        // As Paseo: a turn waiting on a person answers `permission`; an ended one, closed included, `idle` or `error`.
        const answer = (): boolean => {
          if (agent.status === 'running' && !agent.permission) return false;
          const status = agent.permission ? 'permission' : agent.status === 'error' ? 'error' : 'idle';
          reply({ type: 'wait_for_finish_response', payload: { requestId: message.requestId, status, final: snapshot(agent), error: agent.lastError ?? null, lastMessage: status === 'idle' ? agent.behaviour.reply : null } });

          return true;
        };

        const wait = (): void => {
          if (!answer()) waiters.set(agent.id, [...waiters.get(agent.id) ?? [], wait]);
        };

        wait();

        return;
      }

      case 'cancel_agent_request': {
        const agent = kept.agents[message.agentId];
        const { refuse_cancel: refused, refuse_cancel_ms: refusing } = behaviour();

        if (refused) {
          setTimeout(() => reply({ type: 'cancel_agent_response', payload: { requestId: message.requestId ?? '', agentId: message.agentId, agent: agent ? snapshot(agent) : null, error: refused } }), refusing);

          return;
        }

        if (agent) stop(agent, 'idle');
        const answer = (): void => reply({ type: 'cancel_agent_response', payload: { requestId: message.requestId ?? '', agentId: message.agentId, agent: agent ? snapshot(agent) : null, error: agent ? null : `Agent not found: ${message.agentId}` } });
        const { cancel_reply_ms: replying } = behaviour();

        if (replying > 0) timers.add(setTimeout(answer, replying));
        else answer();

        return;
      }

      case 'fetch_agents_request': {
        // Every agent no archive closed, in one page: the runtime asks which agents a workspace holds.
        const entries = Object.values(kept.agents).filter((agent) => agent.status !== 'closed').map((agent) => ({ agent: snapshot(agent), project: placementOf(agent.workspaceId, agent.cwd) }));
        reply({ type: 'fetch_agents_response', payload: { requestId: message.requestId, entries, pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } });

        return;
      }

      case 'archive_workspace_request': {
        const refused = behaviour().refuse_archive;

        // Paseo deletes only worktrees it created, so archiving teamai's leaves the directory in place.
        if (!refused) {
          for (const [cwd, id] of Object.entries(kept.workspaces)) if (id === message.workspaceId) delete kept.workspaces[cwd];
          save();

          for (const agent of Object.values(kept.agents)) if (agent.workspaceId === message.workspaceId) stop(agent, 'closed');
        }

        reply({ type: 'archive_workspace_response', payload: { requestId: message.requestId, workspaceId: message.workspaceId, archivedAt: refused ? null : now(), error: refused ?? null } });

        return;
      }

      default:
        throw new Error(`The fake Paseo daemon does not answer ${message.type}`);
    }
  }

  const url = socketPath === undefined ? `ws://127.0.0.1:${z.object({ port: z.number() }).parse(wss.address()).port}/ws` : `ws+unix://${socketPath}:/ws`;

  return {
    url,
    close: async () => {
      for (const timer of timers) clearInterval(timer);

      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}

/**
 * A provider's diagnostic, as Paseo 0.14.0 formats it (recorded): Claude's `Auth` row quotes `claude auth status`, which
 * fails when signed out; OpenCode's quotes `opencode auth list`; Codex's has no `Auth` row.
 */
function diagnosticOf(provider: string, signIn: 'signed_out' | 'unreported' | undefined, resolved: string, claudeHome: string | undefined): string {
  const rows = [`  Binary: ${provider}`, `  Resolved path: ${resolved}`];
  const isSignedOut = signIn === 'signed_out';

  if (signIn !== 'unreported' && provider === 'claude') {
    const home = claudeHome === undefined ? '' : `,\n  "projectsDirectory": ${JSON.stringify(path.join(claudeHome, 'projects'))},\n  "configDirectory": ${JSON.stringify(claudeHome)}`;
    rows.push(`  Auth: {\n  "loggedIn": ${String(!isSignedOut)},\n  "authMethod": "${isSignedOut ? 'none' : 'oauth_token'}",\n  "apiProvider": "firstParty"${home}\n}${isSignedOut ? '\nCommand failed: /usr/local/bin/claude auth status' : ''}`);
  } else if (signIn !== 'unreported' && provider === 'opencode') {
    rows.push(`  Auth: \n    ${isSignedOut ? 'No authenticated integrations' : '●  Anthropic oauth'}`);
  }

  return [provider, ...rows, '  Status: Ready'].join('\n');
}

/**
 * The path of the daemon host's `codex`, or of the command a custom Codex provider runs (`name`), which answers `codex login status` as `login` says, as Codex 0.166.0 does on
 * stderr (recorded); with no `login`, the path holds nothing.
 */
function hostCodex(state: string, login: 'signed_in' | 'signed_out' | 'unknown' | undefined, { name = 'codex', home, needsHome = false }: { name?: string; home?: string | undefined; needsHome?: boolean } = {}): string {
  const file = path.join(state, 'host-bin', name);
  fs.rmSync(file, { force: true });

  if (login) {
    const answers = { signed_in: ['Logged in using ChatGPT', 0], signed_out: ['Not logged in', 1], unknown: ['error: unrecognized subcommand: status', 2] } as const;
    const [answer, code] = answers[login];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const elsewhere = home === undefined ? '' : `[ "$CODEX_HOME" = '${home}' ] || { echo 'Not logged in' >&2; exit 1; }\n`;
    const missing = 'CODEX_HOME points to \\"$CODEX_HOME\\", but that path does not exist';
    const noHome = needsHome ? `[ -z "$CODEX_HOME" ] || [ -d "$CODEX_HOME" ] || { echo "WARNING: proceeding, even though we could not create PATH aliases: ${missing}" >&2; echo "Error loading configuration: ${missing}" >&2; exit 1; }\n` : '';
    fs.writeFileSync(file, `#!/bin/sh\n[ "$*" = "login status" ] || exit 2\n${noHome}${elsewhere}echo '${answer}' >&2\nexit ${code}\n`, { mode: 0o755 });
  }

  return file;
}

/** Where Paseo places a workspace's directory: its project and checkout. */
function placementOf(id: string, cwd: string): NonNullable<WorkspaceDescriptorPayload['project']> {
  return { projectKey: `prj_${id.slice(4)}`, projectName: path.basename(cwd), workspaceName: 'main', checkout: { cwd, currentBranch: 'main', remoteUrl: null, worktreeRoot: cwd, isGit: true, isPaseoOwnedWorktree: false, mainRepoRoot: null } };
}

/** The workspace `id` on `cwd`, reporting the origin URL `repositories` gives its checkout, as Paseo reports it in its git runtime. */
function workspaceOf(id: string, cwd: string, repositories: Record<string, string>): WorkspaceDescriptorPayload {
  const name = path.basename(cwd);
  const remoteUrl = Object.entries(repositories).find(([dir]) => path.resolve(dir) === cwd)?.[1];

  return {
    id, projectId: `prj_${id.slice(4)}`, projectDisplayName: name, projectCustomName: null, projectCustomIconRevision: null, projectRootPath: cwd, workspaceDirectory: cwd,
    setupStatus: null, projectKind: 'git', workspaceKind: 'local_checkout', name: 'main', title: null, pinnedAt: null, background: false, archivingAt: null,
    status: 'done', statusEnteredAt: null, activityAt: null, createdAt: now(), diffStat: null, scripts: [],
    project: placementOf(id, cwd),
    ...(remoteUrl !== undefined && { gitRuntime: { currentBranch: 'main', remoteUrl, isPaseoOwnedWorktree: false, isDirty: false, aheadBehind: null, aheadOfOrigin: 0, behindOfOrigin: 0 } }),
  };
}

// Run as a process: `fake-daemon --state <dir> [--port <n>]` prints `{"url":…}` once it listens, and ends when its stdin closes.
if (process.argv[1] && /fake-daemon\.(?:ts|mjs|js)$/.test(process.argv[1])) {
  const arg = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);

    return at === -1 ? undefined : process.argv[at + 1];
  };

  const state = arg('--state');

  if (!state) throw new Error('fake-daemon needs --state <dir>');
  const daemon = await startFakeDaemon({ state, port: Number(arg('--port') ?? 0) });
  process.stdout.write(`${JSON.stringify({ url: daemon.url })}\n`);
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}

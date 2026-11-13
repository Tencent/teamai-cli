// A fake T3 Code server for the runtime's tests: the MCP endpoint at /mcp with the tools teamai-runtime-t3 calls, and
// the OAuth endpoints a sign-in walks. It keeps its threads in files under FAKE_T3_STATE, so a restarted runtime finds
// them again, and an agent of its own plays each thread's run: it reads the result path from the prompt, writes the
// result there and a Claude or Codex transcript in HOME, as the real tool would.
//
//   FAKE_T3_STATE/config.json   written by the test: { token, namespace, environment, projects, providers, agent }
//                               namespace: the caller's sign-in session, which T3 hashes into a launch's thread id with its clientRequestId
//                               agent: { output, fail, error, hold, release, waits, noSession, reply, result }; read again on every call;
//                               error: with fail, the { title, text } of the error item T3 records for the failed run
//                               result: the result file's JSON exactly, in place of { output, failure }
//                               organizeFails: T3 refuses t3_thread_organize; stopLagMs: a stop ends the run this long after T3 acknowledged it
//                               delegatesPending: the run's delegated work has not settled; resultRunStatus: the run that answered then
//                               launchFails: T3 refuses every launch, a repeated one too; launchUnavailable: T3 answers every launch
//                               with its generic orchestration_error refusal, before it looks anything up; launchMs: a launch answers this long after
//                               it launched; launchReplyLost: a launch launches, then its reply never comes (an MCP error, not a refusal)
//                               launchInvalid: a new launch's check refuses every launch, a repeated one too, with invalid_request
//                               projectsMs: the project list answers this long after it was asked; environmentMs: the same for the environment;
//                               providersMs: the same for the provider list
//                               wrappedHome: the tool home of a thread whose instance runs teamai's sandbox wrapper, as its grant sets it
//                               decisionRefused: T3 refuses every sign-in decision; decisionNoCode: a decision redirects with no code
//                               decisionMs: a sign-in decision answers this long after it was posted
//                               addedInstanceConstraints: the constraints T3 reports for a provider instance the settings add
//                               providersFailOnceAdded: the provider list fails once, the first time the settings hold this instance
//                               unlistedOnce: provider instance ids the first provider list leaves out, as T3 before it reloads its settings
//                               links: the environments linked to this one, { environmentId, label, status }; unset: linked
//                               environments are off; environments: each linked one's { projects, providers }, by its id
//                               sendMs: a send answers this long after it started the turn; turnStartsLateMs: a send's turn starts this
//                               long after T3 answered it; sendHangs: a send never answers, and starts no turn
//                               scratchFolder: the folder a launch with `scratch: true` binds in place of a new, empty one
//   FAKE_T3_STATE/calls.jsonl   each tool call as { tool, args, bearer }; bearer is "valid" or "invalid", never the token
//   FAKE_T3_STATE/pairings.jsonl   the pairing codes the harness's fake `t3` command minted: { credential, scopes, base }
//   FAKE_T3_STATE/threads/      one JSON file per thread
//   T3CODE_HOME/userdata/server-runtime.json   written once listening: { origin }, as T3 writes it
//   T3CODE_HOME/scratch/        a scratch thread's new folder, as T3 makes one for a launch with `scratch: true`
//   FAKE_T3_HOME                the member's home, as T3 Code's server has it, where the agent's tool keeps its transcripts:
//                               in the tool's home there, or in the home the provider instance's settings name
//   T3CODE_HOME/userdata/settings.json   the member's T3 settings, read on every launch and settle as T3 reads them:
//                               the default model and the project scripts, the project's override first; a Claude or Codex
//                               provider instance it adds is listed as T3 lists one once it reloaded them

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { entriesUnder } from '@teamai/shared/entries-under';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';

const STATE = process.env.FAKE_T3_STATE;
const T3_HOME = process.env.T3CODE_HOME;
const HOME = process.env.FAKE_T3_HOME;
const THREADS = path.join(STATE, 'threads');
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

fs.mkdirSync(THREADS, { recursive: true });

const config = () => JSON.parse(fs.readFileSync(path.join(STATE, 'config.json'), 'utf8'));
const threadFile = (id) => path.join(THREADS, `${encodeURIComponent(id)}.json`);
const readThread = (id) => (fs.existsSync(threadFile(id)) ? JSON.parse(fs.readFileSync(threadFile(id), 'utf8')) : undefined);

// T3 stamps a thread's updatedAt on every change, and lists threads by it, newest first.
const writeThread = (thread) => {
  fs.writeFileSync(`${threadFile(thread.threadId)}.tmp`, JSON.stringify({ ...thread, updatedAt: new Date().toISOString() }));
  fs.renameSync(`${threadFile(thread.threadId)}.tmp`, threadFile(thread.threadId));
};

const update = (id, change) => {
  const thread = readThread(id);

  if (thread) writeThread({ ...thread, ...change(thread) });
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The member's T3 settings, as the test wrote them. */
const settings = () => {
  const file = path.join(T3_HOME, 'userdata', 'settings.json');

  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};

/**
 * The provider instances T3 runs: the test's, and each Claude or Codex instance the member's settings add, as T3 lists
 * one once it reloaded them and checked it; it runs the models the test's first instance of that driver runs.
 * `addedInstanceConstraints`: the constraints T3 reports for each instance the settings add.
 */
function providers() {
  const { providers: listed, addedInstanceConstraints = [] } = config();

  const added = Object.entries(settings().providerInstances ?? {}).flatMap(([id, instance]) => {
    const like = listed.find((one) => one.driverKind === instance.driver);

    if (listed.some((one) => one.providerInstanceId === id) || !like) return [];

    return [{ ...like, providerInstanceId: id, displayName: instance.displayName ?? id, constraints: instance.enabled === false ? ['Provider instance is disabled.'] : addedInstanceConstraints }];
  });

  return [...listed, ...added];
}

/** The scripts of a project, as T3 resolves them: the project's override, then the global ones once folded, then its own. */
function scriptsOf(projectId) {
  const all = settings();
  const override = all.projectSettingsOverrides?.[projectId]?.defaultProjectScripts;

  if (override !== undefined) return override;

  if (all.projectSettingsFolded) return all.defaultProjectScripts ?? [];
  const own = config().projects.find((project) => project.id === projectId)?.scripts ?? [];

  return own.length > 0 ? own : all.defaultProjectScripts ?? [];
}

/** Runs the project script `which` picks in `cwd`, as T3 runs it in a terminal there. */
function runScript(projectId, which, cwd) {
  const script = scriptsOf(projectId).find(which);

  if (script && cwd) execFileSync('/bin/sh', ['-c', script.command], { cwd });
}

/**
 * Starts the Binary path of the thread's provider instance once, in the thread's folder, when it is teamai's sandbox
 * wrapper, as T3 starts a run's tool: why it failed, or undefined once it exited 0.
 */
function startWrapper(thread) {
  const binaryPath = settings().providerInstances?.[thread.instanceId]?.config?.binaryPath;

  if (!binaryPath || !path.basename(binaryPath).startsWith('teamai-sandbox-')) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const child = spawn(binaryPath, [], { cwd: thread.worktreePath ?? process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', (error) => resolve(error.message));
    child.on('close', (code) => resolve(code === 0 ? undefined : stderr.trim() || `${binaryPath} exited ${code}`));
  });
}

/** The agent of one run: its tool starts, it works, then writes the result file and its transcript, and the run completes. */
async function play(threadId) {
  const thread = readThread(threadId);
  const agent = config().agent ?? {};
  update(threadId, () => ({ status: 'running' }));
  const startFailure = await startWrapper(thread);

  if (startFailure !== undefined) {
    update(threadId, () => ({ status: 'failed', error: { title: 'Provider failed to start', text: startFailure, runId: `run:${threadId}:1` } }));

    return;
  }

  while (agent.hold || agent.release) {
    const now = readThread(threadId);

    if (now.status !== 'running') return;

    if (agent.release && fs.existsSync(agent.release)) break;
    await sleep(25);
  }

  await sleep(20);

  if (readThread(threadId).status !== 'running') return;

  if (thread.worktreePath) update(threadId, () => ({ sees: filesUnder(thread.worktreePath), couldWrite: canWrite(thread.worktreePath) }));

  if (agent.delegatedWaits) {
    // The task's own thread holds the approval; the step's run goes on, waiting for the task.
    writeThread({ threadId: `${threadId}:task`, title: 'Delegated task', parentThreadId: threadId, projectId: thread.projectId, provider: thread.provider, status: 'running', settled: false, runCount: 1, pendingRequestCount: 1 });

    return;
  }

  if (agent.delegates) {
    // Each delegated task's thread names the thread that delegated it, and ends before the run that waits for it.
    writeThread({ threadId: `${threadId}:task`, title: 'Delegated task', parentThreadId: threadId, projectId: thread.projectId, provider: thread.provider, status: 'completed', settled: false, runCount: 1 });
    writeThread({ threadId: `${threadId}:task:task`, title: 'Delegated subtask', parentThreadId: `${threadId}:task`, projectId: thread.projectId, provider: thread.provider, status: 'completed', settled: false, runCount: 1 });
  }

  if (agent.waits) {
    // The agent asks for an approval nobody gives. T3 keeps such a run `running`, with the request pending.
    update(threadId, () => ({ pendingRequestCount: 1 }));

    return;
  }

  if (agent.fail) {
    update(threadId, () => ({ status: 'failed', ...(agent.error && { error: { ...agent.error, runId: `run:${threadId}:1` } }) }));

    return;
  }

  const result = /Write the workflow result as JSON to (\S+?)\.(?:\s|$)/.exec(thread.message)?.[1];

  if (result && agent.result !== undefined) fs.writeFileSync(result, JSON.stringify(agent.result));
  else if (result && (agent.output !== undefined || agent.failure)) fs.writeFileSync(result, JSON.stringify({ output: agent.output, failure: agent.failure }));

  if (!agent.noSession) writeTranscript(thread);
  update(threadId, () => ({ status: 'completed', ...(agent.reply !== undefined && { reply: agent.reply }) }));
}

/** The files under `dir`, relative to it and sorted: what the agent finds in its thread's folder. */
function filesUnder(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]))
    .sort();
}

/** Whether the agent can change anything in `dir`: write a file of its own, or overwrite one it found there. */
function canWrite(dir) {
  const found = filesUnder(dir)[0];

  try {
    fs.writeFileSync(path.join(dir, '.agent-probe'), '');
    fs.rmSync(path.join(dir, '.agent-probe'));

    return true;
  } catch {
    try {
      if (found) fs.appendFileSync(path.join(dir, found), '');

      return found !== undefined;
    } catch {
      return false;
    }
  }
}

const expandHome = (value) => path.resolve(value === '~' ? HOME : value.startsWith('~/') ? path.join(HOME, value.slice(2)) : value);

/**
 * The tool home the thread's provider instance keeps its sessions in, as T3 resolves it: the instance's `homePath`,
 * `~` being the server's home, else the tool's default home there. A Codex instance with a shadow home (its
 * `shadowHomePath`, or, for a managed one not named codex, one in T3's state) signs in there, and T3 links the shadow's
 * `sessions` to this home, as its `KNOWN_SHARED_DIRECTORIES` do.
 */
function toolHomeOf(thread) {
  const instance = settings().providerInstances?.[thread.instanceId]?.config ?? {};

  // teamai's wrapper starts the tool in the sandbox with the tool home the sandbox grants it, not the instance's.
  if (config().wrappedHome && path.basename(instance.binaryPath ?? '').startsWith('teamai-sandbox-')) return config().wrappedHome;
  const own = instance.homePath?.trim() ?? '';
  const shared = own === '' ? path.join(HOME, thread.provider === 'codex' ? '.codex' : '.claude') : expandHome(own);

  const shadow = thread.provider !== 'codex' ? '' : instance.shadowHomePath?.trim()
    || (instance.setupMode === 'managed' && thread.instanceId !== 'codex' ? path.join(T3_HOME, 'userdata', 'providers', 'codex', thread.instanceId, 'shadow') : '');

  if (shadow !== '' && !fs.existsSync(path.join(expandHome(shadow), 'sessions'))) {
    fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
    fs.mkdirSync(expandHome(shadow), { recursive: true });
    fs.symlinkSync(path.join(shared, 'sessions'), path.join(expandHome(shadow), 'sessions'));
  }

  return shared;
}

/**
 * The transcript the thread's tool keeps, in its own layout in its tool home. A later run of the thread, a turn, goes on
 * in the same file, as the tool continues its session. With `agent.usage`, each run bills those tokens in the tool's own
 * usage lines: Claude's per assistant message, Codex's per response with the thread's running total.
 */
function writeTranscript(thread) {
  const sessionId = createHash('sha256').update(thread.threadId).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
  const cwd = fs.realpathSync(thread.worktreePath);
  const at = new Date().toISOString();
  const usage = config().agent?.usage;
  const run = thread.runCount ?? 1;

  if (thread.provider === 'codex') {
    const sessions = path.join(toolHomeOf(thread), 'sessions');
    const day = at.slice(0, 10).split('-');
    const kept = filesNamed(sessions, `-${sessionId}.jsonl`)[0];
    const file = kept ?? path.join(sessions, ...day, `rollout-${at.replace(/[:.]/g, '-')}-${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Codex counts cached input inside input_tokens.
    const counted = (times) => usage && ({ input_tokens: (usage.input + usage.cacheRead) * times, cached_input_tokens: usage.cacheRead * times, cache_write_input_tokens: 0, output_tokens: usage.output * times, reasoning_output_tokens: 0, total_tokens: (usage.input + usage.cacheRead + usage.output) * times });
    fs.appendFileSync(file, [
      ...(kept ? [] : [JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: sessionId, timestamp: at, cwd, originator: 'codex_exec', cli_version: '0.50.0' } })]),
      JSON.stringify({ timestamp: at, type: 'turn_context', payload: { turn_id: `turn-${run}`, cwd, model: thread.model } }),
      JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: thread.message }] } }),
      ...(usage ? [JSON.stringify({ timestamp: at, type: 'token_usage_record', payload: { thread_id: sessionId, session_id: sessionId, response_id: `resp_${run}`, usage: counted(1), thread_token_usage: counted(run) } })] : []),
    ].join('\n') + '\n');

    return;
  }

  const dir = path.join(toolHomeOf(thread), 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const message = { role: 'assistant', model: thread.model, content: [{ type: 'text', text: 'Done.' }] };
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', sessionId, cwd, timestamp: at, uuid: randomUUID(), message: { role: 'user', content: thread.message } }),
    JSON.stringify({
      type: 'assistant', sessionId, cwd, timestamp: at, uuid: randomUUID(), requestId: `req_${run}`,
      message: usage ? { id: `msg_${run}`, ...message, usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: 0 } } : message,
    }),
  ].join('\n') + '\n');
}

/** The files under `dir` whose name ends with `suffix`, at any depth. */
function filesNamed(dir, suffix) {
  if (!fs.existsSync(dir)) return [];

  try {
    return entriesUnder(dir).filter(({ entry }) => entry.isFile() && entry.name.endsWith(suffix)).map(({ relative }) => path.join(dir, relative));
  } catch {
    // A folder of the store it cannot list, as another user's: the tool finds its session by its id, and writes on.
    return [];
  }
}

// Broadest first, as T3 ranks them.
const MODES = ['full-access', 'auto', 'auto-accept-edits', 'approval-required'];
const fail = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });

// As T3 answers a call on a thread it does not have, such as one the person deleted.
const notFound = (threadId) => fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'thread_not_found', message: `Thread ${threadId} is no longer available.` }));

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

// As T3 answers a launch: its web UI's link to the thread, not the t3-thread:// form its thread lists carry.
const link = (threadId) => `http://127.0.0.1:${httpServer.address().port}/${config().environment.environmentId}/${encodeURIComponent(threadId)}`;

let sequence = 2_900_000;

/**
 * A launch as T3 answers it: the thread a repeated clientRequestId launched before under the same sign-in, or a new one.
 * T3 derives the thread id from the caller's sign-in session and the clientRequestId together.
 */
function launch(args) {
  const key = JSON.stringify([`client:${config().namespace ?? 'session-1'}`, args.clientRequestId ?? randomUUID()]);
  const threadId = `mcp:launch:${createHash('sha256').update(key).digest('hex')}`;
  const access = config().access ?? approved;

  // As T3 does, the mode the sign-in allows is checked before a repeated launch is looked up.
  if (access && MODES.indexOf(args.runtimeMode) < MODES.indexOf(access)) {
    return fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'runtime_mode_escalation_denied', message: `Child runtime mode ${args.runtimeMode} is broader than parent mode ${access}.` }));
  }

  const existing = readThread(threadId);

  if (existing) return ok({ threadId, link: link(threadId), status: existing.status, modelSelection: { instanceId: existing.instanceId, model: existing.model } });
  // A launch from outside a thread that names no model starts on the member's default, the project's first.
  const all = settings();
  const projectDefault = all.projectSettingsOverrides?.[args.projectId]?.defaultModelSelection;
  const modelSelection = args.modelSelection ?? (projectDefault !== undefined ? projectDefault : all.defaultModelSelection);

  if (!modelSelection) return fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'invalid_request', message: 'Pass modelSelection: the project has no default model.' }));
  const provider = providers().find((one) => one.providerInstanceId === modelSelection.instanceId);

  if (!provider) return fail(`No provider instance ${modelSelection.instanceId}.`);

  // A scratch thread gets a new, empty folder of its own.
  const scratch = args.scratch === true ? config().scratchFolder ?? path.join(T3_HOME, 'scratch', threadId.slice(-8)) : undefined;

  if (scratch) fs.mkdirSync(scratch, { recursive: true });
  const idle = args.message === undefined;
  // A thread binds the project's own folder (`root`, the default), or one of its worktrees, where T3 runs the project's setup script.
  const strategy = args.workspaceStrategy ?? { type: 'root' };
  const folder = scratch ?? (strategy.type === 'existing_worktree' ? strategy.worktreePath : config().projects.find((project) => project.id === args.projectId)?.workspaceRoot);

  if (strategy.type === 'existing_worktree') runScript(args.projectId, (script) => script.runOnWorktreeCreate, folder);

  writeThread({
    threadId, clientRequestId: args.clientRequestId, title: args.title, message: args.message, worktreePath: folder, projectId: scratch ? 'scratch-project' : args.projectId, workspace: scratch ? 'scratch' : strategy.type,
    provider: provider.driverKind, instanceId: provider.providerInstanceId, model: modelSelection.model, runtimeMode: args.runtimeMode, status: idle ? 'idle' : 'starting', settled: false, runCount: idle ? 0 : 1,
  });

  if (!idle) void play(threadId);

  return ok({ threadId, link: link(threadId), status: idle ? null : 'starting', modelSelection: { instanceId: provider.providerInstanceId, model: modelSelection.model } });
}

/** As T3 answers a call it forwards to a linked environment it cannot reach. */
const unreachable = (environmentId) => fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'environment_unreachable', message: `Environment ${environmentId} did not answer.` }));

/**
 * A launch forwarded to a linked environment: the thread is that machine's, which this fake keeps with its environment
 * and leaves starting, since nothing here plays its run. A repeated clientRequestId answers the thread it launched.
 */
function launchThere(args) {
  const linked = config().environments?.[args.environmentId];

  if (!linked) return unreachable(args.environmentId);
  const threadId = `mcp:launch:${createHash('sha256').update(JSON.stringify([args.environmentId, args.clientRequestId])).digest('hex')}`;

  if (!readThread(threadId)) {
    writeThread({
      threadId, title: args.title, message: args.message, environmentId: args.environmentId, projectId: args.projectId, delegatedFrom: args.delegatedFrom, workspace: args.workspaceStrategy?.type,
      provider: args.modelSelection.instanceId, instanceId: args.modelSelection.instanceId, model: args.modelSelection.model, runtimeMode: args.runtimeMode, status: 'starting', settled: false, runCount: 1,
    });
  }

  return ok({ threadId, link: `<t3-thread://v2/${args.environmentId}/${threadId}>`, status: 'starting', modelSelection: args.modelSelection });
}

const TOOLS = {
  t3_environment_read: async () => {
    await sleep(config().environmentMs ?? 0);

    return ok(config().environment);
  },
  orchestrator_capabilities: async (args) => {
    await sleep(config().providersMs ?? 0);
    const failOnce = config().providersFailOnceAdded;
    const failed = path.join(STATE, 'providers-failed');

    if (failOnce && settings().providerInstances?.[failOnce] && !fs.existsSync(failed)) {
      fs.writeFileSync(failed, '');

      return fail('T3 Code is restarting its providers.');
    }

    const unlisted = path.join(STATE, 'unlisted-once');
    const hidden = fs.existsSync(unlisted) ? [] : config().unlistedOnce ?? [];
    fs.writeFileSync(unlisted, '');

    if (args.environmentId !== undefined) {
      const linked = config().environments?.[args.environmentId];

      return linked ? ok({ providers: linked.providers }) : unreachable(args.environmentId);
    }

    return ok({ providers: providers().filter((provider) => !hidden.includes(provider.providerInstanceId)) });
  },
  t3_project_list: async (args) => {
    await sleep(config().projectsMs ?? 0);

    if (args.environmentId !== undefined) {
      const linked = config().environments?.[args.environmentId];

      return linked ? ok({ projects: linked.projects, nextCursor: null }) : unreachable(args.environmentId);
    }

    return ok({ projects: config().projects, nextCursor: null });
  },
  // As T3 lists the machines linked to it; it refuses while linked environments are off in its Labs settings.
  t3_environment_links: () => {
    const { links, noLinkedEnvironments } = config();

    // A T3 Code before linked environments has no such tool.
    if (noLinkedEnvironments) return fail('Unknown tool t3_environment_links.');

    if (!links) return fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'capability_denied', message: 'Linked environments is off on this machine, so no tool can act on another machine.' }));

    return ok({ environmentId: config().environment.environmentId, links });
  },
  t3_thread_launch: async (args) => {
    if (config().launchFails) return fail('T3 Code cannot launch threads now.');

    // As T3 answers when a check a new launch runs fails, such as a worktree the project does not have.
    if (config().launchInvalid) return fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'invalid_request', message: `Worktree ${args.workspaceStrategy?.worktreePath} is not a worktree of project ${args.projectId}.` }));

    // As T3 answers when it could not complete the call, such as the repeated launch's own lookup failing.
    if (config().launchUnavailable) return fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'orchestration_error', message: 'The operation could not be completed.' }));
    const launched = args.environmentId === undefined ? launch(args) : launchThere(args);
    await sleep(config().launchMs ?? 0);

    if (config().launchReplyLost) throw new Error('The connection closed before T3 answered.');

    return launched;
  },
  // As T3 answers a wait until delegated work settled: the run's own status, timed out until that work settled too,
  // and then the run that answered. A thread with no run yet answers idle at once.
  t3_thread_wait: async (args) => {
    const deadline = Date.now() + Math.min(args.timeoutMs ?? 30_000, config().waitCapMs ?? Infinity);
    let thread = readThread(args.threadId);

    if (!thread) return notFound(args.threadId);

    if (thread.status === 'idle') return ok({ threadId: args.threadId, runId: null, status: 'idle', timedOut: false });
    const settledNow = () => TERMINAL.has(thread.status) && !config().delegatesPending;

    while (!settledNow() && Date.now() < deadline) {
      await sleep(20);
      thread = readThread(args.threadId);
    }

    const runId = `run:${args.threadId}:1`;
    const settled = settledNow();

    return ok({ threadId: args.threadId, runId, status: thread.status, timedOut: !settled, ...(settled && { resultRun: { runId, status: config().resultRunStatus ?? thread.status } }) });
  },
  // As T3 lists them: newest first, a delegated task's thread with its parent only when subagents are asked for.
  t3_thread_list: (args) => {
    const threads = fs.readdirSync(THREADS).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(path.join(THREADS, file), 'utf8')))
      .filter((thread) => (args.includeSubagents || thread.parentThreadId === undefined) && (args.projectId === undefined || thread.projectId === args.projectId) && (args.statuses === undefined || args.statuses.includes(thread.status))
        && (args.settled === undefined || thread.settled === args.settled))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.threadId.localeCompare(left.threadId));

    const cursor = args.cursor ?? 0;
    const page = threads.slice(cursor, cursor + (args.limit ?? 50));
    const nextCursor = cursor + page.length < threads.length ? cursor + page.length : null;

    return ok({ threads: page.map((thread) => ({ threadId: thread.threadId, projectId: thread.projectId, status: thread.status, parentThreadId: thread.parentThreadId ?? null, updatedAt: thread.updatedAt })), nextCursor, total: threads.length });
  },
  t3_thread_read: (args) => {
    const thread = readThread(args.threadId);

    if (!thread) return notFound(args.threadId);

    // The messages view holds the agent's replies; the activity view also holds the error a failed run recorded.
    const items = [
      ...(thread.reply !== undefined ? [{ position: 1, itemId: 'item-reply', type: 'assistant_message', runId: `run:${thread.threadId}:1`, title: null, text: thread.reply, textTruncated: false, nextTextOffset: null }] : []),
      ...(args.view === 'activity' && thread.error ? [{ position: 2, itemId: 'item-error', type: 'error', status: 'failed', runId: thread.error.runId, title: thread.error.title, text: thread.error.text, textTruncated: false, nextTextOffset: null }] : []),
    ].filter((item) => args.itemId === undefined || item.itemId === args.itemId);

    return ok({
      // As T3 reads a thread: the instance and model its runs use and its mode, but not the model's options.
      thread: {
        threadId: thread.threadId, title: thread.title, status: thread.status, worktreePath: thread.worktreePath ?? null, runCount: thread.runCount ?? 1, pendingRequestCount: thread.pendingRequestCount ?? 0, settled: thread.settled,
        providerInstanceId: thread.instanceId ?? null, model: thread.model ?? null, runtimeMode: thread.runtimeMode ?? null,
      },
      items, nextPosition: items.at(-1)?.position ?? null, hasMore: false,
    });
  },
  // As T3 answers a send: a repeated clientRequestId starts nothing more; a thread whose run ended, settled or not,
  // starts a new turn of the same conversation, and leaves the Settled group.
  t3_thread_send: async (args) => {
    const thread = readThread(args.threadId);

    if (!thread) return notFound(args.threadId);

    if ((thread.sends ?? []).includes(args.clientRequestId)) return ok({ threadId: args.threadId, status: thread.status });

    if (thread.status !== 'idle' && !TERMINAL.has(thread.status)) return ok({ threadId: args.threadId, status: 'queued' });

    if (config().sendHangs) return new Promise(() => {});

    const startTurn = () => {
      update(args.threadId, (now) => ({ message: args.message, status: 'starting', settled: false, runCount: (now.runCount ?? 0) + 1, sends: [...(now.sends ?? []), args.clientRequestId] }));
      void play(args.threadId);
    };

    // As T3 may: the send is answered before the turn's run shows, so the thread still reads as its earlier run ended.
    if (config().turnStartsLateMs) setTimeout(startTurn, config().turnStartsLateMs);
    else startTurn();
    await sleep(config().sendMs ?? 0);

    return ok({ threadId: args.threadId, status: 'starting' });
  },
  // As T3 sets a thread's model: its next runs use it, on the provider instance the thread runs on.
  t3_thread_configure: (args) => {
    const thread = readThread(args.threadId);

    if (!thread) return notFound(args.threadId);

    if (args.modelSelection.instanceId !== thread.instanceId) return fail(JSON.stringify({ _tag: 'OrchestratorMcpFailure', code: 'invalid_request', message: `Thread ${args.threadId} runs on ${thread.instanceId}.` }));
    update(args.threadId, () => ({ model: args.modelSelection.model }));

    return ok({ threadId: args.threadId });
  },
  t3_thread_interrupt: async (args) => {
    await sleep(config().interruptMs ?? 0);
    const thread = readThread(args.threadId);

    if (!thread) return notFound(args.threadId);

    // An idle thread has no run to stop either.
    if (TERMINAL.has(thread.status) || thread.status === 'idle') return ok({ threadId: args.threadId, runId: null, status: 'no_active_run' });

    if (config().interruptFails) return fail(`Thread ${args.threadId} has a run T3 cannot interrupt now.`);
    const lag = config().stopLagMs;

    // As T3 does, it may acknowledge the stop before the provider's run has ended. A stop also stops the tasks it delegated.
    const stop = () => {
      update(args.threadId, () => ({ status: 'interrupted' }));
      update(`${args.threadId}:task`, () => ({ status: 'interrupted', pendingRequestCount: 0 }));
    };

    if (lag) setTimeout(stop, lag);
    else stop();

    return ok({ threadId: args.threadId, runId: `run:${args.threadId}:1`, status: 'interrupt_requested' });
  },
  // As T3 answers it: the sequence number of the event it recorded.
  t3_thread_organize: (args) => {
    if (!readThread(args.threadId)) return notFound(args.threadId);

    if (config().organizeFails) return fail(`Thread ${args.threadId} cannot be organized now.`);

    if (args.action === 'settle') runScript(readThread(args.threadId).projectId, (script) => script.runOnSettle, readThread(args.threadId).worktreePath);
    update(args.threadId, () => ({ settled: args.action === 'settle' }));
    sequence += 1;

    return ok({ sequence });
  },
};

const record = (tool, args, bearer) => fs.appendFileSync(path.join(STATE, 'calls.jsonl'), `${JSON.stringify({ tool, args, bearer })}\n`);

function mcpServer(bearer) {
  const server = new Server({ name: 'fake-t3', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: Object.keys(TOOLS).map((name) => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    record(request.params.name, args, bearer);
    const tool = TOOLS[request.params.name];

    return tool ? tool(args) : fail(`Unknown tool ${request.params.name}.`);
  });

  return server;
}

const codes = new Map();

/** The scopes T3 grants a sign-in approved with `access` (`mcpClientScopes` in T3's server). */
const scopesOf = (access) => (access === 'full-access' ? ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write'] : ['orchestration:read', 'orchestration:operate']);

/** The pairing codes the fake `t3` command minted, each with its scopes and the data directory it was minted for. */
const pairings = () => {
  const file = path.join(STATE, 'pairings.jsonl');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line)) : [];
};

const spent = new Set();

/** The access the last pairing-code decision approved: it caps the modes the threads of its sign-in run in. */
let approved;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  let text = '';

  for await (const chunk of req) text += chunk;

  return text;
};

async function route(req, res) {
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const url = new URL(req.url, origin);

  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['orchestration:read', 'orchestration:operate'], bearer_methods_supported: ['header'] });
  }

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return json(res, 200, {
      issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    });
  }

  if (url.pathname === '/oauth/mcp/register') {
    const metadata = JSON.parse(await readBody(req));

    return json(res, 201, { ...metadata, client_id: `client-${randomUUID()}` });
  }

  if (url.pathname === '/oauth/mcp/authorize') {
    // The person approves at once, with the access they pick in the page.
    const code = randomUUID();
    const access = config().pageAccess ?? 'auto';
    approved = access;
    codes.set(code, { challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri'), access });
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);

    if (url.searchParams.get('state')) back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() });

    return res.end();
  }

  if (url.pathname === '/oauth/mcp/decision') {
    // T3's sign-in page posts here; a pairing-code decision needs a code the `t3` command minted for this server's
    // data directory, carrying the scopes the access level needs, and each code approves once.
    const { authorization, decision } = JSON.parse(await readBody(req));
    await sleep(config().decisionMs ?? 0);
    const pairing = pairings().find((minted) => minted.credential === decision.code && minted.base === T3_HOME && !spent.has(minted.credential));
    const needed = scopesOf(decision.access);

    if (config().decisionRefused || decision._tag !== 'pairing-code' || !pairing || !needed.every((scope) => pairing.scopes.includes(scope))) {
      return json(res, 400, { _tag: 'AuthMcpApprovalError', message: 'That pairing code is not valid. Create a new one and try again.' });
    }

    spent.add(pairing.credential);
    approved = decision.access;
    record('oauth_decision', { access: decision.access }, 'none');
    const back = new URL(authorization.redirect_uri);

    if (config().decisionNoCode) back.searchParams.set('error', 'access_denied');
    else {
      const code = randomUUID();
      codes.set(code, { challenge: authorization.code_challenge, redirect: authorization.redirect_uri, access: decision.access });
      back.searchParams.set('code', code);
    }

    if (authorization.state) back.searchParams.set('state', authorization.state);

    return json(res, 200, { redirectTo: back.toString() });
  }

  if (url.pathname === '/oauth/mcp/token') {
    const form = new URLSearchParams(await readBody(req));
    const pending = codes.get(form.get('code'));
    const verified = pending && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === pending.challenge;

    if (!verified) return json(res, 400, { error: 'invalid_grant' });
    codes.delete(form.get('code'));
    fs.appendFileSync(path.join(STATE, 'calls.jsonl'), `${JSON.stringify({ tool: 'oauth_token', args: {}, bearer: 'none' })}\n`);

    // T3 names the scopes of the access approved, as it issued them.
    return json(res, 200, { access_token: config().token, token_type: 'Bearer', expires_in: 3600, scope: scopesOf(pending.access).join(' ') });
  }

  if (url.pathname === '/mcp') {
    const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

    if (presented !== config().token) {
      return json(res, 401, { error: 'invalid_mcp_credential', message: 'A valid T3 Code MCP credential is required.' }, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${presented ? ', error="invalid_token"' : ''}`,
      });
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer('valid');
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);

    return transport.handleRequest(req, res, req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined);
  }

  json(res, 404, { error: 'not_found' });
}

const httpServer = http.createServer((req, res) => {
  route(req, res).catch((error) => json(res, 500, { error: String(error) }));
});

httpServer.listen(0, '127.0.0.1', () => {
  const dir = path.join(T3_HOME, 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server-runtime.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, pid: process.pid, origin: `http://127.0.0.1:${httpServer.address().port}` }));
  fs.renameSync(`${file}.tmp`, file);
});

process.on('SIGTERM', () => { httpServer.close(); process.exit(0); });

// A test that removes its state is done with this server, and so is one whose process is gone before its teardown ran,
// as when its worker is killed: the server is then reparented, and would outlive the test with its state. The test's
// process names itself (FAKE_T3_PARENT), since it may be gone before this server reads its own parent.
const parent = Number(process.env.FAKE_T3_PARENT ?? process.ppid);

setInterval(() => { if (!fs.existsSync(STATE) || process.ppid !== parent) process.exit(0); }, 500);

#!/usr/bin/env node
// The toy step runtime: protocol 1 over JSON lines on stdio. It runs each exec on the host, in a process group of its
// own, and keeps handles and outcomes in the `state` option's directory, so a toy started again answers a repeated
// operation and a reattach from them. `die_at` kills the process that spawned it, once per state directory, right after
// it recorded that point and before it replies: `open-accepted`, `exec-exited` or `prompt-finished`. It reads each
// request with the protocol's own schema, so a request teamai writes that the protocol does not have is answered with
// an error.
//
// With `agent`, it is a runtime that launches agents its own way, as T3 or Paseo: it offers `prompt` and no `exec`, and
// its agent works `hold_ms` (from when the prompt was first sent, across a restart of the toy) and until the file
// `release` names exists (`{step}` in it is the lease's step), then writes `output` (or the whole `result`) to the lease's result file and finishes with a
// session and `usage`, or ends with `fail`. It appends each prompt it is sent, and how each ended, to `prompts.jsonl` in its state, which
// `close` keeps. It answers `conversations` in its init, as T3 and Paseo do, unless `conversations: false`, as a runtime
// that launches a tool per prompt and keeps nothing to continue. It continues the session a prompt's lease names and
// says so in `finished`, unless `resumes: false`; with
// a lease's `continue`, it keeps each conversation a prompt launched in `conversations/<id>.json` in its state, by the
// conversation's id (its session's), until the place that launched it closes. A prompt that names one it still holds,
// whose launching turn finished, on the same tool and working directory, is a new turn of it (the same session,
// `resumed: true`); any other is a new conversation with a new session, one notice saying why, and no `resumed`. The
// close of a later place stops only its own turns; the conversation it continued stays with the place that launched
// it. A person who deletes the conversation is the test removing that file. With
// `transcript`, its agent keeps each session in the member's Claude store, as an agent T3 or Paseo starts on this
// machine does; with `home` too, in that Claude home instead, which `finished` reports as the session's `home`, as a
// T3 provider instance with its own home does. With `prompt_tool_home` beside `agent`, its init says it runs each tool
// in the attempt's tool home (`toolHome: true`), and its agent keeps a transcript in the Claude home its place's view
// gives under a variable init names for Claude (`homeEnv.claude`), and none when the view gives none. Each open records the tool its attempt's prompt
// runs (`open.tool`) and the attempt's deadline (`open.deadline`).
// `agent.display` is what its agent shows once it exists, given with the prompt's acceptance; with `display_after_ms`, it
// accepts the prompt at once with no display and sends that one as a `display` event that long after, as a runtime that
// accepts before its slow launch and shows the agent once it exists.
//
// With `judge`, it also answers confined prompts, best effort: its init says so and offers `can.confined` at `level`
// (`best-effort` unless given) with `access` (`read`) for `tools` (`claude`). It answers each one at once with `reply`
// as the result's output, keeping the level it was asked for (or `reports`, to say less), and logs the files it could
// read: those under the prompt's directory, which is all it reads; with `fail`, it ends each with that failure instead. `path` names a directory of its own tools, first on
// the PATH of each exec.
//
// `answer` makes it answer a request otherwise, by request type: `failed`, the failure reply for that handle or
// operation; `error`, an error line that names no request; `silent`, nothing; `display`, only a `display` event for the
// operation, with `agent.display` or else `display`. `answer.init: silent` leaves an init for
// new work unanswered, as a sign-in check whose provider stalls, while recover mode still answers. A request it cannot
// answer, such as one for a handle while its journal cannot be read, gets the failure reply for its handle or operation.
//
// Each init's mode, the directory it was started in, and the checkout, tool instances and home variables it was given, are appended to
// `inits.jsonl` in its state. `init_fails` is the failure an init for new work ends with, as a runtime signed out of
// its provider; in `recover` mode it still opens, offers nothing and answers from its state, unless `recover: false`
// makes it answer that mode as a runtime before it did. A `check` init it answers as one for new work, writing nothing
// but its `inits.jsonl` line, unless `check: false` makes it refuse that mode as a runtime before it. With `cancel_fails`, a cancel of an exec or prompt still
// running stops nothing and ends it failed with that failure, which reattach keeps reporting until a later cancel stops
// it. With `stop_ms`, a stop completes that long after the cancel, and the operation is reported running until then.
// With `stray`, an exec it accepts also starts a process that shares the toy's stdout and stderr and outlives it, which
// writes its pid to `stray.pid` in the state; the toy then writes a line that is not JSON. With `binds`, a place keeps
// the worktree folder it was first opened on until it is closed, as a container binds a folder: an exec in a place
// whose worktree was made again since exits 128, as Docker's does.
//
// `calls` names a file, which two toys may share, that each request after init is appended to, in the order the toy
// reads them: the toy's state directory's name, the request's type, operation and handle, an open's `outer` and the
// tool home its view gives, the names an open or a reattach says the step goes without (`unset`), and the names of the
// credentials it brought, never a value.
//
// With `wake_log`, an absolute path, it wakes fleet members: its init says `wake: true`, and it appends each `wake` it is
// sent to that file as one JSON line, the request as teamai wrote it, then answers `woken` with `where: "toy"`, so a
// test starts the member from that file.
//
// `notice` sends a notice before it answers a request, by request type (`{"init":"…","exec":"…"}`), naming the
// request's operation or handle. `{NAME}` in it is replaced by the value of credential NAME the request brought, or of
// NAME in its env, so a test reads what teamai shows of a secret a runtime echoes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
import { signalGroup, signalPid } from '@teamai/shared/process-group';
import { encodeCwdClaude } from '@teamai/tool-core/sessions/fs';

const OPTIONS = new Set(['state', 'die_at', 'exit_at', 'close_fails', 'open_fails', 'open_refuses', 'can', 'display', 'agent', 'judge', 'path', 'answer', 'init_fails', 'cancel_fails', 'recover', 'check', 'stop_ms', 'stray', 'notice', 'unavailable', 'permissions', 'own_logins', 'calls', 'wake_log', 'prompt_tool_home', 'binds']);

const DEFAULT_CAN = {
  hitl: false, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: true,
  tokens: true, max_turns: true, setup: true, tools: ['claude', 'codex', 'codebuddy'], end_turn: true, unattended: true, role: true,
};

let options;
/** The variables teamai names in init for each tool's home. */
let homeEnv = {};
const running = new Map();

// When teamai is gone, a line it would have read goes nowhere: an exec still running keeps going and records its end.
let stdoutOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

function send(message) {
  if (stdoutOpen) process.stdout.write(`${JSON.stringify(message)}\n`);
}

function file(...parts) {
  return path.join(options.state, ...parts);
}

function readJson(at, fallback) {
  try {
    return JSON.parse(fs.readFileSync(at, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(at, value) {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const tmp = `${at}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, at);
}

const opPath = (op) => file('ops', `${op}.json`);

/** The ends the toy answered and could not record, by op, until their place closes: they stand in for the records. */
const unkept = new Map();

/** What the toy keeps of `op`: the end it could not record, else its record. */
const readOp = (op) => unkept.get(op) ?? readJson(opPath(op), undefined);

/**
 * Records `record`, how `op` ended. One its journal cannot write is kept in memory and named in a notice: the op still
 * ends as it did, since teamai keeps that end as soon as it reads it.
 */
function keepEnd(op, record) {
  try {
    writeJson(opPath(op), record);
    unkept.delete(op);
  } catch (error) {
    unkept.set(op, record);
    send({ event: 'notice', op, message: `The toy could not record how ${op} ended (${error instanceof Error ? error.message : String(error)}), so only this toy remembers that end, until the place closes.` });
  }
}

/** The toy's journal of handles. One it cannot read fails the request, never reads as no handle. */
function readHandles() {
  try {
    return JSON.parse(fs.readFileSync(file('handles.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`The toy cannot read its journal ${file('handles.json')}: ${error.message}. Fix or remove that file, then run the same command again.`, { cause: error });
  }
}

function dieAt(point) {
  if (options.die_at !== point) return false;
  const marker = file(`died-${point}`);

  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(marker, '');
  signalPid(process.ppid, 'SIGKILL');

  return true;
}

function pidAlive(pid) {
  return signalPid(pid, 0) === 'sent';
}

/** The toy that started an exec outlives teamai and records the exec's outcome, so while it lives the exec may still end. */
function ownerAlive(record) {
  return record.owner !== undefined && record.owner !== process.pid && pidAlive(record.owner);
}

function groupAlive(pgid) {
  return signalGroup(pgid, 0) === 'sent';
}

function stopGroup(pgid) {
  if (signalGroup(pgid, 'SIGTERM') !== 'sent') return;
  setTimeout(() => { signalGroup(pgid, 'SIGKILL'); }, 2000).unref();
}

// It appends the names, never the values, of the credentials and logins its init names, and of the credentials each
// open, exec and prompt brings, to `credentials.jsonl` in its state, and sets an exec's over its process environment.
// `exit_at: 'exec-accepted'` makes the toy itself exit right after it accepted an exec, which keeps running. With
// `close_fails`, it answers every `close` with `close_failed`; set to a credential's name, its failure echoes the value
// the place's open brought, so a test reads what teamai keeps of it. Each `close` appends the handle and whether the
// folder its place was opened in still exists to `closes.jsonl`, so a test reads what a runtime sees go at a close; a
// close with `release` forgets the place even when `close_fails` refuses it.
// `display` is sent as given, valid or not, so a test reads what teamai keeps of it.
function shown() {
  return options.display === undefined ? {} : { display: options.display };
}

function init(request) {
  const unknown = Object.keys(request.options ?? {}).find((key) => !OPTIONS.has(key));

  if (unknown !== undefined) {
    send({ type: 'init', ok: false, error: { code: 'bad_option', key: unknown, message: `The toy runtime takes no option "${unknown}". It takes: ${[...OPTIONS].join(', ')}.` } });

    return;
  }

  if (typeof request.options?.state !== 'string') {
    send({ type: 'init', ok: false, error: { code: 'bad_option', key: 'state', message: 'The toy runtime needs option "state", the directory it keeps its handles in.' } });

    return;
  }

  fs.mkdirSync(request.options.state, { recursive: true });
  fs.appendFileSync(path.join(request.options.state, 'inits.jsonl'), `${JSON.stringify({ mode: request.mode, cwd: process.cwd(), ...(request.checkout && { checkout: request.checkout }), ...(request.instances && { instances: request.instances }), ...(request.homeEnv && { homeEnv: request.homeEnv }) })}\n`);

  // A sign-in check whose provider never answers: an init for new work stalls, and recover mode, which checks nothing, does not.
  if (request.mode !== 'recover' && request.options.answer?.init === 'silent') return;

  if (request.mode === 'check' && request.options.check === false) {
    send({ event: 'error', message: 'The toy runtime does not know mode check.' });

    return;
  }

  if (request.mode === 'recover') {
    if (request.options.recover === false) {
      send({ event: 'error', message: 'The toy runtime does not know mode recover.' });

      return;
    }

    options = request.options;
    homeEnv = request.homeEnv ?? {};
    send({ type: 'init', ok: true, can: {} });

    return;
  }

  if (request.options.init_fails !== undefined) {
    send({ type: 'init', ok: false, error: request.options.init_fails });

    return;
  }

  options = request.options;
  homeEnv = request.homeEnv ?? {};

  if (request.credentials !== undefined) {
    fs.appendFileSync(file('credentials.jsonl'), `${JSON.stringify({ type: 'init', names: request.credentials.env, logins: request.credentials.logins })}\n`);
  }

  const judge = options.judge === undefined ? {} : {
    confinedPrompt: true,
    confined: [{ level: options.judge.level ?? 'best-effort', access: options.judge.access ?? 'read', tools: options.judge.tools ?? ['claude'] }],
  };
  const judging = judge.confinedPrompt ? { confinedPrompt: true } : {};

  // `unavailable` names the tools the toy cannot run now, with why: it offers the rest, and still starts.
  const tools = DEFAULT_CAN.tools.filter((tool) => !(tool in (options.unavailable ?? {})));
  const unavailable = options.unavailable === undefined ? {} : { unavailable: options.unavailable };
  // `permissions` is what it reports of the tools it runs without permission prompts, as given.
  const permissions = options.permissions === undefined ? {} : { permissions: options.permissions };
  // `own_logins` names the tools whose login its provider keeps, so teamai copies none for them and sends none of
  // their sign-in variables it found by name.
  const ownLogins = options.own_logins === undefined ? {} : { ownLogins: options.own_logins };
  const wakes = typeof options.wake_log === 'string' ? { wake: true } : {};

  if (options.agent === undefined) {
    send({ type: 'init', ok: true, ...judging, ...unavailable, ...permissions, ...ownLogins, ...wakes, can: { ...DEFAULT_CAN, tools, ...(judge.confined && { confined: judge.confined }), ...options.can } });

    return;
  }

  // An agent the toy launches works in the place on the host: it takes no command, so it runs no setup either.
  const conversations = options.agent.conversations === false ? {} : { conversations: true };
  const toolHome = options.prompt_tool_home === true ? { toolHome: true } : {};
  // Its agent reports the tokens `agent.usage` names on every prompt it finishes, and none without it.
  const tokens = options.agent.usage !== undefined;
  send({ type: 'init', ok: true, prompt: true, ...conversations, ...toolHome, ...judging, ...unavailable, ...permissions, ...ownLogins, ...wakes, can: { ...DEFAULT_CAN, tools, exec: false, setup: false, tokens, end_turn: false, ...(judge.confined && { confined: judge.confined }), ...options.can } });
}

/** Notes which credentials a request brought, by name only: a value is never written. */
function noteCredentials(request, handle) {
  fs.appendFileSync(file('credentials.jsonl'), `${JSON.stringify({ type: request.type, op: request.op, handle, names: Object.keys(request.credentials ?? {}).sort() })}\n`);
}

/** The credentials each place's open brought, by handle, in memory only. */
const openCredentials = new Map();

function open(request) {
  // `open_refuses` is the failure every open answers before it makes a place, as a runtime that cannot make one.
  if (options.open_refuses !== undefined) return send({ op: request.op, event: 'failed', failure: options.open_refuses });
  const handles = readHandles();
  const key = `${request.run}/${request.attempt}`;
  const handle = handles[key] ?? `toy-${request.run}-${request.attempt}`;
  handles[key] = handle;
  writeJson(file('handles.json'), handles);
  // A confined prompt's place is opened with no view of the host.
  writeJson(opPath(request.op), { kind: 'open', handle, view: request.view ?? null, tool: request.tool ?? null, deadline: request.deadline ?? null });
  if (options.prompt_tool_home === true) writeJson(file('views', `${handle}.json`), request.view ?? null);
  if (options.binds === true && request.view && !fs.existsSync(file('bound', `${handle}.json`))) writeJson(file('bound', `${handle}.json`), { worktree: request.view.worktree, ino: fs.statSync(request.view.worktree).ino });
  noteCredentials(request, handle);
  openCredentials.set(handle, request.credentials ?? {});

  if (dieAt('open-accepted')) return;
  send({ op: request.op, event: 'accepted', handle });

  // `open_fails` is the failure every open ends with, as a runtime that refuses an option only once it opens a place.
  if (options.open_fails !== undefined) return send({ op: request.op, event: 'failed', failure: options.open_fails });
  send({ op: request.op, event: 'ready', ...shown() });
}

// Protocol 1 bounds the stdout an `exited` carries: past 64 KiB, its end after a marker.
const bounded = (stdout) => (stdout.length <= 64 * 1024 ? stdout : `[teamai: only the last 64 KiB of stdout follow]\n${stdout.slice(stdout.length - 64 * 1024)}`);

function settle(op, outcome) {
  if (outcome.state === 'exited') send({ op, event: 'exited', code: outcome.code, stdout: bounded(outcome.stdout) });
  else if (outcome.state === 'failed') send({ op, event: 'failed', failure: outcome.failure });
  else send({ op, event: 'cancelled' });
}

function replay(op, record) {
  send({ op, event: 'accepted' });
  settle(op, record.outcome);
}

function exec(request) {
  if (options.agent !== undefined) {
    send({ op: request.op, event: 'failed', failure: { code: 'exec_unsupported', message: 'The toy launches agents its own way and runs no command (can.exec: false).' } });

    return;
  }

  const record = readOp(request.op);

  if (record?.outcome) {
    replay(request.op, record);

    return;
  }

  if (running.has(request.op)) {
    send({ op: request.op, event: 'accepted' });

    return;
  }

  // An exec a toy before this one started is never run again. The toy that started it outlives its stdin and records
  // the outcome, which is replayed here; it is lost only when both that toy and the exec's group are gone without one.
  // A cancel of it says it ended.
  if (record?.pgid !== undefined) {
    send({ op: request.op, event: 'accepted' });
    const wait = setInterval(() => {
      const now = readJson(opPath(request.op), record);

      if (now.outcome) {
        clearInterval(wait);
        settle(request.op, now.outcome);

        return;
      }

      if (groupAlive(record.pgid) || ownerAlive(record)) return;
      clearInterval(wait);

      if (fs.existsSync(file('cancel', request.op))) return;
      send({ op: request.op, event: 'failed', failure: { code: 'runtime_lost', message: `The toy lost exec ${request.op}.` } });
    }, 25);

    return;
  }

  const bound = options.binds === true ? readJson(file('bound', `${request.handle}.json`), undefined) : undefined;

  if (bound !== undefined && fs.statSync(bound.worktree, { throwIfNoEntry: false })?.ino !== bound.ino) {
    send({ op: request.op, event: 'accepted' });
    send({ op: request.op, event: 'exited', code: 128, stdout: 'OCI runtime exec failed: exec failed: unable to start container process: current working directory is outside of container mount namespace root -- possible container breakout detected' });

    return;
  }

  noteCredentials(request, request.handle);
  // `path` is a directory of the toy's own tools, first on the PATH of what it runs, as an image that ships its tools.
  const env = { ...process.env, ...(options.path && { PATH: `${options.path}${path.delimiter}${process.env.PATH ?? ''}` }), ...request.env, ...request.credentials };

  for (const name of request.unset ?? []) delete env[name];
  const [command, ...args] = request.argv;
  const child = spawn(command, args, { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(request.op, child);
  writeJson(opPath(request.op), { kind: 'exec', handle: request.handle, pgid: child.pid, owner: process.pid });
  send({ op: request.op, event: 'accepted' });

  // A tool that outlives the toy and holds its output open, then a line teamai cannot read.
  if (options.stray) {
    const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync(file('stray.pid'), String(stray.pid));
    stray.unref();
    process.stdout.write('not json\n');
  }

  // The toy itself stops while the exec runs on, as a runtime that crashes leaves its processes behind.
  if (options.exit_at === 'exec-accepted') {
    process.stdout.write('', () => process.exit(70));

    return;
  }
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; send({ op: request.op, event: 'output', stream: 'stdout', data }); });
  child.stderr.setEncoding('utf8').on('data', (data) => { send({ op: request.op, event: 'output', stream: 'stderr', data }); });
  child.on('error', (error) => { stdout += ''; send({ op: request.op, event: 'output', stream: 'stderr', data: error.message }); });
  child.on('close', (code) => {
    running.delete(request.op);
    const cancelled = fs.existsSync(file('cancel', request.op));
    const outcome = cancelled ? { state: 'cancelled' } : { state: 'exited', code: code ?? 1, stdout };
    keepEnd(request.op, { kind: 'exec', handle: request.handle, outcome });

    if (!cancelled && dieAt('exec-exited')) return;
    send(cancelled ? { op: request.op, event: 'cancelled' } : { op: request.op, event: 'exited', code: outcome.code, stdout: bounded(stdout) });
    exitWhenIdle();
  });
}

/** The prompts this toy waits on, by operation: the timer that finishes each. */
const working = new Map();

/** The credentials each prompt brought, by operation, in memory only. */
const promptCredentials = new Map();

/** What the agent of a prompt record ended with, once it worked `hold_ms` since the prompt was first sent. */
function agentOutcome(record) {
  if (record.outcome) return record.outcome;

  if (fs.existsSync(file('cancel', record.op))) return { state: 'cancelled' };

  if (Date.now() < record.startedAt + (options.agent.hold_ms ?? 0)) return undefined;

  // `{step}` in `release` is the lease's step, so a test releases one step's agent apart from another's.
  if (options.agent.release !== undefined && !fs.existsSync(options.agent.release.replaceAll('{step}', record.lease.step))) return undefined;

  if (options.agent.fail) return { state: 'failed', failure: options.agent.fail };
  // `echo` names a credential whose value the agent writes into its output, as an agent that prints its token would.
  const echoed = options.agent.echo === undefined ? undefined : { echoed: promptCredentials.get(record.op)?.[options.agent.echo] ?? null };
  const result = options.agent.result ?? { output: echoed ?? options.agent.output ?? {} };
  fs.mkdirSync(path.dirname(record.lease.result), { recursive: true });
  fs.writeFileSync(record.lease.result, JSON.stringify(result));
  // `agent.unmeasured` says why a runtime that offers tokens read none for the prompt.
  const usage = options.agent.usage === undefined ? options.agent.unmeasured === undefined ? {} : { unmeasured: options.agent.unmeasured } : { usage: options.agent.usage };
  // `agent.stopped` names the limit of the lease at which it says it stopped its tool.
  const stopped = options.agent.stopped === undefined ? {} : { stopped: options.agent.stopped };

  // A lease that names a conversation is a turn of it, as the prompt's first send found it, or else a new one.
  const continues = record.lease.continue !== undefined;
  const resumes = continues ? record.continued !== undefined : record.lease.resume !== undefined && options.agent.resumes !== false;
  const id = continues ? record.continued ?? conversationId(record.op) : resumes ? record.lease.resume : conversationId(record.op);
  const session = { tool: record.lease.tool, id, ...(options.agent.home !== undefined && { home: options.agent.home }) };

  // On the attempt's tool home, the agent keeps its transcript in the Claude home its place's view gives.
  const view = options.prompt_tool_home === true ? readJson(file('views', `${record.handle}.json`), null) : null;
  const placeHome = (homeEnv.claude ?? []).map((variable) => view?.toolHome?.[variable]).find((dir) => dir !== undefined);

  if (options.agent.transcript && (options.prompt_tool_home !== true || placeHome !== undefined)) {
    const project = path.join(placeHome ?? options.agent.home ?? path.join(os.homedir(), '.claude'), 'projects', encodeCwdClaude(record.cwd));
    fs.mkdirSync(project, { recursive: true });
    const line = { type: 'user', sessionId: session.id, cwd: record.cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'step' } };
    fs.appendFileSync(path.join(project, `${session.id}.jsonl`), `${JSON.stringify(line)}\n`);
  }

  // A fresh session where the lease named one to continue says so, as `resumed: false`; one that names a conversation
  // it did not continue says nothing of `resumed`, its notice said why.
  if (continues) return { state: 'finished', session, result, ...usage, ...stopped, ...(resumes && { resumed: true }) };

  return { state: 'finished', session, result, ...usage, ...stopped, ...(record.lease.resume !== undefined && { resumed: resumes }) };
}

/** The id of the conversation prompt `op` launches: the session its agent reports. */
const conversationId = (op) => `toy-session-${op.slice(3)}`;
const conversationPath = (id) => file('conversations', `${id}.json`);

/**
 * The conversation the lease of `request` names, read by its id from the conversations this toy holds:
 * `{ session }`, its session; else `{ notice }`, why this prompt starts a new conversation.
 */
function conversationFor(request) {
  const { handle, op } = request.lease.continue;
  const id = conversationId(op);
  const held = readJson(conversationPath(id), undefined);

  if (held === undefined || held.place !== handle || !known(handle)) return { notice: `The toy holds no conversation ${id} in place ${handle} any more, so this prompt starts a new one.` };

  if (!held.isReady) return { notice: `Conversation ${id} has no finished turn to continue, so this prompt starts a new one.` };

  if (held.tool !== request.lease.tool) return { notice: `Conversation ${id} runs ${held.tool}, not ${request.lease.tool}, so this prompt starts a new one.` };

  if (held.cwd !== request.cwd) return { notice: `Conversation ${id} works in ${held.cwd}, not ${request.cwd}, so this prompt starts a new one.` };

  return { session: id };
}

function promptEnded(op, outcome) {
  const { state, ...rest } = outcome;

  return { op, event: state, ...rest };
}

/**
 * Whether this toy records how prompt `op` ended, `outcome`. A toy whose teamai was killed still waits on the agent
 * beside the one the restarted teamai sent the prompt to again, and both see it end: the first to claim the end records
 * it, and its claim carries that end, so the other reads it there when the journal cannot record it. A claim it cannot
 * write at all is its own, as a lone toy's is.
 */
function claimsEnd(op, outcome) {
  try {
    fs.mkdirSync(file('ended'), { recursive: true });
    fs.writeFileSync(file('ended', op), JSON.stringify(outcome), { flag: 'wx' });

    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

/** Records how the prompt's agent ended and says so, or waits for it. */
function settlePrompt(op) {
  const record = readOp(op);

  // Its place closed while it ran: the close stopped it.
  if (record === undefined) {
    working.delete(op);

    return;
  }

  const outcome = agentOutcome(record);

  if (outcome === undefined) {
    working.set(op, setTimeout(() => settlePrompt(op), Math.max(record.startedAt + (options.agent.hold_ms ?? 0) - Date.now(), 25)));

    return;
  }

  if (!record.outcome && !claimsEnd(op, outcome)) {
    // Another toy records this end: say it as that toy records it, or as its claim says it, once it has.
    const recorded = readOp(op)?.outcome ?? readJson(file('ended', op), undefined);

    if (recorded === undefined) {
      working.set(op, setTimeout(() => settlePrompt(op), 25));

      return;
    }

    working.delete(op);
    send(promptEnded(op, recorded));
    exitWhenIdle();

    return;
  }

  working.delete(op);

  if (!record.outcome) fs.appendFileSync(file('prompts.jsonl'), `${JSON.stringify({ op, ended: outcome.state })}\n`);
  keepEnd(op, { ...record, outcome });
  const launched = readJson(conversationPath(conversationId(op)), undefined);

  if (outcome.state === 'finished' && launched !== undefined && !launched.isReady) writeJson(conversationPath(conversationId(op)), { ...launched, isReady: true });

  if (outcome.state === 'finished' && dieAt('prompt-finished')) return;
  send(promptEnded(op, outcome));
  exitWhenIdle();
}

/** The files under `dir`, relative to it and sorted: what a confined prompt's agent can read. */
function filesUnder(dir, prefix = '') {
  return fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]))
    .sort();
}

/** Answers a confined prompt at once with the judge's reply, keeping the level it was asked for, or the one `reports` gives. */
function judgePrompt(request) {
  if (options.judge === undefined) {
    send({ op: request.op, event: 'failed', failure: { code: 'prompt_unsupported', message: 'The toy answers confined prompts only with the judge option.' } });

    return;
  }

  let record = readJson(opPath(request.op), undefined);
  send({ op: request.op, event: 'accepted' });
  noteCredentials(request, request.handle);

  if (!record) {
    fs.appendFileSync(file('prompts.jsonl'), `${JSON.stringify({ op: request.op, sent: request.lease, confined: request.confined, sees: filesUnder(request.confined.dir) })}\n`);
    const outcome = options.judge.fail !== undefined ? { state: 'failed', failure: options.judge.fail } : {
      state: 'finished', session: { tool: request.lease.tool, id: `toy-judge-${request.op.slice(3)}` }, result: { output: options.judge.reply ?? {} },
      confined: { level: options.judge.reports ?? request.confined.level, access: request.confined.access },
    };
    record = { kind: 'prompt', op: request.op, handle: request.handle, lease: request.lease, startedAt: Date.now(), outcome };
    writeJson(opPath(request.op), record);
  }

  send(promptEnded(request.op, record.outcome));
}

function prompt(request) {
  if (request.confined) {
    judgePrompt(request);

    return;
  }

  const record = readOp(request.op);

  if (options.agent === undefined) {
    send({ op: request.op, event: 'failed', failure: { code: 'prompt_unsupported', message: 'The toy runs a prompt\'s tool as an exec; start it with the agent option to take prompts.' } });

    return;
  }

  const { display, display_after_ms: displayAfter } = options.agent;
  send({ op: request.op, event: 'accepted', ...(display === undefined || displayAfter !== undefined ? {} : { display }) });

  if (display !== undefined && displayAfter !== undefined) setTimeout(() => send({ op: request.op, event: 'display', display }), displayAfter);
  noteCredentials(request, request.handle);
  promptCredentials.set(request.op, request.credentials);

  if (working.has(request.op)) return;

  // The first prompt of this id starts the agent; a repeated one reconnects to it, or reads how it ended.
  // The names of its env, never a value, and which of them the team provides.
  fs.appendFileSync(file('prompts.jsonl'), `${JSON.stringify({ op: request.op, sent: request.lease, env: Object.keys(request.env).sort(), provided: request.provided })}\n`);

  if (!record) {
    const conversation = request.lease.continue === undefined ? undefined : conversationFor(request);

    if (conversation?.notice !== undefined) send({ event: 'notice', op: request.op, message: conversation.notice });

    if (conversation?.session === undefined) writeJson(conversationPath(conversationId(request.op)), { place: request.handle, tool: request.lease.tool, cwd: request.cwd, isReady: false });
    writeJson(opPath(request.op), { kind: 'prompt', op: request.op, handle: request.handle, lease: request.lease, cwd: request.cwd, startedAt: Date.now(), ...(conversation?.session !== undefined && { continued: conversation.session }) });
  }

  settlePrompt(request.op);
}

function cancel(request) {
  const found = readOp(request.op);

  if (!found) return;

  // A cancel of an operation that already ended answers that end again; a cancel that could not stop the operation is
  // the one outcome a later cancel replaces.
  if (found.outcome && !found.cancelFailed) {
    if (found.kind === 'prompt') send(promptEnded(request.op, found.outcome));
    else settle(request.op, found.outcome);

    return;
  }
  const { outcome: _failed, cancelFailed: _retried, ...record } = found;

  if (options.cancel_fails !== undefined) {
    writeJson(opPath(request.op), { ...record, outcome: { state: 'failed', failure: options.cancel_fails }, cancelFailed: true });
    send({ op: request.op, event: 'failed', failure: options.cancel_fails });

    return;
  }

  // From the moment it reads the cancel, the operation is reported running until this stop is confirmed: the stop that
  // failed before is not this cancel's outcome.
  if (found.cancelFailed) writeJson(opPath(request.op), record);

  const stop = () => {
    stopping.delete(request.op);
    stopOperation(request.op, record);
    exitWhenIdle();
  };

  // `stop_ms`: the stop completes that long after the cancel, as a runtime that asks its provider to stop does.
  if (options.stop_ms === undefined) {
    stop();

    return;
  }

  stopping.add(request.op);
  setTimeout(stop, options.stop_ms);
}

/** The operations whose stop the toy started and has not confirmed yet. */
const stopping = new Set();

/** Stops operation `op` and every process it started. */
function stopOperation(op, record) {
  if (record.kind === 'prompt') {
    fs.mkdirSync(file('cancel'), { recursive: true });
    fs.writeFileSync(file('cancel', op), '');
    clearTimeout(working.get(op));

    // A prompt this toy waits on ends now; one a toy before it sent ends when teamai sends it again.
    if (working.has(op)) settlePrompt(op);

    return;
  }

  fs.mkdirSync(file('cancel'), { recursive: true });
  fs.writeFileSync(file('cancel', op), '');

  if (record.pgid === undefined) return;
  stopGroup(record.pgid);

  // An exec a toy before this one started ends here: no child of this process reports it.
  if (!running.has(op)) {
    const wait = setInterval(() => {
      if (groupAlive(record.pgid)) return;
      clearInterval(wait);
      writeJson(opPath(op), { kind: 'exec', handle: record.handle, outcome: { state: 'cancelled' } });
      send({ op, event: 'cancelled' });
    }, 25);
  }
}

function opsOf(handle) {
  let names;

  try { names = fs.readdirSync(file('ops')); } catch { names = []; }

  return names.filter((name) => name.endsWith('.json')).map((name) => ({ op: name.slice(0, -5), record: readOp(name.slice(0, -5)) }))
    .filter(({ record }) => (record?.kind === 'exec' || record?.kind === 'prompt') && record.handle === handle);
}

function known(handle) {
  return Object.values(readHandles()).includes(handle);
}

function reattach(request) {
  if (!known(request.handle)) {
    send({ event: 'gone', handle: request.handle });

    return;
  }

  const ops = opsOf(request.handle).map(({ op, record }) => {
    if (record.kind === 'prompt') {
      const { state, ...rest } = agentOutcome(record) ?? { state: 'running' };

      return { op, state, ...rest };
    }

    if (record.outcome?.state === 'exited') return { op, state: 'exited', code: record.outcome.code, stdout: bounded(record.outcome.stdout) };

    if (record.outcome?.state === 'cancelled') return { op, state: 'cancelled' };

    if (record.outcome?.state === 'failed') return { op, state: 'failed', failure: record.outcome.failure };

    if (running.has(op) || groupAlive(record.pgid) || ownerAlive(record)) return { op, state: 'running' };

    // A cancelled exec whose processes are gone has ended cancelled, though its outcome may not be written yet.
    return fs.existsSync(file('cancel', op)) ? { op, state: 'cancelled' } : { op, state: 'failed', failure: { code: 'runtime_lost', message: `The toy lost exec ${op}.` } };
  });

  send({ event: 'alive', handle: request.handle, ops, ...shown() });
}

/** Drops `handle` from the places the toy keeps. */
function forget(handle) {
  const handles = readHandles();

  for (const [key, kept] of Object.entries(handles)) if (kept === handle) delete handles[key];
  writeJson(file('handles.json'), handles);
}

function close(request) {
  let names;

  try { names = fs.readdirSync(file('ops')); } catch { names = []; }
  const opened = names.map((name) => readJson(file('ops', name), undefined)).find((record) => record?.kind === 'open' && record.handle === request.handle);
  const folder = opened?.view?.worktree;
  fs.appendFileSync(file('closes.jsonl'), `${JSON.stringify({ handle: request.handle, ...(folder && { present: fs.existsSync(folder) }), ...(request.release && { release: true }) })}\n`);

  // A close that releases the attempt forgets the place, whether or not the toy can end it.
  if (request.release) forget(request.handle);

  if (options.close_fails) {
    const echoed = typeof options.close_fails === 'string' ? ` It holds ${openCredentials.get(request.handle)?.[options.close_fails] ?? 'nothing'}.` : '';
    send({ event: 'close_failed', handle: request.handle, failure: { code: 'close_failed', message: `The toy keeps place ${request.handle}: close_fails is set.${echoed}` } });

    return;
  }

  forget(request.handle);
  fs.rmSync(file('bound', `${request.handle}.json`), { force: true });

  // It ends the conversations this place launched, and stops only its own turns of any it continued.
  for (const { op } of opsOf(request.handle)) {
    clearTimeout(working.get(op));
    working.delete(op);
    fs.rmSync(opPath(op), { force: true });
    fs.rmSync(conversationPath(conversationId(op)), { force: true });
    unkept.delete(op);
  }

  send({ event: 'closed', handle: request.handle });
}

let ended = false;

/** The toy outlives its stdin while an exec runs, so an exec that finishes while teamai is down is still recorded. */
function exitWhenIdle() {
  if (ended && running.size === 0 && working.size === 0 && stopping.size === 0) process.exit(0);
}

/** Wakes a fleet member as `wake_log` says: the request goes to that file, and the member is "woken" on the toy. */
function wake(request) {
  if (typeof options.wake_log !== 'string') return send({ op: request.op, event: 'failed', failure: { code: 'wake_unavailable', message: 'The toy wakes no fleet member: give it option wake_log, the file it writes each wake to.' } });
  fs.appendFileSync(options.wake_log, `${JSON.stringify(request)}\n`);
  send({ op: request.op, event: 'accepted' });
  send({ op: request.op, event: 'woken', where: 'toy' });
}

const HANDLERS = { init, open, exec, prompt, cancel, wake, collect: (request) => send({ event: 'collected', handle: request.handle }), reattach, close };

/** Answers a request for a handle or an operation as `answer` says, and says whether it did. */
function answeredOtherwise(request) {
  const how = options?.answer?.[request.type];
  const about = request.handle ?? request.op;

  if (how === undefined || about === undefined) return false;
  const refused = { code: 'toy_refused', message: `The toy refuses ${request.type} of ${about}: answer.${request.type} is set.` };

  if (how === 'failed') send(request.op === undefined ? { event: 'failed', handle: request.handle, failure: refused } : { op: request.op, event: 'failed', failure: refused });

  if (how === 'error') send({ event: 'error', message: `The toy cannot answer ${request.type} of ${about}: answer.${request.type} is set.` });

  if (how === 'display' && request.op !== undefined) send({ op: request.op, event: 'display', display: options.agent?.display ?? options.display });

  return true;
}

/** Sends the notice `notice` sets for `request`'s type, about its operation or handle, with the credentials and env it brought spelled out. */
function noticeFor(request) {
  const text = (request.type === 'init' ? request.options?.notice : options?.notice)?.[request.type];

  if (typeof text !== 'string') return;
  const message = text.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => request.credentials?.[name] ?? request.env?.[name] ?? '');
  send({ event: 'notice', ...(request.op !== undefined ? { op: request.op } : request.handle !== undefined ? { handle: request.handle } : {}), message });
}

/** The failure reply to a request the toy could not answer: for its handle, or for its operation. */
function failedReply(request, error) {
  const failure = { code: 'toy_failed', message: error instanceof Error ? error.message : String(error) };

  if (request.handle !== undefined && request.op === undefined) return { event: 'failed', handle: request.handle, failure };

  return request.op === undefined ? { event: 'error', message: failure.message } : { op: request.op, event: 'failed', failure };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const raw = JSON.parse(line);

  if (raw?.type === 'init' && raw.protocol !== 1) {
    send({ type: 'init', ok: false, error: { code: 'bad_protocol', key: 'protocol', message: `The toy runtime speaks protocol 1, and was sent protocol ${JSON.stringify(raw.protocol)}.` } });

    return;
  }

  const parsed = RuntimeRequestSchema.safeParse(raw);

  if (!parsed.success) {
    send({ event: 'error', message: `The toy runtime does not know request ${line.slice(0, 200)}: ${parsed.error.issues[0]?.message}` });

    return;
  }

  const request = parsed.data;
  const handler = HANDLERS[request.type];

  if (request.type !== 'init' && !options) {
    send({ event: 'error', message: 'Send init first.' });

    return;
  }

  if (request.type !== 'init' && typeof options.calls === 'string') {
    const call = {
      toy: path.basename(options.state), type: request.type, op: request.op, handle: request.handle, outer: request.outer, credentials: request.credentials && Object.keys(request.credentials).sort(),
      ...(request.type === 'open' && { toolHome: request.view?.toolHome }), ...((request.type === 'open' || request.type === 'reattach') && { unset: request.unset }),
    };
    fs.appendFileSync(options.calls, `${JSON.stringify(call)}\n`);
  }

  noticeFor(request);

  if (answeredOtherwise(request)) return;

  try {
    handler(request);
  } catch (error) {
    send(failedReply(request, error));
  }
}).on('close', () => {
  ended = true;
  exitWhenIdle();
});

#!/usr/bin/env node
// The toy step runtime: protocol 1 over JSON lines on stdio. It runs each exec on the host, in a process group of its
// own, and keeps handles and outcomes in the `state` option's directory, so a toy started again answers a repeated
// operation and a reattach from them. `die_at` kills the process that spawned it, once per state directory, right after
// it recorded that point and before it replies: `open-accepted` or `exec-exited`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const OPTIONS = new Set(['state', 'die_at', 'can']);

const DEFAULT_CAN = {
  hitl: false, workspace: ['read-only', 'new', 'continue'], network: false, isolation: 'none', env: true,
  tokens: true, max_turns: true, setup: true, tools: ['claude', 'codex', 'codebuddy'], end_turn: true, unattended: true, role: true,
};

let options;
const running = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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

function dieAt(point) {
  if (options.die_at !== point) return false;
  const marker = file(`died-${point}`);

  if (fs.existsSync(marker)) return false;
  fs.writeFileSync(marker, '');
  process.kill(process.ppid, 'SIGKILL');

  return true;
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
}

function stopGroup(pgid) {
  try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
  setTimeout(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
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

  options = request.options;
  fs.mkdirSync(options.state, { recursive: true });
  send({ type: 'init', ok: true, can: { ...DEFAULT_CAN, ...options.can } });
}

function open(request) {
  const handles = readJson(file('handles.json'), {});
  const key = `${request.run}/${request.attempt}`;
  const handle = handles[key] ?? `toy-${request.run}-${request.attempt}`;
  handles[key] = handle;
  writeJson(file('handles.json'), handles);
  writeJson(opPath(request.op), { kind: 'open', handle });

  if (dieAt('open-accepted')) return;
  send({ op: request.op, event: 'accepted', handle });
  send({ op: request.op, event: 'ready' });
}

function replay(op, record) {
  send({ op, event: 'accepted' });

  if (record.outcome.state === 'exited') send({ op, event: 'exited', code: record.outcome.code, stdout: record.outcome.stdout });
  else send({ op, event: 'cancelled' });
}

function exec(request) {
  const record = readJson(opPath(request.op), undefined);

  if (record?.outcome) {
    replay(request.op, record);

    return;
  }

  if (running.has(request.op)) {
    send({ op: request.op, event: 'accepted' });

    return;
  }

  const env = { ...process.env, ...request.env };

  for (const name of request.unset ?? []) delete env[name];
  const [command, ...args] = request.argv;
  const child = spawn(command, args, { cwd: request.cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  running.set(request.op, child);
  writeJson(opPath(request.op), { kind: 'exec', handle: request.handle, pgid: child.pid });
  send({ op: request.op, event: 'accepted' });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; send({ op: request.op, event: 'output', stream: 'stdout', data }); });
  child.stderr.setEncoding('utf8').on('data', (data) => { send({ op: request.op, event: 'output', stream: 'stderr', data }); });
  child.on('error', (error) => { stdout += ''; send({ op: request.op, event: 'output', stream: 'stderr', data: error.message }); });
  child.on('close', (code) => {
    running.delete(request.op);
    const cancelled = fs.existsSync(file('cancel', request.op));
    const outcome = cancelled ? { state: 'cancelled' } : { state: 'exited', code: code ?? 1, stdout };
    writeJson(opPath(request.op), { kind: 'exec', handle: request.handle, outcome });

    if (!cancelled && dieAt('exec-exited')) return;
    send(cancelled ? { op: request.op, event: 'cancelled' } : { op: request.op, event: 'exited', code: outcome.code, stdout });
    exitWhenIdle();
  });
}

function cancel(request) {
  const record = readJson(opPath(request.op), undefined);

  if (!record || record.outcome) return;
  fs.mkdirSync(file('cancel'), { recursive: true });
  fs.writeFileSync(file('cancel', request.op), '');

  if (record.pgid === undefined) return;
  stopGroup(record.pgid);

  // An exec a toy before this one started ends here: no child of this process reports it.
  if (!running.has(request.op)) {
    const wait = setInterval(() => {
      if (groupAlive(record.pgid)) return;
      clearInterval(wait);
      writeJson(opPath(request.op), { kind: 'exec', handle: record.handle, outcome: { state: 'cancelled' } });
      send({ op: request.op, event: 'cancelled' });
    }, 25);
  }
}

function opsOf(handle) {
  let names;

  try { names = fs.readdirSync(file('ops')); } catch { names = []; }

  return names.filter((name) => name.endsWith('.json')).map((name) => ({ op: name.slice(0, -5), record: readJson(file('ops', name), undefined) }))
    .filter(({ record }) => record?.kind === 'exec' && record.handle === handle);
}

function known(handle) {
  return Object.values(readJson(file('handles.json'), {})).includes(handle);
}

function reattach(request) {
  if (!known(request.handle)) {
    send({ event: 'gone', handle: request.handle });

    return;
  }

  const ops = opsOf(request.handle).map(({ op, record }) => {
    if (record.outcome?.state === 'exited') return { op, state: 'exited', code: record.outcome.code, stdout: record.outcome.stdout };

    if (record.outcome?.state === 'cancelled') return { op, state: 'cancelled' };

    return running.has(op) || groupAlive(record.pgid) ? { op, state: 'running' } : { op, state: 'failed', failure: { code: 'runtime_lost', message: `The toy lost exec ${op}.` } };
  });

  send({ event: 'alive', handle: request.handle, ops });
}

function close(request) {
  const handles = readJson(file('handles.json'), {});

  for (const [key, handle] of Object.entries(handles)) if (handle === request.handle) delete handles[key];
  writeJson(file('handles.json'), handles);

  for (const { op } of opsOf(request.handle)) fs.rmSync(opPath(op), { force: true });
  send({ event: 'closed', handle: request.handle });
}

let ended = false;

/** The toy outlives its stdin while an exec runs, so an exec that finishes while teamai is down is still recorded. */
function exitWhenIdle() {
  if (ended && running.size === 0) process.exit(0);
}

const HANDLERS = { init, open, exec, cancel, collect: (request) => send({ event: 'collected', handle: request.handle }), reattach, close };

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const request = JSON.parse(line);
  const handler = HANDLERS[request.type];

  if (!handler) {
    send({ event: 'error', message: `The toy runtime does not know request "${request.type}".` });

    return;
  }

  if (request.type !== 'init' && !options) {
    send({ event: 'error', message: 'Send init first.' });

    return;
  }

  handler(request);
}).on('close', () => {
  ended = true;
  exitWhenIdle();
});

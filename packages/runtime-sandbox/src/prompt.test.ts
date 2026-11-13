import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from './testing/harness.js';
import { closeLeftovers, expectNothingLeft } from './testing/leaks.js';
import { entriesUnder } from '@teamai/shared/entries-under';

// A prompt step's tool run by the sandbox runtime itself, through its stdio entry point, on a fake docker
// (testing/fake-engine.mjs): teamai sends the lease as a `prompt`, and the runtime launches the tool in the attempt's
// container, on the attempt's tool home.

const IMAGE = 'ghcr.io/acme/agent:1';
const RUN = 'r0123abcd';
const ATTEMPT = 'a0123abcd';
const HANDLE = `teamai-${RUN}-${ATTEMPT}`;

/**
 * A headless Claude as the step launch drives it: it prints stream-json, keeps its session in the Claude home it is
 * given, writes the workflow result, and notes how it was launched in that home. What its prompt says picks a way to end:
 * `spend` streams usage until it is stopped, `hang` prints nothing until it is stopped, `limit` ends on a spent usage
 * limit, `fail` exits 2 on an error it prints on stderr, `flood` exits 2 after one stderr line longer than the tail
 * teamai keeps of it, which starts with its sign-in token, and `echo` puts that token in its reply.
 */
const AGENT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const prompt = args.includes('-p') ? args[args.indexOf('-p') + 1] : '';
const home = process.env.CLAUDE_CONFIG_DIR;
const id = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'session-' + process.pid;
const say = (line) => process.stdout.write(JSON.stringify(line) + '\n');
fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
fs.appendFileSync(path.join(home, 'projects', id + '.jsonl'), JSON.stringify({ sessionId: id, cwd: process.cwd() }) + '\n');
fs.writeFileSync(path.join(home, 'launch.json'), JSON.stringify({ args, env: Object.keys(process.env).sort(), cwd: process.cwd(), baseUrl: process.env.ANTHROPIC_BASE_URL }));
say({ type: 'system', subtype: 'init', session_id: id, model: 'claude-sonnet-4-5' });
if (prompt.includes('spend')) {
  let n = 0;
  setInterval(() => {
    n += 1;
    say({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' + n, usage: { input_tokens: 100, output_tokens: 1 } } } });
  }, 20);
} else if (prompt.includes('hang')) {
  setInterval(() => {}, 1000);
} else if (prompt.includes('limit')) {
  say({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm (Europe/Madrid)", session_id: id });
  process.exit(1);
} else if (prompt.includes('flood')) {
  process.stderr.write(process.env.ANTHROPIC_API_KEY + 'y'.repeat(7995));
  process.exit(2);
} else if (prompt.includes('fail')) {
  process.stderr.write('auth failed for ' + process.env.ANTHROPIC_API_KEY + '\n');
  process.exit(2);
} else {
  const reply = prompt.includes('echo') ? 'token ' + process.env.ANTHROPIC_API_KEY : 'Done.';
  fs.writeFileSync(process.env.TEAMAI_WORKFLOW_RESULT, JSON.stringify({ output: { ok: true, reply } }));
  say({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: id, usage: { input_tokens: 10, output_tokens: 5 } });
}
`;

let executable: string;
let dir: string;
let engine: FakeEngine;
const open: Connection[] = [];
let opCount = 0;

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  engine = fakeEngine(dir);
  engine.image(IMAGE, { claude: AGENT, codex: AGENT, opencode: AGENT });
  fs.mkdirSync(path.join(dir, 'home'));
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  engine.repair();
  const { invalid, recovered } = await closeLeftovers(connections);

  expect([...connections.flatMap((connection) => connection.invalid), ...invalid]).toEqual([]);
  await expectNothingLeft({ connections: [...connections, ...recovered], dir, containers: engine.containers, planted: [] });
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(extra: NodeJS.ProcessEnv = {}): Connection {
  const connection = connect(executable, { ...engine.env(), HOME: path.join(dir, 'home'), ...extra });
  open.push(connection);

  return connection;
}

function newOp(): string {
  opCount += 1;

  return `op-${opCount.toString(16).padStart(8, '0')}`;
}

async function init(connection: Connection): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options: { provider: 'docker', image: IMAGE }, credentials: { env: ['ANTHROPIC_API_KEY'], logins: [] } });

  return connection.next((message) => message.type === 'init', 30_000);
}

interface Place {
  worktree: string;
  result: string;
  toolHome: string;
}

/** Opens the attempt's place for Claude, with its tool home under CLAUDE_CONFIG_DIR. */
async function openPlace(connection: Connection): Promise<Place> {
  const at = { worktree: path.join(dir, 'worktree'), result: path.join(dir, 'attempts', ATTEMPT, 'out'), toolHome: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') };
  const git = path.join(dir, 'repo.git');
  fs.mkdirSync(at.worktree, { recursive: true });
  fs.mkdirSync(git, { recursive: true });
  fs.mkdirSync(at.toolHome, { recursive: true });
  const op = newOp();
  connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'claude', credentials: {}, view: { worktree: at.worktree, readonly: [git], result: at.result, runDir: path.join(dir, 'runs', RUN, 'scratch'), toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
  expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });

  return at;
}

/** Sends a headless Claude prompt lease, and gives its end. */
async function prompt(connection: Connection, at: Place, lease: Message = {}, request: Message = {}, op = newOp()): Promise<Message> {
  connection.send({
    type: 'prompt', op, handle: HANDLE, env: {}, unset: [], credentials: { ANTHROPIC_API_KEY: 'sk-ant-secret-1' }, cwd: at.worktree, ...request,
    lease: { step: 'review', tool: 'claude', prompt: 'Review it.', result: path.join(at.result, 'result.json'), permissions: 'unattended', interactive: false, ...lease },
  });

  return connection.next((message) => message.op === op && ['finished', 'failed', 'cancelled'].includes(String(message.event)), 30_000);
}

/** How the agent was launched, as it noted in its home. */
function launched(at: Place): { args: string[]; env: string[]; cwd: string; baseUrl?: string } {
  return JSON.parse(fs.readFileSync(path.join(at.toolHome, 'launch.json'), 'utf8'));
}

describe('a prompt step in the attempt\'s container', () => {
  it('runs the lease\'s tool in the container on the attempt\'s tool home, and finishes with its session, result and usage', async () => {
    const connection = start();
    expect(await init(connection)).toMatchObject({ ok: true, prompt: true, toolHome: true });
    const at = await openPlace(connection);
    const end = await prompt(connection, at);

    expect(end).toMatchObject({ event: 'finished', session: { tool: 'claude' }, result: { output: { ok: true, reply: 'Done.' } }, usage: { input: 10, output: 5 } });
    const session = String((end.session as Message).id);
    // The session is in the attempt's tool home, where teamai reads it.
    expect(fs.existsSync(path.join(at.toolHome, 'projects', `${session}.jsonl`))).toBe(true);
    expect(engine.calls().some(([, command, ...rest]) => command === 'exec' && rest.includes('claude'))).toBe(true);
    expect(launched(at).cwd).toBe(at.worktree);
  });

  it('runs a prompt in a place on the provider it was opened with, when a resume after a profile change inits another one', async () => {
    const first = start();
    await init(first);
    const at = await openPlace(first);
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    second.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options: { provider: 'podman', image: IMAGE }, credentials: { env: ['ANTHROPIC_API_KEY'], logins: [] } });
    expect(await second.next((message) => message.type === 'init', 30_000)).toMatchObject({ ok: true });
    const before = engine.calls().length;

    expect(await prompt(second, at)).toMatchObject({ event: 'finished', result: { output: { ok: true, reply: 'Done.' } } });
    expect(engine.calls().slice(before).filter(([, command]) => command === 'exec').map(([name]) => name)).toEqual(['docker']);
  });

  it('continues the session the lease names, and says it resumed it', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    expect(await prompt(connection, at, { resume: 'session-earlier' })).toMatchObject({ event: 'finished', session: { tool: 'claude', id: 'session-earlier' }, resumed: true });
    expect(launched(at).args).toEqual(expect.arrayContaining(['--resume', 'session-earlier']));
  });

  it('gives the tool only the environment the lease names, never one of the runtime\'s own, whatever this machine sets', async () => {
    const connection = start({ RUNTIME_OWN_SECRET: 'runtime-value-1' });
    await init(connection);
    const at = await openPlace(connection);

    expect(await prompt(connection, at, {}, { env: { STEP_VALUE: 'from-teamai' } })).toMatchObject({ event: 'finished' });
    const { env } = launched(at);
    expect(env).toEqual(expect.arrayContaining(['STEP_VALUE', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'TEAMAI_WORKFLOW_RESULT']));
    expect(env).not.toContain('RUNTIME_OWN_SECRET');
    expect(env).not.toContain('FAKE_ENGINE_STATE');
  });

  it('gives the tool a base URL on this machine itself as the host alias the container reaches it by', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    expect(await prompt(connection, at, {}, { credentials: { ANTHROPIC_API_KEY: 'sk-ant-secret-1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/anthropic' } })).toMatchObject({ event: 'finished' });
    expect(launched(at).baseUrl).toBe('http://host.docker.internal:4000/anthropic');
  });
});

describe('the limits a prompt lease names', () => {
  it('stops the tool in the container once its stdout states more tokens than the budget, and finishes stopped at the budget', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    const end = await prompt(connection, at, { prompt: 'spend tokens', limits: { budget: { tokens: 250 } } });

    expect(end).toMatchObject({ event: 'finished', stopped: 'budget', session: { tool: 'claude' }, usage: { input: expect.any(Number) } });
    expect(Number((end.usage as Message).input)).toBeGreaterThan(250);
  });

  it('stops a tool still working at the timeout, and finishes stopped at it', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    expect(await prompt(connection, at, { prompt: 'hang on', limits: { timeoutMs: 800 } })).toMatchObject({ event: 'finished', stopped: 'timeout', session: { tool: 'claude' } });
  });

  it('fails a tool it could not stop at the timeout, naming what still runs and how to remove it, rather than letting it run on', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);
    const op = newOp();
    const ending = prompt(connection, at, { prompt: 'hang on', limits: { timeoutMs: 1_500 } }, {}, op);
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.toolHome, 'launch.json'))).toBe(true); }, { timeout: 10_000 });
    // The engine stops answering while the tool runs, so the stop at the timeout fails.
    engine.daemon(false);

    expect(await ending).toMatchObject({
      event: 'failed',
      failure: { code: 'sandbox_failed', message: expect.stringMatching(/claude reached a limit of its step and could not be stopped: docker could not stop the processes in container .*docker rm --force/) },
    });
    // teamai closes the place of a failed step, which removes what still ran there.
    engine.daemon(true);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  });

  it('fails a tool that prints nothing for longer than the idle limit, naming the limit', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    expect(await prompt(connection, at, { prompt: 'hang on', limits: { idleMs: 500 } })).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('idle limit') } });
  });
});

describe('how a prompt step\'s tool fails', () => {
  it('fails usage_limited with the tool\'s own words, which name the reset', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    expect(await prompt(connection, at, { prompt: 'limit reached' })).toMatchObject({ event: 'failed', failure: { code: 'usage_limited', message: expect.stringContaining('resets 3pm') } });
  });

  it('fails tool_failed with the end of what the tool printed on stderr, masked of every credential it got', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);
    const end = await prompt(connection, at, { prompt: 'fail now' });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'tool_failed', message: expect.stringContaining('Its stderr in the sandbox ends: auth failed for') } });
    expect(JSON.stringify(end)).not.toContain('sk-ant-secret-1');
  });

  it('quotes no part of a credential the start of the stderr tail it keeps cuts through', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);

    const end = await prompt(connection, at, { prompt: 'flood it' });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'tool_failed' } });
    expect(JSON.stringify(connection.messages)).not.toContain('ret-1y');
  });

  it('masks a credential the tool put in its result, on the wire and in the journal', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);
    const end = await prompt(connection, at, { prompt: 'echo it' });

    expect(end).toMatchObject({ event: 'finished', result: { output: { ok: true } } });
    expect(JSON.stringify(end)).not.toContain('sk-ant-secret-1');
    const journal = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox');
    const kept = entriesUnder(journal).map(({ relative }) => relative).filter((file) => file.endsWith('.json')).map((file) => fs.readFileSync(path.join(journal, file), 'utf8'));
    expect(kept.join('\n')).not.toContain('sk-ant-secret-1');
  });

  it('stops the tool on a cancel, and ends the prompt cancelled', async () => {
    const connection = start();
    await init(connection);
    const at = await openPlace(connection);
    const op = newOp();
    const ending = prompt(connection, at, { prompt: 'hang on' }, {}, op);
    await connection.next((message) => message.op === op && message.event === 'accepted');
    // Once the tool started in the container, so the cancel stops a running process.
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.toolHome, 'launch.json'))).toBe(true); }, { timeout: 10_000, interval: 50 });
    connection.send({ type: 'cancel', op });

    expect(await ending).toMatchObject({ op, event: 'cancelled' });
  });
});


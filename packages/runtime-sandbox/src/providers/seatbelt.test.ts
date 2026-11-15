import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRuntime, tempDir, type Connection, type Message } from '../testing/harness.js';
import { exec, failStandIn, HANDLE, init, nativeHost, openPlace, placeIn, startOn, type NativeHost } from '../testing/native-harness.js';
import { closeLeftovers, expectNothingLeft } from '../testing/leaks.js';
import { signalGroup } from '@teamai/shared/process-group';

// The seatbelt provider through the runtime's stdio entry point: on a stand-in sandbox-exec that records the profile and
// runs the command, and, on macOS, on the real one, which alone proves what the profile hides.

const CLAUDE = "if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)'); else console.log('reviewed');";

let executable: string;
let host: NativeHost;
const open: Connection[] = [];

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  host = nativeHost(tempDir());
  host.tool('claude', CLAUDE);
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  const { invalid, recovered } = await closeLeftovers(connections);
  expect([...connections.flatMap((connection) => connection.invalid), ...invalid]).toEqual([]);
  await expectNothingLeft({ connections: [...connections, ...recovered], dir: host.dir });
  fs.rmSync(host.dir, { recursive: true, force: true });
});

const start = (extra: NodeJS.ProcessEnv = {}): Connection => startOn(executable, host, open, extra);

/** The profile the last stand-in sandbox-exec was given, with its `-D` parameters. */
function lastProfile(): { profile: string; params: Record<string, string>; command: string[] } {
  const call = host.calls().findLast(([name]) => name === 'sandbox-exec') ?? [];
  const params: Record<string, string> = {};
  let profile = '';
  let index = 1;

  while (index < call.length) {
    const flag = call[index];

    if (flag === '-p') profile = call[index + 1] ?? '';
    else if (flag === '-D') {
      const [name = '', ...value] = (call[index + 1] ?? '').split('=');
      params[name] = value.join('=');
    } else break;
    index += 2;
  }

  return { profile, params, command: call.slice(index) };
}

describe('seatbelt: init', () => {
  it('offers the tools on this machine that sign in, at isolation worktree, and never unattended', async () => {
    const reply = await init(start(), { provider: 'seatbelt' }, { env: ['ANTHROPIC_API_KEY'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'worktree', env: true, setup: true, tools: ['claude'], workspace: ['read-only', 'new', 'continue', 'clone', 'team'] } });
    expect(reply.can).not.toHaveProperty('unattended');
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('names CLAUDE_CODE_OAUTH_TOKEN for Claude when only a login on this machine signs it in, which the sandbox does not read', async () => {
    const reply = await init(start(), { provider: 'seatbelt' }, { env: [], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { tools: [] } });
    expect(String((reply.unavailable as Message).claude)).toContain('CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('takes no option but provider, naming the key', async () => {
    expect(await init(start(), { provider: 'seatbelt', image: 'x' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'image', message: 'Provider seatbelt takes no option "image". It takes: provider' } });
  });

  it('fails sandbox_unavailable on a macOS older than 14, and runs nothing', async () => {
    const reply = await init(start({ FAKE_MACOS_VERSION: '13.6.1' }), { provider: 'seatbelt' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toContain('macOS 14');
  });

  it('fails sandbox_unavailable saying macOS does not nest sandboxes when sandbox-exec is not permitted to start one', async () => {
    failStandIn(host, 'sandbox-exec', 'sandbox-exec: sandbox_apply: Operation not permitted');
    const reply = await init(start(), { provider: 'seatbelt' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    const message = String((reply.error as Message).message);

    expect(message).toContain('sandbox_apply: Operation not permitted');
    expect(message).toContain('already runs inside a macOS sandbox');
  });

  it('fails sandbox_unavailable off macOS, naming bwrap', async () => {
    fs.rmSync(path.join(host.system, 'sw_vers'));
    const reply = await init(start(), { provider: 'seatbelt' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toContain('provider: bwrap');
  });
});

describe('seatbelt: a step', () => {
  it('runs the step under a profile that denies what it does not allow, on a home and temp directory of its own', async () => {
    const connection = start();
    await init(connection, { provider: 'seatbelt' }, { env: ['ANTHROPIC_API_KEY'], logins: [] });
    const at = placeIn(host.dir);
    const { ready } = await openPlace(connection, at, { tool: 'claude' });

    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (seatbelt)` } });

    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Review it.'], credentials: { ANTHROPIC_API_KEY: 'step-key' }, env: { CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('reviewed\n');
    const { profile, params, command } = lastProfile();

    expect(command).toEqual(['claude', '-p', 'Review it.']);
    expect(profile).toContain('(deny default)');
    expect(Object.values(params)).toEqual(expect.arrayContaining([fs.realpathSync(at.worktree), fs.realpathSync(at.git), path.join(fs.realpathSync(host.home), '.docker')]));
    expect(Object.values(params)).not.toContain(fs.realpathSync(host.home));
    // No credential value ever reaches the sandbox's argv.
    expect(JSON.stringify(host.calls())).not.toContain('step-key');
  });
});

describe("seatbelt: macOS's own sandbox-exec", () => {
  it('runs sandbox-exec and sw_vers from /usr/bin, never one found earlier on PATH', async () => {
    const planted = path.join(host.dir, 'planted-bin');
    fs.mkdirSync(planted);
    const marker = path.join(host.dir, 'planted-ran');

    // Either one, run, would leave its name in the marker, and the planted sandbox-exec runs the step unconfined.
    fs.writeFileSync(path.join(planted, 'sw_vers'), `#!/bin/sh\necho sw_vers >> "${marker}"\necho 15.1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(planted, 'sandbox-exec'), `#!/bin/sh\necho sandbox-exec >> "${marker}"\nwhile [ $# -gt 0 ]; do case "$1" in -p|-D) shift 2 ;; *) break ;; esac; done\nexec "$@"\n`, { mode: 0o755 });
    const connection = start({ PATH: [planted, host.fakes, host.tools, '/usr/bin', '/bin'].join(path.delimiter) });

    expect(await init(connection, { provider: 'seatbelt' })).toMatchObject({ ok: true });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Review it.'], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('reviewed\n');
    expect(fs.existsSync(marker)).toBe(false);
    expect(host.calls().filter(([name]) => name === 'sandbox-exec')).toHaveLength(2);
  });
});

describe('seatbelt: lifecycle', () => {
  /** A step that says it started, then waits until it is stopped. */
  const WAITS = "console.log('started'); setInterval(() => {}, 1000);";

  it('cancels a running step by ending its process group, then removes its place at close', async () => {
    host.tool('waits', WAITS);
    const connection = start();
    await init(connection, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    const op = 'op-0000beef';
    connection.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await connection.next((message) => message.op === op && message.event === 'output');
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);

    expect(fs.existsSync(path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE))).toBe(false);
  });

  it('answers a cancel from a runtime started again once a killed runtime took its step down', async () => {
    host.tool('waits', WAITS);
    const first = start();
    await init(first, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(first, at);
    const op = 'op-0000cafe';
    first.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await first.next((message) => message.op === op && message.event === 'output');
    const pids = path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE, 'pids');
    const [pgid] = fs.readdirSync(pids).map(Number);
    first.child.kill('SIGKILL');
    await first.end();

    const second = start();
    await init(second, { provider: 'seatbelt' });
    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    expect(signalGroup(Number(pgid), 0)).toBe('gone');
  });

  it("removes an exec's group file once a killed runtime's step is taken down, so no later stop signals that number", async () => {
    host.tool('waits', WAITS);
    const first = start();
    await init(first, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(first, at);
    const op = 'op-0000cafe';
    first.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await first.next((message) => message.op === op && message.event === 'output');
    const pids = path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE, 'pids');
    const [pgid] = fs.readdirSync(pids).map(Number);
    first.child.kill('SIGKILL');
    await first.end();
    await vi.waitFor(() => { expect(signalGroup(Number(pgid), 0)).toBe('gone'); }, { timeout: 10_000 });

    // The number is free for another group of the member's from now on, so nothing of this place names it any more.
    await vi.waitFor(() => { expect(fs.readdirSync(pids)).toEqual([]); }, { timeout: 5_000 });
    const second = start();
    await init(second, { provider: 'seatbelt' });
    second.send({ type: 'close', handle: HANDLE });
    await second.next((message) => message.event === 'closed' && message.handle === HANDLE);
  });

  it('leaves alone a process group whose number a step held before this machine started, at close', async () => {
    const connection = start();
    await init(connection, { provider: 'seatbelt' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    // The member's own process, whose number a step of an earlier boot held.
    const theirs = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pidFile = path.join(host.home, '.teamai', 'runtime-state', 'sandbox', 'seatbelt', HANDLE, 'pids', String(theirs.pid));
    fs.writeFileSync(pidFile, '');
    const beforeBoot = new Date(Date.now() - (os.uptime() + 3_600) * 1000);
    fs.utimesSync(pidFile, beforeBoot, beforeBoot);

    try {
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);

      expect(signalGroup(Number(theirs.pid), 0)).toBe('sent');
    } finally {
      theirs.kill('SIGKILL');
    }
  });
});

// Only the real sandbox-exec proves what the profile hides; containment.test.ts holds the probes bwrap shares.
describe.runIf(process.platform === 'darwin')('seatbelt: on this Mac', () => {
  it("reads a tool in a bin under the member's home, never what sits beside that bin or what the step's own PATH names", async () => {
    const local = path.join(host.home, '.local');
    fs.mkdirSync(path.join(local, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(local, 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(local, 'share', 'opencode', 'auth.json'), '{"token":"member"}');
    fs.mkdirSync(path.join(host.home, '.config'));
    fs.writeFileSync(path.join(host.home, '.config', 'login'), 'member login');
    fs.writeFileSync(path.join(local, 'bin', 'probe'), `#!${process.execPath}\nconst fs = require('node:fs');\nconsole.log(JSON.stringify(process.argv.slice(2).map((at) => { try { fs.readFileSync(at); return 'ok'; } catch (error) { return error.code; } })));\n`, { mode: 0o755 });
    const connection = startOn(executable, host, open, { PATH: [path.join(local, 'bin'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: fs.realpathSync(host.dir), SANDBOX_TEST_SYSTEM_BIN: undefined });
    expect(await init(connection, { provider: 'seatbelt' })).toMatchObject({ ok: true });
    const at = placeIn(host.dir);
    await openPlace(connection, at);

    const { end, output } = await exec(connection, {
      argv: ['probe', path.join(local, 'bin', 'probe'), path.join(local, 'share', 'opencode', 'auth.json'), path.join(host.home, '.config', 'login')],
      env: { PATH: [path.join(local, 'bin'), path.join(host.home, '.config'), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) },
      cwd: at.worktree,
    });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(JSON.parse(output)).toEqual(['ok', 'EPERM', 'EPERM']);
  });
});

// A step reaches no port of this Mac but the ones its credentials name: not the member's daemons on loopback, such as
// Paseo's, which take any local client and run what it asks outside the sandbox.
describe.runIf(process.platform === 'darwin')('seatbelt: this Mac\'s own ports, on this Mac', () => {
  const servers: net.Server[] = [];

  /** A listener on this Mac's loopback that answers every connection with `reply`, and its port. */
  async function listening(reply: string): Promise<number> {
    const server = net.createServer((socket) => { socket.end(reply); });
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });

    return z.object({ port: z.number() }).parse(server.address()).port;
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.close(resolve); })));
  });

  it("refuses a step a port of this Mac's loopback, and lets it reach the gateway its credentials name there", async () => {
    const daemon = await listening('daemon');
    const gateway = await listening('gateway');
    host.tool('connects', "const net = require('node:net'); const [host, port] = process.argv.slice(2); const socket = net.connect(Number(port), host); socket.on('data', (data) => { console.log(String(data)); process.exit(0); }); socket.on('error', (error) => { console.log(error.code); process.exit(0); });");
    const connection = startOn(executable, host, open, { PATH: [host.tools, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), TMPDIR: fs.realpathSync(host.dir), SANDBOX_TEST_SYSTEM_BIN: undefined });
    expect(await init(connection, { provider: 'seatbelt' })).toMatchObject({ ok: true });
    const at = placeIn(host.dir);
    await openPlace(connection, at, { credentials: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway}/anthropic` } });
    const reach = async (address: string, port: number): Promise<string> => (await exec(connection, { argv: ['connects', address, String(port)], cwd: at.worktree })).output.trim();

    expect({ daemon: await reach('127.0.0.1', daemon), byName: await reach('localhost', daemon), gateway: await reach('127.0.0.1', gateway) }).toEqual({ daemon: 'EPERM', byName: 'EPERM', gateway: 'gateway' });
  });
});

describe('seatbelt: never the outer of an app runtime', () => {
  it('opens a place for a tool with no attempt socket, as it confines files only', async () => {
    const connection = start();
    await init(connection, { provider: 'seatbelt' }, { env: ['ANTHROPIC_API_KEY'], logins: [] });
    const { accepted } = await openPlace(connection, placeIn(host.dir), { tool: 'claude' });

    expect(accepted.handle).toBe(HANDLE);
  });
});

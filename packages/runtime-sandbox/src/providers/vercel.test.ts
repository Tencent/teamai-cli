import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bundleRuntimeWith, connect, tempDir, type Connection, type Message } from '../testing/harness.js';
import { closeLeftovers, expectNothingLeft } from '../testing/leaks.js';
import { ATTEMPT, exec, HANDLE, newOp, openPlace, placeIn, RUN, type Place } from '../testing/native-harness.js';
import { entriesUnder } from '@teamai/shared/entries-under';

// The vercel provider through the runtime's stdio entry point, bundled as it ships but with `@vercel/sandbox` replaced
// by a stand-in (testing/vercel-fake-sdk.ts) whose hosted sandboxes are directories on this machine. Only a Vercel
// account proves the real SDK; this proves what the runtime asks of it and what it copies back.

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A tool in Vercel's image: prints its args, writes into its working directory and its tool home. */
const CLAUDE = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
fs.writeFileSync('README.md', 'add(a, b) returns a + b.\\n');
fs.rmSync('obsolete.txt', { force: true });
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/session.jsonl', '{}\\n');
console.log(JSON.stringify({ names: Object.keys(process.env).sort() }));`;

let executable: string;
let dir: string;
let stateDir: string;
let imageDir: string;
const open: Connection[] = [];

beforeAll(async () => {
  executable = await bundleRuntimeWith({
    outfile: path.join(tempDir(), 'teamai-runtime-sandbox.mjs'),
    alias: { '@vercel/sandbox': path.join(HERE, '..', 'testing', 'vercel-fake-sdk.ts') },
  });
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  stateDir = path.join(dir, 'vercel-state');
  imageDir = path.join(dir, 'image');
  fs.mkdirSync(imageDir);
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(imageDir, 'claude'), `#!${process.execPath}\n${CLAUDE}\n`, { mode: 0o755 });
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  const { invalid, recovered } = await closeLeftovers(connections);
  expect([...connections.flatMap((connection) => connection.invalid), ...invalid]).toEqual([]);
  await expectNothingLeft({ connections: [...connections, ...recovered], dir, vercelState: stateDir });
  // A sandbox a test left open holds read-only git paths.
  execFileSync('chmod', ['-R', 'u+w', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
});

const AUTH = { VERCEL_TOKEN: 'vercel-token-value', VERCEL_TEAM_ID: 'team_acme', VERCEL_PROJECT_ID: 'prj_acme' };

function start(extra: NodeJS.ProcessEnv = AUTH): Connection {
  const connection = connect(executable, { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), FAKE_VERCEL_STATE: stateDir, FAKE_VERCEL_IMAGE: imageDir, ...extra });
  open.push(connection);

  return connection;
}

async function init(connection: Connection, options: Message = { provider: 'vercel' }, credentials = { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] }): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options, credentials });

  return connection.next((message) => message.type === 'init', 30_000);
}

const CallSchema = z.looseObject({ call: z.string() });

function calls(): Array<z.infer<typeof CallSchema>> {
  const file = path.join(stateDir, 'calls.log');

  // The log of a call another runtime process makes now may exist and be empty yet.
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => CallSchema.parse(JSON.parse(line))) : [];
}

/** The sandbox's own copy of host path `at`. */
const inSandbox = (name: string, at: string): string => path.join(stateDir, 'sandboxes', name, 'root', at);

function sandboxNames(): string[] {
  const root = path.join(stateDir, 'sandboxes');

  return fs.existsSync(root) ? fs.readdirSync(root) : [];
}

/** A place whose worktree holds a README, a file the step deletes, and a `.git` pointer into the read-only git path. */
function preparedPlace(): Place {
  const at = placeIn(dir);
  fs.writeFileSync(path.join(at.worktree, 'README.md'), 'add(a, b) returns a - b.\n');
  fs.writeFileSync(path.join(at.worktree, 'obsolete.txt'), 'old\n');
  fs.writeFileSync(path.join(at.git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(at.toolHome, { recursive: true });
  fs.writeFileSync(path.join(at.toolHome, 'settings.json'), '{}\n');

  return at;
}

async function collect(connection: Connection): Promise<Message> {
  connection.send({ type: 'collect', handle: HANDLE });

  return connection.next((message) => message.handle === HANDLE && (message.event === 'collected' || message.event === 'collect_failed' || message.event === 'failed'), 30_000);
}

describe('vercel: init', () => {
  it('offers a hosted sandbox with Claude, which its image ships, signed in by the credential teamai gives', async () => {
    const reply = await init(start());

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('fails sandbox_unavailable naming the variables to set when it has no Vercel sign-in', async () => {
    const reply = await init(start({}));

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toMatch(/VERCEL_TOKEN.*VERCEL_TEAM_ID.*VERCEL_PROJECT_ID.*VERCEL_OIDC_TOKEN/s);
  });

  it('names the variables a token lacks when VERCEL_TOKEN is set without its team or project', async () => {
    const neither = await init(start({ VERCEL_TOKEN: 'vercel-token-value' }));

    expect(neither).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringMatching(/VERCEL_TOKEN is set, but not VERCEL_TEAM_ID and VERCEL_PROJECT_ID/) } });

    const noProject = await init(start({ VERCEL_TOKEN: 'vercel-token-value', VERCEL_TEAM_ID: 'team_acme' }));

    expect(noProject).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringMatching(/VERCEL_TOKEN is set, but not VERCEL_PROJECT_ID\b/) } });
    expect(JSON.stringify(noProject)).not.toContain('vercel-token-value');
  });

  it('reads the provider auth a definition names, from another variable or a file', async () => {
    fs.writeFileSync(path.join(dir, 'token'), 'vercel-token-from-file\n');
    const reply = await init(start({ ACME_VERCEL_TEAM: 'team_acme', VERCEL_PROJECT_ID: 'prj_acme' }), { provider: 'vercel', provider_auth: { VERCEL_TOKEN: `file:${path.join(dir, 'token')}`, VERCEL_TEAM_ID: 'env:ACME_VERCEL_TEAM' } });

    expect(reply).toMatchObject({ ok: true });
  });

  it('signs in with an OIDC token alone, which it leaves to the SDK and never gives the step', async () => {
    fs.writeFileSync(path.join(dir, 'oidc'), 'vercel-oidc-value\n');
    const connection = start({});
    expect(await init(connection, { provider: 'vercel', provider_auth: { VERCEL_OIDC_TOKEN: `file:${path.join(dir, 'oidc')}` } })).toMatchObject({ ok: true });
    const at = preparedPlace();
    await openPlace(connection, at, { tool: 'claude' });

    expect(calls().find((call) => call.call === 'create')).toMatchObject({ auth: [], oidc: true });
    const { output } = await exec(connection, { argv: ['/bin/sh', '-c', 'env | cut -d= -f1'], cwd: at.worktree });

    expect(output.split('\n').filter((name) => name.startsWith('VERCEL_'))).toEqual([]);
    expect(JSON.stringify(calls())).not.toContain('vercel-oidc-value');
  });

  it('refuses provider auth it does not know, a value that is not env: or file:, and a lifetime Vercel does not take', async () => {
    expect(await init(start(), { provider: 'vercel', provider_auth: { VERCEL_TOKN: 'env:VERCEL_TOKEN' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider_auth.VERCEL_TOKN' } });
    expect(await init(start(), { provider: 'vercel', provider_auth: { VERCEL_TOKEN: 'abc' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider_auth.VERCEL_TOKEN' } });
    expect(await init(start(), { provider: 'vercel', timeout: '9h' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'timeout' } });
    expect(await init(start(), { provider: 'vercel', timeout: 'soon' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'timeout' } });
  });
});

describe('vercel: an attempt', () => {
  it('creates one sandbox with persistence off and no credential, recreates the place at its host paths, and runs the step there', async () => {
    const connection = start();
    await init(connection, { provider: 'vercel', runtime: 'node24', timeout: '2h' });
    const at = preparedPlace();
    const { ready } = await openPlace(connection, at, { tool: 'claude' });

    expect(ready).toMatchObject({ event: 'ready' });
    const [name = ''] = sandboxNames();
    const created = calls().find((call) => call.call === 'create');

    expect(created).toMatchObject({ persistent: false, timeout: 2 * 3_600_000, runtime: 'node24', auth: ['token', 'teamId', 'projectId'] });
    expect(fs.readFileSync(inSandbox(name, path.join(at.worktree, 'README.md')), 'utf8')).toBe('add(a, b) returns a - b.\n');
    expect(fs.readFileSync(inSandbox(name, path.join(at.toolHome, 'settings.json')), 'utf8')).toBe('{}\n');
    expect(fs.existsSync(inSandbox(name, at.result))).toBe(true);
    // The git paths are read-only inside.
    expect(fs.statSync(inSandbox(name, path.join(at.git, 'HEAD'))).mode & 0o222).toBe(0);

    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Fix it.'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'step-token' }, env: { CLAUDE_CONFIG_DIR: at.toolHome }, unset: ['GITHUB_TOKEN'], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    const { names } = z.object({ names: z.array(z.string()) }).parse(JSON.parse(output));

    // The step gets the exec's credential, and none of the provider's auth.
    expect(names).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(names.filter((variable) => variable.startsWith('VERCEL_'))).toEqual([]);
    expect(JSON.stringify(calls())).not.toMatch(/vercel-token-value|step-token/);
  });

  it('copies the work back at collect: changes, deletions and the tool home, never the git paths', async () => {
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at, { tool: 'claude' });
    await exec(connection, { argv: ['claude', '-p', 'Fix it.'], env: { CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree });
    const [name = ''] = sandboxNames();
    fs.chmodSync(inSandbox(name, path.join(at.git, 'HEAD')), 0o644);
    fs.writeFileSync(inSandbox(name, path.join(at.git, 'HEAD')), 'planted\n');

    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readFileSync(path.join(at.worktree, 'README.md'), 'utf8')).toBe('add(a, b) returns a + b.\n');
    expect(fs.existsSync(path.join(at.worktree, 'obsolete.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(at.toolHome, 'session.jsonl'), 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(path.join(at.git, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
  });

  it("copies back what the step wrote in the run directory, and nothing there it left alone or another step wrote meanwhile", async () => {
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    fs.mkdirSync(at.runDir, { recursive: true });
    fs.writeFileSync(path.join(at.runDir, 'notes.md'), 'step 1\n');
    await openPlace(connection, at);
    const [name = ''] = sandboxNames();
    fs.writeFileSync(inSandbox(name, path.join(at.runDir, 'plan.md')), 'step 2: test\n');
    fs.writeFileSync(path.join(at.runDir, 'other-attempt.md'), 'kept\n');
    fs.writeFileSync(path.join(at.runDir, 'notes.md'), 'step 1\nanother attempt\n');

    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readFileSync(path.join(at.runDir, 'plan.md'), 'utf8')).toBe('step 2: test\n');
    expect(fs.readFileSync(path.join(at.runDir, 'other-attempt.md'), 'utf8')).toBe('kept\n');
    expect(fs.readFileSync(path.join(at.runDir, 'notes.md'), 'utf8')).toBe('step 1\nanother attempt\n');
  });

  it('keeps every run-directory path the step left alone: a hardlinked pair, and a link another step replaced meanwhile', async () => {
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    fs.mkdirSync(at.runDir, { recursive: true });
    fs.writeFileSync(path.join(at.runDir, 'a.md'), 'same\n');
    fs.linkSync(path.join(at.runDir, 'a.md'), path.join(at.runDir, 'b.md'));
    fs.symlinkSync('a.md', path.join(at.runDir, 'latest.md'));
    await openPlace(connection, at);
    fs.rmSync(path.join(at.runDir, 'latest.md'));
    fs.writeFileSync(path.join(at.runDir, 'latest.md'), 'another attempt\n');

    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readFileSync(path.join(at.runDir, 'a.md'), 'utf8')).toBe('same\n');
    expect(fs.readFileSync(path.join(at.runDir, 'b.md'), 'utf8')).toBe('same\n');
    expect(fs.readFileSync(path.join(at.runDir, 'latest.md'), 'utf8')).toBe('another attempt\n');
  });

  it('copies back a read-only directory the step made with its files in it, and deletes what the step deleted', async () => {
    fs.writeFileSync(path.join(imageDir, 'lock'), `#!${process.execPath}\nconst fs = require('node:fs'); fs.mkdirSync('locked'); fs.writeFileSync('locked/child.txt', 'kept'); fs.chmodSync('locked', 0o555); fs.rmSync('obsolete.txt');\n`, { mode: 0o755 });
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['lock'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readFileSync(path.join(at.worktree, 'locked', 'child.txt'), 'utf8')).toBe('kept');
    expect(fs.statSync(path.join(at.worktree, 'locked')).mode & 0o777).toBe(0o555);
    expect(fs.existsSync(path.join(at.worktree, 'obsolete.txt'))).toBe(false);
  });

  it('deletes at the next open a sandbox an earlier run left that no attempt here records, and keeps that open\'s own', async () => {
    const first = start();
    await init(first);
    const at = preparedPlace();
    expect((await openPlace(first, at)).ready).toMatchObject({ event: 'ready' });
    await first.end();
    const [left = ''] = sandboxNames();
    fs.rmSync(path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox', 'places'), { recursive: true, force: true });
    const second = start();
    await init(second);
    second.send({ type: 'open', op: newOp(), run: RUN, attempt: 'a00000002', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: {} } });
    await second.next((message) => message.event === 'ready' || message.event === 'failed', 30_000);

    await vi.waitFor(() => { expect(sandboxNames()).toEqual([left.replace(ATTEMPT, 'a00000002')]); }, { timeout: 10_000 });
  });

  it('never reuses a sandbox its place was not fully copied into: the next open of the attempt starts a new one, and collect deletes nothing', async () => {
    const fails = path.join(dir, 'tar.fails');
    fs.writeFileSync(path.join(imageDir, 'tar'), `#!/bin/sh\nif [ -f '${fails}' ]; then echo 'tar: connection reset' >&2; exit 1; fi\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(fails, '');
    const first = start();
    await init(first);
    const at = preparedPlace();

    expect((await openPlace(first, at)).ready).toMatchObject({ event: 'failed' });
    fs.rmSync(fails);
    const second = start();
    await init(second);

    expect((await openPlace(second, at)).ready).toMatchObject({ event: 'ready' });
    expect(await collect(second)).toMatchObject({ event: 'collected' });
    expect(fs.readFileSync(path.join(at.worktree, 'README.md'), 'utf8')).toBe('add(a, b) returns a - b.\n');
    expect(fs.readFileSync(path.join(at.worktree, 'obsolete.txt'), 'utf8')).toBe('old\n');
  });

  it('fails the open naming the copy that failed, even when the sandbox cannot be deleted either, and the next open deletes it', async () => {
    const fails = path.join(dir, 'tar.fails');
    fs.writeFileSync(path.join(imageDir, 'tar'), `#!/bin/sh\nif [ -f '${fails}' ]; then echo 'tar: connection reset' >&2; exit 1; fi\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(fails, '');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'delete.fails'), 'Vercel API: 503 Service Unavailable');
    const first = start();
    await init(first);
    const at = preparedPlace();
    const { ready } = await openPlace(first, at);
    const [left = ''] = sandboxNames();

    expect(ready).toMatchObject({ event: 'failed', failure: { message: expect.stringContaining('tar: connection reset') } });
    expect(String((ready.failure as Message).message)).toContain(`Vercel could not delete sandbox ${left}: Vercel API: 503 Service Unavailable`);
    fs.rmSync(fails);
    fs.rmSync(path.join(stateDir, 'delete.fails'));
    const second = start();
    await init(second);

    expect((await openPlace(second, at)).ready).toMatchObject({ event: 'ready' });
    expect(calls().filter((call) => call.call === 'delete')).toHaveLength(2);
    expect(sandboxNames()).toEqual([left]);
  });

  it('streams a last line that has no newline, once', async () => {
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);

    const { end, output } = await exec(connection, { argv: ['/bin/sh', '-c', "printf 'first\\nlast'"], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('first\nlast');
  });

  it('answers collect_failed, naming the sandbox, when Vercel no longer has it, and changes nothing on the host', async () => {
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);
    const [name = ''] = sandboxNames();
    execFileSync('chmod', ['-R', 'u+w', path.join(stateDir, 'sandboxes', name)]);
    fs.rmSync(path.join(stateDir, 'sandboxes', name), { recursive: true, force: true });

    expect(await collect(connection)).toMatchObject({ event: 'collect_failed', failure: { message: expect.stringContaining(name) } });
    expect(fs.readFileSync(path.join(at.worktree, 'obsolete.txt'), 'utf8')).toBe('old\n');
  });

  it('brings a symlink the step planted back as a link, and writes nothing through it or outside the place', async () => {
    fs.writeFileSync(path.join(imageDir, 'plant'), `#!${process.execPath}\nconst fs = require('node:fs'); fs.mkdirSync('../outside'); fs.symlinkSync('../outside', 'escape'); fs.writeFileSync('escape/through.txt', 'x');\n`, { mode: 0o755 });
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['plant'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    expect(await collect(connection)).toMatchObject({ event: 'collected' });
    expect(fs.readlinkSync(path.join(at.worktree, 'escape'))).toBe('../outside');
    expect(fs.existsSync(path.join(dir, 'outside'))).toBe(false);
  });

  it('fails the open on timeout, naming both times, when the lifetime ends before the attempt may, and creates nothing', async () => {
    const connection = start();
    await init(connection, { provider: 'vercel', timeout: '10m' });
    const at = preparedPlace();
    const op = newOp();
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, deadline, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    const failed = await connection.next((message) => message.op === op && message.event === 'failed', 30_000);

    expect(failed).toMatchObject({ failure: { code: 'bad_option', key: 'timeout' } });
    expect(String((failed.failure as Message).message)).toContain(deadline);
    expect(calls().filter((call) => call.call === 'create')).toEqual([]);
  });

  it.each([
    ['no timeout, and an attempt that may run past the 5h a Vercel sandbox lives', {}, 6 * 3_600_000],
    ['a timeout that ends with the attempt, leaving no time to copy its work back', { timeout: '1h' }, 3_600_000],
  ])('fails the open on timeout with %s, and creates nothing', async (_case, timeout, ms) => {
    const connection = start();
    await init(connection, { provider: 'vercel', ...timeout });
    const at = preparedPlace();
    const op = newOp();
    const deadline = new Date(Date.now() + ms).toISOString();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, deadline, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    const failed = await connection.next((message) => message.op === op && (message.event === 'failed' || message.event === 'ready'), 30_000);

    expect(failed).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'timeout' } });
    expect(String((failed.failure as Message).message)).toContain(deadline);
    expect(calls().filter((call) => call.call === 'create')).toEqual([]);
  });

  it('refuses a credential on this machine itself, which a hosted sandbox cannot reach, naming the variable', async () => {
    const connection = start();
    await init(connection);
    const { ready } = await openPlace(connection, preparedPlace(), { credentials: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } });

    expect(ready).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'credentials.ANTHROPIC_BASE_URL' } });
    expect(sandboxNames()).toEqual([]);
  });

  it('cancels a running step, then deletes the sandbox at close', async () => {
    fs.writeFileSync(path.join(imageDir, 'waits'), `#!${process.execPath}\nconsole.log('started'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const connection = start();
    await init(connection);
    const at = preparedPlace();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await connection.next((message) => message.op === op && message.event === 'output');
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed' && message.handle === HANDLE);

    expect(sandboxNames()).toEqual([]);
    expect(calls().filter((call) => call.call === 'delete')).toHaveLength(1);
  });

  it('reaches the sandbox by its name from a runtime started again: a cancel stops the step a killed runtime left, and close deletes it', async () => {
    fs.writeFileSync(path.join(imageDir, 'waits'), `#!${process.execPath}\nconsole.log('started'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const first = start();
    await init(first);
    const at = preparedPlace();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await first.next((message) => message.op === op && message.event === 'output');
    first.child.kill('SIGKILL');
    await first.end();

    const second = start();
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.handle === HANDLE && message.event === 'alive')).toMatchObject({ ops: [{ op, state: 'running' }] });
    await init(second);
    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
    second.send({ type: 'close', handle: HANDLE });
    await second.next((message) => message.event === 'closed' && message.handle === HANDLE);

    expect(sandboxNames()).toEqual([]);
  });
});

/** A prepare that fills a store in the sandbox's home from the lockfile, leaves node_modules, and lists its variables. */
const PREPARE = 'mkdir -p "$HOME/.store" node_modules && cksum package-lock.json > "$HOME/.store/index" && echo dep > node_modules/dep.js && env | cut -d= -f1 > "$HOME/.store/names"';

const WARM = { provider: 'vercel', runtime: 'node24', warm: { prepare: PREPARE, cache: ['package-lock.json'] } };

/** Opens attempt `attempt` of `at` and waits until it is ready, or failed. */
async function openAttempt(connection: Connection, at: Place, attempt: string): Promise<Message> {
  const op = newOp();
  connection.send({ type: 'open', op, run: RUN, attempt, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });

  return connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
}

/** A place whose worktree holds a lockfile. */
function lockedPlace(lock = 'lock v1\n'): Place {
  const at = preparedPlace();
  fs.writeFileSync(path.join(at.worktree, 'package-lock.json'), lock);

  return at;
}

const snapshotsDir = (): string => path.join(stateDir, 'snapshots');

function snapshotIds(): string[] {
  return fs.existsSync(snapshotsDir()) ? fs.readdirSync(snapshotsDir()) : [];
}

/** Every file a snapshot holds, as its path inside the sandbox. */
function filesOf(id: string): string[] {
  const root = path.join(snapshotsDir(), id, 'root');

  return entriesUnder(root).map(({ relative }) => relative).filter((file) => fs.lstatSync(path.join(root, file)).isFile()).map((file) => `/${file}`);
}

const CreateSchema = z.looseObject({ call: z.literal('create'), name: z.string(), source: z.object({ type: z.literal('snapshot'), snapshotId: z.string() }).optional() });

/** The sandboxes created for attempts, with the snapshot each started from. */
function attemptCreates(): Array<z.infer<typeof CreateSchema>> {
  return calls().flatMap((call) => { const created = CreateSchema.safeParse(call); return created.success && !created.data.name.includes('-warm-') ? [created.data] : []; });
}

describe('vercel: the warm snapshot', () => {
  it('prepares it in a scratch sandbox with no credential, keeps a store but no checkout file, node_modules or credential, and starts the attempt from it', async () => {
    const connection = start();
    await init(connection, WARM);
    const at = lockedPlace();

    expect(await openAttempt(connection, at, ATTEMPT)).toMatchObject({ event: 'ready' });
    const scratch = calls().find((call) => call.call === 'create' && String(call.name).includes('-warm-'));
    const [id = ''] = snapshotIds();

    expect(scratch).toMatchObject({ persistent: false, runtime: 'node24' });
    expect(calls().filter((call) => call.call === 'runCommand' && call.sandbox === scratch?.name).every((call) => Array.isArray(call.env) && call.env.length === 0)).toBe(true);
    expect(calls().filter((call) => call.call === 'snapshot')).toEqual([expect.objectContaining({ sandbox: scratch?.name, expiration: 30 * 24 * 3_600_000 })]);
    expect(snapshotIds()).toHaveLength(1);
    expect(filesOf(id)).toContain('/home/vercel-sandbox/.store/index');
    expect(filesOf(id).filter((file) => file.includes('node_modules') || file.endsWith('package-lock.json') || file.startsWith(at.worktree))).toEqual([]);
    expect(fs.readFileSync(path.join(snapshotsDir(), id, 'root', 'home/vercel-sandbox/.store/names'), 'utf8')).not.toMatch(/VERCEL_|CLAUDE_/);
    expect(filesOf(id).filter((file) => fs.readFileSync(path.join(snapshotsDir(), id, 'root', file), 'utf8').includes('vercel-token-value'))).toEqual([]);
    // The scratch sandbox goes once the snapshot is kept; the attempt's starts from it.
    expect(sandboxNames()).toEqual([expect.stringMatching(new RegExp(`-${RUN}-${ATTEMPT}$`))]);
    expect(attemptCreates()).toEqual([expect.objectContaining({ source: { type: 'snapshot', snapshotId: id } })]);
    expect(attemptCreates()[0]).not.toHaveProperty('runtime');
    expect(fs.existsSync(inSandbox(sandboxNames()[0] ?? '', '/home/vercel-sandbox/.store/index'))).toBe(true);
  });

  it('reuses the snapshot from a runtime started again while the lockfile is unchanged, and prepares a new one once it changes', async () => {
    const at = lockedPlace();
    const first = start();
    await init(first, { ...WARM, warm: { ...WARM.warm, expiration: '12h' } });

    expect(await openAttempt(first, at, 'a00000001')).toMatchObject({ event: 'ready' });
    await first.end();
    const second = start();
    await init(second, { ...WARM, warm: { ...WARM.warm, expiration: '12h' } });

    expect(await openAttempt(second, at, 'a00000002')).toMatchObject({ event: 'ready' });
    expect(calls().filter((call) => call.call === 'snapshot')).toEqual([expect.objectContaining({ expiration: 12 * 3_600_000 })]);
    fs.writeFileSync(path.join(at.worktree, 'package-lock.json'), 'lock v2\n');

    expect(await openAttempt(second, at, 'a00000003')).toMatchObject({ event: 'ready' });
    expect(snapshotIds()).toHaveLength(2);
    const [one, two, three] = attemptCreates().map((created) => created.source?.snapshotId);

    expect(two).toBe(one);
    expect(three).not.toBe(one);
    expect(three).toBeDefined();
  });

  it('builds one snapshot for two opens at once', async () => {
    const connection = start();
    await init(connection, WARM);
    const at = lockedPlace();
    const opened = await Promise.all([openAttempt(connection, at, 'a00000001'), openAttempt(connection, at, 'a00000002')]);

    expect(opened).toEqual([expect.objectContaining({ event: 'ready' }), expect.objectContaining({ event: 'ready' })]);
    expect(calls().filter((call) => call.call === 'snapshot')).toHaveLength(1);
    expect(new Set(attemptCreates().map((created) => created.source?.snapshotId)).size).toBe(1);
  });

  it.each([
    ['expired', (id: string) => fs.writeFileSync(path.join(snapshotsDir(), id, 'meta.json'), JSON.stringify({ expiresAt: Date.now() - 1_000 }))],
    ['gone', (id: string) => fs.rmSync(path.join(snapshotsDir(), id), { recursive: true, force: true })],
  ])('prepares the snapshot again once the kept one is %s', async (_case, lose) => {
    const at = lockedPlace();
    const first = start();
    await init(first, WARM);
    await openAttempt(first, at, 'a00000001');
    await first.end();
    const [kept = ''] = snapshotIds();
    lose(kept);
    const second = start();
    await init(second, WARM);

    expect(await openAttempt(second, at, 'a00000002')).toMatchObject({ event: 'ready' });
    expect(calls().filter((call) => call.call === 'snapshot')).toHaveLength(2);
    expect(attemptCreates().at(-1)?.source?.snapshotId).not.toBe(kept);
  });

  it('fails the open with the end of prepare\'s output when it fails, and leaves no sandbox', async () => {
    const connection = start();
    await init(connection, { ...WARM, warm: { prepare: 'echo "npm ERR! 404 left-pad" >&2; exit 3', cache: ['package-lock.json'] } });

    expect(await openAttempt(connection, lockedPlace(), ATTEMPT)).toMatchObject({ event: 'failed', failure: { code: 'sandbox_failed', message: expect.stringMatching(/code 3.*npm ERR! 404 left-pad/s) } });
    expect(sandboxNames()).toEqual([]);
    expect(snapshotIds()).toEqual([]);
  });

  it('fails the open on timeout before it prepares a snapshot, when the lifetime ends before the attempt may', async () => {
    const connection = start();
    await init(connection, { ...WARM, timeout: '10m' });
    const at = lockedPlace();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, deadline: new Date(Date.now() + 3_600_000).toISOString(), credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });

    expect(await connection.next((message) => message.op === op && (message.event === 'failed' || message.event === 'ready'), 30_000)).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'timeout' } });
    expect(calls().filter((call) => call.call === 'create')).toEqual([]);
  });

  it('fails the open bad_option on warm.cache when a cache file links out of the checkout, and creates nothing', async () => {
    const connection = start();
    await init(connection, WARM);
    const at = preparedPlace();
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside\n');
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(at.worktree, 'package-lock.json'));

    expect(await openAttempt(connection, at, ATTEMPT)).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'warm.cache' } });
    expect(calls().filter((call) => call.call === 'create')).toEqual([]);
  });

  it('deletes at the next open the scratch sandbox of a build whose runtime was killed', async () => {
    const block = path.join(dir, 'block');
    fs.writeFileSync(block, '');
    const first = start();
    await init(first, { ...WARM, warm: { prepare: `while [ -f '${block}' ]; do sleep 0.1; done`, cache: ['package-lock.json'] } });
    const at = lockedPlace();
    first.send({ type: 'open', op: newOp(), run: RUN, attempt: 'a00000001', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: {} } });
    await vi.waitFor(() => { expect(calls().some((call) => call.call === 'runCommand' && call.cmd === 'sh' && String(call.sandbox).includes('-warm-'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second);

    expect(await openAttempt(second, at, 'a00000002')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(sandboxNames().filter((name) => name.includes('-warm-'))).toEqual([]); }, { timeout: 10_000 });
  });
});

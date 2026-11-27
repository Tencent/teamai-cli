import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleRuntime, tempDir, type Connection, type Message } from '../testing/harness.js';
import { exec, failStandIn, HANDLE, init, nativeHost, openPlace, placeIn, startOn, type NativeHost } from '../testing/native-harness.js';
import { closeLeftovers, expectNothingLeft } from '../testing/leaks.js';

// The bwrap provider through the runtime's stdio entry point, on a stand-in bwrap that records its argv and runs the
// command. Only a Linux host proves what the namespaces hide; this one proves what the runtime asks bwrap for.

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

/** The `[flag, at]` binds of the last bwrap that ran a step, in order, and the command after `--`. */
function lastSandbox(): { binds: Array<[string, string]>; options: string[]; command: string[] } {
  const call = host.calls().findLast(([name, ...args]) => name === 'bwrap' && args.includes('--chdir')) ?? [];
  const end = call.indexOf('--');
  const args = call.slice(1, end);
  const binds: Array<[string, string]> = [];

  for (const [index, flag] of args.entries()) if (['--bind', '--ro-bind-try', '--ro-bind'].includes(flag)) binds.push([flag, args[index + 1] ?? '']);

  return { binds, options: args, command: call.slice(end + 1) };
}

describe('bwrap: init', () => {
  it("offers the tools on this machine that sign in, at isolation worktree, and never unattended, as a step shares this machine's loopback", async () => {
    const reply = await init(start(), { provider: 'bwrap' }, { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'worktree', env: true, setup: true, tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('unattended');
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('fails sandbox_unavailable naming how to install it when bwrap is missing, and runs nothing', async () => {
    fs.rmSync(path.join(host.fakes, 'bwrap'));
    fs.writeFileSync(path.join(host.dir, 'os-release'), 'ID=debian\n');
    // Without /usr/bin, where a Linux machine that has bwrap keeps it.
    const reply = await init(start({ PATH: [host.fakes, host.tools].join(path.delimiter), SANDBOX_TEST_OS_RELEASE: path.join(host.dir, 'os-release') }), { provider: 'bwrap' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(String((reply.error as Message).message)).toContain('sudo apt install bubblewrap');
  });

  /** init's message on a machine whose os-release reads `osRelease` and that has no bwrap. */
  async function missingOn(osRelease: string): Promise<string> {
    fs.rmSync(path.join(host.fakes, 'bwrap'));
    const file = path.join(host.dir, 'os-release');
    fs.writeFileSync(file, osRelease);
    const reply = await init(start({ PATH: [host.fakes, host.tools].join(path.delimiter), SANDBOX_TEST_OS_RELEASE: file }), { provider: 'bwrap' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });

    return String((reply.error as Message).message);
  }

  it.each([
    ['Fedora', 'NAME="Fedora Linux"\nID=fedora\n', 'sudo dnf install bubblewrap'],
    ['Arch', 'ID=arch\n', 'sudo pacman -S bubblewrap'],
    ['Alpine', 'ID=alpine\n', 'sudo apk add bubblewrap'],
    ['openSUSE', 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', 'sudo zypper install bubblewrap'],
    ['Linux Mint, by the distribution it is like', 'ID=linuxmint\nID_LIKE="ubuntu debian"\n', 'sudo apt install bubblewrap'],
  ])('names the one command that installs bwrap on %s', async (_distro, osRelease, command) => {
    const message = await missingOn(osRelease);

    expect(message).toContain(command);
    expect(['sudo apt install', 'sudo dnf install', 'sudo pacman -S', 'sudo apk add', 'sudo zypper install'].filter((install) => message.includes(install))).toHaveLength(1);
  });

  it('names the command of each distribution it knows when it does not know this one', async () => {
    const message = await missingOn('ID=nixos\n');

    for (const command of ['sudo apt install bubblewrap', 'sudo dnf install bubblewrap', 'sudo pacman -S bubblewrap', 'sudo apk add bubblewrap', 'sudo zypper install bubblewrap']) expect(message).toContain(command);
  });

  it('fails sandbox_unavailable naming the AppArmor fix when the kernel refuses its namespaces', async () => {
    failStandIn(host, 'bwrap', 'bwrap: setting up uid map: Permission denied');
    const reply = await init(start(), { provider: 'bwrap' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    const { message } = reply.error as { message: string };

    expect(message).toContain('setting up uid map: Permission denied');
    expect(message).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  });

  it('takes no option but provider', async () => {
    expect(await init(start(), { provider: 'bwrap', warm: { prepare: 'npm ci' } })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'warm' } });
  });
});

describe('bwrap: a step', () => {
  it("binds the place at its host paths, the git paths and this machine's tools read only, and never the member's home", async () => {
    const connection = start();
    await init(connection, { provider: 'bwrap' }, { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });
    const at = placeIn(host.dir);
    const { ready } = await openPlace(connection, at, { tool: 'claude' });

    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (bwrap)` } });

    const { end, output } = await exec(connection, { argv: ['claude', '-p', 'Review it.'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'step-token' }, env: { CLAUDE_CONFIG_DIR: at.toolHome }, unset: ['GITHUB_TOKEN'], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('reviewed\n');
    const { binds, options, command } = lastSandbox();
    const real = (file: string): string => fs.realpathSync(file);

    expect(command).toEqual(['claude', '-p', 'Review it.']);
    expect(options).toEqual(expect.arrayContaining(['--unshare-all', '--share-net', '--die-with-parent']));
    // A step started on no terminal needs no session of its own, and its group's kill reaches bwrap's init however early.
    expect(options).not.toContain('--new-session');
    expect(binds).toEqual(expect.arrayContaining([['--bind', real(at.worktree)], ['--bind', real(at.result)], ['--bind', real(at.toolHome)], ['--bind', real(at.runDir)], ['--ro-bind-try', real(at.git)], ['--ro-bind-try', real(host.tools)]]));
    expect(binds.map(([, bound]) => bound)).not.toContain(real(host.home));
    // A deeper bind comes after the one it sits in, so it wins.
    const depths = binds.map(([, bound]) => bound.split('/').length);

    expect(depths).toEqual([...depths].sort((left, right) => left - right));
    expect(JSON.stringify(host.calls())).not.toContain('step-token');
  });

  it("gives the step a home and temp directory of its own, the exec's credentials, and none of the runtime's other variables", async () => {
    host.tool('env-names', "console.log(JSON.stringify({ names: Object.keys(process.env).sort(), home: process.env.HOME, tmp: process.env.TMPDIR, token: process.env.CLAUDE_CODE_OAUTH_TOKEN === 'step-token' }))");
    const connection = start({ MEMBER_SECRET: 'member-only', GITHUB_TOKEN: 'forge' });
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);

    const { output } = await exec(connection, { argv: ['env-names'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'step-token' }, unset: ['GITHUB_TOKEN'], cwd: at.worktree });
    const seen = JSON.parse(output) as { names: string[]; home: string; tmp: string; token: boolean };
    const own = path.join(fs.realpathSync(host.home), '.teamai', 'runtime-state', 'sandbox', 'bwrap', HANDLE);

    expect(seen.names).not.toContain('MEMBER_SECRET');
    expect(seen.names).not.toContain('GITHUB_TOKEN');
    expect(seen).toMatchObject({ home: path.join(own, 'home'), tmp: path.join(own, 'tmp'), token: true });
  });

  it('anchors only the folders above a git path, so a tool directory on PATH inside the worktree leaves its folders removable', async () => {
    const at = placeIn(host.dir);
    const bin = path.join(at.worktree, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    const connection = start({ PATH: [host.fakes, bin, host.tools, '/usr/bin', '/bin'].join(path.delimiter) });
    await init(connection, { provider: 'bwrap' });
    await openPlace(connection, at);

    await exec(connection, { argv: ['/bin/sh', '-c', 'true'], cwd: at.worktree });

    expect(lastSandbox().binds).not.toContainEqual(['--bind', fs.realpathSync(path.join(at.worktree, 'node_modules'))]);
  });

  it("points Claude Code's own temp directory at the step's, which it writes instead of TMPDIR", async () => {
    host.tool('claude-tmp', 'console.log(process.env.CLAUDE_CODE_TMPDIR)');
    const connection = start();
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);

    const { output } = await exec(connection, { argv: ['claude-tmp'], cwd: at.worktree });

    expect(output).toBe(`${path.join(fs.realpathSync(host.home), '.teamai', 'runtime-state', 'sandbox', 'bwrap', HANDLE, 'tmp')}\n`);
  });

  it('cancels a running step by ending its process group', async () => {
    host.tool('waits', "console.log('started'); setInterval(() => {}, 1000);");
    const connection = start();
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    await openPlace(connection, at);
    const op = 'op-0000beef';
    connection.send({ type: 'exec', op, handle: HANDLE, argv: ['waits'], env: {}, unset: [], credentials: {}, cwd: at.worktree });
    await connection.next((message) => message.op === op && message.event === 'output');
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toMatchObject({ event: 'cancelled' });
  });

  it('passes a URL on this machine to the step at its loopback, as the step shares its network', async () => {
    host.tool('base-url', 'console.log(new URL(process.env.ANTHROPIC_BASE_URL).host)');
    const connection = start();
    await init(connection, { provider: 'bwrap' });
    const at = placeIn(host.dir);
    const { ready } = await openPlace(connection, at, { credentials: { ANTHROPIC_BASE_URL: 'http://localhost:8317/anthropic' } });

    expect(ready).toMatchObject({ event: 'ready' });
    const { end, output } = await exec(connection, { argv: ['base-url'], credentials: { ANTHROPIC_BASE_URL: 'http://localhost:8317/anthropic' }, cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output.trim()).toBe('127.0.0.1:8317');
  });
});

describe('bwrap: never the outer of an app runtime', () => {
  it("opens a place for a tool with no attempt socket, as a step shares this machine's loopback", async () => {
    const connection = start();
    await init(connection, { provider: 'bwrap' }, { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });
    const { accepted } = await openPlace(connection, placeIn(host.dir), { tool: 'claude' });

    expect(accepted.handle).toBe(HANDLE);
  });
});

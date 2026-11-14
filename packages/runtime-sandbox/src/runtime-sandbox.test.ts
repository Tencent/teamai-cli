import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { EXITED_STDOUT_CHARS, STDOUT_CUT, UNAVAILABLE_REASON_MAX, type InitCredentials, type InitInstance } from '@teamai/runtime-protocol';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from './testing/harness.js';
import { closeLeftovers, expectNothingLeft } from './testing/leaks.js';
import { signalPid } from '@teamai/shared/process-group';
import { entriesUnder } from '@teamai/shared/entries-under';

// The runtime through its stdio entry point, as teamai spawns it, on a fake docker / podman (testing/fake-engine.mjs).

const IMAGE = 'ghcr.io/acme/agent:1';
/** The teamai-cli checkout, whose drivers/ holds the definitions teamai ships. */
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLAUDE = "if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)')";

let executable: string;
let dir: string;
let engine: FakeEngine;
const open: Connection[] = [];
/** What a test planted itself, which the leak check after it allows. */
const plantedLeft: string[] = [];

const planted = (...names: string[]): void => { plantedLeft.push(...names); };

beforeAll(async () => {
  executable = await bundleRuntime(tempDir());
}, 60_000);

beforeEach(() => {
  dir = tempDir();
  engine = fakeEngine(dir);
  engine.image(IMAGE, { claude: CLAUDE });
  fs.mkdirSync(path.join(dir, 'home'));
});

afterEach(async () => {
  const connections = open.splice(0);
  await Promise.all(connections.map((connection) => connection.end()));
  engine.repair();
  const { invalid, recovered } = await closeLeftovers(connections);

  // Every line the runtime wrote is one runtime protocol 1 allows.
  expect([...connections.flatMap((connection) => connection.invalid), ...invalid]).toEqual([]);
  await expectNothingLeft({ connections: [...connections, ...recovered], dir, containers: engine.containers, planted: plantedLeft.splice(0) });
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(extra: NodeJS.ProcessEnv = {}): Connection {
  const connection = connect(executable, { ...engine.env(), HOME: path.join(dir, 'home'), ...extra });
  open.push(connection);

  return connection;
}

async function init(connection: Connection, options: Message, mode = 'unattended', credentials?: InitCredentials, instances?: Message[]): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, homeEnv: {}, mode, options, ...(credentials && { credentials }), ...(instances && { instances }) });

  return connection.next((message) => message.type === 'init', 30_000);
}

describe('init', () => {
  it('fails on an option it does not take, naming the key', async () => {
    expect(await init(start(), { provider: 'docker', image: IMAGE, imgae: 'x' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'imgae' } });
  });

  it('names a misspelled key rather than the key it replaced', async () => {
    expect(await init(start(), { provider: 'docker', imgae: IMAGE })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'imgae' } });
  });

  it('fails on a provider this version does not run, naming the ones it does', async () => {
    const reply = await init(start(), { provider: 'firecracker' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'provider' } });
    expect(JSON.stringify(reply)).toMatch(/sbx.*docker.*podman/);
  });

  it('fails without an image', async () => {
    expect(await init(start(), { provider: 'podman' })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'image' } });
  });

  it('fails with sandbox_unavailable and the command that fixes it when the engine is not running, and never offers the host', async () => {
    engine.daemon(false);
    const reply = await init(start(), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toMatch(/Docker Desktop|systemctl start docker/);
  });

  it('fails sandbox_unavailable on Windows for every provider, naming WSL2 and the local driver, and runs no engine', async () => {
    const everyProvider: Message[] = [{ provider: 'docker', image: IMAGE }, { provider: 'podman', image: IMAGE }, { provider: 'sbx' }, { provider: 'seatbelt' }, { provider: 'bwrap' }, { provider: 'vercel' }];

    for (const options of everyProvider) {
      const reply = await init(start({ SANDBOX_TEST_PLATFORM: 'win32' }), options);

      expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
      expect(String((reply.error as Message).message)).toMatch(/WSL2.*--driver local/s);
    }

    expect(engine.calls()).toEqual([]);
  });

  it('fails with sandbox_unavailable when the engine is not installed', async () => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const reply = await init(start({ PATH: empty }), { provider: 'podman', image: IMAGE });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toContain('podman');
  });

  it('fails when the image cannot be pulled, naming it', async () => {
    const reply = await init(start(), { provider: 'docker', image: 'ghcr.io/acme/missing:1' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toContain('ghcr.io/acme/missing:1');
  });

  it('starts with no tool and names CLAUDE_CODE_OAUTH_TOKEN for Claude when it has only a login on this machine, which never crosses into a container', async () => {
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env: [], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { tools: [] } });
    const reason = String((reply.unavailable as Message).claude);

    expect(reason).toContain('Keychain');
    expect(reason).toContain('`claude setup-token`');
    expect(reason).toContain('CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('offers only the tools of the image that a credential or a login teamai gives signs in, and says why it leaves out the others', async () => {
    engine.image(IMAGE, { claude: CLAUDE, codex: SBX_CODEX });
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude'] }, unavailable: { codex: expect.stringContaining('CODEX_HOME=~/.teamai/logins/codex codex login') } });
    expect(Object.keys(reply.unavailable as Message)).toEqual(['codex']);
    // A container keeps no login of its own, so every sign-in teamai found goes to it.
    expect(reply).not.toHaveProperty('ownLogins');
  });

  it('offers a sandbox with the tools the image holds on docker with node in the image, which runs the network filter, and declares no network', async () => {
    engine.image(IMAGE, { claude: CLAUDE, node: '' });
    const reply = await init(start(), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('hitl');
  });

  it.runIf(process.platform === 'linux')('offers a sandbox on Docker Engine on this Linux machine, whose addresses the filter refuses', async () => {
    engine.image(IMAGE, { claude: CLAUDE, node: '' });
    const reply = await init(start({ FAKE_ENGINE_OS: 'Ubuntu 24.04.1 LTS', FAKE_ENGINE_HOST: os.hostname() }), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', unattended: true } });
  });

  // Without the filter, a step's container reaches every port of this machine (host.docker.internal), so it is no sandbox.
  it.each<{ label: string; options: Message; tools: Record<string, string>; env?: NodeJS.ProcessEnv }>([
    { label: 'docker with no node in the image', options: { provider: 'docker', image: IMAGE }, tools: { claude: CLAUDE } },
    { label: 'podman, whose rootless network cannot connect the filter', options: { provider: 'podman', image: IMAGE }, tools: { claude: CLAUDE, node: '' } },
    {
      label: 'docker in a VM of its own, as Colima or Rancher Desktop runs it, whose address for this machine the filter does not know',
      options: { provider: 'docker', image: IMAGE },
      tools: { claude: CLAUDE, node: '' },
      env: { FAKE_ENGINE_OS: 'Ubuntu 24.04.1 LTS', FAKE_ENGINE_HOST: 'colima' },
    },
  ])('offers isolation worktree, no unattended step and no attempt socket on $label', async ({ options, tools, env }) => {
    engine.image(IMAGE, tools);
    const connection = start(env);
    const reply = await init(connection, options);
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'claude', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    const accepted = await connection.next((message) => message.op === op && message.event === 'accepted');

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'worktree', tools: ['claude'] } });
    expect(reply.can).not.toHaveProperty('unattended');
    expect(accepted.handle).toBe(HANDLE);
  });
});

describe('how teamai starts it', () => {
  it('serves nothing when teamai did not start it: with no TEAMAI_RUNTIME_PROTOCOL it reads no request and exits 2, naming the variable', () => {
    const request = { type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options: { provider: 'docker', image: IMAGE } };
    const ran = spawnSync(process.execPath, [executable], { env: { ...engine.env(), HOME: path.join(dir, 'home') }, input: `${JSON.stringify(request)}\n`, encoding: 'utf8', timeout: 20_000 });

    expect(ran.status).toBe(2);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('TEAMAI_RUNTIME_PROTOCOL=1');
    expect(engine.calls()).toEqual([]);
  });

  it('leaves the variable teamai starts it with out of what it starts, so an engine command it runs never serves runtime protocol 1', async () => {
    const seen = path.join(dir, 'seen-by-docker');
    const shim = path.join(dir, 'shim-bin');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'docker'), `#!/bin/sh\necho "\${TEAMAI_RUNTIME_PROTOCOL-unset}" >> "${seen}"\nexec "${path.join(engine.bin, 'docker')}" "$@"\n`, { mode: 0o755 });

    expect(await init(start({ PATH: `${shim}${path.delimiter}${String(engine.env().PATH)}` }), { provider: 'docker', image: IMAGE })).toMatchObject({ ok: true });
    expect([...new Set(fs.readFileSync(seen, 'utf8').trim().split('\n'))]).toEqual(['unset']);
  });
});

/** A team's Claude instance: its own command, and its own home under its own variable. */
const ACME_CLAUDE = { name: 'acme-claude', tool: 'claude', command: 'acme-claude', home: { dir: '.acme-claude' } } satisfies InitInstance;

/** An instance's command that writes into its own home, so a test sees where it ran and with which home. */
const ACME_CLAUDE_COMMAND = "const fs = require('node:fs'); fs.writeFileSync(`${process.env.ACME_CLAUDE_CONFIG_DIR}/ran`, 'acme-claude'); console.log('reviewed');";

describe('the tool instances teamai passes at init', () => {
  it('offers an instance whose command the image holds and whose tool signs in, and says why it leaves out one whose command the image lacks', async () => {
    engine.image(IMAGE, { claude: CLAUDE, 'acme-claude': ACME_CLAUDE_COMMAND });
    const instances = [ACME_CLAUDE, { name: 'acme-review', tool: 'claude', command: 'acme-review' }, { name: 'acme-codex', tool: 'codex', command: 'acme-codex' }] satisfies InitInstance[];
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] }, instances);

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'acme-claude'] }, unavailable: { 'acme-codex': expect.stringContaining('acme-codex, an instance of codex, cannot sign in') } });
    expect(Object.keys(reply.unavailable as Message)).toEqual(['acme-review', 'acme-codex']);
    expect(String((reply.unavailable as Message)['acme-review'])).toBe(`acme-review runs acme-review, which is not in image ${IMAGE}: add it to the image, or run the step with --driver local.`);
  });

  it("leaves out an instance whose tool cannot sign in, with that tool's sign-in", async () => {
    engine.image(IMAGE, { claude: CLAUDE, 'acme-claude': ACME_CLAUDE_COMMAND });
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env: [], logins: [] }, [ACME_CLAUDE]);

    expect(reply).toMatchObject({ ok: true, can: { tools: [] }, unavailable: { 'acme-claude': expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN') } });
  });

  it("runs the instance's command in the container with its home variable at the attempt's tool home", async () => {
    engine.image(IMAGE, { claude: CLAUDE, 'acme-claude': ACME_CLAUDE_COMMAND });
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE }, 'unattended', { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] }, [ACME_CLAUDE]);
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'claude', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { ACME_CLAUDE_CONFIG_DIR: at.toolHome } } });
    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });

    expect((await exec(connection, { argv: ['acme-claude', '-p', 'Review it.'], env: { ACME_CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: 'reviewed\n' });
    expect(fs.readFileSync(path.join(at.toolHome, 'ran'), 'utf8')).toBe('acme-claude');
  });

  it('cuts a reason longer than protocol 1 takes to fit, marking the cut, so init still answers', async () => {
    const name = `acme-${'x'.repeat(300)}`;
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] }, [{ name, tool: 'claude', command: name }]);
    const reason = String((reply.unavailable as Message)[name]);

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude'] } });
    expect(reason).toHaveLength(UNAVAILABLE_REASON_MAX);
    expect(reason.endsWith('…')).toBe(true);
  });

  it("offers an instance whose command the image holds without its tool's own executable, and says why one that runs that executable cannot run", async () => {
    const wrapperOnly = 'ghcr.io/acme/wrapper:1';
    engine.image(wrapperOnly, { 'acme-claude': ACME_CLAUDE_COMMAND });
    const reply = await init(start(), { provider: 'docker', image: wrapperOnly }, 'unattended', { env: ['ANTHROPIC_API_KEY'], logins: [] }, [ACME_CLAUDE, { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' } }]);

    expect(reply).toMatchObject({ ok: true, can: { tools: ['acme-claude'] }, unavailable: { 'claude-work': expect.stringContaining(`claude-work runs claude, which is not in image ${wrapperOnly}`) } });
  });

  it('offers an instance with no command of its own wherever its tool is offered', async () => {
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env: ['ANTHROPIC_API_KEY'], logins: [] }, [{ name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' } }]);

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'claude-work'] } });
    expect(reply).not.toHaveProperty('unavailable');
  });
});

const RUN = 'r0123abcd';
const ATTEMPT = 'a0123abcd';
const HANDLE = `teamai-${RUN}-${ATTEMPT}`;
let opCount = 0;

function newOp(): string {
  opCount += 1;

  return `op-${opCount.toString(16).padStart(8, '0')}`;
}

interface Place {
  worktree: string;
  git: string;
  result: string;
  runDir: string;
  toolHome: string;
}

function place(): Place {
  const at = { worktree: path.join(dir, 'worktree'), git: path.join(dir, 'repo.git'), result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: path.join(dir, 'runs', RUN, 'scratch'), toolHome: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') };
  fs.mkdirSync(at.worktree, { recursive: true });
  fs.mkdirSync(at.git, { recursive: true });

  return at;
}

/** Opens the attempt's place, with its tool home, and the credentials teamai sends on `open`. */
async function openPlace(connection: Connection, at: Place, op = newOp(), { credentials = {} }: { credentials?: Record<string, string> } = {}): Promise<{ accepted: Message; ready: Message }> {
  connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
  const accepted = await connection.next((message) => message.op === op && message.event === 'accepted');
  const ready = await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);

  return { accepted, ready };
}

/** Every file the runtime's journal holds. */
function journalFiles(): string[] {
  const journal = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox');

  return entriesUnder(journal).map(({ relative }) => path.join(journal, relative)).filter((file) => fs.statSync(file).isFile());
}

async function exec(connection: Connection, request: { argv: string[]; env?: Record<string, string>; unset?: string[]; credentials?: Record<string, string>; cwd: string }, op = newOp()): Promise<{ end: Message; output: string }> {
  connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, ...request });
  const end = await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000);
  const output = connection.messages.filter((message) => message.op === op && message.event === 'output' && message.stream === 'stdout').map((message) => String(message.data)).join('');

  return { end, output };
}

describe('a prompt attempt in a container', () => {
  it('opens one container per attempt with the place view, the run directory included, at its host paths, as the member, and shows it in the dashboard', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const { accepted, ready } = await openPlace(connection, at);

    expect(accepted.handle).toBe(HANDLE);
    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (docker)`, fields: { container: HANDLE, image: IMAGE } } });
    // A new open of the same attempt finds that container instead of creating a second.
    expect((await openPlace(connection, at)).accepted.handle).toBe(HANDLE);
    expect(engine.containers()).toEqual([HANDLE]);

    const run = engine.calls().find(([, command, detached]) => command === 'run' && detached === '-d') ?? [];
    const joined = run.join(' ');

    expect(joined).toContain(`--label teamai.run=${RUN} --label teamai.attempt=${ATTEMPT}`);
    expect(joined).toContain(`--user ${process.getuid?.()}:${process.getgid?.()}`);
    expect(run).toEqual(expect.arrayContaining([`${at.worktree}:${at.worktree}:rw`, `${at.result}:${at.result}:rw`, `${at.toolHome}:${at.toolHome}:rw`, `${at.runDir}:${at.runDir}:rw`, `${at.git}:${at.git}:ro`]));
    // The tool home exists on the host before the engine mounts it, so the member owns it.
    expect(fs.existsSync(at.toolHome)).toBe(true);
  });

  it.each(['docker', 'sbx'])("opens a clone or team workspace on %s at its host path, its own .git read-only there, and the step's work is on the host with nothing to copy back", async (provider) => {
    engine.image('claude', { claude: CLAUDE });
    const connection = start();
    await init(connection, provider === 'sbx' ? { provider, agent: 'claude' } : { provider, image: IMAGE });
    // A clone teamai prepared holds its own git directory, which the view names read-only.
    const clone = path.join(dir, 'clones', RUN, 'review');
    const at = { ...place(), worktree: clone, git: path.join(clone, '.git') };
    fs.mkdirSync(at.git, { recursive: true });

    expect((await openPlace(connection, at)).ready).toMatchObject({ event: 'ready' });
    const create = engine.calls().find(([name, command, detached]) => name === provider && (command === 'create' || (command === 'run' && detached === '-d'))) ?? [];

    expect(create).toEqual(expect.arrayContaining(provider === 'sbx' ? [clone, `${at.git}:ro`] : [`${clone}:${clone}:rw`, `${at.git}:${at.git}:ro`]));
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo reviewed > NOTES.md'], cwd: clone })).end).toMatchObject({ event: 'exited', code: 0 });
    connection.send({ type: 'collect', handle: HANDLE });
    await connection.next((message) => message.event === 'collected');

    expect(fs.readFileSync(path.join(clone, 'NOTES.md'), 'utf8')).toBe('reviewed\n');
  });

  it('maps the member with keep-id on podman', async () => {
    const connection = start();
    await init(connection, { provider: 'podman', image: IMAGE });
    const { ready } = await openPlace(connection, place());

    expect(ready).toMatchObject({ event: 'ready', display: { label: `${HANDLE} (podman)` } });
    expect(engine.calls().find(([name, command, detached]) => name === 'podman' && command === 'run' && detached === '-d')?.join(' ')).toContain('--userns keep-id');
  });

  it.each<{ engine: string; os: string; alias: string }>([
    { engine: 'docker', os: 'Docker Desktop', alias: 'host.docker.internal' },
    { engine: 'podman', os: 'Docker Desktop', alias: 'host.containers.internal' },
  ])("gives a step a base URL on this machine itself as $engine's host alias, port and path kept", async ({ engine: provider, alias }) => {
    const connection = start();
    await init(connection, { provider, image: IMAGE });
    const at = place();
    const credentials = { ANTHROPIC_API_KEY: 'step-key', ANTHROPIC_BASE_URL: 'http://localhost:4000/v1' };

    expect((await openPlace(connection, at, newOp(), { credentials })).ready).toMatchObject({ event: 'ready' });
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'printf %s "$ANTHROPIC_BASE_URL" > base-url.txt'], credentials, cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    expect(fs.readFileSync(path.join(at.worktree, 'base-url.txt'), 'utf8')).toBe(`http://${alias}:4000/v1`);
  });

  it("masks a base URL on this machine itself as the step got it, in what the step prints, since teamai masks only the value it gave", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const credentials = { ANTHROPIC_API_KEY: 'step-key', ANTHROPIC_BASE_URL: 'http://member:gateway-secret-1@localhost:4000/v1' };

    expect((await openPlace(connection, at, newOp(), { credentials })).ready).toMatchObject({ event: 'ready' });
    const ran = await exec(connection, { argv: ['/bin/sh', '-c', 'echo "calling $ANTHROPIC_BASE_URL"; echo "failed: $ANTHROPIC_BASE_URL" >&2'], credentials, cwd: at.worktree });

    expect(ran.end).toMatchObject({ event: 'exited', code: 0 });
    // Every line it wrote to teamai: both streams as they came, and the stdout it ended with.
    expect(JSON.stringify(connection.messages)).not.toContain('gateway-secret-1');
    expect(ran.output).toContain('calling <REDACTED:');
  });

  it('streams the stdout it ends an exec with, masking a base URL on this machine that the step printed in two writes in both', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const credentials = { ANTHROPIC_API_KEY: 'step-key', ANTHROPIC_BASE_URL: 'http://member:gateway-secret-1@localhost:4000/v1' };

    expect((await openPlace(connection, at, newOp(), { credentials })).ready).toMatchObject({ event: 'ready' });
    const ran = await exec(connection, { argv: ['/bin/sh', '-c', 'printf %s "${ANTHROPIC_BASE_URL%%gateway*}"; sleep 0.3; printf "%s\\n" "gateway${ANTHROPIC_BASE_URL#*gateway}"'], credentials, cwd: at.worktree });

    expect(ran.end).toMatchObject({ event: 'exited', code: 0 });
    expect(ran.output).toBe(ran.end.stdout);
    expect(JSON.stringify(connection.messages)).not.toContain('gateway-secret-1');
  });

  it('masks a base URL whose start is another base URL, when the step printed that start in a write of its own', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const credentials = { ANTHROPIC_BASE_URL: 'http://localhost:4000', OPENAI_BASE_URL: 'http://localhost:4000/v1?key=gateway-secret-2' };

    expect((await openPlace(connection, at, newOp(), { credentials })).ready).toMatchObject({ event: 'ready' });
    const ran = await exec(connection, { argv: ['/bin/sh', '-c', 'printf %s "$ANTHROPIC_BASE_URL"; sleep 0.3; printf "%s\\n" "${OPENAI_BASE_URL#"$ANTHROPIC_BASE_URL"}"'], credentials, cwd: at.worktree });

    expect(ran.end).toMatchObject({ event: 'exited', code: 0 });
    expect(ran.output).toBe(ran.end.stdout);
    expect(JSON.stringify(connection.messages)).not.toContain('gateway-secret-2');
  });

  it('ends an exec that prints past protocol 1\'s bound with the end of what it streamed, marked as cut, and reattaches with the same', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const ran = await exec(connection, { argv: [process.execPath, '-e', 'process.stdout.write("start" + "x".repeat(100000) + "end")'], cwd: at.worktree });
    const stdout = String(ran.end.stdout);

    expect(ran.output).toBe(`start${'x'.repeat(100_000)}end`);
    expect(stdout).toBe(`${STDOUT_CUT}${ran.output.slice(-EXITED_STDOUT_CHARS)}`);
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'alive')).toMatchObject({ ops: [{ op: ran.end.op, state: 'exited', code: 0, stdout }] });
  });

  it('answers a resent exec and a reattach with its stdout marked as cut, once the journal masked a credential at its end', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const key = `secret-${'k'.repeat(93)}`;
    const op = newOp();
    const request = { argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(100000) + process.env.API_KEY)'], credentials: { API_KEY: key }, cwd: at.worktree };
    await exec(connection, request, op);
    const before = connection.messages.length;
    const resent = await exec(connection, request, op);

    expect(connection.messages.indexOf(resent.end)).toBeGreaterThanOrEqual(before);
    expect(resent.end).toMatchObject({ event: 'exited', code: 0 });
    expect(String(resent.end.stdout).slice(0, STDOUT_CUT.length)).toBe(STDOUT_CUT);
    expect(String(resent.end.stdout)).not.toContain(key);
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'alive')).toMatchObject({ ops: [{ op, state: 'exited', stdout: resent.end.stdout }] });
  });

  it("refuses a step whose base URL points at this machine itself on Docker on Linux, before it creates the container, naming the variable and never its value", async () => {
    const connection = start({ FAKE_ENGINE_OS: 'Ubuntu 24.04.1 LTS' });
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { ANTHROPIC_API_KEY: 'step-key', ANTHROPIC_BASE_URL: 'http://localhost:4000' }, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    const failed = await connection.next((message) => message.op === op && (message.event === 'failed' || message.event === 'ready'));

    expect(failed).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'credentials.ANTHROPIC_BASE_URL' } });
    expect(JSON.stringify(failed)).not.toContain('localhost');
    expect(engine.containers()).toEqual([]);
  });

  it("runs the image's tool, not the host's", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);

    expect(await exec(connection, { argv: ['claude', '--version'], cwd: at.worktree })).toMatchObject({ end: { event: 'exited', code: 0, stdout: '2.1.0 (Claude Code)\n' }, output: '2.1.0 (Claude Code)\n' });
  });

  it("gives an exec its names and the credentials it brings, never a value in an argv, on disk, nor any other name of teamai's environment", async () => {
    const connection = start({ GITHUB_TOKEN: 'forge-value-1' });
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const credentials = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' };
    // Says whether each name is set, and whether the token is the one teamai gave, never a credential's value. The
    // glob matches that value alone, without writing it in the argv this test checks.
    const script = 'token=unset; [ -n "${CLAUDE_CODE_OAUTH_TOKEN+x}" ] && token=other; case "${CLAUDE_CODE_OAUTH_TOKEN-}" in oauth-value-[1]) token=given;; esac; printf "%s|%s|%s" "${STEP_VALUE-unset}" "$token" "${GITHUB_TOKEN+set}"; exit 3';

    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], env: { STEP_VALUE: 'step-value-1' }, credentials, cwd: at.worktree })).end)
      .toEqual({ op: expect.any(String), event: 'exited', code: 3, stdout: 'step-value-1|given|' });
    // A credential the exec withholds is not set.
    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], unset: ['CLAUDE_CODE_OAUTH_TOKEN'], credentials, cwd: at.worktree })).end).toMatchObject({ stdout: 'unset|unset|' });

    const argvs = JSON.stringify(engine.calls());

    expect(argvs).not.toContain('oauth-value-1');
    expect(argvs).not.toContain('step-value-1');
    expect(engine.calls().filter(([, command]) => command === 'run').join(' ')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    // The runtime's journal keeps no credential.
    const kept = journalFiles();

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.map((file) => fs.readFileSync(file, 'utf8')).join('\n')).not.toContain('oauth-value-1');
  });

  it('keeps a credential the tool printed off disk, and answers a repeated id with it masked', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    // A tool that echoes its token: a fake value, written by the test.
    const request = { argv: ['/bin/sh', '-c', 'printf "token=%s" "$CLAUDE_CODE_OAUTH_TOKEN"'], credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-echoed' }, cwd: at.worktree };
    const op = newOp();

    // teamai gets the complete stdout, and masks it itself.
    expect((await exec(connection, request, op)).end).toMatchObject({ event: 'exited', code: 0, stdout: 'token=oauth-value-echoed' });
    expect((await exec(connection, request, op)).end).toMatchObject({ event: 'exited', code: 0, stdout: 'token=<REDACTED:CLAUDE_CODE_OAUTH_TOKEN>' });

    expect(journalFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n')).not.toContain('oauth-value-echoed');
  });

  it("sets no credential on an exec that brings none, as a command step's, whatever the attempt's open carried", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at, newOp(), { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' } });

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'if [ -n "${CLAUDE_CODE_OAUTH_TOKEN+x}" ]; then printf set; else printf unset; fi'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', stdout: 'unset' });
  });

  it('records the end of an exec that outlives teamai, even once its stdout is gone', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    const marker = path.join(at.worktree, 'started');
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], cwd: at.worktree, argv: ['/bin/sh', '-c', `touch started; i=0; while [ $i -lt 20 ]; do echo line $i; i=$((i+1)); sleep 0.05; done; echo done`] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    expect(fs.existsSync(marker) || await new Promise((resolve) => setTimeout(() => resolve(fs.existsSync(marker)), 500))).toBe(true);
    // teamai is gone: nobody reads the runtime's stdout, and its stdin ends.
    first.child.stdout.destroy();
    await first.end();

    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone')).toMatchObject({
      event: 'alive', ops: [{ op, state: 'exited', code: 0, stdout: expect.stringMatching(/line 19\ndone\n$/) }],
    });
  });

  it('answers a repeated exec id with the same outcome without running it again', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    const first = await exec(connection, { argv: ['/bin/sh', '-c', 'echo x >> runs; echo once'], cwd: at.worktree }, op);

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo x >> runs; echo once'], cwd: at.worktree }, op)).end).toEqual(first.end);
    expect(fs.readFileSync(path.join(at.worktree, 'runs'), 'utf8')).toBe('x\n');
  });

  it('runs an exec id sent twice at once only once', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    const request = { type: 'exec', op, handle: HANDLE, env: {}, unset: [], cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo x >> runs'] };
    connection.send(request);
    connection.send(request);
    await connection.next((message) => message.op === op && message.event === 'exited', 30_000);
    // The other request's end, had it run, would be written by now.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(fs.readFileSync(path.join(at.worktree, 'runs'), 'utf8')).toBe('x\n');
    expect(connection.messages.filter((message) => message.op === op && message.event === 'exited')).toHaveLength(1);
  });

  it("finds the engine on teamai's PATH when the step sets its own PATH for the container", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'printf "%s" "$PATH"'], env: { PATH: '/opt/step/bin:/usr/bin:/bin' }, cwd: at.worktree })).end)
      .toMatchObject({ event: 'exited', code: 0, stdout: '/opt/step/bin:/usr/bin:/bin' });
  });

  it('answers close_failed when the engine cannot remove the container, and keeps the place to close again', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());
    engine.failRemove(true);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'))).toMatchObject({
      event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_failed', message: expect.stringContaining(`docker rm --force`) },
    });
    expect(engine.containers()).toEqual([HANDLE]);

    engine.failRemove(false);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'))).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('forgets the place of a released attempt when the engine cannot remove its container, still answering close_failed with how to remove it', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());
    engine.failRemove(true);
    connection.send({ type: 'close', handle: HANDLE, release: true });

    expect(await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'))).toMatchObject({
      event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_failed', message: expect.stringMatching(/docker rm --force.*You released the attempt, so this runtime no longer keeps its place\.$/) }, kept: [HANDLE],
    });
    expect(journalFiles()).toEqual([]);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it("forgets the place of a released attempt whose record it cannot read, still answering the close's failure", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: at.worktree });
    const record = journalFiles().find((file) => file.includes(`${path.sep}ops${path.sep}`)) ?? '';
    fs.writeFileSync(record, '{"handle":');
    connection.send({ type: 'close', handle: HANDLE, release: true });

    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 5_000)).toMatchObject({ event: 'failed', handle: HANDLE, failure: { code: 'runtime_failed', message: expect.stringContaining(record) }, kept: [HANDLE] });
    expect(journalFiles()).toEqual([]);
  });

  it('stops an exec still running when teamai closes its place, ends it as cancelled, then answers closed', async () => {
    engine.stopLag(1_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => (message.op === op && message.event !== 'output') || message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ op, event: 'cancelled' });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it("answers a close within 10 s with close_failed and how to remove it when an exec does not end after the removal, and keeps the place to close again", async () => {
    engine.stopLag(16_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    const sent = Date.now();

    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 15_000)).toMatchObject({
      event: 'close_failed', handle: HANDLE, failure: { message: expect.stringMatching(new RegExp(`teamai workflow cancel ${RUN}.*docker rm --force ${HANDLE}`)) },
    });
    expect(Date.now() - sent).toBeLessThan(10_500);
    expect(journalFiles().some((file) => file.includes(`${path.sep}places${path.sep}`))).toBe(true);
    // Once the exec ended, the place closes.
    expect(await connection.next((message) => message.op === op && message.event !== 'accepted' && message.event !== 'output', 15_000)).toEqual({ op, event: 'cancelled' });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(journalFiles()).toEqual([]);
  }, 60_000);

  it('never counts an exec whose runtime died as cancelled when the engine could not stop it', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    engine.daemon(false);

    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toMatchObject({
      op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('docker rm --force') },
    });
    engine.daemon(true);
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('fails a cancel the engine could not stop, with how to remove the container, and keeps it to remove at close', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    engine.daemon(false);

    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({
      op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`docker rm --force`) },
    });
    engine.daemon(true);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    // The exec's own end, once close removed its container, is not a second outcome.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connection.messages.filter((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toHaveLength(1);
  });

  /** Starts an exec that runs until something stops it, and waits until it runs. */
  async function runForever(connection: Connection, at: Place): Promise<string> {
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });

    return op;
  }

  const ended = (op: string) => (message: Message): boolean => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event));

  /** Starts an exec that runs until something stops it, and returns its op and its shell's pid once it runs. */
  async function runTracked(connection: Connection, at: Place): Promise<{ op: string; pid: number }> {
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo $$ > pid.tmp; mv pid.tmp pid; while :; do sleep 1; done'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    const file = path.join(at.worktree, 'pid');
    await vi.waitFor(() => { expect(fs.existsSync(file)).toBe(true); }, { timeout: 10_000 });

    return { op, pid: Number(fs.readFileSync(file, 'utf8')) };
  }

  /** Whether the step's process still runs. */
  function isRunning(pid: number): boolean {
    return signalPid(pid, 0) === 'sent';
  }

  /** The pids of `parent`'s children, as `pgrep -P` lists them. */
  function childrenOf(parent: number | undefined): number[] {
    try {
      return execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' }).trim().split('\n').map(Number);
    } catch {
      return [];
    }
  }

  it('reports an exec whose stop a killed runtime never confirmed as running, and a later cancel stops it', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const { op, pid } = await runTracked(first, at);
    first.child.kill('SIGKILL');
    await first.end();
    // A runtime in recover mode asks the engine to stop it, and is killed before the engine stopped anything.
    engine.stopDelay(60_000);
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE }, 'recover');
    second.send({ type: 'cancel', op });
    await vi.waitFor(() => { expect(engine.calls().some(([, command]) => command === 'restart')).toBe(true); }, { timeout: 10_000 });
    const stopping = childrenOf(second.child.pid);
    second.child.kill('SIGKILL');
    await second.end();

    for (const child of stopping) signalPid(child, 'SIGKILL');
    engine.stopDelay(0);
    expect(isRunning(pid)).toBe(true);

    const third = start();
    await init(third, { provider: 'docker', image: IMAGE }, 'recover');
    third.send({ type: 'reattach', handle: HANDLE });

    expect(await third.next((message) => message.handle === HANDLE)).toMatchObject({ event: 'alive', ops: [{ op, state: 'running' }] });
    third.send({ type: 'cancel', op });
    expect(await third.next(ended(op), 15_000)).toEqual({ op, event: 'cancelled' });
    await vi.waitFor(() => { expect(isRunning(pid)).toBe(false); }, { timeout: 5_000 });
    third.send({ type: 'close', handle: HANDLE });
    expect(await third.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it("reports a killed runtime's exec as running, never lost, so a cancel still stops it", async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const { op, pid } = await runTracked(first, at);
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE }, 'recover');
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.handle === HANDLE)).toMatchObject({ event: 'alive', ops: [{ op, state: 'running' }] });
    expect(isRunning(pid)).toBe(true);
    second.send({ type: 'cancel', op });
    expect(await second.next(ended(op), 15_000)).toEqual({ op, event: 'cancelled' });
    await vi.waitFor(() => { expect(isRunning(pid)).toBe(false); }, { timeout: 5_000 });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  }, 60_000);

  // teamai ends a live exec whose cancel has no outcome 15 s after it sent the cancel.
  it.each<{ options: Message; remove: string }>([
    { options: { provider: 'docker', image: IMAGE }, remove: 'docker rm --force' },
    { options: { provider: 'sbx', agent: 'claude' }, remove: 'sbx rm --force' },
  ])('answers the cancel of a live exec within 15 s when the $options.provider stop stalls, with cancel_failed and how to remove it', async ({ options, remove }) => {
    engine.image('claude', { claude: CLAUDE });
    const connection = start();
    await init(connection, options);
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    engine.stopDelay(60_000);
    const sent = Date.now();

    connection.send({ type: 'cancel', op });

    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(remove) } });
    expect(Date.now() - sent).toBeLessThan(15_000);
    engine.stopDelay(0);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it('answers the cancel of a live exec within 15 s with cancel_failed when its process does not end after the stop', async () => {
    engine.stopLag(16_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    const sent = Date.now();

    connection.send({ type: 'cancel', op });

    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(`teamai workflow cancel ${RUN}`) } });
    expect(Date.now() - sent).toBeLessThan(15_000);
  }, 60_000);

  // A step's stop keeps its sandbox, so an exec still on its way to the engine when the stop lands starts after it.
  it.each<{ options: Message }>([
    { options: { provider: 'docker', image: IMAGE } },
    { options: { provider: 'podman', image: IMAGE } },
    { options: { provider: 'sbx', agent: 'claude' } },
  ])('ends a step cancelled, with nothing left running, when its $options.provider stop overtakes the start of its exec', async ({ options }) => {
    engine.image('claude', { claude: CLAUDE });
    const connection = start();
    await init(connection, options);
    const at = place();
    await openPlace(connection, at);
    const execsBefore = engine.calls().filter(([, command]) => command === 'exec').length;
    engine.holdExec(1_500);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo $$ > pid.tmp; mv pid.tmp pid; while :; do sleep 1; done'] });
    await vi.waitFor(() => { expect(engine.calls().filter(([, command]) => command === 'exec').length).toBeGreaterThan(execsBefore); }, { timeout: 10_000 });

    connection.send({ type: 'cancel', op });

    expect(await connection.next(ended(op), 15_000)).toEqual({ op, event: 'cancelled' });
    const file = path.join(at.worktree, 'pid');
    expect(fs.existsSync(file) && isRunning(Number(fs.readFileSync(file, 'utf8')))).toBe(false);
  }, 60_000);

  it('reports a retried cancel running until its stop is confirmed, never the failure the cancel before left, then cancelled', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    engine.daemon(false);
    connection.send({ type: 'cancel', op });
    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed' } });
    engine.daemon(true);
    engine.stopDelay(1_500);

    connection.send({ type: 'cancel', op });
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'alive', 5_000)).toMatchObject({ event: 'alive', ops: [{ op, state: 'running' }] });
    await vi.waitFor(async () => {
      connection.send({ type: 'reattach', handle: HANDLE });
      expect(await connection.next((message) => message.event === 'alive', 5_000)).toMatchObject({ ops: [{ op, state: 'cancelled' }] });
    }, { timeout: 15_000, interval: 200 });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it('answers an exec resent while its cancel is retried with its running state, never the failure the cancel before left, then cancelled', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    engine.daemon(false);
    connection.send({ type: 'cancel', op });
    expect(await connection.next(ended(op), 15_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed' } });
    engine.daemon(true);
    engine.stopDelay(1_500);
    const before = connection.messages.length;

    connection.send({ type: 'cancel', op });
    connection.send({ type: 'reattach', handle: HANDLE });
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });

    expect(await connection.next((message) => message.event === 'alive', 5_000)).toMatchObject({ ops: [{ op, state: 'running' }] });
    expect(await connection.next((message) => connection.messages.indexOf(message) >= before && ended(op)(message), 15_000)).toEqual({ op, event: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connection.messages.slice(before).filter(ended(op))).toEqual([{ op, event: 'cancelled' }]);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  }, 60_000);

  it('fails a cancel it cannot read the place record for with cancel_failed, naming the record, and keeps the container', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = await runForever(connection, at);
    const record = journalFiles().find((file) => file.includes(`${path.sep}places${path.sep}`)) ?? '';
    const kept = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '');

    connection.send({ type: 'cancel', op });

    expect(await connection.next(ended(op), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(record) } });
    expect(engine.containers()).toEqual([HANDLE]);
    expect(engine.calls().filter(([, command]) => command === 'restart')).toEqual([]);
    // Mended, the place closes as any other.
    fs.writeFileSync(record, kept);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed' || (message.event === 'failed' && message.handle === HANDLE), 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it('keeps the cancel_failed of a cancel that could not record itself, so a reattach reports it, and a retry once mended stops the exec', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const { op, pid } = await runTracked(first, at);
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    // The cancel's own marker cannot be written; the exec's record still can.
    const marker = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox', 'ops', `${op}.cancel`);
    fs.mkdirSync(marker);

    second.send({ type: 'cancel', op });

    expect(await second.next(ended(op), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed' } });
    second.send({ type: 'reattach', handle: HANDLE });
    expect(await second.next((message) => message.handle === HANDLE)).toMatchObject({ event: 'alive', ops: [{ op, state: 'failed', failure: { code: 'cancel_failed' } }] });
    expect(isRunning(pid)).toBe(true);
    fs.rmdirSync(marker);
    second.send({ type: 'cancel', op });
    expect(await second.next(ended(op), 15_000)).toEqual({ op, event: 'cancelled' });
    await vi.waitFor(() => { expect(isRunning(pid)).toBe(false); }, { timeout: 5_000 });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  }, 60_000);

  it('ends an exec resent after its runtime died once, with cancel_failed, when its cancel cannot read the place record', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const { op, pid } = await runTracked(first, at);
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    second.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'exit 0'] });
    await second.next((message) => message.op === op && message.event === 'accepted');
    const record = journalFiles().find((file) => file.includes(`${path.sep}places${path.sep}`) && file.endsWith('.json')) ?? '';
    const kept = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '');

    second.send({ type: 'cancel', op });

    expect(await second.next(ended(op), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining(record) } });
    fs.writeFileSync(record, kept);
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(second.messages.filter(ended(op))).toHaveLength(1);
    await vi.waitFor(() => { expect(isRunning(pid)).toBe(false); }, { timeout: 5_000 });
  }, 60_000);

  it('fails a cancel the engine could not stop for an exec a runtime teamai left still runs, and that exec is not kept again after close', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while :; do sleep 1; done'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    // teamai is gone: the first runtime keeps running the exec.
    first.child.stdin.end();
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    engine.daemon(false);

    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({
      op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('docker rm --force') },
    });
    engine.daemon(true);
    second.send({ type: 'close', handle: HANDLE });

    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    await first.end();
    expect(engine.containers()).toEqual([]);
    expect(journalFiles().filter((file) => file.includes(op))).toEqual([]);
  });

  it('answers a runtime restarted while the engine is down, whose init failed, from its own record, and keeps the sandbox to close later', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    engine.daemon(false);
    const second = start();

    expect(await init(second, { provider: 'docker', image: IMAGE })).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    second.send({ type: 'cancel', op });
    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining("stays this attempt's") } });
    // teamai resends the exec after a restart: it is answered from the journal, and the place stays.
    second.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed' } });
    second.send({ type: 'reattach', handle: HANDLE });
    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone', 5_000)).toMatchObject({ event: 'alive', handle: HANDLE, ops: [{ op, state: 'failed' }] });
    second.send({ type: 'reattach', handle: 'teamai-r0123abcd-a99999999' });
    expect(await second.next((message) => message.handle === 'teamai-r0123abcd-a99999999', 5_000)).toEqual({ event: 'gone', handle: 'teamai-r0123abcd-a99999999' });
    second.send({ type: 'collect', handle: HANDLE });
    expect(await second.next((message) => message.event === 'collected' || message.event === 'collect_failed', 5_000)).toEqual({ event: 'collected', handle: HANDLE });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 5_000)).toMatchObject({ event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_unavailable', message: expect.stringContaining("stays this attempt's") } });

    engine.daemon(true);
    const third = start();
    await init(third, { provider: 'docker', image: IMAGE });
    third.send({ type: 'close', handle: HANDLE });
    expect(await third.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('opens in recover mode while the engine is down without running it, and offers nothing', async () => {
    engine.daemon(false);
    const connection = start();

    expect(await init(connection, { provider: 'docker', image: IMAGE }, 'recover')).toEqual({ type: 'init', ok: true, can: {} });
    expect(engine.calls()).toEqual([]);
  });

  // Whether a run could start here is known only once the image is pulled and a container started, which a check may not
  // do; whether the engine runs at all is known by asking it.
  it('in check mode asks the engine only whether it runs, says why not when it does not, and keeps nothing of the instances it names', async () => {
    const instances = [{ name: 'acme-claude', tool: 'claude', command: 'acme-claude' }];

    expect(await init(start(), { provider: 'docker', image: IMAGE }, 'check', undefined, instances)).toEqual({
      type: 'init', ok: false, error: { code: 'check_unsupported', message: expect.stringContaining('cannot tell whether a run could start without starting a sandbox') },
    });
    engine.daemon(false);
    expect(await init(start(), { provider: 'docker', image: IMAGE }, 'check', undefined, instances)).toEqual({
      type: 'init', ok: false, error: { code: 'sandbox_unavailable', message: expect.stringContaining('its daemon is not running') },
    });
    expect(engine.calls().map(([, command]) => command)).toEqual(['info', 'info']);
    expect(entriesUnder(path.join(dir, 'home')).map(({ relative }) => relative).filter((entry) => entry.endsWith('instances.json'))).toEqual([]);
  });

  it("stops and removes a dead runtime's exec in recover mode, running the engine only for the stop and the removal", async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const before = engine.calls().length;
    const second = start();

    expect(await init(second, { provider: 'docker', image: IMAGE }, 'recover')).toEqual({ type: 'init', ok: true, can: {} });
    second.send({ type: 'cancel', op });
    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toEqual({ op, event: 'cancelled' });
    second.send({ type: 'reattach', handle: HANDLE });
    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone' || message.event === 'failed')).toMatchObject({ event: 'alive', handle: HANDLE, ops: [{ op, state: 'cancelled' }] });
    second.send({ type: 'collect', handle: HANDLE });
    expect(await second.next((message) => message.handle === HANDLE && message.event !== 'alive')).toEqual({ event: 'collected', handle: HANDLE });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });

    // The removal of its network filter and network, which a sandbox not behind one does not have, finds nothing.
    expect(engine.calls().slice(before).map(([, command]) => command)).toEqual(['inspect', 'restart', 'rm', 'rm', 'network']);
    expect(engine.containers()).toEqual([]);
  });

  it('stops a place on the provider it was opened with, when the profile names another one by the time of the stop', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    await openPlace(first, place());
    first.child.kill('SIGKILL');
    await first.end();
    const before = engine.calls().length;
    const second = start();

    expect(await init(second, { provider: 'podman', image: IMAGE }, 'recover')).toEqual({ type: 'init', ok: true, can: {} });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });

    expect(engine.calls().slice(before).map(([name, command]) => `${name} ${command}`)).toEqual(['docker rm', 'docker rm', 'docker network']);
    expect(engine.containers()).toEqual([]);
  });

  it('runs an exec in a place on the provider it was opened with, when a resume after a profile change inits another one', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();

    expect(await init(second, { provider: 'podman', image: IMAGE })).toMatchObject({ ok: true });
    const before = engine.calls().length;

    expect(await exec(second, { argv: ['/bin/sh', '-c', 'echo again'], cwd: at.worktree })).toMatchObject({ end: { event: 'exited', code: 0 }, output: 'again\n' });
    expect(engine.calls().slice(before).filter(([, command]) => command === 'exec').map(([name]) => name)).toEqual(['docker']);
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  });

  it('keeps the place of an open attempt, and runs its next exec, when an open of it again fails', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    expect((await openPlace(connection, at)).ready).toMatchObject({ event: 'ready' });
    engine.daemon(false);
    expect((await openPlace(connection, at)).ready).toMatchObject({ event: 'failed' });
    engine.daemon(true);

    expect(await exec(connection, { argv: ['/bin/sh', '-c', 'echo still'], cwd: at.worktree })).toMatchObject({ end: { event: 'exited', code: 0 }, output: 'still\n' });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  });

  it("keeps the addresses of this machine its step's filter reads current, as when a VPN comes up during a step, and removes them with the place", async () => {
    engine.image(IMAGE, { claude: CLAUDE, node: '' });
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());
    const file = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox', 'docker', 'filters', HANDLE, 'this-machine');
    const lan = Object.values(os.networkInterfaces()).flatMap((found) => found ?? []).filter((one) => !one.internal && one.family === 'IPv4').map((one) => one.address);
    const listed = (): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : []);

    expect(listed()).toEqual(expect.arrayContaining(lan));
    // What the file held when the addresses it lists were not this machine's yet.
    fs.writeFileSync(file, '');
    await expect.poll(listed, { timeout: 10_000 }).toEqual(expect.arrayContaining(lan));
    expect(lan.length).toBeGreaterThan(0);
    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'));

    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it("keeps the addresses of this machine a resumed step's filter reads current, when the resume after a profile change inits another provider", async () => {
    engine.image(IMAGE, { claude: CLAUDE, node: '' });
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    first.child.kill('SIGKILL');
    await first.end();
    const file = path.join(dir, 'home', '.teamai', 'runtime-state', 'sandbox', 'docker', 'filters', HANDLE, 'this-machine');
    const lan = Object.values(os.networkInterfaces()).flatMap((found) => found ?? []).filter((one) => !one.internal && one.family === 'IPv4').map((one) => one.address);
    // What the file held when the addresses it lists were not this machine's yet.
    fs.writeFileSync(file, '');
    const second = start();
    await init(second, { provider: 'podman', image: IMAGE });

    expect(await exec(second, { argv: ['/bin/sh', '-c', 'echo again'], cwd: at.worktree })).toMatchObject({ end: { event: 'exited', code: 0 } });
    await expect.poll(() => fs.readFileSync(file, 'utf8').split('\n'), { timeout: 10_000 }).toEqual(expect.arrayContaining(lan));
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
  });

  it('leaves no network of a first open whose network filter could not start, for no later open to sweep', async () => {
    engine.image(IMAGE, { claude: CLAUDE, node: '' });
    engine.failFilter(true);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });

    expect((await openPlace(connection, place())).ready).toMatchObject({ event: 'failed', failure: { code: 'sandbox_failed', message: expect.stringContaining('could not start the network filter') } });
    expect(engine.networks()).toEqual([]);
    expect(engine.containers()).toEqual([]);
  });

  it('stops a place on the options it was opened with when teamai, whose profile is gone, gives none', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    await openPlace(first, place());
    first.child.kill('SIGKILL');
    await first.end();
    const before = engine.calls().length;
    const second = start();

    expect(await init(second, {}, 'recover')).toEqual({ type: 'init', ok: true, can: {} });
    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });

    expect(engine.calls().slice(before).map(([name, command]) => `${name} ${command}`)).toEqual(['docker rm', 'docker rm', 'docker network']);
  });

  it('answers a recover cancel with the end the runtime that ran the exec recorded while the stop ran, never silence', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    // teamai is gone; the runtime that runs the exec outlives its stdin, and records the exec's end when it stops.
    first.child.stdin.end();
    // The engine answers the stop only after that runtime has seen its exec end and recorded it.
    engine.stopHold(1_500);
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE }, 'recover');
    second.send({ type: 'cancel', op });

    expect(await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toEqual({ op, event: 'cancelled' });
  });

  it('answers a cancel of an exec that already ended with that end again, in the runtime that ran it and in a restarted one', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    const { end } = await exec(connection, { argv: ['/bin/sh', '-c', 'echo done; exit 3'], cwd: at.worktree }, op);

    expect(end).toEqual({ op, event: 'exited', code: 3, stdout: 'done\n' });
    connection.send({ type: 'cancel', op });
    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toEqual(end);
    const restarted = start();
    await init(restarted, { provider: 'docker', image: IMAGE }, 'recover');
    restarted.send({ type: 'cancel', op });
    expect(await restarted.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)))).toEqual(end);
    // The container stays for the step's next exec: nothing was stopped.
    expect(engine.calls().filter(([, command]) => command === 'restart')).toEqual([]);
  });

  it('answers a reattach from its journal alone, without asking the engine, even while the engine is down', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());
    engine.daemon(false);
    const before = engine.calls().length;
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'alive' || message.event === 'gone' || message.event === 'failed')).toEqual({ event: 'alive', handle: HANDLE, ops: [], display: { label: `${HANDLE} (docker)`, fields: { container: HANDLE, image: IMAGE } } });
    expect(engine.calls().slice(before)).toEqual([]);
    // An error line would fail every request teamai is waiting on.
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
  });

  // teamai's order after a driver died: cancel the exec, reattach until it no longer runs, collect, close.
  it.each<{ options: Message; remove: string }>([
    { options: { provider: 'docker', image: IMAGE }, remove: 'docker rm --force' },
    { options: { provider: 'sbx', agent: 'claude' }, remove: 'sbx rm --force' },
  ])("keeps a dead runtime's $options.provider sandbox through a reattach while the engine is down, and removes it at close", async ({ options, remove }) => {
    engine.image('claude', { claude: CLAUDE });
    const first = start();
    await init(first, options);
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    const second = start();
    await init(second, options);
    engine.daemon(false);

    second.send({ type: 'cancel', op });
    await second.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000);
    second.send({ type: 'reattach', handle: HANDLE });

    // Not gone: the journal still holds the place, so it is still this attempt's, and the cleanup command is the op's.
    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone', 30_000)).toMatchObject({
      event: 'alive', handle: HANDLE, ops: [{ op, state: 'failed', failure: { message: expect.stringContaining(remove) } }],
    });
    expect(second.messages.filter((message) => message.event === 'error')).toEqual([]);
    second.send({ type: 'collect', handle: HANDLE });
    await second.next((message) => message.event === 'collected' || message.event === 'collect_failed');
    engine.daemon(true);
    second.send({ type: 'close', handle: HANDLE });

    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it("answers an exec, a close and a reattach it cannot read the journal for with their own failure, naming the record, so teamai never waits on them", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const record = journalFiles().find((file) => file.includes(`${path.sep}places${path.sep}`)) ?? '';
    const intact = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '{"run":');
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo ran'] });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    connection.send({ type: 'close', handle: HANDLE });
    const closeFailed = await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 5_000);

    expect(closeFailed).toMatchObject({ event: 'failed', handle: HANDLE, failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    // Not released: the place stays for a close once the journal is mended, so nothing is left on purpose.
    expect(closeFailed).not.toHaveProperty('kept');
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE, 5_000)).toMatchObject({ event: 'failed', handle: HANDLE, failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    // An error line would fail every other request teamai is waiting on.
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
    // Nothing is taken as absent: the container and its record stay for a close once the journal is mended.
    expect(engine.containers()).toEqual([HANDLE]);
    expect(fs.existsSync(record)).toBe(true);
    // Mended, the place closes as any other.
    fs.writeFileSync(record, intact);
  });

  it('answers a resent exec whose own record it cannot read with that exec\'s failure, never silence', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: at.worktree }, op);
    const record = journalFiles().find((file) => file.endsWith(`${op}.json`)) ?? '';
    const intact = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '{"handle":');
    const before = connection.messages.length;
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo ran'] });

    expect(await connection.next((message) => message.op === op && connection.messages.indexOf(message) >= before && message.event !== 'output', 5_000)).toMatchObject({ op, event: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
    // Mended, the place closes as any other.
    fs.writeFileSync(record, intact);
  });

  it('ends an exec it cannot record the end of once, with its true end, and says so in a notice naming the record', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while [ ! -f release ]; do sleep 0.05; done; echo finished'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    const record = journalFiles().find((file) => file.endsWith(`${op}.json`)) ?? '';
    const intact = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '{"handle":');
    fs.writeFileSync(path.join(at.worktree, 'release'), '');

    expect(await connection.next(ended(op), 10_000)).toEqual({ op, event: 'exited', code: 0, stdout: 'finished\n' });
    expect(connection.messages.filter((message) => message.op === op && message.event === 'notice')).toEqual([{ event: 'notice', op, message: expect.stringContaining(record) }]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connection.messages.filter(ended(op))).toHaveLength(1);
    // Mended, the place closes as any other.
    fs.writeFileSync(record, intact);
  });

  it("reattaches and closes a healthy place whatever another attempt's damaged record holds, and still fails that attempt until it is mended", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const otherHandle = `teamai-${RUN}-a0000beef`;
    const opened = newOp();
    connection.send({ type: 'open', op: opened, run: RUN, attempt: 'a0000beef', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    await connection.next((message) => message.op === opened && message.event === 'ready', 30_000);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: otherHandle, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo ran'] });
    await connection.next(ended(op), 30_000);
    const record = journalFiles().find((file) => file.endsWith(`${op}.json`)) ?? '';
    const kept = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '{"handle":');

    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && message.op === undefined)).toMatchObject({ event: 'alive', ops: [] });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && message.op === undefined, 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([otherHandle]);
    // The damaged record is that attempt's own: never skipped as absent.
    connection.send({ type: 'reattach', handle: otherHandle });
    expect(await connection.next((message) => message.handle === otherHandle && message.op === undefined)).toMatchObject({ event: 'failed', failure: { message: expect.stringContaining(record) } });

    fs.writeFileSync(record, kept);
    connection.send({ type: 'close', handle: otherHandle });
    expect(await connection.next((message) => message.handle === otherHandle && message.op === undefined, 30_000)).toEqual({ event: 'closed', handle: otherHandle });
    expect(journalFiles()).toEqual([]);
  });

  it('leaves no journal file behind at close, a write a crash left before its rename included', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: at.worktree });

    // Each record is written to `<record>.<pid>.tmp`, then renamed: a runtime killed between leaves the first.
    for (const file of journalFiles()) fs.copyFileSync(file, `${file}.99999.tmp`);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(journalFiles()).toEqual([]);
  });

  it('collects with the work already at its host path, and close removes the container', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    await exec(connection, { argv: ['/bin/sh', '-c', 'echo kept > work.txt; exit 1'], cwd: at.worktree });

    connection.send({ type: 'collect', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'collected')).toEqual({ event: 'collected', handle: HANDLE });
    expect(fs.readFileSync(path.join(at.worktree, 'work.txt'), 'utf8')).toBe('kept\n');
    expect(fs.statSync(path.join(at.worktree, 'work.txt')).uid).toBe(process.getuid?.());

    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed');
    expect(engine.containers()).toEqual([]);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('removes the container an open was still creating when teamai closed its place, and keeps no record of it', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    engine.delay('run', 1_500);
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(engine.calls().some(([, command, ...rest]) => command === 'run' && rest.includes(HANDLE))).toBe(true); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'accepted', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
    expect(engine.containers()).toEqual([]);
    expect(journalFiles()).toEqual([]);
  }, 60_000);

  it('keeps no record of a released attempt whose container lands after its close gave up waiting for it', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    engine.holdCreate(12_000);
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(engine.containers()).toEqual([HANDLE]); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE, release: true });

    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'accepted', 15_000)).toMatchObject({ event: 'close_failed', handle: HANDLE });
    await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
    expect(journalFiles()).toEqual([]);
  }, 60_000);

  it('accepts an exec before it looks its sandbox up by its labels, after a runtime died before it kept the sandbox id', async () => {
    engine.delay('run', 1_500);
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    const at = place();
    first.send({ type: 'open', op: newOp(), run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    await first.next((message) => message.event === 'accepted');
    await vi.waitFor(() => { expect(engine.calls().some(([, command, ...rest]) => command === 'run' && rest.includes(HANDLE))).toBe(true); }, { timeout: 10_000 });
    // Killed while the engine creates its container: the container lands, and the journal never got its id.
    first.child.kill('SIGKILL');
    await first.end();
    await vi.waitFor(() => { expect(engine.containers()).toEqual([HANDLE]); }, { timeout: 10_000 });
    engine.delay('run', 0);
    const second = start();
    await init(second, { provider: 'docker', image: IMAGE });
    engine.delay('ps', 3_000);
    const op = newOp();
    const sent = Date.now();

    second.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'echo ran'] });

    await second.next((message) => message.op === op && message.event === 'accepted');
    expect(Date.now() - sent).toBeLessThan(2_000);
    expect(await second.next(ended(op), 30_000)).toEqual({ op, event: 'exited', code: 0, stdout: 'ran\n' });
  }, 60_000);

  it('fails an exec the engine CLI cannot start with exec_failed, which nothing ran, and keeps that end', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const at = place();
    await openPlace(connection, at);
    const cli = path.join(engine.bin, 'docker');
    fs.chmodSync(cli, 0o644);

    const { end } = await exec(connection, { argv: ['/bin/sh', '-c', 'touch ran'], cwd: at.worktree });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'exec_failed' } });
    expect(fs.existsSync(path.join(at.worktree, 'ran'))).toBe(false);
    fs.chmodSync(cli, 0o755);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE)).toMatchObject({ event: 'alive', ops: [{ op: end.op, state: 'failed', failure: { code: 'exec_failed' } }] });
  });

  it('fails an open when the engine stopped since init, with what it said', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    engine.daemon(false);

    expect((await openPlace(connection, place())).ready).toMatchObject({ event: 'failed', failure: { code: 'sandbox_failed', message: expect.stringContaining('Cannot connect') } });
  });
});

describe("the containers of one runtime's journal", () => {
  /** Opens `attempt` of RUN on the shared place view, and returns how the open ended. */
  async function openAttempt(connection: Connection, attempt: string): Promise<Message> {
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });

    return connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
  }

  it('labels each container with its journal: the same label after a restart, another for another home', async () => {
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    await openAttempt(first, 'a00000001');
    await first.end();
    const again = start();
    await init(again, { provider: 'docker', image: IMAGE });
    await openAttempt(again, 'a00000002');
    fs.mkdirSync(path.join(dir, 'other-home'));
    const other = start({ HOME: path.join(dir, 'other-home') });
    await init(other, { provider: 'docker', image: IMAGE });
    await openAttempt(other, 'a00000003');

    const owner = (attempt: string): string | undefined => engine.labelsOf(`teamai-${RUN}-${attempt}`)?.['teamai.owner'];

    expect(owner('a00000001')).toMatch(/^[0-9a-f]{16}$/);
    expect(owner('a00000002')).toBe(owner('a00000001'));
    expect(owner('a00000003')).toMatch(/^[0-9a-f]{16}$/);
    expect(owner('a00000003')).not.toBe(owner('a00000001'));
  }, 60_000);

  /** A container of `attempt` with `labels`, as a runtime killed while the engine created it leaves one. */
  function leave(attempt: string, labels: Record<string, string>): void {
    const own = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    execFileSync(path.join(engine.bin, 'docker'), ['run', '-d', '--name', `teamai-${RUN}-${attempt}`, '--label', `teamai.run=${RUN}`, '--label', `teamai.attempt=${attempt}`, ...own, '--entrypoint', '/bin/sh', IMAGE, '-c', 'sleep infinity'], { env: engine.env() });
  }

  const named = (...attempts: string[]): string[] => attempts.map((attempt) => `teamai-${RUN}-${attempt}`).sort();

  it("removes, once an open is accepted, a container of this journal whose attempt it no longer records, and keeps one it records, another journal's and an unlabelled one", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openAttempt(connection, 'a00000001');
    const owner = engine.labelsOf(`teamai-${RUN}-a00000001`)?.['teamai.owner'] ?? '';
    leave('a00000002', { 'teamai.owner': owner });
    leave('a00000003', { 'teamai.owner': '0123456789abcdef' });
    leave('a00000004', {});
    // Another journal's and an unlabelled one are never this runtime's to remove.
    planted(...named('a00000003', 'a00000004'));

    expect(await openAttempt(connection, 'a00000005')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(engine.containers().sort()).toEqual(named('a00000001', 'a00000003', 'a00000004', 'a00000005')); }, { timeout: 10_000 });
    expect(connection.stderr()).toBe('');
  }, 60_000);

  it("removes a judge's container this journal no longer records together with its filter and its network", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openAttempt(connection, 'a00000001');
    const owner = ['--label', `teamai.owner=${engine.labelsOf(`teamai-${RUN}-a00000001`)?.['teamai.owner'] ?? ''}`];
    const judged = `teamai-${RUN}-a00000002`;
    const docker = (...args: string[]): void => { execFileSync(path.join(engine.bin, 'docker'), args, { env: engine.env() }); };
    docker('network', 'create', '--internal', '--label', `teamai.run=${RUN}`, '--label', 'teamai.attempt=a00000002', ...owner, `${judged}-net`);
    docker('run', '-d', '--name', `${judged}-proxy`, '--label', `teamai.run=${RUN}`, '--label', 'teamai.judge=a00000002', ...owner, '--entrypoint', 'node', IMAGE, '-e', '');
    docker('run', '-d', '--name', judged, '--label', `teamai.run=${RUN}`, '--label', 'teamai.attempt=a00000002', ...owner, '--network', `${judged}-net`, '--entrypoint', '/bin/sh', IMAGE, '-c', 'sleep infinity');

    expect(await openAttempt(connection, 'a00000003')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => {
      expect(engine.containers().sort()).toEqual(named('a00000001', 'a00000003'));
      expect(engine.networks()).toEqual([]);
    }, { timeout: 10_000 });
    expect(connection.stderr()).toBe('');
  }, 60_000);

  it('removes a network a runtime killed before its container left, and never another journal\'s or an unlabelled one', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openAttempt(connection, 'a00000001');
    const owner = engine.labelsOf(`teamai-${RUN}-a00000001`)?.['teamai.owner'] ?? '';
    const docker = (...args: string[]): void => { execFileSync(path.join(engine.bin, 'docker'), args, { env: engine.env() }); };
    const network = (attempt: string, labels: string[]): void => docker('network', 'create', '--internal', ...labels, `teamai-${RUN}-${attempt}-net`);
    network('a00000002', ['--label', `teamai.run=${RUN}`, '--label', 'teamai.attempt=a00000002', '--label', `teamai.owner=${owner}`]);
    network('a00000003', ['--label', `teamai.run=${RUN}`, '--label', 'teamai.attempt=a00000003', '--label', 'teamai.owner=0123456789abcdef']);
    network('a00000004', []);

    expect(await openAttempt(connection, 'a00000005')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(engine.networks()).toEqual([`teamai-${RUN}-a00000003-net`, `teamai-${RUN}-a00000004-net`]); }, { timeout: 10_000 });
    expect(connection.stderr()).toBe('');
  }, 60_000);

  it("removes a judge's filter that landed after its place was closed, with its network, when its judge's container never did", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openAttempt(connection, 'a00000001');
    const owner = ['--label', `teamai.owner=${engine.labelsOf(`teamai-${RUN}-a00000001`)?.['teamai.owner'] ?? ''}`];
    const judged = `teamai-${RUN}-a00000002`;
    const docker = (...args: string[]): void => { execFileSync(path.join(engine.bin, 'docker'), args, { env: engine.env() }); };
    docker('network', 'create', '--internal', '--label', `teamai.run=${RUN}`, '--label', 'teamai.attempt=a00000002', ...owner, `${judged}-net`);
    docker('run', '-d', '--name', `${judged}-proxy`, '--label', `teamai.run=${RUN}`, '--label', 'teamai.judge=a00000002', ...owner, '--entrypoint', 'node', IMAGE, '-e', '');

    expect(await openAttempt(connection, 'a00000003')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => {
      expect(engine.containers().sort()).toEqual(named('a00000001', 'a00000003'));
      expect(engine.networks()).toEqual([]);
    }, { timeout: 10_000 });
    expect(connection.stderr()).toBe('');
  }, 60_000);

  it('opens all the same when the engine cannot remove or list what an earlier run left, with one warning each on stderr', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openAttempt(connection, 'a00000001');
    leave('a00000002', { 'teamai.owner': engine.labelsOf(`teamai-${RUN}-a00000001`)?.['teamai.owner'] ?? '' });
    engine.failRemove(true);
    planted(...named('a00000002'));

    expect(await openAttempt(connection, 'a00000003')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(connection.stderr()).toContain('was left by an earlier run'); }, { timeout: 10_000 });
    engine.failRemove(false);
    engine.failFormat(true);
    expect(await openAttempt(connection, 'a00000004')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(connection.stderr()).toContain('could not list'); }, { timeout: 10_000 });
    expect(engine.containers().sort()).toEqual(named('a00000001', 'a00000002', 'a00000003', 'a00000004'));
    expect(connection.stderr().trim().split('\n')).toEqual([
      expect.stringMatching(/^teamai-runtime-sandbox: warning: teamai-r0123abcd-a00000002 \(docker\) was left by an earlier run, and docker could not remove container .+ Remove it with `docker rm --force [0-9a-f]+`\.$/),
      expect.stringMatching(/^teamai-runtime-sandbox: warning: docker could not list the containers this runtime's journal owns: Error: template: .+ Sandboxes an earlier run left stay until a later open\.$/),
    ]);
  }, 60_000);

  it('accepts and readies an open, then cancels and closes it, while the list of what earlier runs left is still held', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    engine.holdOwned(true);
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });

    // No slow work comes before accepted: the sweep starts after it, and nothing waits for it.
    expect(await connection.next((message) => message.op === op && message.event === 'accepted', 5_000)).toMatchObject({ handle: HANDLE });
    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });
    const running = newOp();
    connection.send({ type: 'exec', op: running, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    connection.send({ type: 'cancel', op: running });
    expect(await connection.next((message) => message.op === running && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 5_000)).toEqual({ op: running, event: 'cancelled' });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 5_000)).toEqual({ event: 'closed', handle: HANDLE });
    // The list is still held: it neither ended nor failed with a warning.
    expect(engine.isListingOwned()).toBe(true);
    expect(connection.stderr()).toBe('');
    engine.holdOwned(false);
    await vi.waitFor(() => { expect(engine.isListingOwned()).toBe(false); }, { timeout: 10_000 });
    expect(engine.containers()).toEqual([]);
  }, 60_000);

  it('keeps running, and records the end of its exec, when the sweep warns after teamai stopped reading its stderr', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openAttempt(connection, 'a00000001');
    leave('a00000002', { 'teamai.owner': engine.labelsOf(`teamai-${RUN}-a00000001`)?.['teamai.owner'] ?? '' });
    engine.failRemove(true);
    planted(...named('a00000002'));
    const at = place();
    const op = newOp();
    connection.send({ type: 'exec', op, handle: `teamai-${RUN}-a00000001`, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while [ ! -f release ]; do sleep 0.05; done; echo finished'] });
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    connection.child.stderr.destroy();

    // Its sweep cannot remove a00000002 and warns on a stderr nobody reads.
    expect(await openAttempt(connection, 'a00000003')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(engine.calls().filter(([, command]) => command === 'rm')).not.toEqual([]); }, { timeout: 10_000 });
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    fs.writeFileSync(path.join(at.worktree, 'release'), '');

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toEqual({ op, event: 'exited', code: 0, stdout: 'finished\n' });
  }, 60_000);

  it("keeps the container of another runtime's create still on its way, whose place that runtime saved first", async () => {
    const creating = start();
    await init(creating, { provider: 'docker', image: IMAGE });
    engine.holdCreate(10_000);
    const held = openAttempt(creating, 'a00000001');
    let isCreateOver = false;
    void held.finally(() => { isCreateOver = true; });
    await vi.waitFor(() => { expect(engine.containers()).toEqual(named('a00000001')); }, { timeout: 10_000 });
    engine.holdCreate(0);
    const other = start();
    await init(other, { provider: 'docker', image: IMAGE });

    expect(await openAttempt(other, 'a00000002')).toMatchObject({ event: 'ready' });
    // Both opens' sweeps have listed the journal's containers, and a removal either started has had time to end.
    await vi.waitFor(() => { expect(engine.ownedListings()).toBe(2); }, { timeout: 10_000 });
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(engine.calls().filter(([, command]) => command === 'rm')).toEqual([]);
    expect(engine.containers().sort()).toEqual(named('a00000001', 'a00000002'));
    // Checked while the create was still on its way, or the test proves nothing.
    expect(isCreateOver).toBe(false);
    expect(await held).toMatchObject({ event: 'ready' });
  }, 60_000);
});

// A judge's tools: each lists the files it can see from its working directory, says which credential names it got
// (names only), and replies as the real tool does on stdout.
// Lists without following links, as entriesUnder does: a link to a folder is not entered.
const SEES = "const fs = require('node:fs'); const under = (at) => fs.readdirSync(at || '.', { withFileTypes: true }).flatMap((entry) => { const file = at ? at + '/' + entry.name : entry.name; return entry.isDirectory() ? under(file) : [file]; }); const sees = under('').filter((file) => fs.statSync(file).isFile()).sort();";
const NAMES = "const names = ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'HTTPS_PROXY'].filter((name) => process.env[name] !== undefined); const given = Object.keys(process.env).filter((name) => process.env[name].includes('given')).sort();";
const JUDGE_CLAUDE = `if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
${SEES} ${NAMES}
if (process.argv.includes('--hang')) setInterval(() => {}, 1000);
else console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 'claude-session-1', result: '', structured_output: { answer: { label: 'good', reasoning: JSON.stringify({ sees, names, given, argv: process.argv.slice(2) }) } }, usage: { input_tokens: 12, output_tokens: 5 } }));`;
const JUDGE_CODEX = `${SEES} ${NAMES}
const schema = require('node:fs').readFileSync(process.argv[process.argv.indexOf('--output-schema') + 1], 'utf8');
const argv = process.argv.slice(2);
const retried = argv.at(-1).includes('flaky network') ? [{ type: 'error', message: 'Reconnecting... 1/5' }] : [];
const answer = JSON.stringify({ answer: { label: 'bad', reasoning: JSON.stringify({ sees, names, given, schema, argv }) } });
const text = argv.at(-1).includes('explain yourself') ? 'I read the evidence.\\n\\n\`\`\`json\\n' + answer + '\\n\`\`\`\\n\\nThe work misses a test.' : answer;
const lines = [{ type: 'thread.started', thread_id: 'codex-thread-1' }, ...retried, { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 7 } }].map((line) => JSON.stringify(line) + '\\n');
// \`chatty\` prints 640 MiB of progress between its first line and the rest, more than one string of V8's can hold.
const noise = argv.at(-1).includes('chatty') ? Array.from({ length: 640 }, () => 'p'.repeat(1024 * 1024 - 1) + '\\n') : [];
const out = [lines[0], ...noise, ...lines.slice(1)];
(function next() { while (out.length > 0) { if (!process.stdout.write(out.shift())) { process.stdout.once('drain', next); return; } } })();`;

describe('a judge (a confined prompt) in a container of its own', () => {
  const SCHEMA = { type: 'object', properties: { answer: { type: 'object' } }, required: ['answer'] };
  let evidence: string;

  beforeEach(() => {
    engine.image(IMAGE, { claude: JUDGE_CLAUDE, codex: JUDGE_CODEX, node: '' });
    evidence = path.join(dir, 'runs', RUN, 'scratch', 'a0000beef');
    fs.mkdirSync(path.join(evidence, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(evidence, 'transcript.jsonl'), '{}\n');
    fs.writeFileSync(path.join(evidence, 'nested', 'diff.patch'), '');
  });

  /** Opens a confined prompt's place: no view of the host, and the credentials teamai gives the judge. */
  async function openJudge(connection: Connection, credentials: Record<string, string>): Promise<Message> {
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials });
    const first = await connection.next((message) => message.op === op && (message.event === 'accepted' || message.event === 'failed'));

    return first.event === 'failed' ? first : connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
  }

  async function judge(connection: Connection, { tool = 'claude', credentials, op = newOp(), lease = {}, ms = 30_000 }: { tool?: string; credentials: Record<string, string>; op?: string; lease?: Message; ms?: number }): Promise<Message> {
    connection.send({
      type: 'prompt', op, handle: HANDLE, env: {}, unset: [], credentials, cwd: evidence,
      lease: { step: 'review', tool, prompt: 'Judge the work in this directory.', result: path.join(dir, 'attempts', ATTEMPT, 'out', 'result.json'), permissions: 'approval-required', interactive: false, ...lease },
      confined: { dir: evidence, level: 'verified', access: 'read', schema: SCHEMA },
    });

    return connection.next((message) => message.op === op && ['finished', 'failed', 'cancelled'].includes(String(message.event)), ms);
  }

  const reasoning = (end: Message): { sees: string[]; names: string[]; given: string[]; argv?: string[]; schema?: string } => {
    const parsed: unknown = JSON.parse(String((end as { result: { output: { answer: { reasoning: string } } } }).result.output.answer.reasoning));

    return parsed as { sees: string[]; names: string[]; given: string[]; argv?: string[]; schema?: string };
  };

  // teamai gives a judge on a runtime the definition's credentials that a confined run of its tool reads: the common
  // names (proxies, CA files, PATH, HOME…) and its profile's own. The judge's tool gets every profile name but its home,
  // and none of the host's own: its one way out is the filter, and a host path means nothing in the container.
  it.each([
    { tool: 'claude', profile: BUILT_IN_TOOLS.claude.launch.claude.confined },
    { tool: 'codex', profile: BUILT_IN_TOOLS.codex.launch.codex.confined },
  ])("gives a $tool judge each name its confined profile reads but its home, and none of this machine's own", async ({ tool, profile }) => {
    const own = Object.fromEntries(profile.env.map((name) => [name, name.endsWith('_BASE_URL') ? 'https://given.llm.acme.internal/v1' : `given-${name.toLowerCase()}`]));
    const credentials = { ...own, HTTPS_PROXY: 'http://given-proxy.acme.internal:3128', HTTP_PROXY: 'http://given-proxy.acme.internal:3128', NO_PROXY: 'given.acme.internal', SSL_CERT_FILE: '/Users/given/ca.pem', NODE_EXTRA_CA_CERTS: '/Users/given/ca.pem', PATH: '/Users/given/bin', HOME: '/Users/given' };
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE }, 'unattended', { env: Object.keys(credentials), logins: [] });
    await openJudge(connection, credentials);

    expect(reasoning(await judge(connection, { tool, credentials })).given).toEqual(profile.env.filter((name) => name !== profile.homeEnv).sort());
  });

  it('offers no judge on podman, whose rootless network cannot hold the filter', async () => {
    const reply = await init(start(), { provider: 'podman', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(reply).not.toHaveProperty('confinedPrompt');
  });

  it("signs a codex judge in with an OPENAI_API_KEY under Codex's own variable, and points it at the base URL by its config", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { OPENAI_API_KEY: 'judge-key-2', OPENAI_BASE_URL: 'https://llm.acme.internal:8443/v1' };
    await openJudge(connection, credentials);
    const end = await judge(connection, { tool: 'codex', credentials });

    expect(reasoning(end).names).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY', 'HTTPS_PROXY']);
    expect(reasoning(end).argv).toEqual(expect.arrayContaining(['-c', 'openai_base_url="https://llm.acme.internal:8443/v1"']));
    // Claude's tool names would send Codex looking for tools it does not have.
    expect(JSON.stringify(reasoning(end).argv)).not.toMatch(/\b(Read|Grep|Glob)\b/);
    // The base URL reaches Codex from the container's env, never in teamai's argv.
    expect(JSON.stringify(engine.calls())).not.toContain('llm.acme.internal:8443/v1');
    expect(JSON.stringify(engine.calls())).not.toContain('judge-key-2');
  });

  it('reads a codex judge that prints more than one string holds before its reply, keeping only the start and the end of its stdout', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { OPENAI_API_KEY: 'judge-key-4' };
    await openJudge(connection, credentials);

    expect(await judge(connection, { tool: 'codex', credentials, lease: { prompt: 'Judge it, chatty as you like.' }, ms: 170_000 })).toMatchObject({ event: 'finished', session: { tool: 'codex', id: 'codex-thread-1' }, result: { output: { answer: { label: 'bad' } } } });
  }, 180_000);

  it('signs a codex judge in with a CODEX_API_KEY as it is given', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE }, 'unattended', { env: ['CODEX_API_KEY'], logins: [] });
    await openJudge(connection, { CODEX_API_KEY: 'judge-key-3' });

    expect(reasoning(await judge(connection, { tool: 'codex', credentials: { CODEX_API_KEY: 'judge-key-3' } })).names).toEqual(['CODEX_API_KEY', 'HTTPS_PROXY']);
  });

  it('reads the JSON answer of a codex judge that explains itself around it', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { OPENAI_API_KEY: 'judge-key-2' });

    expect(await judge(connection, { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' }, lease: { prompt: 'Judge it, and explain yourself.' } })).toMatchObject({ event: 'finished', result: { output: { answer: { label: 'bad' } } } });
  });

  it('accepts a codex reply after Codex reconnected on its way there', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { OPENAI_API_KEY: 'judge-key-2' });

    expect(await judge(connection, { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' }, lease: { prompt: 'Judge it over a flaky network.' } })).toMatchObject({ event: 'finished', result: { output: { answer: { label: 'bad' } } } });
  });

  it('keeps DNS and the host out of the judge network', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } });

    expect(engine.calls().find(([, command, action]) => command === 'network' && action === 'create')).toEqual(expect.arrayContaining(['--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true']));
  });

  it('says it answers confined prompts, and offers the tools the image holds at verified, with what each can do there', async () => {
    // Claude gets only its file tools; Codex runs with the container as its sandbox, so it can run commands there.
    expect(await init(start(), { provider: 'docker', image: IMAGE })).toMatchObject({
      ok: true, confinedPrompt: true, can: { confined: [{ level: 'verified', access: 'read', tools: ['claude'] }, { level: 'verified', access: 'full', tools: ['codex'] }] },
    });
  });

  it.each<{ env: string[]; logins: string[]; offered: Message[] }>([
    { env: ['ANTHROPIC_API_KEY'], logins: [], offered: [{ level: 'verified', access: 'read', tools: ['claude'] }] },
    { env: ['OPENAI_API_KEY', 'GITHUB_TOKEN'], logins: ['claude'], offered: [{ level: 'verified', access: 'full', tools: ['codex'] }] },
    { env: ['CODEX_API_KEY'], logins: [], offered: [{ level: 'verified', access: 'full', tools: ['codex'] }] },
  ])('offers a judge only on the tools whose credentials the definition names: $env', async ({ env, logins, offered }) => {
    expect(await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env, logins })).toMatchObject({ ok: true, confinedPrompt: true, can: { confined: offered } });
  });

  it.each<{ env: string[]; logins: string[] }>([
    { env: [], logins: ['claude', 'codex'] },
    { env: ['GITHUB_TOKEN'], logins: ['claude', 'codex'] },
  ])('offers no judge when it could sign none in, so teamai judges on a later runtime: $env $logins', async ({ env, logins }) => {
    const reply = await init(start(), { provider: 'docker', image: IMAGE }, 'unattended', { env, logins });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(reply).not.toHaveProperty('confinedPrompt');
    expect(reply.can).not.toHaveProperty('confined');
  });

  // Every spelling of this machine itself, with the port its host alias keeps.
  const LOOPBACK: Array<[string, string, string]> = [
    ['ANTHROPIC_BASE_URL', 'http://127.0.0.1:4000', 'http://host.docker.internal:4000'],
    ['ANTHROPIC_BASE_URL', 'http://localhost:4000/v1', 'http://host.docker.internal:4000/v1'],
    ['OPENAI_BASE_URL', 'http://[::1]:8080/v1', 'http://host.docker.internal:8080/v1'],
    ['OPENAI_BASE_URL', 'https://127.8.9.10/v1', 'https://host.docker.internal/v1'],
    ['ANTHROPIC_BASE_URL', 'http://localhost.:4000', 'http://host.docker.internal:4000'],
    ['OPENAI_BASE_URL', 'http://[::ffff:127.0.0.1]:8080/v1', 'http://host.docker.internal:8080/v1'],
    ['ANTHROPIC_BASE_URL', 'http://0.0.0.0:4000', 'http://host.docker.internal:4000'],
  ];

  it.each(LOOPBACK)("lets a judge whose %s points at this machine itself (%s) reach only that port of the host, through Docker Desktop's host alias", async (name, value, rewritten) => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', OPENAI_API_KEY: 'judge-key-2', [name]: value };
    await openJudge(connection, credentials);

    expect(await judge(connection, { tool: name.startsWith('OPENAI') ? 'codex' : 'claude', credentials })).toMatchObject({ event: 'finished' });
    const proxyRun = engine.calls().find((call) => call.includes(`${HANDLE}-proxy`) && call.includes('-d')) ?? [];
    const url = new URL(rewritten);

    expect(proxyRun.slice(-2)).toEqual(['3128', `host.docker.internal:${url.port || (url.protocol === 'http:' ? '80' : '443')}`]);
  });

  it("masks a base URL on this machine itself as the judge got it, in the reply teamai gets, since teamai masks only the value it gave", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    // The Codex judge takes its base URL in its argv, which the fake judge echoes into its reply.
    const credentials = { OPENAI_API_KEY: 'judge-key-2', OPENAI_BASE_URL: 'http://member:gateway-secret-2@127.0.0.1:4000/v1' };
    await openJudge(connection, credentials);
    const end = await judge(connection, { tool: 'codex', credentials });

    expect(end).toMatchObject({ event: 'finished' });
    expect(JSON.stringify(reasoning(end).argv)).toContain('<REDACTED:OPENAI_BASE_URL (in the sandbox)>');
    expect(JSON.stringify(connection.messages)).not.toContain('gateway-secret-2');
  });

  it.each(LOOPBACK)("refuses a judge whose %s points at this machine itself on Docker on Linux, which gives no host alias, naming the variable and never its value", async (name, value) => {
    const connection = start({ FAKE_ENGINE_OS: 'Ubuntu 24.04.1 LTS' });
    await init(connection, { provider: 'docker', image: IMAGE });
    const opened = await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1', OPENAI_API_KEY: 'judge-key-2', [name]: value });

    expect(opened).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: `credentials.${name}` } });
    const message = String((opened.failure as Message).message);

    expect(message).toContain(name);
    expect(message).toContain('Linux');
    expect(message).not.toContain(new URL(value).hostname.replace(/\.$/, ''));
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it('mounts the evidence at /evidence alone, and names it there in the prompt, so the judge never sees where it lives on the host', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const end = await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, lease: { prompt: `Read only the files under ${evidence}:\nthe diff in ${evidence}/nested/diff.patch, and the schema in ${evidence}/answer.schema.json.` } });
    const seen = reasoning(end);
    const judgeRun = engine.calls().find((call) => call.includes(HANDLE) && call.includes('-d')) ?? [];
    const toolExec = engine.calls().find(([, command]) => command === 'exec') ?? [];

    expect(seen.sees).toEqual(['nested/diff.patch', 'transcript.jsonl']);
    expect(judgeRun.filter((arg, index) => judgeRun[index - 1] === '-v')).toEqual([`${evidence}:/evidence:ro`]);
    expect(toolExec.slice(toolExec.indexOf('-w'), toolExec.indexOf('-w') + 2)).toEqual(['-w', '/evidence']);
    expect(seen.argv).toEqual(expect.arrayContaining(['Read only the files under /evidence:\nthe diff in /evidence/nested/diff.patch, and the schema in /evidence/answer.schema.json.']));
    expect(JSON.stringify(seen.argv)).not.toContain(dir);
  });

  it("leaves a sibling of the evidence directory as the prompt wrote it, since it is not what the judge sees at /evidence", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const { argv = [] } = reasoning(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, lease: { prompt: `Read ${evidence}/diff.patch, not ${evidence}-old/diff.patch nor ${evidence}.bak, and end at ${evidence}.` } }));

    expect(argv).toContain(`Read /evidence/diff.patch, not ${evidence}-old/diff.patch nor ${evidence}.bak, and end at /evidence.`);
  });

  it('offers no confined prompt from an image without node, which runs the network filter', async () => {
    engine.image('ghcr.io/acme/native-claude:1', { claude: JUDGE_CLAUDE });
    const reply = await init(start(), { provider: 'docker', image: 'ghcr.io/acme/native-claude:1' });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude'] } });
    expect(reply).not.toHaveProperty('confinedPrompt');
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('answers with only the evidence directory mounted, read-only, on a network that reaches only the model provider, and reports verified', async () => {
    const connection = start({ GITHUB_TOKEN: 'forge-value-1' });
    await init(connection, { provider: 'docker', image: IMAGE });

    expect(await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' })).toMatchObject({ event: 'ready' });
    // Nothing is created before the prompt names its directory.
    expect(engine.containers()).toEqual([]);

    const end = await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, lease: { model: { name: 'claude-sonnet-4-5' } } });

    expect(end).toMatchObject({
      event: 'finished', session: { tool: 'claude', id: 'claude-session-1' }, result: { output: { answer: { label: 'good' } } },
      usage: { input: 12, output: 5 }, confined: { level: 'verified', access: 'read' },
    });
    const seen = reasoning(end);

    expect(seen.sees).toEqual(['nested/diff.patch', 'transcript.jsonl']);
    expect(seen.names).toEqual(['ANTHROPIC_API_KEY', 'HTTPS_PROXY']);
    expect(seen.argv).toEqual(expect.arrayContaining(['--tools', 'Read,Grep,Glob', '--model', 'claude-sonnet-4-5', '--json-schema', JSON.stringify(SCHEMA)]));

    const runs = engine.calls().filter(([, command, detached]) => command === 'run' && detached === '-d');
    const judgeRun = runs.find((call) => call.includes(HANDLE)) ?? [];
    const proxyRun = runs.find((call) => call.includes(`${HANDLE}-proxy`)) ?? [];

    // Only the evidence directory, read-only.
    expect(judgeRun.filter((arg, index) => judgeRun[index - 1] === '-v')).toEqual([`${evidence}:/evidence:ro`]);
    expect(judgeRun.join(' ')).toContain(`--network ${HANDLE}-net`);
    expect(judgeRun.join(' ')).toContain('--cap-drop ALL');
    expect(engine.calls()).toContainEqual(['docker', 'network', 'create', '--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true', '-o', 'com.docker.network.enable_ipv6=false', '--label', `teamai.run=${RUN}`, '--label', `teamai.attempt=${ATTEMPT}`, '--label', expect.stringMatching(/^teamai\.owner=[0-9a-f]{16}$/), `${HANDLE}-net`]);
    // The filter in front of that network lets through only the provider's host.
    expect(proxyRun.at(-2)).toBe('3128');
    expect(proxyRun.at(-1)).toBe('api.anthropic.com:443');
    expect(proxyRun.filter((arg, index) => proxyRun[index - 1] === '-v')).toEqual([]);
    expect(engine.calls()).toContainEqual(['docker', 'network', 'connect', `${HANDLE}-net`, `${HANDLE}-proxy`]);
    expect(JSON.stringify(engine.calls())).not.toContain('judge-key-1');

    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it.each<{ tool: string; credentials: Record<string, string> }>([
    { tool: 'claude', credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } },
    { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' } },
  ])('tells a $tool judge it may list, search and read the files it judges', async ({ tool, credentials }) => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, credentials);
    const { argv = [] } = reasoning(await judge(connection, { tool, credentials }));

    expect(argv.at(-1)).toContain('List, search and read the files in this directory');
  });

  it('lets a judge reach only the base URL its credentials name, in place of the public API', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', ANTHROPIC_BASE_URL: 'https://llm-gateway.acme.internal:8443/anthropic' };
    await openJudge(connection, credentials);

    expect(await judge(connection, { credentials })).toMatchObject({ event: 'finished' });
    const proxyRun = engine.calls().find((call) => call.includes(`${HANDLE}-proxy`) && call.includes('-d')) ?? [];

    expect(proxyRun.slice(-2)).toEqual(['3128', 'llm-gateway.acme.internal:8443']);
  });

  it('judges on codex with its reply schema, and returns its own session', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { OPENAI_API_KEY: 'judge-key-2' });
    const end = await judge(connection, { tool: 'codex', credentials: { OPENAI_API_KEY: 'judge-key-2' } });

    expect(end).toMatchObject({
      event: 'finished', session: { tool: 'codex', id: 'codex-thread-1' }, result: { output: { answer: { label: 'bad' } } },
      usage: { input: 30, output: 7, cachedInput: 10 }, confined: { level: 'verified', access: 'full' },
    });
    expect(JSON.parse(String(reasoning(end).schema))).toEqual(SCHEMA);
    expect(reasoning(end).sees).toEqual(['nested/diff.patch', 'transcript.jsonl']);
    expect((engine.calls().find((call) => call.includes(`${HANDLE}-proxy`) && call.includes('-d')) ?? []).at(-1)).toBe('api.openai.com:443');
  });

  it('refuses a judge that brings no credential, as a login-only definition, naming the env credential to add', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const opened = await openJudge(connection, {});

    expect(opened).toMatchObject({ event: 'failed', failure: { code: 'credential_missing' } });
    expect(String((opened.failure as Message).message)).toMatch(/OPENAI_API_KEY: env:OPENAI_API_KEY/);
    expect(String((opened.failure as Message).message)).toMatch(/codex: login/);
    expect(engine.containers()).toEqual([]);
  });

  it('fails a judge whose container the engine could not create with that failure, before its tool ran, and close leaves nothing', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    engine.daemon(false);

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } })).toMatchObject({ event: 'failed', failure: { code: 'sandbox_failed' } });
    expect(engine.calls().filter(([, command]) => command === 'exec')).toEqual([]);
    engine.daemon(true);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it.each<{ shell: NodeJS.ProcessEnv; named: string }>([
    { shell: { ANTHROPIC_API_KEY: 'shell-key' }, named: 'ANTHROPIC_API_KEY' },
    { shell: { ANTHROPIC_AUTH_TOKEN: 'shell-token', CLAUDE_CODE_OAUTH_TOKEN: '' }, named: 'ANTHROPIC_AUTH_TOKEN' },
    { shell: {}, named: 'CLAUDE_CODE_OAUTH_TOKEN' },
  ])("points a Claude judge that brings no sign-in at $named, the one your shell sets first", async ({ shell, named }) => {
    const connection = start(shell);
    await init(connection, { provider: 'docker', image: IMAGE });
    const opened = await openJudge(connection, {});

    expect(String((opened.failure as Message).message)).toContain(`for example ${named}: env:${named} for Claude`);
    await openJudge(connection, { OPENAI_API_KEY: 'judge-key-1' });
    const end = await judge(connection, { credentials: { OPENAI_API_KEY: 'judge-key-1' } });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'credential_missing', message: expect.stringContaining(`for example ${named}: env:${named}.`) } });
    expect(JSON.stringify(connection.messages)).not.toContain('shell-');
  });

  it("refuses a judge whose credentials are not its tool's, before it starts anything", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const end = await judge(connection, { tool: 'codex', credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } });

    expect(end).toMatchObject({ event: 'failed', failure: { code: 'credential_missing', message: expect.stringContaining('OPENAI_API_KEY') } });
    expect(engine.containers()).toEqual([]);
  });

  it('answers a repeated prompt id with the same outcome, and reattach reports it', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const op = newOp();
    const first = await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op });

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op })).toEqual(first);
    // The tool ran once.
    expect(engine.calls().filter(([, command]) => command === 'exec')).toHaveLength(1);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'alive' || message.event === 'gone')).toMatchObject({ event: 'alive', ops: [{ op, state: 'finished', session: { tool: 'claude' } }] });
  });

  it("answers a prompt whose judge's place record it cannot read with that prompt's failure, never silence", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const record = journalFiles().find((file) => file.includes(`${path.sep}places${path.sep}`)) ?? '';
    const intact = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, '{"run":');

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, ms: 5_000 })).toMatchObject({ event: 'failed', failure: { code: 'runtime_failed', message: expect.stringContaining(record) } });
    expect(connection.messages.filter((message) => message.event === 'error')).toEqual([]);
    // Mended, the place closes as any other.
    fs.writeFileSync(record, intact);
  });

  it('leaves no container, filter, network or record when teamai closes a judge while its container is being created', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    engine.delay('run', 1_000);
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } } });
    await vi.waitFor(() => { expect(engine.calls().some(([, command, ...rest]) => command === 'run' && rest.includes(`${HANDLE}-proxy`))).toBe(true); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE });

    expect(await ended).toEqual({ op, event: 'cancelled' });
    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
    expect(journalFiles()).toEqual([]);
    expect(engine.calls().filter(([, command]) => command === 'exec')).toEqual([]);
  }, 60_000);

  it("removes the judge's container a cancel overtook while it was being created, and close removes the rest", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    engine.delay('run', 1_000);
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } } });
    await vi.waitFor(() => { expect(engine.calls().some(([, command, ...rest]) => command === 'run' && rest[rest.indexOf('--name') + 1] === HANDLE)).toBe(true); }, { timeout: 10_000 });

    connection.send({ type: 'cancel', op });

    expect(await ended).toEqual({ op, event: 'cancelled' });
    expect(engine.containers()).toEqual([`${HANDLE}-proxy`]);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  }, 60_000);

  it("answers a judge's cancel within 10 s with cancel_failed and how to remove it when the engine's removal stalls", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } }, ms: 15_000 });
    await vi.waitFor(() => { expect(engine.calls().some(([, command]) => command === 'exec')).toBe(true); }, { timeout: 10_000 });
    engine.delay('rm', 60_000);
    const sent = Date.now();

    connection.send({ type: 'cancel', op });

    expect(await ended).toMatchObject({ op, event: 'failed', failure: { code: 'cancel_failed', message: expect.stringContaining('docker rm --force') } });
    expect(Date.now() - sent).toBeLessThan(10_500);
    engine.delay('rm', 0);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && message.event !== 'ready', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  }, 60_000);

  it("labels a judge's container, its filter and its network with the journal that owns its place", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } } });
    await vi.waitFor(() => { expect(engine.containers().sort()).toEqual([HANDLE, `${HANDLE}-proxy`]); }, { timeout: 10_000 });

    const owner = engine.labelsOf(HANDLE)?.['teamai.owner'];
    const network = engine.calls().find(([, command, action]) => command === 'network' && action === 'create') ?? [];

    expect(owner).toMatch(/^[0-9a-f]{16}$/);
    expect(engine.labelsOf(`${HANDLE}-proxy`)?.['teamai.owner']).toBe(owner);
    expect(network.join(' ')).toContain(`--label teamai.owner=${owner}`);
    connection.send({ type: 'cancel', op });
    expect(await ended).toEqual({ op, event: 'cancelled' });
  });

  it('ends a judge cancelled, with nothing left running, when its cancel removes the container while its exec is still starting', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    engine.holdExec(3_000);
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } } });
    await vi.waitFor(() => { expect(engine.calls().some(([, command]) => command === 'exec')).toBe(true); }, { timeout: 10_000 });

    connection.send({ type: 'cancel', op });

    expect(await ended).toEqual({ op, event: 'cancelled' });
    expect(engine.containers()).toEqual([`${HANDLE}-proxy`]);
  });

  it('stops a judge on cancel', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    const op = newOp();
    const ended = judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' }, op, lease: { model: { name: '--hang' } } });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await new Promise((resolve) => setTimeout(resolve, 500));
    connection.send({ type: 'cancel', op });

    expect(await ended).toEqual({ op, event: 'cancelled' });
    // The judge's container is gone, so an exec still on its way to the engine has nothing to start in.
    expect(engine.containers()).toEqual([`${HANDLE}-proxy`]);
  });

  it('keeps a numeric score when a setting the judge is given is a number, and its place still closes', async () => {
    engine.image(IMAGE, { node: '', claude: `if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 'claude-session-1', result: '', structured_output: { answer: { label: 'good', score: 1, passed: true } } }));` });
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' };
    await openJudge(connection, credentials);

    expect(await judge(connection, { credentials, ms: 10_000 })).toMatchObject({ event: 'finished', result: { output: { answer: { label: 'good', score: 1, passed: true } } } });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
  });

  it("answers a judge's prompt resent to a restarted runtime that offers no judge as still running, and close ends it cancelled and removes its container", async () => {
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1' };
    const lease = { model: { name: '--hang' } };
    const first = start();
    await init(first, { provider: 'docker', image: IMAGE });
    await openJudge(first, credentials);
    const op = newOp();
    judge(first, { credentials, op, lease }).catch(() => {});
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(engine.calls().some(([, command]) => command === 'exec')).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();
    // The definition now gives this runtime no judge key, so it offers no judge.
    const second = start();
    const reinit = await init(second, { provider: 'docker', image: IMAGE }, 'unattended', { env: [], logins: ['codex'] });

    expect(reinit).toMatchObject({ ok: true, can: { tools: ['codex'] } });
    expect(reinit).not.toHaveProperty('confinedPrompt');

    // The runtime that ran it is gone, but its judge may still run: the resent id is accepted, and its end waits for a stop.
    const resent = judge(second, { credentials, op, lease });
    await second.next((message) => message.op === op && message.event === 'accepted');
    second.send({ type: 'close', handle: HANDLE });

    expect(await resent).toEqual({ op, event: 'cancelled' });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000)).toEqual({ event: 'closed', handle: HANDLE });
    // closed follows the op's last line.
    expect(second.messages.findIndex((message) => message.op === op && message.event === 'cancelled')).toBeLessThan(second.messages.findIndex((message) => message.event === 'closed'));
    expect(engine.containers()).toEqual([]);
    expect(engine.networks()).toEqual([]);
  });

  it("gives a judge only its own tool's credentials", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    const credentials = { ANTHROPIC_API_KEY: 'judge-key-1', OPENAI_API_KEY: 'judge-key-2' };
    await openJudge(connection, credentials);

    expect(reasoning(await judge(connection, { credentials })).names).toEqual(['ANTHROPIC_API_KEY', 'HTTPS_PROXY']);
  });

  it("refuses an exec in a judge's place", async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openJudge(connection, { ANTHROPIC_API_KEY: 'judge-key-1' });
    await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } });

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: evidence })).end).toMatchObject({ event: 'failed', failure: { code: 'bad_request' } });
    expect(engine.calls().filter(([, command]) => command === 'exec')).toHaveLength(1);
  });

  it('offers no judge on a docker that lets DNS out of an internal network', async () => {
    const reply = await init(start({ FAKE_ENGINE_VERSION: '25.0.3' }), { provider: 'docker', image: IMAGE });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(reply.can).not.toHaveProperty('confined');
  });

  it('refuses a confined prompt in a place opened with a view of the host', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE });
    await openPlace(connection, place());

    expect(await judge(connection, { credentials: { ANTHROPIC_API_KEY: 'judge-key-1' } })).toMatchObject({ event: 'failed', failure: { code: 'bad_request' } });
  });
});

// ─── sbx (Docker Sandboxes): a microVM per attempt, from the agent's template ───

const SBX_CODEX = `if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
const fs = require('node:fs'); const path = require('node:path');
// Codex signs in from its home's auth.json, or from OPENAI_API_KEY, here the placeholder sbx's proxy swaps for the stored login.
const login = fs.existsSync(path.join(process.env.CODEX_HOME, 'auth.json')) ? 'file' : process.env.OPENAI_API_KEY === 'proxy-managed' ? 'proxy' : 'none';
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'sessions', 'rollout.jsonl'), '{}\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-1', login }));
process.exit(login === 'none' ? 1 : 0);`;

describe('an attempt in an sbx sandbox', () => {
  beforeEach(() => {
    engine.image('claude', { claude: CLAUDE });
    engine.image('codex', { codex: SBX_CODEX });
    engine.image('shell', {});
  });

  /** The attempt's sandbox name: the journal that owns it, then the run and the attempt. */
  const SANDBOX = new RegExp(`^teamai-[0-9a-f]{16}-${RUN}-${ATTEMPT}$`);

  /** The name of the attempt's sandbox, once it exists. */
  const sandbox = (): string => engine.containers().find((name) => SANDBOX.test(name)) ?? 'none';

  it('fails init on agent: shell, since the bare shell template holds no agent, naming the key', async () => {
    const reply = await init(start(), { provider: 'sbx', agent: 'shell' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'agent' } });
    expect(JSON.stringify(reply)).toMatch(/agent: claude/);
  });

  it("offers claude, codex and opencode with no agent, and starts each attempt from its own tool's template, a command step's from the bare shell", async () => {
    engine.secret('anthropic', true);
    engine.secret('openai', true);
    const connection = start();

    // OpenCode needs no sign-in: it runs its free models.
    expect(await init(connection, { provider: 'sbx' }, 'unattended', { env: [], logins: [] })).toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'opencode'] } });
    const at = place();
    const templates: string[] = [];

    for (const tool of ['claude', 'codex', undefined]) {
      const op = newOp();
      connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, ...(tool && { tool }), credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: {} } });
      expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });
      // `sbx create --name <name> --no-progress <template> <paths…>`
      const create = engine.calls().findLast(([name, command]) => name === 'sbx' && command === 'create') ?? [];
      templates.push(create[create.indexOf('--no-progress') + 1] ?? 'none');
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000);
    }

    expect(templates).toEqual(['claude', 'codex', 'shell']);
  });

  it('starts on the sandbox profile the teamai-sandbox definition teamai ships runs, teamai-default, on sbx, with each tool sbx keeps a login for', async () => {
    const shipped = z.object({ name: z.string(), runtimes: z.array(z.object({ use: z.string(), sandbox: z.string().optional(), options: z.record(z.string(), z.json()).default({}) })) })
      .parse(parse(fs.readFileSync(path.join(REPO, 'drivers', 'teamai-sandbox.yaml'), 'utf8')));
    // An entry that names no profile runs profile default, which is teamai's teamai-default until a team or member replaces it.
    const options = z.record(z.string(), z.json()).parse(parse(fs.readFileSync(path.join(REPO, 'sandboxes', 'teamai-default.yaml'), 'utf8')));
    engine.secret('anthropic', true);

    expect(shipped).toMatchObject({ name: 'teamai-sandbox', runtimes: [{ use: 'sandbox', options: { max_parallel: 4 } }, { use: 'tools' }] });
    expect(shipped.runtimes[0]?.sandbox).toBeUndefined();
    expect(await init(start(), { ...options, profile: { name: 'teamai-default', revision: 'r' } }, 'unattended', { env: [], logins: [] })).toMatchObject({ ok: true, can: { tools: ['claude', 'opencode'] }, unavailable: { codex: expect.stringContaining('sbx secret set openai') } });
  });

  it.each([
    { secrets: ['anthropic'], ownLogins: ['claude'] },
    { secrets: ['anthropic', 'openai'], ownLogins: ['claude', 'codex'] },
  ])('names in ownLogins each tool sbx keeps a login for: $ownLogins', async ({ secrets, ownLogins }) => {
    for (const service of secrets) engine.secret(service, true);

    expect(await init(start(), { provider: 'sbx' }, 'unattended', { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'], logins: [] }))
      .toMatchObject({ ok: true, can: { tools: ['claude', 'codex', 'opencode'] }, ownLogins });
  });

  it('runs a Claude step from the claude template with no agent, and a command step in that same sandbox', async () => {
    engine.secret('anthropic', true);
    const connection = start();
    await init(connection, { provider: 'sbx' }, 'unattended', { env: [], logins: [] });
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'claude', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);

    expect((await exec(connection, { argv: ['claude', '--version'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: '2.1.0 (Claude Code)\n' });
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo ok'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: 'ok\n' });
  });

  it('fails an open with bad_option on agent when no agent is set and its tool has no sbx template, before it creates anything', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx' });
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'codebuddy', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: {} } });

    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'agent', message: expect.stringContaining('codebuddy') } });
    expect(engine.containers()).toEqual([]);
  });

  it("fails init on an option sbx does not take, as a container's image", async () => {
    expect(await init(start(), { provider: 'sbx', agent: 'claude', image: IMAGE })).toMatchObject({ ok: false, error: { code: 'bad_option', key: 'image' } });
  });

  it('fails init with sandbox_unavailable and how to install it when sbx is not on PATH', async () => {
    const empty = path.join(dir, 'empty-bin');
    fs.mkdirSync(empty);
    const reply = await init(start({ PATH: empty }), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    expect(JSON.stringify(reply)).toContain('Docker Sandboxes');
  });

  it('fails init with sandbox_unavailable when sandboxd is down, with what sbx said and the command that starts it', async () => {
    engine.daemon(false);
    const reply = await init(start(), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringContaining('cannot connect to sandboxd') } });
    expect(JSON.stringify(reply)).toContain('sbx daemon start');
  });

  it('fails init with sandbox_unavailable, naming the command, when no network policy was ever set, and never sets one itself', async () => {
    engine.policy(false);
    const reply = await init(start(), { provider: 'sbx', agent: 'claude' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringContaining('sbx policy init balanced') } });
    expect(engine.calls().filter(([name, command, action]) => name === 'sbx' && command === 'policy' && action !== 'ls')).toEqual([]);
  });

  it("offers a sandbox with the agent's tool, no network, and no judge", async () => {
    const reply = await init(start(), { provider: 'sbx', agent: 'codex' }, 'unattended', { env: ['OPENAI_API_KEY'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { isolation: 'sandbox', env: true, unattended: true, setup: true, workspace: ['read-only', 'new', 'continue', 'clone', 'team'], tools: ['codex'] } });
    expect(reply.can).not.toHaveProperty('network');
    expect(reply.can).not.toHaveProperty('confined');
    expect(reply).not.toHaveProperty('confinedPrompt');
  });

  it("names each sandbox after the journal that owns it, with the id a container's teamai.owner label carries, and reaches it by that name only", async () => {
    const docker = start();
    await init(docker, { provider: 'docker', image: IMAGE });
    await openPlace(docker, place());
    const owner = engine.labelsOf(HANDLE)?.['teamai.owner'];
    docker.send({ type: 'close', handle: HANDLE });
    await docker.next((message) => message.event === 'closed');
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    const { accepted, ready } = await openPlace(connection, at);
    const name = `teamai-${owner}-${RUN}-${ATTEMPT}`;

    expect(owner).toMatch(/^[0-9a-f]{16}$/);
    // The handle teamai holds stays the attempt's; only sbx's name carries the journal.
    expect(accepted.handle).toBe(HANDLE);
    expect(engine.containers()).toEqual([name]);
    expect(ready).toMatchObject({ display: { label: `${name} (sbx)`, fields: { sandbox: name } } });
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo ran'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    engine.failRemove(true);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'close_failed')).toMatchObject({ failure: { message: expect.stringContaining(`sbx rm --force ${name}`) } });
    engine.failRemove(false);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    expect(new Set(engine.calls().filter(([tool]) => tool === 'sbx').flat().filter((arg) => arg.startsWith('teamai-')))).toEqual(new Set([name]));
  });

  it("removes, at an open, a sandbox named for this journal whose attempt it no longer records, and keeps one it records, another journal's and one named the old way", async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    await openPlace(connection, place());
    const own = sandbox();
    const journalPrefix = own.slice(0, -`${RUN}-${ATTEMPT}`.length);
    // What a runtime killed while sbx created a sandbox leaves, for this journal, another journal, and an older teamai.
    const left = [`${journalPrefix}${RUN}-a00000002`, `teamai-0123456789abcdef-${RUN}-a00000003`, `teamai-${RUN}-a00000004`];
    planted(...left.slice(1));

    for (const name of left) execFileSync(path.join(engine.bin, 'sbx'), ['create', '--name', name, '--no-progress', 'claude'], { env: engine.env() });

    expect((await openPlace(connection, place())).ready).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => { expect(engine.containers().sort()).toEqual([own, ...left.slice(1)].sort()); }, { timeout: 10_000 });
    expect(engine.calls()).toContainEqual(['sbx', 'rm', '--force', left[0]]);
    expect(connection.stderr()).toBe('');
  });

  it("opens one sandbox per attempt from the agent's template, at the place's host paths, git paths read-only, with no credential, and shows it in the dashboard", async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    const { accepted, ready } = await openPlace(connection, at, newOp(), { credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' } });

    expect(accepted.handle).toBe(HANDLE);
    expect(ready).toMatchObject({ event: 'ready', display: { label: `${sandbox()} (sbx)`, fields: { sandbox: sandbox(), agent: 'claude' } } });
    // A new open of the same attempt finds that sandbox by its name instead of creating a second.
    expect((await openPlace(connection, at)).ready).toMatchObject({ event: 'ready' });
    expect(engine.containers()).toEqual([expect.stringMatching(SANDBOX)]);

    const creates = engine.calls().filter(([name, command]) => name === 'sbx' && command === 'create');

    expect(creates).toHaveLength(1);
    // The worktree is the primary workspace; every other path keeps its host path, the git paths read-only.
    expect(creates[0]).toEqual(['sbx', 'create', '--name', sandbox(), '--no-progress', 'claude', at.worktree, at.result, at.runDir, at.toolHome, `${at.git}:ro`]);
    expect(JSON.stringify(engine.calls())).not.toContain('oauth-value-1');
    expect(fs.existsSync(at.toolHome)).toBe(true);
  });

  it('runs an exec with its credentials by name only, unsets the withheld names, and keeps the rest of the sandbox env', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);
    const script = 'token=unset; case "${CLAUDE_CODE_OAUTH_TOKEN-}" in oauth-value-[1]) token=given;; esac; printf "%s|%s|%s|%s" "${STEP_VALUE-unset}" "$token" "${GH_TOKEN-unset}" "$(pwd)"; exit 4';

    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], env: { STEP_VALUE: 'step-value-1' }, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-value-1' }, cwd: at.worktree })).end)
      .toEqual({ op: expect.any(String), event: 'exited', code: 4, stdout: `step-value-1|given|proxy-managed|${at.worktree}` });
    // A strict step withholds the forge names, which sbx's own env sets as placeholders.
    expect((await exec(connection, { argv: ['/bin/sh', '-c', script], unset: ['GH_TOKEN'], cwd: at.worktree })).end).toMatchObject({ stdout: `unset|unset|unset|${at.worktree}` });
    expect(JSON.stringify(engine.calls())).not.toMatch(/oauth-value-1|step-value-1/);
    expect(journalFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n')).not.toContain('oauth-value-1');
  });

  it("runs codex on the login sbx's proxy holds (sbx secret set openai --oauth), with no login file in the attempt's tool home", async () => {
    engine.secret('openai', true);
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'codex' });
    const at = { ...place(), toolHome: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'codex') };
    connection.send({ type: 'open', op: newOp(), run: RUN, attempt: ATTEMPT, credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CODEX_HOME: at.toolHome } } });
    await connection.next((message) => message.event === 'ready' || message.event === 'failed', 30_000);

    const { end } = await exec(connection, { argv: ['codex', 'exec', '--json', 'Review it.'], env: { CODEX_HOME: at.toolHome }, cwd: at.worktree });

    expect(end).toMatchObject({ event: 'exited', code: 0, stdout: expect.stringContaining('"login":"proxy"') });
    expect(fs.existsSync(path.join(at.toolHome, 'sessions', 'rollout.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(at.toolHome, 'auth.json'))).toBe(false);
  });

  it("signs Claude in on the login sbx keeps while its config dir is the attempt's tool home, with no credential on the host's disk", async () => {
    // Claude reads its sign-in from its config dir, where sbx's template keeps the stand-in its proxy swaps for the login.
    engine.image('claude', { claude: "const fs = require('node:fs'); const signedIn = fs.existsSync(`${process.env.CLAUDE_CONFIG_DIR}/.credentials.json`); console.log(signedIn ? 'signed in' : 'Not logged in · Please run /login'); process.exit(signedIn ? 0 : 1);" });
    engine.secret('anthropic', true);
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' }, 'unattended', { env: [], logins: [] });
    const at = place();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['claude', '-p', 'Fix it.'], env: { CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: 'signed in\n' });
    // Only a link into the sandbox's own home is on the host, never the file.
    expect(fs.lstatSync(path.join(at.toolHome, '.credentials.json')).isSymbolicLink()).toBe(true);
  });

  it('runs an exec in a sandbox sbx stopped while idle, and keeps its start notice out of the stdout', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);
    // sbx stops an idle sandbox on its own.
    const stop = execFileSync(path.join(engine.bin, 'sbx'), ['stop', sandbox()], { env: engine.env(), encoding: 'utf8' });

    expect(stop).toContain('Stopped');
    const op = newOp();

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'claude --version; echo step-err >&2'], cwd: at.worktree }, op)).end).toMatchObject({ event: 'exited', code: 0, stdout: '2.1.0 (Claude Code)\n' });
    expect(connection.messages.filter((message) => message.op === op && message.stream === 'stderr').map((message) => message.data).join('')).toBe('step-err\n');
  });

  it("keeps the sandbox's own HOME when an exec names one, and still reaches sbx", async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);

    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'printf "%s" "$HOME"'], env: { HOME: path.join(dir, 'elsewhere') }, cwd: at.worktree })).end)
      .toMatchObject({ event: 'exited', code: 0, stdout: expect.not.stringContaining('elsewhere') });
  });

  it.each<{ tool: string; command: string; variable: string }>([
    { tool: 'claude', command: 'sbx run claude <any dir>', variable: 'CLAUDE_CODE_OAUTH_TOKEN' },
    { tool: 'codex', command: 'sbx secret set openai --oauth', variable: 'OPENAI_API_KEY' },
  ])("offers no $tool when it could not sign in, naming the sbx command, so no step starts and answers \"Not logged in\"", async ({ tool, command, variable }) => {
    const reply = await init(start(), { provider: 'sbx', agent: tool }, 'unattended', { env: ['GITHUB_TOKEN'], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { tools: [] } });
    const reason = String((reply.unavailable as Message)[tool]);

    expect(reason).toContain(`\`${command}\``);
    expect(reason).toContain(`${variable}: env:${variable}`);
    expect(engine.calls().filter(([name, subcommand]) => name === 'sbx' && subcommand === 'create')).toEqual([]);
  });

  it('runs a command step in a sandbox where no tool can sign in', async () => {
    const connection = start();

    expect(await init(connection, { provider: 'sbx', agent: 'claude' }, 'unattended', { env: [], logins: [] })).toMatchObject({ ok: true, can: { tools: [] } });
    const at = place();

    expect((await openPlace(connection, at)).ready).toMatchObject({ event: 'ready' });
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo built > BUILT.md'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    expect(fs.readFileSync(path.join(at.worktree, 'BUILT.md'), 'utf8')).toBe('built\n');
  });

  describe("a gateway your shell sets, which sbx's login replaces", () => {
    const GATEWAY = 'http://127.0.0.1:4000/anthropic';

    /** Opens the attempt's place for `tool`, then its notices about that open. */
    async function openFor(connection: Connection, tool: string, credentials: Record<string, string> = {}): Promise<Message[]> {
      const at = place();
      const op = newOp();
      connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool, credentials, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
      expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000);

      return connection.messages.filter((message) => message.op === op && message.event === 'notice');
    }

    it('says once, at the first Claude attempt, that the gateway is not used in the sandbox and how to use it there, never its value', async () => {
      engine.secret('anthropic', true);
      const connection = start({ ANTHROPIC_BASE_URL: GATEWAY });
      await init(connection, { provider: 'sbx' }, 'unattended', { env: [], logins: [] });
      const first = await openFor(connection, 'claude');

      expect(first).toEqual([expect.objectContaining({ event: 'notice', message: expect.stringContaining('ANTHROPIC_BASE_URL: env:ANTHROPIC_BASE_URL') })]);
      expect(JSON.stringify(first)).toContain('sbx secret ls');
      expect(JSON.stringify(first)).not.toContain('127.0.0.1');
      expect(await openFor(connection, 'claude')).toEqual([]);
    });

    it.each<{ name: string; env: NodeJS.ProcessEnv; tool: string; credentials: Record<string, string> }>([
      { name: 'the definition gives the gateway to the step', env: { ANTHROPIC_BASE_URL: GATEWAY }, tool: 'claude', credentials: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_AUTH_TOKEN: 'gateway-token' } },
      { name: "the definition signs Claude in on a key of its own, not on sbx's login", env: { ANTHROPIC_BASE_URL: GATEWAY }, tool: 'claude', credentials: { ANTHROPIC_API_KEY: 'definition-key' } },
      { name: 'your shell sets no gateway', env: {}, tool: 'claude', credentials: {} },
      { name: 'the attempt runs another tool', env: { ANTHROPIC_BASE_URL: GATEWAY }, tool: 'codex', credentials: {} },
    ])('says nothing when $name', async ({ env, tool, credentials }) => {
      engine.secret('anthropic', true);
      engine.secret('openai', true);
      engine.allowNetwork('localhost:4000');
      const connection = start(env);
      await init(connection, { provider: 'sbx' }, 'unattended', { env: Object.keys(credentials), logins: [] });

      expect(await openFor(connection, tool, credentials)).toEqual([]);
    });
  });

  it.each<{ tool: string; service: string; credentials: InitCredentials }>([
    { tool: 'claude', service: 'anthropic', credentials: { env: [], logins: [] } },
    { tool: 'codex', service: 'openai', credentials: { env: [], logins: [] } },
  ])('offers $tool on the login sbx keeps for $service, with no credential named', async ({ tool, service, credentials }) => {
    engine.secret(service, true);

    expect(await init(start(), { provider: 'sbx', agent: tool }, 'unattended', credentials)).toMatchObject({ ok: true, can: { tools: [tool] } });
  });

  it.each<{ tool: string; credentials: InitCredentials }>([
    { tool: 'claude', credentials: { env: ['CLAUDE_CODE_OAUTH_TOKEN'], logins: [] } },
    { tool: 'claude', credentials: { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'], logins: [] } },
    { tool: 'codex', credentials: { env: ['CODEX_API_KEY'], logins: [] } },
    { tool: 'codex', credentials: { env: [], logins: ['codex'] } },
  ])('offers $tool on a credential teamai gives it by name, with no login sbx keeps: $credentials.env $credentials.logins', async ({ tool, credentials }) => {
    expect(await init(start(), { provider: 'sbx', agent: tool }, 'unattended', credentials)).toMatchObject({ ok: true, can: { tools: [tool] } });
  });

  it("gives a step a base URL on this machine itself as host.docker.internal when sbx's policy lets a sandbox reach that port", async () => {
    engine.allowNetwork('localhost:4000');
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    const credentials = { ANTHROPIC_AUTH_TOKEN: 'gateway-token-1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000/anthropic' };

    expect((await openPlace(connection, at, newOp(), { credentials })).ready).toMatchObject({ event: 'ready' });
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'printf %s "$ANTHROPIC_BASE_URL" > base-url.txt'], credentials, cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0 });
    expect(fs.readFileSync(path.join(at.worktree, 'base-url.txt'), 'utf8')).toBe('http://host.docker.internal:4000/anthropic');
  });

  it("fails the open, naming the sbx rule with the real port, when sbx's policy does not let a sandbox reach it, and never edits the policy", async () => {
    engine.allowNetwork('localhost:4000');
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { ANTHROPIC_AUTH_TOKEN: 'gateway-token-1', ANTHROPIC_BASE_URL: 'http://localhost:8317' }, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
    const ready = await connection.next((message) => message.op === op && (message.event === 'failed' || message.event === 'ready'));

    expect(ready).toMatchObject({ event: 'failed', failure: { code: 'sandbox_unavailable', message: expect.stringContaining('`sbx policy allow network localhost:8317`') } });
    expect(String((ready.failure as Message).message)).toContain('ANTHROPIC_BASE_URL');
    expect(engine.containers()).toEqual([]);
    // Only the read-only `policy ls` and `policy check` ran: no rule was added, removed or reset.
    expect(engine.calls().filter(([name, command, action]) => name === 'sbx' && command === 'policy' && !['ls', 'check'].includes(action ?? ''))).toEqual([]);
  });

  it("offers an instance whose command a kit brings, and says an instance's command is not in sbx's own templates", async () => {
    engine.secret('anthropic', true);
    engine.image('./kits/acme', { claude: CLAUDE, 'acme-claude': ACME_CLAUDE_COMMAND });

    expect(await init(start(), { provider: 'sbx', agent: './kits/acme' }, 'unattended', { env: [], logins: [] }, [ACME_CLAUDE])).toMatchObject({ ok: true, can: { tools: ['claude', 'acme-claude'] } });
    // An instance whose command is its tool's own runs in that tool's template.
    const reply = await init(start(), { provider: 'sbx' }, 'unattended', { env: [], logins: [] }, [ACME_CLAUDE, { name: 'claude-fast', tool: 'claude', command: 'claude' }]);

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'opencode', 'claude-fast'] }, unavailable: { 'acme-claude': expect.stringMatching(/acme-claude.*sbx's claude template.*agent.*kit.*--driver local/) } });
  });

  it("opens a Claude instance teamai names in open from sbx's claude template, and signs it in on the login sbx keeps, in the instance's own home", async () => {
    engine.image('claude', { claude: "const fs = require('node:fs'); const signedIn = fs.existsSync(`${process.env.ACME_CLAUDE_CONFIG_DIR}/.credentials.json`); console.log(signedIn ? 'signed in' : 'Not logged in · Please run /login'); process.exit(signedIn ? 0 : 1);" });
    engine.secret('anthropic', true);
    const connection = start();
    const instance = { name: 'claude-work', tool: 'claude', home: { dir: '.claude-work' } } satisfies InitInstance;

    expect(await init(connection, { provider: 'sbx' }, 'unattended', { env: [], logins: [] }, [instance])).toMatchObject({ ok: true, can: { tools: ['claude', 'opencode', 'claude-work'] } });
    const at = place();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'claude-work', credentials: {}, view: { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { ACME_CLAUDE_CONFIG_DIR: at.toolHome } } });
    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'ready' });

    expect((await exec(connection, { argv: ['claude', '-p', 'Fix it.'], env: { ACME_CLAUDE_CONFIG_DIR: at.toolHome }, cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: 'signed in\n' });
  });

  it('offers only the tools of a kit that can sign in, and says why it leaves out the others', async () => {
    engine.image('./kits/review', { claude: CLAUDE, codex: SBX_CODEX });
    engine.secret('openai', true);
    const reply = await init(start(), { provider: 'sbx', agent: './kits/review' }, 'unattended', { env: [], logins: [] });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['codex'] }, unavailable: { claude: expect.stringContaining('`sbx run claude <any dir>`') } });
    expect(Object.keys(reply.unavailable as Message)).toEqual(['claude']);
  });

  it('offers the tools a kit brings, found in a scratch sandbox it then removes', async () => {
    engine.image('./kits/review', { claude: CLAUDE, codex: SBX_CODEX });
    const reply = await init(start(), { provider: 'sbx', agent: './kits/review' });

    expect(reply).toMatchObject({ ok: true, can: { tools: ['claude', 'codex'] } });
    expect(engine.containers()).toEqual([]);
  });

  it('fails init, naming the command, when it cannot remove the scratch sandbox it probed a kit in', async () => {
    engine.image('./kits/review', { claude: CLAUDE });
    engine.failRemove(true);
    const reply = await init(start(), { provider: 'sbx', agent: './kits/review' });

    expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable', message: expect.stringMatching(/sbx rm --force teamai-tools-[0-9a-f]{8}/) } });
    // The member removes it with the command the failure names.
    planted(...engine.containers().filter((name) => name.startsWith('teamai-tools-')));
  });

  it('stops the step on cancel and keeps the sandbox for the next exec; close removes it, and reattach then says gone', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(connection, at);
    const op = newOp();
    connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; sleep 30'] });
    await connection.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    connection.send({ type: 'cancel', op });

    expect(await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000)).toEqual({ op, event: 'cancelled' });
    expect(engine.containers()).toEqual([expect.stringMatching(SANDBOX)]);
    expect((await exec(connection, { argv: ['/bin/sh', '-c', 'echo again'], cwd: at.worktree })).end).toMatchObject({ event: 'exited', code: 0, stdout: 'again\n' });

    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('reattaches by name after the runtime is killed mid-step, reports its exec still running, and close then leaves no sandbox', async () => {
    const first = start();
    await init(first, { provider: 'sbx', agent: 'claude' });
    const at = place();
    await openPlace(first, at);
    const op = newOp();
    first.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, cwd: at.worktree, argv: ['/bin/sh', '-c', 'touch started; while [ ! -f release ]; do sleep 0.05; done; echo finished'] });
    await first.next((message) => message.op === op && message.event === 'accepted');
    await vi.waitFor(() => { expect(fs.existsSync(path.join(at.worktree, 'started'))).toBe(true); }, { timeout: 10_000 });
    first.child.kill('SIGKILL');
    await first.end();

    const second = start();
    await init(second, { provider: 'sbx', agent: 'claude' });
    second.send({ type: 'reattach', handle: HANDLE });

    expect(await second.next((message) => message.event === 'alive' || message.event === 'gone')).toMatchObject({
      event: 'alive', handle: HANDLE, display: { label: `${sandbox()} (sbx)` }, ops: [{ op, state: 'running' }],
    });

    second.send({ type: 'close', handle: HANDLE });
    expect(await second.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });

  it('keeps a place whose sandbox was removed meanwhile until close finds it absent, and reattach then says gone', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    await openPlace(connection, place());
    execFileSync(path.join(engine.bin, 'sbx'), ['rm', '--force', sandbox()], { env: engine.env() });
    connection.send({ type: 'reattach', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toMatchObject({ event: 'alive', handle: HANDLE, ops: [] });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'gone' || message.event === 'alive')).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('answers close_failed with the command that removes it when sbx cannot, and keeps the place to close again', async () => {
    const connection = start();
    await init(connection, { provider: 'sbx', agent: 'claude' });
    await openPlace(connection, place());
    engine.failRemove(true);
    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toMatchObject({
      event: 'close_failed', handle: HANDLE, failure: { code: 'sandbox_failed', message: expect.stringContaining(`sbx rm --force ${sandbox()}`) },
    });
    engine.failRemove(false);
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed')).toEqual({ event: 'closed', handle: HANDLE });
    expect(engine.containers()).toEqual([]);
  });
});

describe('a warm image', () => {
  const LOCK = '{"lockfileVersion":3,"marker":"lock-7c1e"}';
  // prepare sees the copies of the cache files, and fills a store in the sandbox's home, outside the checkout.
  const PREPARE = 'test -f package.json && test -f package-lock.json && mkdir -p "$HOME/.store" && echo filled > "$HOME/.store/ready"';
  const WARM = { prepare: PREPARE, cache: ['package.json', 'package-lock.json'] };
  const PROVIDERS: Array<{ options: Message; save: string }> = [
    { options: { provider: 'docker', image: IMAGE }, save: 'commit' },
    { options: { provider: 'podman', image: IMAGE }, save: 'commit' },
    { options: { provider: 'sbx', agent: 'claude' }, save: 'template' },
  ];

  /** The attempt's place, with the checkout files the warm image is keyed by. */
  function checkout(lock = LOCK): Place {
    const at = place();
    fs.writeFileSync(path.join(at.worktree, 'package.json'), '{"name":"app"}');
    fs.writeFileSync(path.join(at.worktree, 'package-lock.json'), lock);

    return at;
  }

  /** Opens `attempt` at `at` and answers its ready or failed. */
  async function openAttempt(connection: Connection, at: Place, attempt: string): Promise<Message> {
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1' }, view: { worktree: at.worktree, readonly: [at.git], result: path.join(dir, 'attempts', attempt, 'out'), runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: path.join(dir, 'attempts', attempt, 'tool-home', 'claude') } } });

    return connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);
  }

  /** The commands that saved a warm image, and the prepares that ran, since `before`. */
  const builds = (before = 0): { saves: string[][]; prepares: string[][] } => {
    const calls = engine.calls().slice(before);

    return { saves: calls.filter(([, command, action]) => command === 'commit' || command === 'build' || (command === 'template' && action === 'save')), prepares: calls.filter((call) => call.includes(PREPARE)) };
  };

  /** The host directory the warm image was prepared in: docker's and podman's mount, or sbx's workspace. */
  const scratchDir = (): string | undefined => {
    for (const call of engine.calls()) {
      const mount = call.find((arg) => arg.endsWith(':/teamai-warm:rw'));

      if (mount !== undefined) return mount.slice(0, -':/teamai-warm:rw'.length);

      if (call[1] === 'create' && call.some((arg) => /^teamai-[0-9a-f]{16}-warm-[0-9]+-/.test(arg))) return call.at(-1);
    }

    return undefined;
  };

  beforeEach(() => {
    engine.image('claude', { claude: CLAUDE });
  });

  it.each(PROVIDERS)('starts an attempt on $options.provider from a warm image prepared once, which holds the store and no checkout file or credential', async ({ options }) => {
    const connection = start();
    await init(connection, { ...options, warm: WARM });
    const at = checkout();

    const ready = await openAttempt(connection, at, ATTEMPT);
    const [tag] = engine.savedImages();
    expect(tag).toMatch(/^teamai-warm:[0-9a-f]{16}$/);
    // The attempt's sandbox starts from it, says so, and sees the store prepare filled.
    expect(ready).toMatchObject({ event: 'ready', display: { fields: options.provider === 'sbx' ? { template: tag } : { image: tag, base: IMAGE } } });
    expect(engine.calls().find((call) => call.includes(String(tag)) && (call[1] === 'run' || call[1] === 'create'))).toBeDefined();
    const { end, output } = await exec(connection, { argv: ['/bin/sh', '-c', 'cat "$HOME/.store/ready"'], cwd: at.worktree });
    expect(end).toMatchObject({ event: 'exited', code: 0 });
    expect(output).toBe('filled\n');
    // Prepare got no name from teamai, and the image holds no file of the checkout nor any credential.
    const { prepares } = builds();
    expect(prepares).toHaveLength(1);
    expect(prepares[0]).not.toContain('-e');
    const { home } = engine.savedFiles(String(tag));
    expect(Object.keys(home)).toContain(path.join('.store', 'ready'));
    expect(Object.keys(home).filter((file) => file.includes('package'))).toEqual([]);
    expect(JSON.stringify(home)).not.toMatch(/lock-7c1e|oauth-secret-1/);
    // Only the attempt's sandbox is left, and the scratch directory prepare ran in is gone.
    expect(engine.containers()).toEqual([options.provider === 'sbx' ? expect.stringMatching(/-r0123abcd-a0123abcd$/) : HANDLE]);
    const scratch = scratchDir();
    expect(scratch).toMatch(/teamai-warm-/);
    expect(fs.existsSync(String(scratch))).toBe(false);
  });

  it.each(PROVIDERS)('reuses the warm image on $options.provider while the lockfile is unchanged, in another runtime process, and prepares a new one when it changes', async ({ options }) => {
    const first = start();
    await init(first, { ...options, warm: WARM });
    const at = checkout();
    await openAttempt(first, at, ATTEMPT);
    first.send({ type: 'close', handle: HANDLE });
    await first.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000);
    await first.end();
    const before = engine.calls().length;
    const second = start();
    await init(second, { ...options, warm: WARM });

    expect(await openAttempt(second, at, ATTEMPT)).toMatchObject({ event: 'ready' });
    expect(builds(before)).toEqual({ saves: [], prepares: [] });
    second.send({ type: 'close', handle: HANDLE });
    await second.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000);
    fs.writeFileSync(path.join(at.worktree, 'package-lock.json'), '{"lockfileVersion":3,"marker":"lock-9d20"}');

    expect(await openAttempt(second, at, ATTEMPT)).toMatchObject({ event: 'ready' });
    expect(builds(before).saves).toHaveLength(1);
    expect(engine.savedImages()).toHaveLength(2);
  });

  it.each(PROVIDERS)('builds one warm image on $options.provider for two attempts that open at once', async ({ options, save }) => {
    engine.delay(save, 1_000);
    const connection = start();
    await init(connection, { ...options, warm: WARM });
    const at = checkout();
    const [one, two] = await Promise.all([openAttempt(connection, at, ATTEMPT), openAttempt(connection, at, 'a0123abce')]);

    expect([one?.event, two?.event]).toEqual(['ready', 'ready']);
    expect(builds()).toMatchObject({ saves: [expect.anything()], prepares: [expect.anything()] });
  });

  it.each(PROVIDERS)('closes an attempt on $options.provider at once while its warm image is still being made, and makes no sandbox for it', async ({ options, save }) => {
    engine.delay(save, 5_000);
    const connection = start();
    await init(connection, { ...options, warm: WARM });
    const at = checkout();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1' }, view: { worktree: at.worktree, readonly: [at.git], result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') } } });
    await connection.next((message) => message.op === op && message.event === 'accepted', 5_000);
    await vi.waitFor(() => { expect(builds().prepares).toHaveLength(1); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 2_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 15_000)).toMatchObject({
      event: 'failed', failure: { code: 'sandbox_failed', message: `Attempt ${ATTEMPT} was closed while its warm image was being made, so no sandbox was made for it.` },
    });
    // The image is kept for the next attempt; the scratch sandbox it was made in is gone, and the attempt never had one.
    expect(engine.savedImages()).toHaveLength(1);
    await vi.waitFor(() => { expect(engine.containers()).toEqual([]); }, { timeout: 5_000 });
  }, 30_000);

  it('makes a new warm image on docker once its image here is another under the same tag', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE, warm: WARM });
    const at = checkout();
    await openAttempt(connection, at, ATTEMPT);
    connection.send({ type: 'close', handle: HANDLE });
    await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000);
    // The team pushed the tag again with a new tool, and it was pulled here.
    engine.image(IMAGE, { 'new-tool': 'console.log("new")' });

    expect(await openAttempt(connection, at, ATTEMPT)).toMatchObject({ event: 'ready' });
    expect(builds().saves).toHaveLength(2);
    expect(engine.savedImages()).toHaveLength(2);
  });

  it('makes a new warm template on sbx once sbx is upgraded, since a new sbx ships new templates', async () => {
    const options = { provider: 'sbx', agent: 'claude', warm: WARM };
    const first = start();
    await init(first, options);
    const at = checkout();
    await openAttempt(first, at, ATTEMPT);
    first.send({ type: 'close', handle: HANDLE });
    await first.next((message) => message.event === 'closed' || message.event === 'close_failed', 30_000);
    await first.end();
    engine.upgrade('0.52.0');
    const second = start();
    await init(second, options);

    expect(await openAttempt(second, at, ATTEMPT)).toMatchObject({ event: 'ready' });
    expect(builds().saves).toHaveLength(2);
    expect(engine.savedImages()).toHaveLength(2);
  });

  it('removes the sandbox of an attempt whose close was still looking for it when its warm image was done, and fails the open', async () => {
    // The close's lookup outlasts the build, so the open, past its warm image, creates while the close forgets the place.
    engine.delay('commit', 2_000);
    engine.delay('ps', 4_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE, warm: WARM });
    const at = checkout();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1' }, view: { worktree: at.worktree, readonly: [at.git], result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') } } });
    await connection.next((message) => message.op === op && message.event === 'accepted', 5_000);
    await vi.waitFor(() => { expect(builds().prepares).toHaveLength(1); }, { timeout: 10_000 });

    connection.send({ type: 'close', handle: HANDLE });

    expect(await connection.next((message) => message.event === 'closed' || message.event === 'close_failed', 10_000)).toEqual({ event: 'closed', handle: HANDLE });
    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 20_000)).toMatchObject({
      event: 'failed', failure: { code: 'sandbox_failed', message: `Attempt ${ATTEMPT} was closed while its sandbox was being made, so it was removed.` },
    });
    engine.delay('ps', 0);
    await vi.waitFor(() => { expect(engine.containers()).toEqual([]); }, { timeout: 10_000 });
  }, 40_000);

  it.each<{ options: Message; says: (tag: string) => unknown }>([
    { options: { provider: 'docker', image: IMAGE }, says: (tag: string) => `The warm image ${tag} was removed after it was made for attempt ${ATTEMPT}, so no sandbox was made for it. Start the step again, and teamai makes the image again.` },
    { options: { provider: 'sbx', agent: 'claude' }, says: (tag: string) => expect.stringContaining(`template ${tag} not found`) },
  ])('fails the open on $options.provider of an attempt whose warm image was removed once made, rather than making it again while creating the sandbox, which a close waits for', async ({ options, says }) => {
    // The sandbox's lookup outlasts the removal, which lands between the warm image and the sandbox's creation, and the
    // image takes a while to save, as one under load does.
    engine.delay('ps', 3_000);
    engine.holdSave(1_000);
    const connection = start();
    await init(connection, { ...options, warm: WARM });
    const at = checkout();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1' }, view: { worktree: at.worktree, readonly: [at.git], result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') } } });
    await connection.next((message) => message.op === op && message.event === 'accepted', 5_000);
    await vi.waitFor(() => { expect(engine.savedImages()).toHaveLength(1); }, { timeout: 10_000 });
    const [tag = ''] = engine.savedImages();
    // Removed meanwhile, as `docker image rm` or a prune of the member's would.
    for (const record of ['pulled', 'saved']) fs.rmSync(path.join(engine.state, record, encodeURIComponent(tag)), { recursive: true, force: true });

    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 20_000)).toMatchObject({
      event: 'failed', failure: { code: 'sandbox_failed', message: says(tag) },
    });
    expect(builds().prepares).toHaveLength(1);
    engine.delay('ps', 0);
  }, 40_000);

  it('makes the sandbox on docker from the warm image made for the attempt, though its base was pulled again before the sandbox was made', async () => {
    // The sandbox's lookup outlasts the new pull, which lands between the warm image and the sandbox's creation.
    engine.delay('ps', 3_000);
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE, warm: WARM });
    const at = checkout();
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1' }, view: { worktree: at.worktree, readonly: [at.git], result: path.join(dir, 'attempts', ATTEMPT, 'out'), runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: path.join(dir, 'attempts', ATTEMPT, 'tool-home', 'claude') } } });
    await connection.next((message) => message.op === op && message.event === 'accepted', 5_000);
    await vi.waitFor(() => { expect(engine.savedImages()).toHaveLength(1); }, { timeout: 10_000 });
    // The tag pushed again with other tools and pulled, by another teamai or the member: its id moves.
    engine.image(IMAGE, { claude: CLAUDE, 'git-lfs': 'process.exit(0)' });

    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 20_000)).toMatchObject({ event: 'ready' });
    expect(builds().prepares).toHaveLength(1);
    engine.delay('ps', 0);
  }, 40_000);

  it.each(PROVIDERS)('removes, at the next open on $options.provider, the scratch sandbox and directory of a warm image whose runtime was killed, and keeps those of one that runs', async ({ options }) => {
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const connection = start({ TMPDIR: tmp });
    await init(connection, options);
    await openAttempt(connection, checkout(), ATTEMPT);
    // A pid no process has any more, and this test's own, which runs.
    const gone = spawnSync('true').pid;
    const bin = path.join(engine.bin, String(options.provider));

    const leave = (pid: number): void => {
      fs.mkdirSync(path.join(tmp, `teamai-warm-${pid}-abc123`));

      if (options.provider === 'sbx') {
        const prefix = engine.containers()[0]?.replace(`${RUN}-${ATTEMPT}`, '');
        execFileSync(bin, ['create', '--name', `${prefix}warm-${pid}-abc123`, '--no-progress', 'claude', tmp], { env: engine.env() });
      } else {
        const owner = engine.labelsOf(HANDLE)?.['teamai.owner'] ?? '';
        execFileSync(bin, ['run', '-d', '--name', `teamai-warm-${pid}`, '--label', `teamai.owner=${owner}`, '--label', `teamai.warm-by=${os.hostname()}:${pid}`, '--entrypoint', '/bin/sh', IMAGE, '-c', 'sleep infinity'], { env: engine.env() });
      }
    };

    leave(gone);
    leave(process.pid);
    // The scratch sandbox of a warm image whose runtime still runs is that runtime's.
    planted(...engine.containers().filter((name) => name.includes(`warm-${process.pid}`)));

    expect(await openAttempt(connection, checkout(), 'a0123abce')).toMatchObject({ event: 'ready' });
    await vi.waitFor(() => {
      expect(engine.containers().filter((name) => name.includes('warm'))).toEqual([expect.stringContaining(`warm-${process.pid}`)]);
      expect(fs.readdirSync(tmp).filter((name) => name.startsWith('teamai-warm-'))).toEqual([`teamai-warm-${process.pid}-abc123`]);
    }, { timeout: 10_000 });
    expect(connection.stderr()).toBe('');
  }, 30_000);

  it.each(PROVIDERS)('fails the open on $options.provider with the last lines of a prepare that fails, and leaves nothing', async ({ options }) => {
    const connection = start();
    await init(connection, { ...options, warm: { prepare: 'echo "npm error 401 Unauthorized" >&2; exit 7', cache: ['package-lock.json'] } });

    expect(await openAttempt(connection, checkout(), ATTEMPT)).toMatchObject({
      event: 'failed', failure: { code: 'sandbox_failed', message: expect.stringMatching(/prepare, `echo .*`, failed in a (container|sandbox) from .*, exiting with code 7\. It printed: npm error 401 Unauthorized\. No step ran; fix warm, and start again\./) },
    });
    expect(engine.containers()).toEqual([]);
    expect(engine.savedImages()).toEqual([]);
  });

  /** What `teamai uninstall` has the runtime remove, run in the member's HOME. */
  const removeWarm = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const ran = spawnSync(process.execPath, [executable, 'remove-warm', ...args], { env: { ...engine.env(), HOME: path.join(dir, 'home') }, encoding: 'utf8', timeout: 60_000 });

    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  };

  /** Opens an attempt on `options` with a warm image, and closes it, as a finished step does. */
  async function warmedAndClosed(options: Message): Promise<string> {
    const connection = start();
    await init(connection, { ...options, warm: WARM });
    expect(await openAttempt(connection, checkout(), ATTEMPT)).toMatchObject({ event: 'ready' });
    connection.send({ type: 'close', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && (message.event === 'closed' || message.event === 'close_failed'))).toEqual({ event: 'closed', handle: HANDLE });
    await connection.end();
    const [tag = ''] = engine.savedImages();

    return tag;
  }

  /** The templates the fake sbx keeps, by reference. */
  const sbxTemplates = (): string[] => z.array(z.object({ repository: z.string(), tag: z.string() }).loose()).parse(JSON.parse(execFileSync(path.join(engine.bin, 'sbx'), ['template', 'ls', '--json'], { env: engine.env(), encoding: 'utf8' }))).map(({ repository, tag }) => `${repository}:${tag}`);

  /** The sbx kit template a warm template saved from a sandbox of agent claude shares its image with. */
  const KIT = 'docker.io/library/sandbox-kit-assembled:' + crypto.createHash('sha256').update('claude').digest('hex').slice(0, 16);

  it.each<{ options: Message; listed: (tag: string) => string; removed: (tag: string) => string; left: (tag: string) => string }>([
    { options: { provider: 'docker', image: IMAGE }, listed: (tag) => `docker image ${tag}\n`, removed: (tag) => `Removed docker image ${tag}, a warm image teamai's sandbox made.\n`, left: () => '' },
    { options: { provider: 'podman', image: IMAGE }, listed: (tag) => `podman image ${tag}\n`, removed: (tag) => `Removed podman image ${tag}, a warm image teamai's sandbox made.\n`, left: () => '' },
    {
      options: { provider: 'sbx', agent: 'claude' },
      listed: (tag) => `sbx template ${tag}\n`,
      removed: (tag) => `Removed sbx template docker.io/library/${tag}, a warm template teamai's sandbox saved.\n`,
      left: (tag) => `sbx keeps the image of docker.io/library/${tag} as its template ${KIT} too, so removing it freed no disk. Remove that one with \`sbx template rm --force ${KIT}\` if no sandbox of yours starts from it.\n`,
    },
  ])('removes on $options.provider, as teamai is uninstalled, the warm image it made, naming it, and asks the engine nothing once none is left', async ({ options, listed, removed, left }) => {
    const tag = await warmedAndClosed(options);
    const made = engine.calls().length;

    // What an uninstall's preview lists: the image, asking the engine nothing and removing nothing.
    expect(removeWarm('--dry-run')).toEqual({ status: 0, stdout: listed(tag), stderr: '' });
    expect(engine.calls().slice(made)).toEqual([]);
    expect(engine.savedImages()).toEqual([tag]);
    expect(removeWarm()).toEqual({ status: 0, stdout: removed(tag), stderr: left(tag) });
    expect(engine.savedImages()).toEqual([]);

    if (options.provider === 'sbx') expect(sbxTemplates()).toContain(KIT);
    const before = engine.calls().length;
    expect(removeWarm()).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(engine.calls().slice(before)).toEqual([]);
  });

  it.each<{ options: Message; left: (tag: string) => string }>([
    { options: { provider: 'docker', image: IMAGE }, left: (tag) => `Could not remove docker image ${tag}, a warm image teamai's sandbox made (Cannot connect to the Docker daemon. Is the daemon running?). Remove it with \`docker image rm ${tag}\` once docker runs and no container uses it.\n` },
    { options: { provider: 'sbx', agent: 'claude' }, left: (tag) => `Could not look for sbx template ${tag}, a warm template teamai's sandbox saved (error: cannot connect to sandboxd: connection refused; try: sbx daemon start). Once \`sbx template ls\` answers, remove it with \`sbx template rm --force ${tag}\`.\n` },
  ])('names on $options.provider the warm image it cannot remove and how to, and removes it once the engine answers', async ({ options, left }) => {
    const tag = await warmedAndClosed(options);
    engine.daemon(false);

    expect(removeWarm()).toEqual({ status: 0, stdout: '', stderr: left(tag) });
    expect(engine.savedImages()).toEqual([tag]);
    engine.daemon(true);
    expect(removeWarm()).toMatchObject({ status: 0, stdout: expect.stringContaining(tag) });
    expect(engine.savedImages()).toEqual([]);
  });

  it.each(PROVIDERS)('says nothing on $options.provider of a warm image removed by hand, and forgets it', async ({ options }) => {
    const tag = await warmedAndClosed(options);
    const [command, removal] = options.provider === 'sbx' ? ['sbx', ['template', 'rm', '--force', `docker.io/library/${tag}`]] : [String(options.provider), ['image', 'rm', tag]];
    execFileSync(path.join(engine.bin, command), removal, { env: engine.env() });

    expect(removeWarm()).toEqual({ status: 0, stdout: '', stderr: '' });
    const before = engine.calls().length;
    removeWarm();
    expect(engine.calls().slice(before)).toEqual([]);
  });

  it('takes an sbx template that sbx lists but answers is not found as one removed meanwhile, and says nothing of it', async () => {
    const tag = await warmedAndClosed({ provider: 'sbx', agent: 'claude' });
    // sbx 0.53.0's answer to a template removed between its listing and the removal.
    const listing = execFileSync(path.join(engine.bin, 'sbx'), ['template', 'ls', '--json'], { env: engine.env(), encoding: 'utf8' });
    const stale = path.join(dir, 'stale-sbx');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'sbx'), `#!/bin/sh\nif [ "$1" = template ] && [ "$2" = ls ]; then printf '%s' '${listing.trim()}'; exit 0; fi\necho 'error: cannot remove template "docker.io/library/${tag}": delete template: image not found: request failed: 404 Not Found: no image "docker.io/library/${tag}"' >&2\nexit 1\n`, { mode: 0o755 });
    const ran = spawnSync(process.execPath, [executable, 'remove-warm'], { env: { ...engine.env(), PATH: `${stale}${path.delimiter}${engine.env().PATH ?? ''}`, HOME: path.join(dir, 'home') }, encoding: 'utf8', timeout: 60_000 });

    expect({ status: ran.status, stdout: ran.stdout, stderr: ran.stderr }).toEqual({ status: 0, stdout: '', stderr: '' });
    const before = engine.calls().length;
    expect(removeWarm()).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(engine.calls().slice(before)).toEqual([]);
  });

  it('builds a warm image on docker from a Containerfile whose context holds only the cache files', async () => {
    const connection = start();
    const at = checkout();
    fs.writeFileSync(path.join(at.worktree, 'Containerfile'), `FROM ${IMAGE}\nRUN npm ci\n`);
    fs.writeFileSync(path.join(at.worktree, 'secret.env'), 'TOKEN=checkout-only');
    await init(connection, { provider: 'docker', image: IMAGE, warm: { containerfile: 'Containerfile', cache: ['package.json', 'package-lock.json'] } });

    expect(await openAttempt(connection, at, ATTEMPT)).toMatchObject({ event: 'ready' });
    const [tag] = engine.savedImages();
    expect(Object.keys(engine.savedFiles(String(tag)).context).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(engine.calls().find(([, command, ...rest]) => command === 'run' && rest.includes(HANDLE))).toContain(tag);
  });

  it('builds the Containerfile of a sandbox profile folder with the folder\'s files, keyed by the folder\'s revision, and refuses one that leaves the folder or a folder holding a link', async () => {
    const folder = path.join(dir, 'profile-gpu');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'Containerfile'), `FROM ${IMAGE}\nCOPY prepare.sh package.json ./\nRUN ./prepare.sh\n`);
    fs.writeFileSync(path.join(folder, 'prepare.sh'), '#!/bin/sh\nnpm ci\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'Containerfile.outside'), `FROM ${IMAGE}\n`);
    const linked = path.join(dir, 'profile-linked');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, 'Containerfile'), `FROM ${IMAGE}\n`);
    fs.symlinkSync(path.join(dir, 'Containerfile.outside'), path.join(linked, 'Linked'));
    const opened = async (containerfile: string, revision: string, attempt: string, at = folder): Promise<Message> => {
      const connection = start();
      await init(connection, { provider: 'docker', image: IMAGE, warm: { containerfile, cache: ['package.json'] }, profile: { name: 'gpu', revision, folder: at } });
      return openAttempt(connection, checkout(), attempt);
    };

    const first = await opened('./Containerfile', 'rev-1', 'a0123abc1');
    const tag = builds().saves[0]?.find((argument) => argument.startsWith('teamai-warm:'));

    // The container ran the warm image, not the base the profile names, and says which profile at which revision.
    expect(tag).toMatch(/^teamai-warm:[0-9a-f]{16}$/);
    expect(first).toMatchObject({ event: 'ready', display: { fields: { container: expect.stringContaining('a0123abc1'), image: tag, profile: 'gpu, revision rev-1' } } });
    // The build sees the cache files at their paths in the checkout, and the folder's own files at its top.
    expect(Object.keys(engine.savedFiles(String(tag)).context).sort()).toEqual(['Containerfile', 'package.json', 'prepare.sh']);
    expect(await opened('./Containerfile', 'rev-1', 'a0123abc2')).toMatchObject({ event: 'ready' });
    expect(await opened('./Containerfile', 'rev-2', 'a0123abc3')).toMatchObject({ event: 'ready' });
    expect(builds().saves).toHaveLength(2);
    expect(await opened('../Containerfile.outside', 'rev-2', 'a0123abc4')).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'warm.containerfile', message: '../Containerfile.outside is not a path inside the folder of sandbox profile "gpu". Give it relative to the folder, for example ./Containerfile' } });
    expect(await opened('./Containerfile', 'rev-3', 'a0123abc5', linked)).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'warm', message: 'Linked is a link, and a sandbox profile builds only from the files its folder holds. Replace it with the file itself' } });
    expect(builds().saves).toHaveLength(2);
  });

  it('fails the open with bad_option on warm.cache naming a cache file that links out of the checkout, and copies nothing of where it points', async () => {
    const outside = path.join(dir, 'host-secret');
    fs.writeFileSync(outside, 'TOKEN=host-only');
    const at = checkout();
    fs.rmSync(path.join(at.worktree, 'package-lock.json'));
    fs.symlinkSync(outside, path.join(at.worktree, 'package-lock.json'));
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE, warm: WARM });

    expect(await openAttempt(connection, at, ATTEMPT)).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'warm.cache', message: expect.stringContaining('package-lock.json is a link to a file outside the checkout') } });
    expect(builds()).toEqual({ saves: [], prepares: [] });
    expect(engine.containers()).toEqual([]);
  });

  it('keeps no place and serves no attempt socket for an attempt whose first open failed after it was accepted', async () => {
    engine.image(IMAGE, { claude: CLAUDE, node: '' });
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE, warm: { prepare: 'exit 7', cache: ['package-lock.json'] } });
    const at = checkout();
    const view = { worktree: at.worktree, readonly: [at.git], result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } };
    const op = newOp();
    connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, tool: 'claude', credentials: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-2' }, view });
    const { socket } = z.object({ socket: z.string() }).parse(JSON.parse(String((await connection.next((message) => message.op === op && message.event === 'accepted')).handle)));

    expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000)).toMatchObject({ event: 'failed' });
    expect(fs.existsSync(socket)).toBe(false);
    connection.send({ type: 'reattach', handle: HANDLE });
    expect(await connection.next((message) => message.handle === HANDLE && ['alive', 'gone', 'failed'].includes(String(message.event)))).toEqual({ event: 'gone', handle: HANDLE });
  });

  it('fails the open with bad_option on warm.cache naming a cache file the checkout does not hold, before any sandbox exists', async () => {
    const connection = start();
    await init(connection, { provider: 'docker', image: IMAGE, warm: { prepare: PREPARE, cache: ['pnpm-lock.yaml'] } });

    expect(await openAttempt(connection, checkout(), ATTEMPT)).toMatchObject({ event: 'failed', failure: { code: 'bad_option', key: 'warm.cache', message: expect.stringContaining('pnpm-lock.yaml is not a file in the checkout') } });
    expect(engine.containers()).toEqual([]);
  });
});

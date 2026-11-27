import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleRuntime, connect, fakeEngine, tempDir, type Connection, type FakeEngine, type Message } from '../testing/harness.js';
import { expectNothingLeft } from '../testing/leaks.js';

// One spec for the container providers, through the runtime's stdio entry point, run against the fake engine
// (testing/fake-engine.mjs) always, and against the real engines CONTAINER_SPEC_ENGINES names (`docker,podman,sbx`).
// What the fake answers is then checked against what the engine does: a drift fails here instead of hiding a bug
// (after sandcastle's tests/local/helpers/containerProviderSpec.ts). A named engine that does not run fails the suite.
//
// Every command runs through `/bin/sh` by its absolute path, which every real image here has, and the fake runs on
// the host.


type Engine = z.infer<typeof EngineSchema>;

/** One engine the spec runs against: the runtime's environment for it, its options, and what it holds. */
interface Target {
  label: string;
  engine: Engine;
  options: Message;
  /** Readies the engine (an image), once; the returned function removes what it made. */
  prepare(dir: string): Promise<() => void>;
  env(dir: string): NodeJS.ProcessEnv;
  /** The names of the containers (sbx: sandboxes) that exist. */
  containers(dir: string): string[];
}

/** What `sbx ls --json` lists, as the sbx provider reads it. */
const SbxListSchema = z.array(z.object({ name: z.string() }));

const RUN = 'r0c0ffee1';
const ATTEMPT = 'a0c0ffee1';
const FAKE_IMAGE = 'ghcr.io/acme/spec:1';
// Unique to this run, so another run of the spec on this engine neither shares nor removes it.
const REAL_IMAGE = `teamai-spec/agent:${process.pid}`;

let fakes: FakeEngine | undefined;

/** The fake engine answering as `engine`. */
function fakeTarget(engine: Engine): Target {
  return {
    label: `fake ${engine}`,
    engine,
    options: engine === 'sbx' ? { provider: 'sbx' } : { provider: engine, image: FAKE_IMAGE },
    async prepare(dir) {
      fakes = fakeEngine(dir);
      fakes.image(FAKE_IMAGE, {});
      fakes.image('shell', {});

      return () => undefined;
    },
    env: () => fakes?.env() ?? {},
    containers: () => fakes?.containers() ?? [],
  };
}

/**
 * The engine `engine` on this machine, as the member runs it. The suite runs with a home of its own, and each case
 * gives the runtime another, so the engine runs through a shim that gives it the member's home, where it keeps its
 * images, its storage and its sign-in.
 */
function realTarget(engine: Engine): Target {
  const shim = (dir: string): string => path.join(dir, 'engine-bin');
  const cli = (dir: string, args: string[]): string => execFileSync(path.join(shim(dir), engine), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });

  return {
    label: `real ${engine}`,
    engine,
    options: engine === 'sbx' ? { provider: 'sbx' } : { provider: engine, image: REAL_IMAGE },
    async prepare(dir) {
      const found = execFileSync('/bin/sh', ['-c', `command -v ${engine}`], { encoding: 'utf8' }).trim();
      fs.mkdirSync(shim(dir), { recursive: true });
      fs.writeFileSync(path.join(shim(dir), engine), `#!/bin/sh\nHOME='${os.userInfo().homedir}' exec '${found}' "$@"\n`, { mode: 0o755 });
      if (engine === 'sbx') return () => undefined;

      const context = path.join(dir, 'image');
      fs.mkdirSync(context, { recursive: true });
      // node runs the network filter in front of each step's container.
      fs.writeFileSync(path.join(context, 'Containerfile'), 'FROM docker.io/library/node:22-alpine\n');
      cli(dir, ['build', '-q', '-t', REAL_IMAGE, '-f', path.join(context, 'Containerfile'), context]);

      return () => { spawnSync(path.join(shim(dir), engine), ['rmi', '-f', REAL_IMAGE], { stdio: 'ignore' }); };
    },
    env: (dir) => ({ PATH: [shim(dir), process.env.PATH].join(path.delimiter), ...(process.env.DOCKER_HOST && { DOCKER_HOST: process.env.DOCKER_HOST }), ...(process.env.CONTAINER_HOST && { CONTAINER_HOST: process.env.CONTAINER_HOST }) }),
    containers: (dir) => (engine === 'sbx'
      ? SbxListSchema.parse(JSON.parse(cli(dir, ['ls', '--json']))).map(({ name }) => name)
      : cli(dir, ['ps', '-a', '--format', '{{.Names}}']).split('\n')).filter((name) => name.includes(`${RUN}-${ATTEMPT}`)),
  };
}

const EngineSchema = z.enum(['docker', 'podman', 'sbx'], { error: (issue) => `CONTAINER_SPEC_ENGINES names ${String(issue.input)}; name docker, podman or sbx` });
const named = (process.env.CONTAINER_SPEC_ENGINES ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
const TARGETS: Target[] = [fakeTarget('docker'), fakeTarget('podman'), fakeTarget('sbx'), ...named.map((name) => realTarget(EngineSchema.parse(name)))];

/**
 * A step that tries this machine's port `argv[2]` straight (host.docker.internal) and through its proxy (a CONNECT), and
 * fetches its credential's gateway through the proxy, printing what each got.
 */
const REACH = String.raw`const net = require('node:net'); const http = require('node:http');
const [port, neighbour] = process.argv.slice(2);
const direct = () => new Promise((resolve) => { const socket = net.connect(Number(port), 'host.docker.internal'); socket.setTimeout(5000, () => { socket.destroy(); resolve('timeout'); }); socket.on('data', (data) => { resolve(String(data)); socket.destroy(); }); socket.on('error', (error) => resolve(error.code)); });
const proxy = () => new URL(process.env.HTTP_PROXY || 'http://no-proxy.invalid:1');
const tunnel = (host = 'host.docker.internal') => new Promise((resolve) => { const request = http.request({ host: proxy().hostname, port: proxy().port, method: 'CONNECT', path: host + ':' + port, timeout: 5000 }); request.on('connect', (response, socket) => { socket.destroy(); resolve(String(response.statusCode)); }); request.on('response', (response) => resolve(String(response.statusCode))); request.on('timeout', () => { request.destroy(); resolve('timeout'); }); request.on('error', (error) => resolve(error.code)); request.end(); });
const fetched = () => new Promise((resolve) => { const request = http.request({ host: proxy().hostname, port: proxy().port, path: process.env.ANTHROPIC_BASE_URL, timeout: 5000 }, (response) => { let body = ''; response.on('data', (data) => { body += data; }); response.on('end', () => resolve(response.statusCode + ' ' + body)); }); request.on('timeout', () => { request.destroy(); resolve('timeout'); }); request.on('error', (error) => resolve(error.code)); request.end(); });
(async () => { console.log(JSON.stringify({ direct: await direct(), tunnel: await tunnel(), neighbour: await tunnel(neighbour), gateway: await fetched() })); })();`;

/** A command that waits until `file` exists, at most 20 s. */
const waitFor = (file: string): string => `i=0; while [ ! -e '${file}' ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done`;

for (const target of TARGETS) {
  describe(`container provider spec: ${target.label}`, () => {
    let executable: string;
    let dir: string;
    let home: string;
    let removeImage: () => void;
    const open: Connection[] = [];
    let ops = 0;

    const newOp = (): string => {
      ops += 1;

      return `op-${ops.toString(16).padStart(8, '0')}`;
    };

    beforeAll(async () => {
      if (target.label.startsWith('real') && spawnSync(target.engine, ['version'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) {
        throw new Error(`CONTAINER_SPEC_ENGINES names ${target.engine}, which does not run here. Start it, or leave it out of CONTAINER_SPEC_ENGINES`);
      }

      executable = await bundleRuntime(tempDir());
      dir = tempDir();
      removeImage = await target.prepare(dir);
    }, 600_000);

    afterAll(() => {
      removeImage();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(dir, 'home-'));
    });

    afterEach(async () => {
      const connections = open.splice(0);
      await Promise.all(connections.map((connection) => connection.end()));
      expect(connections.flatMap((connection) => connection.invalid)).toEqual([]);
      // Every case closes what it opened: no container of the attempt, process or attempt's state is left.
      expect(target.containers(dir)).toEqual([]);
      await expectNothingLeft({ dir: home, connections });
    });

    function start(extra: NodeJS.ProcessEnv = {}): Connection {
      const connection = connect(executable, { ...target.env(dir), HOME: home, ...extra });
      open.push(connection);

      return connection;
    }

    /** `git` is the common git directory, and `admin` git's record of the worktree inside it, which `git` mounts. */
    interface Opened { connection: Connection; handle: string; worktree: string; git: string; admin: string }

    async function opened(extra: NodeJS.ProcessEnv = {}, credentials: Record<string, string> = {}): Promise<Opened> {
      const connection = start(extra);
      connection.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options: target.options, credentials: { env: [], logins: [] } });
      expect(await connection.next((message) => message.type === 'init', 300_000)).toMatchObject({ ok: true });
      const root = fs.mkdtempSync(path.join(dir, 'place-'));
      const worktree = path.join(root, 'worktree');
      const git = path.join(root, 'repo.git');
      const admin = path.join(git, 'worktrees', 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      fs.mkdirSync(admin, { recursive: true });
      fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
      const op = newOp();
      connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, credentials, view: { worktree, readonly: [git], result: path.join(root, 'out'), runDir: path.join(root, 'run'), toolHome: {} } });
      const accepted = await connection.next((message) => message.op === op && (message.event === 'accepted' || message.event === 'failed'));
      expect(await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 300_000)).toMatchObject({ event: 'ready' });

      return { connection, handle: String(accepted.handle), worktree, git, admin };
    }

    async function exec({ connection, handle }: Opened, request: { script: string; cwd: string; env?: Record<string, string>; credentials?: Record<string, string> }, op = newOp()): Promise<{ end: Message; stdout: string; stderr: string }> {
      connection.send({ type: 'exec', op, handle, argv: ['/bin/sh', '-c', request.script], env: request.env ?? {}, unset: [], credentials: request.credentials ?? {}, cwd: request.cwd });
      const end = await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 120_000);
      const printed = (stream: string): string => connection.messages.filter((message) => message.op === op && message.event === 'output' && message.stream === stream).map((message) => String(message.data)).join('');

      return { end, stdout: printed('stdout'), stderr: printed('stderr') };
    }

    async function close({ connection, handle }: Opened): Promise<void> {
      connection.send({ type: 'close', handle });
      expect(await connection.next((message) => message.handle === handle && (message.event === 'closed' || message.event === 'failed'), 300_000)).toMatchObject({ event: 'closed' });
    }

    it('makes one sandbox for the attempt at open, and removes it at close', async () => {
      const place = await opened();

      // A docker sandbox behind the network filter has the filter's container beside it.
      expect(target.containers(dir).filter((name) => !name.endsWith('-proxy'))).toHaveLength(1);
      await close(place);
      expect(target.containers(dir)).toEqual([]);
    }, 600_000);

    it("passes the exit status, stdout and stderr apart, the working directory, and only the exec's own variables", async () => {
      const place = await opened({ MEMBER_CANARY: 'member-canary-value' });
      const { end, stdout, stderr } = await exec(place, {
        script: 'pwd; echo "named=$NAMED key=$STEP_KEY canary=${MEMBER_CANARY:-unset}"; echo oops >&2; exit 7',
        cwd: place.worktree, env: { NAMED: 'given' }, credentials: { STEP_KEY: 'step-secret' },
      });

      expect(end).toMatchObject({ event: 'exited', code: 7 });
      expect(stdout).toBe(`${place.worktree}\nnamed=given key=step-secret canary=unset\n`);
      expect(stderr).toBe('oops\n');
      await close(place);
    }, 600_000);

    it("streams output while the exec runs", async () => {
      const place = await opened();
      const op = newOp();
      const ended = exec(place, { script: `echo first; ${waitFor(path.join(place.worktree, 'go'))}; echo second`, cwd: place.worktree }, op);

      expect(await place.connection.next((message) => message.op === op && message.event === 'output', 120_000)).toMatchObject({ stream: 'stdout', data: 'first\n' });
      fs.writeFileSync(path.join(place.worktree, 'go'), '');
      expect(await ended).toMatchObject({ end: { event: 'exited', code: 0 }, stdout: 'first\nsecond\n' });
      await close(place);
    }, 600_000);

    it('writes the worktree on this machine', async () => {
      const place = await opened();

      expect(await exec(place, { script: 'echo made > made.txt', cwd: place.worktree })).toMatchObject({ end: { event: 'exited', code: 0 } });
      expect(fs.readFileSync(path.join(place.worktree, 'made.txt'), 'utf8')).toBe('made\n');
      await close(place);
    }, 600_000);

    // The fake runs its processes on this machine, where nothing makes a read-only mount read only.
    it.runIf(target.label.startsWith('real'))('keeps the git paths read only', async () => {
      const place = await opened();
      const { end, stdout } = await exec(place, { script: `if echo x > '${place.git}/HEAD' 2>/dev/null; then echo git=written; else echo git=refused; fi`, cwd: place.worktree });

      expect(end).toMatchObject({ event: 'exited', code: 0 });
      expect(stdout).toBe('git=refused\n');
      expect(fs.readFileSync(path.join(place.git, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
      await close(place);
    }, 600_000);

    it('cancels a running exec, and runs the next one', async () => {
      const place = await opened();
      const op = newOp();
      const ended = exec(place, { script: `echo started; ${waitFor(path.join(place.worktree, 'never'))}; echo late > late.txt`, cwd: place.worktree }, op);
      await place.connection.next((message) => message.op === op && message.event === 'output', 120_000);
      place.connection.send({ type: 'cancel', op });

      expect((await ended).end).toMatchObject({ event: 'cancelled' });
      expect(await exec(place, { script: 'echo again', cwd: place.worktree })).toMatchObject({ end: { event: 'exited', code: 0 }, stdout: 'again\n' });
      expect(fs.existsSync(path.join(place.worktree, 'late.txt'))).toBe(false);
      await close(place);
    }, 600_000);

    // Docker Desktop makes a bind source that is gone again, as an empty directory, whenever a container starts. sbx's
    // stop is its own provider's.
    it.runIf(target.engine !== 'sbx')('makes nothing of a place removed under a running step again when it stops the step', async () => {
      // Docker Desktop's removal of a container goes on after its processes ended.
      const slowRemoval = target.label.startsWith('fake') ? fakes : undefined;
      slowRemoval?.holdRemove(1000);

      try {
        const place = await opened();
        const op = newOp();
        const ended = exec(place, { script: `echo started; ${waitFor(path.join(place.git, 'never'))}`, cwd: place.worktree }, op);
        await place.connection.next((message) => message.op === op && message.event === 'output', 120_000);
        // As `git worktree remove` takes a worktree: its directory, then git's record of it.
        fs.rmSync(place.worktree, { recursive: true, force: true });
        fs.rmSync(place.admin, { recursive: true, force: true });
        place.connection.send({ type: 'cancel', op });

        expect((await ended).end).toMatchObject({ event: 'cancelled' });
        expect({ worktree: fs.existsSync(place.worktree), admin: fs.existsSync(place.admin) }).toEqual({ worktree: false, admin: false });
        await close(place);
        expect({ worktree: fs.existsSync(place.worktree), admin: fs.existsSync(place.admin) }).toEqual({ worktree: false, admin: false });
      } finally {
        slowRemoval?.repair();
      }
    }, 600_000);

    // A daemon of the member's on this machine, such as Paseo's, may run what any local client asks, outside the
    // sandbox: a step reaches no port of this machine but the ones its credentials name.
    it.runIf(target.label === 'real docker')("keeps a step from this machine's ports, and lets it reach the gateway its credentials name there", async () => {
      const daemon = net.createServer((socket) => { socket.end('daemon'); });
      const gateway = http.createServer((_request, response) => { response.end('gateway'); });
      const portOf = async (server: net.Server): Promise<number> => {
        await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });

        return z.object({ port: z.number() }).parse(server.address()).port;
      };

      let place: Opened | undefined;

      try {
        const [daemonPort, gatewayPort] = [await portOf(daemon), await portOf(gateway)];
        const credentials = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1` };
        place = await opened({}, credentials);
        // Another address of the engine's VM, beside the one it names this machine by, as its own services listen on.
        const nameAddress = execFileSync('docker', ['exec', `${place.handle}-proxy`, 'node', '-e', "require('node:dns').lookup('host.docker.internal', (error, address) => console.log(error ? '' : address))"], { encoding: 'utf8' }).trim();
        const neighbour = nameAddress.replace(/\.(\d+)$/, (_all, last: string) => `.${Number(last) === 1 ? 2 : Number(last) - 1}`);
        fs.writeFileSync(path.join(place.worktree, 'probe.js'), REACH);
        const { end, stdout } = await exec(place, { script: `node probe.js ${daemonPort} ${neighbour}`, cwd: place.worktree, credentials });

        expect(end).toMatchObject({ event: 'exited', code: 0 });
        const reached = z.object({ direct: z.string(), tunnel: z.string(), neighbour: z.string(), gateway: z.string() }).parse(JSON.parse(stdout));
        expect(reached.direct).not.toBe('daemon');
        expect(net.isIPv4(neighbour)).toBe(true);
        expect(reached).toMatchObject({ tunnel: '403', neighbour: '403', gateway: '200 gateway' });
      } finally {
        if (place) await close(place);
        daemon.close();
        gateway.close();
      }
    }, 600_000);

    it.runIf(target.engine !== 'sbx')('fails init naming an image that cannot be pulled', async () => {
      const connection = start();
      connection.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options: { ...target.options, image: 'localhost:1/teamai-spec/missing:1' } });
      const reply = await connection.next((message) => message.type === 'init', 300_000);

      expect(reply).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
      expect(JSON.stringify(reply)).toContain('localhost:1/teamai-spec/missing:1');
    }, 600_000);
  });
}

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRuntime, tempDir, type Connection } from '../testing/harness.js';
import { exec, HANDLE, init, nativeHost, newOp, openPlace, placeIn, startOn, type NativeHost, type Place } from '../testing/native-harness.js';
import { closeLeftovers, expectNothingLeft } from '../testing/leaks.js';
import { signalPid } from '@teamai/shared/process-group';

// What a native sandbox keeps a step from, on the real sandbox-exec (macOS) or bwrap (Linux), through the runtime's
// stdio entry point: one probe set for both, after sandcastle's tests/containment.test.ts.
//
// A provider whose platform this is not is skipped. One whose tool does not work here is skipped too, unless
// REQUIRE_NATIVE_SANDBOX is set, as the job that runs these on purpose sets it: then the suite fails, naming the setup.

interface NativeCase {
  provider: 'seatbelt' | 'bwrap';
  platform: NodeJS.Platform;
  /** What makes the tool work here, named when it does not and the suite may not skip. */
  setup: string;
  isUsable(): boolean;
}

const NATIVE: NativeCase[] = [
  {
    provider: 'seatbelt',
    platform: 'darwin',
    setup: 'nothing to install: run on macOS 14 or later, outside any other Seatbelt sandbox',
    isUsable: () => spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0,
  },
  {
    provider: 'bwrap',
    platform: 'linux',
    setup: 'sudo apt-get install -y bubblewrap && sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    isUsable: () => spawnSync('bwrap', ['--die-with-parent', '--new-session', '--unshare-all', '--share-net', '--ro-bind', '/', '/', 'true']).status === 0,
  },
];

const isRequired = (process.env.REQUIRE_NATIVE_SANDBOX ?? '') !== '';

const skipsHere = (native: NativeCase): boolean => process.platform !== native.platform || (!isRequired && !native.isUsable());

/** Each named try's outcome, `ok` or its error code, as one JSON line. */
const TRIES = `
const fs = require('node:fs'); const net = require('node:net'); const path = require('node:path'); const { execFileSync } = require('node:child_process');
const connects = (at) => new Promise((resolve) => { const socket = net.connect(at); socket.on('data', () => { socket.destroy(); resolve('ok'); }); socket.on('error', (error) => resolve(error.code)); });
(async () => {
  const out = {};
  for (const [name, op, ...args] of JSON.parse(process.argv[2])) {
    try {
      if (op === 'kill') { process.kill(Number(args[0]), args[1]); out[name] = 'ok'; }
      else if (op === 'connect') out[name] = await connects(args[0]);
      else if (op === 'ps') out[name] = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).includes(args.join('')) ? 'ok' : 'unseen';
      else if (op === 'rename') { fs.renameSync(args[0], args[1]); out[name] = 'ok'; }
      else if (op === 'write') { fs.mkdirSync(path.dirname(args[0]), { recursive: true }); fs.writeFileSync(args[0], 'planted'); out[name] = 'ok'; }
      else if (op === 'remove') { fs.rmSync(args[0], { recursive: true }); out[name] = 'ok'; }
      else if (op === 'read') { fs.readFileSync(args[0]); out[name] = 'ok'; }
      else if (op === 'list') out[name] = fs.readdirSync(args[0]).includes(args[1]) ? 'ok' : 'unseen';
      else if (op === 'env') out[name] = process.env[args[0]] === undefined ? 'unset' : 'ok';
      else if (op === 'run') { execFileSync(args[0], args.slice(1), { stdio: 'ignore' }); out[name] = 'ok'; }
    } catch (error) { out[name] = error.code ?? String(error.status ?? error.message); }
  }
  console.log(JSON.stringify(out));
})();`;

/** Starts `sleep <seconds>` in the background, then waits on one more: two processes that never end on their own. */
const SLEEPS = `
const { spawn } = require('node:child_process');
spawn('sleep', [process.argv[2]], { stdio: 'ignore' });
spawn('sleep', [process.argv[2]], { stdio: 'inherit' });
console.log('started');`;

/**
 * Keeps starting `sleep <seconds>` from eight shells, each killing the one it started: a step forking all the time, whose
 * child forked as its group is killed outlives that kill, never killed after.
 */
const FORKS = `
const { spawn } = require('node:child_process');
spawn('/bin/sh', ['-c', 'for shell in 1 2 3 4 5 6 7 8; do while :; do sleep "$1" & kill $!; done & done; wait', 'sh', process.argv[2]], { stdio: 'ignore' });
console.log('started');`;

/** A server on the Unix socket `at` that greets each client, closed by the returned function. */
async function listenOn(at: string): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  const server = net.createServer((socket) => socket.end('hi\n'));
  await new Promise<void>((resolve) => { server.listen(at, resolve); });

  return () => new Promise((resolve) => { server.close(() => resolve()); });
}

/**
 * Every process on this machine whose command line holds `marker`, as pid, parent, state and command line: a survivor
 * then says whether it was reaped late (state Z) or kept running, and whose child it was.
 */
function processesWith(marker: string): string[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(marker) && !line.includes('ps -axo'));
}

const outcomes = (output: string): Record<string, string> => JSON.parse(output) as Record<string, string>;

/** Whether each outcome reached its target: `ok`, or denied (any error, or unseen). */
const reached = (output: string): Record<string, boolean> => Object.fromEntries(Object.entries(outcomes(output)).map(([name, outcome]) => [name, outcome === 'ok']));

for (const native of NATIVE) {
  describe.skipIf(skipsHere(native))(`${native.provider}: what a step cannot reach, on this machine`, () => {
    let executable: string;
    let host: NativeHost;
    /** A short directory for what must fit the Unix socket path limit: the place, and the member's home. */
    let short: string;
    const open: Connection[] = [];

    beforeAll(async () => {
      if (!native.isUsable()) throw new Error(`${native.provider} does not work on this ${native.platform} machine, and REQUIRE_NATIVE_SANDBOX is set. Set it up with: ${native.setup}`);
      executable = await bundleRuntime(tempDir());
    }, 60_000);

    beforeEach(() => {
      host = nativeHost(tempDir());
      host.tool('tries', TRIES);
      host.tool('sleeps', SLEEPS);
      host.tool('forks', FORKS);
      short = fs.realpathSync(fs.mkdtempSync('/tmp/tsc-'));
    });

    afterEach(async () => {
      const connections = open.splice(0);
      await Promise.all(connections.map((connection) => connection.end()));
      const { invalid, recovered } = await closeLeftovers(connections);
      expect([...connections.flatMap((connection) => connection.invalid), ...invalid]).toEqual([]);
      await expectNothingLeft({ connections: [...connections, ...recovered], dir: host.dir });
      await expectNothingLeft({ connections: [...connections, ...recovered], dir: short });
      fs.rmSync(host.dir, { recursive: true, force: true });
      fs.rmSync(short, { recursive: true, force: true });
    });

    /** The runtime on the real sandbox, the member's home under `short`, and a place opened there. */
    async function opened({ readonly, env = {} }: { readonly?: (at: Place) => string[]; env?: NodeJS.ProcessEnv } = {}): Promise<{ connection: Connection; at: Place; home: string }> {
      const home = path.join(short, 'h');
      fs.mkdirSync(home, { recursive: true });
      const connection = startOn(executable, host, open, { PATH: [host.tools, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home, TMPDIR: host.dir, SANDBOX_TEST_SYSTEM_BIN: undefined, ...env });
      expect(await init(connection, { provider: native.provider })).toMatchObject({ ok: true });
      const at = placeIn(path.join(short, 'p'));
      const { ready } = await openPlace(connection, at, readonly ? { readonly: readonly(at) } : {});
      expect(ready).toMatchObject({ event: 'ready' });

      return { connection, at, home };
    }

    async function tries(connection: Connection, at: Place, list: unknown[][]): Promise<string> {
      const { end, output, stderr } = await exec(connection, { argv: ['tries', JSON.stringify(list)], cwd: at.worktree });
      expect(end, stderr).toMatchObject({ event: 'exited', code: 0 });

      return output;
    }

    async function close(connection: Connection): Promise<void> {
      connection.send({ type: 'close', handle: HANDLE });
      await connection.next((message) => message.event === 'closed' && message.handle === HANDLE, 30_000);
    }

    it('runs the tools a step needs: a shell, git and node', async () => {
      const { connection, at } = await opened();

      expect(outcomes(await tries(connection, at, [['sh', 'run', '/bin/sh', '-c', 'true'], ['git', 'run', 'git', '--version'], ['node', 'run', process.execPath, '-e', '0']]))).toEqual({ sh: 'ok', git: 'ok', node: 'ok' });
      await close(connection);
    });

    it("keeps the member's home, temp directory and other repositories out of reach, and lets the step write only its place", async () => {
      const { connection, at, home } = await opened();
      fs.writeFileSync(path.join(home, 'secret'), 'member secret');
      const other = path.join(short, 'other-repo');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'file'), 'other');
      fs.writeFileSync(path.join(host.dir, 'member-tmp-file'), 'tmp');

      const output = await tries(connection, at, [
        ['readHome', 'read', path.join(home, 'secret')], ['listHome', 'list', home, 'secret'], ['readOther', 'read', path.join(other, 'file')],
        ['readTmp', 'read', path.join(host.dir, 'member-tmp-file')], ['writeOutside', 'write', path.join(short, 'outside.txt')],
        ['writeWorktree', 'write', path.join(at.worktree, 'made.txt')], ['writeResult', 'write', path.join(at.result, 'out.json')], ['readGit', 'list', at.git, 'HEAD'],
      ]);

      // A write outside the place fails on seatbelt, and lands in bwrap's own /tmp: either way, never on this machine.
      expect({ ...reached(output), writeOutside: undefined }).toEqual({ readHome: false, listHome: false, readOther: false, readTmp: false, writeOutside: undefined, writeWorktree: true, writeResult: true, readGit: true });
      expect(fs.existsSync(path.join(short, 'outside.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(at.worktree, 'made.txt'), 'utf8')).toBe('planted');
      await close(connection);
    });

    it('keeps a variable of the member out of the step', async () => {
      const { connection, at } = await opened({ env: { MEMBER_CANARY: 'member-canary-value' } });

      expect(outcomes(await tries(connection, at, [['canary', 'env', 'MEMBER_CANARY'], ['path', 'env', 'PATH']]))).toEqual({ canary: 'unset', path: 'ok' });
      await close(connection);
    });

    it('keeps a step from signalling or listing a process it did not start, and from a Unix socket outside its place', async () => {
      const { connection, at } = await opened();
      const marker = `61.${process.pid}${Date.now() % 1000}`;
      const sleeper = spawn('sleep', [marker], { detached: true, stdio: 'ignore' });
      const closeOutside = await listenOn(path.join(short, 'o', 's.sock'));
      const closeInside = await listenOn(path.join(at.worktree, 's.sock'));

      try {
        const output = await tries(connection, at, [
          ['signal', 'kill', String(sleeper.pid), 'SIGCONT'], ['probe', 'kill', String(sleeper.pid), 0], ['list', 'ps', 'sleep 6', marker.slice(1)],
          ['outside', 'connect', path.join(short, 'o', 's.sock')], ['inside', 'connect', path.join(at.worktree, 's.sock')],
        ]);

        expect(reached(output)).toEqual({ signal: false, probe: false, list: false, outside: false, inside: true });
      } finally {
        sleeper.kill('SIGKILL');
        await closeOutside();
        await closeInside();
        await close(connection);
      }
    });

    it("keeps a step from a container engine's socket", async () => {
      const home = path.join(short, 'h');
      const sockets = ['.docker/run/docker.sock', '.colima/default/docker.sock', '.orbstack/run/docker.sock', '.lima/default/sock/docker.sock', '.rd/docker.sock'].map((at) => path.join(home, at));
      const closes = await Promise.all(sockets.map(listenOn));

      try {
        const { connection, at } = await opened();
        const output = await tries(connection, at, sockets.map((socket, index) => [String(index), 'connect', socket]));

        expect(Object.values(reached(output))).toEqual(sockets.map(() => false));
        await close(connection);
      } finally {
        await Promise.all(closes.map((closeServer) => closeServer()));
      }
    });

    it('keeps the git files read only, and the folders that hold them in place', async () => {
      const { connection, at } = await opened({
        readonly: (place) => {
          // A clone's own git directory inside the worktree, one folder down, besides the worktree's git paths.
          const gitDir = path.join(place.worktree, 'repo', '.git');
          fs.mkdirSync(path.join(gitDir, 'hooks'), { recursive: true });
          fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n');
          fs.mkdirSync(path.join(place.git, 'hooks'), { recursive: true });
          fs.writeFileSync(path.join(place.git, 'config'), '[core]\n');

          return [place.git, place.dotGit, gitDir];
        },
      });
      const gitDir = path.join(at.worktree, 'repo', '.git');

      const output = await tries(connection, at, [
        ['config', 'write', path.join(at.git, 'config')], ['hook', 'write', path.join(at.git, 'hooks', 'pre-commit')], ['pointer', 'write', at.dotGit],
        ['movePointer', 'rename', at.dotGit, path.join(at.worktree, 'aside')], ['removePointer', 'remove', at.dotGit],
        ['innerConfig', 'write', path.join(gitDir, 'config')], ['innerHook', 'write', path.join(gitDir, 'hooks', 'pre-commit')],
        ['moveGit', 'rename', gitDir, path.join(at.worktree, 'repo', 'aside')], ['moveParent', 'rename', path.join(at.worktree, 'repo'), path.join(at.worktree, 'aside')],
        ['removeParent', 'remove', path.join(at.worktree, 'repo')], ['ownFile', 'write', path.join(at.worktree, 'repo', 'file.txt')],
      ]);

      expect(reached(output)).toEqual({ config: false, hook: false, pointer: false, movePointer: false, removePointer: false, innerConfig: false, innerHook: false, moveGit: false, moveParent: false, removeParent: false, ownFile: true });
      expect(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')).toBe('[core]\n');
      expect(fs.readFileSync(path.join(at.git, 'config'), 'utf8')).toBe('[core]\n');
      expect(fs.readFileSync(at.dotGit, 'utf8')).toBe(`gitdir: ${at.git}\n`);
      await close(connection);
    });

    it.runIf(native.provider === 'bwrap')("never mounts WSL's Windows drives or interop, even when PATH names them", async () => {
      const { connection, at } = await opened({ env: { PATH: [host.tools, path.dirname(process.execPath), '/usr/bin', '/bin', '/mnt', '/mnt/c/Windows/System32', '/run/WSL'].join(path.delimiter) } });

      expect(reached(await tries(connection, at, [['mnt', 'list', '/mnt'], ['wsl', 'list', '/run/WSL']]))).toEqual({ mnt: false, wsl: false });
      await close(connection);
    });

    describe('after a SIGKILL of the runtime', () => {
      /** Kills the runtime once `isStarted` holds for `tool`'s step, and returns its processes still alive a few seconds later. */
      async function survivorsOfKill(isStarted: (marker: string) => boolean, tool = 'sleeps'): Promise<string[]> {
        const { connection, at } = await opened();
        // Unique to this run, so no other process's command line holds it.
        const marker = `765.${process.pid}${Date.now() % 1000}`;
        connection.send({ type: 'exec', op: newOp(), handle: HANDLE, argv: [tool, marker], env: {}, unset: [], credentials: {}, cwd: at.worktree });

        try {
          await vi.waitFor(() => { expect(isStarted(marker)).toBe(true); }, { timeout: 10_000, interval: 20 });
          connection.child.kill('SIGKILL');
          await connection.end();
          await vi.waitFor(() => { expect(processesWith(marker)).toEqual([]); }, { timeout: 5_000, interval: 100 }).catch(() => undefined);

          return processesWith(marker);
        } finally {
          // Whatever is left, a step that still forks included, until nothing names the marker.
          await vi.waitFor(() => {
            const left = processesWith(marker);

            for (const line of left) signalPid(Number(line.trim().split(/\s+/)[0]), 'SIGKILL');
            expect(left).toEqual([]);
          }, { timeout: 5_000, interval: 100 });
        }
      }

      it("leaves none of the step's processes running", async () => {
        expect(await survivorsOfKill((marker) => processesWith(`sleep ${marker}`).length >= 2)).toEqual([]);
      }, 30_000);

      it("leaves none of the step's processes running while the exec is still starting", async () => {
        expect(await survivorsOfKill((marker) => processesWith(marker).length > 0)).toEqual([]);
      }, 30_000);

      it("leaves none of the step's processes running while the step starts more of them", async () => {
        expect(await survivorsOfKill((marker) => processesWith(`sh ${marker}`).length >= 8, 'forks')).toEqual([]);
      }, 30_000);
    });
  });
}

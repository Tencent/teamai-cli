import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PlaceViewSchema, type Can, type RuntimeFailure } from '@teamai/runtime-protocol';
import { signalGroup } from '@teamai/shared/process-group';
import { readRegularFileSync, writeRegularFile, writeRegularFileSync } from '@teamai/shared/regular-file';
import { COMMAND_MS, handleOf, type ExecEnd, type ExecSpec, type Provider } from '../provider.js';
import { offerSignedIn, type SignInProvider } from '../sign-in.js';
import { commandsOf, definedOnly, LAUNCHABLE, WORKSPACES } from './cli.js';

// ─── Native sandboxes: seatbelt (macOS) and bwrap (Linux) ───
//
//  The operating system sandboxes each process on its own, so nothing is started at open and nothing lives between
//  execs. Each exec is a fresh sandboxed process on this machine's own tools, never root:
//
//    <state>/teamai-<run>-<attempt>/view.json   the place view open gave, which each exec's sandbox is built from
//    <state>/teamai-<run>-<attempt>/home        the step's home, empty: the member's home is out of its reach
//    <state>/teamai-<run>-<attempt>/tmp         the step's temp directory
//    <state>/teamai-<run>-<attempt>/pids/<pid>  one file per exec running, its process group, so a stop from another
//                                               runtime process (a cancel after a restart) reaches it
//
//  The place view's paths are reachable with the access the view gives them; the PATH's directories and their install
//  roots and the system directories are readable; nothing else is, on seatbelt and bwrap alike: not the member's home
//  and temp directory, with the SSH keys, logins and repositories there, nor a repository elsewhere on disk. A step's
//  environment holds only the few names a shell needs (PATH, USER, LANG, …) and what teamai gives the exec: none of the
//  member's own variables reaches it. They share this machine's network, so a URL on this machine reaches it as is.
//

/** The one technology a native provider runs on. */
export interface NativeSandbox {
  provider: Extract<SignInProvider, 'seatbelt' | 'bwrap'>;
  isolation: NonNullable<Can['isolation']>;
  /** Whether a step leased `permissions: unattended` may run here (#1718: seatbelt confines files only, so not there). */
  isUnattended: boolean;
  /** Checks the technology works on this machine, or says how to make it. */
  preflight(env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; message: string }>;
  /** The command that runs `argv` in this sandbox: the sandbox's executable and its arguments, `argv` last. */
  wrap(sandboxed: Sandboxed): { command: string; args: string[] };
}

/** What a sandboxed process may reach, as real paths (a sandbox matches the path a symlink resolves to). */
export interface Sandboxed {
  argv: string[];
  cwd: string;
  /** Read and written: the worktree, result, run directory and tool homes, and the step's own home and temp directory. */
  writable: string[];
  /** Read only: the view's git paths, and this machine's PATH directories and install roots. */
  readable: string[];
  /** The view's git paths: the folders that hold one stay where they are. */
  gitPaths: string[];
  /** The member's home, whose container engines' sockets and state no step reaches; never read either. */
  memberHome: string;
  /** The step's own home and temp directory. */
  home: string;
  tmp: string;
  /** Whether the command starts detached, as an exec does: leading a process group and a session of its own, with no terminal. */
  isDetached: boolean;
  /** The ports of this machine the attempt's credentials name: on seatbelt, the only ones of its loopback the step reaches. */
  hostPorts: readonly number[];
}

/** The variables of the runtime's own environment a step's process keeps: what a shell and a locale need, no secret. */
const KEPT = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ'] as const;

const SIGTERM_GRACE_MS = 2_000;

/**
 * How an exec starts, in the process group of its own it leads: a background shell blocked on fd 3, the read end of a
 * pipe whose write end only the runtime holds, kills the whole group once that pipe ends (the exec ended, or the runtime
 * died, however it died), and the exec's command replaces the launching shell without fd 3. Its first argument is the
 * place's `pids` directory: the watcher removes the group's file there before its first kill, so a runtime that died
 * leaves no file naming a number another group may hold later, which a stop would then signal. The watcher is in place
 * before the sandbox starts, outside it, so no SIGKILL of the runtime, however early, leaves the step running (after
 * sandcastle's `bwrapProcess.ts` watcher and `sandboxes/seatbelt.ts` watchdog). A process the step starts in a session
 * of its own (`setsid`) leaves the group, and outlives it.
 *
 * One kill of a group misses a child macOS forks meanwhile, which then outlives it, so the watcher kills the group until
 * none of it is left, from a group of its own (`set -m`) so it outlives its own kills; for at most five seconds. A shell
 * with no job control here (dash) keeps it in the group, killed with the first kill. On bwrap the step's pid namespace,
 * its init included, stays in the group, as an exec goes without --new-session (bwrap.ts), so the group's kill ends it
 * however early it comes.
 */
const LAUNCH = 'pids=$1; shift\nset -m 2>/dev/null\n{ read -r _ || :; rm -f "$pids/$$"; n=0; while kill -9 -$$ 2>/dev/null && [ $n -lt 50 ]; do n=$((n+1)); sleep 0.1; done; } <&3 >/dev/null 2>&1 &\nset +m 2>/dev/null\nexec 3<&-\nexec "$@"';

/** The executable `name` as `pathVariable` finds it, or undefined. */
export function onPath(name: string, pathVariable: string | undefined): string | undefined {
  if (name.includes('/')) return isExecutable(name) ? name : undefined;

  return (pathVariable ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)).map((dir) => path.join(dir, name)).find(isExecutable);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);

    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `at` with every symlink resolved, or, while it does not exist yet, its nearest existing parent resolved. */
export function realOf(at: string): string {
  try {
    return fs.realpathSync(at);
  } catch {
    const parent = path.dirname(at);

    return parent === at ? at : path.join(realOf(parent), path.basename(at));
  }
}

/** Whether `inner` is `outer` or inside it. */
export function isWithin(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** WSL2's Windows drives and interop, which WSL puts on PATH: never a tool root, so no planted `.exe` runs (sandcastle's `bwrapSandbox.ts`). */
const WINDOWS_ROOTS = ['/mnt', '/run/WSL'];

/**
 * The directories of this machine a step reads its tools from: each PATH directory, and its install root (the parent of
 * a `bin`), and the install root of each executable `argv[0]`, `node` and `git` resolve to through their links. Under the
 * member's home only the directory itself, never its install root: beside `~/.local/bin` sit logins. Never the home or
 * a directory above it, nor one holding `.git`, whose history is the member's, nor WSL's Windows drives.
 */
export function toolRoots(argv0: string, pathVariable: string | undefined, home: string): string[] {
  const entries = (pathVariable ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));

  const executables = [argv0, 'node', 'git'].flatMap((name) => {
    const found = onPath(name, pathVariable);

    return found === undefined ? [] : [path.dirname(realOf(found))];
  });

  const realHome = realOf(home);

  const candidates = [...entries.map(realOf), ...executables].flatMap((dir) => (path.basename(dir) === 'bin' && !isWithin(dir, realHome) ? [dir, path.dirname(dir)] : [dir]));

  return [...new Set(candidates)].filter((dir) => fs.existsSync(dir) && !isWithin(realHome, dir) && !fs.existsSync(path.join(dir, '.git')) && !WINDOWS_ROOTS.some((root) => isWithin(dir, root)));
}

const PidSchema = z.coerce.number().int().positive();

/** Whether the process group `pgid` still has a process. */
function isAlive(pgid: number): boolean {
  const probe = signalGroup(pgid, 0);

  return probe === 'sent' || probe === 'denied';
}

async function until(isDone: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (!isDone()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }

  return true;
}

/**
 * A provider on `sandbox`, keeping each attempt's directory under `state`. `env` is the runtime's own: its PATH finds
 * the tools a step runs and `home` is the member's, which no step reads.
 */
export function nativeProvider({ sandbox, state, env, home }: { sandbox: NativeSandbox; state: string; env: NodeJS.ProcessEnv; home: string }): Provider {
  const { provider } = sandbox;
  const dirOf = (id: string): string => path.join(state, id);
  const pidsOf = (id: string): string => path.join(dirOf(id), 'pids');

  const failed = (message: string) => ({ ok: false, failure: { code: 'sandbox_failed', message } }) satisfies { ok: false; failure: RuntimeFailure };

  /**
   * The process groups of `id`'s execs still running, by their files; a file whose group ended is removed, and so is one
   * written before this machine started, whose number another process may hold now.
   */
  const groupsOf = (id: string): number[] => {
    const dir = pidsOf(id);
    const booted = Date.now() - os.uptime() * 1000;

    return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).flatMap((name) => {
      const pgid = PidSchema.safeParse(name);

      if (pgid.success && isAlive(pgid.data) && (fs.statSync(path.join(dir, name), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= booted) return [pgid.data];
      fs.rmSync(path.join(dir, name), { force: true });

      return [];
    });
  };

  /** Ends every process of `id`'s execs: TERM, then KILL once the grace ran out, ok once none is left. */
  const stop = async (id: string): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const groups = groupsOf(id);

    for (const pgid of groups) signalGroup(pgid, 'SIGTERM');

    if (await until(() => groups.every((pgid) => !isAlive(pgid)), SIGTERM_GRACE_MS)) return { ok: true };

    for (const pgid of groups) signalGroup(pgid, 'SIGKILL');

    if (await until(() => groups.every((pgid) => !isAlive(pgid)), COMMAND_MS - SIGTERM_GRACE_MS)) return { ok: true };
    const left = groups.filter(isAlive);

    return failed(`${provider} could not stop the processes of sandbox ${id} (process groups ${left.join(', ')}). Stop them with \`kill -KILL ${left.map((pgid) => `-${pgid}`).join(' ')}\`.`);
  };

  // A place an earlier runtime wrote names no port: its steps reach none of this machine's.
  const ViewFileSchema = z.object({ view: PlaceViewSchema, hostPorts: z.array(z.number().int().min(1).max(65_535)).default([]) });

  /** The place of sandbox `id`: the view open gave, and the ports of this machine its credentials name. */
  const placeOf = (id: string): z.infer<typeof ViewFileSchema> | undefined => {
    const file = path.join(dirOf(id), 'view.json');

    return fs.existsSync(file) ? ViewFileSchema.parse(JSON.parse(readRegularFileSync(file, 'utf8'))) : undefined;
  };

  /**
   * The sandbox's command line for `spec` in sandbox `id`, its executable found on the runtime's PATH (never one the
   * step sets), and the whole environment it runs with: only what a shell needs, the step's own home and temp
   * directory, and the spec's names, less those it withholds.
   */
  const launchOf = (id: string, spec: ExecSpec, { isDetached }: Pick<Sandboxed, 'isDetached'>): { ok: true; command: string; args: string[]; env: NodeJS.ProcessEnv } | { ok: false; failure: RuntimeFailure } => {
    const place = placeOf(id);

    if (place === undefined) return { ok: false, failure: { code: 'runtime_gone', message: `Sandbox ${id} has no place on this machine any more.` } };
    const { view, hostPorts } = place;
    const [argv0 = ''] = spec.argv;
    const own = { home: realOf(path.join(dirOf(id), 'home')), tmp: realOf(path.join(dirOf(id), 'tmp')) };
    const kept = Object.fromEntries(KEPT.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
    // Claude Code writes /tmp/claude-<uid> whatever TMPDIR says, which the sandbox does not let it write.
    const childEnv: NodeJS.ProcessEnv = { ...kept, HOME: own.home, TMPDIR: own.tmp, CLAUDE_CODE_TMPDIR: own.tmp, ...spec.env };

    for (const name of spec.unset) delete childEnv[name];

    const { command, args } = sandbox.wrap({
      argv: spec.argv,
      cwd: spec.cwd,
      writable: [view.worktree, view.result, view.runDir, ...Object.values(view.toolHome)].map(realOf).concat(own.home, own.tmp),
      readable: [...view.readonly.map(realOf), ...toolRoots(argv0, env.PATH, home)],
      gitPaths: view.readonly.map(realOf),
      memberHome: realOf(home),
      home: own.home,
      tmp: own.tmp,
      isDetached,
      hostPorts,
    });

    return { ok: true, command: onPath(command, env.PATH) ?? command, args, env: childEnv };
  };

  const reachable = async (): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
    const ready = await sandbox.preflight(env);

    return ready.ok ? { ok: true } : { ok: false, failure: { code: 'sandbox_unavailable', message: ready.message } };
  };

  return {
    family: 'bind',
    reachable,
    async offer(credentials, instances) {
      const ready = await reachable();

      if (!ready.ok) return ready;
      const held = new Set([...LAUNCHABLE, ...commandsOf(instances)].filter((command) => onPath(command, env.PATH) !== undefined));

      const { tools, unavailable } = offerSignedIn({
        tools: LAUNCHABLE.filter((tool) => held.has(tool)), provider, credentials, stored: new Set(), env, instances,
        missing: (command) => (held.has(command) ? undefined : { holder: "this machine's PATH", fix: 'install it' }),
      });

      const can: Can = { workspace: WORKSPACES, isolation: sandbox.isolation, env: true, tokens: true, max_turns: true, setup: true, tools, end_turn: true, ...(sandbox.isUnattended && { unattended: true }), role: true };

      // A step shares this machine's network: a URL on this machine reaches it at its IPv4 loopback.
      return { ok: true, can, host: { ok: true, alias: '127.0.0.1' }, unavailable, ownLogins: [], unusedGateways: {} };
    },

    find: async (key) => ({ ok: true, id: fs.existsSync(dirOf(handleOf(key))) ? handleOf(key) : undefined }),

    async owned() {
      const names = fs.existsSync(state) ? fs.readdirSync(state) : [];

      return {
        ok: true,
        sandboxes: names.flatMap((name) => {
          const [prefix, run, attempt, ...more] = name.split('-');

          return prefix === 'teamai' && run && attempt && more.length === 0 ? [{ id: name, run, attempt }] : [];
        }),
      };
    },

    async create(key, { view, hostPorts }) {
      const id = handleOf(key);

      // A writable path made here is the member's, as a bind mount's is.
      for (const at of [view.worktree, view.result, view.runDir, ...Object.values(view.toolHome)]) fs.mkdirSync(at, { recursive: true });

      for (const sub of ['home', 'tmp', 'pids']) fs.mkdirSync(path.join(dirOf(id), sub), { recursive: true, mode: 0o700 });
      await writeRegularFile(path.join(dirOf(id), 'view.json'), JSON.stringify({ view, hostPorts }), { mode: 0o600 });

      return { ok: true, id };
    },

    ...(sandbox.isolation === 'sandbox' && {
      client(id: string, spec: ExecSpec) {
        // An app's runtime may start the tool on a terminal.
        const launch = launchOf(id, spec, { isDetached: false });

        return launch.ok ? { ok: true as const, argv: [launch.command, ...launch.args], env: definedOnly(launch.env) } : launch;
      },
    }),

    async exec(id, spec: ExecSpec, onOutput): Promise<ExecEnd> {
      const launch = launchOf(id, spec, { isDetached: true });

      if (!launch.ok) return { kind: 'failed', failure: launch.failure };
      const { command, args, env: childEnv } = launch;

      return new Promise((resolve) => {
        // A process group of its own, so a stop ends the step and whatever it started.
        // Found on the runtime's PATH, never on one the step sets.
        const child = spawn('/bin/sh', ['-c', LAUNCH, 'sh', pidsOf(id), command, ...args], { cwd: spec.cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        const pidFile = child.pid === undefined ? undefined : path.join(pidsOf(id), String(child.pid));

        if (pidFile) writeRegularFileSync(pidFile, '');
        // Ending the watch pipe ends the group: nothing the step started outlives it, as nothing outlives a bwrap namespace.
        child.on('exit', () => child.stdio[3]?.destroy());
        // Pipes, as stdio asks; typed nullable only because node types no fourth stdio entry.
        child.stdout?.setEncoding('utf8').on('data', (data: string) => onOutput('stdout', data));
        child.stderr?.setEncoding('utf8').on('data', (data: string) => onOutput('stderr', data));
        child.on('error', (error) => {
          if (pidFile) fs.rmSync(pidFile, { force: true });
          resolve({ kind: 'failed', failure: { code: 'exec_failed', message: `${provider} could not start: ${error.message}` } });
        });
        child.on('close', (code, ended) => {
          if (pidFile) fs.rmSync(pidFile, { force: true });
          resolve({ kind: 'exited', code: code ?? (ended === 'SIGKILL' ? 137 : 143) });
        });
      });
    },

    stop,

    async destroy(id) {
      const stopped = await stop(id);

      if (!stopped.ok) return stopped;
      fs.rmSync(dirOf(id), { recursive: true, force: true });

      return { ok: true };
    },

    name: (key) => dirOf(handleOf(key)),
    display: (key) => ({ label: `${handleOf(key)} (${provider})` }),

    removal: (place) => `remove ${dirOf(handleOf(place))} once nothing of it runs`,
  };
}

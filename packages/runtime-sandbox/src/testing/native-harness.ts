import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { connect, type Connection, type Message } from './harness.js';

// ─── Test support for the native providers, seatbelt and bwrap ───
//
//  `nativeHost` lays out a host for the runtime: a home, a PATH holding the tools as node scripts, and, unless the test
//  runs the real one, a stand-in `sandbox-exec`, `sw_vers` and `bwrap` that record their argv (paths only, never an
//  environment value) and then run the command they were given, as the real ones do once they set up the sandbox. The
//  runtime runs `sandbox-exec` and `sw_vers` from `/usr/bin` only, never from PATH; the test bundle reads them from
//  `SANDBOX_TEST_SYSTEM_BIN`, which `env` sets to the stand-ins' own directory (a test running the real ones unsets it).
//

export interface NativeHost {
  dir: string;
  /** The member's home, as the runtime sees it. */
  home: string;
  /** The directory the tools are in, on the runtime's PATH. */
  tools: string;
  /** The directory the stand-ins are in, first on the runtime's PATH unless the real sandbox is asked for. */
  fakes: string;
  /** The directory the stand-ins for macOS's own `/usr/bin` tools are in (`sandbox-exec`, `sw_vers`), never on PATH. */
  system: string;
  /** Adds `name` to the tools, a script that runs `body` in node. */
  tool(name: string, body: string): void;
  /** Every argv a stand-in was run with, as `[name, ...args]`. */
  calls(): string[][];
  /** The runtime's environment: PATH, HOME, and `extra` over them. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

const LoggedSchema = z.array(z.string());

/**
 * A stand-in that logs its argv as one JSON line, then skips the options its real counterpart takes before the command
 * and runs that command in its own place, as `exec` does: same pid, so a stop of its process group reaches the step.
 * `skip` is a shell `case` body that shifts past one option and its operands.
 */
function standIn(name: string, log: string, skip: string): string {
  return `#!/bin/sh
"${process.execPath}" -e 'require("node:fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${log}" "${name}" "$@"
if [ -f "$(dirname "$0")/${name}.fails" ]; then cat "$(dirname "$0")/${name}.fails" >&2; exit 1; fi
while [ $# -gt 0 ]; do
  case "$1" in
${skip}
    --) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
`;
}

export function nativeHost(dir: string): NativeHost {
  const home = path.join(dir, 'home');
  const tools = path.join(dir, 'tools-bin');
  const fakes = path.join(dir, 'native-bin');
  const system = path.join(dir, 'system-bin');
  const log = path.join(dir, 'native.log');

  for (const at of [home, tools, fakes, system]) fs.mkdirSync(at, { recursive: true });

  fs.writeFileSync(path.join(system, 'sandbox-exec'), standIn('sandbox-exec', log, '    -p|-f|-n|-D) shift 2 ;;'), { mode: 0o755 });
  fs.writeFileSync(path.join(system, 'sw_vers'), '#!/bin/sh\necho "${FAKE_MACOS_VERSION:-15.1}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fakes, 'bwrap'), standIn('bwrap', log, [
    '    --bind|--ro-bind|--bind-try|--ro-bind-try|--dev-bind|--symlink|--setenv) shift 3 ;;',
    '    --proc|--dev|--tmpfs|--dir|--unsetenv|--remount-ro) shift 2 ;;',
    '    --chdir) cd "$2" || exit 1; shift 2 ;;',
    '    --*) shift ;;',
  ].join('\n')), { mode: 0o755 });

  return {
    dir, home, tools, fakes, system,
    tool(name, body) {
      fs.writeFileSync(path.join(tools, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => LoggedSchema.parse(JSON.parse(line))) : []),
    env: (extra = {}) => ({ PATH: [fakes, tools, '/usr/bin', '/bin'].join(path.delimiter), HOME: home, SANDBOX_TEST_SYSTEM_BIN: system, ...extra }),
  };
}

/** Makes the stand-in `name` fail before it runs anything, printing `stderr`, as a sandbox that cannot start. */
export function failStandIn(host: NativeHost, name: 'sandbox-exec' | 'bwrap', stderr: string): void {
  fs.writeFileSync(path.join(name === 'sandbox-exec' ? host.system : host.fakes, `${name}.fails`), `${stderr}\n`);
}

export const RUN = 'r0123abcd';
export const ATTEMPT = 'a0123abcd';
export const HANDLE = `teamai-${RUN}-${ATTEMPT}`;

let opCount = 0;

export function newOp(): string {
  opCount += 1;

  return `op-${opCount.toString(16).padStart(8, '0')}`;
}

/** An attempt's place view on the host: its worktree, git paths, result, run directory and tool home. */
export interface Place {
  worktree: string;
  git: string;
  /** The worktree's own `.git` file, read only inside the writable worktree, as teamai gives a linked worktree's. */
  dotGit: string;
  result: string;
  runDir: string;
  toolHome: string;
}

/** A place under `root`, its worktree and git path made, as teamai makes them before `open`. */
export function placeIn(root: string): Place {
  const at = { worktree: path.join(root, 'worktree'), git: path.join(root, 'repo.git'), result: path.join(root, 'attempts', ATTEMPT, 'out'), runDir: path.join(root, 'runs', RUN, 'scratch'), toolHome: path.join(root, 'attempts', ATTEMPT, 'tool-home', 'claude'), dotGit: path.join(root, 'worktree', '.git') };
  fs.mkdirSync(at.worktree, { recursive: true });
  fs.mkdirSync(at.git, { recursive: true });
  fs.writeFileSync(path.join(at.git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(at.dotGit, `gitdir: ${at.git}\n`);

  return at;
}

export async function init(connection: Connection, options: Message, credentials?: { env: string[]; logins: string[] }, instances?: Message[]): Promise<Message> {
  connection.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'unattended', options, ...(credentials && { credentials }), ...(instances && { instances }) });

  return connection.next((message) => message.type === 'init', 30_000);
}

/** Opens the attempt's place and waits until it is ready, or failed. */
export async function openPlace(connection: Connection, at: Place, { op = newOp(), tool, credentials = {}, readonly = [at.git, at.dotGit] }: { op?: string; tool?: string; credentials?: Record<string, string>; readonly?: string[] } = {}): Promise<{ accepted: Message; ready: Message }> {
  connection.send({ type: 'open', op, run: RUN, attempt: ATTEMPT, ...(tool && { tool }), credentials, view: { worktree: at.worktree, readonly, result: at.result, runDir: at.runDir, toolHome: { CLAUDE_CONFIG_DIR: at.toolHome } } });
  const accepted = await connection.next((message) => message.op === op && (message.event === 'accepted' || message.event === 'failed'));
  const ready = accepted.event === 'failed' ? accepted : await connection.next((message) => message.op === op && (message.event === 'ready' || message.event === 'failed'), 30_000);

  return { accepted, ready };
}

/** Sends one exec and waits for its end, with what it printed on stdout. */
export async function exec(connection: Connection, request: { argv: string[]; env?: Record<string, string>; unset?: string[]; credentials?: Record<string, string>; cwd: string }, op = newOp()): Promise<{ end: Message; output: string; stderr: string }> {
  connection.send({ type: 'exec', op, handle: HANDLE, env: {}, unset: [], credentials: {}, ...request });
  const end = await connection.next((message) => message.op === op && ['exited', 'cancelled', 'failed'].includes(String(message.event)), 30_000);
  const printed = (stream: string): string => connection.messages.filter((message) => message.op === op && message.event === 'output' && message.stream === stream).map((message) => String(message.data)).join('');

  return { end, output: printed('stdout'), stderr: printed('stderr') };
}

/** Starts the runtime at `executable` on `host`, remembering the connection in `open` so the test ends it. */
export function startOn(executable: string, host: NativeHost, open: Connection[], extra: NodeJS.ProcessEnv = {}): Connection {
  const connection = connect(executable, host.env(extra));
  open.push(connection);

  return connection;
}

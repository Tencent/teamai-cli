import fs from 'node:fs';
import path from 'node:path';
import { OuterHandleSchema } from '@teamai/runtime-kit/outer';
import { expectNothingLeft as expectNothingLeftBy } from '@teamai/runtime-testing/leaks';
import { z } from 'zod';
import { connect, type Connection } from './harness.js';
import { entriesUnder } from '@teamai/shared/entries-under';

// ─── What a test left behind ───
//
//  Every sandbox harness ends a test with `expectNothingLeft`, so a test that leaves a process, a container, an
//  attempt's state directory or a hosted sandbox fails, and a new test is checked without asking (after sandcastle's
//  testGlobalSetup.ts and "leaves no temp dir behind" checks). What a runtime said it leaves, in an answer's `kept`, is
//  no leak: `@teamai/runtime-testing/leaks` reads it from the connections' lines.
//

/** The test's own directory, its runtimes, and what else it may have made a sandbox in. */
export interface Scope {
  /** The test's directory: everything it made is under it. */
  dir: string;
  /** Every runtime the test started, the ones `closeLeftovers` started included. */
  connections?: readonly Connection[];
  /** The fake engine's containers (and sbx sandboxes), when the test runs one. */
  containers?: () => string[];
  /** The fake Vercel's state directory, when the test runs it. */
  vercelState?: string;
  /** What the test planted itself, by name: what a runtime leaves on purpose it says in `kept`. */
  planted?: readonly string[];
}

/** An attempt's state directory, as a provider names it: `teamai-<run>-<attempt>`, after an owner id on sbx. */
const ATTEMPT_DIR = /^teamai-(?:[0-9a-f]{16}-)?r[0-9a-f]+-a[0-9a-f]+$/;

/** Every directory under the runtime state of a home under `dir` that is an attempt's. */
function attemptDirsUnder(dir: string): string[] {
  return entriesUnder(dir).map(({ entry }) => entry).filter((entry) => entry.isDirectory() && ATTEMPT_DIR.test(entry.name) && entry.parentPath.includes(`${path.sep}runtime-state${path.sep}`)).map((entry) => path.join(entry.parentPath, entry.name));
}

/** When this module loaded: a file a fake sandbox wrote on the host since then is the suite's. */
const LOADED_AT = Date.now();

/**
 * The pid files a process the fake engine runs wrote into the host's /tmp since the suite started: its processes run on
 * the host, so a write a container would keep in its own /tmp lands there unless the fake maps it.
 */
function hostTmpFilesWritten(): string[] {
  if (!fs.existsSync('/tmp')) return [];

  return fs.readdirSync('/tmp').filter((name) => /^teamai-tool-[0-9a-f]+\.pid$/.test(name)).flatMap((name) => {
    const file = path.join('/tmp', name);
    const written = fs.statSync(file, { throwIfNoEntry: false });

    return written !== undefined && written.mtimeMs >= LOADED_AT ? [file] : [];
  });
}

/** An open's answer whose handle is an outer handle, which names the place's socket. */
const AcceptedOuterSchema = z.object({ event: z.literal('accepted'), handle: z.string().startsWith('{') });

/**
 * The folders of the attempt sockets the test's runtimes accepted a place with that are still there: a runtime that
 * stops serving a place removes its socket's folder, which may sit under the temp directory, outside the test's own.
 */
function socketFoldersLeft(connections: readonly Connection[]): string[] {
  const sockets = connections.flatMap(({ messages }) => messages.flatMap((message) => {
    const accepted = AcceptedOuterSchema.safeParse(message);
    const handle = accepted.success ? OuterHandleSchema.safeParse(JSON.parse(accepted.data.handle)) : undefined;

    return handle?.success === true ? [handle.data.socket] : [];
  }));

  return [...new Set(sockets.map((socket) => path.dirname(socket)))].filter((folder) => fs.existsSync(folder));
}

/** What the test left of sandboxes, as `<kind> <name>`: containers, attempts' state directories, hosted sandboxes, attempt sockets' folders, and host files a fake container wrote. */
function sandboxesLeft({ dir, connections = [], containers, vercelState, planted = [] }: Scope): string[] {
  const sandboxes = vercelState === undefined ? undefined : path.join(vercelState, 'sandboxes');

  return [
    ...hostTmpFilesWritten().map((file) => `host file ${file}`),
    ...socketFoldersLeft(connections).map((folder) => `socket folder ${folder}`),
    ...(containers?.() ?? []).filter((name) => !planted.includes(name)).map((name) => `container ${name}`),
    ...(fs.existsSync(dir) ? attemptDirsUnder(dir).filter((at) => !planted.includes(path.basename(at))).map((at) => `attempt ${at}`) : []),
    ...(sandboxes !== undefined && fs.existsSync(sandboxes) ? fs.readdirSync(sandboxes).map((name) => `vercel ${name}`) : []),
  ];
}

/**
 * Fails the test, naming each thing it left, when it left anything: a runtime still running, a process naming its
 * directory, or a sandbox, but what a runtime said it keeps and what the test planted.
 */
export function expectNothingLeft(scope: Scope): Promise<void> {
  return expectNothingLeftBy({ dir: scope.dir, connections: (scope.connections ?? []).map(({ runtime }) => runtime), left: () => sandboxesLeft(scope) });
}

/**
 * Closes every place a test's runtimes left in their journal, as teamai does after a crash: a runtime started again in
 * `recover` mode on the same home, with the options the test's last `init` gave, and a `close` of each place. What is
 * left after that is a leak of the runtime's own, which `expectNothingLeft` names.
 */
export async function closeLeftovers(connections: Connection[]): Promise<{ invalid: string[]; recovered: Connection[] }> {
  const invalid: string[] = [];
  const recovered: Connection[] = [];
  const homes = new Map<string, Connection>();

  for (const connection of connections) {
    if (connection.env.HOME !== undefined && connection.sent.some((request) => request.type === 'init')) homes.set(connection.env.HOME, connection);
  }

  for (const [home, last] of homes) {
    const places = path.join(home, '.teamai', 'runtime-state', 'sandbox', 'places');
    const handles = fs.existsSync(places) ? fs.readdirSync(places).filter((name) => name.endsWith('.json')).map((name) => decodeURIComponent(name.slice(0, -'.json'.length))) : [];

    if (handles.length === 0) continue;
    const options = connections.filter((connection) => connection.env.HOME === home).flatMap((connection) => connection.sent).findLast((request) => request.type === 'init')?.options ?? {};
    const recover = connect(last.executable, last.env);
    recovered.push(recover);
    recover.send({ type: 'init', protocol: 1, homeEnv: {}, mode: 'recover', options });
    await recover.next((message) => message.type === 'init', 30_000);

    for (const handle of handles) {
      recover.send({ type: 'close', handle });
      await recover.next((message) => message.handle === handle && (message.event === 'closed' || message.event === 'failed'), 60_000);
    }

    await recover.end();
    invalid.push(...recover.invalid);
  }

  return { invalid, recovered };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eachLine } from '@teamai/runtime-kit/serve';
import { ConnectedSchema, OuterHandleSchema, RegisterSchema } from '@teamai/runtime-kit/outer';
import type { RuntimeFailure } from '@teamai/runtime-protocol';
import { z } from 'zod';

// ─── The attempt socket ──────────────────────────────────
//
//  When an app's runtime (T3 Code, Paseo) runs a step's tool through this sandbox (`use: t3, through: sandbox`), the
//  app launches teamai's wrapper, `teamai-sandbox-<tool>`, in place of the tool. The wrapper asks this runtime, over a
//  unix socket of the attempt's, how to start the tool in the attempt's sandbox. Two kinds of client, JSON lines:
//
//    inner runtime   > {"register":{"agent":"<id>"|null}}          < {"connected":{"agent":"<id>"|null}} once granted
//    wrapper         > {"ask":{"tool":"claude","agent":…,"cwd":…}}  < {"grant":{"argv":[…],"cwd":"…","env":{…}}}
//                                                                    or {"refused":{"code":"…","message":"…"}}
//
//  The socket is mode 0600 in a 0700 directory beside the attempt's result directory, outside every path the sandbox
//  mounts. Its path travels in the place's handle, which teamai gives the inner runtime as `outer`. A grant's values
//  are the step's credentials, held in this runtime's memory only: never on disk, never in an argv (`-e NAME`).
//

/** The place a handle names: the handle itself, or the place of an outer handle. */
export function placeOf(handle: string): string {
  if (!handle.startsWith('{')) return handle;

  try {
    return OuterHandleSchema.parse(JSON.parse(handle)).place;
  } catch {
    return handle;
  }
}

const AgentSchema = RegisterSchema.shape.register.shape.agent;

export const SocketRequestSchema = z.union([
  RegisterSchema,
  z.object({ ask: z.object({ tool: z.string().min(1), agent: AgentSchema, cwd: z.string().min(1) }) }),
]);

export type SocketRequest = z.infer<typeof SocketRequestSchema>;

export type Ask = Extract<SocketRequest, { ask: unknown }>['ask'];

/** How the wrapper starts the tool: `argv` with `env` as the whole environment of that process, nothing of its own. */
export const GrantSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  /** The command line that sends a signal to the tool in the sandbox, its name last, when the exec client does not. */
  signal: z.array(z.string()).min(1).optional(),
});

export type Grant = z.infer<typeof GrantSchema>;

export const AnswerSchema = z.union([
  z.object({ grant: GrantSchema }),
  z.object({ refused: z.object({ code: z.string().min(1), message: z.string() }) }),
  ConnectedSchema,
]);

export type Answer = z.infer<typeof AnswerSchema>;

/** The longest path a unix socket binds: sun_path less its NUL (104 bytes on macOS, 108 on Linux). */
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

/**
 * Where the attempt's socket lives: `<attempt>/sandbox/attempt.sock` beside its result directory, or, when that path is
 * past what a socket can bind, a directory of this user's own under the temp directory, named after the place so that
 * a reopen and a restarted runtime find the same path.
 */
export function socketPathOf({ result, place }: { result: string; place: string }): string {
  const beside = path.join(path.dirname(result), 'sandbox', 'attempt.sock');

  if (Buffer.byteLength(beside) <= SOCKET_PATH_MAX) return beside;

  return path.join(os.tmpdir(), `teamai-${crypto.createHash('sha256').update(`${result}\0${place}`).digest('hex').slice(0, 16)}`, 'attempt.sock');
}

/** What the socket asks of the runtime: the grant for one wrapper's ask, or why not. */
export type Answering = (ask: Ask) => Promise<{ ok: true; grant: Grant } | { ok: false; failure: RuntimeFailure }>;

export interface AttemptSocket {
  path: string;
  /** Stops listening and removes the socket and its directory. */
  close(): Promise<void>;
}

/** Whether a live process listens on `socketPath`: a socket file a stopped runtime left accepts no connection. */
function isServed(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

/**
 * Removes the folder of the socket at `socketPath` a runtime that stopped serving it left, as one that dies before its
 * place closes does: a socket another runtime still serves stays that runtime's, and a folder that is not this user's
 * own is not touched. Left as it is when it cannot be removed: it holds no secret, and the next listen replaces it.
 */
export async function removeLeftSocket(socketPath: string): Promise<void> {
  const dir = path.dirname(socketPath);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });

  if (stat === undefined || !stat.isDirectory() || stat.uid !== process.getuid?.() || await isServed(socketPath)) return;

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Left for the next listen on this place, as a close that cannot remove its folder leaves it.
  }
}

/**
 * Listens on `socketPath` for the inner runtime's registration and the wrapper's asks. Only the registered agent is
 * served, while the connection it registered on stays open: an ask before any registration, after that connection
 * closed, or from another agent (an app's helper agents in the same worktree), is refused. A socket another runtime still serves (one teamai started to stop the run reattaches too) stays that
 * runtime's. Never keeps this process alive on its own.
 */
export async function listen(socketPath: string, answer: Answering): Promise<{ ok: true; socket: AttemptSocket } | { ok: false; failure: RuntimeFailure }> {
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) {
    return { ok: false, failure: { code: 'sandbox_failed', message: `The attempt socket ${socketPath} is longer than a unix socket path can be (${SOCKET_PATH_MAX} bytes). Set TMPDIR to a shorter directory, and start again.` } };
  }

  const dir = path.dirname(socketPath);

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);

    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error(`${dir} is not a directory of this user's`);
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    return { ok: false, failure: { code: 'sandbox_failed', message: `The attempt socket cannot be made in ${dir}: ${error instanceof Error ? error.message : String(error)}` } };
  }

  if (await isServed(socketPath)) {
    return { ok: false, failure: { code: 'sandbox_failed', message: `Another sandbox runtime still serves the attempt socket ${socketPath}, so this one leaves it to that runtime` } };
  }

  try {
    // A socket a runtime of this place left when it stopped; this runtime serves the place now.
    fs.rmSync(socketPath, { force: true });
  } catch (error) {
    return { ok: false, failure: { code: 'sandbox_failed', message: `The attempt socket ${socketPath} a stopped runtime left cannot be removed: ${error instanceof Error ? error.message : String(error)}` } };
  }

  /**
   * The agent each open connection registered, in the order they registered: a string, or null for an app that gives
   * its tool no id. A registration ends with its connection, and the latest one still open is the one served.
   */
  const registrations = new Map<net.Socket, string | null>();
  /** Every connection open now: a close ends them all, since the server closes only once none is left. */
  const clients = new Set<net.Socket>();
  const granted = new Set<string | null>();

  const say = (client: net.Socket, reply: Answer): void => {
    if (!client.destroyed) client.write(`${JSON.stringify(reply)}\n`);
  };

  const connected = (agent: string | null): void => {
    for (const client of registrations.keys()) say(client, { connected: { agent } });
  };

  const server = net.createServer((client) => {
    clients.add(client);
    client.on('error', () => client.destroy());
    client.on('close', () => {
      clients.delete(client);
      const agent = registrations.get(client);
      registrations.delete(client);

      // A wrapper connected for a registration that ended says nothing to the next one of its agent.
      if (agent !== undefined && ![...registrations.values()].includes(agent)) granted.delete(agent);
    });
    // A connection that fails, such as on a write to a wrapper that hung up, ends only itself.
    void eachLine(client, (line) => {
      void (async () => {
        let parsed: z.ZodSafeParseResult<SocketRequest>;

        try {
          parsed = SocketRequestSchema.safeParse(JSON.parse(line));
        } catch {
          parsed = SocketRequestSchema.safeParse(undefined);
        }

        if (!parsed.success) {
          say(client, { refused: { code: 'bad_request', message: 'The attempt socket takes one JSON line: {"register":{"agent":…}} or {"ask":{"tool":…,"agent":…,"cwd":…}}.' } });

          return;
        }

        const request = parsed.data;

        if ('register' in request) {
          // A registration again on the same connection is the latest one.
          registrations.delete(client);
          registrations.set(client, request.register.agent);

          if (granted.has(request.register.agent)) say(client, { connected: { agent: request.register.agent } });

          return;
        }

        const { ask } = request;
        const registered = [...registrations.values()].at(-1);

        if (registered === undefined) {
          say(client, { refused: { code: 'isolation_unproven', message: 'No step on this attempt is registered for its tool: none registered yet, or the connection it registered on closed. So this sandbox runs nothing for it.' } });

          return;
        }

        if (registered !== ask.agent) {
          const asked = ask.agent === null ? 'with no agent id' : `for agent ${ask.agent}`;
          const step = registered === null ? "the step's own tool, which has no agent id" : `the tool of agent ${registered}`;
          say(client, { refused: { code: 'isolation_unproven', message: `This attempt's sandbox runs only ${step}, and this one was started ${asked}.` } });

          return;
        }

        try {
          const answered = await answer(ask);

          if (!answered.ok) {
            say(client, { refused: { code: answered.failure.code, message: answered.failure.message } });

            return;
          }

          say(client, { grant: answered.grant });
          granted.add(ask.agent);
          connected(ask.agent);
        } catch (error) {
          say(client, { refused: { code: 'runtime_failed', message: `The sandbox runtime failed on an ask: ${error instanceof Error ? error.message : String(error)}` } });
        }
      })();
    }).catch(() => client.destroy());
  });

  const listened = await new Promise<Error | undefined>((resolve) => {
    server.once('error', resolve);
    server.listen(socketPath, () => resolve(undefined));
  });

  if (listened !== undefined) return { ok: false, failure: { code: 'sandbox_failed', message: `The attempt socket ${socketPath} cannot be listened on: ${listened.message}` } };
  fs.chmodSync(socketPath, 0o600);
  // teamai's stdin, and the work it asked for, keep this process alive; a socket nobody asks on never does.
  server.unref();

  return {
    ok: true,
    socket: {
      path: socketPath,
      close: () => new Promise((resolve) => {
        server.close(() => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            // A socket directory left behind holds no secret, and the next listen on this place replaces it.
          }

          resolve();
        });

        for (const client of clients) client.destroy();
      }),
    },
  };
}

/**
 * Asks the socket at `socketPath` once, as the wrapper does: its answer, or why it could not reach the runtime. A
 * socket whose directory is not this user's own at 0700 is never asked: whoever made it would choose what runs.
 */
export function askSocket(socketPath: string, ask: Ask): Promise<Answer | { unreachable: string } | { unreadable: string } | { unsafe: string }> {
  const dir = path.dirname(socketPath);

  const stat = (() => {
    try {
      return fs.lstatSync(dir);
    } catch {
      return undefined;
    }
  })();

  if (stat !== undefined && (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
    return Promise.resolve({ unsafe: `${dir} is not a directory of this user's that only this user may open (0700)` });
  }

  return new Promise((resolve) => {
    const client = net.connect(socketPath);
    let isAnswered = false;
    client.on('error', (error) => resolve({ unreachable: error.message }));
    client.on('connect', () => client.write(`${JSON.stringify({ ask } satisfies SocketRequest)}\n`));
    // The first line is the answer; a socket that fails first, such as on a write to a peer that hung up, is unreachable.
    void eachLine(client, (line) => {
      if (isAnswered) return;
      isAnswered = true;
      client.destroy();

      try {
        resolve(AnswerSchema.parse(JSON.parse(line)));
      } catch (error) {
        // Never the line itself: a grant this version cannot read still holds the step's credentials.
        resolve({ unreadable: error instanceof z.ZodError ? `an answer of ${line.length} bytes whose shape this version does not know` : `an answer of ${line.length} bytes that is not JSON` });
      }
    }).catch((error: Error) => resolve({ unreachable: error.message }));
    client.on('end', () => resolve({ unreachable: 'it closed the connection without an answer' }));
  });
}

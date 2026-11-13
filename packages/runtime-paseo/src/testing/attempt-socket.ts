import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { OuterHandleSchema, RegisterSchema, WRAPPER_PREFIX } from '@teamai/runtime-kit/outer';
import { z } from 'zod';

// ─── Test support: the sandbox side of a place that runs through one ───
//
//  The attempt socket the sandbox runtime serves, as much of it as the inner runtime and the wrapper use: an inner
//  registers its agent, and a wrapper's ask from that agent is granted, and says `connected` to the registrations. And
//  a stand-in `teamai-sandbox-<tool>` that asks as the real wrapper does, with the agent Paseo started it for, and exits
//  0 once granted, or 2 with the refusal.
//

const LineSchema = z.union([
  RegisterSchema,
  z.object({ ask: z.object({ tool: z.string(), agent: z.string().nullable(), cwd: z.string() }) }),
]);

export type SocketLine = z.infer<typeof LineSchema>;

/** What the socket answers: a grant or a refusal to a wrapper's ask, and `connected` to the registrations. */
type SocketAnswer =
  | { grant: { argv: string[]; cwd: string; env: Record<string, string> } }
  | { refused: { code: string; message: string } }
  | { connected: { agent: string | null } };

export interface FakeAttemptSocket {
  /** The socket's path, in a directory only this user may open, as the outer handle names it. */
  socket: string;
  /** The outer handle teamai gives the inner runtime for this place. */
  handle: string;
  /** Every line a client sent, in order. */
  lines: SocketLine[];
  close(): Promise<void>;
}

/**
 * Serves an attempt socket in a directory of its own under /tmp (a socket path binds ~104 bytes at most). With `grants`
 * false, every ask is refused as one from an agent nobody registered. With `holdUntil`, an ask is answered only once
 * that file exists, as a sandbox slow to start the tool.
 */
export async function serveAttemptSocket({ grants = true, holdUntil }: { grants?: boolean; holdUntil?: string } = {}): Promise<FakeAttemptSocket> {
  const dir = fs.mkdtempSync(path.join('/tmp', 'paseo-attempt-'));
  fs.chmodSync(dir, 0o700);
  const socket = path.join(dir, 'attempt.sock');
  const lines: SocketLine[] = [];
  const registrations = new Set<net.Socket>();
  let registered: string | null | undefined;

  const say = (client: net.Socket, answer: SocketAnswer): void => {
    if (!client.destroyed) client.write(`${JSON.stringify(answer)}\n`);
  };

  const server = net.createServer((client) => {
    client.on('error', () => {});
    client.on('close', () => registrations.delete(client));
    readline.createInterface({ input: client }).on('error', () => client.destroy()).on('line', (text) => {
      const line = LineSchema.parse(JSON.parse(text));
      lines.push(line);

      if ('register' in line) {
        registered = line.register.agent;
        registrations.add(client);

        return;
      }

      const { ask } = line;

      const answer = (): void => {
        if (holdUntil !== undefined && !fs.existsSync(holdUntil)) {
          setTimeout(answer, 50);

          return;
        }

        answerAsk(client, ask);
      };

      answer();
    });
  });

  /** Grants a registered agent's ask, and says to the registrations it connected; refuses any other. */
  const answerAsk = (client: net.Socket, ask: Extract<SocketLine, { ask: unknown }>['ask']): void => {
    if (!grants || registered === undefined || ask.agent !== registered) {
      say(client, { refused: { code: 'isolation_unproven', message: `No inner runtime registered agent ${ask.agent ?? 'none'} on this attempt.` } });

      return;
    }

    say(client, { grant: { argv: [ask.tool], cwd: ask.cwd, env: {} } });

    for (const registration of registrations) say(registration, { connected: { agent: ask.agent } });
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });

  return {
    socket,
    handle: JSON.stringify(OuterHandleSchema.parse({ place: 'teamai-sandbox-place', socket })),
    lines,
    close: async () => {
      for (const client of registrations) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Writes `teamai-sandbox-<tool>` into `bin`: it asks `socket` for the agent PASEO_AGENT_ID names in PASEO_AGENT_CWD, as
 * the real wrapper does, and exits 0 once granted, 2 when refused, with the refusal on stderr.
 */
export function writeFakeWrapper({ bin, tool, socket }: { bin: string; tool: string; socket: string }): string {
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, `${WRAPPER_PREFIX}${tool}`);
  fs.writeFileSync(file, `#!${process.execPath}
const net = require('node:net');
const client = net.connect(${JSON.stringify(socket)});
client.on('error', (error) => { process.stderr.write(error.message); process.exit(2); });
client.on('connect', () => client.write(JSON.stringify({ ask: { tool: ${JSON.stringify(tool)}, agent: process.env.PASEO_AGENT_ID || null, cwd: process.env.PASEO_AGENT_CWD || process.cwd() } }) + '\\n'));
let text = '';
client.on('data', (chunk) => {
  text += chunk;
  if (!text.includes('\\n')) return;
  const answer = JSON.parse(text.split('\\n')[0]);
  client.destroy();
  if (answer.grant) process.exit(0);
  process.stderr.write(answer.refused ? answer.refused.message : 'no answer');
  process.exit(2);
});
`, { mode: 0o755 });

  return file;
}

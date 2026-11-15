import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeMessageSchema, type RuntimeMessage, type RuntimeRequestSchema } from '@teamai/runtime-protocol';
import { bundleRuntime as bundleRuntimeAt } from '@teamai/runtime-testing/bundle';
import { connectRuntime, type Connection } from '@teamai/runtime-testing/connect';
import type { z } from 'zod';
import { signalChild } from '@teamai/shared/process-group';

// ─── Test support: the runtime over its stdio, on a fake Paseo daemon ───
//
//  `bundleRuntime` builds the executable as the package ships it. `startRuntime` starts it as teamai does, with its
//  journal under a home of the test's, and reads every line it writes as a protocol message.
//

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'main.ts');
const ROOT = path.join(HERE, '..', '..', '..', '..');

/** Builds the runtime's executable into `dir`, as tsup bundles it, and returns its path. */
export async function bundleRuntime(dir: string): Promise<string> {
  return bundleRuntimeAt({ entry: ENTRY, outfile: path.join(dir, 'teamai-runtime-paseo.mjs') });
}

/** How long a test waits for a line: past every stop the runtime confirms within its own 10 s. */
const LINE_MS = 60_000;

export interface Runtime {
  /** The connection the shared leak check reads. */
  connection: Connection;
  child: Connection['child'];
  send(request: z.input<typeof RuntimeRequestSchema>): void;
  /** The next line that matches, waiting for it; every line is checked against the protocol on the way. */
  next(match: (message: RuntimeMessage) => boolean): Promise<RuntimeMessage>;
  /** Every line read so far. */
  lines: RuntimeMessage[];
  /** Ends its stdin, as teamai does when it is done, and waits for it to exit. */
  stop(): Promise<void>;
  /** Kills it outright, as `kill -9` does. */
  kill(): Promise<void>;
}

/** The Paseo client the tests run against: the one installed for this repository's tests, as a member's paseo brings it. */
export const TEST_CLIENT = path.join(ROOT, 'node_modules', '@getpaseo', 'client');

/**
 * Starts the runtime at `executable` with its journal under `home`, as teamai spawns it, finding the test client
 * through `PASEO_CLIENT_PATH`; `env` sets or, with undefined, removes names over that.
 */
export function startRuntime(executable: string, home: string, env: Record<string, string | undefined> = {}): Runtime {
  // A test run inside a Paseo agent does not make every runtime it starts one started from that agent.
  const merged = { ...process.env, PASEO_AGENT_ID: undefined, HOME: home, PASEO_CLIENT_PATH: TEST_CLIENT, ...env };
  const given = Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const connection = connectRuntime({ executable, env: given });
  const { child } = connection;

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

  // Its stderr reaches the test's own.
  child.stderr.on('data', (data: Buffer | string) => { process.stderr.write(data); });

  const lines: RuntimeMessage[] = [];

  const read = (): RuntimeMessage[] => {
    for (const line of connection.lines.slice(lines.length)) lines.push(RuntimeMessageSchema.parse(line));

    return lines;
  };

  return {
    connection,
    child,
    get lines() {
      return read();
    },
    send: (request) => { child.stdin.write(`${JSON.stringify(request)}\n`); },
    async next(match) {
      read();

      return RuntimeMessageSchema.parse(await connection.next((line) => match(RuntimeMessageSchema.parse(line)), LINE_MS));
    },
    async stop() {
      child.stdin.end();
      await exited;
    },
    async kill() {
      signalChild(child, 'SIGKILL');
      await exited;
    },
  };
}

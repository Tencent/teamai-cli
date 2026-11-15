import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { RuntimeOptions } from '@teamai/runtime-protocol';
import { bundleOnce, bundleRuntime } from '@teamai/runtime-testing/bundle';
import type { JsonValue } from '@teamai/shared/json';

const PACKAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'runtime-t3', 'src');
const FAKE_T3 = path.join(PACKAGE, 'testing', 'fake-t3.mjs');
const TOKEN = 'fake-t3-token-scenarios';

/** The tokens the toy's agent bills, as a tool's own end-of-run usage reports them. */
export const ToyUsageSchema = z.object({ input: z.number().optional(), output: z.number().optional(), cachedInput: z.number().optional() });

const ToyAgentSchema = z.object({
  usage: ToyUsageSchema.optional(),
  output: z.json().optional(),
  fail: z.object({ code: z.string(), message: z.string() }).optional(),
  hold_ms: z.number().optional(),
  release: z.string().optional(),
  result: z.json().optional(),
}).loose();

/**
 * teamai-runtime-t3 built as it ships, against a fake T3 Code server (packages/runtime-t3/src/testing/fake-t3.mjs) over
 * `state`. `options(state, agent)` lays out what a T3 run needs beside the scenario's worktree, `<state>/../worktree`
 * (the worktree as a git checkout the fake lists as a T3 project, and the fake's agent playing the scenario's toy
 * agent), then gives the runtime's options; `through` gives the attempt's tool home a run through a sandbox keeps its
 * session in. `ready(state)` starts the fake once per state and signs the member in;
 * `stop(state)` stops it, and it stops by itself once `state` is removed. Its command line names `state`, so a leak check
 * of the test's directory sees it. `forget(state, op)` deletes the thread prompt `op` launched (its clientRequestId), as
 * the person deletes it in T3 Code. `worktreeAt(state, at)` adds `at` as another git worktree of the project.
 */
export async function t3OnFakeServer(): Promise<{
  command: string;
  args: (state: string) => string[];
  options: (state: string, agent: JsonValue, through?: { toolHome: string }) => RuntimeOptions;
  ready: (state: string) => Promise<void>;
  stop: (state: string) => Promise<void>;
  forget: (state: string, op: string) => void;
  worktreeAt: (state: string, at: string) => void;
}> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-t3-runtime-')));
  const executable = path.join(dir, 'teamai-runtime-t3.mjs');

  await bundleRuntime({ entry: path.join(PACKAGE, 'main.ts'), outfile: executable });
  // The fake too, with the packages it imports inside, as teamai's own session code names a project: built the way
  // the runtime's own tests build it.
  const fake = await bundleOnce(FAKE_T3);

  const servers = new Map<string, Promise<void>>();
  const exits = new Map<string, { stop: () => void; exited: Promise<void> }>();

  const serve = async (state: string): Promise<void> => {
    const runtimeFile = path.join(state, 't3-home', 'userdata', 'server-runtime.json');
    const server = spawn(process.execPath, [fake, path.join(state, 't3-state')], {
      env: { ...process.env, FAKE_T3_STATE: path.join(state, 't3-state'), T3CODE_HOME: path.join(state, 't3-home'), FAKE_T3_HOME: path.join(state, 'home'), FAKE_T3_PARENT: String(process.pid) },
      stdio: 'ignore', detached: false,
    });
    const exited = new Promise<void>((resolve) => { server.once('exit', () => resolve()); });
    exits.set(state, { stop: () => server.kill('SIGTERM'), exited });
    server.unref();

    for (const deadline = Date.now() + 10_000; !fs.existsSync(runtimeFile);) {
      if (Date.now() > deadline) throw new Error('The fake T3 server did not start.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const { origin } = z.object({ origin: z.string() }).parse(JSON.parse(fs.readFileSync(runtimeFile, 'utf8')));
    const credentials = path.join(state, 'home', '.teamai', 'runtime-state', 't3', 'credentials.json');
    fs.mkdirSync(path.dirname(credentials), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentials, JSON.stringify({ [`${origin}/mcp`]: { tokens: { access_token: TOKEN, token_type: 'Bearer' }, expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
  };

  return {
    command: '/usr/bin/env',
    args: (state) => [`HOME=${path.join(state, 'home')}`, `T3CODE_HOME=${path.join(state, 't3-home')}`, process.execPath, executable],
    options(state, agent, through) {
      const worktree = path.join(path.dirname(state), 'worktree');
      const toy = ToyAgentSchema.parse(agent);

      if (!fs.existsSync(path.join(worktree, '.git'))) execFileSync('git', ['init', '-q', worktree]);
      fs.mkdirSync(path.join(state, 't3-state'), { recursive: true });
      fs.writeFileSync(path.join(state, 't3-state', 'config.json'), JSON.stringify({
        token: TOKEN,
        environment: { environmentId: 'env-fake-1', label: 'fake-laptop', serverVersion: '0.1.8-fake' },
        projects: [{ id: 'project-1', title: 'scenario', workspaceRoot: fs.realpathSync(worktree) }],
        providers: [{ providerInstanceId: 'claudeAgent', driverKind: 'claudeAgent', displayName: 'Claude', constraints: [], models: [{ id: 'claude-opus-5-5' }] }],
        agent: {
          output: toy.output, fail: toy.fail !== undefined, hold: toy.hold_ms !== undefined, release: toy.release, result: toy.result,
          ...(toy.usage && { usage: { input: toy.usage.input ?? 0, output: toy.usage.output ?? 0, cacheRead: toy.usage.cachedInput ?? 0 } }),
        },
        ...(through && { wrappedHome: through.toolHome }),
      }));

      return { environment: 'local' };
    },
    async ready(state) {
      const server = servers.get(state) ?? serve(state);
      servers.set(state, server);
      await server;
    },
    worktreeAt(state, at) {
      const worktree = path.join(path.dirname(state), 'worktree');
      const identity = ['-c', 'user.name=teamai', '-c', 'user.email=teamai@example.com'];

      // A worktree needs a commit to check out; the project's is empty until then.
      if (!execFileSync('git', ['-C', worktree, 'rev-list', '--all'], { encoding: 'utf8' }).trim()) execFileSync('git', ['-C', worktree, ...identity, 'commit', '-q', '--allow-empty', '-m', 'start']);
      execFileSync('git', ['-C', worktree, 'worktree', 'add', '-q', '--detach', at]);
    },
    forget(state, op) {
      const threads = path.join(state, 't3-state', 'threads');
      const launched = fs.readdirSync(threads).filter((name) => z.object({ clientRequestId: z.string().optional() }).loose().parse(JSON.parse(fs.readFileSync(path.join(threads, name), 'utf8'))).clientRequestId === op);

      if (launched.length !== 1) throw new Error(`The fake T3 server has ${launched.length} threads launched by ${op}.`);
      for (const name of launched) fs.rmSync(path.join(threads, name));
    },
    async stop(state) {
      const server = exits.get(state);

      if (!server) return;
      exits.delete(state);
      servers.delete(state);
      server.stop();
      await server.exited;
    },
  };
}

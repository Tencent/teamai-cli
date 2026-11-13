import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InitHomeEnv, InitInstance, PromptLeaseSchema, PromptRequestSchema, RuntimeMessage, RuntimeMode, RuntimeOptions } from '@teamai/runtime-protocol';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { expectNothingLeft } from '@teamai/runtime-testing/leaks';
import { startFakeDaemon, type Behaviour } from './fake-daemon.js';
import { bundleRuntime, startRuntime, type Runtime } from './harness.js';
import type { PaseoTool } from '../providers.js';
import { entriesUnder } from '@teamai/shared/entries-under';

// ─── Test support: one test file's runtimes on a fake Paseo daemon ───
//
//  teamai-runtime-paseo through its stdio entry, as teamai spawns it, against a fake Paseo daemon that speaks Paseo
//  0.14.0's WebSocket protocol and checks every frame against Paseo's own schemas. A test file calls `useRuntimeSuite`
//  once: each test then gets its own directory, worktree and daemon, and leaves nothing running.
//

let bundleDir: string;
let executable: string;

export let dir: string;
export let worktree: string;
export let daemonState: string;
export let daemon: Awaited<ReturnType<typeof startFakeDaemon>>;
const runtimes: Runtime[] = [];

export const RUN = 'r0123abcd';
export const ATTEMPT = 'a0123abcd';

/** Starts the test's fake daemon again on its state, as a daemon restart does: on `port`, or a Unix socket at `socket`. */
export async function restartDaemon(at: { port: number; socket?: string }): Promise<void> {
  daemon = await startFakeDaemon({ state: daemonState, ...at });
}

export const behave = (behaviour: Behaviour): void => fs.writeFileSync(path.join(daemonState, 'behaviour.json'), JSON.stringify(behaviour));

/** A request the fake daemon recorded: its type, and the rest of its frame as it crossed the wire. */
const ReceivedSchema = z.looseObject({ type: z.string() });

/** What the fake daemon keeps of its agents and of the workspace it opened on each directory. */
const DaemonStateSchema = z.object({ agents: z.record(z.string(), z.looseObject({})), workspaces: z.record(z.string(), z.string()) });

/** The agent creates and cancels, and the workspace archives, the daemon received, as they crossed the wire. */
export const received = () => {
  const file = path.join(daemonState, 'requests.jsonl');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => ReceivedSchema.parse(JSON.parse(line))) : [];
};

/** The agent the runtime asked Paseo to create for `op`, by the id its create carried over the wire. */
export const createdAgent = (op: string): string => z.string().parse(received().find((request) => request.type === 'agent.create.request' && request.idempotencyKey === op)?.agentId);

/** The agents a cancel or an archive stopped, as they stopped running. */
export const stopped = (): unknown[] => {
  const file = path.join(daemonState, 'stopped.jsonl');

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

/** Whether a client asked the daemon to wait for agent `agentId`: a prompt's follow does once it read the prompt's record. */
export const waitedOn = (agentId: string): boolean => {
  const file = path.join(daemonState, 'waited.jsonl');

  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim().split('\n').some((line) => z.object({ agentId: z.string() }).parse(JSON.parse(line)).agentId === agentId);
};

export const start = (env?: Record<string, string | undefined>): Runtime => {
  const runtime = startRuntime(executable, path.join(dir, 'home'), env);
  runtimes.push(runtime);

  return runtime;
};

export const isOp = (op: string, event: string) => (line: RuntimeMessage): boolean => 'op' in line && line.op === op && 'event' in line && line.event === event;
export const isEnd = (op: string) => (line: RuntimeMessage): boolean => 'op' in line && line.op === op && 'event' in line && ['finished', 'failed', 'cancelled'].includes(line.event);
export const isInit = (line: RuntimeMessage): boolean => 'type' in line && line.type === 'init';

/** The home variables teamai sends for the tools Paseo runs, as `toolCommandEnv` names them. */
export const SHIPPED_HOME_ENV: Record<PaseoTool, string[]> = { claude: ['CLAUDE_CONFIG_DIR'], codex: ['CODEX_HOME'], opencode: [] };

/** A team instance teamai passes at init, with the variables it names for that instance in `init.homeEnv`. */
export type PassedInstance = InitInstance & { readonly homeEnv: readonly string[] };

/** Sends `init`, as teamai does: each instance in `instances`, and its variables with the shipped tools' in `homeEnv`. */
export async function ready(runtime: Runtime, { mode = 'unattended', options = { url: daemon.url }, instances, homeEnv = SHIPPED_HOME_ENV }: { mode?: RuntimeMode; options?: RuntimeOptions; instances?: PassedInstance[]; homeEnv?: InitHomeEnv } = {}): Promise<RuntimeMessage> {
  const passed = instances?.map(({ homeEnv: _variables, ...instance }) => instance);
  const sent = { ...homeEnv, ...Object.fromEntries((instances ?? []).map(({ name, homeEnv: variables }) => [name, [...variables]])) };
  runtime.send({ type: 'init', protocol: 1, mode, options, homeEnv: sent, ...(passed && { instances: passed }) });

  return runtime.next(isInit);
}

export const openRequest = (op: string, attempt: string, tool?: string) => ({
  type: 'open' as const, op, run: RUN, attempt, credentials: {}, ...(tool !== undefined && { tool }), view: { worktree, readonly: [], result: path.join(dir, 'out'), runDir: path.join(dir, 'run'), toolHome: {} },
});

/** Opens the attempt's place and waits until it is ready, as teamai does before it sends a prompt there. */
export async function opened(runtime: Runtime, { attempt = ATTEMPT, op = 'op-0000000a', tool }: { attempt?: string; op?: string; tool?: string } = {}): Promise<string> {
  runtime.send(openRequest(op, attempt, tool));
  const accepted = await runtime.next(isOp(op, 'accepted'));

  if (!('handle' in accepted) || !accepted.handle) throw new Error(`no handle in ${JSON.stringify(accepted)}`);
  await runtime.next((line) => isOp(op, 'ready')(line) || isOp(op, 'failed')(line));

  return accepted.handle;
}

/** Every file the runtime's journal holds, by its path under the journal. */
export const journalFiles = (): string[] => {
  const root = path.join(dir, 'home', '.teamai', 'runtime-state', 'paseo');

  return fs.existsSync(root) ? entriesUnder(root).map(({ entry }) => entry).filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))) : [];
};

/** The agents the fake daemon holds, by id. */
export const agentsOf = (): string[] => {
  const file = path.join(daemonState, 'agents.json');

  return fs.existsSync(file) ? Object.keys(DaemonStateSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).agents) : [];
};

/** How a close that keeps an attempt, while a create it sent may still start the agent, says so, and how to release it. */
export const mayStartMessage = (agentId: string): string => `Paseo does not show the claude agent ${agentId} yet, though its create was sent, so it may still start in the worktree. Once it appears, run teamai workflow cancel ${RUN} again, which stops it. If it never appears in Paseo, the create was refused: check that nothing of the attempt runs in the worktree, then run teamai workflow cancel ${RUN} --release ${ATTEMPT}.`;

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Why init names a tool unavailable on the test daemon, as teamai shows it on a step that names that tool. */
export const cannotRun = (tool: string, reason: string): string => `The Paseo daemon at ${daemon.url} cannot run ${tool}: ${reason}.`;

/** Why a tool the daemon has not installed is unavailable. */
export const notInstalled = (tool: string): string => `it is not installed where the daemon finds its tools; install ${tool} on the daemon's PATH and sign in to it there`;

/** Waits until `holds` does, as a state outside the runtime's own lines shows it, for at most `ms`. */
export async function until(holds: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !holds(); await delay(25)) if (Date.now() > end) throw new Error(`not so within ${ms} ms`);
}

/** The Paseo workspace the fake daemon opened on the worktree. */
export const worktreeWorkspace = (): string | undefined => DaemonStateSchema.parse(JSON.parse(fs.readFileSync(path.join(daemonState, 'agents.json'), 'utf8'))).workspaces[fs.realpathSync(worktree)];

/** A prompt as teamai sends one, with the step env it sets, none of which the runtime passes on. */
export const promptRequest = (handle: string, op: string, lease: Partial<z.input<typeof PromptLeaseSchema>> = {}): z.input<typeof PromptRequestSchema> => ({
  type: 'prompt', op, handle, env: { TEAMAI_WORKFLOW_RESULT: path.join(dir, 'out', 'result.json'), STEP_TOKEN: 'from-teamai' }, unset: [], cwd: worktree,
  lease: {
    step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false,
    prompt: `Review the change.\n\nWrite the workflow result as JSON to ${path.join(dir, 'out', 'result.json')}. Write {"output": …}.`, result: path.join(dir, 'out', 'result.json'),
    ...lease,
  },
});

/** Bundles the runtime once for the test file, and gives each test its own directory and daemon, checked for leaks after it. */
export function useRuntimeSuite(): void {
  beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-paseo-bundle-'));
    executable = await bundleRuntime(bundleDir);
  }, 60_000);

  afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-paseo-runtime-')));
    worktree = path.join(dir, 'worktree');
    daemonState = path.join(dir, 'daemon');
    fs.mkdirSync(worktree);
    fs.mkdirSync(path.join(dir, 'out'));
    daemon = await startFakeDaemon({ state: daemonState, port: 0 });
  });

  afterEach(async () => {
    const closed = runtimes.splice(0);
    await Promise.all(closed.map((runtime) => runtime.kill()));
    await daemon.close();

    try {
      await expectNothingLeft({ dir, connections: closed.map(({ connection }) => connection) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

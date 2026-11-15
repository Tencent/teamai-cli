import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PromptLease } from '@teamai/runtime-protocol';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { z } from 'zod';
import { expectNothingLeft } from '@teamai/runtime-testing/leaks';
import { bundleRuntime, connect, fakeT3, signIn, type Connection, type FakeT3, type Line } from './harness.js';
import type { DRIVERS, Driver } from '../sessions.js';

// The T3 runtime's tests: teamai-runtime-t3 through its stdio entry, against a fake T3 Code server (fake-t3.mjs). Each
// test file runs it in a describe that calls useT3Runtime, and a prompt step's tests also call usePromptStep.

let bundleDir: string;
let executable: string;

/** The folder each test runs in, with the checkout of its run, and the fake T3 Code server. */
export let dir: string;
export let checkout: string;
export let t3: FakeT3;
const connections: Connection[] = [];

/** Puts `fake` in the place of the fake T3 Code server for the rest of the test, which stops it after. */
export function replaceT3(fake: FakeT3): void {
  t3 = fake;
}

/** The link that opens a thread of the fake's environment in T3 Code's desktop app. */
export const linkTo = (threadId: string | undefined): string => `t3code://threads/env-fake-1/${encodeURIComponent(threadId ?? '')}`;

/** A line for the person, which answers no request. */
export const isNotice = (line: Line): boolean => line['event'] === 'notice';

/** The notices the runtime wrote so far. */
export const noticesOf = (runtime: Connection): Line[] => runtime.lines.filter(isNotice);

/** A runtime on the bundled executable, against the fake T3 Code server, started in `cwd`, closed after the test. */
export const start = (env: Record<string, string> = {}, cwd?: string): Connection => {
  const runtime = connect(executable, t3, env, cwd);
  connections.push(runtime);

  return runtime;
};

/** Bundles the runtime once, and gives each test a fresh checkout and fake T3 Code server, then checks it left nothing. */
export function useT3Runtime(): void {
  beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-bundle-'));
    executable = await bundleRuntime(bundleDir);
  }, 60_000);

  afterAll(() => fs.rmSync(bundleDir, { recursive: true, force: true }));

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-t3-')));
    checkout = path.join(dir, 'acme-app');
    fs.mkdirSync(checkout);
    execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
    execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    t3 = fakeT3(dir, checkout);
    await t3.start();
  });

  afterEach(async () => {
    const closed = connections.splice(0);
    await Promise.all(closed.map((runtime) => runtime.close()));
    await t3.stop();

    try {
      await expectNothingLeft({ dir, connections: closed });
    } finally {
      // A judge's copy left unclosed is read-only.
      execFileSync('chmod', ['-R', 'u+w', dir]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ─── A prompt step ───

export let worktree: string;
export let result: string;
export const OPEN = 'op-0000000a';
export const RUN = 'r7f3a91c2';

/** The home variables teamai sends for the tools T3 runs, as `toolCommandEnv` names them. */
export const SHIPPED_HOME_ENV: Record<(typeof DRIVERS)[Driver]['tool'], string[]> = { claude: ['CLAUDE_CONFIG_DIR'], codex: ['CODEX_HOME'] };

/** A runtime past init and open on the attempt's worktree, and its handle. */
export const opened = async (mode: 'attended' | 'unattended' = 'attended', env: Record<string, string> = {}, options: Line = {}): Promise<{ runtime: Connection; handle: string }> => {
  const runtime = start(env);
  runtime.send({ type: 'init', protocol: 1, mode, options: { environment: 'local', ...options }, homeEnv: SHIPPED_HOME_ENV });
  expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });
  runtime.send({ type: 'open', op: OPEN, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
  const accepted = await runtime.next((line) => line['op'] === OPEN && line['event'] === 'accepted');
  expect(await runtime.next((line) => line['op'] === OPEN && line['event'] !== 'accepted' && !isNotice(line))).toMatchObject({ event: 'ready' });

  return { runtime, handle: z.string().parse(accepted['handle']) };
};

/** A prompt of the step on the worktree. teamai sends no env to this runtime, whose offer says can.env: false. */
export const prompt = (handle: string, op: string, lease: { [Key in keyof PromptLease]?: Line[string] | undefined } = {}) => ({
  type: 'prompt', op, handle, env: {}, unset: [], cwd: worktree,
  lease: {
    step: 'review', tool: 'claude', model: { name: 'claude-opus-5-5' }, permissions: 'approval-required', interactive: false, result,
    prompt: `Review the change on this branch.\n\nWrite the workflow result as JSON to ${result}. Use this shape: {"output":{}}.`,
    ...lease,
  },
});

/** How the op ended: its first line that neither accepts it nor shows its thread. */
export const ended = (runtime: Connection, op: string): Promise<Line> => runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && line['event'] !== 'display' && !isNotice(line), 20_000);

/** Opens the place of an attempt whose folder is `folder` on `runtime`, and answers how the open ended. */
export const openOn = async (runtime: Connection, folder: string, op = OPEN, timeoutMs?: number): Promise<Line> => {
  runtime.send({ type: 'open', op, run: RUN, attempt: 'a1b2c3d4', credentials: {}, view: { worktree: folder, readonly: [], result: path.dirname(result), runDir: path.join(dir, 'run'), toolHome: {} } });
  await runtime.next((line) => line['op'] === op && line['event'] === 'accepted');

  return runtime.next((line) => line['op'] === op && line['event'] !== 'accepted' && !isNotice(line), timeoutMs);
};

export const initialized = async (options: Line = {}, env: Record<string, string> = {}): Promise<Connection> => {
  const runtime = start(env);
  runtime.send({ type: 'init', protocol: 1, mode: 'attended', options: { environment: 'local', ...options }, homeEnv: SHIPPED_HOME_ENV });
  expect(await runtime.next((line) => line['type'] === 'init')).toMatchObject({ ok: true });

  return runtime;
};

/** The project script settings that make T3 run `script` in the folder of every thread in project-1. */
export const scriptsInProject1 = (script: { name: string; command: string; runOnWorktreeCreate: boolean; runOnSettle?: boolean }) => ({
  projectSettingsFolded: true, projectSettingsOverrides: { 'project-1': { defaultProjectScripts: [{ id: 'one', icon: 'configure', ...script }] } },
});

/** Signs the member in, and prepares the attempt's worktree and result folder of a prompt step. */
export function usePromptStep(): void {
  beforeEach(() => {
    signIn(t3);
    worktree = path.join(checkout, '.teamai', 'workflow-worktrees', `${RUN}-a1b2c3d4`);
    execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', worktree]);
    result = path.join(dir, 'attempt', 'out', 'result.json');
    fs.mkdirSync(path.dirname(result), { recursive: true });
  });
}

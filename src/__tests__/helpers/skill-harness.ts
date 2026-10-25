import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { resolveWorkflowEnv } from '../../env-resolution.js';
import type { LocalConfig } from '../../types.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { inProcessClient, type WorkflowClient } from '../../workflow/protocol.js';
import { runSkillCall, skillContext, type CommandRun, type Runners, type SkillCall, type SkillContext } from '../../workflow/drivers/skill/skill-driver.js';
import { withRunLock } from '../../workflow/store.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A command that runs until it is stopped, as `sleep 300` does, and calls `stopped` when it is. */
export function untilStopped(stopped: () => void): CommandRun {
  let end: (exit: Awaited<CommandRun['exit']>) => void = () => {};
  const exit = new Promise<Awaited<CommandRun['exit']>>((resolve) => { end = resolve; });
  return { exit, stop: async () => { stopped(); end({ exitCode: 143, stdout: '', stderr: '', output: '' }); return exit; } };
}

/** How many turns a settle waits for a runner to park before it fails, naming the runner, instead of hanging. */
const SETTLE_TURNS = 5_000;
/** How long a settle waits for a real command to exit on its own. */
const COMMAND_EXIT_MS = 10_000;

/**
 * Runners in this process on a fake clock, which is also the engine's: `Date` follows it. A runner is the same
 * `report --driver skill --attempt` call the detached process makes, and it parks at each run lock it takes and each
 * sleep until the next `sleep` of the session, so a test sees each phase a real runner passes through: preparing, then
 * running, then reported. A command runs for real, and a session's sleep waits for it to exit; a test fakes one that
 * runs until it is stopped.
 */
function memoryRunners(command: Runners['command']): { runners: Runners; now: () => Date; bind(context: SkillContext): void; hold(held: boolean): void } {
  let clock = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  onTestFinished(() => { vi.useRealTimers(); });
  let held = false;
  let base: SkillContext | undefined;
  const live = new Map<string, Promise<unknown>>();
  /** What lets each parked runner go on, by runner. */
  const parked = new Map<string, () => void>();
  /** Every real command still running, by what it runs. */
  const commands = new Map<Promise<unknown>, string>();
  const park = (key: string, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    parked.set(key, resolve);
    signal?.addEventListener('abort', () => {
      if (parked.get(key) === resolve) parked.delete(key);
      resolve();
    }, { once: true });
  });
  const settle = async (): Promise<void> => {
    for (let turn = 0; ; turn += 1) {
      if (commands.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), COMMAND_EXIT_MS); });
        const exited = await Promise.race([Promise.all(commands.keys()), late]);
        clearTimeout(timer);
        if (exited === 'late') throw new Error(`${[...commands.values()].join('; ')} did not exit within ${COMMAND_EXIT_MS} ms. Fake a command that runs until it is stopped with the harness's runners option.`);
      }
      const moving = [...live.keys()].filter((key) => !parked.has(key));
      if (moving.length === 0 && commands.size === 0 && turn > 0) return;
      if (turn >= SETTLE_TURNS) throw new Error(`The runner of ${moving.join(', ')} neither parked at a lock or a sleep nor ended within ${SETTLE_TURNS} turns: it loops without waiting.`);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
    }
  };
  return {
    now: () => new Date(clock),
    bind: (context) => { base = context; },
    hold: (on) => { held = on; },
    runners: {
      spawn: async (job) => {
        if (!base) throw new Error('memoryRunners used before bind');
        const { config } = base;
        const key = `${job.run}/${job.attempt}`;
        const call: SkillCall = { kind: 'report', run: job.run, attempt: job.attempt, role: 'runner' };
        // A runner parks at each lock and sleep until the next sleep of the session, so it never waits on itself.
        const locks: SkillContext['locks'] = { take: async (run, body, waitMs) => { await park(key); return withRunLock(config, run, body, { waitMs }); } };
        const runners = { ...base.runners, sleep: (_ms: number, signal?: AbortSignal) => park(key, signal) };
        live.set(key, runSkillCall(call, { ...base, session: undefined, locks, runners }).finally(() => live.delete(key)));
      },
      alive: async (run, attempt) => live.has(`${run}/${attempt}`),
      command: (input) => {
        const started = command(input);
        const exit = started.exit.finally(() => commands.delete(exit));
        commands.set(exit, `The command ${input.command} of ${input.env.TEAMAI_WORKFLOW_ATTEMPT ?? 'a runner'}`);
        return { exit, stop: started.stop };
      },
      sleep: async (ms) => {
        clock += ms;
        vi.setSystemTime(clock);
        if (held) return;
        const waiting = [...parked.values()];
        parked.clear();
        for (const open of waiting) open();
        await settle();
      },
    },
  };
}

interface HarnessOptions {
  session?: string;
  /** Wraps the in-process protocol, to script an engine answer. */
  client?: (client: WorkflowClient) => WorkflowClient;
  /** Wraps the in-memory runners, to drop or hold a runner. */
  runners?: (runners: Runners) => Runners;
}

/**
 * A member's checkout and team repository holding `workflows`, synced, with the skill driver's context for one session.
 * `rows` collects the id of every transition row a call or a runner takes.
 */
export async function skillHarness(workflows: Record<string, string>, options: HarnessOptions = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-driver-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const work = path.join(root, 'work');
  const repo = path.join(root, 'knowledge');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'fixture');
  const config: LocalConfig = {
    repo: { kind: 'self', localPath: repo, remote: 'local' }, username: 'test', scope: 'project', projectRoot: work,
    additionalRoles: [], dataHome: path.join(root, 'data'),
  };
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(repo, 'workflows', `${name}.yaml`), yaml);
  await syncWorkflowDefinitions(config);
  const env = await resolveWorkflowEnv(config);
  const production = await skillContext({ config, env, cwd: work });
  const scheduler = memoryRunners(production.runners.command);
  const client = inProcessClient({ config, env });
  const rows: string[] = [];
  const context: SkillContext = {
    config, env, client: options.client ? options.client(client) : client, session: options.session ?? 'session-a', tool: 'claude', invocation: 'teamai', cwd: work,
    now: scheduler.now, runners: options.runners ? options.runners(scheduler.runners) : scheduler.runners,
    locks: { take: (run, body, waitMs) => withRunLock(config, run, body, { waitMs }) },
    trace: (row) => { rows.push(row); },
  };
  scheduler.bind(context);
  return {
    root, work, config, context, rows,
    /** While held, a sleep moves the clock and no runner, so two calls in a row see the same runners. */
    hold: scheduler.hold,
    /** Makes `call` as the session, or with another session or lock in its context. */
    call: (call: SkillCall, overrides: Partial<Pick<SkillContext, 'session' | 'locks'>> = {}) => runSkillCall(call, { ...context, ...overrides }),
  };
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { resolveWorkflowEnv } from '../../env-resolution.js';
import type { RunMode } from '../../launch-context.js';
import { memberTools } from '../../tool-launch/call.js';
import { getUserConfigPath, TeamaiConfigBaseSchema, type LocalConfig, type ToolId } from '../../types.js';
import type { AgentEvidence } from '../../workflow/attempt-marker.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { inProcessClient, type WorkflowClient } from '../../workflow/protocol.js';
import { runSkillCall, skillContext, type CommandRun, type Runners, type SkillCall, type SkillContext } from '../../workflow/drivers/skill/skill-driver.js';
import { takeRunLock } from '../../workflow/store.js';
import { fakeGh } from './fake-gh.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A command that runs until it is stopped, as `sleep 300` does, and calls `stopped` when it is. */
export function untilStopped(stopped: () => void): CommandRun {
  let end: (exit: Awaited<CommandRun['exit']>) => void = () => {};
  const exit = new Promise<Awaited<CommandRun['exit']>>((resolve) => { end = resolve; });
  return { exit, stop: async () => { stopped(); end({ exitCode: 143, stdout: '', stderr: '', output: '' }); return exit; } };
}

/**
 * Puts on PATH a `claude` whose confined judge profile verifies, and that labels every pass `label`, or exits
 * `exitCode` without an answer.
 */
export function fakeJudge(root: string, label: string, exitCode = 0): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
if (${exitCode} !== 0) process.exit(${exitCode});
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: { label: ${JSON.stringify(label)}, reasoning: 'It read the change.' } }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

/**
 * Gives the harness checkout `work` a GitHub origin that git rewrites to a bare repository under `root`, with main
 * pushed, and puts a fake `gh` in front of teamai: the host a `deliver: pr` step opens its pull request on.
 */
export function githubOrigin(harness: { root: string; work: string }): void {
  const bare = path.join(harness.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  git(harness.work, 'remote', 'add', 'origin', 'https://github.com/fixture/app.git');
  git(harness.work, 'config', `url.${bare}.insteadOf`, 'https://github.com/fixture/app.git');
  git(harness.work, 'push', '-qu', 'origin', 'main');
  fakeGh(path.join(harness.root, 'gh'));
  onTestFinished(() => { vi.restoreAllMocks(); });
}

/** A crash a test injects: the call or the runner that throws it stops there, as a process killed at that point does. */
export class Crash extends Error {}

/** How many turns a settle waits for a runner to park before it fails, naming the runner, instead of hanging. */
const SETTLE_TURNS = 5_000;
/** How long a settle waits for a real setup or command to end on its own. */
const COMMAND_EXIT_MS = 10_000;

/**
 * Runners in this process on a fake clock, which is also the engine's: `Date` follows it. A runner is the same
 * `report --driver skill --attempt` call the detached process makes, and it parks at each run lock it takes and each
 * sleep until the next `sleep` of the session, so a test sees each phase a real runner passes through: preparing, then
 * running, then reported. A setup or a command runs for real, and a session's sleep waits for it to end; a test fakes
 * one that runs until it is stopped. A runner that throws `Crash` is gone, as a killed one is; any other error fails the next sleep.
 */
function memoryRunners(command: Runners['command']): {
  runners: Runners; track(runners: Runners): Runners; settingUp(client: WorkflowClient): WorkflowClient; judging(client: WorkflowClient): WorkflowClient; now: () => Date; advance(ms: number): void; bind(context: SkillContext): void; hold(held: boolean): void; crash(run: string, attempt: string): boolean;
} {
  let clock = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  onTestFinished(() => { vi.useRealTimers(); });
  let held = false;
  let base: SkillContext | undefined;
  /** Every runner still going, by its own id, `<run>/<attempt>#<n>`. A runner spawned again gets a new id. */
  const live = new Map<string, Promise<unknown>>();
  let spawned = 0;
  /** What lets each parked runner go on, or makes it crash, by runner. */
  const parked = new Map<string, { resume: () => void; crash: () => void }>();
  /** The attempts, `<run>/<attempt>`, whose runners crash where they are parked at the next sleep. */
  const doomed = new Set<string>();
  const failures: unknown[] = [];
  const attemptOf = (id: string): string => id.slice(0, id.lastIndexOf('#'));
  /** Every real setup, command and judge still running, by what it runs. */
  const commands = new Map<Promise<unknown>, string>();
  /** The stop of every command, real or faked, still running, by `<run>/<attempt>`. */
  const started = new Map<string, Set<CommandRun['stop']>>();
  const park = (id: string, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    const entry = { resume: resolve, crash: () => { reject(new Crash(`the runner ${id} crashed`)); } };
    parked.set(id, entry);
    signal?.addEventListener('abort', () => {
      if (parked.get(id) === entry) parked.delete(id);
      resolve();
    }, { once: true });
  });
  const settle = async (): Promise<void> => {
    for (let turn = 0; ; turn += 1) {
      const [failure] = failures.splice(0);
      if (failure !== undefined) throw failure;
      if (commands.size > 0) {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), COMMAND_EXIT_MS); });
        const exited = await Promise.race([Promise.all(commands.keys()), late]);
        clearTimeout(timer);
        if (exited === 'late') throw new Error(`${[...commands.values()].join('; ')} did not end within ${COMMAND_EXIT_MS} ms. Fake a setup or a command that runs until it is stopped with the harness's client or runners option.`);
      }
      const moving = [...live.keys()].filter((id) => !parked.has(id));
      if (moving.length === 0 && commands.size === 0 && turn > 0 && failures.length === 0) return;
      if (turn >= SETTLE_TURNS) throw new Error(`The runner of ${moving.join(', ')} neither parked at a lock or a sleep nor ended within ${SETTLE_TURNS} turns: it loops without waiting.`);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
    }
  };
  return {
    now: () => new Date(clock),
    advance: (ms) => { clock += ms; vi.setSystemTime(clock); },
    bind: (context) => { base = context; },
    hold: (on) => { held = on; },
    /** Wraps the runners a test ends with, so `stopLeft` reaches the commands they start, faked ones too. */
    track: (runners) => ({
      ...runners,
      command: (input) => {
        const running = runners.command(input);
        const key = `${input.run}/${input.attempt}`;
        const stops = started.get(key) ?? new Set();
        started.set(key, stops);
        stops.add(running.stop);
        void running.exit.finally(() => stops.delete(running.stop));
        return running;
      },
      stopLeft: async (run, attempt) => {
        for (const stop of started.get(`${run}/${attempt}`) ?? []) await stop();
      },
    }),
    /**
     * Wraps the in-process client, so a settle waits for a real setup, as it waits for a real command. A test that fakes
     * setup with the client option replaces this one.
     */
    settingUp: (client) => ({
      ...client,
      setup: (run, attempt, mode, signal) => {
        const running = client.setup(run, attempt, mode, signal).finally(() => commands.delete(running));
        commands.set(running, `The setup of ${run}/${attempt}`);
        return running;
      },
    }),
    /** Wraps the client a test ends with, so a settle waits for a judge it runs, as it waits for a real command. */
    judging: (client) => ({
      ...client,
      judge: (ref, body, options) => {
        const judged = client.judge(ref, body, options);
        const running = judged.finally(() => commands.delete(running));
        commands.set(running, `The judge of ${ref}`);
        return judged;
      },
    }),
    crash: (run, attempt) => {
      const key = `${run}/${attempt}`;
      if (![...live.keys()].some((id) => attemptOf(id) === key)) return false;
      doomed.add(key);
      return true;
    },
    runners: {
      spawn: async (job) => {
        if (!base) throw new Error('memoryRunners used before bind');
        const { config } = base;
        spawned += 1;
        const id = `${job.run}/${job.attempt}#${spawned}`;
        const call: SkillCall = { kind: 'report', run: job.run, attempt: job.attempt, role: 'runner' };
        // A runner parks at each lock and sleep until the next sleep of the session, so it never waits on itself.
        const locks: SkillContext['locks'] = { take: async (run, body, waitMs) => { await park(id); return takeRunLock(config, run, body, { waitMs }); } };
        const runners = { ...base.runners, sleep: (_ms: number, signal?: AbortSignal) => park(id, signal) };
        const running = runSkillCall(call, { ...base, session: undefined, locks, runners })
          .catch((error: unknown) => { if (!(error instanceof Crash)) failures.push(error); })
          .finally(() => live.delete(id));
        live.set(id, running);
      },
      alive: async (run, attempt) => [...live.keys()].some((id) => attemptOf(id) === `${run}/${attempt}`),
      command: (input) => {
        const running = command(input);
        const exit = running.exit.finally(() => commands.delete(exit));
        commands.set(exit, `The command ${input.command} of ${input.env.TEAMAI_WORKFLOW_ATTEMPT ?? 'a runner'}`);
        return { exit, stop: running.stop };
      },
      stopLeft: async () => {},
      sleep: async (ms) => {
        clock += ms;
        vi.setSystemTime(clock);
        if (held) return;
        const waiting = [...parked.entries()];
        parked.clear();
        for (const [id, open] of waiting) {
          if (doomed.delete(attemptOf(id))) open.crash();
          else open.resume();
        }
        await settle();
      },
    },
  };
}

interface HarnessOptions {
  session?: string;
  /** Why the caller counts as an agent's; none unless a test sets it. */
  evidence?: AgentEvidence;
  /** The run mode of the calling process; attended unless a test sets it. */
  mode?: RunMode;
  /** Wraps the in-process protocol, to script an engine answer. */
  client?: (client: WorkflowClient) => WorkflowClient;
  /** Wraps the in-memory runners, to drop or hold a runner. */
  runners?: (runners: Runners) => Runners;
  /** The team repository's scorers, by name, as the text of `scorers/<name>.md`. */
  scorers?: Record<string, string>;
  /** The member's `scoring` settings. */
  scoring?: LocalConfig['scoring'];
  /** An install of a `sharedTeam` to drive from, instead of a checkout and team repository of the harness's own. */
  install?: TeamInstall;
  /** The member's `ai.tool` in ~/.teamai/config.yaml; none unless a test sets it. */
  aiTool?: string;
  /** The tool the session's host names, which its runners also run under; claude unless a test sets it, null for none. */
  tool?: ToolId | null;
}

/** A member's install of a `sharedTeam`: its config, and the business checkout its runs start from. */
interface TeamInstall {
  config: LocalConfig;
  checkout: string;
}

/**
 * A team repository holding `workflows` and a business repository, each on a bare origin, so one install publishes a
 * run to `teamai-reports` and another claims it. `install` makes a member's install: a team clone with its workflows
 * synced, a data home, and a business checkout.
 */
export function sharedTeam(workflows: Record<string, string>): { install(name: string): Promise<TeamInstall> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-skill-team-')));
  onTestFinished(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const origin = path.join(root, 'team.git');
  const business = path.join(root, 'business.git');
  const seed = (dir: string, files: Record<string, string>): void => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'seed');
  };
  seed(path.join(root, 'team'), { 'teamai.yaml': 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: github\n', ...Object.fromEntries(Object.entries(workflows).map(([name, yaml]) => [`workflows/${name}.yaml`, yaml])) });
  seed(path.join(root, 'product'), { 'README.md': 'fixture\n' });
  git(root, 'clone', '-q', '--bare', path.join(root, 'team'), origin);
  git(root, 'clone', '-q', '--bare', path.join(root, 'product'), business);
  return {
    install: async (name) => {
      const home = path.join(root, name);
      const clone = path.join(home, 'team-repo');
      const checkout = path.join(home, 'work');
      git(root, 'clone', '-q', origin, clone);
      git(root, 'clone', '-q', business, checkout);
      for (const dir of [clone, checkout]) {
        git(dir, 'config', 'user.name', name);
        git(dir, 'config', 'user.email', `${name}@example.invalid`);
      }
      const config: LocalConfig = { repo: { kind: 'git', localPath: clone, remote: origin }, username: name, scope: 'user', additionalRoles: [], dataHome: path.join(home, 'data') };
      await syncWorkflowDefinitions(config);
      return { config, checkout };
    },
  };
}

/** A checkout and a team repository of the harness's own under `root`, holding `workflows` and the scorers of `options`, synced. */
async function ownInstall(root: string, workflows: Record<string, string>, options: HarnessOptions): Promise<TeamInstall> {
  const work = path.join(root, 'work');
  const repo = path.join(root, 'knowledge');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(repo, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scorers'));
  for (const [name, text] of Object.entries(options.scorers ?? {})) fs.writeFileSync(path.join(repo, 'scorers', `${name}.md`), text);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'fixture');
  const config: LocalConfig = {
    repo: { kind: 'self', localPath: repo, remote: 'local' }, username: 'test', scope: 'project', projectRoot: work,
    additionalRoles: [], dataHome: path.join(root, 'data'), ...(options.scoring ? { scoring: options.scoring } : {}),
  };
  for (const [name, yaml] of Object.entries(workflows)) fs.writeFileSync(path.join(repo, 'workflows', `${name}.yaml`), yaml);
  await syncWorkflowDefinitions(config);
  return { config, checkout: work };
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
  const { config, checkout: work } = options.install ?? await ownInstall(root, workflows, options);
  const env = await resolveWorkflowEnv(config);
  // Every tool's default paths, as a team repository that sets no toolPaths has them.
  const toolPaths = TeamaiConfigBaseSchema.shape.toolPaths.parse(undefined);
  if (options.aiTool) {
    fs.mkdirSync(path.dirname(getUserConfigPath()), { recursive: true });
    fs.writeFileSync(getUserConfigPath(), `ai:\n  tool: ${options.aiTool}\n`);
  }
  const aiTools = (await memberTools(config)).map(({ tool }) => tool);
  const production = await skillContext({ config, toolPaths, env, cwd: work, aiTools });
  const scheduler = memoryRunners(production.runners.command);
  const client = scheduler.settingUp(inProcessClient({ config, env }));
  const rows: string[] = [];
  const context: SkillContext = {
    config, toolPaths, env, client: scheduler.judging(options.client ? options.client(client) : client), session: options.session ?? 'session-a', tool: options.tool === null ? undefined : options.tool ?? 'claude', aiTools: production.aiTools, invocation: 'teamai', evidence: options.evidence ?? { kind: 'none' }, mode: options.mode ?? 'attended', cwd: work,
    now: scheduler.now, runners: scheduler.track(options.runners ? options.runners(scheduler.runners) : scheduler.runners),
    locks: { take: (run, body, waitMs) => takeRunLock(config, run, body, { waitMs }) },
    trace: (row) => { rows.push(row); },
  };
  scheduler.bind(context);
  return {
    root, work, config, context, rows,
    /** While held, a sleep moves the clock and no runner, so two calls in a row see the same runners. */
    hold: scheduler.hold,
    /** Moves the clock `ms` ahead and wakes no runner. A sleep moves it on from there, so `vi.setSystemTime` would not hold. */
    advance: scheduler.advance,
    /** Makes the runner of `attempt` crash where it is parked at the next sleep. Whether one is alive to crash. */
    crashRunner: scheduler.crash,
    /** Makes `call` as the session, or with another session, agent evidence, run mode, lock, config, session tool or working directory in its context. */
    call: (call: SkillCall, overrides: Partial<Pick<SkillContext, 'session' | 'evidence' | 'mode' | 'locks' | 'config' | 'tool' | 'cwd'>> = {}) => runSkillCall(call, { ...context, ...overrides }),
  };
}

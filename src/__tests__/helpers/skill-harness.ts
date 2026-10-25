import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { resolveWorkflowEnv } from '../../env-resolution.js';
import type { LocalConfig } from '../../types.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { inProcessClient, type WorkflowClient } from '../../workflow/protocol.js';
import { runSkillCall, type Runners, type SkillCall, type SkillContext } from '../../workflow/drivers/skill/skill-driver.js';
import { withRunLock } from '../../workflow/store.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/**
 * Runners in this process on a fake clock. A runner is the same `report --driver skill --attempt` call the detached
 * process makes, and it waits at each run lock it takes until the next `sleep`, so a test sees each phase a real runner
 * passes through: preparing, then running, then reported.
 */
function memoryRunners(start: number): { runners: Runners; now: () => Date; bind(context: SkillContext): void } {
  let clock = start;
  let base: SkillContext | undefined;
  const live = new Map<string, Promise<unknown>>();
  const gates: Array<() => void> = [];
  const locks: SkillContext['locks'] = {
    take: async (run, body, waitMs) => {
      await new Promise<void>((resolve) => { gates.push(resolve); });
      if (!base) throw new Error('memoryRunners used before bind');
      return withRunLock(base.config, run, body, { waitMs });
    },
  };
  const settle = async (): Promise<void> => {
    while (live.size > gates.length) await new Promise((resolve) => { setImmediate(resolve); });
  };
  return {
    now: () => new Date(clock),
    bind: (context) => { base = context; },
    runners: {
      spawn: async (job) => {
        if (!base) throw new Error('memoryRunners used before bind');
        const key = `${job.run}/${job.attempt}`;
        const call: SkillCall = { kind: 'report', run: job.run, attempt: job.attempt, role: 'runner' };
        // A runner that waits parks until the next sleep of the session, so it never waits on itself.
        const runners = { ...base.runners, sleep: () => new Promise<void>((resolve) => { gates.push(resolve); }) };
        live.set(key, runSkillCall(call, { ...base, session: undefined, locks, runners }).finally(() => live.delete(key)));
      },
      alive: async (run, attempt) => live.has(`${run}/${attempt}`),
      sleep: async (ms) => {
        clock += ms;
        for (const open of gates.splice(0)) open();
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
  const scheduler = memoryRunners(Date.parse('2026-10-01T09:00:00.000Z'));
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
    /** Makes `call` as the session, or with another session or lock in its context. */
    call: (call: SkillCall, overrides: Partial<Pick<SkillContext, 'session' | 'locks'>> = {}) => runSkillCall(call, { ...context, ...overrides }),
  };
}

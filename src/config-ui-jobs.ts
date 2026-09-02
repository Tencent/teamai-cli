/**
 * Job runner for the Config WebUI — spawns CLI subprocesses (init → pull)
 * as background jobs with a tail-capped log. Injectable SpawnRunner keeps
 * tests hermetic (no real subprocess, no network).
 *
 * Security posture: user input NEVER reaches git raw args here. Branch names
 * are validated against the `ls-remote --heads` whitelist by the route layer
 * before a reinit job is created; the remote is pinned to the currently
 * configured repo.remote (the API accepts no repo URL).
 */
import { spawn } from 'node:child_process';

export type JobKind = 'reinit' | 'sync';
export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  exitCode: number | null;
  /** Tail-capped joined subprocess output. */
  log: string;
  error?: string;
}

export interface SpawnRunner {
  (args: string[], opts: { cwd: string }): Promise<{ code: number; output: string }>;
}

export class JobBusyError extends Error {
  constructor() {
    super('another job is already running');
    this.name = 'JobBusyError';
  }
}

/** Ring-buffer log: keep the tail, cap line count. */
const LOG_MAX_LINES = 8000;

class RingLog {
  private lines: string[] = [];
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > LOG_MAX_LINES) {
      this.lines = this.lines.slice(-LOG_MAX_LINES);
    }
  }
  toString(): string {
    return this.lines.join('\n');
  }
}

/**
 * Resolve the CLI entry script for subprocesses.
 * TEAMAI_CONFIG_UI_CLI overrides (tests / tsx dev mode, where process.argv[1]
 * points at the tsx loader instead of dist/index.js).
 */
export function resolveCliEntry(): string {
  return process.env.TEAMAI_CONFIG_UI_CLI ?? process.argv[1] ?? 'dist/index.js';
}

/** Default spawn implementation: node <cliEntry> ...args with inherited env. */
export const defaultSpawn: SpawnRunner = (args, opts) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveCliEntry(), ...args], {
      cwd: opts.cwd,
      env: process.env,
    });
    const ring = new RingLog();
    const feed = (chunk: Buffer): void => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) ring.push(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => {
      resolve({ code: -1, output: `${ring.toString()}\nspawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, output: ring.toString() });
    });
  });

export interface ReinitPlan {
  /** Remote URL, pinned from the current local config (never user input). */
  remote: string;
  /** Target branch; null ⇒ return to the remote default (omit --branch). */
  branch: string | null;
  scope: 'user' | 'project';
  /** Preserve the current primary role across re-init. */
  primaryRole?: string;
  /** Preserve the current enabled agents across re-init. */
  agents: string[];
  /** cwd for the subprocess (scope resolution fallback). */
  cwd: string;
}

export interface JobRunner {
  /** Start a reinit job (init --branch → pull --force). Throws JobBusyError. */
  startReinit(plan: ReinitPlan): string;
  /** Start a sync job (pull --force). Throws JobBusyError. */
  startSync(cwd: string): string;
  get(id: string): Job | undefined;
  /** The active/last job, if any. */
  current(): Job | undefined;
}

let jobCounter = 0;

export function createJobRunner(spawnImpl: SpawnRunner = defaultSpawn): JobRunner {
  const jobs = new Map<string, Job>();
  let active: Job | undefined;
  const HISTORY_CAP = 20;

  function pruneHistory(): void {
    // Keep the newest HISTORY_CAP jobs (active job always survives).
    const ordered = [...jobs.entries()].filter(([id]) => id !== active?.id);
    while (ordered.length >= HISTORY_CAP) {
      const [id] = ordered.shift()!;
      jobs.delete(id);
    }
  }

  function begin(kind: JobKind): Job {
    if (active && (active.status === 'queued' || active.status === 'running')) {
      throw new JobBusyError();
    }
    jobCounter += 1;
    const job: Job = {
      id: `job_${Date.now().toString(36)}_${jobCounter}`,
      kind,
      status: 'queued',
      exitCode: null,
      log: '',
    };
    jobs.set(job.id, job);
    active = job;
    pruneHistory();
    return job;
  }

  async function runSequence(job: Job, steps: Array<{ label: string; args: string[]; cwd: string }>): Promise<void> {
    job.status = 'running';
    try {
      for (const step of steps) {
        appendJobLog(job, '$ teamai ' + step.args.join(' '));
        const result = await spawnImpl(step.args, { cwd: step.cwd });
        appendJobLog(job, result.output);
        job.exitCode = result.code;
        if (result.code !== 0) {
          job.status = 'error';
          job.error = `step "${step.label}" exited with code ${result.code}`;
          return;
        }
      }
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = (e as Error).message;
    }
  }

  /** Append with a hard tail cap so job.log stays bounded for ANY spawn impl. */
  function appendJobLog(job: Job, text: string): void {
    const combined = job.log ? `${job.log}\n${text}` : text;
    const lines = combined.split('\n');
    job.log = lines.length > LOG_MAX_LINES ? lines.slice(-LOG_MAX_LINES).join('\n') : combined;
  }

  return {
    startReinit(plan) {
      const job = begin('reinit');
      const initArgs: string[] = ['init', plan.remote];
      if (plan.branch) {
        initArgs.push('--branch', plan.branch);
      }
      initArgs.push('--scope', plan.scope, '--force');
      if (plan.primaryRole) {
        initArgs.push('--role', plan.primaryRole);
      }
      if (plan.agents.length > 0) {
        initArgs.push('--agent', plan.agents.join(','));
      }
      const steps = [
        { label: 'init', args: initArgs, cwd: plan.cwd },
        { label: 'pull', args: ['pull', '--force'], cwd: plan.cwd },
      ];
      void runSequence(job, steps);
      return job.id;
    },
    startSync(cwd) {
      const job = begin('sync');
      void runSequence(job, [{ label: 'pull', args: ['pull', '--force'], cwd }]);
      return job.id;
    },
    get(id) {
      return jobs.get(id);
    },
    current() {
      return active;
    },
  };
}

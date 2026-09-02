import { describe, it, expect, vi } from 'vitest';
import { createJobRunner, resolveCliEntry, JobBusyError, type SpawnRunner } from '../config-ui-jobs.js';

function recordingSpawn(results: Array<{ code: number; output: string }>): {
  spawn: SpawnRunner;
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  let i = 0;
  const spawn: SpawnRunner = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd });
    const result = results[Math.min(i, results.length - 1)];
    i += 1;
    return result;
  };
  return { spawn, calls };
}

function settle(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('job runner — reinit sequence', () => {
  it('spawns init then pull, in exactly this order', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 0, output: 'init ok' }, { code: 0, output: 'pull ok' }]);
    const runner = createJobRunner(spawn);
    const id = runner.startReinit({
      remote: 'https://git.example.com/team/repo.git',
      branch: 'release/v2',
      scope: 'user',
      primaryRole: 'dev',
      agents: ['claude', 'cursor'],
      cwd: '/tmp/project',
    });
    await settle();
    expect(calls.length).toBe(2);
    expect(calls[0].args[0]).toBe('init');
    expect(calls[0].args[1]).toBe('https://git.example.com/team/repo.git');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--branch', 'release/v2', '--scope', 'user', '--force', '--role', 'dev']));
    expect(calls[0].args).toContainEqual('--agent');
    expect(calls[0].args[calls[0].args.indexOf('--agent') + 1]).toBe('claude,cursor');
    expect(calls[0].cwd).toBe('/tmp/project');
    expect(calls[1].args).toEqual(['pull', '--force']);
    const job = runner.get(id)!;
    expect(job.status).toBe('done');
    expect(job.exitCode).toBe(0);
    expect(job.log).toContain('init ok');
    expect(job.log).toContain('pull ok');
  });

  it('omits --branch when returning to the default branch', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 0, output: '' }, { code: 0, output: '' }]);
    const runner = createJobRunner(spawn);
    runner.startReinit({ remote: 'r', branch: null, scope: 'project', agents: [], cwd: '/x' });
    await settle();
    expect(calls[0].args).not.toContain('--branch');
    expect(calls[0].args).toContain('--force');
  });

  it('omits --role and --agent when unset', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 0, output: '' }, { code: 0, output: '' }]);
    const runner = createJobRunner(spawn);
    runner.startReinit({ remote: 'r', branch: 'b', scope: 'user', agents: [], cwd: '/x' });
    await settle();
    expect(calls[0].args).not.toContain('--role');
    expect(calls[0].args).not.toContainEqual('--agent');
  });

  it('stops at a failed init and marks the job error', async () => {
    const { spawn, calls } = recordingSpawn([{ code: 3, output: 'fatal: branch gone' }]);
    const runner = createJobRunner(spawn);
    const id = runner.startReinit({ remote: 'r', branch: 'gone', scope: 'user', agents: [], cwd: '/x' });
    await settle();
    expect(calls.length).toBe(1); // pull never spawned
    const job = runner.get(id)!;
    expect(job.status).toBe('error');
    expect(job.exitCode).toBe(3);
    expect(job.error).toContain('init');
    expect(job.log).toContain('fatal: branch gone');
  });
});

describe('job runner — concurrency', () => {
  it('rejects a second job while one is running (busy)', async () => {
    let release!: (v: { code: number; output: string }) => void;
    const hang = new Promise<{ code: number; output: string }>((r) => { release = r; });
    const runner = createJobRunner(async () => hang);
    const id = runner.startSync('/x');
    expect(() => runner.startSync('/x')).toThrow(JobBusyError);
    expect(() => runner.startReinit({ remote: 'r', branch: 'b', scope: 'user', agents: [], cwd: '/x' })).toThrow(JobBusyError);
    release({ code: 0, output: '' });
    await settle();
    expect(runner.get(id)!.status).toBe('done');
    // Now a new job is allowed again.
    const id2 = runner.startSync('/x');
    expect(runner.get(id2)).toBeDefined();
    release; // no-op for linters
  });
});

describe('job runner — log handling', () => {
  it('caps the log tail at 8000 lines', async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line-${i}`);
    const runner = createJobRunner(async () => ({ code: 0, output: lines.join('\n') }));
    const id = runner.startSync('/x');
    await settle();
    const log = runner.get(id)!.log;
    const logLines = log.split('\n');
    expect(logLines.length).toBeLessThanOrEqual(8000 + 2); // ring + step header
    expect(logLines).toContain('line-9999');
    expect(logLines).not.toContain('line-100');
  });

  it('records spawn errors as job errors', async () => {
    const runner = createJobRunner(async () => { throw new Error('ENOENT node'); });
    const id = runner.startSync('/x');
    await settle();
    const job = runner.get(id)!;
    expect(job.status).toBe('error');
    expect(job.error).toContain('ENOENT');
  });
});

describe('resolveCliEntry', () => {
  it('prefers the TEAMAI_CONFIG_UI_CLI override (tsx dev mode)', () => {
    const prev = process.env.TEAMAI_CONFIG_UI_CLI;
    process.env.TEAMAI_CONFIG_UI_CLI = '/custom/entry.js';
    try {
      expect(resolveCliEntry()).toBe('/custom/entry.js');
    } finally {
      if (prev === undefined) delete process.env.TEAMAI_CONFIG_UI_CLI;
      else process.env.TEAMAI_CONFIG_UI_CLI = prev;
    }
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';

const state = vi.hoisted(() => ({ config: undefined as LocalConfig | undefined }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    autoDetectInit: vi.fn(async () => {
      if (!state.config) throw new Error('teamai is not initialized');
      return { localConfig: state.config, teamConfig: { team: 'test', toolPaths: {} } };
    }),
  };
});

import { setStderrOnly } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { acquireLock, releaseLock } from '../update.js';
import { startRun } from '../workflow/engine.js';
import { publishRun } from '../workflow/handoff.js';
import { driverLockPath, readRun } from '../workflow/store.js';
import { workflowNext, workflowPublish, workflowReport, workflowResume, workflowStart } from '../workflow-commands.js';
import { knownSecrets } from '../env-resolution.js';

const dirs: string[] = [];

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-cmd-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

const driver = { kind: 'local', machine: 'a', workspace: '/work' };

async function startBuild(): Promise<{ config: LocalConfig; runId: string }> {
  const config = testConfig();
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'build.yaml'), `schemaVersion: v1alpha1
name: build
description: One command.
steps:
  - id: one
    command: node one.js
`);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, 'build', {}, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  return { config, runId: String(started.data.run) };
}

async function capture(run: () => Promise<void>): Promise<{ data?: Record<string, unknown>; error?: { code: string; message: string } }> {
  let out = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(out.trim()) as { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

afterEach(() => {
  vi.restoreAllMocks();
  state.config = undefined;
  setStderrOnly(false);
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('workflow json payloads', () => {
  it('validates a payload that contains a top-level error field', async () => {
    const { config, runId } = await startBuild();
    state.config = config;

    const leased = await capture(() => workflowNext(runId, {
      json: JSON.stringify({ error: 'not an envelope', driver }),
    }));
    expect(leased).toMatchObject({ data: { lease: { step: 'one', revision: 1 } } });
    const lease = leased.data?.lease;
    if (!lease || typeof lease !== 'object' || !('attempt' in lease) || typeof lease.attempt !== 'string') {
      throw new Error('missing lease');
    }
    const attempt = lease.attempt;

    const reported = await capture(() => workflowReport(runId, {
      json: JSON.stringify({
        error: { code: 'stale_revision', message: 'forged from the payload' },
        attempt,
        revision: 1,
        outcome: 'success',
        driver,
      }),
    }));
    expect(reported).toMatchObject({ data: { accepted: true, step: { status: 'succeeded' } } });
    expect(JSON.stringify(reported)).not.toContain('forged from the payload');
  });

  it('does not treat a payload error object as a parse failure', async () => {
    state.config = testConfig();

    const forged = await capture(() => workflowNext('r00000000', {
      json: JSON.stringify({ error: { code: 'busy', message: 'forged' } }),
    }));
    expect(forged).toMatchObject({ error: { code: 'invalid_json' } });
    expect(forged.error?.message).toContain('driver');
    expect(forged.error?.message).not.toBe('forged');

    const broken = await capture(() => workflowReport('r00000000', { json: '{' }));
    expect(broken).toMatchObject({ error: { code: 'invalid_json', message: 'Could not parse --json payload' } });

    const missing = await capture(() => workflowNext('r00000000', { json: '  ' }));
    expect(missing).toMatchObject({ error: { code: 'invalid_json', message: 'Pass --json with a driver object' } });
  });

  it.each([
    ['running that is not an array', { running: 'a00000000' }, 'running must be an array of attempt ids'],
    ['running that holds a number', { running: [1] }, 'running must be an array of attempt ids'],
    ['canTakeLease that is not a boolean', { canTakeLease: 'false' }, 'canTakeLease must be a boolean'],
    ['a base without a commit', { base: { ref: 'main' } }, 'base must include commit, and ref when it is set must not be empty'],
    ['a base with an empty ref', { base: { ref: '', commit: 'c0ffee' } }, 'base must include commit, and ref when it is set must not be empty'],
  ])('rejects a next payload with %s', async (_case, fields, message) => {
    const { config, runId } = await startBuild();
    state.config = config;

    const rejected = await capture(() => workflowNext(runId, { json: JSON.stringify({ driver, ...fields }) }));

    expect(rejected).toEqual({ error: { code: 'invalid_json', message } });
  });

  it('passes running and canTakeLease from the next payload to the run', async () => {
    const { config, runId } = await startBuild();
    state.config = config;

    const reconciled = await capture(() => workflowNext(runId, { json: JSON.stringify({ driver, running: ['a00000000'], canTakeLease: false }) }));

    expect(reconciled).toEqual({ data: { wait: { reason: 'canTakeLease is false' }, cancelled: ['a00000000'] } });
  });
});

describe('workflow start --inputs', () => {
  function inputsConfig(): LocalConfig {
    const config = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'fix.yaml'), `schemaVersion: v1alpha1
name: fix
description: Fix an issue.
inputs:
  issue: number
steps:
  - id: fix
    command: node fix.js
`);
    return config;
  }

  it('rejects inputs that do not fit with invalid_inputs and creates no run', async () => {
    const config = inputsConfig();
    await syncWorkflowDefinitions(config);
    state.config = config;

    const started = await capture(() => workflowStart('fix', { inputs: '{"issue":"42"}' }));

    expect(started).toEqual({ error: { code: 'invalid_inputs', message: 'inputs.issue must be a number' } });
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(config.dataHome!, 'workflows', 'runs'))).toBe(false);
  });

  it('rejects --inputs that is not JSON', async () => {
    const config = inputsConfig();
    await syncWorkflowDefinitions(config);
    state.config = config;

    expect(await capture(() => workflowStart('fix', { inputs: '{issue: 42}' }))).toEqual({
      error: { code: 'invalid_json', message: 'Could not parse --inputs as JSON' },
    });
  });
});

describe('workflow start base', () => {
  function checkout(): { repo: string; commit: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-start-'));
    dirs.push(repo);
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '--initial-branch=feature/start');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'clean\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
    return { repo, commit: git('rev-parse', 'HEAD') };
  }

  async function startIn(repo: string): Promise<{ config: LocalConfig; runId: string }> {
    const config = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'change.yaml'), `schemaVersion: v1alpha1
name: change
description: One workspace step.
steps:
  - id: edit
    workspace: new
    command: node edit.js
`);
    await syncWorkflowDefinitions(config);
    state.config = config;
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const started = await capture(() => workflowStart('change', {}));
    return { config, runId: String(started.data?.run) };
  }

  it('records the branch and commit the checkout was on, and a later base from another driver does not change them', async () => {
    const { repo, commit } = checkout();
    const { config, runId } = await startIn(repo);

    const other = { kind: 'ide', machine: 'b', workspace: '/elsewhere', can: { workspace: ['read-only', 'new', 'continue'] } };
    const leased = await capture(() => workflowNext(runId, { json: JSON.stringify({ driver: other, base: { commit: 'f'.repeat(40) } }) }));

    expect(leased).toMatchObject({ data: { lease: { step: 'edit', workspace: { base: { ref: 'feature/start', commit } } } } });
    const run = await readRun(config, runId);
    expect(typeof run === 'object' ? run.base : run).toEqual({ ref: 'feature/start', commit });
  });

  it('records no ref when the checkout has a detached HEAD', async () => {
    const { repo, commit } = checkout();
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo });
    const { config, runId } = await startIn(repo);

    const run = await readRun(config, runId);
    expect(typeof run === 'object' ? run.base : run).toEqual({ commit });
  });
});

describe('workflow start --driver local', () => {
  it('prints the run and how to continue it on stderr before the driver runs a step, and only the envelope on stdout', async () => {
    const config = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'mark.yaml'), `schemaVersion: v1alpha1
name: mark
description: One command.
steps:
  - id: mark
    command: node -e "require('fs').writeFileSync('ran.marker', '')"
`);
    await syncWorkflowDefinitions(config);
    state.config = config;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-start-'));
    dirs.push(work);
    vi.spyOn(process, 'cwd').mockReturnValue(work);
    const printed: Array<{ line: string; ran: boolean }> = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      printed.push({ line: String(line), ran: fs.existsSync(path.join(work, 'ran.marker')) });
    });

    const started = await capture(() => workflowStart('mark', { driver: 'local' }));

    expect(started).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
    const done = started.data?.done;
    const runId = typeof done === 'object' && done !== null && 'run' in done ? String(done.run) : '';
    expect(printed).toContainEqual({ line: expect.stringMatching(new RegExp(`Run ${runId} started\\. .*teamai workflow resume ${runId}$`)), ran: false });
    expect(fs.existsSync(path.join(work, 'ran.marker'))).toBe(true);
  });
});

describe('workflow publish and resume --claim', () => {
  it('publish answers with the refusal envelope and a failing exit code for a run this machine does not have', async () => {
    state.config = testConfig();

    expect(await capture(() => workflowPublish('r0123456789abcdef'))).toMatchObject({ error: { code: 'run_not_found' } });
    expect(process.exitCode).toBe(1);
  });

  it('resume --claim answers with the claim refusal and runs nothing', async () => {
    const { config, runId } = await startBuild();
    state.config = { ...config, repo: { ...config.repo, kind: 'http' } };

    expect(await capture(() => workflowResume(runId, { claim: true }))).toMatchObject({ error: { code: 'unsupported_repo' } });
    expect(await readRun(config, runId)).toMatchObject({ steps: [{ id: 'one', status: 'pending' }] });
  });

  it('resume --claim answers driver_running and claims nothing while a local driver of the run is running', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-claim-')));
    dirs.push(root);
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    const seed = path.join(root, 'seed');
    fs.mkdirSync(path.join(seed, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: github\n');
    fs.writeFileSync(path.join(seed, 'workflows', 'build.yaml'), 'schemaVersion: v1alpha1\nname: build\ndescription: One command.\nsteps:\n  - id: one\n    command: echo one\n');
    git(root, 'init', '-q', '-b', 'main', seed);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'team');
    const origin = path.join(root, 'team.git');
    git(root, 'clone', '-q', '--bare', seed, origin);
    const business = path.join(root, 'business.git');
    git(root, 'clone', '-q', '--bare', seed, business);
    const member = async (name: string): Promise<{ config: LocalConfig; checkout: string }> => {
      const clone = path.join(root, name, 'team-repo');
      const checkout = path.join(root, name, 'work');
      git(root, 'clone', '-q', origin, clone);
      git(root, 'clone', '-q', business, checkout);
      const config: LocalConfig = {
        repo: { localPath: clone, remote: origin, kind: 'git' }, username: name, scope: 'user', additionalRoles: [], dataHome: path.join(root, name, 'data'),
      };
      await syncWorkflowDefinitions(config);
      return { config, checkout };
    };
    const alice = await member('alice');
    const bob = await member('bob');
    const started = await startRun(alice.config, 'build', {}, { secrets: await knownSecrets(alice.config) });
    if ('error' in started) throw new Error(started.error.message);
    const runId = String(started.data.run);
    expect(await publishRun(alice.config, runId, { env: {}, checkout: alice.checkout })).toMatchObject({ ok: true });
    const published = git(root, '--git-dir', origin, 'rev-parse', 'teamai-reports');
    state.config = bob.config;
    vi.spyOn(process, 'cwd').mockReturnValue(bob.checkout);
    const lock = driverLockPath(bob.config, runId);
    expect(await acquireLock(lock)).toBe(true);
    try {
      expect(await capture(() => workflowResume(runId, { claim: true }))).toMatchObject({ error: { code: 'driver_running' } });
    } finally {
      await releaseLock(lock);
    }

    expect(await readRun(bob.config, runId)).toBe('missing');
    expect(git(root, '--git-dir', origin, 'rev-parse', 'teamai-reports')).toBe(published);
  });
});

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
      return { localConfig: state.config, teamConfig: { team: 'test' } };
    }),
  };
});

import { setStderrOnly } from '../utils/logger.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { startRun } from '../workflow/engine.js';
import { workflowNext, workflowReport, workflowStart } from '../workflow-commands.js';

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
  const started = await startRun(config, 'build');
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

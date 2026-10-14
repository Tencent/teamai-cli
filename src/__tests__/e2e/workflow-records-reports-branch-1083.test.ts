import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../../types.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { startRun } from '../../workflow/engine.js';
import { localDriver, runLocalDriver } from '../../workflow/local-driver.js';
import { pendingRecords } from '../../workflow/records.js';

// #1083 end-to-end: a real git clone with a real bare origin, driven through
// the engine the CLI uses. The run record and the workflow stats totals must
// land on the teamai-reports branch of origin, and the local queue must drain.

const TWO_STEPS = `schemaVersion: v1alpha1
name: build
description: Two commands.
steps:
  - id: one
    command: node one.js
  - id: two
    command: node two.js
    output:
      ok: boolean
`;

let sandbox = '';

afterEach(async () => {
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  sandbox = '';
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

describe('#1083 workflow run records reach the reports branch', () => {
  it('publishes start and end records plus stats totals to origin', async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-workflow-records-e2e-'));
    const origin = path.join(sandbox, 'origin.git');
    const repo = path.join(sandbox, 'team-repo');
    const work = path.join(sandbox, 'work');
    const dataHome = path.join(sandbox, 'data');
    git(sandbox, 'init', '--bare', '-b', 'main', 'origin.git');
    git(sandbox, 'clone', 'origin.git', 'team-repo');
    git(repo, 'config', 'user.name', 'E2E Test');
    git(repo, 'config', 'user.email', 'e2e@example.invalid');
    await fs.mkdir(path.join(repo, 'workflows'), { recursive: true });
    await fs.writeFile(path.join(repo, 'workflows', 'build.yaml'), TWO_STEPS);
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'fixture: workflow definition');
    git(repo, 'push', 'origin', 'main');
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, 'one.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");
    await fs.writeFile(path.join(work, 'two.js'), "process.stdout.write(JSON.stringify({ ok: true }))\n");

    const config: LocalConfig = {
      repo: { localPath: repo, remote: origin, kind: 'git' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
      projectRoot: sandbox,
      dataHome,
    };

    await syncWorkflowDefinitions(config);
    const started = await startRun(config, 'build', { driver: localDriver(work) });
    expect(started).toMatchObject({ data: { status: 'running', record: 'published' } });
    const runId = String((started as { data: { run: string } }).data.run);

    // The start record is already on origin's reports branch.
    const startListing = git(origin, 'ls-tree', '-r', '--name-only', 'teamai-reports');
    expect(startListing).toContain(`workflows/runs/${runId}.json`);
    const startRaw = git(origin, 'show', `teamai-reports:workflows/runs/${runId}.json`);
    const startRecord = JSON.parse(startRaw) as Record<string, unknown>;
    expect(startRecord.phase).toBe('start');
    expect(startRecord.status).toBe('running');
    expect(startRecord.username).toBe('alice');

    const done = await runLocalDriver(config, runId, work);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });

    // The end phase completed the same logical record (no duplicate file).
    const endRaw = git(origin, 'show', `teamai-reports:workflows/runs/${runId}.json`);
    const endRecord = JSON.parse(endRaw) as Record<string, unknown>;
    expect(endRecord.phase).toBe('end');
    expect(endRecord.status).toBe('succeeded');
    expect(endRecord.stepCounts).toEqual({ total: 2, succeeded: 2, failed: 0 });
    expect(endRecord.steps).toEqual([
      { step: 'one', outcome: 'success' },
      { step: 'two', outcome: 'success' },
    ]);
    expect(endRecord.startedAt).toBe(startRecord.startedAt);

    // Workflow totals landed in the user's stats file on the same branch.
    const statsRaw = git(origin, 'show', 'teamai-reports:stats/alice.yaml');
    expect(statsRaw).toContain('workflows:');
    expect(statsRaw).toContain('runs: 1');
    expect(statsRaw).toContain('succeeded: 1');

    // The local queue drained after delivery.
    expect(await pendingRecords(config)).toEqual([]);
  }, 60000);
});

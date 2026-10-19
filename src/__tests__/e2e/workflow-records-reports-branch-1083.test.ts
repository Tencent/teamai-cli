import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentVersion } from '../../package-info.js';
import type { LocalConfig, TeamaiConfig } from '../../types.js';
import { syncWorkflowDefinitions } from '../../workflow/cache.js';
import { startRun } from '../../workflow/engine.js';
import { localDriver, runLocalDriver } from '../../workflow/local-driver.js';
import { createLocalToolAdapter, type ToolSpawn } from '../../workflow/local-tool-adapter.js';
import { pendingRecords } from '../../workflow/records.js';
import { fakeClaude, recordDelivery } from '../helpers/delivered-checkout.js';

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
    needs: [one]
    command: node two.js
    output:
      ok: boolean
  - id: review
    needs: [two]
    prompt: Review the build.
    agent: reviewer
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

    const rev = git(repo, 'rev-parse', '--short', 'HEAD').trim();
    const agentFile = path.join(os.homedir(), '.claude', 'agents', 'reviewer.md');
    await fs.mkdir(path.dirname(agentFile), { recursive: true });
    await fs.writeFile(agentFile, '---\nname: reviewer\ndescription: Reviews builds.\nmodel: claude-opus-4-1\n---\nReview carefully.\n');
    await recordDelivery(config, {
      rev,
      targets: ['claude'],
      files: [agentFile],
      agentModels: { reviewer: { claude: { step: 'spec', model: 'claude-opus-4-1' } } },
    });
    const restorePath = fakeClaude(sandbox, '2.1.301');
    // The tool prints what `claude -p --output-format stream-json --verbose` prints: an `init` event naming the model.
    const stream = [
      { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-opus-4-1-20250805' },
      { type: 'result', result: '{}', session_id: 'session-1', modelUsage: { 'claude-opus-4-1-20250805': { inputTokens: 3, outputTokens: 1 } } },
    ].map((event) => JSON.stringify(event)).join('\n');
    const claude: ToolSpawn = (_command, _args, options) => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stream)})`], options);

    await syncWorkflowDefinitions(config);
    const started = await startRun(config, 'build', {}, { driver: localDriver(work) });
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

    const done = await runLocalDriver(config, runId, work, {
      tools: { default: 'claude' },
      toolPaths: { claude: { agents: '.claude/agents' } } as TeamaiConfig['toolPaths'],
      adapter: createLocalToolAdapter(claude, () => process.execPath),
    }).finally(restorePath);
    expect(done).toMatchObject({ data: { done: { outcome: 'succeeded', record: 'published' } } });

    // The end phase completed the same logical record (no duplicate file).
    const endRaw = git(origin, 'show', `teamai-reports:workflows/runs/${runId}.json`);
    const endRecord = JSON.parse(endRaw) as Record<string, unknown>;
    expect(endRecord.phase).toBe('end');
    expect(endRecord.status).toBe('succeeded');
    expect(endRecord.stepCounts).toEqual({ total: 3, succeeded: 3, failed: 0, skipped: 0, cancelled: 0 });
    expect(endRecord.steps).toEqual([
      { step: 'one', pass: 1, outcome: 'success' },
      { step: 'two', pass: 1, outcome: 'success' },
      {
        step: 'review',
        pass: 1,
        agent: {
          v: 1,
          definition: { name: 'reviewer', applied: 'main' },
          tool: { name: 'claude', version: '2.1.301' },
          model: { requested: 'claude-opus-4-1', reported: 'claude-opus-4-1-20250805' },
          team: { revision: git(repo, 'rev-parse', rev).trim(), localChanges: false },
          teamai: getCurrentVersion(),
          driver: 'local',
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        tool: 'claude',
        model: 'claude-opus-4-1-20250805',
        outcome: 'success',
      },
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

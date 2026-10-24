import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerFromDashboard, listLocalRuns, listReportedRuns, workflowRunDetail } from '../dashboard/workflow-runs.js';
import { HttpError } from '../dashboard/http.js';
import { getReportsDir, type LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, startRun } from '../workflow/engine.js';
import { readRun } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { knownSecrets } from '../env-resolution.js';

const roots: string[] = [];
const driver = { kind: 'ide', machine: 'host-7f3a', workspace: '/private/work/checkout' };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function scope(kind: 'self' | 'http'): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-runs-'));
  roots.push(root);
  return { repo: { localPath: path.join(root, 'repo'), remote: 'local', kind }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
}

/** A run whose `ship` step waits on a HITL request that renders an input into its message. */
async function waitingRun(hitl = 'approve: { message: "Ship {{ inputs.ticket }}?", required: true }') {
  const config = scope('self');
  fs.mkdirSync(path.join(config.repo.localPath, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows/ship.yaml'), [
    'schemaVersion: v1alpha1', 'name: ship', 'description: Ship a ticket.', 'inputs: { ticket: string }', 'steps:',
    '  - id: build', '    command: echo build-secret-command',
    '  - id: ship', '    needs: [build]', `    ${hitl}`, '    prompt: Deliver {{ inputs.ticket }} as prompt-secret-text',
  ].join('\n'));
  expect((await syncWorkflowDefinitions(config)).invalid).toEqual([]);
  const started = await startRun(config, 'ship', { ticket: 'TICKET-SECRET-42' }, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(started.error.message);
  const id = String(started.data.run);
  const next = () => leaseNext(config, id, driver, { can: { hitl: true } });
  const lease = await next();
  if ('error' in lease) throw new Error(lease.error.message);
  const { attempt, revision } = lease.data.lease as { attempt: string; revision: number };
  const { reportAttempt } = await import('../workflow/engine.js');
  await reportAttempt(config, id, { attempt, revision, driver, outcome: 'success', message: 'build-output-secret', tokens: { input: 120, output: 30 } });
  const asked = await next();
  expect(asked).toMatchObject({ data: { hitl: { step: 'ship', pass: 1 } } });
  return { config, id, state: async () => await readRun(config, id) as RunState };
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  const { status, message } = error as HttpError;
  return { status, message };
}

describe('dashboard workflow runs', () => {
  it('lists a local run with its waiting HITL request and none of its inputs, outputs, prompts, message, or paths', async () => {
    const run = await waitingRun();
    const [row] = await listLocalRuns(run.config);
    expect(row).toMatchObject({ source: 'local', run: run.id, workflow: 'ship', driver: 'ide', status: 'running', current: [], waiting: ['ship'], tokens: 150, prs: [] });
    expect(row).not.toHaveProperty('endedAt');
    expect(row).not.toHaveProperty('teamRevision');
    expect(row?.sourceHash).toEqual(expect.any(String));
    const detail = await workflowRunDetail(run.config, 'local', run.id);
    expect(detail?.steps).toEqual([
      { step: 'build', pass: 1, status: 'succeeded', tokens: { input: 120, output: 30 } },
      { step: 'ship', pass: 1, status: 'waiting', gate: { kind: 'approve', options: ['yes', 'no'], required: true } },
    ]);
    const served = JSON.stringify([row, detail]);
    for (const secret of ['TICKET-SECRET-42', 'build-secret-command', 'prompt-secret-text', 'build-output-secret', 'Ship ', 'host-7f3a', '/private/work', run.config.dataHome ?? 'data']) {
      expect(served).not.toContain(secret);
    }
  });

  it('answers a required HITL request through the non-agent dashboard channel', async () => {
    const run = await waitingRun();
    expect(await answerFromDashboard(run.config, { run: run.id, step: 'ship', pass: 1, choice: 'yes' }))
      .toEqual({ answered: { step: 'ship', pass: 1, choice: 'yes', channel: 'dashboard' } });
    expect((await run.state()).steps.find((step) => step.id === 'ship')?.answer).toMatchObject({ choice: 'yes', channel: 'dashboard', agent: false });
    const [row] = await listLocalRuns(run.config);
    expect(row?.waiting).toEqual([]);
    expect((await workflowRunDetail(run.config, 'local', run.id))?.steps.find((step) => step.step === 'ship'))
      .toEqual({ step: 'ship', pass: 1, status: 'pending', answer: { choice: 'yes', channel: 'dashboard' } });
  });

  it('refuses an answer to a pass the page no longer shows, and a repeated one', async () => {
    const run = await waitingRun('approve: Ship it?');
    expect(await refusal(answerFromDashboard(run.config, { run: run.id, step: 'ship', pass: 2, choice: 'yes' })))
      .toEqual({ status: 409, message: expect.stringContaining('pass 2 was answered or replaced') });
    await answerFromDashboard(run.config, { run: run.id, step: 'ship', pass: 1, choice: 'no' });
    expect(await refusal(answerFromDashboard(run.config, { run: run.id, step: 'ship', pass: 1, choice: 'yes' })))
      .toMatchObject({ status: 409 });
  });

  it('refuses an answer without the pass it answers, or with a choice the request does not offer', async () => {
    const run = await waitingRun('approve: Ship it?');
    expect(await refusal(answerFromDashboard(run.config, { run: run.id, step: 'ship', choice: 'yes' }))).toMatchObject({ status: 400 });
    expect(await refusal(answerFromDashboard(run.config, { run: run.id, step: 'ship', pass: 1, choice: 'maybe' })))
      .toEqual({ status: 400, message: expect.stringContaining('yes, no') });
  });

  describe('team-reported history', () => {
    function publish(config: LocalConfig, record: Record<string, unknown>): void {
      const dir = path.join(getReportsDir(config), 'workflows/runs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${String(record.run)}.json`), JSON.stringify(record));
    }
    const record = (run: string, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 'v1alpha1', run, workflow: 'ship', sourceHash: 'a'.repeat(64), phase: 'end', driver: { kind: 'local' }, status: 'succeeded',
      startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T10:05:00.000Z', durationMs: 300000, username: 'alice', publishedAt: '2026-10-01T10:05:01.000Z',
      steps: [{ step: 'build', pass: 1, outcome: 'success', tokens: { input: 10, output: 5 } }, { step: 'skip-me', pass: 1 }],
      stepCounts: { total: 2, succeeded: 1, failed: 0, skipped: 1, cancelled: 0 }, ...extra,
    });

    it('reads a record without a team revision and keeps its source hash', async () => {
      const config = scope('http');
      publish(config, record('r0000000000000001'));
      const [row] = await listReportedRuns(config);
      expect(row).toMatchObject({ source: 'reported', run: 'r0000000000000001', username: 'alice', sourceHash: 'a'.repeat(64), tokens: 15, prs: [], durationMs: 300000 });
      expect(row).not.toHaveProperty('teamRevision');
      expect((await workflowRunDetail(config, 'reported', 'r0000000000000001'))?.steps.map((step) => [step.step, step.status]))
        .toEqual([['build', 'succeeded'], ['skip-me', 'skipped']]);
    });

    it('lists every delivered pull request of a record, newest run first, and only web links', async () => {
      const config = scope('http');
      const prs = ['https://github.com/team/app/pull/1', 'https://github.com/team/app/pull/2', 'https://github.com/team/lib/pull/3'];
      publish(config, record('r0000000000000002', { prs: [...prs, 'javascript:alert(1)'], teamRevision: 'b'.repeat(40), startedAt: '2026-10-02T10:00:00.000Z' }));
      publish(config, record('r0000000000000001'));
      const rows = await listReportedRuns(config);
      expect(rows.map((row) => row.run)).toEqual(['r0000000000000002', 'r0000000000000001']);
      expect(rows[0]).toMatchObject({ prs, teamRevision: 'b'.repeat(40) });
    });

    it('carries no field a record holds outside what the page reads, and skips a record it cannot read', async () => {
      const config = scope('http');
      publish(config, record('r0000000000000001', { inputs: { ticket: 'TICKET-SECRET-42' }, workspace: '/private/work' }));
      publish(config, { run: 'r0000000000000003', workflow: 'broken' });
      const rows = await listReportedRuns(config);
      expect(rows.map((row) => row.run)).toEqual(['r0000000000000001']);
      expect(JSON.stringify(rows)).not.toMatch(/TICKET-SECRET-42|private\/work|publishedAt/);
    });

    it('reads no run from another repository\'s reports checkout left at this scope\'s path', async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-foreign-')));
      roots.push(root);
      const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.co', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.co' } });
      const business = path.join(root, 'business');
      const previous = path.join(root, 'previous-team');
      for (const dir of [business, previous]) {
        fs.mkdirSync(dir);
        git(dir, ['init', '-q']);
        git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
      }
      const config: LocalConfig = { repo: { kind: 'self', localPath: path.join(business, '.teamai'), businessRepoRoot: business, remote: 'local' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: business, dataHome: path.join(root, 'data') };
      git(previous, ['worktree', 'add', '-q', '-b', 'teamai-reports', getReportsDir(config)]);
      publish(config, record('r0000000000000001'));
      await expect(listReportedRuns(config)).rejects.toMatchObject({ name: 'ForeignCheckoutError' });
      await expect(workflowRunDetail(config, 'reported', 'r0000000000000001')).rejects.toMatchObject({ name: 'ForeignCheckoutError' });
    });
  });
});

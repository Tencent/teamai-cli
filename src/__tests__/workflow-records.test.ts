import { JUDGE_FAILURES } from '../scorers/attempts.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import * as reportsBranch from '../utils/reports-branch.js';
import { readRecordedAgent } from '../agent-observation.js';
import { getDataHome, type LocalConfig, type UserStats } from '../types.js';
import {
  buildEndRecord,
  buildStartRecord,
  enqueueRecord,
  mergeRecord,
  mergeWorkflowStats,
  pendingRecords,
  publishPendingRecords,
  recordPath,
  type WorkflowRunRecord,
} from '../workflow/records.js';
import { acquireLock, releaseLock } from '../update.js';
import { generateRunId, isRunId, runLockPath } from '../workflow/store.js';
import { PrUrlSchema } from '../workflow/pr-url.js';
import type { DriverIdentity, RunState, WorkflowDefinition, WorkflowDiagnostic } from '../workflow/types.js';

const dirs: string[] = [];

function testConfig(): { config: LocalConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-records-'));
  dirs.push(root);
  return {
    config: {
      repo: { localPath: path.join(root, 'knowledge'), remote: 'local', kind: 'self' },
      username: 'tester',
      scope: 'project',
      additionalRoles: [],
      projectRoot: root,
      dataHome: path.join(root, 'data'),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const definition: WorkflowDefinition = {
  schemaVersion: 'v1alpha1',
  name: 'build',
  description: 'Two commands.',
  steps: [
    { id: 'one', command: 'node one.js' },
    { id: 'two', command: 'node two.js' },
  ],
};

const driver: DriverIdentity = {
  kind: 'local',
  machine: 'host-a',
  // A local workspace path — banned from records (#1083).
  workspace: '/Users/secret/work',
};

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 'v1alpha1',
    id: 'r1234567890abcdef',
    name: 'build',
    revision: 3,
    status: 'succeeded',
    sourceHash: 'abc',
    definition,
    steps: [
      { id: 'one', status: 'succeeded', attempt: 'a1', settledAt: 2, outcome: 'success', exitCode: 0 },
      { id: 'two', status: 'succeeded', attempt: 'a2', settledAt: 3, outcome: 'success', exitCode: 0 },
    ],
    settledAttempts: ['a1', 'a2', 'a1'],
    createdAt: '2026-10-14T10:00:00.000Z',
    updatedAt: '2026-10-14T10:02:30.000Z',
    ...overrides,
  };
}

/** A settled run of a for_each over `items` items, each of which runs an inline workflow with a reviewer prompt. */
function settledFan(items: number): RunState {
  const done = { status: 'succeeded', outcome: 'success', settledAt: 2 } as const;
  return runState({
    definition: {
      ...definition,
      steps: [
        {
          id: 'build',
          forEach: { items: 'inputs.xs' },
          workflow: { steps: [
            { id: 'compile', command: 'node compile.js' },
            { id: 'review', needs: ['compile'], prompt: 'Review it.', agent: 'reviewer' },
          ] },
        },
        { id: 'after', needs: ['build'], command: 'node after.js' },
      ],
    },
    steps: [
      { id: 'build', ...done },
      ...Array.from({ length: items }, (_, index) => [
        { id: `build[${index}]`, item: index, ...done },
        { id: `build[${index}].compile`, ...done },
        { id: `build[${index}].review`, ...done },
      ]).flat(),
      { id: 'after', ...done },
    ],
  });
}

describe('#1083 workflow run records', () => {
  it('builds a start record with exactly the allowlisted fields', () => {
    const teamRevision = '0123456789abcdef0123456789abcdef01234567';
    const record = buildStartRecord(runState({ status: 'running', teamRevision }), driver, 'tester');
    expect(record.schemaVersion).toBe('v1alpha1');
    expect(record.run).toBe('r1234567890abcdef');
    expect(record.workflow).toBe('build');
    expect(record.phase).toBe('start');
    expect(record.sourceHash).toBe('abc');
    expect(record.teamRevision).toBe(teamRevision);
    // Kind only: the hostname is machine-identifying and is not published.
    expect(record.driver).toEqual({ kind: 'local' });
    expect(record.status).toBe('running');
    expect(record.username).toBe('tester');
    expect(typeof record.startedAt).toBe('string');
    expect(record.endedAt).toBeUndefined();
    // No banned fields exist in the shape at all.
    expect(record).not.toHaveProperty('prompt');
    expect(record).not.toHaveProperty('outputs');
    expect(record).not.toHaveProperty('workspace');
  });

  it('reads and merges queued records published before and after source provenance', async () => {
    const { config } = testConfig();
    const teamRevision = '0123456789abcdef0123456789abcdef01234567';
    const current = buildEndRecord(runState({ teamRevision }), driver, 'tester');
    const legacy: WorkflowRunRecord = {
      schemaVersion: 'v1alpha1',
      run: current.run,
      workflow: current.workflow,
      phase: 'start',
      status: 'running',
      startedAt: current.startedAt,
      username: current.username,
      publishedAt: current.publishedAt,
    };
    const queue = path.join(getDataHome(config), 'workflows', 'pending');
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, `${legacy.run}.${legacy.phase}.json`), JSON.stringify(legacy));

    const [parsed] = await pendingRecords(config);

    expect(parsed).toBeDefined();
    expect(parsed?.run).toBe(legacy.run);
    expect(parsed?.sourceHash).toBeUndefined();
    expect(parsed?.teamRevision).toBeUndefined();
    expect(current.sourceHash).toBe('abc');
    expect(current.teamRevision).toBe(teamRevision);
    expect(mergeRecord(parsed!, current)).toMatchObject({
      sourceHash: 'abc',
      teamRevision,
      phase: 'end',
    });
  });

  it('structurally redacts: prompts, outputs, and local paths cannot leak', () => {
    const juicy = runState({
      steps: [
        {
          id: 'one',
          status: 'failed',
          attempt: 'a1',
          settledAt: 2,
          outcome: 'failed',
          exitCode: 1,
          // Step state may carry failure text quoting the command and paths.
          message: 'SECRET PROMPT /Users/secret/work/plan.md leaked output diff',
          outputs: { secret: 'PROMPT LEAK /Users/secret/work' },
        },
      ],
    });
    for (const record of [buildStartRecord(juicy, driver, 'tester'), buildEndRecord(juicy, driver, 'tester')]) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('SECRET PROMPT');
      expect(serialized).not.toContain('PROMPT LEAK');
      expect(serialized).not.toContain('/Users/secret/work');
      expect(serialized).not.toContain('node one.js');
    }
  });

  it('publishes the failure code of a run only when teamai sets it', () => {
    const failed = (code: string): RunState => runState({ status: 'failed', failure: { code, message: `the ${code} message` } });

    expect(buildEndRecord(failed('loop_exhausted'), driver, 'tester').failure).toEqual({ code: 'loop_exhausted' });
    expect(JSON.stringify(buildEndRecord(failed('secret-x'), driver, 'tester'))).not.toContain('secret-x');
  });

  it('publishes the failure code of every step failure teamai writes, and only codes it can name', () => {
    // Codes a module writes, as `code: '…'`, `error('…', …)` or `failure('…', …)`, that never become a run's failure: every module of src/workflow and src/scorers, and every other one that imports src/scorers or answers a WorkflowEnvelope.
    const diagnostics = ['unknown_key', 'missing_needs', 'false_if', 'bad_template', 'dotted_name', 'undeclared_output', 'undeclared_end', 'bad_loop', 'bad_workspace', 'workflow_namespace_conflict', 'prompt_namespace_conflict', 'bad_delivery', 'bad_invoke', 'bad_alias', 'alias_conflict'] satisfies Array<WorkflowDiagnostic['code']>;
    const answers = ['invalid_json', 'driver_running', 'invalid_run', 'repeated_response', 'agent_in_path', 'stale_response', 'retried', 'end_reached', 'repeated_report', 'wrong_attempt', 'invalid_report', 'lease_cancelled', 'interrupted', 'run_unreadable', 'driver_stuck', 'ambiguous_run', 'busy', 'workflow_recursion', 'workflow_not_found',
      // Refusals of a run handover, answered to the command or driver that asked for it.
      'not_owner', 'unsupported_repo', 'reports_unreachable', 'reports_failed', 'run_not_found', 'run_not_published', 'run_mismatch',
      'state_conflict', 'state_moved', 'definition_mismatch', 'records_pending', 'snapshot_unsupported', 'secret_detected', 'local_path_detected', 'origin_unavailable', 'commit_missing',
      'branch_diverged', 'sessions_not_archived', 'judge_lease',
      // Refusals of a driver's or member's request about a run that is already past it.
      'stale_revision', 'wrong_driver', 'run_settled', 'step_not_found', 'not_hitl', 'not_waiting', 'invalid_choice', 'not_cancellable', 'not_retryable',
      // Refusals of a judge submit, answered to the driver; the lease and the run stay as they were.
      'lease_unknown', 'lease_settled', 'lease_judging', 'entry_closed', 'label_invalid', 'isolation_unmet', 'scoring_settings_invalid',
      // Work the driver's judge tools cannot run the scorer's model for; it stays open for another driver.
      'judge_model_unavailable',
      // Refusals of a teamai score or teamai workflow command line before it reads any run or judge work.
      'invalid_arguments', 'invalid_pass', 'not_initialized', 'unsupported_driver', 'invalid_tools',
      // Refusals of teamai workflow start for a run whose pull requests would have no branch to target.
      'no_base_branch',
      // Refusals of a start from an agent session that the workflow's invoke does not let start it.
      'invoke_denied',
      // Refusals of an agent's start of an invoke: ask workflow in an unattended run, where no person can agree.
      'unattended_denied',
      // Refusals of a workflow command from inside a workflow attempt, or of a start from a workflow's place.
      'nested_workflow',
      // A place the host made that a prepare cannot adopt; the attempt stays leased.
      'adopt_mismatch',
      // Refusals of a --driver skill call, answered to the agent with the command it can run instead.
      'confirm_needed', 'needs_local_driver', 'not_skill_run', 'orchestrator_active', 'choice_pending', 'unknown_choice', 'unknown_offer', 'unknown_attempt', 'not_dispatched', 'tool_needed',
      // An error thrown inside a --driver skill call, answered to the agent as one envelope with its message.
      'skill_call_failed',
      // Why the skill driver stopped judging a run, told to the agent in a judging-off event.
      'judge_runner_gone', 'no_child_agent',
      // Refusals of teamai score --run, answered to the member who asked for a pass to be judged.
      'scoring_unavailable', 'pass_not_found', 'scorer_not_found', 'entry_leased',
      // Refusals of teamai score --session, answered to the member who asked for a session to be judged.
      'session_required', 'source_required', 'session_not_found', 'session_ambiguous', 'scorer_invalid',
      // Why a judge attempt closed: kept with the attempt under scores/, never on a run.
      ...JUDGE_FAILURES];
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = fs.readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.startsWith('__tests__'))
      .map((file) => ({ file, text: fs.readFileSync(path.join(src, file), 'utf8') }))
      .filter(({ file, text }) => /^(workflow|scorers)\//.test(file) || /from '(?:\.\.?\/)+scorers\//.test(text) || /\bWorkflowEnvelope\b/.test(text));
    const written = new Set(files.flatMap(({ text }) => [
      ...[...text.matchAll(/\bcode: ('[^']+'(?:\s*\|\s*'[^']+')*)/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/'([^']+)'/g)].flatMap((code) => code[1] ?? [])),
      ...[...text.matchAll(/(?<![.\w]|function )(?:error|failure)\('([^']+)'/g)].flatMap((match) => match[1] ?? []),
    ]));
    // An `error(…)` whose code is not a literal passes on a code written as a literal elsewhere; each one is named here.
    const passedOn = ['session-flow/scoring.ts: result.code', 'workflow/engine.ts: tree.failed.code', 'workflow/engine.ts: undeliverable.code', 'workflow/scoring.ts: built.code', 'workflow/scoring.ts: result.code'];
    const unnamed = files.flatMap(({ file, text }) => [...text.matchAll(/(?<![.\w]|function )(?:error|failure)\((?!')([^,)]+)/g)].map((match) => `${file}: ${match[1]}`)).sort();
    const failedWith = (code: string): RunState => runState({
      status: 'failed',
      steps: [{ id: 'one', status: 'failed', outcome: 'failed', attempt: 'a1', settledAt: 2, failure: { code, message: 'm' } }],
    });

    expect(unnamed).toEqual(passedOn);
    expect([...diagnostics, ...answers].filter((code) => !written.has(code) && !JUDGE_FAILURES.some((failure) => failure === code))).toEqual([]);
    expect([...written].filter((code) => ![...diagnostics, ...answers].includes(code) && buildEndRecord(failedWith(code), driver, 'tester').failure?.code !== code)).toEqual([]);
  });

  it('publishes the first failure teamai can name, under a top-level step whose own code it cannot', () => {
    const run = runState({
      status: 'failed',
      definition: { ...definition, steps: [{ id: 'build', workflow: { steps: [{ id: 'compile', command: 'node compile.js' }] } }] },
      steps: [
        { id: 'build', status: 'failed', outcome: 'failed', settledAt: 3, failure: { code: 'my secret code', message: 'm' } },
        { id: 'build.compile', status: 'failed', outcome: 'failed', attempt: 'a1', settledAt: 2, failure: { code: 'tool_failed', message: 'm' } },
      ],
    });

    expect(buildEndRecord(run, driver, 'tester').failure).toEqual({ code: 'tool_failed' });
  });

  it('builds an end record with outcome, duration, iterations, and step counts', () => {
    const record = buildEndRecord(runState(), driver, 'tester');
    expect(record.phase).toBe('end');
    expect(record.status).toBe('succeeded');
    expect(record.durationMs).toBe(150000);
    expect(record.iterations).toBe(3);
    expect(record.stepCounts).toEqual({ total: 2, succeeded: 2, failed: 0, skipped: 0, cancelled: 0 });
    expect(record.steps).toEqual([
      { step: 'one', pass: 1, outcome: 'success' },
      { step: 'two', pass: 1, outcome: 'success' },
    ]);
    expect(record.endedAt).toBe('2026-10-14T10:02:30.000Z');
  });

  it('gives the entry of a step that ran once pass 1, as its lease did', () => {
    expect(buildEndRecord(runState(), driver, 'tester').steps?.map((entry) => entry.pass)).toEqual([1, 1]);
  });

  it('records per-step agent fields: a Codex implementer beside a Claude reviewer', () => {
    // SaulMoro's P1: run-level tool/model cannot express a mixed-agent run.
    const mixed = runState({
      definition: {
        ...definition,
        steps: [
          { id: 'one', command: 'node one.js', agent: 'implementer' },
          { id: 'two', command: 'node two.js', agent: 'reviewer' },
        ],
      },
      steps: [
        { id: 'one', status: 'succeeded', attempt: 'a1', settledAt: 2, outcome: 'success', exitCode: 0, tool: 'codex', model: 'gpt-5.4-codex', tokens: { input: 100, output: 50 } },
        { id: 'two', status: 'succeeded', attempt: 'a2', settledAt: 3, outcome: 'success', exitCode: 0, tool: 'claude', model: 'claude-sonnet-4.6' },
      ],
    });
    const record = buildEndRecord(mixed, driver, 'tester');
    expect(record.steps).toEqual([
      { step: 'one', pass: 1, agent: { definition: { name: 'implementer' } }, tool: 'codex', model: 'gpt-5.4-codex', outcome: 'success', tokens: { input: 100, output: 50 } },
      { step: 'two', pass: 1, agent: { definition: { name: 'reviewer' } }, tool: 'claude', model: 'claude-sonnet-4.6', outcome: 'success' },
    ]);
  });

  it.each([
    ['a local tool and a model name', 'claude-internal', 'anthropic/claude-sonnet-4.6@2026', { tool: 'claude-internal', model: 'anthropic/claude-sonnet-4.6@2026' }],
    ['a secret as the tool', 'sk-ant-SECRET-token', 'gpt-5.4-codex', { model: 'gpt-5.4-codex' }],
    ['an absolute path as the model', 'codex', '/Users/me/private/model', { tool: 'codex' }],
    ['a relative path that climbs as the model', 'codex', 'models/../../home/me', { tool: 'codex' }],
    ['a Windows absolute path as the model', 'codex', 'C:/Users/alice/private/model.gguf', { tool: 'codex' }],
    ['a file URL as the model', 'codex', 'file:/Users/me/private/model', { tool: 'codex' }],
    ['a tagged model name', 'codex', 'ollama:llama3.1:8b', { tool: 'codex', model: 'ollama:llama3.1:8b' }],
    ['a model with a space', 'codex', 'my private model', { tool: 'codex' }],
    ['a model longer than 80 characters', 'codex', `m${'x'.repeat(80)}`, { tool: 'codex' }],
  ])('records the tool and model of a report with %s only when they are a local tool name and a model name', (_case, tool, model, fields) => {
    const run = runState({
      definition: { ...definition, steps: [{ id: 'one', command: 'node one.js' }] },
      steps: [{ id: 'one', status: 'succeeded', attempt: 'a1', settledAt: 2, outcome: 'success', exitCode: 0, tool, model }],
    });

    expect(buildEndRecord(run, driver, 'tester').steps).toEqual([{ step: 'one', pass: 1, ...fields, outcome: 'success' }]);
  });

  it('builds the end record of a for_each with work linear in the item count', () => {
    // Every lookup over the run's step instances reads each one's path, so the number of `id` reads counts how many it looks at.
    const work = (items: number): number => {
      let read = 0;
      const run = settledFan(items);
      run.steps = run.steps.map((state) => new Proxy(state, {
        get: (target, key, receiver) => {
          if (key === 'id') read += 1;
          return Reflect.get(target, key, receiver);
        },
      }));
      expect(buildEndRecord(run, driver, 'tester').steps?.filter((entry) => entry.agent?.definition?.name === 'reviewer')).toHaveLength(items);
      return read;
    };
    const small = work(100);
    const large = work(200);
    expect(small).toBeGreaterThan(100);
    // Linear work doubles with the items; a scan of every instance per entry grows about four times.
    expect(large / small).toBeLessThan(3);
  });

  it('reports the cumulative iteration count, not the bounded history length', () => {
    // settledAttempts is a 32-entry dedup history; a run with 40 settled
    // attempts still has 32 entries. The record must say 40.
    const bounded = runState({ settledCount: 40 });
    const record = buildEndRecord(bounded, driver, 'tester');
    expect(record.iterations).toBe(40);
    // A run from before the counter exists falls back to the history length.
    const legacy = buildEndRecord(runState(), driver, 'tester');
    expect(legacy.iterations).toBe(3);
  });

  it('seeds the required stats shape so digest never skips workflow-only stats', async () => {
    const { ensureStatsShape } = await import('../workflow/records.js');
    // digest's loadTeamStats requires username AND skills; a first workflow
    // run with no prior stats file must still produce a digest-visible file.
    const seeded = ensureStatsShape({}, 'tester');
    expect(seeded.username).toBe('tester');
    expect(seeded.skills).toEqual({});
    expect(typeof seeded.updatedAt).toBe('string');
    // An existing stats file keeps its shape untouched.
    const existing = { username: 'tester', skills: { review: { count: 5 } }, updatedAt: 'x' };
    expect(ensureStatsShape(existing, 'tester')).toBe(existing);
  });

  it('merges a record published with a string agent, which reads as its definition (#1176)', () => {
    const published = JSON.parse(JSON.stringify({
      ...buildEndRecord(runState(), driver, 'tester'),
      steps: [{ step: 'one', pass: 1, agent: 'implementer', tool: 'codex', outcome: 'success' }],
    })) as WorkflowRunRecord;
    const observed = { v: 1, tool: { name: 'codex' }, teamai: '0.23.0', driver: 'local' } as const;
    const next = buildEndRecord(runState({
      steps: [{ id: 'one', status: 'succeeded', attempt: 'a1', settledAt: 2, outcome: 'success', tool: 'codex', agent: observed }],
    }), driver, 'tester');

    expect(readRecordedAgent(published.steps?.[0]?.agent)).toEqual({ definition: { name: 'implementer' } });
    expect(mergeRecord(published, next).steps).toEqual([{ step: 'one', pass: 1, agent: observed, tool: 'codex', outcome: 'success' }]);
  });

  it('merges retry-safe: end wins, a late start retry cannot regress phase', () => {
    const start = buildStartRecord(runState({ status: 'running' }), driver, 'tester');
    const end = buildEndRecord(runState(), driver, 'tester');
    // Normal order: origin holds start, end overlays it.
    const merged = mergeRecord(start, end);
    expect(merged.phase).toBe('end');
    expect(merged.status).toBe('succeeded');
    expect(merged.startedAt).toBe(start.startedAt);
    // Retry order: origin already holds the end record, a queued start
    // re-arrives (e.g. both phases queued before a crash). It must not
    // resurrect a started-but-not-ended view.
    const remerged = mergeRecord(end, start);
    expect(remerged.phase).toBe('end');
    expect(remerged.status).toBe('succeeded');
    expect(remerged.endedAt).toBe(end.endedAt);
  });

  it('lists the pull requests delivered on the run in the order they first appeared, and never a step output', () => {
    const pr = (n: number): string => `https://github.com/acme/app/pull/${n}`;
    const receipt = (n: number, step: string, pass: number) => ({ url: PrUrlSchema.parse(pr(n)), branch: `teamai/r1234567890abcdef/${step}/p${pass}`, base: 'main', step, pass });
    const run = runState({
      steps: [
        { id: 'one', status: 'succeeded', attempt: 'a1', settledAt: 2, outcome: 'success', outputs: { pr_url: 'https://untrusted.example/1' } },
        { id: 'two', status: 'succeeded', attempt: 'a2', settledAt: 3, outcome: 'success' },
      ],
      deliveries: [receipt(3, 'two', 1), receipt(1, 'loop.write', 1), receipt(2, 'one', 1)],
    });

    expect(buildEndRecord(run, driver, 'tester').prs).toEqual([pr(3), pr(1), pr(2)]);
    expect(buildEndRecord(runState(), driver, 'tester')).not.toHaveProperty('prs');
  });

  it('gives each pass what it delivered: the commits on its branch, its own pull request, and what its commands reported (#1387)', () => {
    const sha = (digit: string): string => digit.repeat(40);
    const pr = (n: number): string => `https://github.com/acme/app/pull/${n}`;
    const receipt = (n: number, step: string, pass: number) => ({ url: PrUrlSchema.parse(pr(n)), branch: `teamai/r1234567890abcdef/${step}/p${pass}`, base: 'main', step, pass });
    const run = runState({
      steps: [
        {
          id: 'one', status: 'succeeded', attempt: 'a1', settledAt: 2, outcome: 'success',
          changes: { branch: 'teamai/r1234567890abcdef/one/p1', base: 'main', from: sha('0'), to: sha('b'), commits: [sha('a'), sha('b')] },
        },
        { id: 'two', status: 'succeeded', attempt: 'a2', settledAt: 3, outcome: 'success', outcomes: [{ kind: 'learning', id: 'retry-backoff-2026-10-24-p0x1za' }] },
      ],
      deliveries: [receipt(43, 'one', 1), receipt(44, 'one', 2)],
    });

    expect(buildEndRecord(run, driver, 'tester').steps).toEqual([
      expect.objectContaining({ step: 'one', pass: 1, outcomes: [{ kind: 'commit', sha: sha('a') }, { kind: 'commit', sha: sha('b') }, { kind: 'pr', url: pr(43) }] }),
      expect.objectContaining({ step: 'two', pass: 1, outcomes: [{ kind: 'learning', id: 'retry-backoff-2026-10-24-p0x1za' }] }),
    ]);
    expect(buildEndRecord(runState(), driver, 'tester').steps?.[0]).not.toHaveProperty('outcomes');
  });

  it('drops the prs of an earlier end when a retried run ends again without them', () => {
    const delivered = { ...buildEndRecord(runState(), driver, 'tester'), prs: ['https://github.com/acme/app/pull/1'] };
    const again = buildEndRecord(runState(), driver, 'tester');

    expect(mergeRecord(delivered, again)).not.toHaveProperty('prs');
    expect(mergeRecord(again, delivered).prs).toEqual(['https://github.com/acme/app/pull/1']);
  });

  it('queues records durably and keeps them across failure', async () => {
    const { config } = testConfig();
    const record = buildStartRecord(runState({ status: 'running' }), driver, 'tester');
    await enqueueRecord(config, record, {});
    const pending = await pendingRecords(config);
    expect(pending).toHaveLength(1);
    expect(pending[0].run).toBe(record.run);
    // The queue lives under the data home, so it survives process restart.
    const queueDir = path.join(config.dataHome!, 'workflows', 'pending');
    expect(fs.existsSync(path.join(queueDir, `${record.run}.start.json`))).toBe(true);
  });

  it('names record files by run id under workflows/runs', () => {
    expect(recordPath('r1234567890abcdef')).toBe('workflows/runs/r1234567890abcdef.json');
  });

  it('generates 16-hex run ids and still accepts the legacy 8-hex form', () => {
    const id = generateRunId();
    expect(id).toMatch(/^r[0-9a-f]{16}$/);
    expect(isRunId(id)).toBe(true);
    // SaulMoro: records are a team-wide key — the old 8-hex form must keep
    // resolving (regex still accepts it).
    expect(isRunId('r12345678')).toBe(true);
    expect(isRunId('r1234567')).toBe(false);
    expect(isRunId('r1234567890abcde')).toBe(false);
  });
});

/** A team repo clone with a bare origin to publish reports to, drained by `username`. */
async function reportsRemote(username: string): Promise<{ config: LocalConfig; origin: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-drain-'));
  dirs.push(root);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  await seedGit.add(['.']);
  await seedGit.commit('init');
  const origin = path.join(root, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const clone = path.join(root, 'team-repo');
  await simpleGit().clone(origin, clone);
  await simpleGit(clone).addConfig('user.email', 't@t.com');
  await simpleGit(clone).addConfig('user.name', 't');
  const config: LocalConfig = {
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username,
    scope: 'user',
    additionalRoles: [],
    dataHome: path.join(root, 'data'),
  };
  return { config, origin };
}

// Stats merge: workflow totals land in the user's stats file additively,
// preserving every unrelated field (the #1056 preservation discipline).
describe('#1083 workflow stats merge', () => {
  it('counts end records once per run, additively, preserving unrelated fields', async () => {
    const { mergeWorkflowStats } = await import('../workflow/records.js');
    const existing = {
      username: 'tester',
      updatedAt: '2026-10-13T00:00:00.000Z',
      skills: [{ skill: 'review', count: 5 }],
      prompts: { 20261012: 4 },
      tokens: { 20261012: 4000 },
      daily: { 20261012: { sessions: 2 } },
    };
    const start = buildStartRecord(runState({ status: 'running' }), driver, 'tester');
    const end = buildEndRecord(runState(), driver, 'tester');
    const merged = mergeWorkflowStats(existing, 'tester', [start, end]);
    expect(merged.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 150000 });
    // Unrelated fields untouched.
    expect(merged.skills).toEqual(existing.skills);
    expect(merged.prompts).toEqual(existing.prompts);
    expect(merged.tokens).toEqual(existing.tokens);
    expect(merged.daily).toEqual(existing.daily);
    expect(merged.username).toBe('tester');
    // Additive: another run's end record adds on top.
    const end2 = buildEndRecord(runState({ id: 'rfedcba0987654321' }), driver, 'tester');
    const merged2 = mergeWorkflowStats(merged, 'tester', [end2]);
    expect(merged2.workflows).toEqual({ runs: 2, succeeded: 2, failed: 0, totalDurationMs: 300000 });
  });

  it('does not recount a run whose end phase origin already holds', async () => {
    const { statsDeltaRecords } = await import('../workflow/records.js');
    const end = buildEndRecord(runState(), driver, 'tester');
    // First delivery: origin holds nothing for the run → counted.
    const first = statsDeltaRecords(new Map([['r1234567890abcdef', null]]), [end]);
    expect(first).toEqual([end]);
    // Queue replay after the first delivery landed: origin holds the end
    // phase → the same record is not recounted.
    const replay = statsDeltaRecords(new Map([['r1234567890abcdef', end]]), [end]);
    expect(replay).toEqual([]);
    // A start-phase record never contributes totals.
    const start = buildStartRecord(runState({ status: 'running' }), driver, 'tester');
    const startOnly = statsDeltaRecords(new Map([['r1234567890abcdef', null]]), [start]);
    expect(startOnly).toEqual([]);
  });

  it('keeps workflow totals through a later usage report', async () => {
    const { mergeWorkflowStats } = await import('../workflow/records.js');
    const { mergeStatsWithinTeamSkills } = await import('../team-push.js');
    const published = mergeWorkflowStats(
      { username: 'tester', updatedAt: '2026-10-13T00:00:00.000Z', skills: {} },
      'tester',
      [buildEndRecord(runState(), driver, 'tester')],
    );
    const onDisk = YAML.parse(YAML.stringify(published)) as UserStats;
    const reported = mergeStatsWithinTeamSkills(onDisk, 'tester', [], new Set());
    expect(reported.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 150000 });
  });

  it('folds a queued record into the stats file of the member who ran it', async () => {
    // The queue outlives a username change: alice ran the workflow, bob drains it.
    const { config, origin } = await reportsRemote('bob');
    await enqueueRecord(config, buildEndRecord(runState(), driver, 'alice'), {});

    expect(await publishPendingRecords(config)).toEqual({ state: 'published' });

    const reports = simpleGit(origin);
    const stats = YAML.parse(await reports.show(['teamai-reports:stats/alice.yaml'])) as Record<string, unknown>;
    expect(stats.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 150000 });
    expect(await reports.raw(['ls-tree', '--name-only', 'teamai-reports', 'stats/'])).toBe('stats/alice.yaml\n');
  });

  it('moves a run out of the stats of the member whose end another member replaced', async () => {
    const { config, origin } = await reportsRemote('bob');
    await enqueueRecord(config, buildEndRecord(runState({ status: 'failed' }), driver, 'alice'), {});
    expect(await publishPendingRecords(config)).toEqual({ state: 'published' });
    await enqueueRecord(config, buildEndRecord(runState({ updatedAt: '2026-10-14T10:05:00.000Z' }), driver, 'bob'), {});

    expect(await publishPendingRecords(config)).toEqual({ state: 'published' });

    const reports = simpleGit(origin);
    const workflows = async (username: string): Promise<unknown> =>
      (YAML.parse(await reports.show([`teamai-reports:stats/${username}.yaml`])) as Record<string, unknown>).workflows;
    expect(await workflows('alice')).toEqual({ runs: 0, succeeded: 0, failed: 0, totalDurationMs: 0 });
    expect(await workflows('bob')).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 300000 });
  });
});


describe('manual control records', () => {
  it.each(['tty', 'driver'] as const)('publishes only choice, channel, and agent from current and archived %s answers', (channel) => {
    const answer = { choice: 'yes', note: 'PRIVATE NOTE', at: 'PRIVATE TIME', channel, agent: false, ...(channel === 'driver' ? { driver: { kind: 'ide', machine: 'PRIVATE HOST', workspace: 'PRIVATE WORKSPACE' } } : {}) };
    const run = runState({ status: 'failed', steps: [{ id: 'one', status: 'cancelled', settledAt: 2, failure: { code: 'cancelled', message: 'private failure' }, answer, pass: 2,
      passes: [{ pass: 1, outcome: 'failed', answer: { ...answer, choice: 'no' } }] }], archive: [{ step: 'one.child', pass: 1, outcome: 'success', answer }] });
    const record = buildEndRecord(run, driver, 'tester');
    expect(record.failure).toEqual({ code: 'cancelled' });
    expect(record.steps?.map((step) => step.answer)).toEqual([
      { choice: 'no', channel, agent: false }, { choice: 'yes', channel, agent: false }, { choice: 'yes', channel, agent: false },
    ]);
    expect(JSON.stringify(record)).not.toContain('PRIVATE');
  });

  it('counts a cancelled run without counting success or failure', () => {
    const record = buildEndRecord(runState({ status: 'cancelled' }), driver, 'tester');
    expect(record.status).toBe('cancelled');
    expect(record.failure).toBeUndefined();
    expect(mergeWorkflowStats({}, 'tester', [record]).workflows).toEqual({ runs: 1, succeeded: 0, failed: 0, totalDurationMs: 150000 });
  });
});


it('replaces a published failed end after retry without keeping its old end or failure', () => {
  const failed = buildEndRecord(runState({ status: 'failed', failure: { code: 'cancelled', message: 'Cancelled' } }), driver, 'tester');
  const succeeded = buildEndRecord(runState(), driver, 'tester');
  expect(mergeRecord(failed, succeeded).failure).toBeUndefined();
  expect(mergeRecord({ ...failed, end: 'aborted' }, succeeded).end).toBeUndefined();
  expect(mergeRecord(failed, succeeded).run).toBe(failed.run);
});


it.each(['failed', 'cancelled'] as const)('replaces a published %s end contribution after retry succeeds', async (status) => {
  const { statsDeltaRecords } = await import('../workflow/records.js');
  const old = buildEndRecord(runState({ status }), driver, 'tester');
  const replacement = buildEndRecord(runState({ updatedAt: '2026-10-14T10:05:00.000Z' }), driver, 'tester');
  const existing = mergeWorkflowStats({}, 'tester', [old]);
  const origin = new Map([[old.run, old]]);
  const updated = mergeWorkflowStats(existing, 'tester', statsDeltaRecords(origin, [replacement]), origin);
  expect(updated.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 300000 });
  expect(mergeWorkflowStats(updated, 'tester', statsDeltaRecords(new Map([[old.run, replacement]]), [replacement])).workflows).toEqual(updated.workflows);
});


it('replaces a cancelled end without a stored outcome counter', async () => {
  const { statsDeltaRecords } = await import('../workflow/records.js');
  const old = buildEndRecord(runState({ status: 'cancelled' }), driver, 'tester');
  const replacement = buildEndRecord(runState({ updatedAt: '2026-10-14T10:05:00.000Z' }), driver, 'tester');
  const origin = new Map([[old.run, old]]);
  const existing = { workflows: { runs: 1, succeeded: 0, failed: 0, totalDurationMs: 150000 } };
  expect(mergeWorkflowStats(existing, 'tester', statsDeltaRecords(origin, [replacement]), origin).workflows).toEqual({
    runs: 1, succeeded: 1, failed: 0, totalDurationMs: 300000,
  });
});


it('keeps a replacement end queued when an earlier end finishes publishing', async () => {
  const { config } = testConfig();
  const old = buildEndRecord(runState({ status: 'failed' }), driver, 'tester');
  const replacement = buildEndRecord(runState({ updatedAt: '2026-10-14T10:05:00.000Z' }), driver, 'tester');
  await enqueueRecord(config, old, {});
  vi.spyOn(reportsBranch, 'updateReports').mockImplementation(async () => {
    await enqueueRecord(config, replacement, {});
    return { status: 'published' };
  });
  const result = await publishPendingRecords(config);
  expect(await pendingRecords(config)).toEqual([replacement]);
  expect(result).toMatchObject({ state: 'pending' });
});


it('keeps a replacement end queued when its producer starts after the dequeue read', async () => {
  const { config } = testConfig();
  const old = buildEndRecord(runState({ status: 'failed' }), driver, 'tester');
  const replacement = buildEndRecord(runState({ updatedAt: '2026-10-14T10:05:00.000Z' }), driver, 'tester');
  const lock = runLockPath(config, old.run);
  await enqueueRecord(config, old, {});
  let delivered = false;
  vi.spyOn(reportsBranch, 'updateReports').mockImplementation(async () => {
    delivered = true;
    return { status: 'published' };
  });
  const readFile = fsp.readFile.bind(fsp);
  let producer: Promise<void> | undefined;
  vi.spyOn(fsp, 'readFile').mockImplementation(async (...args) => {
    const contents = await readFile(...args);
    if (delivered && !producer && String(args[0]).endsWith(`${old.run}.end.json`)) {
      const held = await acquireLock(lock);
      producer = (async () => {
        if (!held) {
          while (!await acquireLock(lock)) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        try {
          await enqueueRecord(config, replacement, {});
        } finally {
          await releaseLock(lock);
        }
      })();
      if (held) await producer;
    }
    return contents;
  });
  await publishPendingRecords(config);
  expect(producer).toBeDefined();
  await producer;
  expect(await pendingRecords(config)).toEqual([replacement]);
});

it('queues a record with each known secret value masked', async () => {
  const { config } = testConfig();
  const record = buildEndRecord(runState(), driver, 'deploy-secret-value-1082');
  await enqueueRecord(config, record, { DEPLOY_TOKEN: 'deploy-secret-value-1082' });
  expect(await pendingRecords(config)).toEqual([{ ...record, username: '<REDACTED:DEPLOY_TOKEN>' }]);
});

it('leaves a delivered record queued while its run lock is held, then drains it', async () => {
  const { config } = testConfig();
  const record = buildEndRecord(runState(), driver, 'tester');
  await enqueueRecord(config, record, {});
  vi.spyOn(reportsBranch, 'updateReports').mockResolvedValue({ status: 'published' });
  const lock = runLockPath(config, record.run);
  expect(await acquireLock(lock)).toBe(true);
  try {
    expect(await publishPendingRecords(config)).toMatchObject({ state: 'pending' });
    expect(await pendingRecords(config)).toEqual([record]);
  } finally {
    await releaseLock(lock);
  }
  expect(await publishPendingRecords(config)).toEqual({ state: 'published' });
  expect(await pendingRecords(config)).toEqual([]);
});

it.each(['invalid JSON', 'directory'])('leaves a delivered queue path containing %s pending', async (tampering) => {
  const { config } = testConfig();
  const record = buildEndRecord(runState(), driver, 'tester');
  await enqueueRecord(config, record, {});
  const target = path.join(config.dataHome!, 'workflows', 'pending', `${record.run}.end.json`);
  vi.spyOn(reportsBranch, 'updateReports').mockImplementation(async () => {
    if (tampering === 'invalid JSON') fs.writeFileSync(target, '{');
    else {
      fs.rmSync(target);
      fs.mkdirSync(target);
    }
    return { status: 'published' };
  });
  await expect(publishPendingRecords(config)).resolves.toMatchObject({ state: 'pending' });
  expect(fs.existsSync(target)).toBe(true);
});

it('reports published when only another run was queued during delivery', async () => {
  const { config } = testConfig();
  const delivered = buildEndRecord(runState(), driver, 'tester');
  const other = buildStartRecord(runState({ id: 'rabcdef1234567890', status: 'running' }), driver, 'tester');
  await enqueueRecord(config, delivered, {});
  vi.spyOn(reportsBranch, 'updateReports').mockImplementation(async () => {
    await enqueueRecord(config, other, {});
    return { status: 'published' };
  });
  expect(await publishPendingRecords(config)).toEqual({ state: 'published' });
  expect(await pendingRecords(config)).toEqual([other]);
});

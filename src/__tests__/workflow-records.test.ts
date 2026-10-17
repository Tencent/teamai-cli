import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { readRecordedAgent } from '../agent-observation.js';
import type { LocalConfig, UserStats } from '../types.js';
import {
  buildEndRecord,
  buildStartRecord,
  enqueueRecord,
  mergeRecord,
  pendingRecords,
  publishPendingRecords,
  recordPath,
  type WorkflowRunRecord,
} from '../workflow/records.js';
import { generateRunId, isRunId } from '../workflow/store.js';
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
    const record = buildStartRecord(runState({ status: 'running' }), driver, 'tester');
    expect(record.schemaVersion).toBe('v1alpha1');
    expect(record.run).toBe('r1234567890abcdef');
    expect(record.workflow).toBe('build');
    expect(record.phase).toBe('start');
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
    // Codes a `code: '…'` literal in src/workflow writes that never become a run's failure.
    const diagnostics = ['unknown_key', 'missing_needs', 'false_if', 'bad_template', 'dotted_name', 'undeclared_output', 'undeclared_end', 'bad_loop'] satisfies Array<WorkflowDiagnostic['code']>;
    const answers = ['end_reached', 'repeated_report', 'wrong_attempt', 'lease_cancelled', 'interrupted', 'run_unreadable', 'driver_stuck', 'busy'];
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflow');
    const written = new Set(fs.readdirSync(source).filter((file) => file.endsWith('.ts'))
      .flatMap((file) => [...fs.readFileSync(path.join(source, file), 'utf8').matchAll(/code: '([^']+)'/g)].map((match) => match[1]!)));
    const failedWith = (code: string): RunState => runState({
      status: 'failed',
      steps: [{ id: 'one', status: 'failed', outcome: 'failed', attempt: 'a1', settledAt: 2, failure: { code, message: 'm' } }],
    });

    expect([...diagnostics, ...answers].filter((code) => !written.has(code))).toEqual([]);
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

  it('queues records durably and keeps them across failure', async () => {
    const { config } = testConfig();
    const record = buildStartRecord(runState({ status: 'running' }), driver, 'tester');
    await enqueueRecord(config, record);
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
    const merged = mergeWorkflowStats(existing, [start, end]);
    expect(merged.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 150000 });
    // Unrelated fields untouched.
    expect(merged.skills).toEqual(existing.skills);
    expect(merged.prompts).toEqual(existing.prompts);
    expect(merged.tokens).toEqual(existing.tokens);
    expect(merged.daily).toEqual(existing.daily);
    expect(merged.username).toBe('tester');
    // Additive: another run's end record adds on top.
    const end2 = buildEndRecord(runState({ id: 'rfedcba0987654321' }), driver, 'tester');
    const merged2 = mergeWorkflowStats(merged, [end2]);
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
      [buildEndRecord(runState(), driver, 'tester')],
    );
    const onDisk = YAML.parse(YAML.stringify(published)) as UserStats;
    const reported = mergeStatsWithinTeamSkills(onDisk, 'tester', [], new Set());
    expect(reported.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 150000 });
  });

  it('folds a queued record into the stats file of the member who ran it', async () => {
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
    // The queue outlives a username change: alice ran the workflow, bob drains it.
    const config: LocalConfig = {
      repo: { localPath: clone, remote: origin, kind: 'git' },
      username: 'bob',
      scope: 'user',
      additionalRoles: [],
      dataHome: path.join(root, 'data'),
    };
    await enqueueRecord(config, buildEndRecord(runState(), driver, 'alice'));

    expect(await publishPendingRecords(config)).toBe('published');

    const reports = simpleGit(origin);
    const stats = YAML.parse(await reports.show(['teamai-reports:stats/alice.yaml'])) as Record<string, unknown>;
    expect(stats.workflows).toEqual({ runs: 1, succeeded: 1, failed: 0, totalDurationMs: 150000 });
    expect(await reports.raw(['ls-tree', '--name-only', 'teamai-reports', 'stats/'])).toBe('stats/alice.yaml\n');
  });
});

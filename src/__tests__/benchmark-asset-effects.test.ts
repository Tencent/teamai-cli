import { describe, expect, it } from 'vitest';
import type { BenchmarkRecord, TrialResult } from '../benchmark/result.js';
import { assetEffects, benchmarkTable, formatBenchmarkTable, type AssetEffect } from '../benchmark/table.js';

const RUN_TEAM = 't'.repeat(40);
const RUN_START = 'a'.repeat(40);

type TrialSpec = {
  task: string;
  arm: string;
  result?: TrialResult;
  routing?: Record<string, 'fit' | 'idle' | 'extra' | 'missed' | 'unknown'>;
};

/** A record of the migrations example: two tasks that cover the skill and the rule, one that covers neither. */
function migrationsRecord(trials: TrialSpec[], arms?: BenchmarkRecord['arms']): { benchmark: BenchmarkRecord } {
  const armList = arms ?? [
    { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
    { name: 'no-migrations', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/db/migrations'], revision: RUN_TEAM } },
    { name: 'no-db-rule', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['rules/db.md'], revision: RUN_TEAM } },
  ];
  const covers = ['skills/db/migrations', 'rules/db.md'];

  return {
    benchmark: {
      suite: { name: 'migrations', sourceHash: 'h' }, repetitions: 3, baselineTeamRevision: RUN_TEAM, scorers: [],
      tasks: [
        { id: 'add-column', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const, covers, coversSkills: ['migrations', null] },
        { id: 'drop-index', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const, covers, coversSkills: ['migrations', null] },
        { id: 'login-copy', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const },
      ],
      arms: armList,
      trials: trials.map((trial, index) => ({
        task: trial.task, arm: trial.arm, repetition: Math.floor(index / 2) + 1, order: index + 1,
        step: `r${Math.floor(index / 2) + 1}.${trial.task}.${trial.arm}.prompt`, result: trial.result ?? 'passed',
        ...(trial.routing ? { routing: trial.routing } : {}),
      })),
    },
  };
}

/** Both arms' trials of every task, one repetition each, `results` naming which of the three tasks each arm passes. */
function paired(results: { [arm: string]: Array<'p' | 'f' | undefined> }): TrialSpec[] {
  const tasks = ['add-column', 'drop-index', 'login-copy'];
  const [without, with_] = Object.keys(results);

  return tasks.flatMap((task, index) => ([
    { task, arm: without, result: results[without][index] === 'f' ? 'failed' as const : 'passed' as const },
    { task, arm: with_, result: results[with_][index] === 'f' ? 'failed' as const : 'passed' as const },
  ]));
}

describe('asset effects', () => {
  it('builds one table per covered path, with the arm that runs without exactly it against the pulled arm that differs only by that', () => {
    const record = migrationsRecord(paired({
      'no-migrations': ['f', 'p', 'p'],
      pulled: ['p', 'p', 'p'],
    }));

    const assets = assetEffects(record);

    expect(assets.map(({ path, without, has }) => ({ path, without, has }))).toEqual([
      { path: 'skills/db/migrations', without: 'no-migrations', has: 'pulled' },
      { path: 'rules/db.md', without: 'no-db-rule', has: 'pulled' },
    ]);
  });

  it('splits the paired difference by the tasks that cover the asset and the rest, each an interval that can read not separated', () => {
    const record = migrationsRecord(paired({
      'no-migrations': ['f', 'p', 'p'],
      pulled: ['p', 'p', 'p'],
    }));
    const [migrations] = assetEffects(record);

    expect(migrations.rows.map(({ task, covers, without, with: withIt }) => ({ task, covers, without, with: withIt }))).toEqual([
      { task: 'add-column', covers: true, without: { passed: 0, planned: 1 }, with: { passed: 1, planned: 1 } },
      { task: 'drop-index', covers: true, without: { passed: 1, planned: 1 }, with: { passed: 1, planned: 1 } },
      { task: 'login-copy', covers: false, without: { passed: 1, planned: 1 }, with: { passed: 1, planned: 1 } },
    ]);
    expect(migrations.coversDifference).toMatchObject({ from: { passed: 1, planned: 2 }, to: { passed: 2, planned: 2 } });
    expect(migrations.othersDifference).toMatchObject({ from: { passed: 1, planned: 1 }, to: { passed: 1, planned: 1 }, difference: { value: 0 } });
    expect(migrations.othersDifference?.separated).toBe(false);
  });

  it('counts each trial of the arm that has the skill under the routing value the record carries', () => {
    const trials = [
      ...paired({ 'no-migrations': ['f', 'p', 'p'], pulled: ['p', 'p', 'p'] }),
    ];
    const withArm = trials.filter(({ arm }) => arm === 'pulled');
    const skill = 'migrations';

    withArm[0].routing = { [skill]: 'fit' };
    withArm[1].routing = { [skill]: 'missed' };
    withArm[2].routing = { [skill]: 'extra' };
    const [migrations] = assetEffects(migrationsRecord(trials));

    expect(migrations.rows.map(({ task, loaded }) => ({ task, loaded }))).toEqual([
      { task: 'add-column', loaded: { loaded: 1, planned: 1, byValue: { fit: 1 } } },
      { task: 'drop-index', loaded: { loaded: 0, planned: 1, byValue: { missed: 1 } } },
      { task: 'login-copy', loaded: { loaded: 1, planned: 1, byValue: { extra: 1 } } },
    ]);
    expect(migrations.passedWhenLoaded).toEqual({ passed: 2, planned: 2 });
    expect(migrations.passedWhenNotLoaded).toEqual({ passed: 1, planned: 1 });
  });

  it('gives a rule, a claudemd file, a doc and a namespace directory rows with not observed loads and no routing', () => {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
      { name: 'ablated', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['rules/db.md'] as [string, ...string[]], revision: RUN_TEAM } },
    ];
    const record: { benchmark: BenchmarkRecord } = {
      benchmark: {
        ...migrationsRecord(paired({ ablated: ['f', 'p', 'p'], pulled: ['p', 'p', 'p'] })).benchmark,
        arms,
        tasks: (['add-column', 'drop-index'] as const).map((id) => ({ id, startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const, covers: ['claudemd/team.md', 'docs/api', 'rules/db.md'], coversSkills: [null, null, null] })),
        trials: [
          { task: 'add-column', arm: 'ablated', repetition: 1, order: 1, step: 'r1', result: 'failed' },
          { task: 'add-column', arm: 'pulled', repetition: 1, order: 2, step: 'r2', result: 'passed' },
          { task: 'drop-index', arm: 'ablated', repetition: 1, order: 3, step: 'r3', result: 'passed' },
          { task: 'drop-index', arm: 'pulled', repetition: 1, order: 4, step: 'r4', result: 'passed' },
        ],
      },
    };
    const assets = assetEffects(record);

    expect(assets.map(({ path, skill }) => ({ path, skill }))).toEqual([
      { path: 'claudemd/team.md', skill: undefined },
      { path: 'docs/api', skill: undefined },
      { path: 'rules/db.md', skill: undefined },
    ]);
    for (const asset of assets) {
      expect(asset.rows.every(({ loaded }) => loaded === undefined)).toBe(true);
      expect(asset.passedWhenLoaded).toBeUndefined();
      expect(asset.passedWhenNotLoaded).toBeUndefined();
    }
  });

  it('gives an arm that leaves out more than one path no per-asset table', () => {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
      { name: 'ablated', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['rules/db.md', 'skills/db/migrations'] as [string, ...string[]], revision: RUN_TEAM } },
    ];
    const record = migrationsRecord(paired({ ablated: ['f', 'p', 'p'], pulled: ['p', 'p', 'p'] }), arms);
    const assets = assetEffects(record);

    // No arm runs without exactly one of them, so both get rows against the pulled arm, and no difference.
    expect(assets.map(({ path, without }) => ({ path, without }))).toEqual([
      { path: 'skills/db/migrations', without: undefined },
      { path: 'rules/db.md', without: undefined },
    ]);
  });

  it('gives each arm that runs without a covered path its own table, against its own has-arm (#1684 review)', () => {
    const arms = [
      { name: 'claude', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
      { name: 'claude-no', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/db/migrations'] as [string, ...string[]], revision: RUN_TEAM } },
      { name: 'codex', tool: 'codex', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
      { name: 'codex-no', tool: 'codex', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/db/migrations'] as [string, ...string[]], revision: RUN_TEAM } },
    ];
    const record = migrationsRecord([
      { task: 'add-column', arm: 'claude', result: 'passed', routing: { migrations: 'fit' } },
      { task: 'add-column', arm: 'claude-no', result: 'failed' },
      { task: 'add-column', arm: 'codex', result: 'failed' },
      { task: 'add-column', arm: 'codex-no', result: 'failed' },
    ], arms);

    const tables = assetEffects(record);

    expect(tables.filter(({ path }) => path === 'skills/db/migrations').map(({ without, has, tool }) => ({ without, has, tool }))).toEqual([
      { without: 'claude-no', has: 'claude', tool: 'claude' },
      { without: 'codex-no', has: 'codex', tool: 'codex' },
    ]);
    expect(formatBenchmarkTable(benchmarkTable(record))).toContain('Asset effect · skills/db/migrations · claude-no -> claude · claude');
    expect(formatBenchmarkTable(benchmarkTable(record))).toContain('Asset effect · skills/db/migrations · codex-no -> codex · codex');
  });

  it('reads a covered namespace directory as no skill even when skills live under it (#1684 review)', () => {
    const record: Parameters<typeof assetEffects>[0] = {
      benchmark: {
        suite: { name: 'migrations', sourceHash: 'h' }, repetitions: 1, baselineTeamRevision: RUN_TEAM, scorers: [],
        tasks: [{ id: 'add-column', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid', covers: ['skills/db'], coversSkills: [null] }],
        arms: [
          { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
          { name: 'no-db', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/db'] as [string, ...string[]], revision: RUN_TEAM } },
        ],
        trials: [
          { task: 'add-column', arm: 'pulled', repetition: 1, order: 1, step: 's1', result: 'passed' as TrialResult, routing: { migrations: 'fit' } },
          { task: 'add-column', arm: 'no-db', repetition: 1, order: 2, step: 's2', result: 'failed' as TrialResult },
        ],
      },
    };

    const [table] = assetEffects(record);

    expect(table).toMatchObject({ path: 'skills/db', without: 'no-db', has: 'pulled' });
    expect(table?.skill).toBeUndefined();
    expect(table?.rows[0].loaded).toBeUndefined();
    expect(formatBenchmarkTable(benchmarkTable(record))).toContain('add-column   yes   0% (0/1)   100% (1/1)   not observed');
  });

  it('gives a covered path no arm leaves out its rows, with pass rate and loads, and no difference', () => {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
    ];
    const record = migrationsRecord([
      { task: 'add-column', arm: 'pulled', result: 'passed', routing: { migrations: 'fit' } },
      { task: 'drop-index', arm: 'pulled', result: 'failed', routing: { migrations: 'missed' } },
      { task: 'login-copy', arm: 'pulled', result: 'passed', routing: { migrations: 'idle' } },
    ], arms);
    const [migrations] = assetEffects(record);

    expect(migrations.without).toBeUndefined();
    expect(migrations.has).toBe('pulled');
    expect(migrations.coversDifference).toBeUndefined();
    expect(migrations.othersDifference).toBeUndefined();
    expect(migrations.rows.map(({ task, with: withIt }) => ({ task, with: withIt }))).toEqual([
      { task: 'add-column', with: { passed: 1, planned: 1 } },
      { task: 'drop-index', with: { passed: 0, planned: 1 } },
      { task: 'login-copy', with: { passed: 1, planned: 1 } },
    ]);
  });

  it('shows a covered path no arm leaves out on the pulled arm that receives it, not the first pulled arm', () => {
    const pulled = (name: string) => ({ name, tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM }, role: name });
    const record = {
      benchmark: {
        suite: { name: 'auth', sourceHash: 'h' }, repetitions: 1, baselineTeamRevision: RUN_TEAM, scorers: [],
        tasks: [{ id: 'login', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const, covers: ['skills/dev/auth'] as [string], coversSkills: ['auth'] as [string], coversWithheldFrom: [['ops']] as [string[]] }],
        arms: [pulled('ops'), pulled('dev')],
        trials: [
          { task: 'login', arm: 'ops', repetition: 1, order: 1, step: 'r1.login.ops.prompt', result: 'failed' as const },
          { task: 'login', arm: 'dev', repetition: 1, order: 2, step: 'r1.login.dev.prompt', result: 'passed' as const, routing: { auth: 'fit' as const } },
        ],
      },
    };
    const [auth] = assetEffects(record);

    expect(auth.has).toBe('dev');
    expect(auth.rows.map(({ task, with: withIt }) => ({ task, with: withIt }))).toEqual([{ task: 'login', with: { passed: 1, planned: 1 } }]);
  });

  it('shows a covered path no pulled arm receives on the arm on another team ref that does', () => {
    const record = {
      benchmark: {
        suite: { name: 'auth', sourceHash: 'h' }, repetitions: 1, baselineTeamRevision: RUN_TEAM, scorers: [],
        tasks: [{ id: 'login', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const, covers: ['skills/dev/auth'] as [string], coversSkills: ['auth'] as [string], coversWithheldFrom: [['ops']] as [string[]] }],
        arms: [
          { name: 'ops', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM }, role: 'ops' },
          { name: 'dev', tool: 'claude', source: 'team' as const, team: { kind: 'ref' as const, ref: 'next', revision: RUN_TEAM }, role: 'dev' },
        ],
        trials: [
          { task: 'login', arm: 'ops', repetition: 1, order: 1, step: 'r1.login.ops.prompt', result: 'failed' as const },
          { task: 'login', arm: 'dev', repetition: 1, order: 2, step: 'r1.login.dev.prompt', result: 'passed' as const, routing: { auth: 'fit' as const } },
        ],
      },
    };
    const [auth] = assetEffects(record);

    expect(auth.has).toBe('dev');
    expect(auth.rows.map(({ task, with: withIt }) => ({ task, with: withIt }))).toEqual([{ task: 'login', with: { passed: 1, planned: 1 } }]);
  });

  it('shows a covered path no pulled arm receives on an arm that runs without another path and receives it', () => {
    const record = {
      benchmark: {
        suite: { name: 'auth', sourceHash: 'h' }, repetitions: 1, baselineTeamRevision: RUN_TEAM, scorers: [],
        tasks: [{ id: 'login', startingCommit: RUN_START, sourceHash: 'h', baseline: 'valid' as const, covers: ['skills/dev/auth'] as [string], coversSkills: ['auth'] as [string], coversWithheldFrom: [['ops']] as [string[]] }],
        arms: [
          { name: 'ops', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM }, role: 'ops' },
          { name: 'dev', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['rules/dev/review.md'] as [string], revision: RUN_TEAM }, role: 'dev' },
        ],
        trials: [
          { task: 'login', arm: 'ops', repetition: 1, order: 1, step: 'r1.login.ops.prompt', result: 'failed' as const },
          { task: 'login', arm: 'dev', repetition: 1, order: 2, step: 'r1.login.dev.prompt', result: 'passed' as const, routing: { auth: 'fit' as const } },
        ],
      },
    };
    const [auth] = assetEffects(record);

    expect(auth.has).toBe('dev');
    expect(auth.rows.map(({ task, with: withIt }) => ({ task, with: withIt }))).toEqual([{ task: 'login', with: { passed: 1, planned: 1 } }]);
  });

  it('prints the tables with the example\'s lines, and unknown loads never read as idle or missed', () => {
    const trials = paired({ 'no-migrations': ['f', 'p', 'p'], pulled: ['p', 'p', 'p'] });
    const withArm = trials.filter(({ arm }) => arm === 'pulled');
    const skill = 'migrations';

    withArm[0].routing = { [skill]: 'unknown' };
    withArm[1].routing = { [skill]: 'unknown' };
    withArm[2].routing = { [skill]: 'unknown' };
    const text = formatBenchmarkTable(benchmarkTable(migrationsRecord(trials)));
    const [migrations] = assetEffects(migrationsRecord(trials));

    expect(text).toContain('Asset effect · skills/db/migrations · no-migrations -> pulled · claude');
    expect(text).toContain('add-column   yes   0% (0/1)   100% (1/1)   0/1 unknown');
    expect(migrations.passedWhenLoaded).toBeUndefined();
    expect(migrations.passedWhenNotLoaded).toBeUndefined();
    // The trials still count in the pass rates, and in the split's pairs.
    expect(migrations.coversDifference).toMatchObject({ from: { passed: 1, planned: 2 }, to: { passed: 2, planned: 2 } });
    expect(text).toContain('tasks that cover it   +50 pp   1/2 -> 2/2');
  });

  it('prints every routing count a row has, the loaded value first and then the others in one order', () => {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
    ];
    const runs = (task: string, values: Array<'fit' | 'idle' | 'extra' | 'missed'>): TrialSpec[] => values.map((value) => ({ task, arm: 'pulled', routing: { migrations: value } }));
    const text = formatBenchmarkTable(benchmarkTable(migrationsRecord([
      ...runs('add-column', ['fit', 'missed', 'fit']),
      ...runs('drop-index', ['missed', 'idle', 'idle']),
      ...runs('login-copy', ['idle', 'extra', 'idle']),
    ], arms)));

    expect(text).toContain('add-column   yes   -   100% (3/3)   2/3 fit, 1 missed');
    expect(text).toContain('drop-index   yes   -   100% (3/3)   0/3 2 idle, 1 missed');
    expect(text).toContain('login-copy   no   -   100% (3/3)   1/3 extra, 2 idle');
  });

  it('counts the trials whose tool reported no loads beside the observed ones', () => {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
    ];
    const runs = (task: string, values: Array<'fit' | 'idle' | 'unknown'>): TrialSpec[] => values.map((value) => ({ task, arm: 'pulled', routing: { migrations: value } }));
    const text = formatBenchmarkTable(benchmarkTable(migrationsRecord([
      ...runs('add-column', ['fit', 'unknown']),
      ...runs('drop-index', ['unknown', 'unknown']),
      ...runs('login-copy', ['idle', 'unknown']),
    ], arms)));

    expect(text).toContain('add-column   yes   -   100% (2/2)   1/2 fit, 1 unknown');
    expect(text).toContain('drop-index   yes   -   100% (2/2)   0/2 unknown');
    expect(text).toContain('login-copy   no   -   100% (2/2)   0/2 1 idle, 1 unknown');
  });

  it('names the routing question of a covered skill, with its namespace when a namespace delivers it', () => {
    const record = migrationsRecord(paired({ 'no-migrations': ['f', 'p', 'p'], pulled: ['p', 'p', 'p'] }));
    const [migrations, rule] = assetEffects(record);

    expect(migrations.routingScorer).toBe('teamai:routing:db:migrations');
    expect(rule.routingScorer).toBeUndefined();
  });

  it('matches the arm that leaves nothing out only when tool, model, workflow and role agree', () => {
    const arms = [
      { name: 'pulled-claude', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
      { name: 'pulled-codex', tool: 'codex', source: 'team' as const, team: { kind: 'pulled' as const, revision: RUN_TEAM } },
      { name: 'no-migrations', tool: 'codex', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/db/migrations'] as [string, ...string[]], revision: RUN_TEAM } },
    ];
    const record = migrationsRecord(paired({ 'no-migrations': ['f', 'p', 'p'], 'pulled-codex': ['p', 'p', 'p'] }), arms);
    const [migrations] = assetEffects(record);

    expect(migrations.has).toBe('pulled-codex');
  });

  it('emits no tables when no task covers a path', () => {
    const record = migrationsRecord(paired({ 'no-migrations': ['f', 'p', 'p'], pulled: ['p', 'p', 'p'] }));
    const bare: { benchmark: BenchmarkRecord } = { benchmark: { ...record.benchmark, tasks: record.benchmark.tasks.map(({ id, startingCommit, sourceHash, baseline }) => ({ id, startingCommit, sourceHash, baseline })) } };

    expect(assetEffects(bare)).toEqual([]);
    expect(formatBenchmarkTable(benchmarkTable(bare))).not.toContain('Asset effect');
  });
});

/** What a table's rows say about one asset, for the assertions above. */
export type { AssetEffect };

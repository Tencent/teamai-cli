import { describe, expect, it } from 'vitest';
import type { RecordedAgent } from '../agent-observation.js';
import type { ScoreLabel } from '../scorers/label.js';
import { FAILING_PAGE, ScorerResults, type ViewedLabel } from '../scorers/results.js';

const NOW = new Date('2026-03-20T12:00:00Z');
const REV_A = 'a'.repeat(40);

let sequence = 0;

/** A session label of `review-quality`, judged by a Claude model, scored at `scoredAt`. */
function sessionLabel(overrides: Partial<Extract<ScoreLabel, { source: 'session' }>> = {}): Extract<ScoreLabel, { source: 'session' }> {
  sequence += 1;
  return {
    scorer: 'review-quality',
    rubric: { sourceHash: 'rubric-1' },
    label: 'good',
    score: 1,
    passed: true,
    judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-haiku-5-5' }, isolation: 'verified', access: 'read' },
    scoredAt: '2026-03-18T10:00:00.000Z',
    source: 'session',
    subject: { platform: 'claude', sessionId: `session-${sequence}` },
    ...overrides,
  };
}

function viewed(label: ScoreLabel, extra: Partial<ViewedLabel> = {}): ViewedLabel {
  return { label, author: 'alice', ...extra };
}

describe('scorer results', () => {
  it('opens on the newest rubric whose labels carry a team revision, and shows another rubric only with its own labels', () => {
    const labels = [
      viewed(sessionLabel({ rubric: { sourceHash: 'committed', teamRevision: REV_A }, scoredAt: '2026-03-10T00:00:00.000Z' })),
      viewed(sessionLabel({ rubric: { sourceHash: 'committed', teamRevision: REV_A }, scoredAt: '2026-03-11T00:00:00.000Z', passed: false, label: 'poor', score: 0 })),
      viewed(sessionLabel({ rubric: { sourceHash: 'draft' }, scoredAt: '2026-03-19T00:00:00.000Z' })),
    ];
    const opened = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(opened.selected?.cohort.rubric).toEqual({ sourceHash: 'committed', teamRevision: REV_A });
    expect(opened.selected?.cohort.stats).toEqual({ n: 2, passed: 1, failed: 1, rate: 0.5 });

    const draft = opened.scorers[0]?.cohorts.find((cohort) => cohort.rubric.sourceHash === 'draft');
    const other = ScorerResults.of({ labels, query: { windowDays: 30, scorer: 'review-quality', cohort: draft?.id }, now: NOW });
    expect(other.selected?.cohort.stats).toEqual({ n: 1, passed: 1, failed: 0, rate: 1 });
  });

  it('never counts workflow and session labels, two judge models, or two run modes together', () => {
    const workflow: ScoreLabel = { ...sessionLabel(), source: 'workflow', subject: { runId: 'run-1', step: 'review', pass: 1 } };
    const labels = [
      viewed(sessionLabel({ runMode: 'attended' })),
      viewed(workflow),
      viewed(sessionLabel({ runMode: 'attended', judge: { kind: 'model', tool: 'codex', model: { reported: 'gpt-6.1' }, isolation: 'verified', access: 'read' } })),
      viewed(sessionLabel({ runMode: 'unattended' })),
      viewed(sessionLabel()),
    ];
    const [scorer] = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).scorers;
    expect(scorer?.cohorts.map((cohort) => `${cohort.source} ${cohort.runMode ?? 'not recorded'} ${cohort.judge.kind === 'model' ? cohort.judge.model?.id : 'human'} n=${cohort.stats.n}`).sort())
      .toEqual([
        'session attended claude-haiku-5-5 n=1',
        'session attended gpt-6.1 n=1',
        'session not recorded claude-haiku-5-5 n=1',
        'session unattended claude-haiku-5-5 n=1',
        'workflow not recorded claude-haiku-5-5 n=1',
      ]);
  });

  it('counts a judge model under one measurement whatever alias the scorer named it by, and shows the newest alias', () => {
    const judge = (alias?: string): ScoreLabel['judge'] => ({ kind: 'model', tool: 'claude', model: { reported: 'claude-haiku-5-5', ...(alias ? { alias } : {}) }, isolation: 'verified', access: 'read' });
    const labels = [
      viewed(sessionLabel({ judge: judge(), scoredAt: '2026-03-10T00:00:00.000Z' })),
      viewed(sessionLabel({ judge: judge('fast'), scoredAt: '2026-03-12T00:00:00.000Z' })),
    ];
    const [scorer] = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).scorers;
    expect(scorer?.cohorts.map((cohort) => ({ judge: cohort.judge, n: cohort.stats.n }))).toEqual([
      { judge: { kind: 'model', tool: 'claude', model: { id: 'claude-haiku-5-5', isReported: true, alias: 'fast' } }, n: 2 },
    ]);
  });

  it('counts a label rescored in a later month once, in that month', () => {
    const subject = { platform: 'claude', sessionId: 'rescored' };
    const labels = [
      viewed(sessionLabel({ subject, scoredAt: '2026-01-20T00:00:00.000Z', passed: false, label: 'poor', score: 0 })),
      viewed(sessionLabel({ subject, scoredAt: '2026-02-10T00:00:00.000Z' })),
    ];
    const january = ScorerResults.of({ labels, query: { windowDays: 10 }, now: new Date('2026-01-25T00:00:00Z') });
    const february = ScorerResults.of({ labels, query: { windowDays: 10 }, now: new Date('2026-02-15T00:00:00Z') });
    const both = ScorerResults.of({ labels, query: { windowDays: 60 }, now: new Date('2026-02-15T00:00:00Z') });
    expect(january.selected?.cohort.stats.n).toBe(0);
    expect(february.selected?.cohort.stats).toEqual({ n: 1, passed: 1, failed: 0, rate: 1 });
    expect(both.selected?.cohort.stats.n).toBe(1);
  });

  it('reads pass or fail as the label stored it, whatever its score', () => {
    const labels = [viewed(sessionLabel({ score: 0.2, passed: true })), viewed(sessionLabel({ score: 0.9, passed: false }))];
    expect(ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).selected?.cohort.stats).toEqual({ n: 2, passed: 1, failed: 1, rate: 0.5 });
  });

  describe('grouping', () => {
    const observed = (overrides: Partial<Extract<RecordedAgent, { v: 1 }>> = {}): RecordedAgent => ({
      v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local', ...overrides,
    });
    const groups = (labels: ViewedLabel[], groupBy: Parameters<typeof ScorerResults.of>[0]['query']['groupBy']) =>
      ScorerResults.of({ labels, query: { windowDays: 30, groupBy }, now: NOW }).selected?.groups
        ?.map((group) => `${group.kind === 'value' ? group.value : group.kind}${group.kind === 'value' && group.isReported === false ? ' (requested)' : ''} n=${group.stats.n}`);

    it('keeps reported and requested-only models apart, and puts labels with no model under not recorded', () => {
      const labels = [
        viewed(sessionLabel(), { agent: observed({ model: { reported: 'claude-opus-5-5' } }) }),
        viewed(sessionLabel(), { agent: observed({ model: { requested: 'claude-opus-5-5' } }) }),
        viewed(sessionLabel(), { agent: observed({ model: { requested: 'opus', reported: 'claude-opus-5-5' } }) }),
        viewed(sessionLabel(), { agent: observed() }),
        viewed(sessionLabel()),
      ];
      expect(groups(labels, 'model')).toEqual(['claude-opus-5-5 n=2', 'claude-opus-5-5 (requested) n=1', 'not recorded n=2']);
    });

    it('gives an agent recorded before #1176 only its definition', () => {
      const labels = [viewed(sessionLabel(), { agent: { definition: { name: 'reviewer' } } })];
      expect(groups(labels, 'definition')).toEqual(['reviewer n=1']);
      expect(groups(labels, 'tool')).toEqual(['not recorded n=1']);
    });

    it('splits one team revision by the primary role it was delivered for', () => {
      const team = (primaryRole: string) => ({ revision: REV_A, localChanges: false, selection: { scope: 'project' as const, primaryRole, additionalRoles: [] } });
      const labels = [
        viewed(sessionLabel(), { agent: observed({ team: team('backend') }) }),
        viewed(sessionLabel(), { agent: observed({ team: team('frontend') }) }),
        viewed(sessionLabel(), { agent: observed({ team: team('backend') }) }),
      ];
      expect(groups(labels, 'role')).toEqual(['backend n=2', 'frontend n=1']);
      expect(groups(labels, 'teamRevision')).toEqual([`${REV_A} n=3`]);
    });

    it('groups a pass in a workflow copy under the role the copy ran with, not the member\'s', () => {
      const selection = { scope: 'project' as const, primaryRole: 'frontend', additionalRoles: [] };
      const labels = [
        viewed(sessionLabel(), { agent: observed({ team: { revision: REV_A, localChanges: false, selection: { ...selection, stepRole: 'review' } } }) }),
        viewed(sessionLabel(), { agent: observed({ team: { revision: REV_A, localChanges: false, selection } }) }),
      ];
      expect(groups(labels, 'role')).toEqual(['frontend n=1', 'review n=1']);
    });

    it("says whether each role group ran with the step's role, the member's, or both", () => {
      const team = (selection: { primaryRole: string; stepRole?: string }) => ({ revision: REV_A, localChanges: false, selection: { scope: 'project' as const, additionalRoles: [], ...selection } });
      const labels = [
        viewed(sessionLabel(), { agent: observed({ team: team({ primaryRole: 'frontend', stepRole: 'review' }) }) }),
        viewed(sessionLabel(), { agent: observed({ team: team({ primaryRole: 'frontend' }) }) }),
        viewed(sessionLabel(), { agent: observed({ team: team({ primaryRole: 'frontend', stepRole: 'spec' }) }) }),
        viewed(sessionLabel(), { agent: observed({ team: team({ primaryRole: 'spec' }) }) }),
        viewed(sessionLabel()),
      ];
      const roleGroups = ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role' }, now: NOW }).selected?.groups
        ?.map((group) => (group.kind === 'value' ? `${group.value} ${group.roleOf ?? '-'}` : group.kind));
      expect(roleGroups).toEqual(['spec both', 'frontend member', 'review step', 'not recorded']);
      expect(groups(labels, 'tool')).toEqual(['claude n=4', 'not recorded n=1']);
    });

    it("sums a selected group's failing labels by the harness each ran with, the most failures first, past the listed page", () => {
      const REV_B = 'b'.repeat(40);
      const ranAs = ({ model, effort, revision, role }: { model: string; effort?: string; revision: string; role: string }) => observed({
        model: { reported: model }, ...(effort ? { effort: { requested: effort } } : {}),
        team: { revision, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], stepRole: role } },
      });
      const failed = (agent: RecordedAgent) => viewed(sessionLabel({ passed: false, label: 'poor', score: 0 }), { agent });
      const sonnet = ranAs({ model: 'claude-sonnet-5-5', effort: 'high', revision: REV_A, role: 'spec' });
      const labels = [
        failed(sonnet),
        failed(ranAs({ model: 'claude-opus-5-5', revision: REV_B, role: 'spec' })),
        failed(sonnet),
        viewed(sessionLabel(), { agent: sonnet }),
        failed(ranAs({ model: 'claude-opus-5-5', revision: REV_B, role: 'review' })),
      ];
      const spec = JSON.stringify(['value', 'spec', null, false]);
      const failing = ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role', failing: { group: spec, limit: 1 } }, now: NOW }).selected?.failing;

      expect(failing?.labels).toHaveLength(1);
      expect(failing?.byHarness).toEqual([
        { harness: { tool: 'claude', model: 'claude-sonnet-5-5', effort: 'high', role: { of: 'step', names: ['spec'] }, teamRevision: REV_A }, failed: 2 },
        { harness: { tool: 'claude', model: 'claude-opus-5-5', role: { of: 'step', names: ['spec'] }, teamRevision: REV_B }, failed: 1 },
      ]);
      expect(ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role' }, now: NOW }).selected?.failing).not.toHaveProperty('byHarness');
    });

    it("gives each group its pass rate's 95% Wilson interval, as a benchmark arm's, so 1 of 1 weighs less than 20 of 20", () => {
      const on = (stepRole: string) => observed({ team: { revision: REV_A, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], stepRole } } });
      const labels = [viewed(sessionLabel(), { agent: on('spec') }), ...Array.from({ length: 20 }, () => viewed(sessionLabel(), { agent: on('review') })),
        viewed(sessionLabel(), { agent: on('plan') }), viewed(sessionLabel({ passed: false, label: 'poor', score: 0 }), { agent: on('plan') })];
      const intervals = Object.fromEntries((ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role' }, now: NOW }).selected?.groups ?? [])
        .map((group) => [group.kind === 'value' ? group.value : group.kind, [group.interval.low, group.interval.high].map((bound) => Math.round(bound * 1000) / 1000)]));

      expect(intervals).toEqual({ review: [0.839, 1], plan: [0.095, 0.905], spec: [0.207, 1] });
    });

    it("names the team revision a selected group's labels started failing on, only when they passed before it and failed from it on", () => {
      const [REV_B, REV_C] = ['b'.repeat(40), 'c'.repeat(40)];
      const on = (revision: string) => observed({ team: { revision, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], stepRole: 'spec' } } });
      const scored = (day: number, passed: boolean, revision: string) => viewed(sessionLabel({ passed, label: passed ? 'good' : 'poor', score: passed ? 1 : 0, scoredAt: `2026-03-${String(day).padStart(2, '0')}T10:00:00.000Z` }), { agent: on(revision) });
      const spec = JSON.stringify(['value', 'spec', null, false]);
      const changeOf = (labels: ViewedLabel[], group: string | null = spec) => ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role', ...(group ? { failing: { group } } : {}) }, now: NOW }).selected?.failing.revisionChange;
      // Passed on a, then failed on b and on c: b is where it turned.
      const turned = [scored(12, false, REV_B), scored(10, true, REV_A), scored(13, false, REV_C), scored(11, true, REV_A)];

      expect(changeOf(turned)).toEqual({ lastPassed: REV_A, firstFailed: REV_B });
      expect(changeOf(turned, null)).toBeUndefined();
      // A pass after the first failure, a revision that both passed and failed, or no pass at all is no clear change.
      expect(changeOf([...turned, scored(14, true, REV_C)])).toBeUndefined();
      expect(changeOf([scored(10, true, REV_A), scored(11, false, REV_A), scored(12, false, REV_B)])).toBeUndefined();
      expect(changeOf([scored(10, false, REV_A), scored(11, false, REV_B)])).toBeUndefined();
    });

    it('counts a label under every skill it used, and one that used none under none', () => {
      const labels = [
        viewed(sessionLabel({ used: { skills: ['tdd', 'review'] } })),
        viewed(sessionLabel({ used: { skills: ['tdd'] } })),
        viewed(sessionLabel({ used: { skills: [] } })),
        viewed(sessionLabel()),
      ];
      expect(groups(labels, 'skill')).toEqual(['tdd n=2', 'review n=1', 'none n=1', 'not recorded n=1']);
    });
  });

  it('splits labels at a team commit, with labels on no known revision under not recorded, also within each group', () => {
    const [A, B, C] = ['a', 'b', 'c'].map((digit) => digit.repeat(40));
    const on = (revision: string, skills: string[]) => viewed(sessionLabel({ used: { skills } }), {
      agent: { v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local', team: { revision, localChanges: false } },
    });
    const labels = [on(A, ['tdd']), on(B, ['tdd']), on(C, ['review']), viewed(sessionLabel({ used: { skills: ['tdd'] } })), on('d'.repeat(40), ['tdd'])];
    const sides = new Map([[A, 'before' as const], [B, 'after' as const], [C, 'after' as const]]);
    const selected = ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'skill', split: { commit: B, sideOf: sides } }, now: NOW }).selected;
    expect(selected?.split).toEqual({
      commit: B,
      before: { n: 1, passed: 1, failed: 0, rate: 1 },
      after: { n: 2, passed: 2, failed: 0, rate: 1 },
      notRecorded: { n: 2, passed: 2, failed: 0, rate: 1 },
    });
    expect(selected?.groups?.find((group) => group.kind === 'value' && group.value === 'tdd')?.split).toMatchObject({ before: { n: 1 }, after: { n: 1 }, notRecorded: { n: 2 } });
  });

  it('lists the failing labels of a cohort newest first, with their author, platform, skills, session name and start only', () => {
    const labels = [
      viewed(sessionLabel({ passed: false, label: 'poor', scoredAt: '2026-03-12T00:00:00.000Z', used: { skills: ['tdd'] } }), { author: 'bob', sessionName: 'fix-login' }),
      viewed(sessionLabel({ passed: true })),
      viewed(sessionLabel({ passed: false, label: 'poor', scoredAt: '2026-03-15T00:00:00.000Z' })),
    ];
    expect(ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).selected?.failing).toEqual({
      total: 2,
      covered: 0,
      startable: 0,
      labels: [
        { author: 'alice', scoredAt: '2026-03-15T00:00:00.000Z', label: 'poor', source: 'session', platform: 'claude', start: { refused: 'not_recorded' } },
        { author: 'bob', scoredAt: '2026-03-12T00:00:00.000Z', label: 'poor', source: 'session', platform: 'claude', skills: ['tdd'], sessionName: 'fix-login', start: { refused: 'not_recorded' } },
      ],
    });
  });

  it('keeps a recorded value named like none apart from labels that recorded none', () => {
    const labels = [
      viewed(sessionLabel({ passed: false, label: 'poor', used: { skills: ['none'] } })),
      viewed(sessionLabel({ passed: false, label: 'poor', used: { skills: [] } })),
    ];
    const query = { windowDays: 30, groupBy: 'skill' } as const;
    const keys = ScorerResults.of({ labels, query, now: NOW }).selected?.groups?.map((group) => group.key) ?? [];
    expect(new Set(keys).size).toBe(2);
    for (const group of keys) {
      expect(ScorerResults.of({ labels, query: { ...query, failing: { group } }, now: NOW }).selected?.failing.total).toBe(1);
    }
  });

  it('lists a page of failing labels with their total, and every failing label of a group however many newer ones other groups have', () => {
    const failing = (skill: string, scoredAt: string) => viewed(sessionLabel({ passed: false, label: 'poor', scoredAt, used: { skills: [skill] } }));
    const labels = [
      failing('review', '2026-03-01T00:00:00.000Z'),
      ...Array.from({ length: 150 }, (_, index) => failing('tdd', `2026-03-10T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`)),
    ];
    const query = { windowDays: 30, groupBy: 'skill' } as const;
    const selected = ScorerResults.of({ labels, query, now: NOW }).selected;
    expect(selected?.failing.total).toBe(151);
    expect(selected?.failing.labels).toHaveLength(FAILING_PAGE);
    expect(ScorerResults.of({ labels, query: { ...query, failing: { limit: 140 } }, now: NOW }).selected?.failing.labels).toHaveLength(140);

    const review = selected?.groups?.find((group) => group.kind === 'value' && group.value === 'review')?.key ?? 'missing';
    const inReview = ScorerResults.of({ labels, query: { ...query, failing: { group: review } }, now: NOW }).selected?.failing;
    expect(inReview).toMatchObject({ total: 1, labels: [{ scoredAt: '2026-03-01T00:00:00.000Z', skills: ['review'] }] });
  });

  it('compares the sessions the friction reminder fired on with those it did not, over labelled sessions only', () => {
    const on = (sessionId: string, passed: boolean) => viewed(sessionLabel({ subject: { platform: 'claude', sessionId }, passed }));
    const labels = [on('fired-1', false), on('fired-2', true), on('quiet-1', true), on('unknown-1', true), on('elsewhere', false)];
    const reminders = {
      days: 30,
      sessions: ['fired-1', 'fired-2', 'fired-3', 'quiet-1', 'quiet-2', 'unknown-1'],
      hinted: new Map([['fired-1', true], ['fired-2', true], ['fired-3', true], ['quiet-1', false], ['quiet-2', false]]),
    };
    expect(ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW, reminders }).selected?.reminders).toEqual({ days: 30, rows: [
      { reminder: 'yes', sessions: 3, labelled: 2, passed: 1, rate: 0.5 },
      { reminder: 'no', sessions: 2, labelled: 1, passed: 1, rate: 1 },
      { reminder: 'not recorded', sessions: 1, labelled: 1, passed: 1, rate: 1 },
    ] });
  });

  it('shows a week without labels as a gap in the weekly trend, not as 0%', () => {
    const labels = [
      viewed(sessionLabel({ scoredAt: '2026-03-03T00:00:00.000Z' })),
      viewed(sessionLabel({ scoredAt: '2026-03-17T00:00:00.000Z', passed: false })),
    ];
    const trend = ScorerResults.of({ labels, query: { windowDays: 21 }, now: NOW }).selected?.cohort.trend;
    expect(trend).toEqual([
      { week: '2026-02-23', n: 0, passed: 0, failed: 0, rate: null },
      { week: '2026-03-02', n: 1, passed: 1, failed: 0, rate: 1 },
      { week: '2026-03-09', n: 0, passed: 0, failed: 0, rate: null },
      { week: '2026-03-16', n: 1, passed: 0, failed: 1, rate: 0 },
    ]);
  });

  it('counts a measurement by label value, highest score first, adding up to its label count', () => {
    const routing = (label: string, score: number) => viewed(sessionLabel({ label, score, passed: score > 0 }));
    const labels = [routing('missed', 0), routing('fit', 1), routing('extra', 0), routing('fit', 1), routing('extra', 0), routing('fit', 1)];
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(selected?.cohort.values).toEqual([
      { label: 'fit', score: 1, n: 3 },
      { label: 'extra', score: 0, n: 2 },
      { label: 'missed', score: 0, n: 1 },
    ]);
    expect(selected?.cohort.stats.n).toBe(6);
  });

  it('counts a label rescored with another value once, under its newest value, and shows no row for a value outside the window', () => {
    const subject = { platform: 'claude', sessionId: 'rescored' };
    const labels = [
      viewed(sessionLabel({ subject, label: 'partial', score: 0.5, passed: false, scoredAt: '2026-02-25T00:00:00.000Z' })),
      viewed(sessionLabel({ subject, label: 'good', score: 1, passed: true, scoredAt: '2026-03-15T00:00:00.000Z' })),
      viewed(sessionLabel({ label: 'bad', score: 0, passed: false, scoredAt: '2025-12-01T00:00:00.000Z' })),
    ];
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(selected?.cohort.values).toEqual([{ label: 'good', score: 1, n: 1 }]);
  });
});

describe('what decided workflow labels', () => {
  /** A label of `delivered` on a delivering pass, decided by `decidedBy`, passing only when the judge passed it. */
  function delivered(decidedBy: 'check' | 'ci' | 'protected' | 'judge' | undefined, passed: boolean, pass: number): Extract<ScoreLabel, { source: 'workflow' }> {
    return {
      ...sessionLabel(), scorer: 'delivered', label: passed ? 'complete' : 'partial', score: passed ? 1 : 0.5, passed,
      source: 'workflow', subject: { runId: 'run-1', step: 'change', pass }, ...(decidedBy ? { decidedBy } : {}),
    };
  }
  const labels = [
    delivered('ci', false, 1), delivered('ci', false, 2), delivered('check', false, 3), delivered('protected', false, 4),
    delivered('judge', true, 5), delivered('judge', true, 6), delivered('judge', false, 7), delivered(undefined, true, 8),
  ].map((label) => viewed(label));

  it('says how many labels each stage decided, how many never reached a judge, and how the judge did on the rest', () => {
    const decided = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).selected?.decided;

    expect(decided?.rows.map(({ by, stats }) => ({ by, stats }))).toEqual([
      { by: 'judge', stats: { n: 3, passed: 2, failed: 1, rate: 2 / 3 } },
      { by: 'ci', stats: { n: 2, passed: 0, failed: 2, rate: 0 } },
      { by: 'check', stats: { n: 1, passed: 0, failed: 1, rate: 0 } },
      { by: 'protected', stats: { n: 1, passed: 0, failed: 1, rate: 0 } },
      { by: 'not recorded', stats: { n: 1, passed: 1, failed: 0, rate: 1 } },
    ]);
    expect(decided?.beforeJudge).toBe(4);
  });

  it('groups by what decided a label, and lists each failing label with the stage that decided it', () => {
    const ci = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).selected?.decided?.rows.find((row) => row.by === 'ci')?.key;
    const selected = ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'decidedBy', failing: { group: ci } }, now: NOW }).selected;

    expect(selected?.groups?.map((group) => `${group.kind === 'value' ? group.value : group.kind} ${group.stats.n}`)).toEqual(['judge 3', 'ci 2', 'check 1', 'protected 1', 'not recorded 1']);
    expect(selected?.failing.labels.map((failing) => failing.decidedBy)).toEqual(['ci', 'ci']);
    expect(selected?.decided?.rows.map((row) => row.key)).toEqual(selected?.groups?.map((group) => group.key));
  });

  it('counts a label a stage decided in each model judge\'s measurement of its scorer and rubric, whichever tool it names', () => {
    const judge = (tool: string, model: { requested: string } | { reported: string }) => ({ kind: 'model' as const, tool, model, isolation: 'verified' as const, access: 'read' as const });
    const claudeStage = { ...delivered('ci', false, 9), judge: judge('claude', { requested: 'haiku' }) };
    const codexJudged = { ...delivered('judge', true, 10), judge: judge('codex', { reported: 'gpt-5.1-codex' }) };
    const stage: ScoreLabel = { ...delivered('check', false, 11), judge: { kind: 'stage' } };
    const all = [...labels, viewed(claudeStage), viewed(codexJudged), viewed(stage)];
    const view = ScorerResults.of({ labels: all, query: { windowDays: 30 }, now: NOW });

    expect(view.scorers[0]?.cohorts.map((cohort) => `${cohort.judge.kind === 'model' ? cohort.judge.tool : cohort.judge.kind} ${cohort.stats.n}`).sort()).toEqual(['claude 10', 'codex 7']);
    const codex = view.scorers[0]?.cohorts.find((cohort) => cohort.judge.kind === 'model' && cohort.judge.tool === 'codex')?.id;
    expect(ScorerResults.of({ labels: all, query: { windowDays: 30, cohort: codex }, now: NOW }).selected?.decided?.rows
      .map((row) => `${row.by} ${row.stats.n}`)).toEqual(['ci 3', 'check 2', 'protected 1', 'judge 1']);
  });

  it('counts a pass a stage decided once, whether v0.29.0 or this release wrote its labels, as a stage measurement while no judge labelled the rubric', () => {
    const before = delivered('ci', false, 1);
    const after: ScoreLabel = { ...delivered('ci', false, 1), judge: { kind: 'stage' }, scoredAt: '2026-03-19T10:00:00.000Z' };
    const view = ScorerResults.of({ labels: [viewed(before), viewed(after)], query: { windowDays: 30 }, now: NOW });

    expect(view.scorers[0]?.cohorts.map((cohort) => ({ judge: cohort.judge, n: cohort.stats.n }))).toEqual([{ judge: { kind: 'stage' }, n: 1 }]);
  });

  it('keeps labels a stage decided as their own measurement while no judge labelled the rubric', () => {
    const view = ScorerResults.of({ labels: [delivered('ci', false, 1), delivered('protected', false, 2)].map((label) => viewed(label)), query: { windowDays: 30 }, now: NOW });

    expect(view.scorers[0]?.cohorts.map((cohort) => cohort.stats.n)).toEqual([2]);
  });

  it('says nothing of stages for session labels, which a judge always decides', () => {
    expect(ScorerResults.of({ labels: [viewed(sessionLabel())], query: { windowDays: 30 }, now: NOW }).selected).not.toHaveProperty('decided');
  });
});

describe('agreement with hand labels', () => {
  const session = (n: number) => ({ platform: 'claude-code', sessionId: `s-${n}` });
  const byHand = (n: number, overrides: Partial<Extract<ScoreLabel, { source: 'session' }>> = {}) => sessionLabel({ subject: session(n), judge: { kind: 'human' }, ...overrides });
  const missedBug = { label: 'missed-bug', score: 0, passed: false } as const;

  it('pairs a judge\'s labels with hand labels of the same sessions, whoever gave them, and splits disagreements by direction', () => {
    const labels = [
      ...Array.from({ length: 14 }, (_, n) => viewed(sessionLabel({ subject: session(n) }))),
      ...Array.from({ length: 12 }, (_, n) => viewed(byHand(n, n < 2 ? missedBug : {}), { author: 'bob' })),
    ];
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(selected?.agreement).toMatchObject({
      handLabelled: 12,
      judges: [{
        judge: { kind: 'model', tool: 'claude', model: { id: 'claude-haiku-5-5', isReported: true } },
        labels: 14, paired: 12, agree: 10, judgePassedHumanFailed: 2, judgeFailedHumanPassed: 0,
      }],
    });
  });

  it('pairs the hand labels with every rubric of the scorer that still lists their value', () => {
    const rubric = (sourceHash: string, scoredAt: string) => Array.from({ length: 12 }, (_, n) => viewed(sessionLabel({ subject: session(n), rubric: { sourceHash }, scoredAt })));
    const labels = [
      ...rubric('first', '2026-03-10T00:00:00.000Z'),
      ...Array.from({ length: 12 }, (_, n) => viewed(byHand(n, { rubric: { sourceHash: 'first' }, scoredAt: '2026-03-11T00:00:00.000Z', ...(n < 2 ? missedBug : {}) }))),
      ...rubric('prompt-edited', '2026-03-12T00:00:00.000Z'),
      ...rubric('missed-bug-removed', '2026-03-13T00:00:00.000Z'),
    ];
    const rubricLabels = new Map([['first', ['good', 'missed-bug']], ['prompt-edited', ['good', 'missed-bug']], ['missed-bug-removed', ['good', 'partial']]]);
    const agreementOf = (sourceHash: string) => {
      const opened = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW, rubricLabels });
      const cohort = opened.scorers[0]?.cohorts.find((one) => one.rubric.sourceHash === sourceHash && one.judge.kind === 'model');
      const { agreement } = ScorerResults.of({ labels, query: { windowDays: 30, scorer: 'review-quality', cohort: cohort?.id }, now: NOW, rubricLabels }).selected ?? {};
      return agreement && { handLabelled: agreement.handLabelled, paired: agreement.judges[0]?.paired, agree: agreement.judges[0]?.agree };
    };

    expect(agreementOf('first')).toEqual({ handLabelled: 12, paired: 12, agree: 10 });
    expect(agreementOf('prompt-edited')).toEqual({ handLabelled: 12, paired: 12, agree: 10 });
    expect(agreementOf('missed-bug-removed')).toEqual({ handLabelled: 10, paired: 10, agree: 10 });
  });

  it('gives each judge of the rubric its own row and counts, the judge with the most labels first', () => {
    const codex = { kind: 'model', tool: 'codex', model: { reported: 'gpt-5.1-codex' }, isolation: 'best-effort', access: 'read' } as const;
    const labels = [
      viewed(sessionLabel({ subject: session(0) })),
      ...[1, 2].map((n) => viewed(sessionLabel({ subject: session(n), judge: codex }))),
      ...[0, 1, 2].map((n) => viewed(byHand(n, n === 2 ? missedBug : {}))),
    ];
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(selected?.agreement.judges).toMatchObject([
      { judge: { tool: 'codex' }, labels: 2, paired: 2, agree: 1, judgePassedHumanFailed: 1 },
      { judge: { tool: 'claude' }, labels: 1, paired: 1, agree: 1, judgePassedHumanFailed: 0 },
    ]);
  });

  it('pairs every model judge that labelled the same sessions, so a second tool does not hide the first one\'s pairs', () => {
    const codex = { kind: 'model', tool: 'codex', model: { reported: 'gpt-5.1-codex' }, isolation: 'best-effort', access: 'read' } as const;
    const labels = [0, 1].flatMap((n) => [
      viewed(sessionLabel({ subject: session(n), scoredAt: '2026-03-17T00:00:00.000Z' })),
      viewed(sessionLabel({ subject: session(n), judge: codex, scoredAt: '2026-03-18T00:00:00.000Z', ...(n === 1 ? missedBug : {}) })),
      viewed(byHand(n)),
    ]);
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(selected?.agreement.judges).toMatchObject([
      { judge: { tool: 'claude' }, labels: 2, paired: 2, agree: 2 },
      { judge: { tool: 'codex' }, labels: 2, paired: 2, agree: 1, judgeFailedHumanPassed: 1 },
    ]);
  });

  it('counts only the newest hand label of a session, whichever member gave it', () => {
    const labels = [
      viewed(sessionLabel({ subject: session(0) })),
      viewed(byHand(0, { ...missedBug, scoredAt: '2026-03-18T10:00:00.000Z' }), { author: 'bob' }),
      viewed(byHand(0, { scoredAt: '2026-03-19T10:00:00.000Z' }), { author: 'carol' }),
    ];
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(selected?.agreement.judges).toMatchObject([{ paired: 1, agree: 1 }]);
  });

  it('lists the sessions the judge and the member disagree on, newest first, by session name and never by id', () => {
    const labels = [
      viewed(sessionLabel({ subject: session(0), scoredAt: '2026-03-17T00:00:00.000Z' }), { sessionName: 'claude-code_fix-the-retry-loop_20260316' }),
      viewed(byHand(0, missedBug), { author: 'bob', sessionName: 'claude-code_fix-the-retry-loop_20260316' }),
      viewed(sessionLabel({ subject: session(1), ...missedBug, scoredAt: '2026-03-18T00:00:00.000Z' })),
      viewed(byHand(1), { author: 'carol' }),
      viewed(sessionLabel({ subject: session(2) })),
      viewed(byHand(2), { author: 'bob' }),
    ];
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    const judge = { kind: 'model', tool: 'claude', model: { id: 'claude-haiku-5-5', isReported: true } };
    expect(selected?.agreement.disagreements).toEqual([
      { judge, judged: { label: 'missed-bug', passed: false, scoredAt: '2026-03-18T00:00:00.000Z' }, hand: { label: 'good', passed: true, author: 'carol', scoredAt: '2026-03-18T10:00:00.000Z' }, source: 'session', platform: 'claude-code' },
      { judge, judged: { label: 'good', passed: true, scoredAt: '2026-03-17T00:00:00.000Z' }, hand: { label: 'missed-bug', passed: false, author: 'bob', scoredAt: '2026-03-18T10:00:00.000Z' }, source: 'session', platform: 'claude-code', sessionName: 'claude-code_fix-the-retry-loop_20260316' },
    ]);
    expect(JSON.stringify(selected?.agreement)).not.toContain('s-0');
  });

  it('shows how often the judge of each scorer\'s opening measurement agrees with hand labels', () => {
    const labels = [
      ...[0, 1, 2].map((n) => viewed(sessionLabel({ subject: session(n) }))),
      viewed(byHand(0)),
      viewed(byHand(1, missedBug)),
      viewed(sessionLabel({ scorer: 'tests-added' })),
    ];
    const { scorers } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW });
    expect(scorers.map(({ scorer, agreement }) => ({ scorer, agreement }))).toEqual([
      { scorer: 'review-quality', agreement: { paired: 2, agree: 1 } },
      { scorer: 'tests-added', agreement: { paired: 0, agree: 0 } },
    ]);
  });

  it.each([
    ['on the judge\'s rubric', { sourceHash: 'first', teamRevision: REV_A }],
    ['on a newer rubric the judge has not scored with yet', { sourceHash: 'second', teamRevision: 'b'.repeat(40) }],
  ])('opens a scorer on its judge when members hand-labelled more sessions than it judged %s', (_case, handRubric) => {
    const judged = { sourceHash: 'first', teamRevision: REV_A };
    const labels = [
      ...[0, 1].map((n) => viewed(sessionLabel({ subject: session(n), rubric: judged, scoredAt: '2026-03-10T00:00:00.000Z' }))),
      ...[0, 1, 2].map((n) => viewed(byHand(n, { rubric: handRubric, ...(n === 0 ? missedBug : {}) }))),
    ];
    const rubricLabels = new Map([['first', ['good', 'missed-bug']], ['second', ['good', 'missed-bug']]]);
    const { scorers, selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW, rubricLabels });
    expect(selected?.cohort).toMatchObject({ rubric: judged, judge: { kind: 'model' }, stats: { n: 2 } });
    expect(scorers[0]?.agreement).toEqual({ paired: 2, agree: 1 });
  });
});

describe('failures to improve from', () => {
  const COMMIT = 'c'.repeat(40);
  const ran = (project?: { commit: string; dirty: boolean }): RecordedAgent => ({
    v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local', ...(project ? { project } : {}),
  });
  const failing = (sessionId: string, overrides: Partial<Extract<ScoreLabel, { source: 'session' }>> = {}) => sessionLabel({
    subject: { platform: 'claude-code', sessionId }, label: 'missed-bug', score: 0, passed: false, ...overrides,
  });

  it('lists each failing label once, newest first, with its subject, the commit its work started at, and nothing that passed', () => {
    const labels = [
      viewed(failing('7c1e', { scoredAt: '2026-03-10T00:00:00.000Z' }), { agent: ran({ commit: COMMIT, dirty: false }) }),
      viewed(failing('7c1e', { scoredAt: '2026-03-12T00:00:00.000Z', runMode: 'attended' }), { agent: ran({ commit: COMMIT, dirty: false }), sessionName: 'claude-code_fix-retry_20260309' }),
      viewed(failing('9d2f', { scoredAt: '2026-03-11T00:00:00.000Z' }), { agent: ran({ commit: COMMIT, dirty: true }) }),
      viewed(failing('a0b1', { scoredAt: '2026-03-09T00:00:00.000Z' })),
      viewed(sessionLabel({ subject: { platform: 'claude-code', sessionId: 'passed' } })),
      viewed(failing('old', { scoredAt: '2026-01-01T00:00:00.000Z' }), { agent: ran({ commit: COMMIT, dirty: false }) }),
    ];
    const { window, failures } = ScorerResults.failures({ labels, windowDays: 30, now: NOW });
    expect(window.days).toBe(30);
    expect(failures.map(({ failure, start }) => [failure.subject, start])).toEqual([
      [{ platform: 'claude-code', sessionId: '7c1e' }, { commit: COMMIT }],
      [{ platform: 'claude-code', sessionId: '9d2f' }, { refused: 'tracked_changes' }],
      [{ platform: 'claude-code', sessionId: 'a0b1' }, { refused: 'not_recorded' }],
    ]);
    expect(failures[0]).toMatchObject({
      failure: { scorer: 'review-quality', label: 'missed-bug', author: 'alice', runMode: 'attended', scoredAt: '2026-03-12T00:00:00.000Z', agent: { tool: { name: 'claude' } } },
      session: { name: 'claude-code_fix-retry_20260309' },
    });
    expect(JSON.stringify(failures)).not.toContain('reasoning');
  });

  it('shows with each failing label where its work started, its regression task and its learnings, and counts what is covered and what can become a task', () => {
    const covered = { platform: 'claude-code', sessionId: '7c1e' };
    const labels = [
      viewed(failing('7c1e', { scoredAt: '2026-03-12T00:00:00.000Z' }), { agent: ran({ commit: COMMIT, dirty: false }) }),
      viewed(failing('9d2f', { scoredAt: '2026-03-11T00:00:00.000Z' }), { agent: ran({ commit: COMMIT, dirty: false }) }),
      viewed(failing('a0b1', { scoredAt: '2026-03-10T00:00:00.000Z' }), { agent: ran({ commit: COMMIT, dirty: true }) }),
    ];
    const links = {
      tasks: new Map([[JSON.stringify(covered), 'benchmarks/regressions/tasks/missed-null-check.yaml']]),
      learnings: new Map([[JSON.stringify(covered), [{ id: 'retry-loops-need-a-bound', path: '/tmp/l.md' }]]]),
    };
    const { selected } = ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW, links: { taskOf: (subject) => links.tasks.get(JSON.stringify(subject)), learningsOf: (subject) => links.learnings.get(JSON.stringify(subject)) ?? [] } });
    expect(selected?.failing.labels.map(({ start, task, learnings }) => ({ start, task, learnings }))).toEqual([
      { start: { commit: COMMIT }, task: 'benchmarks/regressions/tasks/missed-null-check.yaml', learnings: ['retry-loops-need-a-bound'] },
      { start: { commit: COMMIT }, task: undefined, learnings: [] },
      { start: { refused: 'tracked_changes' }, task: undefined, learnings: [] },
    ]);
    expect(selected?.failing).toMatchObject({ total: 3, covered: 1, startable: 1 });
  });

  it('gives each scorer its cohorts, and each model cohort its agreement with hand labels in both directions', () => {
    const labels = [
      viewed(failing('s1')),
      viewed(sessionLabel({ subject: { platform: 'claude-code', sessionId: 's2' } })),
      viewed(sessionLabel({ subject: { platform: 'claude-code', sessionId: 's1' }, judge: { kind: 'human' } })),
      viewed(sessionLabel({ subject: { platform: 'claude-code', sessionId: 's2' }, judge: { kind: 'human' }, label: 'missed-bug', score: 0, passed: false })),
    ];
    const { scorers, failures } = ScorerResults.failures({ labels, windowDays: 30, now: NOW });
    const [scorer] = scorers;
    expect(scorer?.scorer).toBe('review-quality');
    expect(scorer?.cohorts.map(({ judge, stats, agreement }) => ({ judge: judge.kind, stats: [stats.passed, stats.failed], agreement }))).toEqual([
      { judge: 'model', stats: [1, 1], agreement: { handLabelled: 2, paired: 2, agree: 0, judgePassedHumanFailed: 1, judgeFailedHumanPassed: 1 } },
      { judge: 'human', stats: [1, 1], agreement: undefined },
    ]);
    expect(failures.map(({ failure }) => [failure.subject, failure.cohort === scorer?.cohorts[0]?.id ? 'model' : 'human'])).toEqual([
      [{ platform: 'claude-code', sessionId: 's1' }, 'model'],
      [{ platform: 'claude-code', sessionId: 's2' }, 'human'],
    ]);
  });
});

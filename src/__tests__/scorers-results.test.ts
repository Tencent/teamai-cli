import { describe, expect, it } from 'vitest';
import type { RecordedAgent } from '../agent-observation.js';
import type { ScoreLabel } from '../scorers/label.js';
import { ScorerResults, type ViewedLabel } from '../scorers/results.js';

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
      { judge: { kind: 'model', tool: 'claude', model: { id: 'claude-haiku-5-5', reported: true, alias: 'fast' } }, n: 2 },
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
        ?.map((group) => `${group.kind === 'value' ? group.value : group.kind}${group.kind === 'value' && group.reported === false ? ' (requested)' : ''} n=${group.stats.n}`);

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

  it('lists the failing labels of a cohort newest first, with their author, platform, skills and session name only', () => {
    const labels = [
      viewed(sessionLabel({ passed: false, label: 'poor', scoredAt: '2026-03-12T00:00:00.000Z', used: { skills: ['tdd'] } }), { author: 'bob', sessionName: 'fix-login' }),
      viewed(sessionLabel({ passed: true })),
      viewed(sessionLabel({ passed: false, label: 'poor', scoredAt: '2026-03-15T00:00:00.000Z' })),
    ];
    expect(ScorerResults.of({ labels, query: { windowDays: 30 }, now: NOW }).selected?.failing).toEqual([
      { author: 'alice', scoredAt: '2026-03-15T00:00:00.000Z', label: 'poor', source: 'session', platform: 'claude' },
      { author: 'bob', scoredAt: '2026-03-12T00:00:00.000Z', label: 'poor', source: 'session', platform: 'claude', skills: ['tdd'], sessionName: 'fix-login' },
    ]);
  });

  it('keeps a recorded value named like none apart from labels that recorded none', () => {
    const labels = [
      viewed(sessionLabel({ passed: false, label: 'poor', used: { skills: ['none'] } })),
      viewed(sessionLabel({ passed: false, label: 'poor', used: { skills: [] } })),
    ];
    const selected = ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'skill' }, now: NOW }).selected;
    const keys = selected?.groups?.map((group) => group.key) ?? [];
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(selected?.failing.filter((row) => row.groups?.includes(key))).toHaveLength(1);
  });

  it('lists every failing label of a group, however many newer failing labels other groups have', () => {
    const failing = (skill: string, scoredAt: string) => viewed(sessionLabel({ passed: false, label: 'poor', scoredAt, used: { skills: [skill] } }));
    const labels = [
      failing('review', '2026-03-01T00:00:00.000Z'),
      ...Array.from({ length: 150 }, (_, index) => failing('tdd', `2026-03-10T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`)),
    ];
    const selected = ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'skill' }, now: NOW }).selected;
    const review = selected?.groups?.find((group) => group.kind === 'value' && group.value === 'review')?.key ?? 'missing';
    expect(selected?.failing.filter((row) => row.groups?.includes(review))).toHaveLength(1);
    expect(selected?.failing).toHaveLength(151);
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
});

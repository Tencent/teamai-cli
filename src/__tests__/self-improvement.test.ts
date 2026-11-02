import { describe, expect, it } from 'vitest';
import type { DigestFailure } from '../digest-failures.js';
import { SelfImprovement } from '../self-improvement.js';
import { canonicalJson } from '../utils/canonical-json.js';

const HERE = 'a'.repeat(40);
const ELSEWHERE = 'b'.repeat(40);

/** A failing label of `scorer` for session `sessionId`, judged by `judge`, whose work started as `start` says. */
function failing(sessionId: string, start: DigestFailure['start'], { scorer = 'review-quality', judge = 'model' }: { scorer?: string; judge?: 'model' | 'human' } = {}): DigestFailure {
  return {
    failure: {
      scorer, rubric: { sourceHash: 'rubric-1' }, label: 'missed-bug', score: 0, scoredAt: '2026-10-30T10:00:00.000Z', cohort: 'c1', author: 'alice',
      judge: judge === 'human' ? { kind: 'human' } : { kind: 'model', tool: 'claude', model: { id: 'claude-opus-5-5', isReported: true } },
      source: 'session', subject: { platform: 'claude-code', sessionId },
    },
    start,
    learnings: [],
  };
}

const session = (sessionId: string) => ({ platform: 'claude-code', sessionId });
const sessionIds = (failures: readonly DigestFailure[]) => failures.map(({ failure }) => ('sessionId' in failure.subject ? failure.subject.sessionId : failure.subject.runId));

describe('picking the failures a self-improvement starts from', () => {
  it('keeps the scorer\'s failures whose start commit this checkout has, each subject once, newest first', () => {
    const picked = SelfImprovement.pick({
      failures: [
        failing('s2', { commit: HERE }),
        failing('s1', { commit: HERE }),
        failing('s1', { refused: 'not_recorded' }, { judge: 'human' }),
        failing('s9', { commit: HERE }, { scorer: 'test-quality' }),
      ],
      scorer: 'review-quality',
      tasks: new Map(),
      hasCommit: (commit) => commit === HERE,
    });

    expect(sessionIds(picked.failures)).toEqual(['s2', 's1']);
    expect(picked.covered).toEqual([]);
    expect(picked.refused).toEqual([]);
  });

  it('lists a failure a task already names as covered by that task, once, instead of picking it', () => {
    const task = 'benchmarks/regressions/tasks/missed-null-check.yaml';
    const picked = SelfImprovement.pick({
      failures: [failing('s3', { commit: HERE }), failing('s1', { commit: HERE }), failing('s1', { commit: HERE }, { judge: 'human' })],
      scorer: 'review-quality',
      tasks: new Map([[canonicalJson(session('s1')), task]]),
      hasCommit: () => true,
    });

    expect(sessionIds(picked.failures)).toEqual(['s3']);
    expect(picked.covered).toEqual([task]);
  });

  it('refuses a failure no commit holds the start of, or whose commit this checkout lacks, saying why', () => {
    const picked = SelfImprovement.pick({
      failures: [
        failing('dirty', { refused: 'tracked_changes' }),
        failing('unseen', { refused: 'not_recorded' }),
        failing('other-project', { commit: ELSEWHERE }),
      ],
      scorer: 'review-quality',
      tasks: new Map(),
      hasCommit: (commit) => commit === HERE,
    });

    expect(picked.failures).toEqual([]);
    expect(picked.refused).toEqual([
      { subject: session('dirty'), why: 'tracked_changes' },
      { subject: session('unseen'), why: 'not_recorded' },
      { subject: session('other-project'), why: 'not_in_checkout' },
    ]);
  });
});

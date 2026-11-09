import { describe, expect, it } from 'vitest';
import { comparePair, formatExcluded, type PairSide } from '../benchmark/pairing.js';

const OPUS = { by: 'judge', rubric: 'rubric-a', tool: 'claude', model: 'claude-opus-5-5', effort: 'high', batched: true } as const;
const SONNET = { ...OPUS, model: 'claude-sonnet-5-5' } as const;
const CHECK = { by: 'check', task: 'task-a' } as const;

const side = (decider?: PairSide['decider'], taskHash = 'task-a'): PairSide => (decider === undefined ? { taskHash } : { taskHash, decider });

describe('comparePair', () => {
  it('excludes a pair whose task changed, whoever decided it (row 1)', () => {
    expect(comparePair(side(CHECK), side({ ...CHECK, task: 'task-b' }, 'task-b'))).toEqual({ kind: 'excluded', because: { kind: 'task_changed' } });
    expect(comparePair(side(OPUS), side(OPUS, 'task-b'))).toEqual({ kind: 'excluded', because: { kind: 'task_changed' } });
  });

  it.each([
    ['model', SONNET],
    ['rubric', { ...OPUS, rubric: 'rubric-b' }],
    ['tool', { ...OPUS, tool: 'codex' }],
    ['effort', { ...OPUS, effort: 'low' }],
    ['batched', { ...OPUS, batched: false }],
  ] as const)('excludes a pair both decided by a judge whose %s changed (row 2)', (_facet, to) => {
    expect(comparePair(side(OPUS), side(to))).toEqual({ kind: 'excluded', because: { kind: 'judge_changed', from: OPUS, to } });
  });

  it.each([
    ['both by the check', side(CHECK), side(CHECK)],
    ['one by the check and one by the judge', side(CHECK), side(OPUS)],
    ['both by the same judge', side(OPUS), side(OPUS)],
    ['a side nothing decided, as an error, not_run or unscored trial', side(OPUS), side()],
  ] as const)('compares a pair decided %s (row 3)', (_pair, from, to) => {
    expect(comparePair(from, to)).toEqual({ kind: 'compared' });
  });
});

describe('formatExcluded', () => {
  it("names a changed judge by its tool and model, and only the facets that changed besides", () => {
    expect(formatExcluded([{ pairs: 9, because: { kind: 'judge_changed', from: OPUS, to: SONNET } }])).toBe('9 excluded: their judge changed (claude claude-opus-5-5 → claude claude-sonnet-5-5)');
    expect(formatExcluded([{ pairs: 1, because: { kind: 'judge_changed', from: OPUS, to: { ...OPUS, effort: 'low', batched: false } } }]))
      .toBe('1 excluded: their judge changed (claude claude-opus-5-5 effort high batched → claude claude-opus-5-5 effort low alone)');
  });

  it('counts each reason when the pairs were excluded for more than one', () => {
    expect(formatExcluded([{ pairs: 2, because: { kind: 'task_changed' } }, { pairs: 3, because: { kind: 'judge_changed', from: OPUS, to: SONNET } }]))
      .toBe('5 excluded: 2 as their task changed, 3 as their judge changed (claude claude-opus-5-5 → claude claude-sonnet-5-5)');
  });
});

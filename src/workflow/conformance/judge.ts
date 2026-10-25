import type { JudgeConformanceScenario } from '../conformance-interpreter.js';

const JUDGED_WORKFLOW = `schemaVersion: v1alpha1
name: judged
description: A pass with a quality scorer.
steps:
  - id: work
    prompt: Review the change.
    scorers: [quality]
`;

const QUALITY_SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Missed the work }
passingScore: 0.5
samplingRate: 100
---
Judge the work.
`;

/** What `score --next` answers a driver that declares no judge, which never gets judge work. */
const NO_JUDGE = { error: { code: 'invalid_json' } };

export const judgeConformanceScenarios: JudgeConformanceScenario[] = [
  {
    name: 'a judge lease renews through running and settles only through score submission',
    yaml: JUDGED_WORKFLOW,
    scorers: { quality: QUALITY_SCORER },
    operations: [
      { kind: 'take', at: '2026-10-22T12:00:00.000Z', expect: { data: { lease: { expiresAt: '2026-10-22T12:30:00.000Z' } } } },
      { kind: 'renew', at: '2026-10-22T12:20:00.000Z', expect: { data: { idle: { open: 0, leased: 1 } } } },
      { kind: 'take', at: '2026-10-22T12:45:00.000Z', expect: { data: { lease: { expiresAt: '2026-10-22T12:50:00.000Z', handedBack: true } } } },
      { kind: 'report', expect: { error: { code: 'judge_lease' } } },
      { kind: 'submit', expect: { data: { label: { label: 'good', score: 1, passed: true } } } },
      { kind: 'idle', at: '2026-10-22T12:46:00.000Z', expect: { data: { idle: { open: 0, leased: 0 } } } },
    ],
    refusedBy: { 'skill-no-judge': NO_JUDGE },
  },
  {
    name: 'judge-ref-in-workflow-running: workflow next refuses a judge lease in running, leaves the run as it was, and the lease still renews',
    yaml: JUDGED_WORKFLOW,
    scorers: { quality: QUALITY_SCORER },
    operations: [
      { kind: 'take', at: '2026-10-22T12:00:00.000Z', expect: { data: { lease: { expiresAt: '2026-10-22T12:30:00.000Z' } } } },
      { kind: 'next', expect: { error: { code: 'judge_lease' } } },
      { kind: 'renew', at: '2026-10-22T12:20:00.000Z', expect: { data: { idle: { open: 0, leased: 1 } } } },
      { kind: 'take', at: '2026-10-22T12:45:00.000Z', expect: { data: { lease: { expiresAt: '2026-10-22T12:50:00.000Z', handedBack: true } } } },
    ],
    refusedBy: { 'skill-no-judge': NO_JUDGE },
  },
  {
    name: 'judge-renew-without-take: canTakeLease false renews the lease in running and takes no open work',
    yaml: JUDGED_WORKFLOW.replace('scorers: [quality]', 'scorers: [quality, depth]'),
    scorers: { quality: QUALITY_SCORER, depth: QUALITY_SCORER.replace('Judge the work.', 'Judge how deep the work goes.') },
    operations: [
      { kind: 'take', at: '2026-10-22T12:00:00.000Z', expect: { data: { lease: { scorer: 'quality', expiresAt: '2026-10-22T12:30:00.000Z' } } } },
      { kind: 'renew', at: '2026-10-22T12:20:00.000Z', canTakeLease: false, expect: { data: { idle: { open: 1, leased: 1 } } } },
      { kind: 'take', at: '2026-10-22T12:45:00.000Z', running: true, expect: { data: { lease: { scorer: 'depth', expiresAt: '2026-10-22T13:15:00.000Z' } } } },
      { kind: 'renew', at: '2026-10-22T12:46:00.000Z', canTakeLease: false, expect: { data: { idle: { open: 0, leased: 2 } } } },
    ],
    refusedBy: { 'skill-no-judge': NO_JUDGE },
  },
];

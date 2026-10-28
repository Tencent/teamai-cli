import { describe, it, expect } from 'vitest';
import { formatOutcomeLines } from '../digest.js';
import type { UserOutcomeStats, UserStats } from '../types.js';

function user(username: string, outcomes?: UserOutcomeStats): UserStats {
  return { username, updatedAt: '2026-10-27T00:00:00Z', skills: {}, outcomes };
}

describe('formatOutcomeLines (#1387)', () => {
  it('shows nothing before any member has reported a finished session', () => {
    expect(formatOutcomeLines([user('a'), user('b')])).toEqual([]);
  });

  it('adds up the team per run mode and outcome, with tokens and interventions per session', () => {
    const lines = formatOutcomeLines([
      user('a', {
        attended: { pr: { sessions: 8, tokens: { input: 3_000_000, output: 280_000 }, interventions: 49 } },
        notRecorded: { none: { sessions: 7, tokens: { input: 800_000, output: 40_000 }, interventions: 13 } },
      }),
      user('b', {
        attended: {
          pr: { sessions: 4, tokens: { input: 1_500_000, output: 140_000 }, interventions: 24 },
          learning: { sessions: 5, tokens: { input: 1_000_000, output: 100_000 }, interventions: 15 },
        },
        unattended: { pr: { sessions: 20, tokens: { input: 7_000_000, output: 600_000 }, interventions: 8 } },
      }),
    ]);

    expect(lines).toEqual([
      '  runMode       outcome    sessions   tokens/session   interventions/session',
      '  attended      pr         12         410.0K           6.1',
      '  attended      learning   5          220.0K           3.0',
      '  unattended    pr         20         380.0K           0.4',
      '  not recorded  none       7          120.0K           1.9',
      '  A session with a pull request and a learning is in both rows, so rows do not add up.',
    ]);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildImprovement } from '../dashboard/improvement.js';

const noMaintenance = { promote: [], prune: [], stale: [] };
let root: string;

function writeStats(name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, 'stats'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stats', `${name}.yaml`), YAML.stringify({ username: name, ...body }));
}

function writeSkill(namespace: string, name: string): void {
  fs.mkdirSync(path.join(root, 'repo', 'skills', namespace, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'repo', 'skills', namespace, name, 'SKILL.md'), `# ${name}\n`);
}

const paths = () => ({ statsDir: path.join(root, 'stats'), knowledgeRoot: path.join(root, 'repo') });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-improvement-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('the Improvement Center payload', () => {
  it('sums every member\'s published days, ending at the newest day anyone published', async () => {
    writeStats('ana', {
      updatedAt: '2026-10-23T01:00:00.000Z',
      daily: {
        '2026-10-22': { sessionsEnded: 3, sessionsSucceeded: 2, sessionsCorrected: 1, promptTurns: 9, costMicros: 1_500_000 },
        '2026-10-20': { sessionsEnded: 1, sessionsSucceeded: 1, promptTurns: 2 },
      },
    });
    writeStats('bo', {
      updatedAt: '2026-10-21T08:00:00.000Z',
      daily: { '2026-10-20': { sessionsEnded: 2, sessionsSucceeded: 2, promptTurns: 4, costMicros: 500_000 } },
    });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.window).toEqual({ days: 30, from: '2026-09-23', to: '2026-10-22', latestStats: '2026-10-23T01:00:00.000Z' });
    expect(data.members).toBe(2);
    expect(data.daily).toHaveLength(180);
    expect(data.daily.at(-1)).toMatchObject({ date: '2026-10-22', ended: 3, succeeded: 2, corrected: 1, prompts: 9, costMicros: 1_500_000, members: 1 });
    expect(data.daily.find((d) => d.date === '2026-10-20')).toMatchObject({ ended: 3, prompts: 6, costMicros: 500_000, members: 2 });
  });

  it('adds up friction across members without naming anyone', async () => {
    writeStats('ana', { interventions: { sessions: 10, interrupt: 2, toolReject: 1, correction: 3 } });
    writeStats('bo', { interventions: { sessions: 5, interrupt: 1, toolReject: 0, correction: 0 } });
    writeStats('cy', {});

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.friction).toEqual({ members: 2, sessions: 15, interrupt: 3, toolReject: 1, correction: 3 });
    expect(JSON.stringify(data)).not.toContain('"ana"');
  });

  it('splits team skills into used and unused, and lists skills several members use outside the team repo', async () => {
    writeSkill('tencent', 'tgit');
    writeSkill('tencent', 'cls-log');
    writeStats('ana', {
      daily: { '2026-10-22': { sessionsEnded: 1 } },
      skills: {
        tgit: { count: 4, lastUsed: '2026-10-22T03:00:00.000Z' },
        goal: { count: 2, lastUsed: '2026-10-21T03:00:00.000Z' },
        Users: { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
      },
    });
    writeStats('bo', {
      skills: {
        tgit: { count: 1, lastUsed: '2026-10-10T03:00:00.000Z' },
        goal: { count: 5, lastUsed: '2026-10-20T03:00:00.000Z' },
        'cls-log': { count: 7, lastUsed: '2026-08-01T03:00:00.000Z' },
      },
    });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.skills.teamTotal).toBe(2);
    expect(data.skills.used).toEqual([{ name: 'tgit', namespace: 'tencent', uses: 5, users: 2, lastUsed: '2026-10-22T03:00:00.000Z' }]);
    // cls-log was last used before the 30-day window.
    expect(data.skills.unused.map((s) => s.name)).toEqual(['cls-log']);
    // A path segment the usage tracker recorded is not a skill.
    expect(data.skills.outside.map((s) => s.name)).toEqual(['goal']);
  });

  it('passes the maintenance candidates through, and is empty when nothing has been published', async () => {
    const data = await buildImprovement(paths(), {
      promote: [{ docId: 'retry', title: 'Retry with backoff', suggestedCategory: 'skills', confidence: 0.95, upvotedCount: 6, userCount: 3 }],
      prune: [{ filename: 'old.md', confidence: 0.1, lastActivity: '2026-01-01', reason: 'inactive' }],
      stale: [],
    }, 4);

    expect(data.members).toBe(0);
    expect(data.daily.every((d) => d.ended === 0)).toBe(true);
    expect(data.maintenance).toEqual({
      promote: [{ docId: 'retry', title: 'Retry with backoff', category: 'skills', confidence: 0.95, upvoted: 6, users: 3 }],
      prune: [{ name: 'old.md', confidence: 0.1, lastActivity: '2026-01-01', reason: 'inactive' }],
      stale: [],
      silent: 4,
    });
  });
});

// SPDX-License-Identifier: MIT
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { mergeStatsWithinTeamSkills, teamSharedSkillNames } from '../team-push.js';
import type { UserStats } from '../types.js';

function stat(name: string, count = 1): { name: string; count: number; lastUsed: Date } {
  return { name, count, lastUsed: new Date('2026-10-12T10:00:00Z') };
}

describe('mergeStatsWithinTeamSkills (#1055 privacy filter)', () => {
  const teamSkills = new Set(['shared-skill', 'namespaced']);

  it('publishes only team-shared names from new usage events', () => {
    const merged = mergeStatsWithinTeamSkills(null, 'alice', [
      stat('shared-skill', 3),
      stat('my-private-skill', 7),
      stat('some-slash-command', 2),
    ], teamSkills);

    expect(Object.keys(merged.skills).sort()).toEqual(['shared-skill']);
    expect(merged.skills['shared-skill'].count).toBe(3);
  });

  it('prunes names published before the filter existed', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-10-01T00:00:00Z',
      skills: {
        'leaked-private-skill': { count: 5, lastUsed: '2026-10-01T00:00:00Z' },
        'shared-skill': { count: 2, lastUsed: '2026-10-01T00:00:00Z' },
      },
    };
    const merged = mergeStatsWithinTeamSkills(existing, 'alice', [stat('shared-skill')], teamSkills);

    expect(Object.keys(merged.skills).sort()).toEqual(['shared-skill']);
    expect(merged.skills['shared-skill'].count).toBe(3);
  });

  it('yields an empty skills map for a team that shares no skills', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-10-01T00:00:00Z',
      skills: { 'anything-at-all': { count: 1, lastUsed: '2026-10-01T00:00:00Z' } },
    };
    const merged = mergeStatsWithinTeamSkills(existing, 'alice', [stat('whatever')], new Set());

    expect(merged.skills).toEqual({});
  });

  it('keeps partial-report fields intact (#425)', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-10-01T00:00:00Z',
      skills: {},
      interventions: { sessions: 2, interrupt: 1, toolReject: 2, correction: 1 },
    };
    const merged = mergeStatsWithinTeamSkills(existing, 'alice', [], teamSkills);

    expect(merged.interventions).toBe(existing.interventions);
  });
});

describe('teamSharedSkillNames', () => {
  it('enumerates flat and namespaced skills from the team repo layout', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-catalog-'));
    try {
      await fse.ensureDir(path.join(repo, 'skills', 'flat-skill'));
      await fse.writeFile(path.join(repo, 'skills', 'flat-skill', 'SKILL.md'), '# flat');
      await fse.ensureDir(path.join(repo, 'skills', 'team-ns', 'nested-skill'));
      await fse.writeFile(path.join(repo, 'skills', 'team-ns', 'nested-skill', 'SKILL.md'), '# nested');
      await fse.ensureDir(path.join(repo, 'skills', 'not-a-skill'));

      const names = await teamSharedSkillNames(repo);
      expect([...names].sort()).toEqual(['flat-skill', 'nested-skill']);
    } finally {
      await fse.remove(repo);
    }
  });

  it('returns an empty set when the repo has no skills directory', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-empty-'));
    try {
      expect(await teamSharedSkillNames(repo)).toEqual(new Set());
    } finally {
      await fse.remove(repo);
    }
  });
});

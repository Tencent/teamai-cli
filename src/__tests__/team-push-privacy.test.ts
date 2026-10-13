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

  it('publishes built-in skills that never appear in the team catalog', () => {
    const merged = mergeStatsWithinTeamSkills(null, 'alice', [
      stat('teamai', 4),
      stat('my-private-skill', 2),
    ], new Set(['teamai']));

    expect(Object.keys(merged.skills).sort()).toEqual(['teamai']);
    expect(merged.skills['teamai'].count).toBe(4);
  });

  it('keeps names published before the filter existed (maintainer call on #1056)', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-10-01T00:00:00Z',
      skills: {
        'leaked-private-skill': { count: 5, lastUsed: '2026-10-01T00:00:00Z' },
        'shared-skill': { count: 2, lastUsed: '2026-10-01T00:00:00Z' },
      },
    };
    const merged = mergeStatsWithinTeamSkills(existing, 'alice', [stat('shared-skill')], teamSkills);

    expect(Object.keys(merged.skills).sort()).toEqual(['leaked-private-skill', 'shared-skill']);
    expect(merged.skills['shared-skill'].count).toBe(3);
    expect(merged.skills['leaked-private-skill'].count).toBe(5);
  });

  it('only blocks new additions for a team that shares no skills', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-10-01T00:00:00Z',
      skills: { 'anything-at-all': { count: 1, lastUsed: '2026-10-01T00:00:00Z' } },
    };
    const merged = mergeStatsWithinTeamSkills(existing, 'alice', [stat('whatever')], new Set());

    expect(Object.keys(merged.skills)).toEqual(['anything-at-all']);
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
  it('enumerates flat and namespaced skills plus built-ins', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-catalog-'));
    try {
      await fse.ensureDir(path.join(repo, 'skills', 'flat-skill'));
      await fse.writeFile(path.join(repo, 'skills', 'flat-skill', 'SKILL.md'), '# flat');
      await fse.ensureDir(path.join(repo, 'skills', 'team-ns', 'nested-skill'));
      await fse.writeFile(path.join(repo, 'skills', 'team-ns', 'nested-skill', 'SKILL.md'), '# nested');
      await fse.ensureDir(path.join(repo, 'skills', 'not-a-skill'));

      const names = await teamSharedSkillNames(repo);
      expect([...names].sort()).toEqual(['flat-skill', 'nested-skill', 'teamai']);
    } finally {
      await fse.remove(repo);
    }
  });

  it('still carries the built-in names when the repo has no skills directory', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-empty-'));
    try {
      expect(await teamSharedSkillNames(repo)).toEqual(new Set(['teamai']));
    } finally {
      await fse.remove(repo);
    }
  });
});

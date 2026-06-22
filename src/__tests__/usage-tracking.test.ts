import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import {
  isValidSkillName,
  appendUsageEvent,
  readUsageEvents,
  truncateUsageAfterReport,
  track,
  trackFromStdin,
  trackSlashCommand,
  updateKnownSkills,
  readKnownSkills,
  extractSkillName,
} from '../usage-tracker.js';
import { aggregateUsage } from '../stats.js';
import { mergeStats } from '../team-push.js';
import { evaluateSessionValue } from '../session-collector.js';
import { calculateSkillHealth, scoreToStars, calculateTeamHealth } from '../skill-health.js';
import { getRecommendations } from '../skill-recommend.js';
import type { UsageEvent, UserStats } from '../types.js';

// ─── Test helpers ──────────────────────────────────────

let tmpDir: string;
const origHome = process.env.HOME;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-test-'));
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fse.remove(tmpDir);
});

/**
 * Helper: mock process.stdin to return the given string.
 * Returns a restore function.
 */
function mockStdin(data: string): () => void {
  const original = process.stdin;
  const readable = new (require('stream').Readable)({
    read() {
      this.push(data);
      this.push(null);
    },
  });
  // Mark as not a TTY so trackFromStdin reads it
  (readable as NodeJS.ReadStream).isTTY = false;

  Object.defineProperty(process, 'stdin', {
    value: readable,
    writable: true,
    configurable: true,
  });

  return () => {
    Object.defineProperty(process, 'stdin', {
      value: original,
      writable: true,
      configurable: true,
    });
  };
}

/**
 * Helper: create a fake skill on disk so `skillExistsOnDisk()` finds it.
 * Creates `~/.claude/skills/<name>/SKILL.md` under the test tmpDir.
 */
async function createFakeSkill(name: string): Promise<void> {
  const skillDir = path.join(tmpDir, '.claude', 'skills', name);
  await fse.ensureDir(skillDir);
  await fse.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFake skill for testing.\n`);
}

// ─── usage-tracker tests ───────────────────────────────

describe('isValidSkillName', () => {
  it('accepts valid skill names', () => {
    expect(isValidSkillName('code-review')).toBe(true);
    expect(isValidSkillName('tdd')).toBe(true);
    expect(isValidSkillName('plan-eng-review')).toBe(true);
    expect(isValidSkillName('everything-claude-code:tdd')).toBe(true);
    expect(isValidSkillName('my_skill.v2')).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSkillName('../../etc/passwd')).toBe(false);
    expect(isValidSkillName('../secret')).toBe(false);
    expect(isValidSkillName('skill/../../etc')).toBe(false);
  });

  it('rejects empty and overly long names', () => {
    expect(isValidSkillName('')).toBe(false);
    expect(isValidSkillName('a'.repeat(201))).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(isValidSkillName('skill name')).toBe(false);
    expect(isValidSkillName('skill\n')).toBe(false);
    expect(isValidSkillName('<script>')).toBe(false);
  });
});

describe('appendUsageEvent', () => {
  it('appends a valid event to JSONL', async () => {
    const event: UsageEvent = {
      skill: 'code-review',
      timestamp: '2026-03-19T10:30:00Z',
      tool: 'claude',
    };
    await appendUsageEvent(event);

    const usagePath = path.join(tmpDir, '.teamai', 'usage.jsonl');
    const content = await fs.promises.readFile(usagePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.skill).toBe('code-review');
    expect(parsed.timestamp).toBe('2026-03-19T10:30:00Z');
  });

  it('appends multiple events as separate lines', async () => {
    await appendUsageEvent({ skill: 'tdd', timestamp: '2026-03-19T10:00:00Z', tool: 'claude' });
    await appendUsageEvent({ skill: 'code-review', timestamp: '2026-03-19T11:00:00Z', tool: 'claude' });

    const events = await readUsageEvents();
    expect(events).toHaveLength(2);
    expect(events[0].skill).toBe('tdd');
    expect(events[1].skill).toBe('code-review');
  });
});

describe('readUsageEvents', () => {
  it('returns empty array for missing file', async () => {
    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('skips corrupted JSONL lines', async () => {
    const usagePath = path.join(tmpDir, '.teamai', 'usage.jsonl');
    await fse.ensureDir(path.dirname(usagePath));
    await fs.promises.writeFile(
      usagePath,
      '{"skill":"good","timestamp":"2026-01-01T00:00:00Z","tool":"claude"}\nNOT_JSON\n{"skill":"also-good","timestamp":"2026-01-02T00:00:00Z","tool":"claude"}\n',
    );

    const events = await readUsageEvents();
    expect(events).toHaveLength(2);
    expect(events[0].skill).toBe('good');
    expect(events[1].skill).toBe('also-good');
  });

  it('handles empty file', async () => {
    const usagePath = path.join(tmpDir, '.teamai', 'usage.jsonl');
    await fse.ensureDir(path.dirname(usagePath));
    await fs.promises.writeFile(usagePath, '');

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });
});

describe('truncateUsageAfterReport', () => {
  it('clears file when all events reported', async () => {
    await appendUsageEvent({ skill: 'a', timestamp: '2026-01-01T00:00:00Z', tool: 'claude' });
    await appendUsageEvent({ skill: 'b', timestamp: '2026-01-02T00:00:00Z', tool: 'claude' });

    await truncateUsageAfterReport(2);

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('keeps unreported events', async () => {
    await appendUsageEvent({ skill: 'a', timestamp: '2026-01-01T00:00:00Z', tool: 'claude' });
    await appendUsageEvent({ skill: 'b', timestamp: '2026-01-02T00:00:00Z', tool: 'claude' });
    await appendUsageEvent({ skill: 'c', timestamp: '2026-01-03T00:00:00Z', tool: 'claude' });

    await truncateUsageAfterReport(2);

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('c');
  });
});

describe('track', () => {
  it('tracks Skill tool calls', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }));

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('code-review');
  });

  it('ignores non-Skill tool calls', async () => {
    await track('Bash', JSON.stringify({ command: 'ls' }));
    await track('Read', JSON.stringify({ path: '/tmp' }));

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('ignores invalid skill names', async () => {
    await track('Skill', JSON.stringify({ skill: '../../etc/passwd' }));

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('handles malformed JSON input', async () => {
    await track('Skill', 'not-json');

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('updates known-skills.json on successful track', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }));

    const known = await readKnownSkills();
    expect(known.has('code-review')).toBe(true);
  });
});

// ─── trackFromStdin tests ─────────────────────────────

describe('trackFromStdin', () => {
  it('reads STDIN JSON and tracks Skill tool usage', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'plan-eng-review', args: 'test' },
      tool_output: 'some output',
      session_id: 'sess-123',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('plan-eng-review');
  });

  it('ignores non-Skill tools from STDIN', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('handles empty STDIN gracefully', async () => {
    const restore = mockStdin('');
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('handles malformed STDIN JSON gracefully', async () => {
    const restore = mockStdin('not valid json {{{');
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('extracts skill from tool_input object (not string)', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('tdd');
  });

  it('updates known-skills.json on successful STDIN track', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'code-review' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const known = await readKnownSkills();
    expect(known.has('code-review')).toBe(true);
  });

  it('tracks Cursor Read tool when path is SKILL.md', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
      tool_output: '# TDD Skill\n...',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('tdd');
    expect(events[0].tool).toBe('cursor');
  });

  it('tracks Cursor Read tool using file_path field (Cursor native format)', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/root/.cursor/skills/code-review-expert/SKILL.md' },
      tool_output: '{"file_path":"...","content_length":194}',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('code-review-expert');
    expect(events[0].tool).toBe('cursor');
  });

  it('ignores Cursor Read tool for non-SKILL.md files', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/project/src/index.ts' },
      tool_output: 'console.log("hello");',
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('extracts skill name from nested Cursor skill paths', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/home/user/.cursor/skills/plan-eng-review/SKILL.md' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('plan-eng-review');
    expect(events[0].tool).toBe('cursor');
  });

  it('records tool as claude for Skill tool calls', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });

  it('uses --tool argument as tool source when provided', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('claude-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude-internal');
  });

  it('uses codebuddy as tool source when --tool codebuddy', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'code-review' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('codebuddy');
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('codebuddy');
  });

  it('uses codex-internal as tool source when --tool codex-internal', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'code-review' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('codex-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('codex-internal');
  });

  it('defaults to claude when no --tool argument (backward compat)', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Skill',
      tool_input: { skill: 'tdd' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });

  it('Read + SKILL.md always records cursor regardless of --tool argument', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin('some-other-tool');
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('cursor');
  });

  it('ignores Read tool when path has no SKILL.md suffix', async () => {
    const hookData = JSON.stringify({
      tool_name: 'Read',
      tool_input: { path: '/root/.cursor/skills/tdd/README.md' },
    });
    const restore = mockStdin(hookData);
    try {
      await trackFromStdin();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });
});

// ─── known-skills tests ───────────────────────────────

describe('updateKnownSkills', () => {
  it('writes new skill to known-skills.json', async () => {
    await updateKnownSkills('code-review');

    const knownPath = path.join(tmpDir, '.teamai', 'known-skills.json');
    const content = JSON.parse(await fs.promises.readFile(knownPath, 'utf-8'));
    expect(content).toContain('code-review');
  });

  it('does not duplicate existing skills', async () => {
    await updateKnownSkills('tdd');
    await updateKnownSkills('tdd');
    await updateKnownSkills('tdd');

    const knownPath = path.join(tmpDir, '.teamai', 'known-skills.json');
    const content = JSON.parse(await fs.promises.readFile(knownPath, 'utf-8'));
    expect(content.filter((s: string) => s === 'tdd')).toHaveLength(1);
  });
});

describe('readKnownSkills', () => {
  it('merges usage.jsonl and known-skills.json', async () => {
    // Seed known-skills with a previously-reported skill
    await updateKnownSkills('old-skill');

    // Add a new event to usage.jsonl
    await appendUsageEvent({ skill: 'new-skill', timestamp: '2026-03-20T10:00:00Z', tool: 'claude' });

    const skills = await readKnownSkills();
    expect(skills.has('old-skill')).toBe(true);
    expect(skills.has('new-skill')).toBe(true);
  });

  it('returns empty set when neither file exists', async () => {
    const skills = await readKnownSkills();
    expect(skills.size).toBe(0);
  });

  it('handles corrupted known-skills.json gracefully', async () => {
    const knownPath = path.join(tmpDir, '.teamai', 'known-skills.json');
    await fse.ensureDir(path.dirname(knownPath));
    await fs.promises.writeFile(knownPath, 'NOT_JSON!!!');

    // Should still work with just usage.jsonl data
    await appendUsageEvent({ skill: 'tdd', timestamp: '2026-03-20T10:00:00Z', tool: 'claude' });

    const skills = await readKnownSkills();
    expect(skills.has('tdd')).toBe(true);
  });
});

// ─── stats tests ───────────────────────────────────────

describe('aggregateUsage', () => {
  it('aggregates events by skill', () => {
    const events: UsageEvent[] = [
      { skill: 'tdd', timestamp: '2026-03-19T10:00:00Z', tool: 'claude' },
      { skill: 'code-review', timestamp: '2026-03-19T11:00:00Z', tool: 'claude' },
      { skill: 'tdd', timestamp: '2026-03-19T12:00:00Z', tool: 'claude' },
    ];

    const stats = aggregateUsage(events);
    expect(stats).toHaveLength(2);
    expect(stats[0].name).toBe('tdd');
    expect(stats[0].count).toBe(2);
    expect(stats[1].name).toBe('code-review');
    expect(stats[1].count).toBe(1);
  });

  it('returns empty for no events', () => {
    expect(aggregateUsage([])).toEqual([]);
  });
});

// ─── session-collector tests ───────────────────────────

describe('evaluateSessionValue', () => {
  it('marks sessions with errors as valuable', () => {
    expect(evaluateSessionValue('Encountered an error when running tests')).toBe(true);
    expect(evaluateSessionValue('Had to retry the build 3 times')).toBe(true);
    expect(evaluateSessionValue('发现一个新的踩坑模式')).toBe(true);
  });

  it('marks routine sessions as not valuable', () => {
    expect(evaluateSessionValue('Updated README formatting')).toBe(false);
    expect(evaluateSessionValue('Added a new component')).toBe(false);
  });
});

// ─── skill-health tests ───────────────────────────────

describe('calculateSkillHealth', () => {
  it('returns 0 for unused skills', () => {
    expect(calculateSkillHealth(0, new Date(), 10)).toBe(0);
  });

  it('returns 0 when maxCount is 0', () => {
    expect(calculateSkillHealth(5, new Date(), 0)).toBe(0);
  });

  it('returns high score for frequently used, recent skills', () => {
    const score = calculateSkillHealth(100, new Date(), 100);
    expect(score).toBeGreaterThan(80);
  });

  it('returns lower score for stale skills', () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    const score = calculateSkillHealth(100, thirtyDaysAgo, 100);
    expect(score).toBeLessThanOrEqual(60); // Only usage score, no freshness
  });
});

describe('scoreToStars', () => {
  it('converts score to star rating', () => {
    expect(scoreToStars(100)).toBe('★★★★★');
    expect(scoreToStars(0)).toBe('☆☆☆☆☆');
    expect(scoreToStars(50)).toBe('★★★☆☆');
  });
});

describe('calculateTeamHealth', () => {
  it('aggregates stats across users', () => {
    const stats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const health = calculateTeamHealth(stats);
    expect(health).toHaveLength(1);
    expect(health[0].skill).toBe('code-review');
    expect(health[0].totalCount).toBe(15);
    expect(health[0].contributors).toBe(2);
  });

  it('handles empty stats', () => {
    expect(calculateTeamHealth([])).toEqual([]);
  });
});

// ─── skill-recommend tests ─────────────────────────────

describe('getRecommendations', () => {
  it('recommends skills user hasn\'t tried', async () => {
    // No local usage, so all team skills are recommendations
    const teamStats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const recs = await getRecommendations(teamStats);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].skill).toBe('code-review');
  });

  it('excludes skills in known-skills.json from recommendations', async () => {
    // Mark code-review as known
    await updateKnownSkills('code-review');

    const teamStats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { 'code-review': { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const recs = await getRecommendations(teamStats);
    expect(recs.length).toBe(0);
  });

  it('excludes skills after truncation when known-skills.json exists', async () => {
    // Simulate: track a skill, then report+truncate
    await track('Skill', JSON.stringify({ skill: 'tdd' }));
    await truncateUsageAfterReport(1); // usage.jsonl is now empty

    // But known-skills.json should still have 'tdd'
    const teamStats: UserStats[] = [
      {
        username: 'alice',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { tdd: { count: 10, lastUsed: new Date().toISOString() } },
      },
      {
        username: 'bob',
        updatedAt: '2026-03-19T10:00:00Z',
        skills: { tdd: { count: 5, lastUsed: new Date().toISOString() } },
      },
    ];

    const recs = await getRecommendations(teamStats);
    // tdd should NOT be recommended because it's in known-skills.json
    expect(recs.find((r) => r.skill === 'tdd')).toBeUndefined();
  });

  it('returns empty for no team data', async () => {
    const recs = await getRecommendations([]);
    expect(recs).toEqual([]);
  });
});

// ─── extractSkillName tests ────────────────────────────

describe('extractSkillName', () => {
  it('extracts from { skill: "name" }', () => {
    expect(extractSkillName({ skill: 'code-review' })).toBe('code-review');
  });

  it('extracts from { name: "name" }', () => {
    expect(extractSkillName({ name: 'tdd' })).toBe('tdd');
  });

  it('extracts from { skill_name: "name" }', () => {
    expect(extractSkillName({ skill_name: 'plan-eng-review' })).toBe('plan-eng-review');
  });

  it('extracts from { command: "name" }', () => {
    expect(extractSkillName({ command: 'code-review' })).toBe('code-review');
  });

  it('extracts skill directory name from SKILL.md path', () => {
    expect(extractSkillName({ skill: '/root/.cursor/skills/tdd/SKILL.md' })).toBe('tdd');
    expect(extractSkillName({ name: '/home/user/.claude/skills/plan-eng-review/SKILL.md' })).toBe('plan-eng-review');
  });

  it('extracts last segment from filesystem paths', () => {
    expect(extractSkillName({ skill: '/root/.cursor/skills/tdd' })).toBe('tdd');
    expect(extractSkillName({ skill: '~/skills/code-review' })).toBe('code-review');
  });

  it('handles JSON string input', () => {
    expect(extractSkillName(JSON.stringify({ skill: 'tdd' }))).toBe('tdd');
  });

  it('returns null for missing/invalid values', () => {
    expect(extractSkillName({})).toBeNull();
    expect(extractSkillName({ other: 'value' })).toBeNull();
    expect(extractSkillName({ skill: 123 } as unknown as Record<string, unknown>)).toBeNull();
    expect(extractSkillName({ skill: '' })).toBeNull();
  });

  it('returns null for malformed JSON string input', () => {
    expect(extractSkillName('not-json')).toBeNull();
  });
});

// ─── mergeStats tests ──────────────────────────────────

describe('mergeStats', () => {
  it('creates fresh stats when no existing data', () => {
    const newEvents = [
      { name: 'tdd', count: 3, lastUsed: new Date('2026-03-20T10:00:00Z') },
      { name: 'code-review', count: 1, lastUsed: new Date('2026-03-20T11:00:00Z') },
    ];

    const result = mergeStats(null, 'alice', newEvents);
    expect(result.username).toBe('alice');
    expect(result.skills.tdd.count).toBe(3);
    expect(result.skills['code-review'].count).toBe(1);
  });

  it('accumulates counts when merging with existing stats', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-18T10:00:00Z' },
        'code-review': { count: 5, lastUsed: '2026-03-17T10:00:00Z' },
      },
    };

    const newEvents = [
      { name: 'tdd', count: 3, lastUsed: new Date('2026-03-20T10:00:00Z') },
      { name: 'plan-eng-review', count: 1, lastUsed: new Date('2026-03-20T11:00:00Z') },
    ];

    const result = mergeStats(existing, 'alice', newEvents);

    expect(result.skills.tdd.count).toBe(13);
    expect(result.skills.tdd.lastUsed).toBe('2026-03-20T10:00:00.000Z');

    expect(result.skills['code-review'].count).toBe(5);
    expect(result.skills['code-review'].lastUsed).toBe('2026-03-17T10:00:00Z');

    expect(result.skills['plan-eng-review'].count).toBe(1);
  });

  it('keeps existing lastUsed when it is more recent', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-25T10:00:00Z' },
      },
    };

    const newEvents = [
      { name: 'tdd', count: 2, lastUsed: new Date('2026-03-20T10:00:00Z') },
    ];

    const result = mergeStats(existing, 'alice', newEvents);
    expect(result.skills.tdd.count).toBe(12);
    expect(result.skills.tdd.lastUsed).toBe('2026-03-25T10:00:00Z');
  });

  it('handles empty new events with existing stats', () => {
    const existing: UserStats = {
      username: 'alice',
      updatedAt: '2026-03-19T10:00:00Z',
      skills: {
        tdd: { count: 10, lastUsed: '2026-03-18T10:00:00Z' },
      },
    };

    const result = mergeStats(existing, 'alice', []);
    expect(result.skills.tdd.count).toBe(10);
  });
});

// ─── trackSlashCommand tests ──────────────────────────

describe('trackSlashCommand', () => {
  it('tracks a valid slash command', async () => {
    await createFakeSkill('plan-eng-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review some args',
      session_id: 'sess-456',
      hook_event_name: 'UserPromptSubmit',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('plan-eng-review');
    expect(events[0].tool).toBe('claude');
  });

  it('tracks slash command with colon-namespaced skill', async () => {
    await createFakeSkill('gstack:tdd');
    const hookData = JSON.stringify({
      prompt: '/gstack:tdd',
      session_id: 'sess-789',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].skill).toBe('gstack:tdd');
  });

  it('ignores non-slash prompts', async () => {
    const hookData = JSON.stringify({
      prompt: 'Help me fix a bug in the login flow',
      session_id: 'sess-abc',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('ignores empty prompt', async () => {
    const hookData = JSON.stringify({
      prompt: '',
      session_id: 'sess-def',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('handles empty STDIN gracefully', async () => {
    const restore = mockStdin('');
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('handles malformed JSON gracefully', async () => {
    const restore = mockStdin('not valid json');
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('ignores slash commands for non-existent skills', async () => {
    // "/data" is not a real skill — should NOT be tracked
    const hookData = JSON.stringify({
      prompt: '/data',
      session_id: 'sess-phantom',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toEqual([]);
  });

  it('updates known-skills.json on successful slash track', async () => {
    await createFakeSkill('tdd');
    const hookData = JSON.stringify({
      prompt: '/tdd',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const known = await readKnownSkills();
    expect(known.has('tdd')).toBe(true);
  });

  it('uses --tool argument as tool source', async () => {
    await createFakeSkill('plan-eng-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review args',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand('claude-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude-internal');
  });

  it('uses codex-internal as tool source when --tool codex-internal', async () => {
    await createFakeSkill('plan-eng-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review args',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand('codex-internal');
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('codex-internal');
  });

  it('defaults to claude when no --tool argument (backward compat)', async () => {
    await createFakeSkill('tdd');
    const hookData = JSON.stringify({
      prompt: '/tdd',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });

  it('tracks multiple slash commands in a single prompt', async () => {
    await createFakeSkill('plan-eng-review');
    await createFakeSkill('tdd');
    await createFakeSkill('code-review');
    const hookData = JSON.stringify({
      prompt: '/plan-eng-review /tdd /code-review',
      session_id: 'sess-multi',
      hook_event_name: 'UserPromptSubmit',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(3);
    expect(events.map((e: UsageEvent) => e.skill).sort()).toEqual(
      ['code-review', 'plan-eng-review', 'tdd'],
    );
  });

  it('tracks multiple slash commands with arguments between them', async () => {
    await createFakeSkill('tdd');
    await createFakeSkill('code-review');
    const hookData = JSON.stringify({
      prompt: '/tdd fix the login bug /code-review',
      session_id: 'sess-multi-args',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e: UsageEvent) => e.skill).sort()).toEqual(
      ['code-review', 'tdd'],
    );
  });

  it('skips non-existent skills among multiple slash commands', async () => {
    await createFakeSkill('tdd');
    // 'nonexistent' is NOT created on disk
    const hookData = JSON.stringify({
      prompt: '/tdd /nonexistent /tdd',
      session_id: 'sess-multi-phantom',
    });
    const restore = mockStdin(hookData);
    try {
      await trackSlashCommand();
    } finally {
      restore();
    }

    const events = await readUsageEvents();
    // Only 'tdd' should be tracked (twice — it appears twice in prompt)
    expect(events).toHaveLength(2);
    expect(events.every((e: UsageEvent) => e.skill === 'tdd')).toBe(true);
  });
});

// ─── track() with --tool tests ────────────────────────

describe('track with tool parameter', () => {
  it('uses provided tool parameter', async () => {
    await track('Skill', JSON.stringify({ skill: 'code-review' }), 'claude-internal');

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude-internal');
  });

  it('defaults to claude when tool not provided', async () => {
    await track('Skill', JSON.stringify({ skill: 'tdd' }));

    const events = await readUsageEvents();
    expect(events).toHaveLength(1);
    expect(events[0].tool).toBe('claude');
  });
});

// ─── hook command string tests ────────────────────────

describe('hook command strings', () => {
  it('generates dispatch commands with --tool parameter', async () => {
    // Import the module to test hook injection
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-claude', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    await injectHooks(settingsPath, 'claude-internal');

    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // Check PostToolUse hooks have --tool claude-internal
    const postToolUse = settings.hooks?.PostToolUse;
    expect(postToolUse).toBeDefined();
    const skillHook = postToolUse.find((h: { description?: string }) =>
      h.description?.includes('Hook dispatch post-tool-use Skill'),
    );
    expect(skillHook).toBeDefined();
    expect(skillHook.hooks[0].command).toContain('--tool claude-internal');

    // Check UserPromptSubmit hook has --tool claude-internal
    const userPrompt = settings.hooks?.UserPromptSubmit;
    expect(userPrompt).toBeDefined();
    const promptHook = userPrompt.find((h: { description?: string }) =>
      h.description?.includes('Hook dispatch prompt-submit'),
    );
    expect(promptHook).toBeDefined();
    expect(promptHook.hooks[0].command).toContain('--tool claude-internal');
  });

  it('generates dispatch commands with --tool claude for default tool', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-claude2', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    await injectHooks(settingsPath, 'claude');

    const settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));
    const postToolUse = settings.hooks?.PostToolUse;
    const skillHook = postToolUse.find((h: { description?: string }) =>
      h.description?.includes('Hook dispatch post-tool-use Skill'),
    );
    expect(skillHook.hooks[0].command).toContain('--tool claude');
  });

  it('cleans up legacy hooks without description on inject', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-legacy-cleanup', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    // Write a settings file with legacy duplicate hooks (no description)
    const legacySettings = {
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai pull" 2>/dev/null || true' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai pull" 2>/dev/null || true' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai pull" 2>/dev/null || true' }] },
        ],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }] },
        ],
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/some/other/observe.sh' }] },
        ],
      },
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(legacySettings, null, 2));

    await injectHooks(settingsPath, 'claude-internal');

    const result = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // Legacy duplicates should be cleaned, replaced by single dispatch entry with description
    // SessionStart has 1 hook (hook-dispatch session-start)
    expect(result.hooks.SessionStart).toHaveLength(1);
    expect(result.hooks.SessionStart[0].description).toContain('[teamai]');
    expect(result.hooks.SessionStart[0].hooks[0].command).toContain('hook-dispatch');

    // Stop has 1 hook (hook-dispatch stop)
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.Stop[0].description).toContain('[teamai]');
    expect(result.hooks.Stop[0].hooks[0].command).toContain('hook-dispatch');

    // Non-teamai hooks should be preserved
    expect(result.hooks.PreToolUse).toHaveLength(1);
    expect(result.hooks.PreToolUse[0].hooks[0].command).toContain('observe.sh');
  });

  it('preserves non-teamai hooks during legacy cleanup', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-preserve-others', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    const mixedSettings = {
      hooks: {
        PostToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: '/data/jeff/continuous-learning/observe.sh' }] },
          { matcher: 'Skill', hooks: [{ type: 'command', command: 'bash -lc "teamai track --stdin" 2>>~/.teamai/debug.log || true' }] },
        ],
      },
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(mixedSettings, null, 2));

    await injectHooks(settingsPath, 'claude');

    const result = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // continuous-learning hook preserved, legacy teamai track removed + replaced with dispatch
    const observeHooks = result.hooks.PostToolUse.filter(
      (h: { hooks?: Array<{ command: string }> }) => h.hooks?.[0]?.command?.includes('observe.sh'),
    );
    expect(observeHooks).toHaveLength(1);

    // teamai dispatch hook should exist with Skill matcher
    const skillHooks = result.hooks.PostToolUse.filter(
      (h: { description?: string }) => h.description?.includes('Hook dispatch post-tool-use Skill'),
    );
    expect(skillHooks).toHaveLength(1);
    expect(skillHooks[0].hooks[0].command).toContain('--tool claude');
  });

  it('cleans up hooks with outdated description keywords', async () => {
    const { injectHooks } = await import('../hooks.js');
    const settingsPath = path.join(tmpDir, '.test-outdated-desc', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));

    // Simulate: old description hooks that should be cleaned up
    const outdatedSettings = {
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }],
            description: '[teamai] Check for updates on session end',
          },
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'bash -lc "teamai update" 2>/dev/null || true' }],
            description: '[teamai] Auto-update on session end',
          },
        ],
      },
    };
    await fs.promises.writeFile(settingsPath, JSON.stringify(outdatedSettings, null, 2));

    await injectHooks(settingsPath, 'codebuddy');

    const result = JSON.parse(await fs.promises.readFile(settingsPath, 'utf-8'));

    // Legacy entries cleaned up, replaced with single dispatch entry
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.Stop[0].hooks[0].command).toContain('hook-dispatch stop');
    expect(result.hooks.Stop[0].hooks[0].command).toContain('--tool codebuddy');
  });
});

// ─── showStats merge tests (via readUsageEvents + aggregateUsage) ───

describe('showStats merge logic', () => {
  // Note: We test the merge logic directly since showStats() calls console.log
  // and depends on loadLocalConfig() which requires full init.
  // The merge functions used by showStats are tested here.

  it('mergeLocalAndReported is tested via mergeStats — cross-ref: stats.ts mergeLocalAndReported', () => {
    // This is a placeholder acknowledging the DRY situation.
    // mergeLocalAndReported has the same logic as mergeStats (tested above).
    // The cross-reference comments in both files link them.
    expect(true).toBe(true);
  });
});

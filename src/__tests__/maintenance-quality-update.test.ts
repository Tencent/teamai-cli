// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

const logMocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() }));
vi.mock('../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger.js')>()),
  log: logMocks,
}));

import { findStaleEntries, findRelatedAdoptedLearnings, type StaleEntry } from '../maintenance/quality-update.js';

let tmp: string;
let votesDir: string;
let docsDir: string;
let rulesDir: string;
let skillsDir: string;
let learningsDir: string;

/** A v2 votes file: v1 carries only `at`, so it never reaches a counter threshold. */
function writeVotes(user: string, table: Record<string, { recalled: number; upvoted: number }>): void {
  const votes = Object.fromEntries(
    Object.entries(table).map(([docId, counts]) => [
      docId,
      { recalled_count: counts.recalled, upvoted_count: counts.upvoted, last_recalled_at: '2026-06-01T00:00:00Z' },
    ]),
  );

  fs.writeFileSync(path.join(votesDir, `${user}.yaml`), YAML.stringify({ version: 2, votes, deltas: {} }));
}

function writeFile(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function stale(docId: string, dir = docsDir): StaleEntry {
  return {
    docId,
    path: path.join(dir, `${docId}.md`),
    recalledCount: 9,
    upvotedCount: 0,
    userCount: 2,
    type: 'docs',
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-quality-update-'));
  votesDir = path.join(tmp, 'votes');
  docsDir = path.join(tmp, 'repo', 'docs');
  rulesDir = path.join(tmp, 'repo', 'rules');
  skillsDir = path.join(tmp, 'repo', 'skills');
  learningsDir = path.join(tmp, 'learnings');
  for (const dir of [votesDir, docsDir, rulesDir, learningsDir]) fs.mkdirSync(dir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('findStaleEntries locates an entry by the id its votes are kept under', () => {
  it('finds a docs entry, so the tests below are not passing on an empty scan', async () => {
    writeFile(path.join(docsDir, 'guide.md'), '# guide\n');
    writeVotes('alice', { guide: { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { guide: { recalled: 3, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ docId: 'guide', type: 'docs', recalledCount: 8, userCount: 2 });
  });

  it('finds a rule', async () => {
    writeFile(path.join(rulesDir, 'naming.md'), '# naming\n');
    writeVotes('alice', { naming: { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { naming: { recalled: 3, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries[0]).toMatchObject({ docId: 'naming', type: 'rules' });
  });

  it('finds a flat skill, whose id names a directory rather than a file', async () => {
    writeFile(path.join(skillsDir, 'flat-skill', 'SKILL.md'), '---\nname: flat-skill\n---\n');
    writeVotes('alice', { 'flat-skill': { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { 'flat-skill': { recalled: 3, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ docId: 'flat-skill', type: 'skills' });
    expect(entries[0].path).toBe(path.join(skillsDir, 'flat-skill', 'SKILL.md'));
  });

  it('finds a namespaced skill, which sits one level deeper', async () => {
    writeFile(path.join(skillsDir, 'pay', 'refund-skill', 'SKILL.md'), '---\nname: refund-skill\n---\n');
    writeVotes('alice', { 'refund-skill': { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { 'refund-skill': { recalled: 3, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ docId: 'refund-skill', type: 'skills' });
    expect(entries[0].path).toBe(path.join(skillsDir, 'pay', 'refund-skill', 'SKILL.md'));
  });

  it('prefers the flat layout when a skill exists in both', async () => {
    writeFile(path.join(skillsDir, 'dup-skill', 'SKILL.md'), '---\nname: dup-skill\n---\n');
    writeFile(path.join(skillsDir, 'pay', 'dup-skill', 'SKILL.md'), '---\nname: dup-skill\n---\n');
    writeVotes('alice', { 'dup-skill': { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { 'dup-skill': { recalled: 3, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries[0].path).toBe(path.join(skillsDir, 'dup-skill', 'SKILL.md'));
  });

  it('does not walk out of skills/ when the id is a path', async () => {
    writeFile(path.join(tmp, 'escape', 'SKILL.md'), '---\nname: escape\n---\n');
    writeVotes('alice', { '../escape': { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { '../escape': { recalled: 5, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries).toEqual([]);
  });
});

describe('findStaleEntries reports an entry it could not place', () => {
  it('warns once when an entry clears every threshold but no file matches', async () => {
    writeVotes('alice', { 'gone-skill': { recalled: 5, upvoted: 0 } });
    writeVotes('bob', { 'gone-skill': { recalled: 3, upvoted: 0 } });

    const entries = await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(entries).toEqual([]);
    expect(logMocks.warn).toHaveBeenCalledTimes(1);
    expect(logMocks.warn.mock.calls[0][0]).toContain('gone-skill');
  });

  it('stays quiet below the threshold, where an unplaceable id is just a learning', async () => {
    writeVotes('alice', { 'a-learning': { recalled: 2, upvoted: 0 } });
    writeVotes('bob', { 'a-learning': { recalled: 1, upvoted: 0 } });

    await findStaleEntries(votesDir, { docs: docsDir, rules: rulesDir, skills: skillsDir });

    expect(logMocks.warn).not.toHaveBeenCalled();
  });
});

describe('findRelatedAdoptedLearnings attaches what the entry is about', () => {
  function seedLearnings(): void {
    writeFile(
      path.join(learningsDir, 'deploy-canary.md'),
      '---\ntitle: deploy canary rollout\ntags: [deploy]\n---\n\n# deploy canary\n',
    );
    writeFile(
      path.join(learningsDir, 'billing-invoice.md'),
      '---\ntitle: billing invoice export\ntags: [billing]\n---\n\n# billing invoice\n',
    );
  }

  it('attaches the related learning even when five popular docs outrank it', async () => {
    seedLearnings();

    const votes: Record<string, { recalled: number; upvoted: number }> = {
      'deploy-rollback': { recalled: 9, upvoted: 0 },
      'deploy-canary': { recalled: 2, upvoted: 1 },
      'billing-invoice': { recalled: 2, upvoted: 1 },
    };
    for (const name of ['a', 'b', 'c', 'd', 'e']) votes[`doc-${name}`] = { recalled: 0, upvoted: 20 };
    writeVotes('alice', votes);

    const contents = await findRelatedAdoptedLearnings(stale('deploy-rollback'), votesDir, [learningsDir]);

    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain('deploy canary');
  });

  it('attaches nothing rather than padding with the most-opened entries', async () => {
    seedLearnings();
    writeVotes('alice', {
      'deploy-rollback': { recalled: 9, upvoted: 0 },
      'billing-invoice': { recalled: 2, upvoted: 1 },
    });

    const contents = await findRelatedAdoptedLearnings(stale('deploy-rollback'), votesDir, [learningsDir]);

    expect(contents).toEqual([]);
  });

  it('puts the closer learning first', async () => {
    writeFile(path.join(learningsDir, 'deploy-canary.md'), '---\ntitle: deploy canary\ntags: [deploy]\n---\n\n# canary\n');
    writeFile(path.join(learningsDir, 'deploy-runbook.md'), '---\ntitle: deploy runbook\n---\n\n# runbook\n');
    writeFile(
      path.join(learningsDir, 'deploy-rollback-notes.md'),
      '---\ntitle: deploy rollback notes\ntags: [deploy, rollback]\n---\n\n# rollback notes\n',
    );
    writeVotes('alice', {
      'deploy-rollback': { recalled: 9, upvoted: 0 },
      'deploy-canary': { recalled: 1, upvoted: 5 },
      'deploy-runbook': { recalled: 1, upvoted: 5 },
      'deploy-rollback-notes': { recalled: 1, upvoted: 1 },
    });

    const contents = await findRelatedAdoptedLearnings(stale('deploy-rollback'), votesDir, [learningsDir], { limit: 1 });

    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain('rollback notes');
  });

  it('counts a learning that lives in a namespace', async () => {
    writeFile(
      path.join(learningsDir, 'pay', 'refund-timeout.md'),
      '---\ntitle: refund timeout\ntags: [refund]\n---\n\n# refund timeout\n',
    );
    writeVotes('alice', {
      'refund-policy': { recalled: 9, upvoted: 0 },
      'pay/refund-timeout': { recalled: 1, upvoted: 2 },
    });

    const contents = await findRelatedAdoptedLearnings(stale('refund-policy'), votesDir, [learningsDir], {
      namespaces: ['pay'],
    });

    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain('refund timeout');
  });

  it('leaves the votes files on disk, as before', async () => {
    seedLearnings();
    writeVotes('alice', {
      'deploy-rollback': { recalled: 9, upvoted: 0 },
      'deploy-canary': { recalled: 2, upvoted: 1 },
    });
    const before = fs.readFileSync(path.join(votesDir, 'alice.yaml'), 'utf-8');

    await findRelatedAdoptedLearnings(stale('deploy-rollback'), votesDir, [learningsDir]);

    expect(fs.readFileSync(path.join(votesDir, 'alice.yaml'), 'utf-8')).toBe(before);
  });
});

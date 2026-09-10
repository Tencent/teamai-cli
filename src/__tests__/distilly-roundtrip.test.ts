import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { copyDir, readFileSafe } from '../utils/fs.js';
import { ensureSkillFrontmatter } from '../resources/skills.js';
import { splitFrontmatter } from '../utils/frontmatter.js';

// Exercises the exact two operations pullSingleSource() runs on a deployed
// skill (source.ts: `copyDir(skill.sourcePath, targetDir)` followed by the
// same frontmatter validation push runs via ensureSkillFrontmatter), against
// a SKILL.md carrying Distilly-style provenance metadata in frontmatter.
describe('Distilly export -> TeamAI source deploy round trip', () => {
  it('preserves custom provenance/version frontmatter fields byte-for-byte', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'distilly-rt-'));
    const sourceSkillDir = path.join(tmp, 'source', 'skills', 'hello-distilly');
    const targetSkillDir = path.join(tmp, 'deployed', '.claude', 'skills', 'hello-distilly');
    await fs.mkdir(sourceSkillDir, { recursive: true });

    const skillMd = `---
name: hello-distilly
description: Example skill exported from a Distilly profile.
distilly_source: profiles/onboarding-guide.md
distilly_version: 1.4.0
distilly_profile_id: 9f2c1a7e
provenance: https://github.com/titanwings/distilly/commit/abc1234
---

# Hello Distilly

This skill body is unrelated to the frontmatter under test.
`;
    await fs.writeFile(path.join(sourceSkillDir, 'SKILL.md'), skillMd, 'utf-8');

    // Step 1: the exact deploy call pullSingleSource() makes.
    await copyDir(sourceSkillDir, targetSkillDir);

    // Step 2: the exact validation call the push path makes on skills.
    const mutated = await ensureSkillFrontmatter(targetSkillDir, 'hello-distilly');
    expect(mutated).toBe(false); // already has name+description -> untouched

    const deployedRaw = await readFileSafe(path.join(targetSkillDir, 'SKILL.md'));
    expect(deployedRaw).toBe(skillMd); // byte-for-byte identical, not just field-equal

    const { data } = splitFrontmatter(deployedRaw!);
    expect(data['distilly_source']).toBe('profiles/onboarding-guide.md');
    expect(data['distilly_version']).toBe('1.4.0');
    expect(data['distilly_profile_id']).toBe('9f2c1a7e');
    expect(data['provenance']).toBe('https://github.com/titanwings/distilly/commit/abc1234');
  });
});

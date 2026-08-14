import { describe, it, expect } from 'vitest';
import { buildSkillChangePathspec } from '../digest.js';

/**
 * Regression for the self-mode digest bug: `getRecentSkillChanges` ran git log at
 * <repo>/.teamai (a subdirectory), so git emitted repo-root-relative paths like
 * `.teamai/skills/foo/SKILL.md` that never matched a bare `^skills/...` regex —
 * leaving the skill changelog permanently blank. buildSkillChangePathspec derives
 * both the pathspec and the match regex from the subdir so both layouts work.
 */
describe('buildSkillChangePathspec', () => {
  it('standalone team repo (no subdir): bare skills/ pathspec + regex', () => {
    const { pathspec, skillRe } = buildSkillChangePathspec();
    expect(pathspec).toBe('skills/*/SKILL.md');
    const m = 'skills/my-skill/SKILL.md'.match(skillRe);
    expect(m?.[1]).toBe('my-skill');
    // A .teamai-prefixed path must NOT match in standalone mode.
    expect('.teamai/skills/my-skill/SKILL.md'.match(skillRe)).toBeNull();
  });

  it('single-repo mode (.teamai subdir): prefixed pathspec + regex', () => {
    const { pathspec, skillRe } = buildSkillChangePathspec('.teamai');
    expect(pathspec).toBe('.teamai/skills/*/SKILL.md');
    // This is exactly the path git emits from the business-repo root — must match.
    const m = '.teamai/skills/my-skill/SKILL.md'.match(skillRe);
    expect(m?.[1]).toBe('my-skill');
    // A bare skills/ path (some other repo layout) must NOT match here.
    expect('skills/my-skill/SKILL.md'.match(skillRe)).toBeNull();
  });

  it('tolerates a trailing slash on subdir', () => {
    const { pathspec, skillRe } = buildSkillChangePathspec('.teamai/');
    expect(pathspec).toBe('.teamai/skills/*/SKILL.md');
    expect('.teamai/skills/x/SKILL.md'.match(skillRe)?.[1]).toBe('x');
  });

  it('does not match nested or partial paths', () => {
    const { skillRe } = buildSkillChangePathspec('.teamai');
    expect('.teamai/skills/a/b/SKILL.md'.match(skillRe)).toBeNull(); // too deep
    expect('.teamai/skills/a/README.md'.match(skillRe)).toBeNull();  // not SKILL.md
    expect('.teamai/skills/SKILL.md'.match(skillRe)).toBeNull();     // no skill dir
  });
});

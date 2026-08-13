import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
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

import { SkillsHandler } from '../resources/skills.js';
import { RulesHandler } from '../resources/rules.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

/**
 * Regression for single-repo mode: users edit team knowledge directly under
 * <repo>/.teamai/skills (it lives in their own repo), NOT in an AI tool dir like
 * ~/.claude/skills. `teamai push` must scan the active tree's .teamai/{skills,rules}
 * as a source, diffed against the knowledge worktree (origin/<default>), so a
 * hand-placed skill surfaces as "new" instead of "No new or modified resources".
 *
 * These tests exercise the exact scanner input pushCore builds in self mode: a
 * synthetic toolPaths entry pointing at '.teamai/skills' / '.teamai/rules', with
 * baseDir = business repo root (project scope) and localConfig.repo.localPath =
 * the worktree checkout that represents origin/<default>.
 */
describe('single-repo mode: push scans .teamai knowledge dir', () => {
  let tmpDir: string;
  let bizRoot: string; // business repo root (= project scope baseDir)
  let worktreeTeamai: string; // knowledge worktree's .teamai (= localConfig.repo.localPath)
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  // Mirrors the synthetic key pushCore injects for self-mode scanning.
  const SELF_KEY = '__teamai_self_knowledge__';

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-self-push-'));
    bizRoot = path.join(tmpDir, 'biz');
    // The knowledge worktree checkout of origin/<default>; its .teamai is the diff base.
    worktreeTeamai = path.join(tmpDir, 'biz', '.teamai', 'knowledge-wt', '.teamai');

    await fse.ensureDir(path.join(bizRoot, '.teamai', 'skills'));
    await fse.ensureDir(path.join(bizRoot, '.teamai', 'rules'));
    await fse.ensureDir(path.join(worktreeTeamai, 'skills'));
    await fse.ensureDir(path.join(worktreeTeamai, 'rules'));

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://github.com/acme/app.git',
      provider: 'github' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      // Self-mode scan config: the synthetic entry pushCore adds.
      toolPaths: {
        [SELF_KEY]: { skills: '.teamai/skills', rules: '.teamai/rules' },
      },
    };

    localConfig = {
      repo: {
        localPath: worktreeTeamai,
        remote: 'https://github.com/acme/app.git',
        kind: 'self',
        businessRepoRoot: path.join(tmpDir, 'biz', '.teamai', 'knowledge-wt'),
      },
      username: 'alice',
      scope: 'project',
      projectRoot: bizRoot,
      additionalRoles: [],
    };
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('detects a skill hand-placed under .teamai/skills as "new"', async () => {
    // User did: cp -rf ~/.claude/skills/handoff <repo>/.teamai/skills/
    const handoff = path.join(bizRoot, '.teamai', 'skills', 'handoff');
    await fse.ensureDir(handoff);
    await fse.writeFile(path.join(handoff, 'SKILL.md'), '# Handoff\nHand off work between sessions.');

    const items = await new SkillsHandler().scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'handoff');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
  });

  it('detects an edited skill under .teamai/skills as "modified"', async () => {
    // Base (origin/main) has v1; user edited the copy in the active tree to v2.
    const baseSkill = path.join(worktreeTeamai, 'skills', 'handoff');
    await fse.ensureDir(baseSkill);
    await fse.writeFile(path.join(baseSkill, 'SKILL.md'), '# Handoff v1');

    const activeSkill = path.join(bizRoot, '.teamai', 'skills', 'handoff');
    await fse.ensureDir(activeSkill);
    await fse.writeFile(path.join(activeSkill, 'SKILL.md'), '# Handoff v2');

    const items = await new SkillsHandler().scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'handoff');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
  });

  it('does NOT surface a skill already committed to main (identical content)', async () => {
    const content = '# Handoff\nsame';
    const baseSkill = path.join(worktreeTeamai, 'skills', 'handoff');
    await fse.ensureDir(baseSkill);
    await fse.writeFile(path.join(baseSkill, 'SKILL.md'), content);

    const activeSkill = path.join(bizRoot, '.teamai', 'skills', 'handoff');
    await fse.ensureDir(activeSkill);
    await fse.writeFile(path.join(activeSkill, 'SKILL.md'), content);

    const items = await new SkillsHandler().scanLocalForPush(teamConfig, localConfig);
    expect(items.map((i) => i.name)).not.toContain('handoff');
  });

  it('detects a rule hand-placed under .teamai/rules as "new"', async () => {
    await fse.writeFile(
      path.join(bizRoot, '.teamai', 'rules', 'coding-standards.md'),
      '# Coding Standards\nUse tabs.',
    );

    const items = await new RulesHandler().scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'coding-standards');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
  });
});

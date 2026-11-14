import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { buildRolePullContext } from '../resources/desired.js';
import type { LocalConfig } from '../types.js';

/**
 * Regression for PR #444 review (P1): clearing the active projects on a directory
 * whose team uses project partitioning must NOT fall through to an unfiltered
 * sync (which reinstalls every project's skills/rules). It must scope down and
 * mark the left projects' namespaces inactive for cleanup.
 */
describe('buildRolePullContext — cleared projects do not disable filtering', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-proj-'));
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), `
version: 1
projects:
  - id: alpha
    resources: { knowledge: [alpha], skills: [alpha], learnings: [alpha] }
  - id: billing
    resources: { knowledge: [billing], skills: [billing], learnings: [billing] }
`);
    // Skills laid out by namespace.
    await fse.outputFile(path.join(repoPath, 'skills', 'alpha', 'alpha-skill', 'SKILL.md'), '---\nname: alpha-skill\n---\n');
    await fse.outputFile(path.join(repoPath, 'skills', 'billing', 'billing-skill', 'SKILL.md'), '---\nname: billing-skill\n---\n');
  });

  afterEach(async () => {
    await fse.remove(repoPath);
  });

  const cfg = (projects: string[] | undefined): LocalConfig => ({
    repo: { localPath: repoPath, remote: 'x' },
    username: 'u',
    scope: 'project',
    additionalRoles: [],
    projectRoot: repoPath,
    ...(projects ? { projects } : {}),
  } as LocalConfig);

  it('active alpha → alpha skill active, billing inactive (to be pruned)', async () => {
    const ctx = await buildRolePullContext(cfg(['alpha']));
    expect(ctx).not.toBeNull();
    expect(ctx!.activeNamespaces.skills).toEqual(['alpha']);
    expect([...ctx!.activeSkillNames]).toEqual(['alpha-skill']);
    expect([...ctx!.inactiveSkillNames]).toEqual(['billing-skill']);
  });

  it('cleared projects ([]) still returns a context — NOT null — with all project skills inactive', async () => {
    const ctx = await buildRolePullContext(cfg([]));
    expect(ctx).not.toBeNull(); // the bug: this used to be null → unfiltered sync
    expect(ctx!.activeNamespaces.skills).toEqual([]);
    expect([...ctx!.activeSkillNames].sort()).toEqual([]);
    // both projects' skills are inactive → pull cleanup prunes them
    expect([...ctx!.inactiveSkillNames].sort()).toEqual(['alpha-skill', 'billing-skill']);
  });

  it('undefined projects (never configured) also filters when the team has a projects manifest', async () => {
    const ctx = await buildRolePullContext(cfg(undefined));
    expect(ctx).not.toBeNull();
    expect([...ctx!.inactiveSkillNames].sort()).toEqual(['alpha-skill', 'billing-skill']);
  });

  it('legacy repo with no manifests → null (unfiltered, backward compatible)', async () => {
    const bare = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-bare-'));
    try {
      const ctx = await buildRolePullContext({
        repo: { localPath: bare, remote: 'x' },
        username: 'u',
        scope: 'project',
        additionalRoles: [],
        projectRoot: bare,
      } as LocalConfig);
      expect(ctx).toBeNull();
    } finally {
      await fse.remove(bare);
    }
  });
});

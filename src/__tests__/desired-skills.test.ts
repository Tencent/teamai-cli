import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import { describeDeliveryConflict, resolveDesiredSkills, type DesiredSkills } from '../resources/desired.js';

/** The resolved skills, failing the test on a namespace collision. */
function resolved(result: Awaited<ReturnType<typeof resolveDesiredSkills>>): DesiredSkills {
  if (result.kind === 'conflict') throw new Error(`unexpected collision: ${describeDeliveryConflict(result)}`);
  return result;
}
import type { RolePullContext } from '../resources/desired.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The desired set is what `pull` installs and what `doctor` checks landed. Both
 * read it from here, so this is the one place role namespaces, tag subscriptions
 * and exclusions are combined (#598).
 */
describe('resolveDesiredSkills', () => {
  let tempDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  /** A role context activating the given skill namespaces. */
  function rolesOver(namespaces: string[]): RolePullContext {
    return {
      activeNamespaces: { knowledge: [], skills: namespaces, learnings: [], agents: [] },
      activeSkillNames: new Set(),
      inactiveSkillNames: new Set(),
      inactiveSkillSources: new Map(),
      inactiveDocsNamespaces: [],
    };
  }

  async function writeSkill(namespace: string, name: string): Promise<void> {
    const dir = path.join(repoPath, 'skills', namespace, name);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-desired-skills-'));
    repoPath = path.join(tempDir, 'team-repo');

    await writeSkill('common', 'shared-skill');
    await writeSkill('backend', 'backend-skill');
    await writeSkill('frontend', 'frontend-skill');
    await fse.writeFile(
      path.join(repoPath, 'tags.yaml'),
      'skills:\n  frontend-skill: [ui]\n  backend-skill: [server]\n',
    );

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fse.remove(tempDir);
  });

  /** Make the filesystem list every directory in the given order (#1577). */
  function listDirectories(order: 'ascending' | 'descending'): void {
    const readdir = fse.readdir.bind(fse);
    vi.spyOn(fse, 'readdir').mockImplementation((async (dir: string, options?: unknown) => {
      const entries = (await readdir(dir, options as { withFileTypes: true })) as unknown as { name: string }[];
      const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      return order === 'ascending' ? sorted : sorted.toReversed();
    }) as unknown as typeof fse.readdir);
  }

  describe.each(['ascending', 'descending'] as const)('without a role, with directories listed %s (#1577)', (order) => {
    it('delivers the shared skill over a namespace skill of the same name', async () => {
      await writeSkill('', 'release');
      await writeSkill('dev', 'release');
      listDirectories(order);

      const { items } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

      expect(items.filter((item) => item.name === 'release').map((item) => item.relativePath)).toEqual(['skills/release']);
    });

    it('names the namespace copy it skipped and the copy kept instead', async () => {
      await writeSkill('', 'release');
      await writeSkill('dev', 'release');
      listDirectories(order);

      const { shadowed } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

      expect(shadowed).toEqual([{ name: 'release', namespace: 'dev', skipped: 'skills/dev/release', kept: 'skills/release', receivingRoles: [] }]);
    });

    it('keeps the namespace that sorts first when no shared copy has the name', async () => {
      await writeSkill('ops', 'oncall');
      await writeSkill('dev', 'oncall');
      listDirectories(order);

      const { items, shadowed } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

      expect(items.filter((item) => item.name === 'oncall').map((item) => item.relativePath)).toEqual(['skills/dev/oncall']);
      expect(shadowed).toEqual([{ name: 'oncall', namespace: 'ops', skipped: 'skills/ops/oncall', kept: 'skills/dev/oncall', receivingRoles: [] }]);
    });

    it('orders by namespace name, so dev wins over dev-prod', async () => {
      await writeSkill('dev-prod', 'release');
      await writeSkill('dev', 'release');
      listDirectories(order);

      const { items } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

      expect(items.filter((item) => item.name === 'release').map((item) => item.relativePath)).toEqual(['skills/dev/release']);
    });
  });

  it('takes the union of the active role namespaces and the subscribed tags', async () => {
    localConfig.subscribedTags = ['ui'];

    const { items } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common'])));

    expect(items.map((i) => i.name).sort()).toEqual(['frontend-skill', 'shared-skill']);
  });

  it('names the roles that would deliver a skipped copy, from the roles manifest', async () => {
    await writeSkill('', 'release');
    await writeSkill('dev', 'release');
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: backend',
      '    resources: { knowledge: [backend], skills: [backend, dev] }',
      '  - id: platform',
      '    resources: { knowledge: [], skills: [dev] }',
      '  - id: design',
      '    resources: { knowledge: [], skills: [frontend] }',
      '',
    ].join('\n'));

    const { shadowed } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

    expect(shadowed).toEqual([{ name: 'release', namespace: 'dev', skipped: 'skills/dev/release', kept: 'skills/release', receivingRoles: ['backend', 'platform'] }]);
  });

  it('names no role that receives a second namespace with the same skill name, since that role cannot deliver either copy', async () => {
    await writeSkill('ops', 'release');
    await writeSkill('dev', 'release');
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: fullstack',
      '    resources: { knowledge: [], skills: [dev, ops] }',
      '  - id: sre',
      '    resources: { knowledge: [], skills: [ops] }',
      '',
    ].join('\n'));

    const { shadowed } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

    expect(shadowed).toEqual([{ name: 'release', namespace: 'ops', skipped: 'skills/ops/release', kept: 'skills/dev/release', receivingRoles: ['sre'] }]);
  });

  it('with a role that receives the namespace, delivers its copy over the shared one (#707)', async () => {
    await writeSkill('', 'release');
    await writeSkill('dev', 'release');

    const { items, shadowed } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['dev'])));

    expect(items.filter((item) => item.name === 'release').map((item) => item.relativePath)).toEqual(['skills/dev/release']);
    expect(shadowed).toEqual([]);
  });

  it('reports no skipped copy for a skill name the member excludes', async () => {
    await writeSkill('', 'release');
    await writeSkill('dev', 'release');
    localConfig.excludedSkills = ['release'];

    const { items, shadowed } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

    expect(items.map((item) => item.name)).not.toContain('release');
    expect(shadowed).toEqual([]);
  });

  it('drops excluded skills from the union', async () => {
    localConfig.subscribedTags = ['ui'];
    localConfig.excludedSkills = ['frontend-skill'];

    const { items } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common'])));

    expect(items.map((i) => i.name)).toEqual(['shared-skill']);
  });

  it('without a role context, every skill in the repo is desired', async () => {
    const { items } = resolved(await resolveDesiredSkills(teamConfig, localConfig, null));

    expect(items.map((i) => i.name).sort())
      .toEqual(['backend-skill', 'frontend-skill', 'shared-skill']);
  });

  it('reports the whole team repo separately, so cleanup knows what it may prune', async () => {
    const { items, teamItems, skippedByTags } = resolved(await resolveDesiredSkills(
      teamConfig,
      localConfig,
      rolesOver(['common']),
    ));

    expect(items.map((i) => i.name)).toEqual(['shared-skill']);
    expect(teamItems.map((i) => i.name).sort())
      .toEqual(['backend-skill', 'frontend-skill', 'shared-skill']);
    expect(teamItems.every((i) => i.sourcePath.startsWith(repoPath))).toBe(true);
    // No subscriptions active, so nothing was filtered out by the tag channel.
    expect(skippedByTags).toBe(0);
  });

  it('counts what the tag filter left out', async () => {
    localConfig.subscribedTags = ['ui'];

    const { skippedByTags } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common'])));

    // backend-skill carries a tag the user is not subscribed to.
    expect(skippedByTags).toBe(1);
  });

  it('writes nothing: doctor calls it on a machine it must not change', async () => {
    const before = await fse.readdir(tempDir);

    await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common']));

    expect(await fse.readdir(tempDir)).toEqual(before);
    expect(await fse.pathExists(path.join(tempDir, '.claude'))).toBe(false);
  });
});

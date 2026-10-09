import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  async function writeRootSkill(name: string): Promise<void> {
    const dir = path.join(repoPath, 'skills', name);
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
    await fse.remove(tempDir);
  });

  it('takes the union of the active role namespaces and the subscribed tags', async () => {
    localConfig.subscribedTags = ['ui'];

    const { items } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common'])));

    expect(items.map((i) => i.name).sort()).toEqual(['frontend-skill', 'shared-skill']);
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

  // The root is shared: a member with a role context but no active skill
  // namespace (no role, no active project, yet the team has projects.yaml)
  // still receives every root skill — and cleanup keeps them.
  it('delivers the shared root skills when the role context activates no namespaces', async () => {
    await writeRootSkill('root-one');
    await writeRootSkill('root-two');

    const { items, overrides } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver([])));

    expect(items.map((i) => i.name).sort()).toEqual(['root-one', 'root-two']);
    expect(items.every((i) => i.namespace === undefined)).toBe(true);
    expect(overrides).toEqual([]);
  });

  it('unions root and active namespace skills, the namespace entry replacing the root of its name', async () => {
    await writeRootSkill('shared-skill');
    await writeRootSkill('root-only');

    const { items, overrides } = resolved(await resolveDesiredSkills(teamConfig, localConfig, rolesOver(['common'])));

    const byName = new Map(items.map((item) => [item.name, item]));
    expect([...byName.keys()].sort()).toEqual(['root-only', 'shared-skill']);
    // One delivered `shared-skill`, and it is the namespace copy, never the root.
    expect(byName.get('shared-skill')?.namespace).toBe('common');
    expect(byName.get('shared-skill')?.relativePath).toBe('skills/common/shared-skill');
    expect(overrides).toEqual([
      { name: 'shared-skill', source: 'skills/common/shared-skill', replaces: 'skills/shared-skill' },
    ]);
  });
});

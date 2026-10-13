import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import { collectRulesInventory } from '../dashboard/resources.js';
import type { RolePullContext } from '../resources/desired.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The dashboard's Resources page (#1028) lists what `pull` delivers, so this
 * inventory must read the same channels `resolveDesiredRules` combines: root
 * rules for everyone, namespaced rules by active knowledge namespace, the tag
 * channel, and the root rule an active namespace rule replaces.
 */
describe('collectRulesInventory', () => {
  let tempDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  /** A role context activating the given knowledge namespaces. */
  function rolesOver(namespaces: string[]): RolePullContext {
    return {
      activeNamespaces: { knowledge: namespaces, skills: [], learnings: [], agents: [] },
      activeSkillNames: new Set(),
      inactiveSkillNames: new Set(),
      inactiveSkillSources: new Map(),
      inactiveDocsNamespaces: [],
    };
  }

  async function writeRule(rel: string, frontmatter = ''): Promise<void> {
    const file = path.join(repoPath, 'rules', rel);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, `${frontmatter}# ${rel}\n`);
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dashboard-resources-'));
    repoPath = path.join(tempDir, 'team-repo');

    await writeRule('style.md', '---\ndescription: Team style guide\n---\n');
    await writeRule('api.md');
    await writeRule('backend/api.md');
    await writeRule('frontend/ui.md');
    await fse.writeFile(
      path.join(repoPath, 'tags.yaml'),
      'rules:\n  backend/api: [server]\n  frontend/ui: [client]\n',
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

  it('without a role context, every rule is delivered', async () => {
    const rules = await collectRulesInventory(teamConfig, localConfig, null);

    expect(rules.map((rule) => [rule.name, rule.delivered])).toEqual([
      ['api', true],
      ['backend/api', true],
      ['frontend/ui', true],
      ['style', true],
    ]);
  });

  it('marks namespace rules outside the active namespaces and the roots they replace', async () => {
    const rules = await collectRulesInventory(teamConfig, localConfig, rolesOver(['backend']));

    // The root api.md is replaced by the active backend/api.md (#707).
    expect(rules.map((rule) => [rule.name, rule.delivered, rule.undeliveredReason])).toEqual([
      ['api', false, 'replaced'],
      ['backend/api', true, undefined],
      ['frontend/ui', false, 'namespace'],
      ['style', true, undefined],
    ]);
  });

  it('marks rules the tag channel left out', async () => {
    localConfig.subscribedTags = ['client'];

    const rules = await collectRulesInventory(teamConfig, localConfig, rolesOver(['backend', 'frontend']));

    expect(rules.map((rule) => [rule.name, rule.delivered, rule.undeliveredReason])).toEqual([
      ['api', true, undefined],
      ['backend/api', false, 'tags'],
      ['frontend/ui', true, undefined],
      ['style', true, undefined],
    ]);
  });

  it('reports name, namespace, repo path and frontmatter description only', async () => {
    const rules = await collectRulesInventory(teamConfig, localConfig, null);
    const style = rules.find((rule) => rule.name === 'style');
    const namespaced = rules.find((rule) => rule.name === 'backend/api');

    expect(style).toMatchObject({
      name: 'style', namespace: null, path: 'rules/style.md', description: 'Team style guide',
    });
    expect(namespaced).toMatchObject({
      name: 'backend/api', namespace: 'backend', path: 'rules/backend/api.md', description: null,
    });
  });

  it('returns an empty inventory for a repo without rules', async () => {
    await fse.remove(path.join(repoPath, 'rules'));

    await expect(collectRulesInventory(teamConfig, localConfig, null)).resolves.toEqual([]);
  });
});

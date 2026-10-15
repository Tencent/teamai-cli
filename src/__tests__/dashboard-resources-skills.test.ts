import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import {
  collectSkillsInventory,
  setSkillExclusion,
  skillDetail,
} from '../dashboard/resources-skills.js';
import type { RolePullContext } from '../resources/desired.js';
import { loadState } from '../config.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The skills inventory behind the Resources page (#1123): every skill in the
 * team repo with its delivery state for this scope, its personal exclusion
 * state, and which agents have it installed. Metadata only — no SKILL.md
 * bodies, no environment values.
 */
describe('collectSkillsInventory', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  function rolesOver(namespaces: string[]): RolePullContext {
    return {
      activeNamespaces: { knowledge: [], skills: namespaces, learnings: [], agents: [] },
      activeSkillNames: new Set(),
      inactiveSkillNames: new Set(),
      inactiveSkillSources: new Map(),
      inactiveDocsNamespaces: [],
    };
  }

  async function writeSkill(rel: string, frontmatter = '', contributors: string[] = []): Promise<void> {
    const dir = path.join(repoPath, 'skills', rel);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `${frontmatter}# ${rel}\nSECRET SKILL BODY ${rel}\n`);
    if (contributors.length > 0) {
      await fse.writeFile(path.join(dir, 'CONTRIBUTORS'), `${contributors.join('\n')}\n`);
    }
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dashboard-skills-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    await fse.ensureDir(homeDir);

    await writeSkill('review', '---\nname: review\ndescription: Review code changes\n---\n', ['alice', 'bob']);
    await writeSkill('deploy', '---\nname: deploy\ndescription: Deploy the service\n---\n');
    await writeSkill('backend/api', '---\nname: api\ndescription: Serve the API\n---\n');
    await writeSkill('frontend/ui', '---\nname: ui\ndescription: Build the UI\n---\n');
    await fse.writeFile(
      path.join(repoPath, 'tags.yaml'),
      'skills:\n  deploy: [ops]\n  ui: [client]\n',
    );

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
      dataHome: path.join(homeDir, '.teamai'),
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
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await fse.remove(tempDir);
  });

  it('without a role context, every skill is delivered with metadata only', async () => {
    const skills = await collectSkillsInventory(teamConfig, localConfig, null);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    expect(byName.get('review')).toMatchObject({
      namespace: null,
      description: 'Review code changes',
      contributors: ['alice', 'bob'],
      delivered: true,
      excluded: false,
    });
    // Metadata only: the SKILL.md body must never cross into the inventory.
    expect(JSON.stringify(skills)).not.toContain('SECRET SKILL BODY');
  });

  it('attributes namespace, tags, and replaced states like the rules inventory', async () => {
    const roleContext = rolesOver(['backend']);
    localConfig = { ...localConfig, subscribedTags: ['client'] };
    const skills = await collectSkillsInventory(teamConfig, localConfig, roleContext);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    // Active namespace: delivered.
    expect(byName.get('api')).toMatchObject({ namespace: 'backend', delivered: true });
    // Root skill outside the namespace scan, no tag brings it: namespace.
    expect(byName.get('review')).toMatchObject({ undeliveredReason: 'namespace' });
    // Tag channel brings deploy (subscribed ops? no — deploy is [ops], not
    // subscribed): tags.
    expect(byName.get('deploy')).toMatchObject({ undeliveredReason: 'tags' });
    // ui is [client] and subscribed: delivered by the tag channel.
    expect(byName.get('ui')).toMatchObject({ delivered: true });
  });

  it('marks a personally excluded skill and lets exclusion win over delivery', async () => {
    localConfig = { ...localConfig, excludedSkills: ['review'] };
    const skills = await collectSkillsInventory(teamConfig, localConfig, null);
    const review = skills.find((skill) => skill.name === 'review');
    expect(review).toMatchObject({ excluded: true, delivered: false, undeliveredReason: 'excluded' });
  });

  it('lists the agents that have the skill installed on disk', async () => {
    // claude has review installed; the other configured tool does not.
    const claudeDir = path.join(homeDir, '.claude', 'skills', 'review');
    await fse.ensureDir(claudeDir);
    await fse.writeFile(path.join(claudeDir, 'SKILL.md'), '# review\n');
    const skills = await collectSkillsInventory(teamConfig, localConfig, null);
    const review = skills.find((skill) => skill.name === 'review');
    expect(review!.installedAgents).toEqual(['claude']);
    const deploy = skills.find((skill) => skill.name === 'deploy');
    expect(deploy!.installedAgents).toEqual([]);
  });

  it('serves one skill detail with tags from the tag catalog', async () => {
    const detail = await skillDetail(teamConfig, localConfig, null, 'deploy');
    expect(detail).toMatchObject({ name: 'deploy', description: 'Deploy the service' });
    expect(detail!.tags).toEqual(['ops']);
    expect(JSON.stringify(detail)).not.toContain('SECRET SKILL BODY');
  });

  it('returns null for an unknown skill detail', async () => {
    expect(await skillDetail(teamConfig, localConfig, null, 'nope')).toBeNull();
  });
});

describe('setSkillExclusion', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dashboard-skills-excl-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    await fse.ensureDir(homeDir);
    await fse.ensureDir(path.join(repoPath, 'skills', 'review'));
    await fse.writeFile(path.join(repoPath, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review\n---\nbody\n');
    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
      dataHome: path.join(homeDir, '.teamai'),
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
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await fse.remove(tempDir);
  });

  it('excludes a known skill, persists the config, and invalidates the pull fast path', async () => {
    const result = await setSkillExclusion(teamConfig, localConfig, 'review', true);
    expect(result).toMatchObject({ ok: true, skill: { name: 'review', excluded: true, delivered: false } });
    // The persisted config carries the exclusion.
    const { loadLocalConfig } = await import('../config.js');
    const reloaded = await loadLocalConfig();
    expect(reloaded?.excludedSkills).toContain('review');
    // The pull fast path is invalidated: lastPullRev must be null.
    const state = await loadState();
    expect(state.lastPullRev).toBeNull();
  });

  it('rejects an unknown skill name', async () => {
    const result = await setSkillExclusion(teamConfig, localConfig, 'nope', true);
    expect(result).toEqual({ ok: false, error: 'unknown_skill' });
  });

  it('re-includes a skill and drops the empty list', async () => {
    await setSkillExclusion(teamConfig, localConfig, 'review', true);
    const result = await setSkillExclusion(teamConfig, localConfig, 'review', false);
    expect(result).toMatchObject({ ok: true, skill: { name: 'review', excluded: false, delivered: true } });
    const { loadLocalConfig } = await import('../config.js');
    const reloaded = await loadLocalConfig();
    expect(reloaded?.excludedSkills ?? []).toEqual([]);
  });
});

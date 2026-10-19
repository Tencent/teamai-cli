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

  it('keeps the inventory through a delivery conflict, with the conflict exposed separately (#1143 P2)', async () => {
    // Two members deliver a different copy of one skill name: pull stops the
    // run and keeps what is installed (#913/#707), but the inventory must stay.
    await writeSkill('backend/shared', '---\nname: shared\ndescription: Backend copy\n---\n');
    await writeSkill('frontend/shared', '---\nname: shared\ndescription: Frontend copy\n---\n');
    const roles = rolesOver(['backend', 'frontend']);

    const inventory = await collectSkillsInventory(teamConfig, localConfig, roles);

    expect(inventory.skillConflict).toContain('shared');
    // The inventory lists every catalogued skill; a conflicted run delivers none.
    expect(inventory.skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(['review', 'ui', 'shared']));
    expect(inventory.skills.every((skill) => !skill.delivered)).toBe(true);
    // Exclusions keep working through a conflict: the name is known, so the
    // exclusion is accepted rather than rejected as unknown_skill.
    const result = await setSkillExclusion(teamConfig, localConfig, 'shared', true);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it('skillDetail resolves a same-name copy by source path; name-only prefers the delivered one (#1143 P2)', async () => {
    // A namespaced copy of the root review skill: same name, different source.
    await writeSkill('backend/review', '---\nname: review\ndescription: Namespaced review copy\n---\n');
    const roles = rolesOver(['backend']);

    // Paths come from the inventory itself, so the test speaks its identity.
    const { skills: inventory } = await collectSkillsInventory(teamConfig, localConfig, roles);
    const root = inventory.find((skill) => skill.namespace === null && skill.name === 'review');
    const namespaced = inventory.find((skill) => skill.namespace === 'backend' && skill.name === 'review');
    expect(root?.delivered).toBe(false);
    expect(root?.undeliveredReason).toBe('replaced');
    expect(namespaced?.delivered).toBe(true);

    // Source-path lookup returns each copy unambiguously.
    expect((await skillDetail(teamConfig, localConfig, roles, 'review', namespaced?.path))?.namespace).toBe('backend');
    expect((await skillDetail(teamConfig, localConfig, roles, 'review', root?.path))?.namespace).toBeNull();

    // A name-only lookup cannot land on the replaced root while a delivered copy exists.
    expect((await skillDetail(teamConfig, localConfig, roles, 'review'))?.namespace).toBe('backend');
  });

  it('without a role context, every skill is delivered with metadata only', async () => {
    const skills = (await collectSkillsInventory(teamConfig, localConfig, null)).skills;
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
    const skills = (await collectSkillsInventory(teamConfig, localConfig, roleContext)).skills;
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

  it('marks a root skill replaced when an active namespace copy delivers (#1143 P1)', async () => {
    // Root review AND backend/review share the basename; only the namespace
    // copy delivers. The root entry must say `replaced`, not `delivered`.
    await writeSkill('backend/review', '---\nname: review\ndescription: Namespaced copy\n---\n');
    const roleContext = rolesOver(['backend']);
    const skills = (await collectSkillsInventory(teamConfig, localConfig, roleContext)).skills;
    const byPath = new Map(skills.map((skill) => [skill.path, skill]));
    expect(byPath.get('skills/backend/review')).toMatchObject({ delivered: true, undeliveredReason: undefined });
    expect(byPath.get('skills/review')).toMatchObject({ delivered: false, undeliveredReason: 'replaced' });
  });

  it('labels the losing same-name copy replaced without a role context too', async () => {
    // No roles: the name-keyed merge keeps the scan-order winner (the root
    // copy here); the namespaced twin's truthful label is `replaced`.
    await writeSkill('backend/review', '---\nname: review\ndescription: Namespaced copy\n---\n');
    const skills = (await collectSkillsInventory(teamConfig, localConfig, null)).skills;
    const byPath = new Map(skills.map((skill) => [skill.path, skill]));
    expect(byPath.get('skills/review')).toMatchObject({ delivered: true, undeliveredReason: undefined });
    expect(byPath.get('skills/backend/review')).toMatchObject({ delivered: false, undeliveredReason: 'replaced' });
  });

  it('marks a personally excluded skill and lets exclusion win over delivery', async () => {
    localConfig = { ...localConfig, excludedSkills: ['review'] };
    const skills = (await collectSkillsInventory(teamConfig, localConfig, null)).skills;
    const review = skills.find((skill) => skill.name === 'review');
    expect(review).toMatchObject({ excluded: true, delivered: false, undeliveredReason: 'excluded' });
  });

  it('lists the agents that have the skill installed on disk', async () => {
    // claude has review installed; the other configured tool does not.
    const claudeDir = path.join(homeDir, '.claude', 'skills', 'review');
    await fse.ensureDir(claudeDir);
    await fse.writeFile(path.join(claudeDir, 'SKILL.md'), '# review\n');
    const skills = (await collectSkillsInventory(teamConfig, localConfig, null)).skills;
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
  function rolesOver(namespaces: string[]): RolePullContext {
    return {
      activeNamespaces: { knowledge: [], skills: namespaces, learnings: [], agents: [] },
      activeSkillNames: new Set(),
      inactiveSkillNames: new Set(),
      inactiveSkillSources: new Map(),
      inactiveDocsNamespaces: [],
    };
  }
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

  it('keeps both of two concurrent exclusion writes (#1143 P1)', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'alpha'));
    await fse.writeFile(path.join(repoPath, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: A\n---\nbody\n');
    await Promise.all([
      setSkillExclusion(teamConfig, localConfig, 'review', true),
      setSkillExclusion(teamConfig, localConfig, 'alpha', true),
    ]);
    const { loadLocalConfig } = await import('../config.js');
    const reloaded = await loadLocalConfig();
    expect(reloaded?.excludedSkills ?? []).toEqual(['alpha', 'review']);
  });

  it('rejects an unknown skill name', async () => {
    const result = await setSkillExclusion(teamConfig, localConfig, 'nope', true);
    expect(result).toEqual({ ok: false, error: 'unknown_skill' });
  });

  it('answers the exclusion response with the workspace role context (#1143 P2)', async () => {
    // api sits in the backend namespace; with that role context active, a
    // re-include must answer delivered: false (outside the namespaces), not
    // the null-context delivered: true.
    // Root review sits outside the active namespaces: a re-include must
    // answer delivered: false under that context, not the null-context
    // delivered: true.
    const roleContext = rolesOver(['backend']);
    const result = await setSkillExclusion(teamConfig, localConfig, 'review', false, roleContext);
    expect(result).toMatchObject({ ok: true, skill: { name: 'review', delivered: false, undeliveredReason: 'namespace' } });
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

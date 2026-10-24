import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import {
  previewDistribution,
  readDistribution,
  saveProjects,
  saveRoles,
} from '../dashboard/distribution.js';
import { HttpError } from '../dashboard/http.js';
import type { LocalConfig } from '../types.js';

/**
 * The dashboard's Distribution APIs (#1124) read, preview, and save a
 * workspace's roles and projects with the same resolution and the same save
 * path as `roles set` / `projects set`, and never write the team repo.
 */
describe('dashboard distribution', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let config: LocalConfig;

  async function write(rel: string, content: string): Promise<void> {
    const file = path.join(repoPath, rel);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, content);
  }

  /** Every file in the team repo with its content, to prove a save left it alone. */
  async function snapshotRepo(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out[path.relative(repoPath, full)] = await fse.readFile(full, 'utf8');
      }
    };
    await walk(repoPath);
    return out;
  }

  async function revision(): Promise<string> {
    return (await readDistribution(config)).revision;
  }

  async function rejection(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    const { status, message } = error as HttpError;
    return { status, message };
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dashboard-distribution-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);

    await write('teamai.yaml', 'team: test\nrepo: owner/repo\n');
    await write('skills/frontend/ui-kit/SKILL.md', '# ui-kit\n');
    await write('skills/backend/api-kit/SKILL.md', '# api-kit\n');
    await write('skills/payment/pay-kit/SKILL.md', '# pay-kit\n');
    await write('rules/style.md', '# style\n');
    await write('rules/frontend/ui.md', '# ui\n');
    await write('rules/backend/api.md', '# api\n');
    await write('manifest/roles.yaml', YAML.stringify({
      version: 2,
      roles: [
        { id: 'frontend', description: 'Web', resources: { knowledge: ['frontend'], skills: ['frontend'] } },
        { id: 'backend', description: 'Services', resources: { knowledge: ['backend'], skills: ['backend'] } },
      ],
    }));
    await write('manifest/projects.yaml', YAML.stringify({
      version: 1,
      projects: [{ id: 'pay', name: 'Payments', description: '', resources: { skills: ['payment'] } }],
    }));

    config = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      primaryRole: 'frontend',
      additionalRoles: [],
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tempDir);
  });

  it('reads the selection, both manifests, and what pull delivers', async () => {
    const read = await readDistribution(config);

    expect(read.selection).toEqual({ primaryRole: 'frontend', additionalRoles: [], projects: [] });
    expect(read.roles).toMatchObject({ state: 'ok', items: [{ id: 'frontend' }, { id: 'backend' }] });
    expect(read.projects).toMatchObject({ state: 'ok', items: [{ id: 'pay', name: 'Payments' }] });
    expect(read.children).toEqual([]);
    expect(read.effective).toEqual({
      namespaces: { skills: ['frontend'], knowledge: ['frontend'], agents: [], learnings: [] },
      skills: ['ui-kit'],
      skillNamespaces: ['frontend'],
      rules: ['frontend/ui', 'style'],
      heldSkills: [],
    });
  });

  it('tells a missing manifest from an invalid one, without quoting the invalid file', async () => {
    await fse.remove(path.join(repoPath, 'manifest', 'projects.yaml'));
    await write('manifest/roles.yaml', 'version: 1\ninternalNote: [INTERNAL-ONLY-MARKER\nroles: []\n');

    const read = await readDistribution(config);

    expect(read.projects).toEqual({ state: 'missing' });
    expect(read.roles).toMatchObject({ state: 'invalid' });
    expect(read.effective).toHaveProperty('error');
    expect(JSON.stringify(read)).not.toContain('INTERNAL-ONLY-MARKER');
    const preview = await rejection(previewDistribution(config, { primaryRole: 'frontend' }));
    expect(preview.status).toBe(409);
    expect(preview.message).not.toContain('INTERNAL-ONLY-MARKER');
  });

  it('counts every namespace as delivered when switching away from unfiltered delivery', async () => {
    await fse.remove(path.join(repoPath, 'manifest', 'projects.yaml'));
    delete config.primaryRole;
    expect((await readDistribution(config)).effective).toMatchObject({ namespaces: null, skills: ['api-kit', 'pay-kit', 'ui-kit'] });

    const preview = await previewDistribution(config, { primaryRole: 'frontend' });

    expect(preview.unfiltered).toEqual({ before: true, after: false });
    expect(preview.namespaces.skills).toEqual({ entering: [], leaving: ['backend', 'payment'] });
    expect(preview.namespaces.knowledge).toEqual({ entering: [], leaving: ['backend'] });
    expect(preview.skills).toMatchObject({ entering: [], leaving: ['api-kit', 'pay-kit'] });
  });

  it('reports a skill two members deliver differently as held, not leaving (#913)', async () => {
    await write('skills/frontend/shared/SKILL.md', '# shared, frontend copy\n');
    await write('skills/backend/shared/SKILL.md', '# shared, backend copy\n');
    const ws = path.join(tempDir, 'ws');
    const member = { repo: { localPath: '/nonexistent', remote: 'owner/repo' }, username: 'tester', scope: 'project' };
    await fse.outputFile(path.join(ws, '.teamai', 'config.yaml'), YAML.stringify(member));
    await fse.outputFile(path.join(ws, 'web', '.teamai', 'config.yaml'), YAML.stringify({ ...member, primaryRole: 'frontend' }));
    const workspace: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' }, username: 'tester', scope: 'project',
      additionalRoles: [], projectRoot: ws, dataHome: path.join(ws, '.teamai'),
    };

    const read = await readDistribution(workspace);
    expect(read.children).toEqual([{ path: 'web', primaryRole: 'frontend', additionalRoles: [], projects: [] }]);
    expect(read.effective).toMatchObject({ skills: ['shared', 'ui-kit'], heldSkills: [] });

    const preview = await previewDistribution(workspace, { primaryRole: 'backend' });

    expect(preview.skills).toEqual({ entering: ['api-kit'], leaving: [], held: ['shared'] });
  });

  it('previews roles and projects without writing anything', async () => {
    const before = await snapshotRepo();

    const preview = await previewDistribution(config, { primaryRole: 'backend', projects: ['pay'] });

    expect(preview.selection).toEqual({ primaryRole: 'backend', additionalRoles: [], projects: ['pay'] });
    expect(preview.namespaces.skills).toEqual({ entering: ['backend', 'payment'], leaving: ['frontend'] });
    expect(preview.skills).toEqual({ entering: ['api-kit', 'pay-kit'], leaving: ['ui-kit'], held: [] });
    expect(preview.rules).toEqual({ entering: ['backend/api'], leaving: ['frontend/ui'] });
    expect(await snapshotRepo()).toEqual(before);
    expect(await fse.pathExists(path.join(homeDir, '.teamai', 'config.yaml'))).toBe(false);
  });

  it('rejects unknown and unsafe ids, and a team without a projects manifest', async () => {
    expect(await rejection(previewDistribution(config, { primaryRole: 'designer' }))).toEqual({ status: 400, message: 'Unknown role "designer".' });
    expect(await rejection(previewDistribution(config, { projects: ['../pay'] }))).toEqual({ status: 400, message: 'Invalid project id "../pay".' });
    expect((await rejection(previewDistribution(config, { primaryRole: 42 }))).status).toBe(400);

    await fse.remove(path.join(repoPath, 'manifest', 'projects.yaml'));
    expect((await rejection(saveProjects(config, { revision: await revision(), projects: [] }))).status).toBe(409);
  });

  it('saves roles to the workspace config, clears the pull cache, and leaves the team repo alone', async () => {
    const statePath = path.join(homeDir, '.teamai', 'state.json');
    await fse.writeJson(statePath, { lastPullRev: 'abc123' });
    const before = await snapshotRepo();

    await saveRoles(config, { revision: await revision(), primaryRole: 'backend', additionalRoles: ['frontend', 'backend'] });

    const saved = YAML.parse(await fse.readFile(path.join(homeDir, '.teamai', 'config.yaml'), 'utf8'));
    expect(saved).toMatchObject({ primaryRole: 'backend', additionalRoles: ['frontend'], resourceProfileVersion: 2 });
    expect((await fse.readJson(statePath)).lastPullRev).toBeNull();
    expect(await snapshotRepo()).toEqual(before);
  });

  it('saves an empty project selection', async () => {
    config.projects = ['pay'];

    await saveProjects(config, { revision: await revision(), projects: [] });

    const saved = YAML.parse(await fse.readFile(path.join(homeDir, '.teamai', 'config.yaml'), 'utf8'));
    expect(saved.projects).toEqual([]);
  });

  it('refuses a save whose revision no longer matches the workspace selection', async () => {
    const stale = await revision();
    config.primaryRole = 'backend';

    expect((await rejection(saveRoles(config, { revision: stale, primaryRole: 'frontend' }))).status).toBe(409);
    expect(await fse.pathExists(path.join(homeDir, '.teamai', 'config.yaml'))).toBe(false);
  });

  // The team assigns the roles (#1186): the page shows them, and a save here
  // would be overlaid away on the next load.
  describe('with roles assigned in the team repo', () => {
    beforeEach(() => {
      config.roleAssignment = { source: 'assigned', local: { additionalRoles: [] } };
    });

    it('says the roles are assigned, so the page can show them read-only', async () => {
      expect((await readDistribution(config)).rolesAssigned)
        .toEqual({ file: 'manifest/members.yaml', source: 'assigned' });
    });

    it('refuses a role save and a role preview, naming the file', async () => {
      const save = await rejection(saveRoles(config, { revision: await revision(), primaryRole: 'backend' }));
      expect(save.status).toBe(409);
      expect(save.message).toContain('manifest/members.yaml');
      expect((await rejection(previewDistribution(config, { primaryRole: 'backend' }))).status).toBe(409);
      expect(await fse.pathExists(path.join(homeDir, '.teamai', 'config.yaml'))).toBe(false);
    });

    it('still saves the active projects, which each workspace still picks', async () => {
      await saveProjects(config, { revision: await revision(), projects: ['pay'] });

      const saved = YAML.parse(await fse.readFile(path.join(homeDir, '.teamai', 'config.yaml'), 'utf8'));
      expect(saved.projects).toEqual(['pay']);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn(),
}));

const editMocks = vi.hoisted(() => ({
  pullLatest: vi.fn().mockResolvedValue(undefined),
  pushManifestChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../manifest-edit.js', () => ({
  pullLatest: editMocks.pullLatest,
  pushManifestChange: editMocks.pushManifestChange,
  runManifestEdit: async (
    localConfig: { repo: { localPath: string } },
    _label: string,
    fn: (repoPath: string, editConfig: unknown) => Promise<void>,
  ) => fn(localConfig.repo.localPath, localConfig),
}));

const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  dim: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ log: logMocks }));

import { projectsAdd, projectsUpdate, projectsRemove } from '../projects-cmd.js';
import { autoDetectInit } from '../config.js';

describe('projects add / update / remove (#756)', () => {
  let repoDir: string;
  const manifestPath = () => path.join(repoDir, 'manifest', 'projects.yaml');
  const readManifest = async () => YAML.parse(await fse.readFile(manifestPath(), 'utf8'));
  const errors = () => logMocks.error.mock.calls.map((c) => String(c[0])).join('\n');

  async function writeManifest(projects: unknown[]): Promise<void> {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), YAML.stringify({ version: 1, projects }));
  }

  beforeEach(async () => {
    repoDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-projects-cmd-'));
    vi.clearAllMocks();
    vi.mocked(autoDetectInit).mockResolvedValue({
      localConfig: {
        repo: { localPath: repoDir, remote: 'https://github.com/team/repo.git' },
        username: 'admin',
        updatePolicy: 'auto',
        additionalRoles: [],
        scope: 'user',
      },
      teamConfig: {
        team: 'test',
        description: '',
        repo: 'https://github.com/team/repo.git',
        provider: 'github' as const,
        reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: {},
      },
    } as unknown as Awaited<ReturnType<typeof autoDetectInit>>);
  });

  afterEach(async () => {
    await fse.remove(repoDir);
  });

  describe('add', () => {
    it('creates projects.yaml when the team has none and opens a PR', async () => {
      await projectsAdd('checkout', { namespaces: 'common, checkout', name: 'Checkout', description: 'Payments' });

      expect(await readManifest()).toEqual({
        version: 1,
        projects: [{
          id: 'checkout',
          name: 'Checkout',
          description: 'Payments',
          resources: {
            knowledge: ['common', 'checkout'],
            skills: ['common', 'checkout'],
            learnings: ['common', 'checkout'],
            agents: ['common', 'checkout'],
          },
        }],
      });
      expect(editMocks.pullLatest).toHaveBeenCalledWith(repoDir);
      expect(editMocks.pushManifestChange).toHaveBeenCalledWith(expect.objectContaining({
        repoPath: repoDir,
        commitMsg: '[teamai] Add project "checkout"',
      }));
    });

    it('appends to an existing manifest', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsAdd('beta', { namespaces: 'beta' });

      expect((await readManifest()).projects.map((p: { id: string }) => p.id)).toEqual(['alpha', 'beta']);
    });

    it('rejects a duplicate id', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsAdd('alpha', { namespaces: 'alpha' });

      expect(errors()).toContain('Project "alpha" already exists');
      expect(editMocks.pushManifestChange).not.toHaveBeenCalled();
    });

    it.each(['../escape', 'a/b', '..'])('rejects the unsafe id %s without writing', async (id) => {
      await projectsAdd(id, { namespaces: 'common' });

      expect(errors()).toContain('Invalid projects manifest');
      expect(await fse.pathExists(manifestPath())).toBe(false);
      expect(editMocks.pushManifestChange).not.toHaveBeenCalled();
    });

    it('rejects an unsafe namespace without writing', async () => {
      await projectsAdd('alpha', { namespaces: 'common,../escape' });

      expect(errors()).toContain('Invalid projects manifest');
      expect(await fse.pathExists(manifestPath())).toBe(false);
    });

    it('requires at least one namespace', async () => {
      await projectsAdd('alpha', { namespaces: ' , ' });

      expect(errors()).toContain('At least one namespace is required');
      expect(autoDetectInit).not.toHaveBeenCalled();
    });

    it('only reports the change with --dry-run', async () => {
      await projectsAdd('alpha', { namespaces: 'alpha', dryRun: true });

      expect(logMocks.info).toHaveBeenCalledWith('[dry-run] Would add project "alpha" (namespaces: alpha)');
      expect(await fse.pathExists(manifestPath())).toBe(false);
      expect(editMocks.pushManifestChange).not.toHaveBeenCalled();
    });

    it('reports a manifest that does not parse instead of overwriting it', async () => {
      await fse.ensureDir(path.dirname(manifestPath()));
      await fse.writeFile(manifestPath(), 'version: 1\nprojects: [\n');

      await projectsAdd('alpha', { namespaces: 'alpha' });

      expect(errors()).toContain('Invalid projects manifest YAML');
      expect(await fse.readFile(manifestPath(), 'utf8')).toBe('version: 1\nprojects: [\n');
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      // A hand-edited project whose resource types differ.
      await writeManifest([
        { id: 'alpha', name: 'Alpha', resources: { knowledge: ['common'], skills: ['common', 'alpha'], learnings: ['alpha'] } },
        { id: 'beta', resources: { skills: ['beta'] } },
      ]);
    });

    it('adds and removes namespaces on every resource type, keeping each type\'s own list', async () => {
      await projectsUpdate('alpha', { addNamespaces: 'extra', removeNamespaces: 'common' });

      const alpha = (await readManifest()).projects[0];
      expect(alpha.resources).toEqual({
        knowledge: ['extra'],
        skills: ['alpha', 'extra'],
        learnings: ['alpha', 'extra'],
        agents: ['extra'],
      });
      expect(alpha.name).toBe('Alpha');
      expect(editMocks.pushManifestChange).toHaveBeenCalledWith(expect.objectContaining({
        commitMsg: '[teamai] Update project "alpha"',
      }));
    });

    it('updates name and description only', async () => {
      await projectsUpdate('alpha', { name: 'Alpha Team', description: 'Core' });

      const alpha = (await readManifest()).projects[0];
      expect(alpha).toMatchObject({ name: 'Alpha Team', description: 'Core' });
      expect(alpha.resources.skills).toEqual(['common', 'alpha']);
    });

    it('refuses to remove every namespace', async () => {
      await projectsUpdate('alpha', { removeNamespaces: 'common,alpha' });

      expect(errors()).toContain('Cannot remove every namespace from project "alpha"');
      expect(editMocks.pushManifestChange).not.toHaveBeenCalled();
    });

    it('rejects an unknown project', async () => {
      await projectsUpdate('gamma', { addNamespaces: 'x' });

      expect(errors()).toContain('Unknown project "gamma". Valid projects: alpha, beta');
    });

    it('rejects a call with nothing to update', async () => {
      await projectsUpdate('alpha', {});

      expect(errors()).toContain('Nothing to update');
      expect(autoDetectInit).not.toHaveBeenCalled();
    });

    it('only reports the change with --dry-run', async () => {
      const before = await fse.readFile(manifestPath(), 'utf8');

      await projectsUpdate('alpha', { addNamespaces: 'extra', dryRun: true });

      expect(logMocks.info.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[dry-run] Would update project "alpha"');
      expect(await fse.readFile(manifestPath(), 'utf8')).toBe(before);
    });
  });

  describe('remove', () => {
    it('removes the project and warns about directories that still have it active', async () => {
      await writeManifest([
        { id: 'alpha', resources: { skills: ['alpha'] } },
        { id: 'beta', resources: { skills: ['beta'] } },
      ]);

      await projectsRemove('alpha', {});

      expect((await readManifest()).projects.map((p: { id: string }) => p.id)).toEqual(['beta']);
      expect(logMocks.warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Directories with "alpha" active');
      expect(editMocks.pushManifestChange).toHaveBeenCalledWith(expect.objectContaining({
        commitMsg: '[teamai] Remove project "alpha"',
      }));
    });

    it('can remove the last project, leaving an empty list', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsRemove('alpha', {});

      expect((await readManifest()).projects).toEqual([]);

      await projectsRemove('alpha', {});
      expect(errors()).toContain('Unknown project "alpha". Valid projects: (none)');
    });

    it('rejects an unknown project', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsRemove('beta', {});

      expect(errors()).toContain('Unknown project "beta"');
      expect(editMocks.pushManifestChange).not.toHaveBeenCalled();
    });

    it('explains when the team has no projects manifest', async () => {
      await projectsRemove('alpha', {});

      expect(errors()).toContain('This team repo defines no projects');
    });
  });
});

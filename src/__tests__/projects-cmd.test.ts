import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn(),
}));

const editMocks = vi.hoisted(() => ({
  pushManifestChange: vi.fn().mockResolvedValue(undefined),
  runManifestEdit: vi.fn(async (
    localConfig: { repo: { localPath: string } },
    _label: string,
    fn: (repoPath: string, editConfig: unknown) => Promise<void>,
    _options?: { dryRun?: boolean },
  ) => fn(localConfig.repo.localPath, localConfig)),
}));
vi.mock('../manifest-edit.js', () => ({
  pushManifestChange: editMocks.pushManifestChange,
  runManifestEdit: editMocks.runManifestEdit,
}));

const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  dim: vi.fn(),
}));
vi.mock('@teamai/shared/log', () => ({ log: logMocks }));

import { projectsAdd, projectsList, projectsRemove, projectsSet, projectsUpdate } from '../projects-cmd.js';
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
    // process.exitCode is global state: leaving it set would leak into the
    // next case and, worse, into vitest's own exit status.
    process.exitCode = 0;
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
      expect(editMocks.runManifestEdit).toHaveBeenCalledWith(
        expect.anything(), 'Projects', expect.any(Function), { dryRun: undefined },
      );
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

  describe('list', () => {
    it('shows a workspace\'s children in a team with no projects manifest', async () => {
      const init = await autoDetectInit();
      vi.mocked(autoDetectInit).mockResolvedValue({
        ...init,
        localConfig: {
          ...init.localConfig,
          children: {
            children: [{ path: 'backend', root: path.join(repoDir, 'backend'), anchor: 'a', selection: { primaryRole: 'backend', additionalRoles: [], projects: [] } }],
            leftOut: [],
            roots: [path.join(repoDir, 'backend')],
            fingerprint: 'f',
          },
        },
      });
      const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await projectsList({});
        expect(printed.mock.calls.map((call) => String(call[0]))).toContain('  backend: (no projects); roles: backend');
      } finally {
        printed.mockRestore();
      }
    });
  });

  // Every one of these commands refused the request it was given. The message
  // is on stderr either way; the exit code is what a script or CI job reads, so
  // it has to say the command failed rather than only looking like it on screen.
  describe('exit code', () => {
    it('set: 1 when the team has no projects manifest', async () => {
      await projectsSet(['alpha'], {});

      expect(errors()).toContain('defines no projects');
      expect(process.exitCode).toBe(1);
    });

    it('set: 1 for an unknown project', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsSet(['nosuchproject'], {});

      expect(errors()).toContain('Unknown project "nosuchproject"');
      expect(process.exitCode).toBe(1);
    });

    it('set: stays 0 when the selection goes through', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsSet(['alpha'], { dryRun: true });

      expect(process.exitCode).toBe(0);
    });

    it('add: 1 when no namespace is given', async () => {
      await projectsAdd('alpha', { namespaces: ' , ' });

      expect(errors()).toContain('At least one namespace is required');
      expect(process.exitCode).toBe(1);
    });

    it('add: 1 when the manifest cannot be read', async () => {
      await fse.ensureDir(path.dirname(manifestPath()));
      await fse.writeFile(manifestPath(), 'version: 1\nprojects: [\n');

      await projectsAdd('alpha', { namespaces: 'alpha' });

      expect(process.exitCode).toBe(1);
    });

    it('add: 1 when the edit fails validation', async () => {
      await projectsAdd('../escape', { namespaces: 'common' });

      expect(errors()).toContain('Invalid projects manifest');
      expect(process.exitCode).toBe(1);
    });

    it('add: 1 for a project that already exists', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsAdd('alpha', { namespaces: 'alpha' });

      expect(errors()).toContain('Project "alpha" already exists');
      expect(process.exitCode).toBe(1);
    });

    it('update: 1 with nothing to update', async () => {
      await projectsUpdate('alpha', {});

      expect(errors()).toContain('Nothing to update');
      expect(process.exitCode).toBe(1);
    });

    it('update: 1 for an unknown project', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsUpdate('ghost', { addNamespaces: 'extra' });

      expect(errors()).toContain('Unknown project "ghost"');
      expect(process.exitCode).toBe(1);
    });

    it('update: 1 rather than leave a project with no namespace', async () => {
      await writeManifest([{ id: 'alpha', resources: { knowledge: ['k'], skills: ['alpha'], learnings: ['l'], agents: ['a'] } }]);

      await projectsUpdate('alpha', { removeNamespaces: 'k,alpha,l,a' });

      expect(errors()).toContain('Cannot remove every namespace');
      expect(process.exitCode).toBe(1);
    });

    it('remove: 1 for an unknown project', async () => {
      await writeManifest([{ id: 'alpha', resources: { skills: ['alpha'] } }]);

      await projectsRemove('ghost', {});

      expect(errors()).toContain('Unknown project "ghost"');
      expect(process.exitCode).toBe(1);
    });

    it('remove: 1 when the team has no projects manifest', async () => {
      await projectsRemove('alpha', {});

      expect(errors()).toContain('defines no projects');
      expect(process.exitCode).toBe(1);
    });
  });
});

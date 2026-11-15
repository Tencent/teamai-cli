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
  pullLatest: vi.fn(),
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
vi.mock('@teamai/shared/log', () => ({
  log: logMocks,
  setStderrOnly: vi.fn(() => undefined),
}));

import { rolesAdd, rolesList, rolesRemove, rolesSet, rolesUpdate } from '../roles-cmd.js';
import { autoDetectInit } from '../config.js';

// Every one of these commands refused the request it was given. The message is
// on stderr either way; the exit code is what a script or CI job reads, so it
// has to say the command failed rather than only looking like it on screen.
describe('roles admin — the exit code of a refusal', () => {
  let repoDir: string;
  const manifestPath = () => path.join(repoDir, 'manifest', 'roles.yaml');
  const errors = () => logMocks.error.mock.calls.map((c) => String(c[0])).join('\n');

  async function writeManifest(ids: string[], namespaces = ['common']): Promise<void> {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), YAML.stringify({
      version: 1,
      roles: ids.map((id) => ({
        id,
        description: '',
        resources: { knowledge: namespaces, skills: namespaces, learnings: namespaces },
      })),
      defaults: { shareTarget: 'primary-role' },
    }));
  }

  beforeEach(async () => {
    repoDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-roles-exit-'));
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

  it('list: 1 when the manifest cannot be read', async () => {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), 'version: 1\nroles: [\n');

    await rolesList({});

    expect(errors()).toContain('roles');
    expect(process.exitCode).toBe(1);
  });

  it('set: 1 when the manifest cannot be read', async () => {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), 'version: 1\nroles: [\n');

    await rolesSet('hai', {});

    expect(process.exitCode).toBe(1);
  });

  it('set: 1 for an unknown primary role', async () => {
    await writeManifest(['hai']);

    await rolesSet('ghost', {});

    expect(errors()).toContain('Unknown role "ghost"');
    expect(process.exitCode).toBe(1);
  });

  it('set: 1 for an unknown additional role', async () => {
    await writeManifest(['hai']);

    await rolesSet('hai', { add: ['ghost'] });

    expect(errors()).toContain('Unknown additional role "ghost"');
    expect(process.exitCode).toBe(1);
  });

  it('add: 1 when no namespace is given', async () => {
    await rolesAdd('qa', { namespaces: ' , ' });

    expect(errors()).toContain('At least one namespace is required');
    expect(process.exitCode).toBe(1);
  });

  it('add: 1 when the manifest cannot be read', async () => {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), 'version: 1\nroles: [\n');

    await rolesAdd('qa', { namespaces: 'qa' });

    expect(process.exitCode).toBe(1);
  });

  it('add: 1 for a role that already exists', async () => {
    await writeManifest(['hai']);

    await rolesAdd('hai', { namespaces: 'hai' });

    expect(errors()).toContain('Role "hai" already exists');
    expect(process.exitCode).toBe(1);
  });

  it('remove: 1 when the manifest cannot be read', async () => {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), 'version: 1\nroles: [\n');

    await rolesRemove('hai', {});

    expect(process.exitCode).toBe(1);
  });

  it('remove: 1 for a role that does not exist', async () => {
    await writeManifest(['hai']);

    await rolesRemove('ghost', {});

    expect(errors()).toContain('Role "ghost" not found');
    expect(process.exitCode).toBe(1);
  });

  it('remove: 1 rather than leave a manifest with no role', async () => {
    await writeManifest(['hai']);

    await rolesRemove('hai', {});

    expect(errors()).toContain('Cannot remove the last role');
    expect(process.exitCode).toBe(1);
  });

  it('update: 1 with nothing to update', async () => {
    await writeManifest(['hai']);

    await rolesUpdate('hai', {});

    expect(errors()).toContain('Nothing to update');
    expect(process.exitCode).toBe(1);
  });

  it('update: 1 when the manifest cannot be read', async () => {
    await fse.ensureDir(path.dirname(manifestPath()));
    await fse.writeFile(manifestPath(), 'version: 1\nroles: [\n');

    await rolesUpdate('hai', { addNamespaces: 'extra' });

    expect(process.exitCode).toBe(1);
  });

  it('update: 1 for a role that does not exist', async () => {
    await writeManifest(['hai']);

    await rolesUpdate('ghost', { addNamespaces: 'extra' });

    expect(errors()).toContain('Role "ghost" not found');
    expect(process.exitCode).toBe(1);
  });

  it('update: 1 rather than leave a role with no namespace', async () => {
    await writeManifest(['hai']);

    await rolesUpdate('hai', { removeNamespaces: 'common' });

    expect(errors()).toContain('Cannot remove all namespaces');
    expect(process.exitCode).toBe(1);
  });

  it('stays 0 when the change goes through', async () => {
    await writeManifest(['hai']);

    await rolesAdd('qa', { namespaces: 'qa' });

    expect(process.exitCode).toBe(0);
    expect(editMocks.pushManifestChange).toHaveBeenCalled();
  });
});

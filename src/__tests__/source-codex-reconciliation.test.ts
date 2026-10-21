import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn() })),
}));
vi.mock('../utils/git.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/git.js')>(),
  createGit: vi.fn(() => ({ clone: vi.fn() })),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return { ...actual, copyDir: vi.fn(actual.copyDir) };
});
vi.mock('../config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config.js')>(),
  autoDetectInit: vi.fn(),
}));

import { autoDetectInit } from '../config.js';
import { getHandler } from '../resources/index.js';
import { getSourceManifestPath, pullSources, sourceRemove } from '../source.js';
import { copyDir } from '../utils/fs.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

describe('source Codex duplicate reconciliation', () => {
  const producer = 'https://source.test/shared/skills.git';
  const repositoryId = createHash('sha256').update(producer).digest('hex');
  let root: string;
  let home: string;
  let config: LocalConfig;
  let team: TeamaiConfig;
  let sourceRepo: string;

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-codex-')));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    config = {
      repo: { localPath: path.join(root, 'team'), remote: 'https://source.test/team/repo.git' },
      username: 'tester', updatePolicy: 'skip', additionalRoles: [], scope: 'user',
    };
    team = {
      team: 'test', description: '', repo: config.repo.remote, provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      sources: [{ name: 'shared', repo: producer }],
      toolPaths: { codex: { skills: '.codex/skills' } },
    };
    sourceRepo = path.join(home, '.teamai/source-repos', repositoryId, 'repo');
    await fse.ensureDir(path.join(config.repo.localPath, 'skills'));
    await fse.ensureDir(path.join(home, '.codex/skills'));
    await saveTeam();
    vi.mocked(copyDir).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  async function saveTeam(): Promise<void> {
    await fse.outputFile(path.join(config.repo.localPath, 'teamai.yaml'), YAML.stringify(team));
  }

  async function publish(names = ['foo'], content = '# Source skill\n'): Promise<void> {
    await fse.outputFile(path.join(sourceRepo, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: producer, publicSkills: names }));
    for (const name of names) await fse.outputFile(path.join(sourceRepo, 'skills', name, 'SKILL.md'), content);
  }

  async function skill(relative: string, content = '# Source skill\n'): Promise<string> {
    const target = path.join(home, relative);
    await fse.outputFile(path.join(target, 'SKILL.md'), content);
    return target;
  }

  async function duplicate(name = 'foo'): Promise<void> {
    await skill(`.agents/skills/${name}`);
    await skill(`.codex/skills/${name}`);
  }

  async function record(relative: string, local = config, id = repositoryId, name = 'foo'): Promise<string> {
    const manifest: SourceInstallManifest = {
      destinationRoot: home, teamCheckout: local.repo.localPath, repositoryId: id,
      lastPull: new Date(0).toISOString(), installedSkills: [name],
      installedPaths: { [name]: [relative] },
      installedPhysicalPaths: { [relative]: await fse.realpath(path.join(home, relative)) },
    };
    const target = getSourceManifestPath('shared', local);
    await fse.outputJson(target, manifest);
    return target;
  }

  async function candidates() {
    return getHandler('skills').scanLocalForPush(team, config);
  }

  it('removes only the verified configured duplicate and leaves no source push candidate', async () => {
    await publish();
    await duplicate();

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo'))).toBe(false);
    expect(await fse.readFile(path.join(home, '.agents/skills/foo/SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedPaths).toEqual({ foo: ['.agents/skills/foo'] });
    expect(await candidates()).toEqual([]);
  });

  it.each(['configured-differs', 'incoming-differs'])('preserves unverified local copies as push candidates: %s', async (difference) => {
    await publish();
    await duplicate();
    if (difference === 'configured-differs') await skill('.codex/skills/foo', '# Independent local draft\n');
    if (difference === 'incoming-differs') await publish(['foo'], '# Incoming revision\n');
    const configured = path.join(home, '.codex/skills/foo');
    const before = await fse.readFile(path.join(configured, 'SKILL.md'), 'utf8');

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(configured, 'SKILL.md'), 'utf8')).toBe(before);
    expect(await candidates()).toEqual([expect.objectContaining({ name: 'foo', sourcePath: configured })]);
  });

  it('leaves a shared copy that is no version of the source skill, delivering to the configured directory (#993)', async () => {
    await publish();
    await duplicate();
    await skill('.agents/skills/foo', '# Not a source version\n');

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(home, '.agents/skills/foo/SKILL.md'), 'utf8')).toBe('# Not a source version\n');
    expect(await fse.readFile(path.join(home, '.codex/skills/foo/SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedPaths).toEqual({ foo: ['.codex/skills/foo'] });
  });

  it.each(['same-repository', 'different-repository', 'nested-owner'])('preserves duplicates covered by any foreign owner: %s', async (ownership) => {
    await publish();
    await duplicate();
    const other: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'other-team') } };
    const relative = ownership === 'nested-owner' ? '.codex/skills/foo/child' : '.codex/skills/foo';
    if (ownership === 'nested-owner') {
      for (const base of [sourceRepo, path.join(home, '.agents'), path.join(home, '.codex')]) {
        await fse.outputFile(path.join(base, 'skills/foo/child/SKILL.md'), '# Nested copy\n');
      }
    }
    const manifest = await record(relative, other, ownership === 'different-repository' ? 'other-producer' : repositoryId,
      ownership === 'nested-owner' ? 'foo/child' : 'foo');
    const before = await fse.readFile(manifest, 'utf8');

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
    expect(await candidates()).toEqual([]);
  });

  it('leaves a current old pin intact until normal lifecycle cleanup can run', async () => {
    await publish();
    await duplicate();
    const manifest = await record('.codex/skills/foo');
    const before = await fse.readFile(manifest, 'utf8');
    vi.mocked(copyDir).mockRejectedValueOnce(new Error('Simulated copy failure'));

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
  });

  it('lets successful lifecycle cleanup retire the old configured pin', async () => {
    await publish();
    await duplicate();
    await record('.codex/skills/foo');

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo'))).toBe(false);
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedPaths).toEqual({ foo: ['.agents/skills/foo'] });
    expect(await candidates()).toEqual([]);
  });

  it.each(['configured-leaf', 'configured-ancestor'])('preserves same-physical aliases without exposing source copies: %s', async (link) => {
    await publish();
    await skill('.agents/skills/foo');
    const configured = path.join(home, '.codex/skills/foo');
    if (link === 'configured-leaf') await fse.symlink(path.join(home, '.agents/skills/foo'), configured, 'dir');
    else {
      await fse.rmdir(path.join(home, '.codex/skills'));
      await fse.symlink(path.join(home, '.agents/skills'), path.join(home, '.codex/skills'), 'dir');
    }

    await pullSources(config, { force: true });

    expect(await fse.realpath(configured)).toBe(path.join(home, '.agents/skills/foo'));
    expect((await fse.lstat(link === 'configured-leaf' ? configured : path.dirname(configured))).isSymbolicLink()).toBe(true);
    expect(await candidates()).toEqual([]);
  });

  // A member's link is never replaced or deleted (#993): this changed from replacing a shared leaf link with a copy.
  it('keeps a member\'s shared leaf link and delivers to the configured directory instead', async () => {
    await publish();
    const configured = await skill('.codex/skills/foo');
    const shared = path.join(home, '.agents/skills/foo');
    await fse.ensureDir(path.dirname(shared));
    await fse.symlink(configured, shared, 'dir');

    await pullSources(config, { force: true });

    expect((await fse.lstat(shared)).isSymbolicLink()).toBe(true);
    expect(await fse.readlink(shared)).toBe(configured);
    expect(await fse.readFile(path.join(configured, 'SKILL.md'), 'utf8')).toBe('# Source skill\n');
  });

  // Changed in #993 from deleting a configured leaf link that duplicated the shared copy.
  it('keeps a member\'s configured leaf link even when it is a verified duplicate', async () => {
    await publish();
    await skill('.agents/skills/foo');
    const original = path.join(root, 'independent-copy');
    await fse.outputFile(path.join(original, 'SKILL.md'), '# Source skill\n');
    const link = path.join(home, '.codex/skills/foo');
    await fse.symlink(original, link, 'dir');

    await pullSources(config, { force: true });

    expect((await fse.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(original, 'SKILL.md'), 'utf8')).toBe('# Source skill\n');
  });

  it('does not remove a duplicate which is also another planned destination', async () => {
    team.toolPaths!.secondary = { skills: '.codex/skills' };
    await saveTeam();
    await publish();
    await duplicate();

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedPaths.foo).toEqual(['.agents/skills/foo', '.codex/skills/foo']);
    expect(await candidates()).toEqual([]);
  });

  it('preserves a configured ancestor alias into the immutable source cache', async () => {
    await publish();
    await skill('.agents/skills/foo');
    await fse.rmdir(path.join(home, '.codex/skills'));
    await fse.symlink(path.join(sourceRepo, 'skills'), path.join(home, '.codex/skills'), 'dir');

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(sourceRepo, 'skills/foo/SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.lstat(path.join(home, '.codex/skills'))).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(home, '.agents/skills/foo/SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedSkills).toEqual(['foo']);
  });

  it('rejects a source-root symlink before deployment can grant deletion authority over its referent', async () => {
    await publish(['free', 'foo']);
    const unrelated = path.join(root, 'unrelated-skill');
    await fse.outputFile(path.join(unrelated, 'SKILL.md'), '# Preserve unrelated skill\n');
    await fse.remove(path.join(sourceRepo, 'skills/foo'));
    await fse.symlink(unrelated, path.join(sourceRepo, 'skills/foo'), 'dir');

    await pullSources(config, { force: true });
    const recorded = await fse.pathExists(getSourceManifestPath('shared', config));
    const copies = vi.mocked(copyDir).mock.calls.length;
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: config, teamConfig: team });
    await sourceRemove('shared', {});

    expect(await fse.pathExists(path.join(unrelated, 'SKILL.md'))).toBe(true);
    expect(await fse.readFile(path.join(unrelated, 'SKILL.md'), 'utf8')).toBe('# Preserve unrelated skill\n');
    expect(recorded).toBe(false);
    expect(copies).toBe(0);
  });

  it('copies an in-repository skill-root alias as concrete contents and preserves its input on removal', async () => {
    await publish();
    const input = path.join(sourceRepo, 'skills/original');
    await fse.move(path.join(sourceRepo, 'skills/foo'), input);
    await fse.symlink('original', path.join(sourceRepo, 'skills/foo'), 'dir');

    await pullSources(config, { force: true });

    const deployed = path.join(home, '.codex/skills/foo');
    expect((await fse.lstat(deployed)).isSymbolicLink()).toBe(false);
    expect(await fse.readFile(path.join(deployed, 'SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedPhysicalPaths).toEqual({ '.codex/skills/foo': deployed });
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: config, teamConfig: team });
    await sourceRemove('shared', {});
    expect(await fse.pathExists(deployed)).toBe(false);
    expect(await fse.readFile(path.join(input, 'SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.lstat(path.join(sourceRepo, 'skills/foo'))).isSymbolicLink()).toBe(true);
  });

  it.each(['remove', 'withdraw', 'update'])('keeps an older installed leaf-link record and its unrelated referent unchanged: %s', async (action) => {
    await publish(action === 'withdraw' ? [] : ['free', 'foo']);
    const unrelated = path.join(root, 'old-link-referent');
    await fse.outputFile(path.join(unrelated, 'SKILL.md'), '# Unrelated retained skill\n');
    const installed = path.join(home, '.codex/skills/foo');
    await fse.symlink(unrelated, installed, 'dir');
    const manifest = await record('.codex/skills/foo');
    const before = await fse.readFile(manifest, 'utf8');
    const configFile = path.join(config.repo.localPath, 'teamai.yaml');
    const configBefore = await fse.readFile(configFile, 'utf8');

    if (action === 'remove') {
      vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: config, teamConfig: team });
      await expect(sourceRemove('shared', {})).rejects.toThrow(/skill root.*symlink.*Manual review/i);
    } else await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(unrelated, 'SKILL.md'), 'utf8')).toBe('# Unrelated retained skill\n');
    expect((await fse.lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
    expect(await fse.readFile(configFile, 'utf8')).toBe(configBefore);
    expect(copyDir).not.toHaveBeenCalled();
  });

  it.each(['dangling', 'loop'])('rejects an unverifiable declared source root before any mutation: %s', async (unsafe) => {
    await publish(['free', 'foo']);
    await duplicate();
    const manifest = await record('.agents/skills/foo');
    const before = await fse.readFile(manifest, 'utf8');
    const source = path.join(sourceRepo, 'skills/foo');
    await fse.remove(source);
    await fse.symlink(unsafe === 'dangling' ? 'missing' : 'foo', source, 'dir');

    await pullSources(config, { force: true });

    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect(copyDir).not.toHaveBeenCalled();
  });

  it('preserves source inputs reached through a repository namespace alias outside the cache', async () => {
    await publish();
    const input = path.join(root, 'source-input');
    await fse.move(path.join(sourceRepo, 'skills'), input);
    await fse.symlink(input, path.join(sourceRepo, 'skills'), 'dir');
    await skill('.agents/skills/foo');
    await fse.rmdir(path.join(home, '.codex/skills'));
    await fse.symlink(input, path.join(home, '.codex/skills'), 'dir');

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(input, 'foo/SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect(await fse.readFile(path.join(home, '.agents/skills/foo/SKILL.md'), 'utf8')).toBe('# Source skill\n');
    expect((await fse.readJson(getSourceManifestPath('shared', config))).installedSkills).toEqual(['foo']);
  });

  it('does not reconcile anything when an earlier replacement ownership conflict aborts the pull', async () => {
    await publish(['foo', 'bar', 'free']);
    await duplicate();
    await skill('.agents/skills/bar');
    const manifest = await record('.agents/skills/foo', config, 'previous-producer');
    const before = await fse.readFile(manifest, 'utf8');
    const other: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'other-team') } };
    await record('.agents/skills/bar', other, 'foreign-producer', 'bar');

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.codex/skills/free'))).toBe(false);
    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
    expect(copyDir).not.toHaveBeenCalled();
  });

  it('keeps old shared leaf-link pins unchanged before any reconciliation', async () => {
    await publish(['foo', 'free']);
    const configured = await skill('.codex/skills/foo');
    const shared = path.join(home, '.agents/skills/foo');
    await fse.ensureDir(path.dirname(shared));
    await fse.symlink(configured, shared, 'dir');
    const manifest = await record('.agents/skills/foo');
    const before = await fse.readFile(manifest, 'utf8');

    await pullSources(config, { force: true });

    expect((await fse.lstat(shared)).isSymbolicLink()).toBe(true);
    expect(await fse.pathExists(path.join(configured, 'SKILL.md'))).toBe(true);
    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
    expect(copyDir).not.toHaveBeenCalled();
  });

  it('does not reconcile or record duplicates during dry-run', async () => {
    await publish();
    await duplicate();

    await pullSources(config, { force: true, dryRun: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(getSourceManifestPath('shared', config))).toBe(false);
    expect(copyDir).not.toHaveBeenCalled();
  });

  it.each(['dangling', 'loop', 'scope-root', 'filesystem-root'])('validates every cleanup route before deleting an earlier duplicate: %s', async (unsafe) => {
    await publish(['foo', 'bar', 'free']);
    await duplicate();
    await skill('.agents/skills/bar');
    const configured = path.join(home, '.codex/skills/bar');
    const target = unsafe === 'dangling' ? path.join(root, 'missing')
      : unsafe === 'loop' ? configured : unsafe === 'scope-root' ? home : path.parse(home).root;
    await fse.symlink(target, configured, 'dir');

    await pullSources(config, { force: true });

    expect(await fse.pathExists(path.join(home, '.codex/skills/foo/SKILL.md'))).toBe(true);
    expect((await fse.lstat(configured)).isSymbolicLink()).toBe(true);
    expect(await fse.pathExists(path.join(home, '.codex/skills/free'))).toBe(false);
    expect(await fse.pathExists(getSourceManifestPath('shared', config))).toBe(false);
    expect(copyDir).not.toHaveBeenCalled();
  });
});

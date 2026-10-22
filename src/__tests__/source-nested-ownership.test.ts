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
vi.mock('../config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config.js')>(),
  autoDetectInit: vi.fn(),
}));

import { autoDetectInit, loadTeamConfig } from '../config.js';
import { getHandler } from '../resources/index.js';
import { getSourceManifestPath, pullSources, sourceRemove } from '../source.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

describe('nested source ownership boundaries', () => {
  const producer = 'https://source.test/shared/skills.git';
  const repositoryId = createHash('sha256').update(producer).digest('hex');
  let root: string;
  let home: string;
  let config: LocalConfig;
  let team: TeamaiConfig;

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-nested-')));
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
      sources: [{ name: 'current', repo: producer }],
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    await fse.ensureDir(path.join(config.repo.localPath, 'skills'));
    await fse.ensureDir(path.join(home, '.claude/skills'));
    await saveTeam(config, team);
    vi.mocked(autoDetectInit).mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  async function saveTeam(local: LocalConfig, value: TeamaiConfig): Promise<void> {
    await fse.outputFile(path.join(local.repo.localPath, 'teamai.yaml'), YAML.stringify(value));
  }

  async function publish(names: string[]): Promise<void> {
    const repo = path.join(home, '.teamai/source-repos', repositoryId, 'repo');
    await fse.outputFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: producer, publicSkills: names }));
    for (const name of names) await fse.outputFile(path.join(repo, 'skills', name, 'SKILL.md'), `# Incoming ${name}\n`);
  }

  async function record(alias: string, local: LocalConfig, name: string, target?: string): Promise<string> {
    const manifest: SourceInstallManifest = {
      destinationRoot: home, teamCheckout: local.repo.localPath, repositoryId,
      lastPull: new Date(0).toISOString(), installedSkills: [name],
      ...(target === undefined ? {} : { installedPaths: { [name]: [target] } }),
    };
    const file = getSourceManifestPath(alias, local);
    await fse.outputFile(file, JSON.stringify(manifest, null, 2) + '\n');
    return file;
  }

  async function removeSource(alias: string, local: LocalConfig): Promise<void> {
    const currentTeam = await loadTeamConfig(local.repo.localPath);
    expect(currentTeam).not.toBeNull();
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: local, teamConfig: currentTeam! });
    await sourceRemove(alias, {});
  }

  async function pushCandidates(local: LocalConfig): Promise<string[]> {
    const currentTeam = await loadTeamConfig(local.repo.localPath);
    return (await getHandler('skills').scanLocalForPush(currentTeam!, local)).map((item) => item.name);
  }

  it('rejects exact planned-target collisions between distinct logical skills before any copy', async () => {
    team.toolPaths = {
      claude: { skills: '.claude/skills' },
      secondary: { skills: '.claude/skills/group' },
    };
    await saveTeam(config, team);
    const targets = ['.claude/skills/foo', '.claude/skills/group/foo', '.claude/skills/group/group/foo'];
    for (const target of targets) await fse.outputFile(path.join(home, target, 'SKILL.md'), `# Original ${target}\n`);
    await publish(['free', 'foo', 'group/foo']);

    await pullSources(config, { force: true });

    for (const target of targets) expect(await fse.readFile(path.join(home, target, 'SKILL.md'), 'utf8')).toBe(`# Original ${target}\n`);
    expect(await fse.pathExists(path.join(home, '.claude/skills/free'))).toBe(false);
    expect(await fse.pathExists(path.join(home, '.claude/skills/group/free'))).toBe(false);
    expect(await fse.pathExists(getSourceManifestPath('current', config))).toBe(false);
  });

  it.each(['own', 'foreign'])('preserves an exact target owned by a different logical skill: %s', async (owner) => {
    team.toolPaths = { claude: { skills: '.claude/skills/group' } };
    await saveTeam(config, team);
    const other: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'other-team') } };
    const ownerConfig = owner === 'own' ? config : other;
    const ownerAlias = owner === 'own' ? 'current' : 'other';
    const target = '.claude/skills/group/foo';
    const manifest = await record(ownerAlias, ownerConfig, 'group/foo', target);
    const before = await fse.readFile(manifest, 'utf8');
    await fse.outputFile(path.join(home, target, 'SKILL.md'), '# Existing nested identity\n');
    await fse.outputFile(path.join(home, '.claude/skills/group/local-draft/SKILL.md'), '# Local draft\n');
    await publish(['free', 'foo']);

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(home, target, 'SKILL.md'), 'utf8')).toBe('# Existing nested identity\n');
    expect(await fse.readFile(manifest, 'utf8')).toBe(before);
    expect(await fse.pathExists(path.join(home, '.claude/skills/group/free'))).toBe(false);
    if (owner === 'foreign') expect(await fse.pathExists(getSourceManifestPath('current', config))).toBe(false);
    const candidates = await pushCandidates(config);
    expect(candidates).not.toContain('foo');
    expect(candidates).toContain('local-draft');
  });

  it('still shares an exact target for the same repository and logical skill', async () => {
    const other: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'other-team') } };
    const otherManifest = await record('other', other, 'foo', '.claude/skills/foo');
    const before = await fse.readFile(otherManifest, 'utf8');
    await fse.outputFile(path.join(home, '.claude/skills/foo/SKILL.md'), '# Existing shared copy\n');
    await publish(['foo']);

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(home, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('# Incoming foo\n');
    expect(await fse.readFile(otherManifest, 'utf8')).toBe(before);
    expect((await fse.readJson(getSourceManifestPath('current', config))).installedSkills).toEqual(['foo']);
  });

  it.each([
    ['remove', true], ['remove', false], ['withdraw', true], ['withdraw', false],
  ] as const)('releases recorded parents after their child; unrecorded parents require manual review (%s, recorded paths: %s)', async (action, recordedPaths) => {
    const child: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'child-team') } };
    const childTeam = { ...team, sources: [{ name: 'child', repo: producer }] };
    await saveTeam(child, childTeam);
    const parentManifest = await record('current', config, 'foo', recordedPaths ? '.claude/skills/foo' : undefined);
    const parentBefore = await fse.readFile(parentManifest, 'utf8');
    const teamYamlPath = path.join(config.repo.localPath, 'teamai.yaml');
    const teamBefore = await fse.readFile(teamYamlPath, 'utf8');
    const childManifest = await record('child', child, 'foo/bar', '.claude/skills/foo/bar');
    const childBefore = await fse.readFile(childManifest, 'utf8');
    const parentFile = path.join(home, '.claude/skills/foo/SKILL.md');
    const childFile = path.join(home, '.claude/skills/foo/bar/SKILL.md');
    const draft = path.join(home, '.claude/skills/local-draft/SKILL.md');
    await fse.outputFile(parentFile, '# Retained parent source\n');
    await fse.outputFile(childFile, '# Nested source\n');
    await fse.outputFile(draft, '# Local draft\n');
    await publish([]);

    if (action === 'remove') await removeSource('current', config);
    else await pullSources(config, { force: true });

    expect(await fse.readFile(parentFile, 'utf8')).toBe('# Retained parent source\n');
    expect(await fse.readFile(childFile, 'utf8')).toBe('# Nested source\n');
    expect(await fse.readFile(childManifest, 'utf8')).toBe(childBefore);
    expect((await fse.readJson(parentManifest)).installedSkills).toEqual(['foo']);
    expect(await pushCandidates(config)).not.toContain('foo');

    // Releasing a child must not strand the parent's other source files.
    await removeSource('child', child);
    expect(await fse.pathExists(childManifest)).toBe(!recordedPaths);
    if (!recordedPaths) {
      expect(await fse.readFile(childManifest, 'utf8')).toBe(childBefore);
      expect(await fse.readFile(childFile, 'utf8')).toBe('# Nested source\n');
    }
    expect(await fse.readFile(parentFile, 'utf8')).toBe('# Retained parent source\n');
    const parentBeforeFinalRemoval = await fse.readFile(parentManifest, 'utf8');
    const candidates = await pushCandidates(child);
    expect(candidates).not.toContain('foo');
    expect(candidates).toContain('local-draft');
    expect(await fse.readFile(parentManifest, 'utf8')).toBe(parentBeforeFinalRemoval);

    if (action === 'remove') await removeSource('current', config);
    else await pullSources(config, { force: true });

    expect(await fse.pathExists(path.dirname(parentFile))).toBe(!recordedPaths);
    expect(await fse.readFile(draft, 'utf8')).toBe('# Local draft\n');
    if (!recordedPaths) {
      expect(await fse.readFile(parentManifest, 'utf8')).toBe(parentBefore);
      expect(await fse.readFile(teamYamlPath, 'utf8')).toBe(teamBefore);
      expect(await pushCandidates(config)).not.toContain('foo');
    } else if (action === 'remove') expect(await fse.pathExists(parentManifest)).toBe(false);
    else expect((await fse.readJson(parentManifest)).installedSkills).toEqual([]);
  });
});

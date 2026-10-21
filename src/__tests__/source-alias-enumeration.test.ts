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
  ...await importOriginal<typeof import('../config.js')>(), autoDetectInit: vi.fn(),
}));

import { autoDetectInit } from '../config.js';
import { getHandler } from '../resources/index.js';
import { getSourceManifestPath, getSourcePathOwners, getSourcePushQuarantineNames, getSourceSkillOrigins, pullSources, sourceRemove } from '../source.js';
import { log } from '../utils/logger.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

const ALIASES = ['.git', 'node_modules', '__pycache__', '.pyc', '.DS_Store', 'anything.pyc', 'ordinary'];

describe.each(ALIASES)('source metadata enumeration for accepted alias %s', (alias) => {
  const producer = 'https://source.test/current/repo.git';
  const repositoryId = createHash('sha256').update(producer).digest('hex');
  let root: string;
  let home: string;
  let current: LocalConfig;
  let foreign: LocalConfig;
  let team: TeamaiConfig;

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-alias-')));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    current = {
      repo: { localPath: path.join(root, 'current-team'), remote: 'https://source.test/team/repo.git' },
      username: 'tester', updatePolicy: 'skip', additionalRoles: [], scope: 'user',
    };
    foreign = { ...current, repo: { ...current.repo, localPath: path.join(root, 'foreign-team') } };
    team = {
      team: 'test', description: '', repo: current.repo.remote, provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      sources: [{ name: 'current', repo: producer }],
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    };
    await fse.outputFile(path.join(current.repo.localPath, 'teamai.yaml'), YAML.stringify(team));
    await fse.ensureDir(path.join(current.repo.localPath, 'skills'));
    await fse.ensureDir(path.join(home, '.claude/skills'));
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: current, teamConfig: team });
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  function pinned(config: LocalConfig, name = 'foo'): SourceInstallManifest {
    const relative = `.claude/skills/${name}`;
    return {
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId: 'foreign-producer',
      installedSkills: [name], installedPaths: { [name]: [relative] },
      installedPhysicalPaths: { [relative]: path.join(home, relative) }, lastPull: new Date(0).toISOString(),
    };
  }

  async function record(name: string, config: LocalConfig, manifest: SourceInstallManifest): Promise<string> {
    const target = getSourceManifestPath(name, config);
    await fse.outputJson(target, manifest);
    return target;
  }

  async function skill(relative: string, text: string): Promise<string> {
    const target = path.join(home, relative);
    await fse.outputFile(path.join(target, 'SKILL.md'), text);
    return target;
  }

  async function publish(names: string[]): Promise<void> {
    const repo = path.join(home, '.teamai/source-repos', repositoryId, 'repo');
    await fse.outputFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: producer, publicSkills: names }));
    for (const name of names) await fse.outputFile(path.join(repo, 'skills', name, 'SKILL.md'), `# Incoming ${name}\n`);
  }

  it('retains provenance and excludes modern physical ownership from global push', async () => {
    const owned = await skill('.claude/skills/foo', '# Source bytes\n');
    const draft = await skill('.codex/skills/foo', '# Independent draft\n');
    const manifestPath = await record(alias, current, pinned(current));
    const before = await fse.readFile(manifestPath, 'utf8');

    expect(await getSourceSkillOrigins(current)).toEqual(new Map([['foo', alias]]));
    expect(await getSourcePathOwners()).toEqual([expect.objectContaining({ path: owned, sourceName: alias, manifestPath })]);
    expect(await getSourcePushQuarantineNames(current)).toEqual(new Set());
    expect(await getHandler('skills').scanLocalForPush(team, current)).toEqual([
      expect.objectContaining({ name: 'foo', sourcePath: draft }),
    ]);
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('protects a foreign producer from overwrite while allowing a nonoverlapping install', async () => {
    await skill('.claude/skills/foo', '# Foreign bytes\n');
    const manifestPath = await record(alias, foreign, pinned(foreign));
    const before = await fse.readFile(manifestPath, 'utf8');
    await publish(['foo', 'free']);

    await pullSources(current, { force: true });

    expect(await fse.readFile(path.join(home, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('# Foreign bytes\n');
    expect(await fse.readFile(path.join(home, '.claude/skills/free/SKILL.md'), 'utf8')).toBe('# Incoming free\n');
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect((await fse.readJson(getSourceManifestPath('current', current))).installedSkills).toEqual(['free']);
  });

  it('keeps foreign-owned bytes when another installation releases the same destination', async () => {
    await skill('.claude/skills/foo', '# Shared bytes\n');
    const manifestPath = await record(alias, foreign, pinned(foreign));
    const before = await fse.readFile(manifestPath, 'utf8');
    await record('current', current, { ...pinned(current), repositoryId });

    await sourceRemove('current', {});

    expect(await fse.readFile(path.join(home, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('# Shared bytes\n');
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.pathExists(getSourceManifestPath('current', current))).toBe(false);
  });

  it.each(['scoped', 'legacy'].flatMap((layout) => ['pull', 'remove'].map((operation) => ({ layout, operation }))))(
    'keeps $layout foreign quarantine visible to push and $operation', async ({ layout, operation }) => {
      const owned = await skill('.claude/skills/foo', '# Ambiguous source bytes\n');
      await skill('.codex/skills/foo', '# Ambiguous same-name copy\n');
      const draft = await skill('.codex/skills/local-draft', '# Local draft\n');
      const manifest: SourceInstallManifest = {
        installedSkills: ['foo'], lastPull: new Date(0).toISOString(),
        ...(layout === 'scoped' ? { destinationRoot: home, teamCheckout: foreign.repo.localPath, installedPaths: { foo: [] } } : {}),
      };
      const manifestPath = layout === 'scoped' ? getSourceManifestPath(alias, foreign)
        : path.join(home, '.teamai/sources', alias, 'installed.json');
      await fse.outputJson(manifestPath, manifest);
      const before = await fse.readFile(manifestPath, 'utf8');
      expect(await getSourcePushQuarantineNames(current)).toEqual(new Set(['foo']));
      expect(await getHandler('skills').scanLocalForPush(team, current)).toEqual([
        expect.objectContaining({ name: 'local-draft', sourcePath: draft }),
      ]);
      const currentPath = getSourceManifestPath('current', current);
      if (operation === 'remove') await record('current', current, { ...pinned(current), repositoryId });
      const currentBefore = await fse.pathExists(currentPath) ? await fse.readFile(currentPath, 'utf8') : null;
      const yamlPath = path.join(current.repo.localPath, 'teamai.yaml');
      const yamlBefore = await fse.readFile(yamlPath, 'utf8');
      await publish(['free', 'foo']);

      if (operation === 'remove') await sourceRemove('current', {});
      else await pullSources(current, { force: true });

      expect(await fse.readFile(path.join(owned, 'SKILL.md'), 'utf8')).toBe('# Ambiguous source bytes\n');
      expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
      expect(await fse.pathExists(currentPath) ? await fse.readFile(currentPath, 'utf8') : null).toBe(currentBefore);
      expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
      expect(await fse.pathExists(path.join(home, '.claude/skills/free'))).toBe(false);
      expect(vi.mocked(log.warn).mock.calls.some(([message]) => /manual review/i.test(String(message)))).toBe(true);
    },
  );
});

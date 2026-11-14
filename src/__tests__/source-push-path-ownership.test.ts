import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn() })),
}));

import { getHandler } from '../resources/index.js';
import { getSourceManifestPath, getSourceSkillOrigins } from '../source.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

describe('source push uses physical path ownership', () => {
  let root: string;
  let home: string;
  let config: LocalConfig;
  let team: TeamaiConfig;
  const repositoryId = createHash('sha256').update('https://source.test/shared/repo.git').digest('hex');

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-push-path-')));
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
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    };
    await fse.ensureDir(path.join(config.repo.localPath, 'skills'));
    await fse.ensureDir(home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  async function skill(relative: string, content = '# Local skill\n'): Promise<string> {
    const target = path.join(home, relative);
    await fse.outputFile(path.join(target, 'SKILL.md'), content);
    return target;
  }

  function pinned(name = 'foo', relative = '.claude/skills/foo'): SourceInstallManifest {
    return {
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId,
      lastPull: new Date(0).toISOString(), installedSkills: [name],
      installedPaths: { [name]: [relative] },
      installedPhysicalPaths: { [relative]: path.join(home, relative) },
    };
  }

  async function record(manifest: unknown, local = config, alias = 'shared'): Promise<string> {
    const target = getSourceManifestPath(alias, local);
    await fse.outputJson(target, manifest);
    return target;
  }

  async function candidates() {
    return getHandler('skills').scanLocalForPush(team, config);
  }

  it.each(['source-first', 'draft-first'])('keeps an unrelated same-name Codex draft (%s)', async (order) => {
    if (order === 'draft-first') team.toolPaths = { codex: { skills: '.codex/skills' }, claude: { skills: '.claude/skills' } };
    await skill('.claude/skills/foo', '# Subscribed source\n');
    const draft = await skill('.codex/skills/foo', '# Independent draft\n');
    const manifestPath = await record(pinned());
    const before = await fse.readFile(manifestPath, 'utf8');

    expect(await candidates()).toEqual([expect.objectContaining({ name: 'foo', sourcePath: draft, status: 'new' })]);
    expect(await getSourceSkillOrigins(config)).toEqual(new Map([['foo', 'shared']]));
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('excludes a differently named symlink alias of the pinned physical source', async () => {
    const owned = await skill('.claude/skills/foo', '# Subscribed source\n');
    await fse.ensureDir(path.join(home, '.codex/skills'));
    await fse.symlink(owned, path.join(home, '.codex/skills/alias'), 'dir');
    const draft = await skill('.codex/skills/foo-extra');
    await record(pinned());

    expect(await candidates()).toEqual([expect.objectContaining({ name: 'foo-extra', sourcePath: draft })]);
  });

  it.each(['owned-parent', 'owned-child'])('excludes actual nested overlap rather than only the recorded name (%s)', async (layout) => {
    let manifest: SourceInstallManifest;
    if (layout === 'owned-parent') {
      await skill('.claude/skills/group/foo');
      manifest = pinned('group', '.claude/skills/group');
    } else {
      await skill('.claude/skills/group');
      await skill('.claude/skills/group/foo');
      manifest = pinned('group/foo', '.claude/skills/group/foo');
    }
    const draft = await skill('.codex/skills/foo', '# Independent flat draft\n');
    await record(manifest);

    expect(await candidates()).toEqual([expect.objectContaining({ name: 'foo', sourcePath: draft })]);
  });

  it('uses the actual Codex scan path even when a shared destination with the same name exists', async () => {
    const draft = await skill('.codex/skills/foo', '# Independent Codex draft\n');
    await skill('.agents/skills/foo', '# Source at the shared destination\n');
    await record(pinned('foo', '.agents/skills/foo'));

    expect(await candidates()).toEqual([expect.objectContaining({ name: 'foo', sourcePath: draft })]);
  });

  it.each(['rootless-legacy', 'scoped-unpinned', 'scoped-missing-paths', 'scoped-empty-paths', 'scoped-rootless-pins'])(
    'quarantines same-name copies when physical ownership is incomplete: %s', async (layout) => {
      await skill('.claude/skills/foo', '# Possibly subscribed copy\n');
      await skill('.codex/skills/foo', '# Ambiguous same-name copy\n');
      const draft = await skill('.codex/skills/local-draft');
      const manifest = pinned();
      if (layout === 'rootless-legacy') {
        await fse.outputJson(path.join(home, '.teamai/sources/legacy/installed.json'), {
          lastPull: manifest.lastPull, installedSkills: ['foo'],
        });
      } else {
        if (layout === 'scoped-unpinned') delete manifest.installedPhysicalPaths;
        if (layout === 'scoped-missing-paths') {
          manifest.installedPaths = {};
          manifest.installedPhysicalPaths = {};
        }
        if (layout === 'scoped-empty-paths') {
          manifest.installedPaths = { foo: [] };
          manifest.installedPhysicalPaths = {};
        }
        if (layout === 'scoped-rootless-pins') delete manifest.destinationRoot;
        await record(manifest);
      }

      expect(await candidates()).toEqual([expect.objectContaining({ name: 'local-draft', sourcePath: draft })]);
    },
  );

  it.each(['legacy', 'scoped'])('quarantines bare scan names for an unpinned nested identity: %s', async (layout) => {
    await skill('.claude/skills/group/foo', '# Ambiguous nested source\n');
    const draft = await skill('.codex/skills/local-draft');
    const manifest = { lastPull: new Date(0).toISOString(), installedSkills: ['group/foo'] };
    if (layout === 'legacy') await fse.outputJson(path.join(home, '.teamai/sources/legacy/installed.json'), manifest);
    else await record(manifest);

    expect(await candidates()).toEqual([expect.objectContaining({ name: 'local-draft', sourcePath: draft })]);
  });

  it.each(['null-map', 'array-map', 'relative-pin', 'root-pin', 'missing-pin', 'partial-map', 'invalid-json'])(
    'fails closed for every candidate when ownership metadata is malformed: %s', async (failure) => {
      await skill('.claude/skills/foo', '# Do not publish\n');
      await skill('.codex/skills/local-draft');
      const manifest = pinned();
      let value: unknown = manifest;
      if (failure === 'null-map') value = { ...manifest, installedPhysicalPaths: null };
      if (failure === 'array-map') value = { ...manifest, installedPhysicalPaths: [] };
      if (failure === 'relative-pin') manifest.installedPhysicalPaths = { '.claude/skills/foo': 'relative/foo' };
      if (failure === 'root-pin') manifest.installedPhysicalPaths = { '.claude/skills/foo': path.parse(home).root };
      if (failure === 'missing-pin') manifest.installedPhysicalPaths = {};
      if (failure === 'partial-map') manifest.installedPaths!.foo.push('.codex/skills/foo');
      const manifestPath = await record(value);
      if (failure === 'invalid-json') await fse.writeFile(manifestPath, '{truncated');
      const before = await fse.readFile(manifestPath, 'utf8');

      expect(await candidates()).toEqual([]);
      expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    },
  );

  it('keeps a foreign same-alias original pin protected after its lexical link is repointed', async () => {
    const owned = await skill('.claude/skills/foo', '# Foreign source\n');
    const draft = await skill('.codex/skills/foo', '# Independent same-name draft\n');
    const foreignRoot = path.join(root, 'foreign-project');
    await fse.ensureDir(foreignRoot);
    await fse.symlink(path.join(home, '.claude'), path.join(foreignRoot, '.claude'), 'dir');
    const other: LocalConfig = {
      ...config, scope: 'project', projectRoot: foreignRoot,
      repo: { ...config.repo, localPath: path.join(root, 'other-team') },
    };
    const manifest = pinned();
    manifest.destinationRoot = foreignRoot;
    manifest.teamCheckout = other.repo.localPath;
    manifest.installedPhysicalPaths = { '.claude/skills/foo': owned };
    const manifestPath = await record(manifest, other);
    const before = await fse.readFile(manifestPath, 'utf8');
    await fse.unlink(path.join(foreignRoot, '.claude'));
    const replacement = path.join(root, 'replacement-tool');
    await fse.outputFile(path.join(replacement, 'skills/foo/SKILL.md'), '# Unrelated new referent\n');
    await fse.symlink(replacement, path.join(foreignRoot, '.claude'), 'dir');

    expect(await candidates()).toEqual([expect.objectContaining({ name: 'foo', sourcePath: draft })]);
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.readFile(path.join(owned, 'SKILL.md'), 'utf8')).toBe('# Foreign source\n');
  });
});

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
import { getSourceManifestPath, getSourcePathOwners, pullSources, sourceRemove } from '../source.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

type PinnedManifest = SourceInstallManifest & { installedPhysicalPaths?: Record<string, string> };
type LinkKind = 'ancestor' | 'root';

describe('source physical destination ownership', () => {
  const producer = 'https://source.test/original/skills.git';
  const replacement = 'https://source.test/replacement/skills.git';
  const relativePath = '.claude/skills/foo';
  let root: string;
  let home: string;
  let config: LocalConfig;
  let team: TeamaiConfig;

  beforeEach(async () => {
    // Old plain-path compatibility must not depend on macOS /var aliases.
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-pins-')));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    config = {
      repo: { localPath: path.join(root, 'team'), remote: 'https://source.test/team/repo.git' },
      username: 'tester', updatePolicy: 'skip', additionalRoles: [],
      scope: 'project', projectRoot: path.join(root, 'project'),
    };
    team = {
      team: 'test', description: '', repo: config.repo.remote, provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      sources: [{ name: 'current', repo: producer }],
      toolPaths: { claude: { skills: '.claude/skills' } },
    };
    await fse.ensureDir(path.join(config.repo.localPath, 'skills'));
    await fse.ensureDir(path.join(config.projectRoot!, '.claude/skills'));
    await saveTeam(config, team);
    vi.mocked(autoDetectInit).mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  async function saveTeam(local: LocalConfig, value: TeamaiConfig): Promise<void> {
    await fse.outputFile(path.join(local.repo.localPath, 'teamai.yaml'), YAML.stringify(value));
  }

  async function publish(url = producer, names = ['foo'], marker = 'Original source'): Promise<void> {
    const id = createHash('sha256').update(url).digest('hex');
    const repo = path.join(home, '.teamai/source-repos', id, 'repo');
    await fse.outputFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: url, publicSkills: names }));
    for (const name of names) await fse.outputFile(path.join(repo, 'skills', name, 'SKILL.md'), `# ${marker}: ${name}\n`);
  }

  async function removeSource(alias = 'current', local = config): Promise<void> {
    const currentTeam = await loadTeamConfig(local.repo.localPath);
    expect(currentTeam).not.toBeNull();
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: local, teamConfig: currentTeam! });
    await sourceRemove(alias, {});
  }

  async function pinManifest(): Promise<PinnedManifest> {
    return fse.readJson(getSourceManifestPath('current', config));
  }

  async function writeManifest(value: unknown): Promise<void> {
    await fse.writeFile(getSourceManifestPath('current', config), JSON.stringify(value, null, 2) + '\n');
  }

  async function linkScope(kind: LinkKind): Promise<{ link: string; original: string; alternate: string; suffix: string }> {
    const original = kind === 'root' ? config.projectRoot! : path.join(root, 'original-tool');
    const alternate = path.join(root, `alternate-${kind}`);
    const suffix = kind === 'root' ? '.claude/skills' : 'skills';
    const link = kind === 'root' ? path.join(root, 'project-link') : path.join(config.projectRoot!, '.claude');
    await fse.ensureDir(path.join(original, suffix));
    await fse.ensureDir(path.join(alternate, suffix));
    if (kind === 'ancestor') await fse.remove(link);
    await fse.symlink(original, link, 'dir');
    if (kind === 'root') config.projectRoot = link;
    return { link, original, alternate, suffix };
  }

  it.each(['ancestor', 'root'] as const)('pins and safely updates/removes a stable %s symlink installation', async (kind) => {
    const linked = await linkScope(kind);
    const physical = path.join(linked.original, linked.suffix, 'foo');
    await publish();
    await pullSources(config, { force: true });

    expect((await pinManifest()).installedPhysicalPaths?.[relativePath]).toBe(physical);
    await publish(producer, ['foo'], 'Updated source');
    await pullSources(config, { force: true });
    expect(await fse.readFile(path.join(physical, 'SKILL.md'), 'utf8')).toBe('# Updated source: foo\n');
    expect((await pinManifest()).installedPhysicalPaths?.[relativePath]).toBe(physical);

    await removeSource();
    expect(await fse.pathExists(physical)).toBe(false);
    expect((await fse.lstat(linked.link)).isSymbolicLink()).toBe(true);
    expect(await fse.pathExists(getSourceManifestPath('current', config))).toBe(false);
  });

  const changedLinks = (['ancestor', 'root'] as const).flatMap((kind) =>
    (['repointed', 'removed'] as const).flatMap((change) =>
      (['remove', 'update', 'withdraw', 'replacement'] as const).map((action) => ({ kind, change, action }))));

  it.each(changedLinks)('preserves all state on a $change $kind symlink during $action', async ({ kind, change, action }) => {
    const linked = await linkScope(kind);
    const originalSkill = path.join(linked.original, linked.suffix, 'foo/SKILL.md');
    const unrelatedSkill = path.join(linked.alternate, linked.suffix, 'foo/SKILL.md');
    await publish();
    await pullSources(config, { force: true });
    await fse.outputFile(unrelatedSkill, '# Unrelated local copy\n');
    const manifestPath = getSourceManifestPath('current', config);
    const originalManifest = await fse.readFile(manifestPath, 'utf8');
    expect((await pinManifest()).installedPhysicalPaths?.[relativePath]).toBe(path.dirname(originalSkill));
    await fse.unlink(linked.link);
    if (change === 'repointed') await fse.symlink(linked.alternate, linked.link, 'dir');

    if (action === 'replacement') {
      team.sources = [{ name: 'current', repo: replacement }];
      await saveTeam(config, team);
      await publish(replacement, ['free', 'foo'], 'Replacement');
    } else if (action === 'withdraw') await publish(producer, []);
    else if (action === 'update') await publish(producer, ['free', 'foo'], 'New source');
    const yamlPath = path.join(config.repo.localPath, 'teamai.yaml');
    const originalYaml = await fse.readFile(yamlPath, 'utf8');

    if (action === 'remove') await expect(removeSource()).rejects.toThrow();
    else await pullSources(config, { force: true });

    expect(await fse.readFile(originalSkill, 'utf8')).toBe('# Original source: foo\n');
    expect(await fse.readFile(unrelatedSkill, 'utf8')).toBe('# Unrelated local copy\n');
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(originalManifest);
    expect(await fse.readFile(yamlPath, 'utf8')).toBe(originalYaml);
    expect(await fse.pathExists(path.join(linked.original, linked.suffix, 'free'))).toBe(false);
    expect(await fse.pathExists(path.join(linked.alternate, linked.suffix, 'free'))).toBe(false);
    if (change === 'removed') expect(await fse.pathExists(linked.link)).toBe(false);
    expect(await fse.pathExists(path.join(home, '.teamai/.source-lifecycle-lock'))).toBe(false);
  });

  it.each(['dangling', 'loop'] as const)('does not treat a %s ancestor as a verified physical destination', async (failure) => {
    const linked = await linkScope('ancestor');
    await publish();
    await pullSources(config, { force: true });
    const manifestPath = getSourceManifestPath('current', config);
    const before = await fse.readFile(manifestPath, 'utf8');
    const yamlPath = path.join(config.repo.localPath, 'teamai.yaml');
    const yamlBefore = await fse.readFile(yamlPath, 'utf8');
    if (failure === 'dangling') await fse.remove(linked.original);
    else {
      await fse.unlink(linked.link);
      await fse.symlink(linked.link, linked.link, 'dir');
    }
    await publish(producer, ['free', 'foo'], 'New source');

    await expect(removeSource()).rejects.toThrow();
    await pullSources(config, { force: true });

    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
    expect(await fse.pathExists(path.join(linked.original, linked.suffix, 'free'))).toBe(false);
    if (failure === 'dangling') expect(await fse.pathExists(linked.original)).toBe(false);
    else expect(await fse.readFile(path.join(linked.original, linked.suffix, 'foo/SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
  });

  it.each([false, true])('allows an absent leaf under verified ancestors (stable symlink: %s)', async (symlinked) => {
    if (symlinked) await linkScope('ancestor');
    await publish();
    await pullSources(config, { force: true });
    await fse.remove(path.join(config.projectRoot!, relativePath));

    await removeSource();

    expect(await fse.pathExists(getSourceManifestPath('current', config))).toBe(false);
    expect((await loadTeamConfig(config.repo.localPath))?.sources).toEqual([]);
    expect(await fse.pathExists(config.projectRoot!)).toBe(true);
  });

  it('leaves an unrecorded leaf symlink to a directory that is no copy of the source skill (#993)', async () => {
    const external = path.join(root, 'unrelated-leaf');
    await fse.outputFile(path.join(external, 'SKILL.md'), '# Unrelated leaf target\n');
    const target = path.join(config.projectRoot!, relativePath);
    await fse.symlink(external, target, 'dir');
    await publish();
    await pullSources(config, { force: true });

    expect((await fse.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(external, 'SKILL.md'), 'utf8')).toBe('# Unrelated leaf target\n');
  });

  // Changed in #993 from replacing the leaf link with a copy: a member's link is never replaced or deleted.
  it('keeps a member\'s leaf link at the destination, records nothing for it, and never writes through it', async () => {
    const external = path.join(root, 'copied-leaf');
    await fse.outputFile(path.join(external, 'SKILL.md'), '# Original source: foo\n');
    const target = path.join(config.projectRoot!, relativePath);
    await fse.symlink(external, target, 'dir');
    await publish();
    await pullSources(config, { force: true });

    expect((await fse.lstat(target)).isSymbolicLink()).toBe(true);
    expect((await pinManifest()).installedPhysicalPaths?.[relativePath]).toBeUndefined();
    await publish(producer, ['foo'], 'Updated source');
    await pullSources(config, { force: true });
    expect((await fse.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(external, 'SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
  });

  it('delivers a source skill without the links in it, and names each one once (#993)', async () => {
    await publish();
    const id = createHash('sha256').update(producer).digest('hex');
    const outside = path.join(root, 'outside.md');
    await fse.writeFile(outside, 'outside');
    await fse.symlink(outside, path.join(home, '.teamai/source-repos', id, 'repo', 'skills', 'foo', 'linked.md'));
    const { log } = await import('../utils/logger.js');
    vi.mocked(log.warn).mockClear();

    await pullSources(config, { force: true });

    const dest = path.join(config.projectRoot!, relativePath);
    expect(await fse.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
    expect(await fse.lstat(path.join(dest, 'linked.md')).catch(() => null)).toBeNull();
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      '[source:current] Skipped linked.md in current/foo: teamai does not deliver links.',
    );
  });

  it('keeps a member\'s dangling link at the destination (#993)', async () => {
    const target = path.join(config.projectRoot!, relativePath);
    await fse.symlink(path.join(root, 'nowhere'), target, 'dir');
    await publish();
    await pullSources(config, { force: true });

    expect((await fse.lstat(target)).isSymbolicLink()).toBe(true);
    expect(await fse.pathExists(path.join(root, 'nowhere'))).toBe(false);
  });

  it('keeps a recorded copy that holds a member\'s link through pull and source remove, and names the link (#993)', async () => {
    await publish();
    await pullSources(config, { force: true });
    const skillFile = path.join(config.projectRoot!, relativePath, 'SKILL.md');
    const mine = path.join(root, 'my-skill.md');
    await fse.writeFile(mine, '# Original source: foo\n');
    await fse.remove(skillFile);
    await fse.symlink(mine, skillFile);
    const { log } = await import('../utils/logger.js');

    await publish(producer, ['foo'], 'Updated source');
    await pullSources(config, { force: true });

    expect((await fse.lstat(skillFile)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(mine, 'utf8')).toBe('# Original source: foo\n');
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message))).toContain(
      `[source:current] Kept ${skillFile}: it is a link of yours, so teamai does not replace it. Remove the link to receive current/foo from its source.`,
    );

    await removeSource();
    expect((await fse.lstat(skillFile)).isSymbolicLink()).toBe(true);
  });

  it('does not abandon an existing pin when an ancestor link becomes a leaf link', async () => {
    const linked = await linkScope('ancestor');
    await publish();
    await pullSources(config, { force: true });
    const originalTarget = path.join(linked.original, linked.suffix, 'foo');
    const manifestPath = getSourceManifestPath('current', config);
    const before = await fse.readFile(manifestPath, 'utf8');
    await fse.unlink(linked.link);
    await fse.ensureDir(path.join(linked.link, 'skills'));
    const leaf = path.join(config.projectRoot!, relativePath);
    await fse.symlink(originalTarget, leaf, 'dir');
    // The read target still matches the original pin, but copyDir would unlink
    // the leaf and start writing elsewhere, stranding the old source directory.
    expect(await fse.realpath(leaf)).toBe(originalTarget);
    await publish(producer, ['free', 'foo'], 'New source');

    await pullSources(config, { force: true });

    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect((await fse.lstat(leaf)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(path.join(originalTarget, 'SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
    expect(await fse.pathExists(path.join(config.projectRoot!, '.claude/skills/free'))).toBe(false);
  });

  it('does not replace a lexical ancestor of an old pinned nested skill', async () => {
    const external = path.join(root, 'nested-original');
    await fse.ensureDir(external);
    const ancestor = path.join(config.projectRoot!, relativePath);
    await fse.symlink(external, ancestor, 'dir');
    await publish(producer, ['foo/bar']);
    await pullSources(config, { force: true });
    const originalSkill = path.join(external, 'bar/SKILL.md');
    const manifestPath = getSourceManifestPath('current', config);
    const before = await fse.readFile(manifestPath, 'utf8');
    expect((await pinManifest()).installedPhysicalPaths?.['.claude/skills/foo/bar']).toBe(path.dirname(originalSkill));
    await publish(producer, ['free', 'foo'], 'New parent source');

    await pullSources(config, { force: true });

    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect((await fse.lstat(ancestor)).isSymbolicLink()).toBe(true);
    expect(await fse.readFile(originalSkill, 'utf8')).toBe('# Original source: foo/bar\n');
    expect(await fse.pathExists(path.join(config.projectRoot!, '.claude/skills/free'))).toBe(false);
  });

  it('upgrades an old plain-path scoped record and permits ordinary cleanup', async () => {
    await publish();
    await pullSources(config, { force: true });
    const old = await pinManifest();
    delete old.installedPhysicalPaths;
    await writeManifest(old);
    await publish(producer, ['foo'], 'Updated source');

    await pullSources(config, { force: true });

    const physical = path.join(config.projectRoot!, relativePath);
    expect((await pinManifest()).installedPhysicalPaths?.[relativePath]).toBe(physical);
    expect(await fse.readFile(path.join(physical, 'SKILL.md'), 'utf8')).toBe('# Updated source: foo\n');
    await removeSource();
    expect(await fse.pathExists(physical)).toBe(false);
  });

  it.each(['ancestor', 'root'] as const)('does not invent historical pins for an old %s symlink record', async (kind) => {
    const linked = await linkScope(kind);
    await publish();
    await pullSources(config, { force: true });
    const old = await pinManifest();
    delete old.installedPhysicalPaths;
    await writeManifest(old);
    const manifestPath = getSourceManifestPath('current', config);
    const before = await fse.readFile(manifestPath, 'utf8');
    const yamlPath = path.join(config.repo.localPath, 'teamai.yaml');
    const yamlBefore = await fse.readFile(yamlPath, 'utf8');
    await publish(producer, ['free', 'foo'], 'New source');

    await expect(removeSource()).rejects.toThrow();
    await pullSources(config, { force: true });

    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
    expect(await fse.readFile(path.join(linked.original, linked.suffix, 'foo/SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
    expect(await fse.pathExists(path.join(linked.original, linked.suffix, 'free'))).toBe(false);
  });

  it.each(['null', 'array', 'number', 'relative', 'nul', 'empty', 'missing-entry', 'fallback-missing-entry'] as const)(
    'rejects a malformed or incomplete physical map before YAML or copy changes: %s', async (failure) => {
      await publish();
      await pullSources(config, { force: true });
      const original = await pinManifest();
      const malformed: Record<string, unknown> = { ...original };
      malformed.installedPhysicalPaths = failure === 'null' ? null : failure === 'array' ? []
        : failure === 'missing-entry' || failure === 'fallback-missing-entry' ? {}
          : { [relativePath]: failure === 'number' ? 42 : failure === 'relative' ? 'relative/foo'
            : failure === 'nul' ? path.join(root, 'bad\0path') : '' };
      if (failure === 'fallback-missing-entry') delete malformed.installedPaths;
      await writeManifest(malformed);
      const manifestPath = getSourceManifestPath('current', config);
      const before = await fse.readFile(manifestPath, 'utf8');
      const yamlPath = path.join(config.repo.localPath, 'teamai.yaml');
      const yamlBefore = await fse.readFile(yamlPath, 'utf8');
      await publish(producer, ['free', 'foo'], 'New source');

      await expect(removeSource()).rejects.toThrow();
      await pullSources(config, { force: true });

      expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
      expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
      expect(await fse.readFile(path.join(config.projectRoot!, relativePath, 'SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
      expect(await fse.pathExists(path.join(config.projectRoot!, '.claude/skills/free'))).toBe(false);
    },
  );

  it('keeps foreign ownership pinned to the original physical path after a lexical link moves', async () => {
    const linked = await linkScope('ancestor');
    await publish();
    await pullSources(config, { force: true });
    const manifestPath = getSourceManifestPath('current', config);
    const before = await fse.readFile(manifestPath, 'utf8');
    const originalTarget = path.join(linked.original, linked.suffix, 'foo');
    const unrelated = path.join(linked.alternate, linked.suffix, 'foo/SKILL.md');
    await fse.outputFile(unrelated, '# Unrelated new destination\n');
    await fse.unlink(linked.link);
    await fse.symlink(linked.alternate, linked.link, 'dir');

    const ownerPaths = (await getSourcePathOwners()).filter((owner) => owner.manifestPath === manifestPath).map((owner) => owner.path);
    expect(ownerPaths).toEqual([originalTarget]);

    const other: LocalConfig = {
      ...config, projectRoot: path.join(root, 'other-project'),
      repo: { ...config.repo, localPath: path.join(root, 'other-team') },
    };
    const otherTeam = { ...team, sources: [{ name: 'other', repo: replacement }] };
    await saveTeam(other, otherTeam);
    await fse.ensureDir(other.projectRoot!);
    await fse.symlink(linked.original, path.join(other.projectRoot!, '.claude'), 'dir');
    await fse.outputFile(path.join(linked.original, linked.suffix, 'local-draft/SKILL.md'), '# Local draft\n');
    await publish(replacement, ['foo'], 'Conflicting source');

    await pullSources(other, { force: true });

    expect(await fse.readFile(path.join(originalTarget, 'SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
    expect(await fse.readFile(unrelated, 'utf8')).toBe('# Unrelated new destination\n');
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    const candidates = (await getHandler('skills').scanLocalForPush(otherTeam, other)).map((item) => item.name);
    expect(candidates).not.toContain('foo');
    expect(candidates).toContain('local-draft');
    await removeSource('other', other);
    expect(await fse.readFile(path.join(originalTarget, 'SKILL.md'), 'utf8')).toBe('# Original source: foo\n');
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
  });
});

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
import { getSourceManifestPath, getSourcePushQuarantineNames, getSourceSkillOrigins, pullSources, sourceRemove } from '../source.js';
import { copyDir } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

describe('repository replacement with unrecorded source destinations', () => {
  const producer = 'https://source.test/replacement/skills.git';
  const repositoryId = createHash('sha256').update(producer).digest('hex');
  let root: string;
  let home: string;
  let config: LocalConfig;
  let team: TeamaiConfig;

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-unrecorded-source-')));
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
      toolPaths: { claude: { skills: '.claude/skills' }, codex: { skills: '.codex/skills' } },
    };
    await fse.ensureDir(path.join(config.repo.localPath, 'skills'));
    await fse.outputFile(path.join(config.repo.localPath, 'teamai.yaml'), YAML.stringify(team));
    await fse.ensureDir(path.join(home, '.claude/skills'));
    await fse.ensureDir(path.join(home, '.codex/skills'));
    vi.mocked(copyDir).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  async function publish(names: string[]): Promise<void> {
    const repo = path.join(home, '.teamai/source-repos', repositoryId, 'repo');
    await fse.outputFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: producer, publicSkills: names }));
    for (const name of names) await fse.outputFile(path.join(repo, 'skills', name, 'SKILL.md'), `# Incoming ${name}\n`);
  }

  async function record(manifest: SourceInstallManifest): Promise<string> {
    const target = getSourceManifestPath('shared', config);
    await fse.outputJson(target, manifest);
    return target;
  }

  const replacements = ['missing-map', 'empty-map', 'missing-entry', 'empty-array', 'mixed-empty'].flatMap((layout) =>
    ['known', 'unknown'].flatMap((previousProducer) =>
      ['new-skills', 'empty-publication'].map((publication) => ({ layout, previousProducer, publication }))));

  it.each(replacements)('preserves all prior claims for $previousProducer producer, $layout, $publication', async ({ layout, previousProducer, publication }) => {
    const installedSkills = ['recorded', 'legacy'];
    const manifest: SourceInstallManifest = {
      destinationRoot: home, teamCheckout: config.repo.localPath,
      lastPull: new Date(0).toISOString(), installedSkills,
      ...(previousProducer === 'known' ? { repositoryId: 'previous-producer' } : {}),
    };
    if (layout === 'empty-map') manifest.installedPaths = {};
    if (layout === 'missing-entry') manifest.installedPaths = { recorded: ['.claude/skills/recorded'] };
    if (layout === 'empty-array') manifest.installedPaths = { recorded: [], legacy: [] };
    if (layout === 'mixed-empty') manifest.installedPaths = { recorded: ['.claude/skills/recorded'], legacy: [] };
    for (const name of installedSkills) {
      await fse.outputFile(path.join(home, '.claude/skills', name, 'SKILL.md'), `# Original ${name}\n`);
      await fse.outputFile(path.join(home, '.claude/skills', name, 'scripts/keep.txt'), `Retain ${name}\n`);
    }
    await fse.outputFile(path.join(home, '.codex/skills/local-draft/SKILL.md'), '# Independent draft\n');
    await publish(publication === 'new-skills' ? ['free', 'replacement'] : []);
    const manifestPath = await record(manifest);
    const before = await fse.readFile(manifestPath, 'utf8');
    const yamlPath = path.join(config.repo.localPath, 'teamai.yaml');
    const yamlBefore = await fse.readFile(yamlPath, 'utf8');

    await pullSources(config, { force: true });

    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
    for (const name of installedSkills) {
      expect(await fse.readFile(path.join(home, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(`# Original ${name}\n`);
      expect(await fse.readFile(path.join(home, '.claude/skills', name, 'scripts/keep.txt'), 'utf8')).toBe(`Retain ${name}\n`);
      expect(await fse.pathExists(path.join(home, '.codex/skills', name))).toBe(false);
    }
    for (const tool of ['.claude', '.codex']) {
      for (const name of ['free', 'replacement']) expect(await fse.pathExists(path.join(home, tool, 'skills', name))).toBe(false);
    }
    expect(copyDir).not.toHaveBeenCalled();
    expect(await getSourceSkillOrigins(config)).toEqual(new Map(installedSkills.map((name) => [name, 'shared'])));
    expect(await getSourcePushQuarantineNames(config)).toEqual(new Set(installedSkills));
    expect((await getHandler('skills').scanLocalForPush(team, config)).map((item) => item.name)).toEqual(['local-draft']);
    expect(vi.mocked(log.warn).mock.calls.some(([message]) => /manual review/i.test(String(message)))).toBe(true);
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('does not overwrite an unrecorded old skill when the replacement publishes the same name', async () => {
    await fse.outputFile(path.join(home, '.claude/skills/legacy/SKILL.md'), '# Old producer\n');
    await publish(['free', 'legacy']);
    const manifestPath = await record({
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId: 'previous-producer',
      lastPull: new Date(0).toISOString(), installedSkills: ['legacy'],
    });
    const before = await fse.readFile(manifestPath, 'utf8');

    await pullSources(config, { force: true });

    expect(await fse.readFile(path.join(home, '.claude/skills/legacy/SKILL.md'), 'utf8')).toBe('# Old producer\n');
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(copyDir).not.toHaveBeenCalled();
  });

  it.each(['missing', 'empty'])('keeps an ambiguous retained claim quarantined for another checkout sharing HOME: %s paths', async (paths) => {
    await fse.outputFile(path.join(home, '.claude/skills/legacy/SKILL.md'), '# Retained old source\n');
    await fse.outputFile(path.join(home, '.codex/skills/local-draft/SKILL.md'), '# Independent draft\n');
    await publish(['replacement']);
    const manifestPath = await record({
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId: 'previous-producer',
      lastPull: new Date(0).toISOString(), installedSkills: ['legacy'],
      ...(paths === 'empty' ? { installedPaths: { legacy: [] } } : {}),
    });
    const before = await fse.readFile(manifestPath, 'utf8');
    await pullSources(config, { force: true });
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    const other: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'other-team') } };
    await fse.ensureDir(path.join(other.repo.localPath, 'skills'));
    const otherTeam: TeamaiConfig = { ...team, sources: [] };

    const candidates = await getHandler('skills').scanLocalForPush(otherTeam, other);

    expect(candidates.map((item) => item.name)).toEqual(['local-draft']);
    expect(await getSourcePushQuarantineNames(other)).toEqual(new Set(['legacy']));
    expect(await getSourceSkillOrigins(other)).toEqual(new Map());
    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.readFile(path.join(home, '.claude/skills/legacy/SKILL.md'), 'utf8')).toBe('# Retained old source\n');
  });

  it('keeps fully pinned foreign claims path-specific for another checkout sharing HOME', async () => {
    const original = path.join(home, '.claude/skills/legacy');
    const draft = path.join(home, '.codex/skills/legacy');
    await fse.outputFile(path.join(original, 'SKILL.md'), '# Pinned source\n');
    await fse.outputFile(path.join(draft, 'SKILL.md'), '# Independent same-name draft\n');
    await record({
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId,
      lastPull: new Date(0).toISOString(), installedSkills: ['legacy'],
      installedPaths: { legacy: ['.claude/skills/legacy'] },
      installedPhysicalPaths: { '.claude/skills/legacy': original },
    });
    const other: LocalConfig = { ...config, repo: { ...config.repo, localPath: path.join(root, 'other-team') } };
    await fse.ensureDir(path.join(other.repo.localPath, 'skills'));

    expect(await getHandler('skills').scanLocalForPush({ ...team, sources: [] }, other)).toEqual([
      expect.objectContaining({ name: 'legacy', sourcePath: draft }),
    ]);
    expect(await getSourcePushQuarantineNames(other)).toEqual(new Set());
  });

  const unrecordedActions = ['missing', 'empty', 'mixed'].flatMap((paths) =>
    ['update', 'withdraw', 'remove'].flatMap((action) => [false, true].map((dryRun) => ({ paths, action, dryRun }))));

  it.each(unrecordedActions)('retains same-producer unrecorded claims after tool paths change: $paths, $action, preview $dryRun', async ({ paths, action, dryRun }) => {
    const names = ['legacy', 'recorded'];
    for (const name of names) {
      await fse.outputFile(path.join(home, '.claude/skills', name, 'SKILL.md'), `# Original ${name}\n`);
      await fse.outputFile(path.join(home, '.codex/skills', name, 'SKILL.md'), `# Unrelated new-path ${name}\n`);
    }
    team.toolPaths = { codex: { skills: '.codex/skills' } };
    const yamlPath = path.join(config.repo.localPath, 'teamai.yaml');
    await fse.writeFile(yamlPath, YAML.stringify(team));
    const yamlBefore = await fse.readFile(yamlPath, 'utf8');
    const manifest: SourceInstallManifest = {
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId,
      lastPull: new Date(0).toISOString(), installedSkills: names,
    };
    if (paths === 'empty') manifest.installedPaths = { legacy: [], recorded: [] };
    if (paths === 'mixed') manifest.installedPaths = { recorded: ['.claude/skills/recorded'] };
    const manifestPath = await record(manifest);
    const before = await fse.readFile(manifestPath, 'utf8');
    await publish(action === 'update' ? ['free', ...names] : []);

    if (action === 'remove') {
      vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: config, teamConfig: team });
      await sourceRemove('shared', { dryRun });
    } else await pullSources(config, { force: true, dryRun });

    expect(await fse.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
    for (const name of names) {
      expect(await fse.readFile(path.join(home, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(`# Original ${name}\n`);
      expect(await fse.readFile(path.join(home, '.codex/skills', name, 'SKILL.md'), 'utf8')).toBe(`# Unrelated new-path ${name}\n`);
    }
    for (const tool of ['.claude', '.codex']) expect(await fse.pathExists(path.join(home, tool, 'skills/free'))).toBe(false);
    expect(copyDir).not.toHaveBeenCalled();
    expect(await getSourcePushQuarantineNames(config)).toEqual(new Set(names));
    expect(await getSourceSkillOrigins(config)).toEqual(new Map(names.map((name) => [name, 'shared'])));
    expect(vi.mocked(log.warn).mock.calls.some(([message]) => /manual review/i.test(String(message)))).toBe(true);
  });

  it.each(['update', 'withdraw', 'remove'])('keeps explicitly recorded plain paths compatible: %s', async (action) => {
    await fse.outputFile(path.join(home, '.claude/skills/legacy/SKILL.md'), '# Previous revision\n');
    await record({
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId,
      lastPull: new Date(0).toISOString(), installedSkills: ['legacy'],
      installedPaths: { legacy: ['.claude/skills/legacy'] },
    });
    await publish(action === 'update' ? ['legacy', 'free'] : []);

    if (action === 'remove') {
      vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: config, teamConfig: team });
      await sourceRemove('shared', {});
      expect(await fse.pathExists(getSourceManifestPath('shared', config))).toBe(false);
      expect(await fse.pathExists(path.join(home, '.claude/skills/legacy'))).toBe(false);
      return;
    }
    await pullSources(config, { force: true });

    const after = await fse.readJson(getSourceManifestPath('shared', config)) as SourceInstallManifest;
    expect(after.repositoryId).toBe(repositoryId);
    expect(await getSourcePushQuarantineNames(config)).toEqual(new Set());
    if (action === 'update') {
      expect(after.installedSkills).toEqual(['legacy', 'free']);
      for (const tool of ['.claude', '.codex']) {
        for (const name of ['legacy', 'free']) {
          const relative = `${tool}/skills/${name}`;
          expect(await fse.readFile(path.join(home, relative, 'SKILL.md'), 'utf8')).toBe(`# Incoming ${name}\n`);
          expect(after.installedPaths?.[name]).toContain(relative);
          expect(after.installedPhysicalPaths?.[relative]).toBe(path.join(home, relative));
        }
      }
      expect((await getHandler('skills').scanLocalForPush(team, config)).map((item) => item.name)).toEqual([]);
    } else {
      expect(after.installedSkills).toEqual([]);
      expect(await fse.pathExists(path.join(home, '.claude/skills/legacy'))).toBe(false);
    }
  });
});

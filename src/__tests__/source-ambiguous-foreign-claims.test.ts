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
import { getSourceManifestPath, pullSources, sourceRemove } from '../source.js';
import { copyDir } from '../utils/fs.js';
import { log } from '../utils/logger.js';
import type { LocalConfig, SourceInstallManifest, TeamaiConfig } from '../types.js';

describe('ambiguous foreign source claims sharing HOME', () => {
  const producer = 'https://source.test/current/skills.git';
  const repositoryId = createHash('sha256').update(producer).digest('hex');
  let root: string;
  let home: string;
  let current: LocalConfig;
  let foreign: LocalConfig;
  let team: TeamaiConfig;

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-foreign-claim-')));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    current = {
      repo: { localPath: path.join(root, 'checkout-b'), remote: 'https://source.test/team/repo.git' },
      username: 'tester', updatePolicy: 'skip', additionalRoles: [], scope: 'user',
    };
    foreign = { ...current, repo: { ...current.repo, localPath: path.join(root, 'checkout-a') } };
    team = {
      team: 'test', description: '', repo: current.repo.remote, provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      sources: [{ name: 'current', repo: producer }], toolPaths: { claude: { skills: '.claude/skills' } },
    };
    await fse.outputFile(path.join(current.repo.localPath, 'teamai.yaml'), YAML.stringify(team));
    await fse.ensureDir(path.join(current.repo.localPath, 'skills'));
    await fse.ensureDir(path.join(home, '.claude/skills'));
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: current, teamConfig: team });
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

  async function record(alias: string, config: LocalConfig, names: string[], paths?: Record<string, string[]>): Promise<string> {
    const manifest: SourceInstallManifest = {
      destinationRoot: home, teamCheckout: config.repo.localPath, repositoryId,
      installedSkills: names, installedPaths: paths, lastPull: new Date(0).toISOString(),
    };
    const target = getSourceManifestPath(alias, config);
    await fse.outputJson(target, manifest);
    return target;
  }

  async function snapshot(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await fse.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const [name, content] of Object.entries(await snapshot(path.join(dir, entry.name)))) files[`${entry.name}/${name}`] = content;
      } else files[entry.name] = await fse.readFile(path.join(dir, entry.name), 'utf8');
    }
    return files;
  }

  const overlaps = [
    { relation: 'equal', foreignName: 'legacy', currentName: 'legacy' },
    { relation: 'foreign-parent', foreignName: 'legacy', currentName: 'legacy/child' },
    { relation: 'foreign-child', foreignName: 'legacy/child', currentName: 'legacy' },
  ];
  const cases = ['missing', 'empty', 'mixed', 'rootless-legacy'].flatMap((layout) =>
    overlaps.flatMap((overlap) => ['install', 'withdraw', 'remove'].map((operation) => ({ layout, ...overlap, operation }))));

  async function assertBlocked(layout: string, foreignName: string, currentName: string, operation: string, sameRepository = false): Promise<void> {
    const foreignManifest: SourceInstallManifest = {
      destinationRoot: home, teamCheckout: foreign.repo.localPath,
      repositoryId: sameRepository ? repositoryId : 'another-producer',
      installedSkills: [foreignName, 'foreign-recorded'], lastPull: new Date(0).toISOString(),
    };
    if (layout === 'empty') foreignManifest.installedPaths = { [foreignName]: [], 'foreign-recorded': [] };
    if (layout === 'mixed') foreignManifest.installedPaths = { 'foreign-recorded': ['.claude/skills/foreign-recorded'] };
    let foreignPath = getSourceManifestPath('retained', foreign);
    if (layout === 'rootless-legacy') {
      delete foreignManifest.destinationRoot;
      delete foreignManifest.teamCheckout;
      // Relative paths without a destination identity cannot establish ownership.
      foreignManifest.installedPaths = { [foreignName]: [`.claude/skills/${foreignName}`], 'foreign-recorded': ['.claude/skills/foreign-recorded'] };
      foreignPath = path.join(home, '.teamai/sources/retained/installed.json');
    }
    await fse.outputJson(foreignPath, foreignManifest);
    for (const name of [foreignName, 'foreign-recorded']) {
      await fse.outputFile(path.join(home, '.claude/skills', name, 'SKILL.md'), `# Retained ${name}\n`);
      await fse.outputFile(path.join(home, '.claude/skills', name, 'scripts/keep.txt'), `Keep ${name}\n`);
    }
    const currentPath = getSourceManifestPath('current', current);
    if (operation !== 'install') {
      await fse.outputFile(path.join(home, '.claude/skills', currentName, 'SKILL.md'), `# Existing ${currentName}\n`);
      await fse.outputFile(path.join(home, '.claude/skills/owned-free/SKILL.md'), '# Other existing skill\n');
      await record('current', current, ['owned-free', currentName], {
        'owned-free': ['.claude/skills/owned-free'], [currentName]: [`.claude/skills/${currentName}`],
      });
    }
    await publish(operation === 'install' ? ['new-free', currentName] : ['new-free']);
    const filesBefore = await snapshot(path.join(home, '.claude/skills'));
    const foreignBefore = await fse.readFile(foreignPath, 'utf8');
    const currentBefore = await fse.pathExists(currentPath) ? await fse.readFile(currentPath, 'utf8') : null;
    const yamlPath = path.join(current.repo.localPath, 'teamai.yaml');
    const yamlBefore = await fse.readFile(yamlPath, 'utf8');

    for (const dryRun of [true, false]) {
      if (operation === 'remove') await sourceRemove('current', { dryRun });
      else await pullSources(current, { force: true, dryRun });

      expect(await snapshot(path.join(home, '.claude/skills'))).toEqual(filesBefore);
      expect(await fse.readFile(foreignPath, 'utf8')).toBe(foreignBefore);
      expect(await fse.pathExists(currentPath) ? await fse.readFile(currentPath, 'utf8') : null).toBe(currentBefore);
      expect(await fse.readFile(yamlPath, 'utf8')).toBe(yamlBefore);
      expect(copyDir).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn).mock.calls.some(([message]) => /manual review/i.test(String(message)))).toBe(true);
    }
  }

  it.each(cases)('blocks $operation for $layout and $relation before any mutation', async ({ layout, foreignName, currentName, operation }) => {
    await assertBlocked(layout, foreignName, currentName, operation);
  });

  it.each(['install', 'withdraw', 'remove'])('does not let a same-repository alias bypass ambiguous claims: %s', async (operation) => {
    await assertBlocked('missing', 'legacy', 'legacy', operation, true);
  });

  it.each(['missing', 'empty', 'mixed', 'rootless-legacy'])('allows a nonoverlapping install despite an unrelated %s claim', async (layout) => {
    const manifest: SourceInstallManifest = { installedSkills: ['legacy'], lastPull: new Date(0).toISOString() };
    let foreignPath = path.join(home, '.teamai/sources/retained/installed.json');
    if (layout !== 'rootless-legacy') {
      manifest.destinationRoot = home;
      manifest.teamCheckout = foreign.repo.localPath;
      foreignPath = getSourceManifestPath('retained', foreign);
    }
    if (layout === 'empty') manifest.installedPaths = { legacy: [] };
    if (layout === 'mixed') {
      manifest.installedSkills.push('foreign-recorded');
      manifest.installedPaths = { 'foreign-recorded': ['.claude/skills/foreign-recorded'] };
    }
    await fse.outputJson(foreignPath, manifest);
    const before = await fse.readFile(foreignPath, 'utf8');
    await fse.outputFile(path.join(home, '.claude/skills/legacy/SKILL.md'), '# Retained legacy\n');
    // A common string prefix does not make these logical skill directories overlap.
    await publish(['legacy-other']);

    await pullSources(current, { force: true });

    expect(await fse.readFile(path.join(home, '.claude/skills/legacy-other/SKILL.md'), 'utf8')).toBe('# Incoming legacy-other\n');
    expect(await fse.readFile(path.join(home, '.claude/skills/legacy/SKILL.md'), 'utf8')).toBe('# Retained legacy\n');
    expect(await fse.readFile(foreignPath, 'utf8')).toBe(before);
    expect((await fse.readJson(getSourceManifestPath('current', current))).installedSkills).toEqual(['legacy-other']);
  });

  it.each(['install', 'withdraw', 'remove'])('keeps fully recorded foreign plain paths specific to their destinations: %s', async (operation) => {
    const foreignPath = await record('retained', foreign, ['legacy'], { legacy: ['.other/skills/legacy'] });
    const before = await fse.readFile(foreignPath, 'utf8');
    await fse.outputFile(path.join(home, '.other/skills/legacy/SKILL.md'), '# Foreign copy\n');
    if (operation !== 'install') {
      await record('current', current, ['legacy'], { legacy: ['.claude/skills/legacy'] });
      await fse.outputFile(path.join(home, '.claude/skills/legacy/SKILL.md'), '# Previous current copy\n');
    }
    await publish(operation === 'install' ? ['legacy'] : []);

    if (operation === 'remove') await sourceRemove('current', {});
    else await pullSources(current, { force: true });

    expect(await fse.readFile(foreignPath, 'utf8')).toBe(before);
    expect(await fse.readFile(path.join(home, '.other/skills/legacy/SKILL.md'), 'utf8')).toBe('# Foreign copy\n');
    if (operation === 'install') {
      expect(await fse.readFile(path.join(home, '.claude/skills/legacy/SKILL.md'), 'utf8')).toBe('# Incoming legacy\n');
    } else expect(await fse.pathExists(path.join(home, '.claude/skills/legacy'))).toBe(false);
  });
});

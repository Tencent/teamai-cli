import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { loadCachedScorer, syncScorerDefinitions } from '../scorers/cache.js';
import { formatScorerDiagnostic } from '../scorers/definition.js';

const dirs: string[] = [];

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-scorer-cache-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

function writeScorer(config: LocalConfig, file: string, content: string): void {
  const target = path.join(config.repo.localPath, 'scorers', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeRoles(config: LocalConfig, content: string): void {
  fs.mkdirSync(path.join(config.repo.localPath, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(config.repo.localPath, 'manifest', 'roles.yaml'), content);
}

function dataFiles(config: LocalConfig): string[] {
  const home = config.dataHome ?? '';
  if (!fs.existsSync(home)) return [];
  return fs.readdirSync(home, { recursive: true, encoding: 'utf8' })
    .filter((file) => fs.statSync(path.join(home, file)).isFile())
    .map((file) => file.split(path.sep).join('/'));
}

const VALID = `---
labels:
  - { value: good, score: 1, description: Good. }
  - { value: bad, score: 0, description: Bad. }
passingScore: 1
---
Judge the change.
`;

const OPS_SCORERS = 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [] }\n  - id: ops\n    resources: { knowledge: [], skills: [], scorers: [ops] }\n';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scorer cache', () => {
  it('caches a valid scorer apart from workflows, and loads it by name', async () => {
    const config = testConfig();
    writeScorer(config, 'quality.md', VALID);

    const result = await syncScorerDefinitions(config);

    expect(result).toEqual({ cached: ['quality'], invalid: [], verified: [] });
    expect(dataFiles(config)).toEqual(['scorers/cache/quality.json']);
    expect((await loadCachedScorer(config, 'quality'))?.definition).toMatchObject({ name: 'quality', passingScore: 1, prompt: 'Judge the change.\n' });
  });

  it('ignores README.md, reports every other file, and caches none of them', async () => {
    const config = testConfig();
    writeScorer(config, 'README.md', '# Our scorers\n');
    writeScorer(config, 'eval.yaml', 'name: eval\n');
    writeScorer(config, 'broken.md', '---\nlabels: []\n---\nJudge.\n');

    const result = await syncScorerDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.invalid.map(formatScorerDiagnostic)).toEqual([
      'scorers/broken.md: labels must list 2 to 20 labels: at least one that passes and one that fails',
      'scorers/broken.md: passingScore must be a number',
      'scorers/eval.yaml: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md',
    ]);
    expect(dataFiles(config)).toEqual([]);
  });

  it('caches a scorer of every namespace on disk for a team without a roles or projects manifest', async () => {
    const config = testConfig();
    writeScorer(config, 'ops/review-quality.md', VALID);
    writeScorer(config, 'ops/README.md', '# Ops scorers\n');

    const result = await syncScorerDefinitions(config);

    expect(result).toEqual({ cached: ['review-quality'], invalid: [], verified: [] });
    expect((await loadCachedScorer(config, 'review-quality'))?.relativePath).toBe('scorers/ops/review-quality.md');
  });

  it('caches a scorer of a scorers/<dir>/ no role or project declares for a member with a role', async () => {
    const config = { ...testConfig(), primaryRole: 'dev' };
    writeRoles(config, OPS_SCORERS);
    writeScorer(config, 'shared/x.md', VALID);

    expect(await syncScorerDefinitions(config)).toEqual({ cached: ['x'], invalid: [], verified: [] });
    expect((await loadCachedScorer(config, 'x'))?.relativePath).toBe('scorers/shared/x.md');
  });

  it('caches neither a root scorer nor the scorer of one name in a scorers/<dir>/ no role or project declares', async () => {
    const config = { ...testConfig(), primaryRole: 'dev' };
    writeRoles(config, OPS_SCORERS);
    writeScorer(config, 'quality.md', VALID);
    writeScorer(config, 'shared/quality.md', VALID);

    const result = await syncScorerDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.invalid.map(formatScorerDiagnostic)).toEqual([
      'scorers/quality.md: scorer "quality" is shared twice (scorers/quality.md and scorers/shared/quality.md), so neither is used',
    ]);
  });

  it('skips a scorer of a namespace a role declares and this member does not have', async () => {
    const config = { ...testConfig(), primaryRole: 'dev' };
    writeRoles(config, OPS_SCORERS);
    writeScorer(config, 'ops/y.md', VALID);
    writeScorer(config, 'quality.md', VALID);

    expect(await syncScorerDefinitions(config)).toEqual({ cached: ['quality'], invalid: [], verified: [] });
    expect(await loadCachedScorer(config, 'y')).toBeNull();
  });

  it('caches a scorer of a namespace a role declares for a member who has that role', async () => {
    const config = { ...testConfig(), primaryRole: 'ops' };
    writeRoles(config, OPS_SCORERS);
    writeScorer(config, 'ops/y.md', VALID);

    expect(await syncScorerDefinitions(config)).toEqual({ cached: ['y'], invalid: [], verified: [] });
  });

  it('treats every namespace as inactive when the roles manifest cannot be read', async () => {
    const config = testConfig();
    writeRoles(config, 'roles: [unclosed\n');
    writeScorer(config, 'ops/review-quality.md', VALID);

    expect(await syncScorerDefinitions(config)).toEqual({ cached: [], invalid: [], verified: [] });
  });

  it('lets an active namespace scorer replace the root scorer of the same name', async () => {
    const config = testConfig();
    writeScorer(config, 'quality.md', VALID);
    writeScorer(config, 'ops/quality.md', VALID.replace('Judge the change.', 'Judge the deploy.'));

    expect(await syncScorerDefinitions(config)).toEqual({ cached: ['quality'], invalid: [], verified: [] });
    expect(await loadCachedScorer(config, 'quality')).toMatchObject({ relativePath: 'scorers/ops/quality.md', definition: { prompt: 'Judge the deploy.\n' } });
  });

  it('names the newly selected file when activation switches between identical root and namespace scorers', async () => {
    const config = testConfig();
    writeRoles(config, OPS_SCORERS);
    writeScorer(config, 'quality.md', VALID);
    writeScorer(config, 'ops/quality.md', VALID);
    await syncScorerDefinitions({ ...config, primaryRole: 'dev' });
    expect((await loadCachedScorer(config, 'quality'))?.relativePath).toBe('scorers/quality.md');

    await syncScorerDefinitions(config);

    expect((await loadCachedScorer(config, 'quality'))?.relativePath).toBe('scorers/ops/quality.md');
  });

  it('caches neither scorer when one name is in two active namespaces', async () => {
    const config = testConfig();
    writeScorer(config, 'ops/quality.md', VALID);
    writeScorer(config, 'qa/quality.md', VALID);
    await syncScorerDefinitions(config);

    const result = await syncScorerDefinitions(config);

    expect(result.cached).toEqual([]);
    expect(result.invalid.map(formatScorerDiagnostic)).toEqual([
      'scorers/ops/quality.md: scorer "quality" is in two active namespaces (scorers/ops/quality.md and scorers/qa/quality.md), so neither is used',
    ]);
    expect(await loadCachedScorer(config, 'quality')).toBeNull();
  });

  it('reports a directory that cannot be a namespace, a nested directory, a symlink and a non-Markdown file in a namespace', async () => {
    const config = testConfig();
    const scorers = path.join(config.repo.localPath, 'scorers');
    writeScorer(config, 'ops./quality.md', VALID);
    writeScorer(config, 'ops/deep/quality.md', VALID);
    writeScorer(config, 'ops/eval.yaml', 'name: eval\n');
    writeScorer(config, 'outside.md', VALID);
    fs.symlinkSync(path.join(scorers, 'outside.md'), path.join(scorers, 'ops', 'linked.md'));

    const result = await syncScorerDefinitions(config);

    expect(result.cached).toEqual(['outside']);
    expect(result.invalid.map(formatScorerDiagnostic)).toEqual([
      expect.stringMatching(/^scorers\/ops\.: not a scorer namespace; resource namespace must be a single path segment/),
      'scorers/ops/deep: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md',
      'scorers/ops/eval.yaml: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md',
      'scorers/ops/linked.md: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers, scoring.yaml settings and an optional README.md',
    ]);
  });

  it('drops a cached scorer once its file is invalid or gone', async () => {
    const config = testConfig();
    writeScorer(config, 'quality.md', VALID);
    await syncScorerDefinitions(config);

    writeScorer(config, 'quality.md', '---\npassingScore: 1\n---\nJudge.\n');
    await syncScorerDefinitions(config);

    expect(await loadCachedScorer(config, 'quality')).toBeNull();
  });

  it('writes nothing on a dry run', async () => {
    const config = testConfig();
    writeScorer(config, 'quality.md', VALID);

    expect(await syncScorerDefinitions(config, { dryRun: true })).toEqual({ cached: ['quality'], invalid: [], verified: [] });
    expect(dataFiles(config)).toEqual([]);
  });

  it('records the team revision only once origin reaches the commit that holds the scorer', async () => {
    const config = testConfig();
    const repository = config.repo.localPath;
    const remote = path.join(path.dirname(repository), 'remote.git');
    git(path.dirname(repository), 'init', '--bare', '--initial-branch=main', remote);
    git(repository, 'init', '--initial-branch=main');
    git(repository, 'config', 'user.name', 'TeamAI Test');
    git(repository, 'config', 'user.email', 'teamai@example.test');
    git(repository, 'remote', 'add', 'origin', remote);
    writeScorer(config, 'quality.md', VALID);
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'add scorer');

    await syncScorerDefinitions(config);
    expect((await loadCachedScorer(config, 'quality'))?.teamRevision).toBeUndefined();

    git(repository, 'push', '--set-upstream', 'origin', 'main');
    await syncScorerDefinitions(config);
    expect((await loadCachedScorer(config, 'quality'))?.teamRevision).toBe(git(repository, 'rev-parse', 'HEAD'));
  });
});

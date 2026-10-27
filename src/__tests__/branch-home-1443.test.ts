/**
 * #1443: a `kind: self` team keeps one side-branch checkout per branch,
 * resolved from the repository's project partition, for BOTH scopes and every
 * checkout. This covers the loader seam and the one-time takeover from the
 * user-scope location, including the lock a command still using it holds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LEARNINGS_LOCK_FILENAME,
  LEARNINGS_WORKTREE_DIRNAME,
  REPORTS_LOCK_FILENAME,
  REPORTS_WORKTREE_DIRNAME,
  SELF_BRANCH_HOME_DIRNAME,
  getDataHome,
  getWorktreeDir,
  type LocalConfig,
} from '../types.js';
import { loadLocalConfigForScope, saveLocalConfig, saveLocalConfigForScope } from '../config.js';
import { resolveAnchors } from '../utils/git.js';
import { legacyProjectSlug, projectDataHome } from '../utils/partition.js';
import { ensureReportsWorktree } from '../utils/reports-branch.js';
import { acquireLock, releaseLock } from '../update.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI test',
  GIT_AUTHOR_EMAIL: 'test@teamai.invalid',
  GIT_COMMITTER_NAME: 'TeamAI test',
  GIT_COMMITTER_EMAIL: 'test@teamai.invalid',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

describe('one side-branch checkout per self-mode repository (#1443)', () => {
  let sandbox: string;
  let oldHome: string | undefined;
  let home: string;
  let business: string;
  let userConfig: LocalConfig;
  let projectConfig: LocalConfig;

  beforeEach(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-branch-home-')));
    oldHome = process.env.HOME;
    home = path.join(sandbox, 'home');
    process.env.HOME = home;
    fs.mkdirSync(home, { recursive: true });

    const remote = path.join(sandbox, 'team.git');
    business = path.join(sandbox, 'business');
    git(['init', '-q', '--bare', remote], sandbox);
    git(['init', '-q', '-b', 'main', business], sandbox);
    fs.mkdirSync(path.join(business, '.teamai', 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(business, '.teamai', 'learnings', '.gitkeep'), '');
    fs.writeFileSync(path.join(business, '.teamai', 'teamai.yaml'), 'team: test\nmode: self\nrepo: https://git.example.com/team/business.git\nprovider: git\n');
    fs.writeFileSync(path.join(business, '.teamai', '.gitignore'), 'config.yaml\nstate.json\n');
    git(['add', '-A'], business);
    git(['commit', '-qm', 'init'], business);
    git(['remote', 'add', 'origin', remote], business);
    git(['push', '-q', '-u', 'origin', 'main'], business);

    // Both side branches on the remote, as an older install left them.
    for (const branch of ['teamai-reports', 'teamai-learnings']) {
      git(['checkout', '-q', '--orphan', branch], business);
      git(['rm', '-qrf', '.'], business);
      fs.writeFileSync(path.join(business, '.gitignore'), `${branch.replace('teamai-', '')}-wt/\n`);
      git(['add', '.gitignore'], business);
      git(['commit', '-qm', branch], business);
      git(['push', '-q', 'origin', branch], business);
      git(['checkout', '-q', 'main'], business);
    }

    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(business, '.teamai')}`,
      `  remote: ${remote}`,
      '  kind: self',
      `  businessRepoRoot: ${business}`,
      'username: tester',
      'updatePolicy: skip',
      'scope: user',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(business, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(business, '.teamai')}`,
      `  remote: ${remote}`,
      '  kind: self',
      `  businessRepoRoot: ${business}`,
      'username: tester',
      'updatePolicy: skip',
      'scope: project',
      `projectRoot: ${business}`,
      '',
    ].join('\n'));

    userConfig = (await loadLocalConfigForScope('user'))!;
    projectConfig = (await loadLocalConfigForScope('project', business))!;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('resolves the same checkout and lock for both scopes', async () => {
    const anchors = (await resolveAnchors(business))!;
    const branchHome = path.join(projectDataHome(anchors.projectAnchor), SELF_BRANCH_HOME_DIRNAME);
    expect(userConfig.branchHome).toBe(branchHome);
    expect(projectConfig.branchHome).toBe(branchHome);

    for (const dirname of [REPORTS_WORKTREE_DIRNAME, LEARNINGS_WORKTREE_DIRNAME]) {
      expect(getWorktreeDir(userConfig, dirname)).toBe(path.join(branchHome, dirname));
      expect(getWorktreeDir(projectConfig, dirname)).toBe(path.join(branchHome, dirname));
    }
    const reportsLock = (config: LocalConfig): string =>
      path.join(path.dirname(getWorktreeDir(config, REPORTS_WORKTREE_DIRNAME)), REPORTS_LOCK_FILENAME);
    const learningsLock = (config: LocalConfig): string =>
      path.join(path.dirname(getWorktreeDir(config, LEARNINGS_WORKTREE_DIRNAME)), LEARNINGS_LOCK_FILENAME);
    expect(reportsLock(userConfig)).toBe(reportsLock(projectConfig));
    expect(learningsLock(userConfig)).toBe(learningsLock(projectConfig));
  });

  it('never saves the runtime branch home', async () => {
    await saveLocalConfig(userConfig);
    expect(fs.readFileSync(path.join(home, '.teamai', 'config.yaml'), 'utf8')).not.toContain('branchHome');

    await saveLocalConfigForScope(projectConfig);
    expect(fs.readFileSync(path.join(getDataHome(projectConfig), 'config.yaml'), 'utf8')).not.toContain('branchHome');
  });

  it('keeps a git-mode checkout in the same partition apart', async () => {
    const anchors = (await resolveAnchors(business))!;
    const partition = projectDataHome(anchors.projectAnchor);
    // A git-mode team clone in this partition keeps its side branches as
    // siblings of the clone: <partition>/reports-wt. Self mode must not use it.
    const gitModeCheckout = path.join(partition, REPORTS_WORKTREE_DIRNAME);
    fs.mkdirSync(gitModeCheckout, { recursive: true });
    fs.writeFileSync(path.join(gitModeCheckout, 'owned-by-other-team'), '');

    const reloaded = (await loadLocalConfigForScope('user'))!;
    expect(getWorktreeDir(reloaded, REPORTS_WORKTREE_DIRNAME))
      .toBe(path.join(partition, SELF_BRANCH_HOME_DIRNAME, REPORTS_WORKTREE_DIRNAME));
    expect(fs.existsSync(path.join(gitModeCheckout, 'owned-by-other-team'))).toBe(true);
  });

  it('resolves the same checkout from a linked worktree of the business repo', async () => {
    const anchors = (await resolveAnchors(business))!;
    const partition = projectDataHome(anchors.projectAnchor);
    fs.mkdirSync(partition, { recursive: true });
    fs.copyFileSync(path.join(business, '.teamai', 'config.yaml'), path.join(partition, 'config.yaml'));

    const linked = path.join(sandbox, 'business-wt');
    git(['worktree', 'add', '-q', '-b', 'feat', linked], business);

    const fromLinked = (await loadLocalConfigForScope('project', linked))!;
    expect(fromLinked.branchHome).toBe(projectConfig.branchHome);
    for (const dirname of [REPORTS_WORKTREE_DIRNAME, LEARNINGS_WORKTREE_DIRNAME]) {
      expect(getWorktreeDir(fromLinked, dirname)).toBe(getWorktreeDir(projectConfig, dirname));
    }
  });

  it('adopts a partition still named for the pre-#546 layout', async () => {
    const anchors = (await resolveAnchors(business))!;
    const legacy = path.join(path.dirname(projectDataHome(anchors.projectAnchor)), legacyProjectSlug(anchors.projectAnchor));
    fs.mkdirSync(legacy, { recursive: true });
    const reloaded = (await loadLocalConfigForScope('user'))!;
    expect(reloaded.branchHome).toBe(path.join(projectDataHome(anchors.projectAnchor), SELF_BRANCH_HOME_DIRNAME));
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('takes the checkout over only when the old location is not in use', async () => {
    git(['fetch', '-q', 'origin', 'teamai-reports:teamai-reports'], business);
    const oldCheckout = path.join(home, '.teamai', REPORTS_WORKTREE_DIRNAME);
    git(['worktree', 'add', '-q', oldCheckout, 'teamai-reports'], business);

    const oldLock = path.join(home, '.teamai', REPORTS_LOCK_FILENAME);
    expect(await acquireLock(oldLock)).toBe(true);
    try {
      await expect(ensureReportsWorktree(userConfig)).rejects.toThrow(/being updated by another teamai command/);
      expect(fs.existsSync(oldCheckout)).toBe(true);
    } finally {
      await releaseLock(oldLock);
    }

    const wt = await ensureReportsWorktree(userConfig);
    expect(wt).toBe(path.join(userConfig.branchHome!, REPORTS_WORKTREE_DIRNAME));
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(oldCheckout)).toBe(false);
  });
});

/**
 * E2E (real git, NO mocks): proves reportUsageToTeam never wipes a self-mode
 * business repo working tree, and still resets a genuine git-mode cache clone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';

import { reportUsageToTeam } from '../team-push.js';
import type { LocalConfig } from '../types.js';

let tmp: string;
let originalHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-e2e-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function makeRepo(dir: string, branch = 'master'): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 't@t.com');
  await git.addConfig('user.name', 't');
  await git.checkoutLocalBranch(branch); // default branch = master, like the bug report
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n');
  await git.add('.');
  await git.commit('init');
}

describe('E2E self-mode: business repo working tree is never reset', () => {
  it('self mode: uncommitted change + non-master branch survive reportUsageToTeam', async () => {
    const businessRoot = path.join(tmp, 'business');
    await makeRepo(businessRoot);
    const git = simpleGit(businessRoot);

    // User is on a feature branch with uncommitted work (the scenario that was lost).
    await git.checkoutLocalBranch('feature/wip');
    fs.writeFileSync(path.join(businessRoot, 'app.js'), 'console.log("MY UNCOMMITTED WORK")\n');

    const teamaiDir = path.join(businessRoot, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });

    // self-mode user-scope config: localPath = <businessRoot>/.teamai
    const cfg: LocalConfig = {
      repo: { localPath: teamaiDir, remote: '', kind: 'self', businessRepoRoot: businessRoot },
      username: 'me',
      scope: 'user',
      additionalRoles: [],
    } as unknown as LocalConfig;

    // The bug path: pull passes selfConfig now (fix 1). Even without it, the
    // isDedicatedRoot guard (fix 2) must protect the tree — test the guard by
    // NOT passing selfConfig, forcing the else branch.
    await reportUsageToTeam(teamaiDir, 'me', { skipTruncate: true });

    // Assert the user's working tree is untouched.
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const content = fs.readFileSync(path.join(businessRoot, 'app.js'), 'utf-8');
    expect(branch).toBe('feature/wip');
    expect(content).toContain('MY UNCOMMITTED WORK');
  });

  it('git mode: a real dedicated cache clone IS still reset (no regression)', async () => {
    // A dedicated cache clone: repoPath IS the git top level.
    // Use 'main' as default branch so resetToCleanMaster's fallback checkout matches.
    const cacheRoot = path.join(tmp, 'cache');
    await makeRepo(cacheRoot, 'main');
    const git = simpleGit(cacheRoot);

    // Simulate stale dirty state in the cache.
    fs.writeFileSync(path.join(cacheRoot, 'app.js'), 'garbage\n');

    await reportUsageToTeam(cacheRoot, 'me', { skipTruncate: true });

    // reset --hard should have discarded the dirty change in the cache clone.
    const content = fs.readFileSync(path.join(cacheRoot, 'app.js'), 'utf-8');
    expect(content).toBe('console.log(1)\n');
  });

  it('project scope (git kind): business repo is NOT reset when team-repo dir lacks its own .git', async () => {
    // Reproduces the v0.19.0 data-loss path outside self mode: in project scope the
    // team repo lives at <projectRoot>/.teamai/team-repo. If that dir has no dedicated
    // .git (e.g. clone never completed), git commands there bubble up to the business
    // repo's .git — so an unguarded reset --hard + checkout would wipe the user's tree.
    const businessRoot = path.join(tmp, 'project');
    await makeRepo(businessRoot);
    const git = simpleGit(businessRoot);

    // User is on a feature branch with uncommitted work.
    await git.checkoutLocalBranch('feature/wip');
    fs.writeFileSync(path.join(businessRoot, 'app.js'), 'console.log("MY UNCOMMITTED WORK")\n');

    // team-repo dir exists but is a plain directory (no dedicated .git of its own).
    const teamRepoDir = path.join(businessRoot, '.teamai', 'team-repo');
    fs.mkdirSync(teamRepoDir, { recursive: true });

    // git-mode report to the in-business-repo path. The isDedicatedRoot guard must
    // detect that show-toplevel resolves to the business root, not teamRepoDir, and bail.
    const logBefore = await git.log();
    await reportUsageToTeam(teamRepoDir, 'me', { skipTruncate: true });

    // The user's working tree and branch must be intact.
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    const content = fs.readFileSync(path.join(businessRoot, 'app.js'), 'utf-8');
    expect(branch).toBe('feature/wip');
    expect(content).toContain('MY UNCOMMITTED WORK');
    // Guard must also prevent a spurious stats commit from landing on the user's branch.
    const logAfter = await git.log();
    expect(logAfter.total).toBe(logBefore.total);
  });
});

/**
 * Real-git coverage for learnings leaving the default branch (#485).
 * No mocks of the units under test: a bare origin whose `update` hook refuses
 * the default branch is exactly the protected repo a member cannot push to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { LEARNINGS_WORKTREE_DIRNAME, type LocalConfig } from '../types.js';
import { learningsRoots } from '../utils/learnings-roots.js';
import { savePendingLearning, listPendingLearnings } from '../utils/pending-learnings.js';
import { publishQueuedLearnings } from '../utils/learnings-publish.js';

let tmp: string;
let originalHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-learnings-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function configureGit(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.addConfig('user.email', 't@t.com');
  await git.addConfig('user.name', 't');
}

/** A team repo whose default branch is protected, plus a member's clone. */
async function seedProtectedOrigin(): Promise<{ origin: string; clone: string }> {
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await configureGit(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  // Knowledge the team wrote before learnings moved off the default branch.
  fs.writeFileSync(path.join(seed, 'learnings', 'inherited.md'), '# written before the switch');
  await seedGit.add(['.']);
  await seedGit.commit('init knowledge');

  const origin = path.join(tmp, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const hook = path.join(origin, 'hooks', 'update');
  fs.writeFileSync(hook, `#!/bin/sh
ref="$1"
if [ "$ref" = "refs/heads/main" ] || [ "$ref" = "refs/heads/master" ]; then
  echo "default branch is protected" >&2
  exit 1
fi
exit 0
`);
  fs.chmodSync(hook, 0o755);

  const clone = path.join(tmp, 'team-repo');
  await simpleGit().clone(origin, clone);
  await configureGit(clone);
  return { origin, clone };
}

function gitConfig(clone: string, username = 'alice'): LocalConfig {
  return {
    repo: { localPath: clone, remote: path.join(tmp, 'origin.git'), kind: 'git' },
    username,
    scope: 'user',
    additionalRoles: [],
  };
}

async function refsOf(origin: string, branch: string): Promise<string[]> {
  try {
    const out = await simpleGit(origin).raw(['ls-tree', '-r', '--name-only', branch]);
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('contributing to a repo whose default branch is protected', () => {
  it('publishes the learning on teamai-learnings, with no commit on the default branch', async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const config = gitConfig(clone);
    const mainBefore = (await simpleGit(origin).raw(['rev-parse', 'main'])).trim();

    await savePendingLearning(config, 'first-2026-01-01-aaa111.md', '# retry budget');
    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual(['first-2026-01-01-aaa111.md']);
    expect(await refsOf(origin, 'teamai-learnings'))
      .toContain('learnings/first-2026-01-01-aaa111.md');
    expect((await simpleGit(origin).raw(['rev-parse', 'main'])).trim()).toBe(mainBefore);
    expect(await listPendingLearnings(config)).toEqual([]);
  });

  it('keeps the queued copy when the learnings branch is refused too', async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const hook = path.join(origin, 'hooks', 'update');
    fs.writeFileSync(hook, '#!/bin/sh\necho "everything is protected" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const config = gitConfig(clone);

    await savePendingLearning(config, 'blocked-2026-01-01-bbb222.md', '# blocked');
    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual([]);
    expect(report.remaining).toBe(1);
    expect(report.lastError).toBeDefined();
    expect(await listPendingLearnings(config)).toEqual(['blocked-2026-01-01-bbb222.md']);
  });

  it('delivers a learning that was committed locally when the push failed', async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const hook = path.join(origin, 'hooks', 'update');
    const refuseEverything = '#!/bin/sh\necho "everything is protected" >&2\nexit 1\n';
    const refuseDefaultOnly = fs.readFileSync(hook, 'utf8');
    fs.writeFileSync(hook, refuseEverything);
    fs.chmodSync(hook, 0o755);
    const config = gitConfig(clone);

    // First attempt: the content is committed in the worktree, the push fails.
    await savePendingLearning(config, 'retried-2026-01-01-iii999.md', '# retried');
    expect((await publishQueuedLearnings(config, 'alice')).published).toEqual([]);

    // Second attempt with the branch writable again: the commit is already
    // there, so nothing new stages. It still has to reach origin.
    fs.writeFileSync(hook, refuseDefaultOnly);
    fs.chmodSync(hook, 0o755);
    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual(['retried-2026-01-01-iii999.md']);
    expect(await refsOf(origin, 'teamai-learnings'))
      .toContain('learnings/retried-2026-01-01-iii999.md');
    expect(await listPendingLearnings(config)).toEqual([]);
  });

  it('reports success from a single-branch clone, where no tracking ref appears', async () => {
    const { origin } = await seedProtectedOrigin();
    // What CI checkouts and plenty of business repos are: the fetch refspec
    // covers the default branch only, so pushing a side branch leaves no
    // `origin/teamai-learnings` behind even though the push was accepted.
    const narrow = path.join(tmp, 'narrow-clone');
    await simpleGit().clone(origin, narrow, ['--single-branch', '--branch', 'main']);
    await configureGit(narrow);
    const config: LocalConfig = {
      repo: { localPath: narrow, remote: origin, kind: 'git' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    };

    await savePendingLearning(config, 'narrow-2026-01-01-jjj000.md', '# from a narrow clone');
    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual(['narrow-2026-01-01-jjj000.md']);
    expect(await refsOf(origin, 'teamai-learnings'))
      .toContain('learnings/narrow-2026-01-01-jjj000.md');
    expect(await listPendingLearnings(config)).toEqual([]);
  });

  it('names a queue entry it cannot read, instead of failing forever without a reason', async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const config = gitConfig(clone);

    await savePendingLearning(config, 'good-2026-01-01-kkk111.md', '# readable');
    const unreadable = await savePendingLearning(config, 'bad-2026-01-01-lll222.md', '# unreadable');
    fs.chmodSync(unreadable, 0o000);

    try {
      const report = await publishQueuedLearnings(config, 'alice');

      expect(report.published).toEqual(['good-2026-01-01-kkk111.md']);
      expect(await refsOf(origin, 'teamai-learnings'))
        .toContain('learnings/good-2026-01-01-kkk111.md');
      // The one that stays behind says which file and why.
      expect(report.remaining).toBe(1);
      expect(report.lastError).toContain('bad-2026-01-01-lll222.md');
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }
  });

  it('writes into a worktree beside the clone, never into the clone itself', async () => {
    const { clone } = await seedProtectedOrigin();
    const config = gitConfig(clone);

    await savePendingLearning(config, 'sibling-2026-01-01-ccc333.md', '# beside');
    await publishQueuedLearnings(config, 'alice');

    const worktree = path.join(path.dirname(clone), LEARNINGS_WORKTREE_DIRNAME);
    expect(fs.existsSync(path.join(worktree, 'learnings', 'sibling-2026-01-01-ccc333.md'))).toBe(true);
    expect(fs.existsSync(path.join(clone, 'learnings', 'sibling-2026-01-01-ccc333.md'))).toBe(false);
  });

  it('still reads the corpus the team wrote before the switch', async () => {
    const { clone } = await seedProtectedOrigin();
    const config = gitConfig(clone);

    await savePendingLearning(config, 'new-2026-01-01-ddd444.md', '# new');
    await publishQueuedLearnings(config, 'alice');

    const roots = learningsRoots(config);
    const { listLearningFiles } = await import('../utils/learnings-roots.js');
    const files = (await listLearningFiles(roots.read)).map((f) => f.file);

    expect(files).toContain('new-2026-01-01-ddd444.md');
    expect(files).toContain('inherited.md');
    // Nothing was copied or deleted: the inherited copy is still in the clone.
    expect(fs.existsSync(path.join(clone, 'learnings', 'inherited.md'))).toBe(true);
  });

  it('publishes a namespaced learning into its subdirectory (PR #426 P1 regression)', async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const config = gitConfig(clone);
    const relPath = path.join('alpha-notes', 'scoped-2026-01-01-ggg777.md');

    await savePendingLearning(config, relPath, '# project-private');
    const report = await publishQueuedLearnings(config, 'alice');

    expect(report.published).toEqual([relPath]);
    expect(await refsOf(origin, 'teamai-learnings'))
      .toContain('learnings/alpha-notes/scoped-2026-01-01-ggg777.md');
  });

  it("reads another member's learning after refreshing the branch", async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const alice = gitConfig(clone, 'alice');
    await savePendingLearning(alice, 'from-alice-2026-01-01-hhh888.md', '# alice knows');
    await publishQueuedLearnings(alice, 'alice');

    const bobClone = path.join(tmp, 'team-repo-bob');
    await simpleGit().clone(origin, bobClone);
    await configureGit(bobClone);
    const bob: LocalConfig = {
      repo: { localPath: bobClone, remote: origin, kind: 'git' },
      username: 'bob',
      scope: 'user',
      additionalRoles: [],
    };

    const { learningsBranch } = await import('../utils/learnings-branch.js');
    await learningsBranch.refresh(bob, { pushIfCreated: false });

    const { listLearningFiles } = await import('../utils/learnings-roots.js');
    const files = (await listLearningFiles(learningsRoots(bob).read)).map((f) => f.file);
    expect(files).toContain('from-alice-2026-01-01-hhh888.md');
  });

  it('lands both learnings when two members publish at the same time', async () => {
    const { origin, clone } = await seedProtectedOrigin();
    const alice = gitConfig(clone, 'alice');

    const bobClone = path.join(tmp, 'team-repo-bob');
    await simpleGit().clone(origin, bobClone);
    await configureGit(bobClone);
    const bob: LocalConfig = {
      repo: { localPath: bobClone, remote: origin, kind: 'git' },
      username: 'bob',
      scope: 'user',
      additionalRoles: [],
    };

    await savePendingLearning(alice, 'alice-2026-01-01-eee555.md', '# from alice');
    await savePendingLearning(bob, 'bob-2026-01-01-fff666.md', '# from bob');

    await publishQueuedLearnings(alice, 'alice');
    await publishQueuedLearnings(bob, 'bob');

    const published = await refsOf(origin, 'teamai-learnings');
    expect(published).toContain('learnings/alice-2026-01-01-eee555.md');
    expect(published).toContain('learnings/bob-2026-01-01-fff666.md');
  });
});

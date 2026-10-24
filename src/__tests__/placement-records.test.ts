import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockWarn = vi.fn();
vi.mock('../utils/logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: (...args: unknown[]) => mockWarn(...args), error: vi.fn(), success: vi.fn() },
}));
const mockRemoteBranchExists = vi.fn();
vi.mock('../utils/git.js', async () => ({
  ...(await vi.importActual<typeof import('../utils/git.js')>('../utils/git.js')),
  remoteBranchExists: (...args: unknown[]) => mockRemoteBranchExists(...args),
}));
import { execFileSync } from 'node:child_process';

import { reconcilePlacementRecords, isPlacement } from '../utils/pending-push.js';
import type { PendingPush, ResourceItem, State } from '../types.js';

/**
 * A placement record says "the author's root copy of <name> IS the team file
 * at <root>/<ns>/<name>". Push marks the placement on the pending PR entry;
 * only once that file is on the default branch does it become a record — so a
 * PR closed unmerged, branch kept or not, never leaves one behind, and no
 * provider has to be asked whether a PR is open. A record is withdrawn again
 * when its file is gone, or when a shared-root file of the same name appears
 * and takes over the root path in every tool directory (#649 review).
 */
describe('reconcilePlacementRecords', () => {
  let repoPath: string;
  const pending = (items: PendingPush['items'], branch = 'teamai/push/me/1'): PendingPush => ({
    branch, prUrl: null, createdAt: '2026-01-01T00:00:00.000Z', items,
  });
  // A factory: recording consumes the mark on the item, so tests must not share one.
  const placedRule = () => ({ type: 'rules', name: 'my-rule', relativePath: 'rules/fe/my-rule.md', namespace: 'fe', placed: true });

  beforeEach(async () => {
    repoPath = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-placed-'));
    mockRemoteBranchExists.mockReset();
    mockWarn.mockReset();
  });
  afterEach(async () => { await fse.remove(repoPath); });

  /** Commit `content` at `rel` on the default branch, as a merge would; returns its blob. */
  const land = async (rel: string, content: string): Promise<string> => {
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    if (!await fse.pathExists(path.join(repoPath, '.git'))) run(['init', '-q', '-b', 'main']);
    await fse.outputFile(path.join(repoPath, rel), content);
    run(['add', '-A']); run(['commit', '-q', '-m', `land ${rel}`]);
    return run(['hash-object', rel]);
  };

  it('records a placement once the blob it pushed is on the default branch', async () => {
    const blob = await land('rules/fe/my-rule.md', 'x');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), blob }])] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('records a repo-backed placement by the path the author still edits', async () => {
    // docs, wiki, prompts and the other repo-backed types have no placedRules /
    // placedAgents field: the record is keyed by the shared-root path the author
    // keeps editing, so a self-mode scan can compare it with the destination.
    const blob = await land('docs/ops/guide.md', 'x');
    const state = {
      placedRules: {}, placedAgents: {}, placements: {} as NonNullable<State['placements']>,
      pendingPushes: [pending([{
        type: 'docs',
        name: 'guide.md',
        relativePath: 'docs/ops/guide.md',
        namespace: 'ops',
        sourcePath: 'docs/guide.md',
        placed: true,
        blob,
      }])],
    };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placements).toEqual({ 'docs:docs/guide.md': { path: 'docs/ops/guide.md', blob } });
    expect(state.pendingPushes[0]?.items[0]?.placed).toBe(false);
  });

  it('drops a repo-backed record whose destination was deleted since the last check', async () => {
    // A removal that merged, then another member's file at the same path: the
    // record must not route this author's edits onto that file.
    const run = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    const commit = (message: string): string => {
      run(['add', '-A']);
      run(['commit', '-q', '-m', message]);
      return run(['rev-parse', 'HEAD']);
    };
    run(['init', '-q', '-b', 'main']);
    await fse.outputFile(path.join(repoPath, 'docs/ops/guide.md'), 'ours');
    const blob = run(['hash-object', 'docs/ops/guide.md']);
    const checkedAt = commit('landed');
    await fse.remove(path.join(repoPath, 'docs/ops/guide.md'));
    commit('removed');
    await fse.outputFile(path.join(repoPath, 'docs/ops/guide.md'), 'somebody else\'s');
    commit('recreated');

    const state = {
      placedRules: {}, placedAgents: {},
      placements: { 'docs:docs/guide.md': { path: 'docs/ops/guide.md', blob } },
      placementsCheckedAt: checkedAt,
      pendingPushes: [],
    };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placements).toEqual({});
  });

  it('spends a placement with no blob instead of recording it because the path exists', async () => {
    // Nothing tells its landing from another member creating the path after
    // this PR closed unmerged (#649 review).
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'somebody else\'s');
    const entry = pending([placedRule()]);
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [entry] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({});
    expect(entry.items[0]?.placed).toBe(false);
  });

  it('records nothing while the placement is not on the default branch, whatever its branch is doing', async () => {
    // Open PR, or closed unmerged with the branch kept: the same from here,
    // and neither may leave a record.
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), blob: 'deadbeef' }])] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({});
    expect(mockRemoteBranchExists).not.toHaveBeenCalled();
  });

  it('records a placement only when the blob it pushed is in the default branch history for that path', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    git(['init', '-q', '-b', 'main']);
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'ours, as pushed\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'merge ours']);
    const ours = git(['hash-object', 'rules/fe/my-rule.md']);
    // A teammate edits it afterwards: the path still exists, the blob differs now.
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'edited after the merge\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'teammate edit']);
    await fse.outputFile(path.join(repoPath, 'never-committed.md'), 'never pushed anywhere\n');
    const theirs = git(['hash-object', 'never-committed.md']);

    const landed = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), blob: ours }])] };
    expect(await reconcilePlacementRecords(repoPath, landed)).toBe(true);
    expect(landed.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });

    // Same path, but what is there was never what we pushed: somebody else's file.
    const shadow = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), blob: theirs }])] };
    expect(await reconcilePlacementRecords(repoPath, shadow)).toBe(false);
    expect(shadow.placedRules).toEqual({});
  });

  it('proves landing only by commits after the revision the push branch was built on', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    const file = path.join(repoPath, 'rules/fe/my-rule.md');
    git(['init', '-q', '-b', 'main']);
    // The same content sat at this path once, long before the push.
    await fse.outputFile(file, 'ours, as pushed\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'an old rule']);
    const ours = git(['hash-object', 'rules/fe/my-rule.md']);
    git(['rm', '-q', 'rules/fe/my-rule.md']); git(['commit', '-q', '-m', 'retired']);
    const base = git(['rev-parse', '--short', 'HEAD']);
    // The placement PR is closed unmerged; a teammate then creates the path.
    await fse.outputFile(file, 'somebody else\'s\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'teammate rule']);

    const entry = { ...pending([{ ...placedRule(), blob: ours }]), base };
    const closed = { placedRules: {}, placedAgents: {}, pendingPushes: [entry] };
    await reconcilePlacementRecords(repoPath, closed);
    expect(closed.placedRules).toEqual({});
    // The path arrived without what was pushed: indistinguishable from a
    // reviewer's edit before a squash merge, so the author is told, once.
    expect(entry.items[0]?.placed).toBe(false);
    expect(mockWarn.mock.calls.flat().join(' ')).toContain('not with the content you pushed');
  });

  it('drops a record whose file was deleted and recreated between two checks', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    const file = path.join(repoPath, 'agents/fe/vr.yaml');
    git(['init', '-q', '-b', 'main']);
    await fse.outputFile(file, 'name: vr\n# the author\'s\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'placement merged']);
    const state = { placedRules: {}, placedAgents: { vr: 'agents/fe/vr.yaml' }, pendingPushes: [] } as {
      placedRules: Record<string, string>; placedAgents: Record<string, string>;
      pendingPushes: PendingPush[]; placementsCheckedAt?: string;
    };
    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placementsCheckedAt).toBe(git(['rev-parse', 'HEAD']));

    // The author's removal merges, and another member publishes their own vr
    // at the same path before the author runs anything.
    git(['rm', '-q', 'agents/fe/vr.yaml']); git(['commit', '-q', '-m', 'removal merged']);
    await fse.outputFile(file, 'name: vr\n# somebody else\'s\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'teammate vr']);

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedAgents).toEqual({});
    // Retired just like a record whose file is simply gone: the author's
    // flattened copy was the removed agent's, whatever sits there now.
    expect((state as { retiredPlacedAgents?: Record<string, string> }).retiredPlacedAgents)
      .toEqual({ vr: 'agents/fe/vr.yaml' });
  });

  describe('the checkpoint and the ref it is read from', () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    type ReconcileState = Parameters<typeof reconcilePlacementRecords>[1];
    const commitFile = async (rel: string, content: string, message: string) => {
      await fse.outputFile(path.join(repoPath, rel), content);
      git(['add', '-A']); git(['commit', '-q', '-m', message]);
      return git(['hash-object', rel]);
    };

    it('clears the checkpoint with the last record, so a later re-placement at that path is recorded', async () => {
      git(['init', '-q', '-b', 'main']);
      await commitFile('rules/fe/my-rule.md', 'first\n', 'placement merged');
      const state: ReconcileState = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };
      await reconcilePlacementRecords(repoPath, state);
      git(['rm', '-q', 'rules/fe/my-rule.md']); git(['commit', '-q', '-m', 'removal merged']);
      await reconcilePlacementRecords(repoPath, state);
      expect(state.placedRules).toEqual({});
      expect(state.placementsCheckedAt).toBeUndefined();

      // The author places the rule again, and that PR merges.
      const base = git(['rev-parse', 'HEAD']);
      const blob = await commitFile('rules/fe/my-rule.md', 'second\n', 're-placement merged');
      state.pendingPushes = [{ ...pending([{ ...placedRule(), blob }]), base }];
      await reconcilePlacementRecords(repoPath, state);

      expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
    });

    it('keeps a record made in this run although the checkpoint predates an earlier deletion of its path', async () => {
      git(['init', '-q', '-b', 'main']);
      await commitFile('rules/fe/other.md', 'other\n', 'another placement');
      const state: ReconcileState = { placedRules: { other: 'rules/fe/other.md' }, placedAgents: {}, pendingPushes: [] };
      await reconcilePlacementRecords(repoPath, state);
      // Before the author's next check: my-rule is created and deleted by
      // somebody, then the author's own placement of it lands.
      await commitFile('rules/fe/my-rule.md', 'somebody\'s\n', 'teammate rule');
      git(['rm', '-q', 'rules/fe/my-rule.md']); git(['commit', '-q', '-m', 'teammate removal']);
      const base = git(['rev-parse', 'HEAD']);
      const blob = await commitFile('rules/fe/my-rule.md', 'ours\n', 'our placement merged');
      state.pendingPushes = [{ ...pending([{ ...placedRule(), blob }]), base }];

      await reconcilePlacementRecords(repoPath, state);

      expect(state.placedRules).toEqual({ other: 'rules/fe/other.md', 'my-rule': 'rules/fe/my-rule.md' });
    });

    it('reads the default branch through a ref when the checkout is somewhere else', async () => {
      // A single-repo member on a feature branch cut before the placement merged.
      git(['init', '-q', '-b', 'main']);
      await commitFile('README.md', 'seed\n', 'seed');
      git(['checkout', '-q', '-b', 'feature']);
      git(['checkout', '-q', 'main']);
      const base = git(['rev-parse', 'HEAD']);
      const blob = await commitFile('rules/fe/my-rule.md', 'ours\n', 'placement merged');
      git(['checkout', '-q', 'feature']);
      const state: ReconcileState = {
        placedRules: {}, placedAgents: {}, pendingPushes: [{ ...pending([{ ...placedRule(), blob }]), base }],
      };

      expect(await reconcilePlacementRecords(repoPath, state, 'main')).toBe(true);
      expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
      expect(state.placementsCheckedAt).toBe(git(['rev-parse', 'main']));
      // Reconciled against the checkout itself, the same record is dropped.
      const againstCheckout: ReconcileState = { ...state, placedRules: { ...state.placedRules } };
      await reconcilePlacementRecords(repoPath, againstCheckout);
      expect(againstCheckout.placedRules).toEqual({});
    });

    it('changes nothing when the ref cannot be resolved', async () => {
      git(['init', '-q', '-b', 'main']);
      await commitFile('README.md', 'seed\n', 'seed');
      const state: ReconcileState = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };

      expect(await reconcilePlacementRecords(repoPath, state, 'origin/main')).toBe(false);
      expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
    });
  });

  it('spends a placement unrecorded when its path was deleted and recreated before the first check', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
    } }).trim();
    const file = path.join(repoPath, 'rules/fe/my-rule.md');
    git(['init', '-q', '-b', 'main']);
    await fse.outputFile(path.join(repoPath, 'README.md'), 'seed\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'seed']);
    const base = git(['rev-parse', 'HEAD']);
    await fse.outputFile(file, 'ours, as pushed\n');
    const ours = git(['hash-object', 'rules/fe/my-rule.md']);
    git(['add', '-A']); git(['commit', '-q', '-m', 'placement merged']);
    git(['rm', '-q', 'rules/fe/my-rule.md']); git(['commit', '-q', '-m', 'team deleted it']);
    await fse.outputFile(file, 'somebody else\'s\n');
    git(['add', '-A']); git(['commit', '-q', '-m', 'teammate rule']);

    const entry = { ...pending([{ ...placedRule(), blob: ours }]), base };
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [entry] };
    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({});
    expect(entry.items[0]?.placed).toBe(false);
  });

  it('records a placement once: not again after the team deleted the file and someone recreated the path', async () => {
    const blob = await land('rules/fe/my-rule.md', 'ours');
    const entry = pending([{ ...placedRule(), blob }]);
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [entry] };
    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
    expect(entry.items[0]?.placed).toBe(false);

    // The team deletes it: the record goes.
    execFileSync('git', ['rm', '-q', 'rules/fe/my-rule.md'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'deleted'], { cwd: repoPath });
    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({});

    // Another member recreates the path. The blob we pushed is still in the
    // history, so only the consumed mark keeps this from becoming ours again.
    await land('rules/fe/my-rule.md', 'somebody else\'s');
    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({});
  });

  it('does not record a pending item that was not a placement', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), placed: undefined }])] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({});
  });

  it('keeps a record whose file is on the default branch', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'x');
    const state = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(false);
    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });

  it('drops every record whose file the team has deleted, not just the last one', async () => {
    // Deleting by destructuring from the ORIGINAL map put back what an earlier
    // iteration had removed, so only the last stale record actually went.
    await fse.outputFile(path.join(repoPath, 'rules/fe/kept.md'), 'x');
    const state = {
      placedRules: { gone1: 'rules/fe/gone1.md', kept: 'rules/fe/kept.md', gone2: 'rules/fe/gone2.md' },
      placedAgents: { vr: 'agents/fe/vr.yaml', qa: 'agents/fe/qa.yaml' },
      pendingPushes: [],
    };

    expect(await reconcilePlacementRecords(repoPath, state)).toBe(true);
    expect(state.placedRules).toEqual({ kept: 'rules/fe/kept.md' });
    expect(state.placedAgents).toEqual({});
    // The author's flattened agent copies stood for these; removedStems needs that.
    expect((state as { retiredPlacedAgents?: Record<string, string> }).retiredPlacedAgents)
      .toEqual({ vr: 'agents/fe/vr.yaml', qa: 'agents/fe/qa.yaml' });
  });

  // Legacy mode (no roles, no projects) delivers every namespace beside the
  // root, so a shared-root file of the placed name owns the author's path.
  it('withdraws a record in legacy mode once a shared-root file of the same name exists, and says so', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'the author\'s');
    await fse.outputFile(path.join(repoPath, 'rules/my-rule.md'), 'somebody else\'s, for everyone');
    const state = { placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: {}, pendingPushes: [] };

    expect(await reconcilePlacementRecords(repoPath, state, undefined, async () => true)).toBe(true);
    expect(state.placedRules).toEqual({});
    expect(mockWarn.mock.calls.flat().join(' ')).toContain('rules/my-rule.md now exists at the shared root');
  });

  it('withdraws an agent record in legacy mode shadowed by a legacy shared-root .md of the same stem', async () => {
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\n');
    await fse.outputFile(path.join(repoPath, 'agents/vr.md'), '# vr\n');
    const state = { placedRules: {}, placedAgents: { vr: 'agents/fe/vr.yaml' }, pendingPushes: [] };

    expect(await reconcilePlacementRecords(repoPath, state, undefined, async () => true)).toBe(true);
    expect(state.placedAgents).toEqual({});
  });

  it('does not record a landed placement in legacy mode that a shared-root file already shadows', async () => {
    const blob = await land('rules/fe/my-rule.md', 'x');
    await land('rules/my-rule.md', 'y');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), blob }])] };

    await reconcilePlacementRecords(repoPath, state, undefined, async () => true);

    expect(state.placedRules).toEqual({});
  });

  // With roles or projects, the recorded resource replaces the shared-root one
  // of its name, as an active namespace's would (#707).
  it('keeps rule and agent records when a shared-root file of the same name exists', async () => {
    await fse.outputFile(path.join(repoPath, 'rules/fe/my-rule.md'), 'the author\'s');
    await fse.outputFile(path.join(repoPath, 'rules/my-rule.md'), 'somebody else\'s, for everyone');
    await fse.outputFile(path.join(repoPath, 'agents/fe/vr.yaml'), 'name: vr\n');
    await fse.outputFile(path.join(repoPath, 'agents/vr.yaml'), 'name: vr\n');
    const state = {
      placedRules: { 'my-rule': 'rules/fe/my-rule.md' }, placedAgents: { vr: 'agents/fe/vr.yaml' }, pendingPushes: [],
    };

    await reconcilePlacementRecords(repoPath, state);

    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
    expect(state.placedAgents).toEqual({ vr: 'agents/fe/vr.yaml' });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('records a landed placement although a shared-root file has the same name', async () => {
    const blob = await land('rules/fe/my-rule.md', 'x');
    await land('rules/my-rule.md', 'y');
    const state = { placedRules: {}, placedAgents: {}, pendingPushes: [pending([{ ...placedRule(), blob }])] };

    await reconcilePlacementRecords(repoPath, state);

    expect(state.placedRules).toEqual({ 'my-rule': 'rules/fe/my-rule.md' });
  });
});

describe('isPlacement', () => {
  const base = { sourcePath: '/tmp/x', status: 'new' as const };
  it('is a new root rule or agent that ended up namespaced', () => {
    expect(isPlacement({ ...base, type: 'rules', name: 'my-rule', relativePath: 'rules/fe/my-rule.md', namespace: 'fe' })).toBe(true);
    expect(isPlacement({ ...base, type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe' })).toBe(true);
  });
  it('is not a rule the scanner found in a subdirectory, a modified item, a skill, or an unplaced one', () => {
    expect(isPlacement({ ...base, type: 'rules', name: 'fe/my-rule', relativePath: 'rules/fe/my-rule.md', namespace: 'fe' })).toBe(false);
    expect(isPlacement({ ...base, type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe', status: 'modified' })).toBe(false);
    expect(isPlacement({ ...base, type: 'skills', name: 's', relativePath: 'skills/fe/s', namespace: 'fe' })).toBe(false);
    expect(isPlacement({ ...base, type: 'rules', name: 'my-rule', relativePath: 'rules/my-rule.md' })).toBe(false);
  });
  it('is an agent rewritten under another extension through its record', () => {
    const item: ResourceItem & { supersedes: string } = {
      ...base, type: 'agents', name: 'vr', relativePath: 'agents/fe/vr.yaml', namespace: 'fe',
      status: 'modified', supersedes: 'agents/fe/vr.md',
    };
    expect(isPlacement(item)).toBe(true);
  });
});

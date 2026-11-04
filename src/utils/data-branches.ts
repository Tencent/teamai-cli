/**
 * The teamai data branches a workflow step with `deliver: publish` publishes to, each through this machine's persistent
 * checkout of it: `teamai-reports` and `teamai-learnings`. Each step's patch is kept in this data home, then committed on
 * that checkout in order with the others kept there and removed. A commit origin could not take stays on the checkout,
 * and a patch that could not be committed, because another process held the checkout or it does not apply, stays kept.
 * `pushPending` sends both later.
 *
 *   <dataHome>/data-branches/<branch>/pending/<time>-<run>-<attempt>.patch    a staged change that has not landed yet, named to apply oldest first
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_BRANCHES, getDataHome, usesBranchWorktree, type DataBranch, type LocalConfig } from '../types.js';
import { failureReason, isDelivered, type BranchWorktree, type PublishResult } from './branch-worktree.js';
import { commitSkippingHooks, createGit, isGitRepo } from './git.js';
import { learningsBranch } from './learnings-branch.js';
import { reportsBranch } from './reports-branch.js';

const CHECKOUTS: Record<DataBranch, BranchWorktree> = { 'teamai-reports': reportsBranch, 'teamai-learnings': learningsBranch };

function keptDir(config: LocalConfig, branch: DataBranch): string {
  return path.join(getDataHome(config), 'data-branches', branch, 'pending');
}

/** The patches kept for `branch`, oldest first. */
async function keptFiles(config: LocalConfig, branch: DataBranch): Promise<string[]> {
  const dir = keptDir(config, branch);

  return (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.patch')).sort().map((name) => path.join(dir, name));
}

type Stuck = { file: string; error: string };

/**
 * The lines `patch` appends to the end of each file it changes, or undefined unless that is all it does: one hunk per
 * file, adding lines after its context and removing none, as a step that appends a note or a label does.
 */
function appendedLines(patch: string): Map<string, string[]> | undefined {
  if (patch.includes('\nGIT binary patch\n') || patch.includes('\n\\ No newline at end of file')) return undefined;
  const appended = new Map<string, string[]>();
  let lines: string[] | undefined;
  let hunks = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      lines = undefined;
      hunks = 0;
    } else if (line.startsWith('+++ b/')) {
      lines = [];
      appended.set(line.slice('+++ b/'.length), lines);
    } else if (lines !== undefined && line.startsWith('@@')) {
      hunks += 1;

      if (hunks > 1) return undefined;
    } else if (lines !== undefined && hunks === 1) {
      if (line.startsWith('+')) lines.push(line.slice(1));
      else if (line.startsWith('-') || (line.startsWith(' ') && lines.length > 0)) return undefined;
    }
  }

  return appended.size > 0 && [...appended.values()].every((added) => added.length > 0) ? appended : undefined;
}

/**
 * Appends the lines of `patch`, an append-only one, to the end of its files at `worktree` as they are now, and stages
 * them: what it meant when it no longer applies, because another step appended to the same file since it was cut.
 * Answers how to take it back out, or undefined when `patch` is not append-only or a file does not end in a newline.
 */
async function appendAgain(worktree: string, patch: string): Promise<(() => Promise<void>) | undefined> {
  const appended = appendedLines(patch);

  if (appended === undefined) return undefined;
  const before = new Map<string, string | undefined>();

  for (const file of appended.keys()) {
    const text = await fs.readFile(path.join(worktree, file), 'utf8').catch(() => undefined);

    if (text !== undefined && text !== '' && !text.endsWith('\n')) return undefined;
    before.set(file, text);
  }

  const repo = createGit(worktree);

  for (const [file, lines] of appended) {
    await fs.mkdir(path.dirname(path.join(worktree, file)), { recursive: true });
    await fs.writeFile(path.join(worktree, file), `${before.get(file) ?? ''}${lines.join('\n')}\n`);
  }

  await repo.raw(['add', '--', ...appended.keys()]);

  return async () => {
    for (const [file, text] of before) {
      if (text === undefined) await fs.rm(path.join(worktree, file), { force: true });
      else await fs.writeFile(path.join(worktree, file), text);
    }

    await repo.raw(['add', '-A', '--', ...before.keys()]);
  };
}

/**
 * Applies the patches kept for `branch` to the index of `worktree`, oldest first, and commits each with `own`'s message
 * when it is `own`'s file. A committed patch is removed: that commit is what the checkout pushes, now or later. One
 * already on the branch is removed too. One that does not apply is appended again when all it does is append, and
 * otherwise stays, with what git said.
 */
async function commitKept(input: { worktree: string; branch: DataBranch; files: readonly string[]; own?: OwnPatch }): Promise<Stuck[]> {
  const { worktree, branch, files, own } = input;
  const repo = createGit(worktree);
  const stuck: Stuck[] = [];

  for (const file of files) {
    // Take the patch back out if its commit fails, so the next send applies and commits it rather than finding it on the branch.
    let undo = async (): Promise<void> => {
      await repo.raw(['apply', '--index', '--reverse', '--binary', file]);
    };

    try {
      await repo.raw(['apply', '--index', '--binary', file]);
    } catch (e) {
      // Its reverse applies only where every line it adds sits in its own context and every line it removes is gone.
      const isOnBranch = await repo.raw(['apply', '--check', '--reverse', '--binary', file]).then(() => true, () => false);
      const appended = isOnBranch ? undefined : await appendAgain(worktree, await fs.readFile(file, 'utf8'));

      if (isOnBranch) await fs.rm(file, { force: true });
      else if (appended === undefined) stuck.push({ file, error: failureReason(e) });

      if (appended === undefined) continue;
      undo = appended;
    }

    const paths = (await repo.raw(['apply', '--numstat', '-z', file])).split('\0').flatMap((entry) => entry.split('\t').slice(2));

    try {
      await commitSkippingHooks(repo, file === own?.file ? own.message : `[teamai] Publish pending ${branch} data`, paths, { identityFallback: true });
    } catch (e) {
      await undo();
      throw e;
    }

    await fs.rm(file, { force: true });
  }

  return stuck;
}

/** A patch a step kept a moment ago, and the message its commit takes. */
type OwnPatch = { file: string; message: string };

/**
 * Under the lock of this machine's checkout of `branch`: commits there the patches kept for it, oldest first, and pushes
 * them. The answer names the ones that do not apply.
 */
async function sendKept(config: LocalConfig, branch: DataBranch, own?: OwnPatch): Promise<{ result: PublishResult; stuck: Stuck[] }> {
  let stuck: Stuck[] = [];

  const result = await CHECKOUTS[branch].update(config, async (worktree) => {
    stuck = await commitKept({ worktree, branch, files: await keptFiles(config, branch), own });

    // No files: commitAndPushAt then pushes whatever commits the checkout holds that origin lacks, these or older ones.
    return { files: [], message: `[teamai] Publish pending ${branch} data` };
  });

  return { result, stuck };
}

/** What a send came to: failed while a kept patch does not apply, though the rest landed. */
function sentResult(branch: DataBranch, { result, stuck }: { result: PublishResult; stuck: Stuck[] }): PublishResult {
  if (stuck.length === 0 || !isDelivered(result)) return result;

  return {
    status: 'failed',
    reason: `kept patches no longer apply to ${branch}. To publish them, apply each by hand in a checkout of ${branch} (git apply --3way <patch>), resolve any conflict, commit and push, then delete the patch: ${stuck.map(({ file }) => file).join(', ')}`,
  };
}

export const DataBranches = {
  checkout(branch: DataBranch): BranchWorktree {
    return CHECKOUTS[branch];
  },

  kept: keptFiles,

  /** Keeps `patch`, what a step staged for `branch`, at the end of the patches `send` and `pushPending` land; answers its file. */
  async keep(config: LocalConfig, branch: DataBranch, { name, patch }: { name: string; patch: string }): Promise<string> {
    const dir = keptDir(config, branch);
    const file = path.join(dir, `${name}.patch`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, patch);

    return file;
  },

  send: sendKept,

  /**
   * Sends what each data branch holds here and origin does not: the patches kept for it and the commits its checkout
   * holds that origin lacks, each with what came of it.
   */
  async pushPending(config: LocalConfig): Promise<Array<{ branch: DataBranch; result: PublishResult }>> {
    if (!usesBranchWorktree(config)) return [];
    const results: Array<{ branch: DataBranch; result: PublishResult }> = [];

    for (const branch of DATA_BRANCHES) {
      // A send's update pushes the checkout's own commits too, or did not happen, and a push now would meet the same.
      if ((await keptFiles(config, branch)).length > 0) results.push({ branch, result: sentResult(branch, await sendKept(config, branch)) });
      else if (await isGitRepo(CHECKOUTS[branch].dir(config)) && await CHECKOUTS[branch].hasUnpushed(config)) results.push({ branch, result: await CHECKOUTS[branch].commitAndPush(config, `[teamai] Publish pending ${branch} data`, []) });
    }

    return results;
  },

  /** `pushPending`, answering each data branch whose data still stays on this machine, with a sentence that says why. */
  async sendPending(config: LocalConfig): Promise<Array<{ branch: DataBranch; message: string }>> {
    return (await DataBranches.pushPending(config)).flatMap(({ branch, result }) => {
      if (isDelivered(result)) return [];

      return [{ branch, message: `What workflow steps published to ${branch} stays pending on this machine: ${result.status === 'failed' ? result.reason.trim() : 'another teamai process is writing it'}.` }];
    });
  },
} as const;

/**
 * The place of a `deliver: publish` step in `workspace: { team: { branch } }` of a teamai data branch: a checkout of
 * origin's tip of that orphan branch, made from the member's persistent checkout of it, with no default branch merged in.
 * What the step stages there is published through that persistent checkout under its lock, so it lands on whatever
 * reached origin meanwhile, as every other teamai-reports writer does. A step stages only the member's own files: those
 * whose second path segment, less its extension, is the member's username, such as `scores/<member>/2026-11.jsonl` or
 * `votes/<member>.yaml`. A place that cannot be made, or a publish that cannot land, leaves the data pending and the step
 * succeeds. What the step staged is kept as a patch behind the others kept for that branch, all committed there in order;
 * one that did not land stays kept for `DataBranches.pushPending`.
 *
 *   <runsDir>/<run>/data/<attempt>/    the checkout, made again by every prepare and removed once the step finished
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { usesBranchWorktree, type DataBranch, type LocalConfig } from '../../types.js';
import { failureReason, gitRoot, type PublishResult } from '../../utils/branch-worktree.js';
import { DataBranches } from '../../utils/data-branches.js';
import { commitSkippingHooks, createGit } from '../../utils/git.js';
import { runsDir, type AttemptId, type RunId } from '../store.js';
import type { WorkflowFailure } from '../types.js';
import type { DataAt } from './record.js';
import { git } from '../worktree.js';

const said = (result: { stderr: string; stdout: string }): string => (result.stderr || result.stdout).trim();

export function dataCheckoutOf(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(runsDir(config), run, 'data', attempt);
}

/** Removes the checkout at `dir` and git's record of it. */
export async function removeDataCheckout(config: LocalConfig, dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });

  if (usesBranchWorktree(config)) await git(gitRoot(config), ['worktree', 'prune']);
}

/**
 * Makes the checkout `step` of `run` runs in for `attempt`: origin's tip of `branch` as the member's persistent checkout
 * fetched it just now, else as it last did, with the commits that checkout holds and origin does not yet, then the patches
 * kept for `branch`. Without any tip, the step runs in an empty directory and its data stays pending.
 */
export async function openDataCheckout(input: { config: LocalConfig; run: RunId; attempt: AttemptId; branch: DataBranch }): Promise<{ dir: string; at: DataAt }> {
  const { config, branch } = input;
  const dir = dataCheckoutOf(config, input.run, input.attempt);
  await removeDataCheckout(config, dir);

  const unavailable = async (reason: string): Promise<{ dir: string; at: DataAt }> => {
    await fs.mkdir(dir, { recursive: true });

    return { dir, at: { kind: 'unavailable', reason } };
  };

  if (!DataBranches.checkout(branch).enabled(config)) return unavailable(`the team repo is served over http, which has no ${branch} branch`);

  try {
    const refreshed = await DataBranches.checkout(branch).refresh(config);

    if (refreshed.status === 'failed') return await unavailable(`this machine's checkout of ${branch} is not ready: ${refreshed.reason}`);
  } catch (e) {
    return unavailable(`this machine's checkout of ${branch} is not ready: ${failureReason(e).trim()}`);
  }

  const repo = gitRoot(config);
  const base = await startOf(repo, branch);

  if (base === '') return unavailable(`neither origin nor this machine has ${branch} yet`);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const added = await git(repo, ['worktree', 'add', '-q', '--detach', '--', dir, base]);

  return added.code === 0 ? { dir, at: { kind: 'checkout', base: await withKept({ config, branch, dir, base }) } } : unavailable(`git could not check out ${branch}: ${said(added)}`);
}

/**
 * The commit a step on `branch` starts from: this machine's branch when it holds origin's tip, with the commits origin
 * lacks yet, else origin's tip; '' when neither has the branch.
 */
async function startOf(repo: string, branch: DataBranch): Promise<string> {
  const tipOf = async (ref: string): Promise<string> => {
    const found = await git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);

    return found.code === 0 ? found.stdout.trim() : '';
  };

  const [origin, local] = await Promise.all([tipOf(`refs/remotes/origin/${branch}`), tipOf(`refs/heads/${branch}`)]);
  const holdsOrigin = local !== '' && (origin === '' || (await git(repo, ['merge-base', '--is-ancestor', origin, local])).code === 0);

  return holdsOrigin ? local : origin;
}

/**
 * Commits on the checkout at `dir` the patches kept for `branch` that apply there, oldest first, so the step sees its
 * pending data and what it stages is cut after it. Answers the commit the step's changes are read against, `base` when
 * none applied.
 */
async function withKept({ config, branch, dir, base }: { config: LocalConfig; branch: DataBranch; dir: string; base: string }): Promise<string> {
  let applied = false;

  for (const file of await DataBranches.kept(config, branch)) {
    if ((await git(dir, ['apply', '--index', '--binary', file])).code === 0) applied = true;
  }

  if (!applied) return base;
  await commitSkippingHooks(createGit(dir), `[teamai] Pending ${branch} data`, undefined, { identityFallback: true });

  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

/** The member a path of a data branch belongs to: its second segment, less the extension of a file at that depth. */
function ownerOf(file: string): string | undefined {
  const [, second, ...below] = file.split('/');

  if (second === undefined) return undefined;

  return below.length === 0 ? second.replace(/\.[^.]+$/, '') : second;
}

/** Why each staged change in `listed`, git's `--name-status -z` output, may not be published by `member`. */
function refusals(listed: string[], member: string): string[] {
  const refused: string[] = [];

  for (let index = 0; index + 1 < listed.length; index += 2) {
    const status = listed[index] ?? '';
    const file = listed[index + 1] ?? '';
    const owner = ownerOf(file);

    if (owner === undefined) refused.push(`${file}: in no member's directory or file`);
    else if (owner !== member) refused.push(`${file}: belongs to ${owner}, not ${member}`);
    else if (status === 'D') refused.push(`${file}: deleted; a step publishes new and changed files only`);
  }

  return refused;
}

function pending(step: string, reason: string) {
  return { message: `Step "${step}" left its data on this machine, pending: ${reason}. Run teamai score --push to publish it.` };
}

/**
 * Publishes what `step` staged in its checkout at `dir` to `branch`, through the member's persistent checkout: synced with
 * origin, the staged changes applied, committed and pushed, rebased and pushed again while origin moves. A message says
 * why the data stays pending. A staged file outside the member's own fails the step, and nothing is published.
 */
export async function finishDataCheckout(input: { config: LocalConfig; dir: string; step: string; branch: DataBranch; at: DataAt }): Promise<{ message?: string } | WorkflowFailure> {
  const { config, dir, step, branch, at } = input;

  try {
    if (at.kind === 'unavailable') return pending(step, at.reason);
    const listed = await git(dir, ['diff', '--cached', '--no-renames', '--name-status', '-z', at.base, '--']);

    if (listed.code !== 0) return { code: 'push_failed', message: `Step "${step}" could not read what it staged in ${dir}: ${said(listed)}` };
    const entries = listed.stdout.split('\0').filter(Boolean);

    if (entries.length === 0) return {};
    const member = config.username;
    const refused = refusals(entries, member);

    if (refused.length > 0) {
      return {
        code: 'push_failed',
        message: `Step "${step}" staged files outside ${member}'s own on ${branch}, so nothing was published:\n${refused.join('\n')}\nA step publishes only paths such as scores/${member}/… or votes/${member}.yaml. Have it stage only those, then run the workflow again.`,
      };
    }

    const patch = await git(dir, ['diff', '--cached', '--binary', '--no-renames', at.base, '--']);

    if (patch.code !== 0) return { code: 'push_failed', message: `Step "${step}" could not read what it staged in ${dir}: ${said(patch)}` };

    // The checkout is <runs>/<run>/data/<attempt>; the time first keeps patches in the order they were made.
    const name = `${String(Date.now()).padStart(15, '0')}-${path.basename(path.dirname(path.dirname(dir)))}-${path.basename(dir)}`;

    return await land({ config, step, branch, patch: { name, text: patch.stdout } });
  } finally {
    await removeDataCheckout(config, dir);
  }
}

/**
 * Keeps `patch` behind the patches kept for `branch`, then commits them all, in order, to the member's persistent checkout
 * of it and pushes. A patch that did not land stays kept for the next send.
 */
async function land(input: { config: LocalConfig; step: string; branch: DataBranch; patch: { name: string; text: string } }): Promise<{ message?: string }> {
  const { config, step, branch, patch } = input;
  const file = await DataBranches.keep(config, branch, { name: patch.name, patch: patch.text });
  const { result, stuck } = await DataBranches.send(config, branch, { file, message: `[teamai] ${step}: ${config.username}` });
  const conflict = stuck.find((kept) => kept.file === file);

  if (conflict !== undefined) {
    return { message: `Step "${step}" left its data on this machine: it no longer applies to ${branch} (${conflict.error}). To publish it, apply it by hand in a checkout of ${branch} (git apply --3way ${file}), resolve any conflict, commit and push, then delete ${file}.` };
  }

  const why = pendingReason(result, branch);

  return why === undefined ? {} : pending(step, why);
}

/** Why a publish leaves its data on this machine, or undefined when origin has it. */
function pendingReason(published: PublishResult, branch: DataBranch): string | undefined {
  switch (published.status) {
    case 'published':
    case 'already-present':
      return undefined;
    case 'busy':
      return `another teamai process is writing ${branch}`;
    case 'failed':
      return published.reason.trim();
    default: {
      const unhandled: never = published;

      return unhandled;
    }
  }
}

/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { boundedGit, commitWork, git, hostGitEnv, pushIfOrigin, untrustedGit } from '../workflow/worktree.js';

/** A step ran in the copy finishing commits and pushes, so only git that runs nothing its config names may do it. */
export const commits = (): unknown => commitWork('/copy', 'teamai: s', undefined, untrustedGit(hostGitEnv()));
export const pushes = (): unknown => pushIfOrigin('/copy', 'teamai/s', [], untrustedGit(hostGitEnv()), { kept: new Set(), env: hostGitEnv() });
// @ts-expect-error commitWork has no git of its own to fall back to: the host git runs the hooks a step planted
export const defaulted = (): unknown => commitWork('/copy', 'teamai: s');
// @ts-expect-error the host git runs what the copy's config names
export const hostCommits = (): unknown => commitWork('/copy', 'teamai: s', undefined, git);
// @ts-expect-error boundedGit stops git at a deadline, but still runs what the copy's config names
export const boundedCommits = (): unknown => commitWork('/copy', 'teamai: s', undefined, boundedGit(undefined));
// @ts-expect-error the host git runs the pre-push hook and pack program the copy's config names
export const hostPushes = (): unknown => pushIfOrigin('/copy', 'teamai/s', [], git, { kept: new Set(), env: hostGitEnv() });

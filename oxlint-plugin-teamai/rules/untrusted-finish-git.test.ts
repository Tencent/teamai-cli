import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/untrusted-finish-git', { filename: 'src/workflow/place/team.ts' });

describe('teamai/untrusted-finish-git', () => {
  rule.invalid('reports a commit of a step\'s work with git left to its default', `
import { commitWork } from '../worktree.js';
export async function finish(root: string, step: string, start: string): Promise<unknown> {
  return commitWork(root, \`teamai: \${step}\`, start);
}
`, (output) => {
    expect(output).toContain('untrustedGit');
    expect(output).toContain('commitWork(');
  });

  rule.invalid('reports a commit through the host git', `
import { commitWork, git } from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  return commitWork(root, 'teamai: s', start, git);
}
`);

  rule.invalid('reports a commit through a git bound to boundedGit', `
import { boundedGit, commitWork } from '../worktree.js';
export async function finish(root: string, start: string, expiresAt: string): Promise<unknown> {
  const run = boundedGit(expiresAt);
  return commitWork(root, 'teamai: s', start, run);
}
`);

  rule.invalid('reports a commit through a git a local function makes from something other than untrustedGit', `
import { boundedGit, commitWork } from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  const run = await pick();
  return commitWork(root, 'teamai: s', start, run);
}
async function pick() {
  const inner = () => untrustedGit({});
  return boundedGit(undefined);
}
`);

  rule.valid('allows a commit through untrustedGit(...)', `
import { commitWork, hostGitEnv, untrustedGit } from '../worktree.js';
export async function finish(dir: string, start: string, paths: string[]): Promise<unknown> {
  return commitWork(dir, 'teamai: s', start, untrustedGit(hostGitEnv()), paths);
}
`, { filename: 'src/workflow/place/writer.ts' });

  rule.valid('allows a commit through a name bound to untrustedGit(...)', `
import { commitWork, hostGitEnv, untrustedGit } from '../worktree.js';
export async function finish(dir: string, start: string): Promise<unknown> {
  const hookSafe = untrustedGit(hostGitEnv());
  return commitWork(dir, 'teamai: s', start, hookSafe);
}
`, { filename: 'src/workflow/place/writer.ts' });

  rule.valid('allows a commit through a git a function of the file returns from untrustedGit, declared after its use', `
import { commitWork, untrustedGit, type Git } from '../worktree.js';
export async function commitClone(dir: string, start: string): Promise<unknown> {
  const git = await cloneGit([]);
  if ('code' in git) return git;
  return commitWork(dir, 'teamai: s', start, git);
}
async function cloneGit(withhold: readonly string[]): Promise<Git | { code: string }> {
  return withhold.length === 0 ? untrustedGit({}) : { code: 'workspace_base' };
}
`, { filename: 'src/workflow/place/clone.ts' });

  rule.valid('reads the name in the function that commits, not one another function binds later', `
import { boundedGit, commitWork, untrustedGit } from '../worktree.js';
export async function commitClone(dir: string, start: string): Promise<unknown> {
  const git = untrustedGit({});
  return commitWork(dir, 'teamai: s', start, git);
}
export function prepare(expiresAt: string): unknown {
  const git = boundedGit(expiresAt);
  return git;
}
`, { filename: 'src/workflow/place/clone.ts' });

  rule.invalid('reports a name bound to untrustedGit in another function only', `
import { boundedGit, commitWork, untrustedGit } from '../worktree.js';
export function prepare(): unknown {
  const git = untrustedGit({});
  return git;
}
export async function commitClone(dir: string, start: string): Promise<unknown> {
  const git = boundedGit(undefined);
  return commitWork(dir, 'teamai: s', start, git);
}
`, undefined, { filename: 'src/workflow/place/clone.ts' });

  rule.invalid('reports a commit through commitWork imported under another name', `
import { commitWork as commit, git } from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  return commit(root, 'teamai: s', start, git);
}
`);

  rule.invalid('reports a commit through commitWork read off a namespace import', `
import * as worktree from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  return worktree.commitWork(root, 'teamai: s', start, worktree.git);
}
`);

  rule.valid('allows a commit through a renamed or namespaced commitWork given untrustedGit', `
import * as worktree from '../worktree.js';
import { commitWork as commit, untrustedGit } from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  await commit(root, 'teamai: s', start, untrustedGit({}));
  return worktree.commitWork(root, 'teamai: s', start, worktree.untrustedGit({}));
}
`, { filename: 'src/workflow/place/writer.ts' });

  rule.invalid('reports a parameter that shadows a name bound to untrustedGit outside the function', `
import { commitWork, untrustedGit } from '../worktree.js';
const run = untrustedGit({});
export async function finish(root: string, start: string, run: unknown): Promise<unknown> {
  return commitWork(root, 'teamai: s', start, run);
}
`);

  rule.invalid('reports a name bound to untrustedGit only in a block the commit is outside of', `
import { commitWork, untrustedGit, type Git } from '../worktree.js';
export async function finish(root: string, start: string, run: Git, fresh: boolean): Promise<unknown> {
  if (fresh) {
    const run = untrustedGit({});
    void run;
  }
  return commitWork(root, 'teamai: s', start, run);
}
`);

  rule.invalid('reports a name bound to untrustedGit and later assigned another git', `
import { commitWork, git, untrustedGit } from '../worktree.js';
export async function finish(root: string, start: string, host: boolean): Promise<unknown> {
  let run = untrustedGit({});
  if (host) run = git;
  return commitWork(root, 'teamai: s', start, run);
}
`);

  rule.invalid('reports a git from a function of the file that returns untrustedGit on only some paths', `
import { commitWork, git, untrustedGit } from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  const run = make(false);
  return commitWork(root, 'teamai: s', start, run);
}
function make(safe: boolean) {
  if (!safe) return git;
  return untrustedGit({});
}
`);

  rule.invalid('reports a git from a factory name another function of the file also uses for the host git', `
import { commitWork, git, untrustedGit } from '../worktree.js';
export async function finish(root: string, start: string): Promise<unknown> {
  const run = make();
  return commitWork(root, 'teamai: s', start, run);
}
function make() {
  return untrustedGit({});
}
export function other() {
  function make() {
    return git;
  }
  return make();
}
`);

  rule.valid('leaves tests, which commit fixtures with the host git, alone', `
import { commitWork } from '../workflow/worktree.js';
export async function seed(dir: string): Promise<unknown> {
  return commitWork(dir, 'seed');
}
`, { filename: 'src/__tests__/workflow-workspace.test.ts' });
});

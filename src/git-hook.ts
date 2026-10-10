/**
 * teamai's git hook: a named hook in a repository's local git config that runs
 * `teamai hook-dispatch <event> --tool git` on `post-checkout`, `post-merge`
 * and `post-rewrite`, so a new worktree gets the team's resources before
 * `git worktree add` returns, and `git pull` before it returns.
 *
 * Config hooks (`hook.<name>.command` + `hook.<name>.event`, Git >= 2.54) live
 * in the common config every worktree shares, and run beside `core.hooksPath`
 * and `.git/hooks` scripts, so no hook manager's files are touched.
 *
 * Git gives the command no event name, so each event gets its own named hook.
 * Git runs the command as `sh -c '<command> "$@"' <args>`: its arguments land
 * on the command's last simple command. The command is therefore a function
 * definition followed by its call, which receives them, and the function ends
 * in `|| :` so the hook always exits 0 (a non-zero `post-checkout` becomes the
 * exit status of `git worktree add`).
 *
 * Older Git: without `core.hooksPath`, the same dispatch goes into a
 * marker-delimited block in `.git/hooks/<event>`, inserted after the shebang so
 * the script's own lines and exit status stay as they were. With
 * `core.hooksPath` (a hook manager) nothing is written; `doctor` advises.
 */

import { ensureTeamaiWrapper, TEAMAI_BIN_DIR } from './builtin-hooks.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataHome, type LocalConfig } from './types.js';
import { execCommand } from './utils/exec.js';
import { GIT_REPOSITORY_ENV } from './utils/git-env.js';
import { readFileIfExists, readJson, remove, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';

export const GIT_HOOK_EVENTS = ['post-checkout', 'post-merge', 'post-rewrite'] as const;
export type GitHookEvent = (typeof GIT_HOOK_EVENTS)[number];

/** The `--tool` value of a dispatch git runs. */
export const GIT_HOOK_TOOL = 'git';

/** First Git release with config-defined hooks. */
const MIN_GIT: readonly [number, number] = [2, 54];

const ZERO_OID = /^0+$/;

function hookName(event: GitHookEvent): string {
  return `teamai-${event}`;
}

/** The shell line git runs for `event`. */
export function gitHookCommand(event: GitHookEvent): string {
  return `teamai_git_hook() { PATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" teamai hook-dispatch ${event} --tool ${GIT_HOOK_TOOL} "$@" >/dev/null 2>&1 || :; }; teamai_git_hook`;
}

/**
 * The line a team may commit into its own hook manager's Git hooks when
 * teamai cannot install its hook: a no-op that exits 0
 * on a machine without teamai.
 */
export function guardedGitHookLine(event: GitHookEvent): string {
  return `command -v teamai >/dev/null 2>&1 && teamai hook-dispatch ${event} --tool ${GIT_HOOK_TOOL} "$@" >/dev/null 2>&1 || true`;
}

// Markers of the block in `.git/hooks/<event>` on Git without config hooks.
const BLOCK_START = '# >>> teamai git hook (managed by teamai) >>>';
const BLOCK_END = '# <<< teamai git hook <<<';

function scriptBlock(event: GitHookEvent): string {
  return `${BLOCK_START}\nPATH="$HOME/${TEAMAI_BIN_DIR}:$PATH" teamai hook-dispatch ${event} --tool ${GIT_HOOK_TOOL} "$@" >/dev/null 2>&1 || :\n${BLOCK_END}\n`;
}

/** `text` without teamai's block. */
function withoutScriptBlock(text: string): string {
  const start = text.indexOf(`${BLOCK_START}\n`);
  const end = text.indexOf(`${BLOCK_END}\n`, start);
  return start >= 0 && end > start ? text.slice(0, start) + text.slice(end + BLOCK_END.length + 1) : text;
}

/** `text` with the current block for `event`, or null when it is not a shell script. */
function withScriptBlock(text: string | null, event: GitHookEvent): string | null {
  if (text === null) return `#!/bin/sh\n${scriptBlock(event)}`;
  const rest = withoutScriptBlock(text);
  const shebang = /^#![^\n]*(\n|$)/.exec(rest)?.[0] ?? '';
  if (shebang && !/\b(ba|da|k|z)?sh\b/.test(shebang)) return null;
  return `${shebang}${shebang && !shebang.endsWith('\n') ? '\n' : ''}${scriptBlock(event)}${rest.slice(shebang.length)}`;
}

export type GitHookInstall =
  | { installed: true; changed: boolean }
  | { installed: false; reason: 'hooks-path' | 'other-hook' | 'not-a-repository' };

export type GitHookStatus =
  | { installed: true }
  | { installed: false; reason: 'disabled'; event: GitHookEvent; disabledBy: 'hook' | 'event'; scope: string }
  | { installed: false; reason: 'hooks-path' | 'other-hook'; gitVersion: string }
  | { installed: false; reason: 'not-a-repository' | 'not-configured' };

type Git = (args: string[]) => ReturnType<typeof execCommand>;
const gitIn = (repoDir: string): Git => (args) => execCommand('git', args, { cwd: repoDir, timeoutMs: 10_000 });

async function eventsToWrite(git: Git): Promise<GitHookEvent[]> {
  const stale: GitHookEvent[] = [];
  for (const event of GIT_HOOK_EVENTS) {
    const key = `hook.${hookName(event)}`;
    const current = (await git(['config', '--local', '--get', `${key}.command`])).stdout.trim();
    const events = (await git(['config', '--local', '--get-all', `${key}.event`])).stdout.trim();
    if (current !== gitHookCommand(event) || events !== event) stale.push(event);
  }
  return stale;
}

/** Whether the hook is in the local config of the repository holding `repoDir`, and why not. */
export async function gitHookStatus(repoDir: string): Promise<GitHookStatus> {
  const git = gitIn(repoDir);
  const version = (await git(['--version'])).stdout.trim();
  if ((await git(['rev-parse', '--git-dir'])).code !== 0) return { installed: false, reason: 'not-a-repository' };
  if (!supportsConfigHooks(version)) {
    const scripts = await scriptsToWrite(git, repoDir);
    if (scripts.blocked) return { installed: false, reason: scripts.blocked, gitVersion: version };
    return scripts.stale.length === 0 ? { installed: true } : { installed: false, reason: 'not-configured' };
  }
  if ((await eventsToWrite(git)).length > 0) return { installed: false, reason: 'not-configured' };
  for (const event of GIT_HOOK_EVENTS) {
    const { code, stdout, stderr } = await git(['hook', 'list', event]);
    if (code !== 0) throw new Error(`Could not inspect the ${event} hook: ${stderr.trim() || `exit ${code}`}`);
    const entries = stdout.trim().split('\n');
    const disabledBy = entries.includes(`event-disabled\t${hookName(event)}`) ? 'event'
      : entries.includes(`disabled\t${hookName(event)}`) ? 'hook' : null;
    if (disabledBy) {
      // Where the effective `false` lives decides how to undo it: `--local` cannot override worktree config.
      const key = `hook.${disabledBy === 'event' ? event : hookName(event)}.enabled`;
      const scope = (await git(['config', '--show-scope', '--get', key])).stdout.split('\t')[0].trim();
      return { installed: false, reason: 'disabled', event, disabledBy, scope };
    }
  }
  return { installed: true };
}

/** What `doctor` says about a hook that is not installed: the cause, then the next step. */
export function describeMissingGitHook(status: Exclude<GitHookStatus, { installed: true }>): string {
  switch (status.reason) {
    case 'disabled': {
      const key = `hook.${status.disabledBy === 'event' ? status.event : hookName(status.event)}.enabled`;
      const preserved = 'Teamai pull preserves explicit hook disable settings.';
      if (status.scope === 'worktree') {
        return `Git disables ${hookName(status.event)} through ${key}=false in this worktree's config, so it will not sync resources. `
          + `Run \`git config --worktree --unset ${key}\` to enable it, then \`teamai pull\` to sync. ${preserved}`;
      }
      // Local config overrides global and system; an unreadable scope gets the same advice.
      if (!status.scope || ['local', 'global', 'system'].includes(status.scope)) {
        return `Git disables ${hookName(status.event)} through ${key}=false, so it will not sync resources. `
          + `Run \`git config --local ${key} true\` to enable it for this repository, then \`teamai pull\` to sync. ${preserved}`;
      }
      return `Git disables ${hookName(status.event)} through ${key}=false in ${status.scope} config, so it will not sync resources. `
        + `Unset or override it there, then run \`teamai pull\` to sync. ${preserved}`;
    }
    case 'hooks-path':
    case 'other-hook': {
      const where = status.reason === 'hooks-path'
        ? 'core.hooksPath is set, so teamai leaves the hook manager\'s files alone'
        : 'a post-checkout, post-merge or post-rewrite hook in .git/hooks is a symlink or not an executable shell script, so teamai leaves it alone';
      const owner = status.reason === 'hooks-path' ? 'your hook manager defines' : 'in .git/hooks';
      return `${status.gitVersion || 'This git'} has no config-based hooks (Git 2.54 or later) and ${where}: new `
        + 'worktrees and `git pull` get the team\'s resources only at the next session. Either: '
        + '1. Upgrade Git to 2.54 or later, then run `teamai pull`. '
        + `2. If the team agrees to commit it, run this line from the post-checkout hook ${owner}, `
        + `\`${guardedGitHookLine('post-checkout')}\`, and this one from the post-merge hook, `
        + `\`${guardedGitHookLine('post-merge')}\`, and this one from the post-rewrite hook, `
        + `\`${guardedGitHookLine('post-rewrite')}\`; wrap each in \`sh -c '...'\` when the hook config is not a `
        + 'shell script. All do nothing on a machine without teamai.';
    }
    case 'not-a-repository':
      return 'The project root is not a git repository, so there is no git event to hook.';
    case 'not-configured':
      return 'The teamai hooks are not in this repository\'s git config. Run `teamai pull` to install them.';
  }
}

/**
 * Write (or refresh) the hook into the local config of the repository holding
 * `repoDir`. Idempotent: an up-to-date hook is left untouched.
 */
export async function installGitHook(repoDir: string, opts: { dryRun?: boolean } = {}): Promise<GitHookInstall> {
  const git = gitIn(repoDir);
  const configHooks = supportsConfigHooks((await git(['--version'])).stdout);
  if ((await git(['rev-parse', '--git-dir'])).code !== 0) return { installed: false, reason: 'not-a-repository' };
  if (!configHooks) return installHookScripts(git, repoDir, opts);

  const stale = await eventsToWrite(git);
  if (opts.dryRun) return { installed: true, changed: stale.length > 0 };
  // A block an older Git needed would dispatch a second time beside the config hook.
  await removeHookScriptBlocks(git, repoDir);

  // The wrapper is what the hook command finds `teamai` through when the app
  // that runs git has no login PATH.
  ensureTeamaiWrapper();

  for (const event of stale) {
    const key = `hook.${hookName(event)}`;
    await ok(git(['config', '--local', `${key}.command`, gitHookCommand(event)]), key);
    await ok(git(['config', '--local', '--replace-all', `${key}.event`, event]), key);
  }
  if (stale.length > 0) log.debug(`git hook: installed teamai hooks in ${repoDir}`);
  return { installed: true, changed: stale.length > 0 };
}

type ScriptPlan = { blocked: 'hooks-path' | 'other-hook'; stale: [] } | { blocked: null; stale: { file: string; text: string }[] };

async function scriptsToWrite(git: Git, repoDir: string): Promise<ScriptPlan> {
  if ((await git(['config', '--get', 'core.hooksPath'])).stdout.trim()) return { blocked: 'hooks-path', stale: [] };
  // The common hooks directory, from a linked worktree too.
  const dir = path.resolve(repoDir, (await git(['rev-parse', '--git-path', 'hooks'])).stdout.trim());
  const stale: { file: string; text: string }[] = [];
  for (const event of GIT_HOOK_EVENTS) {
    const file = path.join(dir, event);
    // A symlink usually points at a hook manager's script, possibly shared by other repositories.
    if (await isSymlink(file)) return { blocked: 'other-hook', stale: [] };
    const current = await readFileIfExists(file);
    if (current !== null && process.platform !== 'win32' && ((await fs.stat(file)).mode & 0o111) === 0) {
      return { blocked: 'other-hook', stale: [] };
    }
    const text = withScriptBlock(current, event);
    if (text === null) return { blocked: 'other-hook', stale: [] };
    if (text !== current) stale.push({ file, text });
  }
  return { blocked: null, stale };
}

async function installHookScripts(git: Git, repoDir: string, opts: { dryRun?: boolean }): Promise<GitHookInstall> {
  const plan = await scriptsToWrite(git, repoDir);
  if (plan.blocked) return { installed: false, reason: plan.blocked };
  if (opts.dryRun) return { installed: true, changed: plan.stale.length > 0 };
  ensureTeamaiWrapper();
  for (const { file, text } of plan.stale) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // The creation mode applies only to a new file. Existing owner modes stay.
    await fs.writeFile(file, text, { mode: 0o755 });
  }
  if (plan.stale.length > 0) log.debug(`git hook: installed teamai hook scripts in ${repoDir}`);
  return { installed: true, changed: plan.stale.length > 0 };
}

/**
 * Take teamai's block out of the post-checkout, post-merge and post-rewrite scripts in the
 * repository's own hooks directory (and in core.hooksPath's, should a block
 * predate it). A script left with only the shebang is the one teamai created
 * when there was none, so it goes too. Returns the files changed.
 */
async function removeHookScriptBlocks(git: Git, repoDir: string, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const dirs = new Set<string>();
  for (const args of [['rev-parse', '--git-common-dir'], ['rev-parse', '--git-path', 'hooks']]) {
    const { code, stdout } = await git(args);
    if (code !== 0) continue;
    const out = path.resolve(repoDir, stdout.trim());
    dirs.add(args.length === 2 ? path.join(out, 'hooks') : out);
  }
  const changed: string[] = [];
  for (const dir of dirs) {
    for (const event of GIT_HOOK_EVENTS) {
      const file = path.join(dir, event);
      if (await isSymlink(file)) continue;
      const current = await readFileIfExists(file);
      if (current === null) continue;
      const text = withoutScriptBlock(current);
      if (text === current) continue;
      changed.push(file);
      if (opts.dryRun) continue;
      if (/^(#![^\n]*\n?)?$/.test(text)) await fs.rm(file);
      else await fs.writeFile(file, text);
    }
  }
  return changed;
}

/**
 * Remove everything installGitHook wrote in the repository holding `repoDir`:
 * the `hook.teamai-<event>` config sections and the blocks in hook scripts.
 * Other hooks and lines stay. Returns what was (or, on a dry run, would be)
 * removed: config section names, then script paths.
 */
export async function removeGitHook(repoDir: string, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const git = gitIn(repoDir);
  if ((await git(['rev-parse', '--git-dir'])).code !== 0) return [];
  const removed: string[] = [];
  for (const event of GIT_HOOK_EVENTS) {
    const section = `hook.${hookName(event)}`;
    const present = (await git(['config', '--local', '--get-regexp', `^${section.replace(/\./g, '\\.')}\\.`])).stdout.trim();
    if (!present) continue;
    removed.push(section);
    if (!opts.dryRun) await ok(git(['config', '--local', '--remove-section', section]), section);
  }
  removed.push(...await removeHookScriptBlocks(git, repoDir, opts));
  return removed;
}

async function isSymlink(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

async function ok(result: ReturnType<typeof execCommand>, key: string): Promise<void> {
  const { code, stderr } = await result;
  if (code !== 0) throw new Error(`git config ${key} failed: ${stderr.trim() || `exit ${code}`}`);
}

function supportsConfigHooks(versionOutput: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
}

/**
 * Whether a `post-checkout` with these arguments created a checkout (a new
 * worktree): Git passes an all-zero old ref then. A branch switch passes the
 * previous HEAD.
 */
export function isNewCheckout(args: readonly string[]): boolean {
  const [oldRef, , branchFlag] = args;
  return !!oldRef && ZERO_OID.test(oldRef) && branchFlag === '1';
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Whether a `post-checkout` is a pull or rebase that fast-forwarded HEAD. Git
 * 2.14–2.32 runs a fast-forward `git pull --rebase` with autostash as a rebase
 * that only checks out the upstream, so neither post-merge nor post-rewrite
 * runs. A divergent rebase checks out first too, but its old HEAD is no
 * ancestor of the new one: it syncs on post-rewrite. GIT_REFLOG_ACTION names
 * the command; any other action is not one.
 */
export async function isRebaseFastForward(
  args: readonly string[],
  reflogAction: string | undefined,
  cwd: string,
): Promise<boolean> {
  const [oldRef, newRef, branchFlag] = args;
  if (branchFlag !== '1' || !oldRef || !newRef || oldRef === newRef) return false;
  if (![oldRef, newRef].every(ref => OID.test(ref) && !ZERO_OID.test(ref))) return false;
  if (!/^(?:pull|rebase)(?:\s|$)/.test(reflogAction ?? '')) return false;
  return (await gitIn(cwd)(['merge-base', '--is-ancestor', oldRef, newRef])).code === 0;
}

/** Drop the repository Git exported for the hook, before teamai runs any git. */
export function clearGitHookRepositoryEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of GIT_REPOSITORY_ENV) delete env[name];
}

// ─── Recorded failures ─────────────────────────────────
//
// The hook is silent and exits 0, so a failure inside it is kept here, in the
// project partition every worktree shares, until someone is told: `doctor`
// names it, the next interactive `pull` mentions it once and drops it, and the
// next hook-started pull that succeeds (the detached retry included) drops it.

export type GitHookFailure =
  | { kind: 'fetch-failed'; event: GitHookEvent; at: string; error: string }
  | { kind: 'fetch-timeout'; event: GitHookEvent; at: string; capMs: number }
  | { kind: 'lock-held'; event: GitHookEvent; at: string; waitedMs: number }
  | { kind: 'hook-error'; event: GitHookEvent; at: string; error: string };

/** A failure as the member reads it: what happened and why, then the next step. */
export interface GitHookFailureReport {
  message: string;
  fix: string;
}

function failureFile(config: LocalConfig): string {
  return path.join(getDataHome(config), 'git-hook-failure.json');
}

export function isGitHookEvent(value: unknown): value is GitHookEvent {
  return (GIT_HOOK_EVENTS as readonly unknown[]).includes(value);
}

/** Keep `failure` for `doctor` and the next pull, and write it to debug.log. */
export async function recordGitHookFailure(config: LocalConfig, failure: GitHookFailure): Promise<void> {
  log.persist(`git hook: ${describeGitHookFailure(failure).message}`);
  await writeJson(failureFile(config), failure)
    .catch((e) => log.persist(`git hook: could not record the failure: ${(e as Error).message}`));
}

export async function readGitHookFailure(config: LocalConfig): Promise<GitHookFailure | null> {
  const failure = await readJson<GitHookFailure>(failureFile(config)).catch(() => null);
  return failure && isGitHookEvent(failure.event) ? failure : null;
}

export async function clearGitHookFailure(config: LocalConfig): Promise<void> {
  await remove(failureFile(config)).catch(() => {});
}

export function describeGitHookFailure(failure: GitHookFailure): GitHookFailureReport {
  const when = `(${failure.at})`;
  // git's stderr runs over several lines; the first names the cause, debug.log keeps the rest.
  const firstLine = (error: string) => error.trim().split('\n')[0];
  switch (failure.kind) {
    case 'fetch-failed':
      return {
        message: `${failure.event} could not fetch the team repo ${when}: ${firstLine(failure.error)}`,
        fix: 'The worktree may lack the team\'s latest resources. Check that you can reach the team repo, '
          + 'then run `teamai pull`.',
      };
    case 'fetch-timeout':
      return {
        message: `${failure.event} stopped the team repo fetch at its ${failure.capMs} ms cap ${when}, `
          + 'and the pull it handed over to has not completed it',
        fix: 'Check that you can reach the team repo, then run `teamai pull`.',
      };
    case 'lock-held':
      return {
        message: `${failure.event} skipped its sync: another teamai process held the project's sync lock `
          + `for the ${failure.waitedMs} ms it waits ${when}`,
        fix: 'Run `teamai pull` once that process finishes. If a teamai pull is stuck, stop it first.',
      };
    case 'hook-error':
      return {
        message: `${failure.event} failed ${when}: ${firstLine(failure.error)}`,
        fix: 'Run `teamai pull` to sync; ~/.teamai/debug.log has the details.',
      };
  }
}

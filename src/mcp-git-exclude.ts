import path from 'node:path';
import fse from 'fs-extra';
import type { McpServerDef } from './types.js';
import type { McpTarget } from './mcp-reconcile.js';
import { referencedVars, supportsEnvExpansion } from './resources/mcp-format.js';
import { execCommand } from './utils/exec.js';
import { pathExists, readFileSafe, writeFileAtomic } from './utils/fs.js';
import { listWorktrees } from './utils/git.js';
import { log } from './utils/logger.js';

// ─── Project MCP configs and git ─────────────────────────────
//
//  A project-scope MCP config that holds a resolved `${VAR}` sits in the
//  business repo's working tree with the value in plaintext, and one
//  `git add -A` commits it (#882). teamai lists such a file in the clone's own
//  `.git/info/exclude`, inside a block it owns: local to the clone, nothing
//  committed, and the team's `.gitignore` never touched.

export const MCP_EXCLUDE_START = '# [teamai:mcp-exclude:start] project MCP configs holding resolved ${VAR} values';
export const MCP_EXCLUDE_END = '# [teamai:mcp-exclude:end]';

/**
 * Whether `target`'s file carries a value teamai resolved from a `${VAR}`: a
 * project-scope file holding one of `names` whose definition references a
 * variable the tool does not expand itself.
 */
export function carriesResolvedValue(
  target: McpTarget,
  teamDefs: McpServerDef[],
  names: Iterable<string>,
): boolean {
  if (!target.projectScope) return false;
  const present = new Set(names);
  return teamDefs.some((def) => present.has(def.name)
    && referencedVars(def).length > 0
    && !supportsEnvExpansion(target.format, target.projectScope, def));
}

/**
 * The variable whose value, resolved by teamai into `target`, `raw` (a project
 * file's text) holds, or null: one `teamDefs` references that the tool does not
 * expand itself, with a value in `vars` of 8+ characters (shorter ones turn up
 * anywhere). Needs no ownership manifest.
 */
export function resolvedVariableIn(
  target: McpTarget,
  teamDefs: McpServerDef[],
  vars: Record<string, string>,
  raw: string,
): string | null {
  if (!target.projectScope) return null;
  for (const def of teamDefs) {
    if (supportsEnvExpansion(target.format, target.projectScope, def)) continue;
    const found = referencedVars(def).find((name) => {
      const value = vars[name];
      return value !== undefined && value.length >= 8 && raw.includes(value);
    });
    if (found) return found;
  }
  return null;
}

/**
 * The `info/exclude` git reads for `dir`'s checkout (worktrees and submodules
 * included), the checkout's root, and `dir`'s path from it.
 */
async function gitExcludeFile(dir: string): Promise<{ excludeFile: string; root: string; prefix: string } | null> {
  const result = await execCommand('git', ['rev-parse', '--show-toplevel', '--show-prefix', '--git-path', 'info/exclude'], { cwd: dir, timeoutMs: 10_000 })
    .catch(() => null);
  if (!result || result.code !== 0) return null;
  const [root = '', prefix = '', gitPath = ''] = result.stdout.split(/\r?\n/);
  if (!root || !gitPath) return null;
  // Real path, so one repository reached through a symlink (macOS /var) is one file.
  const base = await fse.realpath(dir).catch(() => dir);
  return { excludeFile: path.resolve(base, gitPath), root, prefix };
}

/** The closest directory above `file` that exists. */
async function existingAncestor(file: string): Promise<string> {
  let dir = path.dirname(path.resolve(file));
  while (!await pathExists(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/**
 * Whether git would put a file in a commit. `unknown` is a repository git could
 * not answer for (unsafe ownership, a bad config): never read it as safe.
 */
export type GitTracking =
  | { kind: 'ignored' }
  | { kind: 'would-commit' }
  | { kind: 'outside-repo' }
  | { kind: 'unknown'; error: string };

/** Whether git would put `file` in a commit: tracked, or untracked without an ignore rule. Read-only. */
export async function gitTracking(file: string): Promise<GitTracking> {
  const dir = await existingAncestor(file);
  const result = await execCommand('git', ['check-ignore', '-q', '--', path.relative(dir, file)], { cwd: dir, timeoutMs: 10_000 })
    .catch((e: unknown) => ({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }));
  if (result.code === 0) return { kind: 'ignored' };
  if (result.code === 1) return { kind: 'would-commit' };
  // Anything else is no repository at all, or git failing inside one.
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (await pathExists(path.join(d, '.git'))) return { kind: 'unknown', error: result.stderr.trim() || `git exited with ${result.code}` };
    if (path.dirname(d) === d) return { kind: 'outside-repo' };
  }
}

/**
 * Whether git tracks `file` (#879): the next `git commit -a` commits a change to
 * it, and no exclude rule stops that. Read-only. A file outside any repository
 * is not tracked; nor is one in a repository git cannot answer for, where a
 * commit fails too.
 */
async function gitTracks(file: string): Promise<boolean> {
  // The file, or even its directory, may be gone from disk and still be in the index.
  const dir = await existingAncestor(file);
  const result = await execCommand('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path.relative(dir, file)], { cwd: dir, timeoutMs: 10_000 })
    .catch(() => null);
  return result?.code === 0;
}

/**
 * teamai's block and what surrounds it; null without both markers, so a damaged
 * block never takes the member's lines with it. The last start marker opens it:
 * one that lost its end marker is left behind, not paired with the next block's end.
 */
function splitBlock(content: string): { before: string; patterns: string[]; after: string } | null {
  const start = content.lastIndexOf(MCP_EXCLUDE_START);
  const endAt = start === -1 ? -1 : content.indexOf(MCP_EXCLUDE_END, start);
  if (endAt === -1) return null;
  const patterns = content.slice(start + MCP_EXCLUDE_START.length, endAt)
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const after = content.slice(endAt + MCP_EXCLUDE_END.length).replace(/^\r?\n/, '');
  return { before: content.slice(0, start), patterns, after };
}

/**
 * Whether `file` is kept out of git, or why teamai could not keep it out and
 * what the member does about it. `pending`: a dry run found nothing in the way
 * of listing it.
 */
export type GitExclusion =
  | { kind: 'excluded' }
  | { kind: 'pending' }
  | { kind: 'failed'; reason: string; fix: string };

/**
 * Add `file` to its repository's `.git/info/exclude` unless git ignores it
 * already, and whether git now leaves it out of a commit. Idempotent; a path
 * already ignored, or outside any repository, adds nothing, and one git cannot
 * answer for is added all the same. `file` need not exist yet: pull calls this
 * before writing a resolved value into it. `dryRun` writes nothing and reports
 * what would stop the write.
 */
export async function ensureExcludedFromGit(file: string, options: { dryRun?: boolean } = {}): Promise<GitExclusion> {
  const tracking = await gitTracking(file);
  if (tracking.kind === 'ignored' || tracking.kind === 'outside-repo') return { kind: 'excluded' };
  // `file` and its directory need not exist yet: git is asked from the nearest one that does.
  const dir = await existingAncestor(file);
  const location = await gitExcludeFile(dir);
  if (!location) {
    return {
      kind: 'failed',
      reason: tracking.kind === 'unknown' ? tracking.error : 'git could not locate .git/info/exclude',
      fix: 'Fix the repository, or add the file to its .git/info/exclude yourself, then run `teamai pull` again.',
    };
  }
  const { excludeFile } = location;
  // Anchored at the working tree root, glob characters escaped.
  const rel = path.relative(dir, file).split(path.sep).join('/');
  const pattern = `/${location.prefix}${rel}`.replace(/[\\*?[\]!#]/g, '\\$&');
  const retry = `Make it writable, or add \`${pattern}\` to it yourself, then run \`teamai pull\` again.`;
  // A read-only exclude file is the member's choice; the atomic write would replace it all the same.
  for (const writable of [path.dirname(excludeFile), ...(await pathExists(excludeFile) ? [excludeFile] : [])]) {
    const denied = await fse.access(writable, fse.constants.W_OK).then(() => false, () => true);
    if (denied) return { kind: 'failed', reason: `${writable} is not writable`, fix: retry };
  }
  const add = (content: string): string | null => {
    const block = splitBlock(content);
    if (block?.patterns.includes(pattern)) return null;
    const head = block ? block.before : content;
    const patterns = [...(block?.patterns ?? []), pattern];
    const body = [MCP_EXCLUDE_START, ...patterns, MCP_EXCLUDE_END].join('\n');
    const sep = head === '' || head.endsWith('\n') ? '' : '\n';
    return `${head}${sep}${body}\n${block?.after ?? ''}`;
  };
  // An exclude rule does not apply to a file git tracks already.
  const tracked: GitExclusion = {
    kind: 'failed',
    reason: `git already tracks ${file}`,
    fix: `Run \`git rm --cached ${file}\` (rotate any value a commit of it holds), then \`teamai pull\` again.`,
  };
  let result: ExcludeUpdate;
  try {
    if (options.dryRun) {
      // Nothing listed yet: only a tracked file would still stop the write.
      if (add((await readFileSafe(excludeFile)) ?? '') !== null) return await gitTracks(file) ? tracked : { kind: 'pending' };
      result = 'unchanged';
    } else {
      result = await updateExclude(excludeFile, add);
    }
  } catch (e) {
    return { kind: 'failed', reason: `adding it to ${excludeFile} failed: ${e instanceof Error ? e.message : String(e)}`, fix: retry };
  }
  if (result === 'locked') {
    return {
      kind: 'failed',
      reason: `another teamai command held ${excludeFile} past the wait`,
      fix: 'Run `teamai pull` again.',
    };
  }
  if (result === 'written') log.debug(`Added ${pattern} to ${excludeFile}`);
  return (await gitTracking(file)).kind === 'would-commit' ? tracked : { kind: 'excluded' };
}

/**
 * `ensureExcludedFromGit` for a file already on disk, warning when it fails
 * rather than failing the sync that wrote the file.
 */
export async function excludeFromGit(file: string): Promise<void> {
  if (!await pathExists(file)) return;
  const exclusion = await ensureExcludedFromGit(file);
  if (exclusion.kind === 'failed') {
    log.warn(
      `${file} holds a resolved MCP variable, and teamai could not keep it out of git: ${exclusion.reason}. `
      + `${exclusion.fix} Do not commit the file meanwhile.`,
    );
  }
}

/** How `updateExclude` left the file: `locked` wrote nothing, another command held it past the wait. */
export type ExcludeUpdate = 'written' | 'unchanged' | 'locked';

/**
 * Rewrite `excludeFile` with `edit` (null: leave it as it is), holding a lock
 * across the read and an atomic write: the worktrees of a repository share the
 * file, so two commands adding different paths must not drop each other's.
 * A lock still held after the wait writes nothing: an unlocked write could drop
 * the holder's pattern, leaving that path unprotected.
 */
async function updateExclude(excludeFile: string, edit: (content: string) => string | null): Promise<ExcludeUpdate> {
  const { acquireLock, releaseLock } = await import('./update.js');
  const lockPath = `${excludeFile}.teamai-lock`;
  let held = false;
  for (let attempt = 0; attempt < 25 && !held; attempt++) {
    held = await acquireLock(lockPath);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!held) return 'locked';
  try {
    const next = edit((await readFileSafe(excludeFile)) ?? '');
    if (next === null) return 'unchanged';
    await writeFileAtomic(excludeFile, next);
    return 'written';
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * The `.git/info/exclude` files holding teamai's block, one per repository
 * among those `dirs` are in (a config inside a nested repository or submodule
 * is excluded from that repository, not from the project root's), each with
 * its patterns and the absolute paths each protects in the checkouts `dirs` reach.
 */
export async function findMcpGitExcludes(dirs: Iterable<string>): Promise<Map<string, Array<{ pattern: string; files: string[] }>>> {
  const roots = new Map<string, Set<string>>();
  for (const dir of new Set(dirs)) {
    const location = await gitExcludeFile(dir);
    if (!location) continue;
    const seen = roots.get(location.excludeFile) ?? new Set<string>();
    roots.set(location.excludeFile, seen.add(location.root));
  }
  const found = new Map<string, Array<{ pattern: string; files: string[] }>>();
  for (const [excludeFile, checkouts] of roots) {
    const content = await readFileSafe(excludeFile);
    const block = content === null ? null : splitBlock(content);
    if (!block) continue;
    // Every checkout sharing the file, including a nested repository's linked worktrees elsewhere.
    const [anyCheckout] = checkouts;
    if (anyCheckout) for (const worktree of await listWorktrees(anyCheckout)) checkouts.add(worktree);
    // Each pattern is `/<path from the root>`, glob characters escaped (see excludeFromGit).
    found.set(excludeFile, block.patterns.map((pattern) => {
      const rel = pattern.replace(/^\//, '').replace(/\\(.)/g, '$1');
      return { pattern, files: [...checkouts].map((root) => path.join(root, rel)) };
    }));
  }
  return found;
}

/**
 * Remove `patterns` from teamai's block in `excludeFile` (one `findMcpGitExcludes`
 * returned), and the block with its last pattern.
 */
export async function removeMcpGitExclude(excludeFile: string, patterns: string[]): Promise<ExcludeUpdate> {
  return updateExclude(excludeFile, (content) => {
    const block = splitBlock(content);
    if (!block) return null;
    const kept = block.patterns.filter((p) => !patterns.includes(p));
    if (kept.length === block.patterns.length) return null;
    const body = kept.length > 0 ? `${[MCP_EXCLUDE_START, ...kept, MCP_EXCLUDE_END].join('\n')}\n` : '';
    return block.before + body + block.after;
  });
}

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
  const dir = path.dirname(file);
  const result = await execCommand('git', ['check-ignore', '-q', '--', path.basename(file)], { cwd: dir, timeoutMs: 10_000 })
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
 * Add `file` to its repository's `.git/info/exclude` unless git ignores it
 * already. Idempotent; a path already ignored, or outside any repository, adds
 * nothing, and one git cannot answer for is added all the same. A failure warns
 * rather than failing the sync that wrote the file.
 */
export async function excludeFromGit(file: string): Promise<void> {
  if (!await pathExists(file)) return;
  const tracking = await gitTracking(file);
  if (tracking.kind === 'ignored' || tracking.kind === 'outside-repo') return;
  const location = await gitExcludeFile(path.dirname(file));
  if (!location) {
    const reason = tracking.kind === 'unknown' ? tracking.error : 'git could not locate .git/info/exclude';
    log.warn(
      `${file} holds a resolved MCP variable, and teamai could not keep it out of git: ${reason}. `
      + 'Fix the repository, or add the file to its .git/info/exclude yourself, so git does not commit the value.',
    );
    return;
  }
  const { excludeFile } = location;
  // Anchored at the working tree root, glob characters escaped.
  const pattern = `/${location.prefix}${path.basename(file)}`.replace(/[\\*?[\]!#]/g, '\\$&');
  try {
    const added = await updateExclude(excludeFile, (content) => {
      const block = splitBlock(content);
      if (block?.patterns.includes(pattern)) return null;
      const head = block ? block.before : content;
      const patterns = [...(block?.patterns ?? []), pattern];
      const body = [MCP_EXCLUDE_START, ...patterns, MCP_EXCLUDE_END].join('\n');
      const sep = head === '' || head.endsWith('\n') ? '' : '\n';
      return `${head}${sep}${body}\n${block?.after ?? ''}`;
    });
    if (added) log.debug(`Added ${pattern} to ${excludeFile}`);
  } catch (e) {
    log.warn(
      `${file} holds a resolved MCP variable, and adding it to ${excludeFile} failed: ${e instanceof Error ? e.message : String(e)}. `
      + `Add \`${pattern}\` to that file yourself so git does not commit the value.`,
    );
  }
}

/**
 * Rewrite `excludeFile` with `edit` (null: leave it as it is), holding a lock
 * across the read and an atomic write: the worktrees of a repository share the
 * file, so two commands adding different paths must not drop each other's.
 * A lock still held after the wait is passed over rather than skipping the
 * write, which would leave the path unprotected.
 */
async function updateExclude(excludeFile: string, edit: (content: string) => string | null): Promise<boolean> {
  const { acquireLock, releaseLock } = await import('./update.js');
  const lockPath = `${excludeFile}.teamai-lock`;
  let held = false;
  for (let attempt = 0; attempt < 25 && !held; attempt++) {
    held = await acquireLock(lockPath);
    if (!held) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!held) log.debug(`${lockPath} is still held; updating ${excludeFile} without it`);
  try {
    const next = edit((await readFileSafe(excludeFile)) ?? '');
    if (next === null) return false;
    await writeFileAtomic(excludeFile, next);
    return true;
  } finally {
    if (held) await releaseLock(lockPath);
  }
}

/**
 * The `.git/info/exclude` files holding teamai's block, one per repository
 * among those `dirs` are in (a config inside a nested repository or submodule
 * is excluded from that repository, not from the project root's), each with
 * the absolute paths its block protects in the checkouts `dirs` reach.
 */
export async function findMcpGitExcludes(dirs: Iterable<string>): Promise<Map<string, string[]>> {
  const roots = new Map<string, Set<string>>();
  for (const dir of new Set(dirs)) {
    const location = await gitExcludeFile(dir);
    if (!location) continue;
    const seen = roots.get(location.excludeFile) ?? new Set<string>();
    roots.set(location.excludeFile, seen.add(location.root));
  }
  const found = new Map<string, string[]>();
  for (const [excludeFile, checkouts] of roots) {
    const content = await readFileSafe(excludeFile);
    const block = content === null ? null : splitBlock(content);
    if (!block) continue;
    // Every checkout sharing the file, including a nested repository's linked worktrees elsewhere.
    const [anyCheckout] = checkouts;
    if (anyCheckout) for (const worktree of await listWorktrees(anyCheckout)) checkouts.add(worktree);
    // Each pattern is `/<path from the root>`, glob characters escaped (see excludeFromGit).
    const rels = block.patterns.map((p) => p.replace(/^\//, '').replace(/\\(.)/g, '$1'));
    found.set(excludeFile, [...checkouts].flatMap((root) => rels.map((rel) => path.join(root, rel))));
  }
  return found;
}

/** Remove teamai's block from `excludeFile`, one `findMcpGitExcludes` returned. */
export async function removeMcpGitExclude(excludeFile: string): Promise<boolean> {
  return updateExclude(excludeFile, (content) => {
    const block = splitBlock(content);
    return block ? block.before + block.after : null;
  });
}

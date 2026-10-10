import path from 'node:path';
import type { McpServerDef } from './types.js';
import type { McpTarget } from './mcp-reconcile.js';
import {
  MCP_EXCLUDE_OWNER,
  ensure,
  excludeLines,
  gitExcludeFile,
  updateExcludeLines,
  type ExcludeUpdate,
} from './git-exclude.js';
import { referencedVars, supportsEnvExpansion } from './resources/mcp-format.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { listWorktrees } from './utils/git.js';
import { log } from './utils/logger.js';

// ─── Project MCP configs and git ─────────────────────────────
//
//  A project-scope MCP config that holds a resolved `${VAR}` sits in the
//  business repo's working tree with the value in plaintext, and one
//  `git add -A` commits it (#882). teamai lists such a file in the clone's own
//  `.git/info/exclude`, inside a block it owns: local to the clone, nothing
//  committed, and the team's `.gitignore` never touched. The block is the
//  `mcp-exclude` owner's in the git-exclude module, which owns the file.

export { MCP_EXCLUDE_END, MCP_EXCLUDE_START, updateFileLocked } from './git-exclude.js';

const MCP_OWNER = { name: MCP_EXCLUDE_OWNER };

/**
 * Whether `target`'s file carries a value teamai resolved from a `${VAR}`: a
 * project-scope file holding one of `names` whose definition references a
 * variable the tool does not expand itself. A local scope (#915) is
 * outside the working tree: no exclusion protects it, and none is needed.
 */
export function carriesResolvedValue(
  target: McpTarget,
  teamDefs: McpServerDef[],
  names: Iterable<string>,
): boolean {
  if (!target.projectScope || target.projectKey) return false;
  const present = new Set(names);
  return teamDefs.some((def) => present.has(def.name)
    && referencedVars(def).length > 0
    && !supportsEnvExpansion(target.format, target.projectScope, def));
}

/**
 * Whether a JSON MCP entry the local agent installs for an HTTP-backed team
 * carries a credential (#882): a header, env value or argument of any kind, a
 * URL (a token can sit in its path, as well as in a user or a query), or a
 * command line with arguments in it. Its payload holds the values themselves,
 * not `${VAR}` references teamai resolves, so nothing tells a token from a
 * plain setting: every one counts. Only a bare stdio command does not.
 */
export function carriesLocalAgentCredential(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const fields = entry as Record<string, unknown>;
  const nonEmpty = (value: unknown): boolean =>
    Array.isArray(value) ? value.length > 0 : typeof value === 'object' && value !== null && Object.keys(value).length > 0;
  // OpenCode keeps env under `environment`, and a stdio command with its arguments under `command`.
  if (['headers', 'env', 'environment', 'args'].some((key) => nonEmpty(fields[key]))) return true;
  // A command line in one string, or OpenCode's one-element array holding it, carries its arguments too.
  const commandParts: unknown[] = Array.isArray(fields.command) ? fields.command : [fields.command];
  if (commandParts.length > 1 || commandParts.some((part) => typeof part === 'string' && /\s/.test(part.trim()))) return true;
  return ['url', 'serverUrl', 'httpUrl'].some((key) => typeof fields[key] === 'string' && fields[key].trim() !== '');
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
 * Whether `file` is kept out of git, or why teamai could not keep it out and
 * what the member does about it. `added`: this call listed it. `pending`: a dry
 * run found nothing in the way of listing it.
 */
export type GitExclusion =
  | { kind: 'excluded'; added: boolean }
  | { kind: 'pending' }
  | { kind: 'failed'; reason: string; fix: string };

/**
 * Add `file` to its repository's `.git/info/exclude` unless git ignores it
 * already, and whether git now leaves it out of a commit. Idempotent; a path
 * already ignored, or outside any repository, adds nothing. One git tracks
 * fails before anything else is checked, and so does one git cannot say it
 * does not track: an exclude rule does not apply to a tracked file, and a git
 * error is never read as safe. `file` need not exist yet: pull calls this
 * before writing a resolved value into it. `dryRun` writes nothing and reports
 * what would stop the write. `rerun` ends each fix: how the caller's write is
 * tried again.
 */
export async function ensureExcludedFromGit(
  file: string,
  options: { dryRun?: boolean; rerun?: string } = {},
): Promise<GitExclusion> {
  const [{ result }] = await ensure(MCP_OWNER, [file], options);
  switch (result.kind) {
    case 'excluded':
    case 'pending':
      return result;
    case 'outsideRepo':
      return { kind: 'excluded', added: false };
    default:
      return { kind: 'failed', reason: result.reason, fix: result.fix };
  }
}

/**
 * `ensureExcludedFromGit` for a file already on disk that may hold a resolved
 * value, warning when it fails rather than failing the sync that wrote the file.
 */
export async function excludeFromGit(file: string, options: { rerun?: string; holds?: string } = {}): Promise<void> {
  if (!await pathExists(file)) return;
  const exclusion = await ensureExcludedFromGit(file, { rerun: options.rerun });
  if (exclusion.kind === 'failed') {
    log.warn(
      `${file} may hold ${options.holds ?? 'a resolved MCP variable'}, and teamai could not keep it out of git: ${exclusion.reason}. `
      + `${exclusion.fix} Do not commit the file meanwhile.`,
    );
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
    const patterns = content === null ? null : excludeLines(content, MCP_EXCLUDE_OWNER);
    if (!patterns) continue;
    // Every checkout sharing the file, including a nested repository's linked worktrees elsewhere.
    const [anyCheckout] = checkouts;
    if (anyCheckout) for (const worktree of await listWorktrees(anyCheckout)) checkouts.add(worktree);
    found.set(excludeFile, patterns.map((pattern) => {
      const rel = mcpExcludePatternPath(pattern);
      return { pattern, files: [...checkouts].map((root) => path.join(root, rel)) };
    }));
  }
  return found;
}

/** The path from its checkout's root one of teamai's patterns stands for: `/<path>`, glob characters escaped (see ensureExcludedFromGit). */
export function mcpExcludePatternPath(pattern: string): string {
  return pattern.replace(/^\//, '').replace(/\\(.)/g, '$1');
}

/**
 * Remove `patterns` from teamai's block in `excludeFile` (one `findMcpGitExcludes`
 * returned), and the block with its last pattern.
 */
export async function removeMcpGitExclude(excludeFile: string, patterns: string[]): Promise<ExcludeUpdate> {
  return updateExcludeLines(excludeFile, MCP_EXCLUDE_OWNER, (lines) => {
    const kept = lines.filter((p) => !patterns.includes(p));
    return kept.length === lines.length ? null : kept;
  });
}

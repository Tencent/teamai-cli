import path from 'node:path';
import { readFileSafe, writeJsonAtomic, pathExists, remove } from '../utils/fs.js';
import { log } from '../utils/logger.js';

// ─── OpenCode config activation ──────────────────────────────
//
//  Unlike every other tool teamai targets, OpenCode does not auto-scan a rules
//  directory. Rule .md files copied into `.opencode/rules/` are inert until they
//  are referenced from the `instructions` array in `opencode.json`. This module
//  maintains the teamai-managed globs in that array by key-level surgery: it
//  reads the JSON, adds or removes only entries teamai owns, and writes every
//  other top-level key (including `mcp`, which the MCP reconcile engine owns)
//  back untouched. It never rewrites the user's own `instructions` entries.
//
//  The same opencode.json is shared with the MCP `mcp` key, so both writers must
//  be surgical — a regenerate-from-scratch here would clobber injected servers.

/**
 * The rules glob relative to the directory that holds opencode.json.
 *
 * OpenCode resolves a relative `instructions` entry from the session's working
 * directory, not from the config file. This gives the entry earlier releases
 * wrote: `.opencode/rules/*.md` in a project's root opencode.json, which loaded
 * no namespaced rule, and `rules/*.md` in the user one, which loaded the
 * project's `rules/` instead. It is used only to reclaim those entries (#946).
 */
export function opencodeRulesGlob(configFileAbs: string, rulesDirAbs: string): string {
  return `${posix(path.relative(path.dirname(configFileAbs), rulesDirAbs))}/*.md`;
}

/** Forward slashes: opencode.json entries are POSIX-style. */
function posix(p: string): string {
  return p.split(path.sep).join('/');
}

/** The `instructions` globs that load teamai's rules, and which entries teamai owns. */
export interface OpencodeRuleGlobs {
  /** The globs that should be listed while the team has rules here. */
  globs: string[];
  /** Whether an `instructions` entry is one teamai wrote for rules, now or in an earlier release. */
  owns: (entry: string) => boolean;
}

/**
 * The opencode.json teamai registers its project entries in. The root
 * opencode.json stays the project's (#945, #946).
 */
export function opencodeProjectConfig(projectRoot: string): string {
  return path.join(projectRoot, '.opencode', 'opencode.json');
}

/** Where one scope registers the rules globs, and where an earlier release did. */
export interface OpencodeRulesTarget extends OpencodeRuleGlobs {
  /** The opencode.json `globs` are registered in. */
  configFile: string;
  /** Another opencode.json and the entries earlier releases wrote there: removed, never written. */
  retired: { configFile: string; owns: (entry: string) => boolean } | null;
}

/**
 * The rules glob for a project, registered in `.opencode/opencode.json`.
 *
 * OpenCode resolves a relative `instructions` entry from the session's working
 * directory, globbing it in that directory and each parent up to the worktree,
 * whichever config file lists it. So the entry is relative to the project
 * root, and one recursive glob loads the namespaced rules as well (#946).
 * Earlier releases wrote `.opencode/rules/*.md` to the root opencode.json,
 * which loaded no namespaced rule; that entry is reclaimed.
 *
 * @param rootConfigAbs The root opencode.json, or null when the team config names none.
 */
export function opencodeProjectRuleGlobs(
  projectRoot: string,
  rulesDirAbs: string,
  rootConfigAbs: string | null,
): OpencodeRulesTarget {
  const glob = `${posix(path.relative(projectRoot, rulesDirAbs))}/**/*.md`;
  const old = rootConfigAbs === null ? null : opencodeRulesGlob(rootConfigAbs, rulesDirAbs);
  return {
    configFile: opencodeProjectConfig(projectRoot),
    globs: [glob],
    owns: (entry) => entry === glob,
    retired: rootConfigAbs === null ? null : { configFile: rootConfigAbs, owns: (entry) => entry === old },
  };
}

/**
 * The user rules globs for `~/.config/opencode/opencode.json`.
 *
 * A relative entry resolves from the session cwd, not from the config file,
 * so the old `rules/*.md` loaded the project's `rules/` instead of the user
 * rules (#946). The globs are absolute, and since OpenCode globs only the
 * basename of an absolute entry (`**` never matches), each directory a rule
 * lands in gets its own: the rules root plus one per namespace. teamai owns
 * the root glob, the glob of each directory a team rule can land in, and the
 * old relative one. A glob for any other directory is the member's own.
 *
 * @param ruleDirsAbs The directories the delivered rules land in.
 * @param teamDirsAbs The directories any team rule can land in, delivered here or not.
 */
export function opencodeRuleGlobs(
  configFileAbs: string,
  rulesDirAbs: string,
  ruleDirsAbs: readonly string[],
  teamDirsAbs: readonly string[],
): OpencodeRuleGlobs {
  const relative = opencodeRulesGlob(configFileAbs, rulesDirAbs);
  const root = posix(rulesDirAbs);
  const under = (dirs: readonly string[]): string[] =>
    [...new Set(dirs.map(posix))].filter((dir) => dir.startsWith(`${root}/`)).sort();
  const globs = [root, ...under(ruleDirsAbs)].map((dir) => `${dir}/*.md`);
  const owned = new Set([relative, ...globs, ...under(teamDirsAbs).map((dir) => `${dir}/*.md`)]);
  return { globs, owns: (entry) => owned.has(entry) };
}

/**
 * Make the entries teamai owns in `instructions` exactly `desired`: add the
 * missing ones at the end, remove the owned ones not desired, and leave every
 * other entry where it is.
 *
 * @returns true if the file was written.
 *
 * A missing file is created with just `desired`, or left missing when nothing
 * is desired. A file that exists but cannot be parsed as a JSON object is left
 * strictly alone (it may hold config we do not understand), and the function
 * returns false. With `deleteIfEmpty`, a file left holding nothing but the
 * `$schema` OpenCode adds is deleted: for a config file teamai creates.
 */
export async function reconcileOpencodeInstructionSet(
  configFileAbs: string,
  desired: readonly string[],
  owns: (entry: string) => boolean,
  purpose = 'rules activation',
  { deleteIfEmpty = false }: { deleteIfEmpty?: boolean } = {},
): Promise<boolean> {
  const exists = await pathExists(configFileAbs);

  if (!exists) {
    if (desired.length === 0) return false;
    await writeJsonAtomic(configFileAbs, { instructions: [...desired] });
    log.debug(`Created ${configFileAbs} with teamai ${purpose} entries`);
    return true;
  }

  const raw = await readFileSafe(configFileAbs);
  if (raw === null) return false;

  let data: Record<string, unknown>;
  if (raw.trim() === '') {
    data = {};
  } else {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log.warn(`Could not parse ${configFileAbs} as a JSON object — skipping OpenCode ${purpose}`);
        return false;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      log.warn(`Could not parse ${configFileAbs} — skipping OpenCode ${purpose}`);
      return false;
    }
  }

  // Operate on the array in place so the relative order of the user's own
  // entries — string globs and any non-string entries alike — is preserved.
  // (OpenCode may treat instruction order as precedence, so reordering the
  // user's entries on every pull would silently change their config.)
  const original = Array.isArray(data.instructions) ? [...(data.instructions as unknown[])] : [];
  const kept = original.filter((entry) => typeof entry !== 'string' || !owns(entry) || desired.includes(entry));
  const next = [...kept, ...desired.filter((entry) => !kept.includes(entry))];
  if (next.length === original.length && next.every((entry, i) => entry === original[i])) return false;

  // Key-level surgery: drop `instructions` entirely when it would be empty,
  // otherwise write the reconciled array back.
  if (next.length === 0) {
    delete data.instructions;
  } else {
    data.instructions = next;
  }

  if (deleteIfEmpty && Object.keys(data).every((key) => key === '$schema')) {
    await remove(configFileAbs);
    log.debug(`Removed ${configFileAbs}: it held only teamai ${purpose} entries`);
    return true;
  }
  await writeJsonAtomic(configFileAbs, data);
  log.debug(`Reconciled teamai ${purpose} entries in ${configFileAbs}`);
  return true;
}

/**
 * Ensure `opencode.json` references (or stops referencing) one teamai entry.
 *
 * @param configFileAbs Absolute path to the opencode.json to edit.
 * @param glob          The instructions glob to add/remove (see opencodeRulesGlob).
 * @param present       true = the glob should be in `instructions`; false = removed.
 * @returns true if the file was written.
 *
 * When `present` is true and the file does not exist, it is created with just the
 * `instructions` array — teamai owns nothing else in it. When `present` is false
 * and the file does not exist, nothing happens. A file that exists but cannot be
 * parsed as a JSON object is left strictly alone (it may hold config we do not
 * understand), and the function returns false.
 */
export async function reconcileOpencodeInstructions(
  configFileAbs: string,
  glob: string,
  present: boolean,
  purpose = 'rules activation',
): Promise<boolean> {
  return reconcileOpencodeInstructionSet(configFileAbs, present ? [glob] : [], (entry) => entry === glob, purpose);
}

// ─── OpenCode team instructions (#945) ───────────────────────

/**
 * The `instructions` entries of an opencode.json, or null when the file is
 * missing or is not a JSON object, the two cases in which pull leaves it alone.
 */
export async function readOpencodeInstructionList(configFile: string): Promise<unknown[] | null> {
  const raw = await readFileSafe(configFile);
  if (raw === null) return null;
  if (raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { instructions } = parsed as { instructions?: unknown };
    return Array.isArray(instructions) ? instructions : [];
  } catch {
    return null;
  }
}

/**
 * Where OpenCode is told to load teamai's instruction file: the config file
 * and its `instructions` entry. In user scope the user config holds the
 * file's absolute path. In a project `.opencode/opencode.json` holds the path
 * from the project root, which OpenCode resolves the same way from any
 * subdirectory; the root `opencode.json` is left alone.
 */
export function opencodeContextReference(contextFile: string, scope: 'user' | 'project', projectRoot: string): { config: string; entry: string } {
  if (scope === 'user') {
    return { config: path.join(path.dirname(contextFile), 'opencode.json'), entry: contextFile };
  }
  return {
    config: opencodeProjectConfig(projectRoot),
    entry: posix(path.relative(projectRoot, contextFile)),
  };
}

/**
 * OpenCode loads `~/.claude/CLAUDE.md` while its own user `AGENTS.md` does not
 * exist. When teamai delivers the user blocks there for Claude, OpenCode
 * already gets them, and a second file would add a duplicate. Returns the
 * Claude file in that case, null otherwise.
 */
export async function opencodeClaudeFallback(home: string, targetPaths: readonly string[]): Promise<string | null> {
  const claudeFile = path.join(home, '.claude', 'CLAUDE.md');
  if (!targetPaths.includes(claudeFile)) return null;
  if (await pathExists(path.join(home, '.config', 'opencode', 'AGENTS.md'))) return null;
  return claudeFile;
}

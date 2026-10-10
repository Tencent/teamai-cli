import path from 'node:path';
import { updateFileLocked } from './git-exclude.js';
import { getDataHome, type GlobalOptions, type LocalConfig } from './types.js';
import { pathExists, readFileSafe } from './utils/fs.js';
import { getUserHome } from './utils/home.js';
import { log } from './utils/logger.js';
import { warnOnce } from './utils/warn-once.js';

// ─── What a background pull could not say about git exclude blocks (#915) ──
//
//  A pull a session start or a git hook runs prints to no one. What it has to
//  say about teamai's git exclude blocks is kept in the project partition
//  (`git-exclude-notices.json`, separate from `git-hook-failure.json`):
//  - the last failure to update a block, replaced by each failed sync and
//    cleared by the next sync that succeeds, whoever runs it; the next
//    interactive pull says it once;
//  - notices (a path no git exclude line can name, a path left visible because
//    another checkout has its own file there, a shared file that stopped being
//    teamai's alone), each said once by the next interactive pull, which then
//    drops it. `doctor` shows both and changes nothing.
//  An owner whose blocks span repositories (the local agent's) keeps the same
//  record under its own key in its state home's `git-exclude-notices.json`, so
//  one owner's success never clears another's failure.

export interface GitExcludeNotice {
  at: string;
  message: string;
}

export interface GitExcludeNotices {
  /** `said`: an interactive pull has said it; `doctor` still shows it until a sync succeeds. */
  lastFailure: (GitExcludeNotice & { said?: boolean }) | null;
  notices: GitExcludeNotice[];
}

const NOTICES_FILE = 'git-exclude-notices.json';

/**
 * Where a record is kept: a project's partition (its pulls'), or one owner's
 * key in a state home's file. `label` names the run a failure came from.
 */
export type GitExcludeNoticesHome = LocalConfig | { stateHome: string; owner: string; label: string };

/** The local agent's record, beside its `git-exclude.json`. */
export function localAgentGitExcludeNotices(): GitExcludeNoticesHome {
  return { stateHome: path.join(getUserHome(), '.teamai', 'local-agent'), owner: 'local-agent', label: 'A local agent sync' };
}

function locate(home: GitExcludeNoticesHome): { file: string; owner: string | null; label: string } {
  return 'stateHome' in home
    ? { file: path.join(home.stateHome, NOTICES_FILE), owner: home.owner, label: home.label }
    : { file: path.join(getDataHome(home), NOTICES_FILE), owner: null, label: 'A background pull' };
}

/** A pull nobody watches: a session start's (`silent`) or a git hook's. */
export function isBackgroundPull(options: Pick<GlobalOptions, 'silent' | 'gitHook'>): boolean {
  return Boolean(options.silent || options.gitHook);
}

function parseFile(content: string | null): Record<string, unknown> {
  if (!content?.trim()) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    // Nothing in it is worth more than the notices to come.
    return {};
  }
}

function parse(record: unknown): GitExcludeNotices {
  const parsed = (typeof record === 'object' && record !== null ? record : {}) as Partial<GitExcludeNotices>;
  const valid = (n: unknown): n is GitExcludeNotice => typeof (n as GitExcludeNotice)?.message === 'string' && typeof (n as GitExcludeNotice)?.at === 'string';
  return {
    lastFailure: valid(parsed.lastFailure) ? { ...parsed.lastFailure, said: parsed.lastFailure.said === true } : null,
    notices: Array.isArray(parsed.notices) ? parsed.notices.filter(valid) : [],
  };
}

/** What background runs kept for this home. Read-only. */
export async function readGitExcludeNotices(home: GitExcludeNoticesHome): Promise<GitExcludeNotices> {
  const { file, owner } = locate(home);
  const all = parseFile(await readFileSafe(file));
  return parse(owner === null ? all : all[owner]);
}

/**
 * Change the record under its lock. A record that cannot be written (its lock
 * held past the wait, the data home not writable) is written to debug.log
 * instead: the next run meets the same state and tries again.
 */
async function updateNotices(home: GitExcludeNoticesHome, edit: (current: GitExcludeNotices) => GitExcludeNotices | null): Promise<void> {
  const { file, owner } = locate(home);
  try {
    const result = await updateFileLocked(file, (content) => {
      const all = parseFile(content);
      const next = edit(parse(owner === null ? all : all[owner]));
      if (next === null) return null;
      return `${JSON.stringify(owner === null ? next : { ...all, [owner]: next }, null, 2)}\n`;
    });
    if (result === 'locked') log.persist(`git exclude: ${file} was busy, its update waits for the next run`);
  } catch (e) {
    log.persist(`git exclude: could not update ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Say `message` about a git exclude block now, once per pull, or, in a
 * background run, keep it for the next interactive pull and `doctor`. The
 * same message is kept once.
 */
export async function noticeGitExclude(home: GitExcludeNoticesHome, message: string, options: Pick<GlobalOptions, 'silent' | 'gitHook'>): Promise<void> {
  if (!isBackgroundPull(options)) {
    warnOnce(message);
    return;
  }
  log.persist(`git exclude: ${message}`);
  await updateNotices(home, (current) => current.notices.some((n) => n.message === message)
    ? null
    : { ...current, notices: [...current.notices, { at: new Date().toISOString(), message }] });
}

/** A background sync's failure, replacing the one before. */
export async function recordGitExcludeFailure(home: GitExcludeNoticesHome, message: string): Promise<void> {
  log.persist(`git exclude: ${message}`);
  await updateNotices(home, (current) => ({ ...current, lastFailure: { at: new Date().toISOString(), message } }));
}

/** A sync succeeded: the last failure is over. */
export async function clearGitExcludeFailure(home: GitExcludeNoticesHome): Promise<void> {
  if (!await pathExists(locate(home).file)) return;
  await updateNotices(home, (current) => current.lastFailure === null ? null : { ...current, lastFailure: null });
}

/**
 * The interactive pull's turn: say the last background failure, once, and
 * every notice, then drop the notices (the failure stays, for `doctor`,
 * until a sync succeeds). Returns whether a failure is on record.
 */
export async function sayGitExcludeNotices(home: GitExcludeNoticesHome): Promise<boolean> {
  const { lastFailure, notices } = await readGitExcludeNotices(home);
  const failure = lastFailure && !lastFailure.said ? lastFailure : null;
  if (failure) log.warn(`${locate(home).label} (${failure.at}) could not keep teamai's git exclude blocks up to date: ${failure.message}`);
  for (const notice of notices) warnOnce(notice.message);
  if (failure || notices.length > 0) {
    const said = new Set(notices.map((n) => n.message));
    await updateNotices(home, (current) => ({
      lastFailure: current.lastFailure && current.lastFailure.at === failure?.at ? { ...current.lastFailure, said: true } : current.lastFailure,
      notices: current.notices.filter((n) => !said.has(n.message)),
    }));
  }
  return lastFailure !== null;
}

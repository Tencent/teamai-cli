/**
 * Attribute a session's working directory to a stable repo label, so usage can
 * be broken down per project.
 *
 * The dashboard event stream records a `cwd` and, inside git, the repo's main
 * checkout (`projectAnchor`) per event, but no git remote, so attribution here is
 * by the project folder (session-level), not the per-turn remote resolution
 * claude-cloud-sync does device-side. The
 * remote-form canonicalization below is ported from that project's repo_canon so
 * that, if a remote-qualified identity ever does show up, `github.com/o/r` and
 * `cnb.cool/o/r` collapse to the same platform-independent `owner/repo`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DashboardEvent } from '../types.js';

/** Leaf directory names that aren't projects — attributed to 'no_repo'. */
const NON_REPO_LEAVES = new Set([
  'home', 'root', 'users', 'user', 'tmp', 'workspace', 'srv', 'mnt', 'data', 'opt',
]);

/**
 * Canonicalize a *remote-form* repo identity (a git URL, `host/owner/repo`, or
 * the legacy `owner_repo` underscore form) into a platform-independent
 * `owner/repo`, dropping the host and any `.git` suffix. Returns null when no
 * owner can be derived (e.g. a bare name).
 */
export function canonicalRepo(identity: string): string | null {
  let s = identity.trim().replace(/\.git$/i, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // proto://
  s = s.replace(/^git@([^:]+):/i, '$1/'); // git@host:owner/repo → host/owner/repo
  const segs = s.split('/').filter(Boolean);
  if (segs.length >= 2) {
    return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
  }
  // Legacy owner_repo (remote '/' replaced by '_').
  const only = segs[0] ?? '';
  if (only.includes('_')) {
    const idx = only.indexOf('_');
    return `${only.slice(0, idx)}/${only.slice(idx + 1)}`;
  }
  return null;
}

/**
 * Map a session's `cwd` to a repo label:
 *  - a remote-form cwd (URL / host-qualified) → canonicalRepo (`owner/repo`)
 *  - a filesystem path → the project directory name (its basename)
 *  - home/root/ops dirs or an empty cwd → 'no_repo'
 */
export function attributeRepo(cwd: string | undefined): string {
  if (!cwd || !cwd.trim()) return 'no_repo';
  const raw = cwd.trim();

  if (/:\/\//.test(raw) || raw.startsWith('git@') || /^[^/\s]+\.[^/\s]+\//.test(raw)) {
    const c = canonicalRepo(raw);
    if (c) return c;
  }

  const segs = raw.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean);
  if (segs.length === 0) return 'no_repo';
  const leaf = segs[segs.length - 1];
  // A drive root (`C:\`) leaves the bare drive letter as the leaf; it names no
  // project, like `/` on POSIX.
  if (/^[a-z]:$/i.test(leaf)) return 'no_repo';
  if (NON_REPO_LEAVES.has(leaf.toLowerCase())) return 'no_repo';
  return leaf;
}

/**
 * The repo each session belongs to, keyed by session id: the last
 * `projectAnchor` its events recorded, else its last `cwd` (events from before
 * #809, directories outside git), else ''. Every worktree of a repo shares the
 * anchor, and a session keeps it after its worktree is removed: the events
 * written after that carry the session's last anchor (#810), or none.
 */
export function repoKeys(events: DashboardEvent[]): Map<string, string> {
  const anchors = new Map<string, string>();
  const cwds = new Map<string, string>();
  for (const e of events) {
    if (e.projectAnchor) anchors.set(e.sessionId, e.projectAnchor);
    if (e.cwd) cwds.set(e.sessionId, e.cwd);
  }
  const keys = new Map<string, string>();
  for (const e of events) keys.set(e.sessionId, anchors.get(e.sessionId) ?? cwds.get(e.sessionId) ?? '');
  return keys;
}

/**
 * The directory that names each anchor, its name, and whether it is a repo
 * (a checkout with `.git`, or a bare git directory); see {@link repoName}.
 */
const namedBy = new Map<string, { dir: string; name: string; repo: boolean }>();

function naming(anchor: string): { dir: string; name: string; repo: boolean } {
  const known = namedBy.get(anchor);
  if (known) return known;
  const checkout = existsSync(path.join(anchor, '.git'));
  // A bare git directory: the anchor of a bare repo's worktrees (`repo/.bare`, `repo.git`).
  const bare = !checkout && existsSync(path.join(anchor, 'HEAD')) && existsSync(path.join(anchor, 'objects'));
  const stem = path.basename(anchor).replace(/\.git$/, '');
  const named = !bare ? { dir: anchor, name: path.basename(anchor), repo: checkout }
    : stem && !stem.startsWith('.') ? { dir: anchor, name: stem, repo: true }
    : { dir: path.dirname(anchor), name: path.basename(path.dirname(anchor)), repo: true };
  namedBy.set(anchor, named);
  return named;
}

/**
 * The name of the repo anchored at `anchor`: its directory's name, except for
 * a bare git directory, which is named without its `.git` suffix (`repo.git`)
 * or, when that leaves a hidden or empty name, after the directory holding it
 * (`repo/.bare`, `repo/.git`). A directory that no longer exists is not bare.
 * Every answer, "not bare" included, is kept for the life of the process: labels
 * are rebuilt on each dashboard update, and a directory does not turn into a
 * bare git directory under a running process in practice.
 */
export function repoName(anchor: string): string {
  return naming(anchor).name;
}

/**
 * Display name of a repo key: its {@link attributeRepo} name ({@link repoName}
 * for a path), prefixed with the parent directory's name when another path key
 * in `allKeys` has the same name (`work/api`, `personal/api`), or the whole key
 * when that still collides, so two repos never share a label. Keys named by the
 * same directory (a bare repo's `repo/.bare` and a session in `repo/`) are one
 * repo and share a label. A remote-form key keeps its canonical `owner/repo`,
 * which it shares with the same repo on another host; a path is never
 * qualified into one of those labels (#823).
 */
export function repoLabel(key: string, allKeys: Iterable<string>): string {
  // A repo keeps its name even when it is a word attributeRepo reserves for
  // directories that are not projects (a repo in `~/workspace`).
  const nameOf = (k: string) => {
    if (path.isAbsolute(k) && naming(k).repo) return repoName(k);
    const name = attributeRepo(k);
    return name === 'no_repo' || !path.isAbsolute(k) ? name : repoName(k);
  };
  const name = nameOf(key);
  if (name === 'no_repo' || !path.isAbsolute(key)) return name;
  const dir = naming(key).dir;
  const keys = [...new Set(allKeys)];
  const others = keys.filter((k) =>
    k !== key && path.isAbsolute(k) && nameOf(k) === name && naming(k).dir !== dir);
  if (others.length === 0) return name;
  const qualified = (k: string) => `${path.basename(path.dirname(naming(k).dir))}/${nameOf(k)}`;
  const label = qualified(key);
  const remoteLabels = new Set(keys.filter((k) => !path.isAbsolute(k)).map(nameOf));
  return (others.some((k) => qualified(k) === label) || remoteLabels.has(label)) ? dir : label;
}

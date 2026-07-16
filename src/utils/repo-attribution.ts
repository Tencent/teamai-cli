/**
 * Attribute a session's working directory to a stable repo label, so usage can
 * be broken down per project.
 *
 * The dashboard event stream records a `cwd` per session but no git remote, so
 * attribution here is by the working directory's project folder (session-level),
 * not the per-turn remote resolution claude-cloud-sync does device-side. The
 * remote-form canonicalization below is ported from that project's repo_canon so
 * that, if a remote-qualified identity ever does show up, `github.com/o/r` and
 * `cnb.cool/o/r` collapse to the same platform-independent `owner/repo`.
 */

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

  if (/:\/\//.test(raw) || /^git@/.test(raw) || /^[^/\s]+\.[^/\s]+\//.test(raw)) {
    const c = canonicalRepo(raw);
    if (c) return c;
  }

  const segs = raw.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs.length === 0) return 'no_repo';
  const leaf = segs[segs.length - 1];
  if (NON_REPO_LEAVES.has(leaf.toLowerCase())) return 'no_repo';
  return leaf;
}

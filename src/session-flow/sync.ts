/**
 * sync.ts — Team session sync engine.
 *
 * Manages storage layout, indexes, and Git operations for full session IR in the team repo.
 *
 * Directory layout (team repo or reports branch):
 *
 *   sessions/
 *   ├── repos/                                ← isolated by repo identity (same as AI agent behavior)
 *   │   ├── github.com_org_payment-service/   ← canonical remote (/ → _)
 *   │   │   ├── _index.json                   ← index of every session in this repo
 *   │   │   ├── alice/                        ← one subdirectory per member
 *   │   │   │   ├── claude-code_fix-port_20260910.jsonl
 *   │   │   │   └── claude-code_fix-port_20260910.meta.json
 *   │   │   └── bob/
 *   │   │       └── ...
 *   │   └── github.com_org_infra-tools/
 *   │       └── ...
 *   └── _unattributed/                        ← sessions from a non-git directory (fallback)
 *       └── alice/
 *           └── ...
 *
 * Design constraints:
 * - repoIdentity is collected from the cwd's git remote and is immutable once canonicalized
 * - Isolation filters by repoIdentity on the way down (pull), matching AI agents isolating by cwd
 * - _index.json is per-repo; rebuild_index can rebuild it idempotently from disk
 * - Zero coupling to TeamAI projects.yaml (optional enhancement; does not block the core feature)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { getTeamaiHomeDir } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import type { Session } from './ir.js';
import { messageToDict, messageFromDict } from './ir.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utcNow(): string {
  return new Date().toISOString();
}

/**
 * Use the current git user.name or user.email as the author identifier.
 * Prefer user.name (more human-friendly), fall back to user.email, then to 'unknown'.
 */
export function getGitAuthor(cwd?: string): string {
  for (const key of ['user.name', 'user.email']) {
    try {
      const result = execFileSync('git', ['config', key], {
        cwd: cwd ?? process.cwd(),
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const val = result.trim();
      if (val) return val;
    } catch {
      // continue
    }
  }
  return 'unknown';
}

/**
 * Get the canonical git remote identity from cwd.
 *
 * Normalization rules:
 *   https://github.com/org/repo.git     → github.com/org/repo
 *   git@github.com:org/repo.git         → github.com/org/repo
 *   https://gitlab.company.com/g/repo   → gitlab.company.com/g/repo
 *
 * Returns null when the directory is not a git repo or has no remote.
 */
export function getRepoIdentity(cwd?: string): string | null {
  try {
    const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!raw) return null;
    return canonicalizeRemote(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize a git remote URL to `host/owner/repo` (no scheme, no .git suffix,
 * no credentials).
 *
 * Credentials are stripped deliberately: remotes of the form
 * `https://oauth2:TOKEN@host/org/repo.git` (CI checkouts, token-authenticated
 * clones) are common, and keeping the userinfo would write the token into
 * archive metadata, indexes and `list --all` output -- i.e. publish it to the
 * whole team.
 */
export function canonicalizeRemote(remote: string): string {
  let s = remote.trim().replace(/\.git$/i, '');
  // https://github.com/org/repo → github.com/org/repo
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Drop userinfo even when the password contains '/' (`user:pw/slash@host/…`):
  // the "no slash before @" rule below cannot match that shape, so the secret
  // survived into meta, _index.json and the SOURCE column of `list --all`.
  // Cut at the first '@' when what precedes it looks like user:password -- a
  // legitimate '@' in the path (`host/org/@scope/pkg`) has no ':' before it.
  const at = s.indexOf('@');
  if (at > 0 && s.slice(0, at).includes(':')) s = s.slice(at + 1);
  // Drop userinfo: oauth2:TOKEN@host/... and git@host (both scp and ssh:// forms).
  s = s.replace(/^[^/@]+@/, '');
  // git@github.com:org/repo → github.com/org/repo (scp-style colon separator)
  s = s.replace(/^([^/:]+):(?!\d+(?:\/|$))/, '$1/');
  // Strip a leading /
  s = s.replace(/^\/+/, '');
  // Hosts are case-insensitive: GitHub.com/Org/Repo and github.com/org/repo are
  // one repository, and two spellings would mean two archive directories and
  // two indexes for it. The path keeps its case (git paths are case-sensitive).
  const slash = s.indexOf('/');
  if (slash > 0) {
    s = s.slice(0, slash).toLowerCase() + s.slice(slash);
  } else {
    s = s.toLowerCase();
  }
  return s;
}

/**
 * Encode a canonical remote into a directory-safe string, reversibly.
 *
 * Every character outside `[A-Za-z0-9._-]` becomes `%XX` (uppercase hex), so
 * the mapping is injective: `github.com/org/a/b`, `github.com/org/a_b` and
 * `github.com/org/a:b` all get their own directory. The previous scheme folded
 * every separator onto `_`, which merged distinct repositories into one
 * archive directory and one index.
 *
 * Reversible via decodeRepoIdentity.
 */
export function encodeRepoIdentity(identity: string): string {
  // Per character: charCodeAt().toString(16) emitted %4E2D for U+4E2D (one CJK character), which the
  // 2-hex-digit decoder read back as 'N' + '2D'. encodeURIComponent gives the
  // UTF-8 bytes (%E4%B8%AD) that decodeURIComponent reverses exactly.
  let out = '';
  for (const ch of identity) {
    out += /^[A-Za-z0-9._-]$/.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}

/** Undo encodeRepoIdentity (used for display; the canonical id stays in meta). */
export function decodeRepoIdentity(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    // A malformed escape (hand-edited index, legacy '_'-folded name): fall back
    // to the raw string rather than throwing out of a listing command.
    return encoded;
  }
}

/**
 * Sanitize a path segment (git author names are free-form text and may
 * contain ':', '/', '..', trailing dots, or Windows-invalid characters).
 * Collisions are acceptable here -- the canonical identity lives in
 * meta/_index.json, not in the directory name.
 */
/** `_index.json` is the index file, not an author directory. Author names may start with `_`. */
function isIndexFileName(name: string): boolean {
  return name === '_index.json';
}

function sanitizePathSegment(name: string): string {
  const cleaned = name
    // `\` is a separator on Windows: an author name of `..\..\evil` would
    // otherwise escape the author directory when the archive is checked out
    // there (git author names are free-form).
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+$|^\.\.$/g, '_')
    .replace(/[. ]+$/g, '_')
    .trim();
  return cleaned || 'unknown';
}

/**
 * Turn a title into a filename-safe slug.
 */
function slugify(title: string, maxLength = 50): string {
  const slug = title.toLowerCase().replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength) || 'untitled';
}

/**
 * Build session_name: `{platform}_{title_slug}_{YYYYMMDD}`.
 */
export function generateSessionName(platform: string, title: string, createdAt: string): string {
  const date = createdAt.slice(0, 10).replace(/-/g, '');
  return `${platform}_${slugify(title)}_${date}`;
}

// ---------------------------------------------------------------------------
// SessionSyncMeta — meta.json data model
// ---------------------------------------------------------------------------

export interface SessionSyncMeta {
  origin: {
    platform: string;
    author: string;
    cwd: string;
    repoIdentity: string | null;
    createdAt: string;
    sessionId: string;
    /** Persisted verbatim: the file name is a lossy slug, never a title source. */
    title?: string;
  };
  migration: {
    migratedAt: string | null;
    sourcePlatform: string | null;
    targetPlatform: string | null;
    fidelityScore: number;
    degradations: string[];
  };
  sync: {
    version: number;
    pushedAt: string | null;
  };
  status: 'active' | 'archived';
}

/**
 * Build the default meta.
 *
 * @param partial Base fields
 * @param createdAt The session's native creation time (session.createdAt). When omitted, falls back to now.
 *   Callers (push / migrate --push) should always pass it; otherwise origin.createdAt records
 *   the push time instead of the session creation time and breaks search's time-decay ranking (see design doc P7).
 */
export function defaultSyncMeta(
  partial: {
    platform: string;
    author: string;
    cwd: string;
    sessionId: string;
    repoIdentity?: string | null;
    /** Persisted verbatim into origin.title (the file name slug is lossy). */
    title?: string;
  },
  createdAt?: string,
): SessionSyncMeta {
  return {
    origin: {
      platform: partial.platform,
      title: partial.title,
      author: partial.author,
      cwd: partial.cwd,
      repoIdentity: partial.repoIdentity ?? null,
      createdAt: createdAt ?? utcNow(),
      sessionId: partial.sessionId,
    },
    migration: {
      migratedAt: null,
      sourcePlatform: null,
      targetPlatform: null,
      fidelityScore: 1.0,
      degradations: [],
    },
    sync: {
      version: 1,
      pushedAt: null,
    },
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// IndexEntry
// ---------------------------------------------------------------------------

export interface IndexEntry {
  sessionName: string;
  author: string;
  platform: string;
  title: string;
  cwd: string;
  repoIdentity: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  /**
   * Source-platform session ID (origin.sessionId).
   *
   * Push dedup key (P8) = sessionId + author: pushing the same session again updates the existing entry
   * instead of resolveNameConflict creating an `xxx_1` copy. Optional: old or corrupt indexes
   * lack this field until rebuilt, and dedup then falls back to the old name-conflict behavior.
   */
  sessionId?: string;
}

interface RepoIndex {
  version: number;
  repoIdentity: string | null;
  updatedAt: string;
  sessions: IndexEntry[];
}

/** The three outcomes of `gitCommit` (committed / no changes / failed). They must not be collapsed back into null. */
export type GitCommitResult =
  | { status: 'committed'; commit: string }
  | { status: 'no-changes' }
  | { status: 'failed'; reason: string };

/**
 * The outcomes of `gitPull`. `stopped` merged nothing, so the checkout is as it was before the pull.
 * `indexes-conflicted` leaves the merge in progress with only these session indexes unmerged: the caller
 * finishes it with the self-locking `commitRebuiltIndexes`. `pending` means an earlier pull left
 * that merge: the requested pull has not run yet, so the caller pulls again once the merge is finished.
 */
export type PullResult =
  | { status: 'pulled' }
  | { status: 'indexes-conflicted'; indexes: string[]; pending?: true }
  | { status: 'stopped'; reason: string };

/** The outcomes of `gitPush`. `indexes-conflicted` is the retry's pull, left for the caller as in `PullResult`. */
export type PushResult = { status: 'pushed' } | { status: 'indexes-conflicted'; indexes: string[] };

function isSessionIndexPath(relPath: string): boolean {
  const parts = relPath.split('/');
  if (parts[0] !== 'sessions' || !isIndexFileName(parts[parts.length - 1])) return false;
  return (parts.length === 3 && parts[1] === '_unattributed') || (parts.length === 4 && parts[1] === 'repos');
}

// ---------------------------------------------------------------------------
// SyncManager
// ---------------------------------------------------------------------------

/**
 * Decode a directory name from the old encoding (`github.com_org_alpha`). Used only as a fallback when the index is missing,
 * because the old rule treated every `_` as a separator and is itself ambiguous (`a_b` and `a/b` encode the same).
 */
function decodeLegacyRepoDirName(dirName: string): string {
  return dirName.includes('%') ? decodeRepoIdentity(dirName) : dirName.replace(/_/g, '/');
}

/**
 * Refuse to write a target whose path passes through a symlink.
 *
 * Directories under `sessions/` come from the team-repo checkout. The repo contents are not controlled by this machine, and git
 * records symlinks as-is. If `sessions/repos/x` or some author directory is replaced with a link to
 * `~/.ssh`, every writeFileSync below follows the link and lands outside the repo,
 * overwriting any writable file. lstat each ancestor before writing; on a symlink, error and abort.
 */
function assertNoSymlinkedAncestors(target: string, root: string): void {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the archive root: ${target}`);
  }
  let cur = root;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(`Refusing to write through a symlinked archive path: ${cur}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
      // ENOENT: this and every deeper component does not exist yet.
      return;
    }
  }
}

// A save holds the lock for a few file writes, a rebuild for one pass over the
// archive. Ten seconds covers both without leaving a command stuck.
const INDEX_LOCK_ATTEMPTS = 100;
const INDEX_LOCK_RETRY_MS = 100;
/** A self-locking archive write either completed or timed out without mutating the archive. */
export type ArchiveWriteResult<T> =
  | { status: 'written'; value: T }
  | { status: 'busy'; lockPath: string };

/** Serialize a command's archive writes and Git publication, including pull/merge. */
export async function withSessionPublicationLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<{ status: 'done'; value: T } | { status: 'busy'; lockPath: string }> {
  const real = await fs.promises.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const key = createHash('sha256').update(real).digest('hex').slice(0, 16);
  const lockPath = path.join(getTeamaiHomeDir(), 'locks', `session-publish-${key}.lock`);
  for (let attempt = 1; !(await acquireLock(lockPath)); attempt++) {
    if (attempt === INDEX_LOCK_ATTEMPTS) return { status: 'busy', lockPath };
    await new Promise((resolve) => setTimeout(resolve, INDEX_LOCK_RETRY_MS));
  }
  try {
    return { status: 'done', value: await fn() };
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Run `fn` holding the lock on the team repo's `sessions/` archive, or report
 * who holds it. Take it around each `saveSession` (dedup lookup, name choice,
 * file writes, index upsert) and each index rebuild, so two pushes at once
 * cannot pick the same free name or drop each other's index entry.
 *
 * The lock lives under `~/.teamai/locks/`, keyed by the archive's real path,
 * not beside `_index.json`: there the commit and `pull --all`'s directory
 * renames would reach it. Public archive writes take this lock themselves.
 */
export async function withSessionIndexLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<{ status: 'done'; value: T } | { status: 'busy'; lockPath: string }> {
  const real = await fs.promises.realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const key = createHash('sha256').update(path.join(real, 'sessions')).digest('hex').slice(0, 16);
  const lockPath = path.join(getTeamaiHomeDir(), 'locks', `sessions-${key}.lock`);
  for (let attempt = 1; !(await acquireLock(lockPath)); attempt++) {
    if (attempt === INDEX_LOCK_ATTEMPTS) return { status: 'busy', lockPath };
    await new Promise((resolve) => setTimeout(resolve, INDEX_LOCK_RETRY_MS));
  }
  try {
    return { status: 'done', value: await fn() };
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Manages full session storage under the team repo's `sessions/` directory.
 *
 * Matches AI agent behavior:
 * - Sessions from the same git repo (remote) are grouped together
 * - Sessions from different repos are isolated by default
 * - pull only fetches the repo subdirectory that matches the current cwd
 */
export class SyncManager {
  private async writeArchive<T>(fn: () => T): Promise<ArchiveWriteResult<T>> {
    const result = await withSessionIndexLock(this.repoRoot, async () => fn());
    return result.status === 'busy' ? result : { status: 'written', value: result.value };
  }

  /** Save through the archive lock, including deduplication and index repair. */
  saveSession(session: Session, meta: SessionSyncMeta): Promise<ArchiveWriteResult<string>> {
    return this.writeArchive(() => this.saveSessionLocked(session, meta));
  }

  rebuildIndex(repoIdentity: string | null, dirOverride?: string): Promise<ArchiveWriteResult<number>> {
    return this.writeArchive(() => this.rebuildIndexLocked(repoIdentity, dirOverride));
  }

  rebuildAllIndexes(): Promise<ArchiveWriteResult<{ repos: number; sessions: number }>> {
    return this.writeArchive(() => this.rebuildAllIndexesLocked());
  }

  commitRebuiltIndexes(indexes: string[]): Promise<ArchiveWriteResult<void>> {
    return this.writeArchive(() => this.commitRebuiltIndexesLocked(indexes));
  }

  deleteSession(repoIdentity: string | null, sessionName: string, author?: string): Promise<ArchiveWriteResult<void>> {
    return this.writeArchive(() => this.deleteSessionLocked(repoIdentity, sessionName, author));
  }
  private readonly sessionsDir: string;
  /**
   * Archive files this process has written (relative to repoRoot).
   *
   * `gitCommit` only `git add`s these paths. Previously it was `git add sessions/`, which also committed
   * other pre-existing changes under `sessions/` (including deletions).
   */
  private readonly writtenPaths = new Set<string>();

  constructor(private readonly repoRoot: string) {
    this.sessionsDir = path.join(repoRoot, 'sessions');
  }

  /** The archive files this manager wrote, relative to the repo root: what `gitCommit` stages. */
  writtenFiles(): string[] {
    return [...this.writtenPaths];
  }

  /** Record the write path, and confirm there is no symlink hijack before writing. */
  private guardWrite(target: string): void {
    assertNoSymlinkedAncestors(target, this.repoRoot);
    this.writtenPaths.add(path.relative(this.repoRoot, target).split(path.sep).join('/'));
  }

  // ------------------------------------------------------------------
  // Path resolution
  // ------------------------------------------------------------------

  /** Repo subdirectory path. null identity → _unattributed */
  private repoDir(repoIdentity: string | null): string {
    if (!repoIdentity) {
      return path.join(this.sessionsDir, '_unattributed');
    }
    return path.join(this.sessionsDir, 'repos', encodeRepoIdentity(repoIdentity));
  }

  private indexPath(repoIdentity: string | null): string {
    return path.join(this.repoDir(repoIdentity), '_index.json');
  }

  private authorDir(repoIdentity: string | null, author: string): string {
    return path.join(this.repoDir(repoIdentity), sanitizePathSegment(author));
  }

  private sessionPaths(repoIdentity: string | null, author: string, sessionName: string) {
    const dir = this.authorDir(repoIdentity, author);
    return {
      jsonl: path.join(dir, `${sessionName}.jsonl`),
      meta: path.join(dir, `${sessionName}.meta.json`),
    };
  }

  // ------------------------------------------------------------------
  // Index operations
  // ------------------------------------------------------------------

  private readIndex(repoIdentity: string | null): RepoIndex {
    return this.readIndexFile(this.indexPath(repoIdentity), repoIdentity);
  }

  private readIndexFile(p: string, repoIdentity: string | null): RepoIndex {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as RepoIndex;
      }
    } catch {
      // A silent rebuild of a corrupt index (parse failure) drops the dedup key, so pushing the same session again
      // creates an _1 copy with no signal to the user. At least say so, and give the recovery command.
      console.warn(`Warning: corrupted session index at ${p}, treating as empty.`);
      console.warn(`Run 'teamai session pull --all --repo-root <repo>' to rebuild indexes.`);
    }
    return { version: 1, repoIdentity, updatedAt: utcNow(), sessions: [] };
  }

  /**
   * `dirOverride` writes the index into an explicit directory (a legacy
   * `_`-folded one) instead of the directory encoded from `repoIdentity` --
   * otherwise rebuilding an old directory would write its index into the new
   * name and leave the old one unindexed forever.
   */
  private writeIndex(repoIdentity: string | null, index: RepoIndex, dirOverride?: string): void {
    const dir = dirOverride ?? this.repoDir(repoIdentity);
    // Guard before mkdir: `mkdir -p` through a symlinked ancestor would create
    // the directory outside the archive first, and the guard after it would
    // then be checking a path that already exists on the wrong side.
    this.guardWrite(path.join(dir, '_index.json'));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, '_index.json');
    // Same sessions → leave the file byte-identical. A fresh updatedAt on every
    // `session pull` kept the team checkout modified, and the next pull that
    // brought index changes then refused to merge.
    try {
      const previous = fs.readFileSync(target, 'utf-8');
      const updatedAt = (JSON.parse(previous) as RepoIndex).updatedAt;
      if (JSON.stringify({ ...index, updatedAt }, null, 2) === previous) return;
    } catch {
      // No index yet, or a corrupt one: write it.
    }
    index.updatedAt = utcNow();
    // Atomic write: land a temp file, then rename. A direct writeFileSync lets two concurrent pushes
    // truncate each other and leave a partial (or empty) _index.json, which makes every session in the repo
    // look like it vanished. rename is atomic on the same filesystem, so readers see either the old value or the new one.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  /**
   * Index read used only on the write path: if the index is corrupt, rebuild from disk first; if that fails, throw.
   *
   * readIndex() returns an empty array on parse failure, and upsert then overwrites the file with "just this 1 entry",
   * so every other session in that repo disappears from the index (easiest to trigger when a concurrent push left conflict markers).
   * The session files themselves are still there, so a rebuild can recover them. If it cannot, the problem is larger; abort instead.
   */
  private readIndexForWrite(repoIdentity: string | null): RepoIndex {
    const p = this.indexPath(repoIdentity);
    if (!fs.existsSync(p)) {
      // A missing index with session files already on disk is the same hole as
      // a corrupt one: dedup would miss and the new index would contain only
      // the session being pushed. Rebuild first when the directory exists.
      const dir = this.repoDir(repoIdentity);
      if (fs.existsSync(dir)) {
        this.rebuildIndexLocked(repoIdentity);
        if (fs.existsSync(p)) {
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as RepoIndex;
        }
      }
      return { version: 1, repoIdentity, updatedAt: utcNow(), sessions: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as RepoIndex;
    } catch {
      this.rebuildIndexLocked(repoIdentity);
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as RepoIndex;
      } catch {
        throw new Error(
          `corrupted session index at ${p}; run 'teamai session pull --all --repo-root <repo-root>' to rebuild it`,
        );
      }
    }
  }

  private upsertIndexEntry(repoIdentity: string | null, entry: IndexEntry, index: RepoIndex): void {
    const key = `${entry.sessionName}:${entry.author}`;
    const idx = index.sessions.findIndex((s) => `${s.sessionName}:${s.author}` === key);
    if (idx >= 0) {
      index.sessions[idx] = entry;
    } else {
      index.sessions.push(entry);
    }
    this.writeIndex(repoIdentity, index);
  }

  private removeIndexEntry(repoIdentity: string | null, sessionName: string, author: string): void {
    // Same reasoning as upsert: a corrupted index must not be overwritten with
    // a filtered copy of "nothing".
    const index = this.readIndexForWrite(repoIdentity);
    index.sessions = index.sessions.filter(
      (s) => !(s.sessionName === sessionName && s.author === author),
    );
    this.writeIndex(repoIdentity, index);
  }

  // ------------------------------------------------------------------
  // Name-conflict handling
  // ------------------------------------------------------------------

  private resolveNameConflict(repoIdentity: string | null, author: string, baseName: string): string {
    const { jsonl } = this.sessionPaths(repoIdentity, author, baseName);
    if (!fs.existsSync(jsonl)) return baseName;
    for (let i = 1; ; i++) {
      const candidate = `${baseName}_${i}`;
      const { jsonl: cJsonl } = this.sessionPaths(repoIdentity, author, candidate);
      if (!fs.existsSync(cJsonl)) return candidate;
    }
  }

  // ------------------------------------------------------------------
  // Save / load
  // ------------------------------------------------------------------

  /**
   * Look up an existing entry in the repo index by source-platform sessionId (and optional author).
   *
   * Push dedup key (P8): origin.sessionId + author. A hit means this session was pushed before
   * and the existing entry and files should be updated, not written again as an `_1` copy.
   */
  private findByOriginSessionId(
    repoIdentity: string | null,
    sessionId: string,
    author?: string,
    platform?: string,
  ): IndexEntry | undefined {
    // Strict read: a corrupted index would come back empty here, so the dedup
    // lookup misses and the session is written as an extra `_1` copy before
    // the upsert repairs the index. Repair first, then look.
    const index = this.readIndexForWrite(repoIdentity);
    return index.sessions.find(
      (s) =>
        s.sessionId === sessionId &&
        (!author || s.author === author) &&
        // platform is part of the dedup key: the same sessionId migrated to a different platform is a different archive
        // (each has its own meta.platform) and must not replace the other. Otherwise pushing codebuddy first
        // and then migrate --push to claude-code would overwrite the earlier archive.
        (!platform || s.platform === platform),
    );
  }

  /**
   * The archived copy of source session `origin`, pushed by any author, or undefined. Reads the index as it is and
   * never repairs it, so a lookup writes nothing; when several authors pushed the session, the latest update wins.
   */
  findArchived(repoIdentity: string | null, origin: { platform: string; sessionId: string }): IndexEntry | undefined {
    return this.readIndex(repoIdentity).sessions
      .filter((s) => s.sessionId === origin.sessionId && s.platform === origin.platform)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.author.localeCompare(b.author))[0];
  }

  /**
   * Save a session into the team repo.
   *
   * @param session IR Session
   * @param meta Sync metadata
   * @returns Path of the written jsonl file (relative to repoRoot)
   */
  private saveSessionLocked(session: Session, meta: SessionSyncMeta): string {
    const repoId = meta.origin.repoIdentity;
    const author = meta.origin.author;

    let sessionName = generateSessionName(session.platform, session.title, session.createdAt);
    // P8 dedup: when the same origin.sessionId + author is pushed again, reuse the original sessionName
    // and overwrite (upsertIndexEntry updates the existing entry in place on sessionName:author),
    // instead of resolveNameConflict creating an `xxx_1` copy.
    const existing = this.findByOriginSessionId(repoId, meta.origin.sessionId, author, session.platform);
    if (existing) {
      sessionName = existing.sessionName;
    } else {
      sessionName = this.resolveNameConflict(repoId, author, sessionName);
    }

    const paths = this.sessionPaths(repoId, author, sessionName);
    this.guardWrite(paths.jsonl);
    this.guardWrite(paths.meta);

    // Resolve/repair the index before installing the pair: a rebuild must
    // never adopt half of this transaction as an existing archive.
    const index = this.readIndexForWrite(repoId);
    fs.mkdirSync(path.dirname(paths.jsonl), { recursive: true });
    meta.sync.pushedAt = utcNow();
    const token = randomUUID();
    const files = [
      { file: paths.jsonl, content: session.messages.map((m) => JSON.stringify(messageToDict(m))).join('\n') + '\n' },
      { file: paths.meta, content: JSON.stringify(meta, null, 2) },
    ].map((file) => ({ ...file, temp: `${file.file}.${token}.tmp`, backup: `${file.file}.${token}.bak`, backedUp: false, installed: false }));
    let committed = false;
    try {
      for (const file of files) fs.writeFileSync(file.temp, file.content, { encoding: 'utf-8', flag: 'wx' });
      for (const file of files) {
        if (fs.existsSync(file.file)) {
          fs.renameSync(file.file, file.backup);
          file.backedUp = true;
        }
        fs.renameSync(file.temp, file.file);
        file.installed = true;
      }
      this.upsertIndexEntry(repoId, {
        sessionName,
        author,
        platform: session.platform,
        title: session.title,
        cwd: session.cwd,
        repoIdentity: repoId,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: meta.status,
        sessionId: meta.origin.sessionId,
      }, index);
      committed = true;
    } catch (error) {
      const failures: unknown[] = [];
      for (const file of [...files].reverse()) {
        try {
          if (file.installed) fs.unlinkSync(file.file);
          if (file.backedUp) fs.renameSync(file.backup, file.file);
        } catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], `Session archive rollback failed; original files kept at ${files.filter((f) => f.backedUp).map((f) => f.backup).join(', ')}`);
      }
      throw error;
    } finally {
      for (const file of files) {
        try { fs.unlinkSync(file.temp); } catch { /* already installed, or staging failed */ }
        // Never delete a backup whose rollback failed.
        if (committed) try { fs.unlinkSync(file.backup); } catch { /* absent or kept for recovery */ }
      }
    }

    return path.relative(this.repoRoot, paths.jsonl);
  }

  /**
   * Load a session from the team repo.
   */
  loadSession(
    repoIdentity: string | null,
    sessionName: string,
    author?: string,
  ): { session: Session; meta: SessionSyncMeta } {
    // The name reaches the filesystem: reject anything that is not a plain
    // file name, so `--session ../../x` cannot read outside the archive.
    if (sessionName !== path.basename(sessionName) || /^\.\.?$/.test(sessionName)) {
      throw new Error(`Invalid session name: ${sessionName}`);
    }
    const resolvedAuthor = author ?? this.findAuthor(repoIdentity, sessionName);
    const paths = this.sessionPaths(repoIdentity, resolvedAuthor, sessionName);

    if (!fs.existsSync(paths.jsonl)) {
      throw new Error(`Session file not found: ${paths.jsonl}`);
    }
    if (!fs.existsSync(paths.meta)) {
      throw new Error(`Meta file not found: ${paths.meta}`);
    }

    // Read meta
    const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf-8')) as SessionSyncMeta;

    // Read JSONL → rebuild Session
    const content = fs.readFileSync(paths.jsonl, 'utf-8');
    const messages = content
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => messageFromDict(JSON.parse(l) as Record<string, unknown>));

    // Extract the title from meta + sessionName
    // Prefer the persisted title; the file name slug is truncated + lowercased
    // and would otherwise rewrite every restored session's title.
    const title = meta.origin.title || this.extractTitleFromSessionName(sessionName);

    const session: Session = {
      sessionId: meta.origin.sessionId,
      title,
      cwd: meta.origin.cwd,
      platform: meta.origin.platform,
      createdAt: meta.origin.createdAt,
      updatedAt: utcNow(),
      messages,
      metadata: {
        originator: meta.migration.sourcePlatform ?? undefined,
        // Archive content is untrusted input: image blocks may carry absolute
        // `filePath` values planted by whoever pushed the archive. Adapters
        // must never read a local file for an untrusted session (see
        // mayReadLocalImageFile) or a crafted archive could pull ~/.ssh keys
        // into the restored session.
        untrusted: true,
      },
    };

    return { session, meta };
  }

  /** Search the repo directory for which author owns sessionName */
  private findAuthor(repoIdentity: string | null, sessionName: string): string {
    const dir = this.repoDir(repoIdentity);
    if (!fs.existsSync(dir)) throw new Error(`Repo directory not found: ${dir}`);
    const matches: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (isIndexFileName(entry)) continue;
      const candidate = path.join(dir, entry);
      // Skip symlinked author dirs: they come from the team repo checkout and
      // would make "which author owns this session" resolve outside the archive.
      let st: fs.Stats;
      try {
        st = fs.lstatSync(candidate);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (fs.existsSync(path.join(candidate, `${sessionName}.jsonl`))) {
        matches.push(entry);
      }
    }
    if (matches.length === 0) {
      throw new Error(`Session ${sessionName} not found (searched all author directories)`);
    }
    // Ambiguous: picking the first match silently restores/resumes the wrong
    // author's session. Make the caller disambiguate with --author.
    if (matches.length > 1) {
      throw new Error(
        `Session ${sessionName} is ambiguous (authors: ${matches.join(', ')}). Re-run with --author <name>.`,
      );
    }
    return matches[0];
  }

  private extractTitleFromSessionName(sessionName: string): string {
    // Format: {platform}_{title_slug}_{YYYYMMDD}
    const parts = sessionName.split('_');
    if (parts.length >= 3) {
      // Drop the first segment (platform) and the last segment (date)
      return parts.slice(1, -1).join('_').replace(/-/g, ' ');
    }
    return sessionName;
  }

  // ------------------------------------------------------------------
  // List / delete
  // ------------------------------------------------------------------

  /**
   * List sessions under the given repo.
   * repoIdentity=null → _unattributed.
   * author is an optional filter.
   */
  listSessions(repoIdentity: string | null, author?: string): IndexEntry[] {
    const index = this.readIndex(repoIdentity);
    let sessions = index.sessions;
    if (author) {
      sessions = sessions.filter((s) => s.author === author);
    }
    return sessions;
  }

  /** Every session the archive indexes, under every repo and unattributed. Reads the indexes as they are. */
  listAllSessions(): IndexEntry[] {
    const dirs = [this.repoDir(null), ...this.listRepos().map((dir) => path.join(this.sessionsDir, 'repos', dir))];
    return dirs.flatMap((dir) => this.readIndexFile(path.join(dir, '_index.json'), null).sessions);
  }

  /**
   * List repoIdentity for every repo.
   */
  listRepos(): string[] {
    const reposDir = path.join(this.sessionsDir, 'repos');
    if (!fs.existsSync(reposDir)) return [];
    return fs.readdirSync(reposDir).filter((d) => {
      return fs.statSync(path.join(reposDir, d)).isDirectory();
    });
  }

  /**
   * List the canonical identity of **every** repo in the team repo (including `_unattributed` → null).
   *
   * Directory names are encoded (`/` → `_`) and decoding is lossy, so they cannot be reversed to the canonical string.
   * Each repo directory's `_index.json` stores RepoIndex.repoIdentity (the canonical string);
   * look it up from the index. Skip directories that are corrupt, have no index, or have no identity.
   *
   * `_unattributed` is also returned as null when its `_index.json` exists or the directory contains session files.
   */
  listAllRepoIdentities(): Array<string | null> {
    const identities: Array<string | null> = [];
    const reposDir = path.join(this.sessionsDir, 'repos');
    if (fs.existsSync(reposDir)) {
      for (const dir of fs.readdirSync(reposDir)) {
        const full = path.join(reposDir, dir);
        try {
          if (!fs.statSync(full).isDirectory()) continue;
          const idxPath = path.join(full, '_index.json');
          if (!fs.existsSync(idxPath)) continue;
          const index = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as RepoIndex;
          if (index.repoIdentity) identities.push(index.repoIdentity);
        } catch {
          // corrupted index / unreadable directory → skip
        }
      }
    }

    // _unattributed: include it when the index exists, or when the directory has session content (author subdirectories)
    const unattrDir = path.join(this.sessionsDir, '_unattributed');
    if (fs.existsSync(unattrDir)) {
      let hasContent = fs.existsSync(path.join(unattrDir, '_index.json'));
      if (!hasContent) {
        try {
          hasContent = fs.readdirSync(unattrDir).some((e) => {
            if (isIndexFileName(e)) return false;
            try {
              return fs.statSync(path.join(unattrDir, e)).isDirectory();
            } catch {
              return false;
            }
          });
        } catch {
          hasContent = false;
        }
      }
      if (hasContent) identities.push(null);
    }

    return identities;
  }

  private deleteSessionLocked(repoIdentity: string | null, sessionName: string, author?: string): void {
    const resolvedAuthor = author ?? this.findAuthor(repoIdentity, sessionName);
    const paths = this.sessionPaths(repoIdentity, resolvedAuthor, sessionName);
    // Same symlink guard as writes: deleting through a checkout-controlled
    // symlink would remove files outside the repository.
    assertNoSymlinkedAncestors(paths.jsonl, this.repoRoot);

    if (fs.existsSync(paths.jsonl)) fs.unlinkSync(paths.jsonl);
    if (fs.existsSync(paths.meta)) fs.unlinkSync(paths.meta);

    this.removeIndexEntry(repoIdentity, sessionName, resolvedAuthor);
  }

  // ------------------------------------------------------------------
  // Index rebuild
  // ------------------------------------------------------------------

  /**
   * Scan the repo directory and rebuild _index.json idempotently.
   *
   * `dirOverride` points at the actual directory (fallback rebuild for an old-encoding directory name).
   */
  private rebuildIndexLocked(repoIdentity: string | null, dirOverride?: string): number {
    const dir = dirOverride ?? this.repoDir(repoIdentity);
    if (!fs.existsSync(dir)) return 0;

    const entries: IndexEntry[] = [];

    for (const authorName of fs.readdirSync(dir)) {
      if (isIndexFileName(authorName)) continue;
      const authorDir = path.join(dir, authorName);
      const authorSt = fs.lstatSync(authorDir);
      if (!authorSt.isDirectory() || authorSt.isSymbolicLink()) continue;

      for (const file of fs.readdirSync(authorDir)) {
        if (!file.endsWith('.meta.json')) continue;
        const sessionName = file.replace('.meta.json', '');
        const metaPath = path.join(authorDir, file);
        const jsonlPath = path.join(authorDir, `${sessionName}.jsonl`);

        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionSyncMeta;
          const msgCount = fs.existsSync(jsonlPath)
            ? fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter((l) => l.trim()).length
            : 0;

          entries.push({
            sessionName,
            // The directory name is the sanitized author (`a:b` → `a_b`); the
            // canonical identity lives in meta. Rebuilding from the directory
            // name silently rewrote every author and broke --author filtering.
            author: meta.origin.author || authorName,
            platform: meta.origin.platform,
            // Same for the title: the file name is a truncated, lowercased slug.
            title: meta.origin.title || this.extractTitleFromSessionName(sessionName),
            cwd: meta.origin.cwd,
            repoIdentity: meta.origin.repoIdentity,
            messageCount: msgCount,
            createdAt: meta.origin.createdAt,
            updatedAt: meta.sync.pushedAt ?? meta.origin.createdAt,
            status: meta.status,
            sessionId: meta.origin.sessionId,
          });
        } catch {
          // skip corrupted entries
        }
      }
    }

    // Push records the session's own updatedAt, which meta does not keep, and
    // appends in push order. Keep both from the current index so rebuilding an
    // unchanged archive reproduces the committed index instead of modifying it.
    const key = (e: IndexEntry) => `${e.sessionName}:${e.author}`;
    let known: IndexEntry[] = [];
    try {
      const sessions = (JSON.parse(fs.readFileSync(path.join(dir, '_index.json'), 'utf-8')) as RepoIndex).sessions;
      if (Array.isArray(sessions)) known = sessions;
    } catch {
      // No index yet, or a corrupt one: rebuild from disk alone.
    }
    const knownAt = new Map(known.map((e, i) => [key(e), { i, updatedAt: e.updatedAt }]));
    for (const e of entries) e.updatedAt = knownAt.get(key(e))?.updatedAt ?? e.updatedAt;
    const rank = (e: IndexEntry) => knownAt.get(key(e))?.i ?? known.length;
    entries.sort((a, b) => rank(a) - rank(b));

    this.writeIndex(
      repoIdentity,
      {
        version: 1,
        repoIdentity,
        updatedAt: utcNow(),
        sessions: entries,
      },
      dirOverride,
    );

    return entries.length;
  }

  /**
   * Rebuild the index of **every** repo directory in the team repo, including directories whose index is missing or corrupt.
   *
   * listAllRepoIdentities() depends on `_index.json` to recover the canonical identity,
   * so a repo with no index is skipped outright — and those are exactly the ones `pull --all` most needs to repair.
   * So walk by directory: prefer the identity stored in the index, and if it is missing, fall back to decoding the directory name.
   */
  private rebuildAllIndexesLocked(): { repos: number; sessions: number } {
    /** identity → actual directory (old-encoding directory names differ from the new encoding, so the directory must travel with the identity). */
    const targets: Array<{ identity: string | null; dir?: string }> = [];
    const seen = new Set<string>();

    const reposDir = path.join(this.sessionsDir, 'repos');
    if (fs.existsSync(reposDir)) {
      for (const dir of fs.readdirSync(reposDir)) {
        const full = path.join(reposDir, dir);
        try {
          if (!fs.lstatSync(full).isDirectory()) continue;
        } catch {
          continue;
        }
        const identity = this.identityOfRepoDir(full) ?? decodeLegacyRepoDirName(dir);
        const key = identity ?? '\u0000_unattributed';
        if (seen.has(key)) continue;
        seen.add(key);
        // A legacy `_`-folded directory decodes to the canonical identity, but
        // every read path resolves the *encoded* name -- so a rebuilt index
        // under the old name would still list nothing. Move the directory to
        // the encoded name once, then both sides agree.
        let dirForIdentity = full;
        if (identity) {
          const expected = path.join(reposDir, encodeRepoIdentity(identity));
          if (expected !== full) {
            if (fs.existsSync(expected)) {
              console.warn(
                `Warning: ${path.basename(full)} and ${path.basename(expected)} both hold ${identity}; keeping ${path.basename(expected)} and leaving ${path.basename(full)} in place.`,
              );
            } else {
              try {
                fs.renameSync(full, expected);
                dirForIdentity = expected;
              } catch (err) {
                console.warn(
                  `Warning: could not rename legacy archive directory ${path.basename(full)}: ${(err as Error).message}`,
                );
              }
            }
          }
        }
        targets.push({ identity, dir: dirForIdentity });
      }
    }

    const unattrDir = path.join(this.sessionsDir, '_unattributed');
    if (fs.existsSync(unattrDir) && !seen.has('\u0000_unattributed')) targets.push({ identity: null });

    let sessions = 0;
    for (const t of targets) {
      sessions += this.rebuildIndexLocked(t.identity, t.dir);
    }
    return { repos: targets.length, sessions };
  }

  /** Canonical identity stored in the directory's index; returns null when there is no index or it is corrupt. */
  private identityOfRepoDir(dir: string): string | null {
    try {
      const idxPath = path.join(dir, '_index.json');
      if (!fs.existsSync(idxPath)) return null;
      const index = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as RepoIndex;
      return index.repoIdentity ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Git operations
  // ------------------------------------------------------------------

  private runGit(args: string[], check = true): string {
    try {
      return execFileSync('git', args, {
        cwd: this.repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Untranslated, so the CLI's English output can quote git's reason.
        env: { ...process.env, LANGUAGE: 'en' },
      }).trim();
    } catch (e) {
      if (check) throw e;
      return '';
    }
  }

  /**
   * Commit the archive files written in this run.
   *
   * The three outcomes must stay distinct: committed / no changes / commit failed. Previously all three returned null,
   * so a gpg signing failure, a rejected pre-commit hook, and a missing git identity were all treated as
   * "nothing to commit". The UI then showed only a harmless "No changes to push",
   * while the archive files were still sitting in the index with nobody to commit them.
   */
  gitCommit(message: string): GitCommitResult {
    const paths = [...this.writtenPaths];
    // When this run wrote no paths, fall back to a directory-level add (for example a commit after an index rebuild),
    // but still only operate inside sessions/.
    const addArgs = paths.length > 0 ? ['add', '--', ...paths] : ['add', 'sessions/'];
    this.runGit(addArgs);

    const scopeArgs = paths.length > 0 ? ['--', ...paths] : ['--', 'sessions/'];
    const staged = this.runGit(['status', '--porcelain', ...scopeArgs], false);
    if (!staged.trim()) return { status: 'no-changes' };

    // Only ever commit the archive paths: `git commit -m` without a pathspec
    // would also commit whatever else the user happened to have staged.
    try {
      this.runGit(['commit', '-m', message, ...scopeArgs], true);
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { status: 'failed', reason };
    }
    return { status: 'committed', commit: this.runGit(['rev-parse', 'HEAD']) };
  }

  gitPush(remote = 'origin', branch?: string): PushResult {
    const ref = branch?.trim() || this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!ref || ref === 'HEAD') {
      throw new Error('Refusing to push without an explicit branch refspec.');
    }
    // Errors must reach the caller: swallowing them here let `push` print
    // "✓ Pushed" after a rejected or unreachable remote.
    try {
      this.runGit(['push', remote, ref]);
      return { status: 'pushed' };
    } catch (err) {
      if (!this.isBehindRemote(remote, ref)) throw err;
    }
    const pulled = this.gitPull(remote, ref);
    if (pulled.status === 'stopped') throw new Error(pulled.reason);
    if (pulled.status === 'indexes-conflicted') return pulled;
    this.runGit(['push', remote, ref]);
    return { status: 'pushed' };
  }

  /** Asked of git: a push fails for many reasons, and a pull fixes only this one. */
  private isBehindRemote(remote: string, ref: string): boolean {
    try {
      this.runGit(['fetch', remote, ref]);
    } catch {
      return false;
    }
    try {
      this.runGit(['merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD']);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Pull and merge. Two machines that archive sessions for the same repo both append to its `_index.json`,
   * so their pulls conflict there. The index is derived from the session files, so those conflicts are
   * resolved by a rebuild, which this leaves to the caller: the rebuild takes the session index lock, and
   * the network pull must not. A conflict in any other file aborts the merge and is returned to the caller.
   */
  gitPull(remote = 'origin', branch?: string): PullResult {
    if (this.gitPathExists('rebase-merge') || this.gitPathExists('rebase-apply')) {
      return { status: 'stopped', reason: `A rebase is in progress in ${this.repoRoot}. Run \`git rebase --abort\` there, then retry.` };
    }
    const unmerged = this.unmergedPaths();
    // An older teamai or a manual `git pull` can leave the checkout mid-merge on an index conflict; finish that merge the same way.
    if (this.gitPathExists('MERGE_HEAD')) {
      if (unmerged.length === 0) {
        return {
          status: 'stopped',
          reason: `A merge is in progress in ${this.repoRoot}. Run \`git commit\` or \`git merge --abort\` there, then retry.`,
        };
      }
      const others = unmerged.filter((f) => !isSessionIndexPath(f));
      if (others.length > 0) {
        // Without an index left to rebuild, teamai has nothing to finish once the user adds the files.
        const next =
          others.length < unmerged.length
            ? 'Resolve and `git add` them, or run `git merge --abort`, then run `teamai session pull`'
            : 'Resolve and `git add` them and run `git commit`, or run `git merge --abort`, then retry';
        return { status: 'stopped', reason: `A merge is in progress in ${this.repoRoot} with conflicts in ${others.join(', ')}. ${next}.` };
      }
      return { status: 'indexes-conflicted', indexes: unmerged, pending: true };
    }
    if (unmerged.length > 0) {
      return {
        status: 'stopped',
        reason: `Unmerged files in ${this.repoRoot} block the pull: ${unmerged.join(', ')}. Finish or abort the git operation that left them, then retry.`,
      };
    }
    const ref = branch?.trim() || this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!ref || ref === 'HEAD') {
      throw new Error('Refusing to pull without an explicit branch refspec.');
    }
    // Explicit flags: with pull.rebase unset git refuses any divergence, with it set a conflict stops
    // mid-rebase on a detached HEAD, and an autostash reapplied after the merge commit can conflict unseen.
    // The autostash is turned off through config (both keys) because `git pull --no-autostash` needs git 2.27.
    try {
      this.runGit(['-c', 'merge.autostash=false', '-c', 'pull.autostash=false', 'pull', '--no-rebase', '--ff', '--no-edit', remote, ref]);
      return { status: 'pulled' };
    } catch (err) {
      const files = this.unmergedPaths();
      if (files.length === 0) throw err;
      const others = files.filter((f) => !isSessionIndexPath(f));
      if (others.length === 0) return { status: 'indexes-conflicted', indexes: files };
      this.runGit(['merge', '--abort']);
      const next =
        others.length < files.length
          ? 'then run `teamai session pull` to rebuild the session indexes and finish the merge'
          : 'run `git commit`, then retry';
      return {
        status: 'stopped',
        reason: `Pull stopped on conflicts in ${others.join(', ')} and was aborted. Run \`git pull --no-rebase\` in ${this.repoRoot}, resolve and \`git add\` those files, ${next}.`,
      };
    }
  }

  /** Finish a merge `gitPull` left on `indexes-conflicted`: rebuild those indexes from the session files and commit. */
  private commitRebuiltIndexesLocked(indexes: string[]): void {
    for (const index of indexes) {
      this.rebuildIndexLocked(this.conflictedIndexIdentity(index), path.join(this.repoRoot, path.dirname(index)));
      this.runGit(['add', '--', index]);
    }
    this.runGit(['commit', '--no-edit']);
  }

  /** The identity either side recorded; a legacy `_`-folded directory name cannot be decoded back to it. */
  private conflictedIndexIdentity(index: string): string | null {
    for (const stage of [2, 3]) {
      try {
        const { repoIdentity } = JSON.parse(this.runGit(['show', `:${stage}:./${index}`])) as { repoIdentity?: unknown };
        if (typeof repoIdentity === 'string' && repoIdentity) return repoIdentity;
      } catch {
        // that side deleted the index or left it unparsable
      }
    }
    const parts = index.split('/');
    return parts[1] === '_unattributed' ? null : decodeLegacyRepoDirName(parts[2]);
  }

  private gitPathExists(name: string): boolean {
    return fs.existsSync(path.resolve(this.repoRoot, this.runGit(['rev-parse', '--git-path', name])));
  }

  /** Unmerged paths relative to repoRoot (git reports them from the top of the work tree). */
  private unmergedPaths(): string[] {
    const files = this.runGit(['diff', '--name-only', '-z', '--diff-filter=U']).split('\0').filter(Boolean);
    if (files.length === 0) return [];
    const prefix = this.runGit(['rev-parse', '--show-prefix']);
    return files.map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : path.posix.relative(prefix, f)));
  }

  getSyncStatus(): { uncommitted: number; ahead: number; behind: number } {
    const status = this.runGit(['status', '--porcelain'], false);
    const uncommitted = status ? status.split('\n').filter((l) => l.trim()).length : 0;

    let ahead = 0;
    let behind = 0;
    const revResult = this.runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], false);
    if (revResult) {
      const parts = revResult.split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    }

    return { uncommitted, ahead, behind };
  }
}

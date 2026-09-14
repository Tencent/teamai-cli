import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { getUserHome } from './home.js';
import { readFileSafe, writeFileAtomic, expandHome } from './fs.js';

/**
 * Per-project data partition identity (issue #374 P1).
 *
 * teamai keys a project's machine-local data by the SHARED `projectAnchor` (the
 * main checkout, so every linked worktree resolves to the same partition), NOT
 * the per-worktree workspace root. The partition lives at
 * `~/.teamai/projects/<slug>/`, entirely outside the business workspace.
 *
 * slug(anchor) = <safe-path>-<sha256(normalized anchor) first 16 hex>
 *
 * The prefix is the WHOLE anchor path made filesystem-safe (leading separator
 * dropped, path separators → `-`), so the directory name reads back to the
 * project it belongs to — mirroring how Claude Code names `~/.claude/projects/`.
 * It is a human-readable convenience only; the trailing hash is what guarantees
 * uniqueness. A raw path escape alone is NOT injective (`/x/my-proj` and
 * `/x/my/proj` would collide after `/`→`-`), so the sha256 suffix breaks any
 * such collision. The prefix is length-bounded (the hash still disambiguates
 * when two long paths share a truncated head), and the authoritative reverse
 * lookup remains the `anchor` file, not the (lossy, one-way) directory name.
 *
 * Partitions written before #546 used the `<safe-basename>-<hash>` format; the
 * hash is unchanged, so those are adopted in place (renamed to the current
 * name) by `resolvePartitionDir` and still recognized by `status --all` via
 * `legacyProjectSlug` — no data is stranded by the widening.
 */

let caseInsensitiveCache = new Map<string, boolean>();

/**
 * Detect at runtime whether the filesystem holding `probeDir` is case-insensitive
 * (macOS APFS/HFS+ default, Windows NTFS) vs case-sensitive (Linux ext4).
 *
 * We must probe the volume that holds the ANCHOR, not `~/.teamai`: HOME and the
 * project can live on different volumes with different case sensitivity (e.g.
 * HOME on a case-insensitive APFS, the project on a case-sensitive volume). If
 * we probed HOME and lowercased, two genuinely distinct anchors like
 * `/Volumes/Case/work/Foo` and `/Volumes/Case/work/foo` would fold to one
 * partition and clobber each other. So callers pass the anchor's directory.
 *
 * `realpath` does NOT fold case on macOS (it returns the queried spelling
 * as-is, verified in the issue), so normalization must be an explicit lowercase
 * gated on this probe.
 *
 * Result is cached per probe directory. On any probe error we fall back to
 * case-sensitive (no lowercasing) — the conservative choice: it never merges two
 * distinct anchors, at worst it keeps two spellings of one anchor separate.
 */
export function isCaseInsensitiveFs(probeDir?: string): boolean {
  const base = probeDir ?? path.join(getUserHome(), '.teamai');
  const cached = caseInsensitiveCache.get(base);
  if (cached !== undefined) return cached;
  let insensitive = false;
  try {
    fs.mkdirSync(base, { recursive: true });
    const token = `.teamai-case-probe-${process.pid}-${Date.now()}`;
    const upper = path.join(base, token.toUpperCase());
    const lower = path.join(base, token.toLowerCase());
    fs.writeFileSync(upper, '');
    // If the lowercased path resolves to the file we wrote under the uppercased
    // name, the FS folds case → case-insensitive.
    insensitive = fs.existsSync(lower);
    fs.rmSync(upper, { force: true });
  } catch {
    insensitive = false;
  }
  caseInsensitiveCache.set(base, insensitive);
  return insensitive;
}

/** Test-only: reset the cached case-sensitivity probes. */
export function resetCaseProbeCache(): void {
  caseInsensitiveCache = new Map();
}

/**
 * Normalize an anchor path for hashing. The anchor is already realpath-resolved
 * by `resolveAnchors` (symlinks + macOS /tmp→/private/tmp). Here we only apply
 * case-folding when the anchor's OWN volume is case-insensitive, so different
 * spellings of one directory map to one partition — while distinct anchors on a
 * case-sensitive volume stay distinct.
 */
function normalizeAnchor(anchor: string): string {
  // Probe the anchor's parent dir: it is on the same volume as the anchor in
  // every realistic case (an anchor whose parent is a mount point is pathological)
  // and, unlike the anchor itself, is not the business workspace root we want to
  // keep pristine. Falls back to the anchor if it has no parent.
  const probeDir = path.dirname(anchor) || anchor;
  return isCaseInsensitiveFs(probeDir) ? anchor.toLowerCase() : anchor;
}

/**
 * Filesystem-safe, length-bounded prefix built from the WHOLE anchor path, so
 * the slug reads back to its project (e.g. `/Users/x/Project/app` →
 * `Users-x-Project-app`). Every path separator and illegal char folds to `-`;
 * the leading `-` from the root separator is trimmed.
 */
function safePathPrefix(anchor: string): string {
  const cleaned = anchor
    // Every separator / illegal char (`/`, `\`, `:`, spaces, …) → `-`.
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Trim the leading `-` produced by the root separator, and any trailing one.
    .replace(/^-+|-+$/g, '');
  const safe = cleaned || 'project';
  // Bound the segment well under NAME_MAX (255): prefix + '-' + 16-hex hash must
  // fit. Keep the TAIL — the project name and its immediate parents are the
  // identifying part; the hash disambiguates any two paths sharing a truncated
  // head. Drop a partial leading token so we never start mid-word.
  const MAX = 180;
  if (safe.length <= MAX) return safe;
  return safe.slice(safe.length - MAX).replace(/^[^-]*-/, '');
}

/**
 * sha256 of the normalized anchor, first 16 hex — the slug's uniqueness suffix.
 *
 * 16 hex = 64 bits of the digest. An 8-hex (32-bit) suffix is NOT collision-safe
 * — a second-preimage against a target slug is constructible in well under a
 * second, which would silently merge two projects' config/state/plaintext-env
 * into one partition. 64 bits pushes a deliberate collision search past ~2^32
 * hashes, out of casual reach, while keeping the directory name reasonable.
 */
function anchorHash(norm: string): string {
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/**
 * `<safe-path>-<sha256(normalized anchor)[:16]>` — stable per projectAnchor.
 */
export function projectSlug(anchor: string): string {
  // Normalize once so BOTH the path prefix and the hash are derived from the
  // same canonical spelling — on a case-insensitive volume this makes the whole
  // slug string identical for any spelling of one directory.
  const norm = normalizeAnchor(anchor);
  return `${safePathPrefix(norm)}-${anchorHash(norm)}`;
}

/**
 * The partition name format used BEFORE the prefix was widened from the anchor's
 * basename to its whole path: `<safe-basename>-<hash>` (basename cleaned,
 * bounded to 40 chars). The hash derivation is unchanged, so the legacy and
 * current slugs of one anchor share the same suffix — which is what makes
 * `resolvePartitionDir`'s rename-based adoption exact. Kept for its two
 * consumers: adopting a pre-widening partition under its new name, and letting
 * `status --all` report a not-yet-adopted legacy partition as active instead of
 * corrupt.
 */
export function legacyProjectSlug(anchor: string): string {
  const norm = normalizeAnchor(anchor);
  const raw = path.basename(norm) || 'project';
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${(cleaned || 'project').slice(0, 40)}-${anchorHash(norm)}`;
}

/**
 * Absolute path of a project's machine-data partition in the CURRENT naming
 * format: `~/.teamai/projects/<slug(anchor)>`. `anchor` MUST be the shared
 * projectAnchor (the main checkout), so all worktrees of one repo share the
 * partition. Pure path math — it does not look at the disk. Callers that need
 * "the partition that actually holds this project's data" (detection, init,
 * migration) must use `resolvePartitionDir` instead, which adopts a partition
 * still named in the pre-#546 legacy format.
 */
export function projectDataHome(anchor: string): string {
  return path.join(getUserHome(), '.teamai', 'projects', projectSlug(anchor));
}

/**
 * Resolve the partition directory that actually holds `anchor`'s machine data,
 * transparently adopting a partition written by a pre-#546 teamai under the
 * legacy `<safe-basename>-<hash>` name (#546 widened the prefix to the whole
 * path without migrating existing installs).
 *
 * Both names share the same sha256 suffix, so an anchor's legacy name is
 * computable exactly — no directory scanning. When the canonical
 * (current-format) directory does not exist yet and a legacy-named one does,
 * the legacy partition is RENAMED into place: an atomic, same-parent metadata
 * move, so no data is copied and an interrupted adoption leaves either name
 * intact, never a half-moved directory. Every seam that resolves "this
 * project's partition" (detection, init, migration) goes through here, so an
 * upgraded CLI converges on the new name on the first command that touches the
 * project. `status --all` deliberately does NOT rename (it must stay
 * read-only); it recognizes the legacy name via `legacyProjectSlug` instead.
 *
 * Edge cases:
 *  - canonical already exists with data → it is authoritative; a leftover
 *    legacy dir is left untouched for `status --all` / manual cleanup (same
 *    rule as migration: never overwrite an authoritative partition).
 *  - canonical exists but is EMPTY (a crashed init's bare mkdir) while the
 *    legacy partition holds the data → the empty dir is replaced. POSIX
 *    rename already does this in one call; Windows (which refuses to rename
 *    onto an existing dir) takes the explicit rmdir-then-rename path.
 *  - rename genuinely impossible (e.g. read-only home) and legacy exists →
 *    the legacy directory keeps serving as the partition, so no data is
 *    stranded and nothing pretends to be fresh.
 *
 * The microscopic race (two processes adopting at once) is benign: the loser
 * observes the legacy name gone, finds the canonical name in place, and lands
 * on the same directory.
 *
 * Whenever the resolution lands on `canonical`, the stored `repo.localPath` is
 * rebased off the legacy directory (see `rebaseLocalPathAfterAdoption`): the
 * team-repo clone lived at `<legacyDir>/team-repo` as an ABSOLUTE path in
 * config.yaml, so a bare directory rename would leave the config pointing at a
 * now-gone path and every later `pull` would silently skip the sync. The
 * rewrite is idempotent, so it also finishes an adoption that crashed between
 * the rename and the config rewrite.
 */
export async function resolvePartitionDir(anchor: string): Promise<string> {
  const canonical = projectDataHome(anchor);
  const legacyDir = path.join(projectsRootDir(), legacyProjectSlug(anchor));
  if (legacyDir === canonical) return canonical; // whole-path prefix == basename (root-level anchor)
  const dir = await adoptLegacyPartition(canonical, legacyDir);
  if (dir === canonical) await rebaseLocalPathAfterAdoption(canonical, legacyDir);
  return dir;
}

/** Perform the rename-based adoption, returning the directory that holds the data. */
async function adoptLegacyPartition(canonical: string, legacyDir: string): Promise<string> {
  try {
    await fs.promises.rename(legacyDir, canonical);
    return canonical;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Nothing to adopt — the common fresh-install case (or a concurrent
      // process just adopted it, in which case canonical now exists).
      return canonical;
    }
    const legacyExists = await dirExists(legacyDir);
    // null → canonical does not exist; [] → exists but is empty.
    const canonicalEntries = await fs.promises.readdir(canonical).catch(() => null);
    if (canonicalEntries && canonicalEntries.length > 0) {
      return canonical; // authoritative data — never clobber it
    }
    if (legacyExists && canonicalEntries) {
      // Canonical is an empty leftover and the FS refused the rename onto it.
      await fs.promises.rmdir(canonical).catch(() => {});
      try {
        await fs.promises.rename(legacyDir, canonical);
      } catch { /* fall through to whichever dir actually exists */ }
      return canonical;
    }
    // Rename failed for a real reason (e.g. permissions) with no canonical
    // dir: keep serving the legacy partition so the data stays reachable.
    return legacyExists ? legacyDir : canonical;
  }
}

/**
 * After a legacy partition is adopted (renamed) into `canonical`, its
 * config.yaml still stores `repo.localPath` as an absolute path inside the old
 * `legacyDir` — the team-repo clone was at `<legacyDir>/team-repo`. That path is
 * gone, so `pull` would read the team config from a dead directory and skip the
 * sync (exit 0, "Team config not found"). Rewrite the stored path into the new
 * partition.
 *
 * Idempotent and safe to run on every resolve that lands on canonical:
 *  - a modern install's localPath is already inside canonical (not legacyDir),
 *    so the `path.relative` containment check leaves it untouched;
 *  - an adoption that crashed after the rename but before this rewrite is
 *    finished by the next command (the stale localPath is detected and fixed).
 *
 * `repo.localPath` is the only absolute path persisted in config.yaml (mirrors
 * migrate.ts's `rebaseConfigPaths`); an external clone whose localPath sits
 * outside legacyDir is left alone. The legacy path is gone at this point, so we
 * compare on the expanded (not realpath'd) spelling — both `legacyDir` and the
 * persisted path are built from the same `getUserHome()` root.
 */
async function rebaseLocalPathAfterAdoption(canonical: string, legacyDir: string): Promise<void> {
  const configPath = path.join(canonical, 'config.yaml');
  const content = await readFileSafe(configPath);
  if (!content) return;
  let doc: Record<string, unknown>;
  try {
    doc = YAML.parse(content) as Record<string, unknown>;
  } catch {
    return; // malformed config — leave it for status/doctor to surface
  }
  const repo = doc?.repo as { localPath?: string } | undefined;
  if (!repo?.localPath) return;
  const rel = path.relative(legacyDir, expandHome(repo.localPath));
  if (rel === '' ? false : rel.startsWith('..') || path.isAbsolute(rel)) return; // not inside legacyDir
  const rebased = rel === '' ? canonical : path.join(canonical, rel);
  if (rebased === repo.localPath) return;
  repo.localPath = rebased;
  // Atomic write (same-dir temp + rename): config.yaml is the partition's only
  // copy and the legacy source has already been renamed away, so a partial
  // overwrite (ENOSPC/EFBIG/crash mid-write) would truncate it with no way back.
  // A failed rename leaves the original config.yaml untouched.
  await writeFileAtomic(configPath, YAML.stringify(doc));
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Root dir holding every project partition: `~/.teamai/projects`. */
export function projectsRootDir(): string {
  return path.join(getUserHome(), '.teamai', 'projects');
}

/**
 * The `anchor` reverse-lookup file inside a partition. The slug is a one-way
 * sha256, so this file is the ONLY way back to the original projectAnchor path;
 * it lives inside the partition (off the workspace), preserving zero-residue.
 * Written on both init and migration so every partition carries it (issue #374).
 */
export async function writeAnchorFile(partitionDir: string, anchor: string): Promise<void> {
  await fs.promises.mkdir(partitionDir, { recursive: true });
  await fs.promises.writeFile(path.join(partitionDir, 'anchor'), `${anchor}\n`, 'utf-8');
}

/** Read a partition's `anchor` file (trimmed), or null when absent/unreadable. */
export async function readAnchorFile(partitionDir: string): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(path.join(partitionDir, 'anchor'), 'utf-8');
    const trimmed = raw.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

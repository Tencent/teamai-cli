import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { getUserHome } from './home.js';

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
 * `<safe-path>-<sha256(normalized anchor)[:16]>` — stable per projectAnchor.
 *
 * 16 hex = 64 bits of the digest. An 8-hex (32-bit) suffix is NOT collision-safe
 * — a second-preimage against a target slug is constructible in well under a
 * second, which would silently merge two projects' config/state/plaintext-env
 * into one partition. 64 bits pushes a deliberate collision search past ~2^32
 * hashes, out of casual reach, while keeping the directory name reasonable.
 */
export function projectSlug(anchor: string): string {
  // Normalize once so BOTH the path prefix and the hash are derived from the
  // same canonical spelling — on a case-insensitive volume this makes the whole
  // slug string identical for any spelling of one directory.
  const norm = normalizeAnchor(anchor);
  const hash = createHash('sha256').update(norm).digest('hex').slice(0, 16);
  return `${safePathPrefix(norm)}-${hash}`;
}

/**
 * Absolute path of a project's machine-data partition:
 * `~/.teamai/projects/<slug(anchor)>`. `anchor` MUST be the shared projectAnchor
 * (the main checkout), so all worktrees of one repo share the partition.
 */
export function projectDataHome(anchor: string): string {
  return path.join(getUserHome(), '.teamai', 'projects', projectSlug(anchor));
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

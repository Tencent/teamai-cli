import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Assert that a resolved target path is within one of the allowed root directories.
 *
 * Resolves symlinks on both sides before comparing, preventing symlink-escape attacks.
 * Throws a descriptive error if the target is outside all allowed roots.
 *
 * @param target       The path to validate (will be resolved to absolute).
 * @param allowedRoots The set of allowed root directories (will be resolved too).
 * @throws Error with a descriptive message if the target is outside all roots.
 */
export function assertSafePath(target: string, allowedRoots: string[]): void {
  const resolvedTarget = resolveReal(target);

  for (const root of allowedRoots) {
    const resolvedRoot = resolveReal(root);
    if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)) {
      return;
    }
  }

  throw new Error(
    `Path traversal detected: "${target}" is outside allowed directories: ${allowedRoots.join(', ')}`,
  );
}

/**
 * Assert that `candidate` stays within `root`, comparing resolved paths WITHOUT
 * following symlinks on either side.
 *
 * Use this for "write a new file under root" guards: the candidate need not exist
 * yet, and because neither side is symlink-resolved the check stays consistent
 * even when `root` is reached through a symlink (e.g. macOS `/var` → `/private/var`
 * tmpdirs). When symlink resolution IS required, use {@link assertSafePath}.
 *
 * @param root       The directory the candidate must stay inside.
 * @param candidate  The path to validate.
 * @param message    Optional custom error message thrown on violation.
 * @throws Error if `candidate` resolves outside `root`.
 */
export function assertWithinRoot(root: string, candidate: string, message?: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + path.sep)) {
    throw new Error(message ?? `path traversal detected: "${candidate}" is outside "${root}"`);
  }
}

/**
 * Resolve a path to its real absolute form.
 *
 * Uses fs.realpathSync when the path exists (follows symlinks).
 * Falls back to path.resolve for non-existent paths (parent must exist check is
 * left to the caller — we still resolve as far as possible).
 *
 * @param p  Input path (may be relative, may contain ~).
 * @returns  Resolved absolute path string.
 */
function resolveReal(p: string): string {
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  const abs = path.resolve(expanded);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Path does not exist yet — return the resolved absolute path without following symlinks.
    // The parent-directory check is sufficient to prevent path traversal for new files.
    return abs;
  }
}

/**
 * Return the default allowed roots for user-facing path inputs:
 * the current working directory and the user's home directory.
 *
 * @returns Array of two resolved paths: [cwd, homedir].
 */
export function defaultAllowedRoots(): string[] {
  return [process.cwd(), os.homedir()];
}

/**
 * Validate a CLI user-supplied resource name (skill / agent / rule, etc.) for safety.
 *
 * Rules enforced:
 *   - Length must be 1–64 characters
 *   - Only [A-Za-z0-9._-] characters are allowed
 *   - Single dot ('.') and double dot ('..') are rejected
 *   - Must not contain path separators ('/' or '\') after URL-decoding
 *   - Must not be an absolute path after URL-decoding
 *   - Must not contain null bytes
 *   - Percent-encoded variants of the above are also rejected
 *
 * @param name  The resource name string to validate.
 * @throws Error with a descriptive message if the name is invalid.
 */
export function assertSafeResourceName(name: string): void {
  // Reject null bytes before any other check
  if (name.includes('\0')) {
    throw new Error('Invalid resource name: contains null byte');
  }

  // Attempt URL-decode to catch %2e%2e, %2f, etc.
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    throw new Error('Invalid resource name: contains invalid percent-encoding');
  }

  // Reject null bytes in decoded form too
  if (decoded.includes('\0')) {
    throw new Error('Invalid resource name: contains null byte');
  }

  // Reject path separators (both slash styles) in decoded form
  if (decoded.includes('/') || decoded.includes('\\')) {
    throw new Error('Invalid resource name: contains path separator');
  }

  // Reject absolute paths in decoded form
  if (path.isAbsolute(decoded)) {
    throw new Error('Invalid resource name: must not be an absolute path');
  }

  // Reject dot-only segments
  if (decoded === '.' || decoded === '..') {
    throw new Error('Invalid resource name: "." and ".." are not allowed');
  }

  // Allowlist: only [A-Za-z0-9._-], length 1–64
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new Error(
      'Invalid resource name: must be 1–64 characters and contain only [A-Za-z0-9._-]',
    );
  }
}

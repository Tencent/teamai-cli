import fse from 'fs-extra';
import crypto from 'node:crypto';
import path from 'node:path';
import { log } from './logger.js';

const IGNORED_NAMES = new Set([
  '__pycache__',
  '.pyc',
  '.DS_Store',
  'node_modules',
  '.git',
]);

function isIgnored(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.endsWith('.pyc');
}

/**
 * Expand ~ to $HOME in paths
 */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(process.env.HOME ?? '', p.slice(1));
  }
  return p;
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dir: string): Promise<void> {
  await fse.ensureDir(expandHome(dir));
}

/**
 * Read a file, return null if not found
 */
export async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fse.readFile(expandHome(filePath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write a file, creating parent dirs as needed
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  const expanded = expandHome(filePath);
  await fse.ensureDir(path.dirname(expanded));
  await fse.writeFile(expanded, content, 'utf-8');
}

/**
 * Read JSON file, return null if not found
 */
export async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  const content = await readFileSafe(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    log.warn(`Failed to parse JSON: ${filePath}`);
    return null;
  }
}

/**
 * Write JSON file
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Copy a directory recursively.
 * If `dest` is a symlink (e.g. left over from setup-links.sh), remove it first
 * so fse.copy can create a real directory in its place.
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  const destExpanded = expandHome(dest);
  try {
    const stat = await fse.lstat(destExpanded);
    if (stat.isSymbolicLink()) {
      await fse.remove(destExpanded);
    }
  } catch {
    // dest doesn't exist yet — that's fine
  }
  await fse.copy(expandHome(src), destExpanded, {
    overwrite: true,
    filter: (srcPath: string) => !isIgnored(path.basename(srcPath)),
  });
}

/**
 * Copy a file
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  const destExpanded = expandHome(dest);
  await fse.ensureDir(path.dirname(destExpanded));
  await fse.copy(expandHome(src), destExpanded, { overwrite: true });
}

/**
 * List directories in a path (non-recursive, only directories)
 */
export async function listDirs(dirPath: string): Promise<string[]> {
  const expanded = expandHome(dirPath);
  if (!await fse.pathExists(expanded)) return [];
  const entries = await fse.readdir(expanded, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && !isIgnored(e.name)).map(e => e.name);
}

/**
 * List files in a path (non-recursive, only files)
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  const expanded = expandHome(dirPath);
  if (!await fse.pathExists(expanded)) return [];
  const entries = await fse.readdir(expanded, { withFileTypes: true });
  return entries.filter(e => e.isFile()).map(e => e.name);
}

/**
 * List files recursively, returning relative paths (e.g. "sub/file.md").
 */
export async function listFilesRecursive(dirPath: string): Promise<string[]> {
  const expanded = expandHome(dirPath);
  if (!await fse.pathExists(expanded)) return [];
  const results: string[] = [];
  await _walkFiles(expanded, '', results);
  return results;
}

async function _walkFiles(base: string, prefix: string, results: string[]): Promise<void> {
  const entries = await fse.readdir(path.join(base, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      results.push(rel);
    } else if (entry.isDirectory()) {
      await _walkFiles(base, rel, results);
    }
  }
}

/**
 * Check if a path exists
 */
export async function pathExists(p: string): Promise<boolean> {
  return fse.pathExists(expandHome(p));
}

/**
 * Remove a file or directory
 */
export async function remove(p: string): Promise<void> {
  await fse.remove(expandHome(p));
}

/**
 * Get the mtime (last modification time) of a file.
 * Returns 0 if the file does not exist.
 */
export async function getFileMtime(filePath: string): Promise<number> {
  try {
    const stat = await fse.stat(expandHome(filePath));
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Get the latest mtime across all files in a directory (recursive).
 * Returns 0 if the directory does not exist or is empty.
 */
export async function getDirLatestMtime(dirPath: string): Promise<number> {
  const expanded = expandHome(dirPath);
  if (!await fse.pathExists(expanded)) return 0;

  let latest = 0;
  const entries = await fse.readdir(expanded, { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const fullPath = path.join(expanded, entry.name);
    if (entry.isFile()) {
      const stat = await fse.stat(fullPath);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } else if (entry.isDirectory()) {
      const sub = await getDirLatestMtime(fullPath);
      if (sub > latest) latest = sub;
    }
  }
  return latest;
}

/**
 * Compute SHA-256 hash of a file's contents. Returns null if file does not exist.
 */
async function fileHash(filePath: string): Promise<string | null> {
  try {
    const content = await fse.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compare a file's content against a Buffer by SHA-256 hash.
 * Returns true if the file has identical content to the buffer.
 * Returns false if the file does not exist.
 */
export async function fileContentEqualToBuffer(filePath: string, buffer: Buffer): Promise<boolean> {
  const fileHashVal = await fileHash(expandHome(filePath));
  if (fileHashVal === null) return false;
  const bufHash = crypto.createHash('sha256').update(buffer).digest('hex');
  return fileHashVal === bufHash;
}

/**
 * Compare two files by content. Returns true if they have identical content.
 * Returns false if either file does not exist or content differs.
 */
export async function fileContentEqual(fileA: string, fileB: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    fileHash(expandHome(fileA)),
    fileHash(expandHome(fileB)),
  ]);
  if (hashA === null || hashB === null) return false;
  return hashA === hashB;
}

/**
 * Recursively compare two directories by content.
 * Returns true only if both directories have exactly the same files with identical content.
 * Returns false if either directory does not exist.
 */
export async function dirContentEqual(dirA: string, dirB: string, ignore?: string[]): Promise<boolean> {
  const expandedA = expandHome(dirA);
  const expandedB = expandHome(dirB);

  if (!await fse.pathExists(expandedA) || !await fse.pathExists(expandedB)) return false;

  const ignoreSet = ignore ? new Set(ignore) : undefined;

  // Collect all relative file paths from both directories
  const filesA = await collectFiles(expandedA, '', ignoreSet);
  const filesB = await collectFiles(expandedB, '', ignoreSet);

  // Same set of files?
  if (filesA.size !== filesB.size) return false;
  for (const rel of filesA) {
    if (!filesB.has(rel)) return false;
  }

  // Same content?
  for (const rel of filesA) {
    const equal = await fileContentEqual(
      path.join(expandedA, rel),
      path.join(expandedB, rel),
    );
    if (!equal) return false;
  }

  return true;
}

/**
 * Team-repo-centric directory comparison.
 * Returns true if every file in `teamDir` exists in `localDir` with identical content.
 * Extra files in `localDir` (e.g. scripts/, agents/, references/) are ignored.
 * This prevents false-positive "modified" detection when the local copy has
 * additional enhancement files that the team repo version does not.
 *
 * Returns false if `teamDir` does not exist (nothing to compare against).
 * Returns false if `localDir` does not exist (local copy missing).
 */
export async function dirTeamSubsetEqual(
  localDir: string,
  teamDir: string,
  ignore?: string[],
): Promise<boolean> {
  const expandedLocal = expandHome(localDir);
  const expandedTeam = expandHome(teamDir);

  if (!await fse.pathExists(expandedLocal) || !await fse.pathExists(expandedTeam)) return false;

  const ignoreSet = ignore ? new Set(ignore) : undefined;

  // Collect files from team repo only — this is the "source of truth" file set
  const teamFiles = await collectFiles(expandedTeam, '', ignoreSet);

  if (teamFiles.size === 0) return true; // Empty team dir matches anything

  // Check that every team file exists in local with identical content
  for (const rel of teamFiles) {
    const equal = await fileContentEqual(
      path.join(expandedLocal, rel),
      path.join(expandedTeam, rel),
    );
    if (!equal) return false;
  }

  return true;
}

/**
 * Recursively collect all relative file paths under a directory.
 */
async function collectFiles(base: string, prefix: string, ignore?: Set<string>): Promise<Set<string>> {
  const result = new Set<string>();
  const entries = await fse.readdir(path.join(base, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    if (ignore?.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile()) {
      result.add(rel);
    } else if (entry.isDirectory()) {
      const sub = await collectFiles(base, rel, ignore);
      for (const s of sub) result.add(s);
    }
  }
  return result;
}

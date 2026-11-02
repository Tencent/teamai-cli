/**
 * Read-only source freshness checks for the codebase pages visible in recall.
 * The source manifest is treated as untrusted metadata: every path is checked
 * against a verified local Git checkout, including symlink resolution.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { errnoCode } from './utils/fs.js';
import { createGit, repoIdentity } from './utils/git.js';
import type { SourceAnchor } from './code-knowledge-recall.js';
import { isCodeFile, SourceManifestSchema, type SourceManifest } from './wiki-engine/code-knowledge/code-collector.js';
import { safeIgnore } from './wiki-engine/core/wiki-protocol.js';

export type SourceFreshness = 'current' | 'stale' | 'missing' | 'unknown';

export interface CodebaseFreshnessResult {
  entry: { filename: string };
  fromCodebase?: boolean;
  sources?: SourceAnchor[];
}

interface CheckoutIdentity {
  root: string;
  remotes: Set<string>;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Normalize a slash or backslash relative path, rejecting traversal and roots. */
function safeRelativePath(value: string, allowEmpty = false): string | null {
  if (value.includes('\0')) return null;
  const slashPath = value.replace(/\\/g, '/');

  if (slashPath.startsWith('/') || /^[a-z]:/i.test(slashPath)) return null;

  if (slashPath === '' || slashPath === '.') return allowEmpty ? '' : null;
  const segments = slashPath.split('/');

  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const normalized = segments.filter(Boolean).join('/');

  return normalized || (allowEmpty ? '' : null);
}

function manifestRepoIdentity(manifest: SourceManifest): string | null {
  if (manifest.repoIdentity?.trim()) {
    return manifest.repoIdentity.trim();
  }

  if (manifest.repoUrl?.trim()) {
    return repoIdentity(manifest.repoUrl);
  }

  return null;
}

function validLastScan(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

async function currentCheckout(cwd: string): Promise<CheckoutIdentity | null> {
  try {
    const git = createGit(cwd);
    const rootText = (await git.revparse(['--show-toplevel'])).trim();

    if (!rootText) return null;
    const root = await realpath(rootText);
    const remotes = await git.getRemotes(true);

    return {
      root,
      remotes: new Set(remotes.flatMap((remote) => (
        remote.refs.fetch.trim() !== '' ? [repoIdentity(remote.refs.fetch)] : []
      ))),
    };
  } catch {
    return null;
  }
}

function codebaseSlug(page: string): string | null {
  const normalized = page.replace(/\\/g, '/');
  const segments = normalized.split('/');

  if (segments.length < 4 || segments[0] !== 'evidence' || segments[1] !== 'code') return null;

  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;

  return segments[2] ?? null;
}

async function readManifest(
  manifestPath: string,
  boundary: string,
): Promise<{ state: 'missing' | 'invalid' | 'ok'; manifest?: SourceManifest }> {
  try {
    const actualPath = await realpath(manifestPath);

    if (!isWithin(boundary, actualPath) || !(await stat(actualPath)).isFile()) {
      return { state: 'invalid' };
    }

    const parsed = SourceManifestSchema.safeParse(JSON.parse(await readFile(actualPath, 'utf8')));

    // A manifest without a file list holds no baseline.
    if (!parsed.success || parsed.data.files === undefined) return { state: 'invalid' };

    return { state: 'ok', manifest: parsed.data };
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') return { state: 'invalid' };

    try {
      // lstat distinguishes a truly absent manifest from a dangling symlink.
      await lstat(manifestPath);

      return { state: 'invalid' };
    } catch (lstatError) {
      return errnoCode(lstatError) === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' };
    }
  }
}

/** How many codebases a teamwiki holds evidence for, and the slug of the only one. */
interface EvidenceCodebases {
  count: number;
  slug?: string;
}

async function evidenceCodebaseCount(wikiRoot: string): Promise<EvidenceCodebases | null> {
  try {
    const evidenceRoot = path.join(wikiRoot, 'evidence', 'code');
    const actualRoot = await realpath(evidenceRoot);

    if (!isWithin(wikiRoot, actualRoot)) return null;
    const entries = await readdir(actualRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());

    const counted: EvidenceCodebases = { count: dirs.length };

    if (dirs.length === 1) counted.slug = dirs[0]?.name;

    return counted;
  } catch {
    return null;
  }
}

async function baselineForPage(
  wikiRoot: string,
  slug: string,
): Promise<SourceManifest | null> {
  const projectDir = path.join(wikiRoot, 'evidence', 'code', slug);
  let realProjectDir: string;

  try {
    realProjectDir = await realpath(projectDir);

    if (!isWithin(wikiRoot, realProjectDir) || !(await stat(realProjectDir)).isDirectory()) return null;
  } catch {
    return null;
  }

  const colocated = await readManifest(path.join(projectDir, 'source-manifest.json'), realProjectDir);

  if (colocated.state === 'ok' && colocated.manifest) {
    if (colocated.manifest.project && colocated.manifest.project !== slug) return null;

    return colocated.manifest;
  }

  // A corrupt/unreadable or escaping per-codebase manifest must not be masked
  // by a different root manifest.
  if (colocated.state !== 'missing') return null;

  // Legacy teamwiki roots may contain one shared manifest. It is safe to use
  // only when it has explicit subdirectory provenance, there is exactly one
  // evidence repository, and any recorded project names this page.
  const codebases = await evidenceCodebaseCount(wikiRoot);

  if (!codebases || codebases.count !== 1 || codebases.slug !== slug) return null;
  const rootManifest = await readManifest(path.join(wikiRoot, 'source-manifest.json'), wikiRoot);

  if (rootManifest.state !== 'ok' || !rootManifest.manifest) return null;

  if (rootManifest.manifest.project && rootManifest.manifest.project !== slug) return null;

  return rootManifest.manifest;
}

async function safelyAbsent(candidate: string, repoRoot: string): Promise<boolean> {
  // The candidate itself must be absent, not a broken symlink or a path that
  // failed for permissions, loops, or a non-directory parent.
  try {
    await lstat(candidate);

    return false;
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') return false;
  }

  let ancestor = path.dirname(candidate);

  while (isWithin(repoRoot, ancestor)) {
    try {
      const actual = await realpath(ancestor);
      const ancestorStat = await stat(actual);

      return ancestorStat.isDirectory() && isWithin(repoRoot, actual);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') return false;

      try {
        // lstat succeeds for a dangling symlink, whose realpath failure must
        // stay unknown instead of being reported as a missing source file.
        await lstat(ancestor);

        return false;
      } catch (lstatError) {
        if (errnoCode(lstatError) !== 'ENOENT') return false;
      }
    }

    const parent = path.dirname(ancestor);

    if (parent === ancestor) return false;
    ancestor = parent;
  }

  return false;
}

async function checkOneSource(
  source: SourceAnchor,
  manifest: SourceManifest,
  checkout: CheckoutIdentity,
): Promise<SourceAnchor> {
  const lastScan = validLastScan(manifest.lastScan);

  const withFreshness = (freshness: SourceFreshness): SourceAnchor => {
    const anchor: SourceAnchor = { ...source, freshness };

    if (lastScan) anchor.lastScan = lastScan;

    return anchor;
  };

  const unknown = (): SourceAnchor => withFreshness('unknown');
  const identity = manifestRepoIdentity(manifest);

  const subdir = manifest.sourceSubdir !== undefined
    ? safeRelativePath(manifest.sourceSubdir, true)
    : null;

  const relative = safeRelativePath(source.path);

  if (!identity || !checkout.remotes.has(identity) || subdir === null || relative === null
    || safeIgnore(relative) || !isCodeFile(relative)) return unknown();

  const repoRoot = checkout.root;
  const sourceRoot = path.resolve(repoRoot, ...subdir.split('/').filter(Boolean));

  if (!isWithin(repoRoot, sourceRoot)) return unknown();

  let realSourceRoot: string;

  try {
    realSourceRoot = await realpath(sourceRoot);

    if (!isWithin(repoRoot, realSourceRoot) || !(await stat(realSourceRoot)).isDirectory()) return unknown();
  } catch {
    return unknown();
  }

  const candidate = path.resolve(sourceRoot, ...relative.split('/'));

  if (!isWithin(sourceRoot, candidate) || safeIgnore(candidate) || !isCodeFile(candidate)) return unknown();

  const baseline = new Map<string, string | null>();

  for (const file of manifest.files ?? []) {
    if (!file) continue;
    const filePath = safeRelativePath(file.relativePath);

    if (filePath) {
      baseline.set(filePath, baseline.has(filePath) ? null : file.sha256.toLowerCase());
    }
  }

  const expectedHash = baseline.get(relative);

  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) return unknown();

  let actualPath: string;

  try {
    actualPath = await realpath(candidate);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT' && await safelyAbsent(candidate, repoRoot)) {
      return withFreshness('missing');
    }

    return unknown();
  }

  if (!isWithin(repoRoot, actualPath) || safeIgnore(actualPath) || !isCodeFile(actualPath)) return unknown();
  let fileStat;

  try {
    fileStat = await stat(actualPath);
  } catch {
    return unknown();
  }

  // Do not read directories, devices, or FIFOs as source files.
  if (!fileStat.isFile()) return unknown();

  try {
    // Match code-collector's semantics: it hashes the UTF-8 decoded text, not
    // the raw bytes, so malformed UTF-8 does not appear stale just by decoding.
    const content = await readFile(actualPath, 'utf8');
    const actualHash = createHash('sha256').update(content).digest('hex');

    return withFreshness(actualHash === expectedHash ? 'current' : 'stale');
  } catch {
    return unknown();
  }
}

/**
 * Add read-only freshness hints to the codebase source anchors in the final
 * visible recall results. Call only after the --check early return and limit.
 */
export async function annotateCodebaseSourceFreshness(
  results: CodebaseFreshnessResult[],
  wikiRoot: string,
  cwd = process.cwd(),
): Promise<void> {
  const visible = results.filter((result) => result.fromCodebase && result.sources?.length);

  if (visible.length === 0) return;

  const markUnknown = (): void => {
    for (const result of visible) {
      result.sources = (result.sources ?? []).map((source) => ({ ...source, freshness: 'unknown' }));
    }
  };

  let realWikiRoot: string;

  try {
    realWikiRoot = await realpath(wikiRoot);

    if (!(await stat(realWikiRoot)).isDirectory()) {
      markUnknown();

      return;
    }
  } catch {
    markUnknown();

    return;
  }

  const checkout = await currentCheckout(cwd);

  for (const result of visible) {
    const slug = codebaseSlug(result.entry.filename);
    const manifest = slug ? await baselineForPage(realWikiRoot, slug) : null;
    result.sources = await Promise.all((result.sources ?? []).map((source) => {
      if (!manifest) return Promise.resolve({ ...source, freshness: 'unknown' as const });

      if (!checkout) {
        const lastScan = validLastScan(manifest.lastScan);
        const anchor: SourceAnchor = { ...source, freshness: 'unknown' };

        if (lastScan) anchor.lastScan = lastScan;

        return Promise.resolve(anchor);
      }

      return checkOneSource(source, manifest, checkout);
    }));
  }
}

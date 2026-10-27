import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractCodebase } from '../codebase-extract.js';
import { importCodebase } from '../import-codebase.js';

/**
 * A `--dir` checkout with no `origin` remote has no `repoIdentity`, so the
 * published baseline could never be matched: `--incremental` silently ran a
 * full extraction every time, and a re-import dropped the curated docs that
 * only enrichment writes (#1422). The hashed git root is now recorded as
 * `localRootHash` and compared instead.
 */

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* the suite reports its own cleanup failures */ }
  }
});

function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(withOrigin: boolean, name = 'repo'): string {
  const root = path.join(temp('teamai-1422-src-'), name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet');
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test');
  if (withOrigin) git(root, 'remote', 'add', 'origin', 'https://github.com/acme/svc.git');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'export const b = 2;\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'init');
  return fs.realpathSync(root);
}

/** A committed subdirectory of `repo`: its own codebase, sharing the git root. */
function makeSubdir(repo: string, subdir: string): string {
  const dir = path.join(repo, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', `add ${subdir}`);
  return fs.realpathSync(dir);
}

async function runExtract(
  sourceDir: string,
  outputRoot: string,
  incremental: boolean,
): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await extractCodebase({ path: sourceDir, outputRoot, incremental, skipEnrich: true });
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

function readManifest(outputRoot: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(outputRoot, 'teamwiki', 'source-manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}

const importDir = (sourceDir: string, slug: string, wikiRoot: string) =>
  importCodebase({ sourceDir, slug, wikiRoot, skipEnrich: true });

describe('incremental baseline for a --dir checkout with no origin (#1422)', { timeout: 120_000 }, () => {
  it('reuses the baseline of the same checkout instead of extracting everything', async () => {
    const repo = makeRepo(false);
    const out = temp('teamai-1422-out-');
    await runExtract(repo, out, false);
    const manifest = readManifest(out);
    expect(manifest.localRootHash).toBe(sha256(repo));
    // The hash must not be a readable copy of the checkout path: the manifest
    // is committed to the teamwiki, which the whole team can read.
    expect(manifest.localRoot).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain(repo);

    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 111;\n');
    const logs = await runExtract(repo, out, true);
    expect(logs).not.toContain('no matching source baseline');
    expect(logs).toContain('incremental: 1 files changed');
  });

  it('records no local root hash when the checkout has an origin', async () => {
    const repo = makeRepo(true);
    const out = temp('teamai-1422-out-');
    await runExtract(repo, out, false);
    const manifest = readManifest(out);
    expect(manifest.repoIdentity).toBe('https://github.com/acme/svc');
    // `repoIdentity` already identifies this checkout; nothing reads a root
    // hash for it, so writing one would only publish the path (hashed).
    expect(manifest.localRootHash).toBeUndefined();

    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 222;\n');
    const logs = await runExtract(repo, out, true);
    expect(logs).not.toContain('no matching source baseline');
  });

  it('refuses a baseline that names a remote the checkout does not have', async () => {
    const repo = makeRepo(false);
    const out = temp('teamai-1422-out-');
    await runExtract(repo, out, false);
    // A manifest written by a checkout that had an origin says nothing about
    // this directory, so it must not be reused here.
    const manifestPath = path.join(out, 'teamwiki', 'source-manifest.json');
    const manifest = readManifest(out);
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      repoIdentity: 'https://github.com/acme/other',
    }));

    const logs = await runExtract(repo, out, true);
    expect(logs).toContain('no matching source baseline');
  });

  it('refuses a baseline extracted from a different directory', async () => {
    const repo = makeRepo(false);
    const out = temp('teamai-1422-out-');
    await runExtract(repo, out, false);
    const manifestPath = path.join(out, 'teamwiki', 'source-manifest.json');
    const manifest = readManifest(out);
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      localRootHash: sha256(path.join(repo, '..', 'elsewhere')),
    }));

    const logs = await runExtract(repo, out, true);
    expect(logs).toContain('no matching source baseline');
  });

  it('refuses a baseline written before localRootHash existed', async () => {
    const repo = makeRepo(false);
    const out = temp('teamai-1422-out-');
    await runExtract(repo, out, false);
    const manifestPath = path.join(out, 'teamwiki', 'source-manifest.json');
    const manifest = readManifest(out);
    delete manifest.localRootHash;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const logs = await runExtract(repo, out, true);
    expect(logs).toContain('no matching source baseline');
  });
});

describe('curated docs of a --dir checkout with no origin (#1422)', { timeout: 120_000 }, () => {
  /** A doc that only enrichment writes; extraction never regenerates it. */
  const curated = (wikiRoot: string, slug: string) =>
    path.join(wikiRoot, 'evidence', 'code', slug, 'docs', 'curated-by-ai.md');
  const writeCurated = (wikiRoot: string, slug: string, body: string): void => {
    const file = curated(wikiRoot, slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };

  it('carries the curated docs across a re-import of the same checkout', async () => {
    const repo = makeRepo(false, 'svc');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    expect(await importDir(repo, 'svc', wikiRoot)).toBe(true);
    writeCurated(wikiRoot, 'svc', '# written by enrichment\n');

    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n');
    expect(await importDir(repo, 'svc', wikiRoot)).toBe(true);
    expect(fs.existsSync(curated(wikiRoot, 'svc')), 'same checkout must keep its docs').toBe(true);
  });

  it('replaces the docs of a different checkout that shares the basename', async () => {
    const first = makeRepo(false, 'svc');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    await importDir(first, 'svc', wikiRoot);
    writeCurated(wikiRoot, 'svc', '# belongs to the first checkout\n');

    // Same basename, different directory: the slug --dir derives collides, and
    // the first repo's curated docs must not be attached to the second.
    const second = makeRepo(false, 'svc');
    expect(await importDir(second, 'svc', wikiRoot)).toBe(true);
    expect(fs.existsSync(curated(wikiRoot, 'svc'))).toBe(false);
  });

  it('replaces the docs of another subdirectory of the same origin-less repo', async () => {
    const repo = makeRepo(false, 'repo');
    const first = makeSubdir(repo, 'service-a/svc');
    const second = makeSubdir(repo, 'service-b/svc');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');

    await importDir(first, 'svc', wikiRoot);
    writeCurated(wikiRoot, 'svc', '# belongs to service-a\n');
    // Same root and same directory: this re-import keeps its docs.
    expect(await importDir(first, 'svc', wikiRoot)).toBe(true);
    expect(fs.existsSync(curated(wikiRoot, 'svc')), 'service-a must keep its docs').toBe(true);

    // Same root, different directory. The root hash alone would call this the
    // same source and hand service-a's docs to service-b.
    expect(await importDir(second, 'svc', wikiRoot)).toBe(true);
    expect(fs.existsSync(curated(wikiRoot, 'svc'))).toBe(false);
  });

  it('replaces the docs when the published manifest names a remote', async () => {
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const withOrigin = makeRepo(true, 'svc');
    await importCodebase({
      sourceDir: withOrigin,
      slug: 'svc',
      wikiRoot,
      skipEnrich: true,
      repoUrl: 'https://github.com/acme/svc',
    });
    writeCurated(wikiRoot, 'svc', '# from the remote checkout\n');

    const localOnly = makeRepo(false, 'svc');
    expect(await importDir(localOnly, 'svc', wikiRoot)).toBe(true);
    expect(fs.existsSync(curated(wikiRoot, 'svc'))).toBe(false);
  });
});

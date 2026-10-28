import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { importLocalCheckout, localCheckoutSlug } from '../import-codebase.js';
import { log } from '../utils/logger.js';

/**
 * A `--dir` checkout without an origin remote is named after its directory, so
 * `/a/svc` and `/b/svc` both wrote `teamwiki/evidence/code/svc/` and the second
 * import replaced the first's evidence (#1422). Such a checkout is told apart
 * by its hashed local root, and one whose slug holds another source's evidence
 * publishes under `<slug>-<hash8(realpath)>` instead.
 */

const temps: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

function hash8(value: string): string {
  return sha256(value).slice(0, 8);
}

/** A plain, non-git directory with one extractable file. */
function plainDir(parent: string, name: string, marker: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ts`), `export const marker = '${marker}';\n`);
  return fs.realpathSync(dir);
}

/** `teamai import --dir <sourceDir> --skip-enrich` of a directory named `svc`. */
async function importDir(sourceDir: string, wikiRoot: string): Promise<boolean> {
  const slug = await localCheckoutSlug({ sourceDir, slug: 'svc', wikiRoot });
  return await importLocalCheckout({ sourceDir, slug, wikiRoot, skipEnrich: true });
}

function evidenceSlugs(wikiRoot: string): string[] {
  return fs.readdirSync(path.join(wikiRoot, 'evidence', 'code')).sort();
}

function localRootHashOf(wikiRoot: string, slug: string): string {
  return JSON.parse(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', slug, 'source-manifest.json'), 'utf-8')).localRootHash;
}

describe('--dir slug collision (#1422)', () => {
  it('a same-basename checkout gets its own evidence directory instead of replacing', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const a = plainDir(parent, 'svc', 'first');
    const b = plainDir(parent, 'other', 'second');

    await importDir(a, wikiRoot);
    await importDir(b, wikiRoot);

    expect(evidenceSlugs(wikiRoot)).toEqual(['svc', `svc-${hash8(b)}`].sort());
    // The first codebase's evidence survived — its manifest still answers by
    // /a/svc's hashed root — and neither manifest publishes a raw path.
    expect(localRootHashOf(wikiRoot, 'svc')).toBe(sha256(a));
    expect(localRootHashOf(wikiRoot, `svc-${hash8(b)}`)).toBe(sha256(b));
    for (const slug of evidenceSlugs(wikiRoot)) {
      expect(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', slug, 'source-manifest.json'), 'utf-8')).not.toContain(a);
      expect(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', slug, 'source-manifest.json'), 'utf-8')).not.toContain(b);
    }
  });

  it('two origin-less subdirectories of one repository do not share a slug', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '--quiet');
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'root.ts'), 'export const root = 1;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');
    const a = path.join(repo, 'a', 'svc');
    const b = path.join(repo, 'b', 'svc');
    for (const dir of [a, b]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'svc.ts'), `export const svc = '${path.basename(path.dirname(dir))}';\n`);
    }

    await importDir(a, wikiRoot);
    await importDir(b, wikiRoot);

    expect(evidenceSlugs(wikiRoot)).toHaveLength(2);
  });

  it('a suffixed destination naming another source is not reused', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const plain = plainDir(parent, 'svc', 'plain');
    await importDir(plain, wikiRoot);

    const b = plainDir(parent, 'other', 'second');
    const staged = `svc-${hash8(b)}`;
    // Stage the suffixed destination as already held by a different source —
    // the same checkout path resolving to another machine's repository.
    fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code', staged), { recursive: true });
    fs.writeFileSync(
      path.join(wikiRoot, 'evidence', 'code', staged, 'source-manifest.json'),
      JSON.stringify({ repoIdentity: 'https://github.com/acme/other' }),
    );

    await importDir(b, wikiRoot);

    // The 8-hex candidate was not reused: the import fell through to the full digest.
    const slugs = evidenceSlugs(wikiRoot);
    expect(slugs).toContain(staged);
    expect(slugs).toContain(`svc-${sha256(b)}`);
    expect(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', staged, 'source-manifest.json'), 'utf-8'))
      .toContain('acme/other');
  });

  it('refuses when every candidate destination names another source', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const plain = plainDir(parent, 'svc', 'plain');
    await importDir(plain, wikiRoot);

    const b = plainDir(parent, 'other', 'second');
    for (const candidate of [`svc-${hash8(b)}`, `svc-${sha256(b)}`]) {
      const dir = path.join(wikiRoot, 'evidence', 'code', candidate);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'source-manifest.json'), JSON.stringify({ repoIdentity: 'https://github.com/acme/other' }));
    }

    await expect(importDir(b, wikiRoot))
      .rejects.toThrow('Not replacing them');
  });

  it('re-importing the same directory keeps its published slug', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const a = plainDir(parent, 'svc', 'first');

    await importDir(a, wikiRoot);
    fs.writeFileSync(path.join(a, 'svc.ts'), `export const marker = 'edited';\n`);
    await importDir(a, wikiRoot);

    expect(evidenceSlugs(wikiRoot)).toEqual(['svc']);
  });

  it('keeps evidence that names no source and publishes beside it', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    // Evidence from a release that recorded no source for a checkout without
    // an origin, with a doc curated by hand.
    const legacy = path.join(wikiRoot, 'evidence', 'code', 'svc');
    fs.mkdirSync(path.join(legacy, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'source-manifest.json'), JSON.stringify({ project: 'svc', files: [] }));
    fs.writeFileSync(path.join(legacy, 'docs', 'curated.md'), '# curated\n');
    const b = plainDir(parent, 'svc', 'second');

    await importDir(b, wikiRoot);
    fs.writeFileSync(path.join(b, 'svc.ts'), `export const marker = 'edited';\n`);
    await importDir(b, wikiRoot);

    expect(evidenceSlugs(wikiRoot)).toEqual(['svc', `svc-${hash8(b)}`].sort());
    expect(fs.readFileSync(path.join(legacy, 'docs', 'curated.md'), 'utf-8')).toBe('# curated\n');
    expect(localRootHashOf(wikiRoot, `svc-${hash8(b)}`)).toBe(sha256(b));
  });

  it('refuses a subdirectory of a repository with an origin over a checkout without one', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    await importDir(plainDir(parent, 'svc', 'plain'), wikiRoot);
    const curated = path.join(wikiRoot, 'evidence', 'code', 'svc', 'docs', 'curated.md');
    fs.mkdirSync(path.dirname(curated), { recursive: true });
    fs.writeFileSync(curated, '# curated\n');
    const repo = path.join(parent, 'mono');
    const sub = path.join(repo, 'apps', 'svc');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'svc.ts'), 'export const svc = 1;\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '--quiet');
    git('remote', 'add', 'origin', 'https://github.com/acme/mono.git');

    await expect(importDir(sub, wikiRoot)).rejects.toThrow('Not replacing it');
    expect(fs.readFileSync(curated, 'utf-8')).toBe('# curated\n');
  });

  it('a subdirectory that gains an origin re-imports over its own evidence and keeps the curated docs', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const repo = path.join(parent, 'mono');
    const sub = path.join(repo, 'apps', 'svc');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'svc.ts'), 'export const svc = 1;\n');
    execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'ignore' });
    await importDir(sub, wikiRoot);
    const curated = path.join(wikiRoot, 'evidence', 'code', 'svc', 'docs', 'curated.md');
    fs.mkdirSync(path.dirname(curated), { recursive: true });
    fs.writeFileSync(curated, '# curated\n');
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/mono.git'], { cwd: repo, stdio: 'ignore' });

    await importDir(sub, wikiRoot);

    expect(evidenceSlugs(wikiRoot)).toEqual(['svc']);
    expect(fs.readFileSync(curated, 'utf-8')).toBe('# curated\n');
    expect(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', 'svc', 'source-manifest.json'), 'utf-8')).toContain('acme/mono');
  });

  it('a suffixed subdirectory that gains an origin keeps re-importing into its suffix', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const plain = plainDir(parent, 'svc', 'plain');
    await importDir(plain, wikiRoot);
    const repo = path.join(parent, 'mono');
    const sub = path.join(repo, 'apps', 'svc');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'svc.ts'), 'export const svc = 1;\n');
    execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'ignore' });
    await importDir(sub, wikiRoot);
    const suffix = `svc-${hash8(sub)}`;
    const curated = path.join(wikiRoot, 'evidence', 'code', suffix, 'docs', 'curated.md');
    fs.mkdirSync(path.dirname(curated), { recursive: true });
    fs.writeFileSync(curated, '# curated\n');
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/mono.git'], { cwd: repo, stdio: 'ignore' });

    // The first import after gaining the origin finds the suffix by its hashed
    // root, later ones by the repository it now names.
    await importDir(sub, wikiRoot);
    fs.writeFileSync(path.join(sub, 'svc.ts'), 'export const svc = 2;\n');
    await importDir(sub, wikiRoot);

    expect(evidenceSlugs(wikiRoot)).toEqual(['svc', suffix].sort());
    expect(fs.readFileSync(curated, 'utf-8')).toBe('# curated\n');
    expect(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', suffix, 'source-manifest.json'), 'utf-8')).toContain('acme/mono');
    expect(localRootHashOf(wikiRoot, 'svc')).toBe(sha256(plain));
  });

  it('a suffixed subdirectory reports the copy an older release wrote under its directory name', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    await importDir(plainDir(parent, 'svc', 'plain'), wikiRoot);
    const repo = path.join(parent, 'mono');
    const sub = path.join(repo, 'apps', 'svc');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'svc.ts'), 'export const svc = 1;\n');
    execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'ignore' });
    await importDir(sub, wikiRoot);
    const suffix = `svc-${hash8(sub)}`;
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/mono.git'], { cwd: repo, stdio: 'ignore' });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const olderCopy = `teamwiki/evidence/code/svc/ is an older copy of teamwiki/evidence/code/${suffix}/. `
      + 'Move any curated docs you want to keep from it, then remove it.';

    // svc/ is still the other checkout's: nothing to report.
    await importDir(sub, wikiRoot);
    expect(warn).not.toHaveBeenCalled();

    // A release without suffixes imported this subdirectory into svc/.
    fs.writeFileSync(path.join(wikiRoot, 'evidence', 'code', 'svc', 'source-manifest.json'),
      JSON.stringify({ repoUrl: 'https://github.com/acme/mono.git', sourceSubdir: 'apps/svc' }));
    fs.writeFileSync(path.join(sub, 'svc.ts'), 'export const svc = 2;\n');
    await importDir(sub, wikiRoot);

    expect(warn.mock.calls).toEqual([[olderCopy]]);
    expect(evidenceSlugs(wikiRoot)).toEqual(['svc', suffix].sort());
  });
});

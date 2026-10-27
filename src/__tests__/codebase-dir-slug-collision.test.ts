import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { importLocalCheckout } from '../import-codebase.js';
import { defaultProjectSlug } from '../codebase-extract.js';

/**
 * A `--dir` slug is the checkout's basename, so `/a/svc` and `/b/svc` both
 * wrote `teamwiki/evidence/code/svc/` and the second import replaced the
 * first's evidence (#1422). The published sidecar now records the source
 * root's real path, and a same-name import whose source differs — by remote
 * identity for a repository, by real path otherwise — publishes under
 * `<slug>-<hash8(realpath)>` instead. One repository, any checkout path,
 * keeps sharing its evidence (#823).
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

function gitCheckout(parent: string, name: string, origin: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '--quiet');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(dir, `${name}.ts`), `export const ${name} = 1;\n`);
  git('add', '.');
  git('commit', '--quiet', '-m', 'init');
  return fs.realpathSync(dir);
}

function repoIdentityOf(url: string): string {
  // repoIdentity's spelling for these remotes: the sanitized URL itself.
  return url.replace(/\.git$/, '');
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

    await importLocalCheckout({ sourceDir: a, slug: 'svc', wikiRoot, skipEnrich: true });
    await importLocalCheckout({ sourceDir: b, slug: 'svc', wikiRoot, skipEnrich: true });

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

    await importLocalCheckout({ sourceDir: a, slug: 'svc', wikiRoot, skipEnrich: true });
    await importLocalCheckout({ sourceDir: b, slug: 'svc', wikiRoot, skipEnrich: true });

    expect(evidenceSlugs(wikiRoot)).toHaveLength(2);
  });

  it('one repository converges on one suffixed destination from any checkout path', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    // A plain directory occupies `svc` first, so the repository must move.
    const plain = plainDir(parent, 'svc', 'plain');
    await importLocalCheckout({ sourceDir: plain, slug: 'svc', wikiRoot, skipEnrich: true });

    const origin = 'https://github.com/acme/svc.git';
    const first = gitCheckout(parent, 'svc-repo', origin);
    const second = gitCheckout(path.join(parent, 'elsewhere'), 'svc-repo', origin);

    await importLocalCheckout({ sourceDir: first, slug: 'svc', wikiRoot, skipEnrich: true });
    await importLocalCheckout({ sourceDir: second, slug: 'svc', wikiRoot, skipEnrich: true });

    // Both paths of the same repository publish to one suffixed directory,
    // and it is not the plain directory's.
    const slugs = evidenceSlugs(wikiRoot);
    expect(slugs).toHaveLength(2);
    expect(slugs).toContain('svc');
    const suffixed = slugs.find((s) => s !== 'svc')!;
    const manifest = JSON.parse(fs.readFileSync(path.join(wikiRoot, 'evidence', 'code', suffixed, 'source-manifest.json'), 'utf-8'));
    expect(manifest.repoIdentity).toBe(repoIdentityOf(origin));
  });
  it('a suffixed destination naming another source is not reused', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const plain = plainDir(parent, 'svc', 'plain');
    await importLocalCheckout({ sourceDir: plain, slug: 'svc', wikiRoot, skipEnrich: true });

    const b = plainDir(parent, 'other', 'second');
    const staged = `svc-${hash8(b)}`;
    // Stage the suffixed destination as already held by a different source —
    // the same checkout path resolving to another machine's repository.
    fs.mkdirSync(path.join(wikiRoot, 'evidence', 'code', staged), { recursive: true });
    fs.writeFileSync(
      path.join(wikiRoot, 'evidence', 'code', staged, 'source-manifest.json'),
      JSON.stringify({ repoIdentity: 'https://github.com/acme/other' }),
    );

    await importLocalCheckout({ sourceDir: b, slug: 'svc', wikiRoot, skipEnrich: true });

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
    await importLocalCheckout({ sourceDir: plain, slug: 'svc', wikiRoot, skipEnrich: true });

    const b = plainDir(parent, 'other', 'second');
    for (const candidate of [`svc-${hash8(b)}`, `svc-${sha256(b)}`]) {
      const dir = path.join(wikiRoot, 'evidence', 'code', candidate);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'source-manifest.json'), JSON.stringify({ repoIdentity: 'https://github.com/acme/other' }));
    }

    await expect(importLocalCheckout({ sourceDir: b, slug: 'svc', wikiRoot, skipEnrich: true }))
      .rejects.toThrow('not replacing it (#1422)');
  });

  it('re-importing the same directory keeps its published slug', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const a = plainDir(parent, 'svc', 'first');

    await importLocalCheckout({ sourceDir: a, slug: 'svc', wikiRoot, skipEnrich: true });
    fs.writeFileSync(path.join(a, 'svc.ts'), `export const marker = 'edited';\n`);
    await importLocalCheckout({ sourceDir: a, slug: 'svc', wikiRoot, skipEnrich: true });

    expect(evidenceSlugs(wikiRoot)).toEqual(['svc']);
  });

  it('one repository keeps one evidence directory from any checkout path (#823)', async () => {
    const parent = temp('teamai-1422-dir-');
    const wikiRoot = path.join(temp('teamai-1422-wiki-'), 'teamwiki');
    const first = gitCheckout(parent, 'svc', 'https://github.com/acme/svc.git');
    const second = gitCheckout(path.join(parent, 'elsewhere'), 'svc', 'https://github.com/acme/svc.git');

    const slug = await defaultProjectSlug(first);
    await importLocalCheckout({ sourceDir: first, slug, wikiRoot, skipEnrich: true });
    await importLocalCheckout({ sourceDir: second, slug: await defaultProjectSlug(second), wikiRoot, skipEnrich: true });

    expect(slug).toBe('svc');
    expect(evidenceSlugs(wikiRoot)).toEqual(['svc']);
  });
});

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { annotateCodebaseSourceFreshness } from '../codebase-freshness.js';
import type { CodebaseFreshnessResult } from '../codebase-freshness.js';
import { repoIdentity } from '../utils/git.js';

const roots: string[] = [];
const REPO_URL = 'https://github.com/acme/orders.git';
const LAST_SCAN = '2026-10-09T10:11:12.000Z';

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(url = REPO_URL): string {
  const root = tempRoot('teamai-freshness-repo-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'export const token = "v1";\n');
  runGit(root, ['init', '--quiet']);
  runGit(root, ['remote', 'add', 'origin', url]);
  return root;
}

function createWiki(slugs = ['github__acme__orders']): string {
  const wiki = tempRoot('teamai-freshness-wiki-');
  for (const slug of slugs) {
    const dir = path.join(wiki, 'evidence', 'code', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'overview.md'), `---\ntitle: ${slug}\nsource: [src/auth.ts]\n---\n\nAuth details.\n`);
  }
  return wiki;
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeManifest(
  wiki: string,
  slug: string,
  options: {
    url?: string;
    project?: string;
    sourceSubdir?: string;
    content?: string;
    files?: Array<{ relativePath: string; sha256: string }>;
  } = {},
): void {
  const content = options.content ?? fs.readFileSync(path.join(roots.find((root) => root.includes('freshness-repo-'))!, 'src', 'auth.ts'), 'utf8');
  const manifest = {
    project: options.project ?? slug,
    repoIdentity: repoIdentity(options.url ?? REPO_URL),
    sourceSubdir: options.sourceSubdir ?? '',
    lastScan: LAST_SCAN,
    headSha: 'a'.repeat(40),
    files: options.files ?? [{ relativePath: 'src/auth.ts', sha256: sha(content) }],
  };
  fs.writeFileSync(
    path.join(wiki, 'evidence', 'code', slug, 'source-manifest.json'),
    JSON.stringify(manifest),
  );
}

function result(slug = 'github__acme__orders', sourcePath = 'src/auth.ts'): CodebaseFreshnessResult {
  return {
    entry: { filename: `evidence/code/${slug}/overview.md` },
    fromCodebase: true,
    sources: [{ path: sourcePath }],
  };
}

async function freshness(
  wiki: string,
  repo: string,
  target = result(),
): Promise<{ freshness?: string; lastScan?: string }> {
  await annotateCodebaseSourceFreshness([target], wiki, repo);
  const source = target.sources?.[0];
  return {
    ...(source?.freshness ? { freshness: source.freshness } : {}),
    ...(source?.lastScan ? { lastScan: source.lastScan } : {}),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('codebase recall source freshness', () => {
  it('marks matching decoded content current even when HEAD differs and unrelated files change', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    const slug = 'github__acme__orders';
    writeManifest(wiki, slug);
    fs.writeFileSync(path.join(repo, 'src', 'unrelated.ts'), 'export const unrelated = true;\n');

    const source = await freshness(wiki, repo);

    expect(source).toEqual({ freshness: 'current', lastScan: LAST_SCAN });
  });

  it('marks uncommitted source edits stale by comparing file content, independent of HEAD', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders');
    fs.writeFileSync(path.join(repo, 'src', 'auth.ts'), 'export const token = "uncommitted";\n');

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'stale', lastScan: LAST_SCAN });
  });

  it('marks a source missing only when the path is safely absent in the matching repository', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders');
    fs.rmSync(path.join(repo, 'src', 'auth.ts'));

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'missing', lastScan: LAST_SCAN });
  });

  it('leaves an absent anchor unknown when the baseline does not prove that file existed', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders', { files: [] });
    fs.rmSync(path.join(repo, 'src', 'auth.ts'));

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('returns unknown when the manifest belongs to another repository', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders', { url: 'https://github.com/other/orders.git' });

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('requires the same host and port even when repository paths match', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders', { url: 'https://github.com:8443/acme/orders.git' });

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it.each(['.env', 'credentials.json', '.git/config'])('never hashes ignored anchor %s even with a valid baseline hash', async (relativePath) => {
    const repo = createRepo();
    const wiki = createWiki();
    const sourcePath = path.join(repo, ...relativePath.split('/'));
    if (relativePath !== '.git/config') {
      fs.writeFileSync(sourcePath, `sensitive test content for ${relativePath}\n`);
    }
    const content = fs.readFileSync(sourcePath, 'utf8');
    writeManifest(wiki, 'github__acme__orders', {
      files: [{ relativePath, sha256: sha(content) }],
    });

    expect(await freshness(wiki, repo, result('github__acme__orders', relativePath)))
      .toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('checks a source relative to a verified monorepo subdirectory', async () => {
    const repo = createRepo();
    const source = 'export const nested = "api";\n';
    const nestedSource = path.join(repo, 'packages', 'api', 'src');
    fs.mkdirSync(nestedSource, { recursive: true });
    fs.writeFileSync(path.join(nestedSource, 'auth.ts'), source);
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders', {
      content: source,
      sourceSubdir: 'packages/api',
      files: [{ relativePath: 'src/auth.ts', sha256: sha(source) }],
    });

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'current', lastScan: LAST_SCAN });
  });

  it('does not apply a legacy root manifest to one repo in a multi-repo wiki', async () => {
    const repo = createRepo();
    const wiki = createWiki(['github__acme__orders', 'github__acme__payments']);
    const legacyRoot = {
      project: 'github__acme__orders',
      repoIdentity: repoIdentity(REPO_URL),
      sourceSubdir: '',
      lastScan: LAST_SCAN,
      files: [{ relativePath: 'src/auth.ts', sha256: sha('export const token = "v1";\n') }],
    };
    fs.writeFileSync(path.join(wiki, 'source-manifest.json'), JSON.stringify(legacyRoot));

    expect(await freshness(wiki, repo, result('github__acme__payments')))
      .toEqual({ freshness: 'unknown' });
  });

  it('uses the codebase-local baseline when the shared root manifest was replaced by another repo', async () => {
    const repo = createRepo();
    const wiki = createWiki(['github__acme__orders', 'github__acme__payments']);
    writeManifest(wiki, 'github__acme__orders');
    fs.writeFileSync(path.join(wiki, 'source-manifest.json'), JSON.stringify({
      project: 'github__acme__payments',
      repoIdentity: repoIdentity(REPO_URL),
      sourceSubdir: '',
      lastScan: LAST_SCAN,
      files: [{ relativePath: 'src/auth.ts', sha256: sha('different baseline') }],
    }));

    expect(await freshness(wiki, repo, result('github__acme__orders')))
      .toEqual({ freshness: 'current', lastScan: LAST_SCAN });
  });

  it('leaves legacy metadata without source-root provenance unknown', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    fs.writeFileSync(path.join(wiki, 'source-manifest.json'), JSON.stringify({
      repoUrl: REPO_URL,
      lastScan: LAST_SCAN,
      files: [{ relativePath: 'src/auth.ts', sha256: sha('export const token = "v1";\n') }],
    }));

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('shows unknown when the source baseline cannot be read', async () => {
    const repo = createRepo();
    const absentWiki = path.join(tempRoot('teamai-freshness-absent-wiki-'), 'teamwiki');

    expect(await freshness(absentWiki, repo)).toEqual({ freshness: 'unknown' });
  });

  it('returns unknown for traversal paths', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders');

    expect(await freshness(wiki, repo, result('github__acme__orders', '../outside.ts')))
      .toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('returns unknown for source symlinks that escape the repository', async ({ skip }) => {
    const repo = createRepo();
    const outside = path.join(tempRoot('teamai-freshness-outside-'), 'auth.ts');
    fs.writeFileSync(outside, 'export const token = "outside";\n');
    const link = path.join(repo, 'src', 'escape.ts');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch {
      skip();
      return;
    }
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders', {
      files: [{ relativePath: 'src/escape.ts', sha256: sha('export const token = "outside";\n') }],
    });

    expect(await freshness(wiki, repo, result('github__acme__orders', 'src/escape.ts')))
      .toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('returns unknown for directory junctions that escape the repository', async ({ skip }) => {
    const repo = createRepo();
    const outside = tempRoot('teamai-freshness-junction-outside-');
    fs.writeFileSync(path.join(outside, 'auth.ts'), 'export const token = "outside";\n');
    const link = path.join(repo, 'src', 'escape');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      skip();
      return;
    }
    const wiki = createWiki();
    writeManifest(wiki, 'github__acme__orders', {
      files: [{ relativePath: 'src/escape/auth.ts', sha256: sha('export const token = "outside";\n') }],
    });

    expect(await freshness(wiki, repo, result('github__acme__orders', 'src/escape/auth.ts')))
      .toEqual({ freshness: 'unknown', lastScan: LAST_SCAN });
  });

  it('uses the collector UTF-8 decoding semantics for malformed byte sequences', async () => {
    const repo = createRepo();
    const wiki = createWiki();
    const file = path.join(repo, 'src', 'auth.ts');
    fs.writeFileSync(file, Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
    writeManifest(wiki, 'github__acme__orders', {
      content: fs.readFileSync(file, 'utf8'),
    });

    expect(await freshness(wiki, repo)).toEqual({ freshness: 'current', lastScan: LAST_SCAN });
  });
});

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';

import { importCodebase } from '../import-codebase.js';

const { mockEnrichWithAI } = vi.hoisted(() => ({ mockEnrichWithAI: vi.fn() }));
vi.mock('../enrich-with-ai.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../enrich-with-ai.js')>();
  return { ...actual, enrichWithAI: (...args: unknown[]) => mockEnrichWithAI(...args) };
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, stdio: 'ignore' });
}

async function makeRepo(root: string, name: string, source: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.ensureDir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'main.ts'), source);
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme/${name}`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('importCodebase: the extraction every import source shares', () => {
  let root: string;
  let wikiRoot: string;
  let logs: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-codebase-'));
    wikiRoot = path.join(root, 'team-repo', 'teamwiki');
    logs = [];
    mockEnrichWithAI.mockReset();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(root);
  });

  const run = (sourceDir: string, slug: string, incremental = false, skipEnrich = true) =>
    importCodebase({ sourceDir, slug, wikiRoot, incremental, skipEnrich, repoUrl: `https://github.com/acme/${path.basename(sourceDir)}` });

  it('writes nothing into the source checkout and leaves a teamwiki already there alone', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    await fs.outputFile(path.join(repo, 'teamwiki', 'keep.md'), '# mine\n');

    expect(await run(repo, 'github__acme__svc')).toBe(true);

    expect(await fs.readdir(path.join(repo, 'teamwiki'))).toEqual(['keep.md']);
    const evidence = path.join(wikiRoot, 'evidence', 'code', 'github__acme__svc');
    expect(await fs.pathExists(path.join(evidence, 'overview.md'))).toBe(true);
    for (const file of ['graph-index.json', 'facts-cache.json', 'interfaces-cache.json']) {
      expect(await fs.pathExists(path.join(evidence, '.indices', file)), file).toBe(true);
    }
    expect((await fs.readJson(path.join(evidence, 'source-manifest.json'))).project).toBe('github__acme__svc');
  });

  it('never drops published pages on an incremental run that changes no source file', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    await run(repo, 'github__acme__svc');
    const evidence = path.join(wikiRoot, 'evidence', 'code', 'github__acme__svc');
    const before = (await fs.readdir(evidence)).sort();

    // Same commit: nothing to extract, nothing written.
    expect(await run(repo, 'github__acme__svc', true)).toBe(false);
    expect((await fs.readdir(evidence)).sort()).toEqual(before);

    // A docs-only commit re-renders the pages from the cached facts.
    await fs.writeFile(path.join(repo, 'README.md'), 'docs only\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'docs');
    await run(repo, 'github__acme__svc', true);
    expect((await fs.readdir(evidence)).sort()).toEqual(before);
    const pages = await Promise.all(before.filter((f) => f.endsWith('.md')).map((f) => fs.readFile(path.join(evidence, f), 'utf8')));
    expect(pages.join('\n')).toContain('greet');
  });

  it('extracts incrementally from the codebase\'s own baseline after another repo was imported into the same teamwiki', async () => {
    const a = await makeRepo(root, 'svc-a', 'export function originalGreeting() { return "hi"; }\n');
    const b = await makeRepo(root, 'svc-b', 'export function other() { return 1; }\n');
    await run(a, 'github__acme__svc-a');
    await run(b, 'github__acme__svc-b');
    // The shared root manifest now describes svc-b.
    expect((await fs.readJson(path.join(wikiRoot, 'source-manifest.json'))).project).toBe('github__acme__svc-b');

    await fs.writeFile(path.join(a, 'src', 'main.ts'), 'export function updatedGreeting() { return "hey"; }\n');
    git(a, 'commit', '-q', '-am', 'change');
    logs.length = 0;

    expect(await run(a, 'github__acme__svc-a', true)).toBe(true);

    expect(logs.join('\n')).toMatch(/\[extract\] incremental: 1 files changed/);
    const evidence = path.join(wikiRoot, 'evidence', 'code', 'github__acme__svc-a');
    const pages = await Promise.all((await fs.readdir(evidence)).filter((f) => f.endsWith('.md'))
      .map((f) => fs.readFile(path.join(evidence, f), 'utf8')));
    expect(pages.join('\n')).toContain('updatedGreeting');
    expect(pages.join('\n')).not.toContain('originalGreeting');
    expect(await fs.pathExists(path.join(wikiRoot, 'evidence', 'code', 'github__acme__svc-b', 'overview.md'))).toBe(true);
  });

  it('keeps curated docs and domain metadata when an import replaces the evidence', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'github__acme__svc';
    await run(repo, slug);

    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'curated.md'), '# curated\n');
    await fs.outputJson(path.join(evidence, '_domains.json'), { domain: 'Billing', keywords: ['billing'] });
    await fs.outputJson(path.join(evidence, '_review', 'progress.json'), { done: true });

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function greet() { return "hello"; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await run(repo, slug, true)).toBe(true);

    expect(await fs.readFile(path.join(evidence, 'docs', 'curated.md'), 'utf8')).toBe('# curated\n');
    expect((await fs.readJson(path.join(evidence, '_domains.json'))).domain).toBe('Billing');
    // Deep-enrich progress is reset so changed components are documented again.
    expect(await fs.pathExists(path.join(evidence, '_review', 'progress.json'))).toBe(false);
    // The generated pages are still replaced by the new extraction.
    expect(await fs.pathExists(path.join(evidence, 'overview.md'))).toBe(true);
  });

  it('drops docs for a component missing from a fallback manifest', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'github__acme__svc';
    await run(repo, slug);

    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    const manifestPath = path.join(evidence, '_manifest.json');
    const manifest = await fs.readJson(manifestPath);
    const currentSlug = manifest.components[0].slug as string;
    manifest.components.push({
      slug: 'legacy',
      docPath: `evidence/code/${slug}/legacy.md`,
      title: 'legacy',
      category: 'component',
      confidence: 'EXTRACTED',
    });
    await fs.writeJson(manifestPath, manifest);

    await fs.outputFile(path.join(evidence, 'docs', 'legacy.md'), '# legacy\n');
    await fs.outputFile(path.join(evidence, 'docs', `${currentSlug}.md`), '# current\n');
    await fs.outputFile(path.join(evidence, 'docs', 'architecture.md'), '# architecture\n');
    await fs.outputFile(path.join(evidence, 'docs', 'README.md'), '# graph routing\n');
    await fs.outputFile(path.join(evidence, 'docs', 'graph-g1-relations.md'), '# graph\n');
    await fs.outputJson(path.join(evidence, '_domains.json'), {
      domain: 'Billing',
      description: 'billing',
      keywords: ['billing', 'legacy', currentSlug],
      components: ['legacy', currentSlug],
    });

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function greet() { return "hello"; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await run(repo, slug, true)).toBe(true);

    const docs = await fs.readdir(path.join(evidence, 'docs'));
    expect(docs).not.toContain('legacy.md');
    expect(docs).not.toContain('graph-g1-relations.md');
    expect(docs).not.toContain('README.md');
    expect(docs).toContain(`${currentSlug}.md`);
    expect(docs).toContain('architecture.md');

    const domains = await fs.readJson(path.join(evidence, '_domains.json'));
    expect(domains.components).toEqual([currentSlug]);
    expect(domains.keywords).toEqual(['billing', currentSlug]);
  });

  it('drops docs for a component removed from an AI-enriched manifest', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'github__acme__svc';
    await run(repo, slug);

    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    const manifestPath = path.join(evidence, '_manifest.json');
    const manifest = await fs.readJson(manifestPath);
    const currentSlug = manifest.components[0].slug as string;
    manifest.components.push({
      slug: 'legacy',
      docPath: `evidence/code/${slug}/legacy.md`,
      title: 'legacy',
      category: 'component',
      confidence: 'EXTRACTED',
    });
    await fs.writeJson(manifestPath, manifest);

    await fs.outputFile(path.join(evidence, 'docs', 'legacy.md'), '# legacy\n');
    await fs.outputFile(path.join(evidence, 'docs', `${currentSlug}.md`), '# current\n');
    await fs.outputFile(path.join(evidence, 'docs', 'architecture.md'), '# architecture\n');
    await fs.outputFile(path.join(evidence, 'docs', 'README.md'), '# graph routing\n');
    await fs.outputFile(path.join(evidence, 'docs', 'graph-g1-relations.md'), '# graph\n');

    mockEnrichWithAI.mockResolvedValue({
      manifest: {
        schemaVersion: 'team-wiki.codebase-output-manifest.v2',
        project: slug,
        generatedAt: new Date().toISOString(),
        components: [{
          slug: currentSlug,
          docPath: `evidence/code/${slug}/${currentSlug}.md`,
          title: currentSlug,
          category: 'component',
          confidence: 'EXTRACTED',
        }],
        edges: [],
      },
      domains: [],
      repoDomain: 'Billing',
      repoDescription: 'billing',
      repoKeywords: ['billing', currentSlug],
    });

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function greet() { return "hello"; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await run(repo, slug, true, false)).toBe(true);

    const docs = await fs.readdir(path.join(evidence, 'docs'));
    expect(docs).not.toContain('legacy.md');
    expect(docs).not.toContain('graph-g1-relations.md');
    expect(docs).not.toContain('README.md');
    expect(docs).toContain(`${currentSlug}.md`);
    expect(docs).toContain('architecture.md');
  });

  it('prunes a component removed by a skipped-enrichment import', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    await fs.outputFile(path.join(repo, 'auth', 'main.ts'), 'export const auth = 1;\n');
    await fs.outputFile(path.join(repo, 'billing', 'main.ts'), 'export const billing = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'modules');

    const slug = 'github__acme__svc';
    await run(repo, slug);
    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'auth.md'), '# auth\n');
    await fs.outputFile(path.join(evidence, 'docs', 'billing.md'), '# billing\n');

    // The daily static import sees auth/ and src/; billing/ is gone.
    await fs.remove(path.join(repo, 'billing'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'remove billing');
    expect(await run(repo, slug, true)).toBe(true);

    expect(await fs.pathExists(path.join(evidence, 'docs', 'auth.md'))).toBe(true);
    expect(await fs.pathExists(path.join(evidence, 'docs', 'billing.md'))).toBe(false);
  });

  it('does not carry curated docs from a different repo that shares the slug', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'github__acme__svc';
    await run(repo, slug);

    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'curated.md'), '# curated\n');

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function other() { return 1; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await importCodebase({
      sourceDir: repo,
      slug,
      wikiRoot,
      incremental: true,
      skipEnrich: true,
      repoUrl: 'https://github.com/acme/another-repo',
    })).toBe(true);

    expect(await fs.pathExists(path.join(evidence, 'docs', 'curated.md'))).toBe(false);
  });

  it('keeps curated docs when older evidence has no sidecar and the slug names the repo', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'github__acme__svc';
    await run(repo, slug);
    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'curated.md'), '# curated\n');
    await fs.remove(path.join(evidence, 'source-manifest.json'));

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function greet() { return "hello"; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await run(repo, slug, true)).toBe(true);

    expect(await fs.pathExists(path.join(evidence, 'docs', 'curated.md'))).toBe(true);
  });

  it('does not carry curated docs for a bare slug when older evidence has no sidecar', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'svc';
    const repoUrl = 'https://github.com/acme/svc';
    await importCodebase({ sourceDir: repo, slug, wikiRoot, skipEnrich: true, repoUrl });
    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'curated.md'), '# curated\n');
    await fs.remove(path.join(evidence, 'source-manifest.json'));

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function greet() { return "hello"; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await importCodebase({ sourceDir: repo, slug, wikiRoot, incremental: true, skipEnrich: true, repoUrl })).toBe(true);

    expect(await fs.pathExists(path.join(evidence, 'docs', 'curated.md'))).toBe(false);
  });

  it('treats the same repo with and without .git as the same identity', async () => {
    const repo = await makeRepo(root, 'svc', 'export function greet() { return "hi"; }\n');
    const slug = 'github__acme__svc';
    await run(repo, slug);
    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'curated.md'), '# curated\n');

    await fs.writeFile(path.join(repo, 'src', 'main.ts'), 'export function greet() { return "hello"; }\n');
    git(repo, 'commit', '-q', '-am', 'change');
    expect(await importCodebase({
      sourceDir: repo,
      slug,
      wikiRoot,
      incremental: true,
      skipEnrich: true,
      repoUrl: 'https://github.com/acme/svc.git',
    })).toBe(true);

    expect(await fs.pathExists(path.join(evidence, 'docs', 'curated.md'))).toBe(true);
  });

  it('does not carry curated docs between remote-less checkouts that share a slug', async () => {
    const first = await makeRepo(root, 'first-svc', 'export function one() { return 1; }\n');
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: first, stdio: 'ignore' });
    const slug = 'svc';
    await importCodebase({ sourceDir: first, slug, wikiRoot, skipEnrich: true });
    const evidence = path.join(wikiRoot, 'evidence', 'code', slug);
    await fs.outputFile(path.join(evidence, 'docs', 'curated.md'), '# curated\n');

    const second = await makeRepo(root, 'second-svc', 'export function two() { return 2; }\n');
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: second, stdio: 'ignore' });
    await importCodebase({ sourceDir: second, slug, wikiRoot, skipEnrich: true });

    expect(await fs.pathExists(path.join(evidence, 'docs', 'curated.md'))).toBe(false);
  });
});

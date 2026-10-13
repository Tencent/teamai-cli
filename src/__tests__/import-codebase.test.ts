import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';

import { importCodebase } from '../import-codebase.js';

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
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(root);
  });

  const run = (sourceDir: string, slug: string, incremental = false) =>
    importCodebase({ sourceDir, slug, wikiRoot, incremental, skipEnrich: true, repoUrl: `https://github.com/acme/${path.basename(sourceDir)}` });

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
});

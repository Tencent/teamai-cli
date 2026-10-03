/**
 * `queryCodeKnowledge`'s `withheldCodebases` (#912): a codebase slug under
 * `teamwiki/evidence/code/<slug>/` that a role or project declared but did not
 * activate must not surface in recall, the same way an inactive docs namespace
 * never reaches the search index.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryCodeKnowledge } from '../code-knowledge-recall.js';

let wikiRoot: string;

function page(project: string, file: string, content: string): void {
  const dir = path.join(wikiRoot, 'evidence', 'code', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, 'utf-8');
}

beforeEach(() => {
  wikiRoot = mkdtempSync(path.join(os.tmpdir(), 'teamai-wiki-scope-'));
  page('svc-a', 'overview.md', '---\ntitle: Svc A overview\n---\n\nnarwhal contract details for svc-a.\n');
  page('svc-b', 'overview.md', '---\ntitle: Svc B overview\n---\n\nnarwhal contract details for svc-b.\n');
});

afterEach(() => {
  rmSync(wikiRoot, { recursive: true, force: true });
});

describe('queryCodeKnowledge: withheldCodebases', () => {
  it('returns pages from every codebase when nothing is withheld, as before', async () => {
    const results = await queryCodeKnowledge('narwhal', { wikiRoot, depth: 'lookup', limit: 10 });

    const pages = results.map((r) => r.page).sort();
    expect(pages).toEqual(['evidence/code/svc-a/overview.md', 'evidence/code/svc-b/overview.md']);
  });

  it('excludes a withheld codebase slug, keeping the others', async () => {
    const results = await queryCodeKnowledge('narwhal', {
      wikiRoot, depth: 'lookup', limit: 10, withheldCodebases: ['svc-b'],
    });

    const pages = results.map((r) => r.page);
    expect(pages).toEqual(['evidence/code/svc-a/overview.md']);
  });

  it('matches a withheld slug case-foldedly, as evidence/code/<slug>/ does on a case-insensitive filesystem', async () => {
    const results = await queryCodeKnowledge('narwhal', {
      wikiRoot, depth: 'lookup', limit: 10, withheldCodebases: ['SVC-B'],
    });

    const pages = results.map((r) => r.page);
    expect(pages).toEqual(['evidence/code/svc-a/overview.md']);
  });

  it('withholds every listed codebase when more than one is inactive', async () => {
    page('svc-c', 'overview.md', '---\ntitle: Svc C overview\n---\n\nnarwhal contract details for svc-c.\n');

    const results = await queryCodeKnowledge('narwhal', {
      wikiRoot, depth: 'lookup', limit: 10, withheldCodebases: ['svc-b', 'svc-c'],
    });

    const pages = results.map((r) => r.page);
    expect(pages).toEqual(['evidence/code/svc-a/overview.md']);
  });
});

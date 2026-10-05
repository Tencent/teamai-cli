/**
 * `queryCodeKnowledge`'s `withheldCodebases` (#912): a codebase slug under
 * `teamwiki/evidence/code/<slug>/` that a role or project declared but did not
 * activate must not surface in recall, the same way an inactive docs namespace
 * never reaches the search index.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryCodeKnowledge } from '../code-knowledge-recall.js';
import { aggregateGlobalGraph } from '../graph-aggregate.js';

let wikiRoot: string;

function page(project: string, file: string, content: string): void {
  const dir = path.join(wikiRoot, 'evidence', 'code', project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, 'utf-8');
}

function repoGraph(project: string, graph: object): void {
  const dir = path.join(wikiRoot, 'evidence', 'code', project, '.indices');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'graph-index.json'), JSON.stringify(graph), 'utf-8');
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

  describe('route depth: router.md', () => {
    function router(content: string): void {
      writeFileSync(path.join(wikiRoot, 'router.md'), content, 'utf-8');
    }

    it('strips a withheld codebase\'s name, link, description and keywords from router.md', async () => {
      router(
        '# Team Wiki Router\n'
        + '<!-- search-anchor: svc-a, svc-b, payments-ledger -->\n\n'
        + '## 项目域入口\n\n'
        + '- [[evidence/code/svc-a/index]] — Svc A desc [alpha]\n'
        + '- [[evidence/code/svc-b/index]] — Svc B desc [payments-ledger]\n',
      );

      const [result] = await queryCodeKnowledge('router', {
        wikiRoot, depth: 'route', withheldCodebases: ['svc-b'],
      });
      expect(result.snippet).toContain('svc-a');
      expect(result.snippet).not.toContain('svc-b');
      expect(result.snippet).not.toContain('payments-ledger');
    });

    it('returns router.md unfiltered when nothing is withheld, as before', async () => {
      router('# Team Wiki Router\n\n- [[evidence/code/svc-b/index]] — Svc B desc\n');
      const [result] = await queryCodeKnowledge('router', { wikiRoot, depth: 'route' });
      expect(result.snippet).toContain('svc-b');
    });
  });

  describe('graph scoping (#912 follow-up): a withheld codebase must not reach recall through the knowledge graph', () => {
    beforeEach(() => {
      // An svc-a file depends on a file whose basename-derived PascalCase
      // matches a component title declared only in svc-b — the same
      // cross-repo edge detection exercised by graph-aggregate.test.ts.
      page('svc-a', 'overview.md', '---\ntitle: Svc A overview\nsource: a/client\n---\n\nnarwhal contract details for svc-a.\n');
      repoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/client', title: 'BalanceClient', type: 'component', confidence: 'EXTRACTED' }],
        edges: [{ from: 'a/client', to: 'libs/balance_service.py', relation: 'imports' }],
      });
      repoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/service', title: 'BalanceService', type: 'component', confidence: 'EXTRACTED' }],
        edges: [],
      });
    });

    it('surfaces a cross-codebase relatedFile when nothing is withheld, as before', async () => {
      await aggregateGlobalGraph(wikiRoot);
      const results = await queryCodeKnowledge('narwhal', { wikiRoot, depth: 'lookup', limit: 10 });
      const svcA = results.find((r) => r.page === 'evidence/code/svc-a/overview.md');
      expect(svcA?.relatedFiles).toContain('b/service');
    });

    it('never surfaces a withheld codebase\'s node as a relatedFile, even via a cross-codebase graph edge', async () => {
      await aggregateGlobalGraph(wikiRoot);
      const results = await queryCodeKnowledge('narwhal', {
        wikiRoot, depth: 'lookup', limit: 10, withheldCodebases: ['svc-b'],
      });
      const svcA = results.find((r) => r.page === 'evidence/code/svc-a/overview.md');
      expect(svcA?.relatedFiles ?? []).not.toContain('b/service');
    });

    it('preserves a global-only forward edge (the kind --reconcile adds directly to the global graph) when the withheld codebase is unrelated to it', async () => {
      await aggregateGlobalGraph(wikiRoot);
      const globalPath = path.join(wikiRoot, '.indices', 'graph-index.json');
      const global = JSON.parse(readFileSync(globalPath, 'utf-8'));
      global.nodes.push({ slug: 'docs/product/billing', title: 'Billing product page', type: 'architecture', confidence: 'EXTRACTED' });
      global.edges.push({ from: 'a/client', to: 'docs/product/billing', relation: 'MAPS_TO' });
      writeFileSync(globalPath, JSON.stringify(global), 'utf-8');

      const results = await queryCodeKnowledge('narwhal', {
        wikiRoot, depth: 'lookup', limit: 10, withheldCodebases: ['svc-b'],
      });
      const svcA = results.find((r) => r.page === 'evidence/code/svc-a/overview.md');
      expect(svcA?.relatedFiles).toContain('docs/product/billing');
      expect(svcA?.relatedFiles).not.toContain('b/service');
    });
  });

  describe('route depth: router.md table-row format (rebuildWikiIndex, #912 review round 2)', () => {
    it('strips a withheld codebase\'s table row, generated by rebuildWikiIndex\'s [[code/<slug>/index]] link format', async () => {
      writeFileSync(
        path.join(wikiRoot, 'router.md'),
        '# Team Wiki Router\n\n'
        + '| 域 | 入口 | 核心职责 | 路由关键词 |\n'
        + '|---|---|---|---|\n'
        + '| 计费 | [[code/svc-a/index]] | Svc A duty | alpha |\n'
        + '| 计费 | [[code/svc-b/index]] | Svc B duty | payments-ledger |\n',
        'utf-8',
      );

      const [result] = await queryCodeKnowledge('router', {
        wikiRoot, depth: 'route', withheldCodebases: ['svc-b'],
      });
      expect(result.snippet).toContain('svc-a');
      expect(result.snippet).not.toContain('svc-b');
      expect(result.snippet).not.toContain('payments-ledger');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DeepEnrich } from '../deep-enrich.js';

const AST_GRAPH = {
  schemaVersion: 'team-wiki.graph-index.v1',
  generatedAt: '2026-01-01T00:00:00Z',
  nodes: [
    { slug: 'component/A', type: 'component', confidence: 'EXTRACTED', title: 'A' },
    { slug: 'component/B', type: 'component', confidence: 'EXTRACTED', title: 'B' },
  ],
  edges: [
    { from: 'a.ts', to: 'b.ts', relation: 'DEPENDS_ON', source: 'code-ast', weight: 0.9 },
    { from: 'a.ts', to: 'c.ts', relation: 'REFERENCES', source: 'code-heuristic', weight: 0.8 },
  ],
};

const MANIFEST = {
  schemaVersion: 'team-wiki.codebase-output-manifest.v2',
  project: 'faketest',
  generatedAt: '2026-01-01T00:00:00Z',
  components: [
    {
      slug: 'A',
      docPath: 'evidence/code/faketest/A.md',
      title: 'A',
      category: 'component',
      confidence: 'INFERRED',
      responsibilities: [],
      entrypoints: [],
    },
  ],
  edges: [],
};

function astCount(g: { edges: Array<{ source?: string }> }): number {
  return g.edges.filter((e) => e.source === 'code-ast').length;
}

describe('deep enrich preserves per-repo graph-index.json (AST edges)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'de-graph-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not mutate evidence/.indices/graph-index.json across every step of a deep-enrich run', async () => {
    const wikiRoot = path.join(root, 'teamwiki');
    const evidenceDir = path.join(wikiRoot, 'evidence', 'code', 'faketest');
    const idxDir = path.join(evidenceDir, '.indices');
    await mkdir(idxDir, { recursive: true });
    const graphPath = path.join(idxDir, 'graph-index.json');
    await writeFile(graphPath, JSON.stringify(AST_GRAPH, null, 2));
    await writeFile(path.join(evidenceDir, '_manifest.json'), JSON.stringify(MANIFEST, null, 2));

    const before = JSON.parse(await readFile(graphPath, 'utf8'));
    expect(before.edges).toHaveLength(2);
    expect(astCount(before)).toBe(1);

    // The steps of teamai-codebase-deep-enrich, with the tool answering nothing.
    const target = { project: 'faketest', wikiRoot };
    const unavailable = { text: '', failure: 'AI unavailable' };
    const planned = await DeepEnrich.plan(target);

    for (const component of planned?.components ?? []) await DeepEnrich.write(target, { kind: 'component', slug: component.slug }, unavailable);

    if (planned?.architecture.needed) await DeepEnrich.write(target, { kind: 'architecture' }, unavailable);
    await DeepEnrich.graph(target);
    await DeepEnrich.finish(target, unavailable);

    const after = JSON.parse(await readFile(graphPath, 'utf8'));
    // The per-repo graph must be untouched by enrichment.
    expect(after.edges).toHaveLength(2);
    expect(astCount(after)).toBe(1);
  });
});

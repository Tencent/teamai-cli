// -*- coding: utf-8 -*-
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reconcileIwikiWithCodebase } from '../import-iwiki.js';
import { aggregateGlobalGraph, scopeGlobalGraph } from '../graph-aggregate.js';

const temporaryDirectories: string[] = [];

function makeWikiRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-iwiki-reconcile-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'teamwiki'), { recursive: true });
  return path.join(root, 'teamwiki');
}

function writeRepoGraph(teamwikiRoot: string, slug: string, graph: object): void {
  const dir = path.join(teamwikiRoot, 'evidence', 'code', slug, '.indices');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'graph-index.json'), JSON.stringify(graph));
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('reconcileIwikiWithCodebase: direct-match MAPS_TO edges (#974 review round 16 P1)', () => {
  it("tags a direct-match edge with the matched node's own origin, not left untagged", async () => {
    const teamwikiRoot = makeWikiRoot();
    writeRepoGraph(teamwikiRoot, 'svc-b', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [{ slug: 'component/App', title: 'App', type: 'component', confidence: 'high' }],
      edges: [],
    });
    await aggregateGlobalGraph(teamwikiRoot);

    const edges = await reconcileIwikiWithCodebase(
      [{ docid: '1', title: 'Doc', content: 'See the `App` component for details.', url: 'https://example.com/1' }],
      teamwikiRoot,
    );

    const directMatch = edges.find((e) => e.to === 'component/App');
    expect(directMatch).toBeDefined();
    expect(directMatch?.origin).toBe('svc-b');
  });

  it("scopeGlobalGraph removes the persisted, origin-tagged edge once that codebase is withheld — even after its matched node is later reattributed to an allowed repo by a slug collision", async () => {
    const teamwikiRoot = makeWikiRoot();
    writeRepoGraph(teamwikiRoot, 'svc-b', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [{ slug: 'component/App', title: 'App', type: 'component', confidence: 'high' }],
      edges: [],
    });
    await aggregateGlobalGraph(teamwikiRoot);

    // `reconcileIwikiWithCodebase` persists its own edges directly to the
    // global graph file — at this point `component/App` is unambiguously
    // svc-b's, so that's what the edge gets tagged with.
    await reconcileIwikiWithCodebase(
      [{ docid: '1', title: 'Doc', content: 'See the `App` component for details.', url: 'https://example.com/1' }],
      teamwikiRoot,
    );

    // Simulate a LATER collision reattributing the NODE (not re-running
    // aggregateGlobalGraph, which would also wipe the iwiki edge just
    // persisted — it never lived in any per-repo file to be re-discovered).
    // svc-c independently claims the identical unqualified slug.
    const graphPath = path.join(teamwikiRoot, '.indices', 'graph-index.json');
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    const appNode = graph.nodes.find((n: { slug: string }) => n.slug === 'component/App');
    appNode.origin = 'svc-c';
    appNode.title = 'UnrelatedApp';
    fs.writeFileSync(graphPath, JSON.stringify(graph));
    writeRepoGraph(teamwikiRoot, 'svc-c', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [{ slug: 'component/App', title: 'UnrelatedApp', type: 'component', confidence: 'high' }],
      edges: [],
    });

    const scoped = await scopeGlobalGraph(teamwikiRoot, new Set(['svc-b']));
    // The node survives — svc-c (allowed) now owns that slug.
    expect(scoped?.nodes.map((n) => n.slug)).toContain('component/App');
    // But the MAPS_TO edge, tagged with svc-b's origin at the moment it
    // was created, must not survive just because the node it points at
    // was later reattributed.
    expect(scoped?.edges ?? []).not.toContainEqual(expect.objectContaining({ to: 'component/App', relation: 'MAPS_TO' }));
  });
});

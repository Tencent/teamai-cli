// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { aggregateGlobalGraph, scopeGlobalGraph } from '../graph-aggregate.js';

describe('aggregateGlobalGraph', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-agg-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  function writeRepoGraph(slug: string, graph: object): void {
    const dir = path.join(tmpDir, 'evidence', 'code', slug, '.indices');
    fs.ensureDirSync(dir);
    fs.writeFileSync(path.join(dir, 'graph-index.json'), JSON.stringify(graph));
  }

  it('merges multiple per-repo graphs into global', async () => {
    writeRepoGraph('repo-a', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [
        { slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' },
      ],
      edges: [],
    });
    writeRepoGraph('repo-b', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [
        { slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' },
      ],
      edges: [],
    });

    const result = await aggregateGlobalGraph(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.nodes).toBe(2);
    expect(result!.edges).toBe(0);

    const globalPath = path.join(tmpDir, '.indices', 'graph-index.json');
    expect(await fs.pathExists(globalPath)).toBe(true);
    const global = JSON.parse(await fs.readFile(globalPath, 'utf8'));
    expect(global.nodes).toHaveLength(2);
  });

  it('detects cross-repo edges via matching titles', async () => {
    writeRepoGraph('repo-a', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [
        { slug: 'a/client', title: 'BalanceClient', type: 'component', confidence: 'high' },
      ],
      edges: [
        { from: 'a/client', to: 'libs/balance_service.py', relation: 'imports' },
      ],
    });
    writeRepoGraph('repo-b', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [
        { slug: 'b/service', title: 'BalanceService', type: 'component', confidence: 'high' },
      ],
      edges: [],
    });

    const result = await aggregateGlobalGraph(tmpDir);
    expect(result!.edges).toBeGreaterThan(0);

    const global = JSON.parse(await fs.readFile(
      path.join(tmpDir, '.indices', 'graph-index.json'), 'utf8',
    ));
    const crossEdges = global.edges.filter((e: { relation: string }) => e.relation === 'DEPENDS_ON');
    expect(crossEdges.length).toBeGreaterThan(0);
  });

  it('does NOT create false cross-repo edges from intra-repo imports (P1 regression)', async () => {
    // repo-a has an internal import: component→module within the same repo
    writeRepoGraph('repo-a', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [
        { slug: 'a/handler', title: 'RequestHandler', type: 'component', confidence: 'high' },
        { slug: 'a/utils', title: 'RequestUtils', type: 'component', confidence: 'high' },
      ],
      edges: [
        { from: 'a/handler', to: 'src/request_utils.py', relation: 'imports' },
      ],
    });
    // repo-b has no shared names with repo-a
    writeRepoGraph('repo-b', {
      schemaVersion: 1, generatedAt: '2026-01-01',
      nodes: [
        { slug: 'b/worker', title: 'BackgroundWorker', type: 'component', confidence: 'high' },
      ],
      edges: [],
    });

    await aggregateGlobalGraph(tmpDir);
    const global = JSON.parse(await fs.readFile(
      path.join(tmpDir, '.indices', 'graph-index.json'), 'utf8',
    ));
    const crossEdges = global.edges.filter((e: { relation: string }) => e.relation === 'DEPENDS_ON');
    // repo-a's internal import (RequestHandler→RequestUtils) should NOT produce
    // a cross-repo DEPENDS_ON edge because both nodes belong to the same repo
    // and detectCrossRepoEdges runs BEFORE merge (overlay doesn't match itself in existing)
    expect(crossEdges).toHaveLength(0);
  });

  it('returns null when no evidence directory exists', async () => {
    const result = await aggregateGlobalGraph(tmpDir);
    expect(result).toBeNull();
  });

  describe('scopeGlobalGraph (#912 review round 2)', () => {
    it("subtracts a withheld project's nodes and its dangling edges from the real global graph", async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' }],
        edges: [{ from: 'b/svc', to: 'b/other', relation: 'DEPENDS_ON' }],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph?.nodes.map((n: { slug: string }) => n.slug)).toEqual(['a/svc']);
      expect(graph?.edges).toHaveLength(0);
    });

    it('removes a cross-repo edge into a withheld node as a dangling edge, even though the edge only ever lived in the merged file', async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/client', title: 'BalanceClient', type: 'component', confidence: 'high' }],
        edges: [{ from: 'a/client', to: 'libs/balance_service.py', relation: 'imports' }],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/service', title: 'BalanceService', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      // Not a relation-based filter: `loadGraphIndex` normalizes the legacy
      // `imports` relation to `DEPENDS_ON` too, so the surviving, unrelated
      // import edge (a/client -> libs/balance_service.py) would false-match.
      const intoWithheld = (graph?.edges ?? []).filter((e: { to: string }) => e.to === 'b/service');
      expect(intoWithheld).toHaveLength(0);
      expect(graph?.edges).toHaveLength(1);
    });

    it("keeps content that lives only in the global file (e.g. --reconcile's MAPS_TO edges) when the withheld project is unrelated to it", async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      // Simulate `teamai codebase --reconcile`: it reads+writes the global
      // graph directly, adding a product-page node and a MAPS_TO edge that
      // never exist in any per-repo file.
      const globalPath = path.join(tmpDir, '.indices', 'graph-index.json');
      const global = JSON.parse(await fs.readFile(globalPath, 'utf8'));
      global.nodes.push({ slug: 'docs/product/billing', title: 'Billing product page', type: 'architecture', confidence: 'high' });
      global.edges.push({ from: 'docs/product/billing', to: 'a/svc', relation: 'MAPS_TO' });
      await fs.writeFile(globalPath, JSON.stringify(global));

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      const slugs = graph?.nodes.map((n: { slug: string }) => n.slug) ?? [];
      expect(slugs).toContain('docs/product/billing');
      expect(graph?.edges).toContainEqual({ from: 'docs/product/billing', to: 'a/svc', relation: 'MAPS_TO' });
    });

    it("fails closed (returns null) when a withheld codebase's per-repo graph file is missing — e.g. extracted via `teamai codebase --extract` directly, which never writes one (#912 review round 5 P1)", async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      // svc-b has evidence pages (and so is a legitimate wiki namespace) but
      // no evidence/code/svc-b/.indices/graph-index.json — simulating a
      // codebase that was extracted directly, not through `teamai import`.
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph).toBeNull();
    });

    it("does not fail closed when EVERY withheld codebase's per-repo graph file is readable, even if other (allowed) codebases have none", async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' }],
        edges: [],
      });
      // svc-c is allowed and has no per-repo graph file at all — must not
      // block scoping, since only withheld codebases need accounting for.
      fs.ensureDirSync(path.join(tmpDir, 'evidence', 'code', 'svc-c'));
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph?.nodes.map((n: { slug: string }) => n.slug)).toEqual(['a/svc']);
    });

    it("restores an allowed repo's own title/domain for a colliding slug, even when the withheld repo's version won the merge (#912 review round 6 P1)", async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'component/App', title: 'AppA', domain: 'svc-a', type: 'component', confidence: 'high' }],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'component/App', title: 'AppB', domain: 'svc-b', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      // mergeGraphs lets the later-processed repo's node win outright; force
      // the deterministic outcome where the WITHHELD repo's version is the
      // one that survived the merge, regardless of actual readdir order.
      const globalPath = path.join(tmpDir, '.indices', 'graph-index.json');
      const global = JSON.parse(await fs.readFile(globalPath, 'utf8'));
      const node = global.nodes.find((n: { slug: string }) => n.slug === 'component/App');
      node.title = 'AppB';
      node.domain = 'svc-b';
      await fs.writeFile(globalPath, JSON.stringify(global));

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      const survivor = graph?.nodes.find((n: { slug: string }) => n.slug === 'component/App') as { title?: string; domain?: string } | undefined;
      expect(survivor?.title).toBe('AppA');
      expect(survivor?.domain).toBe('svc-a');
    });

    it('subtracts a withheld-only edge by its exact relation, keeping an allowed edge between the same two colliding endpoints under a different relation (#912 review round 6 P2)', async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [
          { slug: 'component/App', title: 'AppA', type: 'component', confidence: 'high' },
          { slug: 'component/Config', title: 'ConfigA', type: 'config', confidence: 'high' },
        ],
        edges: [{ from: 'component/App', to: 'component/Config', relation: 'REFERENCES' }],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [
          { slug: 'component/App', title: 'AppB', type: 'component', confidence: 'high' },
          { slug: 'component/Config', title: 'ConfigB', type: 'config', confidence: 'high' },
        ],
        edges: [{ from: 'component/App', to: 'component/Config', relation: 'DEPENDS_ON' }],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      const betweenAppAndConfig = (graph?.edges ?? []).filter(
        (e: { from: string; to: string }) => e.from === 'component/App' && e.to === 'component/Config',
      );
      expect(betweenAppAndConfig.map((e: { relation: string }) => e.relation)).toEqual(['REFERENCES']);
    });

    it("subtracts an edge that only exists in the withheld repo's own graph, even when both endpoint names collide with an allowed repo's (#912 review round 5 P2)", async () => {
      // svc-a and svc-b both define component/App and component/Config
      // (unqualified slugs collide across repos), but only svc-b's graph
      // has an edge directly between them.
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [
          { slug: 'component/App', title: 'AppA', type: 'component', confidence: 'high' },
          { slug: 'component/Config', title: 'ConfigA', type: 'config', confidence: 'high' },
        ],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [
          { slug: 'component/App', title: 'AppB', type: 'component', confidence: 'high' },
          { slug: 'component/Config', title: 'ConfigB', type: 'config', confidence: 'high' },
        ],
        edges: [{ from: 'component/App', to: 'component/Config', relation: 'DEPENDS_ON' }],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      // Both colliding slugs survive (an allowed repo also claims them)...
      expect(graph?.nodes.map((n: { slug: string }) => n.slug)).toContain('component/App');
      expect(graph?.nodes.map((n: { slug: string }) => n.slug)).toContain('component/Config');
      // ...but the edge that only ever existed in the withheld repo is gone.
      expect(graph?.edges ?? []).not.toContainEqual(
        expect.objectContaining({ from: 'component/App', to: 'component/Config' }),
      );
    });

    it("removes a --reconcile-added code-page node and its MAPS_TO edge for a withheld codebase, even though neither ever lived in a per-repo file (#912 review round 4 P1)", async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      // Simulate `teamai codebase --reconcile`: it adds a code-page node for
      // svc-b's overview.md and a MAPS_TO edge from a product page, straight
      // to the global graph, never to svc-b's per-repo file.
      const globalPath = path.join(tmpDir, '.indices', 'graph-index.json');
      const global = JSON.parse(await fs.readFile(globalPath, 'utf8'));
      global.nodes.push({ slug: 'evidence/code/svc-b/overview', title: 'Svc B overview', type: 'architecture', confidence: 'high' });
      global.edges.push({ from: 'docs/product/billing', to: 'evidence/code/svc-b/overview', relation: 'MAPS_TO' });
      await fs.writeFile(globalPath, JSON.stringify(global));

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      const slugs = graph?.nodes.map((n: { slug: string }) => n.slug) ?? [];
      expect(slugs).not.toContain('evidence/code/svc-b/overview');
      expect(graph?.edges ?? []).not.toContainEqual(
        expect.objectContaining({ to: 'evidence/code/svc-b/overview' }),
      );
    });

    it("keeps an allowed repo's file-to-file edge whose endpoints are not graph nodes at all (#912 review round 3 P1)", async () => {
      // AST/heuristic edges are commonly file-to-file with neither endpoint
      // present in nodes[] — requiring both endpoints to "survive as nodes"
      // (an earlier version of this filter) deleted these for every allowed
      // repo too, the moment anything was withheld.
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [{ from: 'src/a.ts', to: 'src/b.ts', relation: 'DEPENDS_ON' }],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph?.edges).toContainEqual(expect.objectContaining({ from: 'src/a.ts', to: 'src/b.ts' }));
    });

    it("does not remove an allowed repo's node when a withheld repo happens to mint the same unqualified slug (#912 review round 3 P2)", async () => {
      // Fact-level slugs are not repo-qualified (buildCodeGraph mints
      // `component/App` the same way for any repo), so two unrelated repos
      // can legitimately collide on one slug after merging.
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'component/App', title: 'AppA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      writeRepoGraph('svc-b', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'component/App', title: 'AppB', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph?.nodes.map((n: { slug: string }) => n.slug)).toContain('component/App');
    });

    it('excludes case-foldedly, matching the evidence/code/<slug>/ directory on a case-insensitive filesystem', async () => {
      writeRepoGraph('Svc-B', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'b/svc', title: 'ServiceB', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph?.nodes).toHaveLength(0);
    });

    it('returns the graph unchanged when nothing is withheld', async () => {
      writeRepoGraph('svc-a', {
        schemaVersion: 1, generatedAt: '2026-01-01',
        nodes: [{ slug: 'a/svc', title: 'ServiceA', type: 'component', confidence: 'high' }],
        edges: [],
      });
      await aggregateGlobalGraph(tmpDir);

      const graph = await scopeGlobalGraph(tmpDir, new Set());
      expect(graph?.nodes).toHaveLength(1);
    });

    it('returns null when there is no global graph to scope', async () => {
      const graph = await scopeGlobalGraph(tmpDir, new Set(['svc-b']));
      expect(graph).toBeNull();
    });
  });
});

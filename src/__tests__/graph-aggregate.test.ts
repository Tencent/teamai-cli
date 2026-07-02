// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { aggregateGlobalGraph } from '../graph-aggregate.js';

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

    const result = await aggregateGlobalGraph(tmpDir);
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
});

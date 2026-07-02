// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';
import { detectCrossRepoEdges } from '../import-repo.js';

describe('detectCrossRepoEdges with GraphIndex format (slug/title)', () => {
  it('detects cross-repo edges via matching node titles', () => {
    const repoA = {
      nodes: [
        { slug: 'hai-api/balance-client', title: 'BalanceClient', type: 'component' },
        { slug: 'hai-api/flow-caller', title: 'FlowCaller', type: 'component' },
      ],
      edges: [
        { from: 'hai-api/balance-client', to: 'libs/balance.py', relation: 'imports' },
      ],
    };

    const repoB = {
      nodes: [
        { slug: 'hai-balance/balance-service', title: 'BalanceService', type: 'component' },
        { slug: 'hai-balance/config', title: 'hai_balance_config', type: 'config' },
        { slug: 'hai-flow/flow-engine', title: 'FlowCaller', type: 'component' },
      ],
      edges: [
        { from: 'hai-flow/flow-engine', to: 'api/balance_client.py', relation: 'imports' },
      ],
    };

    // repoB 的 flow-engine imports balance_client → match repoA's BalanceClient
    const edges = detectCrossRepoEdges(repoB, repoA);
    expect(edges.length).toBeGreaterThan(0);
    const depEdge = edges.find(e => e.relation === 'DEPENDS_ON');
    expect(depEdge).toBeDefined();
  });

  it('detects config node matching across repos', () => {
    const repoA = {
      nodes: [
        { slug: 'hai-api/service', title: 'InferService', type: 'component' },
      ],
      edges: [],
    };

    const configRepo = {
      nodes: [
        { slug: 'configs/infer-service-config', title: 'InferService', type: 'config' },
      ],
      edges: [],
    };

    // config repo has a config node whose title matches repoA's component
    const edges = detectCrossRepoEdges(configRepo, repoA);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0].relation).toBe('DEPENDS_ON');
  });

  it('handles mixed format nodes (id/label and slug/title)', () => {
    const oldFormat = {
      nodes: [
        { id: 'old-node-1', kind: 'component', label: 'AuthService', file: 'src/auth.py' },
      ],
      edges: [
        { from: 'src/auth.py', to: 'libs/auth_client.py', relation: 'imports' },
      ],
    };

    const newFormat = {
      nodes: [
        { slug: 'new-repo/auth-client', title: 'AuthClient', type: 'component' },
      ],
      edges: [],
    };

    // oldFormat imports auth_client → PascalCase = AuthClient → matches newFormat
    const edges = detectCrossRepoEdges(oldFormat, newFormat);
    expect(edges.length).toBeGreaterThan(0);
  });

  it('returns empty for repos with no shared names', () => {
    const repoA = {
      nodes: [{ slug: 'a/foo', title: 'FooService', type: 'component' }],
      edges: [],
    };
    const repoB = {
      nodes: [{ slug: 'b/bar', title: 'BarService', type: 'component' }],
      edges: [],
    };

    const edges = detectCrossRepoEdges(repoA, repoB);
    expect(edges).toHaveLength(0);
  });
});

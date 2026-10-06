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

  it('tags a cross-repo edge with BOTH sides\' origins — the overlay side whose import produced the match, and the matched existing side (#974 review round 13 P1)', () => {
    const repoA = {
      nodes: [
        { slug: 'hai-api/balance-client', title: 'BalanceClient', type: 'component', origin: 'svc-a' },
      ],
      edges: [],
    };
    const repoB = {
      nodes: [
        { slug: 'hai-flow/flow-engine', title: 'FlowCaller', type: 'component', origin: 'svc-b' },
      ],
      edges: [
        { from: 'hai-flow/flow-engine', to: 'api/balance_client.py', relation: 'imports' },
      ],
    };

    // repoB (overlay) imports balance_client → matches repoA's (existing) BalanceClient.
    // The relationship depends on BOTH repoB's own import statement AND repoA's
    // component existing — withholding either one must be able to remove this edge,
    // so both origins are recorded, not just whichever side the label lookup matched.
    const edges = detectCrossRepoEdges(repoB, repoA);
    const depEdge = edges.find(e => e.relation === 'DEPENDS_ON');
    expect(depEdge?.crossOriginPairs).toEqual([expect.arrayContaining(['svc-a', 'svc-b'])]);
    expect(depEdge?.crossOriginPairs?.[0]).toHaveLength(2);
  });

  it('omits a side from the pair when that node predates origin tagging, instead of a placeholder', () => {
    const repoA = {
      nodes: [{ slug: 'hai-api/balance-client', title: 'BalanceClient', type: 'component' }],
      edges: [],
    };
    const repoB = {
      nodes: [{ slug: 'hai-flow/flow-engine', title: 'FlowCaller', type: 'component', origin: 'svc-b' }],
      edges: [{ from: 'hai-flow/flow-engine', to: 'api/balance_client.py', relation: 'imports' }],
    };

    const edges = detectCrossRepoEdges(repoB, repoA);
    const depEdge = edges.find(e => e.relation === 'DEPENDS_ON');
    expect(depEdge?.crossOriginPairs).toEqual([['svc-b']]);
  });

  it("uses the import edge's own origin tag for the importing (reverse) side, not a fresh lookup of whichever node CURRENTLY sits at its slug — a later, unrelated collision can silently swap that node out without ever touching the edge's own tag (#974 review round 14 P1)", () => {
    const existing = {
      // `shared/client` collided with a DIFFERENT repo (svc-x) that was
      // aggregated after svc-b and won the merge — the node here is no
      // longer svc-b's, but the import edge below is still svc-b's own,
      // tagged at the time IT was aggregated, unaffected by that collision.
      nodes: [{ slug: 'shared/client', title: 'ClientX', type: 'component', origin: 'svc-x' }],
      edges: [{ from: 'shared/client', to: 'libs/balance_service.py', relation: 'imports', origin: 'svc-b' }],
    };
    const overlay = {
      nodes: [{ slug: 'a/service', title: 'BalanceService', type: 'component', origin: 'svc-a' }],
      edges: [],
    };

    const edges = detectCrossRepoEdges(overlay, existing);
    const depEdge = edges.find(e => e.relation === 'DEPENDS_ON');
    expect(depEdge?.crossOriginPairs).toEqual([expect.arrayContaining(['svc-b', 'svc-a'])]);
    expect(depEdge?.crossOriginPairs?.[0]).not.toContain('svc-x');
  });

  it('falls back to the current from-node\'s origin for the importing side only when the import edge itself predates origin tagging', () => {
    const existing = {
      nodes: [{ slug: 'shared/client', title: 'ClientX', type: 'component', origin: 'svc-x' }],
      edges: [{ from: 'shared/client', to: 'libs/balance_service.py', relation: 'imports' }],
    };
    const overlay = {
      nodes: [{ slug: 'a/service', title: 'BalanceService', type: 'component', origin: 'svc-a' }],
      edges: [],
    };

    const edges = detectCrossRepoEdges(overlay, existing);
    const depEdge = edges.find(e => e.relation === 'DEPENDS_ON');
    expect(depEdge?.crossOriginPairs).toEqual([expect.arrayContaining(['svc-x', 'svc-a'])]);
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

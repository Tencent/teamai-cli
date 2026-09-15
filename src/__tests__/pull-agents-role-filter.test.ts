import { describe, it, expect } from 'vitest';
import type { ResourceItem } from '../types.js';
import { filterAgentsByNamespaces } from '../pull.js';

describe('filterAgentsByNamespaces', () => {
  function makeAgent(name: string, namespace?: string): ResourceItem {
    const dir = namespace ? `agents/${namespace}` : 'agents';
    return {
      name,
      type: 'agents',
      sourcePath: `/fake/repo/${dir}/${name}.yaml`,
      relativePath: `${dir}/${name}.yaml`,
      ...(namespace ? { namespace } : {}),
    };
  }

  it('includes agents whose namespace is active and excludes the rest', () => {
    const agents = [
      makeAgent('vr-reviewer', 'frontend'),
      makeAgent('tf-reviewer', 'devops'),
      makeAgent('release-notes', 'pm'),
    ];

    const result = filterAgentsByNamespaces(agents, ['common', 'frontend', 'pm']);

    expect(result.map((a) => a.name)).toEqual(['vr-reviewer', 'release-notes']);
  });

  it('always includes root-level agents', () => {
    const agents = [
      makeAgent('teamai-helper'),
      makeAgent('tf-reviewer', 'devops'),
    ];

    const result = filterAgentsByNamespaces(agents, ['frontend']);

    expect(result.map((a) => a.name)).toEqual(['teamai-helper']);
  });

  it('returns every agent when namespaces is null (no role configured)', () => {
    const agents = [
      makeAgent('teamai-helper'),
      makeAgent('vr-reviewer', 'frontend'),
      makeAgent('tf-reviewer', 'devops'),
    ];

    expect(filterAgentsByNamespaces(agents, null)).toEqual(agents);
  });

  it('throws when two active namespaces deploy the same agent name', () => {
    const agents = [
      makeAgent('reviewer', 'frontend'),
      makeAgent('reviewer', 'devops'),
    ];

    expect(() => filterAgentsByNamespaces(agents, ['frontend', 'devops']))
      .toThrow(/Duplicate agent "reviewer" found in active namespaces "frontend" and "devops"/);
  });

  it('throws when a root-level agent and an active namespace share a name', () => {
    const agents = [
      makeAgent('reviewer'),
      makeAgent('reviewer', 'frontend'),
    ];

    expect(() => filterAgentsByNamespaces(agents, ['frontend']))
      .toThrow(/Duplicate agent "reviewer"/);
  });

  it('does not report a duplicate when the colliding namespace is inactive', () => {
    const agents = [
      makeAgent('reviewer', 'frontend'),
      makeAgent('reviewer', 'devops'),
    ];

    const result = filterAgentsByNamespaces(agents, ['frontend']);

    expect(result.map((a) => a.namespace)).toEqual(['frontend']);
  });

  it('still reports a duplicate when no role is configured, because destinations collide', () => {
    const agents = [
      makeAgent('reviewer', 'frontend'),
      makeAgent('reviewer', 'devops'),
    ];

    expect(() => filterAgentsByNamespaces(agents, null)).toThrow(/Duplicate agent "reviewer"/);
  });
});

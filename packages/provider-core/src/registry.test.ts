import { describe, expect, it } from 'vitest';
import { makeProviderRegistry, type ProviderDefinition } from './registry.js';

describe('makeProviderRegistry', () => {
  const definitions = [
    { name: 'forge', hosts: ['forge.example'], defaultEligible: true, create: () => ({ name: 'forge' }) },
    { name: 'git', hosts: [], defaultEligible: false, create: () => ({ name: 'git' }) },
  ] as const satisfies readonly ProviderDefinition<string, { name: string }>[];
  const registry = makeProviderRegistry(definitions);

  it('derives names, hosts, defaults and factories from the definitions', () => {
    expect(registry.ids).toEqual(['forge', 'git']);
    expect(registry.nameForHost('FORGE.EXAMPLE')).toBe('forge');
    expect(registry.defaultIds).toEqual(new Set(['forge']));
    expect(registry.create('git')).toEqual({ name: 'git' });
    expect(registry.create('missing')).toBeUndefined();
  });

  it('rejects duplicate names and hosts', () => {
    expect(() => makeProviderRegistry([...definitions, definitions[0]])).toThrow('Duplicate provider: forge');
    expect(() => makeProviderRegistry([...definitions, { ...definitions[0], name: 'other' as const }])).toThrow('Duplicate provider host: forge.example');
  });
});

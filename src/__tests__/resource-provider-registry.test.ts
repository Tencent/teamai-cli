import { describe, expect, it, vi } from 'vitest';
import {
  ResourceProviderRegistry,
  syncResourceProviders,
  resolveWritableProvider,
} from '../providers/resource-registry.js';
import type { ResourceProvider, SyncContext } from '../providers/types.js';

function provider(name: string, type: 'git' | 'http', priority: number, result = name): ResourceProvider {
  const capabilities = { pull: true, push: type === 'git', report: type === 'http', commands: type === 'http' };
  return {
    name,
    type,
    priority,
    capabilities,
    sync: vi.fn(async () => ({ provider: name, ok: true, changed: false, message: result })),
    describe: vi.fn(async () => ({ name, type, priority, capabilities })),
    teardown: vi.fn(async () => {}),
  };
}

describe('ResourceProviderRegistry', () => {
  it('rejects duplicate provider names and returns providers by descending priority', () => {
    const registry = new ResourceProviderRegistry();
    registry.register(provider('secondary', 'http', 10));
    registry.register(provider('primary', 'git', 100));
    expect(registry.list().map((item) => item.name)).toEqual(['primary', 'secondary']);
    expect(() => registry.register(provider('primary', 'http', 200))).toThrow(/already registered/);
  });

  it('syncs every capable provider once and isolates failures', async () => {
    const good = provider('good', 'http', 50);
    const bad = provider('bad', 'http', 100);
    vi.mocked(bad.sync).mockRejectedValueOnce(new Error('offline'));
    const context: SyncContext = { cwd: '/tmp/project', trigger: 'hook' };
    const results = await syncResourceProviders([bad, good], context);
    expect(results).toEqual([
      expect.objectContaining({ provider: 'bad', ok: false, message: 'offline' }),
      expect.objectContaining({ provider: 'good', ok: true }),
    ]);
    expect(bad.sync).toHaveBeenCalledTimes(1);
    expect(good.sync).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit primary when multiple providers can push', () => {
    const providers = [provider('one', 'git', 10), provider('two', 'git', 20)];
    expect(() => resolveWritableProvider(providers)).toThrow(/primaryProvider/);
    expect(resolveWritableProvider(providers, 'one').name).toBe('one');
    expect(() => resolveWritableProvider(providers, 'missing')).toThrow(/not found/);
  });
});

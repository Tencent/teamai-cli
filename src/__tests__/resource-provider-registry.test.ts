import { describe, it, expect, vi } from 'vitest';
import {
  ResourceProviderRegistry,
  syncResourceProviders,
} from '../providers/resource-registry.js';
import { GitResourceProvider } from '../providers/git/resource-provider.js';
import type {
  ResourceProvider,
  SyncContext,
  ProviderResult,
} from '../providers/types.js';

/** A minimal stub ResourceProvider for registry/sync tests. */
function stubProvider(
  name: string,
  priority: number,
  opts: {
    sync?: (ctx: SyncContext) => Promise<ProviderResult>;
    pull?: boolean;
    report?: boolean;
  } = {},
): ResourceProvider {
  return {
    name,
    type: 'http',
    priority,
    capabilities: {
      pull: opts.pull ?? true,
      push: false,
      report: opts.report ?? false,
      commands: false,
    },
    sync:
      opts.sync ??
      (async () => ({ provider: name, ok: true, changed: false })),
    describe: async () => ({
      name,
      type: 'http',
      priority,
      capabilities: { pull: true, push: false, report: false, commands: false },
    }),
    teardown: async () => {},
  };
}

const HOOK: SyncContext = { trigger: 'hook' };

describe('ResourceProviderRegistry', () => {
  it('rejects a duplicate provider name', () => {
    const registry = new ResourceProviderRegistry();
    registry.register(stubProvider('team', 100));
    expect(() => registry.register(stubProvider('team', 50))).toThrow(
      /already registered/,
    );
  });

  it('looks up a provider by name', () => {
    const registry = new ResourceProviderRegistry();
    const p = stubProvider('team', 100);
    registry.register(p);
    expect(registry.get('team')).toBe(p);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it('lists providers by descending priority, then name', () => {
    const registry = new ResourceProviderRegistry();
    registry.register(stubProvider('bbb', 50));
    registry.register(stubProvider('aaa', 100));
    registry.register(stubProvider('ccc', 50));
    expect(registry.list().map((p) => p.name)).toEqual(['aaa', 'bbb', 'ccc']);
  });
});

describe('syncResourceProviders', () => {
  it('isolates a failing provider from the others', async () => {
    const good = stubProvider('good', 10, {
      sync: async () => ({ provider: 'good', ok: true, changed: true }),
    });
    const bad = stubProvider('bad', 20, {
      sync: async () => {
        throw new Error('backend down');
      },
    });

    const results = await syncResourceProviders([good, bad], HOOK);
    const byName = Object.fromEntries(results.map((r) => [r.provider, r]));

    expect(byName.good.ok).toBe(true);
    expect(byName.good.changed).toBe(true);
    expect(byName.bad.ok).toBe(false);
    expect(byName.bad.message).toBe('backend down');
  });

  it('skips providers with neither pull nor report capability', async () => {
    const sync = vi.fn(async () => ({
      provider: 'silent',
      ok: true,
      changed: false,
    }));
    const silent = stubProvider('silent', 10, { sync, pull: false, report: false });

    const results = await syncResourceProviders([silent], HOOK);

    expect(sync).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it('applies providers lowest-priority first so the winner runs last', async () => {
    const order: string[] = [];
    const low = stubProvider('low', 10, {
      sync: async () => {
        order.push('low');
        return { provider: 'low', ok: true, changed: false };
      },
    });
    const high = stubProvider('high', 100, {
      sync: async () => {
        order.push('high');
        return { provider: 'high', ok: true, changed: false };
      },
    });

    await syncResourceProviders([high, low], HOOK);

    expect(order).toEqual(['low', 'high']);
  });
});

describe('GitResourceProvider', () => {
  it('is a git provider whose push capability tracks writability', () => {
    const writable = new GitResourceProvider(
      'core',
      100,
      'https://example.com/repo.git',
      async () => ({ changed: false }),
      async () => {},
      true,
    );
    expect(writable.type).toBe('git');
    expect(writable.capabilities).toEqual({
      pull: true,
      push: true,
      report: false,
      commands: false,
    });

    const readOnly = new GitResourceProvider(
      'shared',
      50,
      'https://example.com/shared.git',
      async () => ({ changed: false }),
      async () => {},
      false,
    );
    expect(readOnly.capabilities.push).toBe(false);
  });

  it('delegates sync to the injected operation and reports its result', async () => {
    const syncOp = vi.fn(async () => ({ changed: true, message: 'pulled 3 skills' }));
    const provider = new GitResourceProvider(
      'core',
      100,
      'https://example.com/repo.git',
      syncOp,
      async () => {},
      true,
    );

    const result = await provider.sync({ trigger: 'pull', cwd: '/work' });

    expect(syncOp).toHaveBeenCalledWith({ trigger: 'pull', cwd: '/work' });
    expect(result).toEqual({
      provider: 'core',
      ok: true,
      changed: true,
      message: 'pulled 3 skills',
    });
  });

  it('delegates teardown to the injected operation', async () => {
    const teardownOp = vi.fn(async () => {});
    const provider = new GitResourceProvider(
      'core',
      100,
      'https://example.com/repo.git',
      async () => ({ changed: false }),
      teardownOp,
      true,
    );

    await provider.teardown();

    expect(teardownOp).toHaveBeenCalledOnce();
  });

  it('describes itself with the repo as endpoint', async () => {
    const provider = new GitResourceProvider(
      'core',
      100,
      'https://example.com/repo.git',
      async () => ({ changed: false }),
      async () => {},
      true,
    );
    expect(await provider.describe()).toEqual({
      name: 'core',
      type: 'git',
      priority: 100,
      capabilities: { pull: true, push: true, report: false, commands: false },
      endpoint: 'https://example.com/repo.git',
    });
  });
});

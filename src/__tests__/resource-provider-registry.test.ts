import { describe, it, expect, vi } from 'vitest';
import { syncResourceProviders } from '../providers/resource-registry.js';
import type {
  ResourceProvider,
  SyncContext,
  ProviderResult,
} from '../providers/types.js';

/** A minimal stub ResourceProvider for sync tests. */
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

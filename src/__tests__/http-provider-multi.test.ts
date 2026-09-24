import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpDir: string;
let origHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-http-multi-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fse.remove(tmpDir);
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('multiple HTTP providers: hook dispatch', () => {
  it('dispatches every configured provider once, isolating one failure', async () => {
    const seen: Array<{ name: string; endpoint: string; home: string }> = [];

    // Intercept the ClawPro client entry the adapter calls, capturing the
    // active provider context so we can assert per-provider isolation without a
    // real backend.
    vi.doMock('../providers/http/adapters/clawpro/client.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../providers/http/adapters/clawpro/client.js')>();
      return {
        ...actual,
        reportAndSyncFromHook: vi.fn(async () => {
          const ctx = actual.currentHttpProvider();
          const cfg = await actual.loadLocalAgentConfig();
          seen.push({ name: ctx?.name ?? '?', endpoint: cfg?.endpoint ?? '?', home: ctx?.home ?? '?' });
          if (ctx?.name === 'flaky') throw new Error('backend down');
          return `hint:${ctx?.name}`;
        }),
      };
    });

    const { upsertHttpProviderConfig, httpProviderExecutionContext } = await import('../providers/http/store.js');
    const { withHttpProvider, initLocalAgentHttp } = await import('../providers/http/adapters/clawpro/client.js');
    for (const p of [
      { name: 'good', endpoint: 'https://good/api', priority: 40 },
      { name: 'flaky', endpoint: 'https://flaky/api', priority: 80 },
    ]) {
      await upsertHttpProviderConfig({ name: p.name, adapter: 'clawpro', endpoint: p.endpoint, priority: p.priority });
      // Seed each provider's isolated config.json so loadLocalAgentConfig
      // returns its endpoint (initLocalAgentHttp injects no hooks without tools).
      await withHttpProvider(httpProviderExecutionContext(p.name), () =>
        initLocalAgentHttp({ endpoint: p.endpoint, force: true }),
      );
    }

    const { loadHttpResourceProviders } = await import('../providers/http/registry.js');
    const { syncResourceProviders } = await import('../providers/resource-registry.js');
    const providers = await loadHttpResourceProviders();
    const results = await syncResourceProviders(providers, {
      trigger: 'hook',
      tool: 'claude',
      stdin: { hook_event_name: 'SessionStart' },
      cwd: tmpDir,
    });

    // Each provider dispatched exactly once.
    expect(seen.map((s) => s.name).sort()).toEqual(['flaky', 'good']);
    // Each ran against its own endpoint / state home (isolation).
    const good = seen.find((s) => s.name === 'good')!;
    expect(good.endpoint).toBe('https://good/api');
    expect(good.home).toContain(path.join('providers', 'http', 'good'));
    const flaky = seen.find((s) => s.name === 'flaky')!;
    expect(flaky.home).toContain(path.join('providers', 'http', 'flaky'));

    // Failure isolation: one down backend does not sink the other.
    const byName = Object.fromEntries(results.map((r) => [r.provider, r]));
    expect(byName.good.ok).toBe(true);
    expect(byName.good.hookOutput).toBe('hint:good');
    expect(byName.flaky.ok).toBe(false);
    expect(byName.flaky.message).toBe('backend down');
  });

  it('reports ok:false when the client swallows a report/sync error (outcome signal)', async () => {
    // reportAndSyncFromHook does NOT throw here — it returns normally but fills
    // the outcome out-param with a failure, exactly as the real client does when
    // its internal try/catch swallows a network error. The adapter must still
    // surface ok:false, not a false success.
    vi.doMock('../providers/http/adapters/clawpro/client.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../providers/http/adapters/clawpro/client.js')>();
      return {
        ...actual,
        reportAndSyncFromHook: vi.fn(async (_stdin, _tool, outcome) => {
          if (outcome) {
            outcome.failed = true;
            outcome.error = 'sync FAILED: network down';
          }
          return null;
        }),
      };
    });

    const { upsertHttpProviderConfig, httpProviderExecutionContext } = await import('../providers/http/store.js');
    const { withHttpProvider, initLocalAgentHttp } = await import('../providers/http/adapters/clawpro/client.js');
    await upsertHttpProviderConfig({ name: 'solo', adapter: 'clawpro', endpoint: 'https://solo/api', priority: 50 });
    await withHttpProvider(httpProviderExecutionContext('solo'), () =>
      initLocalAgentHttp({ endpoint: 'https://solo/api', force: true }),
    );

    const { loadHttpResourceProviders } = await import('../providers/http/registry.js');
    const { syncResourceProviders } = await import('../providers/resource-registry.js');
    const results = await syncResourceProviders(await loadHttpResourceProviders(), {
      trigger: 'hook',
      tool: 'claude',
      stdin: { hook_event_name: 'SessionStart' },
      cwd: tmpDir,
    });

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].message).toBe('sync FAILED: network down');
  });
});

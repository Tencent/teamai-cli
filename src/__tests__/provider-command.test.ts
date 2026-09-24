import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpDir: string;
let origHome: string | undefined;
let exitSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-provider-cmd-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  // process.exit(1) marks a CLI failure; throw so the test can assert it and
  // the function stops (as it would in the real CLI).
  exitSpy = vi.fn((code?: number) => {
    throw new Error(`process.exit(${code})`);
  });
  vi.spyOn(process, 'exit').mockImplementation(exitSpy as never);
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fse.remove(tmpDir);
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('provider add http: single-provider gate (issue #404 phase 2)', () => {
  it('refuses a second HTTP provider while one is configured', async () => {
    const { upsertHttpProviderConfig } = await import('../providers/http/store.js');
    await upsertHttpProviderConfig({ name: 'first', adapter: 'clawpro', endpoint: 'https://a/api', priority: 50 });

    const { providerAddHttp } = await import('../provider-command.js');
    await expect(
      providerAddHttp('https://b/api', { name: 'second' }),
    ).rejects.toThrow(/process.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // The second provider was never registered.
    const { listHttpProviderConfigs } = await import('../providers/http/store.js');
    expect((await listHttpProviderConfigs()).map((c) => c.name)).toEqual(['first']);
  });

  it('refuses to add a provider while the legacy singleton is active', async () => {
    const legacy = path.join(tmpDir, '.teamai', 'local-agent');
    await fse.ensureDir(legacy);
    await fse.writeJson(path.join(legacy, 'config.json'), {
      endpoint: 'https://legacy/api', workspaceBindings: {}, createdAt: '2026-01-01T00:00:00.000Z',
    });

    const { providerAddHttp } = await import('../provider-command.js');
    await expect(
      providerAddHttp('https://b/api', { name: 'company' }),
    ).rejects.toThrow(/process.exit\(1\)/);

    const { listHttpProviderConfigs } = await import('../providers/http/store.js');
    expect(await listHttpProviderConfigs()).toEqual([]);
  });

  it('rejects an unknown adapter before writing anything', async () => {
    const { providerAddHttp } = await import('../provider-command.js');
    await expect(
      providerAddHttp('https://a/api', { name: 'x', adapter: 'nope' }),
    ).rejects.toThrow(/process.exit\(1\)/);
    const { listHttpProviderConfigs } = await import('../providers/http/store.js');
    expect(await listHttpProviderConfigs()).toEqual([]);
  });
});

describe('provider add http: registry published only after init succeeds (issue #404)', () => {
  it('rolls back and leaves no registry entry when adapter init fails', async () => {
    // Force the ClawPro adapter's initialize to fail.
    vi.doMock('../providers/http/registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../providers/http/registry.js')>();
      return {
        ...actual,
        getHttpAdapter: (name: string) => {
          const backend = actual.getHttpAdapter(name);
          return { ...backend, initialize: async () => { throw new Error('bad token'); } };
        },
      };
    });

    const { providerAddHttp } = await import('../provider-command.js');
    await expect(
      providerAddHttp('https://a/api', { name: 'company', token: 'x' }),
    ).rejects.toThrow(/process.exit\(1\)/);

    // No registered provider, no leftover state home.
    const { listHttpProviderConfigs, httpProviderHome } = await import('../providers/http/store.js');
    expect(await listHttpProviderConfigs()).toEqual([]);
    expect(fse.existsSync(httpProviderHome('company'))).toBe(false);
  });
});

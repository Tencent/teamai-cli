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

  it('rejects an invalid name with a clean exit, not an uncaught throw', async () => {
    const { log } = await import('../utils/logger.js');
    const { providerAddHttp } = await import('../provider-command.js');
    // A Windows reserved name with an extension must be a clean error + exit(1).
    await expect(
      providerAddHttp('https://a/api', { name: 'CON.txt', token: 't' }),
    ).rejects.toThrow(/process.exit\(1\)/);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('reserved device name'));
    const { listHttpProviderConfigs } = await import('../providers/http/store.js');
    expect(await listHttpProviderConfigs()).toEqual([]);
  });
});

describe('provider migrate-legacy: single-provider gate (issue #404 phase 2)', () => {
  it('refuses to migrate while a named provider already exists', async () => {
    // Seed a legacy singleton AND a named provider.
    const legacy = path.join(tmpDir, '.teamai', 'local-agent');
    await fse.ensureDir(legacy);
    await fse.writeJson(path.join(legacy, 'config.json'), {
      endpoint: 'https://legacy/api', workspaceBindings: {}, createdAt: '2026-01-01T00:00:00.000Z',
    });
    const { upsertHttpProviderConfig, listHttpProviderConfigs } = await import('../providers/http/store.js');
    await upsertHttpProviderConfig({ name: 'existing', adapter: 'clawpro', endpoint: 'https://a/api', priority: 50 });

    const { providerMigrateLegacy } = await import('../provider-command.js');
    await expect(
      providerMigrateLegacy({ name: 'migrated' }),
    ).rejects.toThrow(/process.exit\(1\)/);

    // Still only the original named provider; no second one was created.
    expect((await listHttpProviderConfigs()).map((c) => c.name)).toEqual(['existing']);
  });

  it('stays idempotent: re-running after a completed migration is a no-op, not an error', async () => {
    const legacy = path.join(tmpDir, '.teamai', 'local-agent');
    await fse.ensureDir(legacy);
    await fse.writeJson(path.join(legacy, 'config.json'), {
      endpoint: 'https://legacy/api', workspaceBindings: {}, createdAt: '2026-01-01T00:00:00.000Z',
    });
    await fse.writeJson(path.join(legacy, 'manifest.json'), { scopes: {} });

    const { providerMigrateLegacy } = await import('../provider-command.js');
    // First migration succeeds and registers "company".
    await providerMigrateLegacy({ name: 'company' });
    const { listHttpProviderConfigs } = await import('../providers/http/store.js');
    expect((await listHttpProviderConfigs()).map((c) => c.name)).toEqual(['company']);

    // Re-running with the SAME name must NOT error on the single-provider gate
    // (regression: the gate previously rejected any existing entry, including
    // this migration's own). It is a clean no-op.
    await expect(providerMigrateLegacy({ name: 'company' })).resolves.toBeUndefined();
    expect((await listHttpProviderConfigs()).map((c) => c.name)).toEqual(['company']);
  });
});

describe('provider add http: registry published only after init succeeds (issue #404)', () => {
  it('cleanly rolls back (no registry, no home) when init fails and teardown succeeds', async () => {
    // init fails; teardown succeeds → clean rollback removes everything.
    vi.doMock('../providers/http/registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../providers/http/registry.js')>();
      return {
        ...actual,
        getHttpAdapter: (name: string) => {
          const backend = actual.getHttpAdapter(name);
          return {
            ...backend,
            initialize: async () => { throw new Error('bad token'); },
            teardown: async () => {},
          };
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

  it('keeps a retriable state home (no registry) when init AND rollback teardown fail', async () => {
    // init fails; teardown also fails (e.g. an injected hook is locked) → keep
    // the home + a self-describing provider.json so `provider remove` can retry,
    // but drop the registry entry so dispatch won't load a broken provider.
    vi.doMock('../providers/http/registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../providers/http/registry.js')>();
      return {
        ...actual,
        getHttpAdapter: (name: string) => {
          const backend = actual.getHttpAdapter(name);
          return {
            ...backend,
            initialize: async () => { throw new Error('bad token'); },
            teardown: async () => { throw new Error('hook file locked'); },
          };
        },
      };
    });

    const { providerAddHttp } = await import('../provider-command.js');
    await expect(
      providerAddHttp('https://a/api', { name: 'company', token: 'x' }),
    ).rejects.toThrow(/process.exit\(1\)/);

    const { listHttpProviderConfigs, httpProviderHome, readHttpProviderHomeConfig } = await import(
      '../providers/http/store.js'
    );
    // No registry entry (dispatch won't load it) …
    expect(await listHttpProviderConfigs()).toEqual([]);
    // … but the home + provider.json survive so `provider remove` can recover it.
    expect(fse.existsSync(httpProviderHome('company'))).toBe(true);
    expect((await readHttpProviderHomeConfig('company'))?.endpoint).toBe('https://a/api');
  });

  it('provider remove recovers a home whose registry entry was dropped (review #3)', async () => {
    // Seed a home with a self-describing provider.json but NO registry entry —
    // the state a failed add leaves behind.
    const { writeHttpProviderHomeConfig, httpProviderHome, getHttpProviderConfig } = await import(
      '../providers/http/store.js'
    );
    await writeHttpProviderHomeConfig({ name: 'company', adapter: 'clawpro', endpoint: 'https://a/api', priority: 50 });
    expect(await getHttpProviderConfig('company')).toBeUndefined();

    const { providerRemove } = await import('../provider-command.js');
    // teardown for a bare/no-endpoint config no-ops (no manifest); remove succeeds.
    await providerRemove('company');
    expect(fse.existsSync(httpProviderHome('company'))).toBe(false);
  });

  it('provider remove resolves the name case-insensitively and clears the registry (review #3)', async () => {
    const { upsertHttpProviderConfig, listHttpProviderConfigs, httpProviderHome } = await import(
      '../providers/http/store.js'
    );
    await upsertHttpProviderConfig({ name: 'company', adapter: 'clawpro', endpoint: 'https://a/api', priority: 50 });

    const { providerRemove } = await import('../provider-command.js');
    // Different-case input must resolve to the registered `company` and remove
    // BOTH its state home and its registry record — never delete state while
    // leaving a dangling registry entry (case-insensitive FS hazard).
    await providerRemove('Company');
    expect(await listHttpProviderConfigs()).toEqual([]);
    expect(fse.existsSync(httpProviderHome('company'))).toBe(false);
  });
});

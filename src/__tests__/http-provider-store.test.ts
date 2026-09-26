import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tmpDir: string;
let origHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-http-store-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = origHome;
  await fse.remove(tmpDir);
  vi.restoreAllMocks();
});

const teamai = () => path.join(tmpDir, '.teamai');

describe('http provider store: config registry', () => {
  it('rejects an unsafe provider name', async () => {
    const { assertValidProviderName } = await import('../providers/http/store.js');
    expect(() => assertValidProviderName('../evil')).toThrow(/Invalid provider name/);
    expect(() => assertValidProviderName('bad/name')).toThrow(/Invalid provider name/);
    expect(() => assertValidProviderName('good-name.1')).not.toThrow();
    // Cross-platform path-segment hazards: trailing dot and Windows reserved names.
    expect(() => assertValidProviderName('name.')).toThrow(/must not end with/);
    expect(() => assertValidProviderName('CON')).toThrow(/reserved device name/);
    expect(() => assertValidProviderName('com1')).toThrow(/reserved device name/);
    // Windows also forbids a reserved name with any extension (CON.txt → device).
    expect(() => assertValidProviderName('CON.txt')).toThrow(/reserved device name/);
    expect(() => assertValidProviderName('LPT1.foo')).toThrow(/reserved device name/);
    // A name that merely starts with those letters is fine.
    expect(() => assertValidProviderName('console')).not.toThrow();
  });

  it('rejects a name that collides case-insensitively with an existing provider', async () => {
    const { upsertHttpProviderConfig } = await import('../providers/http/store.js');
    await upsertHttpProviderConfig({ name: 'Company', adapter: 'clawpro', endpoint: 'https://a/api', priority: 10 });
    // Same lowercase form, different spelling → collides on a case-insensitive FS.
    await expect(
      upsertHttpProviderConfig({ name: 'company', adapter: 'clawpro', endpoint: 'https://b/api', priority: 20 }),
    ).rejects.toThrow(/collides with existing/);
    // Exact-name replacement is still allowed (intentional upsert).
    await expect(
      upsertHttpProviderConfig({ name: 'Company', adapter: 'clawpro', endpoint: 'https://c/api', priority: 30 }),
    ).resolves.toBeUndefined();
  });

  it('isolates two providers by name in registry and per-provider home', async () => {
    const { upsertHttpProviderConfig, listHttpProviderConfigs, getHttpProviderConfig, httpProviderHome } =
      await import('../providers/http/store.js');

    await upsertHttpProviderConfig({ name: 'company', adapter: 'clawpro', endpoint: 'https://a/api', priority: 80 });
    await upsertHttpProviderConfig({ name: 'community', adapter: 'clawpro', endpoint: 'https://b/api', priority: 40 });

    const all = await listHttpProviderConfigs();
    expect(all.map((c) => c.name).sort()).toEqual(['community', 'company']);
    expect((await getHttpProviderConfig('company'))?.endpoint).toBe('https://a/api');

    // Each provider gets a self-describing config in its own home.
    const companyConfig = await fse.readJson(path.join(httpProviderHome('company'), 'provider.json'));
    expect(companyConfig.endpoint).toBe('https://a/api');
    expect(fs.existsSync(httpProviderHome('community'))).toBe(true);
  });

  it('removes only the selected provider from the registry', async () => {
    const { upsertHttpProviderConfig, removeHttpProviderConfig, listHttpProviderConfigs } =
      await import('../providers/http/store.js');
    await upsertHttpProviderConfig({ name: 'a', adapter: 'clawpro', endpoint: 'https://a/api', priority: 10 });
    await upsertHttpProviderConfig({ name: 'b', adapter: 'clawpro', endpoint: 'https://b/api', priority: 20 });

    expect(await removeHttpProviderConfig('a')).toBe(true);
    expect((await listHttpProviderConfigs()).map((c) => c.name)).toEqual(['b']);
    expect(await removeHttpProviderConfig('missing')).toBe(false);
  });

  it('removes a provider state home and credential file', async () => {
    const { upsertHttpProviderConfig, removeHttpProviderState, httpProviderHome, httpProviderCredentialPath } =
      await import('../providers/http/store.js');
    const { writeTokenFile } = await import('../local-agent.js');

    await upsertHttpProviderConfig({ name: 'a', adapter: 'clawpro', endpoint: 'https://a/api', priority: 10 });
    await fse.ensureDir(path.dirname(httpProviderCredentialPath('a')));
    await writeTokenFile(httpProviderCredentialPath('a'), 'secret');
    expect(fs.existsSync(httpProviderHome('a'))).toBe(true);
    expect(fs.existsSync(httpProviderCredentialPath('a'))).toBe(true);

    await removeHttpProviderState('a');
    expect(fs.existsSync(httpProviderHome('a'))).toBe(false);
    expect(fs.existsSync(httpProviderCredentialPath('a'))).toBe(false);
  });
});

describe('http provider: named-context credential isolation', () => {
  it('keeps the token in a 0600 file, never in config.json', async () => {
    const { withHttpProvider, initLocalAgentHttp, loadLocalAgentConfig } = await import('../local-agent.js');
    const { httpProviderExecutionContext, httpProviderCredentialPath, httpProviderHome } = await import(
      '../providers/http/store.js'
    );

    await withHttpProvider(httpProviderExecutionContext('company'), () =>
      initLocalAgentHttp({ endpoint: 'https://a/api', token: 'super-secret', force: true }),
    );

    // config.json under the provider home carries NO token.
    const cfg = await fse.readJson(path.join(httpProviderHome('company'), 'config.json'));
    expect(cfg.endpoint).toBe('https://a/api');
    expect(cfg.token).toBeUndefined();

    // The credential lives in an isolated 0600 file.
    const credPath = httpProviderCredentialPath('company');
    expect(fs.existsSync(credPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
    }

    // Loading inside the context re-reads the token from the credential file.
    const loaded = await withHttpProvider(httpProviderExecutionContext('company'), () => loadLocalAgentConfig());
    expect(loaded?.token).toBe('super-secret');
  });

  it('routes two providers to separate state homes', async () => {
    const { withHttpProvider, initLocalAgentHttp } = await import('../local-agent.js');
    const { httpProviderExecutionContext, httpProviderHome } = await import('../providers/http/store.js');

    await withHttpProvider(httpProviderExecutionContext('a'), () =>
      initLocalAgentHttp({ endpoint: 'https://a/api', token: 'ta', force: true }),
    );
    await withHttpProvider(httpProviderExecutionContext('b'), () =>
      initLocalAgentHttp({ endpoint: 'https://b/api', token: 'tb', force: true }),
    );

    expect((await fse.readJson(path.join(httpProviderHome('a'), 'config.json'))).endpoint).toBe('https://a/api');
    expect((await fse.readJson(path.join(httpProviderHome('b'), 'config.json'))).endpoint).toBe('https://b/api');
    // Neither run wrote to the legacy singleton location.
    expect(fs.existsSync(path.join(teamai(), 'local-agent', 'config.json'))).toBe(false);
  });
});

describe('http provider: legacy singleton migration', () => {
  async function seedLegacy(token?: string) {
    const legacyDir = path.join(teamai(), 'local-agent');
    await fse.ensureDir(legacyDir);
    await fse.writeJson(path.join(legacyDir, 'config.json'), {
      endpoint: 'https://legacy/api',
      ...(token ? { token } : {}),
      createdAt: '2026-01-01T00:00:00.000Z',
      workspaceBindings: {},
    });
    // A manifest file, to prove the whole state home is copied.
    await fse.writeJson(path.join(legacyDir, 'manifest.json'), { scopes: {} });
    return legacyDir;
  }

  it('reports legacy singleton active until migrated', async () => {
    const { legacySingletonActive } = await import('../providers/http/store.js');
    expect(await legacySingletonActive()).toBe(false);
    await seedLegacy('t');
    expect(await legacySingletonActive()).toBe(true);
  });

  it('promotes the legacy singleton to a named provider with an isolated credential', async () => {
    const legacyDir = await seedLegacy('legacy-token');
    const {
      migrateLegacyHttpProvider,
      legacySingletonActive,
      httpProviderHome,
      httpProviderCredentialPath,
      getHttpProviderConfig,
    } = await import('../providers/http/store.js');

    const config = await migrateLegacyHttpProvider({ name: 'company', priority: 70 });
    expect(config).toMatchObject({ name: 'company', adapter: 'clawpro', endpoint: 'https://legacy/api', priority: 70 });

    // Registered and self-describing.
    expect((await getHttpProviderConfig('company'))?.endpoint).toBe('https://legacy/api');
    // State copied over.
    expect(fs.existsSync(path.join(httpProviderHome('company'), 'manifest.json'))).toBe(true);
    // Token extracted to the isolated 0600 file, stripped from migrated config.json.
    expect(fs.readFileSync(httpProviderCredentialPath('company'), 'utf-8').trim()).toBe('legacy-token');
    expect((await fse.readJson(path.join(httpProviderHome('company'), 'config.json'))).token).toBeUndefined();

    // The legacy dir is DELETED (no rollback snapshot) — so it no longer counts
    // as an active singleton and cannot be revived or double-uninstalled.
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(await legacySingletonActive()).toBe(false);
  });

  it('extracts the token from the legacy ~/.teamai/token file and removes the original (review P2)', async () => {
    await seedLegacy();
    await fse.writeFile(path.join(teamai(), 'token'), 'file-token\n');
    const { migrateLegacyHttpProvider, httpProviderCredentialPath } = await import('../providers/http/store.js');

    await migrateLegacyHttpProvider({ name: 'company' });
    // Moved into the isolated 0600 credential …
    expect(fs.readFileSync(httpProviderCredentialPath('company'), 'utf-8').trim()).toBe('file-token');
    // … and the shared plaintext ~/.teamai/token is deleted, not stranded.
    expect(fs.existsSync(path.join(teamai(), 'token'))).toBe(false);
  });

  it('is idempotent: a second migration is a no-op', async () => {
    await seedLegacy('t');
    const { migrateLegacyHttpProvider } = await import('../providers/http/store.js');
    expect(await migrateLegacyHttpProvider({ name: 'company' })).not.toBeNull();
    expect(await migrateLegacyHttpProvider({ name: 'company2' })).toBeNull();
  });

  it('returns null when there is no legacy singleton', async () => {
    const { migrateLegacyHttpProvider } = await import('../providers/http/store.js');
    expect(await migrateLegacyHttpProvider({ name: 'company' })).toBeNull();
  });

  it('refuses to migrate onto a name a real provider already occupies', async () => {
    await seedLegacy('t');
    const { migrateLegacyHttpProvider, upsertHttpProviderConfig } = await import('../providers/http/store.js');
    // A registered provider is the real conflict.
    await upsertHttpProviderConfig({ name: 'company', adapter: 'clawpro', endpoint: 'https://x/api', priority: 10 });
    await expect(migrateLegacyHttpProvider({ name: 'company' })).rejects.toThrow(/already exists/);
  });

  it('is retriable: a home left by a crashed migration is discarded and rebuilt', async () => {
    await seedLegacy('legacy-token');
    const { migrateLegacyHttpProvider, httpProviderHome, getHttpProviderConfig } = await import(
      '../providers/http/store.js'
    );
    // Simulate a crash after the state-dir move but before the registry write:
    // a home dir exists but no registry entry.
    await fse.ensureDir(httpProviderHome('company'));
    await fse.writeFile(path.join(httpProviderHome('company'), 'stale.txt'), 'leftover');

    const config = await migrateLegacyHttpProvider({ name: 'company' });
    expect(config).not.toBeNull();
    // The leftover was discarded and the home rebuilt from legacy (manifest copied).
    expect(fs.existsSync(path.join(httpProviderHome('company'), 'stale.txt'))).toBe(false);
    expect(fs.existsSync(path.join(httpProviderHome('company'), 'manifest.json'))).toBe(true);
    expect((await getHttpProviderConfig('company'))?.endpoint).toBe('https://legacy/api');
  });

  it('resumes when a prior attempt already wrote the registry entry', async () => {
    await seedLegacy('legacy-token');
    const { migrateLegacyHttpProvider, upsertHttpProviderConfig, legacySingletonActive } = await import(
      '../providers/http/store.js'
    );
    // Simulate a crash AFTER upsert (registry entry with the legacy endpoint)
    // but BEFORE the legacy dir was deleted: legacy is still active. A retry
    // must resume, not fail with "already exists".
    await upsertHttpProviderConfig({
      name: 'company', adapter: 'clawpro', endpoint: 'https://legacy/api', priority: 50,
    });
    expect(await legacySingletonActive()).toBe(true);

    const config = await migrateLegacyHttpProvider({ name: 'company' });
    expect(config).not.toBeNull();
    // Migration completed: the legacy dir is deleted, so it is no longer active.
    expect(await legacySingletonActive()).toBe(false);
  });

  it('deletes the legacy dir on migration (no snapshot) and is idempotent', async () => {
    await seedLegacy('t');
    const { migrateLegacyHttpProvider, legacySingletonActive } = await import(
      '../providers/http/store.js'
    );
    const first = await migrateLegacyHttpProvider({ name: 'company' });
    expect(first).not.toBeNull();
    // No rollback snapshot is kept — the legacy dir is gone, so it is inactive
    // and a second migration is a no-op (returns null).
    expect(await legacySingletonActive()).toBe(false);
    expect(await migrateLegacyHttpProvider({ name: 'company2' })).toBeNull();
  });

  it('a re-written legacy config after migrate+remove is active again by presence (review #5)', async () => {
    await seedLegacy('t');
    const { migrateLegacyHttpProvider, legacySingletonActive } = await import(
      '../providers/http/store.js'
    );
    await migrateLegacyHttpProvider({ name: 'company' });
    expect(await legacySingletonActive()).toBe(false); // legacy dir deleted

    // Simulate `source add-http` / `init --http` writing a fresh legacy config
    // after the provider was removed: presence alone makes it active again, with
    // no marker bookkeeping to get stuck.
    await seedLegacy('t2');
    expect(await legacySingletonActive()).toBe(true);
  });
});

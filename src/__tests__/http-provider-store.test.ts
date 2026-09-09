import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addHttpProvider,
  listHttpProviderConfigs,
  readHttpProviderCredential,
  removeHttpProviderConfig,
  migrateLegacyHttpProvider,
} from '../providers/http/store.js';

describe('HTTP provider store', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-provider-store-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('isolates config and credentials by provider name', async () => {
    await addHttpProvider({ name: 'corp', adapter: 'clawpro', endpoint: 'https://corp.test/', priority: 80 }, 'corp-token');
    await addHttpProvider({ name: 'community', adapter: 'clawpro', endpoint: 'https://community.test', priority: 40 }, 'community-token');

    const configs = await listHttpProviderConfigs();
    expect(configs.map((item) => item.name)).toEqual(['corp', 'community']);
    expect(configs[0]).not.toHaveProperty('token');
    expect(await readHttpProviderCredential('corp')).toBe('corp-token');
    expect(await readHttpProviderCredential('community')).toBe('community-token');
    expect(fs.statSync(path.join(home, '.teamai', 'credentials', 'corp')).mode & 0o777).toBe(0o600);
  });

  it('removes only the selected provider state', async () => {
    await addHttpProvider({ name: 'one', adapter: 'clawpro', endpoint: 'https://one.test', priority: 1 }, 'one');
    await addHttpProvider({ name: 'two', adapter: 'clawpro', endpoint: 'https://two.test', priority: 2 }, 'two');
    await removeHttpProviderConfig('one');
    expect((await listHttpProviderConfigs()).map((item) => item.name)).toEqual(['two']);
    expect(await readHttpProviderCredential('one')).toBeNull();
    expect(await readHttpProviderCredential('two')).toBe('two');
  });

  it('migrates the legacy singleton atomically and keeps it as a disabled rollback snapshot', async () => {
    const legacy = path.join(home, '.teamai', 'local-agent');
    await fs.promises.mkdir(legacy, { recursive: true });
    await fs.promises.writeFile(path.join(legacy, 'config.json'), JSON.stringify({
      endpoint: 'https://legacy.test/', token: 'legacy-token', workspaceBindings: {},
    }));
    await fs.promises.writeFile(path.join(legacy, 'manifest.json'), JSON.stringify({ scopes: {} }));

    const config = await migrateLegacyHttpProvider('company', 90);
    expect(config).toMatchObject({ name: 'company', adapter: 'clawpro', endpoint: 'https://legacy.test', priority: 90 });
    expect(await readHttpProviderCredential('company')).toBe('legacy-token');
    expect(fs.existsSync(path.join(home, '.teamai', 'providers', 'http', 'company', 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(legacy, 'migrated-to'), 'utf8').trim()).toBe('company');
  });
});

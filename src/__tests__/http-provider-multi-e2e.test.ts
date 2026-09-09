import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addHttpProvider } from '../providers/http/store.js';
import { createHttpResourceProvider } from '../providers/http/registry.js';
import { ClawProAdapter } from '../providers/http/adapters/clawpro/index.js';
import { syncHttpProvidersFromHook } from '../providers/http/sync.js';

describe('multiple HTTP resource providers', () => {
  let home: string;
  const servers: http.Server[] = [];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-http-providers-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('TEAMAI_BIND_PROMPT_ENABLED', '0');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function backend(failSync = false): Promise<{ endpoint: string; calls: string[] }> {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      calls.push(req.url ?? '');
      res.writeHead(failSync && req.url?.endsWith('/sync') ? 500 : 200, { 'content-type': 'application/json' });
      res.end(failSync && req.url?.endsWith('/sync') ? JSON.stringify({ error: 'offline' }) : JSON.stringify({ cmds: [] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    return { endpoint: `http://127.0.0.1:${address.port}`, calls };
  }

  it('dispatches each provider once, isolates failure, and keeps state separate', async () => {
    const one = await backend(true);
    const two = await backend();
    for (const [name, remote, priority] of [['one', one, 100], ['two', two, 50]] as const) {
      const config = await addHttpProvider({ name, adapter: 'clawpro', endpoint: remote.endpoint, priority });
      const provider = createHttpResourceProvider(config);
      expect(provider.adapter).toBeInstanceOf(ClawProAdapter);
      await (provider.adapter as ClawProAdapter).initialize(config, `${name}-token`);
    }

    await expect(syncHttpProvidersFromHook({
      hook_event_name: 'Stop',
      session_id: 'multi-provider-session',
    }, 'claude')).resolves.toBeNull();

    expect(one.calls.filter((route) => route.endsWith('/report'))).toHaveLength(1);
    expect(one.calls.filter((route) => route.endsWith('/sync'))).toHaveLength(1);
    expect(two.calls.filter((route) => route.endsWith('/report'))).toHaveLength(1);
    expect(two.calls.filter((route) => route.endsWith('/sync'))).toHaveLength(1);
    expect(fs.existsSync(path.join(home, '.teamai', 'providers', 'http', 'one', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.teamai', 'providers', 'http', 'two', 'config.json'))).toBe(true);
  });
});

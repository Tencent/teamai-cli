import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { buildConfigUiFixture, type ConfigUiFixture } from './helpers/config-ui-fixture.js';
import { createConfigUiServer, type ConfigUiServer } from '../config-ui.js';

let fixture: ConfigUiFixture;
let ui: ConfigUiServer;
let base: string;

beforeAll(async () => {
  fixture = buildConfigUiFixture();
  ui = await createConfigUiServer({ port: 0, scope: 'user' });
  await ui.start();
  base = `http://127.0.0.1:${ui.port}`;
});

afterAll(async () => {
  await ui.stop();
  fixture.cleanup();
});

async function postJson(p: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

function readConfig(): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(path.join(fixture.home, '.teamai', 'config.yaml'), 'utf8'));
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(fixture.home, '.teamai', 'config.yaml'), YAML.stringify(cfg));
}

describe('GET /api/roles', () => {
  it('returns the manifest, binding, effective namespaces, and stale=false', async () => {
    const res = await fetch(base + '/api/roles?scope=user');
    const d = await res.json();
    expect(d.version).toBe(7);
    expect(d.roles.map((r: any) => r.id).sort()).toEqual(['dev', 'ops']);
    expect(d.roles[0].skillNamespaces).toBeDefined();
    expect(d.binding.primaryRole).toBe('dev');
    expect(d.binding.additionalRoles).toEqual([]);
    expect(d.binding.stale).toBe(false); // resourceProfileVersion 7 === version 7
    expect(d.effective).toEqual({ skills: ['core', 'shared'], knowledge: ['common'] });
  });

  it('flags stale when the config profile version lags the manifest', async () => {
    const cfg = readConfig();
    cfg.resourceProfileVersion = 5;
    writeConfig(cfg);
    try {
      const res = await fetch(base + '/api/roles?scope=user');
      const d = await res.json();
      expect(d.binding.stale).toBe(true);
    } finally {
      cfg.resourceProfileVersion = 7;
      writeConfig(cfg);
    }
  });
});

describe('POST /api/roles/bind', () => {
  it('rejects unknown role ids with the valid list', async () => {
    const res = await postJson('/api/roles/bind', { scope: 'user', primaryRole: 'ghost' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0].key).toBe('primaryRole');
    expect(res.body.roles.sort()).toEqual(['dev', 'ops']);
    expect(readConfig().primaryRole).toBe('dev'); // unchanged
  });

  it('rejects unknown additional roles per id', async () => {
    const res = await postJson('/api/roles/bind', { scope: 'user', additionalRoles: ['dev', 'nope'] });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toContain('nope');
  });

  it('binds valid roles through the registry and returns the next-pull hint', async () => {
    const res = await postJson('/api/roles/bind', { scope: 'user', primaryRole: 'ops', additionalRoles: ['dev'] });
    expect(res.status).toBe(200);
    expect(res.body.binding.primaryRole).toBe('ops');
    expect(res.body.binding.additionalRoles).toEqual(['dev']);
    expect(res.body.hint).toContain('next pull');

    const cfg = readConfig();
    expect(cfg.primaryRole).toBe('ops');
    expect(cfg.additionalRoles).toEqual(['dev']);

    // effective namespaces now merge both roles, deduplicated, in order
    expect(res.body.effective.skills).toEqual(['ops', 'core', 'shared']);
    expect(res.body.effective.knowledge).toEqual(['runbooks', 'common']);
  });

  it('rejects empty bind payloads', async () => {
    const res = await postJson('/api/roles/bind', { scope: 'user' });
    expect(res.status).toBe(400);
  });
});

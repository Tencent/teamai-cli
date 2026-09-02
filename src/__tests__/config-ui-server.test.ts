import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildConfigUiFixture, type ConfigUiFixture } from './helpers/config-ui-fixture.js';
import { createConfigUiServer, type ConfigUiServer } from '../config-ui.js';
import { createJobRunner } from '../config-ui-jobs.js';

let fixture: ConfigUiFixture;
let ui: ConfigUiServer;
let base: string;
/** Captured spawn args from the injected runner. */
const spawnedArgs: string[][] = [];

beforeAll(async () => {
  fixture = buildConfigUiFixture();
  const jobs = createJobRunner(async (args) => {
    spawnedArgs.push(args);
    return { code: 0, output: `mocked: teamai ${args.join(' ')}` };
  });
  ui = await createConfigUiServer({ port: 0, scope: 'user', jobs });
  await ui.start();
  base = `http://127.0.0.1:${ui.port}`;
});

afterAll(async () => {
  await ui.stop();
  fixture.cleanup();
});

async function get(p: string): Promise<{ status: number; headers: Headers; body: string; json: any }> {
  const res = await fetch(base + p);
  const body = await res.text();
  let json: any = null;
  try { json = JSON.parse(body); } catch { /* html */ }
  return { status: res.status, headers: res.headers, body, json };
}

async function post(p: string, data: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string; json: any }> {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  });
  const body = await res.text();
  let json: any = null;
  try { json = JSON.parse(body); } catch { /* empty */ }
  return { status: res.status, body, json };
}

/** Raw request with full header control. */
function rawRequest(opts: { path: string; method?: string; host?: string; origin?: string; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ui.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.host ? { Host: opts.host } : {}),
          ...(opts.origin ? { Origin: opts.origin } : {}),
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('config-ui server — happy paths', () => {
  it('serves the Chinese six-tab HTML at /', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    for (const zh of ['配置台', '仓库', '分支', '角色', '资源', '设置', '同步']) {
      expect(res.body).toContain(zh);
    }
  });

  it('GET /api/repo matches the fixture clone', async () => {
    const res = await get('/api/repo');
    expect(res.status).toBe(200);
    expect(res.json.initialized).toBe(true);
    expect(res.json.scope).toBe('user');
    expect(res.json.kind).toBe('git');
    expect(res.json.provider).toBe('git');
    expect(res.json.username).toBe('tester');
    expect(res.json.trackedBranch).toBeNull(); // no branch pinned
    expect(res.json.defaultBranch).toBe('master');
    expect(res.json.state.pendingPushes).toBe(0);
    const health = res.json.health;
    expect(health.checkoutOk).toBe(true);
    expect(health.originHeadOk).toBe(true);
    expect(health.behind).toBe(0);
  });

  it('GET /api/repo/branches lists remote heads with markers', async () => {
    const res = await get('/api/repo/branches');
    expect(res.status).toBe(200);
    const names = res.json.branches.map((b: any) => b.name);
    expect(names.sort()).toEqual(['master', 'release/v2']);
    expect(res.json.currentTracked).toBeNull();
    expect(res.json.defaultBranch).toBe('master');
    for (const b of res.json.branches) {
      expect(b.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('GET /api/config returns a bundle for the scope', async () => {
    const res = await get('/api/config?scope=user');
    expect(res.status).toBe(200);
    expect(res.json.scope).toBe('user');
    expect(res.json.localConfig.username).toBe('tester');
    const keys = res.json.fields.map((f: any) => f.spec.key);
    expect(keys).toContain('repo.branch');
    expect(keys).toContain('recallEnabled');
    expect(res.json.options.roles.sort()).toEqual(['dev', 'ops']);
  });

  it('unknown routes return JSON 404', async () => {
    const res = await get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.json.error).toContain('not found');
  });

  it('GET /api/jobs/:id returns 404 for unknown jobs', async () => {
    const res = await get('/api/jobs/job_missing');
    expect(res.status).toBe(404);
  });
});

describe('config-ui server — security guards', () => {
  it('never sends a CORS header', async () => {
    for (const p of ['/', '/api/repo', '/api/resources']) {
      const res = await get(p);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('binds 127.0.0.1 only', () => {
    expect(ui.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('rejects cross-origin POST with 403', async () => {
    const res = await post('/api/sync', {}, { Origin: 'http://evil.example' });
    expect(res.status).toBe(403);
  });

  it('allows same-origin POST', async () => {
    const res = await post('/api/sync', {}, { Origin: `http://127.0.0.1:${ui.port}` });
    expect(res.status).toBe(202);
    expect(res.json.jobId).toBeTruthy();
  });

  it('rejects non-local Host headers with 403 (DNS-rebinding guard)', async () => {
    const res = await rawRequest({ path: '/api/repo', host: 'evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects non-JSON content types on POST with 415', async () => {
    const res = await rawRequest({ path: '/api/sync', method: 'POST', body: 'x' , origin: undefined });
    // rawRequest always sets application/json when body present; do a text/plain one via fetch instead
    const res2 = await fetch(base + '/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res2.status).toBe(415);
  });

  it('rejects JSON bodies over 1 MB with 413', async () => {
    const big = JSON.stringify({ updates: { x: 'y'.repeat(1100 * 1024) } });
    const res = await post('/api/config', big);
    expect(res.status).toBe(413);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await post('/api/config', '{not json');
    expect(res.status).toBe(400);
  });
});

describe('config-ui server — write routes', () => {
  it('POST /api/config validates via the registry and reports per-key errors', async () => {
    const res = await post('/api/config', { scope: 'user', updates: { updatePolicy: 'sometimes' } });
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(res.json.errors[0].key).toBe('updatePolicy');
  });

  it('POST /api/config persists valid updates', async () => {
    const res = await post('/api/config', { scope: 'user', updates: { updatePolicy: 'skip' } });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const cfg = fs.readFileSync(path.join(fixture.home, '.teamai', 'config.yaml'), 'utf8');
    expect(cfg).toContain('skip');
  });

  it('POST /api/config with sync starts a job', async () => {
    const res = await post('/api/config', { scope: 'user', updates: { updatePolicy: 'auto' }, sync: true });
    expect(res.status).toBe(200);
    expect(res.json.jobId).toBeTruthy();
  });

  it('POST /api/repo/reinit rejects invalid branches with the valid list', async () => {
    const res = await post('/api/repo/reinit', { branch: 'evil', scope: 'user' });
    expect(res.status).toBe(400);
    expect(res.json.branches.sort()).toEqual(['master', 'release/v2']);
  });

  it('POST /api/repo/reinit returns 409 with dirty files when the clone is dirty', async () => {
    const dirty = path.join(fixture.repoPath, 'uncommitted.txt');
    fs.writeFileSync(dirty, 'local change');
    try {
      const res = await post('/api/repo/reinit', { branch: 'release/v2', scope: 'user' });
      expect(res.status).toBe(409);
      expect(res.json.dirtyFiles.some((f: string) => f.includes('uncommitted.txt'))).toBe(true);

      // force bypasses the dirty gate
      const forced = await post('/api/repo/reinit', { branch: 'release/v2', scope: 'user', force: true });
      expect(forced.status).toBe(202);
      expect(forced.json.jobId).toBeTruthy();
    } finally {
      fs.rmSync(dirty, { force: true });
    }
  });

  it('reinit jobs spawn init --branch then pull --force (validated order)', async () => {
    spawnedArgs.length = 0;
    const res = await post('/api/repo/reinit', { branch: null, scope: 'user' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50)); // let the (mocked) sequence run
    expect(spawnedArgs.length).toBeGreaterThanOrEqual(2);
    const init = spawnedArgs[0];
    const pull = spawnedArgs[1];
    expect(init[0]).toBe('init');
    expect(init).toContain('https://git.example.com/fixture/team.git');
    expect(init).not.toContain('--branch'); // returning to default
    expect(init).toContain('--scope');
    expect(init).toContain('user');
    expect(init).toContain('--force');
    expect(init).toContain('--role');
    expect(init).toContain('dev');
    expect(pull[0]).toBe('pull');
    expect(pull).toContain('--force');
  });

  it('snapshots the default branch into state on first reinit', async () => {
    const statePath = path.join(fixture.home, '.teamai', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(state.teamRepoDefaultBranch).toBe('master');
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
vi.mock('../utils/home.js', () => ({ getUserHome: () => tmpHome }));

import { contributeLearning, nextSeq, reportEvents, saveCredentials, submitChangeset, uploadBlob, type ChangeOp } from '../server-repo.js';

const creds = { server: 'https://s', accessToken: 'at', refreshToken: 'rt', machineId: 'm1' };

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-server-write-'));
  await saveCredentials(creds);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('uploadBlob', () => {
  it('sends raw bytes with the sha256 header', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://s/v1/blobs');
      const h = init!.headers as Record<string, string>;
      expect(h['X-Sha256']).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(h['Content-Type']).toBe('application/octet-stream');
      return json({ sha256: h['X-Sha256'], size: 5 }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);
    const ref = await uploadBlob(creds, Buffer.from('hello'));
    expect(ref.size).toBe(5);
    expect(ref.sha256).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('submitChangeset', () => {
  const op: ChangeOp = { op: 'put', level: 'project', project_id: 'p1', kind: 'rule', name: 'naming', files: [{ path: 'RULE.md', sha256: 'sha256:x', size: 1 }] };

  it('creates and submits a new change set when none is open', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith('/v1/change-sets?view=mine')) return json({ items: [] });
      if (url.endsWith('/v1/change-sets')) return json({ id: 'cs1', state: 'draft', title: 'put rule/naming', etag: 'e1', ops: [op] }, 201);
      if (url.endsWith('/v1/change-sets/cs1/submit')) return json({ id: 'cs1', state: 'in_review', title: 'put rule/naming', etag: 'e2', ops: [op] });
      throw new Error(`unexpected ${url}`);
    }));
    const cs = await submitChangeset(creds, { title: 'put rule/naming', ops: [op] });
    expect(cs.state).toBe('in_review');
    expect(calls).toEqual(['GET https://s/v1/change-sets?view=mine', 'POST https://s/v1/change-sets', 'POST https://s/v1/change-sets/cs1/submit']);
  });

  it('folds the operation into my open change set that already touches the resource', async () => {
    const other: ChangeOp = { op: 'put', level: 'project', project_id: 'p1', kind: 'skill', name: 'deploy' };
    const stale: ChangeOp = { ...op, files: [{ path: 'RULE.md', sha256: 'sha256:old', size: 1 }] };
    let patched: { ops: ChangeOp[]; title: string } | null = null;
    let ifMatch = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/change-sets?view=mine')) return json({ items: [{ id: 'cs9', state: 'in_review', title: 'earlier', etag: 'e9', ops: [stale, other] }] });
      if (url.endsWith('/v1/change-sets/cs9') && init?.method === 'GET') return json({ id: 'cs9', state: 'in_review', title: 'earlier', etag: 'e9', ops: [stale, other] });
      if (url.endsWith('/v1/change-sets/cs9') && init?.method === 'PATCH') {
        ifMatch = (init.headers as Record<string, string>)['If-Match'];
        patched = JSON.parse(init.body as string);
        return json({ id: 'cs9', state: 'draft', title: 'earlier', etag: 'e10', ops: patched!.ops });
      }
      if (url.endsWith('/v1/change-sets/cs9/submit')) return json({ id: 'cs9', state: 'in_review', title: 'earlier', etag: 'e11', ops: patched!.ops });
      throw new Error(`unexpected ${init?.method} ${url}`);
    }));
    const cs = await submitChangeset(creds, { title: 'put rule/naming', ops: [op] });
    expect(cs.id).toBe('cs9');
    expect(ifMatch).toBe('"e9"');
    expect(patched!.title).toBe('earlier');
    // the stale copy of naming is replaced, the unrelated skill is kept
    expect(patched!.ops.map((o) => `${o.kind}/${o.name}:${o.files?.[0]?.sha256 ?? ''}`).sort()).toEqual(['rule/naming:sha256:x', 'skill/deploy:']);
  });
});

describe('contributeLearning + reportEvents', () => {
  it('posts learnings and events with a monotonic per-machine sequence', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push({ url, ...JSON.parse(init!.body as string) });
      if (url.endsWith('/v1/learnings')) return json({ id: 'cs2', state: 'published', title: 't', etag: 'e', ops: [{ op: 'put', level: 'project', kind: 'learning', name: 'l-2026' }] }, 201);
      if (url.endsWith('/v1/reports/events')) return json({ accepted: ['a', 'b'], max_seq: 2 });
      throw new Error(`unexpected ${url}`);
    }));
    const cs = await contributeLearning(creds, { title: 't', content: '# t\nbody', projectId: 'p1' });
    expect(cs.ops[0].name).toBe('l-2026');
    const first = await nextSeq(2);
    const again = await nextSeq(1);
    expect([first, again]).toEqual([1, 3]);
    const ack = await reportEvents(creds, [
      { event_id: 'a', seq: 1, type: 'skill_usage', occurred_at: new Date().toISOString(), payload: { skill: 'x', count: 1 } },
      { event_id: 'b', seq: 2, type: 'usage_daily', occurred_at: new Date().toISOString(), payload: { day: '2026-09-11' } },
    ]);
    expect(ack.accepted).toEqual(['a', 'b']);
    expect((bodies[1] as { events: unknown[] }).events).toHaveLength(2);
  });
});

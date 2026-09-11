import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
vi.mock('../utils/home.js', () => ({ getUserHome: () => tmpHome }));

import { renderSnapshot, type ServerSnapshot } from '../server-format.js';
import { applyFiles, classify, deviceLogin, loadJournal, sha256Hex, syncServerRepo, saveCredentials, purgeOwned } from '../server-repo.js';
import type { LocalConfig } from '../types.js';

function blobStore(files: Record<string, string>) {
  const store = new Map<string, Buffer>();
  const ref = (content: string) => {
    const b = Buffer.from(content);
    const sha = `sha256:${sha256Hex(b)}`;
    store.set(sha, b);
    return { sha256: sha, size: b.length };
  };
  const entries = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, ref(v)]));
  return { store, entries, read: async (sha: string) => store.get(sha)! };
}

function snapshot(): { snap: ServerSnapshot; read: (sha: string) => Promise<Buffer>; store: Map<string, Buffer> } {
  const { store, entries, read } = blobStore({
    skill: '---\ndescription: deploy\n---\n\nsteps\n',
    ref: '# checklist\n',
    rule: '# naming\n',
    agent: 'name: reviewer\ndescription: r\ninstructions: |\n  review\n',
    env: 'value: https://api\ndescription: gateway\n',
    secret: 'secret: true\ndescription: token\n',
    hook: 'id: lint\nevent: PostToolUse\ncommand: scripts/lint.sh\n',
    script: '#!/bin/sh\necho ok\n',
    mcp: 'name: fs\ntransport: stdio\ncommand: npx\n',
    claudemd: '# conventions\n',
    culture: '# culture\n',
    learning: '---\ntitle: t\n---\nbody\n',
  });
  const snap: ServerSnapshot = {
    revision: 'sha256:rev1',
    org: { id: 'o', slug: 'acme', name: 'Acme' },
    projects: [{ id: 'p1', slug: 'billing', name: 'Billing' }],
    policy: { enforced_rules: ['naming'], hooks_auto_apply: true, recall_enabled: true },
    culture: { kind: 'culture', name: 'culture', status: 'ok', files: [{ path: 'CULTURE.md', ...entries.culture }] },
    resources: [
      { kind: 'skill', name: 'deploy', namespace: 'billing', status: 'ok', tags: ['ops'], files: [{ path: 'SKILL.md', ...entries.skill }, { path: 'references/checklist.md', ...entries.ref }] },
      { kind: 'rule', name: 'naming', status: 'ok', files: [{ path: 'RULE.md', ...entries.rule }] },
      { kind: 'agent', name: 'reviewer', status: 'ok', files: [{ path: 'AGENT.yaml', ...entries.agent }] },
      { kind: 'env', name: 'API_BASE', status: 'ok', files: [{ path: 'ENV.yaml', ...entries.env }] },
      { kind: 'env', name: 'API_TOKEN', status: 'ok', files: [{ path: 'ENV.yaml', ...entries.secret }] },
      { kind: 'hook', name: 'lint', status: 'ok', files: [{ path: 'HOOK.yaml', ...entries.hook }, { path: 'scripts/lint.sh', ...entries.script }] },
      { kind: 'mcp', name: 'fs', status: 'ok', files: [{ path: 'MCP.yaml', ...entries.mcp }] },
      { kind: 'claudemd', name: 'conventions', namespace: 'common', status: 'ok', files: [{ path: 'CLAUDEMD.md', ...entries.claudemd }] },
      { kind: 'learning', name: 'l1', status: 'ok', files: [{ path: 'LEARNING.md', ...entries.learning }] },
      { kind: 'rule', name: 'clash', status: 'conflict', conflict: { owners: ['a', 'b'] } },
    ],
  };
  return { snap, read, store };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-server-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('renderSnapshot', () => {
  it('produces the flat team-repo layout', async () => {
    const { snap, read } = snapshot();
    const files = await renderSnapshot(snap, read, 'https://console.example');
    const paths = [...files.keys()].sort();
    expect(paths).toEqual([
      'agents/reviewer.yaml', 'claudemd/common/conventions.md', 'culture.md', 'env/env.yaml', 'hooks/hooks.yaml',
      'hooks/scripts/lint.sh', 'learnings/l1.md', 'mcp/mcp.yaml', 'rules/naming.md',
      'skills/deploy/SKILL.md', 'skills/deploy/references/checklist.md', 'tags.yaml', 'teamai.yaml',
    ]);
    expect(files.get('env/env.yaml')!.toString()).toBe(
      'variables:\n  - key: API_BASE\n    value: https://api\n    description: gateway\n  - key: API_TOKEN\n    value: ""\n    # secret: 值不在服务端，需在本机设置\n    description: token\n',
    );
    expect(files.get('hooks/hooks.yaml')!.toString()).toBe('hooks:\n  - id: lint\n    event: PostToolUse\n    command: scripts/lint.sh\n');
    const teamai = files.get('teamai.yaml')!.toString();
    expect(teamai).toContain('team: "acme"');
    expect(teamai).toContain('mode: server');
    expect(teamai).toContain('enforced: ["naming"]');
    expect(files.get('tags.yaml')!.toString()).toBe('version: 1\nskills:\n  deploy: ["ops"]\n');
  });
});

describe('applyFiles', () => {
  it('installs, updates our own files, and never overwrites local edits', async () => {
    const localPath = path.join(tmpHome, 'team-repo');
    const v1 = new Map([['rules/a.md', Buffer.from('a1')], ['rules/b.md', Buffer.from('b1')]]);
    const first = await applyFiles(localPath, v1, { revision: '', files: {} });
    expect(first.results.map((r) => r.action)).toEqual(['installed', 'installed']);

    // member edits b; server updates both and drops nothing
    fs.writeFileSync(path.join(localPath, 'rules/b.md'), 'mine');
    const v2 = new Map([['rules/a.md', Buffer.from('a2')], ['rules/b.md', Buffer.from('b2')]]);
    const second = await applyFiles(localPath, v2, first.journal);
    expect(second.results).toEqual([
      { kind: 'rule', name: 'a', action: 'updated' },
      { kind: 'rule', name: 'b', action: 'conflict_skipped' },
    ]);
    expect(fs.readFileSync(path.join(localPath, 'rules/b.md'), 'utf8')).toBe('mine');

    // a disappears from the manifest → removed (it is still ours); b is the member's now and is left alone
    const v3 = new Map<string, Buffer>();
    const third = await applyFiles(localPath, v3, second.journal);
    expect(third.results.map((r) => `${r.name}:${r.action}`)).toEqual(['a:removed']);
    expect(fs.existsSync(path.join(localPath, 'rules/a.md'))).toBe(false);
    expect(fs.readFileSync(path.join(localPath, 'rules/b.md'), 'utf8')).toBe('mine');
  });

  it('classifies rendered paths back to kinds', () => {
    expect(classify('skills/deploy/SKILL.md')).toEqual({ kind: 'skill', name: 'deploy' });
    expect(classify('claudemd/common/x.md')).toEqual({ kind: 'claudemd', name: 'x' });
    expect(classify('hooks/scripts/lint.sh')).toEqual({ kind: 'hook', name: 'scripts/lint.sh' });
  });
});

describe('deviceLogin', () => {
  it('polls until approved and stores credentials 0600', async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/auth/device/start')) {
        return new Response(JSON.stringify({ device_code: 'dc', user_code: 'AB12-CD34', verification_url: 'https://s/activate', interval: 1 }), { status: 200 });
      }
      if (url.endsWith('/v1/auth/device/poll')) {
        polls++;
        if (polls < 2) return new Response(JSON.stringify({ error: { code: 'AUTHORIZATION_PENDING', message: 'wait' } }), { status: 428 });
        return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', machine_id: 'm1', enrollment_project_ids: ['p1'] }), { status: 200 });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const shown: string[] = [];
    const result = await deviceLogin('https://s', { onCode: (c) => shown.push(c), sleep: async () => {} });
    expect(shown).toEqual(['AB12-CD34']);
    expect(result.enrollmentProjectIds).toEqual(['p1']);
    const credsPath = path.join(tmpHome, '.teamai', 'server-credentials.json');
    expect(JSON.parse(fs.readFileSync(credsPath, 'utf8')).accessToken).toBe('at');
    if (process.platform !== 'win32') {
      expect(fs.statSync(credsPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe('syncServerRepo', () => {
  it('materializes a snapshot, reports results, then returns unchanged on 304', async () => {
    const { snap, store } = snapshot();
    await saveCredentials({ server: 'https://s', accessToken: 'at', refreshToken: 'rt', machineId: 'm1' });
    const reports: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer at');
      expect(headers['X-Client-Version']).toBeTruthy();
      if (url.endsWith('/v1/bindings/b1/snapshot')) {
        if (headers['If-None-Match'] === '"sha256:rev1"') return new Response(null, { status: 304 });
        return new Response(JSON.stringify(snap), { status: 200, headers: { etag: '"sha256:rev1"' } });
      }
      if (url.includes('/v1/blobs/')) {
        const sha = url.slice(url.indexOf('/v1/blobs/') + '/v1/blobs/'.length);
        const b = store.get(sha);
        return b ? new Response(new Uint8Array(b), { status: 200 }) : new Response('', { status: 404 });
      }
      if (url.endsWith('/v1/bindings/b1/sync-results')) {
        reports.push(JSON.parse(init!.body as string));
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const localPath = path.join(tmpHome, 'team-repo');
    const config: LocalConfig = { repo: { localPath, remote: 'https://s', kind: 'server', url: 'https://s', bindingId: 'b1' }, username: 'u', scope: 'user', additionalRoles: [] };

    const first = await syncServerRepo(config);
    expect(first.changed).toBe(true);
    expect(first.conflicts).toEqual([{ kind: 'rule', name: 'clash' }]);
    expect(fs.readFileSync(path.join(localPath, 'skills/deploy/SKILL.md'), 'utf8')).toContain('deploy');
    expect((await loadJournal(localPath)).revision).toBe('sha256:rev1');
    expect(reports).toHaveLength(1);
    expect((reports[0] as { applied_revision: string }).applied_revision).toBe('sha256:rev1');

    const second = await syncServerRepo(config);
    expect(second.changed).toBe(false);
    // blob cache: second full sync must not re-download
    const blobCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/blobs/')).length;
    await syncServerRepo(config, { force: true });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/v1/blobs/')).length).toBe(blobCalls);

    // purge removes only our untouched files
    fs.writeFileSync(path.join(localPath, 'rules/naming.md'), 'edited');
    const n = await purgeOwned(localPath);
    expect(n).toBeGreaterThan(5);
    expect(fs.existsSync(path.join(localPath, 'rules/naming.md'))).toBe(true);
    expect(fs.existsSync(path.join(localPath, 'skills/deploy'))).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildConfigUiFixture, type ConfigUiFixture } from './helpers/config-ui-fixture.js';
import { createConfigUiServer, type ConfigUiServer } from '../config-ui.js';
import { buildIndex } from '../utils/search-index.js';

let fixture: ConfigUiFixture;
let ui: ConfigUiServer;
let base: string;

beforeAll(async () => {
  fixture = buildConfigUiFixture();
  // Learning previews resolve through the recall index — build it for this fixture.
  await buildIndex({ learningsDir: path.join(fixture.repoPath, 'learnings'), indexPath: path.join(fixture.home, '.teamai', 'search-index.json') });
  ui = await createConfigUiServer({ port: 0, scope: 'user' });
  await ui.start();
  base = `http://127.0.0.1:${ui.port}`;
});

afterAll(async () => {
  await ui.stop();
  fixture.cleanup();
});

async function preview(type: string, id: string): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(base + `/api/resources/preview?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  const raw = await res.text();
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* ignore */ }
  return { status: res.status, body, raw };
}

describe('preview dual gate', () => {
  it('serves whitelisted markdown content for a skill', async () => {
    const res = await preview('skill', 'code-review');
    expect(res.status).toBe(200);
    expect(res.body.language).toBe('markdown');
    expect(res.body.content).toContain('code-review');
    expect(res.body.content).toContain('评审代码');
    expect(res.body.path).toContain(path.join('skills', 'core', 'code-review', 'SKILL.md'));
  });

  it('serves rule/doc/agent/hook/mcp/role/culture previews', async () => {
    expect((await preview('rule', 'coding-style')).status).toBe(200);
    expect((await preview('doc', 'onboarding')).body.content).toContain('入职指南');
    expect((await preview('agent', 'teamai-helper')).body.language).toBe('yaml');
    expect((await preview('hook', 'block-force-push')).body.content).toContain('block-force-push');
    expect((await preview('mcp', 'fixture-mcp')).body.content).toContain('fixture-mcp');
    expect((await preview('role', 'dev')).body.content).toContain('roles:');
    expect((await preview('culture', 'culture.md')).body.content).toContain('团队文化');
  });

  it('rejects non-whitelisted ids with 404', async () => {
    expect((await preview('skill', 'nonexistent-skill')).status).toBe(404);
    expect((await preview('doc', 'no-such-doc')).status).toBe(404);
    expect((await preview('hook', 'no-such-hook')).status).toBe(404);
    expect((await preview('role', 'ghost')).status).toBe(404);
    expect((await preview('unknown-type', 'x')).status).toBe(404);
  });

  it('rejects path traversal ids with 404', async () => {
    const res = await preview('doc', '../../../etc/passwd');
    expect(res.status).toBe(404);
    const res2 = await preview('skill', '../../teamai.yaml');
    expect(res2.status).toBe(404);
  });

  it('rejects symlink escapes via assertSafePath (whitelist alone is not enough)', async () => {
    // Plant a real skill OUTSIDE the skills root, then symlink it in so the
    // scan whitelist passes but the symlink-resolved containment check must fail.
    const outside = path.join(fixture.root, 'outside-payload');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'SKILL.md'), '# 逃逸内容 secret-payload-xyz\n');
    const link = path.join(fixture.repoPath, 'skills', 'core', 'escaped');
    fs.symlinkSync(outside, link);
    try {
      const res = await preview('skill', 'escaped');
      expect(res.status).toBe(404);
      expect(res.raw).not.toContain('secret-payload-xyz');
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('always 403s env previews, regardless of id', async () => {
    const res = await preview('env', 'TEAM_API_ENDPOINT');
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain(fixture.envSecretValue);
    expect((await preview('env', 'anything')).status).toBe(403);
  });

  it('caps preview content at 200 KB with truncated flag', async () => {
    const bigSkill = path.join(fixture.repoPath, 'skills', 'core', 'big-skill');
    fs.mkdirSync(bigSkill, { recursive: true });
    fs.writeFileSync(path.join(bigSkill, 'SKILL.md'), `---\nname: big-skill\ndescription: big\n---\n\n${'x'.repeat(250 * 1024)}\n`);
    try {
      const res = await preview('skill', 'big-skill');
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(true);
      expect(Buffer.byteLength(res.body.content, 'utf8')).toBeLessThanOrEqual(200 * 1024);
    } finally {
      fs.rmSync(bigSkill, { recursive: true, force: true });
    }
  });

  it('serves learning previews from the recall index whitelist', async () => {
    const res = await preview('learning', 'deploy-timeout-fix.md');
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('部署超时');
  });
});

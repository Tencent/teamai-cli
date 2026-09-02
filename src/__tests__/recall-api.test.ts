import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildConfigUiFixture, type ConfigUiFixture } from './helpers/config-ui-fixture.js';
import { createConfigUiServer, type ConfigUiServer } from '../config-ui.js';
import { buildIndex } from '../utils/search-index.js';

let fixture: ConfigUiFixture;
let ui: ConfigUiServer;
let base: string;
let indexPath: string;

beforeAll(async () => {
  fixture = buildConfigUiFixture();
  indexPath = path.join(fixture.home, '.teamai', 'search-index.json');
  await buildIndex({ learningsDir: path.join(fixture.repoPath, 'learnings'), indexPath });
  ui = await createConfigUiServer({ port: 0, scope: 'user' });
  await ui.start();
  base = `http://127.0.0.1:${ui.port}`;
});

afterAll(async () => {
  await ui.stop();
  fixture.cleanup();
});

async function search(q: string, limit = 5): Promise<any> {
  const res = await fetch(base + `/api/recall/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return res.json();
}

describe('GET /api/recall/search', () => {
  it('returns ranked results from the fixture index', async () => {
    const d = await search('部署 超时');
    expect(d.status).toBe('fresh');
    expect(d.results.length).toBeGreaterThan(0);
    expect(d.results[0].title).toBe('部署超时排查');
    expect(d.results[0].score).toBeGreaterThan(0);
    expect(d.results[0].snippet.length).toBeGreaterThan(0);
  });

  it('matches a different query to a different document', async () => {
    const d = await search('api 限流');
    expect(d.results[0].title).toBe('API 限流处理');
  });

  it('returns an empty list for non-matching queries (no error)', async () => {
    const d = await search('zzz-no-such-topic-qqq');
    expect(d.results).toEqual([]);
  });

  it('rebuilds a missing index on demand (status rebuilt)', async () => {
    fs.rmSync(indexPath);
    const d = await search('部署 超时');
    expect(d.status).toBe('rebuilt');
    expect(d.results[0].title).toBe('部署超时排查');
    expect(fs.existsSync(indexPath)).toBe(true);
  });

  it('reports missing + hint when the index cannot be built', async () => {
    fs.rmSync(indexPath, { force: true });
    // Make the index path unwritable (a directory) so the rebuild attempt fails.
    fs.mkdirSync(indexPath, { recursive: true });
    try {
      const d = await search('部署');
      expect(d.status).toBe('missing');
      expect(d.hint).toContain('teamai pull');
      expect(d.results).toEqual([]);
    } finally {
      fs.rmSync(indexPath, { recursive: true, force: true });
    }
  });

  it('handles empty queries gracefully', async () => {
    const d = await search('');
    expect(d.results).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchRepoSnapshot, materializeHttpRepo, RepoNotAvailableError } from '../source-http.js';
import { startMockServer, type MockServerHandle } from './helpers/mock-server.js';

/** Spin up a one-off server that answers /repo with a fixed status + body. */
async function startRawServer(
  status: number,
  body: string,
  contentType = 'text/html',
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let tmpDir: string;
let server: MockServerHandle;
const API_KEY = 'test-key';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-http-test-'));
});

afterEach(async () => {
  await server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fetchRepoSnapshot', () => {
  it('parses version / files / commands', async () => {
    server = await startMockServer({
      apiKey: API_KEY,
      repo: {
        version: 'abc123',
        files: [{ path: 'teamai.yaml', content: 'team: x\n' }],
        commands: [{ type: 'install_skill', skill_slug: 'weather', skill_version: '1.0.0', download_url: '' }],
      },
    });
    const snap = await fetchRepoSnapshot(server.url, API_KEY);
    expect(snap.version).toBe('abc123');
    expect(snap.files).toHaveLength(1);
    expect(snap.commands[0].skill_slug).toBe('weather');
  });

  it('reports an auth failure on a bad key', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    await expect(fetchRepoSnapshot(server.url, 'wrong-key')).rejects.toThrow(/Authentication failed/);
  });

  it('throws RepoNotAvailableError on HTTP 404 (/repo not live yet)', async () => {
    const raw = await startRawServer(404, 'not found');
    try {
      await expect(fetchRepoSnapshot(raw.url, API_KEY)).rejects.toBeInstanceOf(RepoNotAvailableError);
    } finally {
      await raw.close();
    }
  });

  it('throws RepoNotAvailableError on a 200 non-JSON (SPA HTML) body', async () => {
    const raw = await startRawServer(200, '<!doctype html><html></html>', 'text/html');
    try {
      await expect(fetchRepoSnapshot(raw.url, API_KEY)).rejects.toBeInstanceOf(RepoNotAvailableError);
    } finally {
      await raw.close();
    }
  });

  it('still throws a plain Error (not RepoNotAvailableError) on 500', async () => {
    const raw = await startRawServer(500, 'boom');
    try {
      const err = await fetchRepoSnapshot(raw.url, API_KEY).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RepoNotAvailableError);
    } finally {
      await raw.close();
    }
  });
});

describe('materializeHttpRepo', () => {
  it('writes inlined files and installs skills via commands', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    // Seed /repo now that the server URL (download endpoint) is known.
    server.seedRepo({
      version: 'v9',
      files: [
        { path: 'teamai.yaml', content: 'team: mock\n' },
        { path: 'rules/common/demo.md', content: '# demo\n' },
      ],
      commands: [
        {
          type: 'install_skill',
          skill_slug: 'weather',
          skill_version: '1.0.0',
          download_url: `${server.url}/download?slug=weather&access_token=smh`,
        },
      ],
    });

    const localPath = path.join(tmpDir, 'team-repo');
    const version = await materializeHttpRepo(server.url, localPath, API_KEY);

    expect(version).toBe('v9');
    expect(fs.readFileSync(path.join(localPath, 'teamai.yaml'), 'utf-8')).toContain('team: mock');
    expect(fs.existsSync(path.join(localPath, 'rules', 'common', 'demo.md'))).toBe(true);
    // Skill materialized into localPath/skills/<slug>/ via the shared executor.
    expect(fs.existsSync(path.join(localPath, 'skills', 'weather', 'SKILL.md'))).toBe(true);
  });

  it('rejects a path-traversal file entry', async () => {
    server = await startMockServer({
      apiKey: API_KEY,
      repo: {
        version: 'v1',
        files: [{ path: '../escape.txt', content: 'pwned' }],
        commands: [],
      },
    });
    const localPath = path.join(tmpDir, 'team-repo');
    await expect(materializeHttpRepo(server.url, localPath, API_KEY)).rejects.toThrow(/path traversal/);
  });
});

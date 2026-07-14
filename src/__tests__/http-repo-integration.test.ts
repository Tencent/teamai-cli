import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { startMockServer, type MockServerHandle } from './helpers/mock-server.js';

let tmpDir: string;
let originalHome: string;
let server: MockServerHandle | undefined;
const API_KEY = 'e2e-key';
const ENV_KEYS = ['TEAMAI_API_TOKEN', 'TEAMAI_API_KEY', 'TEAMAI_REPORT_ENDPOINT'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-http-e2e-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeApiKey(): void {
  fs.mkdirSync(path.join(tmpDir, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.teamai', 'apikey'), API_KEY);
}

describe('teamai init --http (read-only onboarding)', () => {
  it('writes a kind:http local config and a teamai.yaml stub (no repo clone)', async () => {
    writeApiKey();
    server = await startMockServer({ apiKey: API_KEY });

    const { init } = await import('../init.js');
    await init({ http: server.url, force: true });

    // Local config written with kind:http and only the URL (no key).
    const cfg = YAML.parse(fs.readFileSync(path.join(tmpDir, '.teamai', 'config.yaml'), 'utf-8'));
    expect(cfg.repo.kind).toBe('http');
    expect(cfg.repo.url).toBe(server.url);
    expect(JSON.stringify(cfg)).not.toContain(API_KEY);

    // A teamai.yaml stub is written to drive hook injection; skills/rules are
    // NOT cloned — they arrive per-session via report/sync.
    const repoPath = path.join(tmpDir, '.teamai', 'team-repo');
    expect(fs.existsSync(path.join(repoPath, 'teamai.yaml'))).toBe(true);
  });
});

describe('read-only protection (http kind)', () => {
  it('rejects teamai push', async () => {
    writeApiKey();
    server = await startMockServer({ apiKey: API_KEY });

    const { init } = await import('../init.js');
    await init({ http: server.url, force: true });

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { push } = await import('../push.js');
      await expect(push({})).rejects.toThrow(/read-only HTTP source/);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('hook registry wiring', () => {
  it('has exactly one HTTP reporter per event (no double report/sync)', async () => {
    const { buildHandlerRegistry } = await import('../hook-handlers.js');
    const reg = buildHandlerRegistry();

    const httpReporters = (event: string) =>
      reg
        .filter((r) => r.event === event)
        .map((r) => r.handler.name)
        .filter((n) => n.includes('status-report') || n.includes('local-agent'));

    expect(httpReporters('session-start')).toEqual(['local-agent-sync']);
    expect(httpReporters('prompt-submit')).toEqual(['local-agent-sync']);
  });
});

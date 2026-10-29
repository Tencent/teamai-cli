import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { startMockServer, type MockServerHandle } from './helpers/mock-server.js';
import { installFakeCodex, readFakeCodexState } from './helpers/fake-codex.js';
import * as gitHook from '../git-hook.js';
import { log } from '../utils/logger.js';

let tmpDir: string;
let originalHome: string;
let server: MockServerHandle | undefined;
const API_KEY = 'e2e-key';
const ENV_KEYS = ['TEAMAI_API_TOKEN', 'TEAMAI_API_KEY', 'TEAMAI_REPORT_ENDPOINT', 'TEAMAI_HTTP_ENDPOINT'];
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
  it.each([false, true])('trusts written Codex SessionStart hooks after project HTTP init, gitHookFailure=%s', async (gitHookFailure) => {
    writeApiKey();
    server = await startMockServer({ apiKey: API_KEY });
    const project = path.join(tmpDir, 'project');
    const codexHome = path.join(tmpDir, '.codex');
    fs.mkdirSync(project);
    fs.mkdirSync(codexHome);
    const fakeBin = installFakeCodex();
    const oldPath = process.env.PATH;
    const oldCwd = process.cwd();
    const oldExitCode = process.exitCode;
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ''}`;
    process.chdir(project);
    const failure = new Error('EACCES: read-only .git/config');
    const install = vi.spyOn(gitHook, 'installGitHook');
    if (gitHookFailure) install.mockRejectedValueOnce(failure);
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    try {
      const { init } = await import('../init.js');
      await init({ http: server.url, force: true, scope: 'project', agent: ['codex'] });
      expect(fs.existsSync(path.join(codexHome, 'hooks.json'))).toBe(true);
      if (gitHookFailure) {
        expect(error).toHaveBeenCalledWith(expect.stringContaining(failure.message));
        expect(process.exitCode).toBe(1);
      }
      const state = readFakeCodexState(codexHome);
      expect(Object.keys(state.hooksState).some((key) => key.includes(':session_start:'))).toBe(true);
      const { loadLocalConfigForScope, loadTeamConfig } = await import('../config.js');
      const config = await loadLocalConfigForScope('project', project);
      if (!config) throw new Error('HTTP init did not write its project config');
      const teamConfig = await loadTeamConfig(config.repo.localPath);
      if (!teamConfig) throw new Error('HTTP init did not write its team config');
      const { readCodexHookTrustForScope } = await import('../hooks.js');
      expect(await readCodexHookTrustForScope(teamConfig, config)).toMatchObject({ kind: 'listed', notTrusted: [] });
    } finally {
      process.exitCode = oldExitCode;
      process.chdir(oldCwd);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      install.mockRestore();
      error.mockRestore();
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('writes a kind:http local config and a teamai.yaml stub (no repo clone)', async () => {
    writeApiKey();
    server = await startMockServer({ apiKey: API_KEY });

    const { init } = await import('../init.js');
    await init({ http: server.url, force: true, scope: 'user' });

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

describe('teamai init --http and the HTTP local agent', () => {
  function localAgentConfig(): { endpoint: string; token?: string } {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.teamai', 'local-agent', 'config.json'), 'utf-8'));
  }

  it('initializes the local agent on a first user-scope init without --force', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    const success = vi.spyOn(log, 'success');

    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });

    expect(success).toHaveBeenCalledWith(expect.stringContaining('HTTP local agent initialized'));
    expect(localAgentConfig()).toMatchObject({ endpoint: server.url, token: API_KEY });
    expect(fs.readFileSync(path.join(tmpDir, '.teamai', 'token'), 'utf-8').trim()).toBe(API_KEY);
  });

  it('sets up the local agent with --token on a first user-scope init while TEAMAI_API_TOKEN holds another key', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    process.env.TEAMAI_API_TOKEN = 'old-key';

    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });

    expect(localAgentConfig()).toMatchObject({ endpoint: server.url, token: API_KEY });
  });

  it('sets up the local agent on a first init while TEAMAI_HTTP_ENDPOINT names another endpoint', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    process.env.TEAMAI_HTTP_ENDPOINT = 'https://env-host.example/api';

    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });

    expect(localAgentConfig()).toMatchObject({ endpoint: server.url, token: API_KEY });
  });

  it('refuses another token for the same endpoint without --force', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });

    await expect(init({ http: server.url, token: 'new-key', scope: 'user' })).rejects.toThrow(
      `The HTTP local agent already uses ${server.url} with another token. Re-run with --force to replace the token.`,
    );
    expect(localAgentConfig()).toMatchObject({ endpoint: server.url, token: API_KEY });
  });

  it('refuses, before writing anything, to replace a local agent on another endpoint without --force', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });
    const project = path.join(tmpDir, 'project');
    fs.mkdirSync(project);
    const oldCwd = process.cwd();
    process.chdir(project);
    try {
      await expect(init({ http: 'https://new-host.example/api', token: 'new-key', scope: 'project' }))
        .rejects.toThrow(`The HTTP local agent already uses ${server.url}. `
          + 'Re-run with --force to replace it with https://new-host.example/api.');
    } finally {
      process.chdir(oldCwd);
    }

    expect(localAgentConfig()).toMatchObject({ endpoint: server.url, token: API_KEY });
    expect(fs.readFileSync(path.join(tmpDir, '.teamai', 'apikey'), 'utf-8').trim()).toBe(API_KEY);
    const { loadLocalConfigForScope } = await import('../config.js');
    expect(await loadLocalConfigForScope('project', project)).toBeNull();
  });

  it('keeps the local agent token when init --http runs again on the same endpoint without --token', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });
    const project = path.join(tmpDir, 'project');
    fs.mkdirSync(project);
    const oldCwd = process.cwd();
    process.chdir(project);
    try {
      await init({ http: server.url, scope: 'project' });
    } finally {
      process.chdir(oldCwd);
    }

    expect(localAgentConfig()).toMatchObject({ endpoint: server.url, token: API_KEY });
  });

  it('replaces the local agent on another endpoint with --force', async () => {
    server = await startMockServer({ apiKey: API_KEY });
    const { init } = await import('../init.js');
    await init({ http: server.url, token: API_KEY, scope: 'user' });

    await init({ http: 'https://new-host.example/api', token: 'new-key', scope: 'user', force: true });

    expect(localAgentConfig()).toMatchObject({ endpoint: 'https://new-host.example/api', token: 'new-key' });
  });
});

describe('read-only protection (http kind)', () => {
  it('rejects teamai push', async () => {
    writeApiKey();
    server = await startMockServer({ apiKey: API_KEY });

    const { init } = await import('../init.js');
    await init({ http: server.url, force: true, scope: 'user' });

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

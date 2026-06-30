import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveApiKey, saveApiKey, getApiKeyPath } from '../api-key.js';

let tmpDir: string;
let originalHome: string;
const ENV_KEYS = ['TEAMAI_API_TOKEN', 'TEAMAI_API_KEY'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-apikey-test-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveApiKey', () => {
  it('returns null when nothing configured', () => {
    expect(resolveApiKey()).toBeNull();
  });

  it('prefers TEAMAI_API_TOKEN over the file', async () => {
    await saveApiKey('file-key');
    process.env.TEAMAI_API_TOKEN = 'env-token';
    expect(resolveApiKey()).toBe('env-token');
  });

  it('accepts TEAMAI_API_KEY as a legacy alias', () => {
    process.env.TEAMAI_API_KEY = 'legacy-key';
    expect(resolveApiKey()).toBe('legacy-key');
  });

  it('reads the file when no env var is set', async () => {
    await saveApiKey('  on-disk-key  ');
    expect(resolveApiKey()).toBe('on-disk-key');
  });
});

describe('saveApiKey', () => {
  it('writes the key with 0600 permissions', async () => {
    await saveApiKey('secret');
    const p = getApiKeyPath();
    expect(fs.existsSync(p)).toBe(true);
    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('rejects an empty key', async () => {
    await expect(saveApiKey('   ')).rejects.toThrow(/must not be empty/);
  });
});

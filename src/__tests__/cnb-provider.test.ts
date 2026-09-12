import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Provider modules import the logger; stub it so importing has no side effects.
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

// Stub child_process so cnbRepoClone tests can assert git invocations without a
// real git/cnb binary. execSync is only used by isCnbInstalled (not exercised
// here) but must exist so the module loads.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
import { detectProvider, getProvider } from '../providers/registry.js';
import { CNBProvider } from '../providers/cnb/index.js';
import { cnbParseRepoInput, cnbRepoClone, CNB_HOST, assertCnbApiOk } from '../providers/cnb/cnb-cli.js';

const mockedSpawnSync = spawnSync as Mock;

describe('CNB provider registration', () => {
  it('detects cnb.cool URLs (https and ssh) as the cnb provider', () => {
    expect(detectProvider('https://cnb.cool/acme/harness')).toBe('cnb');
    expect(detectProvider('https://cnb.cool/acme/harness.git')).toBe('cnb');
    expect(detectProvider('git@cnb.cool:acme/harness.git')).toBe('cnb');
  });

  it('the factory returns a CNBProvider named "cnb"', () => {
    const p = getProvider('cnb');
    expect(p).toBeInstanceOf(CNBProvider);
    expect(p.name).toBe('cnb');
    expect(p.getDefaultEmailDomain()).toBeNull();
  });
});

describe('cnbParseRepoInput', () => {
  it('parses a bare owner/repo', () => {
    expect(cnbParseRepoInput('acme/harness')).toEqual({
      owner: 'acme',
      repo: 'harness',
      httpsUrl: `https://${CNB_HOST}/acme/harness.git`,
      projectId: encodeURIComponent('acme/harness'),
    });
  });

  it('parses a full URL and strips scheme/host/.git/trailing slash', () => {
    const r = cnbParseRepoInput('https://cnb.cool/acme/harness.git/');
    expect(r.owner).toBe('acme');
    expect(r.repo).toBe('harness');
  });

  it('treats a nested group path as owner = everything but the last segment', () => {
    const r = cnbParseRepoInput('acme/backend/harness');
    expect(r.owner).toBe('acme/backend');
    expect(r.repo).toBe('harness');
    expect(r.projectId).toBe(encodeURIComponent('acme/backend/harness'));
  });

  it('rejects input without an owner', () => {
    expect(() => cnbParseRepoInput('harness')).toThrow(/Invalid CNB repo/);
  });
});

describe('assertCnbApiOk', () => {
  it('passes 2xx responses through', () => {
    expect(() => assertCnbApiOk('status: 201\ndata:\n  name: r', 'create-repo')).not.toThrow();
    expect(() => assertCnbApiOk('{"status": 200}', 'post-pull')).not.toThrow();
  });

  it('throws on a 4xx even though the CLI exits 0, surfacing errmsg', () => {
    const body = '{"status":412,"data":{"errcode":9,"errmsg":"Cannot delete this resource via Open API"}}';
    expect(() => assertCnbApiOk(body, 'delete-repo')).toThrow(/HTTP 412.*Cannot delete/);
  });

  it('is a no-op when the output carries no HTTP status', () => {
    expect(() => assertCnbApiOk('some human text', 'x')).not.toThrow();
  });
});

describe('cnbRepoClone credential persistence', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
  });
  afterEach(() => {
    delete process.env.CNB_TOKEN;
    delete process.env.CNB_ACCESS_TOKEN;
  });

  it('persists the cnb git-credential helper into the cloned repo on the interactive path', () => {
    // No CNB_TOKEN → interactive path. First spawnSync is `git clone`; the
    // second is `git config --local credential.helper`.
    mockedSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }) // clone
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }); // config

    cnbRepoClone('acme/harness', '/tmp/clone');

    // First call: the clone itself, scoped to this one invocation via -c.
    const cloneCall = mockedSpawnSync.mock.calls[0];
    expect(cloneCall[0]).toEqual('git');
    expect(cloneCall[1]).toContain('-c');
    expect(cloneCall[1]).toContain('credential.helper=!cnb git-credential');
    expect(cloneCall[1]).toContain('clone');
    expect(cloneCall[1]).toContain(`https://${CNB_HOST}/acme/harness.git`);

    // Second call: persist the helper into the repo's local config so later
    // push/pull auth without prompting. cwd must point at the clone.
    const cfgCall = mockedSpawnSync.mock.calls[1];
    expect(cfgCall[0]).toEqual('git');
    expect(cfgCall[1]).toEqual(['config', '--local', 'credential.helper', '!cnb git-credential']);
    expect(cfgCall[2]?.cwd).toBe('/tmp/clone');
  });

  it('embeds the token in the clone URL and skips the helper-config step (CI path)', () => {
    process.env.CNB_TOKEN = 'tok123';
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    cnbRepoClone('acme/harness', '/tmp/clone');

    // Only one git invocation — the clone — with creds baked into the URL.
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const cloneCall = mockedSpawnSync.mock.calls[0];
    expect(cloneCall[1]).toContain(`clone`);
    expect(cloneCall[1]).toContain(`https://cnb:tok123@${CNB_HOST}/acme/harness.git`);
    // No `git config --local credential.helper` follow-up.
    expect(mockedSpawnSync.mock.calls.some(
      (c) => c[1]?.[0] === 'config' && c[1]?.includes('credential.helper'),
    )).toBe(false);
  });

  it('still throws CnbRepoNotFoundError when the remote does not exist', async () => {
    mockedSpawnSync.mockReturnValue({ status: 128, stdout: '', stderr: 'Repository not found' });
    const { CnbRepoNotFoundError } = await import('../providers/cnb/cnb-cli.js');
    expect(() => cnbRepoClone('acme/missing', '/tmp/clone')).toThrow(CnbRepoNotFoundError);
  });
});

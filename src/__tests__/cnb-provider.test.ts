import { describe, it, expect, vi } from 'vitest';

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

import { detectProvider, getProvider } from '../providers/registry.js';
import { CNBProvider } from '../providers/cnb/index.js';
import { cnbParseRepoInput, CNB_HOST, assertCnbApiOk } from '../providers/cnb/cnb-cli.js';

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

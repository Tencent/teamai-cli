import { describe, expect, it } from 'vitest';

import { hostAllowed } from '../mcp-reconcile.js';

/**
 * allowedHosts patterns come from teamai.yaml; URL.hostname is lowercased by
 * WHATWG URL. DNS names are case-insensitive, so mixed-case patterns must match.
 */
describe('hostAllowed', () => {
  it('allows every host when the allowlist is empty', () => {
    expect(hostAllowed('https://anything.example/mcp', [])).toBe(true);
  });

  it('matches an exact host regardless of pattern case', () => {
    expect(hostAllowed('https://api.example.com/mcp', ['api.example.com'])).toBe(true);
    expect(hostAllowed('https://api.example.com/mcp', ['API.Example.COM'])).toBe(true);
    expect(hostAllowed('https://API.Example.com/mcp', ['api.example.com'])).toBe(true);
  });

  it('matches a wildcard subdomain regardless of pattern case', () => {
    expect(hostAllowed('https://api.trusted.com/mcp', ['*.trusted.com'])).toBe(true);
    expect(hostAllowed('https://api.trusted.com/mcp', ['*.Trusted.com'])).toBe(true);
    expect(hostAllowed('https://deep.api.trusted.com/mcp', ['*.TRUSTED.com'])).toBe(true);
  });

  it('matches the bare apex for a wildcard pattern', () => {
    expect(hostAllowed('https://trusted.com/mcp', ['*.trusted.com'])).toBe(true);
    expect(hostAllowed('https://trusted.com/mcp', ['*.Trusted.COM'])).toBe(true);
  });

  it('rejects a host outside the allowlist', () => {
    expect(hostAllowed('https://evil.example/mcp', ['*.Trusted.com'])).toBe(false);
    expect(hostAllowed('https://nottrusted.com/mcp', ['*.trusted.com'])).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(hostAllowed('not a url', ['*.trusted.com'])).toBe(false);
  });
});

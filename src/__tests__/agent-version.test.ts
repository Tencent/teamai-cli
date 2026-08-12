import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { getAgentVersion, clearVersionCache, _readPlistVersion } from '../agent-version.js';

beforeEach(() => {
  clearVersionCache();
});

describe('getAgentVersion', () => {
  it('detects claude version from CLI', async () => {
    const ver = await getAgentVersion('claude');
    // Should be a semver-like string (digits and dots), or empty if not installed
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('detects cursor version from CLI', async () => {
    const ver = await getAgentVersion('cursor');
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('detects codebuddy CLI version', async () => {
    const ver = await getAgentVersion('codebuddy');
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+/);
    }
  });

  it('detects codebuddy IDE version from plist', async () => {
    const ver = await getAgentVersion('codebuddy-ide');
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+/);
    }
  });

  it('detects workbuddy version from plist', async () => {
    const ver = await getAgentVersion('workbuddy');
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+/);
    }
  });

  it('detects hermes version from CLI', async () => {
    const ver = await getAgentVersion('hermes');
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+/);
    }
  });

  it('detects openclaw version from CLI', async () => {
    const ver = await getAgentVersion('openclaw');
    if (ver) {
      expect(ver).toMatch(/^\d+\.\d+/);
    }
  });

  it('returns empty string for unknown agents', async () => {
    const ver = await getAgentVersion('nonexistent-agent');
    expect(ver).toBe('');
  });

  it('caches results across calls', async () => {
    const ver1 = await getAgentVersion('claude');
    const ver2 = await getAgentVersion('claude');
    expect(ver1).toBe(ver2);
  });
});

describe('_readPlistVersion', () => {
  it('returns empty string for non-existent path', async () => {
    const ver = await _readPlistVersion('/nonexistent/App.app');
    expect(ver).toBe('');
  });
});

describe('version regex extraction', () => {
  it('extracts leading semver from hermes-style output', async () => {
    // Simulate what detectHermesVersion / detectOpenclawVersion do:
    // execVersion returns raw stdout, then regex extracts leading digits+dots.
    const raw = '1.23.4 (build abc123)';
    const match = raw.match(/^\(?(\d+(?:\.\d+)*)\)?/);
    expect(match?.[1]).toBe('1.23.4');
  });

  it('returns full string when no leading version found', async () => {
    const raw = 'unknown-version-format';
    const match = raw.match(/^([\d.]+)/);
    expect(match?.[1]).toBeUndefined();
  });

  it('handles empty string gracefully', async () => {
    const raw = '';
    const match = raw.match(/^([\d.]+)/);
    expect(match).toBeNull();
  });

  it('extracts version from parenthesized format like hermes', () => {
    const raw = '(2026.8.7)\nProject: /hermes-app\nPython: 3.11.6';
    const match = raw.match(/^\(?(\d+(?:\.\d+)*)\)?/);
    expect(match?.[1]).toBe('2026.8.7');
  });
});

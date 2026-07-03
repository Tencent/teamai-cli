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

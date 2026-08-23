import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger so the provider modules can be imported without side effects.
vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

// Mock package-info so we can simulate both distribution channels.
// Vitest hoists vi.mock() calls above imports; `getCurrentPackageName` is
// mutated per-test via the exported spy below.
vi.mock('../package-info.js', () => {
  const state = {
    name: 'teamai-cli',
    version: '0.0.0-test',
  };
  return {
    __setPackageName: (name: string) => {
      state.name = name;
    },
    getCurrentPackageName: () => state.name,
    getCurrentVersion: () => state.version,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pkgInfo = (await import('../package-info.js')) as any;
const setPackageName = pkgInfo.__setPackageName as (name: string) => void;

import {
  detectProvider,
  getProvider,
  getDefaultProvider,
} from '../providers/registry.js';

describe('getDefaultProvider (fallback)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setPackageName('teamai-cli');
    delete process.env.TEAMAI_DEFAULT_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setPackageName('teamai-cli');
  });

  it('returns github for the public npm package name', () => {
    setPackageName('teamai-cli');
    expect(getDefaultProvider()).toBe('github');
  });

  it('returns tgit for the internal @tencent/ package name', () => {
    setPackageName('@tencent/teamai-cli');
    expect(getDefaultProvider()).toBe('tgit');
  });

  it('honors TEAMAI_DEFAULT_PROVIDER=tgit even on public npm', () => {
    setPackageName('teamai-cli');
    process.env.TEAMAI_DEFAULT_PROVIDER = 'tgit';
    expect(getDefaultProvider()).toBe('tgit');
  });

  it('honors TEAMAI_DEFAULT_PROVIDER=github even on tnpm', () => {
    setPackageName('@tencent/teamai-cli');
    process.env.TEAMAI_DEFAULT_PROVIDER = 'github';
    expect(getDefaultProvider()).toBe('github');
  });

  it('ignores unknown TEAMAI_DEFAULT_PROVIDER values', () => {
    setPackageName('teamai-cli');
    process.env.TEAMAI_DEFAULT_PROVIDER = 'bitbucket';
    // Falls through to package-name-based default (public npm → github).
    expect(getDefaultProvider()).toBe('github');
  });
});

describe('detectProvider with package-name fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setPackageName('teamai-cli');
    delete process.env.TEAMAI_DEFAULT_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setPackageName('teamai-cli');
  });

  it('bare owner/repo → github when installed from public npm', () => {
    setPackageName('teamai-cli');
    expect(detectProvider('HyperAI/teamai')).toBe('github');
  });

  it('bare owner/repo → tgit when installed from internal tnpm', () => {
    setPackageName('@tencent/teamai-cli');
    expect(detectProvider('HyperAI/teamai')).toBe('tgit');
  });

  it('unknown full URL → generic git even when installed from internal tnpm', () => {
    setPackageName('@tencent/teamai-cli');
    expect(detectProvider('https://gitea.example.com/org/repo')).toBe('git');
  });

  it('explicit gitlab.com URL still resolves to gitlab on tnpm build', () => {
    setPackageName('@tencent/teamai-cli');
    expect(detectProvider('https://gitlab.com/org/repo')).toBe('gitlab');
  });

  it('explicit github.com URL still resolves to github on tnpm build', () => {
    setPackageName('@tencent/teamai-cli');
    expect(detectProvider('https://github.com/org/repo')).toBe('github');
  });

  it('explicit git.woa.com URL still resolves to tgit on public build', () => {
    setPackageName('teamai-cli');
    expect(detectProvider('https://git.woa.com/org/repo')).toBe('tgit');
  });
});

describe('getProvider default uses package-name fallback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setPackageName('teamai-cli');
    delete process.env.TEAMAI_DEFAULT_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setPackageName('teamai-cli');
  });

  it('returns GitHub provider when no name is given on public build', () => {
    setPackageName('teamai-cli');
    expect(getProvider().name).toBe('github');
  });

  it('returns TGit provider when no name is given on tnpm build', () => {
    setPackageName('@tencent/teamai-cli');
    expect(getProvider().name).toBe('tgit');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

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

// ─── Imports after mocks ────────────────────────────────

import { execSync, spawnSync } from 'node:child_process';
import { gitcodeRepoClone } from '../providers/gitcode/gitcode-api.js';
import { ghRepoClone } from '../providers/github/gh-cli.js';

const mockedSpawnSync = spawnSync as Mock;
const mockedExecSync = execSync as Mock;

const originalEnv = { ...process.env };

function cloneCall(): { args: string[]; options: { env?: NodeJS.ProcessEnv } } {
  const call = mockedSpawnSync.mock.calls.find((c) => (c[1] as string[]).includes('clone'));
  if (!call) throw new Error('no git clone call recorded');
  return { args: call[1] as string[], options: (call[2] ?? {}) as { env?: NodeJS.ProcessEnv } };
}

function configuredHelperValue(): string | undefined {
  const call = mockedSpawnSync.mock.calls.find((c) => (c[1] as string[]).includes('credential.helper'));
  if (!call) return undefined;
  const args = call[1] as string[];
  return args[args.indexOf('credential.helper') + 1];
}

describe('git calls whose remote URL carries the credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockedExecSync.mockReset();
    // no gh CLI available, so only env tokens count
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    for (const key of ['GITCODE_TOKEN', 'GC_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('clones GitCode with the platform credential helper disabled', () => {
    process.env.GITCODE_TOKEN = 'gc-token';

    gitcodeRepoClone('owner/repo', '/tmp/team-repo');

    const { args, options } = cloneCall();
    expect(args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'clone']);
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('pins the GitCode clone to the URL credential for later pull/push', () => {
    process.env.GITCODE_TOKEN = 'gc-token';

    gitcodeRepoClone('owner/repo', '/tmp/team-repo');

    expect(configuredHelperValue()).toBe('');
  });

  it('keeps the credential helper for a GitCode clone with no token', () => {
    gitcodeRepoClone('owner/repo', '/tmp/team-repo');

    expect(cloneCall().args[0]).toBe('clone');
    expect(configuredHelperValue()).toBeUndefined();
  });

  it('clones GitHub with the platform credential helper disabled', () => {
    process.env.GITHUB_TOKEN = 'gh-token';

    ghRepoClone('owner/repo', '/tmp/team-repo');

    const { args, options } = cloneCall();
    expect(args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'clone']);
    expect(options.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(configuredHelperValue()).toBe('');
  });

  it('keeps the credential helper for an anonymous GitHub clone', () => {
    ghRepoClone('owner/repo', '/tmp/team-repo');

    expect(cloneCall().args[0]).toBe('clone');
    expect(configuredHelperValue()).toBeUndefined();
  });
});

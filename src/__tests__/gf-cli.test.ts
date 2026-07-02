import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../types.js', () => ({
  TEAMAI_HOME: '/tmp/test-teamai-home',
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn(),
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  },
}));

import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import { gfGetOAuthToken, gfMrCreate } from '../providers/tgit/gf-cli.js';

describe('gfGetOAuthToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should read token from ~/.netrc for git.woa.com', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'machine git.woa.com login jeffyxu password myOAuthToken123 refresh abc123 authTokenType accessToken',
    );

    const token = gfGetOAuthToken();
    expect(token).toBe('myOAuthToken123');
  });

  it('should return null when ~/.netrc does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const token = gfGetOAuthToken();
    expect(token).toBeNull();
  });

  it('should return null when ~/.netrc has no git.woa.com entry', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'machine github.com login user password ghp_xxx',
    );

    const token = gfGetOAuthToken();
    expect(token).toBeNull();
  });

  it('should return null when reading ~/.netrc throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const token = gfGetOAuthToken();
    expect(token).toBeNull();
  });

  it('should handle multiline netrc format', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'machine github.com login user password ghp_xxx\nmachine git.woa.com login alice password AliceToken456 refresh r456',
    );

    const token = gfGetOAuthToken();
    expect(token).toBe('AliceToken456');
  });
});

describe('gfMrCreate', () => {
  const mockSpawnSync = vi.mocked(spawnSync);
  const mockExecSync = vi.mocked(execSync);

  beforeEach(() => {
    vi.clearAllMocks();
    // Make getGfPath() find gf in PATH
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('test -x')) throw new Error('not found');
      if (cmd === 'which gf') return '/usr/bin/gf' as any;
      throw new Error('unexpected');
    });
  });

  it('should preserve newlines in description using shell single quotes', () => {
    mockSpawnSync.mockReturnValue({
      stdout: 'https://git.woa.com/team/repo/-/merge_requests/1',
      stderr: '',
      status: 0,
    } as any);

    gfMrCreate({
      repo: 'team/repo',
      source: 'feat-branch',
      target: 'master',
      title: 'my title',
      description: 'line1\nline2\nline3',
    });

    const cmd = mockSpawnSync.mock.calls[0][1]![1] as string;
    // Description should use single quotes and contain actual newlines
    expect(cmd).toContain("'line1\nline2\nline3'");
    // Should NOT contain escaped \\n (JSON.stringify artifact)
    expect(cmd).not.toContain('\\n');
  });

  it('should handle single quotes in title and description', () => {
    mockSpawnSync.mockReturnValue({
      stdout: 'https://git.woa.com/team/repo/-/merge_requests/2',
      stderr: '',
      status: 0,
    } as any);

    gfMrCreate({
      repo: 'team/repo',
      source: 'feat-branch',
      target: 'master',
      title: "it's a title",
      description: "it's a\ndescription",
    });

    const cmd = mockSpawnSync.mock.calls[0][1]![1] as string;
    // Single quotes in content should be escaped as '\''
    expect(cmd).toContain("'it'\\''s a title'");
    expect(cmd).toContain("'it'\\''s a\ndescription'");
  });

  it('should shell-quote repo/branch args to prevent argument injection into bash -c', () => {
    mockSpawnSync.mockReturnValue({
      stdout: 'https://git.woa.com/team/repo/-/merge_requests/3',
      stderr: '',
      status: 0,
    } as any);

    gfMrCreate({
      // Values with shell metacharacters that would break out of the command
      // if interpolated raw into `bash -c "<gfPath> <args>"`.
      repo: 'team/repo;echo PWNED',
      source: 'feat;rm -rf / #',
      target: 'master|cat /etc/passwd',
      title: 't',
    });

    const cmd = mockSpawnSync.mock.calls[0][1]![1] as string;
    // Each dangerous value must be a single single-quoted token so bash -c
    // treats its metacharacters (`;`, `|`, `#`, spaces) as literal argument
    // content rather than command separators.
    expect(cmd).toContain("'team/repo;echo PWNED'");
    expect(cmd).toContain("'feat;rm -rf / #'");
    expect(cmd).toContain("'master|cat /etc/passwd'");
    // No bare (unquoted) `;` that bash could interpret as a command separator:
    // every `;` must sit inside a single-quoted token.
    const outsideQuotes = cmd.replace(/'[^']*'/g, '');
    expect(outsideQuotes).not.toContain(';');
    expect(outsideQuotes).not.toContain('|');
  });

  it('should return MR URL from gf output', () => {
    mockSpawnSync.mockReturnValue({
      stdout: 'Created: https://git.woa.com/team/repo/-/merge_requests/42',
      stderr: '',
      status: 0,
    } as any);

    const url = gfMrCreate({
      repo: 'team/repo',
      source: 'feat-branch',
      target: 'master',
      title: 'test',
    });

    expect(url).toBe('https://git.woa.com/team/repo/-/merge_requests/42');
  });

  it('should throw on gf failure', () => {
    mockSpawnSync.mockReturnValue({
      stdout: '',
      stderr: 'auth required',
      status: 1,
    } as any);

    expect(() =>
      gfMrCreate({
        repo: 'team/repo',
        source: 'feat-branch',
        target: 'master',
        title: 'test',
      }),
    ).toThrow('gf mr create failed: auth required');
  });
});

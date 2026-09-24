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
  getTeamaiHomeDir: () => '/tmp/test-teamai-home',
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
const mockRmSync = vi.fn();
vi.mock('node:fs', () => ({
  default: {
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
  },
}));

import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import {
  gfGetOAuthToken,
  gfMrCreate,
  gfAuthWhoami,
  gfIsAuthenticated,
  gfAuthLogin,
  ensureAuthenticated,
  ensureGfInstalled,
} from '../providers/tgit/gf-cli.js';

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

describe('gf auth commands run from a neutral cwd', () => {
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

  // gf `auth` commands inspect the current git repo's origin remote and scope
  // the auth check to that host. Running them from the repo cwd wrongly reports
  // "not logged in" when origin is a non-git.woa.com mirror (e.g. GitHub). They
  // must run from a neutral, non-git directory (os.tmpdir()) so the host-scoped
  // credential is found regardless of where teamai was invoked.
  it('gfAuthWhoami spawns with cwd = os.tmpdir()', () => {
    mockSpawnSync.mockReturnValue({
      stdout: '当前登录用户：jeffyxu',
      stderr: '',
      status: 0,
    } as any);

    expect(gfAuthWhoami()).toBe('jeffyxu');

    const opts = mockSpawnSync.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBe(os.tmpdir());
  });

  it('gfIsAuthenticated spawns with cwd = os.tmpdir()', () => {
    mockSpawnSync.mockReturnValue({
      stdout: '当前登录用户：jeffyxu',
      stderr: '',
      status: 0,
    } as any);

    expect(gfIsAuthenticated()).toBe(true);

    const opts = mockSpawnSync.mock.calls[0][2] as { cwd?: string };
    expect(opts.cwd).toBe(os.tmpdir());
  });

  it('gfAuthLogin spawns with cwd = os.tmpdir() and inherited stdio', () => {
    mockSpawnSync.mockReturnValue({ status: 0 } as any);

    gfAuthLogin();

    const opts = mockSpawnSync.mock.calls[0][2] as { cwd?: string; stdio?: string };
    expect(opts.cwd).toBe(os.tmpdir());
    expect(opts.stdio).toBe('inherit');
  });

  // issue #711: the inherited-stdio login waits for iOA / a browser with nobody
  // there. Without a terminal, ensureAuthenticated must refuse before spawning it.
  // The message must point at `gf auth login`, the only credential that works:
  // a TGIT_TOKEN PAT is REST-only and git.woa.com rejects it for clone, so
  // naming it would send an unattended run after a token that cannot help.
  it('ensureAuthenticated refuses without a terminal and points at gf auth login', () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      // whoami: not logged in
      mockSpawnSync.mockReturnValue({ stdout: '', stderr: 'not logged in', status: 1 } as any);

      expect(() => ensureAuthenticated()).toThrow(/gf auth login/);
      expect(() => ensureAuthenticated()).toThrow(/REST-API-only/);

      const loginCalls = mockSpawnSync.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === 'auth' && args[1] === 'login',
      );
      expect(loginCalls).toHaveLength(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});

describe('ensureGfInstalled', () => {
  const mockExecSync = vi.mocked(execSync);
  // A fixed fake tarball and its real sha256, so the code-under-test and the
  // test agree on the digest without mocking node:crypto.
  const TARBALL = Buffer.from('fake-gf-tarball-bytes');
  const REAL_SHA = createHash('sha256').update(TARBALL).digest('hex');

  // Drive getGfPath() to "not installed" (forcing a download), then let
  // curl / tar / the final `test -x` verification all succeed. onTar records
  // whether extraction was reached.
  function primeExecSync(opts: { onTar?: () => void } = {}): void {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('&& echo ok')) throw new Error('not installed locally');
      if (cmd === 'which gf') throw new Error('not in PATH');
      if (cmd.startsWith('curl')) return '' as any; // download to temp file
      if (cmd.startsWith('tar ')) {
        opts.onTar?.();
        return '' as any; // extract
      }
      if (cmd.includes('test -x')) return '' as any; // final verify
      throw new Error(`unexpected execSync: ${cmd}`);
    });
  }

  // Mirror the real download: a 302 whose location path is the content-
  // addressed sha256, and a backend that does NOT echo x-checksum-sha256.
  const headersWithRedirect = (sha: string) =>
    `HTTP/2 302\r\nlocation: https://mirror-backend.example.cos/${sha}?sign=abc\r\n\r\n` +
    'HTTP/1.1 200 OK\r\ncontent-type: application/x-gzip\r\n';

  beforeEach(() => {
    vi.clearAllMocks();
    // header read (utf-8) → redirect headers; tarball read (buffer) → bytes
    mockReadFileSync.mockImplementation((_p: string, enc?: string) =>
      enc === 'utf-8' ? headersWithRedirect(REAL_SHA) : TARBALL,
    );
  });

  it('downloads over HTTPS, never plaintext http', async () => {
    primeExecSync();
    await ensureGfInstalled();

    const curl = mockExecSync.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.startsWith('curl'))!;
    expect(curl).toContain('https://mirrors.tencent.com/');
    expect(curl).not.toContain('http://mirrors.tencent.com/');
  });

  it('does not pipe curl straight into tar (download and extract are separate)', async () => {
    primeExecSync();
    await ensureGfInstalled();

    for (const [cmd] of mockExecSync.mock.calls) {
      expect(cmd as string).not.toMatch(/curl[\s\S]*\|\s*tar/);
    }
  });

  it('extracts using the digest from the content-addressed redirect URL', async () => {
    // The default mock has no x-checksum-sha256 header — only the redirect path
    // carries the digest, matching the real mirror behavior.
    let tarCalled = false;
    primeExecSync({ onTar: () => { tarCalled = true; } });

    await expect(ensureGfInstalled()).resolves.toBeUndefined();
    expect(tarCalled).toBe(true);
  });

  it('falls back to the x-checksum-sha256 header when there is no redirect', async () => {
    let tarCalled = false;
    primeExecSync({ onTar: () => { tarCalled = true; } });
    // Direct serve: 200 with an explicit checksum header, no location line.
    mockReadFileSync.mockImplementation((_p: string, enc?: string) =>
      enc === 'utf-8' ? `HTTP/1.1 200 OK\r\nx-checksum-sha256: ${REAL_SHA}\r\n` : TARBALL,
    );

    await expect(ensureGfInstalled()).resolves.toBeUndefined();
    expect(tarCalled).toBe(true);
  });

  it('throws and does not extract when the sha256 mismatches', async () => {
    let tarCalled = false;
    primeExecSync({ onTar: () => { tarCalled = true; } });
    // Redirect advertises a different digest than the downloaded bytes.
    const wrong = 'a'.repeat(64);
    mockReadFileSync.mockImplementation((_p: string, enc?: string) =>
      enc === 'utf-8' ? headersWithRedirect(wrong) : TARBALL,
    );

    await expect(ensureGfInstalled()).rejects.toThrow(/integrity check failed/);
    expect(tarCalled).toBe(false);
  });

  it('fails closed (throws, no extract) when no digest is advertised', async () => {
    let tarCalled = false;
    primeExecSync({ onTar: () => { tarCalled = true; } });
    // Neither a redirect digest nor an x-checksum-sha256 header.
    mockReadFileSync.mockImplementation((_p: string, enc?: string) =>
      enc === 'utf-8' ? 'HTTP/1.1 200 OK\r\ncontent-type: application/x-gzip\r\n' : TARBALL,
    );

    await expect(ensureGfInstalled()).rejects.toThrow(/integrity check failed/);
    expect(tarCalled).toBe(false);
  });

  it('cleans up the temp tarball and header files afterward', async () => {
    primeExecSync();
    await ensureGfInstalled();

    const removed = mockRmSync.mock.calls.map((c) => c[0] as string);
    expect(removed.some((p) => /gf-download\..+\.tar\.gz$/.test(p))).toBe(true);
    expect(removed.some((p) => /gf-download\..+\.headers$/.test(p))).toBe(true);
  });

  it('uses a unique temp filename per attempt (no fixed shared path)', async () => {
    primeExecSync();
    await ensureGfInstalled();

    const curl = mockExecSync.mock.calls
      .map((c) => c[0] as string)
      .find((c) => c.startsWith('curl'))!;
    // A per-attempt id sits between the gf-download prefix and the extension,
    // so concurrent installs cannot collide on one shared tarball path.
    expect(curl).toMatch(/gf-download\.\d+-[0-9a-f]+\.tar\.gz/);
    expect(curl).not.toMatch(/gf-download\.tar\.gz/);
  });
});

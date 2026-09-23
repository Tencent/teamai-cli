import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cnbLogin launches the `cnb` CLI through the shared resolver + cross-spawn
// (see providers/cnb/cnb-cli.ts). On Windows the npm-installed CLI is only a
// `.cmd` shim, so a bare `spawnSync('cnb', ...)` — the call this file used to
// stub — is precisely what cannot work there. Both layers are stubbed instead,
// so the cases keep asserting the exact argv without touching the network.
//
// The stubs stay as plain outer consts rather than `vi.fn()` created inside the
// factory: the cases call `vi.resetModules()` to re-evaluate CNB_HOST, which
// re-runs each factory, and an instance created inside would no longer be the
// one the assertions hold a reference to.
const RESOLVED_CNB = '/opt/npm/bin/cnb';

const crossSpawnSync = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('cross-spawn', () => ({
  default: { sync: (...args: unknown[]) => crossSpawnSync(...args) },
}));

// Returning a path rather than the bare name is what makes the assertions prove
// the exec went through the resolver: `expect(cmd).toBe('cnb')` would also pass
// for a direct spawn of the command name, i.e. the bug.
const resolveCliPathMock = vi.fn<(...args: unknown[]) => string | null>(() => RESOLVED_CNB);
vi.mock('../utils/cli-path.js', () => ({
  resolveCliPath: (...args: unknown[]) => resolveCliPathMock(...args),
}));

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

describe('cnbLogin pins the platform host', () => {
  beforeEach(() => {
    crossSpawnSync.mockReset();
    crossSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    resolveCliPathMock.mockReset();
    resolveCliPathMock.mockReturnValue(RESOLVED_CNB);
    delete process.env.TEAMAI_CNB_HOST;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.TEAMAI_CNB_HOST;
  });

  // issue #711: `cnb login` waits for an OAuth2 device flow with nobody there.
  // Without a terminal, ensureCnbAuthenticated must refuse before spawning it.
  it('ensureCnbAuthenticated refuses without a terminal and names CNB_TOKEN', async () => {
    const originalIsTTY = process.stdin.isTTY;
    const savedToken = { CNB_TOKEN: process.env.CNB_TOKEN, CNB_ACCESS_TOKEN: process.env.CNB_ACCESS_TOKEN };
    delete process.env.CNB_TOKEN;
    delete process.env.CNB_ACCESS_TOKEN;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      // `cnb status`: not logged in
      crossSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
      const { ensureCnbAuthenticated } = await import('../providers/cnb/cnb-cli.js');

      expect(() => ensureCnbAuthenticated()).toThrow(/CNB_TOKEN/);

      const loginCalls = crossSpawnSync.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args[0] === 'login',
      );
      expect(loginCalls).toHaveLength(0);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      for (const [k, v] of Object.entries(savedToken)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('passes --host cnb.cool so login ignores the current dir git remote', async () => {
    const { cnbLogin } = await import('../providers/cnb/cnb-cli.js');
    cnbLogin();
    expect(crossSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = crossSpawnSync.mock.calls[0];
    expect(cmd).toBe(RESOLVED_CNB);
    expect(args).toEqual(['login', '--host', 'cnb.cool']);
  });

  it('honors TEAMAI_CNB_HOST for a self-hosted instance', async () => {
    process.env.TEAMAI_CNB_HOST = 'cnb.internal.example.com';
    const { cnbLogin } = await import('../providers/cnb/cnb-cli.js');
    cnbLogin();
    const [, args] = crossSpawnSync.mock.calls[0];
    expect(args).toEqual(['login', '--host', 'cnb.internal.example.com']);
  });

  it('fails loudly when the cnb CLI is not on PATH', async () => {
    resolveCliPathMock.mockReturnValue(null);
    const { cnbLogin } = await import('../providers/cnb/cnb-cli.js');
    expect(() => cnbLogin()).toThrow(/cnb login failed/);
    expect(crossSpawnSync).not.toHaveBeenCalled();
  });
});

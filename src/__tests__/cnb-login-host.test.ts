import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// cnbLogin spawns the real `cnb` binary; stub child_process so we can assert the
// exact argv without touching the network.
const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args),
  execSync: vi.fn(),
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
    spawnSync.mockReset();
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    delete process.env.TEAMAI_CNB_HOST;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.TEAMAI_CNB_HOST;
  });

  it('passes --host cnb.cool so login ignores the current dir git remote', async () => {
    const { cnbLogin } = await import('../providers/cnb/cnb-cli.js');
    cnbLogin();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnSync.mock.calls[0];
    expect(cmd).toBe('cnb');
    expect(args).toEqual(['login', '--host', 'cnb.cool']);
  });

  it('honors TEAMAI_CNB_HOST for a self-hosted instance', async () => {
    process.env.TEAMAI_CNB_HOST = 'cnb.internal.example.com';
    const { cnbLogin } = await import('../providers/cnb/cnb-cli.js');
    cnbLogin();
    const [, args] = spawnSync.mock.calls[0];
    expect(args).toEqual(['login', '--host', 'cnb.internal.example.com']);
  });
});

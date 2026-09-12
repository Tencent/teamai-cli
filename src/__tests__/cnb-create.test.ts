import { describe, it, expect, vi, beforeEach } from 'vitest';

// `cnbExec` launches the `cnb` CLI through the shared resolver + cross-spawn
// (see providers/cnb/cnb-cli.ts): it resolves the path with resolveCliPath()
// and runs it via crossSpawn.sync(), not a bare spawnSync('cnb', ...). Stub
// both layers — same pattern as cnb-login-host.test.ts — so the cases can feed
// back canned CLI output without touching PATH or the network. Returning a
// resolved path (not the bare name) also keeps resolveCliPath non-null, so
// cnbExec does not short-circuit with "cnb CLI not found on PATH".
const RESOLVED_CNB = '/opt/npm/bin/cnb';

const crossSpawnSync = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('cross-spawn', () => ({
  default: { sync: (...args: unknown[]) => crossSpawnSync(...args) },
}));

const resolveCliPathMock = vi.fn<(...args: unknown[]) => string | null>(() => RESOLVED_CNB);
vi.mock('../utils/cli-path.js', () => ({
  resolveCliPath: (...args: unknown[]) => resolveCliPathMock(...args),
}));

// Stub the logger so importing the provider module has no side effects.
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

import { cnbCreateRepo, cnbOrganizationExists, CNB_HOST } from '../providers/cnb/cnb-cli.js';
import { OrganizationNotFoundError, RepoCreatePermissionError } from '../providers/types.js';

/** Shape a cnb CLI response: { stdout, stderr, status }. */
function cnbResponse(stdout = '', status = 0, stderr = ''): void {
  crossSpawnSync.mockReturnValue({ stdout, stderr, status });
}

/** Restore resolveCliPath to a resolved path after a mockReset(). */
function resetCnbMocks(): void {
  crossSpawnSync.mockReset();
  resolveCliPathMock.mockReset();
  resolveCliPathMock.mockReturnValue(RESOLVED_CNB);
}

describe('cnbCreateRepo', () => {
  beforeEach(() => {
    resetCnbMocks();
  });

  it('calls cnb repositories create-repo with slug and name', async () => {
    cnbResponse('{"status": 201}', 0);

    await expect(cnbCreateRepo('acme', 'widget')).resolves.toBeUndefined();
    expect(crossSpawnSync).toHaveBeenCalledTimes(1);
    const [, args] = crossSpawnSync.mock.calls[0];
    expect(args).toEqual(['repositories', 'create-repo', '--slug', 'acme', '--name', 'widget']);
  });

  it('throws OrganizationNotFoundError with a web create URL when the org is missing (404)', async () => {
    // CNB CLI exits 0 even on API errors; the status is in the response body.
    cnbResponse('status: 404\ndata:\n  errmsg: Resource not found.', 0);

    await expect(cnbCreateRepo('missing-org', 'widget')).rejects.toMatchObject({
      name: 'OrganizationNotFoundError',
      org: 'missing-org',
      createUrl: `https://${CNB_HOST}/new/groups`,
    });
  });

  it('throws RepoCreatePermissionError with a web create URL on a 403 scope error', async () => {
    cnbResponse(
      'status: 403\ndata:\n  errmsg: Missing required scopes: group-resource:rw',
      0,
    );

    const err = await cnbCreateRepo('acme', 'widget').catch((e) => e);
    expect(err).toBeInstanceOf(RepoCreatePermissionError);
    expect(err).toMatchObject({
      repo: 'acme/widget',
      createUrl: `https://${CNB_HOST}/new/repos`,
    });
  });

  it('re-throws unrelated errors unchanged (not treated as a missing org)', async () => {
    cnbResponse('unexpected', 2, 'boom');

    const err = await cnbCreateRepo('acme', 'widget').catch((e) => e);
    expect(err).not.toBeInstanceOf(OrganizationNotFoundError);
    expect((err as Error).message).toMatch(/cnb create-repo failed/);
  });
});

describe('cnbOrganizationExists', () => {
  beforeEach(() => {
    resetCnbMocks();
  });

  it('calls cnb organizations get-group with the org path', () => {
    cnbResponse('status: 200\nname: acme\npath: acme', 0);

    expect(cnbOrganizationExists('acme')).toBe(true);
    const [, args] = crossSpawnSync.mock.calls[0];
    expect(args).toEqual(['organizations', 'get-group', '--group', 'acme']);
  });

  it('returns true on HTTP 200', () => {
    cnbResponse('status: 200\nname: acme', 0);
    expect(cnbOrganizationExists('acme')).toBe(true);
  });

  it('returns false on HTTP 404', () => {
    cnbResponse('status: 404\ndata:\n  errmsg: Resource not found.', 0);
    expect(cnbOrganizationExists('missing-org')).toBe(false);
  });

  it('passes a nested group path through unchanged', () => {
    cnbResponse('status: 200\npath: acme/backend', 0);
    expect(cnbOrganizationExists('acme/backend')).toBe(true);
    const [, args] = crossSpawnSync.mock.calls[0];
    expect(args).toEqual(['organizations', 'get-group', '--group', 'acme/backend']);
  });

  it('throws on an indeterminate result (e.g. 403) rather than reporting "missing"', () => {
    cnbResponse('status: 403\ndata:\n  errmsg: forbidden', 0);
    expect(() => cnbOrganizationExists('acme')).toThrow(/get-group failed/);
  });
});

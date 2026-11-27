import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn(), fail: vi.fn() })),
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config.js')>(),
  autoDetectInit: vi.fn(),
}));

import { autoDetectInit } from '../config.js';
import { log } from '@teamai/shared/log';
import { sourceAdd, sourceAddHttp, sourceBrowse, sourceRemove } from '../source.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

let root = '';

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-refusal-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const team = path.join(root, 'team');
  fs.mkdirSync(team, { recursive: true });
  const localConfig: LocalConfig = {
    repo: { localPath: team, remote: 'https://example.test/acme/team.git' },
    username: 'tester', updatePolicy: 'skip', additionalRoles: [], scope: 'user',
  };
  const teamConfig: TeamaiConfig = {
    team: 'acme', description: '', repo: localConfig.repo.remote, provider: 'git', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
    sources: [{ name: 'shared', repo: 'https://example.test/shared.git' }],
    toolPaths: { claude: { skills: '.claude/skills' } },
  };
  vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig });
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('source commands exit 1 when they refuse', () => {
  it('source add when the name is taken', async () => {
    await sourceAdd('https://example.test/other.git', { name: 'shared' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(process.exitCode).toBe(1);
  });

  it('source add when the repository is already configured', async () => {
    await sourceAdd('https://example.test/shared.git', { name: 'other' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('already configured'));
    expect(process.exitCode).toBe(1);
  });

  it('source remove when the source is neither configured nor installed', async () => {
    await sourceRemove('missing', {});
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(process.exitCode).toBe(1);
  });

  it('source browse when the source is not configured', async () => {
    await sourceBrowse('missing', {});
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(process.exitCode).toBe(1);
  });

  it('source add-http without an endpoint', async () => {
    await sourceAddHttp('   ', {});
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Endpoint is required'));
    expect(process.exitCode).toBe(1);
  });
});

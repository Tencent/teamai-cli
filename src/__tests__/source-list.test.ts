import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

vi.mock('@teamai/shared/log', () => ({
  log: {
    debug: vi.fn(),
    dim: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

import { sourceList } from '../source.js';
import { log } from '@teamai/shared/log';

describe('teamai source list', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-list-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function userConfig(repoPath: string): void {
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: repoPath, remote: 'https://example.test/acme/team.git' },
      username: 'tester',
      scope: 'user',
    }));
  }

  it('reports an invalid teamai.yaml instead of "No sources configured"', async () => {
    const repoPath = path.join(home, 'team-repo');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'teamai.yaml'), 'team: [unclosed\n');
    userConfig(repoPath);

    await expect(sourceList()).rejects.toThrow(/could not be read/);

    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('No sources configured'));
  });

  it('still lists no sources when teamai is not initialized', async () => {
    await sourceList();

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No sources configured'));
    expect(process.exitCode).toBeUndefined();
  });
});

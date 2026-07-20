import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn(),
  loadStateForScope: vi.fn(),
  requireInit: vi.fn(),
  saveLocalConfig: vi.fn(),
  saveLocalConfigForScope: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    dim: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import {
  detectProjectConfig,
  loadStateForScope,
  requireInit,
  saveLocalConfig,
  saveLocalConfigForScope,
  saveStateForScope,
} from '../config.js';
import { excludeAdd, excludeRemove } from '../exclude.js';
import type { LocalConfig } from '../types.js';

const userConfig: LocalConfig = {
  repo: { localPath: '/tmp/team-repo', remote: 'owner/repo' },
  username: 'tester',
  scope: 'user',
  additionalRoles: [],
};

describe('skill exclude commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: userConfig,
      teamConfig: {} as never,
    });
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-07-17T00:00:00.000Z',
      lastPullRev: 'abc1234',
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });
  });

  it('adds sorted exclusions and invalidates the pull revision cache', async () => {
    await excludeAdd(['z-skill', 'a-skill'], {});

    expect(saveLocalConfig).toHaveBeenCalledWith(expect.objectContaining({
      excludedSkills: ['a-skill', 'z-skill'],
    }));
    expect(saveStateForScope).toHaveBeenCalledWith(
      expect.objectContaining({ lastPullRev: null }),
      'user',
      undefined,
    );
  });

  it('removes exclusions in project scope and invalidates that scope only', async () => {
    const projectConfig: LocalConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot: '/tmp/project',
      excludedSkills: ['a-skill', 'b-skill'],
    };
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await excludeRemove(['a-skill'], {});

    expect(saveLocalConfigForScope).toHaveBeenCalledWith(
      expect.objectContaining({ excludedSkills: ['b-skill'] }),
      'project',
      '/tmp/project',
    );
    expect(saveStateForScope).toHaveBeenCalledWith(
      expect.objectContaining({ lastPullRev: null }),
      'project',
      '/tmp/project',
    );
    expect(saveLocalConfig).not.toHaveBeenCalled();
  });

  it('does not rewrite config or state when the exclusion is unchanged', async () => {
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: { ...userConfig, excludedSkills: ['a-skill'] },
      teamConfig: {} as never,
    });

    await excludeAdd(['a-skill'], {});

    expect(saveLocalConfig).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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
    error: vi.fn(),
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
import { tagsSubscribe, tagsUnsubscribe } from '../tags.js';
import type { LocalConfig } from '../types.js';

const userConfig: LocalConfig = {
  repo: { localPath: '/tmp/team-repo', remote: 'owner/repo' },
  username: 'tester',
  scope: 'user',
  additionalRoles: [],
};

describe('tag subscription commands', () => {
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
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });
  });

  it('subscribes and invalidates the pull revision cache', async () => {
    await tagsSubscribe(['testing', 'frontend'], {});

    expect(saveLocalConfig).toHaveBeenCalledWith(expect.objectContaining({
      subscribedTags: ['frontend', 'testing'],
    }));
    expect(saveStateForScope).toHaveBeenCalledWith(
      expect.objectContaining({ lastPullRev: null }),
      expect.objectContaining({ scope: 'user' }),
    );
  });

  it('unsubscribes in project scope and invalidates that scope only', async () => {
    const projectConfig: LocalConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot: '/tmp/project',
      subscribedTags: ['frontend', 'testing'],
    };
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await tagsUnsubscribe(['testing'], {});

    expect(saveLocalConfigForScope).toHaveBeenCalledWith(
      expect.objectContaining({ subscribedTags: ['frontend'] }),
      'project',
      '/tmp/project',
    );
    expect(saveStateForScope).toHaveBeenCalledWith(
      expect.objectContaining({ lastPullRev: null }),
      expect.objectContaining({ scope: 'project', projectRoot: '/tmp/project' }),
    );
    expect(saveLocalConfig).not.toHaveBeenCalled();
  });

  it('does not rewrite config or state when the subscriptions are unchanged', async () => {
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: { ...userConfig, subscribedTags: ['frontend'] },
      teamConfig: {} as never,
    });

    await tagsSubscribe(['frontend'], {});
    await tagsUnsubscribe(['testing'], {});

    expect(saveLocalConfig).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });
});

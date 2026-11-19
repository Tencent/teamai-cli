import path from 'node:path';
import os from 'node:os';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn(),
  loadStateForScope: vi.fn(),
  requireInit: vi.fn(),
  saveLocalConfig: vi.fn(),
  saveLocalConfigForScope: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('@teamai/shared/log', () => ({
  log: {
    dim: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
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
import { log } from '@teamai/shared/log';
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
      pendingPushes: [],
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
      expect.objectContaining({ scope: 'user' }),
    );
  });

  it('warns when an exclusion names no team skill or MCP server', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-exclude-'));
    onTestFinished(async () => fse.remove(repo));
    await fse.outputFile(path.join(repo, 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: A.\n---\n');
    await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'), 'servers:\n  - name: db\n    transport: stdio\n    command: db\n');
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: { ...userConfig, repo: { ...userConfig.repo, localPath: repo } },
      teamConfig: {} as never,
    });

    await excludeAdd(['a', 'db', 'nope'], {});

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No team skill or MCP server named "nope"'));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('"a"'));
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
      expect.objectContaining({ scope: 'project', projectRoot: '/tmp/project' }),
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

  it('previews additions without saving config or invalidating pull state', async () => {
    await excludeAdd(['new-skill'], { dryRun: true });

    expect(requireInit).toHaveBeenCalledWith({ dryRun: true });
    expect(log.info).toHaveBeenCalledWith('[dry-run] Would exclude: new-skill');
    expect(saveLocalConfig).not.toHaveBeenCalled();
    expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    expect(loadStateForScope).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('previews removals in project scope without saving config or state', async () => {
    const projectConfig: LocalConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot: '/tmp/project',
      excludedSkills: ['a-skill', 'b-skill'],
    };
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await excludeRemove(['a-skill'], { dryRun: true });

    expect(detectProjectConfig).toHaveBeenCalledWith(undefined, undefined, { dryRun: true });
    expect(log.info).toHaveBeenCalledWith('[dry-run] Would remove from exclude list: a-skill');
    expect(saveLocalConfig).not.toHaveBeenCalled();
    expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    expect(loadStateForScope).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });
});

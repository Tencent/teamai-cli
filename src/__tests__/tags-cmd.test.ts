import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    error: vi.fn(),
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
import { tagsAdd, tagsList, tagsRemove, tagsSubscribe, tagsUnsubscribe } from '../tags.js';
import { log } from '@teamai/shared/log';
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

  it('previews subscribe under --dry-run without writing config or state', async () => {
    await tagsSubscribe(['testing'], { dryRun: true });

    expect(log.info).toHaveBeenCalledWith('[dry-run] Would subscribe to: testing');
    expect(saveLocalConfig).not.toHaveBeenCalled();
    expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('previews in project scope under --dry-run without writing that scope', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue({
      ...userConfig,
      scope: 'project',
      projectRoot: '/tmp/project',
      subscribedTags: ['frontend'],
    });

    await tagsSubscribe(['testing'], { dryRun: true });
    await tagsUnsubscribe(['frontend'], { dryRun: true });

    expect(log.info).toHaveBeenCalledWith('[dry-run] Would subscribe to: testing');
    expect(log.info).toHaveBeenCalledWith('[dry-run] Would unsubscribe from: frontend');
    expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });

  it('previews unsubscribe under --dry-run without writing config or state', async () => {
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: { ...userConfig, subscribedTags: ['frontend'] },
      teamConfig: {} as never,
    });

    await tagsUnsubscribe(['frontend'], { dryRun: true });

    expect(log.info).toHaveBeenCalledWith('[dry-run] Would unsubscribe from: frontend');
    expect(saveLocalConfig).not.toHaveBeenCalled();
    expect(saveLocalConfigForScope).not.toHaveBeenCalled();
    expect(saveStateForScope).not.toHaveBeenCalled();
  });
});

describe('tag command refusals', () => {
  let repoPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'teamai-tags-refusal-'));
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: { ...userConfig, repo: { localPath: repoPath, remote: 'owner/repo' } },
      teamConfig: {} as never,
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('exits 1 when subscribe is given no tag', async () => {
    await tagsSubscribe([], {});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('at least one tag'));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when unsubscribe is given no tag', async () => {
    await tagsUnsubscribe([], {});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('at least one tag'));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when add is given no tag', async () => {
    await tagsAdd('skills', 'deploy', [], {});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('at least one tag'));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when remove is given no tag', async () => {
    await tagsRemove('skills', 'deploy', [], {});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('at least one tag to remove'));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when remove finds no tags.yaml', async () => {
    await tagsRemove('skills', 'deploy', ['backend'], {});

    expect(log.error).toHaveBeenCalledWith('No tags.yaml found in team repo.');
    expect(process.exitCode).toBe(1);
  });

  it('leaves a tags.yaml it cannot read unchanged when adding tags', async () => {
    const tagsPath = path.join(repoPath, 'tags.yaml');
    writeFileSync(tagsPath, 'skills: [unclosed');

    await tagsAdd('skills', 'deploy', ['backend'], {});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
    expect(process.exitCode).toBe(1);
    expect(readFileSync(tagsPath, 'utf8')).toBe('skills: [unclosed');
  });

  it('refuses to remove tags from a tags.yaml it cannot read', async () => {
    const tagsPath = path.join(repoPath, 'tags.yaml');
    writeFileSync(tagsPath, 'just-a-scalar');

    await tagsRemove('skills', 'deploy', ['backend'], {});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
    expect(process.exitCode).toBe(1);
    expect(readFileSync(tagsPath, 'utf8')).toBe('just-a-scalar');
  });
});

describe('tags list', () => {
  let repoPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    repoPath = mkdtempSync(path.join(os.tmpdir(), 'teamai-tags-list-'));
    writeFileSync(path.join(repoPath, 'teamai.yaml'), 'team: demo\nrepo: owner/repo\nprovider: github\n');
    useConfig({});
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  function useConfig(extra: Partial<LocalConfig>): void {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(requireInit).mockResolvedValue({
      localConfig: { ...userConfig, repo: { localPath: repoPath, remote: 'owner/repo' }, ...extra },
      teamConfig: {} as never,
    });
  }

  afterEach(() => {
    process.exitCode = undefined;
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('reports a tags.yaml it cannot read instead of saying there is none', async () => {
    writeFileSync(path.join(repoPath, 'tags.yaml'), 'skills: [unclosed');

    await tagsList();

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('No tags.yaml found'));
    expect(process.exitCode).toBe(1);
  });

  function addSkill(...segments: string[]): void {
    const dir = path.join(repoPath, 'skills', ...segments);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# skill');
  }

  it('shows the subscriptions even when the team has no tags.yaml', async () => {
    useConfig({ subscribedTags: ['frontend'] });

    await tagsList();

    expect(log.info).toHaveBeenCalledWith('Your subscriptions: frontend');
    expect(log.info).toHaveBeenCalledWith('No tags.yaml found in team repo. Tags are not configured yet.');
  });

  it('shows the subscriptions when tags.yaml holds no tags', async () => {
    writeFileSync(path.join(repoPath, 'tags.yaml'), 'skills: {}\nrules: {}\n');
    useConfig({ subscribedTags: ['frontend'] });

    await tagsList();

    expect(log.info).toHaveBeenCalledWith('Your subscriptions: frontend');
    expect(log.info).toHaveBeenCalledWith('tags.yaml exists but contains no tags.');
  });

  it('counts untagged skills in both the flat and the namespace layout', async () => {
    addSkill('solo');
    addSkill('hai', 'a');
    addSkill('hai', 'b');
    addSkill('hai', 'c');
    writeFileSync(path.join(repoPath, 'tags.yaml'), 'skills:\n  a: [frontend]\nrules: {}\n');

    await tagsList();

    expect(log.dim).toHaveBeenCalledWith('  3 skill(s) have no tags and are always synced.');
  });

  it('counts only the untagged skills a role member is delivered', async () => {
    addSkill('hai', 'a');
    addSkill('hai', 'b');
    addSkill('pm', 'x');
    mkdirSync(path.join(repoPath, 'manifest'));
    writeFileSync(
      path.join(repoPath, 'manifest', 'roles.yaml'),
      'version: 1\nroles:\n  - id: hai\n    description: HAI\n    resources:\n      knowledge: [hai]\n      skills: [hai]\n'
        + '  - id: pm\n    description: PM\n    resources:\n      knowledge: [pm]\n      skills: [pm]\n',
    );
    writeFileSync(path.join(repoPath, 'tags.yaml'), 'skills:\n  a: [frontend]\nrules: {}\n');
    useConfig({ primaryRole: 'hai' });

    await tagsList();

    // pm/x is untagged but outside the member's namespaces, so pull never delivers it.
    expect(log.dim).toHaveBeenCalledWith('  1 skill(s) have no tags and are always synced.');
  });

  it('counts a skill name once when the root and a namespace both hold it', async () => {
    addSkill('deploy');
    addSkill('hai', 'deploy');
    addSkill('hai', 'a');
    writeFileSync(path.join(repoPath, 'tags.yaml'), 'skills:\n  a: [frontend]\nrules: {}\n');

    await tagsList();

    expect(log.dim).toHaveBeenCalledWith('  1 skill(s) have no tags and are always synced.');
  });

  it('still lists tags and warns when manifest/roles.yaml is malformed', async () => {
    addSkill('hai', 'a');
    mkdirSync(path.join(repoPath, 'manifest'));
    writeFileSync(path.join(repoPath, 'manifest', 'roles.yaml'), 'roles: [\n');
    writeFileSync(path.join(repoPath, 'tags.yaml'), 'skills:\n  a: [frontend]\nrules: {}\n');
    useConfig({ primaryRole: 'hai' });

    await expect(tagsList()).resolves.toBeUndefined();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('frontend'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not count untagged skills'));
    expect(log.dim).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  setStderrOnly: vi.fn(() => false),
}));

import { NotInitializedError, detectProjectConfig, findUnreadableProjectConfig, requireInit } from '../config.js';
import { projectDataHome } from '../utils/partition.js';
import { log } from '../utils/logger.js';

/**
 * `loadLocalConfig` returns null both for a missing file and for one it could
 * not use. Commands that work without a team fall back on NotInitializedError
 * alone, so only the missing file may produce it.
 */
describe('requireInit: missing config versus unreadable config', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-config-init-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is NotInitializedError when there is no config file', async () => {
    await expect(requireInit()).rejects.toBeInstanceOf(NotInitializedError);
  });

  it('names the file, and is not NotInitializedError, when the config exists but does not parse', async () => {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'repo: [unclosed\n');

    const error = await requireInit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotInitializedError);
    expect(String(error)).toContain(configPath);
  });

  it('says an empty config is empty, since no loader logged anything for it', async () => {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '');

    const error = await requireInit().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NotInitializedError);
    expect(String(error)).toContain(`${configPath} could not be read: it is empty`);
    expect(String(error)).not.toContain('above');
  });

  it('is not NotInitializedError when the config parses but fails validation', async () => {
    const configPath = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'username: 42\n');

    await expect(requireInit()).rejects.not.toBeInstanceOf(NotInitializedError);
  });

  it('says a team config that exists but fails validation is invalid, not missing', async () => {
    // "not found. Check your repo path" sends the member after a path that is right.
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(teamRepo, { recursive: true });
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: 42\n');
    fs.writeFileSync(
      path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${teamRepo}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`,
    );

    const error = String(await requireInit().catch((e: unknown) => e));
    expect(error).toContain(`${path.join(teamRepo, 'teamai.yaml')} could not be read: it is not a valid team config`);
    expect(error).not.toContain('not found');
  });

  it('still says a missing team config is not found', async () => {
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(teamRepo, { recursive: true });
    fs.writeFileSync(
      path.join(home, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${teamRepo}\n  remote: https://example.test/acme/team.git\nusername: tester\nscope: user\n`,
    );

    await expect(requireInit()).rejects.toThrow('Team config (teamai.yaml) not found');
  });

  it('logs the failing field of a config that fails validation, which the refusal points at', async () => {
    // The refusal says "the error is printed above"; a Zod JSON dump there
    // would bury the field under a line of `[`.
    const configPath = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'username: 42\n');
    vi.mocked(log.error).mockClear();

    await expect(requireInit()).rejects.toThrow('the error is printed above');
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringMatching(/username: Expected string, received number/));
    expect(vi.mocked(log.error).mock.calls.flat().join('')).not.toContain('\n');
  });
});

describe('findUnreadableProjectConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-project-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names a project config that exists but does not parse, which detection alone skips', async () => {
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'repo: [unclosed\n');

    expect(await findUnreadableProjectConfig(dir)).toContain(configPath);
  });

  it('is null when there is no project config at all', async () => {
    expect(await findUnreadableProjectConfig(dir)).toBeNull();
  });

  it('names an empty project config, which detection alone also skips', async () => {
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '');

    expect(await findUnreadableProjectConfig(dir)).toContain(configPath);
  });

  it('names the failing field of a project config that parses but fails validation, on one line', async () => {
    // A Zod message is a JSON dump whose first line is `[`; the refusal keeps
    // only the first line, so the field and the reason must lead.
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'scope: project\nrepo: 42\n');

    const problem = await findUnreadableProjectConfig(dir);
    expect(problem).toContain(configPath);
    expect(problem).toMatch(/repo: Expected object, received number/);
    expect(problem).not.toContain('\n');
  });

  it('names a project config that is not scope: project, which detection alone skips', async () => {
    // `scope` omitted defaults to user: detection would read past the file to
    // the user config, another team's.
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'repo:\n  localPath: /x\n  remote: https://example.test/a.git\nusername: t\n');

    const problem = await findUnreadableProjectConfig(dir);
    expect(problem).toContain(configPath);
    expect(problem).toContain('scope: project');
  });

  it('does not name the user config when the directory is HOME itself', async () => {
    // Run from HOME, `<cwd>/.teamai/config.yaml` is the user config, not a project's.
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'repo:\n  localPath: /x\n  remote: https://example.test/a.git\nusername: t\nscope: user\n');

    expect(await findUnreadableProjectConfig(dir)).toBeNull();
    vi.unstubAllEnvs();
  });

  it('names a project config that is a symlink to the user config', async () => {
    // The HOME exception is about where the project is, not where the file points.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-symlink-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const userConfig = path.join(home, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(userConfig), { recursive: true });
    fs.writeFileSync(userConfig, 'repo:\n  localPath: /x\n  remote: https://example.test/a.git\nusername: t\nscope: user\n');
    const configPath = path.join(dir, '.teamai', 'config.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(userConfig, configPath);

    try {
      expect(await findUnreadableProjectConfig(dir)).toContain(configPath);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('names a broken partition config even when the legacy .teamai/ config behind it loads', async () => {
    // The partition is authoritative; detection skips it when broken and lands
    // on the legacy config, which may belong to another team.
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    try {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      for (const args of [['init', '-q'], ['config', 'user.email', 't@e'], ['config', 'user.name', 'T'], ['commit', '--allow-empty', '-q', '-m', 'init']]) {
        execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      }
      const anchor = realpathSync(repo);
      const partitionConfig = path.join(projectDataHome(anchor), 'config.yaml');
      fs.mkdirSync(path.dirname(partitionConfig), { recursive: true });
      fs.writeFileSync(partitionConfig, 'repo: [unclosed\n');
      fs.mkdirSync(path.join(repo, '.teamai'));
      fs.writeFileSync(path.join(repo, '.teamai', 'config.yaml'),
        `repo:\n  localPath: ${path.join(repo, '.teamai', 'team-repo')}\n  remote: https://example.com/other.git\nusername: t\nscope: project\n`);

      expect(await detectProjectConfig(repo)).not.toBeNull();
      expect(await findUnreadableProjectConfig(repo)).toContain(partitionConfig);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});


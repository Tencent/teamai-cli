import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
vi.mock('../providers/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../providers/index.js')>(),
  getProvider: vi.fn(() => ({
    isAuthenticated: () => true,
    authenticate: async () => 'tester',
    parseRepoInput: (remote: string) => ({ httpsUrl: remote }),
  })),
}));

import { installFakeCodex, readFakeCodexState } from '@teamai/tool-codex/testing';
import { bootstrapSelfMode } from '../bootstrap.js';
import { detectProjectConfig } from '../config.js';
import * as gitHook from '../git-hook.js';
import { log } from '@teamai/shared/log';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bootstrap-test-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrapSelfMode', () => {
  it("returns 'skip' when there is no .teamai/teamai.yaml (not a teamai project)", async () => {
    const result = await bootstrapSelfMode(tmpDir, { silent: true });
    expect(result).toBe('skip');
  });

  it("returns 'skip' when teamai.yaml exists but has no mode: self (standalone team repo marker absent)", async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'teamai.yaml'),
      YAML.stringify({ team: 'x', repo: 'https://github.com/acme/app.git' }),
    );
    const result = await bootstrapSelfMode(tmpDir, { silent: true });
    expect(result).toBe('skip');
  });

  it.each([
    { silent: true, gitHookFailure: false },
    { silent: true, gitHookFailure: true },
    { silent: false, gitHookFailure: true },
  ])('trusts self project hooks during bootstrap, silent=$silent, gitHookFailure=$gitHookFailure', async ({ silent, gitHookFailure }) => {
    tmpDir = fs.realpathSync.native(tmpDir);
    const home = path.join(tmpDir, 'home');
    const project = path.join(tmpDir, 'project');
    const teamaiDir = path.join(project, '.teamai');
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    const fakeBin = installFakeCodex();
    vi.stubEnv('HOME', home);
    vi.stubEnv('PATH', `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`);
    fs.writeFileSync(path.join(teamaiDir, 'teamai.yaml'), YAML.stringify({
      team: 'test', mode: 'self', repo: 'https://github.com/acme/app.git', provider: 'github',
      toolPaths: { codex: { skills: '.codex/skills', settings: '.codex/hooks.json' } },
    }));
    const failure = new Error('EACCES: read-only .git/config');
    const install = vi.spyOn(gitHook, 'installGitHook');
    if (gitHookFailure) install.mockRejectedValueOnce(failure);
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => {});
    try {
      expect(await bootstrapSelfMode(project, { silent })).toBe('bootstrapped');
      if (gitHookFailure) expect(debug).toHaveBeenCalledWith(expect.stringContaining(failure.message));
      const state = readFakeCodexState(codexHome);
      expect(state.projects[project]).toEqual({ trust_level: 'trusted' });
      expect(Object.keys(state.hooksState).length).toBeGreaterThan(0);
      expect(Object.keys(state.hooksState).some((key) => key.includes(':session_start:'))).toBe(true);
      expect(Object.keys(state.hooksState).every((key) => key.startsWith(path.join(project, '.codex', 'hooks.json')))).toBe(true);
    } finally {
      install.mockRestore();
      debug.mockRestore();
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("returns 'already' when a local config.yaml is already present", async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'teamai.yaml'),
      YAML.stringify({ team: 'x', mode: 'self', repo: 'https://github.com/acme/app.git' }),
    );
    fs.writeFileSync(
      path.join(teamaiDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: teamaiDir, remote: 'r', kind: 'self' },
        username: 'alice',
        scope: 'project',
        projectRoot: tmpDir,
      }),
    );
    const result = await bootstrapSelfMode(tmpDir, { silent: true });
    expect(result).toBe('already');
  });
});

describe('detectProjectConfig self-heal', () => {
  it('returns null (no crash) for a self-mode marker when a provider cannot be derived', async () => {
    // teamai.yaml has mode: self but no repo field, and the temp dir is not inside
    // a git repo — so there is no remote to derive a provider from. The
    // non-interactive bootstrap degrades to skip and detect returns null without
    // writing a config. (Deterministic regardless of local gh/git auth.)
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'teamai.yaml'),
      YAML.stringify({ team: 'x', mode: 'self' }),
    );
    const result = await detectProjectConfig(tmpDir);
    expect(result).toBeNull();
    // Must NOT have written a config (bootstrap did not complete).
    expect(fs.existsSync(path.join(teamaiDir, 'config.yaml'))).toBe(false);
  });

  it('returns the config when config.yaml already exists (no bootstrap needed)', async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: teamaiDir, remote: 'r', kind: 'self', businessRepoRoot: tmpDir },
        username: 'alice',
        scope: 'project',
        projectRoot: tmpDir,
      }),
    );
    const result = await detectProjectConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.repo.kind).toBe('self');
    expect(result?.username).toBe('alice');
  });
});

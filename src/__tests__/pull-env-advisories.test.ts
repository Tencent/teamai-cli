/**
 * #875 (#879 S6): an interactive pull names a declared secret with no value,
 * the server that needs it and the command that fixes it; the silent
 * session-start pull prints nothing. Harness from pull-env-shape-warning.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  loadTeamConfig: vi.fn(),
  requireInit: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    fail: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(),
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [{
      id: 'dev',
      name: 'Dev',
      description: '',
      resources: { knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [] },
    }],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({
    knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [],
  })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

// Counts the value store reads, for the one-resolution-per-pull test.
vi.mock('../secret-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secret-store.js')>();
  return { ...actual, readSecretStore: vi.fn(actual.readSecretStore) };
});

// The end-of-pull checks are exercised in pull-post-checks.test.ts; keep them
// out of the way here so a warning under test is the only thing on the wire.
vi.mock('../doctor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../doctor.js')>(),
  resolveDoctorContext: vi.fn(),
  buildChecks: vi.fn(),
}));

import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig } from '../config.js';
import { acquireLock } from '../update.js';
import { buildChecks, resolveDoctorContext, type DoctorContext } from '../doctor.js';
import { log } from '../utils/logger.js';
import { pull } from '../pull.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import { getMachineSecretsPath, getTeamSecretsPath, readSecretStore, writeSecretStore } from '../secret-store.js';
import { secretsEntryReader } from '../resources/secrets.js';

const GITHUB_LINE = 'github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (https://github.com/settings/tokens).';
const KEPT_LINE = 'github: the entry an earlier pull wrote stays in claude and may hold an old GITHUB_TOKEN until a pull finds its value.';

describe('pull advisories for team secrets', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let scopeConfig: LocalConfig;

  const write = (relativePath: string, content: string): Promise<void> =>
    fse.outputFile(path.join(repoPath, ...relativePath.split('/')), content);
  const warned = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));
  /** Every printed line; debug.log still records the skip reason, as before. */
  const printed = (): string[] => (['warn', 'info', 'dim', 'success', 'error'] as const)
    .flatMap((level) => vi.mocked(log[level]).mock.calls.map(([message]) => String(message)));

  beforeEach(async () => {
    resetWarnOnce();
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-env-advisories-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv('GITLAB_TOKEN', undefined);
    vi.stubEnv('GITLAB_HOST', undefined);
    vi.stubEnv('MY_GITLAB_HOST', undefined);

    await write('skills/common/kept-skill/SKILL.md', '---\nname: kept-skill\ndescription: kept\n---\n');
    await write('manifest/roles.yaml', 'version: 1\n');
    await write('mcp/mcp.yaml', [
      'servers:',
      '  - name: github',
      '    transport: http',
      '    url: https://api.example.com/mcp/',
      '    headers:',
      '      Authorization: Bearer ${GITHUB_TOKEN}',
    ].join('\n'));
    await write('env/secrets.yaml', 'secrets:\n  - key: GITHUB_TOKEN\n    url: https://github.com/settings/tokens\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      primaryRole: 'dev',
      additionalRoles: [],
    };
    scopeConfig = localConfig;
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false },
      },
      toolPaths: { claude: { skills: '.claude/skills', mcp: '.claude.json' } },
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(loadStateForScope).mockResolvedValue({ lastPull: null, lastPullRev: null } as never);
    const ctx: DoctorContext = {
      localConfig,
      teamConfig,
      toolPaths: teamConfig.toolPaths,
      hookToolPaths: teamConfig.toolPaths,
      baseDir: homeDir,
    };
    vi.mocked(resolveDoctorContext).mockResolvedValue(ctx);
    vi.mocked(buildChecks).mockResolvedValue([]);
    vi.mocked(acquireLock).mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('names the server, the key, the command and the url', async () => {
    await pull({ force: true });

    expect(warned()).toContain(GITHUB_LINE);
  });

  it('names a secret no MCP server uses, with no mcp.yaml', async () => {
    await fse.remove(path.join(repoPath, 'mcp'));
    await write('env/secrets.yaml', 'secrets:\n  - key: GITLAB_TOKEN\n');

    await pull({ force: true });

    expect(warned()).toContain('GITLAB_TOKEN is not set. Run `teamai env set GITLAB_TOKEN`.');
  });

  // One resolution per scope serves env.sh, the MCP reconcile and the advisories.
  it('reads env/secrets.yaml and each value store once', async () => {
    await write('env/env.yaml', 'variables:\n  - key: API_URL\n    value: u\n');
    const secretsRead = vi.spyOn(secretsEntryReader, 'read');
    vi.mocked(readSecretStore).mockClear();

    await pull({ force: true });

    expect(warned()).toContain(GITHUB_LINE);
    expect(secretsRead.mock.calls.map(([, relativePath]) => relativePath)).toEqual(['env/secrets.yaml']);
    expect(vi.mocked(readSecretStore).mock.calls.map(([file]) => file).sort())
      .toEqual([getMachineSecretsPath(), getTeamSecretsPath(scopeConfig)].sort());
    secretsRead.mockRestore();
  });

  it('prints nothing about it on a silent pull', async () => {
    await pull({ force: true, silent: true });

    expect(printed().some((message) => message.includes('GITHUB_TOKEN'))).toBe(false);
  });

  it('says a kept entry may hold an old value, and that pull did write none of it', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'shell-token');
    await pull({ force: true });
    const claudeJson = await fse.readFile(path.join(homeDir, '.claude.json'), 'utf8');
    expect(claudeJson).toContain('Bearer shell-token');

    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.mocked(log.warn).mockClear();
    resetWarnOnce();
    await pull({ force: true });

    expect(warned()).toEqual(expect.arrayContaining([GITHUB_LINE, KEPT_LINE]));
    expect(await fse.readFile(path.join(homeDir, '.claude.json'), 'utf8')).toBe(claudeJson);
    expect(printed().some((message) => message.includes('shell-token'))).toBe(false);
  });

  it('warns about a key declared as a secret and also set in env.yaml', async () => {
    await write('env/env.yaml', 'variables:\n  - key: GITHUB_TOKEN\n    value: repo-token\n');

    await pull({ force: true });

    expect(warned()).toContain(
      'GITHUB_TOKEN is a team secret and is also set in env/env.yaml, whose value is ignored. '
        + 'Remove it from env/env.yaml and run `teamai push`.',
    );
    expect(printed().some((message) => message.includes('repo-token'))).toBe(false);
  });

  it('says nothing once the secret has a value', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'shell-token');

    await pull({ force: true });

    expect(warned().some((message) => message.includes('GITHUB_TOKEN'))).toBe(false);
  });

  // #875 (#879 S9): the environment no longer overrides a plain variable; pull
  // says so, and env.sh exports the member's value for this team.
  describe('a plain variable the environment no longer overrides', () => {
    const IGNORED_LINE = 'GITLAB_HOST in your environment differs from the value in env/env.yaml, which this team uses. '
      + 'To use yours for this team, run `teamai env set GITLAB_HOST`.';
    const envSh = (): Promise<string> => fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf8');

    beforeEach(async () => {
      await write('env/env.yaml', 'variables:\n  - key: GITLAB_HOST\n    value: gitlab.team.example\n  - key: API_URL\n    value: https://team.example\n');
    });

    it('tells the member to run env set when it ignores a differing export, and never prints either value', async () => {
      vi.stubEnv('GITLAB_HOST', 'gitlab.dave.example');

      await pull({ force: true });

      expect(warned()).toContain(IGNORED_LINE);
      expect(warned().filter((message) => message.includes('--from-env'))).toEqual([]);
      expect(printed().some((message) => message.includes('gitlab.dave.example') || message.includes('gitlab.team.example'))).toBe(false);
      expect(await envSh()).toContain("export GITLAB_HOST='gitlab.team.example'");
    });

    it('says nothing on a silent pull', async () => {
      vi.stubEnv('GITLAB_HOST', 'gitlab.dave.example');

      await pull({ force: true, silent: true });

      expect(printed().some((message) => message.includes('GITLAB_HOST'))).toBe(false);
    });

    it("says nothing for an export that is another scope's env.sh value, or equals the team's", async () => {
      await fse.outputFile(path.join(homeDir, '.teamai', 'projects', 'other-abc', 'env.sh'), "export GITLAB_HOST='gitlab.other.example'\n");
      vi.stubEnv('GITLAB_HOST', 'gitlab.other.example');
      vi.stubEnv('API_URL', 'https://team.example');

      await pull({ force: true });

      expect(printed().some((message) => message.includes('GITLAB_HOST') || message.includes('API_URL'))).toBe(false);
    });

    // #879: a secret's value stays one after the key stops being a secret; an entry without a kind counts as one.
    it('exports the env.yaml value, never a value stored while the key was a secret, in env.sh and the env backup', async () => {
      await writeSecretStore(getTeamSecretsPath(scopeConfig), {
        GITLAB_HOST: { value: 'fixture-old-secret' },
        API_URL: { value: 'fixture-old-secret-2', kind: 'secret' },
      });

      await pull({ force: true });

      const exported = await envSh();
      expect(exported).toContain("export GITLAB_HOST='gitlab.team.example'");
      expect(exported).toContain("export API_URL='https://team.example'");
      const backup = await fse.readFile(path.join(homeDir, '.teamai', 'env'), 'utf8');
      expect(`${exported}${backup}${printed().join('\n')}`).not.toContain('fixture-old-secret');
    });

    it("exports the member's literal value in env.sh, leaves out a --from-env one, and says nothing then", async () => {
      await writeSecretStore(getTeamSecretsPath(scopeConfig), {
        GITLAB_HOST: { value: 'gitlab.dave.example', kind: 'variable' },
        API_URL: { env: 'MY_API_URL', kind: 'variable' },
      });
      vi.stubEnv('GITLAB_HOST', 'gitlab.other.example');
      vi.stubEnv('MY_API_URL', 'https://mine.example');

      await pull({ force: true });

      const exported = await envSh();
      expect(exported).toContain("export GITLAB_HOST='gitlab.dave.example'");
      expect(exported).not.toContain('API_URL');
      expect(await fse.readFile(path.join(homeDir, '.teamai', 'env'), 'utf8')).toBe('GITLAB_HOST=gitlab.dave.example\n');
      expect(printed().some((message) => message.includes('GITLAB_HOST') || message.includes('API_URL'))).toBe(false);
    });
  });
});

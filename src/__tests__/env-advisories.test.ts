import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
  requireInit: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import { autoDetectInit, loadLocalConfig, loadTeamConfig, requireInit } from '../config.js';
import { doctor, type DoctorReport } from '../doctor.js';
import { envList } from '../env-commands.js';
import { mcpList } from '../mcp-cmd.js';
import { EnvHandler } from '../resources/env.js';
import { getMachineSecretsPath, getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const GITHUB_LINE = 'github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (https://github.com/settings/tokens).';
const GITHUB_SERVER = [
  'servers:',
  '  - name: github',
  '    transport: http',
  '    url: https://api.example.com/mcp/',
  '    headers:',
  '      Authorization: Bearer ${GITHUB_TOKEN}',
].join('\n');
const GITHUB_SECRET = 'secrets:\n  - key: GITHUB_TOKEN\n    url: https://github.com/settings/tokens\n';

/**
 * #875 (#879 S6): a declared secret with no value names the server that needs
 * it and the command that fixes it, in `mcp list`, `env list` and `doctor`.
 * Pull is covered in pull-env-advisories.test.ts.
 */
describe('a missing declared secret tells the member what to run', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const write = (relativePath: string, content: string): Promise<void> =>
    fse.outputFile(path.join(repoPath, ...relativePath.split('/')), content);
  const warned = (): string[] => vi.mocked(log.warn).mock.calls.map(([message]) => String(message));

  async function doctorReport(): Promise<{ allPassed: boolean; report: DoctorReport }> {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const allPassed = await doctor({ json: true });
      return { allPassed, report: JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as DoctorReport };
    } finally {
      spy.mockRestore();
    }
  }

  async function quietly(run: () => Promise<void>): Promise<void> {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(async () => {
    resetWarnOnce();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-advisories-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv('GITLAB_TOKEN', undefined);
    localConfig = { repo: { localPath: repoPath, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [] };
    teamConfig = {
      team: 'test', description: '', repo: 'owner/repo', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: { claude: { skills: '.claude/skills', mcp: '.claude.json' } },
    };
    await write('teamai.yaml', 'team: test\n');
    await write('mcp/mcp.yaml', GITHUB_SERVER);
    await write('env/secrets.yaml', GITHUB_SECRET);
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig, teamConfig });
    vi.mocked(requireInit).mockResolvedValue({ localConfig, teamConfig });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it('mcp list names the server, the key, the command and the url', async () => {
    await quietly(() => mcpList({}));

    expect(warned()).toContain(GITHUB_LINE);
  });

  // #879 Conflict 14: a failed declaration can't mean "no secrets".
  it('mcp list reports a broken secrets.yaml, exits 1 and does not call a secret from the environment set', async () => {
    await write('env/secrets.yaml', 'secret:\n  - key: GITHUB_TOKEN\n');
    vi.stubEnv('GITHUB_TOKEN', 'other-team-token');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await mcpList({});
      const out = spy.mock.calls.map(([line]) => String(line)).join('\n');
      expect(out).toContain('secrets:  GITHUB_TOKEN (not resolved)');
      expect(out).not.toContain('all set');
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = undefined;
    }
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(expect.stringContaining('env/secrets.yaml declares no secrets'));
  });

  it('on Windows, mcp list matches ${github_token} to the declared GITHUB_TOKEN, missing or set', async () => {
    await write('mcp/mcp.yaml', GITHUB_SERVER.replace('${GITHUB_TOKEN}', '${github_token}'));
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await quietly(() => mcpList({}));
      expect(warned()).toContain(GITHUB_LINE);
      vi.stubEnv('GITHUB_TOKEN', 'fixture-exported');
      spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await mcpList({});
      expect(spy.mock.calls.map(([line]) => String(line)).join('\n')).toContain('secrets:  github_token (all set)');
    } finally {
      spy?.mockRestore();
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('env list prints the same line', async () => {
    await quietly(() => envList({}));

    expect(warned()).toContain(GITHUB_LINE);
  });

  it('names no server for a secret no MCP server uses, with no mcp.yaml and no url', async () => {
    await fse.remove(path.join(repoPath, 'mcp'));
    await write('env/secrets.yaml', 'secrets:\n  - key: GITLAB_TOKEN\n');

    await quietly(() => envList({}));
    await quietly(() => mcpList({}));
    const { report } = await doctorReport();

    const line = 'GITLAB_TOKEN is not set. Run `teamai env set GITLAB_TOKEN`.';
    expect(warned().filter((message) => message === line)).toHaveLength(2);
    expect(report.notes).toContain(line);
  });

  it('says nothing once the member set a value', async () => {
    await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });

    await quietly(() => envList({}));
    await quietly(() => mcpList({}));
    const { report } = await doctorReport();

    expect(warned().some((message) => message.includes('is not set'))).toBe(false);
    expect(report.notes ?? []).not.toContain(GITHUB_LINE);
  });

  // `teamai env set KEY` there would replace the reference, which may be what the member wants, or not.
  it('says to set the variable a --from-env value reads when it is unset, or to replace the reference', async () => {
    vi.stubEnv('WORK_GITHUB_TOKEN', undefined);
    vi.stubEnv('MY_GITHUB_TOKEN', undefined);
    await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });

    await quietly(() => mcpList({}));

    expect(warned()).toContain(
      'github: GITHUB_TOKEN reads WORK_GITHUB_TOKEN, which is not set. '
        + 'Set WORK_GITHUB_TOKEN, or run `teamai env set GITHUB_TOKEN` to replace the reference.',
    );
    expect(warned()).not.toContain(GITHUB_LINE);

    vi.mocked(log.warn).mockClear();
    await writeSecretStore(getTeamSecretsPath(localConfig), {});
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { env: 'MY_GITHUB_TOKEN' } });
    await quietly(() => envList({}));

    expect(warned()).toContain(
      'github: GITHUB_TOKEN reads MY_GITHUB_TOKEN, which is not set. '
        + 'Set MY_GITHUB_TOKEN, or run `teamai env set GITHUB_TOKEN --global` to replace the reference.',
    );
  });

  it('says nothing when the only value is the machine value', async () => {
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'machine-token' } });

    await quietly(() => envList({}));
    await quietly(() => mcpList({}));
    const { report } = await doctorReport();

    expect(warned().some((message) => message.includes('is not set'))).toBe(false);
    expect(report.notes ?? []).not.toContain(GITHUB_LINE);
  });

  it('doctor reports it as a note and exits as it would without the secret', async () => {
    await write('mcp/mcp.yaml', 'servers: []\n');
    await fse.remove(path.join(repoPath, 'env'));
    const without = await doctorReport();

    await write('mcp/mcp.yaml', GITHUB_SERVER);
    await write('env/secrets.yaml', GITHUB_SECRET);
    const withMissing = await doctorReport();

    expect(withMissing.report.notes).toContain(GITHUB_LINE);
    expect(withMissing.allPassed).toBe(without.allPassed);
    expect(withMissing.report.ok).toBe(without.report.ok);
    expect(withMissing.report.checks.filter((check) => !check.ok).map((check) => check.name))
      .toEqual(without.report.checks.filter((check) => !check.ok).map((check) => check.name));
  });

  // Otherwise the MCP check passes and only a pull warning says why the secrets have no value.
  it('doctor fails a check when the member\'s values file can\'t be read, naming the file and never a value', async () => {
    await fse.outputFile(getTeamSecretsPath(localConfig), '{ "GITHUB_TOKEN": { "value": ghp_fixture_value } }');

    const { allPassed, report } = await doctorReport();

    const check = report.checks.find((candidate) => candidate.name === 'Your team secret values can be read');
    expect(check?.ok).toBe(false);
    expect(check?.fix).toContain(`${getTeamSecretsPath(localConfig)} is not valid JSON`);
    expect(allPassed).toBe(false);
    expect(JSON.stringify(report)).not.toContain('ghp_fixture_value');
  });

  it('doctor passes that check once the values file can be read', async () => {
    await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });

    const { report } = await doctorReport();

    expect(report.checks.find((candidate) => candidate.name === 'Your team secret values can be read')?.ok).toBe(true);
  });

  it('doctor still fails an unrelated MCP delivery problem next to it', async () => {
    await write('mcp/mcp.yaml', `${GITHUB_SERVER}\n  - name: docs\n    transport: stdio\n    command: docs-server\n`);

    const { report } = await doctorReport();

    const mcp = report.checks.find((check) => check.name === 'MCP servers delivered to claude');
    expect(mcp?.ok).toBe(false);
    expect(mcp?.fix).toContain('not injected: docs');
    expect(mcp?.fix).not.toContain('GITHUB_TOKEN');
    expect(report.notes).toContain(GITHUB_LINE);
  });

  it('doctor notes that an entry kept for a missing secret may hold an old value', async () => {
    await fse.writeJson(path.join(homeDir, '.claude.json'), {
      mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: 'Bearer old' } } },
    });
    await fse.outputJson(path.join(homeDir, '.teamai', 'managed-mcp.json'), { claude: [{ name: 'github', hash: 'h' }] });

    const { report } = await doctorReport();

    expect(report.notes).toContain(
      'github: the entry an earlier pull wrote stays in claude and may hold an old GITHUB_TOKEN until a pull finds its value.',
    );
    expect(JSON.stringify(report)).not.toContain('Bearer old');
  });

  it('doctor does not call an entry teamai never wrote a kept one', async () => {
    await fse.writeJson(path.join(homeDir, '.claude.json'), { mcpServers: { github: { type: 'http', url: 'https://mine/' } } });

    const { report } = await doctorReport();

    expect((report.notes ?? []).some((note) => note.includes('earlier pull'))).toBe(false);
  });

  it('doctor notes a key declared as a secret and also set in env.yaml', async () => {
    await write('env/env.yaml', 'variables:\n  - key: GITHUB_TOKEN\n    value: repo-token\n');

    const { report } = await doctorReport();

    expect(report.notes).toContain(
      'GITHUB_TOKEN is a team secret and is also set in env/env.yaml, whose value is ignored. '
        + 'Remove it from env/env.yaml and run `teamai push`.',
    );
    expect(JSON.stringify(report)).not.toContain('repo-token');
  });

  // #879 S9: doctor runs in the member's shell too, so it explains why an MCP
  // server doesn't use their export; a note, like the rest.
  it('doctor notes an ignored export for a team with no secrets, and env list and mcp list do not', async () => {
    await fse.remove(path.join(repoPath, 'env', 'secrets.yaml'));
    await write('env/env.yaml', 'variables:\n  - key: GITLAB_HOST\n    value: gitlab.team.example\n');
    vi.stubEnv('GITLAB_HOST', 'gitlab.dave.example');

    await quietly(() => envList({}));
    await quietly(() => mcpList({}));
    const { report } = await doctorReport();

    const line = 'GITLAB_HOST in your environment differs from the value in env/env.yaml, which this team uses. '
      + 'To use yours for this team, run `teamai env set GITLAB_HOST`.';
    expect(report.notes).toContain(line);
    expect(warned().some((message) => message.includes('GITLAB_HOST'))).toBe(false);
    expect(JSON.stringify(report)).not.toContain('gitlab.dave.example');
  });

  // #879 Conflict 10: a shell opened before a team edit carries the old value
  // through every later command, not only the pull that rewrote env.sh.
  it('doctor does not call the value an earlier env.sh exported an ignored export', async () => {
    await fse.remove(path.join(repoPath, 'env', 'secrets.yaml'));
    const handler = new EnvHandler();
    await handler.writeResolvedEnv([{ key: 'GITLAB_HOST', value: 'gitlab.old.example' }], teamConfig, localConfig);
    await handler.writeResolvedEnv([{ key: 'GITLAB_HOST', value: 'gitlab.new.example' }], teamConfig, localConfig);
    await write('env/env.yaml', 'variables:\n  - key: GITLAB_HOST\n    value: gitlab.new.example\n');
    vi.stubEnv('GITLAB_HOST', 'gitlab.old.example');

    const { report } = await doctorReport();

    expect((report.notes ?? []).some((note) => note.includes('GITLAB_HOST'))).toBe(false);
  });

  it('mcp list names a declared secret withheld from a project config git tracks, with the file and the fix (#879)', async () => {
    const projectRoot = path.join(tmpDir, 'business-repo');
    await fse.ensureDir(path.join(projectRoot, '.claude', 'skills'));
    execFileSync('git', ['init', '-q'], { cwd: projectRoot });
    await fse.writeJson(path.join(projectRoot, '.mcp.json'), { mcpServers: {} });
    execFileSync('git', ['add', '.mcp.json'], { cwd: projectRoot });
    Object.assign(localConfig, { scope: 'project', projectRoot });
    teamConfig.toolPaths = { claude: { skills: '.claude/skills', mcp: '.claude.json', mcpProject: '.mcp.json' } };
    vi.stubEnv('GITHUB_TOKEN', 'fixture-github-token');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await mcpList({});
      const out = spy.mock.calls.map(([line]) => String(line)).join('\n');
      const file = path.join(projectRoot, '.mcp.json');
      expect(out).toContain(`withheld: claude — git already tracks ${file}. Run \`git rm --cached ${file}\` (rotate any value a commit of it holds)`);
      expect(out.match(/withheld:/g)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

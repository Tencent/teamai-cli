import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(), persist: vi.fn(),
  },
}));

import { buildVarTable, reconcileMcpForConfig } from '../mcp-reconcile.js';
import { getTeamSecretsPath, writeSecretStore } from '../secret-store.js';
import { log } from '../utils/logger.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * `${VAR}` in mcp.yaml for a declared secret (#875): the member's value for
 * this team, then their own environment (#879 Conflict 10), never the repo's
 * env.yaml value for the same key.
 */
describe('MCP servers and declared secrets', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  const teamConfig = {
    team: 't', description: '', repo: 'r', provider: 'tgit', reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '~/.teamai/docs' }, env: { injectShellProfile: false } },
    toolPaths: { claude: { skills: '.claude/skills', settings: '.claude/settings.json', mcp: '.claude.json', mcpProject: '.mcp.json' } },
  } as unknown as TeamaiConfig;

  const write = (relativePath: string, content: string): Promise<void> =>
    fse.outputFile(path.join(repoPath, ...relativePath.split('/')), content);
  const githubAuthorization = async (): Promise<string | undefined> => {
    const file = path.join(homeDir, '.claude.json');
    if (!await fse.pathExists(file)) return undefined;
    const config = await fse.readJson(file) as { mcpServers?: Record<string, { headers?: Record<string, string> }> };
    return config.mcpServers?.github?.headers?.Authorization;
  };

  beforeEach(async () => {
    resetWarnOnce();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-secrets-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    localConfig = { repo: { localPath: repoPath, remote: 'r' }, username: 'u', scope: 'user', additionalRoles: [] } as unknown as LocalConfig;
    await write('mcp/mcp.yaml', [
      'servers:',
      '  - name: github',
      '    transport: http',
      '    url: https://api.example.com/mcp/',
      '    headers:',
      '      Authorization: Bearer ${GITHUB_TOKEN}',
    ].join('\n'));
    await write('env/secrets.yaml', 'secrets:\n  - key: GITHUB_TOKEN\n');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('gives a server the team value over an exported one', async () => {
    await writeSecretStore(getTeamSecretsPath(localConfig), { GITHUB_TOKEN: { value: 'team-token' } });
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBe('Bearer team-token');
  });

  it("uses the member's own export when no team value is set", async () => {
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBe('Bearer exported-token');
  });

  it("does not use a value another scope's env.sh exported", async () => {
    await fse.outputFile(path.join(homeDir, '.teamai', 'projects', 'other-abc', 'env.sh'), "export GITHUB_TOKEN='other-team-token'\n");
    vi.stubEnv('GITHUB_TOKEN', 'other-team-token');

    await reconcileMcpForConfig(teamConfig, localConfig);

    expect(await githubAuthorization()).toBeUndefined();
  });

  it("ignores the env.yaml value of a key declared as a secret, and the shell's copy of it", async () => {
    await write('env/env.yaml', 'variables:\n  - key: GITHUB_TOKEN\n    value: repo-token\n  - key: API_URL\n    value: u\n');
    vi.stubEnv('GITHUB_TOKEN', 'repo-token');

    const vars = await buildVarTable(localConfig);

    expect(vars.GITHUB_TOKEN).toBeUndefined();
    expect(vars.API_URL).toBe('u');
  });

  it('keeps today\'s order for a variable that is not declared as a secret', async () => {
    await write('env/env.yaml', 'variables:\n  - key: API_URL\n    value: team-url\n');
    vi.stubEnv('API_URL', 'exported-url');

    expect((await buildVarTable(localConfig)).API_URL).toBe('exported-url');
  });

  it('warns without the value when the store cannot be read, and resolves the secret to nothing', async () => {
    await fse.outputFile(getTeamSecretsPath(localConfig), '{"GITHUB_TOKEN": {"value": ghp_fixture_value}}');
    vi.stubEnv('GITHUB_TOKEN', 'exported-token');

    const vars = await buildVarTable(localConfig);

    expect(vars.GITHUB_TOKEN).toBeUndefined();
    const warnings = vi.mocked(log.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings).toEqual([expect.stringContaining(`${getTeamSecretsPath(localConfig)} is not valid JSON (line 1, column 28)`)]);
    expect(warnings.join('\n')).not.toContain('ghp_fixture_value');
  });
});

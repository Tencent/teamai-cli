import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The env half of the delivery check (#624). The plumbing version asked only
 * whether the marker comment was in the profile, which is true of a block that
 * cannot load (#661) and of a run that delivered nothing (#662) — both of which
 * surface three layers away as MCP servers skipped for unresolved variables.
 */
describe('doctor — env variables reach a shell', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;
  let envShPath: string;
  let profilePath: string;

  async function writeEnvYaml(body: string): Promise<void> {
    await fse.ensureDir(path.join(repoPath, 'env'));
    await fse.writeFile(path.join(repoPath, 'env', 'env.yaml'), body);
  }

  async function writeEnvSh(body: string): Promise<void> {
    await fse.ensureDir(path.dirname(envShPath));
    await fse.writeFile(envShPath, body);
  }

  async function writeProfile(sourceLine: string): Promise<void> {
    await fse.writeFile(
      profilePath,
      `# [teamai:env:start]\n# DO NOT EDIT: This section is auto-managed by teamai\n${sourceLine}\n# [teamai:env:end]\n`,
    );
  }

  async function envCheck(): Promise<Check> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const check = (await buildChecks(ctx)).find((c) => c.name === 'Env variables injected in shell profile');
    if (!check) throw new Error('no env check');
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    envShPath = path.join(homeDir, '.teamai', 'env.sh');
    profilePath = path.join(homeDir, '.bashrc');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/bash');

    await writeEnvYaml('variables:\n  - key: JIRA_PASSWORD\n    value: "s3cret"\n');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {},
    };

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when the block loads an env.sh carrying every declared variable', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('fails when the block points at a path a POSIX shell cannot read (#661)', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    const windowsStyle = envShPath.replace(/\//g, '\\');
    await writeProfile(`[ -f ${windowsStyle} ] && source ${windowsStyle}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('does not load');
    expect(check.fix).toContain(envShPath);
  });

  it('fails and names `variables:` for the shorthand env.yaml form (#662)', async () => {
    await writeEnvYaml('JIRA_PASSWORD: "s3cret"\n');
    await writeEnvSh('');
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('declares no variables');
    expect(check.fix).toContain('variables:');
  });

  it('passes for a multiline value the shell quotes across several lines', async () => {
    // A YAML block scalar is a legal env value, and single-quoting one spans
    // physical lines. A reader that scans env.sh line by line can never match
    // that export, so it called a correct delivery stale.
    await writeEnvYaml('variables:\n  - key: TEAM_KEY\n    value: |\n      line one\n      line two\n');
    await writeEnvSh("export TEAM_KEY='line one\nline two\n'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('still reports a multiline value that drifted from env.yaml', async () => {
    await writeEnvYaml('variables:\n  - key: TEAM_KEY\n    value: |\n      line one\n      line two\n');
    await writeEnvSh("export TEAM_KEY='line one\nsomething else\n'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('stale value');
  });

  it('passes for a value carrying a single quote, which the generator escapes', async () => {
    await writeEnvYaml("variables:\n  - key: TEAM_KEY\n    value: \"it's here\"\n");
    await writeEnvSh("export TEAM_KEY='it'\\''s here'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('passes for an env.yaml that declares `variables: []` on purpose', async () => {
    // Nothing is owed, so nothing can be undelivered. This parses correctly
    // and is a deliberately empty configuration, not the shorthand form.
    await writeEnvYaml('variables: []\n');

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('passes for an empty env.yaml', async () => {
    await writeEnvYaml('');

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('fails and names the file when env.yaml is not valid YAML', async () => {
    await writeEnvYaml('variables:\n  - key: A\n   value: bad indent\n');

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain(path.join(repoPath, 'env', 'env.yaml'));
  });

  it('fails when env.sh still exports the value env.yaml replaced', async () => {
    await writeEnvSh("export JIRA_PASSWORD='rotated-away'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('JIRA_PASSWORD');
    expect(check.fix).toContain('stale value');
    // The value is a secret: naming the key is the whole diagnosis.
    expect(check.fix).not.toContain('s3cret');
    expect(check.fix).not.toContain('rotated-away');
  });

  it('fails when a declared variable never reached env.sh', async () => {
    await writeEnvSh("export OTHER='x'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('JIRA_PASSWORD');
  });

  it('fails when the profile carries no TeamAI block at all', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    await fse.writeFile(profilePath, '# nothing here\n');

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('carries no TeamAI env block');
  });

  it('passes when the team opted out of shell-profile injection', async () => {
    teamConfig.sharing.env = { injectShellProfile: false };

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('passes when the team ships no env.yaml', async () => {
    await fse.remove(path.join(repoPath, 'env'));

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('accepts a quoted path containing whitespace', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    await writeProfile(`[ -f "${envShPath}" ] && source "${envShPath}"`);

    expect(await (await envCheck()).check()).toBe(true);
  });
});

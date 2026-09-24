import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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

  // A stray leftover block is cleanup hygiene, not a delivery failure — kept
  // as its own Check (#693 review round 5) so a working delivery never
  // reports as broken just because a dead file needs cleaning up.
  async function staleBlockCheck(): Promise<Check> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const check = (await buildChecks(ctx)).find((c) => c.name === 'No stale env blocks left behind');
    if (!check) throw new Error('no stale-block check');
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

  // Regression (#693 hardware review by @CarlosWonMore): which file `pull`
  // prefers has changed (#682), and `pull` only ever adds a block, never
  // migrates an old one away. A stray, still-scope-owned block left behind
  // in a different candidate file must not go unreported forever.
  it('flags a stray legacy block left in a different candidate file for this scope (#693)', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    // Force the resolved profile to .profile, bypassing platform-dependent
    // detectShellProfile() so this test is deterministic on any host.
    teamConfig.sharing.env.shellProfilePath = path.join(homeDir, '.profile');
    // The generator always writes the forward-slash, quoted form; envShPath
    // is a native OS path (backslashes on a Windows dev host), so convert it
    // the same way generateShellBlock does — this block must actually load,
    // since the point of this test is that delivery stays healthy.
    const envShPosix = envShPath.split(path.sep).join('/');
    await fse.writeFile(
      path.join(homeDir, '.profile'),
      `# [teamai:env:start]\n# DO NOT EDIT\n[ -f '${envShPosix}' ] && source '${envShPosix}'\n# [teamai:env:end]\n`,
    );
    // A legacy block for the SAME env.sh, left behind in .bashrc — raw and
    // unquoted (the current generator always quotes via shellQuoteValue, so
    // an unquoted block is necessarily from an older write path). Windows-
    // specific legacy spellings (backslash, MSYS drive form) are covered
    // directly in shell-profile.test.ts's envBlockReferencesDataHome suite,
    // with explicit Windows-shaped test data rather than a host-dependent
    // string transform of this test's own (POSIX-on-CI) envShPath.
    await fse.writeFile(
      path.join(homeDir, '.bashrc'),
      `# my bashrc\n# [teamai:env:start]\n# DO NOT EDIT\n[ -f ${envShPath} ] && source ${envShPath}\n# [teamai:env:end]\n`,
    );

    // Delivery itself is healthy — a stray leftover must not report as a
    // delivery failure (#693 review round 5).
    expect(await (await envCheck()).check()).toBe(true);

    const stale = await staleBlockCheck();
    expect(await stale.check()).toBe(false);
    expect(stale.fix).toContain('.bashrc');
    expect(stale.fix).toContain('teamai uninstall');
  });

  // Regression (#693 review round 4): an unexpanded `~/...` override made
  // the stray-block scan compare a literal `~/.profile` string against its
  // own always-absolute candidate paths, so the resolved file never matched
  // itself and got reported as a stray copy of its own valid block.
  it('does not report shellProfilePath\'s own file as a stray copy of itself', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    teamConfig.sharing.env.shellProfilePath = '~/.profile';
    // The generator always writes the forward-slash form; envShPath is a
    // native OS path (backslashes on a Windows dev host), so convert it the
    // same way generateShellBlock does before writing this test fixture.
    const profileShPosix = envShPath.split(path.sep).join('/');
    await fse.writeFile(
      path.join(homeDir, '.profile'),
      `# [teamai:env:start]\n# DO NOT EDIT\n[ -f '${profileShPosix}' ] && source '${profileShPosix}'\n# [teamai:env:end]\n`,
    );

    expect(await (await envCheck()).check()).toBe(true);
    expect(await (await staleBlockCheck()).check()).toBe(true);
  });

  // Regression (#693 review round 6): `shellProfilePath` is user-supplied and
  // may use forward slashes (or, on Windows, different case) even though the
  // stray-block scan's own candidate is built with `path.join`, which uses
  // the host's native separator. A raw string comparison between the two
  // told the check its own resolved file was a stray copy of itself whenever
  // the two spellings of the same path did not match byte-for-byte.
  it('does not report shellProfilePath as a stray copy of itself when its spelling differs by separator', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    // path.join(homeDir, '.profile') is native-separated; this override names
    // the same file with forward slashes throughout, which on a POSIX host is
    // already identical and on Windows is the exact shape the review reported.
    teamConfig.sharing.env.shellProfilePath = path.join(homeDir, '.profile').split(path.sep).join('/');
    const profileShPosix = envShPath.split(path.sep).join('/');
    await fse.writeFile(
      path.join(homeDir, '.profile'),
      `# [teamai:env:start]\n# DO NOT EDIT\n[ -f '${profileShPosix}' ] && source '${profileShPosix}'\n# [teamai:env:end]\n`,
    );

    expect(await (await envCheck()).check()).toBe(true);
    expect(await (await staleBlockCheck()).check()).toBe(true);
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

  it('does not report a variable this directory is scoped out of as undelivered', async () => {
    // The false failure #668 would otherwise introduce: pull correctly withholds
    // BILLING_URL from a checkout directory, and doctor must not call that a
    // delivery problem.
    await writeEnvYaml(
      'variables:\n'
      + '  - key: CHECKOUT_URL\n    value: "c"\n    projects: [checkout]\n'
      + '  - key: BILLING_URL\n    value: "b"\n    projects: [billing]\n',
    );
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh("export CHECKOUT_URL='c'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('still reports a scoped-in variable that is missing from env.sh', async () => {
    await writeEnvYaml(
      'variables:\n'
      + '  - key: CHECKOUT_URL\n    value: "c"\n    projects: [checkout]\n'
      + '  - key: BILLING_URL\n    value: "b"\n    projects: [billing]\n',
    );
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh('');
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('CHECKOUT_URL');
    expect(check.fix).not.toContain('BILLING_URL');
  });

  it('passes when every declared variable is scoped away from this directory', async () => {
    await writeEnvYaml('variables:\n  - key: BILLING_URL\n    value: "b"\n    projects: [billing]\n');
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh('');
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    expect(await (await envCheck()).check()).toBe(true);
  });

  // PR #700 review: after `teamai projects set`, the previous project's secrets
  // sit in env.sh until the next pull rewrites it. A member scoped out of every
  // variable must not get a pass while env.sh still exports the old ones.
  it('reports a withheld variable that env.sh still exports when nothing is deliverable', async () => {
    await writeEnvYaml('variables:\n  - key: BILLING_URL\n    value: "b"\n    projects: [billing]\n');
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh("export BILLING_URL='b'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('BILLING_URL');
    expect(check.fix).toContain('no longer delivers');
    expect(check.fix).not.toContain("'b'");
  });

  it('reports a withheld variable left in env.sh beside the delivered ones', async () => {
    await writeEnvYaml(
      'variables:\n'
      + '  - key: CHECKOUT_URL\n    value: "c"\n    projects: [checkout]\n'
      + '  - key: BILLING_URL\n    value: "b"\n    projects: [billing]\n',
    );
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh("export CHECKOUT_URL='c'\nexport BILLING_URL='b'\n");
    await writeProfile(`[ -f ${envShPath} ] && source ${envShPath}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('BILLING_URL');
    expect(check.fix).not.toContain('CHECKOUT_URL');
  });

  it('passes when every variable is scoped away and env.sh was never written', async () => {
    await writeEnvYaml('variables:\n  - key: BILLING_URL\n    value: "b"\n    projects: [billing]\n');
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });

    expect(await (await envCheck()).check()).toBe(true);
  });
});

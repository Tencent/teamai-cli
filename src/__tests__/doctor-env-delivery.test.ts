import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  isSilent: () => false,
  setSilent: vi.fn(),
}));

// The loader shells on PATH; by default none besides $SHELL, so only $SHELL's startup files are owed the block.
const installedShells = new Set<string>();
vi.mock('../utils/lookpath.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/lookpath.js')>();
  return {
    ...actual,
    isOnPath: (bin: string, options?: Parameters<typeof actual.isOnPath>[1]) =>
      bin === 'zsh' || bin === 'bash' ? installedShells.has(bin) : actual.isOnPath(bin, options),
  };
});

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, doctor, resolveDoctorContext, type Check, type DoctorReport } from '../doctor.js';
import { EnvHandler } from '../resources/env.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';
import { getTeamSecretsPath, writeSecretStore } from '../secret-store.js';

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

  /**
   * Env files in two project namespaces, `checkout` and `billing` (#707): the
   * way a variable reaches one directory and not another now.
   */
  async function writeProjectEnv(files: { checkout?: string; billing?: string }): Promise<void> {
    // Nothing shared, so only the namespaces decide what this directory gets.
    await writeEnvYaml('variables: []\n');
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: checkout',
      '    resources: { env: [checkout] }',
      '  - id: billing',
      '    resources: { env: [billing] }',
      '',
    ].join('\n'));
    for (const [namespace, body] of Object.entries(files)) {
      await fse.outputFile(path.join(repoPath, 'env', namespace, 'env.yaml'), body);
    }
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

  /** The loader every scope's block sources (#1018), in the form the generator writes it. */
  const loaderPath = (): string => path.join(process.env.HOME ?? '', '.teamai', 'env-loader.sh').split(path.sep).join('/');
  const loaderLine = (): string => `[ -f '${loaderPath()}' ] && . '${loaderPath()}'`;

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
    // A login bash reads .bashrc through it.
    await fse.writeFile(path.join(homeDir, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n');

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

  const originalCwd = process.cwd();

  afterEach(async () => {
    process.chdir(originalCwd);
    installedShells.clear();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when the block loads an env.sh carrying every declared variable', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    await writeProfile(loaderLine());

    expect(await (await envCheck()).check()).toBe(true);
  });

  // Skipped on Windows, where the data home below is a real absolute path.
  // Skipped on Windows, where the home below is a real absolute path.
  it.skipIf(process.platform === 'win32')('fails when the block points at a path a POSIX shell cannot read (#661)', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    teamConfig.sharing.env.shellProfilePath = profilePath;
    process.chdir(tempDir);
    vi.stubEnv('HOME', 'D:\\Users\\me');
    const windowsLoader = path.join('D:\\Users\\me', '.teamai', 'env-loader.sh');
    // Raw and unquoted, as a pre-#661 CLI wrote a path.
    await writeProfile(`[ -f ${windowsLoader} ] && . ${windowsLoader}`);

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('does not load');
    expect(check.fix).toContain(windowsLoader);
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
    // The loader block, as the generator writes it: delivery stays healthy.
    await fse.writeFile(
      path.join(homeDir, '.profile'),
      `# [teamai:env:start]\n# DO NOT EDIT\n${loaderLine()}\n# [teamai:env:end]\n`,
    );
    // An interactive bash reads .bashrc whatever the override names, so it
    // is owed the loader block too.
    await fse.writeFile(
      path.join(homeDir, '.bashrc'),
      `# [teamai:env:start]\n# DO NOT EDIT\n${loaderLine()}\n# [teamai:env:end]\n`,
    );
    // A legacy block for the SAME env.sh, left behind in .bash_login — raw and
    // unquoted (the current generator always quotes via shellQuoteValue, so
    // an unquoted block is necessarily from an older write path). Windows-
    // specific legacy spellings (backslash, MSYS drive form) are covered
    // directly in shell-profile.test.ts's envBlockReferencesDataHome suite,
    // with explicit Windows-shaped test data rather than a host-dependent
    // string transform of this test's own (POSIX-on-CI) envShPath.
    await fse.writeFile(
      path.join(homeDir, '.bash_login'),
      `# my bash_login\n# [teamai:env:start]\n# DO NOT EDIT\n[ -f ${envShPath} ] && source ${envShPath}\n# [teamai:env:end]\n`,
    );

    // Delivery itself is healthy — a stray leftover must not report as a
    // delivery failure (#693 review round 5).
    expect(await (await envCheck()).check()).toBe(true);

    const stale = await staleBlockCheck();
    expect(await stale.check()).toBe(false);
    expect(stale.fix).toContain('.bash_login');
    expect(stale.fix).toContain('teamai uninstall');
  });

  // #1018: `zsh -c` reads .zshenv only, so for a zsh member the block counts
  // there, whatever shellProfilePath names.
  it.each([
    { blockIn: '.zshrc', passes: false },
    { blockIn: '.zshenv', passes: true },
  ])('for a zsh member whose team sets shellProfilePath to ~/.zshrc, passes only with the block in ~/$blockIn', async ({ blockIn, passes }) => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('ZDOTDIR', '');
    await fse.remove(path.join(homeDir, '.bash_profile'));
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    teamConfig.sharing.env.shellProfilePath = '~/.zshrc';
    profilePath = path.join(homeDir, blockIn);
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(passes);
    if (!passes) expect(check.fix).toContain(path.join(homeDir, '.zshenv'));
  });

  // A zsh member with a ~/.bashrc: pull puts the loader block in both, so
  // each is owed one, and neither counts as a stray copy.
  it.each([
    { blockInBashrc: true, passes: true },
    { blockInBashrc: false, passes: false },
  ])('for a zsh member with a ~/.bashrc, passes only with the block in both (block in .bashrc: $blockInBashrc)', async ({ blockInBashrc, passes }) => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('ZDOTDIR', '');
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    profilePath = path.join(homeDir, '.zshenv');
    await writeProfile(loaderLine());
    profilePath = path.join(homeDir, '.bashrc');
    if (blockInBashrc) await writeProfile(loaderLine());
    else await fse.writeFile(profilePath, '# my bashrc\n');

    const check = await envCheck();
    expect(await check.check()).toBe(passes);
    if (!passes) expect(check.fix).toContain(path.join(homeDir, '.bashrc'));
    expect(await (await staleBlockCheck()).check()).toBe(true);
  });

  // A login bash reads .bash_profile, not .bashrc, unless the first sources
  // the second: pull then owes the block in .bash_profile too.
  it.each([
    { sourcesBashrc: false, blockInBashProfile: true, passes: true },
    { sourcesBashrc: false, blockInBashProfile: false, passes: false },
    { sourcesBashrc: true, blockInBashProfile: false, passes: true },
  ])('for a zsh member with a ~/.bash_profile (sources .bashrc: $sourcesBashrc, block in it: $blockInBashProfile), passes: $passes', async ({ sourcesBashrc, blockInBashProfile, passes }) => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('ZDOTDIR', '');
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    for (const name of ['.zshenv', '.bashrc']) {
      profilePath = path.join(homeDir, name);
      await writeProfile(loaderLine());
    }
    profilePath = path.join(homeDir, '.bash_profile');
    if (blockInBashProfile) await writeProfile(loaderLine());
    else await fse.writeFile(profilePath, sourcesBashrc ? '. ~/.bashrc\n' : '# my bash_profile\n');

    const check = await envCheck();
    expect(await check.check()).toBe(passes);
    if (!passes) expect(check.fix).toContain(path.join(homeDir, '.bash_profile'));
    expect(await (await staleBlockCheck()).check()).toBe(true);
  });

  // A zsh member with bash installed and none of its startup files: pull
  // creates .bashrc and .profile, so each is owed the block, and neither
  // counts as a stray copy.
  it.each([
    { blockIn: ['.zshenv', '.bashrc', '.profile'], missing: [] },
    { blockIn: ['.zshenv'], missing: ['.bashrc', '.profile'] },
  ])('for a zsh member with bash installed and no bash startup file, owes the block in .bashrc and .profile (block in $blockIn)', async ({ blockIn, missing }) => {
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('ZDOTDIR', '');
    installedShells.add('bash');
    await fse.remove(path.join(homeDir, '.bash_profile'));
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    for (const name of blockIn) {
      profilePath = path.join(homeDir, name);
      await writeProfile(loaderLine());
    }

    const check = await envCheck();
    expect(await check.check()).toBe(missing.length === 0);
    for (const name of missing) expect(check.fix).toContain(path.join(homeDir, name));
    expect(await (await staleBlockCheck()).check()).toBe(true);
  });

  // Regression (#693 review round 4): an unexpanded `~/...` override made
  // the stray-block scan compare a literal `~/.profile` string against its
  // own always-absolute candidate paths, so the resolved file never matched
  // itself and got reported as a stray copy of its own valid block.
  it('does not report shellProfilePath\'s own file as a stray copy of itself', async () => {
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    teamConfig.sharing.env.shellProfilePath = '~/.profile';
    // An interactive bash reads .bashrc whatever the override names.
    profilePath = path.join(homeDir, '.bashrc');
    await writeProfile(loaderLine());
    await fse.writeFile(
      path.join(homeDir, '.profile'),
      `# [teamai:env:start]\n# DO NOT EDIT\n${loaderLine()}\n# [teamai:env:end]\n`,
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
    // An interactive bash reads .bashrc whatever the override names.
    profilePath = path.join(homeDir, '.bashrc');
    await writeProfile(loaderLine());
    await fse.writeFile(
      path.join(homeDir, '.profile'),
      `# [teamai:env:start]\n# DO NOT EDIT\n${loaderLine()}\n# [teamai:env:end]\n`,
    );

    expect(await (await envCheck()).check()).toBe(true);
    expect(await (await staleBlockCheck()).check()).toBe(true);
  });

  it('fails and names `variables:` for the shorthand env.yaml form (#662)', async () => {
    await writeEnvYaml('JIRA_PASSWORD: "s3cret"\n');
    await writeEnvSh('');
    await writeProfile(loaderLine());

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
    await writeProfile(loaderLine());

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('still reports a multiline value that drifted from env.yaml', async () => {
    await writeEnvYaml('variables:\n  - key: TEAM_KEY\n    value: |\n      line one\n      line two\n');
    await writeEnvSh("export TEAM_KEY='line one\nsomething else\n'\n");
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('stale value');
  });

  it('passes for a value carrying a single quote, which the generator escapes', async () => {
    await writeEnvYaml("variables:\n  - key: TEAM_KEY\n    value: \"it's here\"\n");
    await writeEnvSh("export TEAM_KEY='it'\\''s here'\n");
    await writeProfile(loaderLine());

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
    // Named as it is in the team repo, where it has to be fixed.
    expect(check.fix).toContain('env/env.yaml is not valid YAML');
  });

  it('fails when env.sh still exports the value env.yaml replaced', async () => {
    await writeEnvSh("export JIRA_PASSWORD='rotated-away'\n");
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('JIRA_PASSWORD');
    expect(check.fix).toContain('stale value');
    // The value is a secret: naming the key is the whole diagnosis.
    expect(check.fix).not.toContain('s3cret');
    expect(check.fix).not.toContain('rotated-away');
  });

  // On Windows `jira_password` is the same environment variable: a declaration
  // whose spelling changed is still delivered, until the next pull respells it.
  it.each([
    { platform: 'linux', delivered: false },
    { platform: 'win32', delivered: true },
  ] as const)('on $platform, takes an env.sh export in another case of a declared name as delivered: $delivered', async ({ platform, delivered }) => {
    await writeEnvSh("export jira_password='s3cret'\n");
    await writeProfile(loaderLine());
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    try {
      const check = await envCheck();
      const passed = await check.check();
      const fix = passed ? '' : check.fix ?? '';
      // Not missing JIRA_PASSWORD, and not still exporting jira_password, on Windows; both elsewhere.
      expect(fix.includes('JIRA_PASSWORD'), fix).toBe(!delivered);
      expect(fix.includes('jira_password'), fix).toBe(!delivered);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails when a declared variable never reached env.sh', async () => {
    await writeEnvSh("export OTHER='x'\n");
    await writeProfile(loaderLine());

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

  // #1018: several projects at once, each loaded in its own directory by one
  // loader block, so doctor in one project is not failed by another's pull.
  describe.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0)('with several project scopes', () => {
    const project = async (name: string): Promise<LocalConfig> => {
      const projectRoot = fs.realpathSync(await fse.mkdtemp(path.join(tempDir, `${name}-`)));
      execFileSync('git', ['init', '-q', projectRoot]);
      return { ...localConfig, scope: 'project', projectRoot, dataHome: path.join(homeDir, '.teamai', 'projects', name) };
    };
    const checksIn = async (config: LocalConfig): Promise<Check[]> => {
      vi.mocked(loadLocalConfig).mockResolvedValue(config);
      const ctx = await resolveDoctorContext();
      if (!ctx) throw new Error('expected a resolved doctor context');
      return (await buildChecks(ctx)).filter((c) => c.name.startsWith('Env variables') || c.name === 'This directory resolves its team env');
    };
    const pull = (config: LocalConfig) =>
      new EnvHandler().writeResolvedEnv([{ key: 'JIRA_PASSWORD', value: 's3cret' }], teamConfig, config);

    it('passes in a project after another project pulled last', async () => {
      const a = await project('a');
      const b = await project('b');
      await pull(a);
      await pull(b);

      const checks = await checksIn(a);
      expect(checks.map((c) => c.name)).toEqual(['Env variables injected in shell profile', 'This directory resolves its team env']);
      for (const c of checks) expect({ name: c.name, ok: await c.check(), fix: c.fix }).toMatchObject({ ok: true });
    });

    // An inheriting project's shells load the user scope's env.sh before its own.
    it.each([
      { userEnvSh: "export USER_ONLY='u'\n", projectSecret: false, keep: false, projectFails: false, fix: undefined },
      { userEnvSh: null, projectSecret: false, keep: false, projectFails: false, fix: 'env.sh, which this project inherits, is missing' },
      { userEnvSh: "export USER_ONLY='old'\n", projectSecret: false, keep: false, projectFails: false, fix: 'has a stale value for USER_ONLY, which this project inherits' },
      { userEnvSh: "export USER_ONLY='u'\n", projectSecret: true, keep: true, projectFails: false, fix: undefined },
      { userEnvSh: "export USER_ONLY='u'\n", projectSecret: true, keep: false, projectFails: false, fix: 'does not keep USER_ONLY from the user scope' },
      // A key the user scope no longer delivers reaches this project's shells, and env exec and MCP leave it out.
      { userEnvSh: "export USER_ONLY='u'\nexport OLD='x'\n", projectSecret: false, keep: false, projectFails: false, fix: 'still exports OLD, which the user scope no longer delivers' },
      { userEnvSh: "export USER_ONLY='u'\nexport OLD='x'\n", projectSecret: true, keep: true, projectFails: false, fix: 'still exports OLD, which the user scope no longer delivers' },
      // The user scope's part is diagnosed on its own while the project's declarations fail.
      { userEnvSh: null, projectSecret: false, keep: false, projectFails: true, fix: 'env.sh, which this project inherits, is missing' },
      { userEnvSh: "export USER_ONLY='old'\n", projectSecret: false, keep: false, projectFails: true, fix: 'has a stale value for USER_ONLY, which this project inherits' },
      // The inherited env still needs the profile block to reach shells.
      { userEnvSh: "export USER_ONLY='u'\n", projectSecret: false, keep: false, projectFails: true, noBlock: true, fix: 'carries no TeamAI env block' },
      // While the user scope's declarations fail, its pull keeps the env.sh it wrote, and shells still load
      // it; the failure is reported, as env exec and MCP report it.
      { userEnvSh: "export USER_ONLY='u'\n", projectSecret: false, keep: false, projectFails: false, userFails: true, fix: '[user] ' },
      { userEnvSh: null, projectSecret: false, keep: false, projectFails: false, userFails: true, fix: 'env.sh, which this project inherits, is missing' },
    ] as { userEnvSh: string | null; projectSecret: boolean; keep: boolean; projectFails: boolean; userFails?: boolean; noBlock?: boolean; fix: string | undefined }[])('checks inherited user env (user env.sh $userEnvSh, project secret $projectSecret, kept $keep, project fails $projectFails, user fails $userFails, no profile block $noBlock)', async ({ userEnvSh, projectSecret, keep, projectFails, userFails, noBlock, fix }) => {
      const userRepo = path.join(tempDir, 'user-repo');
      await fse.outputFile(path.join(userRepo, 'env', 'env.yaml'), 'variables:\n  - key: USER_ONLY\n    value: u\n');
      await fse.outputFile(path.join(homeDir, '.teamai', 'config.yaml'), `repo:\n  localPath: ${userRepo}\n  remote: owner/user\nusername: tester\nscope: user\n`);
      await writeEnvYaml('variables: []\n');
      if (projectSecret) await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: USER_ONLY\n');
      const a = { ...await project('inherits'), inheritUserScope: true };
      await new EnvHandler().writeResolvedEnv([], teamConfig, a, keep ? ['USER_ONLY'] : []);
      if (projectSecret && !keep) await fse.outputFile(path.join(a.dataHome ?? '', 'env.sh'), '\n');
      if (userEnvSh === null) await fse.remove(envShPath);
      else await writeEnvSh(userEnvSh);
      if (projectFails) await writeEnvYaml('variables:\n  - key: A\n   value: bad indent\n');
      if (userFails) {
        // What the user scope's last pull wrote, before its env.yaml broke.
        await fse.outputFile(path.join(homeDir, '.teamai', 'env'), '{ "USER_ONLY": "u" }\n');
        await fse.outputFile(path.join(userRepo, 'env', 'env.yaml'), 'variables:\n  - key: USER_ONLY\n   value: bad indent\n');
      }
      if (noBlock) for (const name of ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zshenv']) await fse.remove(path.join(homeDir, name));

      const check = (await checksIn(a))[0];
      expect({ ok: await check.check(), fix: fix === undefined ? undefined : check.fix }).toEqual(
        fix === undefined ? { ok: true, fix: undefined } : { ok: false, fix: expect.stringContaining(fix) },
      );
      if (projectFails) expect(check.fix).toContain('env/env.yaml is not valid YAML');
      if (userFails && fix !== undefined) expect(check.fix).toContain('[user] ');
    });

    it("passes a project that does not inherit the user scope, whatever the user scope's env.sh exports", async () => {
      const userRepo = path.join(tempDir, 'user-repo');
      await fse.outputFile(path.join(userRepo, 'env', 'env.yaml'), 'variables:\n  - key: USER_ONLY\n    value: u\n');
      await fse.outputFile(path.join(userRepo, 'teamai.yaml'), 'team: user\nrepo: owner/user\nprovider: git\nsharing:\n  env:\n    injectShellProfile: true\n');
      await fse.outputFile(path.join(homeDir, '.teamai', 'config.yaml'), `repo:\n  localPath: ${userRepo}\n  remote: owner/user\nusername: tester\nscope: user\n`);
      await writeEnvYaml('variables:\n  - key: JIRA_PASSWORD\n    value: s3cret\n');
      const a = await project('own');
      await pull(a);
      await writeEnvSh("export USER_ONLY='u'\n");

      expect(await (await checksIn(a))[0].check()).toBe(true);
    });

    it("fails an inheriting project with no env.sh of its own while the user scope's env.sh exports a key it no longer delivers", async () => {
      const userRepo = path.join(tempDir, 'user-repo');
      await fse.outputFile(path.join(userRepo, 'env', 'env.yaml'), 'variables: []\n');
      await fse.outputFile(path.join(homeDir, '.teamai', 'config.yaml'), `repo:\n  localPath: ${userRepo}\n  remote: owner/user\nusername: tester\nscope: user\n`);
      await writeEnvYaml('variables: []\n');
      const a = { ...await project('bare'), inheritUserScope: true };
      await new EnvHandler().writeResolvedEnv([], teamConfig, a);
      await fse.remove(path.join(a.dataHome ?? '', 'env.sh'));
      await writeEnvSh("export OLD='x'\n");

      const check = (await checksIn(a))[0];
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain('still exports OLD, which the user scope no longer delivers');
    });

    it('fails in a project whose scope a pull has not registered yet, and says to pull there', async () => {
      const a = await project('a');
      await pull(a);
      await fse.remove(path.join(homeDir, '.teamai', 'env-scopes'));

      const directory = (await checksIn(a))[1];
      expect(await directory.check()).toBe(false);
      expect(directory.fix).toContain(`instead of ${path.join(a.dataHome ?? '', 'env.sh')}`);
      expect(directory.fix).toContain('Run `teamai pull` here');
    });

    it('passes for a shell that runs no loader, and names the gap in a note', async () => {
      const a = await project('a');
      await pull(a);
      vi.stubEnv('SHELL', '/usr/local/bin/fish');

      const directory = (await checksIn(a))[1];
      expect(await directory.check()).toBe(true);
      const printed: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
      try {
        await doctor({ json: true });
      } finally {
        spy.mockRestore();
      }
      const report = JSON.parse(printed.find((line) => line.trimStart().startsWith('{')) ?? '{}') as DoctorReport;
      expect(report.notes?.join('\n')).toContain('fish');
      expect(report.notes?.join('\n')).toContain('teamai env exec');
    });

    // The note follows what a loader shell would load here, inherited user env included.
    it.each([
      { delivers: 'its own env.sh', own: true, inherits: false, userEnvSh: false, noted: true },
      { delivers: 'only the user scope\'s env.sh it inherits', own: false, inherits: true, userEnvSh: true, noted: true },
      { delivers: 'nothing, the user scope\'s env.sh not inherited', own: false, inherits: false, userEnvSh: true, noted: false },
      { delivers: 'nothing', own: false, inherits: true, userEnvSh: false, noted: false },
    ])('notes a shell that runs no loader in a project that delivers $delivers: $noted', async ({ own, inherits, userEnvSh, noted }) => {
      const { envLoaderNotes } = await import('../doctor-delivery.js');
      const a = { ...await project('noted'), inheritUserScope: inherits };
      await new EnvHandler().writeResolvedEnv(own ? [{ key: 'JIRA_PASSWORD', value: 's3cret' }] : [], teamConfig, a);
      if (userEnvSh) {
        const userRepo = path.join(tempDir, 'user-repo');
        await fse.outputFile(path.join(userRepo, 'env', 'env.yaml'), 'variables:\n  - key: USER_ONLY\n    value: u\n');
        await new EnvHandler().writeResolvedEnv([{ key: 'USER_ONLY', value: 'u' }], teamConfig, {
          ...localConfig,
          repo: { localPath: userRepo, remote: 'owner/user' },
          scope: 'user',
        });
      }
      vi.stubEnv('SHELL', '/usr/local/bin/fish');
      vi.mocked(loadLocalConfig).mockResolvedValue(a);
      const ctx = await resolveDoctorContext();
      if (!ctx) throw new Error('expected a resolved doctor context');

      expect((await envLoaderNotes(ctx)).length).toBe(noted ? 1 : 0);
    });

    it('reports a shell that cannot start as that, not as a project to pull', async () => {
      const a = await project('a');
      await pull(a);
      vi.stubEnv('SHELL', path.join(tempDir, 'missing', 'zsh'));

      const directory = (await checksIn(a))[1];
      expect(await directory.check()).toBe(false);
      expect(directory.fix).toContain(`Could not run ${path.join(tempDir, 'missing', 'zsh')}`);
      expect(directory.fix).not.toContain('teamai pull');
    });
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
    await writeProfile(`[ -f "${loaderPath()}" ] && . "${loaderPath()}"`);

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('does not report a variable of an inactive namespace as undelivered', async () => {
    // Pull correctly withholds BILLING_URL from a checkout directory, and
    // doctor must not call that a delivery problem.
    await writeProjectEnv({
      checkout: 'variables:\n  - key: CHECKOUT_URL\n    value: "c"\n',
      billing: 'variables:\n  - key: BILLING_URL\n    value: "b"\n',
    });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh("export CHECKOUT_URL='c'\n");
    await writeProfile(loaderLine());

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('still reports an active namespace variable that is missing from env.sh', async () => {
    await writeProjectEnv({
      checkout: 'variables:\n  - key: CHECKOUT_URL\n    value: "c"\n',
      billing: 'variables:\n  - key: BILLING_URL\n    value: "b"\n',
    });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh('');
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('CHECKOUT_URL');
    expect(check.fix).not.toContain('BILLING_URL');
  });

  it('passes when every declared variable is in an inactive namespace', async () => {
    await writeProjectEnv({ billing: 'variables:\n  - key: BILLING_URL\n    value: "b"\n' });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh('');
    await writeProfile(loaderLine());

    expect(await (await envCheck()).check()).toBe(true);
  });

  // PR #700 review: after `teamai projects set`, the previous project's secrets
  // sit in env.sh until the next pull rewrites it. A member with nothing to
  // receive must not get a pass while env.sh still exports the old ones.
  it('reports a variable of a deactivated namespace that env.sh still exports when nothing is deliverable', async () => {
    await writeProjectEnv({ billing: 'variables:\n  - key: BILLING_URL\n    value: "b"\n' });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh("export BILLING_URL='b'\n");
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('BILLING_URL');
    expect(check.fix).toContain('no longer delivers');
    expect(check.fix).not.toContain("'b'");
  });

  it('reports a variable of a deactivated namespace left in env.sh beside the delivered ones', async () => {
    await writeProjectEnv({
      checkout: 'variables:\n  - key: CHECKOUT_URL\n    value: "c"\n',
      billing: 'variables:\n  - key: BILLING_URL\n    value: "b"\n',
    });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });
    await writeEnvSh("export CHECKOUT_URL='c'\nexport BILLING_URL='b'\n");
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('BILLING_URL');
    expect(check.fix).not.toContain('CHECKOUT_URL');
  });

  it('passes when every variable is in an inactive namespace and env.sh was never written', async () => {
    await writeProjectEnv({ billing: 'variables:\n  - key: BILLING_URL\n    value: "b"\n' });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout'] });

    expect(await (await envCheck()).check()).toBe(true);
  });

  it('reports two active namespaces that define the same key, naming both files', async () => {
    await writeProjectEnv({
      checkout: 'variables:\n  - key: API_BASE\n    value: "c"\n',
      billing: 'variables:\n  - key: API_BASE\n    value: "b"\n',
    });
    vi.mocked(loadLocalConfig).mockResolvedValue({ ...localConfig, projects: ['checkout', 'billing'] });

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('variable "API_BASE" is defined in both env/checkout/env.yaml and env/billing/env.yaml');
  });

  // #875 (#879 Conflict 13): pull leaves the env.yaml value of a key declared as a secret out of env.sh.
  it('does not owe env.sh a key the team also declares as a secret, and reports one it still exports', async () => {
    await writeEnvYaml('variables:\n  - key: JIRA_PASSWORD\n    value: "s3cret"\n  - key: API_URL\n    value: "u"\n');
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: JIRA_PASSWORD\n');
    await writeProfile(loaderLine());

    await writeEnvSh("export API_URL='u'\n");
    expect(await (await envCheck()).check()).toBe(true);

    await writeEnvSh("export API_URL='u'\nexport JIRA_PASSWORD='s3cret'\n");
    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('still exports JIRA_PASSWORD');
  });

  // #875 (#879 S9): pull writes the member's value for this team, and leaves a --from-env one out.
  it("expects the member's value for a variable in env.sh, and no --from-env one", async () => {
    await writeEnvYaml('variables:\n  - key: GITLAB_HOST\n    value: "gitlab.team.example"\n  - key: API_URL\n    value: "u"\n');
    await writeProfile(loaderLine());
    await writeSecretStore(getTeamSecretsPath(localConfig), { GITLAB_HOST: { value: 'gitlab.mine.example', kind: 'variable' }, API_URL: { env: 'MY_API_URL', kind: 'variable' } });

    await writeEnvSh("export GITLAB_HOST='gitlab.mine.example'\n");
    expect(await (await envCheck()).check()).toBe(true);

    await writeEnvSh("export GITLAB_HOST='gitlab.team.example'\nexport API_URL='u'\n");
    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('has a stale value for GITLAB_HOST');
    expect(check.fix).toContain('still exports API_URL');
  });

  // #879 Conflict 14: a failed declaration keeps env.sh as it is, so it cannot be checked against env.yaml.
  it('names the secrets file when the declarations cannot be read', async () => {
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [\n');
    await writeEnvSh("export JIRA_PASSWORD='s3cret'\n");
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('env/secrets.yaml is not valid YAML');
  });

  // Shells keep loading the env.sh the last pull wrote, so it is still owed.
  it('reports the env.sh the last pull wrote as missing while the declarations cannot be read', async () => {
    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: [\n');
    await fse.outputFile(path.join(homeDir, '.teamai', 'env'), '{ "JIRA_PASSWORD": "s3cret" }\n');
    await writeProfile(loaderLine());

    const check = await envCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain(`${envShPath} is missing`);
  });
});

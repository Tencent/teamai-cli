import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { envExec, exitLike, inTerminalForeground } from '../env-exec.js';
import { EnvHandler } from '../resources/env.js';
import { envLoaderPath } from '../resources/env-loader.js';
import { envShMarker } from '../env-sh-exports.js';
import { getMachineSecretsPath, getTeamSecretsPath, writeSecretStore, type SecretStore } from '../secret-store.js';
import { resolveAnchors } from '../utils/git.js';
import { _resetState, _setLogFilePath, setStderrOnly } from '../utils/logger.js';
import { projectDataHome } from '../utils/partition.js';
import { getDataHome, type LocalConfig, type TeamaiConfig } from '../types.js';

/**
 * `teamai env exec -- <command>` (#875, #879 S8): the command runs with the
 * inherited environment overlaid with this directory's team env variables and
 * its secrets in the resolution order. Everything teamai prints goes to stderr.
 */
describe('teamai env exec', () => {
  let tmpDir: string;
  let home: string;
  let out: string;
  let stdout: string[];
  let stderr: string[];

  const GITHUB_SECRET = 'secrets:\n  - key: GITHUB_TOKEN\n    url: https://github.com/settings/tokens\n';
  const GITHUB_LINE = 'GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (https://github.com/settings/tokens).';
  // Writes the child's environment to a file: the child's own stdout is the
  // terminal the test runs in.
  const DUMP = 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))';

  const git = (cwd: string, ...args: string[]): void => { execFileSync('git', args, { cwd, stdio: 'pipe' }); };
  const text = (lines: string[]): string => lines.join('\n');

  /** A team repo clone with these files, and a config for it. */
  async function team(name: string, files: Record<string, string>): Promise<{ repoPath: string }> {
    const repoPath = path.join(tmpDir, `${name}-repo`);
    await fse.outputFile(path.join(repoPath, 'teamai.yaml'), `team: ${name}\nrepo: https://example.com/${name}.git\n`);
    for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(repoPath, file), content);
    return { repoPath };
  }

  async function userScope(repoPath: string, extra: Partial<LocalConfig> = {}): Promise<LocalConfig> {
    const config: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/user.git' }, username: 't', scope: 'user', additionalRoles: [], ...extra,
    };
    await fse.outputFile(path.join(home, '.teamai', 'config.yaml'), YAML.stringify(config));
    return config;
  }

  /** A git project with a linked worktree, set up as a teamai project in its partition. */
  async function project(repoPath: string): Promise<{ root: string; worktree: string; config: LocalConfig; partition: string }> {
    const root = path.join(tmpDir, 'api');
    await fse.ensureDir(root);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'config', 'user.name', 't');
    git(root, 'commit', '--allow-empty', '-q', '-m', 'init');
    const worktree = path.join(tmpDir, 'api-feature');
    git(root, 'worktree', 'add', '-q', worktree, 'HEAD');
    const anchors = await resolveAnchors(root);
    if (!anchors) throw new Error('no git anchors for the fixture project');
    const partition = projectDataHome(anchors.projectAnchor);
    const config: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/work.git' }, username: 't', scope: 'project',
      projectRoot: root, additionalRoles: [],
    };
    await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(config));
    return { root, worktree, config, partition };
  }

  async function exec(cwd: string, script = DUMP, args: string[] = [out]): ReturnType<typeof envExec> {
    return envExec(['--', process.execPath, '-e', script, ...args], {}, cwd);
  }

  async function childEnv(cwd: string): Promise<Record<string, string>> {
    const outcome = await exec(cwd);
    expect(outcome).toEqual({ kind: 'exited', code: 0 });
    return JSON.parse(await fse.readFile(out, 'utf8')) as Record<string, string>;
  }

  it('restores the member BASH_ENV when removing the loader from the child environment', async () => {
    const memberBashEnv = path.join(home, '.bash_env');
    vi.stubEnv('BASH_ENV', envLoaderPath());
    vi.stubEnv('__TEAMAI_ENV_BASH_ENV', memberBashEnv);

    const env = await childEnv(home);

    expect(env.BASH_ENV).toBe(memberBashEnv);
    expect(env.__TEAMAI_ENV_BASH_ENV).toBeUndefined();
  });

  // A bash the command starts sources the member's BASH_ENV after teamai set
  // the team env: the team value still wins a key both set (sharing.md).
  it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0).each([
    { via: 'the member', loader: false },
    { via: 'the env loader', loader: true },
  ])("gives a bash the command starts the team values over those a BASH_ENV set through $via sets, removes a missing secret, and keeps the member's own for the rest", async ({ loader }) => {
    const { repoPath } = await team('personal', {
      'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n',
      'env/secrets.yaml': `${GITHUB_SECRET}  - key: NPM_TOKEN\n`,
    });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { value: 'fixture-team' } });
    const memberBashEnv = path.join(home, '.bash_env');
    await fse.writeFile(memberBashEnv, 'export API_URL=member GITHUB_TOKEN=member NPM_TOKEN=member MEMBER_ONLY=member\n');
    if (loader) {
      vi.stubEnv('BASH_ENV', envLoaderPath());
      vi.stubEnv('__TEAMAI_ENV_BASH_ENV', memberBashEnv);
    } else {
      vi.stubEnv('BASH_ENV', memberBashEnv);
    }

    const outcome = await envExec(['--', 'bash', '-c', 'printf "%s|%s|%s|%s" "$API_URL" "$GITHUB_TOKEN" "$NPM_TOKEN" "$MEMBER_ONLY" > "$0"; bash -c \'printf "|%s|%s" "$API_URL" "$GITHUB_TOKEN" >> "$0"\' "$0"', out], {}, home);

    expect(outcome).toEqual({ kind: 'exited', code: 0 });
    expect(await fse.readFile(out, 'utf8')).toBe('https://team.example|fixture-team||member|https://team.example|fixture-team');
  });

  // An integer attribute the member's BASH_ENV gives a team key would evaluate the team value.
  it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0).each([
    { via: 'the member', loader: false },
    { via: 'the env loader', loader: true },
  ])("gives a bash the command starts the team value as written when the BASH_ENV $via chains declares the key an integer", async ({ loader }) => {
    const { repoPath } = await team('personal', { 'env/env.yaml': "variables:\n  - key: TOKEN\n    value: '1+1'\n" });
    await userScope(repoPath);
    const memberBashEnv = path.join(home, '.bash_env');
    await fse.writeFile(memberBashEnv, 'declare -ix TOKEN=3\n');
    if (loader) {
      vi.stubEnv('BASH_ENV', envLoaderPath());
      vi.stubEnv('__TEAMAI_ENV_BASH_ENV', memberBashEnv);
    } else {
      vi.stubEnv('BASH_ENV', memberBashEnv);
    }

    const outcome = await envExec(['--', 'bash', '-c', 'printf "%s|%s" "$TOKEN" "$(printenv TOKEN)" > "$0"; bash -c \'printf "|%s" "$TOKEN" >> "$0"\' "$0"', out], {}, home);

    expect(outcome).toEqual({ kind: 'exited', code: 0 });
    expect(await fse.readFile(out, 'utf8')).toBe('1+1|1+1|1+1');
  });

  it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0).each([
    { via: 'the member', loader: false },
    { via: 'the env loader', loader: true },
  ])("keeps the team values in a nested bash when the BASH_ENV $via chains points BASH_ENV elsewhere", async ({ loader }) => {
    const { repoPath } = await team('personal', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n' });
    await userScope(repoPath);
    const nextBashEnv = path.join(home, '.bash_env_next');
    await fse.writeFile(nextBashEnv, 'export API_URL=next NEXT_ONLY=next\n');
    const memberBashEnv = path.join(home, '.bash_env');
    await fse.writeFile(memberBashEnv, `export API_URL=member BASH_ENV='${nextBashEnv}'\n`);
    if (loader) {
      vi.stubEnv('BASH_ENV', envLoaderPath());
      vi.stubEnv('__TEAMAI_ENV_BASH_ENV', memberBashEnv);
    } else {
      vi.stubEnv('BASH_ENV', memberBashEnv);
    }

    const outcome = await envExec(['--', 'bash', '-c', 'printf "%s" "$API_URL" > "$0"; bash -c \'printf "|%s|%s" "$API_URL" "$NEXT_ONLY" >> "$0"\' "$0"', out], {}, home);

    expect(outcome).toEqual({ kind: 'exited', code: 0 });
    expect(await fse.readFile(out, 'utf8')).toBe('https://team.example|https://team.example|next');
  });

  // While the member's file runs, BASH_ENV names it, so it can find files beside it.
  it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0).each([
    { via: 'the member', loader: false },
    { via: 'the env loader', loader: true },
  ])("gives the BASH_ENV $via chains its own path while it runs, in a bash the command starts and a nested one", async ({ loader }) => {
    const { repoPath } = await team('personal', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n' });
    await userScope(repoPath);
    const memberBashEnv = path.join(home, 'member-bash-env', 'bash_env');
    await fse.outputFile(path.join(home, 'member-bash-env', 'companion.sh'), 'export COMPANION=1\n');
    // bash 3.2 (macOS) sets $0 only after it sources BASH_ENV, so the file names the output itself.
    await fse.outputFile(memberBashEnv, `printf "during:%s|" "$BASH_ENV" >> '${out}'\n. "$(dirname "$BASH_ENV")/companion.sh"\n`);
    if (loader) {
      vi.stubEnv('BASH_ENV', envLoaderPath());
      vi.stubEnv('__TEAMAI_ENV_BASH_ENV', memberBashEnv);
    } else {
      vi.stubEnv('BASH_ENV', memberBashEnv);
    }

    const outcome = await envExec(['--', 'bash', '-c', 'printf "after:%s:%s|" "$API_URL" "$COMPANION" >> "$0"; bash -c \'printf "after:%s:%s" "$API_URL" "$COMPANION" >> "$0"\' "$0"', out], {}, home);

    expect(outcome).toEqual({ kind: 'exited', code: 0 });
    expect(await fse.readFile(out, 'utf8')).toBe(`during:${memberBashEnv}|after:https://team.example:1|during:${memberBashEnv}|after:https://team.example:1`);
  });

  // On Windows `api_url` is the team's `API_URL`: the member's spelling does not stay beside it.
  it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0)("leaves on Windows only the team's spelling of a key the member's BASH_ENV sets in another", async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { repoPath } = await team('personal', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n' });
    await userScope(repoPath);
    const memberBashEnv = path.join(home, '.bash_env');
    await fse.writeFile(memberBashEnv, 'export api_url=member MEMBER_ONLY=member\n');
    vi.stubEnv('BASH_ENV', memberBashEnv);

    const outcome = await envExec(['--', 'bash', '-c', 'printf "%s|%s|%s" "${api_url-unset}" "$API_URL" "$MEMBER_ONLY" > "$0"', out], {}, home);

    expect(outcome).toEqual({ kind: 'exited', code: 0 });
    expect(await fse.readFile(out, 'utf8')).toBe('unset|https://team.example|member');
  });

  it.each(['BASH_ENV', 'ENV', 'ZDOTDIR', 'HOME', 'home', 'PROMPT_COMMAND', 'chpwd_functions', 'precmd_functions', 'preexec_functions', 'periodic_functions', 'zshaddhistory_functions', 'zshexit_functions', 'zsh_directory_name_functions', '__TEAMAI_ENV_FILES', '__teamai_env_apply', '__teamai_keys', 'IFS', 'BASH_VERSION', 'ZSH_VERSION'])('does not overlay reserved team variable %s in env exec', async (key) => {
    const { repoPath } = await team('reserved', { 'env/env.yaml': `variables:\n  - key: ${key}\n    value: team-value\n` });
    await userScope(repoPath);

    const env = await childEnv(home);

    expect(env[key]).not.toBe('team-value');
    expect(stderr.join('\n')).toContain(`${key} is reserved for TeamAI shell routing`);
  });

  it('does not pass a reserved team secret to env exec', async () => {
    const { repoPath } = await team('reserved-secret', { 'env/secrets.yaml': 'secrets:\n  - key: BASH_ENV\n' });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), { BASH_ENV: { value: 'team-value' } });

    const env = await childEnv(home);

    expect(env.BASH_ENV).not.toBe('team-value');
    expect(stderr.join('\n')).toContain('BASH_ENV is reserved for TeamAI shell routing');
  });

  beforeEach(async () => {
    tmpDir = fs.realpathSync(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-env-exec-')));
    home = path.join(tmpDir, 'home');
    out = path.join(tmpDir, 'child-env.json');
    await fse.ensureDir(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    for (const key of ['GITHUB_TOKEN', 'API_URL', 'WORK_GITHUB_TOKEN']) vi.stubEnv(key, undefined);
    _setLogFilePath(path.join(home, '.teamai', 'debug.log'));
    stdout = [];
    stderr = [];
    const record = (sink: string[]) => (...parts: unknown[]) => { sink.push(parts.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(record(stdout));
    vi.spyOn(console, 'info').mockImplementation(record(stdout));
    vi.spyOn(console, 'error').mockImplementation(record(stderr));
    vi.spyOn(console, 'warn').mockImplementation(record(stderr));
  });

  afterEach(async () => {
    setStderrOnly(false);
    _resetState();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('overlays the scope variables on the inherited environment, and resolves a secret team > machine > environment', async () => {
    const { repoPath } = await team('personal', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n', 'env/secrets.yaml': GITHUB_SECRET });
    const config = await userScope(repoPath);
    vi.stubEnv('API_URL', 'https://inherited.example');
    vi.stubEnv('UNRELATED', 'kept');
    vi.stubEnv('GITHUB_TOKEN', 'fixture-exported');

    let env = await childEnv(home);
    expect(env.API_URL).toBe('https://team.example');
    expect(env.UNRELATED).toBe('kept');
    expect(env.GITHUB_TOKEN).toBe('fixture-exported');

    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'fixture-machine' } });
    env = await childEnv(home);
    expect(env.GITHUB_TOKEN).toBe('fixture-machine');

    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });
    vi.stubEnv('WORK_GITHUB_TOKEN', 'fixture-from-env');
    env = await childEnv(home);
    expect(env.GITHUB_TOKEN).toBe('fixture-from-env');
    expect(text(stderr)).not.toContain('is not set');
  });

  // A directory git cannot answer for inside a repository has no known scope:
  // it gets no team env, never the user scope's (#1018).
  it.each([
    { outcome: 'git fails in the project', where: 'project', git: 'broken', expected: undefined },
    { outcome: 'git is not found in the project', where: 'project', git: 'missing', expected: undefined },
    { outcome: 'git is not found outside any repository', where: 'plain', git: 'missing', expected: 'fixture-user' },
  ])('applies the user secret only where git or the absence of .git says no project governs: $outcome', async ({ where, git: state, expected }) => {
    const personal = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    const userConfig = await userScope(personal.repoPath);
    await writeSecretStore(getTeamSecretsPath(userConfig), { GITHUB_TOKEN: { value: 'fixture-user' } });
    const work = await team('work', {});
    const { root } = await project(work.repoPath);
    // Not the root: this process already resolved it while git could.
    const dirs: Record<string, string> = { project: path.join(root, 'src'), plain: path.join(tmpDir, 'plain') };
    for (const dir of Object.values(dirs)) await fse.ensureDir(dir);
    if (state === 'broken') {
      await fse.remove(path.join(root, '.git'));
      await fse.writeFile(path.join(root, '.git'), `gitdir: ${path.join(tmpDir, 'no-such-git-dir')}\n`);
    } else {
      vi.stubEnv('PATH', path.join(tmpDir, 'empty-bin'));
    }

    const env = await childEnv(dirs[where]);

    expect(env.GITHUB_TOKEN).toBe(expected);
    if (expected === undefined) expect(text(stderr)).toContain('git could not read this repository');
  });

  // #1018: a shell started in another project carries that project's env.sh;
  // a command run here gets this directory's env, not a mix of both.
  describe('with values another scope exported', () => {
    const exportedBy = async (config: LocalConfig, variables: { key: string; value: string }[]): Promise<void> => {
      const teamConfig = { sharing: { env: { injectShellProfile: false } } } as TeamaiConfig;
      await new EnvHandler().writeResolvedEnv(variables, teamConfig, config);
      for (const { key, value } of variables) vi.stubEnv(key, value);
    };

    it("drops another project's values before applying this one's", async () => {
      const { repoPath } = await team('work', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://a.example\n' });
      const { root } = await project(repoPath);
      await exportedBy({
        repo: { localPath: repoPath, remote: 'https://example.com/b.git' }, username: 't', scope: 'project',
        projectRoot: path.join(tmpDir, 'b'), additionalRoles: [], dataHome: path.join(home, '.teamai', 'projects', 'b'),
      }, [{ key: 'ONLY_B', value: 'b-only' }, { key: 'API_URL', value: 'https://b.example' }]);
      vi.stubEnv('MINE', 'kept');

      const env = await childEnv(root);

      expect(env.ONLY_B).toBeUndefined();
      expect(env.API_URL).toBe('https://a.example');
      expect(env.MINE).toBe('kept');
    });

    it('puts the user scope\'s variables, never its secrets, under a project that inherits it', async () => {
      const personal = await team('personal', {
        'env/env.yaml': 'variables:\n  - key: USER_ONLY\n    value: u\n  - key: SHARED\n    value: user\n',
        'env/secrets.yaml': GITHUB_SECRET,
      });
      const userConfig = await userScope(personal.repoPath);
      await writeSecretStore(getTeamSecretsPath(userConfig), { GITHUB_TOKEN: { value: 'fixture-user-team' } });
      const work = await team('work', { 'env/env.yaml': 'variables:\n  - key: SHARED\n    value: project\n' });
      const { root, partition, config } = await project(work.repoPath);

      expect((await childEnv(root)).USER_ONLY).toBeUndefined();

      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify({ ...config, inheritUserScope: true }));
      const env = await childEnv(root);
      expect(env.USER_ONLY).toBe('u');
      expect(env.SHARED).toBe('project');
      expect(env.GITHUB_TOKEN).toBeUndefined();
    });

    // On Windows `token` and `TOKEN` are one variable, and `${TOKEN}` finds either spelling.
    it.each<{ project: string; files: Record<string, string>; expected: string }>([
      { project: 'a variable', files: { 'env/env.yaml': 'variables:\n  - key: TOKEN\n    value: project\n' }, expected: 'project' },
      { project: 'a secret', files: { 'env/secrets.yaml': 'secrets:\n  - key: TOKEN\n' }, expected: 'team-secret' },
    ])('on Windows, gives a server only the project\'s TOKEN when it declares $project and the inherited user scope sets token', async ({ files, expected }) => {
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: token\n    value: user\n' });
      await userScope(personal.repoPath);
      const work = await team('work', files);
      const { partition, config } = await project(work.repoPath);
      const inheriting = { ...config, inheritUserScope: true };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(inheriting));
      await writeSecretStore(getTeamSecretsPath(inheriting), { TOKEN: { value: 'team-secret' } });
      const { buildVarTable } = await import('../mcp-reconcile.js');
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

      const vars = await buildVarTable(inheriting);

      expect(Object.entries(vars).filter(([key]) => key.toUpperCase() === 'TOKEN')).toEqual([['TOKEN', expected]]);
    });

    // While the project's env.yaml fails, a shell still loads the user scope's
    // env.sh and the project's as the last pull wrote it: so do exec and MCP.
    it('keeps the inherited user variables in exec and MCP while the project\'s env.yaml fails', async () => {
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: USER_ONLY\n    value: u\n' });
      await userScope(personal.repoPath);
      const work = await team('work', { 'env/env.yaml': 'variables: [\n' });
      const { root, partition, config } = await project(work.repoPath);
      const inheriting = { ...config, inheritUserScope: true };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(inheriting));
      const { buildVarTable } = await import('../mcp-reconcile.js');

      expect({ exec: (await childEnv(root)).USER_ONLY, mcp: (await buildVarTable(inheriting)).USER_ONLY }).toEqual({ exec: 'u', mcp: 'u' });
    });

    // One resolution: MCP, `env list` and the session-start hint give a key
    // what `env exec` applies, whatever part of the project's env fails.
    it.each([
      { project: "an env.yaml that doesn't parse", http: false, files: { 'env/env.yaml': 'variables: [\n' }, key: 'USER_ONLY', expected: 'u', list: 'USER_ONLY=u  env.yaml  (user scope)' },
      { project: "a secrets.yaml that doesn't parse", http: false, files: { 'env/env.yaml': 'variables:\n  - key: PROJ\n    value: p\n', 'env/secrets.yaml': 'secrets: [\n' }, key: 'PROJ', expected: undefined, list: 'PROJ  (root)' },
      { project: 'an HTTP team repo', http: true, files: {}, key: 'USER_ONLY', expected: 'u', list: 'USER_ONLY=u  env.yaml  (user scope)' },
    ])('gives $key what env exec applies in every consumer when the inheriting project has $project', async ({ http, files, key, expected, list }) => {
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: USER_ONLY\n    value: u\n' });
      await userScope(personal.repoPath);
      const work = await team('work', files as Record<string, string>);
      const { root, partition, config } = await project(work.repoPath);
      const inheriting: LocalConfig = {
        ...config,
        inheritUserScope: true,
        ...http ? { repo: { localPath: work.repoPath, remote: 'https://teamai.example', kind: 'http', url: 'https://teamai.example' } } : {},
      };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(inheriting));
      const { resolveTeamEnv } = await import('../env-resolution.js');
      const { buildVarTable } = await import('../mcp-reconcile.js');
      const { envListing } = await import('../env-listing.js');
      const { buildHandlerRegistry } = await import('../hook-handlers.js');
      const hint = buildHandlerRegistry().find(({ handler }) => handler.name === 'team-env-hint')!.handler;

      expect({
        exec: (await childEnv(root))[key],
        mcp: (await buildVarTable(inheriting))[key],
        list: envListing(await resolveTeamEnv(inheriting), { reveal: true }).lines.map(({ text }) => text.trim()).filter((text) => text.startsWith(key)),
        hint: (await hint.execute({}, 'claude', inheriting))?.includes(key) ?? false,
      }).toEqual({ exec: expected, mcp: expected, list: [list], hint: expected !== undefined });
    });

    // The inherited part follows the user scope's own state, whatever the
    // project's. While the user scope's env can't be resolved, any current
    // value may be a secret: every consumer applies what the user scope's last
    // pull wrote, which its pull keeps and shells keep loading, and says so by key.
    it.each([
      { user: 'everything readable', project: "a values file that can't be read", userFiles: {}, userStore: undefined, projectStore: 'not json', expected: 'u', list: ['USER_ONLY=u  env.yaml  (user scope)'], problem: undefined },
      { user: 'everything readable', project: "a secrets.yaml that doesn't parse", userFiles: {}, userStore: undefined, projectStore: undefined, projectFiles: { 'env/secrets.yaml': 'secrets: [\n' }, expected: 'u', list: ['USER_ONLY=u  env.yaml  (user scope)'], problem: undefined },
      { user: "a secrets.yaml that doesn't parse", project: 'everything readable', userFiles: { 'env/secrets.yaml': 'secrets: [\n' }, userStore: undefined, projectStore: undefined, expected: 'old', list: ['USER_ONLY  (user scope)'], problem: 'secrets.yaml' },
      { user: "a values file that can't be read", project: 'everything readable', userFiles: {}, userStore: 'not json', projectStore: undefined, expected: 'old', list: ['USER_ONLY  (user scope)'], problem: 'is not valid JSON' },
      { user: "an env.yaml that doesn't parse", project: 'everything readable', userFiles: { 'env/env.yaml': 'variables: [\n' }, userStore: undefined, projectStore: undefined, expected: 'old', list: [], problem: 'env.yaml' },
    ])('applies the inherited variables by the user scope\'s state when the user scope has $user and the project $project', async ({ userFiles, userStore, projectStore, projectFiles, expected, list, problem }) => {
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: USER_ONLY\n    value: u\n', ...userFiles as Record<string, string> });
      const userConfig = await userScope(personal.repoPath);
      // What the user scope's last pull wrote, while its env could be resolved.
      await new EnvHandler().writeResolvedEnv([{ key: 'USER_ONLY', value: 'old' }], { sharing: { env: { injectShellProfile: false } } } as TeamaiConfig, userConfig);
      if (userStore) await fse.outputFile(getTeamSecretsPath(userConfig), userStore);
      const work = await team('work', { 'env/env.yaml': 'variables:\n  - key: PROJ\n    value: p\n', ...projectFiles as Record<string, string> | undefined });
      const { root, partition, config } = await project(work.repoPath);
      const inheriting = { ...config, inheritUserScope: true };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(inheriting));
      if (projectStore) await fse.outputFile(getTeamSecretsPath(inheriting), projectStore);
      const { resolveTeamEnv } = await import('../env-resolution.js');
      const { buildVarTable } = await import('../mcp-reconcile.js');
      const { envListing } = await import('../env-listing.js');
      const { buildHandlerRegistry } = await import('../hook-handlers.js');
      const hint = buildHandlerRegistry().find(({ handler }) => handler.name === 'team-env-hint')!.handler;
      const listing = envListing(await resolveTeamEnv(inheriting), { reveal: true });

      expect({
        exec: (await childEnv(root)).USER_ONLY,
        mcp: (await buildVarTable(inheriting)).USER_ONLY,
        list: listing.lines.map(({ text }) => text.trim()).filter((text) => text.startsWith('USER_ONLY')),
        hint: (await hint.execute({}, 'claude', inheriting))?.includes('USER_ONLY') ?? false,
      }).toEqual({ exec: expected, mcp: expected, list, hint: true });
      if (problem) {
        expect(listing.problems.some((text) => text.includes(problem))).toBe(true);
        expect(listing.problems).toContain("Until it is fixed, shells, MCP servers and `teamai env exec` use the values the user scope's last pull wrote for USER_ONLY.");
        const kept = stderr.find((text) => text.includes("with the env variables the user scope's last pull wrote (USER_ONLY)"));
        expect(kept).toContain('[user] ');
        expect(kept).toContain(problem);
        expect(kept).not.toContain('USER_ONLY=old');
      }
    });

    // The project's own part, by the same rule: while it can't be resolved,
    // every consumer applies what its last pull wrote, and no secret from it.
    it.each([
      { project: "an env.yaml that doesn't parse", files: { 'env/env.yaml': 'variables: [\n' }, store: undefined, problem: 'env.yaml' },
      { project: "a secrets.yaml that doesn't parse", files: { 'env/env.yaml': 'variables:\n  - key: PROJ\n    value: p\n', 'env/secrets.yaml': 'secrets: [\n' }, store: undefined, problem: 'secrets.yaml' },
      { project: "a values file that can't be read", files: { 'env/env.yaml': 'variables:\n  - key: PROJ\n    value: p\n' }, store: 'not json', problem: 'is not valid JSON' },
    ])("applies what the project's last pull wrote in every consumer when the project has $project", async ({ files, store, problem }) => {
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: USER_ONLY\n    value: u\n' });
      await userScope(personal.repoPath);
      const work = await team('work', files as Record<string, string>);
      const { root, partition, config } = await project(work.repoPath);
      const inheriting = { ...config, inheritUserScope: true };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(inheriting));
      // As detection resolves it in the directory: the env backup lives in its partition.
      const detected = { ...inheriting, dataHome: partition };
      await new EnvHandler().writeResolvedEnv([{ key: 'PROJ', value: 'old' }], { sharing: { env: { injectShellProfile: false } } } as TeamaiConfig, detected);
      if (store) await fse.outputFile(getTeamSecretsPath(detected), store);
      const { resolveTeamEnv } = await import('../env-resolution.js');
      const { buildVarTable } = await import('../mcp-reconcile.js');
      const { envListing } = await import('../env-listing.js');
      const { buildHandlerRegistry } = await import('../hook-handlers.js');
      const hint = buildHandlerRegistry().find(({ handler }) => handler.name === 'team-env-hint')!.handler;
      const listing = envListing(await resolveTeamEnv(detected), { reveal: true });
      const env = await childEnv(root);

      expect({
        exec: [env.PROJ, env.USER_ONLY],
        mcp: [(await buildVarTable(detected)).PROJ, (await buildVarTable(detected)).USER_ONLY],
        hint: (await hint.execute({}, 'claude', detected))?.includes('PROJ') ?? false,
      }).toEqual({ exec: ['old', 'u'], mcp: ['old', 'u'], hint: true });
      expect(listing.problems.some((text) => text.includes(problem))).toBe(true);
      expect(listing.problems).toContain('Until it is fixed, shells, MCP servers and `teamai env exec` use the values the last pull wrote for PROJ.');
      expect(stderr.find((text) => text.includes('with the env variables the last pull wrote (PROJ)'))).toContain(problem);
    });

    // What the last pull wrote is what its env.sh exports, byte for byte: a
    // value with newlines or surrounding spaces is the one a shell gets.
    it.each([
      { part: "the project's own", userFiles: {}, projectFiles: { 'env/env.yaml': 'variables: [\n' }, key: 'PROJ' },
      { part: 'the inherited', userFiles: { 'env/secrets.yaml': 'secrets: [\n' }, projectFiles: {}, key: 'USER_ONLY' },
    ])('applies a last-pulled value with newlines and surrounding spaces as env.sh exports it, for $part part', async ({ userFiles, projectFiles, key }) => {
      const value = '  first line\nsecond line  ';
      const quoting = { sharing: { env: { injectShellProfile: false } } } as TeamaiConfig;
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: USER_ONLY\n    value: u\n', ...userFiles as Record<string, string> });
      const userConfig = await userScope(personal.repoPath);
      const work = await team('work', projectFiles as Record<string, string>);
      const { root, partition, config } = await project(work.repoPath);
      const detected = { ...config, inheritUserScope: true, dataHome: partition };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify({ ...config, inheritUserScope: true }));
      const pulled = key === 'PROJ' ? detected : userConfig;
      await new EnvHandler().writeResolvedEnv([{ key, value }], quoting, pulled);
      // env.sh is POSIX sh: dash (Ubuntu's sh) reads it as bash and zsh do.
      const shells = ['sh', 'dash', 'bash', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0);
      const sourced = Object.fromEntries(shells.map((shell) => [shell, execFileSync(shell, ['-c', '. "$1"; eval "printf %s \\"\\$$2\\""', 'sh', path.join(getDataHome(pulled), 'env.sh'), key], { encoding: 'utf8' })]));
      const { buildVarTable } = await import('../mcp-reconcile.js');

      expect({ shells: sourced, exec: (await childEnv(root))[key], mcp: (await buildVarTable(detected))[key] })
        .toEqual({ shells: Object.fromEntries(shells.map((shell) => [shell, value])), exec: value, mcp: value });
    });

    // A key the project declares is the project's in every consumer: a secret
    // without a value stays missing rather than take the user scope's value.
    it.each([
      { project: 'nothing', user: 'a git team repo', files: {}, store: {}, expected: 'user', list: 'TOKEN=user  env.yaml  (user scope)' },
      { project: 'a variable', user: 'a git team repo', files: { 'env/env.yaml': 'variables:\n  - key: TOKEN\n    value: project\n' }, store: {}, expected: 'project', list: 'TOKEN=project  env.yaml  (root)' },
      { project: 'a secret with a value', user: 'a git team repo', files: { 'env/secrets.yaml': 'secrets:\n  - key: TOKEN\n' }, store: { TOKEN: { value: 'project-secret' } }, expected: 'project-secret', list: 'TOKEN  team  (root)' },
      { project: 'a secret without a value', user: 'a git team repo', files: { 'env/secrets.yaml': 'secrets:\n  - key: TOKEN\n' }, store: {}, expected: undefined, list: 'TOKEN  missing  (root)' },
      // Pull writes the user scope's env.sh whatever its source, so shells inherit it from an HTTP team repo too.
      { project: 'nothing', user: 'an HTTP team repo', files: {}, store: {}, expected: 'user', list: 'TOKEN=user  env.yaml  (user scope)' },
    ])('gives TOKEN the project\'s value when the project declares $project and the user scope ($user) a variable', async ({ user, files, store, expected, list }) => {
      const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: TOKEN\n    value: user\n' });
      await userScope(personal.repoPath, user === 'an HTTP team repo' ? { repo: { localPath: personal.repoPath, remote: 'https://teamai.example', kind: 'http', url: 'https://teamai.example' } } : {});
      const work = await team('work', files as Record<string, string>);
      const { root, partition, config } = await project(work.repoPath);
      const inheriting = { ...config, inheritUserScope: true };
      await fse.outputFile(path.join(partition, 'config.yaml'), YAML.stringify(inheriting));
      await writeSecretStore(getTeamSecretsPath(inheriting), store as SecretStore);
      const { resolveTeamEnv, effectiveTeamEnvVariables } = await import('../env-resolution.js');
      const { buildVarTable } = await import('../mcp-reconcile.js');
      const { envListing } = await import('../env-listing.js');
      const teamEnv = await resolveTeamEnv(inheriting);
      const declared = effectiveTeamEnvVariables(teamEnv).find(({ name }) => name === 'TOKEN');

      expect({
        exec: (await childEnv(root)).TOKEN,
        mcp: (await buildVarTable(inheriting, teamEnv)).TOKEN,
        inherited: declared ? teamEnv.inheritedVariables.includes(declared) : false,
        list: envListing(teamEnv, { reveal: true }).lines.map(({ text }) => text.trim()).filter((text) => text.startsWith('TOKEN')),
      }).toEqual({ exec: expected, mcp: expected, inherited: expected === 'user', list: [list] });
    });

    it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0)("keeps this project's secret in a bash the command starts, from a shell that loaded another directory's env", async () => {
      const { repoPath } = await team('work', { 'env/secrets.yaml': GITHUB_SECRET });
      const { root, config } = await project(repoPath);
      await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { value: 'fixture-work' } });
      const b = path.join(tmpDir, 'b');
      await fse.ensureDir(b);
      vi.stubEnv('SHELL', '/bin/bash');
      await new EnvHandler().writeResolvedEnv([{ key: 'GITHUB_TOKEN', value: 'fixture-b' }], { sharing: { env: { injectShellProfile: true } } } as TeamaiConfig, {
        repo: { localPath: repoPath, remote: 'https://example.com/b.git' }, username: 't', scope: 'project',
        projectRoot: b, additionalRoles: [], dataHome: path.join(home, '.teamai', 'projects', 'b'),
      });
      // What a script started in b carries: the loader's values and its bookkeeping.
      const loaded = spawnSync('bash', ['-c', `${JSON.stringify(process.execPath)} -e '${DUMP}' "$0"`, out], {
        cwd: b, env: { HOME: home, PATH: process.env.PATH, BASH_ENV: path.join(home, '.teamai', 'env-loader.sh') },
      });
      expect(loaded.status).toBe(0);
      const inherited = JSON.parse(await fse.readFile(out, 'utf8')) as Record<string, string>;
      expect(inherited.GITHUB_TOKEN).toBe('fixture-b');
      for (const [key, value] of Object.entries(inherited)) if (key.startsWith('__TEAMAI_ENV_') || key === 'BASH_ENV' || key === 'GITHUB_TOKEN') vi.stubEnv(key, value);

      const outcome = await envExec(['--', 'bash', '-c', 'printenv GITHUB_TOKEN > "$0"', out], {}, root);

      expect((await fse.readFile(out, 'utf8')).trim()).toBe('fixture-work');
      expect(outcome).toEqual({ kind: 'exited', code: 0 });
    });
  });

  // #875 (#879 S9): the same order as MCP for a variable.
  it("gives a variable the member's value for this team over env.yaml and the inherited one", async () => {
    const { repoPath } = await team('personal', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n' });
    const config = await userScope(repoPath);
    vi.stubEnv('API_URL', 'https://inherited.example');
    await writeSecretStore(getMachineSecretsPath(), { API_URL: { value: 'https://machine.example' } });

    expect((await childEnv(home)).API_URL).toBe('https://team.example');

    await writeSecretStore(getTeamSecretsPath(config), { API_URL: { value: 'https://mine.example', kind: 'variable' } });
    expect((await childEnv(home)).API_URL).toBe('https://mine.example');

    await writeSecretStore(getTeamSecretsPath(config), { API_URL: { env: 'MY_API_URL', kind: 'variable' } });
    vi.stubEnv('MY_API_URL', 'https://mine-from-env.example');
    expect((await childEnv(home)).API_URL).toBe('https://mine-from-env.example');
  });

  // #879: a former secret's stored value never reaches the child as the variable it is now.
  it('gives a variable its env.yaml value, never a value stored while it was a secret, and a secret never a variable override', async () => {
    const { repoPath } = await team('personal', {
      'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n', 'env/secrets.yaml': GITHUB_SECRET,
    });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), {
      API_URL: { value: 'fixture-old-secret' },
      GITHUB_TOKEN: { value: 'fixture-override', kind: 'variable' },
    });

    const env = await childEnv(home);
    expect(env.API_URL).toBe('https://team.example');
    expect(Object.hasOwn(env, 'GITHUB_TOKEN')).toBe(false);
    expect(text(stderr)).toContain(GITHUB_LINE);
  });

  // `__proto__` is a valid env key; an ordinary object's inherited setter would drop it.
  it('passes a secret and a variable named __proto__, and removes the secret when it has no value', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': 'secrets:\n  - key: __proto__\n' });
    const config = await userScope(repoPath);
    vi.stubEnv('__proto__', 'fixture-exported');

    expect((await childEnv(home))['__proto__']).toBe('fixture-exported');

    await writeSecretStore(getTeamSecretsPath(config), { ['__proto__']: { env: 'WORK_GITHUB_TOKEN' } });
    expect(Object.hasOwn(await childEnv(home), '__proto__')).toBe(false);

    await writeSecretStore(getTeamSecretsPath(config), { ['__proto__']: { value: 'fixture-secret' } });
    expect((await childEnv(home))['__proto__']).toBe('fixture-secret');

    await fse.outputFile(path.join(repoPath, 'env', 'secrets.yaml'), 'secrets: []\n');
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables:\n  - key: __proto__\n    value: fixture-team\n');
    await writeSecretStore(getTeamSecretsPath(config), {});
    expect((await childEnv(home))['__proto__']).toBe('fixture-team');
  });

  // Windows environment names are case-insensitive: a declared key in another case is the same variable.
  it('on Windows, removes and overlays a declared key in any case, and elsewhere only in its own case', async () => {
    const { repoPath } = await team('personal', {
      'env/env.yaml': 'variables:\n  - key: api_url\n    value: https://team.example\n', 'env/secrets.yaml': GITHUB_SECRET,
    });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });
    vi.stubEnv('API_URL', 'https://inherited.example');
    vi.stubEnv('github_token', 'fixture-exported');
    const named = (env: Record<string, string>, key: string): Record<string, string> =>
      Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase() === key));

    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let env: Record<string, string>;
    try {
      env = await childEnv(home);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
    expect(named(env, 'API_URL')).toEqual({ api_url: 'https://team.example' });
    expect(named(env, 'GITHUB_TOKEN')).toEqual({});

    env = await childEnv(home);
    expect(named(env, 'API_URL')).toEqual({ API_URL: 'https://inherited.example', api_url: 'https://team.example' });
    expect(named(env, 'GITHUB_TOKEN')).toEqual({ github_token: 'fixture-exported' });
  });

  it('resolves the project scope from a linked worktree of the project, and the user scope elsewhere', async () => {
    const personal = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    const user = await userScope(personal.repoPath);
    const work = await team('work', { 'env/secrets.yaml': GITHUB_SECRET, 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://work.example\n' });
    const { root, worktree, config } = await project(work.repoPath);
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'fixture-personal' } });
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { value: 'fixture-work' } });
    expect(getTeamSecretsPath(config)).not.toBe(getTeamSecretsPath(user));
    const sub = path.join(worktree, 'src');
    await fse.ensureDir(sub);

    expect((await childEnv(home)).GITHUB_TOKEN).toBe('fixture-personal');
    expect((await childEnv(root)).GITHUB_TOKEN).toBe('fixture-work');
    const fromWorktree = await childEnv(sub);
    expect(fromWorktree.GITHUB_TOKEN).toBe('fixture-work');
    expect(fromWorktree.API_URL).toBe('https://work.example');
  });

  it('prints the missing-secret line on stderr and still runs the command', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    await userScope(repoPath);

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(text(stderr)).toContain(GITHUB_LINE);
    expect(stdout).toEqual([]);
  });

  it('removes a declared key whose only environment value is one teamai exported for another scope', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    await userScope(repoPath);
    await fse.outputFile(path.join(home, '.teamai', 'projects', 'other-0123456789', 'env.sh'), "export GITHUB_TOKEN='fixture-other-team'\n");
    vi.stubEnv('GITHUB_TOKEN', 'fixture-other-team');

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(text(stderr)).toContain(GITHUB_LINE);
  });

  it('removes a declared key whose team entry names an unset variable, rather than pass the inherited value', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });
    vi.stubEnv('GITHUB_TOKEN', 'fixture-personal-export');

    expect((await childEnv(home)).GITHUB_TOKEN).toBeUndefined();
  });

  // Any current env.yaml value may be a secret the file declares (#879 Conflict 14):
  // the variables are what the last pull wrote, as the shells keep them, and no secret.
  it('applies no secret and only the variables the last pull wrote on a failed declaration, and names the failure', async () => {
    const { repoPath } = await team('personal', {
      'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n',
      'env/secrets.yaml': 'secrets:\n  - key: 1BAD\n',
    });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { value: 'fixture-team' } });
    vi.stubEnv('GITHUB_TOKEN', 'fixture-exported');

    let env = await childEnv(home);
    expect(env.API_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe('fixture-exported');
    expect(text(stderr)).toContain('env/secrets.yaml');
    expect(text(stderr)).toContain("The command runs without team secrets, and without the team's env variables.");

    await new EnvHandler().writeResolvedEnv([{ key: 'API_URL', value: 'https://last-pull.example' }], { sharing: { env: { injectShellProfile: false } } } as TeamaiConfig, config);
    stderr.length = 0;
    env = await childEnv(home);
    expect(env.API_URL).toBe('https://last-pull.example');
    expect(env.GITHUB_TOKEN).toBe('fixture-exported');
    expect(text(stderr)).toContain('The command runs without team secrets, and with the env variables the last pull wrote (API_URL).');
  });

  // The env backup holds what env.sh exports: a key env.sh drops never reaches the command.
  it('applies no variable from the last pull that its env.sh did not export while the declarations fail', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': 'secrets:\n  - key: 1BAD\n' });
    const config = await userScope(repoPath);
    await new EnvHandler().writeResolvedEnv(
      [{ key: 'API_URL', value: 'https://last-pull.example' }, { key: 'BAD-NAME', value: 'dropped' }],
      { sharing: { env: { injectShellProfile: false } } } as TeamaiConfig, config,
    );

    const env = await childEnv(home);

    expect(await fse.readFile(path.join(home, '.teamai', 'env.sh'), 'utf8')).not.toContain('BAD-NAME');
    expect(await fse.readFile(path.join(home, '.teamai', 'env'), 'utf8')).not.toContain('BAD-NAME');
    expect(env.API_URL).toBe('https://last-pull.example');
    expect(env['BAD-NAME']).toBeUndefined();
    expect(text(stderr)).toContain('with the env variables the last pull wrote (API_URL).');
  });

  it('removes what a teamai env.sh exported while the declarations fail, keeps the member\'s own exports, and names the keys', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': 'secrets: [not yaml\n' });
    await userScope(repoPath);
    await fse.outputFile(path.join(home, '.teamai', 'env.sh'), "export GITHUB_TOKEN='fixture-repo-token'\nexport SENTRY_TOKEN='fixture-repo-sentry'\n");
    const [marker, digests] = envShMarker(path.join(tmpDir, 'unscanned', '.teamai'), [['GITLAB_TOKEN', 'fixture-marked']]) ?? [];
    if (!marker || !digests) throw new Error('no marker for the fixture export');
    vi.stubEnv(marker, digests);
    vi.stubEnv('GITHUB_TOKEN', 'fixture-repo-token');
    vi.stubEnv('GITLAB_TOKEN', 'fixture-marked');
    vi.stubEnv('SENTRY_TOKEN', 'fixture-hand-export');

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.SENTRY_TOKEN).toBe('fixture-hand-export');
    expect(text(stderr)).toContain('without GITHUB_TOKEN, GITLAB_TOKEN, whose values a teamai env.sh exported.');
    expect(text(stderr)).not.toMatch(/fixture-(repo|marked|hand)/);
  });

  it.each([
    ['env.yaml does not parse', { 'env/env.yaml': 'variables: [not yaml\n' }, false],
    ['the values file cannot be read', { 'env/env.yaml': 'variables:\n  - key: REGION\n    value: eu\n' }, true],
  ])('removes what a teamai env.sh exported when %s, keeps the member\'s own exports, and names the keys', async (_, files, corruptStore) => {
    const { repoPath } = await team('personal', files);
    const config = await userScope(repoPath);
    if (corruptStore) await fse.outputFile(getTeamSecretsPath(config), '{"REGION": {"value": fixture-corrupt}}');
    await fse.outputFile(path.join(home, '.teamai', 'env.sh'), "export GITHUB_TOKEN='fixture-repo-token'\n");
    vi.stubEnv('GITHUB_TOKEN', 'fixture-repo-token');
    vi.stubEnv('SENTRY_TOKEN', 'fixture-hand-export');

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SENTRY_TOKEN).toBe('fixture-hand-export');
    expect(text(stderr)).toContain('without GITHUB_TOKEN, whose values a teamai env.sh exported.');
    expect(text(stderr)).not.toMatch(/fixture-(repo|hand|corrupt)/);
  });

  it('keeps a legacy env.yaml value of a key that may be a secret from the command while the declarations fail', async () => {
    const { repoPath } = await team('personal', {
      'env/env.yaml': 'variables:\n  - key: GITHUB_TOKEN\n    value: fixture-legacy-repo\n',
      'env/secrets.yaml': 'secrets: [not yaml\n',
    });
    await userScope(repoPath);

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(text(stderr)).not.toContain('fixture-legacy-repo');
  });

  it('removes every declared key when the values file cannot be read, and says why', async () => {
    const { repoPath } = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    const config = await userScope(repoPath);
    await fse.outputFile(getTeamSecretsPath(config), '{"GITHUB_TOKEN": {"value": fixture-corrupt}}');
    vi.stubEnv('GITHUB_TOKEN', 'fixture-exported');

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(text(stderr)).toContain(getTeamSecretsPath(config));
    expect(text(stderr)).not.toContain('fixture-corrupt');
  });

  it('names a project config that cannot be read, applies no stored values, and runs the command', async () => {
    const personal = await team('personal', { 'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://personal.example\n', 'env/secrets.yaml': GITHUB_SECRET });
    await userScope(personal.repoPath);
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'fixture-machine' } });
    const work = await team('work', {});
    const { root, partition } = await project(work.repoPath);
    await fse.outputFile(path.join(partition, 'config.yaml'), 'repo: [not a config\n');

    const env = await childEnv(root);

    expect(env.API_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(text(stderr)).toContain(path.join(partition, 'config.yaml'));
    expect(text(stderr)).not.toContain('No teamai config');
  });

  it("removes what another scope's env.sh exported when a project config cannot be read, keeps the member's own exports, and names the keys", async () => {
    const personal = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    await userScope(personal.repoPath);
    const work = await team('work', {});
    const { root, partition } = await project(work.repoPath);
    await fse.outputFile(path.join(partition, 'config.yaml'), 'repo: [not a config\n');
    await fse.outputFile(path.join(home, '.teamai', 'env.sh'), "export GITHUB_TOKEN='fixture-user-scope'\n");
    await fse.outputFile(path.join(partition, 'env.sh'), "export API_URL='fixture-work-scope'\n");
    const [marker, digests] = envShMarker(path.join(tmpDir, 'unscanned', '.teamai'), [['GITLAB_TOKEN', 'fixture-marked']]) ?? [];
    if (!marker || !digests) throw new Error('no marker for the fixture export');
    vi.stubEnv(marker, digests);
    vi.stubEnv('GITHUB_TOKEN', 'fixture-user-scope');
    vi.stubEnv('API_URL', 'fixture-work-scope');
    vi.stubEnv('GITLAB_TOKEN', 'fixture-marked');
    vi.stubEnv('SENTRY_TOKEN', 'fixture-hand-export');

    const env = await childEnv(root);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.API_URL).toBeUndefined();
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.SENTRY_TOKEN).toBe('fixture-hand-export');
    expect(text(stderr)).toContain(path.join(partition, 'config.yaml'));
    expect(text(stderr)).toMatch(/without (?=.*GITHUB_TOKEN)(?=.*API_URL)(?=.*GITLAB_TOKEN)[A-Z_, ]+, whose values a teamai env\.sh exported/);
    expect(text(stderr)).not.toMatch(/fixture-(user|work|marked|hand)/);
  });

  it('with no config at all, runs with the inherited environment, applies no machine value, and says so', async () => {
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'fixture-machine' } });
    vi.stubEnv('UNRELATED', 'kept');
    const nowhere = path.join(tmpDir, 'nowhere');
    await fse.ensureDir(nowhere);

    const env = await childEnv(nowhere);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.UNRELATED).toBe('kept');
    expect(text(stderr)).toContain('No teamai config');
    expect(stdout).toEqual([]);
  });

  it("with no config, removes what a teamai env.sh exported, keeps the member's own exports, and names the keys", async () => {
    await fse.outputFile(path.join(home, '.teamai', 'projects', 'other-0123456789', 'env.sh'), "export GITHUB_TOKEN='fixture-other-team'\n");
    vi.stubEnv('GITHUB_TOKEN', 'fixture-other-team');
    vi.stubEnv('SENTRY_TOKEN', 'fixture-hand-export');
    const nowhere = path.join(tmpDir, 'nowhere');
    await fse.ensureDir(nowhere);

    const env = await childEnv(nowhere);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SENTRY_TOKEN).toBe('fixture-hand-export');
    expect(text(stderr)).toContain('No teamai config');
    expect(text(stderr)).toContain('without GITHUB_TOKEN, whose values a teamai env.sh exported');
    expect(text(stderr)).not.toMatch(/fixture-(other|hand)/);
  });

  // An empty value is the team's too when a teamai env.sh exported it.
  it.each([
    { name: 'in a resolved scope', warns: false, dir: async () => { await userScope((await team('personal', {})).repoPath); return home; } },
    { name: 'with no config', warns: true, dir: async () => { const nowhere = path.join(tmpDir, 'nowhere'); await fse.ensureDir(nowhere); return nowhere; } },
  ])("removes an empty value another scope's env.sh exported, and keeps the member's own empty export, $name", async ({ warns, dir }) => {
    await fse.outputFile(path.join(home, '.teamai', 'projects', 'other-0123456789', 'env.sh'), "export FLAG=''\n");
    vi.stubEnv('FLAG', '');
    vi.stubEnv('MEMBER_EMPTY', '');

    const env = await childEnv(await dir());

    expect(env.FLAG).toBeUndefined();
    expect(env.MEMBER_EMPTY).toBe('');
    if (warns) expect(text(stderr)).toContain('without FLAG, whose values a teamai env.sh exported');
  });

  it("in an HTTP-backed scope, removes what another team's env.sh exported, keeps the member's own exports, and names the keys", async () => {
    const { repoPath } = await team('http', {});
    await userScope(repoPath, { repo: { localPath: repoPath, remote: 'https://team.example/api', kind: 'http', url: 'https://team.example/api' } });
    await fse.outputFile(path.join(home, '.teamai', 'projects', 'other-0123456789', 'env.sh'), "export GITHUB_TOKEN='fixture-other-team'\n");
    vi.stubEnv('GITHUB_TOKEN', 'fixture-other-team');
    vi.stubEnv('SENTRY_TOKEN', 'fixture-hand-export');

    const env = await childEnv(home);

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SENTRY_TOKEN).toBe('fixture-hand-export');
    expect(text(stderr)).toContain('HTTP team repo');
    expect(text(stderr)).toContain('without GITHUB_TOKEN, whose values a teamai env.sh exported');
    expect(text(stderr)).not.toMatch(/fixture-(other|hand)/);
  });

  // Without `--`, a flag of the command (`gh pr list --dry-run`) would be read as teamai's.
  it('rejects a command without -- before it, with exit code 2, and runs nothing', async () => {
    const marker = path.join(tmpDir, 'ran');
    const outcome = await envExec([process.execPath, '-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`, '--dry-run'], {}, tmpDir);

    expect(outcome).toEqual({ kind: 'exited', code: 2 });
    expect(text(stderr)).toContain('Put -- before the command: teamai env exec -- <command>');
    expect(await fse.pathExists(marker)).toBe(false);
  });

  it('accepts teamai options before --, and passes everything after it to the command', async () => {
    const outcome = await envExec(['--verbose', '--', process.execPath, '-e', 'process.exit(process.argv[1] === "--dry-run" ? 4 : 5)', '--', '--dry-run'], {}, tmpDir);

    expect(outcome).toEqual({ kind: 'exited', code: 4 });
  });

  it('passes the exit code and the signal through', async () => {
    const nowhere = path.join(tmpDir, 'nowhere');
    await fse.ensureDir(nowhere);

    expect(await exec(nowhere, 'process.exit(3)', [])).toEqual({ kind: 'exited', code: 3 });
    expect(await exec(nowhere, 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)', []))
      .toEqual({ kind: 'signaled', signal: 'SIGTERM' });
  });

  it('exits 128 + the signal number for a signal that does not end teamai (SIGPIPE, SIGUSR1)', () => {
    try {
      exitLike({ kind: 'signaled', signal: 'SIGPIPE' });
      expect(process.exitCode).toBe(141);
      exitLike({ kind: 'signaled', signal: 'SIGUSR1' });
      expect(process.exitCode).toBe(128 + os.constants.signals.SIGUSR1);
    } finally {
      process.exitCode = undefined;
    }
  });

  // #879: a terminal sends Ctrl-C to its foreground group, the command included; any other SIGINT is teamai's alone.
  it.each([
    ['in the foreground group of its terminal', '77167 77167\n', true],
    ['in a background job of its terminal', ' 77167 80012\n', false],
    ['without a controlling terminal (macOS)', '77167     0\n', false],
    ['without a controlling terminal (Linux)', '77167    -1\n', false],
    ['when ps printed nothing', '', false],
    ['when ps printed something else', 'PGID TPGID\n', false],
  ] as const)('takes teamai to be %s from `ps -o pgid=,tpgid=`', (_name, ps, foreground) => {
    expect(inTerminalForeground(ps)).toBe(foreground);
  });

  it('reports a command that cannot be started, with exit code 127', async () => {
    const nowhere = path.join(tmpDir, 'nowhere');
    await fse.ensureDir(nowhere);

    expect(await envExec(['--', 'teamai-no-such-command-875'], {}, nowhere)).toEqual({ kind: 'exited', code: 127 });
    expect(text(stderr)).toContain('teamai-no-such-command-875');
  });

  it('prints nothing on stdout, the scope lookup included', async () => {
    const { repoPath } = await team('personal', {
      'env/secrets.yaml': GITHUB_SECRET,
      'manifest/roles.yaml': 'version: 1\nroles:\n  - id: hai\n    description: default\n    resources:\n      knowledge: []\n      skills: []\n',
    });
    await userScope(repoPath);

    await childEnv(home);

    expect(stdout).toEqual([]);
    expect(text(stderr)).toContain('Migrated legacy teamai config');
  });

  it('writes no member value to disk or debug.log', async () => {
    const personal = await team('personal', { 'env/secrets.yaml': GITHUB_SECRET });
    const user = await userScope(personal.repoPath);
    const work = await team('work', { 'env/secrets.yaml': GITHUB_SECRET });
    const { root, config } = await project(work.repoPath);
    await writeSecretStore(getMachineSecretsPath(), { GITHUB_TOKEN: { value: 'fixture-machine' } });
    await writeSecretStore(getTeamSecretsPath(user), { GITHUB_TOKEN: { value: 'fixture-team' } } satisfies SecretStore);
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { env: 'WORK_GITHUB_TOKEN' } });
    vi.stubEnv('WORK_GITHUB_TOKEN', 'fixture-parent-env-only');
    const fixtures = ['fixture-machine', 'fixture-team', 'fixture-parent-env-only'];
    const holding = async (): Promise<Map<string, string>> => {
      const found = new Map<string, string>();
      for (const file of await filesUnder([home, root, personal.repoPath, work.repoPath])) {
        const content = await fse.readFile(file);
        if (fixtures.some((fixture) => content.includes(fixture))) {
          found.set(file, crypto.createHash('sha256').update(content).digest('hex'));
        }
      }
      return found;
    };
    const before = await holding();

    expect((await childEnv(home)).GITHUB_TOKEN).toBe('fixture-team');
    expect((await childEnv(root)).GITHUB_TOKEN).toBe('fixture-parent-env-only');
    await fse.remove(out);

    expect(await holding()).toEqual(before);
    for (const log of ['debug.log', 'debug.log.1']) {
      const content = await fse.readFile(path.join(home, '.teamai', log), 'utf8').catch(() => '');
      for (const fixture of fixtures) expect(content).not.toContain(fixture);
    }
  });
});

async function filesUnder(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fse.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  for (const root of roots) await walk(root);
  return files;
}

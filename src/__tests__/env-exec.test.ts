import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { envExec, exitLike, inTerminalForeground } from '../env-exec.js';
import { envShMarker } from '../env-sh-exports.js';
import { getMachineSecretsPath, getTeamSecretsPath, writeSecretStore, type SecretStore } from '../secret-store.js';
import { resolveAnchors } from '../utils/git.js';
import { _resetState, _setLogFilePath, setStderrOnly } from '../utils/logger.js';
import { projectDataHome } from '../utils/partition.js';
import type { LocalConfig } from '../types.js';

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

  it('applies no variables and no secrets on a failed declaration, and names the failure', async () => {
    const { repoPath } = await team('personal', {
      'env/env.yaml': 'variables:\n  - key: API_URL\n    value: https://team.example\n',
      'env/secrets.yaml': 'secrets:\n  - key: 1BAD\n',
    });
    const config = await userScope(repoPath);
    await writeSecretStore(getTeamSecretsPath(config), { GITHUB_TOKEN: { value: 'fixture-team' } });
    vi.stubEnv('GITHUB_TOKEN', 'fixture-exported');

    const env = await childEnv(home);

    expect(env.API_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBe('fixture-exported');
    expect(text(stderr)).toContain('env/secrets.yaml');
    expect(text(stderr)).toContain('The command runs with the inherited environment, without team env variables or secrets.');
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

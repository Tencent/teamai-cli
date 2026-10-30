import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const REPO_URL = 'https://teamai.test/fixtures/longpaths';

describe.skipIf(process.platform !== 'win32')('Windows team-repo long paths', () => {
  let sandbox: string;

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pulls an inactive namespace with long paths and delivers the active skill without changing Git config', () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-longpaths-')));
    const home = path.join(sandbox, 'home');
    const workspace = path.join(sandbox, 'workspace');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'remote');
    for (const dir of [home, workspace, path.join(seed, 'manifest')]) fs.mkdirSync(dir, { recursive: true });
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
      GIT_TERMINAL_PROMPT: '0', TEAMAI_NONINTERACTIVE: '1', FORCE_COLOR: '0',
    };
    const git = (args: string[], cwd = sandbox) => execFileSync('git', args, {
      cwd, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    }).trim();
    const cli = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], {
      cwd: workspace, env, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    git(['config', '--global', 'core.hooksPath', path.join(sandbox, 'no-hooks')]);
    git(['config', '--global', 'gc.auto', '0']);
    git(['config', '--global', `url.${remote.replace(/\\/g, '/')}.insteadOf`, REPO_URL]);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'longpaths-e2e', repo: REPO_URL, provider: 'git', reviewers: [],
    }));
    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), YAML.stringify({
      version: 1, roles: [
        { id: 'dev', resources: { knowledge: [], skills: ['active'] } },
        { id: 'other', resources: { knowledge: [], skills: ['inactive'] } },
      ],
    }));
    const skill = path.join(seed, 'skills', 'active', 'demo', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, '---\nname: demo\ndescription: Long path fixture\n---\n\nOriginal\n');
    const inactiveSkill = path.join(seed, 'skills', 'inactive', 'deep-demo', 'SKILL.md');
    fs.mkdirSync(path.dirname(inactiveSkill), { recursive: true });
    fs.writeFileSync(inactiveSkill, '---\nname: deep-demo\ndescription: Inactive skill fixture\n---\n\nOther role only\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote]);
    cli(['init', REPO_URL, '--provider', 'git', '--scope', 'workspace', '--role', 'dev', '--agent', 'cursor', '--force']);
    const config = YAML.parse(fs.readFileSync(path.join(workspace, '.teamai', 'config.yaml'), 'utf8')) as {
      repo: { localPath: string };
    };
    const globalBefore = fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8');
    const localBefore = fs.readFileSync(path.join(config.repo.localPath, '.git', 'config'), 'utf8');
    const relative = path.join('skills', 'inactive', 'deep-demo', ...Array<string>(14).fill('nested-template-source'), 'asset.txt');
    expect(path.join(config.repo.localPath, relative).length).toBeGreaterThan(260);
    fs.appendFileSync(skill, '\nUpdated active skill\n');
    // Seed the long tree entry directly: preparing the remote must not depend
    // on the Git version's ability to scan an untracked long directory.
    const asset = path.join(sandbox, 'asset.txt');
    fs.writeFileSync(asset, 'inactive asset\n');
    const blob = git(['hash-object', '-w', asset], seed);
    git(['update-index', '--add', '--cacheinfo', '100644', blob, relative.replace(/\\/g, '/')], seed);
    git(['add', '--', 'skills/active/demo/SKILL.md'], seed);
    git(['-c', 'core.longpaths=true', 'commit', '-q', '-m', 'long inactive asset and active update'], seed);
    git(['-c', 'core.longpaths=true', 'push', '-q', remote, 'HEAD:main'], seed);
    expect(git(['ls-tree', '-r', '--name-only', 'main'], remote)).toContain(relative.replace(/\\/g, '/'));

    // Confirm this exact tree fails under ordinary Git with long paths off.
    const control = spawnSync('git', ['clone', '-q', '-c', 'core.longpaths=false', remote, path.join(sandbox, 'control')], {
      cwd: sandbox, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    expect(control.status, control.stderr).not.toBe(0);
    expect(control.stderr).toMatch(/Filename too long/i);

    const output = cli(['pull', '--force']);
    expect(output).not.toMatch(/Pull failed|Filename too long|realigning discards/i);
    expect(fs.readFileSync(path.join(workspace, '.cursor', 'skills', 'demo', 'SKILL.md'), 'utf8'))
      .toContain('Updated active skill');
    expect(fs.existsSync(path.join(workspace, '.cursor', 'skills', 'deep-demo'))).toBe(false);
    expect(fs.readFileSync(path.join(config.repo.localPath, relative), 'utf8')).toBe('inactive asset\n');
    expect(fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(globalBefore);
    expect(fs.readFileSync(path.join(config.repo.localPath, '.git', 'config'), 'utf8')).toBe(localBefore);
  });
});

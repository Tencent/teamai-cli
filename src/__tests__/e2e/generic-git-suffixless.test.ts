import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist/index.js');
const REPO_URL = 'https://dev.azure.com/teamai-repro/My%20Project/_git/teamai-oe';

describe('generic Git clone paths without a .git suffix (#1169)', () => {
  let sandbox: string;
  let home: string;
  let workspace: string;
  let seed: string;
  let remote: string;
  let env: NodeJS.ProcessEnv;

  function git(args: string[], cwd = sandbox): string {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30_000 }).trim();
  }

  function cli(args: string[]): string {
    return execFileSync(process.execPath, [CLI, ...args], {
      cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000, windowsHide: true,
    });
  }

  beforeEach(() => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-git-suffixless-')));
    home = path.join(sandbox, 'home');
    workspace = path.join(sandbox, 'workspace');
    seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'remotes', 'teamai-oe');
    for (const dir of [home, workspace, path.dirname(remote), path.join(seed, 'manifest')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'TeamAI CI',
      GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI',
      GIT_COMMITTER_EMAIL: 'ci@teamai.test',
      GIT_TERMINAL_PROMPT: '0',
      TEAMAI_NONINTERACTIVE: '1',
      FORCE_COLOR: '0',
    };
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'suffixless-e2e', repo: REPO_URL, provider: 'git', reviewers: [],
    }));
    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), YAML.stringify({
      version: 1,
      roles: [{ id: 'dev', resources: { knowledge: [], skills: ['common'] } }],
    }));
    const skill = path.join(seed, 'skills', 'common', 'suffixless-demo');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'),
      '---\nname: suffixless-demo\ndescription: Suffixless Git fixture\n---\n\n# Original\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote]);
    // Rewrite only the prefix: an added .git must point at a missing repository.
    git(['config', '--global', `url.${path.dirname(remote).replace(/\\/g, '/')}/.insteadOf`,
      'https://dev.azure.com/teamai-repro/My%20Project/_git/']);
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('initializes, preserves the saved remote, and pulls a later skill update', () => {
    // Establish that the original URL is cloneable before exercising TeamAI.
    git(['clone', '-q', REPO_URL, path.join(sandbox, 'direct-clone')]);
    cli(['init', REPO_URL, '--provider', 'git', '--scope', 'workspace',
      '--role', 'dev', '--agent', 'claude', '--force']);
    const config = YAML.parse(fs.readFileSync(path.join(workspace, '.teamai', 'config.yaml'), 'utf8')) as {
      repo: { remote: string; localPath: string };
    };
    expect(config.repo.remote).toBe(REPO_URL);
    expect(git(['config', '--get', 'remote.origin.url'], config.repo.localPath)).toBe(REPO_URL);
    cli(['pull']);
    const delivered = path.join(workspace, '.claude', 'skills', 'suffixless-demo', 'SKILL.md');
    expect(fs.readFileSync(delivered, 'utf8')).toContain('# Original');

    const skill = path.join(seed, 'skills', 'common', 'suffixless-demo', 'SKILL.md');
    fs.appendFileSync(skill, '\nUpdated through the suffixless remote.\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'update skill'], seed);
    git(['push', '-q', remote, 'HEAD:main'], seed);
    cli(['pull']);
    expect(fs.readFileSync(delivered, 'utf8')).toContain('Updated through the suffixless remote.');
  });
});

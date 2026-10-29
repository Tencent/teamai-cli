import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
const REPO_URL = 'https://teamai.test/fixtures/roundtrip.git';
let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('skill sync round trip', () => {
  it.each([false, true])('preserves the origin and edits with core.autocrlf=%s', (autocrlf) => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-roundtrip-')));
    const home = path.join(sandbox, 'home');
    const seed = path.join(sandbox, 'seed');
    const project = path.join(sandbox, 'project');
    const remote = path.join(sandbox, 'remote.git');
    const clone = path.join(project, '.teamai', 'team-repo');
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@teamai.test',
      GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@teamai.test',
      TEAMAI_NONINTERACTIVE: '1', GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0',
    };
    const git = (args: string[], cwd = sandbox!) => execFileSync('git', args, {
      cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true,
    }).trim();
    const run = (args: string[], expectedCode = 0) => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: project, env, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(expectedCode);
      return output;
    };
    git(['config', '--global', 'core.autocrlf', String(autocrlf)]);
    git(['config', '--global', 'core.hooksPath', path.join(sandbox, 'no-hooks')]);
    git(['config', '--global', 'gc.auto', '0']);
    git(['config', '--global', `url.${remote.replace(/\\/g, '/')}.insteadOf`, REPO_URL]);
    write(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'roundtrip', repo: REPO_URL, provider: 'git', usageReport: false,
    }));
    write(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify({
      version: 1,
      projects: ['first', 'second'].map((id) => ({ id, resources: { skills: [id] } })),
    }));
    for (const namespace of ['first', 'second']) {
      write(path.join(seed, 'skills', namespace, 'demo', 'SKILL.md'),
        `---\nname: demo\ndescription: Round trip fixture\n---\n\nFrom ${namespace}.\n`);
    }
    git(['init', '-q', '-b', 'main'], seed);
    git(['-c', 'core.autocrlf=false', 'add', '.'], seed);
    git(['commit', '-qm', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote]);
    git(['clone', '-q', REPO_URL, clone]);
    const configFile = path.join(project, '.teamai', 'config.yaml');
    write(configFile, YAML.stringify({
      repo: { kind: 'git', localPath: clone, remote: REPO_URL },
      username: 'member', provider: 'git', scope: 'project', projectRoot: project,
      updatePolicy: 'skip', projects: ['first'], additionalRoles: [], enabledAgents: ['claude'],
    }));
    const gitConfigBefore = fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8');
    run(['pull', '--force']);
    const delivered = path.join(project, '.claude', 'skills', 'demo', 'SKILL.md');
    const original = fs.readFileSync(delivered, 'utf8');
    expect(original.includes('\r\n')).toBe(autocrlf);
    fs.appendFileSync(delivered, '\nMember edit.\n');

    // The active namespace changes, but this edit still belongs to the first
    // copy. Matching only the name or the active namespace would misroute it.
    run(['projects', 'set', 'second']);
    run(['pull']);
    // Generic Git publishes a branch, then exits 1 because no host API can
    // open its review. Assert the remote contents rather than a success log.
    expect(run(['push', '--all'], 1)).toContain('Pushed branch teamai/push/');
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], remote)
      .split('\n').filter(Boolean);
    expect(branches).toHaveLength(1);
    const branch = branches[0]!;
    expect(git(['diff', '--name-only', 'main', branch], remote)).toContain('skills/first/demo/SKILL.md');
    expect(git(['show', `${branch}:skills/first/demo/SKILL.md`], remote)).toContain('Member edit.');
    expect(git(['show', `${branch}:skills/second/demo/SKILL.md`], remote)).not.toContain('Member edit.');

    // Accept the review on the disposable remote, then prove another pull
    // receives it. Neither the real user config nor a network host is used.
    git(['update-ref', 'refs/heads/main', git(['rev-parse', branch], remote)], remote);
    run(['projects', 'set', 'first']);
    fs.rmSync(path.dirname(delivered), { recursive: true });
    run(['pull', '--force']);
    expect(fs.readFileSync(delivered, 'utf8')).toContain('Member edit.');
    run(['push', '--all']);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], remote)
      .split('\n').filter(Boolean)).toEqual(branches);
    expect(fs.readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(gitConfigBefore);
  }, 180_000);
});

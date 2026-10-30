import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = path.join(ROOT, 'dist', 'index.js');
const OPENCODE = path.join(ROOT, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('OpenCode loads delivered agents', () => {
  it.each(['user', 'project'] as const)('loads the %s agent from a session in a subdirectory', (scope) => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-agent-loader-')));
    const home = path.join(sandbox, 'home');
    const project = path.join(sandbox, 'project');
    const subdir = path.join(project, 'src', 'nested');
    const xdg = path.join(sandbox, 'xdg');
    const seed = path.join(sandbox, 'seed');
    const clone = path.join(sandbox, 'team-clone');
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    for (const dir of [home, subdir, path.join(xdg, 'opencode'), path.join(project, '.opencode')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg,
      XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
      XDG_STATE_HOME: path.join(home, 'state'), OPENCODE_CONFIG_DIR: path.join(xdg, 'opencode'),
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'loader', GIT_AUTHOR_EMAIL: 'loader@teamai.test',
      GIT_COMMITTER_NAME: 'loader', GIT_COMMITTER_EMAIL: 'loader@teamai.test',
      TEAMAI_NONINTERACTIVE: '1', FORCE_COLOR: '0',
    };
    const git = (args: string[], cwd = sandbox!) => execFileSync('git', args, {
      cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true,
    });
    write(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'loader', repo: seed, provider: 'git', usageReport: false,
    }));
    write(path.join(seed, 'agents', 'loader-probe.yaml'), YAML.stringify({
      name: 'loader-probe', description: 'Verify the actual OpenCode loader',
      instructions: 'TEAMAI_REAL_LOADER_PROBE_1221',
    }));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '.'], seed);
    git(['commit', '-qm', 'seed'], seed);
    git(['clone', '-q', seed, clone]);
    git(['init', '-q'], project);
    write(path.join(scope === 'user' ? home : project, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { kind: 'git', localPath: clone, remote: seed },
      username: 'loader', scope, ...(scope === 'project' ? { projectRoot: project } : {}),
      updatePolicy: 'skip', enabledAgents: ['opencode'], additionalRoles: [],
    }));
    execFileSync(process.execPath, [CLI, 'pull', '--force'], {
      cwd: project, env, encoding: 'utf8', stdio: 'pipe', timeout: 60_000, windowsHide: true,
    });
    const loaded = execFileSync(OPENCODE, ['debug', 'agent', 'loader-probe', '--pure'], {
      cwd: subdir, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000, windowsHide: true,
    });
    expect(loaded).toContain('TEAMAI_REAL_LOADER_PROBE_1221');
  }, 120_000);
});

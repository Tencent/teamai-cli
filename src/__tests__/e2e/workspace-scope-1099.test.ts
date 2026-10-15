import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// ─── The workspace install scope (issue #1099) ──────────────────────────────
//
// The scope rooted at a directory is named `workspace`; `project` is its older
// name. Run through the compiled CLI: init accepts `--scope workspace`, a config
// an older CLI wrote with `scope: project` still loads and is not rewritten by a
// read-only command, and a command that saves the config writes `workspace`.
//
// The team remote is a synthetic HTTPS URL that git's `insteadOf` rewrites to a
// local bare repo, as in init-project-all.test.ts. The workspace is not a git
// repo, so its config stays at `<workspace>/.teamai/config.yaml`.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/workspace-scope.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('the workspace install scope (issue #1099)', () => {
  let sandbox: string;
  let home: string;
  let workspace: string;
  let configPath: string;
  let initResult: { code: number | null; output: string };
  let initConfig: string;

  const readConfig = (): Record<string, unknown> => YAML.parse(fs.readFileSync(configPath, 'utf8'));

  /** The config as a CLI older than #1099 wrote it: the one init wrote, with `scope: project`. */
  function writeOldConfig(): string {
    const old = initConfig.replace(/^scope: workspace$/m, 'scope: project');
    expect(old).toMatch(/^scope: project$/m);
    fs.writeFileSync(configPath, old);
    return old;
  }

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workspace-scope-e2e-'));
    home = path.join(sandbox, 'home');
    workspace = path.join(sandbox, 'workspace');
    configPath = path.join(workspace, '.teamai', 'config.yaml');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team.git');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });

    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: workspace-scope-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: common',
      '    resources:',
      '      knowledge: []',
      '      skills: [alpha]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: alpha',
      '    name: Alpha',
      '    resources:',
      '      skills: [alpha]',
      '',
    ].join('\n'));

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, home);

    initResult = await runCLI(
      ['init', FAKE_URL, '--scope', 'workspace', '--role', 'common', '--agent', 'claude', '--force'],
      workspace,
      home,
    );
    initConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('init --scope workspace installs into the directory and writes scope: workspace', () => {
    expect(initResult.code, initResult.output).toBe(0);
    expect(initResult.output).toMatch(/Scope: workspace /);
    expect(YAML.parse(initConfig).scope).toBe('workspace');
    expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml'))).toBe(false);
  });

  it('reads a scope: project config without rewriting it', async () => {
    const old = writeOldConfig();

    const status = await runCLI(['status'], workspace, home);
    const pull = await runCLI(['pull'], workspace, home);

    expect(status.code, status.output).toBe(0);
    expect(status.output).toMatch(/Scope: workspace /);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('[workspace]');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(old);
  });

  it('writes scope: workspace when a command saves a scope: project config', async () => {
    writeOldConfig();

    const result = await runCLI(['projects', 'set', 'alpha'], workspace, home);

    expect(result.code, result.output).toBe(0);
    expect(readConfig()).toMatchObject({ scope: 'workspace', projects: ['alpha'] });
  });

  it('says to update teamai when the config names a scope it does not know', async () => {
    fs.writeFileSync(configPath, initConfig.replace(/^scope: workspace$/m, 'scope: galaxy'));

    const result = await runCLI(['status'], workspace, home);

    expect(result.output).toContain('scope "galaxy" is not one this teamai knows; a newer teamai may have written it. Run `teamai update`');
  });
});

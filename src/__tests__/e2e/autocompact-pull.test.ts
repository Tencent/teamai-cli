/**
 * E2E: `sharing.autoCompact` reaches each installed tool's own config on pull,
 * leaves a member's own value alone, and is taken back when the team drops it.
 *
 * The team remote is a synthetic HTTPS URL that git's `insteadOf` rewrites to a
 * local bare repo in the sandbox HOME (see coauthor-project-local-settings.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const URL = 'https://git.example.com/team/autocompact.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

let sandbox: string;
let home: string;
let seed: string;
let remote: string;

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv } }).trim();
}

function runCLI(args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    FORCE_COLOR: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const v of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'CODEBUDDY_CONFIG_DIR', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CODEBUDDY_AUTO_COMPACT_WINDOW']) delete env[v];
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function publishTeam(autoCompact: boolean): void {
  writeFile(path.join(seed, 'teamai.yaml'), [
    'team: autocompact',
    `repo: ${URL}`,
    'provider: git',
    'reviewers: []',
    ...(autoCompact ? ['sharing:', '  autoCompact:', '    tokens: 400000'] : []),
    '',
  ].join('\n'));
  git(['add', '-A'], seed);
  git(['commit', '-q', '--allow-empty', '-m', autoCompact ? 'set autoCompact' : 'drop autoCompact'], seed);
  git(['push', '-q', remote, 'HEAD:main'], seed);
}

/** A machine of its own: a fresh HOME with Claude Code installed, reaching the team remote. */
function freshMachine(name: string): void {
  home = path.join(sandbox, name);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  git(['config', '--global', `url.${remote}.insteadOf`, URL], sandbox, { HOME: home, USERPROFILE: home });
}

/** A user-scope install in HOME and a workspace one in ~/work/p, both pulled; returns the workspace dir and its config file. */
async function installUserAndWorkspace(): Promise<{ project: string; workspaceConfig: string }> {
  const userInit = await runCLI(['init', URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'], home);
  expect(userInit.code, userInit.output).toBe(0);
  const userPull = await runCLI(['pull'], home);
  expect(userPull.code, userPull.output).toBe(0);
  const project = path.join(home, 'work', 'p');
  fs.mkdirSync(project, { recursive: true });
  git(['init', '-q', '-b', 'main'], project);
  const init = await runCLI(['init', URL, '--provider', 'git', '--agent', 'claude', '--force'], project);
  expect(init.code, init.output).toBe(0);
  const partitions = fs.readdirSync(path.join(home, '.teamai', 'projects'));
  expect(partitions).toHaveLength(1);
  return { project, workspaceConfig: path.join(home, '.teamai', 'projects', partitions[0], 'config.yaml') };
}

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'));
const readText = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');

describe.skipIf(process.platform === 'win32')('auto-compact threshold on pull', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-autocompact-e2e-')));
    seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'autocompact.git');
    writeFile(path.join(seed, 'skills', 'team-skill', 'SKILL.md'), '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes each tool\'s setting, keeps the member\'s own, and takes its values back when the team drops the policy', async () => {
    freshMachine('home-policy');
    publishTeam(true);
    for (const dir of ['.codex', '.codebuddy']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    writeFile(path.join(home, '.codex', 'config.toml'), '# mine\nmodel = "gpt-6.1-sol"\n\n[desktop]\nx = 1\n');
    // The member's own CodeBuddy value, which teamai must leave alone.
    writeFile(path.join(home, '.codebuddy', 'settings.json'), '{\n  "autoCompactWindow": 300000\n}\n');
    const init = await runCLI(['init', URL, '--provider', 'git', '--agent', 'claude,codex,codebuddy', '--scope', 'user', '--force'], home);
    expect(init.code, init.output).toBe(0);
    const pulled = await runCLI(['pull'], home);
    expect(pulled.code, pulled.output).toBe(0);
    expect(pulled.output).toMatch(/Auto-compact threshold applied to claude, codex/);

    expect(readJson('.claude/settings.json').autoCompactWindow).toBe(433_000);
    // Pull also records Codex hook trust under later tables; the key sits above them.
    expect(readText('.codex/config.toml')).toMatch(/^# mine\nmodel = "gpt-6\.1-sol"\n\nmodel_auto_compact_token_limit = 400000\n\n\[desktop\]\nx = 1\n/);
    expect(readJson('.codebuddy/settings.json').autoCompactWindow).toBe(300_000);

    const again = await runCLI(['pull'], home);
    expect(again.code, again.output).toBe(0);
    expect(again.output).not.toMatch(/Auto-compact threshold applied/);

    publishTeam(false);
    const dropped = await runCLI(['pull'], home);
    expect(dropped.code, dropped.output).toBe(0);
    expect(dropped.output).toMatch(/Removed the auto-compact setting teamai wrote for claude, codex/);
    expect(readJson('.claude/settings.json').autoCompactWindow).toBeUndefined();
    expect(readText('.codex/config.toml')).toMatch(/^# mine\nmodel = "gpt-6\.1-sol"\n\n\[desktop\]\nx = 1\n/);
    expect(readJson('.codebuddy/settings.json').autoCompactWindow).toBe(300_000);
  }, 180_000);

  it('keeps the user scope\'s value when a pull runs in a workspace that opts out', async () => {
    freshMachine('home-workspace-opt-out');
    publishTeam(true);
    const { project, workspaceConfig } = await installUserAndWorkspace();
    expect(readJson('.claude/settings.json').autoCompactWindow).toBe(433_000);
    fs.appendFileSync(workspaceConfig, 'autoCompactTokens: 0\n');

    const projectPull = await runCLI(['pull', '--force'], project);
    expect(projectPull.code, projectPull.output).toBe(0);
    expect(projectPull.output).not.toMatch(/Removed the auto-compact setting/);
    expect(readJson('.claude/settings.json').autoCompactWindow).toBe(433_000);
  }, 180_000);

  it('leaves the value alone while another process holds the user scope\'s sync lock, and applies the user scope\'s change once it is free', async () => {
    freshMachine('home-user-locked');
    publishTeam(true);
    const { project } = await installUserAndWorkspace();
    fs.appendFileSync(path.join(home, '.teamai', 'config.yaml'), 'autoCompactTokens: 300000\n');
    const lock = path.join(home, '.teamai', '.sync-lock');
    // A live holder: this test process.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'other-pull' }));

    const locked = await runCLI(['pull', '--force'], project);
    expect(locked.code, locked.output).toBe(0);
    expect(readJson('.claude/settings.json').autoCompactWindow).toBe(433_000);

    fs.rmSync(lock);
    const free = await runCLI(['pull', '--force'], project);
    expect(free.code, free.output).toBe(0);
    expect(readJson('.claude/settings.json').autoCompactWindow).toBe(333_000);
    expect(fs.existsSync(lock)).toBe(false);
  }, 180_000);
});

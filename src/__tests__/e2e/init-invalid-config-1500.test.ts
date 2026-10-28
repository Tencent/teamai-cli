/**
 * E2E (#1500, part 3): `init --force` over a workspace config that does not
 * validate keeps the settings that do, names each one it drops, and moves the
 * config aside only when it records another team repo.
 *
 * Runs the built CLI against local team repos. Each case gets its own HOME and
 * repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectSlug } from '../../utils/partition.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const TEAM_URL = 'https://git.example.test/team/a.git';
const OTHER_TEAM_URL = 'https://git.example.test/team/b.git';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
/** The bare repository each team URL is cloned from. */
const teamRemotes = new Map<string, string>();

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-invalid-config-1500-')));
  for (const [team, url] of [['a', TEAM_URL], ['b', OTHER_TEAM_URL]]) {
    const seed = path.join(sandbox, `team-${team}-seed`);
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), `team: ${team}\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '.'], seed);
    git(['commit', '-qm', 'seed'], seed);
    const remote = path.join(sandbox, `team-${team}.git`);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    teamRemotes.set(url, remote);
  }
});

afterAll(async () => {
  await waitForDetachedChildren();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV }): void {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
}

/** A member with a HOME of its own and a committed repository, `dir`, to init in. */
function member(name: string) {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  const dir = path.join(base, 'app');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', FORCE_COLOR: '0',
  };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  for (const [url, remote] of teamRemotes) git(['config', '--global', `url.${remote}.insteadOf`, url], base, env);
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], dir, env);
  git(['add', '.'], dir, env);
  git(['commit', '-qm', 'app'], dir, env);
  git(['remote', 'add', 'origin', `https://127.0.0.1:9/team/${name}.git`], dir, env);
  const root = fs.realpathSync.native(dir);
  const cli = (args: string[]): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end('');
  });
  return { cli, config: path.join(home, '.teamai', 'projects', projectSlug(root), 'config.yaml') };
}

const INIT = (url: string) => ['init', url, '--provider', 'git', '--agent', 'claude'];

/** Install `TEAM_URL`, then write `recallEnabled: "yes"` (not a boolean) and `coAuthorEnabled: false` into the config. */
async function withInvalidConfig(name: string, remote?: string) {
  const m = member(name);
  const first = await m.cli(INIT(TEAM_URL));
  expect(first.code, first.output).toBe(0);
  const installed: Record<string, unknown> & { repo: Record<string, unknown> } = YAML.parse(fs.readFileSync(m.config, 'utf8'));
  if (remote) installed.repo.remote = remote;
  fs.writeFileSync(m.config, YAML.stringify({ ...installed, recallEnabled: 'yes', coAuthorEnabled: false }));
  return m;
}

describe('init --force over a config that does not validate (#1500)', () => {
  it('keeps the settings that validate and names the one it drops, on the same team', async () => {
    const m = await withInvalidConfig('same-team');

    const again = await m.cli([...INIT(TEAM_URL), '--force']);
    expect(again.code, again.output).toBe(0);

    const saved: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    expect(saved.coAuthorEnabled).toBe(false);
    expect(saved).not.toHaveProperty('recallEnabled');
    expect(again.output).toContain('recallEnabled');
    expect(again.output).toContain('so it was dropped');
    expect(again.output).not.toContain("another install's config");
    expect(fs.existsSync(`${m.config}.previous`)).toBe(false);
  }, 120_000);

  it('carries the agents, the inherit-user-scope choice and the queued learnings as for a readable config', async () => {
    const m = member('same-team-carry');
    const first = await m.cli(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude,codex', '--inherit-user-scope']);
    expect(first.code, first.output).toBe(0);
    const installed: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    expect(installed.inheritUserScope).toBe(true);
    expect(installed.enabledAgents).toEqual(['claude', 'codex']);
    fs.writeFileSync(m.config, YAML.stringify({ ...installed, recallEnabled: 'yes' }));
    const queue = path.join(path.dirname(m.config), 'pending-learnings');
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, 'l1.md'), 'a learning\n');

    const again = await m.cli([...INIT(TEAM_URL), '--force']);
    expect(again.code, again.output).toBe(0);

    const saved: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    expect(saved).not.toHaveProperty('recallEnabled');
    expect(saved.inheritUserScope).toBe(true);
    expect(saved.enabledAgents).toEqual(['claude', 'codex']);
    expect(saved.disabledAgents ?? []).toEqual([]);
    expect(fs.existsSync(path.join(queue, 'l1.md'))).toBe(true);
    expect(fs.existsSync(`${queue}.unknown`)).toBe(false);
  }, 120_000);

  it('still moves the config aside when it records another team repo', async () => {
    const m = await withInvalidConfig('other-team', OTHER_TEAM_URL);

    const again = await m.cli([...INIT(TEAM_URL), '--force']);
    expect(again.code, again.output).toBe(0);

    expect(again.output).toContain("another install's config");
    expect(fs.existsSync(`${m.config}.previous`)).toBe(true);
  }, 120_000);
});

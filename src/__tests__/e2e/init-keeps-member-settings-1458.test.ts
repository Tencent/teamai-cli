/**
 * E2E (#1458): `init --force` in a workspace that is already set up keeps every
 * setting the member wrote in its config. A re-init decides only the install,
 * the role and project selection, the agents and the tool roots.
 *
 * Runs the built CLI against a local team repo, the single-repo mode and an
 * in-process HTTP backend. Each case gets its own HOME and repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { LocalConfigInput } from '../../types.js';
import { projectSlug } from '../../utils/partition.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { startMockServer, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const TEAM_URL = 'https://git.example.test/team/a.git';
const OTHER_TEAM_URL = 'https://git.example.test/team/b.git';
const API_KEY = 'e2e-http-key';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

/** The keys init writes on every run. Every other key is the member's own. */
type InitDecides = 'repo' | 'username' | 'provider' | 'scope' | 'projectRoot' | 'primaryRole' | 'additionalRoles'
  | 'projects' | 'resourceProfileVersion' | 'inheritUserScope' | 'enabledAgents' | 'disabledAgents' | 'toolRoots';

/** A value other than the default for each of the member's own keys. A key added to the config fails the type check here until it is listed. */
const MEMBER_SETTINGS = {
  updatePolicy: 'skip',
  subscribedTags: ['backend'],
  excludedSkills: ['noisy-skill'],
  recallEnabled: true,
  gitExcludeEnabled: false,
  contributeHintEnabled: false,
  mrHintEnabled: false,
  usageReportEnabled: false,
  coAuthorEnabled: false,
  autoCompactTokens: 0,
  codexTrustEnabled: false,
  ai: { tool: 'codex' },
  workflows: { tools: { default: 'codex' }, max_parallel: 2, auto_approve: true, sandbox: true, allow: { network: false, env: ['CI'] } },
  modelAliases: { 'gateway-model-42': 'claude-opus-4-1' },
  scoring: { isolation: 'verified', sessions: false, daily_limit: 0 },
  sessions: { publish: { attended: 'auto', unattended: 'off' } },
} satisfies Required<Omit<LocalConfigInput, InitDecides>>;

interface Run { code: number | null; output: string }

let sandbox: string;
let server: MockServerHandle;
/** The bare repository each team URL is cloned from. */
const teamRemotes = new Map<string, string>();

beforeAll(async () => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-keeps-settings-1458-')));
  server = await startMockServer({ apiKey: API_KEY });
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
  await server?.close();
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
  // Spawned asynchronously: the HTTP backend runs in this process.
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

const INITS: Array<[string, () => string[]]> = [
  ['a team repo', () => ['init', TEAM_URL, '--provider', 'git', '--agent', 'claude']],
  ['single-repo mode', () => ['init', '.', '--provider', 'git', '--agent', 'claude']],
  ['an HTTP team repo', () => ['init', '--http', server.url, '--token', API_KEY, '--agent', 'claude']],
];

describe('init --force in a workspace keeps the member\'s own settings (#1458)', () => {
  it.each(INITS)('keeps every setting the member wrote, on %s', async (name, args) => {
    const m = member(name.replaceAll(' ', '-'));
    const first = await m.cli(args());
    expect(first.code, first.output).toBe(0);
    const installed: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    fs.writeFileSync(m.config, YAML.stringify({ ...installed, ...MEMBER_SETTINGS }));

    const again = await m.cli([...args(), '--force']);
    expect(again.code, again.output).toBe(0);

    const saved: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    const kept = Object.fromEntries(Object.keys(MEMBER_SETTINGS).map((key) => [key, saved[key]]));
    expect(kept).toEqual(MEMBER_SETTINGS);
  }, 120_000);

  it('drops the tag subscription and skill exclusions when it switches to another team repo', async () => {
    const m = member('team-switch');
    const first = await m.cli(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude']);
    expect(first.code, first.output).toBe(0);
    const installed: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    fs.writeFileSync(m.config, YAML.stringify({ ...installed, ...MEMBER_SETTINGS }));

    const other = await m.cli(['init', OTHER_TEAM_URL, '--provider', 'git', '--agent', 'claude', '--force']);
    expect(other.code, other.output).toBe(0);

    // Tags and skill names belong to the team repo they were chosen from; the rest hold on any team.
    const { subscribedTags: _tags, excludedSkills: _skills, ...elsewhere } = MEMBER_SETTINGS;
    const saved: Record<string, unknown> = YAML.parse(fs.readFileSync(m.config, 'utf8'));
    expect(saved).not.toHaveProperty('subscribedTags');
    expect(saved).not.toHaveProperty('excludedSkills');
    expect(Object.fromEntries(Object.keys(elsewhere).map((key) => [key, saved[key]]))).toEqual(elsewhere);
  }, 120_000);
});

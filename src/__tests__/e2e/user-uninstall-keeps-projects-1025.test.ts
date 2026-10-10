/**
 * E2E (#1025): uninstalling the user scope keeps the data of every project
 * still set up on the machine, so `teamai uninstall` in that project still
 * finds its config and removes what it installed.
 *
 * Before, the user-scope uninstall removed all of `~/.teamai`, the project
 * partitions under `projects/` with it. The project's own uninstall then found
 * no config, said "Nothing to uninstall" and left its skills and rules behind.
 *
 * Each team remote is a local bare repo reached through a synthetic HTTPS URL
 * that git's `insteadOf` rewrites, so no network is touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
let detached: ReturnType<typeof trackDetachedProcesses>;

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '0',
  };
  delete e.CLAUDE_CONFIG_DIR;
  delete e.CODEX_HOME;
  e.NODE_OPTIONS = [e.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' ');
  return e;
}

function run(command: string, args: string[], cwd: string): Run {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(args: string[], cwd: string): void {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.output}`);
}

async function teamai(args: string[], cwd: string): Promise<Run> {
  const r = run(process.execPath, [CLI, ...args], cwd);
  await detached.waitForExit();
  return r;
}

/** A team remote with one role skill and one rule, each named after the team; returns its URL. */
function team(name: string): string {
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  write(path.join(seed, 'teamai.yaml'), `team: ${name}\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
  write(path.join(seed, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: fe\n    resources:\n      knowledge: [fe]\n      skills: [fe]\n');
  write(path.join(seed, 'skills', 'fe', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: ${name} fixture\n---\n\nBody.\n`);
  write(path.join(seed, 'rules', `${name}-rule.md`), `# ${name}\n\n${name} rule.\n`);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['clone', '-q', '--bare', seed, remote], sandbox);
  git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  return url;
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-user-uninstall-1025-e2e-')));
  detached = trackDetachedProcesses(sandbox);
  home = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
});

afterAll(async () => {
  if (detached) await detached.waitForExit();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}, 65_000);

// The hook scripts are POSIX shell.
describe.skipIf(process.platform === 'win32')('user-scope uninstall keeps the projects still set up (#1025)', () => {
  it('the project\'s own uninstall still removes what it installed', async () => {
    const userUrl = team('orgteam');
    const projectUrl = team('projteam');
    const app = path.join(sandbox, 'app');
    write(path.join(app, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], app);
    git(['add', '-A'], app);
    git(['commit', '-q', '-m', 'app'], app);
    const init = ['--provider', 'git', '--agent', 'claude', '--role', 'fe', '--force'];
    const userInit = await teamai(['init', userUrl, '--scope', 'user', ...init], home);
    expect(userInit.code, userInit.output).toBe(0);
    const projectInit = await teamai(['init', projectUrl, '--scope', 'project', ...init], app);
    expect(projectInit.code, projectInit.output).toBe(0);

    const teamaiHome = path.join(home, '.teamai');
    const [slug] = fs.readdirSync(path.join(teamaiHome, 'projects'));
    const partition = path.join(teamaiHome, 'projects', slug);
    const projectConfig = fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8');
    const projectSkill = path.join(app, '.claude', 'skills', 'projteam-skill');
    const projectRule = path.join(app, '.claude', 'rules', 'projteam-rule.md');
    expect(fs.existsSync(projectSkill)).toBe(true);
    expect(fs.existsSync(projectRule)).toBe(true);

    const user = await teamai(['uninstall', '--force'], home);
    expect(user.code, user.output).toBe(0);
    expect(user.output).toContain(`Kept the data of 1 project(s) still set up on this machine: ${app}. Run \`teamai uninstall\` in each project`);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'orgteam-skill'))).toBe(false);
    expect(fs.existsSync(path.join(teamaiHome, 'config.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8')).toBe(projectConfig);
    expect(fs.existsSync(projectSkill)).toBe(true);

    const project = await teamai(['uninstall', '--force'], app);
    expect(project.code, project.output).toBe(0);
    expect(project.output).toContain('teamai uninstalled');
    expect(fs.existsSync(projectSkill)).toBe(false);
    expect(fs.existsSync(projectRule)).toBe(false);
    expect(fs.existsSync(partition)).toBe(false);

    // What the user scope kept for the project goes once it is the last thing left.
    const rest = await teamai(['uninstall', '--force'], home);
    expect(rest.code, rest.output).toBe(0);
    expect(fs.existsSync(teamaiHome)).toBe(false);
  });
});

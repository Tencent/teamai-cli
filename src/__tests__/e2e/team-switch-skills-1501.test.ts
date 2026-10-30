/**
 * E2E (#1501 part 2): `init <other team> --force` is how a workspace moves to
 * another team. The pull after it removes the old team's skills that teamai
 * recorded delivering and the member did not edit, in every tool it wrote
 * them to, as it removes a skill the team deletes. A copy the member edited is
 * kept and named.
 *
 * Runs the built CLI with an isolated HOME and two local bare team repos
 * reached through `url.<path>.insteadOf`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};
const FRONTEND_URL = 'https://git.example.test/team/frontend.git';
const PLATFORM_URL = 'https://git.example.test/team/platform.git';

interface Run { code: number | null; output: string }

let sandbox: string;
let home: string;
let app: string;
let env: NodeJS.ProcessEnv;

const skillMd = (name: string, body: string): string => `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
}

function teamai(args: string[], cwd = app, runEnv = env): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: runEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  if (run.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${run.output}`);
  return run;
}

/** A team repo at `url` holding `files`, as a local bare repo. */
function team(name: string, url: string, files: Record<string, string>): void {
  const seed = path.join(sandbox, `${name}-seed`);
  writeFile(path.join(seed, 'teamai.yaml'), `team: ${name}\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'seed'], seed);
  const remote = path.join(sandbox, `${name}.git`);
  git(['clone', '-q', '--bare', seed, remote], sandbox);
  git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
}

const exists = (rel: string): boolean => fs.existsSync(path.join(app, rel));

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-switch-1501-')));
  home = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  env = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', FORCE_COLOR: '0',
  };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.HERMES_HOME;
  team('frontend', FRONTEND_URL, {
    'skills/react-review/SKILL.md': skillMd('react-review', 'Review React components.'),
    'skills/react-review/checklist.md': '- hooks rules\n',
    'skills/storybook/SKILL.md': skillMd('storybook', 'Write stories.'),
    'rules/frontend-style.md': '# Frontend style\n\nUse function components.\n',
  });
  team('platform', PLATFORM_URL, {
    'skills/terraform-plan/SKILL.md': skillMd('terraform-plan', 'Plan infra changes.'),
    'rules/platform-style.md': '# Platform style\n\nPin provider versions.\n',
  });
  app = path.join(sandbox, 'app');
  writeFile(path.join(app, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], app);
  git(['add', '-A'], app);
  git(['commit', '-qm', 'app'], app);
  app = fs.realpathSync.native(app);
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('init <other team> --force, then pull (#1501 part 2)', () => {
  it('removes the old team\'s unedited skills from every tool, keeps and names an edited one, and delivers the new team', () => {
    const agents = ['--provider', 'git', '--agent', 'claude,codex', '--scope', 'project'];
    teamai(['init', FRONTEND_URL, ...agents]);
    teamai(['pull']);
    for (const dir of ['.claude/skills', '.codex/skills']) {
      expect(exists(`${dir}/react-review/SKILL.md`), dir).toBe(true);
      expect(exists(`${dir}/storybook/SKILL.md`), dir).toBe(true);
    }
    fs.appendFileSync(path.join(app, '.claude/skills/storybook/SKILL.md'), '\nMy own notes.\n');

    teamai(['init', PLATFORM_URL, ...agents, '--force']);
    const pulled = teamai(['pull']);

    for (const dir of ['.claude/skills', '.codex/skills']) {
      expect(exists(`${dir}/react-review`), dir).toBe(false);
      expect(exists(`${dir}/terraform-plan/SKILL.md`), dir).toBe(true);
    }
    expect(exists('.codex/skills/storybook'), pulled.output).toBe(false);
    expect(fs.readFileSync(path.join(app, '.claude/skills/storybook/SKILL.md'), 'utf8')).toContain('My own notes.');
    const kept = path.join(app, '.claude', 'skills', 'storybook');
    expect(pulled.output.split(kept).length - 1, pulled.output).toBe(1);
    expect(pulled.output).toContain(`Kept ${kept}: teamai no longer delivers storybook here, but you changed this copy.`);
    expect(exists('.claude/rules/frontend-style.md')).toBe(false);
    expect(exists('.claude/rules/platform-style.md')).toBe(true);
  }, 120_000);

  it('removes the old team\'s skills from Codex\'s shared ~/.agents/skills in user scope', () => {
    const userHome = path.join(sandbox, 'user-home');
    fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
    const userEnv = { ...env, HOME: userHome, USERPROFILE: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') };
    for (const [url, remote] of [[FRONTEND_URL, 'frontend'], [PLATFORM_URL, 'platform']]) {
      const r = spawnSync('git', ['config', '--global', `url.${path.join(sandbox, `${remote}.git`)}.insteadOf`, url], { env: userEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const shared = path.join(userHome, '.agents', 'skills');
    // An older release's copy of one frontend skill there: every frontend skill follows it.
    writeFile(path.join(shared, 'react-review', 'SKILL.md'), skillMd('react-review', 'Review React components.'));
    writeFile(path.join(shared, 'react-review', 'checklist.md'), '- hooks rules\n');
    const agents = ['--provider', 'git', '--agent', 'codex', '--scope', 'user'];
    teamai(['init', FRONTEND_URL, ...agents], userHome, userEnv);
    teamai(['pull'], userHome, userEnv);
    expect(fs.existsSync(path.join(shared, 'storybook', 'SKILL.md'))).toBe(true);

    teamai(['init', PLATFORM_URL, ...agents, '--force'], userHome, userEnv);
    const pulled = teamai(['pull'], userHome, userEnv);

    expect(fs.existsSync(path.join(shared, 'react-review')), pulled.output).toBe(false);
    expect(fs.existsSync(path.join(shared, 'storybook')), pulled.output).toBe(false);
    expect(fs.existsSync(path.join(userHome, '.codex', 'skills', 'terraform-plan', 'SKILL.md')), pulled.output).toBe(true);
  }, 120_000);

  it('keeps the skills in Hermes\' one directory that the user scope still delivers', () => {
    const userHome = path.join(sandbox, 'hermes-home');
    fs.mkdirSync(path.join(userHome, '.hermes'), { recursive: true });
    const userEnv = { ...env, HOME: userHome, USERPROFILE: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') };
    for (const [url, remote] of [[FRONTEND_URL, 'frontend'], [PLATFORM_URL, 'platform']]) {
      const r = spawnSync('git', ['config', '--global', `url.${path.join(sandbox, `${remote}.git`)}.insteadOf`, url], { env: userEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const project = path.join(userHome, 'work', 'app');
    writeFile(path.join(project, 'README.md'), '# app\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'app']]) {
      const r = spawnSync('git', args, { cwd: project, env: userEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const hermesSkills = path.join(userHome, '.hermes', 'skills');
    teamai(['init', FRONTEND_URL, '--provider', 'git', '--agent', 'hermes', '--scope', 'user'], userHome, userEnv);
    teamai(['pull'], userHome, userEnv);
    const inProject = ['--provider', 'git', '--agent', 'hermes', '--scope', 'project'];
    teamai(['init', FRONTEND_URL, ...inProject], project, userEnv);
    teamai(['pull'], project, userEnv);
    expect(fs.existsSync(path.join(hermesSkills, 'react-review', 'SKILL.md'))).toBe(true);

    teamai(['init', PLATFORM_URL, ...inProject, '--force'], project, userEnv);
    const pulled = teamai(['pull'], project, userEnv);

    expect(fs.existsSync(path.join(hermesSkills, 'react-review', 'SKILL.md')), pulled.output).toBe(true);
    expect(fs.existsSync(path.join(hermesSkills, 'storybook', 'SKILL.md')), pulled.output).toBe(true);
    expect(fs.existsSync(path.join(hermesSkills, 'terraform-plan', 'SKILL.md')), pulled.output).toBe(true);
    expect(pulled.output).not.toContain('no longer delivered here');
  }, 120_000);

  it('keeps the skills the user scope delivers in OpenClaw\'s workspace when the project is that workspace', () => {
    const userHome = path.join(sandbox, 'openclaw-home');
    const workspace = path.join(userHome, '.openclaw', 'workspace');
    writeFile(path.join(userHome, '.openclaw', 'openclaw.json'), '{}\n');
    const userEnv = { ...env, HOME: userHome, USERPROFILE: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') };
    for (const [url, remote] of [[FRONTEND_URL, 'frontend'], [PLATFORM_URL, 'platform']]) {
      const r = spawnSync('git', ['config', '--global', `url.${path.join(sandbox, `${remote}.git`)}.insteadOf`, url], { env: userEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    writeFile(path.join(workspace, 'README.md'), '# workspace\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'workspace']]) {
      const r = spawnSync('git', args, { cwd: workspace, env: userEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    }
    const skills = path.join(workspace, 'skills');
    teamai(['init', FRONTEND_URL, '--provider', 'git', '--agent', 'openclaw', '--scope', 'user'], userHome, userEnv);
    teamai(['pull'], userHome, userEnv);
    const inProject = ['--provider', 'git', '--agent', 'openclaw', '--scope', 'project'];
    teamai(['init', FRONTEND_URL, ...inProject], workspace, userEnv);
    teamai(['pull'], workspace, userEnv);
    expect(fs.existsSync(path.join(skills, 'react-review', 'SKILL.md'))).toBe(true);

    teamai(['init', PLATFORM_URL, ...inProject, '--force'], workspace, userEnv);
    const pulled = teamai(['pull'], workspace, userEnv);

    expect(fs.existsSync(path.join(skills, 'react-review', 'SKILL.md')), pulled.output).toBe(true);
    expect(fs.existsSync(path.join(skills, 'storybook', 'SKILL.md')), pulled.output).toBe(true);
    expect(fs.existsSync(path.join(skills, 'terraform-plan', 'SKILL.md')), pulled.output).toBe(true);
    expect(pulled.output).not.toContain('no longer delivered here');
  }, 120_000);
});

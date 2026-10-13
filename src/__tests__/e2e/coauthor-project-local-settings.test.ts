/**
 * E2E (#993 bug 7): in project scope the co-author setting is personal, so it
 * goes to `.claude/settings.local.json`, never into the team's tracked
 * `.claude/settings.json` or another Claude-family tool's shared project
 * settings. An `attribution` an earlier release wrote to the shared file is
 * removed on the next pull, byte-preserving, only when it is teamai's.
 *
 * The team remote is a synthetic HTTPS URL that git's `insteadOf` rewrites to a
 * local bare repo in the sandbox HOME (see init-ends-with-pull.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/coauthor.git';
/** A team whose `toolPaths` defines its own tool (replacing the defaults). */
const CUSTOM_URL = 'https://git.example.com/team/coauthor-custom.git';
/** A team with no co-author policy (e.g. it dropped `sharing.coAuthor`). */
const NO_CHOICE_URL = 'https://git.example.com/team/coauthor-none.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

/** The team's tracked settings, formatted the way writeJson would not. */
const TEAM_SETTINGS = '{\n  "permissions": {\n    "allow": ["Bash(npm test)"]\n  }\n}\n';

const CLAUDE_FAMILY = ['claude-internal', 'tclaude', 'qoder', 'qoder-cn', 'codebuddy', 'workbuddy'];

let sandbox: string;
let home: string;
const remotes: Record<string, string> = {};

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', ...extraEnv },
  }).trim();
}

/** Init no longer copies team resources. The co-author setting is written by pull. */
async function initThenPull(project: string, args: string[]): Promise<{ code: number | null; output: string }> {
  const started = await runCLI(['init', ...args], project);
  expect(started.code, started.output).toBe(0);
  const pulled = await runCLI(['pull'], project);
  expect(pulled.code, pulled.output).toBe(0);
  return { code: pulled.code, output: `${started.output}${pulled.output}` };
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
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A business repo that tracks the team's `.claude/settings.json`. */
function makeBusinessRepo(): string {
  const dir = path.join(sandbox, `app-${Math.random().toString(36).slice(2)}`);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  writeFile(path.join(dir, '.claude', 'settings.json'), TEAM_SETTINGS);
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'app'], dir);
  return dir;
}

/** Tracked files the CLI modified (untracked files are #915's concern). */
function modifiedTracked(dir: string): string[] {
  return git(['status', '--porcelain', '--untracked-files=no'], dir).split('\n').filter(Boolean);
}

/** Find the project scope's state.json (the one naming `marker`) in the sandbox data home. */
function findStateFile(dir: string, marker: string): string {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = (() => { try { return findStateFile(full, marker); } catch { return null; } })();
      if (found) return found;
    } else if (entry.name === 'state.json' && fs.readFileSync(full, 'utf8').includes(marker)) {
      return full;
    }
  }
  throw new Error(`no state.json naming ${marker} under ${dir}`);
}

/**
 * Put the project in the state an earlier release left: `attribution` in the
 * tracked settings file, committed, and the co-author record listing that file.
 */
function simulatePreFix(project: string, settingsText: string): void {
  const shared = path.join(project, '.claude', 'settings.json');
  writeFile(shared, settingsText);
  git(['commit', '-q', '-am', 'settings written by an earlier teamai'], project);
  const stateFile = findStateFile(path.join(home, '.teamai'), project);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { coAuthorManaged?: Record<string, boolean> };
  state.coAuthorManaged = { ...state.coAuthorManaged, [shared]: false };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/** A bare team repo reached through `url`, whose team disables the trailer unless `coAuthor` is false. */
function makeRemote(url: string, extraYaml: string[], coAuthor = true): void {
  const name = path.basename(url, '.git');
  const seed = path.join(sandbox, `seed-${name}`);
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`,
    `repo: ${url}`,
    'provider: git',
    'reviewers: []',
    ...(coAuthor ? ['sharing:', '  coAuthor:', '    enabled: false'] : []),
    ...extraYaml,
    '',
  ].join('\n'));
  writeFile(path.join(seed, 'skills', 'team-skill', 'SKILL.md'),
    '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  remotes[url] = path.join(sandbox, `${name}.git`);
  git(['clone', '-q', '--bare', seed, remotes[url]], sandbox);
}

describe.skipIf(process.platform === 'win32')('co-author setting in project scope (#993 bug 7)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-coauthor-e2e-')));
    makeRemote(FAKE_URL, []);
    makeRemote(NO_CHOICE_URL, [], false);
    makeRemote(CUSTOM_URL, [
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '    settings: .claude/settings.json',
      '  teamtool:',
      '    skills: .teamtool/skills',
      '    settings: .teamtool/settings.json',
    ]);
  });

  beforeEach(() => {
    home = path.join(sandbox, `home-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    for (const [url, remote] of Object.entries(remotes)) {
      git(['config', '--global', `url.${remote}.insteadOf`, url], sandbox, { HOME: home, USERPROFILE: home });
    }
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('writes attribution to settings.local.json and leaves the tracked settings.json unchanged', async () => {
    const project = makeBusinessRepo();
    const result = await initThenPull(project, [FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force']);
    expect(result.output).toMatch(/Co-author trailer disabled for claude/);

    expect(modifiedTracked(project), result.output).toEqual([]);
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8')).toBe(TEAM_SETTINGS);
    const local = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.attribution).toEqual({ commit: '', pr: '' });
  }, 90_000);

  it('leaves a settings.local.json that does not parse as it is, and writes the setting once it parses', async () => {
    const project = makeBusinessRepo();
    const localFile = path.join(project, '.claude', 'settings.local.json');
    const broken = '{ "permissions": { "allow": ["Bash(npm test)"] }, \n';
    writeFile(localFile, broken);
    await initThenPull(project, [FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force']);
    expect(fs.readFileSync(localFile, 'utf8')).toBe(broken);

    writeFile(localFile, '{ "permissions": { "allow": ["Bash(npm test)"] } }\n');
    const pulled = await runCLI(['pull'], project);
    expect(pulled.code, pulled.output).toBe(0);
    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    expect(local.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(local.attribution).toEqual({ commit: '', pr: '' });
  }, 90_000);

  it('writes no project settings file of any other Claude-family tool', async () => {
    const project = makeBusinessRepo();
    const result = await initThenPull(project, [FAKE_URL, '--scope', 'project', '--agent', ['claude', ...CLAUDE_FAMILY].join(','), '--force']);
    expect(result.output).toMatch(/Co-author trailer disabled for claude\./);

    for (const tool of CLAUDE_FAMILY) {
      const settings = path.join(project, tool === 'qoder-cn' ? '.qoder' : `.${tool}`, 'settings.json');
      expect(fs.existsSync(settings), `${tool}: ${settings} was written\n${result.output}`).toBe(false);
    }
    expect(modifiedTracked(project)).toEqual([]);
  }, 90_000);

  it('writes no project settings file of a team-defined tool', async () => {
    const project = makeBusinessRepo();
    const result = await initThenPull(project, [CUSTOM_URL, '--scope', 'project', '--agent', 'claude,teamtool', '--force']);
    expect(result.output).toMatch(/Co-author trailer disabled for claude\./);
    expect(fs.existsSync(path.join(project, '.teamtool', 'skills')), result.output).toBe(true);
    expect(fs.existsSync(path.join(project, '.teamtool', 'settings.json')), result.output).toBe(false);
  }, 90_000);

  it('removes the attribution an earlier release wrote to the tracked settings.json, keeping every other byte', async () => {
    const project = makeBusinessRepo();
    await initThenPull(project, [FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force']);

    const before = '{\n  "permissions": {\n    "allow": ["Bash(npm test)"]\n  },\n'
      + '  "attribution": {\n    "commit": "",\n    "pr": ""\n  },\n  "model":   "opus"\n}\n';
    simulatePreFix(project, before);

    const pull = await runCLI(['pull'], project);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toMatch(/Removed the co-author setting an earlier teamai wrote to .*settings\.json/);
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'))
      .toBe('{\n  "permissions": {\n    "allow": ["Bash(npm test)"]\n  },\n  "model":   "opus"\n}\n');
    const local = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.attribution).toEqual({ commit: '', pr: '' });
  }, 120_000);

  it('leaves an attribution in the tracked settings.json alone when it is not teamai\'s value', async () => {
    const project = makeBusinessRepo();
    await initThenPull(project, [FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force']);

    const before = '{\n  "attribution": {"commit": "Team trailer", "pr": ""},\n  "model": "opus"\n}\n';
    simulatePreFix(project, before);

    const pull = await runCLI(['pull'], project);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).not.toMatch(/Removed the co-author setting/);
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(modifiedTracked(project)).toEqual([]);
  }, 120_000);

  it('moves a pre-fix attribution to settings.local.json when no co-author choice exists', async () => {
    const project = makeBusinessRepo();
    await initThenPull(project, [NO_CHOICE_URL, '--scope', 'project', '--agent', 'claude', '--force']);
    expect(fs.existsSync(path.join(project, '.claude', 'settings.local.json'))).toBe(false);

    const before = '{\n  "permissions": {\n    "allow": ["Bash(npm test)"]\n  },\n'
      + '  "attribution": {\n    "commit": "",\n    "pr": ""\n  },\n  "model":   "opus"\n}\n';
    simulatePreFix(project, before);

    const pull = await runCLI(['pull'], project);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toMatch(/Moved the co-author setting an earlier teamai wrote to .*settings\.json/);
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'))
      .toBe('{\n  "permissions": {\n    "allow": ["Bash(npm test)"]\n  },\n  "model":   "opus"\n}\n');
    const local = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    expect(local.attribution).toEqual({ commit: '', pr: '' });

    // Settled: the next pull has nothing left to move.
    const again = await runCLI(['pull'], project);
    expect(again.code, again.output).toBe(0);
    expect(again.output).not.toMatch(/Moved the co-author setting/);
  }, 150_000);

  it('leaves a different attribution in the tracked settings.json alone when no co-author choice exists', async () => {
    const project = makeBusinessRepo();
    await initThenPull(project, [NO_CHOICE_URL, '--scope', 'project', '--agent', 'claude', '--force']);

    const before = '{\n  "attribution": {"commit": "Team trailer", "pr": ""},\n  "model": "opus"\n}\n';
    simulatePreFix(project, before);

    const pull = await runCLI(['pull'], project);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).not.toMatch(/co-author setting/);
    expect(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(modifiedTracked(project)).toEqual([]);
    expect(fs.existsSync(path.join(project, '.claude', 'settings.local.json'))).toBe(false);
  }, 120_000);
});

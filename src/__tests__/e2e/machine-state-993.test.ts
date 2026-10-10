/**
 * E2E (#993 bug 4): teamai keeps no machine state in the working tree.
 *
 * The managed-hooks index (the record of the team hooks teamai wrote) and the
 * package lock used to land in `<project>/.teamai/`, where `git add -A`
 * commits them. They live in the data home now: the hook index per checkout,
 * like `managed-mcp.json`, and the lock beside the project's config. What an
 * older release left in the tree is moved on the next pull, install or status
 * read; a tracked hook index is left for the member and named by doctor.
 *
 * Each case gets its own team remote: a local bare repo reached through a
 * synthetic HTTPS URL (`url.<path>.insteadOf` in the sandbox HOME).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex } from '../helpers/fake-codex.js';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string; stdout: string }

let sandbox: string;
let home: string;
let fakeCodexDir: string;
let stubBin: string;
let detached: ReturnType<typeof trackDetachedProcesses>;

function env(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    CODEX_HOME: path.join(home, '.codex'),
    PATH: [stubBin, fakeCodexDir, process.env.PATH ?? ''].join(path.delimiter),
    NODE_OPTIONS: detached.nodeOptions,
    FORCE_COLOR: '0',
  };
  delete base.CLAUDE_CONFIG_DIR;
  return base;
}

function run(command: string, args: string[], cwd: string, input = ''): Run {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), input });
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}

function gitOk(args: string[], cwd: string): string {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
  return r.stdout;
}

const teamai = (args: string[], cwd: string, input = ''): Run => run(process.execPath, [CLI, ...args], cwd, input);

function teamaiOk(args: string[], cwd: string): Run {
  const r = teamai(args, cwd);
  if (r.code !== 0) throw new Error(`teamai ${args.join(' ')} failed: ${r.output}`);
  return r;
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A team: a seed checkout and the bare remote its synthetic URL reaches. */
interface Team { url: string; publish(files: Record<string, string>, message: string): void }

function team(name: string, files: Record<string, string>, extra: string[] = []): Team {
  const url = `https://git.example.com/team/${name}.git`;
  const seed = path.join(sandbox, `${name}-seed`);
  const remote = path.join(sandbox, `${name}.git`);
  writeFile(path.join(seed, 'teamai.yaml'), [
    `team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []',
    'sharing:', '  hooks:', '    autoApply: true', '    requireTeamScripts: false', ...extra, '',
  ].join('\n'));
  gitOk(['init', '-q', '-b', 'main'], seed);
  const publish = (next: Record<string, string>, message: string): void => {
    for (const [rel, content] of Object.entries(next)) writeFile(path.join(seed, rel), content);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', message], seed);
    if (fs.existsSync(remote)) gitOk(['push', '-q', remote, 'main'], seed);
  };
  publish(files, 'seed');
  gitOk(['clone', '-q', '--bare', seed, remote], sandbox);
  gitOk(['config', '--global', `url.${remote}.insteadOf`, url], sandbox);
  return { url, publish };
}

/** A git business repo with one commit, then `files` written untracked. */
function business(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(sandbox, name);
  writeFile(path.join(dir, 'README.md'), '# app\n');
  gitOk(['init', '-q', '-b', 'main'], dir);
  gitOk(['add', '-A'], dir);
  gitOk(['commit', '-q', '-m', 'app'], dir);
  for (const [rel, content] of Object.entries(files)) writeFile(path.join(dir, rel), content);
  return fs.realpathSync.native(dir);
}

const init = (t: Team, dir: string, agents: string): Run =>
  teamaiOk(['init', t.url, '--provider', 'git', '--agent', agents, '--scope', 'project', '--force'], dir);

/** What git sees under `.teamai/`, ignored files included. */
const teamaiStatus = (dir: string): string => gitOk(['status', '--porcelain', '-uall', '--ignored', '--', '.teamai'], dir);

const hooksYaml = (id: string, command: string): string =>
  `hooks:\n  - id: ${id}\n    description: Team stop\n    event: Stop\n    command: ${command}\n`;

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, 'utf8'));
const notBuiltin = (command: string): boolean => !command.includes('teamai hook-dispatch');
/** The commands of the Copilot Stop entries in the project, built-ins left out. */
const copilotStops = (dir: string): string[] =>
  (readJson(path.join(dir, '.github', 'hooks', 'teamai.json')).hooks?.Stop ?? [])
    .map((e: { bash: string }) => e.bash).filter(notBuiltin);
/** The commands of the Codex Stop entries in the project, built-ins left out. */
const codexStops = (dir: string): string[] =>
  (readJson(path.join(dir, '.codex', 'hooks.json')).hooks?.Stop ?? [])
    .map((e: { hooks: Array<{ command: string }> }) => e.hooks[0].command).filter(notBuiltin);

describe('no machine state in the working tree (#993 bug 4)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-machine-state-e2e-')));
    home = path.join(sandbox, 'home');
    for (const tool of ['.claude', '.codex', '.copilot']) fs.mkdirSync(path.join(home, tool), { recursive: true });
    fakeCodexDir = installFakeCodex();
    // An `npm` that succeeds without touching the network.
    stubBin = path.join(sandbox, 'stub-bin');
    writeFile(path.join(stubBin, 'npm'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(stubBin, 'npm'), 0o755);
    detached = trackDetachedProcesses(sandbox);
  });

  afterAll(async () => {
    if (detached) await detached.waitForExit();
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (fakeCodexDir) fs.rmSync(fakeCodexDir, { recursive: true, force: true });
  });

  it('keeps the Copilot hook index of a git project out of the tree, and still updates its team hook', () => {
    const t = team('copilot-hooks', { 'hooks/hooks.yaml': hooksYaml('team-stop', 'echo team-stop-v1') });
    const dir = business('copilot-biz');

    init(t, dir, 'claude,copilot');
    teamaiOk(['pull'], dir);
    expect(copilotStops(dir)).toEqual(['echo team-stop-v1']);
    expect(teamaiStatus(dir)).toBe('');

    // The index is what lets the next pull replace the team's entry.
    t.publish({ 'hooks/hooks.yaml': hooksYaml('team-stop', 'echo team-stop-v2') }, 'v2');
    teamaiOk(['pull'], dir);
    expect(copilotStops(dir)).toEqual(['echo team-stop-v2']);
    expect(teamaiStatus(dir)).toBe('');
  });

  /**
   * The tree an older release left: its hook index in `.teamai/`, recording a
   * Copilot entry and a pre-#370 Codex entry the team has since dropped.
   */
  const legacyTree = (): Record<string, string> => ({
    '.teamai/managed-hooks.json': JSON.stringify({
      copilot: [{ id: 'old-stop', event: 'Stop', command: 'echo old-copilot-stop' }],
      codex: [{ id: 'old-stop', event: 'Stop', command: 'echo old-codex-stop' }],
    }),
    '.github/hooks/teamai.json': JSON.stringify({ version: 1, hooks: { Stop: [
      { type: 'command', bash: 'echo old-copilot-stop', command: 'echo old-copilot-stop' },
    ] } }),
    '.codex/hooks.json': JSON.stringify({ hooks: { Stop: [
      { hooks: [{ type: 'command', command: 'echo old-codex-stop' }] },
    ] } }),
  });

  it('moves the Copilot records out of an older hook index, keeps the pre-#370 Codex import, and deletes the emptied file', () => {
    const t = team('legacy-index', { 'hooks/hooks.yaml': hooksYaml('team-stop', 'echo team-stop') });
    const dir = business('legacy-index-biz', legacyTree());

    init(t, dir, 'claude,codex,copilot');

    // Both recorded entries were teamai's, so both are gone: the Copilot one
    // through the moved record, the Codex one through the pre-#370 import.
    expect(copilotStops(dir)).toEqual(['echo team-stop']);
    expect(codexStops(dir)).toEqual(['echo team-stop']);
    expect(fs.existsSync(path.join(dir, '.teamai', 'managed-hooks.json'))).toBe(false);
    expect(teamaiStatus(dir)).toBe('');

    teamaiOk(['pull'], dir);
    expect(copilotStops(dir)).toEqual(['echo team-stop']);
    expect(teamaiStatus(dir)).toBe('');
  });

  it('keeps the hook index of a self-mode repo out of the tree and out of commits, and ignores it in older installs', () => {
    const repo = business('self-biz');
    gitOk(['remote', 'add', 'origin', 'https://127.0.0.1:9/team/self-biz.git'], repo);
    teamaiOk(['init', '.', '--provider', 'git', '--agent', 'claude'], repo);
    const yaml = path.join(repo, '.teamai', 'teamai.yaml');
    // `sharing:` is the last key init writes.
    fs.appendFileSync(yaml, '  hooks:\n    autoApply: true\n    requireTeamScripts: false\n');
    writeFile(path.join(repo, '.teamai', 'hooks', 'hooks.yaml'), hooksYaml('team-stop', 'echo team-stop'));
    gitOk(['add', '-A'], repo);
    gitOk(['commit', '-q', '-m', 'team hooks'], repo);

    teamaiOk(['pull'], repo);
    // A new team keeps delivered files out of git, so the team hooks are in settings.local.json (#915).
    const settings = readJson(path.join(repo, '.claude', 'settings.local.json'));
    expect(JSON.stringify(settings.hooks?.Stop ?? [])).toContain('echo team-stop');
    expect(gitOk(['status', '--porcelain', '-uall', '--', '.teamai'], repo)).toBe('');
    expect(run('git', ['check-ignore', '-q', '.teamai/managed-hooks.json'], repo).code).toBe(0);
    gitOk(['add', '-A'], repo);
    expect(gitOk(['ls-files', '--', '.teamai'], repo)).not.toContain('managed-hooks.json');

    // An install whose .gitignore predates the entry gets it on the next pull.
    const gitignore = path.join(repo, '.teamai', '.gitignore');
    fs.writeFileSync(gitignore, fs.readFileSync(gitignore, 'utf8').replace(/^managed-hooks\.json\n/m, ''));
    expect(run('git', ['check-ignore', '-q', '.teamai/managed-hooks.json'], repo).code).toBe(1);
    teamaiOk(['pull'], repo);
    expect(run('git', ['check-ignore', '-q', '.teamai/managed-hooks.json'], repo).code).toBe(0);
  });

  it('writes the package lock to the data home, moves an older one out of the tree, and reads it there', () => {
    const t = team('packages', {}, ['packages:', '  npm:', '    - name: left-pad', '      version: "1.3.0"']);
    const dir = business('packages-biz', { 'package.json': '{"name":"app","version":"1.0.0"}\n' });
    init(t, dir, 'claude');
    const lock = path.join(home, '.teamai', 'projects', projectSlug(dir), 'teamai.lock');
    const legacyLock = path.join(dir, '.teamai', 'teamai.lock');
    let session = 0;
    /** The package hint a new session gets: it reads the lock to tell whether the packages are installed. */
    const packageHint = (): string => {
      const r = teamai(['hook-dispatch', 'session-start', '--tool', 'claude'], dir,
        JSON.stringify({ cwd: dir, session_id: `packages-${++session}`, hook_event_name: 'SessionStart', source: 'startup' }));
      expect(r.code, r.output).toBe(0);
      return r.stdout;
    };
    /** The tree an older release left: the lock in `.teamai/`, and the `.gitignore` it wrote to hide it. */
    const restoreLegacyLayout = (): void => {
      fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
      fs.renameSync(lock, legacyLock);
      fs.writeFileSync(path.join(dir, '.teamai', '.gitignore'), 'teamai.lock\n');
    };
    expect(packageHint()).toContain('1 npm package');

    const installed = teamaiOk(['packages', 'install'], dir);
    expect(installed.output).toContain('wrote teamai.lock');
    expect(fs.existsSync(lock)).toBe(true);
    expect(teamaiStatus(dir)).toBe('');
    expect(packageHint()).not.toContain('1 npm package');

    // A status read finds the older lock and moves it.
    restoreLegacyLayout();
    expect(packageHint()).not.toContain('1 npm package');
    expect(fs.existsSync(lock)).toBe(true);
    expect(teamaiStatus(dir)).toBe('');

    // So does an install.
    restoreLegacyLayout();
    teamaiOk(['packages', 'install'], dir);
    expect(fs.existsSync(lock)).toBe(true);
    expect(teamaiStatus(dir)).toBe('');
  });

  it('leaves a tracked older package lock in place, reads it there, and doctor names it with the untrack command', () => {
    const t = team('tracked-lock', {}, ['packages:', '  npm:', '    - name: left-pad', '      version: "1.3.0"']);
    const dir = business('tracked-lock-biz', { 'package.json': '{"name":"app","version":"1.0.0"}\n' });
    init(t, dir, 'claude');
    const lock = path.join(home, '.teamai', 'projects', projectSlug(dir), 'teamai.lock');
    const legacyLock = path.join(dir, '.teamai', 'teamai.lock');
    const packageHint = (): string => {
      const r = teamai(['hook-dispatch', 'session-start', '--tool', 'claude'], dir,
        JSON.stringify({ cwd: dir, session_id: 'tracked-lock', hook_event_name: 'SessionStart', source: 'startup' }));
      expect(r.code, r.output).toBe(0);
      return r.stdout;
    };
    teamaiOk(['packages', 'install'], dir);
    // An older release's lock, committed by mistake.
    fs.mkdirSync(path.dirname(legacyLock), { recursive: true });
    fs.renameSync(lock, legacyLock);
    gitOk(['add', '-f', '.teamai/teamai.lock'], dir);
    gitOk(['commit', '-q', '-m', 'commit the package lock by mistake'], dir);
    const trackedStatus = (): string => gitOk(['status', '--porcelain', '--', '.teamai'], dir);

    // Read where it is: the packages count as installed, and git sees no change.
    expect(packageHint()).not.toContain('1 npm package');
    expect(fs.existsSync(legacyLock)).toBe(true);
    expect(trackedStatus()).toBe('');

    teamaiOk(['packages', 'install'], dir);
    expect(fs.existsSync(legacyLock)).toBe(true);
    expect(trackedStatus()).toBe('');

    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toContain('git rm --cached .teamai/teamai.lock');
  });

  it('leaves a tracked older hook index in place and doctor names it with the untrack command', () => {
    const t = team('tracked-index', { 'hooks/hooks.yaml': hooksYaml('team-stop', 'echo team-stop') });
    const dir = business('tracked-index-biz', legacyTree());
    gitOk(['add', '.teamai/managed-hooks.json'], dir);
    gitOk(['commit', '-q', '-m', 'commit the hook index by mistake'], dir);

    init(t, dir, 'claude,codex,copilot');

    expect(copilotStops(dir)).toEqual(['echo team-stop']);
    expect(fs.existsSync(path.join(dir, '.teamai', 'managed-hooks.json'))).toBe(true);
    const doctor = teamai(['doctor'], dir);
    expect(doctor.output).toContain('git rm --cached .teamai/managed-hooks.json');
  });
});

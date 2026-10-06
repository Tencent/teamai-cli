import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

/** The team repo URL; git's insteadOf in the sandbox HOME points it at a local bare repo. */
const TEAM_URL = 'https://git.example.com/team/team.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * Every file under `dir` with a hash of its content; `.git` objects aside, and
 * the debug log, which every log.debug and log.error appends to, preview or not.
 */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'objects') walk(full);
      } else if (entry.name !== 'debug.log') {
        files[path.relative(dir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  return files;
}

// A command that does not honor --dry-run must refuse it, not run for real (#900).
describe('--dry-run on a command with no preview', () => {
  let sandbox: string;
  let home: string;

  function cli(args: string[], cwd = sandbox, extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, TEAMAI_E2E_KEY: 'sk-e2e', FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1', ...extraEnv,
    };
    // A run that is not refused must not reach the developer's own tool roots.
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      input: '',
      timeout: 10_000,
    });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-refusal-'));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('models remove --dry-run exits 1 and keeps the profile', () => {
    const added = cli(['models', 'add', 'gw', '--name', 'Gateway', '--protocol', 'anthropic', '--base-url', 'https://gw.example.test',
      '--model', 'm1', '--from-env', 'TEAMAI_E2E_KEY']);
    expect(added.output).toContain('Added local model profile');
    const before = snapshot(home);

    const removed = cli(['models', 'remove', 'gw', '--dry-run']);

    expect(removed.code, removed.output).toBe(1);
    expect(removed.output).toContain('teamai models remove has no --dry-run preview, nothing was run');
    expect(snapshot(home)).toEqual(before);
    expect(cli(['models', 'list']).output).toContain('local:gw');
  });

  it('refuses codebase --extract and lets a read-only sibling through', () => {
    const before = snapshot(home);

    const extract = cli(['codebase', '--extract', '--dry-run']);
    expect(extract.code, extract.output).toBe(1);
    expect(extract.output).toContain('teamai codebase --extract has no --dry-run preview, nothing was run');

    const list = cli(['models', 'list', '--dry-run']);
    expect(list.code, list.output).toBe(0);
    expect(list.output).not.toContain('has no --dry-run preview');

    expect(snapshot(home)).toEqual(before);
  });

  /** A fresh clone of a single-repo team: `.teamai/teamai.yaml` says `mode: self`, no local config. */
  function selfClone(): string {
    const repo = path.join(sandbox, 'repo');
    const env = { ...process.env, ...GIT_ENV };
    fs.mkdirSync(path.join(repo, '.teamai'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    fs.writeFileSync(path.join(repo, '.teamai', 'teamai.yaml'),
      ['team: self-e2e', 'repo: local/self-e2e', 'provider: git', 'mode: self', ''].join('\n'));
    execFileSync('git', ['add', '-A'], { cwd: repo, env });
    execFileSync('git', ['commit', '-qm', 'team'], { cwd: repo, env });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/self-e2e.git'], { cwd: repo });
    return repo;
  }

  /** A team repo at TEAM_URL, served from a local bare repo, so a real init clones it offline. */
  function teamRemote(): void {
    const env = { ...process.env, ...GIT_ENV };
    const remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env });
    execFileSync('git', ['init', '-q', '-b', 'main', seed], { env });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), ['team: team', `repo: ${TEAM_URL}`, 'provider: git', ''].join('\n'));
    execFileSync('git', ['add', '-A'], { cwd: seed, env });
    execFileSync('git', ['commit', '-qm', 'team'], { cwd: seed, env });
    execFileSync('git', ['push', '-q', remote, 'main'], { cwd: seed, env });
    execFileSync('git', ['config', '--global', `url.${remote}.insteadOf`, TEAM_URL], { env: { ...env, HOME: home, USERPROFILE: home } });
  }

  const INIT_REFUSAL = 'teamai init has no --dry-run preview, nothing was run';

  // Init has no preview: with --dry-run it cloned, saved its config, injected
  // hooks and pulled, exactly as a real init.
  it('init <url> --dry-run in a project writes nothing', () => {
    teamRemote();
    const project = path.join(sandbox, 'project');
    execFileSync('git', ['init', '-q', '-b', 'main', project], { env: { ...process.env, ...GIT_ENV } });
    const projectBefore = snapshot(project);
    const homeBefore = snapshot(home);

    const result = cli(['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--force', '--dry-run'], project);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(INIT_REFUSAL);
    expect(snapshot(project)).toEqual(projectBefore);
    expect(snapshot(home)).toEqual(homeBefore);
  });

  // In a single-repo clone even loading the config bootstraps the machine side
  // (#852), so every form of init is refused before the migration step, which
  // would preview that bootstrap first.
  it('every form of init --dry-run in a single-repo clone writes nothing', () => {
    teamRemote();
    const repo = selfClone();
    const repoBefore = snapshot(repo);
    const homeBefore = snapshot(home);

    for (const args of [
      ['init', TEAM_URL, '--provider', 'git'],
      ['init', '.'],
      ['init', '--self'],
      ['init', '--repo', '.'],
      ['init', '--http', 'https://teamai.example.test', '--token', 'k'],
    ]) {
      const result = cli([...args, '--agent', 'claude', '--force', '--dry-run'], repo);
      expect(result.code, `${args.join(' ')}\n${result.output}`).toBe(1);
      expect(result.output).toContain(INIT_REFUSAL);
      expect(result.output).not.toContain('Would bootstrap');
    }

    expect(snapshot(repo)).toEqual(repoBefore);
    expect(snapshot(home)).toEqual(homeBefore);
  });

  it.each([
    ['stats'], ['digest'], ['recall', 'query'],
    ['import', '--from-repo', TEAM_URL], ['import', '--from-repo-list', 'repos.yaml'],
    ['import', '--from-iwiki', 'page', '--from-mr', 'url'], ['import', '--from-claude'],
  ])('refuses unsafe preview %j before writing', (...args) => {
    const before = snapshot(home);
    const result = cli([...args, '--dry-run']);
    const command = args[0] === 'import' ? `import ${args[1]}` : args[0];
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain(`teamai ${command} has no --dry-run preview, nothing was run`);
    expect(snapshot(home)).toEqual(before);
  });

  it('roles add --dry-run leaves a remote-ahead team clone unchanged', () => {
    teamRemote();
    const env = { ...process.env, ...GIT_ENV };
    const remote = path.join(sandbox, 'team.git');
    const repo = path.join(home, '.teamai', 'team-repo');
    execFileSync('git', ['clone', '-q', remote, repo], { env });
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${repo}`, `  remote: ${TEAM_URL}`,
      'username: tester', 'scope: user', 'provider: git', '',
    ].join('\n'));
    const seed = path.join(sandbox, 'seed');
    fs.writeFileSync(path.join(seed, 'remote-ahead.txt'), 'new commit\n');
    execFileSync('git', ['add', '-A'], { cwd: seed, env });
    execFileSync('git', ['commit', '-qm', 'remote ahead'], { cwd: seed, env });
    execFileSync('git', ['push', '-q', remote, 'main'], { cwd: seed, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seed, encoding: 'utf8' });
    expect(head).not.toBe(remoteHead);
    const before = snapshot(home);

    const result = cli(['roles', 'add', 'x', '--namespaces', 'x', '--dry-run']);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('teamai roles add has no --dry-run preview, nothing was run');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' })).toBe(head);
    expect(snapshot(home)).toEqual(before);
  });

  it('refuses CI artifact output before provider access and preserves no-output previews', () => {
    const project = path.join(sandbox, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'keep.txt'), 'unchanged');
    const output = path.join(project, 'artifacts');
    const marker = path.join(sandbox, 'provider-access');
    const preload = path.join(sandbox, 'block-provider.mjs');
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      `globalThis.fetch = async () => { fs.writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('provider access blocked by test'); };`,
    ].join('\n'));
    const bin = path.join(sandbox, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, { mode: 0o755 });
    const env = { NODE_OPTIONS: `--import=${preload}`, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const beforeHome = snapshot(home);
    const beforeProject = snapshot(project);
    const args = ['ci', 'extract-mr', '--url', 'https://github.com/example/team/pull/1', '--dry-run'];

    const result = cli([...args, '--output', output], project, env);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('teamai ci extract-mr --output has no --dry-run preview, nothing was run');
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(snapshot(home)).toEqual(beforeHome);
    expect(snapshot(project)).toEqual(beforeProject);

    // Positive control: without --output the action reaches the intercepted
    // provider request, proving the refusal did not merely mask a broken URL.
    const preview = cli(args, project, env);
    expect(preview.output).not.toContain('has no --dry-run preview');
    expect(fs.readFileSync(marker, 'utf8')).toBe('called');
    expect(snapshot(home)).toEqual(beforeHome);
    expect(snapshot(project)).toEqual(beforeProject);
  });

  it('bind-project --dry-run exits 1 and writes nothing', () => {
    const before = snapshot(home);
    const result = cli(['bind-project', '--skip', '--dry-run']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('teamai bind-project has no --dry-run preview, nothing was run');
    expect(snapshot(home)).toEqual(before);
  });
});

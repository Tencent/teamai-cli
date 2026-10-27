/**
 * E2E (#993 bug 9): `teamai init . --agent claude` sets up only Claude, even
 * when other tools are installed in HOME.
 *
 * init wrote `.teamai/teamai.yaml` (mode: self) before it read the existing
 * project config. With the marker on disk and no config yet, that read ran the
 * clone-time self-heal, which enabled every tool found in HOME, injected their
 * hooks into the repo and saved them; init then merged `--agent` into that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
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

/** The tools a member has installed: one directory each in HOME. */
const HOME_TOOLS = ['.claude', '.codex', '.cursor', '.codebuddy', '.copilot'];

interface Run {
  code: number | null;
  output: string;
}

describe('init . --agent sets up only the tools passed (#993 bug 9)', () => {
  let sandbox: string;
  let home: string;
  let counter = 0;

  const env = (): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      FORCE_COLOR: '0',
    };
    delete base.GIT_CONFIG_GLOBAL;
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    return base;
  };
  /** stdin is a pipe, never a terminal. A run past `timeout` ms is killed and reports code null. */
  const run = (command: string, args: string[], cwd: string, timeout?: number): Run => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', env: env(), input: '', timeout });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const gitOk = (args: string[], cwd: string): string => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.output}`);
    return r.output;
  };
  const teamai = (args: string[], cwd: string, timeout?: number): Run => run('node', [CLI, ...args], cwd, timeout);

  /**
   * A business repo with one commit. init only parses the origin; nothing it
   * checks here needs the remote, so origin is an https URL on a closed local
   * port. It must be https: the self-heal skips a remote it cannot parse.
   */
  const project = (): string => {
    const repo = path.join(sandbox, `self-${++counter}`);
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# project\n');
    gitOk(['init', '-q', '-b', 'main'], repo);
    gitOk(['add', '-A'], repo);
    gitOk(['commit', '-q', '-m', 'project'], repo);
    gitOk(['remote', 'add', 'origin', `https://127.0.0.1:9/team/self-${counter}.git`], repo);
    return repo;
  };

  /**
   * A teammate's fresh clone of a repo already in single-repo mode: the
   * committed `.teamai/teamai.yaml` says `mode: self`, and there is no local
   * config yet. Cloned from a local seed, then origin is set to an https URL
   * on a closed local port, as in `project()`.
   */
  const clone = (): string => {
    const name = `clone-${++counter}`;
    const url = `https://127.0.0.1:9/team/${name}.git`;
    const seed = path.join(sandbox, `${name}-seed`);
    fs.mkdirSync(path.join(seed, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'README.md'), '# project\n');
    fs.writeFileSync(path.join(seed, '.teamai', 'teamai.yaml'), YAML.stringify({
      team: name,
      mode: 'self',
      repo: url,
      provider: 'git',
    }));
    gitOk(['init', '-q', '-b', 'main'], seed);
    gitOk(['add', '-A'], seed);
    gitOk(['commit', '-q', '-m', 'team'], seed);
    const repo = path.join(sandbox, name);
    gitOk(['clone', '-q', seed, repo], sandbox);
    gitOk(['remote', 'set-url', 'origin', url], repo);
    return repo;
  };

  /** The tools saved in the member's project config, as `teamai` reads them. */
  const enabledAgents = (repo: string): string[] => {
    const configPath = path.join(home, '.teamai', 'projects', projectSlug(repo), 'config.yaml');
    const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    return config.enabledAgents ?? [];
  };

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`Build first: ${CLI} is missing`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-self-agent-')));
    home = path.join(sandbox, 'home');
    for (const tool of HOME_TOOLS) fs.mkdirSync(path.join(home, tool), { recursive: true });
  });

  afterAll(async () => {
    await waitForDetachedChildren();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('saves only claude and touches no other tool\'s files', () => {
    const repo = project();

    const init = teamai(['init', '.', '--provider', 'git', '--agent', 'claude', '--verbose'], repo);

    expect(init.code, init.output).toBe(0);
    expect(init.output).not.toContain('[bootstrap]');
    const hookWrites = init.output.split('\n').filter((line) => line.includes('Updated teamai hooks in'));
    expect(hookWrites.length, init.output).toBeGreaterThan(0);
    for (const line of hookWrites) expect(line).toContain(path.join(repo, '.claude', 'settings.json'));
    expect(enabledAgents(repo)).toEqual(['claude']);
    expect(gitOk(['status', '--porcelain', '-uall'], repo)).toBe('');
    for (const dir of ['.codex', '.cursor', '.codebuddy', '.github']) {
      expect(fs.existsSync(path.join(repo, dir)), dir).toBe(false);
    }
  });

  it('re-running init keeps the tools already enabled and adds --agent', () => {
    const repo = project();
    const first = teamai(['init', '.', '--provider', 'git', '--agent', 'codex'], repo);
    expect(first.code, first.output).toBe(0);
    expect(enabledAgents(repo)).toEqual(['codex']);

    const again = teamai(['init', '.', '--provider', 'git', '--agent', 'claude', '--force'], repo);

    expect(again.code, again.output).toBe(0);
    expect(enabledAgents(repo)).toEqual(['codex', 'claude']);
    for (const dir of ['.cursor', '.codebuddy', '.github']) {
      expect(fs.existsSync(path.join(repo, dir)), dir).toBe(false);
    }
  });

  // A fresh clone self-heals on its first command (#198), but not on `init`,
  // which sets the project up itself and must honour --agent.
  it.each([[[]], [['--force']]])('in a fresh clone of a single-repo project, init . --agent claude %j saves only claude', (extra: string[]) => {
    const repo = clone();

    const init = teamai(['init', '.', '--provider', 'git', '--agent', 'claude', '--verbose', ...extra], repo);

    expect(init.code, init.output).toBe(0);
    expect(init.output).not.toContain('[bootstrap]');
    expect(init.output).not.toContain('already initialized');
    const hookWrites = init.output.split('\n').filter((line) => line.includes('Updated teamai hooks in'));
    expect(hookWrites.length, init.output).toBeGreaterThan(0);
    for (const line of hookWrites) expect(line).toContain(path.join(repo, '.claude', 'settings.json'));
    expect(enabledAgents(repo)).toEqual(['claude']);
    expect(gitOk(['status', '--porcelain', '-uall'], repo)).toBe('');
    for (const dir of ['.codex', '.cursor', '.codebuddy', '.github']) {
      expect(fs.existsSync(path.join(repo, dir)), dir).toBe(false);
    }
  });

  // Scripts and CI run `init .` with no terminal: with no config in the clone
  // yet, init must take the non-interactive default rather than wait on the
  // tool picker.
  it('in a fresh clone, init . with no --agent and no terminal sets up the tools found in HOME without prompting', () => {
    const repo = clone();

    const init = teamai(['init', '.', '--provider', 'git'], repo, 60_000);

    expect(init.code, `timed out or failed:\n${init.output}`).toBe(0);
    expect(init.output).not.toContain('Which AI tools');
    expect(init.output).not.toContain('already initialized');
    expect([...enabledAgents(repo)].sort()).toEqual(['claude', 'codebuddy', 'codex', 'copilot', 'cursor']);
  });

  it('in a fresh clone, any other command still self-heals with the tools found in HOME', () => {
    const repo = clone();

    teamai(['pull'], repo);

    expect([...enabledAgents(repo)].sort()).toEqual(['claude', 'codebuddy', 'codex', 'copilot', 'cursor']);
  });
});

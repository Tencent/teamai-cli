import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { KNOWN_AGENTS } from '../../known-agents.js';
import { TOOLS } from '../../tools.js';
import { projectSlug } from '../../utils/partition.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run {
  code: number | null;
  output: string;
}

interface Fixture {
  home: string;
  env: NodeJS.ProcessEnv;
  url: string;
}

describe('init --agent validates ids against built-in and team agents', () => {
  let sandbox: string;
  let homeCount = 0;

  const makeEnv = (home: string): NodeJS.ProcessEnv => {
    const testEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      TEAMAI_API_TOKEN: 'test-token',
      FORCE_COLOR: '0',
    };
    return testEnv;
  };

  const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Run => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input: '', timeout: 60_000 });
    return {
      code: result.status,
      output: (result.stdout ?? '') + (result.stderr ?? '') + (result.error ? '\n' + result.error.message : ''),
    };
  };

  const gitOk = (args: string[], cwd: string, env: NodeJS.ProcessEnv): string => {
    const result = run('git', args, cwd, env);
    if (result.code !== 0) throw new Error('git ' + args.join(' ') + ' failed:\n' + result.output);
    return result.output;
  };

  const teamai = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Run =>
    run('node', [CLI, ...args], cwd, env);

  const newHome = (name: string): { home: string; env: NodeJS.ProcessEnv } => {
    const home = path.join(sandbox, name + '-' + (++homeCount), 'home');
    fs.mkdirSync(home, { recursive: true });
    const env = makeEnv(home);
    gitOk(['config', '--global', 'user.name', 'TeamAI Test'], home, env);
    gitOk(['config', '--global', 'user.email', 'teamai-test@example.invalid'], home, env);
    return { home, env };
  };

  const newTeamRepo = (name: string, toolPaths?: Record<string, unknown>): Fixture => {
    const { home, env } = newHome(name);
    const url = 'https://git.example.invalid/team/' + name + '.git';
    const seed = path.join(sandbox, name + '-' + homeCount + '-seed');
    const bare = path.join(sandbox, name + '-' + homeCount + '.git');
    fs.mkdirSync(seed, { recursive: true });
    const teamConfig = {
      team: name,
      repo: url,
      provider: 'git',
      reviewers: [],
      ...(toolPaths ? { toolPaths } : {}),
    };
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify(teamConfig));
    gitOk(['init', '-q', '-b', 'main'], seed, env);
    gitOk(['add', '-A'], seed, env);
    gitOk(['commit', '-q', '-m', 'seed'], seed, env);
    gitOk(['clone', '-q', '--bare', seed, bare], sandbox, env);
    gitOk(['config', '--global', 'url.' + pathToFileURL(bare).href + '.insteadOf', url], home, env);
    return { home, env, url };
  };

  const initTeam = (fixture: Fixture, agent: string): Run => teamai([
    'init', fixture.url, '--provider', 'git', '--agent', agent, '--scope', 'user', '--force',
  ], fixture.home, fixture.env);

  const configPath = (home: string): string => path.join(home, '.teamai', 'config.yaml');

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Build first: ' + CLI + ' is missing');
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-agent-validation-')));
  });

  afterAll(async () => {
    await waitForDetachedChildren();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects an unknown id and leaves a fresh user config absent', () => {
    const fixture = newTeamRepo('invalid-agent');

    const result = initTeam(fixture, 'claudee');

    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('claudee');
    expect(result.output).toContain('neither a built-in agent nor a key in the team');
    expect(result.output).toContain('Valid ids:');
    expect(result.output).toContain('claude');
    expect(fs.existsSync(configPath(fixture.home))).toBe(false);
  });

  it('rejects a comma-separated list before changing or creating a config', () => {
    const fixture = newTeamRepo('invalid-agent-list');
    const initial = initTeam(fixture, 'claude');
    expect(initial.code, initial.output).toBe(0);
    const before = fs.readFileSync(configPath(fixture.home), 'utf8');

    const result = initTeam(fixture, 'claude,claudee');

    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('claudee');
    expect(result.output).toContain('Valid ids:');
    expect(fs.readFileSync(configPath(fixture.home), 'utf8')).toBe(before);
    expect((YAML.parse(before) as { enabledAgents?: string[] }).enabledAgents).toEqual(['claude']);

    const fresh = newTeamRepo('invalid-agent-list-fresh');
    const freshResult = initTeam(fresh, 'claude,claudee');
    expect(freshResult.code, freshResult.output).not.toBe(0);
    expect(freshResult.output).toContain('claudee');
    expect(fs.existsSync(configPath(fresh.home))).toBe(false);
  });

  it('accepts a team-declared custom tool and creates its user root', () => {
    const fixture = newTeamRepo('custom-agent', { agy: { skills: '.agy/skills' } });

    const result = initTeam(fixture, 'agy');

    expect(result.code, result.output).toBe(0);
    expect((YAML.parse(fs.readFileSync(configPath(fixture.home), 'utf8')) as { enabledAgents?: string[] }).enabledAgents).toEqual(['agy']);
    expect(fs.existsSync(path.join(fixture.home, '.agy', 'skills'))).toBe(true);
  });

  it('accepts every built-in tool id and every KNOWN_AGENTS id', () => {
    const fixture = newTeamRepo('known-agent-list');
    const ids = [...new Set([...Object.keys(TOOLS), ...KNOWN_AGENTS.map((agent) => agent.id)])];

    const result = initTeam(fixture, ids.join(','));

    expect(result.code, result.output).toBe(0);
    expect((YAML.parse(fs.readFileSync(configPath(fixture.home), 'utf8')) as { enabledAgents?: string[] }).enabledAgents).toEqual(ids);
  });

  it('warns and continues for an unchecked custom id in HTTP mode', () => {
    const { home, env } = newHome('http-custom-agent');

    const result = teamai([
      'init', '--http', 'http://127.0.0.1:9/team', '--agent', 'agy', '--scope', 'user', '--force',
    ], home, env);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('agy');
    expect(result.output).toContain('team config is unavailable');
    expect((YAML.parse(fs.readFileSync(configPath(home), 'utf8')) as { enabledAgents?: string[] }).enabledAgents).toEqual(['agy']);
  });

  it('rejects an unknown id in single-repo git init before saving config', () => {
    const { home, env } = newHome('self-invalid-agent');
    const repo = path.join(sandbox, 'self-invalid-agent-' + homeCount);
    const url = 'https://git.example.invalid/team/self-invalid-agent.git';
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# project\n');
    gitOk(['init', '-q', '-b', 'main'], repo, env);
    gitOk(['add', '-A'], repo, env);
    gitOk(['commit', '-q', '-m', 'project'], repo, env);
    gitOk(['remote', 'add', 'origin', url], repo, env);

    const result = teamai(['init', '.', '--provider', 'git', '--agent', 'claudee', '--force'], repo, env);

    const projectConfig = path.join(home, '.teamai', 'projects', projectSlug(repo), 'config.yaml');
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain('claudee');
    expect(fs.existsSync(projectConfig)).toBe(false);
  });
});

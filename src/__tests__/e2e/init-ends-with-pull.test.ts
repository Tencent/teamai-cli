/**
 * E2E: `teamai init` does not pull (#1065). It saves config and installs hooks.
 * Team skills, rules, agents and MCP arrive on the next session start, which
 * creates the current agent's project directory when it is missing, or when
 * the member runs `teamai pull`.
 *
 * The team remote is a synthetic HTTPS URL that git's `insteadOf` rewrites to a
 * local bare repo in the sandbox HOME (see init-project-all.test.ts), so no
 * network is touched.
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

const FAKE_URL = 'https://git.example.com/team/team.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

let sandbox: string;
let home: string;
let remote: string;
let binDir: string;

/**
 * A `git` ahead of PATH that reports the synthetic HTTPS origin for
 * `remote get-url` (so a re-init reuses the clone; real `insteadOf` expansion
 * would make it look like another repo), and with TEST_FAIL_FETCH=1 refuses to
 * refresh a clone, as an unreachable remote would.
 */
function writeGitWrapper(): void {
  binDir = path.join(sandbox, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then',
    `  printf '%s\\n' '${FAKE_URL}'; exit 0`,
    'fi',
    'if [ "$TEST_FAIL_FETCH" = "1" ]; then',
    '  for arg in "$@"; do',
    '    case "$arg" in',
    '      fetch|pull) echo "fatal: unable to access remote (test)" >&2; exit 128 ;;',
    '    esac',
    '  done',
    'fi',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

function git(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...extraEnv },
  }).trim();
}

function runCLI(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    FORCE_COLOR: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extraEnv,
  };
  // The sandbox HOME decides where tools live; a developer's override must not.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return new Promise((resolve) => {
    // stdin ignored: no terminal, so init never prompts.
    const child = spawn('node', [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function writeSeed(seed: string, relativePath: string, content: string): void {
  const file = path.join(seed, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A git business repo with no tool roots of its own. */
function makeBusinessRepo(name: string): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'app'], dir);
  return dir;
}

const TOOL_ROOTS = ['.claude', '.codex', '.cursor', '.codebuddy', '.opencode', '.config'];

describe.skipIf(process.platform === 'win32')('teamai init does not pull team resources', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-pull-e2e-')));
    remote = path.join(sandbox, 'team.git');
    const seed = path.join(sandbox, 'seed');

    writeSeed(seed, 'teamai.yaml', [
      'team: init-pull-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      'sharing:',
      '  mcp:',
      '    autoApply: true',
      '  hooks:',
      '    autoApply: true',
      '    requireTeamScripts: false',
      '',
    ].join('\n'));
    writeSeed(seed, 'skills/team-skill/SKILL.md',
      '---\nname: team-skill\ndescription: Team skill fixture\n---\n\n# Team skill\n');
    writeSeed(seed, 'rules/team-rule.md', '# Team rule\n');
    writeSeed(seed, 'agents/team-agent.yaml', 'name: team-agent\ndescription: Startup agent fixture\ninstructions: Team agent v1\n');
    writeSeed(seed, 'hooks/hooks.yaml', 'hooks:\n  - id: startup-guard\n    description: Startup hook fixture\n    event: SessionStart\n    command: echo team-hook-v1\n');
    writeSeed(seed, 'mcp/mcp.yaml', [
      'servers:',
      '  - name: team-api',
      '    transport: http',
      '    url: https://team.example.com/mcp',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    writeGitWrapper();
  });

  beforeEach(() => {
    home = path.join(sandbox, `home-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(home, { recursive: true });
    // Claude and Codex are installed on this machine.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, { HOME: home, USERPROFILE: home });
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('user scope: init succeeds without copying team skills, rules, agents or MCP', async () => {
    const cwd = path.join(sandbox, 'elsewhere');
    fs.mkdirSync(cwd, { recursive: true });
    const result = await runCLI(['init', FAKE_URL, '--scope', 'user', '--agent', 'claude', '--force'], cwd);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/teamai initialized successfully/);
    expect(result.output).toMatch(/not copied during init/);
    expect(result.output).not.toMatch(/Synced \d+/);

    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'rules', 'team-rule.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'agents', 'team-agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  }, 90_000);

  it('user scope run inside a project checkout does not pull that user scope', async () => {
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const first = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'codex', '--force'], project);
    expect(first.code, first.output).toBe(0);

    const result = await runCLI(['init', FAKE_URL, '--scope', 'user', '--agent', 'claude', '--force'], project);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toMatch(/Synced \d+/);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'rules', 'team-rule.md'))).toBe(false);
  }, 120_000);

  it('project scope with --agent creates that root and does not fill it', async () => {
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const result = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force'], project);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/teamai initialized successfully/);
    expect(result.output).not.toMatch(/Synced \d+/);

    expect(fs.existsSync(path.join(project, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude', 'rules', 'team-rule.md'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude', 'agents', 'team-agent.md'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(false);
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toContain('teamai hook-dispatch');
    // Only the chosen tool's root, although Codex is installed too.
    expect(fs.existsSync(path.join(project, '.codex'))).toBe(false);
  }, 90_000);

  it('project scope re-init with another --agent adds that root and still does not fill it', async () => {
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const first = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'codex', '--force'], project);
    expect(first.code, first.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.codex'))).toBe(true);

    const second = await runCLI(['init', FAKE_URL, '--scope', 'project', '--agent', 'claude', '--force'], project);
    expect(second.code, second.output).toBe(0);
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'team-skill', 'SKILL.md'))).toBe(false);
  }, 120_000);

  it('project scope without a terminal, --agent or installed tools: no tool root is created', async () => {
    for (const root of TOOL_ROOTS) fs.rmSync(path.join(home, root), { recursive: true, force: true });
    const project = makeBusinessRepo(`app-${Math.random().toString(36).slice(2)}`);
    const result = await runCLI(['init', FAKE_URL, '--scope', 'project', '--force'], project);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/teamai initialized successfully/);
    expect(result.output).not.toMatch(/Synced \d+/);
    for (const root of TOOL_ROOTS) {
      expect(fs.existsSync(path.join(project, root)), `${root} was created:\n${result.output}`).toBe(false);
    }
  }, 90_000);

  it('init does not run a pull, so a fetch failure after the clone is not a pull failure', async () => {
    const cwd = path.join(sandbox, 'elsewhere');
    fs.mkdirSync(cwd, { recursive: true });
    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'user', '--agent', 'claude', '--force'],
      cwd,
      { TEST_FAIL_FETCH: '1' },
    );
    expect(result.output).not.toMatch(/Pull failed:/);
    expect(result.output).toMatch(/teamai initialized successfully/);
    expect(result.code, result.output).toBe(0);
  }, 90_000);
});

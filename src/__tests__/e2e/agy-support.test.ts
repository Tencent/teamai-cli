import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Antigravity CLI (agy) support ──────────────────────────────────────────
//
// End-to-end leg for agy delivery, run through the ACTUAL compiled CLI against
// a local bare team repo. Every expected path below is where agy 1.4.8 reads
// its resources, observed with the real binary: user ones in ~/.gemini/config,
// project ones in <root>/.agents. A rule needs a `trigger` there, and an
// agent's `model` must be one agy knows, or agy skips the file.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/agy.git';

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

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('Antigravity CLI resource delivery', () => {
  let sandbox: string;
  let remote: string;

  /** A scratch HOME bridging the fake team URL to the local bare repo. agy creates ~/.gemini/config on its first run. */
  function makeHome(name: string): string {
    const home = path.join(sandbox, name);
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, home);
    return home;
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-agy-e2e-'));
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');
    const write = (rel: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    };
    write('teamai.yaml', `team: agy-e2e\nrepo: ${FAKE_URL}\nprovider: git\nreviewers: []\n`);
    write('skills/release-notes/SKILL.md', '---\nname: release-notes\ndescription: Draft release notes from merged PRs\n---\n\n# Release notes\n');
    write('rules/no-console.md', 'Never leave console.log in committed code.\n');
    write('rules/api-errors.md', '---\npaths:\n  - "src/api/**/*.ts"\n---\n\nReturn typed errors from API handlers.\n');
    write('culture.md', '---\ncompany:\n  name: Acme\n---\n\nShip small PRs.\n');
    write('mcp/mcp.yaml', [
      'servers:',
      '  - name: issues',
      '    transport: stdio',
      '    command: node',
      '    args: [issues-server.mjs]',
      '    env: { ISSUES_PROJECT: web }',
      '  - name: docs',
      '    transport: http',
      '    url: https://mcp.example.com/mcp',
      '    headers: { X-Team: acme }',
      '  - name: legacy-events',
      '    transport: sse',
      '    url: https://mcp.example.com/sse',
      '',
    ].join('\n'));
    write('agents/reviewer.yaml', [
      'name: reviewer',
      'description: Reviews a diff for bugs',
      'instructions: Review the change.',
      'model: sonnet',
      'tools: [Read, Grep, Bash]',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers skills, rules, culture, agents and MCP to ~/.gemini/config in user scope, leaving Gemini CLI files alone', async () => {
    const home = makeHome('home-user');
    const cwd = fs.mkdtempSync(path.join(sandbox, 'user-work-'));
    const init = await runCLI(['init', FAKE_URL, '--scope', 'user', '--role', 'dev', '--agent', 'agy', '--force'], cwd, home);
    expect(init.code, init.output).toBe(0);
    const pull = await runCLI(['pull'], cwd, home);
    expect(pull.code, pull.output).toBe(0);

    const config = path.join(home, '.gemini', 'config');
    expect(read(path.join(config, 'skills', 'release-notes', 'SKILL.md'))).toContain('Draft release notes');
    expect(fs.existsSync(path.join(config, 'skills', 'teamai', 'SKILL.md'))).toBe(true);
    expect(read(path.join(config, 'rules', 'no-console.md'))).toBe('---\ntrigger: always_on\n---\n\nNever leave console.log in committed code.\n');
    expect(read(path.join(config, 'rules', 'api-errors.md'))).toBe('---\ntrigger: model_decision\ndescription: "Applies when reading or editing files matching src/api/**/*.ts"\n---\n\nReturn typed errors from API handlers.\n');
    const context = read(path.join(config, 'rules', 'teamai-context.md'));
    expect(context.startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
    expect(context).toContain('Ship small PRs.');
    // agy skips an agent whose model it does not know, so Claude's `sonnet` and tool names stay out.
    expect(read(path.join(config, 'agents', 'reviewer.md'))).toBe('---\nname: reviewer\ndescription: Reviews a diff for bugs\n---\nReview the change.\n');

    // agy takes the transport from `command` or `url`, warns on `type`, and has no legacy SSE transport.
    expect(JSON.parse(read(path.join(config, 'mcp_config.json')))).toEqual({
      mcpServers: {
        issues: { command: 'node', args: ['issues-server.mjs'], env: { ISSUES_PROJECT: 'web' } },
        docs: { url: 'https://mcp.example.com/mcp', headers: { 'X-Team': 'acme' } },
      },
    });

    // Gemini CLI reads ~/.gemini/skills and ~/.gemini/GEMINI.md: agy must not write them.
    expect(fs.existsSync(path.join(home, '.gemini', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.gemini', 'GEMINI.md'))).toBe(false);
  });

  it('delivers skills, rules, culture and agents to <root>/.agents and MCP through a teamai plugin in project scope, and uninstall takes the plugin', async () => {
    const home = makeHome('home-project');
    const projectRoot = path.join(sandbox, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    git(['init', '-q', '-b', 'main'], projectRoot, home);
    const init = await runCLI(['init', FAKE_URL, '--scope', 'project', '--role', 'dev', '--agent', 'agy', '--force'], projectRoot, home);
    expect(init.code, init.output).toBe(0);
    const pull = await runCLI(['pull'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);

    const agents = path.join(projectRoot, '.agents');
    expect(read(path.join(agents, 'skills', 'release-notes', 'SKILL.md'))).toContain('Draft release notes');
    expect(read(path.join(agents, 'rules', 'no-console.md'))).toBe('---\ntrigger: always_on\n---\n\nNever leave console.log in committed code.\n');
    expect(read(path.join(agents, 'rules', 'teamai-context.md')).startsWith('---\ntrigger: always_on\n---\n')).toBe(true);
    expect(read(path.join(agents, 'agents', 'reviewer.md'))).toContain('name: reviewer\n');
    expect(fs.existsSync(path.join(projectRoot, 'GEMINI.md'))).toBe(false);

    // agy reads no project mcp_config.json, only a plugin's: teamai's servers ride a plugin of its own.
    const plugin = path.join(agents, 'plugins', 'teamai');
    expect(JSON.parse(read(path.join(plugin, 'plugin.json')))).toEqual({ name: 'teamai' });
    expect(Object.keys(JSON.parse(read(path.join(plugin, 'mcp_config.json'))).mcpServers)).toEqual(['issues', 'docs']);

    const uninstall = await runCLI(['uninstall', '--agent', 'agy', '--force'], projectRoot, home);
    expect(uninstall.code, uninstall.output).toBe(0);
    expect(fs.existsSync(plugin)).toBe(false);
  });
});

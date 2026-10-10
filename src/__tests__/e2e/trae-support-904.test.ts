import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Trae and Trae CN first-class support (issue #904) ──────────────────────
//
// End-to-end leg for the resource delivery, run through the ACTUAL compiled
// CLI: `teamai init --agent trae,trae-cn` must deliver skills, Trae-format
// rules and a Claude-shaped .trae/mcp.json into the project, and a user-scope
// init must land the CN build's user resources under ~/.trae-cn (user_rules,
// skills) while writing no user-level MCP file.
//
// The remote is a synthetic HTTPS URL bridged to a local bare repo through
// git's url.<base>.insteadOf — the same no-network setup as
// init-project-all.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/trae.git';

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

function runCLI(
  args: string[],
  cwd: string,
  home: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        ...GIT_ENV,
        HOME: home,
        USERPROFILE: home,
        FORCE_COLOR: '0',
        TEAMAI_NONINTERACTIVE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('Trae and Trae CN resource delivery (issue #904)', () => {
  let sandbox: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-trae-e2e-'));
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team.git');

    fs.mkdirSync(path.join(seed, 'rules', 'fe'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });

    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: trae-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      '',
    ].join('\n'));

    fs.writeFileSync(
      path.join(seed, 'rules', 'style.md'),
      '---\npaths: ["src/**/*.ts"]\n---\n\nUse named exports.\n',
    );
    fs.writeFileSync(path.join(seed, 'rules', 'fe', 'naming.md'), 'Prefer long names.\n');
    fs.writeFileSync(
      path.join(seed, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Trae fixture skill\n---\n\n# demo\n',
    );
    fs.writeFileSync(path.join(seed, 'mcp', 'mcp.yaml'), [
      'servers:',
      '  - name: team-demo',
      '    transport: stdio',
      '    command: node',
      '    args: ["server.mjs"]',
      '',
    ].join('\n'));

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    // Bridge the synthetic HTTPS remote to the local bare repo for every
    // scratch HOME this file uses (never the developer's own gitconfig).
    for (const homeName of ['home-project', 'home-user']) {
      const home = path.join(sandbox, homeName);
      fs.mkdirSync(home, { recursive: true });
      git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, home);
    }
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers skills, Trae-format rules and project MCP for --agent trae,trae-cn', async () => {
    const projectRoot = path.join(sandbox, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const home = path.join(sandbox, 'home-project');

    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'dev', '--agent', 'trae,trae-cn', '--force'],
      projectRoot,
      home,
    );
    expect(result.code, result.output).toBe(0);

    // Scoped rule: Trae frontmatter with unquoted, comma-joined globs.
    expect(fs.readFileSync(path.join(projectRoot, '.trae', 'rules', 'style.md'), 'utf8')).toBe(
      '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nUse named exports.\n',
    );
    // Unscoped namespaced rule: always applied, directory shape kept (Trae
    // reads rules up to three levels deep).
    expect(fs.readFileSync(path.join(projectRoot, '.trae', 'rules', 'fe', 'naming.md'), 'utf8')).toBe(
      '---\nalwaysApply: true\n---\n\nPrefer long names.\n',
    );
    // Skills land as SKILL.md folders.
    expect(fs.readFileSync(path.join(projectRoot, '.trae', 'skills', 'demo', 'SKILL.md'), 'utf8')).toContain(
      'Trae fixture skill',
    );
    // Project MCP is the shared .trae/mcp.json in the Claude mcpServers shape.
    const mcp = JSON.parse(fs.readFileSync(path.join(projectRoot, '.trae', 'mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { command?: string }>;
    };
    expect(mcp.mcpServers?.['team-demo']).toMatchObject({ command: 'node' });
    // One shared project directory: the CN build adds no .trae-cn/ in a project.
    expect(fs.existsSync(path.join(projectRoot, '.trae-cn'))).toBe(false);
  }, 90_000);

  it('lands Trae CN user resources under ~/.trae-cn, with user rules in user_rules', async () => {
    const workDir = path.join(sandbox, 'user-work');
    fs.mkdirSync(workDir, { recursive: true });
    const home = path.join(sandbox, 'home-user');
    // A CN install opts in by existing; seeds the roots teamai delivers to.
    fs.mkdirSync(path.join(home, '.trae-cn', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.trae', 'skills'), { recursive: true });

    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'user', '--role', 'dev', '--agent', 'trae,trae-cn', '--force'],
      workDir,
      home,
    );
    expect(result.code, result.output).toBe(0);

    // The CN build reads ~/.trae-cn for skills and — under the user_rules
    // name, not rules — for its rules.
    expect(fs.existsSync(path.join(home, '.trae-cn', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.trae-cn', 'user_rules', 'style.md'), 'utf8')).toBe(
      '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nUse named exports.\n',
    );
    // The international build reads ~/.trae/skills and ~/.trae/user_rules.
    expect(fs.existsSync(path.join(home, '.trae', 'skills', 'demo', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.trae', 'user_rules', 'style.md'), 'utf8')).toBe(
      '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nUse named exports.\n',
    );
    // No user-scope MCP file: Trae keeps user-level MCP in a platform-specific
    // user-data directory teamai does not write.
    expect(fs.existsSync(path.join(home, '.trae', 'mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.trae-cn', 'mcp.json'))).toBe(false);
  }, 90_000);
});

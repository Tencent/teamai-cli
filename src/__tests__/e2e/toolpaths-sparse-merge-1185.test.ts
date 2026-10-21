import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Sparse toolPaths merge over defaults (issue #1185) ─────────────────────
//
// When a team specifies a custom or partial `toolPaths` mapping in teamai.yaml
// (e.g. only defining a single in-house tool like `zcode`), TeamAI must merge
// those entries tool-by-tool over DEFAULT_TOOL_PATHS. Built-in tools like Claude,
// Cursor, Codex, and CodeBuddy must retain their default delivery paths rather
// than having their configurations wiped out.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/toolpaths-merge.git';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ENV,
      ...(home ? { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') } : {}),
    },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        ...GIT_ENV,
        HOME: home,
        USERPROFILE: home,
        GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('sparse toolPaths merge over built-in defaults (issue #1185)', () => {
  let sandbox: string;
  let home: string;
  let seed: string;
  let remote: string;

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-toolpaths-merge-e2e-')));
    home = path.join(sandbox, 'home');
    seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'skills', 'common', 'hello-skill'), { recursive: true });

    // Seed teamai.yaml with ONLY a single custom tool defined in toolPaths
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: sparse-toolpaths-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      'toolPaths:',
      '  zcode:',
      '    skills: .zcode/skills',
      '    rules: .zcode/rules',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: dev',
      '    resources:',
      '      knowledge: []',
      '      skills: [common]',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(seed, 'skills', 'common', 'hello-skill', 'SKILL.md'), [
      '---',
      'name: hello-skill',
      'description: Hello world test skill',
      '---',
      '# Hello Skill',
    ].join('\n'));

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed team repository'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    const remotePosix = remote.replace(/\\/g, '/');
    git(['config', '--global', `url.${remotePosix}/.insteadOf`, `${FAKE_URL}/`], sandbox, home);
    git(['config', '--global', `url.${remotePosix}.insteadOf`, FAKE_URL], sandbox, home);
  });

  afterAll(() => {
    if (sandbox) {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('delivers skills to default Claude path even when teamai.yaml only declared zcode', async () => {
    const ws1 = path.join(sandbox, 'workspace1');
    fs.mkdirSync(ws1, { recursive: true });
    git(['init', '-q', '-b', 'main'], ws1, home);

    const initRes = await runCLI(
      ['init', FAKE_URL, '--provider', 'git', '--scope', 'workspace', '--role', 'dev', '--agent', 'claude', '--force'],
      ws1,
      home,
    );
    expect(initRes.code, initRes.output).toBe(0);

    const pullRes = await runCLI(['pull'], ws1, home);
    expect(pullRes.code, pullRes.output).toBe(0);

    // Default tool Claude must retain its .claude/skills delivery path
    const claudeSkillPath = path.join(ws1, '.claude', 'skills', 'hello-skill', 'SKILL.md');
    expect(fs.existsSync(claudeSkillPath)).toBe(true);
    expect(fs.readFileSync(claudeSkillPath, 'utf8')).toContain('# Hello Skill');
  });

  it('also supports custom tool zcode alongside the default tools', async () => {
    const ws2 = path.join(sandbox, 'workspace2');
    fs.mkdirSync(ws2, { recursive: true });
    git(['init', '-q', '-b', 'main'], ws2, home);

    // Initialize with both default tool claude and custom tool zcode
    const initRes = await runCLI(
      ['init', FAKE_URL, '--provider', 'git', '--scope', 'workspace', '--role', 'dev', '--agent', 'claude,zcode', '--force'],
      ws2,
      home,
    );
    expect(initRes.code, initRes.output).toBe(0);

    const pullRes = await runCLI(['pull'], ws2, home);
    expect(pullRes.code, pullRes.output).toBe(0);

    // Both Claude (default) and zcode (custom) receive the skill
    const claudeSkillPath = path.join(ws2, '.claude', 'skills', 'hello-skill', 'SKILL.md');
    const zcodeSkillPath = path.join(ws2, '.zcode', 'skills', 'hello-skill', 'SKILL.md');

    expect(fs.existsSync(claudeSkillPath)).toBe(true);
    expect(fs.existsSync(zcodeSkillPath)).toBe(true);
    expect(fs.readFileSync(claudeSkillPath, 'utf8')).toContain('# Hello Skill');
    expect(fs.readFileSync(zcodeSkillPath, 'utf8')).toContain('# Hello Skill');
  });
});

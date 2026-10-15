import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Muse Code support ──────────────────────────────────────────────────────
//
// End-to-end leg for Muse Code delivery, run through the ACTUAL compiled CLI
// against a local bare team repo. Every expected path below is where Muse Code
// 1.4.6 reads its resources, observed with the real binary: user skills in
// ~/.config/muse/skills, agents in ~/.config/muse/agents and <root>/.agents/agents.
//
// The remote is a synthetic HTTPS URL bridged to a local bare repo through
// git's url.<base>.insteadOf — the same no-network setup as
// trae-support-904.test.ts.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/muse.git';

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

describe('Muse Code resource delivery', () => {
  let sandbox: string;
  let remote: string;

  /** A scratch HOME whose git bridges the fake team URL to the local bare repo. */
  function makeHome(name: string): string {
    const home = path.join(sandbox, name);
    fs.mkdirSync(home, { recursive: true });
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, home);
    return home;
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-muse-e2e-'));
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');

    fs.mkdirSync(path.join(seed, 'skills', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'agents', 'reviewer.yaml'), [
      'name: reviewer',
      'description: Muse fixture agent',
      'instructions: Review the change.',
      'tools: [Read, Grep, Bash, NotebookEdit]',
      'tool_extras:',
      '  claude: { color: blue }',
      '  muse: { color: blue }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: muse-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(seed, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Muse fixture skill\n---\n\n# demo\n',
    );

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers team skills and the teamai skill to ~/.config/muse/skills in user scope', async () => {
    const workDir = path.join(sandbox, 'user-work');
    fs.mkdirSync(workDir, { recursive: true });
    const home = makeHome('home-user');
    // The Muse installer creates its config root on install.
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });

    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'user', '--role', 'dev', '--agent', 'muse', '--force'],
      workDir,
      home,
    );
    expect(result.code, result.output).toBe(0);
    const pulled = await runCLI(['pull'], workDir, home);
    expect(pulled.code, pulled.output).toBe(0);

    const skills = path.join(home, '.config', 'muse', 'skills');
    expect(fs.readFileSync(path.join(skills, 'demo', 'SKILL.md'), 'utf8')).toContain('Muse fixture skill');
    expect(fs.existsSync(path.join(skills, 'teamai', 'SKILL.md'))).toBe(true);
    // Only the keys Muse accepts, tools in its names: anything else and Muse never starts the agent.
    expect(fs.readFileSync(path.join(home, '.config', 'muse', 'agents', 'reviewer.md'), 'utf8')).toBe(
      '---\nname: reviewer\ndescription: Muse fixture agent\ntools:\n  - read_file\n  - search\n  - bash\n---\nReview the change.\n',
    );
    expect(pulled.output).toContain('agents/reviewer.yaml: Muse Code has no tool for NotebookEdit, so its muse copy leaves it out of tools.');
    expect(pulled.output).toContain('agents/reviewer.yaml: Muse Code rejects an agent file setting color, so its muse copy leaves tool_extras.muse.color out.');
  }, 90_000);

  it('installs the teamai hooks in ~/.config/muse/settings.json from a project init', async () => {
    const projectRoot = path.join(sandbox, 'project-hooks');
    fs.mkdirSync(projectRoot, { recursive: true });
    const home = makeHome('home-project-hooks');
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });

    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'dev', '--agent', 'muse', '--force'],
      projectRoot,
      home,
    );
    expect(result.code, result.output).toBe(0);
    const pulled = await runCLI(['pull'], projectRoot, home);
    expect(pulled.code, pulled.output).toBe(0);

    const settings = JSON.parse(fs.readFileSync(path.join(home, '.config', 'muse', 'settings.json'), 'utf8')) as {
      schema_version?: number;
      hooks?: Record<string, { hooks: { command: string }[] }[]>;
    };
    // Only what Muse reads: no co-author attribution keys from the Claude family.
    expect(Object.keys(settings).sort()).toEqual(['hooks', 'schema_version']);
    expect(settings.schema_version).toBe(1);
    const commands = Object.values(settings.hooks ?? {}).flat().flatMap((group) => group.hooks.map((h) => h.command));
    expect(commands.some((command) => command.includes('hook-dispatch session-start --tool muse'))).toBe(true);
    expect(commands.some((command) => command.includes('hook-dispatch stop --tool muse'))).toBe(true);
    // A project init writes no project hooks file: Muse runs user hooks in every workspace.
    expect(fs.existsSync(path.join(projectRoot, '.muse'))).toBe(false);
    expect(fs.readFileSync(path.join(projectRoot, '.agents', 'agents', 'reviewer.md'), 'utf8')).toContain('  - read_file\n');
  }, 90_000);

  // Muse and Codex both read <root>/.agents/skills in project scope.
  it.each(['codex', 'muse'])('keeps one project copy in .agents/skills for Codex and Muse, and uninstalling %s keeps it for the other', async (first) => {
    const projectRoot = path.join(sandbox, `project-shared-${first}`);
    fs.mkdirSync(projectRoot, { recursive: true });
    const home = makeHome(`home-shared-${first}`);
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });

    const init = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'dev', '--agent', 'codex,muse', '--force'],
      projectRoot,
      home,
    );
    expect(init.code, init.output).toBe(0);
    const pulled = await runCLI(['pull'], projectRoot, home);
    expect(pulled.code, pulled.output).toBe(0);
    const shared = path.join(projectRoot, '.agents', 'skills', 'demo', 'SKILL.md');
    expect(fs.readFileSync(shared, 'utf8')).toContain('Muse fixture skill');
    expect(fs.existsSync(path.join(projectRoot, '.codex', 'skills', 'demo'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'skills', 'teamai', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.codex', 'skills', 'teamai'))).toBe(false);
    expect(pulled.output).not.toContain('skill conflict');
    // The shared copy is the one both tools read, so a second pull updates it rather than calling it new.
    const again = await runCLI(['pull', '--force'], projectRoot, home);
    expect(again.code, again.output).toBe(0);
    expect(again.output).not.toContain('new: demo');

    const other = first === 'codex' ? 'muse' : 'codex';
    const partial = await runCLI(['uninstall', '--agent', first, '--force'], projectRoot, home);
    expect(partial.code, partial.output).toBe(0);
    expect(fs.existsSync(shared), `${other} still reads it`).toBe(true);

    const last = await runCLI(['uninstall', '--agent', other, '--force'], projectRoot, home);
    expect(last.code, last.output).toBe(0);
    expect(fs.existsSync(shared)).toBe(false);
  }, 120_000);

  it('does not take a Codex-only machine for a Muse Code install', async () => {
    const workDir = path.join(sandbox, 'codex-work');
    fs.mkdirSync(workDir, { recursive: true });
    const home = makeHome('home-codex');
    // Codex users have ~/.agents (its shared skills root) and ~/.config.
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });

    const result = await runCLI(['init', FAKE_URL, '--scope', 'user', '--role', 'dev', '--force'], workDir, home);
    expect(result.code, result.output).toBe(0);

    expect(fs.existsSync(path.join(home, '.config', 'muse'))).toBe(false);
  }, 90_000);
});

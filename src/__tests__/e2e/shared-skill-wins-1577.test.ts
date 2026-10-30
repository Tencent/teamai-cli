import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], homeDir: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'TeamAI CI',
      GIT_AUTHOR_EMAIL: 'ci@teamai.test',
      GIT_COMMITTER_NAME: 'TeamAI CI',
      GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    },
  });
}

/**
 * A shared skill and a namespace skill of the same name (#1577): a member with
 * no role gets the shared one and is told which copy was skipped; a member
 * whose role receives the namespace still gets the namespace one (#707).
 */
describe('shared skill wins without a role (#1577)', () => {
  let sandbox: string;
  let homeDir: string;
  let remoteRepo: string;

  function writeSkill(relativeDir: string, description: string): void {
    const skillDir = path.join(remoteRepo, 'skills', relativeDir);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${path.basename(relativeDir)}\ndescription: ${description}\n---\n`);
  }

  function project(name: string, role?: string): string {
    const projectRoot = path.join(sandbox, name);
    const localRepo = path.join(projectRoot, '.teamai', 'team-repo');
    // Built fresh so a retry of the test starts from the same state.
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
    git(['clone', '-q', remoteRepo, localRepo], sandbox);
    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remoteRepo}`,
      `username: ${name}`,
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      ...(role ? [`primaryRole: ${role}`] : []),
      '',
    ].join('\n'));
    return projectRoot;
  }

  function deliveredRelease(projectRoot: string): string {
    return fs.readFileSync(path.join(projectRoot, '.claude', 'skills', 'release', 'SKILL.md'), 'utf8');
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-shared-skill-wins-e2e-'));
    homeDir = path.join(sandbox, 'home');
    remoteRepo = path.join(sandbox, 'remote');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(remoteRepo, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(remoteRepo, 'teamai.yaml'), [
      'team: shared-skill-wins-e2e',
      `repo: ${remoteRepo}`,
      'provider: tgit',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: backend',
      '    resources:',
      '      knowledge: [dev]',
      '      skills: [dev]',
      '',
    ].join('\n'));
    writeSkill('release', 'Shared release checklist');
    writeSkill('dev/release', 'Dev release checklist');

    git(['init', '-q', '-b', 'main'], remoteRepo);
    git(['add', '-A'], remoteRepo);
    git(['commit', '-q', '-m', 'fixture'], remoteRepo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers the shared skill to a member with no role and names the skipped copy', async () => {
    const projectRoot = project('no-role');

    const pull = await runCLI(['pull', '--force'], homeDir, projectRoot);

    expect(pull.code, pull.output).toBe(0);
    expect(deliveredRelease(projectRoot)).toContain('Shared release checklist');
    const skipLines = pull.output.split('\n').filter((line) => line.includes('Skipped skills/dev/release'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('Skipped skills/dev/release: the shared skills/release has the same name. To get it instead, set a role that receives dev: teamai roles set backend.');
  });

  it('delivers the namespace skill to a member whose role receives it (#707)', async () => {
    const projectRoot = project('backend-member', 'backend');

    const pull = await runCLI(['pull', '--force'], homeDir, projectRoot);

    expect(pull.code, pull.output).toBe(0);
    expect(deliveredRelease(projectRoot)).toContain('Dev release checklist');
    expect(pull.output).not.toContain('Skipped skills/');
  });
});

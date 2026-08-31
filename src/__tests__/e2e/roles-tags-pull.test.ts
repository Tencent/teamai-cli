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

function writeSkill(repoPath: string, namespace: string, name: string): void {
  const skillDir = path.join(repoPath, 'skills', namespace, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\n`);
}

describe('roles and tags pull integration', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-tags-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const remoteRepo = path.join(sandbox, 'remote');
    const localRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(remoteRepo, 'manifest'), { recursive: true });

    fs.writeFileSync(path.join(remoteRepo, 'teamai.yaml'), [
      'team: roles-tags-e2e',
      `repo: ${remoteRepo}`,
      'provider: tgit',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '    rules: .claude/rules',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: backend',
      '    resources:',
      '      knowledge: [common, backend]',
      '      skills: [backend]',
      '  - id: frontend',
      '    resources:',
      '      knowledge: [common, frontend]',
      '      skills: [frontend]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(remoteRepo, 'tags.yaml'), [
      'skills:',
      '  beta-tag-wanted: [wanted]',
      '  beta-tag-other: [other]',
      '',
    ].join('\n'));
    writeSkill(remoteRepo, 'backend', 'backend-only');
    writeSkill(remoteRepo, 'frontend', 'beta-tag-wanted');
    writeSkill(remoteRepo, 'frontend', 'beta-tag-other');
    writeSkill(remoteRepo, 'frontend', 'frontend-only');

    git(['init', '-q', '-b', 'main'], remoteRepo);
    git(['add', '-A'], remoteRepo);
    git(['commit', '-q', '-m', 'fixture'], remoteRepo);
    git(['clone', '-q', remoteRepo, localRepo], sandbox);

    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${localRepo}`,
      `  remote: ${remoteRepo}`,
      'username: ci-user',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('syncs active-role skills and explicit cross-role tag matches only', async () => {
    const roleResult = await runCLI(['roles', 'set', 'backend'], homeDir, projectRoot);
    expect(roleResult.code, roleResult.output).toBe(0);

    const tagResult = await runCLI(['tags', 'subscribe', 'wanted'], homeDir, projectRoot);
    expect(tagResult.code, tagResult.output).toBe(0);

    const pullResult = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(pullResult.code, pullResult.output).toBe(0);
    expect(pullResult.output).toContain('backend-only');
    expect(pullResult.output).toContain('beta-tag-wanted');
    expect(pullResult.output).not.toContain('beta-tag-other');
    expect(pullResult.output).not.toContain('frontend-only');

    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    expect(fs.existsSync(path.join(skillsDir, 'backend-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'beta-tag-wanted', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'beta-tag-other'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'frontend-only'))).toBe(false);
  });
});

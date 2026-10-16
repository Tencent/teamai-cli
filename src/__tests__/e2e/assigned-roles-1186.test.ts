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
 * `manifest/members.yaml` assigns roles as team data (#1186): the member's own
 * `primaryRole` stops deciding, `roles set` refuses, and a member the file does
 * not list receives shared resources only instead of an unfiltered sync.
 */
describe('assigned roles (#1186)', () => {
  let sandbox: string;
  let homeDir: string;
  let remoteRepo: string;

  function writeSkill(namespace: string | null, name: string): void {
    const skillDir = namespace === null
      ? path.join(remoteRepo, 'skills', name)
      : path.join(remoteRepo, 'skills', namespace, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\n`);
  }

  /** A project checkout of the team repo whose config names `username`. */
  function project(name: string, username: string, localRole?: string): string {
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
      `username: ${username}`,
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      ...(localRole ? [`primaryRole: ${localRole}`] : []),
      '',
    ].join('\n'));
    return projectRoot;
  }

  function deliveredSkills(projectRoot: string): string[] {
    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    return fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-assigned-roles-e2e-'));
    homeDir = path.join(sandbox, 'home');
    remoteRepo = path.join(sandbox, 'remote');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(remoteRepo, 'manifest'), { recursive: true });

    fs.writeFileSync(path.join(remoteRepo, 'teamai.yaml'), [
      'team: assigned-roles-e2e',
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
      '      knowledge: [backend]',
      '      skills: [backend]',
      '  - id: frontend',
      '    resources:',
      '      knowledge: [frontend]',
      '      skills: [frontend]',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), [
      'version: 1',
      'members:',
      '  alice: [frontend]',
      'default: []',
      '',
    ].join('\n'));
    writeSkill('backend', 'backend-only');
    writeSkill('frontend', 'frontend-only');

    git(['init', '-q', '-b', 'main'], remoteRepo);
    git(['add', '-A'], remoteRepo);
    git(['commit', '-q', '-m', 'fixture'], remoteRepo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers the assigned role, not the one the member set locally, and refuses roles set', async () => {
    // The config says backend; the team assigned frontend.
    const projectRoot = project('alice-project', 'alice', 'backend');

    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(list.code, list.output).toBe(0);
    expect(JSON.parse(list.output)).toMatchObject({
      roles: ['frontend'],
      primaryRole: 'frontend',
      source: 'assigned',
      assignmentFile: 'manifest/members.yaml',
    });

    const set = await runCLI(['roles', 'set', 'backend'], homeDir, projectRoot);
    expect(set.code).toBe(1);
    expect(set.output).toContain('manifest/members.yaml');

    const pull = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(pull.code, pull.output).toBe(0);
    // `teamai` is the CLI's own discovery skill, delivered to every member.
    expect(deliveredSkills(projectRoot)).toEqual(['frontend-only', 'teamai']);

    // The refused `roles set` left the config file alone, and so did the pull.
    const config = fs.readFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), 'utf8');
    expect(config).toContain('primaryRole: backend');
  });

  // The assignment lives in the repo the pull itself refreshes: resolved before
  // that, it would deliver the previous roles and record the new revision as
  // synced, so no later pull would fix it without --force.
  it('delivers a reassignment on the pull that fetches it', async () => {
    const projectRoot = project('bob-project', 'bob');
    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), [
      'version: 1',
      'members:',
      '  alice: [frontend]',
      '  bob: [frontend]',
      'default: []',
      '',
    ].join('\n'));
    git(['commit', '-qam', 'assign bob to frontend'], remoteRepo);
    const first = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(first.code, first.output).toBe(0);
    expect(deliveredSkills(projectRoot)).toEqual(['frontend-only', 'teamai']);

    fs.writeFileSync(path.join(remoteRepo, 'manifest', 'members.yaml'), [
      'version: 1',
      'members:',
      '  alice: [frontend]',
      '  bob: [backend]',
      'default: []',
      '',
    ].join('\n'));
    git(['commit', '-qam', 'reassign bob to backend'], remoteRepo);

    // A plain pull, as a session start runs it: one pull, no --force.
    const second = await runCLI(['pull'], homeDir, projectRoot);
    expect(second.code, second.output).toBe(0);
    expect(deliveredSkills(projectRoot)).toContain('backend-only');
    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(list.output)).toMatchObject({ roles: ['backend'] });
  });

  it('delivers no role namespace to a member the file does not list', async () => {
    const projectRoot = project('carol-project', 'carol');

    const list = await runCLI(['roles', 'list', '--json'], homeDir, projectRoot);
    expect(JSON.parse(list.output)).toMatchObject({ roles: [], primaryRole: null, source: 'default' });

    const pull = await runCLI(['pull', '--force'], homeDir, projectRoot);
    expect(pull.code, pull.output).toBe(0);
    // Without the assignments file this role-less member would receive every
    // namespace — both of these skills. `default: []` closes that.
    expect(deliveredSkills(projectRoot)).toEqual(['teamai']);
  });
});

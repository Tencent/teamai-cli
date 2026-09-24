import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// ─── projects add / update / remove e2e (issue #756) ────────────────────────
//
// An admin edits manifest/projects.yaml through the ACTUAL compiled CLI, the
// pushed branch is merged on the team remote (standing in for the PR), and a
// member directory pulls:
//   1. `projects add` creates projects.yaml from nothing → pull delivers;
//   2. `projects update --add-namespaces` → pull delivers the new namespace,
//      `--remove-namespaces` → pull removes it again;
//   3. `projects remove` → a member that still has the project active pulls
//      and the project's deployed skills, rules and agents are reclaimed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

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

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function writeSkill(repoPath: string, namespace: string, name: string): void {
  const skillDir = path.join(repoPath, 'skills', namespace, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${namespace} fixture\n---\n\n# ${name}\n`,
  );
}

describe('projects add/update/remove via the real CLI (issue #756)', () => {
  let sandbox: string;
  let home: string;
  let adminRoot: string;
  let memberRoot: string;
  let remote: string;
  let skillsDir: string;

  function setupDir(root: string, username: string): void {
    const teamRepo = path.join(root, '.teamai', 'team-repo');
    for (const dir of ['skills', 'rules', 'agents']) fs.mkdirSync(path.join(root, '.claude', dir), { recursive: true });
    git(['clone', '-q', remote, teamRepo], sandbox);
    fs.writeFileSync(path.join(root, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      `username: ${username}`,
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${root}`,
      '',
    ].join('\n'));
  }

  /** Run an admin command, then merge the branch it pushed (the PR) into main. */
  async function adminEdit(args: string[]): Promise<RunResult> {
    // Push branch names have one-second resolution; keep consecutive edits apart.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await runCLI(['projects', ...args], adminRoot, home);
    const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/admin/'], remote);
    expect(branch, result.output).toMatch(/^teamai\/push\/admin\//);
    git(['update-ref', 'refs/heads/main', `refs/heads/${branch}`], remote);
    git(['update-ref', '-d', `refs/heads/${branch}`], remote);
    return result;
  }

  function remoteManifest(): { projects: Array<{ id: string; resources: Record<string, string[]> }> } {
    return YAML.parse(git(['show', 'main:manifest/projects.yaml'], remote));
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-projects-crud-e2e-'));
    home = path.join(sandbox, 'home');
    adminRoot = path.join(sandbox, 'admin');
    memberRoot = path.join(sandbox, 'member');
    remote = path.join(sandbox, 'team.git');
    skillsDir = path.join(memberRoot, '.claude', 'skills');
    const seed = path.join(sandbox, 'seed');
    fs.mkdirSync(home, { recursive: true });

    // No manifest/projects.yaml yet: the first `projects add` creates it.
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: projects-crud-e2e',
      `repo: ${remote}`,
      'provider: git',
      'reviewers: []',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '    rules: .claude/rules',
      '    agents: .claude/agents',
      '',
    ].join('\n'));
    writeSkill(seed, 'alpha', 'alpha-only');
    fs.mkdirSync(path.join(seed, 'rules', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'rules', 'shared-rule.md'), '# Shared rule\n');
    fs.writeFileSync(path.join(seed, 'rules', 'alpha', 'alpha-rule.md'), '# Alpha rule\n');
    fs.mkdirSync(path.join(seed, 'agents', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(seed, 'agents', 'alpha', 'alpha-agent.yaml'),
      'name: alpha-agent\ndescription: Alpha fixture\ninstructions: Work on alpha.\n',
    );
    writeSkill(seed, 'beta', 'beta-only');
    writeSkill(seed, 'extra', 'extra-only');

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    setupDir(adminRoot, 'admin');
    setupDir(memberRoot, 'member');
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('add creates projects.yaml and pull delivers the new project', async () => {
    const add = await adminEdit(['add', 'alpha', '--namespaces', 'alpha', '--name', 'Alpha']);
    expect(add.output).toContain('Add project "alpha"');
    await adminEdit(['add', 'beta', '--namespaces', 'beta']);

    const manifest = remoteManifest();
    expect(manifest.projects.map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(manifest.projects[0].resources).toEqual({
      knowledge: ['alpha'],
      skills: ['alpha'],
      learnings: ['alpha'],
      agents: ['alpha'],
    });

    // The member picks up the merged manifest before activating the project.
    const sync = await runCLI(['pull', '--force'], memberRoot, home);
    expect(sync.code, sync.output).toBe(0);
    const set = await runCLI(['projects', 'set', 'alpha'], memberRoot, home);
    expect(set.output).toContain('Active projects set to: alpha');
    const pull = await runCLI(['pull', '--force'], memberRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, 'alpha-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'beta-only'))).toBe(false);
    expect(fs.existsSync(path.join(memberRoot, '.claude', 'rules', 'alpha', 'alpha-rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(memberRoot, '.claude', 'agents', 'alpha-agent.md'))).toBe(true);
  }, 60_000);

  it('update adds a namespace that pull delivers, and removes it again', async () => {
    await adminEdit(['update', 'alpha', '--add-namespaces', 'extra']);
    let pull = await runCLI(['pull', '--force'], memberRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, 'extra-only', 'SKILL.md'))).toBe(true);

    await adminEdit(['update', 'alpha', '--remove-namespaces', 'extra']);
    pull = await runCLI(['pull', '--force'], memberRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, 'extra-only'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'alpha-only', 'SKILL.md'))).toBe(true);
  }, 60_000);

  it('remove reclaims the project skills, rules and agents from a member that still has it active', async () => {
    const remove = await adminEdit(['remove', 'alpha']);
    expect(remove.output).toContain('Remove project "alpha"');
    expect(remoteManifest().projects.map((p) => p.id)).toEqual(['beta']);

    const pull = await runCLI(['pull', '--force'], memberRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('Unknown project "alpha"');
    expect(fs.existsSync(path.join(skillsDir, 'alpha-only'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'beta-only'))).toBe(false);
    expect(fs.existsSync(path.join(memberRoot, '.claude', 'rules', 'alpha', 'alpha-rule.md'))).toBe(false);
    expect(fs.existsSync(path.join(memberRoot, '.claude', 'rules', 'shared-rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(memberRoot, '.claude', 'agents', 'alpha-agent.md'))).toBe(false);
  }, 60_000);
});

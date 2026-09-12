import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── multi-project e2e (issue #375) ─────────────────────────────────────────
//
// The unit suite (projects.test.ts / members.test.ts / pull-project-cleanup)
// drives the project resolvers directly. This is the missing END-TO-END leg for
// the user-facing commands, run through the ACTUAL compiled CLI:
//   1. `projects set <id>` scopes a directory to one project;
//   2. `pull --force` deploys ONLY that project's skills namespace and prunes an
//      inactive project's skills — the isolation guarantee of #375;
//   3. `push --project <id>` routes a skill into the project's skills namespace
//      (skills/<ns>/…) on the team remote, agreeing with what pull syncs.

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

describe('multi-project resource isolation via the real CLI (issue #375)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let remote: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-multiproject-e2e-'));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');
    const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    // Two projects, each owning a distinct skills namespace.
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: multiproject-e2e',
      `repo: ${remote}`,
      'provider: git',
      'reviewers: []',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: alpha',
      '    name: Alpha',
      '    resources:',
      '      skills: [alpha]',
      '      learnings: [alpha]',
      '  - id: billing',
      '    name: Billing',
      '    resources:',
      '      skills: [billing]',
      '      learnings: [billing]',
      '',
    ].join('\n'));
    writeSkill(seed, 'alpha', 'alpha-only');
    writeSkill(seed, 'billing', 'billing-only');

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);
    git(['clone', '-q', remote, teamRepo], projectRoot);

    fs.writeFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      `  remote: ${remote}`,
      'username: mp-user',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      '',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('deploys only the active project\'s skills and prunes an inactivated project', async () => {
    const skillsDir = path.join(projectRoot, '.claude', 'skills');

    // Activate alpha → only alpha's skill deploys, billing's does not.
    const setAlpha = await runCLI(['projects', 'set', 'alpha'], projectRoot, home);
    expect(setAlpha.code, setAlpha.output).toBe(0);

    const pullAlpha = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pullAlpha.code, pullAlpha.output).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, 'alpha-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'billing-only'))).toBe(false);

    // Switch alpha → billing. The now-inactive alpha skill must be PRUNED, and
    // billing's deployed — the core cross-project isolation guarantee.
    const setBilling = await runCLI(['projects', 'set', 'billing'], projectRoot, home);
    expect(setBilling.code, setBilling.output).toBe(0);

    const pullBilling = await runCLI(['pull', '--force'], projectRoot, home);
    expect(pullBilling.code, pullBilling.output).toBe(0);
    expect(fs.existsSync(path.join(skillsDir, 'billing-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'alpha-only'))).toBe(false);
  }, 60_000);

  it('routes push --project into the project skills namespace on the remote', async () => {
    // A new local skill pushed with --project billing must land under
    // skills/billing/ on the pushed branch (the namespace pull reads), proving
    // push and pull agree on the project → namespace mapping.
    const skillPath = '.claude/skills/pushed-proof';
    fs.mkdirSync(path.join(projectRoot, skillPath), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, skillPath, 'SKILL.md'),
      '---\nname: pushed-proof\ndescription: push --project e2e\n---\n\n# Pushed proof\n',
    );

    const pushResult = await runCLI(
      ['push', '--skill', skillPath, '--project', 'billing', '--all'],
      projectRoot,
      home,
    );
    // provider: git cannot open a PR, so the command exits non-zero AFTER pushing
    // the branch — the branch content is what we assert (same contract as the
    // role-scoped push e2e).
    expect(pushResult.output).not.toContain('No changes to push');
    expect(pushResult.output).toContain('Pushed branch teamai/push/mp-user/');

    const branch = git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/mp-user/'],
      remote,
    );
    expect(branch).toMatch(/^teamai\/push\/mp-user\//);
    expect(git(['show', `${branch}:skills/billing/pushed-proof/SKILL.md`], remote))
      .toContain('# Pushed proof');
  }, 60_000);
});

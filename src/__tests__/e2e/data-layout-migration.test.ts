import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../../utils/partition.js';

// ─── data-layout migration e2e (issue #374) ─────────────────────────────────
//
// The unit suite (migrate.test.ts) drives planMigration/runMigration directly.
// This is the missing END-TO-END leg: seed a real legacy `<repo>/.teamai/`
// layout, run the ACTUAL compiled CLI (`teamai pull`), and assert the preAction
// hook migrated the data into the partition `~/.teamai/projects/<slug>/`, left
// the workspace residue-free, and that pull then ran successfully THROUGH the
// migrated clone (repo.localPath rebased onto the partition).

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

describe('data-layout auto-migration via the real CLI (issue #374)', () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let legacyDir: string;
  let partitionDir: string;

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    // realpath the base so the anchor the CLI computes (realpath of show-toplevel)
    // matches the slug we compute here — macOS /tmp and /var are symlinks.
    sandbox = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-datalayout-e2e-')));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const remoteRepo = path.join(sandbox, 'remote');
    legacyDir = path.join(projectRoot, '.teamai');
    const legacyTeamRepo = path.join(legacyDir, 'team-repo');

    fs.mkdirSync(home, { recursive: true });

    // The business repo MUST be a real git repo — resolveAnchors (hence migration)
    // stands down outside one.
    fs.mkdirSync(projectRoot, { recursive: true });
    git(['init', '-q', '-b', 'main'], projectRoot);
    git(['commit', '--allow-empty', '-q', '-m', 'business init'], projectRoot);

    // Seed the team remote with a deployable skill so a successful pull proves the
    // migrated clone is actually usable, not just present.
    fs.mkdirSync(path.join(remoteRepo, 'skills', 'team', 'mig-proof'), { recursive: true });
    fs.writeFileSync(path.join(remoteRepo, 'teamai.yaml'), [
      'team: datalayout-e2e',
      `repo: ${remoteRepo}`,
      'provider: git',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(remoteRepo, 'skills', 'team', 'mig-proof', 'SKILL.md'),
      '---\nname: mig-proof\ndescription: migration e2e fixture\n---\n\n# Mig proof\n',
    );
    git(['init', '-q', '-b', 'main'], remoteRepo);
    git(['add', '-A'], remoteRepo);
    git(['commit', '-q', '-m', 'seed team'], remoteRepo);

    // Build a genuine LEGACY layout: machine data (incl. a plaintext secret and a
    // real team-repo clone) under <repo>/.teamai/, with localPath pointing INTO it.
    git(['clone', '-q', remoteRepo, legacyTeamRepo], projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'config.yaml'), [
      'repo:',
      `  localPath: ${legacyTeamRepo}`,
      `  remote: ${remoteRepo}`,
      '  kind: git',
      'username: legacy-user',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({ lastPullRev: null }));
    fs.writeFileSync(path.join(legacyDir, 'env'), 'TEAM_TOKEN=s3cret\n');

    // The partition path the CLI will migrate INTO. projectSlug is HOME-independent,
    // so join it onto the sandbox HOME the child process will use.
    partitionDir = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('migrates a legacy .teamai into the partition and pulls through it', async () => {
    const result = await runCLI(['pull', '--force'], projectRoot, home);
    expect(result.code, result.output).toBe(0);

    // ── Machine data landed in the partition ──
    expect(fs.existsSync(path.join(partitionDir, 'config.yaml')), result.output).toBe(true);
    expect(fs.existsSync(path.join(partitionDir, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(partitionDir, 'env'))).toBe(true);
    // The anchor reverse-lookup file points back at the business repo.
    expect(fs.readFileSync(path.join(partitionDir, 'anchor'), 'utf8').trim()).toBe(projectRoot);

    // ── The migrated team-repo clone survived intact (raw copy, not .git-filtered) ──
    const migratedRepo = path.join(partitionDir, 'team-repo');
    expect(fs.existsSync(path.join(migratedRepo, '.git'))).toBe(true);
    expect(() => git(['rev-parse', 'HEAD'], migratedRepo)).not.toThrow();

    // ── repo.localPath was rebased from the legacy dir onto the partition ──
    expect(fs.readFileSync(path.join(partitionDir, 'config.yaml'), 'utf8'))
      .toContain(`localPath: ${migratedRepo}`);

    // ── Workspace is residue-free: legacy gone, backup present and git-ignored ──
    expect(fs.existsSync(legacyDir)).toBe(false);
    const backup = `${legacyDir}.bak`;
    expect(fs.existsSync(path.join(backup, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(backup, 'env'))).toBe(true);
    expect(fs.readFileSync(path.join(backup, '.gitignore'), 'utf8')).toContain('*');

    // ── Pull ran THROUGH the migrated clone: the team skill deployed ──
    expect(fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'mig-proof', 'SKILL.md')))
      .toBe(true);
  }, 60_000);
});

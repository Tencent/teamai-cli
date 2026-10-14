import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

function runCLI(args: string[], homeDir: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: homeDir, USERPROFILE: homeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

/** A v1 votes file: no `version:` key, one `at` timestamp per docId. */
function v1Votes(docIds: string[]): string {
  return ['votes:', ...docIds.map((id) => `  ${id}:\n    at: 2026-06-01T00:00:00Z`), ''].join('\n');
}

// `recall maintenance` only aggregates votes, but it read them through
// loadUserVotes, which persists the v1 → v2 upgrade. A preview therefore
// rewrote every v1 votes file in the team's reports branch (#900, C7).
describe('recall maintenance --dry-run leaves v1 votes files alone (#900 C7)', () => {
  let sandbox: string;
  let homeDir: string;
  let votesDir: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-c7-'));
    homeDir = path.join(sandbox, 'home');
    const remote = path.join(sandbox, 'remote.git');
    const localPath = path.join(homeDir, '.teamai', 'team-repo');
    const work = path.join(sandbox, 'work');
    votesDir = path.join(homeDir, '.teamai', 'reports-wt', 'votes');

    fs.mkdirSync(path.join(homeDir, '.teamai'), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);

    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    fs.writeFileSync(path.join(work, 'teamai.yaml'), [
      'team: c7', 'description: c7 fixture', `repo: ${fwd(remote)}`,
      'provider: git', 'usageReport: false', '',
    ].join('\n'));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'knowledge'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', 'origin', 'main'], work);

    // Reports branch carries the votes maintenance reads.
    git(['checkout', '-q', '--orphan', 'teamai-reports'], work);
    git(['rm', '-rq', '--cached', '.'], work);
    fs.rmSync(path.join(work, 'teamai.yaml'));
    fs.mkdirSync(path.join(work, 'votes'), { recursive: true });
    fs.writeFileSync(path.join(work, 'votes', 'alice.yaml'), v1Votes(['lesson', 'guide']));
    fs.writeFileSync(path.join(work, 'votes', 'bob.yaml'), v1Votes(['lesson']));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'reports'], work);
    git(['push', '-q', 'origin', 'teamai-reports'], work);

    git(['checkout', '-q', '--orphan', 'teamai-learnings'], work);
    git(['rm', '-rq', '--cached', '.'], work);
    fs.rmSync(path.join(work, 'votes'), { recursive: true, force: true });
    fs.mkdirSync(path.join(work, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(work, 'learnings', 'lesson.md'), [
      '---', 'docId: lesson', 'created: 2026-06-01T00:00:00Z', 'confidence: 0.1', '---', '', '# lesson', '',
    ].join('\n'));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'learnings'], work);
    git(['push', '-q', 'origin', 'teamai-learnings'], work);

    git(['clone', '-q', remote, localPath], sandbox);
    fs.writeFileSync(path.join(homeDir, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${fwd(localPath)}`, `  remote: ${fwd(remote)}`, '  kind: git',
      'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', '',
    ].join('\n'));
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function votesSnapshot(): Record<string, string> {
    return Object.fromEntries(
      fs.readdirSync(votesDir).map((f) => [f, fs.readFileSync(path.join(votesDir, f), 'utf-8')]),
    );
  }

  it.each([
    ['--confidence-writeback'],
    ['--update-quality'],
    ['--prune'],
  ])('maintenance %s --dry-run keeps them v1 on disk', async (mode) => {
    // A dry run no longer creates the reports worktree, so a read-only
    // `members` materializes it; snapshot after that so the comparison is
    // about the scan, not about the checkout appearing.
    await runCLI(['members'], homeDir, sandbox);
    const before = votesSnapshot();
    expect(Object.keys(before).sort()).toEqual(['alice.yaml', 'bob.yaml']);
    expect(before['alice.yaml']).not.toContain('version: 2');

    const { output } = await runCLI(['recall', 'maintenance', mode, '--dry-run'], homeDir, sandbox);

    expect(votesSnapshot()).toEqual(before);
    expect(output).not.toMatch(/\bError\b/);
  });
});

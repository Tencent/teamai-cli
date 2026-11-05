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

/** A v2 votes file: the v1 shape carries no counters, so it never reaches a threshold. */
function v2Votes(recalls: Record<string, number>): string {
  const lines = ['version: 2', 'votes:'];

  for (const [docId, recalled] of Object.entries(recalls)) {
    lines.push(
      `  ${docId}:`,
      `    recalled_count: ${recalled}`,
      '    upvoted_count: 0',
      '    last_recalled_at: 2026-06-01T00:00:00Z',
    );
  }

  lines.push('deltas: {}');

  return `${lines.join('\n')}\n`;
}

// A skill's vote id is its bare name while its file is `<name>/SKILL.md` (or
// `<namespace>/<name>/SKILL.md`), so `recall maintenance --update-quality` looked
// the id up as `<id>.md`, found nothing, and skipped every skill in silence
// (#1735).
describe('recall maintenance --update-quality lists a skill it should flag (#1735)', () => {
  let sandbox: string;
  let homeDir: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1735-'));
    homeDir = path.join(sandbox, 'home');
    const remote = path.join(sandbox, 'remote.git');
    const localPath = path.join(homeDir, '.teamai', 'team-repo');
    const work = path.join(sandbox, 'work');

    fs.mkdirSync(path.join(homeDir, '.teamai'), { recursive: true });
    fs.mkdirSync(remote, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);

    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    fs.writeFileSync(path.join(work, 'teamai.yaml'), [
      'team: t1735', 'description: t1735 fixture', `repo: ${fwd(remote)}`,
      'provider: git', 'usageReport: false', '',
    ].join('\n'));
    fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(work, 'docs', 'guide.md'), '# guide\n');
    fs.mkdirSync(path.join(work, 'skills', 'pay', 'refund-skill'), { recursive: true });
    fs.writeFileSync(path.join(work, 'skills', 'pay', 'refund-skill', 'SKILL.md'), [
      '---', 'name: refund-skill', 'description: refund a payment', '---', '', '# refund skill', '',
    ].join('\n'));
    fs.mkdirSync(path.join(work, 'skills', 'flat-skill'), { recursive: true });
    fs.writeFileSync(path.join(work, 'skills', 'flat-skill', 'SKILL.md'), [
      '---', 'name: flat-skill', 'description: a flat skill', '---', '', '# flat skill', '',
    ].join('\n'));
    git(['add', '-A'], work);
    git(['commit', '-qm', 'knowledge'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', 'origin', 'main'], work);

    // Reports branch carries the votes maintenance reads.
    git(['checkout', '-q', '--orphan', 'teamai-reports'], work);
    git(['rm', '-rq', '--cached', '.'], work);
    fs.rmSync(path.join(work, 'teamai.yaml'));
    fs.rmSync(path.join(work, 'docs'), { recursive: true, force: true });
    fs.rmSync(path.join(work, 'skills'), { recursive: true, force: true });
    fs.mkdirSync(path.join(work, 'votes'), { recursive: true });
    // Five recalls from two members for each: the three that exist, plus one id
    // that matches no file at all.
    fs.writeFileSync(
      path.join(work, 'votes', 'alice.yaml'),
      v2Votes({ 'refund-skill': 3, 'flat-skill': 3, guide: 3, 'gone-skill': 3 }),
    );
    fs.writeFileSync(
      path.join(work, 'votes', 'bob.yaml'),
      v2Votes({ 'refund-skill': 2, 'flat-skill': 2, guide: 2, 'gone-skill': 2 }),
    );
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

  it('reports both skill layouts, a doc, and the id it could not place', async () => {
    // A dry run does not create the reports worktree; `members` materializes it.
    await runCLI(['members'], homeDir, sandbox);

    const { output } = await runCLI(['recall', 'maintenance', '--update-quality', '--dry-run'], homeDir, sandbox);

    expect(output).toContain('Found 3 entry(ies) recalled often but rarely adopted:');
    expect(output).toMatch(/\[skills\] refund-skill: recalled 5x by 2 users/);
    expect(output).toMatch(/\[skills\] flat-skill: recalled 5x by 2 users/);
    expect(output).toMatch(/\[docs\] guide: recalled 5x by 2 users/);
    // The one id with no file behind it is named instead of dropped in silence.
    expect(output).toContain('gone-skill');
    expect(output).not.toMatch(/\bError\b/);
  }, 120_000);
});

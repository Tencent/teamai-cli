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

type Ran = { code: number | null; stdout: string; stderr: string };

function runCLI(args: string[], { home, cwd, bin, extra }: { home: string; cwd: string; bin: string; extra?: Record<string, string> }): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TEAMAI_AI_TOOL: '', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

/** Two members who each recalled `guide` and `lesson` three times and adopted neither: both are stale. */
function votes(): string {
  return ['version: 2', 'votes:', ...['guide', 'lesson'].map((id) => `  ${id}:\n    recalled_count: 3\n    upvoted_count: 0\n    last_recalled_at: '2026-06-01T00:00:00Z'`), 'deltas: {}', ''].join('\n');
}

/**
 * A `claude` that answers each prompt with a draft of the entry it names, and fails one that holds `fails`. With
 * `FAKE_CLAUDE_HANGS` it answers nothing for that many milliseconds first.
 */
function fakeClaude(bin: string, fails: string | undefined): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => setTimeout(() => {
  const fails = ${JSON.stringify(fails ?? null)};
  if (fails !== null && stdin.includes(fails)) { process.stderr.write('Authentication failed\\n'); process.exit(2); }
  const title = /^# (.+)$/m.exec(stdin)?.[1] ?? 'entry';
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '---\\ndate: 2026-11-04\\n---\\n\\n# ' + title + ', updated\\n', usage: { input_tokens: 10, output_tokens: 5 } }));
}, Number(process.env.FAKE_CLAUDE_HANGS ?? 0)));\n`, { mode: 0o755 });
}

describe('recall maintenance --update-quality', () => {
  let sandbox: string;
  let home: string;
  let docs: string;
  let remote: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-update-quality-'));
    home = path.join(sandbox, 'home');
    remote = path.join(sandbox, 'remote.git');
    const localPath = path.join(home, '.teamai', 'team-repo');
    const work = path.join(sandbox, 'work');
    docs = path.join(localPath, 'docs');

    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
    fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: quality', 'description: quality fixture', `repo: ${fwd(remote)}`, 'provider: git', 'usageReport: false', ''].join('\n'));
    for (const id of ['guide', 'lesson']) fs.writeFileSync(path.join(work, 'docs', `${id}.md`), `---\ndate: 2026-01-01\n---\n\n# ${id}\n`);
    git(['add', '-A'], work);
    git(['commit', '-qm', 'knowledge'], work);
    git(['remote', 'add', 'origin', remote], work);
    git(['push', '-q', 'origin', 'main'], work);

    git(['checkout', '-q', '--orphan', 'teamai-reports'], work);
    git(['rm', '-rq', '--cached', '.'], work);
    fs.rmSync(path.join(work, 'teamai.yaml'));
    fs.rmSync(path.join(work, 'docs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(work, 'votes'), { recursive: true });
    fs.writeFileSync(path.join(work, 'votes', 'alice.yaml'), votes());
    fs.writeFileSync(path.join(work, 'votes', 'bob.yaml'), votes());
    git(['add', '-A'], work);
    git(['commit', '-qm', 'reports'], work);
    git(['push', '-q', 'origin', 'teamai-reports'], work);

    git(['clone', '-q', remote, localPath], sandbox);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${fwd(localPath)}`, `  remote: ${fwd(remote)}`, '  kind: git',
      'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', '',
    ].join('\n'));
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const run = (args: string[], fails?: string, extra?: Record<string, string>, cwd = sandbox): Promise<Ran> => {
    const bin = fs.mkdtempSync(path.join(sandbox, 'bin-'));
    fakeClaude(bin, fails);
    for (const id of ['guide', 'lesson']) fs.rmSync(path.join(docs, `${id}.md.draft.md`), { force: true });

    return runCLI(['recall', 'maintenance', '--update-quality', ...args], { home, cwd, bin, extra });
  };

  const listing = [
    'ℹ Found 2 entry(ies) recalled often but rarely adopted:',
    'ℹ   - [docs] guide: recalled 6x by 2 users, adopted 0x',
    'ℹ   - [docs] lesson: recalled 6x by 2 users, adopted 0x',
  ];

  it('lists the stale entries with --dry-run, and drafts none', async () => {
    // A dry run creates no reports worktree, so a read-only command materializes it first.
    await runCLI(['members'], { home, cwd: sandbox, bin: sandbox });
    const { code, stdout } = await run(['--dry-run']);

    expect(stdout.split('\n').filter((line) => line !== '')).toEqual(listing);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(docs, 'lesson.md.draft.md'))).toBe(false);
  });

  it('writes a draft beside each stale entry and prints what it wrote', async () => {
    const { code, stdout, stderr } = await run([]);

    expect(stdout.split('\n').filter((line) => line !== '')).toEqual([
      ...listing,
      'ℹ ',
      'Generating AI-powered update drafts...',
      `✔   Draft written: ${path.join(docs, 'guide.md')}.draft.md`,
      `✔   Draft written: ${path.join(docs, 'lesson.md')}.draft.md`,
      'Review drafts, then rename .draft.md -> .md to apply updates.',
    ]);
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(docs, 'lesson.md.draft.md'), 'utf8')).toBe('---\ndate: 2026-11-04\n---\n\n# lesson, updated');
    // The run ended, so there is nothing to continue.
    expect(stderr).toBe('');
  });

  it('writes the drafts from inside the team checkout that holds the knowledge', async () => {
    const { code, stdout, stderr } = await run([], undefined, undefined, path.dirname(docs));

    expect(stdout.split('\n').filter((line) => line !== '').slice(-3)).toEqual([
      `✔   Draft written: ${path.join(docs, 'guide.md')}.draft.md`,
      `✔   Draft written: ${path.join(docs, 'lesson.md')}.draft.md`,
      'Review drafts, then rename .draft.md -> .md to apply updates.',
    ]);
    expect(code, stderr).toBe(0);
    expect(fs.existsSync(path.join(docs, 'lesson.md.draft.md'))).toBe(true);
  });

  it('says how to continue a run stopped before it ended, and leaves it open', async () => {
    const bin = fs.mkdtempSync(path.join(sandbox, 'bin-'));
    fakeClaude(bin, undefined);
    const child = spawn('node', [CLI, 'recall', 'maintenance', '--update-quality'], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TEAMAI_AI_TOOL: '', FAKE_CLAUDE_HANGS: '5000' },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: sandbox,
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin.end();
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('close', (_code, signal) => resolve(signal)));
    // The stale entries are listed, then the first draft is asked for: stop teamai while claude thinks.
    await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();

      if (stdout.includes('Generating AI-powered update drafts...')) setTimeout(resolve, 1000);
    }));
    child.kill('SIGINT');

    expect(await exited).toBe('SIGINT');
    const hint = /^ℹ Run (r[0-9a-f]{16}) is still open\. Continue it with: teamai workflow resume (r[0-9a-f]{16})$/m.exec(stderr);
    expect(hint, stderr).not.toBeNull();
    expect(hint?.[2]).toBe(hint?.[1]);
    const runFile = path.join(home, '.teamai', 'workflows', 'runs', `${hint?.[1]}.json`);
    const stopped = JSON.parse(fs.readFileSync(runFile, 'utf8')) as { status: string };
    expect(stopped.status).toBe('running');
    // Another test reads every run in this home as one it started.
    fs.rmSync(runFile);
    fs.rmSync(runFile.replace(/\.json$/, ''), { recursive: true, force: true });
  });

  it('runs inside an agent session as it does in the person\'s terminal', async () => {
    const { code, stdout } = await run([], undefined, { CLAUDE_CODE_SESSION_ID: 'agent-session' });

    expect(stdout.split('\n').filter((line) => line !== '')).toEqual([
      ...listing,
      'ℹ ',
      'Generating AI-powered update drafts...',
      `✔   Draft written: ${path.join(docs, 'guide.md')}.draft.md`,
      `✔   Draft written: ${path.join(docs, 'lesson.md')}.draft.md`,
      'Review drafts, then rename .draft.md -> .md to apply updates.',
    ]);
    expect(code).toBe(0);
  });

  it('still refuses an agent that starts the workflow by name, which has invoke: deny', async () => {
    const { code, stdout } = await runCLI(['workflow', 'start', 'teamai-draft-learning-updates', '--driver', 'local'], { home, cwd: sandbox, bin: sandbox, extra: { CLAUDE_CODE_SESSION_ID: 'agent-session' } });

    expect(JSON.parse(stdout)).toMatchObject({ error: { code: 'invoke_denied' } });
    expect(code).toBe(1);
  });

  it('drafts the other entries when one fails, names the one it could not draft and why, and exits 1', async () => {
    const { code, stdout, stderr } = await run([], '# guide');

    expect(stdout).toContain(`✔   Draft written: ${path.join(docs, 'lesson.md')}.draft.md`);
    expect(stdout).toContain(`Could not draft ${path.join(docs, 'guide.md')}.`);
    expect(stderr).toContain('failed with tool_failed: AI call failed (tool: claude): Authentication failed');
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(docs, 'guide.md.draft.md'))).toBe(false);
  });

  it('drives its own run inside the step of a team workflow that runs it, whatever driver the member set', async () => {
    const team = path.join(fs.mkdtempSync(path.join(sandbox, 'team-edit-')), 'team');
    git(['clone', '-q', remote, team], sandbox);
    fs.mkdirSync(path.join(team, 'workflows'));
    fs.writeFileSync(path.join(team, 'workflows', 'weekly-quality.yaml'), [
      'schemaVersion: v1alpha1', 'name: weekly-quality', 'description: Drafts updates of the stale entries.',
      'steps:', '  - id: drafts', '    command: teamai recall maintenance --update-quality', '',
    ].join('\n'));
    git(['add', '-A'], team);
    git(['commit', '-qm', 'weekly quality'], team);
    git(['push', '-q', 'origin', 'main'], team);
    const pulled = await runCLI(['pull'], { home, cwd: sandbox, bin: sandbox });
    expect(pulled.code, pulled.stderr).toBe(0);
    const config = path.join(home, '.teamai', 'config.yaml');
    const member = fs.readFileSync(config, 'utf8');
    // Outside a run this leaves the shortcut's run open for another driver; inside a step, the step's process drives it.
    fs.writeFileSync(config, `${member}workflows:\n  driver: none\n`);
    const bin = fs.mkdtempSync(path.join(sandbox, 'bin-'));
    fakeClaude(bin, undefined);
    for (const id of ['guide', 'lesson']) fs.rmSync(path.join(docs, `${id}.md.draft.md`), { force: true });

    try {
      const { code, stdout, stderr } = await runCLI(['workflow', 'start', 'weekly-quality', '--driver', 'local'], { home, cwd: sandbox, bin });
      const runs = path.join(home, '.teamai', 'workflows', 'runs');
      const states = fs.readdirSync(runs).filter((file) => /^r[0-9a-f]+\.json$/.test(file))
        .map((file) => JSON.parse(fs.readFileSync(path.join(runs, file), 'utf8')) as { name: string; status: string });

      expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({ data: { done: { outcome: 'succeeded' } } });
      expect(code, stderr).toBe(0);
      expect(states.filter((state) => state.name === 'weekly-quality' || state.status !== 'succeeded')).toEqual([{ name: 'weekly-quality', status: 'succeeded' }].map((state) => expect.objectContaining(state)));
      expect(fs.readFileSync(path.join(docs, 'lesson.md.draft.md'), 'utf8')).toBe('---\ndate: 2026-11-04\n---\n\n# lesson, updated');
    } finally {
      fs.writeFileSync(config, member);
    }
  });

  it('prints the run\'s envelope with --json, and what it said on stderr', async () => {
    const { code, stdout, stderr } = await run(['--json']);

    expect(JSON.parse(stdout)).toMatchObject({ data: { done: { outcome: 'succeeded', outputs: { text: 'Review drafts, then rename .draft.md -> .md to apply updates.', exit_code: 0 } } } });
    expect(stderr).toContain(`✔   Draft written: ${path.join(docs, 'lesson.md')}.draft.md`);
    expect(code).toBe(0);
  });
});

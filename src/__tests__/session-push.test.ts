import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdapter } from '../session-flow/adapters/index.js';
import { loadLocalConfig, saveLocalConfig } from '../config.js';
import { AgentSession } from '../session-flow/agent-session.js';
import { openSessionArchive } from '../session-flow/archive.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { registerSessionFlowCommands } from '../session-flow/session-cmd.js';
import { encodeRepoIdentity, withSessionPublicationLock } from '../session-flow/sync.js';
import { getDataHome, getReportsDir, REPORTS_LOCK_FILENAME, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { ensureReportsWorktree, updateReports } from '../utils/reports-branch.js';
import { worktreePath } from '../workflow/worktree.js';

const project = vi.hoisted(() => ({ config: null as LocalConfig | null }));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: async () => project.config,
}));

let tmp: string;
const saved = { gitConfig: process.env.GIT_CONFIG_GLOBAL, home: process.env.HOME };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-push-')));
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = tester\n\temail = tester@example.com\n');
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.HOME = path.join(tmp, 'home');
  project.config = null;
});

afterEach(() => {
  if (saved.gitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.gitConfig;
  process.env.HOME = saved.home;
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A repository with one commit on a bare origin, and a clone of it. */
function repository(name: string): { origin: string; checkout: string } {
  const seed = path.join(tmp, `${name}-seed`);
  const origin = path.join(tmp, `${name}.git`);
  const checkout = path.join(tmp, name);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', name);
  git(tmp, 'clone', '-q', '--bare', seed, origin);
  git(tmp, 'clone', '-q', origin, checkout);
  return { origin, checkout };
}

/** Writes the Claude Code session a tool left in `cwd`, with one assistant answer per entry of `answers`, and returns the id it got. */
async function claudeSession(cwd: string, { id = 'review-1', title = 'Review this project', answers = ['Found two problems.'] } = {}): Promise<string> {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), '.claude', 'projects'), { recursive: true });
  return getAdapter('claude-code').writeSession({
    sessionId: id,
    title,
    cwd,
    platform: 'claude-code',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: `2026-10-01T10:0${answers.length}:00.000Z`,
    messages: [
      { role: 'user', timestamp: '2026-10-01T10:00:00.000Z', content: [{ type: 'text', text: 'Review this project.' }] },
      ...answers.map((text, index) => ({ role: 'assistant' as const, timestamp: `2026-10-01T10:0${index + 1}:00.000Z`, content: [{ type: 'text' as const, text }] })),
    ],
    metadata: {},
  }, cwd);
}

/** The files under `sessions/` on `ref` of bare repository `origin`. */
function archived(origin: string, ref: string): string[] {
  try {
    return execFileSync('git', ['--git-dir', origin, 'ls-tree', '-r', '--name-only', ref, 'sessions'], { encoding: 'utf8', stdio: 'pipe' })
      .split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Runs `teamai session <args>`. */
async function session(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  process.exitCode = 0;
  let code: number;
  try {
    const program = new Command();
    program.option('--dry-run', 'preview');
    registerSessionFlowCommands(program.command('session'));
    await program.parseAsync(['node', 'teamai', 'session', ...args]);
    code = Number(process.exitCode ?? 0);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    code = err.code;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
    process.exitCode = 0;
  }
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('session push for a team that keeps its workflows in the business repository', () => {
  it('answers busy and writes nothing while another write holds teamai-reports, then archives there', async () => {
    const { origin, checkout } = repository('product');
    project.config = {
      repo: { localPath: path.join(checkout, '.teamai'), remote: origin, kind: 'self', businessRepoRoot: checkout },
      username: 'alice',
      scope: 'project',
      projectRoot: checkout,
      additionalRoles: [],
      dataHome: path.join(tmp, 'data'),
    };
    const config = project.config;
    await ensureReportsWorktree(config);
    await claudeSession(checkout);

    let busy = { code: 0, stdout: '', stderr: '' };
    await updateReports(config, async () => {
      busy = await session('push', '--source', 'claude-code', '--cwd', checkout, '-y');
      return null;
    });

    expect(busy.code, busy.stdout).toBe(1);
    expect(busy.stderr).toContain('teamai-reports');
    expect(fs.existsSync(path.join(getReportsDir(config), 'sessions'))).toBe(false);
    expect(archived(origin, 'teamai-reports')).toEqual([]);

    const pushed = await session('push', '--source', 'claude-code', '--cwd', checkout, '-y');

    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stdout).toContain('Pushed 1 session(s) from claude-code');
    expect(archived(origin, 'teamai-reports')).toContainEqual(expect.stringMatching(/\.jsonl$/));
    expect(archived(origin, 'main')).toEqual([]);
  });

  it('waits while another session command publishes the archive, then archives on teamai-reports', async () => {
    const { origin, checkout } = repository('product');
    project.config = {
      repo: { localPath: path.join(checkout, '.teamai'), remote: origin, kind: 'self', businessRepoRoot: checkout },
      username: 'alice',
      scope: 'project',
      projectRoot: checkout,
      additionalRoles: [],
      dataHome: path.join(tmp, 'data'),
    };
    const config = project.config;
    await ensureReportsWorktree(config);
    await claudeSession(checkout);

    let finished = false;
    let push: Promise<{ code: number; stdout: string; stderr: string }> | undefined;
    await withSessionPublicationLock(getReportsDir(config), async () => {
      push = session('push', '--source', 'claude-code', '--cwd', checkout, '-y').finally(() => { finished = true; });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    });

    expect(finished).toBe(false);
    expect(archived(origin, 'teamai-reports')).toEqual([]);
    const pushed = await push;
    expect(pushed?.code, pushed?.stderr).toBe(0);
    expect(archived(origin, 'teamai-reports')).toContainEqual(expect.stringMatching(/\.jsonl$/));
  });
});

describe('session migrate --push for a team that keeps its workflows in the business repository', () => {
  it('answers busy and archives nothing while another write holds teamai-reports, then archives there', async () => {
    const { origin, checkout } = repository('product');
    project.config = {
      repo: { localPath: path.join(checkout, '.teamai'), remote: origin, kind: 'self', businessRepoRoot: checkout },
      username: 'alice',
      scope: 'project',
      projectRoot: checkout,
      additionalRoles: [],
      dataHome: path.join(tmp, 'data'),
    };
    const config = project.config;
    await ensureReportsWorktree(config);
    await claudeSession(checkout);
    const migrate = () => session('migrate', '-s', 'claude-code', '-t', 'codex', '--all', '--cwd', checkout, '--push', '-y');

    let busy = { code: 0, stdout: '', stderr: '' };
    await updateReports(config, async () => {
      busy = await migrate();
      return null;
    });

    expect(busy.code, busy.stdout).toBe(1);
    expect(busy.stderr).toContain('teamai-reports');
    expect(fs.existsSync(path.join(getReportsDir(config), 'sessions'))).toBe(false);
    expect(archived(origin, 'teamai-reports')).toEqual([]);

    const pushed = await migrate();

    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stdout).toContain('Pushed 1 session(s)');
    expect(archived(origin, 'teamai-reports')).toContainEqual(expect.stringMatching(/\.jsonl$/));
    expect(archived(origin, 'main')).toEqual([]);
  });
});

describe('session pull for a team that keeps its workflows in the business repository', () => {
  it('answers busy and merges nothing while another write holds teamai-reports, then pulls there', async () => {
    const { origin, checkout } = repository('product');
    project.config = {
      repo: { localPath: path.join(checkout, '.teamai'), remote: origin, kind: 'self', businessRepoRoot: checkout },
      username: 'alice',
      scope: 'project',
      projectRoot: checkout,
      additionalRoles: [],
      dataHome: path.join(tmp, 'data'),
    };
    const config = project.config;
    await ensureReportsWorktree(config);
    const reportsDir = getReportsDir(config);
    const pull = () => session('pull', '--cwd', checkout);

    let busy = { code: 0, stdout: '', stderr: '' };
    await updateReports(config, async () => {
      const other = path.join(tmp, 'other');
      git(tmp, 'clone', '-q', '-b', 'teamai-reports', origin, other);
      fs.writeFileSync(path.join(other, 'from-bob.md'), 'bob\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-qm', 'bob');
      git(other, 'push', '-q', 'origin', 'teamai-reports');
      busy = await pull();
      return null;
    });

    expect(busy.code, busy.stdout).toBe(1);
    expect(busy.stderr).toContain('teamai-reports');
    expect(fs.existsSync(path.join(reportsDir, 'from-bob.md'))).toBe(false);

    const pulled = await pull();

    expect(pulled.code, pulled.stderr).toBe(0);
    expect(fs.existsSync(path.join(reportsDir, 'from-bob.md'))).toBe(true);
  });
});

describe('session list and search for a team that keeps its workflows in the business repository', () => {
  it('answer without creating the teamai-reports checkout while another write holds its lock, which creates it afterwards', async () => {
    const { origin, checkout } = repository('product');
    project.config = {
      repo: { localPath: path.join(checkout, '.teamai'), remote: origin, kind: 'self', businessRepoRoot: checkout },
      username: 'alice',
      scope: 'project',
      projectRoot: checkout,
      additionalRoles: [],
      dataHome: path.join(tmp, 'data'),
    };
    const reportsDir = getReportsDir(project.config);
    const lockPath = path.join(path.dirname(reportsDir), REPORTS_LOCK_FILENAME);

    expect(await acquireLock(lockPath)).toBe(true);
    let reads: Array<{ code: number; stdout: string; stderr: string }>;
    try {
      reads = [await session('list', '--cwd', checkout), await session('search', 'Review', '--cwd', checkout)];
    } finally {
      await releaseLock(lockPath);
    }

    for (const read of reads) {
      expect(read.code, read.stderr).toBe(0);
    }
    expect(reads[0].stdout).toContain('No team sessions found.');
    expect(fs.existsSync(reportsDir)).toBe(false);

    const listed = await session('list', '--cwd', checkout);

    expect(listed.code, listed.stderr).toBe(0);
    expect(fs.existsSync(path.join(reportsDir, '.git'))).toBe(true);
  });
});

describe('session push of a session a workflow step ran', () => {
  it('files it under the repository of the checkout whose step worktree it ran in, after that worktree is removed', async () => {
    const team = repository('team');
    const { checkout } = repository('product');
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/product.git');
    const worktree = worktreePath(checkout, 'teamai/r0123abcd/review');
    await claudeSession(worktree);
    fs.rmSync(worktree, { recursive: true });

    const pushed = await session('push', '--source', 'claude-code', '--all', '-y', '--repo-root', team.checkout);

    expect(pushed.code, pushed.stderr).toBe(0);
    const files = archived(team.origin, 'main');
    expect(files.filter((file) => file.endsWith('.jsonl')), files.join('\n')).toEqual([
      expect.stringContaining(`sessions/repos/${encodeRepoIdentity('github.com/acme/product')}/`),
    ]);
    const index = files.find((file) => file.endsWith('_index.json'));
    expect(JSON.parse(git(team.checkout, 'show', `origin/main:${index}`))).toMatchObject({ sessions: [{ cwd: '' }] });
  });
});

describe('session commands without --repo-root outside a workspace install', () => {
  /** A team repo clone with its config, saved as this machine's user install. */
  async function userInstall(): Promise<{ origin: string; checkout: string }> {
    const team = repository('team');
    fs.writeFileSync(path.join(team.checkout, 'teamai.yaml'), 'team: acme\nrepo: https://github.com/acme/team.git\nprovider: github\n');
    git(team.checkout, 'add', '-A');
    git(team.checkout, 'commit', '-qm', 'team config');
    git(team.checkout, 'push', '-q', 'origin', 'main');
    await saveLocalConfig({
      repo: { localPath: team.checkout, remote: team.origin, kind: 'git' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    });
    return team;
  }

  it('archive on teamai-reports of the user install, not on its default branch', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    await claudeSession(checkout);

    const pushed = await session('push', '--source', 'claude-code', '--cwd', checkout, '-y');

    expect(pushed.code, pushed.stderr).toBe(0);
    expect(archived(team.origin, 'teamai-reports')).toContainEqual(expect.stringMatching(/\.jsonl$/));
    expect(archived(team.origin, 'main')).toEqual([]);
  });

  it('list a session archived on teamai-reports and on the default branch once, from teamai-reports, and one only the default branch holds', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    await claudeSession(checkout, { answers: ['Found two problems.'] });
    await claudeSession(checkout, { id: 'plan-1', title: 'Plan the release' });
    expect((await session('push', '--source', 'claude-code', '--cwd', checkout, '-y', '--repo-root', team.checkout)).code).toBe(0);
    await claudeSession(checkout, { answers: ['Found two problems.', 'The second one is in the parser.'] });
    expect((await session('push', '--source', 'claude-code', '--cwd', checkout, '-y', '--limit', '1')).code).toBe(0);

    const listed = await session('list', '--cwd', checkout);

    expect(listed.code, listed.stderr).toBe(0);
    const rows = listed.stdout.split('\n').filter((line) => line.includes('claude-code_'));
    expect(rows, listed.stdout).toEqual([
      expect.stringMatching(/claude-code_review-this-project_\S*\s+tester\s+claude-code\s+3\s/),
      expect.stringMatching(/claude-code_plan-the-release_\S*\s+tester\s+claude-code\s+2\s/),
    ]);
    expect(listed.stdout).toContain('2 session(s)');
  });

  it('push to teamai-reports a session the default branch also holds, and say that list and resume read this copy first', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    await claudeSession(checkout);
    expect((await session('push', '--source', 'claude-code', '--cwd', checkout, '-y', '--repo-root', team.checkout)).code).toBe(0);

    const pushed = await session('push', '--source', 'claude-code', '--cwd', checkout, '-y');

    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stdout).toContain('  · 1 session(s) also archived on the default branch: session list and resume read the copy pushed to teamai-reports first.');
  });

  it('push exactly the session --session names, scrubbed, to teamai-reports', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const plan = await claudeSession(checkout, { id: 'plan-1', title: 'Plan the release', answers: [`Planned it. The deploy token is ${token}.`] });
    await claudeSession(checkout, { answers: ['Found two problems.', 'The second one is in the parser.'] });

    const pushed = await session('push', '--session', plan, '--source', 'claude-code', '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const files = archived(team.origin, 'teamai-reports').filter((file) => file.endsWith('.jsonl'));
    expect(files, files.join('\n')).toEqual([expect.stringContaining('claude-code_plan-the-release_')]);
    const transcript = git(team.checkout, 'show', `origin/teamai-reports:${files[0]}`);
    expect(transcript).toContain('Planned it.');
    expect(transcript).not.toContain(token);
    expect(archived(team.origin, 'main')).toEqual([]);
  });

  it('mask a secret the team declares, whatever its name, in the sessions push --scrub archives', async () => {
    const team = await userInstall();
    fs.mkdirSync(path.join(team.checkout, 'env'), { recursive: true });
    fs.writeFileSync(path.join(team.checkout, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    const { checkout } = repository('product');
    await claudeSession(checkout, { answers: [`Found two problems in ${dsn}.`] });

    const pushed = await session('push', '--source', 'claude-code', '--cwd', checkout, '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const [file, ...more] = archived(team.origin, 'teamai-reports').filter((name) => name.endsWith('.jsonl'));
    expect(more).toEqual([]);
    const transcript = git(team.checkout, 'show', `origin/teamai-reports:${file}`);
    expect(transcript).toContain('Found two problems in');
    expect(transcript).not.toContain(dsn);
  });

  it('archive no start of a secret that the first prompt carries past the title length, in titles, the index or file names', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    const github = `ghp_${'A1b2C3d4E5F6'.repeat(3)}`;
    const anthropic = `sk-ant-api03-${'Q9w8E7r6T5'.repeat(4)}`;
    await claudeSession(checkout);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(checkout));
    const prompts = { deploy: `Deploy the staging build with the token ${github} now`, summary: `Call the model for the summary with key ${anthropic} please` };
    for (const [id, prompt] of Object.entries(prompts)) {
      const records = [
        { type: 'user', uuid: `${id}-u`, parentUuid: null, sessionId: id, cwd: checkout, timestamp: '2026-10-02T10:00:00.000Z', message: { role: 'user', content: prompt } },
        { type: 'assistant', uuid: `${id}-a`, parentUuid: `${id}-u`, sessionId: id, cwd: checkout, timestamp: '2026-10-02T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    }

    const pushed = await session('push', '--source', 'claude-code', '--cwd', checkout, '-y', '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const files = archived(team.origin, 'teamai-reports');
    expect(files.filter((file) => file.endsWith('.meta.json')), files.join('\n')).toHaveLength(3);
    const archive = [...files, ...files.map((file) => git(team.checkout, 'show', `origin/teamai-reports:${file}`))].join('\n');
    for (const secret of [github, anthropic]) {
      const start = secret.slice(0, 8);
      expect(archive).not.toContain(start);
      expect(archive).not.toContain(start.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    }
  });

  it('archive none of this machine\'s paths with push --scrub, in the transcript, its title, meta or index', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/product.git');
    const home = os.homedir();
    const uid = process.getuid?.() ?? 502;
    const answers = [
      `Edited ${checkout}/src/sync.ts and ${path.join(checkout, 'README.md')}.`,
      `Your settings are in ${home}/.claude/settings.json, the other project in ${home}/other-project/x.ts.`,
      `Output is being written to: /private/tmp/claude-${uid}/${encodeCwdClaude(checkout)}/6e64/tasks/b.output`,
      `Open file://${checkout}/README.md, not src/sync.ts or https://github.com/acme/app.`,
      // macOS links /tmp and /var to /private/...: a tool records the resolved cwd, a prompt often has the other spelling.
      `Also see ${checkout.replace(/^\/private\//, '/')}/packages/api/src/retry.ts.`,
    ];
    await claudeSession(path.join(checkout, 'packages', 'api'), { title: `Review ${checkout}/packages/api`, answers });

    const pushed = await session('push', '--source', 'claude-code', '--cwd', path.join(checkout, 'packages', 'api'), '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const files = archived(team.origin, 'teamai-reports');
    const archive = files.map((file) => git(team.checkout, 'show', `origin/teamai-reports:${file}`)).join('\n');
    expect(archive).toContain('Edited <repo>/src/sync.ts and <repo>/README.md.');
    expect(archive).toContain('Your settings are in ~/.claude/settings.json, the other project in ~/other-project/x.ts.');
    expect(archive).toContain('Output is being written to: <tmp>/<project>/6e64/tasks/b.output');
    expect(archive).toContain('Open file://<repo>/README.md, not src/sync.ts or https://github.com/acme/app.');
    expect(archive).toContain('Also see <repo>/packages/api/src/retry.ts.');
    for (const local of [checkout, home, fs.realpathSync(os.tmpdir())]) expect(archive).not.toContain(local.replace(/^\/private\//, '/'));
    expect(archive).not.toMatch(/claude-[0-9]+\//);
  });

  it('archive no path of a session run through a link to a directory of the repository with push --scrub', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/product.git');
    fs.mkdirSync(path.join(checkout, 'packages', 'api'), { recursive: true });
    const link = path.join(tmp, 'opt-api');
    fs.symlinkSync(path.join(checkout, 'packages', 'api'), link, process.platform === 'win32' ? 'junction' : 'dir');
    await claudeSession(link, { answers: [`Edited ${link}/src/retry.ts.`] });

    const pushed = await session('push', '--source', 'claude-code', '--cwd', link, '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const archive = archived(team.origin, 'teamai-reports').map((file) => git(team.checkout, 'show', `origin/teamai-reports:${file}`)).join('\n');
    expect(archive).toContain('Edited <repo>/packages/api/src/retry.ts.');
    expect(archive).not.toContain(link);
  });

  it('archive the directory of a session outside any repository as <cwd> with push --scrub', async () => {
    const team = await userInstall();
    const scratch = path.join(tmp, 'scratch');
    await claudeSession(scratch, { answers: [`Edited ${scratch}/a.ts.`] });

    const pushed = await session('push', '--source', 'claude-code', '--cwd', scratch, '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const archive = archived(team.origin, 'teamai-reports').map((file) => git(team.checkout, 'show', `origin/teamai-reports:${file}`)).join('\n');
    expect(archive).toContain('Edited <cwd>/a.ts.');
    expect(archive).not.toContain(scratch);
  });

  it('resume a session archived relative to its repository in another clone of it, with its turns', async () => {
    const team = await userInstall();
    const { origin, checkout } = repository('product');
    const answers = ['Found two problems.', 'The second one is in the parser.'];
    await claudeSession(path.join(checkout, 'packages', 'api'), { answers });
    expect((await session('push', '--source', 'claude-code', '--cwd', path.join(checkout, 'packages', 'api'), '-y')).code).toBe(0);
    const meta = archived(team.origin, 'teamai-reports').find((file) => file.endsWith('.meta.json')) ?? '';
    expect(JSON.parse(git(team.checkout, 'show', `origin/teamai-reports:${meta}`))).toMatchObject({ origin: { cwd: 'packages/api' } });
    const other = path.join(tmp, 'other-machine');
    git(tmp, 'clone', '-q', origin, other);

    const resumed = await session('resume', path.basename(meta, '.meta.json'), '--platform', 'claude-code', '--cwd', other);

    expect(resumed.code, resumed.stderr).toBe(0);
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encodeCwdClaude(other));
    const [transcript, ...more] = fs.readdirSync(projectDir).filter((file) => file.endsWith('.jsonl'));
    expect(more).toEqual([]);
    const records = fs.readFileSync(path.join(projectDir, transcript), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { cwd?: string; message?: { content: unknown } }).filter((record) => record.message);
    expect(records.map((record) => record.cwd)).toEqual([other, other, other]);
    expect(JSON.stringify(records.map((record) => record.message?.content))).toContain('The second one is in the parser.');
  });

  it('restore a session archived relative to its repository when a workflow run is handed over to another clone', async () => {
    await userInstall();
    const { origin, checkout } = repository('product');
    const id = await claudeSession(path.join(checkout, 'packages', 'api'), { answers: ['Found two problems.', 'The second one is in the parser.'] });
    expect((await session('push', '--source', 'claude-code', '--cwd', path.join(checkout, 'packages', 'api'), '-y')).code).toBe(0);
    const other = path.join(tmp, 'other-machine');
    git(tmp, 'clone', '-q', origin, other);
    const config = await loadLocalConfig();
    if (!config) throw new Error('the user install was not saved');
    const archive = openSessionArchive(config);

    const restored = await archive.restore({ platform: 'claude-code', sessionId: id }, { platform: 'claude-code', cwd: other });
    await archive.close();

    expect(restored).toMatchObject({ status: 'restored' });
    const found = await AgentSession.find({ platform: 'claude-code', sessionId: 'sessionId' in restored ? restored.sessionId : '', cwd: other }, { scrub: false });
    expect(found).toMatchObject({ status: 'done', session: { cwd: other } });
    expect(JSON.stringify(found)).toContain('The second one is in the parser.');
  });

  it('record what the session ran as from its one capture here, and nothing for a session no hook captured', async () => {
    const team = await userInstall();
    const { checkout } = repository('product');
    const captured = await claudeSession(checkout, { id: 'captured-1', title: 'Captured review' });
    await claudeSession(checkout, { id: 'uncaptured-1', title: 'Uncaptured review' });
    const config = await loadLocalConfig();
    if (!config) throw new Error('the user install was not saved');
    const revision = '7a6134a25e74c0de7a6134a25e74c0de7a6134a2';
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f10';
    const dir = path.join(getDataHome(config), 'sessions', 'captures', 'claude-code', captured);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({
      captureId, platform: 'claude-code', sessionId: captured, capturedAt: '2026-10-01T10:00:00.000Z',
      agent: { v: 1, tool: { name: 'claude', version: '2.1.301' }, model: { requested: 'claude-opus-5-5' }, team: { revision, localChanges: false },
        project: { commit: '8e04ff4308e04ff4308e04ff4308e04ff4308e04', dirty: true }, teamai: '0.31.0', driver: 'session' },
    }));

    const pushed = await session('push', '--source', 'claude-code', '--cwd', checkout, '--scrub');

    expect(pushed.code, pushed.stderr).toBe(0);
    const files = archived(team.origin, 'teamai-reports');
    const read = (suffix: string, title: string) => JSON.parse(git(team.checkout, 'show', `origin/teamai-reports:${files.find((file) => file.includes(title) && file.endsWith(suffix))}`)) as Record<string, unknown>;
    expect(read('.meta.json', 'captured-review')).toMatchObject({
      agent: { tool: { name: 'claude', version: '2.1.301' }, model: { requested: 'claude-opus-5-5' }, team: { revision }, driver: 'session', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(read('.meta.json', 'uncaptured-review')).not.toHaveProperty('agent');
    const index = JSON.parse(git(team.checkout, 'show', `origin/teamai-reports:${files.find((file) => file.endsWith('_index.json'))}`)) as { sessions: Array<{ title: string; teamRevision?: string }> };
    expect(index.sessions.map(({ title, teamRevision }) => ({ title, teamRevision })).sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { title: 'Captured review', teamRevision: revision },
      { title: 'Uncaptured review', teamRevision: undefined },
    ]);
  });

  it('throw that teamai is not set up when there is no install at all', async () => {
    const { checkout } = repository('product');
    await claudeSession(checkout);

    for (const args of [['push', '--source', 'claude-code', '-y'], ['list'], ['pull']]) {
      await expect(session(...args, '--cwd', checkout), args.join(' ')).rejects.toThrow(
        /teamai is not set up[\s\S]*teamai init[\s\S]*--repo-root/,
      );
    }
  });
});

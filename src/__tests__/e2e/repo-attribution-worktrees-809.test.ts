/**
 * E2E (#809): every worktree of a repo counts as that repo.
 *
 * Each dashboard event recorded its `cwd` and nothing else about the project,
 * so `stats --by-repo`, the dashboard and `session save` derived the project
 * from a per-worktree path, and the wiki commands took the slug from the
 * directory they ran in. A worktree became its own project, and once it was
 * removed git could no longer map its path back to the repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../../utils/partition.js';

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

function cliEnv(home: string): NodeJS.ProcessEnv {
  // The host's session id would override --session-id defaults and hook payloads.
  const { CLAUDE_SESSION_ID: _ignored, ...env } = process.env;
  return { ...env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', NO_COLOR: '1' };
}

function runCLI(args: string[], cwd: string, home: string, input = ''): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: cliEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

/** `[label, sessions]` for each row of the `By Repo` section. */
function byRepo(output: string): Array<[string, number]> {
  return [...output.slice(output.indexOf('By Repo')).matchAll(/^ {2}(\S+)\s+(\d+) sess,/gm)]
    .map((m): [string, number] => [m[1], Number(m[2])]);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('one repo, many worktrees (#809)', () => {
  let sandbox: string;
  let home: string;
  let repo: string;
  let worktree: string;
  let workApi: string;
  let personalApi: string;
  let dashboard: ChildProcess | undefined;

  const events = () => fs.readFileSync(path.join(home, '.teamai', 'dashboard', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { sessionId: string; cwd?: string });

  /** A prompt and a tool call, sent the way the installed hooks send them. */
  const session = async (sessionId: string, cwd: string, writer: 'dispatch' | 'legacy' = 'dispatch') => {
    const payloads = [
      { hook: 'prompt-submit', data: { session_id: sessionId, hook_event_name: 'UserPromptSubmit', cwd, prompt: `work in ${sessionId}` } },
      { hook: 'post-tool-use', data: { session_id: sessionId, hook_event_name: 'PostToolUse', cwd, tool_name: 'Edit', tool_input: {}, tool_response: {} } },
    ];
    for (const { hook, data } of payloads) {
      const args = writer === 'dispatch'
        ? ['hook-dispatch', hook, '--tool', 'claude', '--stdin']
        : ['dashboard-report', '--stdin', '--tool', 'claude'];
      const r = await runCLI(args, cwd, home, JSON.stringify(data));
      expect(r.code, r.output).toBe(0);
    }
  };

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue809-e2e-')));
    home = path.join(sandbox, 'home');
    repo = path.join(sandbox, 'my-repo');
    worktree = path.join(sandbox, 'wt-demo');
    workApi = path.join(sandbox, 'work', 'api');
    personalApi = path.join(sandbox, 'personal', 'api');
    const seed = path.join(sandbox, 'seed');
    const remote = path.join(sandbox, 'team-remote.git');

    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: issue-809-e2e\nrepo: https://example.com/team.git\nprovider: tgit\n');
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    // The business repo, set up for teamai in project scope (its partition),
    // with a linked worktree outside the checkout.
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'greet.ts'), 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'teamwiki/\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'project'], repo);
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-demo'], repo);

    const partition = path.join(home, '.teamai', 'projects', projectSlug(repo));
    const projectTeamRepo = path.join(partition, 'team-repo');
    fs.mkdirSync(partition, { recursive: true });
    git(['clone', '-q', remote, projectTeamRepo], sandbox);
    fs.writeFileSync(path.join(partition, 'anchor'), `${repo}\n`);
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      `  localPath: ${projectTeamRepo}`,
      `  remote: ${remote}`,
      'username: ci-809',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${repo}`,
      'enabledAgents: [claude]',
      '',
    ].join('\n'));

    // User scope, which records sessions outside the project.
    const userTeamRepo = path.join(home, '.teamai', 'team-repo');
    git(['clone', '-q', remote, userTeamRepo], sandbox);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${userTeamRepo}`,
      `  remote: ${remote}`,
      'username: ci-809',
      'updatePolicy: auto',
      'scope: user',
      'enabledAgents: [claude]',
      '',
    ].join('\n'));

    // Two unrelated repos that share a directory name.
    for (const dir of [workApi, personalApi]) {
      fs.mkdirSync(dir, { recursive: true });
      git(['init', '-q', '-b', 'main'], dir);
      git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    }

    await session('main-1', repo);
    await session('main-2', path.join(repo, 'src'));
    await session('wt-1', worktree);
    await session('wt-2', worktree, 'legacy');
    // Starts in HOME, then `cd`s into the repo.
    await session('cd-1', home);
    await session('cd-1', repo);
    await session('api-work', workApi);
    await session('api-personal', personalApi);
  }, 120_000);

  afterAll(async () => {
    if (dashboard && dashboard.exitCode === null) {
      const exited = once(dashboard, 'exit');
      dashboard.kill('SIGTERM');
      await exited;
    }
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('records every session', () => {
    expect([...new Set(events().map((e) => e.sessionId))].sort()).toEqual(
      ['api-personal', 'api-work', 'cd-1', 'main-1', 'main-2', 'wt-1', 'wt-2'],
    );
  });

  it('stats --by-repo shows one row for the repo, counting its worktree sessions', async () => {
    const r = await runCLI(['stats', '--by-repo'], repo, home);
    expect(r.code, r.output).toBe(0);
    // cd-1 started in HOME: the user scope's, whole (#785), so the repo's own four.
    expect(byRepo(r.output), r.output).toEqual([['my-repo', 4]]);
  });

  it('stats --by-repo labels two unrelated repos with the same name apart', async () => {
    const r = await runCLI(['stats', '--by-repo'], home, home);
    expect(r.code, r.output).toBe(0);
    expect(byRepo(r.output), r.output).toEqual(expect.arrayContaining([['work/api', 1], ['personal/api', 1]]));
  });

  it('session save from a worktree session records the repo as Project and the path as Directory', async () => {
    const r = await runCLI(['session', 'save', '--session-id', 'wt-1'], home, home);
    expect(r.code, r.output).toBe(0);
    const logs = path.join(home, '.teamai', 'session-logs');
    const log = fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n');
    expect(log, r.output).toContain('- Project: `my-repo`');
    expect(log, r.output).toContain(`- Directory: \`${worktree}\``);
  });

  it('import --dir and codebase --extract in a worktree use the repo name as the wiki slug', async () => {
    const imported = await runCLI(['import', '--dir', '.', '--dry-run'], worktree, home);
    expect(imported.code, imported.output).toBe(0);
    expect(imported.output).toContain('(project: my-repo)');

    const extracted = await runCLI(['codebase', '--extract', worktree, '--json', '--max-files', '10'], worktree, home);
    expect(extracted.code, extracted.output).toBe(0);
    expect(fs.readdirSync(path.join(worktree, 'teamwiki', 'evidence', 'code')), extracted.output).toEqual(['my-repo']);
  });

  it('keeps a removed worktree\'s sessions in the repo\'s dashboard workspace, listed once in the Repository filter', async () => {
    git(['worktree', 'remove', '--force', worktree], repo);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    dashboard = spawn(process.execPath, [CLI, 'dashboard', '--port', String(port)], { cwd: home, env: cliEnv(home), stdio: 'pipe' });
    let output = '';
    dashboard.stdout?.on('data', (b: Buffer) => { output += b.toString(); });
    dashboard.stderr?.on('data', (b: Buffer) => { output += b.toString(); });
    const deadline = Date.now() + 15_000;
    while (!output.includes('Dashboard running') && Date.now() < deadline) {
      if (dashboard.exitCode !== null) throw new Error(output);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(output).toContain('Dashboard running');

    const workspaces = await (await fetch(`${base}/api/workspaces`)).json() as Array<{ id: string; scope: string; root: string }>;
    const project = workspaces.find((w) => w.scope === 'project' && w.root === repo);
    expect(project, JSON.stringify(workspaces)).toBeDefined();
    const sessions = await (await fetch(`${base}/api/sessions?workspace=${project?.id}`)).json() as
      Array<{ sessionId: string; cwd: string; repoKey?: string; repoLabel?: string }>;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['cd-1', 'main-1', 'main-2', 'wt-1', 'wt-2']);

    // The Repository filter lists one option per repoKey (the cwd before #809),
    // labelled with repoLabel. Session rows still show the cwd.
    const options = new Map(sessions.map((s) => [s.repoKey ?? s.cwd, s.repoLabel ?? s.cwd]));
    expect([...options.values()]).toEqual(['my-repo']);
    expect(sessions.find((s) => s.sessionId === 'wt-1')?.cwd).toBe(worktree);
  });
});

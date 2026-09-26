/**
 * E2E (#808): in self mode, every checkout of the business repo publishes
 * learnings and keeps its queue, whichever checkout ran first.
 *
 * Git lets a branch be checked out in one worktree only. The teamai-learnings
 * and teamai-reports checkouts, and the queue of unpublished learnings, used to
 * live in each checkout's own `.teamai/`, so the first checkout to create them
 * locked every other one out, and a learning queued in a linked worktree was
 * deleted with it. The search index was shared by every checkout, so recall
 * served whichever one rebuilt it last.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSlug } from '../../utils/partition.js';
import { queueLockPath } from '../../utils/pending-learnings.js';

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

function runCLI(args: string[], cwd: string, home: string, env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}

interface Project {
  sandbox: string;
  home: string;
  remote: string;
  projectRoot: string;
  /** A linked worktree outside the main checkout, like `git worktree add ../b`. */
  worktree: string;
}

const sandboxes: string[] = [];

/**
 * A self-mode business repo with a bare origin. Team knowledge is committed
 * under .teamai/, and the machine config sits in the checkout, as a
 * pre-partition install left it: the first pull moves it into the partition.
 */
function setUpProject(): Project {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue808-e2e-')));
  sandboxes.push(sandbox);
  const project: Project = {
    sandbox,
    home: path.join(sandbox, 'home'),
    remote: path.join(sandbox, 'origin.git'),
    projectRoot: path.join(sandbox, 'project'),
    worktree: path.join(sandbox, 'project-wt'),
  };
  const { home, remote, projectRoot } = project;
  fs.mkdirSync(home, { recursive: true });

  git(['init', '-q', '--bare', remote], sandbox);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  const knowledge = path.join(projectRoot, '.teamai');
  fs.mkdirSync(path.join(knowledge, 'learnings'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'learnings', '.gitkeep'), '');
  fs.writeFileSync(path.join(knowledge, 'teamai.yaml'), [
    'team: issue-808-e2e',
    'mode: self',
    'repo: https://git.example.com/team/project.git',
    'provider: git',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(knowledge, '.gitignore'), 'config.yaml\nstate.json\n');
  git(['init', '-q', '-b', 'main'], projectRoot);
  git(['add', '-A'], projectRoot);
  git(['commit', '-q', '-m', 'project'], projectRoot);
  git(['remote', 'add', 'origin', remote], projectRoot);
  git(['push', '-q', '-u', 'origin', 'main'], projectRoot);

  fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    `  remote: ${remote}`,
    '  kind: self',
    `  businessRepoRoot: ${projectRoot}`,
    'username: ci-808',
    'updatePolicy: auto',
    'scope: project',
    `projectRoot: ${projectRoot}`,
    '',
  ].join('\n'));
  return project;
}

/** Learnings on origin's teamai-learnings branch. */
function published(project: Project): string[] {
  return git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], project.remote)
    .split('\n')
    .filter((f) => f.startsWith('learnings/'));
}

/** The `File:` paths a recall printed. */
function recalledFiles(output: string): string[] {
  return [...output.matchAll(/^File: (.+)$/gm)].map((m) => m[1].trim());
}

/** Reject every push to origin while `fn` runs, so a contribution stays queued. */
async function withPushesRejected<T>(project: Project, fn: () => Promise<T>): Promise<T> {
  const hook = path.join(project.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "rejected by the #808 test" >&2\nexit 1\n', { mode: 0o755 });
  try {
    return await fn();
  } finally {
    fs.rmSync(hook, { force: true });
  }
}

function note(project: Project, name: string, text: string): string {
  const file = path.join(project.sandbox, `${name}.md`);
  fs.writeFileSync(file, `${text}\n`);
  return file;
}

/** The project partition: exactly one exists under the sandbox HOME. */
function partitionOf(project: Project): string {
  const projects = path.join(project.home, '.teamai', 'projects');
  const [partition] = fs.readdirSync(projects);
  return path.join(projects, partition);
}

/** The partition's queue. */
function partitionQueue(project: Project): string[] {
  const queue = path.join(partitionOf(project), 'pending-learnings');
  return fs.existsSync(queue) ? fs.readdirSync(queue, { recursive: true }).map(String) : [];
}

/** The queue lock of `home` under the sandbox HOME, as the CLI resolves it. */
async function sandboxQueueLock(project: Project, home: string): Promise<string> {
  const realHome = process.env.HOME;
  process.env.HOME = project.home;
  try {
    return await queueLockPath(home);
  } finally {
    process.env.HOME = realHome;
  }
}

/** Hold `lock` as a live teamai process would: this test's own process. */
function holdLock(lock: string): void {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'issue-808-e2e' }));
}

/**
 * An install an older teamai left in a linked worktree: its config and one
 * queued learning in its `.teamai/`. `remote` is the origin URL its init saw.
 */
function writeUnmigratedWorktree(project: Project, queued: string, remote = project.remote): string {
  const knowledge = path.join(project.worktree, '.teamai');
  fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    `  remote: ${remote}`,
    '  kind: self',
    `  businessRepoRoot: ${project.worktree}`,
    'username: ci-808',
    'updatePolicy: auto',
    'scope: project',
    `projectRoot: ${project.worktree}`,
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(knowledge, 'pending-learnings'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'pending-learnings', queued), '# Queued by the older teamai\n');
  return knowledge;
}

/** A checkout's directory name under `<partition>/workspaces/`, as teamai keys it (managedMcpWorkspaceId). */
function workspaceId(checkout: string): string {
  return createHash('sha1').update(checkout).digest('hex').slice(0, 12);
}

describe('self mode with a linked worktree (#808)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('publishes from both checkouts, keeps a worktree queue after the worktree is removed, and recalls only live paths', async () => {
    const project = setUpProject();
    const { home, projectRoot, worktree } = project;

    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    // The pull brings .teamai/.gitignore up to date; commit it as it asks, so
    // the worktree starts from a clean tree.
    git(['add', '.teamai/.gitignore'], projectRoot);
    git(['commit', '-q', '-m', 'gitignore'], projectRoot);

    // The worktree's branch carries a doc the main checkout does not have.
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    fs.mkdirSync(path.join(worktree, '.teamai', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.teamai', 'docs', 'wt-only.md'), '# Wombat note from the worktree branch\n');
    git(['add', '-A'], worktree);
    git(['commit', '-q', '-m', 'worktree doc'], worktree);

    // The main checkout created its learnings checkout during the pull, so the
    // worktree is the one that used to be locked out.
    const fromWorktree = await runCLI(
      ['contribute', '--title', 'wt-note', '--file', note(project, 'wt', 'Wombat note contributed from the worktree')],
      worktree,
      home,
    );
    expect(fromWorktree.code, fromWorktree.output).toBe(0);
    expect(fromWorktree.output).not.toContain('already used by worktree');
    expect(fromWorktree.output).not.toContain('Saved locally');

    const fromMain = await runCLI(
      ['contribute', '--title', 'main-note', '--file', note(project, 'main', 'Wombat note contributed from the main checkout')],
      projectRoot,
      home,
    );
    expect(fromMain.code, fromMain.output).toBe(0);
    expect(fromMain.output).not.toContain('Saved locally');

    expect(published(project).some((f) => f.includes('wt-note-')), published(project).join('\n')).toBe(true);
    expect(published(project).some((f) => f.includes('main-note-')), published(project).join('\n')).toBe(true);

    // The issue's order: the main checkout contributed, then the worktree. The
    // main checkout's recall lists both, with paths that exist.
    const later = await runCLI(
      ['contribute', '--title', 'later-note', '--file', note(project, 'later', 'Wombat note contributed later from the worktree')],
      worktree,
      home,
    );
    expect(later.code, later.output).toBe(0);
    const recallAfterWorktree = await runCLI(['recall', 'wombat', 'note'], projectRoot, home);
    const afterWorktree = recalledFiles(recallAfterWorktree.output);
    for (const title of ['main-note-', 'later-note-']) {
      expect(afterWorktree.some((f) => path.basename(f).startsWith(title)), recallAfterWorktree.output).toBe(true);
    }
    for (const file of afterWorktree) {
      expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
    }

    // A contribution the remote refuses stays queued.
    const queued = await withPushesRejected(project, () => runCLI(
      ['contribute', '--title', 'queued-note', '--file', note(project, 'queued', 'Wombat note queued in the worktree')],
      worktree,
      home,
    ));
    expect(queued.output).toContain('Saved locally');

    // A plain remove, no --force: ignored files do not make a worktree dirty.
    git(['worktree', 'remove', worktree], projectRoot);
    expect(fs.existsSync(worktree)).toBe(false);

    // The main checkout's recall still serves its own checkout: every path it
    // prints exists, and none points into the removed worktree.
    const recallMain = await runCLI(['recall', 'wombat', 'note'], projectRoot, home);
    expect(recallMain.code, recallMain.output).toBe(0);
    const files = recalledFiles(recallMain.output);
    expect(files.length, recallMain.output).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith(worktree), `${file} points into the removed worktree`).toBe(false);
      expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
    }

    // The next pull in the main checkout publishes what the worktree queued.
    // As a full sync it also drops the removed worktree's per-checkout
    // directory, and keeps the main checkout's.
    const workspaces = path.join(partitionOf(project), 'workspaces');
    const worktreeDir = path.join(workspaces, workspaceId(worktree));
    const mainDir = path.join(workspaces, workspaceId(projectRoot));
    expect(fs.existsSync(worktreeDir)).toBe(true);
    const pullMain = await runCLI(['pull'], projectRoot, home);
    expect(pullMain.code, pullMain.output).toBe(0);
    expect(published(project).some((f) => f.includes('queued-note-')), published(project).join('\n')).toBe(true);
    expect(fs.existsSync(worktreeDir)).toBe(false);
    expect(fs.existsSync(mainDir)).toBe(true);

    const recallAll = await runCLI(['recall', 'wombat', 'note'], projectRoot, home);
    expect(recallAll.code, recallAll.output).toBe(0);
    const recalled = recalledFiles(recallAll.output);
    for (const title of ['wt-note-', 'main-note-', 'queued-note-']) {
      expect(recalled.some((f) => path.basename(f).startsWith(title)), recallAll.output).toBe(true);
    }
    for (const file of recalled) {
      expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
    }
  });

  it('moves a queue out of a linked worktree an older teamai never migrated before contribute publishes, so removing the worktree loses nothing', async () => {
    const project = setUpProject();
    const { home, projectRoot, worktree } = project;

    // The worktree's own pre-partition install: its config and queue in its .teamai/.
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const knowledge = path.join(worktree, '.teamai');
    fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
      'repo:',
      `  localPath: ${knowledge}`,
      `  remote: ${project.remote}`,
      '  kind: self',
      `  businessRepoRoot: ${worktree}`,
      'username: ci-808',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${worktree}`,
      '',
    ].join('\n'));
    const oldQueued = 'old-queued-2026-01-01-dddddd.md';
    fs.mkdirSync(path.join(knowledge, 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'pending-learnings', oldQueued), '# Queued by the older teamai\n');

    // Import modes that leave the queue alone do not migrate: their JSON stays clean.
    const cacheStatus = await runCLI(['import', '--cache-status', '--json'], worktree, home);
    expect(cacheStatus.output).not.toContain('Migrated');
    expect(fs.existsSync(path.join(knowledge, 'config.yaml'))).toBe(true);

    const queued = await withPushesRejected(project, () => runCLI(
      ['contribute', '--title', 'unmigrated-note', '--file', note(project, 'unmigrated', 'Note queued in an unmigrated worktree')],
      worktree,
      home,
    ));
    expect(queued.output).toContain('Saved locally');

    // --force deletes everything in the worktree, so what survives was kept elsewhere.
    git(['worktree', 'remove', '--force', worktree], projectRoot);
    expect(fs.existsSync(worktree)).toBe(false);
    // An unmigrated contribute never creates the partition.
    const queue = fs.existsSync(path.join(home, '.teamai', 'projects')) ? partitionQueue(project) : [];
    expect(queue, queue.join('\n')).toContain(oldQueued);
    expect(queue.some((f) => f.startsWith('unmigrated-note-')), queue.join('\n')).toBe(true);

    const pull = await runCLI(['pull'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(published(project), published(project).join('\n')).toContain(`learnings/${oldQueued}`);
    expect(published(project).some((f) => f.includes('unmigrated-note-')), published(project).join('\n')).toBe(true);
  });

  it('moves the queue an older teamai left in a linked worktree before import --from-mr publishes, so removing the worktree loses nothing', async () => {
    const project = setUpProject();
    const { home, projectRoot, worktree } = project;
    // The main checkout migrated; the worktree still holds the queue an older
    // teamai kept in its own .teamai/, with no config beside it.
    expect((await runCLI(['pull'], projectRoot, home)).code).toBe(0);
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const legacy = 'legacy-wt-2026-01-01-bbbbbb.md';
    fs.mkdirSync(path.join(worktree, '.teamai', 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.teamai', 'pending-learnings', legacy), '# Queued in the worktree by an older teamai\n');
    // `gh` (the MR) and `claude` (the extraction) are stand-ins on PATH.
    const bin = path.join(project.sandbox, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env bash',
      'case "$1 $2" in',
      `  "pr view") echo '{"title":"Retry flaky upload","body":"Retries uploads.","author":{"login":"dev"},"mergedAt":"2026-09-20T10:00:00Z","commits":[]}' ;;`,
      "  \"pr diff\") printf 'diff --git a/up.ts b/up.ts\\n+retry(3)\\n' ;;",
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/usr/bin/env bash',
      "cat <<'MD'",
      '---',
      'title: Retry flaky uploads',
      '---',
      '# Retry flaky uploads',
      '',
      'Wrap uploads in retry(3).',
      'MD',
      '',
    ].join('\n'), { mode: 0o755 });

    const imported = await runCLI(
      ['import', '--from-mr', 'https://github.com/acme/app/pull/7', '--all'],
      worktree,
      home,
      { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CLAUDE_SESSION_ID: '', GITHUB_TOKEN: '', GH_TOKEN: '' },
    );

    expect(imported.code, imported.output).toBe(0);
    git(['worktree', 'remove', '--force', worktree], projectRoot);
    expect(published(project), `${published(project).join('\n')}\n${imported.output}`).toContain(`learnings/${legacy}`);
    expect(published(project).some((f) => f.includes('retry-flaky-uploads-')), published(project).join('\n')).toBe(true);
    expect(partitionQueue(project)).toEqual([]);
  });

  it('stops contribute in an unmigrated linked worktree while another command holds its sync lock, saving nothing there', async () => {
    const project = setUpProject();
    const { home, projectRoot, worktree } = project;

    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const knowledge = path.join(worktree, '.teamai');
    fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
      'repo:',
      `  localPath: ${knowledge}`,
      `  remote: ${project.remote}`,
      '  kind: self',
      `  businessRepoRoot: ${worktree}`,
      'username: ci-808',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${worktree}`,
      '',
    ].join('\n'));
    // A live holder: this test's own process, as an unmigrated pull would be.
    fs.writeFileSync(
      path.join(knowledge, '.sync-lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'issue-808-e2e' }),
    );

    const run = await runCLI(
      ['contribute', '--title', 'locked-note', '--file', note(project, 'locked', 'Note contributed while the sync lock is held')],
      worktree,
      home,
    );
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain(
      "teamai could not move this checkout's data into the project's shared data directory (another teamai command is using it). " +
        'Nothing was saved. Run this again when that command finishes.',
    );
    expect(fs.existsSync(path.join(knowledge, 'pending-learnings'))).toBe(false);
    expect(fs.existsSync(path.join(knowledge, 'config.yaml'))).toBe(true);
    const queue = fs.existsSync(path.join(home, '.teamai', 'projects')) ? partitionQueue(project) : [];
    expect(queue, queue.join('\n')).toEqual([]);
  });

  it('stops contribute with exit 1 while another command holds the queue lock, saving nothing (#823 item 11)', async () => {
    const project = setUpProject();
    const { home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const lock = await sandboxQueueLock(project, partitionOf(project));
    holdLock(lock);

    const run = await runCLI(
      ['contribute', '--title', 'held-note', '--file', note(project, 'held', 'Note contributed while the queue lock is held')],
      projectRoot,
      home,
    );
    // Nothing was published at all: the learnings branch does not exist yet.
    const branch = git(['for-each-ref', '--format=%(refname)', 'refs/heads/teamai-learnings'], project.remote);
    const onOrigin = branch ? published(project) : [];
    expect(onOrigin.some((f) => f.includes('held-note-')), run.output).toBe(false);
    expect(partitionQueue(project)).toEqual([]);
    expect(run.output).toContain(
      `Another teamai command is moving this project's queued learnings (${lock} is held). ` +
        'Nothing was saved. Run this again when it finishes.',
    );
    expect(run.code, run.output).toBe(1);
  });

  it("stops init in an unmigrated linked worktree while its queue would stay there, then moves it, so removing the worktree loses nothing (#808)", async () => {
    const project = setUpProject();
    const { home, projectRoot, worktree } = project;
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const queued = 'old-queued-2026-01-01-eeeeee.md';
    // init needs no network here: an unreachable origin fails the GitLab probe
    // at once, and the member registration push is best effort.
    const origin = 'http://127.0.0.1:9/team/project.git';
    git(['config', 'user.name', 'TeamAI CI'], projectRoot);
    git(['config', 'user.email', 'ci@teamai.test'], projectRoot);
    git(['remote', 'set-url', 'origin', origin], projectRoot);
    // The older install was set up from the same origin (another one would own
    // another queue, #823 item 13).
    const knowledge = writeUnmigratedWorktree(project, queued, origin);

    // Another command holds the worktree's sync lock, so the migration cannot run.
    const syncLock = path.join(knowledge, '.sync-lock');
    holdLock(syncLock);
    const busy = await runCLI(['init', '--self', '--force'], worktree, home);
    expect(busy.output).toContain(
      "teamai could not move this checkout's data into the project's shared data directory (another teamai command is using it). " +
        'Nothing was saved. Run this again when that command finishes.',
    );
    expect(busy.code, busy.output).toBe(1);
    fs.rmSync(syncLock);

    // The partition's config cannot be read, so the migration stands down.
    const partition = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));
    fs.mkdirSync(partition, { recursive: true });
    fs.writeFileSync(path.join(partition, 'config.yaml'), 'repo: "unterminated\n');
    const unreadable = await runCLI(['init', '--self', '--force'], worktree, home);
    expect(unreadable.output).toContain(
      `teamai could not move this checkout's data into the project's shared data directory (${path.join(partition, 'config.yaml')} cannot be read`,
    );
    expect(unreadable.code, unreadable.output).toBe(1);
    expect(fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8')).toBe('repo: "unterminated\n');
    expect(fs.readdirSync(path.join(knowledge, 'pending-learnings'))).toEqual([queued]);
    fs.rmSync(path.join(partition, 'config.yaml'));

    const init = await runCLI(['init', '--self', '--force'], worktree, home);
    expect(init.code, init.output).toBe(0);
    git(['worktree', 'remove', '--force', worktree], projectRoot);
    expect(partitionQueue(project)).toContain(queued);
  });

  it("stops contribute when an unmigrated worktree's old queue cannot move, saving nothing", async () => {
    const project = setUpProject();
    const { home, projectRoot, worktree } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);

    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const knowledge = path.join(worktree, '.teamai');
    fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
      'repo:',
      `  localPath: ${knowledge}`,
      `  remote: ${project.remote}`,
      '  kind: self',
      `  businessRepoRoot: ${worktree}`,
      'username: ci-808',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${worktree}`,
      '',
    ].join('\n'));
    // The same name in both queues with other content: only a hand edit gets
    // there, and teamai keeps both for the member to compare.
    const clash = 'clash-note-2026-01-01-cccccc.md';
    fs.mkdirSync(path.join(knowledge, 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'pending-learnings', clash), '# The worktree copy\n');
    const partitionClash = path.join(partitionOf(project), 'pending-learnings', clash);
    fs.mkdirSync(path.dirname(partitionClash), { recursive: true });
    fs.writeFileSync(partitionClash, '# The partition copy\n');

    const run = await runCLI(
      ['contribute', '--title', 'blocked-note', '--file', note(project, 'blocked', 'Note contributed beside a stuck queue')],
      worktree,
      home,
    );
    expect(run.code, run.output).toBe(1);
    expect(run.output).toContain(
      `teamai could not move this checkout's data into the project's shared data directory (the learnings queued in ${path.join(knowledge, 'pending-learnings')} could not be moved; see the warning above). Nothing was saved.`,
    );
    expect(fs.readdirSync(path.join(knowledge, 'pending-learnings'))).toEqual([clash]);
    expect(partitionQueue(project)).toEqual([clash]);
    expect(fs.readFileSync(partitionClash, 'utf8')).toBe('# The partition copy\n');
  });

  it('upgrades a checkout an older teamai left: keeps a dirty old checkout, then frees a clean one and drains every queue', async () => {
    const project = setUpProject();
    const { home, remote, projectRoot, worktree } = project;

    // What an older teamai left: teamai-learnings checked out in the main
    // checkout's .teamai/, and a queue in each checkout's .teamai/.
    const seed = path.join(project.sandbox, 'seed');
    git(['clone', '-q', remote, seed], project.sandbox);
    git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
    git(['rm', '-rfq', '.'], seed);
    fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.gitignore'), 'reports-wt/\nlearnings-wt/\nknowledge-wt/\n');
    fs.writeFileSync(path.join(seed, 'learnings', '.gitkeep'), '');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'learnings branch'], seed);
    git(['push', '-q', 'origin', 'teamai-learnings'], seed);
    git(['fetch', '-q', 'origin', 'teamai-learnings:teamai-learnings'], projectRoot);
    const oldCheckout = path.join(projectRoot, '.teamai', 'learnings-wt');
    git(['worktree', 'add', '-q', oldCheckout, 'teamai-learnings'], projectRoot);
    // Uncommitted work in the old checkout: git will not remove it without --force.
    const stray = path.join(oldCheckout, 'draft.txt');
    fs.writeFileSync(stray, 'unsaved\n');

    // With nothing queued, the pull still says why the learnings checkout is missing.
    const firstPull = await runCLI(['pull'], projectRoot, home);
    // Once, however many steps of the pull ran into it.
    expect(firstPull.output.split(`${oldCheckout} still has teamai-learnings checked out`).length - 1, firstPull.output).toBe(1);
    expect(fs.readFileSync(stray, 'utf8')).toBe('unsaved\n');

    fs.mkdirSync(path.join(projectRoot, '.teamai', 'pending-learnings'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'pending-learnings', 'legacy-main-2026-01-01-aaaaaa.md'),
      '# Legacy note queued in the main checkout\n',
    );
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    fs.mkdirSync(path.join(worktree, '.teamai', 'pending-learnings'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.teamai', 'pending-learnings', 'legacy-wt-2026-01-01-bbbbbb.md'),
      '# Legacy note queued in the worktree\n',
    );

    // The pull moves the main checkout's queue into the partition, then stops
    // at the dirty old checkout and says what to do with it.
    const pullMain = await runCLI(['pull'], projectRoot, home);
    // Once in full; the queue summary gives the short reason.
    expect(pullMain.output.split(`${oldCheckout} still has teamai-learnings checked out`).length - 1, pullMain.output).toBe(1);
    expect(pullMain.output).toContain(`Commit or move the uncommitted changes in ${oldCheckout}`);
    expect(pullMain.output).toContain('or delete it by hand, which loses those uncommitted changes');
    expect(pullMain.output).toContain('an old teamai-learnings checkout is in the way; see the warning above');
    expect(fs.readFileSync(stray, 'utf8')).toBe('unsaved\n');
    expect(fs.existsSync(path.join(projectRoot, '.teamai', 'pending-learnings'))).toBe(false);
    expect(partitionQueue(project)).toContain('legacy-main-2026-01-01-aaaaaa.md');

    // Maintenance stops there too: the shared checkout it would write into does
    // not exist, and the next publish would delete what it wrote.
    const learning = path.join(projectRoot, '.teamai', 'learnings', 'kb-note.md');
    fs.writeFileSync(learning, '---\ntitle: kb-note\n---\nA learning with votes.\n');
    const votes = path.join(partitionOf(project), 'reports-wt', 'votes', 'ci-808.yaml');
    fs.mkdirSync(path.dirname(votes), { recursive: true });
    fs.writeFileSync(votes, [
      'version: 2',
      'votes:',
      '  kb-note:',
      '    recalled_count: 5',
      '    upvoted_count: 5',
      `    last_recalled_at: ${new Date().toISOString()}`,
      'deltas: {}',
      '',
    ].join('\n'));
    const oldHead = git(['rev-parse', 'HEAD'], oldCheckout);
    const maintenance = await runCLI(['recall', 'maintenance', '--confidence-writeback'], projectRoot, home);
    expect(maintenance.code, maintenance.output).toBe(1);
    expect(maintenance.output.split(`${oldCheckout} still has teamai-learnings checked out`).length - 1, maintenance.output).toBe(1);
    expect(maintenance.output).not.toContain('Updated confidence');
    expect(fs.existsSync(path.join(partitionOf(project), 'learnings-wt'))).toBe(false);
    expect(fs.readFileSync(learning, 'utf8')).toBe('---\ntitle: kb-note\n---\nA learning with votes.\n');
    expect(git(['status', '--porcelain'], oldCheckout)).toBe('?? draft.txt\n');
    expect(git(['rev-parse', 'HEAD'], oldCheckout)).toBe(oldHead);
    fs.rmSync(learning);
    fs.rmSync(votes);

    // A contribute meanwhile stays queued: no pull publishes it until the old checkout is dealt with.
    const blocked = await runCLI(
      ['contribute', '--title', 'blocked-note', '--file', note(project, 'blocked', 'Note while the old checkout is in the way')],
      projectRoot,
      home,
    );
    expect(blocked.output).toContain(
      'Saved locally (an old teamai-learnings checkout is in the way; see the warning above). It stays queued and recallable here, ' +
        'but no `teamai pull` can publish it until that checkout is dealt with: do what the refusal says, then run `teamai pull`.',
    );
    expect(blocked.output).not.toContain('the next `teamai pull` publishes it');

    // Once the old checkout is clean, a contribute in the worktree, with no
    // pull first, removes it, moves the worktree's own old queue into the
    // shared one, and publishes all of it.
    fs.rmSync(stray);
    const fromWorktree = await runCLI(
      ['contribute', '--title', 'wt-note', '--file', note(project, 'wt', 'Note contributed from the worktree')],
      worktree,
      home,
    );
    expect(fromWorktree.code, fromWorktree.output).toBe(0);
    expect(fromWorktree.output).not.toContain('Saved locally');
    expect(fs.existsSync(oldCheckout)).toBe(false);
    expect(fs.existsSync(path.join(worktree, '.teamai', 'pending-learnings'))).toBe(false);
    expect(published(project).some((f) => f.includes('wt-note-')), published(project).join('\n')).toBe(true);
    expect(published(project)).toContain('learnings/legacy-main-2026-01-01-aaaaaa.md');
    expect(published(project)).toContain('learnings/legacy-wt-2026-01-01-bbbbbb.md');
    expect(published(project).some((f) => f.includes('blocked-note-')), published(project).join('\n')).toBe(true);

    // Removing the worktree loses nothing: every queued learning reached origin.
    // --force: the contribute brought its old .teamai/.gitignore up to date.
    git(['worktree', 'remove', '--force', worktree], projectRoot);
    expect(partitionQueue(project)).toEqual([]);
    expect(published(project)).toContain('learnings/legacy-wt-2026-01-01-bbbbbb.md');
  });

  it("publishes the learning an older import --from-mr left in the old checkout, so git can remove it and contribute publishes both (#823 item 7)", async () => {
    const project = setUpProject();
    const { home, remote, projectRoot } = project;
    const seed = path.join(project.sandbox, 'seed');
    git(['clone', '-q', remote, seed], project.sandbox);
    git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
    git(['rm', '-rfq', '.'], seed);
    fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.gitignore'), 'reports-wt/\nlearnings-wt/\nknowledge-wt/\n');
    fs.writeFileSync(path.join(seed, 'learnings', '.gitkeep'), '');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'learnings branch'], seed);
    git(['push', '-q', 'origin', 'teamai-learnings'], seed);
    git(['fetch', '-q', 'origin', 'teamai-learnings:teamai-learnings'], projectRoot);
    // The checkout an older teamai kept in .teamai/, holding what an older
    // import --from-mr wrote there and never committed.
    const oldCheckout = path.join(projectRoot, '.teamai', 'learnings-wt');
    git(['worktree', 'add', '-q', oldCheckout, 'teamai-learnings'], projectRoot);
    const remnant = [
      '---',
      'title: "Quokka cache warmup before deploy"',
      'date: 2026-09-20',
      'source_mr: "https://github.com/acme/app/pull/42"',
      '---',
      'Warm the quokka cache in the post-deploy hook.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(oldCheckout, 'learnings', '2026-09-20-Quokka-cache-warmup-before-deploy.md'), remnant);

    const contribute = await runCLI(
      ['contribute', '--title', 'self-note', '--file', note(project, 'self', 'Note contributed beside the old checkout')],
      projectRoot,
      home,
    );

    expect(contribute.code, contribute.output).toBe(0);
    expect(contribute.output).not.toContain('still has teamai-learnings checked out');
    expect(contribute.output).not.toContain('Saved locally');
    expect(fs.existsSync(oldCheckout)).toBe(false);
    expect(published(project).some((f) => f.includes('self-note-')), published(project).join('\n')).toBe(true);
    const quokka = published(project).filter((f) => /^learnings\/quokka-cache-warmup-before-deploy-[\d-]+-[a-z0-9]+\.md$/.test(f));
    expect(quokka, published(project).join('\n')).toHaveLength(1);
    expect(git(['show', `teamai-learnings:${quokka[0]}`], remote)).toBe(remnant);
    expect(partitionQueue(project)).toEqual([]);
  });

  it("removes that learning instead when a teammate already published one from the same merge request the old checkout never fetched (#823 item 21)", async () => {
    const project = setUpProject();
    const { home, remote, projectRoot } = project;
    const seed = path.join(project.sandbox, 'seed');
    git(['clone', '-q', remote, seed], project.sandbox);
    git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
    git(['rm', '-rfq', '.'], seed);
    fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.gitignore'), 'reports-wt/\nlearnings-wt/\nknowledge-wt/\n');
    fs.writeFileSync(path.join(seed, 'learnings', '.gitkeep'), '');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'learnings branch'], seed);
    git(['push', '-q', 'origin', 'teamai-learnings'], seed);
    git(['fetch', '-q', 'origin', 'teamai-learnings:teamai-learnings'], projectRoot);
    const oldCheckout = path.join(projectRoot, '.teamai', 'learnings-wt');
    git(['worktree', 'add', '-q', oldCheckout, 'teamai-learnings'], projectRoot);
    const remnantFile = path.join(oldCheckout, 'learnings', '2026-09-20-Quokka-cache-warmup-before-deploy.md');
    fs.writeFileSync(remnantFile, [
      '---',
      'title: "Quokka cache warmup before deploy"',
      'date: 2026-09-20',
      'source_mr: "https://github.com/acme/app/pull/42"',
      '---',
      'Warm the quokka cache in the post-deploy hook.',
      '',
    ].join('\n'));
    // A teammate's later import of the same MR, pushed after this repo last fetched.
    const teammates = 'learnings/quokka-cache-warmup-2026-09-21-ttt111.md';
    fs.writeFileSync(path.join(seed, teammates), [
      '---',
      'title: "Quokka cache warmup"',
      'date: 2026-09-21',
      'source_mr: "https://github.com/acme/app/pull/42"',
      '---',
      'Warm the quokka cache before traffic returns.',
      '',
    ].join('\n'));
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'teammate import'], seed);
    git(['push', '-q', 'origin', 'teamai-learnings'], seed);

    const contribute = await runCLI(
      ['contribute', '--title', 'self-note', '--file', note(project, 'self', 'Note contributed beside the old checkout')],
      projectRoot,
      home,
    );

    expect(contribute.code, contribute.output).toBe(0);
    expect(contribute.output).toContain(`Removed ${remnantFile}, which an older teamai import --from-mr left unpublished: ${teammates} already has it.`);
    expect(fs.existsSync(oldCheckout)).toBe(false);
    expect(published(project).filter((f) => f.includes('quokka')), published(project).join('\n')).toEqual([teammates]);
    expect(published(project).some((f) => f.includes('self-note-')), published(project).join('\n')).toBe(true);
    expect(partitionQueue(project)).toEqual([]);
  });

  it("refuses a learnings checkout another repository left in the partition, and publishes nothing to it", async () => {
    const project = setUpProject();
    const { sandbox, home, projectRoot } = project;

    // A team repo with its own teamai-learnings branch, as a git-mode install uses.
    const teamRemote = path.join(sandbox, 'team.git');
    const teamSeed = path.join(sandbox, 'team-seed');
    git(['init', '-q', '--bare', teamRemote], sandbox);
    git(['clone', '-q', teamRemote, teamSeed], sandbox);
    git(['checkout', '-q', '--orphan', 'teamai-learnings'], teamSeed);
    fs.mkdirSync(path.join(teamSeed, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'learnings', '.gitkeep'), '');
    // The other team's learning, which this project must never index or touch.
    // Dated today, so the weekly digest would list it.
    const foreignNote = `foreign-note-${new Date().toISOString().slice(0, 10)}-cccccc.md`;
    fs.writeFileSync(path.join(teamSeed, 'learnings', foreignNote), '# Foreign note from the other team\n');
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'learnings branch'], teamSeed);
    git(['push', '-q', 'origin', 'teamai-learnings'], teamSeed);

    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const projects = path.join(home, '.teamai', 'projects');
    const partition = path.join(projects, fs.readdirSync(projects)[0]);
    const checkout = path.join(partition, 'learnings-wt');

    // What the project's earlier git-mode install left in the same partition:
    // the team clone, with its own checkout of teamai-learnings where self mode
    // keeps the business repo's.
    git(['worktree', 'remove', checkout], projectRoot);
    const teamClone = path.join(partition, 'team-repo');
    git(['clone', '-q', teamRemote, teamClone], sandbox);
    git(['fetch', '-q', 'origin', 'teamai-learnings:teamai-learnings'], teamClone);
    git(['worktree', 'add', '-q', checkout, 'teamai-learnings'], teamClone);

    const contribute = await runCLI(
      ['contribute', '--title', 'self-note', '--file', note(project, 'self', 'Note contributed in self mode')],
      projectRoot,
      home,
    );
    // Said once in full; "Saved locally" gives the short reason.
    expect(contribute.output.split(`${checkout} is a teamai-learnings checkout of ${teamClone}`).length - 1, contribute.output).toBe(1);
    expect(contribute.output).toContain(`git -C ${teamClone} worktree remove ${checkout}`);
    expect(contribute.output).toContain('Saved locally (the teamai-learnings checkout belongs to another repository; see the warning above)');
    const teamLearnings = git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], teamRemote);
    expect(teamLearnings).not.toContain('self-note-');
    expect(fs.existsSync(checkout)).toBe(true);
    expect(partitionQueue(project).some((f) => f.startsWith('self-note-'))).toBe(true);
    // Neither contribute's index rebuild nor recall's own serves the other team's learning.
    // This project's own knowledge, the queued learning included, stays recallable.
    const recallAfterContribute = await runCLI(['recall', 'note'], projectRoot, home);
    expect(recallAfterContribute.output).not.toContain('foreign-note-');
    expect(recallAfterContribute.output).toContain('self-note-');
    // With no index at all, recall builds one itself.
    const workspaces = path.join(partition, 'workspaces');
    for (const id of fs.existsSync(workspaces) ? fs.readdirSync(workspaces) : []) {
      fs.rmSync(path.join(workspaces, id, 'search-index.json'), { force: true });
    }
    const recallRebuilt = await runCLI(['recall', 'note'], projectRoot, home);
    expect(recallRebuilt.output).not.toContain('foreign-note-');
    expect(recallRebuilt.output).toContain('self-note-');

    // A pull runs into it at several steps and still says it once in full.
    const pull = await runCLI(['pull'], projectRoot, home);
    expect(pull.output.split(`${checkout} is a teamai-learnings checkout of`).length - 1, pull.output).toBe(1);
    expect(git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], teamRemote)).not.toContain('self-note-');
    const recallAfterPull = await runCLI(['recall', 'note'], projectRoot, home);
    expect(recallAfterPull.output).not.toContain('foreign-note-');
    expect(recallAfterPull.output).toContain('self-note-');

    // The weekly digest lists this team's learnings, not the other team's. It
    // only gets that far with some team usage on this project's reports branch.
    const reportsCheckout = path.join(partition, 'reports-wt');
    fs.mkdirSync(path.join(reportsCheckout, 'stats'), { recursive: true });
    fs.writeFileSync(path.join(reportsCheckout, 'stats', 'ci-808.yaml'), 'username: ci-808\nskills: {}\n');
    git(['add', 'stats'], reportsCheckout);
    git(['commit', '-q', '-m', 'stats'], reportsCheckout);
    git(['push', '-q', 'origin', 'teamai-reports'], reportsCheckout);
    const digest = await runCLI(['digest'], projectRoot, home);
    expect(digest.output).not.toContain('No team usage data');
    expect(digest.output).not.toContain('Failed to generate digest');
    expect(digest.output).toContain('Active members: 1');
    expect(digest.output).not.toMatch(/foreign note/i);

    // Maintenance rewrites learnings, so it stops instead of touching the other team's checkout.
    const before = git(['rev-parse', 'HEAD'], checkout);
    const maintenance = await runCLI(['recall', 'maintenance', '--prune', '--threshold', '1'], projectRoot, home);
    expect(maintenance.code, maintenance.output).not.toBe(0);
    expect(maintenance.output).toContain(`${checkout} is a teamai-learnings checkout of ${teamClone}`);
    // Said once, as a message, not as a crash.
    expect(maintenance.output.split(`${checkout} is a teamai-learnings checkout of`).length - 1, maintenance.output).toBe(1);
    expect(maintenance.output).not.toContain('at refuseForeignCheckout');
    expect(fs.existsSync(path.join(checkout, 'learnings', foreignNote))).toBe(true);
    expect(git(['status', '--porcelain'], checkout)).toBe('');
    expect(git(['rev-parse', 'HEAD'], checkout)).toBe(before);

    // The same for the reports checkout: the other team's roster is not listed,
    // and the command stops with the refusal, not a crash.
    git(['checkout', '-q', '--orphan', 'teamai-reports'], teamSeed);
    git(['rm', '-rfq', '.'], teamSeed);
    fs.mkdirSync(path.join(teamSeed, 'members'), { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'members', 'other-team-member.yaml'), 'username: other-team-member\n');
    // The other team's upvotes under this member's name: of its own doc, and of
    // a file named like this project's queued learning.
    const selfNote = partitionQueue(project).find((f) => f.startsWith('self-note-'));
    if (!selfNote) throw new Error('self-note is not queued');
    fs.mkdirSync(path.join(teamSeed, 'votes'), { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'votes', 'ci-808.yaml'), [
      'version: 2',
      'votes:',
      '  foreign-doc:',
      '    recalled_count: 1',
      '    upvoted_count: 1',
      // Votes key a learning by its filename without `.md`.
      `  ${selfNote.replace(/\.md$/, '')}:`,
      '    recalled_count: 3',
      '    upvoted_count: 3',
      'deltas: {}',
      '',
    ].join('\n'));
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'reports branch'], teamSeed);
    git(['push', '-q', 'origin', 'teamai-reports'], teamSeed);
    git(['worktree', 'remove', '--force', reportsCheckout], projectRoot);
    git(['fetch', '-q', 'origin', 'teamai-reports:teamai-reports'], teamClone);
    git(['worktree', 'add', '-q', reportsCheckout, 'teamai-reports'], teamClone);
    for (const args of [['members'], ['projects', 'members', 'some-project']]) {
      const run = await runCLI(args, projectRoot, home);
      expect(run.code, run.output).toBe(1);
      expect(run.output.split(`${reportsCheckout} is a teamai-reports checkout of`).length - 1, run.output).toBe(1);
      expect(run.output).not.toContain('at refuseForeignCheckout');
      expect(run.output).not.toContain('other-team-member');
    }
    // A downvote does not count the other team's votes as this team's.
    const downvote = await runCLI(['recall', 'feedback', '--negative', 'foreign-doc'], projectRoot, home);
    expect(downvote.output).toContain('Document not found in votes: foreign-doc');
    expect(downvote.output).not.toContain('Negative signal recorded');

    // Nor does an index build: contribute's, then recall's own.
    const indexPath = path.join(partition, 'workspaces', workspaceId(projectRoot), 'search-index.json');
    const selfNoteVotes = (): number | undefined => {
      const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const entries = index && typeof index === 'object' && 'entries' in index && Array.isArray(index.entries) ? index.entries : [];
      const entry: unknown = entries.find((e: unknown) => e && typeof e === 'object' && 'filename' in e && e.filename === selfNote);
      return entry && typeof entry === 'object' && 'votes' in entry && typeof entry.votes === 'number' ? entry.votes : undefined;
    };
    await runCLI(['contribute', '--title', 'another-note', '--file', note(project, 'another', 'Another note')], projectRoot, home);
    expect(selfNoteVotes()).toBe(0);
    fs.rmSync(indexPath, { force: true });
    await runCLI(['recall', 'note'], projectRoot, home);
    expect(selfNoteVotes()).toBe(0);
  });

  it('refuses and keeps a learnings checkout whose repository is gone, and indexes none of it', async () => {
    const project = setUpProject();
    const { sandbox, home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const partition = partitionOf(project);
    const checkout = path.join(partition, 'learnings-wt');

    // A checkout of a repository that was moved or deleted since: its .git
    // points at a git dir that no longer exists, and it holds uncommitted work.
    git(['worktree', 'remove', checkout], projectRoot);
    const gone = path.join(sandbox, 'moved-repo', '.git', 'worktrees', 'learnings-wt');
    fs.mkdirSync(path.join(checkout, 'learnings'), { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git'), `gitdir: ${gone}\n`);
    const orphan = path.join(checkout, 'learnings', 'quokka-note-2026-01-01-eeeeee.md');
    fs.writeFileSync(orphan, '# Quokka note nobody committed\n');
    const refusal = `${checkout} is a teamai-learnings checkout teamai cannot show to be ${projectRoot}'s`;

    for (const id of fs.readdirSync(path.join(partition, 'workspaces'))) {
      fs.rmSync(path.join(partition, 'workspaces', id, 'search-index.json'), { force: true });
    }
    const recall = await runCLI(['recall', 'quokka', 'note'], projectRoot, home);
    expect(recall.output).not.toContain('quokka-note-');

    const contribute = await runCLI(
      ['contribute', '--title', 'kept-note', '--file', note(project, 'kept', 'Note contributed beside a checkout of a gone repository')],
      projectRoot,
      home,
    );
    expect(contribute.output.split(refusal).length - 1, contribute.output).toBe(1);
    expect(contribute.output).toContain('Saved locally');
    expect(fs.readFileSync(orphan, 'utf8')).toBe('# Quokka note nobody committed\n');
    expect(partitionQueue(project).some((f) => f.startsWith('kept-note-'))).toBe(true);
    const recallAfter = await runCLI(['recall', 'quokka', 'note'], projectRoot, home);
    expect(recallAfter.output).not.toContain('quokka-note-');
  });

  it('stops maintenance and promote while another command holds the learnings or reports lock, writing nothing', async () => {
    const project = setUpProject();
    const { home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const partition = partitionOf(project);
    const checkout = path.join(partition, 'learnings-wt');
    const lock = path.join(partition, '.learnings-lock');
    const busy = `The learnings checkout is locked: another teamai command may be updating it, or its lock at ${lock} could not be created. ` +
      `Nothing was changed. Run this again when the other command finishes; if this keeps happening, check that ${partition} is writable.`;

    // A live holder: this test's own process, as another teamai command would be.
    fs.writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), owner: 'issue-808-e2e' }),
    );
    const before = git(['rev-parse', 'HEAD'], checkout);
    for (const args of [['recall', 'maintenance', '--confidence-writeback'], ['recall', 'promote']]) {
      const run = await runCLI(args, projectRoot, home);
      expect(run.code, run.output).toBe(1);
      expect(run.output.split(busy).length - 1, run.output).toBe(1);
      expect(git(['status', '--porcelain'], checkout)).toBe('');
      expect(git(['rev-parse', 'HEAD'], checkout)).toBe(before);
    }

    // Maintenance reads votes from the reports checkout, which is just as unchecked under its lock.
    const reportsLock = path.join(partition, '.reports-lock');
    const reportsBusy = `The reports checkout is locked: another teamai command may be updating it, or its lock at ${reportsLock} could not be created. ` +
      `Nothing was changed. Run this again when the other command finishes; if this keeps happening, check that ${partition} is writable.`;
    fs.renameSync(lock, reportsLock);
    for (const args of [['recall', 'maintenance', '--confidence-writeback'], ['recall', 'promote']]) {
      const run = await runCLI(args, projectRoot, home);
      expect(run.code, run.output).toBe(1);
      expect(run.output.split(reportsBusy).length - 1, run.output).toBe(1);
      expect(git(['status', '--porcelain'], checkout)).toBe('');
      expect(git(['rev-parse', 'HEAD'], checkout)).toBe(before);
    }
    fs.renameSync(reportsLock, lock);

    // The holder may be creating the checkout: maintenance leaves the path to it.
    git(['worktree', 'remove', checkout], projectRoot);
    const creating = await runCLI(['recall', 'maintenance', '--confidence-writeback'], projectRoot, home);
    expect(creating.code, creating.output).toBe(1);
    expect(creating.output.split(busy).length - 1, creating.output).toBe(1);
    expect(fs.existsSync(checkout)).toBe(false);
  });

  it('sets aside a git-mode queue when init switches the project to single-repo mode, and uninstall lists every queue', async () => {
    const project = setUpProject();
    const { home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const partition = partitionOf(project);

    // An earlier git-mode install of this project, with a learning still
    // queued for its own team repository.
    fs.writeFileSync(path.join(partition, 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(partition, 'team-repo')}`,
      '  remote: https://git.example.com/other/team.git',
      '  kind: git',
      'username: ci-808',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${projectRoot}`,
      '',
    ].join('\n'));
    const queue = path.join(partition, 'pending-learnings');
    const otherTeams = 'other-team-note-2026-01-01-aaaaaa.md';
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, otherTeams), '# Queued for the other team\n');
    // Its search index, and a per-checkout one: both built from that repository.
    const rootIndex = path.join(partition, 'search-index.json');
    const checkoutIndex = path.join(partition, 'workspaces', workspaceId(projectRoot), 'search-index.json');
    fs.writeFileSync(rootIndex, '{"version":6,"entries":[]}\n');
    fs.mkdirSync(path.dirname(checkoutIndex), { recursive: true });
    fs.writeFileSync(checkoutIndex, '{"version":6,"entries":[]}\n');

    // init needs no network here: an unreachable origin fails the GitLab probe
    // at once, and the member registration push is best effort.
    git(['config', 'user.name', 'TeamAI CI'], projectRoot);
    git(['config', 'user.email', 'ci@teamai.test'], projectRoot);
    git(['remote', 'set-url', 'origin', 'http://127.0.0.1:9/team/project.git'], projectRoot);
    const init = await runCLI(['init', '--self', '--force'], projectRoot, home);
    expect(init.code, init.output).toBe(0);

    const asideDir = path.join(partition, 'pending-learnings.git');
    expect(fs.readFileSync(path.join(asideDir, otherTeams), 'utf8')).toBe('# Queued for the other team\n');
    expect(fs.existsSync(path.join(queue, otherTeams))).toBe(false);
    expect(init.output).toContain(`Set aside 1 queued learning(s) from the previous git install in ${asideDir}`);
    // No index built from the previous repository survives the switch.
    expect(fs.existsSync(rootIndex)).toBe(false);
    expect(fs.existsSync(checkoutIndex)).toBe(false);

    // Uninstall names every queue it would delete, with its count, before it asks.
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, 'mine-2026-01-01-bbbbbb.md'), '# Mine\n');
    const uninstall = await runCLI(['uninstall'], projectRoot, home);
    expect(uninstall.output).toContain(`1 unpublished learning(s) in ${queue}`);
    expect(uninstall.output).toContain(`1 unpublished learning(s) in ${asideDir}`);
    expect(fs.existsSync(partition)).toBe(true);
  });

  it("sets aside an unmigrated worktree's old queue once another checkout switched the project to a git team repo, and publishes none of it there", async () => {
    const project = setUpProject();
    const { sandbox, home, projectRoot, worktree } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);

    // The linked worktree's own pre-partition install, with a learning queued
    // for the business repo.
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const knowledge = path.join(worktree, '.teamai');
    fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
      'repo:',
      `  localPath: ${knowledge}`,
      `  remote: ${project.remote}`,
      '  kind: self',
      `  businessRepoRoot: ${worktree}`,
      'username: ci-808',
      'updatePolicy: auto',
      'scope: project',
      `projectRoot: ${worktree}`,
      '',
    ].join('\n'));
    const oldQueued = 'old-self-note-2026-01-01-ffffff.md';
    fs.mkdirSync(path.join(knowledge, 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'pending-learnings', oldQueued), '# Queued for the business repo\n');

    // A git team repo behind an HTTPS URL, which git rewrites to a local bare repo.
    const teamUrl = 'https://git.example.com/team/team.git';
    const teamRemote = path.join(sandbox, 'team.git');
    const teamSeed = path.join(sandbox, 'team-seed');
    fs.mkdirSync(teamSeed, { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'teamai.yaml'), [
      'team: issue-808-team',
      `repo: ${teamUrl}`,
      'provider: git',
      'reviewers: []',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], teamSeed);
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'team repo'], teamSeed);
    git(['clone', '-q', '--bare', teamSeed, teamRemote], sandbox);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[url "${teamRemote}"]\n\tinsteadOf = ${teamUrl}\n`);

    // The main checkout switches the project to the team repo.
    const init = await runCLI(['init', teamUrl, '--scope', 'project', '--force'], projectRoot, home);
    expect(init.code, init.output).toBe(0);
    const partition = partitionOf(project);
    // A git install: its config names the team repo and no kind.
    const partitionConfig = fs.readFileSync(path.join(partition, 'config.yaml'), 'utf8');
    expect(partitionConfig).toContain(`remote: ${teamUrl}`);
    expect(partitionConfig).not.toContain('kind:');
    // The self install's side-branch checkouts are in the way of the team
    // repo's; remove them, as teamai says to.
    for (const dir of ['learnings-wt', 'reports-wt']) git(['worktree', 'remove', path.join(partition, dir)], projectRoot);

    // The worktree never migrated: its checkout config still says self.
    const contribute = await runCLI(
      ['contribute', '--title', 'team-note', '--file', note(project, 'team', 'Note contributed to the team repo')],
      worktree,
      home,
    );
    expect(contribute.code, contribute.output).toBe(0);
    const teamLearnings = git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], teamRemote);
    expect(teamLearnings).toContain('team-note-');
    expect(teamLearnings).not.toContain(oldQueued);
    expect(partitionQueue(project)).not.toContain(oldQueued);
    // Kept beside the team repo's queue, where uninstall lists it.
    const aside = path.join(partition, 'pending-learnings.self');
    expect(fs.readFileSync(path.join(aside, oldQueued), 'utf8')).toBe('# Queued for the business repo\n');
    expect(contribute.output).toContain(`Set aside 1 queued learning(s) from the previous self install in ${aside}`);
    expect(fs.existsSync(path.join(knowledge, 'pending-learnings'))).toBe(false);
  });

  it('stops maintenance and promote when the learnings checkout cannot be created, writing nothing', async () => {
    const project = setUpProject();
    const { sandbox, home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const partition = partitionOf(project);
    const checkout = path.join(partition, 'learnings-wt');

    // teamai-learnings checked out where teamai does not look: git will not
    // check it out a second time.
    git(['worktree', 'remove', checkout], projectRoot);
    const elsewhere = path.join(sandbox, 'elsewhere-learnings');
    git(['worktree', 'add', '-q', elsewhere, 'teamai-learnings'], projectRoot);
    const elsewhereHead = git(['rev-parse', 'HEAD'], elsewhere);

    const learning = path.join(projectRoot, '.teamai', 'learnings', 'kb-note.md');
    fs.writeFileSync(learning, '---\ntitle: kb-note\n---\nA learning with votes.\n');
    const votes = path.join(partition, 'reports-wt', 'votes', 'ci-808.yaml');
    fs.mkdirSync(path.dirname(votes), { recursive: true });
    fs.writeFileSync(votes, [
      'version: 2',
      'votes:',
      '  kb-note:',
      '    recalled_count: 5',
      '    upvoted_count: 5',
      `    last_recalled_at: ${new Date().toISOString()}`,
      'deltas: {}',
      '',
    ].join('\n'));

    for (const args of [['recall', 'maintenance', '--confidence-writeback'], ['recall', 'promote']]) {
      const run = await runCLI(args, projectRoot, home);
      expect(run.code, run.output).toBe(1);
      expect(run.output).toContain('The learnings checkout could not be set up: ');
      expect(run.output).toContain(elsewhere);
      expect(run.output).toContain('Nothing was changed.');
      expect(run.output).not.toContain('Updated confidence');
      expect(fs.existsSync(checkout)).toBe(false);
      expect(fs.readFileSync(learning, 'utf8')).toBe('---\ntitle: kb-note\n---\nA learning with votes.\n');
      expect(git(['status', '--porcelain'], elsewhere)).toBe('');
      expect(git(['rev-parse', 'HEAD'], elsewhere)).toBe(elsewhereHead);
    }
  });

  it("sets aside the queue an older self install left in the checkout once the project uses a team repo, so contribute and init still run", async () => {
    const project = setUpProject();
    const { sandbox, home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);

    const teamUrl = 'https://git.example.com/team/team.git';
    const teamRemote = path.join(sandbox, 'team.git');
    const teamSeed = path.join(sandbox, 'team-seed');
    fs.mkdirSync(teamSeed, { recursive: true });
    fs.writeFileSync(path.join(teamSeed, 'teamai.yaml'), [
      'team: issue-808-team',
      `repo: ${teamUrl}`,
      'provider: git',
      'reviewers: []',
      '',
    ].join('\n'));
    git(['init', '-q', '-b', 'main'], teamSeed);
    git(['add', '-A'], teamSeed);
    git(['commit', '-q', '-m', 'team repo'], teamSeed);
    git(['clone', '-q', '--bare', teamSeed, teamRemote], sandbox);
    fs.writeFileSync(path.join(home, '.gitconfig'), `[url "${teamRemote}"]\n\tinsteadOf = ${teamUrl}\n`);
    const init = await runCLI(['init', teamUrl, '--scope', 'project', '--force'], projectRoot, home);
    expect(init.code, init.output).toBe(0);
    const partition = partitionOf(project);
    for (const dir of ['learnings-wt', 'reports-wt']) git(['worktree', 'remove', path.join(partition, dir)], projectRoot);

    // What an older teamai left: a self install whose config was already in
    // the partition queued in the checkout, and its init switched the project
    // to the team repo without moving that queue.
    const oldQueue = path.join(projectRoot, '.teamai', 'pending-learnings');
    const oldQueued = 'old-self-note-2026-01-01-aaaaaa.md';
    fs.mkdirSync(oldQueue, { recursive: true });
    fs.writeFileSync(path.join(oldQueue, oldQueued), '# Queued for the business repo\n');

    const contribute = await runCLI(
      ['contribute', '--title', 'team-note', '--file', note(project, 'team', 'Note contributed to the team repo')],
      projectRoot,
      home,
    );
    expect(contribute.code, contribute.output).toBe(0);
    const aside = path.join(partition, 'pending-learnings.self');
    expect(fs.readFileSync(path.join(aside, oldQueued), 'utf8')).toBe('# Queued for the business repo\n');
    expect(contribute.output).toContain(`Set aside 1 queued learning(s) from the previous self install in ${aside}`);
    expect(fs.existsSync(oldQueue)).toBe(false);
    const teamLearnings = git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], teamRemote);
    expect(teamLearnings).toContain('team-note-');
    expect(teamLearnings).not.toContain(oldQueued);

    const reinit = await runCLI(['init', teamUrl, '--scope', 'project', '--force'], projectRoot, home);
    expect(reinit.code, reinit.output).toBe(0);
  });

  it("names the checkout's config.yaml it cannot read when a learning queued beside it stops contribute", async () => {
    const project = setUpProject();
    const { home, projectRoot } = project;
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);

    const legacyDir = path.join(projectRoot, '.teamai');
    const legacyConfig = path.join(legacyDir, 'config.yaml');
    fs.writeFileSync(legacyConfig, 'repo: [not a config\n');
    const queued = 'kept-note-2026-01-01-aaaaaa.md';
    fs.mkdirSync(path.join(legacyDir, 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'pending-learnings', queued), '# Queued beside a broken config\n');

    const contribute = await runCLI(
      ['contribute', '--title', 'blocked', '--file', note(project, 'blocked', 'Blocked note')],
      projectRoot,
      home,
    );
    expect(contribute.code, contribute.output).toBe(1);
    expect(contribute.output).toContain(`${legacyConfig} cannot be read`);
    expect(contribute.output).toContain('see the warning above');
    expect(fs.readdirSync(path.join(legacyDir, 'pending-learnings'))).toEqual([queued]);
  });
});


/**
 * A git team repo, and a business repo with a bare origin and a linked
 * worktree. Neither checkout has teamai yet; writeGitInstall gives one the
 * install an older teamai left.
 */
function setUpGitInstall(): Project & { teamRemote: string } {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue808-git-e2e-')));
  sandboxes.push(sandbox);
  const install = {
    sandbox,
    home: path.join(sandbox, 'home'),
    remote: path.join(sandbox, 'origin.git'),
    projectRoot: path.join(sandbox, 'project'),
    worktree: path.join(sandbox, 'project-wt'),
    teamRemote: path.join(sandbox, 'team.git'),
  };
  fs.mkdirSync(install.home, { recursive: true });

  const teamSeed = path.join(sandbox, 'team-seed');
  fs.mkdirSync(teamSeed, { recursive: true });
  fs.writeFileSync(path.join(teamSeed, 'teamai.yaml'), [
    'team: issue-808-git',
    `repo: ${install.teamRemote}`,
    'provider: git',
    '',
  ].join('\n'));
  git(['init', '-q', '-b', 'main'], teamSeed);
  git(['add', '-A'], teamSeed);
  git(['commit', '-q', '-m', 'team repo'], teamSeed);
  git(['clone', '-q', '--bare', teamSeed, install.teamRemote], sandbox);

  git(['init', '-q', '--bare', install.remote], sandbox);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], install.remote);
  fs.mkdirSync(install.projectRoot, { recursive: true });
  fs.writeFileSync(path.join(install.projectRoot, 'README.md'), '# Business repo\n');
  git(['init', '-q', '-b', 'main'], install.projectRoot);
  git(['add', '-A'], install.projectRoot);
  git(['commit', '-q', '-m', 'project'], install.projectRoot);
  git(['remote', 'add', 'origin', install.remote], install.projectRoot);
  git(['push', '-q', '-u', 'origin', 'main'], install.projectRoot);
  return install;
}

/**
 * The git-mode install an older teamai left in a checkout's `.teamai/`: a
 * clone of the team repo and the config naming it. Returns that directory.
 */
function writeGitInstall(install: { teamRemote: string }, checkout: string): string {
  const legacyDir = path.join(checkout, '.teamai');
  const clone = path.join(legacyDir, 'team-repo');
  fs.mkdirSync(legacyDir, { recursive: true });
  git(['clone', '-q', install.teamRemote, clone], checkout);
  fs.writeFileSync(path.join(legacyDir, 'config.yaml'), [
    'repo:',
    `  localPath: ${clone}`,
    `  remote: ${install.teamRemote}`,
    '  kind: git',
    'username: ci-808',
    'updatePolicy: auto',
    'scope: project',
    `projectRoot: ${checkout}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({ lastPullRev: null }));
  return legacyDir;
}

/** A team repo `init` can take by its HTTPS URL, which git rewrites to a local bare repo. */
function serveTeamRepo(install: Project, name: string): { url: string; bare: string } {
  const url = `https://git.example.com/team/${name}.git`;
  const bare = path.join(install.sandbox, `${name}.git`);
  const seed = path.join(install.sandbox, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), [`team: ${name}`, `repo: ${url}`, 'provider: git', 'reviewers: []', ''].join('\n'));
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'team repo'], seed);
  git(['clone', '-q', '--bare', seed, bare], install.sandbox);
  fs.appendFileSync(path.join(install.home, '.gitconfig'), `[url "${bare}"]\n\tinsteadOf = ${url}\n`);
  return { url, bare };
}

describe('a checkout an older git-mode install left (#808)', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }
  });

  afterEach(() => {
    for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("stops contribute while the partition has no config it can read, so nothing is queued in the checkout", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const legacyDir = writeGitInstall(install, projectRoot);
    const partition = path.join(home, '.teamai', 'projects', projectSlug(projectRoot));

    // A partition moved aside by hand, then one whose config does not parse.
    for (const config of [null, 'repo: "unterminated\n']) {
      fs.rmSync(partition, { recursive: true, force: true });
      fs.mkdirSync(partition, { recursive: true });
      if (config !== null) fs.writeFileSync(path.join(partition, 'config.yaml'), config);

      const run = await runCLI(
        ['contribute', '--title', 'kept-note', '--file', note(install, 'kept', 'Note contributed beside a broken partition')],
        projectRoot,
        home,
      );
      expect(run.code, run.output).toBe(1);
      expect(run.output).toContain("teamai could not move this checkout's data into the project's shared data directory (");
      expect(run.output).toContain('Nothing was saved.');
      expect(fs.existsSync(path.join(legacyDir, 'pending-learnings'))).toBe(false);
      expect(fs.existsSync(path.join(legacyDir, 'config.yaml'))).toBe(true);
    }
  });

  it("keeps a linked worktree's queue when another checkout migrated first, so removing the worktree loses nothing", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot, worktree } = install;
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    const queued = new Map([
      [writeGitInstall(install, projectRoot), 'root-note-2026-01-01-aaaaaa.md'],
      [writeGitInstall(install, worktree), 'wt-note-2026-01-01-bbbbbb.md'],
    ]);
    for (const [legacyDir, name] of queued) {
      fs.mkdirSync(path.join(legacyDir, 'pending-learnings'), { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'pending-learnings', name), `# ${name}\n`);
    }

    // The main checkout builds the partition; the worktree finds it built.
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);
    const second = await runCLI(['pull'], worktree, home);
    expect(second.code, second.output).toBe(0);
    expect(fs.existsSync(path.join(worktree, '.teamai'))).toBe(false);
    git(['worktree', 'remove', '--force', worktree], projectRoot);

    // Each learning is still queued in the partition, or on the team repo.
    const kept = [
      ...partitionQueue(install),
      ...git(['log', '--all', '--name-only', '--format='], install.teamRemote).split('\n').map((f) => path.basename(f)),
    ];
    for (const name of queued.values()) expect(kept, kept.join('\n')).toContain(name);
  });

  it('lets a checkout pull and contribute after another checkout switched the project to single-repo mode, keeping the knowledge and setting the old queue aside', async () => {
    const install = setUpGitInstall();
    const { home, remote, projectRoot, worktree } = install;
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    writeGitInstall(install, projectRoot);
    const legacyDir = writeGitInstall(install, worktree);
    const oldQueued = 'old-git-note-2026-01-01-eeeeee.md';
    fs.mkdirSync(path.join(legacyDir, 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'pending-learnings', oldQueued), '# Queued for the git team repo\n');

    // The main checkout switches the project to single-repo mode. init needs
    // no network here: an unreachable origin fails the GitLab probe at once.
    git(['config', 'user.name', 'TeamAI CI'], projectRoot);
    git(['config', 'user.email', 'ci@teamai.test'], projectRoot);
    git(['remote', 'set-url', 'origin', 'http://127.0.0.1:9/team/project.git'], projectRoot);
    const init = await runCLI(['init', '--self', '--force'], projectRoot, home);
    expect(init.code, init.output).toBe(0);
    git(['remote', 'set-url', 'origin', remote], projectRoot);

    // The worktree's branch takes the knowledge init committed on main, next
    // to its own old install.
    git(['merge', '-q', 'main'], worktree);
    const teamaiYaml = fs.readFileSync(path.join(worktree, '.teamai', 'teamai.yaml'), 'utf8');
    expect(teamaiYaml).toContain('mode: self');
    expect(fs.existsSync(path.join(legacyDir, 'config.yaml'))).toBe(true);

    const pull = await runCLI(['pull'], worktree, home);
    expect(pull.code, pull.output).toBe(0);
    const contribute = await runCLI(
      ['contribute', '--title', 'self-note', '--file', note(install, 'self', 'Note contributed after the switch')],
      worktree,
      home,
    );
    expect(contribute.code, contribute.output).toBe(0);

    // The knowledge is as main has it, and nothing of the old install is left
    // for git to see.
    expect(fs.readFileSync(path.join(worktree, '.teamai', 'teamai.yaml'), 'utf8')).toBe(teamaiYaml);
    expect(git(['status', '--porcelain', '--', '.teamai'], worktree)).toBe('');
    // The old install is kept, out of git's sight.
    expect(fs.existsSync(path.join(`${legacyDir}.bak`, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(`${legacyDir}.bak`, 'team-repo', '.git'))).toBe(true);
    // Its queue is set aside, not published to the business repo.
    const aside = path.join(home, '.teamai', 'projects', projectSlug(projectRoot), 'pending-learnings.git');
    expect(fs.readFileSync(path.join(aside, oldQueued), 'utf8')).toBe('# Queued for the git team repo\n');
    expect(pull.output).toContain(`Set aside 1 queued learning(s) from the previous git install in ${aside}`);
    expect(published(install).some((f) => f.includes('self-note-')), published(install).join('\n')).toBe(true);
    expect(published(install)).not.toContain(`learnings/${oldQueued}`);

    const again = await runCLI(['pull'], worktree, home);
    expect(again.code, again.output).toBe(0);
  });

  it("sets aside the queue when init points the project at another team repo, and the next pull publishes none of it there (#823 item 13)", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    // Team A rejects the push, so the learning stays queued for it.
    const queued = await withPushesRejected({ ...install, remote: teamA.bare }, () => runCLI(
      ['contribute', '--title', 'team-a-note', '--file', note(install, 'team-a', 'Note for team A')],
      projectRoot,
      home,
    ));
    expect(queued.output).toContain('Saved locally');
    const [name] = partitionQueue(install).filter((f) => f.startsWith('team-a-note-'));
    expect(name, partitionQueue(install).join('\n')).toBeDefined();

    // A search index built from team A's knowledge.
    const index = path.join(partitionOf(install), 'search-index.json');
    fs.writeFileSync(index, '{"version":6,"entries":[],"built":"team-a"}\n');

    // The same team repo written another way changes nothing.
    const initSame = await runCLI(['init', teamA.url.replace(/\.git$/, '/'), '--scope', 'project', '--force'], projectRoot, home);
    expect(initSame.code, initSame.output).toBe(0);
    expect(initSame.output).not.toContain('Set aside');
    expect(partitionQueue(install)).toContain(name);
    expect(fs.readFileSync(index, 'utf8')).toContain('"built":"team-a"');

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initB.code, initB.output).toBe(0);
    const partition = partitionOf(install);
    const aside = path.join(partition, 'pending-learnings.git-git.example.com-team-team-a');
    expect(fs.readFileSync(path.join(aside, name), 'utf8')).toContain('Note for team A');
    expect(initB.output).toContain(`Set aside 1 queued learning(s) from the previous git install in ${aside}`);
    expect(partitionQueue(install)).not.toContain(name);
    expect(fs.existsSync(index)).toBe(false);

    const pull = await runCLI(['pull'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(git(['log', '--all', '--name-only', '--format='], teamB.bare)).not.toContain('team-a-note-');
  });

  it("leaves no config naming team A beside team B's clone when init stops after recloning, and sets team A's queue aside (#823 item 17)", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');
    // Team B has roles, so an unknown --role stops init after it has recloned.
    const edit = path.join(install.sandbox, 'team-b-edit');
    git(['clone', '-q', teamB.bare, edit], install.sandbox);
    fs.mkdirSync(path.join(edit, 'manifest'));
    fs.writeFileSync(path.join(edit, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: backend\n    resources:\n      knowledge: []\n      skills: []\n');
    git(['add', '-A'], edit);
    git(['commit', '-q', '-m', 'roles'], edit);
    git(['push', '-q', 'origin', 'main'], edit);

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    const queued = await withPushesRejected({ ...install, remote: teamA.bare }, () => runCLI(
      ['contribute', '--title', 'team-a-note', '--file', note(install, 'team-a', 'Note for team A')],
      projectRoot,
      home,
    ));
    expect(queued.output).toContain('Saved locally');
    const [name] = partitionQueue(install).filter((f) => f.startsWith('team-a-note-'));
    expect(name, partitionQueue(install).join('\n')).toBeDefined();

    const failed = await runCLI(['init', teamB.url, '--scope', 'project', '--force', '--role', 'ghost'], projectRoot, home);

    expect(failed.code, failed.output).toBe(1);
    expect(failed.output).toContain('Unknown role "ghost"');
    const partition = partitionOf(install);
    expect(git(['remote', 'get-url', 'origin'], path.join(partition, 'team-repo')).trim()).toBe(teamB.url);
    const config = path.join(partition, 'config.yaml');
    expect(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '', failed.output).not.toContain(teamA.url);
    // Moved aside, not deleted, and the member is told where.
    expect(fs.readFileSync(`${config}.previous`, 'utf8')).toContain(teamA.url);
    expect(failed.output).toContain(`Moved ${config} to ${config}.previous`);
    const aside = path.join(partition, 'pending-learnings.git-git.example.com-team-team-a');
    expect(fs.readFileSync(path.join(aside, name), 'utf8')).toContain('Note for team A');
    expect(partitionQueue(install)).not.toContain(name);

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force', '--role', 'backend'], projectRoot, home);
    expect(initB.code, initB.output).toBe(0);
    const pull = await runCLI(['pull'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(git(['log', '--all', '--name-only', '--format='], teamB.bare)).not.toContain('team-a-note-');
  });

  it("moves team A's config aside when init reuses a clone of team B an earlier init left beside it and then fails, and carries its settings on the rerun (#823 item 17)", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force', '--agent', 'claude'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    const partition = partitionOf(install);
    const config = path.join(partition, 'config.yaml');
    // What an init that recloned team B and stopped before saving left: team A's config beside team B's clone.
    const clone = path.join(partition, 'team-repo');
    fs.rmSync(clone, { recursive: true, force: true });
    git(['clone', '-q', teamB.bare, clone], install.sandbox);
    git(['remote', 'set-url', 'origin', teamB.url], clone);
    // Without team B's rewrite the clone names team B itself, so init reuses it,
    // and with HTTPS refused its refresh fails.
    const gitconfig = path.join(home, '.gitconfig');
    const rewrites = fs.readFileSync(gitconfig, 'utf8');
    fs.writeFileSync(gitconfig, rewrites.replace(`[url "${teamB.bare}"]\n\tinsteadOf = ${teamB.url}\n`, ''));

    const failed = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home, { GIT_ALLOW_PROTOCOL: 'file' });

    expect(failed.code, failed.output).toBe(1);
    expect(failed.output).toContain('using existing clone');
    expect(failed.output).toContain('Failed to refresh existing clone');
    expect(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '', failed.output).not.toContain(teamA.url);
    expect(fs.readFileSync(`${config}.previous`, 'utf8')).toContain(teamA.url);
    fs.writeFileSync(gitconfig, rewrites);

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);

    expect(initB.code, initB.output).toBe(0);
    const saved = fs.readFileSync(config, 'utf8');
    expect(saved).toContain(teamB.url);
    expect(saved).toMatch(/enabledAgents:\n\s+- claude\n/);
  });

  it("carries the set-aside config's settings into the init that reruns after the replacement clone failed (#823 item 17)", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force', '--agent', 'claude'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    const config = path.join(partitionOf(install), 'config.yaml');
    expect(fs.readFileSync(config, 'utf8')).toMatch(/enabledAgents:\n\s+- claude\n/);

    // Team B is unreachable, so the clone fails after the config was moved aside.
    fs.renameSync(teamB.bare, `${teamB.bare}.offline`);
    const failed = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(failed.code, failed.output).toBe(1);
    expect(failed.output).toContain('Clone failed');
    expect(fs.existsSync(config)).toBe(false);
    fs.renameSync(`${teamB.bare}.offline`, teamB.bare);

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force', '--agent', 'codex'], projectRoot, home);

    expect(initB.code, initB.output).toBe(0);
    const saved = fs.readFileSync(config, 'utf8');
    expect(saved).toContain(teamB.url);
    expect(saved).toMatch(/enabledAgents:\n\s+- claude\n\s+- codex\n/);
  });

  it('keeps the agent lists of the set-aside config when the rerun after a failed replacement clone names no --agent (#823 item 17)', async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force', '--agent', 'claude'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    const config = path.join(partitionOf(install), 'config.yaml');
    // What `uninstall --agent codex` records.
    const written = fs.readFileSync(config, 'utf8');
    expect(written).toContain('disabledAgents: []\n');
    fs.writeFileSync(config, written.replace('disabledAgents: []\n', 'disabledAgents:\n  - codex\n'));

    fs.renameSync(teamB.bare, `${teamB.bare}.offline`);
    const failed = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(failed.code, failed.output).toBe(1);
    expect(fs.existsSync(config)).toBe(false);
    fs.renameSync(`${teamB.bare}.offline`, teamB.bare);

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);

    expect(initB.code, initB.output).toBe(0);
    const saved = fs.readFileSync(config, 'utf8');
    expect(saved).toContain(teamB.url);
    expect(saved).toMatch(/enabledAgents:\n\s+- claude\n/);
    expect(saved).toMatch(/disabledAgents:\n\s+- codex\n/);
  });

  it("sets aside the queue under an unknown owner when init replaces a config it cannot read, and the next pull publishes none of it", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    const queued = await withPushesRejected({ ...install, remote: teamA.bare }, () => runCLI(
      ['contribute', '--title', 'team-a-note', '--file', note(install, 'team-a', 'Note for team A')],
      projectRoot,
      home,
    ));
    expect(queued.output).toContain('Saved locally');
    const [name] = partitionQueue(install).filter((f) => f.startsWith('team-a-note-'));
    expect(name, partitionQueue(install).join('\n')).toBeDefined();

    // The config naming team A no longer parses, so nothing says whose queue it is.
    const partition = partitionOf(install);
    const config = path.join(partition, 'config.yaml');
    fs.writeFileSync(config, 'repo: [not a config\n');
    // A current-schema index built from team A's knowledge, which recall would serve as is.
    const index = path.join(partition, 'search-index.json');
    fs.writeFileSync(index, '{"version":6,"entries":[],"built":"team-a"}\n');

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initB.code, initB.output).toBe(0);
    expect(fs.existsSync(index)).toBe(false);
    const aside = path.join(partition, 'pending-learnings.unknown');
    expect(fs.readFileSync(path.join(aside, name), 'utf8')).toContain('Note for team A');
    expect(initB.output).toContain(`Set aside 1 queued learning(s) in ${aside}`);
    expect(initB.output).toContain(config);
    expect(partitionQueue(install)).not.toContain(name);

    const pull = await runCLI(['pull'], projectRoot, home);
    expect(pull.code, pull.output).toBe(0);
    expect(git(['log', '--all', '--name-only', '--format='], teamB.bare)).not.toContain('team-a-note-');
  });

  it("refuses and keeps team A's learnings checkout once init reclones team B at the same path, so its uncommitted work stays", async () => {
    const install = setUpGitInstall();
    const { home, projectRoot } = install;
    const teamA = serveTeamRepo(install, 'team-a');
    const teamB = serveTeamRepo(install, 'team-b');

    const initA = await runCLI(['init', teamA.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initA.code, initA.output).toBe(0);
    const published = await runCLI(
      ['contribute', '--title', 'team-a-note', '--file', note(install, 'team-a', 'Note for team A')],
      projectRoot,
      home,
    );
    expect(published.code, published.output).toBe(0);
    const partition = partitionOf(install);
    const checkout = path.join(partition, 'learnings-wt');
    const draft = path.join(checkout, 'learnings', 'team-a-draft-2026-01-01-aaaaaa.md');
    fs.writeFileSync(draft, '# Team A draft nobody committed\n');

    const initB = await runCLI(['init', teamB.url, '--scope', 'project', '--force'], projectRoot, home);
    expect(initB.code, initB.output).toBe(0);
    // The new clone sits where team A's did, and has no registration of the old checkout.
    expect(git(['remote', 'get-url', 'origin'], path.join(partition, 'team-repo')).trim()).toBe(teamB.url);

    const refusal = `${checkout} is a teamai-learnings checkout teamai cannot show to be ${path.join(partition, 'team-repo')}'s`;
    const contribute = await runCLI(
      ['contribute', '--title', 'team-b-note', '--file', note(install, 'team-b', 'Note for team B')],
      projectRoot,
      home,
    );
    expect(contribute.output.split(refusal).length - 1, contribute.output).toBe(1);
    expect(contribute.output).toContain('Saved locally');
    expect(fs.readFileSync(draft, 'utf8')).toBe('# Team A draft nobody committed\n');
    expect(git(['log', '--all', '--name-only', '--format='], teamB.bare)).not.toContain('team-a-');
  });

  it("sets aside a linked worktree's old queue for another team repo, and publishes none of it to this one (#823 item 13)", async () => {
    const install = setUpGitInstall();
    const { sandbox, home, projectRoot, worktree } = install;
    git(['worktree', 'add', '-q', worktree, '-b', 'wt-808'], projectRoot);
    writeGitInstall(install, projectRoot);
    const first = await runCLI(['pull'], projectRoot, home);
    expect(first.code, first.output).toBe(0);

    // The worktree's own older install belongs to another team repo.
    const otherTeam = path.join(sandbox, 'other-team.git');
    git(['clone', '-q', '--bare', path.join(sandbox, 'team-seed'), otherTeam], sandbox);
    const legacyDir = writeGitInstall({ teamRemote: otherTeam }, worktree);
    const oldQueued = 'other-team-note-2026-01-01-aaaaaa.md';
    fs.mkdirSync(path.join(legacyDir, 'pending-learnings'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'pending-learnings', oldQueued), '# Queued for the other team\n');

    const pull = await runCLI(['pull'], worktree, home);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.existsSync(legacyDir)).toBe(false);
    const partition = partitionOf(install);
    const asides = fs.readdirSync(partition).filter((n) => n.startsWith('pending-learnings.'));
    expect(asides).toHaveLength(1);
    expect(asides[0]).toMatch(/^pending-learnings\.git-.+-other-team$/);
    expect(fs.readFileSync(path.join(partition, asides[0], oldQueued), 'utf8')).toBe('# Queued for the other team\n');
    expect(pull.output).toContain(`Set aside 1 queued learning(s) from the previous git install in ${path.join(partition, asides[0])}`);
    expect(partitionQueue(install)).not.toContain(oldQueued);
    expect(git(['log', '--all', '--name-only', '--format='], install.teamRemote)).not.toContain(oldQueued);
  });
});

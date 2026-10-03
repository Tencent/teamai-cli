/**
 * E2E (#900 C5): a dry run of `roles add/remove/update` and
 * `projects add/update/remove` leaves the team clone exactly as it was.
 *
 * These commands used to pull before their dry-run guard, and `pullRepo` falls
 * back to `git reset --hard origin/<b>` when a fast-forward fails, so a dry run
 * on a clone with unpushed commits discarded them. `remove` also saved the
 * reconciled placement records, and in single-repo mode both commands created
 * the knowledge worktree. A preview may fetch; it must not move HEAD, touch the
 * working tree, save state or add a worktree. It still resolves names against
 * the default branch on origin, as the real run does.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
};

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], cwd: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
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

const ROLES_YAML = [
  'version: 1',
  'roles:',
  '  - id: base',
  '    description: ""',
  '    resources:',
  '      knowledge: [base]',
  '      skills: [base]',
  '      agents: [base]',
  '',
].join('\n');

const PROJECTS_YAML = [
  'version: 1',
  'projects:',
  '  - id: alpha',
  '    name: ""',
  '    description: ""',
  '    resources:',
  '      knowledge: [alpha]',
  '      skills: [alpha]',
  '      agents: [alpha]',
  '',
].join('\n');

function writeTeamFiles(dir: string, extra: string[]): void {
  fs.mkdirSync(path.join(dir, 'manifest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), [
    'team: issue-900-e2e',
    ...extra,
    'repo: https://git.example.com/team/repo.git',
    'provider: git',
    'usageReport: false',
    'toolPaths:',
    '  claude:',
    '    rules: .claude/rules',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'manifest', 'roles.yaml'), ROLES_YAML);
  fs.writeFileSync(path.join(dir, 'manifest', 'projects.yaml'), PROJECTS_YAML);
  fs.writeFileSync(path.join(dir, 'rules', 'doomed.md'), '# Doomed\n');
}

/**
 * Origin moves on after the member's last pull: it gains a role and a rule
 * the member's checkout has not seen. A real run would pull them first.
 */
function advanceOrigin(upstream: string, knowledgeRel: string): void {
  const knowledge = path.join(upstream, knowledgeRel);
  fs.appendFileSync(path.join(knowledge, 'manifest', 'roles.yaml'), [
    '  - id: remote-role',
    '    description: ""',
    '    resources:',
    '      knowledge: [remote]',
    '      skills: [remote]',
    '      agents: [remote]',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(knowledge, 'rules', 'fresh.md'), '# Fresh\n');
  git(['add', '-A'], upstream);
  git(['commit', '-q', '-m', 'upstream moves on'], upstream);
  git(['push', '-q', 'origin', 'main'], upstream);
}

/** The member's checkout diverges: a commit origin does not have. */
function commitLocally(checkout: string): void {
  fs.writeFileSync(path.join(checkout, 'local-note.md'), 'not pushed yet\n');
  git(['add', 'local-note.md'], checkout);
  git(['commit', '-q', '-m', 'local work'], checkout);
}

/**
 * `git worktree add` runs the checkout's post-checkout hook, so a worktree
 * created and removed within one run still leaves this mark.
 */
function markCheckouts(checkout: string): string {
  const marker = path.join(path.dirname(checkout), `${path.basename(checkout)}.checkouts`);
  const hook = path.join(checkout, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\necho "$PWD" >> "${marker}"\n`, { mode: 0o755 });
  return marker;
}

/**
 * A placement record whose file is not on the default branch: reconciling
 * drops it, which a real `remove` saves before resolving names.
 */
const STATE_JSON = `${JSON.stringify({ placedRules: { gone: 'rules/ns/gone.md' } }, null, 2)}\n`;

interface Snapshot {
  head: string;
  branch: string;
  status: string;
  worktrees: string;
  state: string | null;
  checkouts: string | null;
}

function snapshot(fixture: Fixture): Snapshot {
  const { checkout, statePath, checkoutMarker } = fixture;
  return {
    head: git(['rev-parse', 'HEAD'], checkout).trim(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], checkout).trim(),
    status: git(['status', '--porcelain', '--untracked-files=all'], checkout),
    worktrees: git(['worktree', 'list', '--porcelain'], checkout),
    state: fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null,
    checkouts: fs.existsSync(checkoutMarker) ? fs.readFileSync(checkoutMarker, 'utf8') : null,
  };
}

interface Fixture {
  home: string;
  cwd: string;
  checkout: string;
  statePath: string;
  checkoutMarker: string;
}

const sandboxes: string[] = [];

function newSandbox(): string {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-900-git-previews-')));
  sandboxes.push(sandbox);
  return sandbox;
}

/** A dedicated team-repo clone (user scope), diverged from origin. */
function setUpClone(): Fixture {
  const sandbox = newSandbox();
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'remote.git');
  const upstream = path.join(sandbox, 'upstream');
  const checkout = path.join(home, '.teamai', 'team-repo');

  git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
  fs.mkdirSync(upstream, { recursive: true });
  writeTeamFiles(upstream, []);
  git(['init', '-q', '-b', 'main'], upstream);
  git(['add', '-A'], upstream);
  git(['commit', '-q', '-m', 'seed'], upstream);
  git(['remote', 'add', 'origin', remote], upstream);
  git(['push', '-q', '-u', 'origin', 'main'], upstream);

  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  git(['clone', '-q', '-b', 'main', remote, checkout], sandbox);
  fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:',
    `  localPath: ${checkout}`,
    '  remote: https://git.example.com/team/repo.git',
    'username: e2e',
    'updatePolicy: skip',
    'scope: user',
    '',
  ].join('\n'));
  const statePath = path.join(home, '.teamai', 'state.json');
  fs.writeFileSync(statePath, STATE_JSON);

  advanceOrigin(upstream, '.');
  commitLocally(checkout);
  return { home, cwd: home, checkout, statePath, checkoutMarker: markCheckouts(checkout) };
}

/** A single-repo (self mode) business checkout, diverged from origin. */
function setUpSelf(): Fixture {
  const sandbox = newSandbox();
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'origin.git');
  const upstream = path.join(sandbox, 'upstream');
  const checkout = path.join(sandbox, 'project');
  fs.mkdirSync(home, { recursive: true });

  git(['init', '-q', '--bare', '-b', 'main', remote], sandbox);
  const seed = path.join(upstream, '.teamai');
  fs.mkdirSync(seed, { recursive: true });
  writeTeamFiles(seed, ['mode: self']);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'config.yaml\nstate.json\nknowledge-wt/\n');
  fs.writeFileSync(path.join(upstream, 'app.txt'), 'business code\n');
  git(['init', '-q', '-b', 'main'], upstream);
  git(['add', '-A'], upstream);
  git(['commit', '-q', '-m', 'project'], upstream);
  git(['remote', 'add', 'origin', remote], upstream);
  git(['push', '-q', '-u', 'origin', 'main'], upstream);

  git(['clone', '-q', '-b', 'main', remote, checkout], sandbox);
  const knowledge = path.join(checkout, '.teamai');
  fs.writeFileSync(path.join(knowledge, 'config.yaml'), [
    'repo:',
    `  localPath: ${knowledge}`,
    `  remote: ${remote}`,
    '  kind: self',
    `  businessRepoRoot: ${checkout}`,
    'username: e2e',
    'updatePolicy: skip',
    'scope: project',
    `projectRoot: ${checkout}`,
    '',
  ].join('\n'));
  const statePath = path.join(knowledge, 'state.json');
  fs.writeFileSync(statePath, STATE_JSON);

  advanceOrigin(upstream, '.teamai');
  commitLocally(checkout);
  return { home, cwd: checkout, checkout, statePath, checkoutMarker: markCheckouts(checkout) };
}

async function dryRun(fixture: Fixture, args: string[]): Promise<RunResult> {
  const before = snapshot(fixture);
  const result = await runCLI([...args, '--dry-run'], fixture.cwd, fixture.home);
  expect(snapshot(fixture), result.output).toEqual(before);
  return result;
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  }
});

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe.each([
  ['a team-repo clone', setUpClone],
  ['single-repo mode', setUpSelf],
])('--dry-run on %s with unpushed commits (#900)', (_label, setUp) => {
  it('roles add keeps the local commits and previews against origin', async () => {
    const fixture = setUp();

    const added = await dryRun(fixture, ['roles', 'add', 'x', '--namespaces', 'x']);
    expect(added.code, added.output).toBe(0);
    expect(added.output).toContain('[dry-run] Would add role "x" with namespaces: x');

    // remote-role exists only on origin: the preview read origin, not the stale checkout.
    const taken = await dryRun(fixture, ['roles', 'add', 'remote-role', '--namespaces', 'y']);
    expect(taken.output).toContain('Role "remote-role" already exists');
  });

  it('roles update and remove preview against origin without writing', async () => {
    const fixture = setUp();

    const updated = await dryRun(fixture, ['roles', 'update', 'remote-role', '--add-namespaces', 'z']);
    expect(updated.code, updated.output).toBe(0);
    expect(updated.output).toContain('[dry-run] Would update role "remote-role"');

    const removed = await dryRun(fixture, ['roles', 'remove', 'remote-role']);
    expect(removed.code, removed.output).toBe(0);
    expect(removed.output).toContain('[dry-run] Would remove role "remote-role". Remaining: base');
  });

  it('projects add, update and remove preview without writing', async () => {
    const fixture = setUp();

    const added = await dryRun(fixture, ['projects', 'add', 'beta', '--namespaces', 'beta']);
    expect(added.code, added.output).toBe(0);
    expect(added.output).toContain('[dry-run] Would add project "beta"');

    const updated = await dryRun(fixture, ['projects', 'update', 'alpha', '--add-namespaces', 'more']);
    expect(updated.output).toContain('[dry-run] Would update project "alpha"');

    const removed = await dryRun(fixture, ['projects', 'remove', 'alpha']);
    expect(removed.output).toContain('[dry-run] Would remove project "alpha"');
  });

});

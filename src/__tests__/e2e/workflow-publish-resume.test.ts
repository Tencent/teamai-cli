/**
 * Real CLI: two members, each with their own HOME and install, share a team origin and a business origin. A run one
 * member publishes is continued by the other with `workflow resume`, which claims it from teamai-reports and fetches
 * its branches from the business origin; the first member then gets `not_owner` until it takes the run back.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORTS_LOCK_FILENAME } from '../../types.js';
import { acquireLock, releaseLock } from '../../update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const BUSINESS_URL = 'https://github.com/acme/business.git';

const SHIP = `schemaVersion: v1alpha1
name: ship
description: Edit the project in one copy.
steps:
  - id: change
    workspace: new
    workflow: edit
`;

// `more` holds, after writing, while the file HOLD_AT names exists: the member who started the run stops it there.
const EDIT = `schemaVersion: v1alpha1
name: edit
description: Two changes made one after another in one copy.
steps:
  - id: write
    workspace: continue
    command: node -e "require('fs').writeFileSync('write.txt', 'W')"
  - id: more
    needs: [write]
    workspace: continue
    command: node -e "const fs=require('fs'); fs.writeFileSync('more.txt', 'M'); const hold=process.env.HOLD_AT; if (hold && fs.existsSync(hold)) { fs.writeFileSync(hold + '.held', ''); setInterval(() => {}, 1000); }"
`;

const REVIEW = `schemaVersion: v1alpha1
name: review
description: Review the project twice in one session.
steps:
  - id: review
    prompt: Review this project.
    session: continue
    loop: { back_to: review, while: "length(steps.review.passes) < 2", max_iterations: 2 }
`;

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code: string; message: string } & Record<string, unknown>;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  envelope: () => Envelope;
}

let sandbox = '';
let teamOrigin = '';
let businessOrigin = '';

function homeOf(member: string): string {
  return path.join(sandbox, member);
}

function workOf(member: string): string {
  return path.join(homeOf(member), 'work');
}

function envOf(member: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeOf(member),
    USERPROFILE: homeOf(member),
    GIT_CONFIG_GLOBAL: path.join(homeOf(member), '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    FORCE_COLOR: '0',
    ...extra,
  };
  delete env.XDG_CONFIG_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return env;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function originGit(origin: string, ...args: string[]): string {
  return git(sandbox, ['--git-dir', origin, ...args]);
}

/** Runs the CLI as `member`; with `detached`, in a process group of its own, as a terminal's foreground job. */
function teamai(member: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean; started?: (pid: number) => void } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? workOf(member),
      env: envOf(member, options.env),
      detached: options.detached === true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) options.started?.(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout,
      stderr,
      envelope: () => {
        const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
        if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}\n${stderr}`);
        return JSON.parse(line) as Envelope;
      },
    }));
  });
}

function said(result: RunResult): string {
  return `exit ${result.code}\n${result.stdout}\n${result.stderr}`;
}

async function waitFor(file: string, ms: number): Promise<boolean> {
  for (let waited = 0; !fs.existsSync(file); waited += 100) {
    if (waited >= ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function publishedState(run: string): { status: string; stateRevision: number; owner: { id: string } } {
  return JSON.parse(originGit(teamOrigin, 'show', `teamai-reports:workflows/runs/${run}/state.json`)) as { status: string; stateRevision: number; owner: { id: string } };
}

function seed(dir: string, files: Record<string, string>, message: string, origin: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', message]);
  git(dir, ['push', '-q', origin, 'main']);
}

async function join(member: string): Promise<void> {
  const home = homeOf(member);
  fs.mkdirSync(home, { recursive: true });
  // init needs a forge URL; git maps it onto the bare origins, so nothing leaves the machine.
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', `\tname = ${member}`, `\temail = ${member}@example.com`,
    `[url "file://${teamOrigin}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${businessOrigin}"]`, `\tinsteadOf = ${BUSINESS_URL}`, '',
  ].join('\n'));
  git(sandbox, ['clone', '-q', BUSINESS_URL, workOf(member)], envOf(member));
  const init = await teamai(member, ['init', TEAM_URL, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force']);
  expect(init.code, said(init)).toBe(0);
  const pulled = await teamai(member, ['pull']);
  expect(pulled.code, said(pulled)).toBe(0);
}

describe('workflow publish and resume across members', () => {
  let shipRun = '';

  beforeAll(async () => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-handoff-e2e-')));
    teamOrigin = path.join(sandbox, 'team.git');
    businessOrigin = path.join(sandbox, 'business.git');
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', teamOrigin]);
    git(sandbox, ['init', '-q', '--bare', '-b', 'main', businessOrigin]);
    seed(path.join(sandbox, 'seed-team'), {
      'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\n`,
      'workflows/ship.yaml': SHIP,
      'workflows/edit.yaml': EDIT,
      'workflows/review.yaml': REVIEW,
    }, 'team repo', teamOrigin);
    seed(path.join(sandbox, 'seed-business'), { 'README.md': '# business\n' }, 'business repo', businessOrigin);
    // Both members join before anything is published, so nothing published reaches bob through a pull.
    await join('alice');
    await join('bob');
  }, 120_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('continues a run another member stopped mid-run and published, and finishes its copy on the business origin', async () => {
    const hold = path.join(sandbox, 'hold');
    fs.writeFileSync(hold, '');
    let pid = 0;
    const started = teamai('alice', ['workflow', 'start', 'ship', '--driver', 'local'], {
      env: { HOLD_AT: hold }, detached: true, started: (value) => { pid = value; },
    });
    expect(await waitFor(`${hold}.held`, 30_000), 'alice reached change.more').toBe(true);
    // Ctrl-C in a terminal: the foreground group, the driver and the command it runs, gets SIGINT.
    process.kill(-pid, 'SIGINT');
    const stopped = await started;
    expect(stopped.signal, said(stopped)).toBe('SIGINT');
    fs.rmSync(hold);
    expect(stopped.stdout, said(stopped)).toBe('');
    const printed = /Run (r[0-9a-f]{16}) started\. .*teamai workflow resume \1$/m.exec(stopped.stderr);
    expect(printed, said(stopped)).not.toBeNull();
    shipRun = printed?.[1] ?? '';
    expect(originGit(teamOrigin, 'ls-tree', '--name-only', 'teamai-reports', 'workflows/runs/').split('\n')).toEqual([`workflows/runs/${shipRun}.json`]);
    const copy = `teamai/${shipRun}/change/p1`;

    const published = await teamai('alice', ['workflow', 'publish', shipRun]);
    expect(published.code, said(published)).toBe(0);
    expect(published.envelope()).toEqual({ data: {
      run: shipRun, publication: 'published', stateRevision: 1,
      inFlight: [{ step: 'change.more', attempt: expect.any(String), driverKind: 'local' }],
    } });
    const alicesCommit = originGit(businessOrigin, 'rev-parse', copy);
    expect(originGit(businessOrigin, 'rev-parse', `teamai/${shipRun}/base`)).toBe(originGit(businessOrigin, 'rev-parse', 'main'));
    expect(originGit(businessOrigin, 'show', `${alicesCommit}:write.txt`)).toBe('W');
    expect(originGit(businessOrigin, 'ls-tree', '--name-only', alicesCommit).split('\n')).not.toContain('more.txt');

    const resumed = await teamai('bob', ['workflow', 'resume', shipRun]);
    expect(resumed.code, said(resumed)).toBe(0);
    expect(resumed.envelope()).toMatchObject({ data: { done: { run: shipRun, outcome: 'succeeded' } } });

    const tip = originGit(businessOrigin, 'rev-parse', copy);
    expect(originGit(businessOrigin, 'rev-parse', `${tip}^`), 'bob continued from the commit alice recorded').toBe(alicesCommit);
    expect(originGit(businessOrigin, 'show', `${tip}:write.txt`)).toBe('W');
    expect(originGit(businessOrigin, 'show', `${tip}:more.txt`)).toBe('M');
    expect(git(workOf('bob'), ['rev-parse', copy]), 'bob drove the copy in his own checkout').toBe(tip);

    expect(publishedState(shipRun), 'the run published how it ended').toMatchObject({ status: 'succeeded', stateRevision: 3 });
    const bobPublished = await teamai('bob', ['workflow', 'publish', shipRun]);
    expect(bobPublished.code, said(bobPublished)).toBe(0);
    expect(bobPublished.envelope()).toEqual({ data: { run: shipRun, publication: 'unchanged', stateRevision: 3, inFlight: [] } });
  }, 180_000);

  it('answers not_owner naming the member who took the run, until resume --claim takes it back', async () => {
    expect(shipRun, 'the handoff scenario ran').not.toBe('');
    const bobs = publishedState(shipRun).owner;

    const refused = await teamai('alice', ['workflow', 'publish', shipRun]);
    expect(refused.code, said(refused)).toBe(1);
    expect(refused.envelope()).toMatchObject({ error: { code: 'not_owner', owner: bobs } });

    const resumed = await teamai('alice', ['workflow', 'resume', shipRun]);
    expect(resumed.code, said(resumed)).toBe(1);
    expect(resumed.envelope()).toMatchObject({ error: { code: 'not_owner', owner: bobs } });
    expect(resumed.envelope().error?.message).toContain(`teamai workflow resume ${shipRun} --claim`);

    // The step alice stopped left its write in her copy's worktree. The run bob finished leases nothing, so taking it
    // back leaves that copy as it is.
    const copy = `teamai/${shipRun}/change/p1`;
    const worktrees = git(workOf('alice'), ['worktree', 'list', '--porcelain']).split('\n\n');
    const stale = worktrees.find((entry) => entry.includes(`branch refs/heads/${copy}`))?.match(/^worktree (.+)$/m)?.[1] ?? '';
    expect(stale, worktrees.join('\n\n')).not.toBe('');
    const left = { tip: git(workOf('alice'), ['rev-parse', copy]), status: git(stale, ['status', '--porcelain']) };
    expect(left.status).not.toBe('');

    const claimed = await teamai('alice', ['workflow', 'resume', shipRun, '--claim']);
    expect(claimed.code, said(claimed)).toBe(0);
    expect(claimed.envelope()).toMatchObject({ data: { done: { run: shipRun, outcome: 'succeeded' } } });
    expect(publishedState(shipRun).owner.id).not.toBe(bobs.id);
    expect({ tip: git(workOf('alice'), ['rev-parse', copy]), status: git(stale, ['status', '--porcelain']) }).toEqual(left);

    const published = await teamai('alice', ['workflow', 'publish', shipRun]);
    expect(published.code, said(published)).toBe(0);
    expect(published.envelope()).toMatchObject({ data: { run: shipRun, publication: 'unchanged', stateRevision: 4 } });

    const bobRefused = await teamai('bob', ['workflow', 'resume', shipRun]);
    expect(bobRefused.code, said(bobRefused)).toBe(1);
    expect(bobRefused.envelope()).toMatchObject({ error: { code: 'not_owner', owner: publishedState(shipRun).owner } });
  }, 120_000);

  it('adds no reports commit when a run is published again unchanged', async () => {
    const started = await teamai('alice', ['workflow', 'start', 'ship']);
    expect(started.code, said(started)).toBe(0);
    const run = String(started.envelope().data?.run);
    const first = await teamai('alice', ['workflow', 'publish', run]);
    expect(first.code, said(first)).toBe(0);
    expect(first.envelope()).toEqual({ data: { run, publication: 'published', stateRevision: 1, inFlight: [] } });
    const reports = originGit(teamOrigin, 'rev-parse', 'teamai-reports');
    expect(originGit(teamOrigin, 'log', '-1', '--format=%s', reports)).toBe(`[teamai] Publish workflow run ${run}`);

    const again = await teamai('alice', ['workflow', 'publish', run]);
    expect(again.code, said(again)).toBe(0);
    expect(again.envelope()).toEqual({ data: { run, publication: 'unchanged', stateRevision: 1, inFlight: [] } });
    expect(originGit(teamOrigin, 'rev-parse', 'teamai-reports')).toBe(reports);
  }, 120_000);

  it('pins a detached base on the business origin, and a shallow clone continues the run from it', async () => {
    const work = workOf('alice');
    fs.writeFileSync(path.join(work, 'ci.txt'), 'only in the CI checkout\n');
    git(work, ['add', 'ci.txt'], envOf('alice'));
    git(work, ['commit', '-qm', 'ci merge commit'], envOf('alice'));
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '-q', '--detach'], envOf('alice'));
    git(work, ['branch', '-q', '-f', 'main', 'origin/main'], envOf('alice'));
    try {
      const started = await teamai('alice', ['workflow', 'start', 'ship']);
      expect(started.code, said(started)).toBe(0);
      const run = String(started.envelope().data?.run);
      const published = await teamai('alice', ['workflow', 'publish', run]);
      expect(published.code, said(published)).toBe(0);
      expect(published.envelope()).toMatchObject({ data: { run, publication: 'published' } });
      expect(originGit(businessOrigin, 'rev-parse', `teamai/${run}/base`)).toBe(base);
      expect(originGit(businessOrigin, 'rev-parse', 'main')).not.toBe(base);

      const shallow = path.join(homeOf('bob'), 'shallow');
      git(sandbox, ['clone', '-q', '--depth', '1', BUSINESS_URL, shallow], envOf('bob'));
      expect(git(shallow, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      const resumed = await teamai('bob', ['workflow', 'resume', run], { cwd: shallow });
      expect(resumed.code, said(resumed)).toBe(0);
      expect(resumed.envelope()).toMatchObject({ data: { done: { run, outcome: 'succeeded' } } });
      const copy = `teamai/${run}/change/p1`;
      expect(originGit(businessOrigin, 'merge-base', '--is-ancestor', base, copy)).toBe('');
      expect(originGit(businessOrigin, 'show', `${copy}:ci.txt`)).toBe('only in the CI checkout');
      expect(originGit(businessOrigin, 'show', `${copy}:more.txt`)).toBe('M');
    } finally {
      git(work, ['checkout', '-q', 'main'], envOf('alice'));
    }
  }, 180_000);

  it('archives the session a step continues, scrubbed, and the member who resumes the run continues a copy of it', async () => {
    const work = workOf('alice');
    const token = 'ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5';
    const session = '11111111-2222-4333-8444-555555555555';
    const project = path.join(homeOf('alice'), '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(project, { recursive: true });
    const line = { isSidechain: false, sessionId: session, cwd: work, version: '2.1.0', userType: 'external' };
    fs.writeFileSync(path.join(project, `${session}.jsonl`), [
      { ...line, parentUuid: null, type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Review this project.' }] } },
      { ...line, parentUuid: 'u1', type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `Found two problems. The deploy token is ${token}.` }] } },
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');

    const started = await teamai('alice', ['workflow', 'start', 'review']);
    expect(started.code, said(started)).toBe(0);
    const run = String(started.envelope().data?.run);
    const driver = { kind: 'local', machine: 'alice-laptop', workspace: work };
    const next = await teamai('alice', ['workflow', 'next', run, '--json', JSON.stringify({ driver })]);
    const lease = next.envelope().data?.lease as { step: string; attempt: string; revision: number };
    expect(lease, said(next)).toMatchObject({ step: 'review' });
    const reported = await teamai('alice', ['workflow', 'report', run, '--json', JSON.stringify({
      attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver, tool: 'claude', session,
    })]);
    expect(reported.envelope(), said(reported)).toMatchObject({ data: { accepted: true } });

    // The session archive is on teamai-reports, with the run's published state: one lock, beside its checkout, holds both.
    const lock = path.join(homeOf('alice'), '.teamai', REPORTS_LOCK_FILENAME);
    const archivedOn = (branch: string) => originGit(teamOrigin, 'ls-tree', '-r', '--name-only', branch, 'sessions').split('\n').filter((file) => file.endsWith('.jsonl'));
    expect(await acquireLock(lock)).toBe(true);
    let blocked: RunResult;
    try {
      blocked = await teamai('alice', ['workflow', 'publish', run, '--sessions']);
    } finally {
      await releaseLock(lock);
    }
    expect(blocked.code, said(blocked)).toBe(1);
    expect(blocked.envelope(), said(blocked)).toMatchObject({
      error: { code: 'busy', message: 'Another teamai process is writing teamai-reports; try again.' },
    });
    expect(archivedOn('teamai-reports')).toEqual([]);

    const published = await teamai('alice', ['workflow', 'publish', run, '--sessions']);
    expect(published.code, said(published)).toBe(0);
    expect(published.envelope()).toMatchObject({ data: { run, publication: 'published', sessions: [{ tool: 'claude', id: session }] } });
    const archived = archivedOn('teamai-reports');
    expect(archived).toHaveLength(1);
    expect(archivedOn('main')).toEqual([]);
    const transcript = originGit(teamOrigin, 'show', `teamai-reports:${archived[0]}`);
    expect(transcript).toContain('Found two problems.');
    expect(transcript).not.toContain(token);
    expect(originGit(teamOrigin, 'show', `teamai-reports:workflows/runs/${run}/state.json`)).not.toContain('Found two problems.');

    // bob has used Claude Code here before, and his claude records how each run was started.
    const bobHome = homeOf('bob');
    fs.mkdirSync(path.join(bobHome, '.claude', 'projects'), { recursive: true });
    const bin = path.join(bobHome, 'bin');
    const calls = path.join(bobHome, 'claude-args.txt');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
      `printf '%s\\n' "$@" >> '${calls}'`,
      `echo '${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-4' })}'`,
      `echo '${JSON.stringify({ type: 'result', result: 'done' })}'`,
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    expect(fs.existsSync(path.join(bobHome, '.teamai', 'team-repo', 'sessions')), 'bob has not pulled since alice archived').toBe(false);

    const resumed = await teamai('bob', ['workflow', 'resume', run, '--tools', 'default=claude'], {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    expect(resumed.code, said(resumed)).toBe(0);
    expect(resumed.envelope()).toMatchObject({ data: { done: { run, outcome: 'succeeded' } } });
    const args = fs.readFileSync(calls, 'utf8').split('\n');
    const restored = args[args.indexOf('--resume') + 1];
    expect(args, said(resumed)).toContain('--resume');
    const copies = fs.readdirSync(path.join(bobHome, '.claude', 'projects'), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith(`${restored}.jsonl`));
    expect(copies).toHaveLength(1);
    const copy = fs.readFileSync(path.join(bobHome, '.claude', 'projects', copies[0] ?? ''), 'utf8');
    expect(copy).toContain('Review this project.');
    expect(copy).toContain('Found two problems.');
    expect(copy).not.toContain(token);
  }, 180_000);
});

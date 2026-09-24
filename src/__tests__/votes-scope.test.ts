/**
 * Votes stay with the scope they were cast in (#787): the real dispatcher,
 * report push, `recall feedback` and vote view, observed through the votes each
 * team's reports checkout receives in a sandbox HOME. Only the machine-level
 * handlers that reach the network or spawn processes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { LocalConfig, UserVotesV2 } from '../types.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(() => ({ on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn((_: string, done: () => void) => done()) }, unref: vi.fn() })),
}));
vi.mock('../pull.js', () => ({ pull: vi.fn(async () => undefined) }));
vi.mock('../update.js', () => ({ doUpdate: vi.fn(async () => undefined) }));
vi.mock('../local-agent.js', () => ({ reportAndSyncFromHook: vi.fn(async () => null) }));
// Each team's reports checkout sits beside its clone, where getReportsDir puts it;
// a write lands there instead of being pushed.
vi.mock('../utils/reports-branch.js', async () => {
  const nodePath = await import('node:path');
  const nodeFs = await import('node:fs');
  const checkout = (config: LocalConfig): string => {
    const dir = nodePath.join(nodePath.dirname(config.repo.localPath), 'reports-wt');
    nodeFs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    updateReports: vi.fn(async (config: LocalConfig, write: (wt: string) => Promise<unknown>) => (await write(checkout(config))) !== null),
    ensureReportsWorktree: vi.fn(async (config: LocalConfig) => checkout(config)),
  };
});

const { hookDispatchCli } = await import('../hook-dispatch-cli.js');
const { resolveProjectDataHome, saveLocalConfigForScope } = await import('../config.js');
const { reportUsageToTeam } = await import('../team-push.js');
const { recallFeedback } = await import('../votes.js');
const { resolveVizRoot } = await import('../viz.js');

let tmp: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-votes-scope-')));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const teamaiHome = () => path.join(tmp, 'home', '.teamai');

function userScope(): LocalConfig {
  const teamRepo = path.join(teamaiHome(), 'team-repo');
  fs.mkdirSync(teamRepo, { recursive: true });
  fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: user-team\nrepo: https://example.test/acme/user-team.git\n');
  const config: LocalConfig = {
    repo: { localPath: teamRepo, remote: 'https://example.test/acme/user-team.git' },
    username: 'tester', scope: 'user', additionalRoles: [],
  };
  fs.writeFileSync(path.join(teamaiHome(), 'config.yaml'), YAML.stringify(config));
  return config;
}

/** Project A, set up for the same member as the user scope. */
async function projectA(): Promise<{ root: string; dataHome: string; config: LocalConfig }> {
  const root = path.join(tmp, 'project-a');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataHome = await resolveProjectDataHome(root);
  const teamRepo = path.join(dataHome, 'team-repo');
  fs.mkdirSync(teamRepo, { recursive: true });
  fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: team-a\nrepo: https://example.test/acme/team-a.git\n');
  const config: LocalConfig = {
    repo: { localPath: teamRepo, remote: 'https://example.test/acme/team-a.git' },
    username: 'tester', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
  };
  await saveLocalConfigForScope(config);
  return { root, dataHome, config };
}

/** A project whose config cannot be read. */
async function brokenProject(): Promise<{ root: string; dataHome: string }> {
  const root = path.join(tmp, 'project-broken');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataHome = await resolveProjectDataHome(root);
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'config.yaml'), 'repo: [not: a, valid config\n');
  return { root, dataHome };
}

/** A directory no project claims: its sessions belong to the user scope. */
function outsideAnyProject(): string {
  const dir = path.join(tmp, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A Stop hook whose transcript declares `docId` recalled and used. */
async function stop(cwd: string, docId: string): Promise<void> {
  const transcript = path.join(tmp, `transcript-${docId}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{
    type: 'text',
    text: `<!-- teamai:recalled-doc-ids: [${docId}] --> <!-- teamai:referenced-doc-ids: [${docId}] -->`,
  }] } }) + '\n');
  for (const bgOnly of [false, true]) {
    const stdinFile = path.join(tmp, `stdin-${Date.now()}-${Math.random()}.json`);
    fs.writeFileSync(stdinFile, JSON.stringify({ session_id: `sid-${docId}`, cwd, hook_event_name: 'Stop', transcript_path: transcript }));
    await hookDispatchCli('stop', 'claude', '*', { bgOnly, stdinFile });
  }
}

async function feedbackIn(cwd: string, docId: string): Promise<void> {
  process.chdir(cwd);
  try {
    await recallFeedback({ positive: docId });
  } finally {
    process.chdir(originalCwd);
  }
}

/** A team's `votes/` on its reports checkout. */
const reportsVotesDir = (config: LocalConfig) => path.join(path.dirname(config.repo.localPath), 'reports-wt', 'votes');

/** Upvotes per doc in the member's file on a team's reports checkout. */
function teamVotes(config: LocalConfig): Record<string, number> {
  const file = path.join(reportsVotesDir(config), 'tester.yaml');
  if (!fs.existsSync(file)) return {};
  const parsed = YAML.parse(fs.readFileSync(file, 'utf-8')) as UserVotesV2;
  return Object.fromEntries(Object.entries(parsed.votes).map(([doc, entry]) => [doc, entry.upvoted_count]));
}

async function report(config: LocalConfig): Promise<void> {
  await reportUsageToTeam(config.repo.localPath, config.username, { skipTruncate: true, selfConfig: config });
}

/** What an earlier release leaves in the shared directory: a delta no scope may push. */
function sharedPendingVote(docId: string): void {
  const dir = path.join(teamaiHome(), 'votes');
  fs.mkdirSync(dir, { recursive: true });
  const votes: UserVotesV2 = {
    version: 2,
    votes: { [docId]: { recalled_count: 1, upvoted_count: 1, last_recalled_at: '2026-01-01T00:00:00.000Z' } },
    deltas: { [docId]: { recalled_delta: 1, upvoted_delta: 1 } },
  };
  fs.writeFileSync(path.join(dir, 'tester.yaml'), YAML.stringify(votes));
}

describe('votes stay with the scope they were cast in (#787)', () => {
  it('a vote cast in project A never reaches the user-scope team', async () => {
    const user = userScope();
    const a = await projectA();

    await feedbackIn(a.root, 'doc-a');
    await stop(outsideAnyProject(), 'doc-u');
    await report(user);
    await report(a.config);

    expect(teamVotes(user)).toEqual({ 'doc-u': 1 });
    expect(teamVotes(a.config)).toEqual({ 'doc-a': 1 });
  });

  it('a vote cast in the user scope never reaches project A\'s team', async () => {
    const user = userScope();
    const a = await projectA();

    await feedbackIn(outsideAnyProject(), 'doc-u');
    await stop(a.root, 'doc-a');
    await report(a.config);
    await report(user);

    expect(teamVotes(a.config)).toEqual({ 'doc-a': 1 });
    expect(teamVotes(user)).toEqual({ 'doc-u': 1 });
  });

  it('votes pending in the shared directory before the upgrade are pushed by no scope', async () => {
    const user = userScope();
    const a = await projectA();
    sharedPendingVote('doc-before-upgrade');

    await stop(a.root, 'doc-a');
    await stop(outsideAnyProject(), 'doc-u');
    await report(a.config);
    await report(user);

    expect(teamVotes(a.config)).toEqual({ 'doc-a': 1 });
    expect(teamVotes(user)).toEqual({ 'doc-u': 1 });
  });

  it('what an earlier release writes after a rollback is not pushed after re-upgrading', async () => {
    const user = userScope();
    const a = await projectA();
    await feedbackIn(a.root, 'doc-a');
    // Rolled back: the earlier release records into the shared directory again.
    sharedPendingVote('doc-during-rollback');

    await report(user);
    await report(a.config);

    expect(teamVotes(user)).toEqual({});
    expect(teamVotes(a.config)).toEqual({ 'doc-a': 1 });
  });

  it('recall feedback records into the votes of the scope of its cwd', async () => {
    userScope();
    const a = await projectA();

    await feedbackIn(a.root, 'doc-a');
    await feedbackIn(outsideAnyProject(), 'doc-u');

    const upvoted = (file: string) => Object.keys((YAML.parse(fs.readFileSync(file, 'utf-8')) as UserVotesV2).votes);
    expect(upvoted(path.join(a.dataHome, 'votes', 'tester.yaml'))).toEqual(['doc-a']);
    expect(upvoted(path.join(teamaiHome(), 'user-votes', 'tester.yaml'))).toEqual(['doc-u']);
    expect(fs.existsSync(path.join(teamaiHome(), 'votes'))).toBe(false);
  });

  it('recall feedback in a project whose config cannot be read records nothing, not even in the user scope', async () => {
    userScope();
    const { root, dataHome } = await brokenProject();

    await feedbackIn(root, 'doc-x');

    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(teamaiHome(), 'user-votes'))).toBe(false);
    expect(fs.existsSync(path.join(dataHome, 'votes'))).toBe(false);
  });

  it('the vote view reads the votes of the scope of its cwd', async () => {
    const user = userScope();
    const a = await projectA();

    process.chdir(a.root);
    expect((await resolveVizRoot({})).votesDir).toBe(reportsVotesDir(a.config));
    process.chdir(outsideAnyProject());
    expect((await resolveVizRoot({})).votesDir).toBe(reportsVotesDir(user));
  });

  it('the vote view in a project whose config cannot be read shows no other scope\'s votes and names the file', async () => {
    userScope();
    const { root, dataHome } = await brokenProject();

    process.chdir(root);

    await expect(resolveVizRoot({})).rejects.toThrow(`${path.join(dataHome, 'config.yaml')}`);
  });

  it('with no scope set up, the local vote view reads the user scope\'s own directory, not the shared one', async () => {
    process.chdir(outsideAnyProject());

    expect((await resolveVizRoot({})).votesDir).toBe(path.join(teamaiHome(), 'user-votes'));
  });
});

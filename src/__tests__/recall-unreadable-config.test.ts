/**
 * `teamai recall` in a project whose config cannot be read (#796): real config
 * files and a real search index in a sandbox HOME, so detection and search run
 * for real. What recall searches (stdout) and records (votes, recall quality)
 * is what these tests observe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
}));
vi.mock('../code-knowledge-recall.js', () => ({
  queryCodeKnowledge: vi.fn().mockResolvedValue([]),
}));

const { recall } = await import('../recall.js');
const { resolveProjectDataHome, saveLocalConfigForScope } = await import('../config.js');
const { readRecallQuality } = await import('../recall-quality.js');
const { log } = await import('../utils/logger.js');

const SESSION = 'recall-unreadable-session';
const QUERY = 'deployment timeout';

let tmp: string;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;
let stdout: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-unreadable-')));
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  vi.stubEnv('HOME', path.join(tmp, 'home'));
  vi.stubEnv('CLAUDE_SESSION_ID', SESSION);
  vi.stubEnv('TEAMAI_RECALL_DISABLED', '');
  fs.mkdirSync(path.join(tmp, 'home'));
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A team repo holding one doc that matches QUERY, titled after the team. */
function teamRepo(dir: string, team: string): string {
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), `team: ${team}\nrepo: https://example.test/acme/${team}.git\n`);
  fs.writeFileSync(path.join(dir, 'docs', `${team}-timeout.md`),
    `---\ntitle: "${team} deployment timeout fix"\nauthor: tester\ndate: 2026-05-01\ntags: [deployment, timeout]\n---\n\nRaise the deployment timeout.\n`);
  return dir;
}

function userScope(): string {
  const home = path.join(tmp, 'home', '.teamai');
  const repo = teamRepo(path.join(home, 'team-repo'), 'user-team');
  fs.writeFileSync(path.join(home, 'config.yaml'),
    `repo:\n  localPath: ${repo}\n  remote: https://example.test/acme/user-team.git\nusername: tester\nscope: user\n`);
  return repo;
}

function gitRepo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function brokenPartition(root: string): Promise<string> {
  const partition = await resolveProjectDataHome(root);
  fs.mkdirSync(partition, { recursive: true });
  const configPath = path.join(partition, 'config.yaml');
  fs.writeFileSync(configPath, 'repo: [not: a, valid config\n');
  return configPath;
}

function legacyOtherTeam(root: string): void {
  const legacy = path.join(root, '.teamai');
  const repo = teamRepo(path.join(legacy, 'team-repo'), 'other-team');
  fs.writeFileSync(path.join(legacy, 'config.yaml'),
    `repo:\n  localPath: ${repo}\n  remote: https://example.test/acme/other-team.git\nusername: tester\nscope: project\n`);
}

async function readableProject(root: string, inheritUserScope: boolean): Promise<void> {
  const dataHome = await resolveProjectDataHome(root);
  const repo = teamRepo(path.join(dataHome, 'team-repo'), 'team-a');
  await saveLocalConfigForScope({
    repo: { localPath: repo, remote: 'https://example.test/acme/team-a.git' },
    username: 'tester', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
    inheritUserScope,
  });
}

/** Everything recall records about a search: recalled counts (in any scope's
 *  votes directory, #787) and the quality signal. */
function recorded(): { votes: boolean; quality: boolean } {
  return {
    votes: fs.readdirSync(tmp, { recursive: true, encoding: 'utf8' }).some((entry) => ['votes', 'user-votes'].includes(path.basename(entry))),
    quality: readRecallQuality(SESSION) !== null,
  };
}

function errors(): string[] {
  return vi.mocked(log.error).mock.calls.map(([msg]) => String(msg));
}

describe('recall in a project whose config cannot be read (#796)', () => {
  it('searches nothing from a legacy .teamai/ of another team behind a broken partition, and says why', async () => {
    const root = gitRepo('project-a');
    const configPath = await brokenPartition(root);
    legacyOtherTeam(root);
    process.chdir(root);

    await recall(QUERY, {});

    expect(stdout).toBe('');
    expect(recorded()).toEqual({ votes: false, quality: false });
    expect(fs.existsSync(path.join(root, '.teamai', 'team-repo', 'votes'))).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].startsWith(`Nothing was searched: ${configPath}: `)).toBe(true);
    expect(errors()[0].endsWith('. Fix the file, or move it aside and run `teamai init` to write a new one.')).toBe(true);
    // A parse error's code frame spans several lines; only the first is printed.
    expect(errors()[0]).not.toContain('\n');
    expect(errors()[0]).not.toContain('teamai doctor');
  });

  it('does not search or record the user scope in its place', async () => {
    userScope();
    const root = gitRepo('project-a');
    await brokenPartition(root);
    process.chdir(root);

    await recall(QUERY, {});

    expect(stdout).toBe('');
    expect(recorded()).toEqual({ votes: false, quality: false });
    expect(process.exitCode).toBe(1);
  });

  it('--check refuses with the same message instead of a verdict', async () => {
    userScope();
    const root = gitRepo('project-a');
    const configPath = await brokenPartition(root);
    legacyOtherTeam(root);
    process.chdir(root);

    await recall(QUERY, { check: true });

    expect(stdout).toBe('');
    expect(process.exitCode).toBe(1);
    expect(errors()).toHaveLength(1);
    expect(errors()[0].startsWith(`Nothing was searched: ${configPath}: `)).toBe(true);
  });

  it('--check refuses even for an empty query, which would otherwise print NOT_RELEVANT', async () => {
    const root = gitRepo('project-a');
    await brokenPartition(root);
    process.chdir(root);

    await recall('', { check: true });

    expect(stdout).not.toContain('RELEVANT');
    expect(process.exitCode).toBe(1);
    expect(errors()).toEqual([expect.stringMatching(/^Nothing was searched: /)]);
  });

  it('a missing query is rejected before the project is resolved, as before', async () => {
    const root = gitRepo('project-a');
    await brokenPartition(root);
    process.chdir(root);

    await recall('', {});

    expect(vi.mocked(log.error).mock.calls.map(([msg]) => msg)).toEqual(['Usage: teamai recall <query>']);
  });

  it('searches and records the project scope of a readable project config, as before', async () => {
    userScope();
    const root = gitRepo('project-a');
    await readableProject(root, false);
    process.chdir(root);

    await recall(QUERY, {});

    expect(stdout).toContain('team-a deployment timeout fix');
    expect(stdout).not.toContain('user-team');
    expect(recorded()).toEqual({ votes: true, quality: true });
    expect(process.exitCode).toBe(originalExitCode);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('also searches the user scope when the project inherits it, as before', async () => {
    userScope();
    const root = gitRepo('project-a');
    await readableProject(root, true);
    process.chdir(root);

    await recall(QUERY, {});

    expect(stdout).toContain('team-a deployment timeout fix');
    expect(stdout).toContain('user-team deployment timeout fix');
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('searches the user scope where there is no project config, as before', async () => {
    userScope();
    process.chdir(gitRepo('project-b'));

    await recall(QUERY, {});

    expect(stdout).toContain('user-team deployment timeout fix');
    expect(recorded()).toEqual({ votes: true, quality: true });
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('with no config at all, says no learnings are available and exits 0, as before', async () => {
    process.chdir(gitRepo('project-b'));

    await recall(QUERY, {});

    expect(stdout).toBe('');
    expect(vi.mocked(log.info).mock.calls.map(([msg]) => msg)).toEqual([
      expect.stringMatching(/^No learnings available\./),
    ]);
    expect(process.exitCode).toBe(originalExitCode);
    expect(log.error).not.toHaveBeenCalled();
  });
});

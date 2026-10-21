import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autoPushTeamRepo, autoPushViaMR, checkoutMaster, createGit, pullRepo, pullRepoFastForward, pushRepoBranch, pushRepoDirectly, resetToCleanMaster } from '../utils/git.js';
import { LocalConfigSchema, type LocalConfig } from '../types.js';
import { loadLocalConfigForScope, saveLocalConfigForScope } from '../config.js';
import * as gitModule from '../utils/git.js';
import * as teamRef from '../team-ref.js';
import { getHandler } from '../resources/index.js';
import { TeamaiConfigSchema } from '../types.js';
import { resolveTeamRef, teamRefBlocker } from '../team-ref.js';

let root: string;
let clone: string;
let commit: string;
let unreachable: string;
const config = (overrides: Partial<LocalConfig> = {}): LocalConfig => LocalConfigSchema.parse({
  repo: { localPath: clone, remote: 'https://example.com/team.git' }, username: 'member', scope: 'project', ...overrides,
});

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-ref-unit-'));
  const seed = path.join(root, 'seed');
  clone = path.join(root, 'clone');
  await fs.mkdir(seed);
  const git = createGit(seed);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await fs.writeFile(path.join(seed, 'teamai.yaml'), 'team: test\n');
  await git.add('.');
  await git.commit('team');
  commit = (await git.revparse(['HEAD'])).trim();
  await git.branch(['trial']);
  await git.tag(['-a', 'v1', '-m', 'v1']);
  await git.checkout(['--orphan', 'teamai-reports']);
  await git.rm(['teamai.yaml']);
  await fs.writeFile(path.join(seed, 'report'), 'report');
  await git.add('.');
  await git.commit('report');
  await git.checkout('main');
  await git.checkoutLocalBranch('no-config');
  await git.rm(['teamai.yaml']);
  await git.commit('remove config');
  await git.checkout('main');
  await createGit(root).clone(seed, clone);
  const local = createGit(clone);
  await local.addConfig('user.name', 'Test');
  await local.addConfig('user.email', 'test@example.com');
  await local.checkoutLocalBranch('local-only');
  await fs.writeFile(path.join(clone, 'local'), 'local');
  await local.add('.');
  await local.commit('local only');
  unreachable = (await local.revparse(['HEAD'])).trim();
  await local.checkout('main');
});

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('team ref resolution', () => {
  it.each([
    ['trial', 'branch'], ['v1', 'tag'], ['short', 'commit'], ['full', 'commit'],
  ])('resolves %s to its commit', async (input, kind) => {
    const ref = input === 'short' ? commit.slice(0, 8) : input === 'full' ? commit : input;
    expect(await resolveTeamRef(clone, ref)).toEqual({ ref, kind, commit });
  });

  it.each(['unknown', 'origin/main', 'HEAD~1', 'local-only', 'teamai-reports', 'no-config', 'unreachable'])('rejects %s without moving HEAD', async (input) => {
    const ref = input === 'unreachable' ? unreachable : input;
    await expect(resolveTeamRef(clone, ref)).rejects.toMatchObject({ message: `Team ref "${ref}" is not a branch, tag or commit of the team repo that holds teamai.yaml. Branches: main, no-config, trial. Push it, or check the name.` });
    expect((await createGit(clone).revparse(['HEAD'])).trim()).toBe(commit);
  });

  it('resolves a full SHA-256 commit reachable from a team branch', async () => {
    const repo = path.join(root, 'sha256');
    await fs.mkdir(repo);
    const git = createGit(repo);
    await git.init(['-b', 'main', '--object-format=sha256']);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.com');
    await fs.writeFile(path.join(repo, 'teamai.yaml'), 'team: sha256\n');
    await git.add('.');
    await git.commit('Create team');
    const sha = (await git.revparse(['HEAD'])).trim();
    await git.raw(['update-ref', 'refs/remotes/origin/main', sha]);
    expect(sha).toHaveLength(64);
    expect(await resolveTeamRef(repo, sha)).toEqual({ ref: sha, kind: 'commit', commit: sha });
  });

  it.each(['teamai-reports', 'teamai-learnings'])('rejects a commit only reachable from %s even with teamai.yaml', async (branch) => {
    const repo = path.join(root, branch);
    await fs.mkdir(repo);
    const git = createGit(repo);
    await git.init(['-b', branch]);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.com');
    await fs.writeFile(path.join(repo, 'teamai.yaml'), 'team: report\n');
    await git.add('.');
    await git.commit('Create report');
    const sha = (await git.revparse(['HEAD'])).trim();
    await git.raw(['update-ref', `refs/remotes/origin/${branch}`, sha]);
    await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]);
    await expect(resolveTeamRef(repo, sha)).rejects.toBeInstanceOf(teamRef.TeamRefError);
  });

  it('prefers a remote branch over a tag of the same name', async () => {
    await createGit(clone).tag(['trial', unreachable]);
    expect((await resolveTeamRef(clone, 'trial')).kind).toBe('branch');
  });
});

it('round-trips repo.ref through workspace config load and save', async () => {
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await createGit(project).init(['-b', 'main']);
  const local = config({ projectRoot: project, repo: { localPath: clone, remote: 'https://example.com/team.git', ref: 'trial' } });
  await saveLocalConfigForScope(local);
  const loaded = await loadLocalConfigForScope('project', project);
  expect(loaded?.repo.ref).toBe('trial');
  await saveLocalConfigForScope(loaded!);
  expect((await loadLocalConfigForScope('project', project))?.repo.ref).toBe('trial');
});

describe('team ref scope boundary', () => {
  it('allows a standalone workspace', () => { expect(teamRefBlocker(config(), null)).toBeNull(); });
  it('requires a workspace', () => { expect(teamRefBlocker(null, null)?.message).toBe('--team-ref needs a teamai workspace here. Run teamai init --scope workspace here first.'); });
  it.each(['same-team', 'inherit'])('refuses user scope through %s', (kind) => {
    expect(teamRefBlocker(config({ inheritUserScope: kind === 'inherit' }), kind === 'same-team' ? config({ scope: 'user' }) : null)?.message)
      .toBe('--team-ref pins one workspace, but this team also reaches it through user scope, where every workspace shares one copy. Remove the user-scope install, or turn off inheritUserScope, to pin a workspace.');
  });
  it('refuses self mode', () => { expect(teamRefBlocker(config({ repo: { localPath: clone, remote: '.', kind: 'self' } }), null)?.message).toBe("--team-ref does not apply in single-repo mode: the project's own commit decides which team assets it has."); });
  it('refuses HTTP', () => { expect(teamRefBlocker(config({ repo: { localPath: clone, remote: 'https://example.com', kind: 'http' } }), null)?.message).toBe('--team-ref needs a git team repo. This team is served over HTTP.'); });
});

it('compares deployed skill names across namespace moves', async () => {
  const git = createGit(clone);
  await fs.mkdir(path.join(clone, 'skills/base'), { recursive: true });
  await fs.writeFile(path.join(clone, 'skills/base/SKILL.md'), 'base');
  await git.add('.'); await git.commit('flat skill');
  const previous = (await git.revparse(['HEAD'])).trim();
  await fs.mkdir(path.join(clone, 'skills/fe'), { recursive: true });
  await fs.rename(path.join(clone, 'skills/base'), path.join(clone, 'skills/fe/base'));
  await git.add('.'); await git.commit('move skill');
  try {
    expect((await teamRef.removedTeamResources(clone, previous, 'HEAD')).skills).toEqual(new Set());
  } finally { await git.reset(['--hard', commit]); }
});

it('returns an explicit clone transition without mutating the config', async () => {
  const local = config();
  const before = structuredClone(local);
  expect(await teamRef.transitionTeamRepo(local, { teamRef: 'trial' })).toMatchObject({ transition: 'pinned', ref: 'trial', label: 'team ref "trial"' });
  expect(local).toEqual(before);
  expect(await teamRef.transitionTeamRepo(local, { teamRef: 'main' })).toMatchObject({ transition: 'unpinned' });
});

it('previews the current clone without switching or mutating its config', async () => {
  const local = config();
  const before = structuredClone(local);
  expect(await teamRef.transitionTeamRepo(local, { teamRef: 'trial', dryRun: true })).toMatchObject({ transition: 'none' });
  expect(local).toEqual(before);
  expect((await createGit(clone).revparse(['HEAD'])).trim()).toBe(commit);
  expect((await createGit(clone).raw(['symbolic-ref', '-q', 'HEAD'])).trim()).toBe('refs/heads/main');
});

it('propagates a git transport failure while resolving a commit', async () => {
  const git = createGit(clone);
  const raw = git.raw.bind(git);
  vi.spyOn(git, 'raw').mockImplementation((...args: Parameters<typeof git.raw>) => {
    if (Array.isArray(args[0]) && args[0][0] === 'branch') throw new Error('spawn git EAGAIN');
    return raw(...args);
  });
  vi.spyOn(gitModule, 'createGit').mockReturnValue(git);
  try { await expect(resolveTeamRef(clone, commit)).rejects.toThrow('spawn git EAGAIN'); }
  finally { vi.restoreAllMocks(); }
});

it('does not apply the detached-team guard inside another repository', async () => {
  const nested = path.join(clone, 'nested');
  await fs.mkdir(nested);
  const git = createGit(clone);
  await git.checkout(['--detach', commit]);
  try {
    await expect(pullRepo(nested)).rejects.toThrow('You are not currently on a branch.');
    await expect(pullRepoFastForward(nested)).rejects.toThrow('You are not currently on a branch.');
  } finally { await git.checkout('main'); }
});

it('names a fixed commit and its real default branch in write refusal advice', async () => {
  const git = createGit(clone);
  await git.checkout(['--detach', commit]);
  try {
    await expect(pullRepo(clone)).rejects.toThrow('The team repo is checked out at a fixed commit (a team ref pin, or an interrupted switch), so this command cannot change it. Run teamai pull --team-ref main to follow the default branch again.');
  } finally { await git.checkout('main'); }
});

describe('unborn team clone compatibility', () => {
  async function unborn(name: string) {
    const remote = path.join(root, `${name}.git`);
    const localPath = path.join(root, name);
    await createGit(root).raw(['init', '--bare', '-b', 'main', remote]);
    await createGit(root).clone(remote, localPath);
    const git = createGit(localPath);
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 'test@example.com');
    return { remote, localPath, git };
  }

  it.each([false, true])('rejects a missing pin on an unborn clone with populated remote=%s', async (populated) => {
    const { remote, localPath, git } = await unborn(`unborn-ref-${populated}`);
    if (populated) await createGit(path.join(root, 'seed')).push([remote, 'main']);
    await expect(teamRef.transitionTeamRepo(config({ repo: { localPath, remote } }), { teamRef: 'missing' }))
      .rejects.toBeInstanceOf(teamRef.TeamRefError);
    expect((await git.raw(['symbolic-ref', '-q', 'HEAD'])).trim()).toBe('refs/heads/main');
  });

  it('pins the first remote commit from an unborn clone', async () => {
    const { remote, localPath, git } = await unborn('unborn-pin');
    await createGit(path.join(root, 'seed')).push([remote, 'main:trial']);
    await expect(teamRef.transitionTeamRepo(config({ repo: { localPath, remote } }), { teamRef: 'trial' }))
      .resolves.toMatchObject({ transition: 'pinned', ref: 'trial' });
    expect((await git.revparse(['HEAD'])).trim()).toBe(commit);
  });

  it('pulls the first remote commit into an unborn branch', async () => {
    const { remote, localPath, git } = await unborn('unborn-pull');
    await createGit(path.join(root, 'seed')).push([remote, 'main']);
    await expect(pullRepo(localPath)).resolves.toBe('already up to date');
    expect((await git.revparse(['HEAD'])).trim()).toBe(commit);
  });

  it('checks out the default branch from an unborn branch', async () => {
    const { remote, localPath, git } = await unborn('unborn-checkout');
    await createGit(path.join(root, 'seed')).push([remote, 'main']);
    await git.fetch();
    await expect(checkoutMaster(localPath)).resolves.toBeUndefined();
    expect((await git.revparse(['HEAD'])).trim()).toBe(commit);
  });

  it('pushes a first commit from an unborn branch', async () => {
    const { localPath, git } = await unborn('unborn-push');
    await fs.writeFile(path.join(localPath, 'teamai.yaml'), 'team: first\n');
    await expect(pushRepoBranch(localPath, 'Create team', ['teamai.yaml'], 'first-team')).resolves.toBe(true);
    expect(await git.show(['origin/first-team:teamai.yaml'])).toBe('team: first\n');
  });

  it('keeps the existing reset failure on an unborn branch', async () => {
    const { localPath, git } = await unborn('unborn-reset');
    await expect(resetToCleanMaster(git, localPath)).rejects.toThrow("ambiguous argument 'HEAD'");
    expect((await git.raw(['symbolic-ref', '-q', 'HEAD'])).trim()).toBe('refs/heads/main');
  });
});

it('pullRepo refuses a detached HEAD without resetting it or discarding changes', async () => {
  const git = createGit(clone);
  await git.checkout(['--detach', commit]);
  await fs.writeFile(path.join(clone, 'teamai.yaml'), 'member edit\n');
  await expect(pullRepo(clone)).rejects.toMatchObject({ name: 'DetachedTeamRepoError' });
  for (const write of [
    () => pullRepoFastForward(clone),
    () => resetToCleanMaster(git, clone),
    () => checkoutMaster(clone),
    () => pushRepoBranch(clone, 'change', ['teamai.yaml'], 'write-attempt'),
    () => pushRepoDirectly(clone, 'change', ['teamai.yaml']),
  ]) await expect(write()).rejects.toMatchObject({ name: 'DetachedTeamRepoError' });
  await expect(autoPushViaMR(clone, 'change', ['teamai.yaml'], { repo: 'https://example.com/team.git' }, config())).rejects.toBeInstanceOf(gitModule.DetachedTeamRepoError);
  await expect(autoPushTeamRepo(clone, 'change')).rejects.toBeInstanceOf(gitModule.DetachedTeamRepoError);
  expect((await git.revparse(['HEAD'])).trim()).toBe(commit);
  expect(await fs.readFile(path.join(clone, 'teamai.yaml'), 'utf8')).toBe('member edit\n');
});

it('resetToCleanMaster sweeps an untracked leftover that blocks the switch back to the default branch', async () => {
  const remote = path.join(root, 'untracked-block.git');
  const seed = path.join(root, 'untracked-seed');
  const localPath = path.join(root, 'untracked-block');
  await fs.mkdir(path.join(seed, 'votes'), { recursive: true });
  await createGit(root).raw(['init', '--bare', '-b', 'main', remote]);
  const seedGit = createGit(seed);
  await seedGit.init(['-b', 'main']);
  await seedGit.addConfig('user.name', 'Test');
  await seedGit.addConfig('user.email', 'test@example.com');
  await fs.writeFile(path.join(seed, 'teamai.yaml'), 'team: test\n');
  await fs.writeFile(path.join(seed, 'votes', 'stray.yaml'), 'upstream\n');
  await seedGit.add('.');
  await seedGit.commit('team');
  await seedGit.push([remote, 'main']);
  await createGit(root).clone(remote, localPath);
  const local = createGit(localPath);
  await local.addConfig('user.name', 'Test');
  await local.addConfig('user.email', 'test@example.com');
  // A crashed push left the clone on a stale push branch whose tree lacks
  // votes/stray.yaml; a later crashed run left that path behind untracked.
  await local.checkoutLocalBranch('teamai/push/member/20260411-225746');
  await local.raw(['rm', '-rf', '.']);
  await local.commit('empty push branch');
  await fs.mkdir(path.join(localPath, 'votes'), { recursive: true });
  await fs.writeFile(path.join(localPath, 'votes', 'stray.yaml'), 'stray\n');

  await expect(resetToCleanMaster(local, localPath)).resolves.toBeUndefined();
  expect((await local.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
  expect(await fs.readFile(path.join(localPath, 'votes', 'stray.yaml'), 'utf8')).toBe('upstream\n');
});

it('matches removal names to handler names for flat and namespaced resources', async () => {
  const repo = path.join(root, 'resource-names');
  await fs.mkdir(repo);
  const git = createGit(repo);
  await git.init(['-b', 'main']);
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'test@example.com');
  await fs.writeFile(path.join(repo, 'teamai.yaml'), 'team: names\n');
  await git.add('.');
  await git.commit('empty team');
  const empty = (await git.revparse(['HEAD'])).trim();
  for (const file of ['skills/flat/SKILL.md', 'skills/fe/scoped/SKILL.md', 'rules/flat.md', 'rules/fe/scoped.md', 'agents/flat.yaml', 'agents/fe/scoped.md']) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), 'fixture\n');
  }
  await git.add('.');
  await git.commit('resource names');
  const removed = await teamRef.removedTeamResources(repo, 'HEAD', empty);
  const local = config({ repo: { localPath: repo, remote: 'https://example.com/names.git' } });
  const team = TeamaiConfigSchema.parse({ team: 'names', repo: local.repo.remote });
  for (const type of ['skills', 'rules', 'agents'] as const) {
    const items = await getHandler(type).scanTeamForPull(team, local);
    expect(items).toHaveLength(2);
    expect(removed[type]).toEqual(new Set(items.map((item) => item.name)));
  }
});

it('reports a detached-clone refusal when upgrading a wiki', async () => {
  const upgrade = await import('../codebase-upgrade-wiki.js');
  const { codebaseCmd } = await import('../codebase-cmd.js');
  const { log } = await import('../utils/logger.js');
  const refusal = new gitModule.DetachedTeamRepoError('main');
  vi.spyOn(upgrade, 'upgradeCodebaseWiki').mockRejectedValueOnce(refusal);
  const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
  const previousExit = process.exitCode;
  try {
    await expect(codebaseCmd({ upgradeWiki: true })).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(refusal.message);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previousExit;
    vi.restoreAllMocks();
  }
});


it('propagates a detached-clone refusal before a wiki upgrade writes', async () => {
  const importer = await import('../import-repo.js');
  const { upgradeCodebaseWiki } = await import('../codebase-upgrade-wiki.js');
  const cwd = path.join(root, 'legacy-upgrade');
  const docs = path.join(cwd, 'docs/team-codebase/repos');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'app.md'), '---\nsource: https://example.com/team/app.git\n---\nLegacy wiki\n');
  const refusal = new gitModule.DetachedTeamRepoError('main');
  const importSpy = vi.spyOn(importer, 'importFromRepo').mockRejectedValueOnce(refusal);
  try {
    await expect(upgradeCodebaseWiki({ cwd })).rejects.toBe(refusal);
  } finally {
    importSpy.mockRestore();
  }
});

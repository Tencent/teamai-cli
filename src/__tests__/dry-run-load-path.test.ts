import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A dry run may parse the remote, but any other provider call can prompt, open
// a browser, store credentials or reach the network. Record and refuse them all.
const providerCalls = vi.hoisted((): string[] => []);
vi.mock('../providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/index.js')>()),
  getProvider: vi.fn(() => new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'name') return 'github';
      if (prop === 'parseRepoInput') return () => ({ httpsUrl: 'https://github.com/acme/app.git' });
      if (prop === 'then') return undefined;
      return () => {
        providerCalls.push(String(prop));
        throw new Error(`provider.${String(prop)}() called under --dry-run`);
      };
    },
  })),
}));

// Member registration pushes to the reports branch; a dry run must never reach it.
vi.mock('../utils/reports-branch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/reports-branch.js')>()),
  updateReports: vi.fn(),
}));

import { contribute } from '../contribute.js';
import { loadLocalConfigForScope } from '../config.js';
import { pull } from '../pull.js';
import { push } from '../push.js';
import { recall } from '../recall.js';
import { rolesSet } from '../roles-cmd.js';
import { list, status } from '../status.js';
import { tagsSubscribe, tagsUnsubscribe } from '../tags.js';
import { updateReports } from '../utils/reports-branch.js';
import { log } from '../utils/logger.js';
import { legacyProjectSlug } from '../utils/partition.js';

const ROLES_YAML =
  'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [hai] }\n' +
  '  - id: pm\n    resources: { knowledge: [], skills: [pm] }\n';

/**
 * `git init` with git's background upkeep off. A commit starts a detached `git maintenance
 * run --auto`, which holds .git/objects/maintenance.lock while the test snapshots the tree.
 */
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: dir, stdio: 'ignore' });
}

/** A teammate's fresh clone of a single-repo project: the marker travels, no machine config does. */
function setupSelfModeClone(root: string): string {
  const project = path.join(root, 'app');
  fs.mkdirSync(path.join(project, '.teamai', 'manifest'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.teamai', 'teamai.yaml'),
    'team: demo\nrepo: https://github.com/acme/app.git\nprovider: github\nmode: self\n',
  );
  fs.writeFileSync(path.join(project, '.teamai', 'manifest', 'roles.yaml'), ROLES_YAML);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: project, stdio: 'ignore' });
  gitInit(project);
  git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return project;
}

/** A role-less user config next to a roles manifest, which the load migrates to `hai`. */
function setupLegacyRoleConfig(root: string): string {
  const home = path.join(root, 'home');
  const repoDir = path.join(root, 'team-repo');
  fs.mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'teamai.yaml'), 'team: demo\nrepo: owner/repo\nprovider: github\n');
  fs.writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), ROLES_YAML);
  fs.writeFileSync(
    path.join(home, '.teamai', 'config.yaml'),
    `repo:\n  localPath: ${repoDir}\n  remote: owner/repo\nusername: dev\nsubscribedTags:\n  - frontend\n`,
  );
  fs.writeFileSync(path.join(home, '.teamai', 'state.json'), '{"lastPull":null,"lastPullRev":"abc1234"}\n');
  // Outside any git repo, so no project config is detected.
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  return cwd;
}

/** A project install whose partition still carries its pre-#546 name, which detection renames. */
function setupLegacyNamedPartition(root: string): string {
  const project = path.join(root, 'app');
  fs.mkdirSync(project);
  gitInit(project);
  const partition = path.join(root, 'home', '.teamai', 'projects', legacyProjectSlug(fs.realpathSync(project)));
  const repoDir = path.join(partition, 'team-repo');
  fs.mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'teamai.yaml'), 'team: demo\nrepo: owner/repo\nprovider: github\n');
  fs.writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), ROLES_YAML);
  fs.writeFileSync(
    path.join(partition, 'config.yaml'),
    `repo:\n  localPath: ${repoDir}\n  remote: owner/repo\nusername: dev\nscope: project\n` +
      `projectRoot: ${project}\nprimaryRole: hai\nsubscribedTags:\n  - frontend\n`,
  );
  return project;
}

function isGitTransientLock(rel: string): boolean {
  const name = path.basename(rel);
  return rel.split(path.sep).includes('.git') && (name.endsWith('.lock') || name === 'gc.pid');
}

/** Every file under root (HOME, the project and its .git, state.json) mapped to a content hash. */
function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      // Diagnostics, not state: log.debug appends here on every run.
      if (rel.startsWith(path.join('home', '.teamai', 'debug.log'))) continue;
      // Git's own transient locks, in case some git process still runs in the background.
      // Only these: a real write to .git (config, hooks, refs) must still fail the test.
      if (isGitTransientLock(rel)) continue;
      if (entry.isDirectory()) {
        files[`${rel}/`] = 'dir';
        walk(full);
      } else {
        const bytes = entry.isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full);
        files[rel] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  };
  walk(root);
  return files;
}

const FIXTURES: Array<[string, (root: string) => string]> = [
  ['a fresh self-mode clone', setupSelfModeClone],
  ['a config pending the legacy role migration', setupLegacyRoleConfig],
  ['a partition with its pre-#546 name', setupLegacyNamedPartition],
];

const COMMANDS: Array<[string, () => Promise<void>]> = [
  ['tags subscribe', () => tagsSubscribe(['testing'], { dryRun: true })],
  ['tags unsubscribe', () => tagsUnsubscribe(['frontend'], { dryRun: true })],
  ['roles set', () => rolesSet('pm', { dryRun: true })],
];

describe.each(FIXTURES)('--dry-run on %s', (_fixture, setup) => {
  const originalCwd = process.cwd();
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-load-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    // An installed agent, so a bootstrap that did run would seed and wire it.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    vi.stubEnv('HOME', home);
    cwd = setup(root);
    process.chdir(cwd);
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateReports).mockClear();
    providerCalls.length = 0;
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(COMMANDS)('%s writes no file, registers no member and makes no provider call', async (_command, run) => {
    const before = snapshotTree(root);
    const error = await run().then(() => null, (e: unknown) => e);
    expect(providerCalls).toEqual([]);
    expect(error).toBeNull();
    expect(snapshotTree(root)).toEqual(before);
    expect(updateReports).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Would'));
  });
});

describe('--dry-run through the loaders the commands share (#850)', () => {
  const originalCwd = process.cwd();
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function legacyRoot(): { root: string; configPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-loader-'));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    vi.stubEnv('HOME', home);
    process.chdir(setupLegacyRoleConfig(root));
    return { root, configPath: path.join(home, '.teamai', 'config.yaml') };
  }

  it('recall --dry-run writes no file: the user scope loads through the flag (#850)', async () => {
    const { root } = legacyRoot();
    const before = snapshotTree(root);
    await recall('dry run probe', { dryRun: true });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('contribute --scope user --dry-run writes no file on a config pending the role migration (#850)', async () => {
    const { root } = legacyRoot();
    // In the tree before the snapshot, so the run itself adds nothing.
    const file = path.join(process.cwd(), 'note.md');
    fs.writeFileSync(file, 'Learned: a dry run must not migrate the teamai config.\n');
    const before = snapshotTree(root);
    await contribute({ file, scope: 'user', dryRun: true });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('the loader previews the legacy role migration under --dry-run and writes nothing (#850)', async () => {
    const { configPath } = legacyRoot();
    const loaded = await loadLocalConfigForScope('user', undefined, { dryRun: true });
    expect(loaded?.primaryRole).toBe('hai');
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('primaryRole');
  });

  it('the loader still migrates in place when the caller passes nothing, as before (#850)', async () => {
    const { configPath } = legacyRoot();
    const loaded = await loadLocalConfigForScope('user');
    expect(loaded?.primaryRole).toBe('hai');
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('primaryRole: hai');
  });

  // The command-level half of #850. Each of these reaches the legacy role
  // migration through a loader it used to call bare, so the fixture's
  // `config.yaml` gained `primaryRole` even though nothing had asked to write.
  // `pull`/`push` carry `--dry-run`; `status`/`list` are read-only and pass it
  // unconditionally (see the note at their `autoDetectInit` call site).
  //
  // The positive control is the test directly above: the SAME fixture does gain
  // `primaryRole` when the flag is absent, so an unchanged tree here is a real
  // result and not the harness failing to look.
  const LOAD_ONLY_COMMANDS: Array<[string, () => Promise<void>]> = [
    ['pull --dry-run', () => pull({ dryRun: true })],
    ['push --dry-run', () => push({ dryRun: true })],
    ['status', () => status({})],
    ['list', () => list(undefined, {})],
  ];

  it.each(LOAD_ONLY_COMMANDS)('%s migrates nothing it loads (#850)', async (_command, run) => {
    const { root, configPath } = legacyRoot();
    const before = snapshotTree(root);
    const error = await run().then(() => null, (e: unknown) => e);
    expect(error).toBeNull();
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('primaryRole');
    // A dry run may parse the remote, but nothing else may reach a provider.
    expect(providerCalls).toEqual([]);
  });

  /** A git project whose partition still carries its pre-#546 name, i.e. project scope. */
  function projectRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-project-'));
    roots.push(root);
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    // An installed agent, so a bootstrap that did run would seed and wire it.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    vi.stubEnv('HOME', home);
    process.chdir(setupLegacyNamedPartition(root));
    return root;
  }

  // The project-scope half. These reach the same bare calls through
  // `detectProjectConfig`, whose dry-run branch is what stops
  // `adoptLegacyPartition` (a real `fs.rename`) and the self-heal bootstrap.
  // The issue report located these by code path only; they are run here.
  const PROJECT_SCOPE_COMMANDS: Array<[string, () => Promise<void>]> = [
    ['pull --dry-run', () => pull({ dryRun: true })],
    ['status', () => status({})],
    ['list', () => list(undefined, {})],
  ];

  it.each(PROJECT_SCOPE_COMMANDS)('%s adopts no legacy partition on a git project (#850)', async (_command, run) => {
    const root = projectRoot();
    const before = snapshotTree(root);
    const error = await run().then(() => null, (e: unknown) => e);
    expect(error).toBeNull();
    expect(snapshotTree(root)).toEqual(before);
    expect(providerCalls).toEqual([]);
  });
});

// The self-mode half of #866. `pull` and `push` are the two commands that take a
// partition sync-lock, and every fixture above runs them at user scope, or on a
// project partition that already exists. A fresh self-mode clone is the one
// shape where the partition does NOT exist yet — so `acquireLock` creating the
// lock's parent directory creates a directory that nothing removes afterwards.
// `push` carries a second instance of the same mistake: its self-mode setup
// (lock, `.teamai/.gitignore` self-heal, knowledge worktree) all runs before
// `pushCore` reaches its own dry-run guard.
describe('--dry-run on a fresh self-mode clone (#866)', () => {
  const originalCwd = process.cwd();
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dry-run-self-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    // An installed agent, so a bootstrap that did run would seed and wire it.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    vi.stubEnv('HOME', home);
    process.chdir(setupSelfModeClone(root));
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(updateReports).mockClear();
    providerCalls.length = 0;
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Each command declares exactly which new entries it may leave behind. Both
  // start empty: the point of #866 is that a preview writes nothing.
  //
  // `pull` is allowed one, and it is not this change's. `pull` counts the
  // contribution queue so it can report how many learnings it would publish, and
  // `publishQueuedLearnings` lists it through `listPendingForInstall`
  // (`utils/pending-learnings.ts`), which holds the queue lock — `acquireLock`
  // creates the lock's parent, so an install with no `<getTeamaiHome>/locks/`
  // gets one and keeps it. That call is unchanged here, and identical on the
  // base commit; it only became reachable on a fresh self-mode clone once
  // detection stopped aborting first (#850). Declared and counted rather than
  // filtered out, so any OTHER new entry still fails this test.
  const PULL_LOCK_DIR = `${path.join('home', '.teamai', 'locks')}/`;
  // `git fetch` — which the preview performs on purpose, so that its plan is
  // based on the same `origin/<default>` the real push would branch from —
  // leaves its own one-line record behind. It names no ref, changes no working
  // tree, and git overwrites it on the next fetch. Same treatment as the entry
  // above: declared and counted, so any other new entry still fails this test.
  const FETCH_HEAD = path.join('app', '.git', 'FETCH_HEAD');
  const SELF_COMMANDS: Array<[string, () => Promise<void>, string[]]> = [
    ['pull --dry-run', () => pull({ dryRun: true }), [PULL_LOCK_DIR]],
    ['push --dry-run', () => push({ dryRun: true }), [FETCH_HEAD]],
  ];

  it.each(SELF_COMMANDS)('%s creates no partition, worktree or lock file', async (_command, run, allowed) => {
    // The reported symptom, named so a failure here reads as #866 rather than
    // as an anonymous tree diff: taking the sync-lock used to create this
    // directory, and releasing it removed the lock file but not the directory.
    const partitionRoot = path.join(root, 'home', '.teamai', 'projects');
    expect(fs.existsSync(partitionRoot)).toBe(false);
    const before = snapshotTree(root);
    const error = await run().then(() => null, (e: unknown) => e);
    expect(error).toBeNull();
    expect(fs.existsSync(partitionRoot)).toBe(false);

    const after = snapshotTree(root);
    const appeared = Object.keys(after).filter((key) => !(key in before));
    const vanished = Object.keys(before).filter((key) => !(key in after));
    expect({ appeared, vanished }).toEqual({ appeared: allowed, vanished: [] });
    // Nothing that already existed may be rewritten, whatever it is.
    for (const key of Object.keys(before)) expect(after[key]).toBe(before[key]);
    // A dry run may parse the remote, but nothing else may reach a provider.
    expect(providerCalls).toEqual([]);
  });
});

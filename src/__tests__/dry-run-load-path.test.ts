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

import { codebaseCmd } from '../codebase-cmd.js';
import { contribute } from '../contribute.js';
import { generateDigest } from '../digest.js';
import { loadLocalConfigForScope } from '../config.js';
import { envList, envUnset } from '../env-commands.js';
import { envExec } from '../env-exec.js';
import { resolveDoctorContext } from '../doctor.js';
import { excludeList } from '../exclude.js';
import { hooksList } from '../hooks-cmd.js';
import { importCmd } from '../import.js';
import { mcpInject, mcpList } from '../mcp-cmd.js';
import { maybeMigrate, queueKeptInCheckout } from '../migrate.js';
import { modelsList, modelsSwitch } from '../models-cmd.js';
import { pkgInstall } from '../pkg/commands.js';
import { listMembers } from '../members.js';
import { projectsAdd, projectsList, projectsMembers, projectsRemove, projectsUpdate } from '../projects-cmd.js';
import { pull } from '../pull.js';
import { push } from '../push.js';
import { recall } from '../recall.js';
import { recallStatus } from '../recall-toggle.js';
import { remove } from '../remove.js';
import { rolesAdd, rolesInit, rolesList, rolesRemove, rolesSet, rolesUpdate } from '../roles-cmd.js';
import { skillList, skillShow } from '../skill-cmd.js';
import { skillGet, skillPath } from '../skill-content.js';
import { sourceAdd, sourceAddHttp, sourceBrowse, sourceList, sourceRemove } from '../source.js';
import { list, status } from '../status.js';
import { tagsAdd, tagsList, tagsRemove, tagsSubscribe, tagsUnsubscribe } from '../tags.js';
import { uninstall } from '../uninstall.js';
import { listWebhooks } from '../webhook.js';
import { updateReports } from '../utils/reports-branch.js';
import { log, setStderrOnly } from '../utils/logger.js';
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
  const partition = path.join(root, 'home', '.teamai', 'projects', legacyProjectSlug(fs.realpathSync.native(project)));
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

/** `env exec` sends the logger to stderr for the rest of the process; put it back for the next case. */
async function envExecDryRun(): Promise<void> {
  try {
    await envExec(['--', 'true'], { dryRun: true });
  } finally {
    setStderrOnly(false);
  }
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
    process.exitCode = undefined;
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
  // `pull`/`push` carry `--dry-run`; `status`/`list`/`env list` are read-only
  // and pass it unconditionally (see the note at their `autoDetectInit` call site).
  //
  // The positive control is the test directly above: the SAME fixture does gain
  // `primaryRole` when the flag is absent, so an unchanged tree here is a real
  // result and not the harness failing to look.
  const LOAD_ONLY_COMMANDS: Array<[string, () => Promise<void>]> = [
    ['pull --dry-run', () => pull({ dryRun: true })],
    ['push --dry-run', () => push({ dryRun: true })],
    ['status', () => status({})],
    ['list', () => list(undefined, {})],
    ['env list', () => envList({})],
    ['env unset --dry-run', () => envUnset('TOKEN', { dryRun: true })],
    ['env exec --dry-run', envExecDryRun],
    ['mcp inject --dry-run', () => mcpInject({ dryRun: true })],
    ['mcp list', () => mcpList({})],
    ['roles list', () => rolesList()],
    ['projects list', () => projectsList({})],
    ['tags list', () => tagsList()],
    ['source list', () => sourceList()],
    ['hooks list', () => hooksList({})],
    ['exclude list', () => excludeList({})],
    ['recall status', () => recallStatus({})],
    ['doctor (its loader)', async () => { await resolveDoctorContext(); }],
    ['skill get share', () => skillGet(['share'])],
    ['skill path share', () => skillPath('share')],
    ['models list', () => modelsList()],
    ['codebase --status', () => codebaseCmd({ status: true })],
    ['uninstall --dry-run', () => uninstall({ dryRun: true, force: true })],
    ['packages install --dry-run', () => pkgInstall(undefined, { dryRun: true })],
    ['source browse', () => sourceBrowse('x', {})],
    ['codebase --lint', () => codebaseCmd({ lint: true })],
    ['skill list', () => skillList({})],
    ['skill show', () => skillShow('core', {})],
    ['webhook list', async () => { await listWebhooks(); }],
    ['digest', () => generateDigest()],
  ];

  // The loader logs this line when it previews the migration, so it proves the
  // row reached the load: an early return would leave the file unchanged too.
  const PREVIEWED = expect.stringContaining('[dry-run] Would migrate legacy teamai config');

  it.each(LOAD_ONLY_COMMANDS)('%s migrates nothing it loads (#850)', async (_command, run) => {
    const { root, configPath } = legacyRoot();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const before = snapshotTree(root);
    const error = await run().then(() => null, (e: unknown) => e);
    expect(error).toBeNull();
    expect(info).toHaveBeenCalledWith(PREVIEWED);
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('primaryRole');
    // A dry run may parse the remote, but nothing else may reach a provider.
    expect(providerCalls).toEqual([]);
  });

  // The rest of #893: commands that honour `--dry-run` in their own logic but
  // loaded the scope bare. Each one reaches the loader before anything this
  // fixture lacks (a team repo remote, a provider, a network) stops it, so the
  // test asserts only what the loader decides: whether `config.yaml` is
  // rewritten. The same call without the flag is the positive control: it DOES
  // migrate, so an unchanged file under the flag is a result, not a command that
  // failed before it loaded anything. Writes these commands make on their own
  // dry-run path, past the loader, are out of scope here.
  const PREVIEWS: Array<[string, (dryRun: boolean) => Promise<unknown>]> = [
    ['mcp inject', (dryRun) => mcpInject({ dryRun })],
    ['roles init', (dryRun) => rolesInit({ dryRun })],
    ['roles add', (dryRun) => rolesAdd('ops', { dryRun, namespaces: 'ops' })],
    ['roles remove', (dryRun) => rolesRemove('pm', { dryRun })],
    ['roles update', (dryRun) => rolesUpdate('pm', { dryRun, description: 'x' })],
    ['projects add', (dryRun) => projectsAdd('checkout', { dryRun, namespaces: 'checkout' })],
    ['tags add', (dryRun) => tagsAdd('skills', 'x', ['a'], { dryRun })],
    ['tags remove', (dryRun) => tagsRemove('skills', 'x', ['a'], { dryRun })],
    ['source add', (dryRun) => sourceAdd('https://github.com/acme/other.git', { dryRun })],
    ['source remove', (dryRun) => sourceRemove('x', { dryRun })],
    ['source add-http', (dryRun) => sourceAddHttp('https://h.test', { dryRun, token: 't' })],
    ['remove', (dryRun) => remove('skills', ['x'], { dryRun })],
    ['packages install', (dryRun) => pkgInstall(undefined, { dryRun })],
    ['import --from-iwiki', (dryRun) => importCmd({ fromIwiki: 'x', dryRun })],
    ['import --from-mr', (dryRun) => importCmd({ fromMr: 'https://github.com/acme/app/pull/1', dryRun })],
    ['codebase --reconcile', (dryRun) => codebaseCmd({ reconcile: true, dryRun })],
    ['projects update', (dryRun) => projectsUpdate('checkout', { dryRun, description: 'x' })],
    ['projects remove', (dryRun) => projectsRemove('checkout', { dryRun })],
    // No candidates on this fixture: covers the scan's load, not the one after review.
    ['import --from-claude', (dryRun) => importCmd({ fromClaude: true, all: true, dryRun })],
    ['codebase --deep-enrich', (dryRun) => codebaseCmd({ deepEnrich: true, project: 'x', dryRun })],
    ['models switch', (dryRun) => modelsSwitch('p', { dryRun })],
  ];

  describe.each(PREVIEWS)('%s', (_command, run) => {
    beforeEach(() => {
      // Past the loader these commands may exit or set an exit code; neither is under test.
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${String(code)})`);
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      process.exitCode = undefined;
      // `source add` reaches the provider's clone after the load; not what this asserts.
      providerCalls.length = 0;
    });

    it('--dry-run leaves a config pending the role migration as it was (#893)', async () => {
      const { configPath } = legacyRoot();
      const info = vi.spyOn(log, 'info').mockImplementation(() => {});
      const before = fs.readFileSync(configPath, 'utf-8');
      await run(true).catch(() => {});
      expect(info).toHaveBeenCalledWith(PREVIEWED);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });

    it('without the flag, the same call migrates it, so the load is on this path', async () => {
      const { configPath } = legacyRoot();
      await run(false).catch(() => {});
      expect(fs.readFileSync(configPath, 'utf-8')).toContain('primaryRole: hai');
    });
  });

  // Read-only commands that, past the load, fail on this fixture: there is no
  // reports branch to read members from. Only the load is asserted.
  const READ_ONLY_PAST_THE_LOAD: Array<[string, () => Promise<unknown>]> = [
    ['members', () => listMembers({})],
    ['projects members', () => projectsMembers('checkout', {})],
  ];

  it.each(READ_ONLY_PAST_THE_LOAD)('%s migrates nothing it loads (#893)', async (_command, run) => {
    const { configPath } = legacyRoot();
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = fs.readFileSync(configPath, 'utf-8');
    await run().catch(() => {});
    providerCalls.length = 0;
    expect(info).toHaveBeenCalledWith(PREVIEWED);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
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
    ['env list', () => envList({})],
    ['env exec --dry-run', envExecDryRun],
    // What the CLI's preAction hook runs before a command under --dry-run:
    // `maybeMigrate` before every write command (`pull`, `push`, ...), and
    // `queueKeptInCheckout` before one that queues a learning. Calling
    // `pull()` directly, as the rows above do, skips both.
    ['the pre-command migration under --dry-run', async () => {
      await queueKeptInCheckout(await maybeMigrate({ dryRun: true }), { dryRun: true });
    }],
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

  // Each command declares exactly which new entries it may leave behind, and
  // both are empty: a preview writes nothing at all.
  //
  // `pull` used to be allowed one — the empty `<getTeamaiHome>/locks/` its queue
  // listing created. `pull` counts the contribution queue so it can report how
  // many learnings it would publish, and `publishQueuedLearnings` lists it
  // through `listPendingForInstall` (`utils/pending-learnings.ts`), which holds
  // the queue lock. Taking that lock is a write: `acquireLock` creates the
  // lock's parent, and `releaseLock` removes the lock file but not the
  // directory. `dryRun` now reaches that `acquireLock` as it already reached the
  // partition locks in `pull` and `push` (#866), so the preview creates neither
  // and this list is empty.
  const FETCH_HEAD = path.join('app', '.git', 'FETCH_HEAD');
  // `git fetch` — which the preview performs on purpose, so that its plan is
  // based on the same `origin/<default>` the real push would branch from —
  // leaves its own one-line record behind. It names no ref, changes no working
  // tree, and git overwrites it on the next fetch. Declared and counted, so any
  // other new entry still fails this test.
  const SELF_COMMANDS: Array<[string, () => Promise<void>, string[]]> = [
    ['pull --dry-run', () => pull({ dryRun: true }), []],
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

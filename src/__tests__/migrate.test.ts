import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import { planMigration, runMigration, maybeMigrate } from '../migrate.js';
import { projectDataHome } from '../utils/partition.js';

// ─── Real-git migration tests (issue #374 P1-3) ─────────────────────────────
//
// A legacy install kept machine data in `<repo>/.teamai/`, including a real git
// team-repo clone. Migration copies it into the partition, verifies, atomically
// renames, and retires the source to `.teamai.bak/`. These tests build a REAL
// legacy layout (real anchors + a real nested git clone) rather than an empty
// fixture, so the load-bearing details — anchor resolution, `.git` survival,
// atomicity — are genuinely exercised.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

let base: string;
let repoRoot: string;
let homeDir: string;
let legacyDir: string;

/** Write a minimal but schema-valid legacy project config into legacyDir. */
async function writeLegacyConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  const cfg = {
    repo: {
      localPath: path.join(legacyDir, 'team-repo'),
      remote: 'git@example.com:team/repo.git',
      kind: 'git',
    },
    username: 'tester',
    scope: 'project',
    ...overrides,
  };
  await fse.ensureDir(legacyDir);
  await fse.writeFile(path.join(legacyDir, 'config.yaml'), YAML.stringify(cfg));
}

/** Build a real, non-empty legacy `.teamai/` with a genuine git team-repo clone. */
async function seedLegacyLayout(): Promise<void> {
  await writeLegacyConfig();
  await fse.writeJson(path.join(legacyDir, 'state.json'), { lastSync: 'x' });
  await fse.writeFile(path.join(legacyDir, 'env'), 'TEAM_TOKEN=s3cret\n');
  await fse.writeJson(path.join(legacyDir, 'search-index.json'), { docs: [] });

  // A real git clone under team-repo/ — the `.git` dir is what the copyDir filter
  // would silently drop, so the test must assert it survives.
  const teamRepo = path.join(legacyDir, 'team-repo');
  await fse.ensureDir(teamRepo);
  git(teamRepo, 'init', '-q');
  git(teamRepo, 'config', 'user.email', 'test@example.com');
  git(teamRepo, 'config', 'user.name', 'Test');
  await fse.writeFile(path.join(teamRepo, 'README'), 'team\n');
  git(teamRepo, 'add', '.');
  git(teamRepo, 'commit', '-q', '-m', 'seed');

  // A per-worktree managed-mcp subtree (P1-2C layout).
  const wsDir = path.join(legacyDir, 'workspaces', 'abc123def456');
  await fse.ensureDir(wsDir);
  await fse.writeJson(path.join(wsDir, 'managed-mcp.json'), { 'claude:project': {} });
}

beforeEach(() => {
  base = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-migrate-')));
  repoRoot = path.join(base, 'business-repo');
  fs.mkdirSync(repoRoot);
  git(repoRoot, 'init', '-q');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'commit', '--allow-empty', '-q', '-m', 'init');

  homeDir = path.join(base, 'home');
  fs.mkdirSync(homeDir);
  legacyDir = path.join(repoRoot, '.teamai');

  vi.stubEnv('HOME', homeDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('planMigration', () => {
  it('plans a migration for a legacy git-mode project install', async () => {
    await seedLegacyLayout();
    const plan = await planMigration(repoRoot);
    expect(plan).not.toBeNull();
    expect(plan!.legacyDir).toBe(legacyDir);
    expect(plan!.partitionDir).toBe(projectDataHome(repoRoot));
    expect(plan!.anchor).toBe(repoRoot);
  });

  it('skips when no legacy config.yaml exists', async () => {
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('plans a retire-only cleanup when a partition exists but legacy lingers', async () => {
    // Interrupted prior run: partition built, source never retired. Instead of
    // skipping (which would leave the legacy dir — incl. plaintext env — forever),
    // planMigration must return a retire-only plan to finish the cleanup.
    await seedLegacyLayout();
    const partition = projectDataHome(repoRoot);
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(partition, 'config.yaml'), 'repo: {}\n');
    const plan = await planMigration(repoRoot);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('retire-only');
  });

  it('adopts a pre-#546 legacy-NAMED partition before planning (retire-only, not a re-copy)', async () => {
    // A partition built by a teamai older than the #546 naming widening carries
    // the legacy <basename>-<hash> name. planMigration must adopt (rename) it
    // FIRST — otherwise it would see "no partition" and plan a FULL re-copy of
    // the legacy dir onto a second, empty partition.
    await seedLegacyLayout();
    const { legacyProjectSlug } = await import('../utils/partition.js');
    const legacyNamed = path.join(homeDir, '.teamai', 'projects', legacyProjectSlug(repoRoot));
    await fse.ensureDir(legacyNamed);
    await fse.writeFile(path.join(legacyNamed, 'config.yaml'), 'repo: {}\n');

    const plan = await planMigration(repoRoot);

    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('retire-only');
    expect(plan!.partitionDir).toBe(projectDataHome(repoRoot));
    // Adopted: the data now lives under the current-format slug.
    expect(fse.existsSync(path.join(projectDataHome(repoRoot), 'config.yaml'))).toBe(true);
    expect(fse.existsSync(legacyNamed)).toBe(false);
  });

  it('skips a user-scope legacy config', async () => {
    await writeLegacyConfig({ scope: 'user' });
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('plans a self-mode migration when legacy A1 machine data is in the repo (P2)', async () => {
    // config.yaml is class-A1, so a self install with it still in <repo>/.teamai
    // must be planned for selective relocation (not skipped like pre-P2).
    await writeLegacyConfig({ repo: { localPath: legacyDir, remote: '', kind: 'self' } });
    const plan = await planMigration(repoRoot);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('self');
  });

  it('skips a self-mode config with no A1 machine data left in the repo (P2)', async () => {
    // A self install whose machine data already lives in the partition leaves only
    // class-B knowledge (here: teamai.yaml) in the repo — nothing to relocate.
    await fse.ensureDir(legacyDir);
    await fse.writeFile(path.join(legacyDir, 'teamai.yaml'), 'team: t\nmode: self\n');
    // Its config now lives in the partition, so there is no legacy config.yaml.
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('skips outside a git repository', async () => {
    const plain = path.join(base, 'plain');
    fs.mkdirSync(plain);
    await fse.ensureDir(path.join(plain, '.teamai'));
    await fse.writeFile(
      path.join(plain, '.teamai', 'config.yaml'),
      YAML.stringify({ repo: { localPath: '', remote: '', kind: 'git' }, username: 'x', scope: 'project' }),
    );
    expect(await planMigration(plain)).toBeNull();
  });

  it('skips a malformed legacy config rather than throwing', async () => {
    await fse.ensureDir(legacyDir);
    await fse.writeFile(path.join(legacyDir, 'config.yaml'), ':::not yaml:::\n');
    expect(await planMigration(repoRoot)).toBeNull();
  });
});

describe('runMigration', () => {
  it('migrates into the partition, keeps the git clone intact, and retires the source', async () => {
    await seedLegacyLayout();
    const plan = await planMigration(repoRoot);
    const result = await runMigration(plan!);
    expect(result).toBe('migrated');

    const partition = projectDataHome(repoRoot);
    // Machine data landed in the partition.
    expect(await fse.pathExists(path.join(partition, 'config.yaml'))).toBe(true);
    expect(await fse.pathExists(path.join(partition, 'state.json'))).toBe(true);
    expect(await fse.pathExists(path.join(partition, 'search-index.json'))).toBe(true);
    expect(await fse.pathExists(path.join(partition, 'workspaces', 'abc123def456', 'managed-mcp.json'))).toBe(true);
    // The anchor reverse-lookup file was written.
    expect((await fse.readFile(path.join(partition, 'anchor'), 'utf-8')).trim()).toBe(repoRoot);

    // team-repo/.git SURVIVED — the clone is still a working repo (proves raw
    // fse.copy was used, not the .git-filtering copyDir).
    const migratedRepo = path.join(partition, 'team-repo');
    expect(await fse.pathExists(path.join(migratedRepo, '.git'))).toBe(true);
    expect(() => git(migratedRepo, 'status')).not.toThrow();
    expect(() => git(migratedRepo, 'rev-parse', 'HEAD')).not.toThrow();

    // Source retired to .bak, original gone → workspace zero-residue.
    expect(await fse.pathExists(legacyDir)).toBe(false);
    expect(await fse.pathExists(`${legacyDir}.bak`)).toBe(true);
    expect(await fse.pathExists(path.join(`${legacyDir}.bak`, 'config.yaml'))).toBe(true);
  });

  it('rebases repo.localPath from the legacy dir onto the partition', async () => {
    await seedLegacyLayout();
    const plan = await planMigration(repoRoot);
    await runMigration(plan!);
    // The migrated config must name the team-repo INSIDE the partition, not the
    // now-retired legacy path — otherwise the next pull reads the wrong clone.
    const partition = projectDataHome(repoRoot);
    const migrated = YAML.parse(
      await fse.readFile(path.join(partition, 'config.yaml'), 'utf-8'),
    );
    expect(migrated.repo.localPath).toBe(path.join(partition, 'team-repo'));
    expect(migrated.repo.localPath).not.toContain('.teamai/team-repo');
  });

  it('leaves a localPath that is not inside the legacy dir untouched', async () => {
    // e.g. an install whose team-repo clone lives elsewhere entirely.
    const external = path.join(base, 'external-clone');
    await writeLegacyConfig({
      repo: { localPath: external, remote: 'git@example.com:t/r.git', kind: 'git' },
    });
    const plan = await planMigration(repoRoot);
    await runMigration(plan!);
    const migrated = YAML.parse(
      await fse.readFile(path.join(projectDataHome(repoRoot), 'config.yaml'), 'utf-8'),
    );
    expect(migrated.repo.localPath).toBe(external);
  });

  it('does not carry a live sync-lock into the backup', async () => {
    await seedLegacyLayout();
    const plan = await planMigration(repoRoot);
    await runMigration(plan!);
    // The lock lived in legacyDir and must be released before the .bak rename,
    // so neither the partition nor the backup keeps a stale lock.
    expect(await fse.pathExists(path.join(`${legacyDir}.bak`, '.sync-lock'))).toBe(false);
    expect(await fse.pathExists(path.join(projectDataHome(repoRoot), '.sync-lock'))).toBe(false);
  });

  it('does not copy disposable worktrees or lock files', async () => {
    await seedLegacyLayout();
    await fse.ensureDir(path.join(legacyDir, 'reports-wt'));
    await fse.writeFile(path.join(legacyDir, 'reports-wt', 'x'), 'stale\n');
    await fse.writeFile(path.join(legacyDir, '.update-lock'), '{}');
    const plan = await planMigration(repoRoot);
    await runMigration(plan!);
    const partition = projectDataHome(repoRoot);
    expect(await fse.pathExists(path.join(partition, 'reports-wt'))).toBe(false);
    expect(await fse.pathExists(path.join(partition, '.update-lock'))).toBe(false);
  });

  it('is idempotent: a second run stands down once the partition exists', async () => {
    await seedLegacyLayout();
    await runMigration((await planMigration(repoRoot))!);
    // Legacy is now .bak; planMigration returns null (nothing to migrate).
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('retire-only mode retires a leftover legacy dir without re-copying (finishes an interrupted run)', async () => {
    // Simulate a crash between the partition rename and the source retire: the
    // partition is already built AND the legacy dir still lingers.
    await seedLegacyLayout();
    const partition = projectDataHome(repoRoot);
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(partition, 'config.yaml'), 'repo:\n  kind: git\n');
    await fse.writeFile(path.join(partition, 'sentinel'), 'authoritative\n');

    const plan = await planMigration(repoRoot);
    expect(plan!.mode).toBe('retire-only');
    const result = await runMigration(plan!);
    expect(result).toBe('migrated');
    // Legacy retired → workspace zero-residue (the plaintext env no longer lingers).
    expect(await fse.pathExists(legacyDir)).toBe(false);
    expect(await fse.pathExists(`${legacyDir}.bak`)).toBe(true);
    // The authoritative partition was NOT overwritten by a re-copy.
    expect(await fse.pathExists(path.join(partition, 'sentinel'))).toBe(true);
    // A follow-up plan is now null — the workspace is clean.
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('aborts without touching the source when the staged clone is corrupt', async () => {
    // A team-repo whose .git is present but not a real repo → verify's rev-parse
    // smoke-check must fail, leaving the source intact and no partition/.bak.
    await writeLegacyConfig();
    await fse.writeJson(path.join(legacyDir, 'state.json'), {});
    const tr = path.join(legacyDir, 'team-repo');
    await fse.ensureDir(path.join(tr, '.git')); // a .git dir that is NOT a valid repo
    await fse.writeFile(path.join(tr, 'README'), 'x\n');

    const plan = await planMigration(repoRoot);
    await expect(runMigration(plan!)).rejects.toThrow(/not a usable git repository/);
    // Source untouched; nothing half-migrated.
    expect(await fse.pathExists(path.join(legacyDir, 'config.yaml'))).toBe(true);
    expect(await fse.pathExists(`${legacyDir}.bak`)).toBe(false);
    expect(await fse.pathExists(projectDataHome(repoRoot))).toBe(false);
    expect(await fse.pathExists(`${projectDataHome(repoRoot)}.staging`)).toBe(false);
  });

  it('never overwrites an existing .teamai.bak — picks a fresh name instead (no data loss)', async () => {
    await seedLegacyLayout();
    // The user (or a prior migration) already has a .teamai.bak with data.
    const existingBak = `${legacyDir}.bak`;
    await fse.ensureDir(existingBak);
    await fse.writeFile(path.join(existingBak, 'only-copy.txt'), 'irreplaceable');

    await runMigration((await planMigration(repoRoot))!);

    // The pre-existing backup is untouched...
    expect(await fse.readFile(path.join(existingBak, 'only-copy.txt'), 'utf-8')).toBe('irreplaceable');
    // ...and the migration's own backup went to a fresh name.
    expect(await fse.pathExists(path.join(`${legacyDir}.bak.1`, 'config.yaml'))).toBe(true);
  });

  it('keeps the retired backup git-ignored so a `git add -A` cannot leak its secrets', async () => {
    // Precondition that makes this dangerous: the legacy .teamai is protected
    // ONLY by a repo-root `.gitignore` rule for `.teamai/`, which does not match
    // `.teamai.bak/`. Without an in-dir .gitignore the rename would expose the
    // plaintext env/token to the next commit.
    await fse.writeFile(path.join(repoRoot, '.gitignore'), '.teamai/\n');
    await seedLegacyLayout();
    await fse.writeFile(path.join(legacyDir, 'token'), 'api-key-xyz\n');
    // sanity: env IS ignored pre-migration
    expect(gitOut(repoRoot, 'status', '--porcelain', '--ignored')).toContain('.teamai/');

    await runMigration((await planMigration(repoRoot))!);

    git(repoRoot, 'add', '-A');
    const staged = gitOut(repoRoot, 'diff', '--cached', '--name-only');
    expect(staged.split('\n').filter((l) => l.includes('.teamai.bak'))).toHaveLength(0);
    // The secrets are unreadable via git but still on disk (rollback intact).
    expect(() => git(repoRoot, 'show', ':.teamai.bak/env')).toThrow();
    expect(() => git(repoRoot, 'show', ':.teamai.bak/token')).toThrow();
    expect(await fse.pathExists(path.join(`${legacyDir}.bak`, 'env'))).toBe(true);
  });

  it('migrates an http-mode install (no team-repo clone)', async () => {
    await writeLegacyConfig({
      repo: { localPath: legacyDir, remote: 'https://team.example/api', kind: 'http', url: 'https://team.example/api' },
    });
    await fse.writeFile(path.join(legacyDir, 'token'), 'api-key-xyz\n');
    await fse.writeJson(path.join(legacyDir, 'state.json'), {});

    const plan = await planMigration(repoRoot);
    expect(plan!.mode).toBe('full');
    const result = await runMigration(plan!);
    expect(result).toBe('migrated');
    const partition = projectDataHome(repoRoot);
    expect(await fse.pathExists(path.join(partition, 'config.yaml'))).toBe(true);
    expect(await fse.pathExists(path.join(partition, 'token'))).toBe(true);
    expect(await fse.pathExists(legacyDir)).toBe(false);
  });

  it('recovers from a leftover staging dir (interrupted prior run)', async () => {
    await seedLegacyLayout();
    const partition = projectDataHome(repoRoot);
    const staging = `${partition}.staging`;
    // Simulate a crash mid-copy: a partial staging dir is left behind.
    await fse.ensureDir(staging);
    await fse.writeFile(path.join(staging, 'garbage'), 'partial\n');
    const result = await runMigration((await planMigration(repoRoot))!);
    expect(result).toBe('migrated');
    // Stale staging content was discarded, not merged.
    expect(await fse.pathExists(path.join(partition, 'garbage'))).toBe(false);
    expect(await fse.pathExists(path.join(partition, 'config.yaml'))).toBe(true);
  });

  it('dry-run writes nothing', async () => {
    await seedLegacyLayout();
    const plan = await planMigration(repoRoot);
    const result = await runMigration(plan!, { dryRun: true });
    expect(result).toBe('dry-run');
    const partition = projectDataHome(repoRoot);
    expect(await fse.pathExists(partition)).toBe(false);
    // Source untouched.
    expect(await fse.pathExists(legacyDir)).toBe(true);
    expect(await fse.pathExists(`${legacyDir}.bak`)).toBe(false);
  });
});

describe('self mode migration (P2)', () => {
  /** Build a real self-mode `.teamai/`: class-B knowledge + class-A1 machine data. */
  async function seedSelfLayout(): Promise<void> {
    await fse.ensureDir(legacyDir);
    // config.yaml (A1) — kind: self
    await fse.writeFile(
      path.join(legacyDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: legacyDir, remote: 'git@example.com:t/r.git', kind: 'self', businessRepoRoot: repoRoot },
        username: 'tester',
        scope: 'project',
      }),
    );
    // A1 machine data
    await fse.writeJson(path.join(legacyDir, 'state.json'), { lastSync: 'x' });
    await fse.writeFile(path.join(legacyDir, 'env.local'), 'SECRET=xyz\n');
    await fse.writeFile(path.join(legacyDir, 'env.sh'), 'export SECRET=xyz\n');
    await fse.writeJson(path.join(legacyDir, 'search-index.json'), { docs: [] });
    await fse.ensureDir(path.join(legacyDir, 'workspaces', 'ws1'));
    await fse.writeJson(path.join(legacyDir, 'workspaces', 'ws1', 'managed-mcp.json'), {});
    // class-B knowledge (committed to main — must stay)
    for (const d of ['skills', 'rules', 'docs', 'learnings', 'agents', 'hooks', 'mcp']) {
      await fse.ensureDir(path.join(legacyDir, d));
      await fse.writeFile(path.join(legacyDir, d, '.gitkeep'), '');
    }
    await fse.ensureDir(path.join(legacyDir, 'env'));
    await fse.writeFile(path.join(legacyDir, 'env', 'env.yaml'), 'SHARED: value\n');
    await fse.writeFile(path.join(legacyDir, 'teamai.yaml'), 'team: t\nmode: self\n');
    await fse.writeFile(path.join(legacyDir, 'skills', 'team-skill.md'), '# team\n');
    // a disposable worktree dir (must stay — anchors on the repo)
    await fse.ensureDir(path.join(legacyDir, 'reports-wt'));
    await fse.writeFile(path.join(legacyDir, 'reports-wt', 'x'), 'wt\n');
  }

  it('relocates A1 machine data to the partition and leaves class-B knowledge in the repo', async () => {
    await seedSelfLayout();
    const plan = await planMigration(repoRoot);
    expect(plan!.mode).toBe('self');
    const result = await runMigration(plan!);
    expect(result).toBe('migrated');

    const partition = projectDataHome(repoRoot);
    // A1 moved to the partition...
    for (const a1 of ['config.yaml', 'state.json', 'env.local', 'env.sh', 'search-index.json']) {
      expect(await fse.pathExists(path.join(partition, a1))).toBe(true);
      expect(await fse.pathExists(path.join(legacyDir, a1))).toBe(false);
    }
    expect(await fse.pathExists(path.join(partition, 'workspaces', 'ws1', 'managed-mcp.json'))).toBe(true);
    expect(await fse.pathExists(path.join(legacyDir, 'workspaces'))).toBe(false);

    // ...class-B knowledge stayed in the repo.
    expect(await fse.pathExists(path.join(legacyDir, 'skills', 'team-skill.md'))).toBe(true);
    expect(await fse.pathExists(path.join(legacyDir, 'env', 'env.yaml'))).toBe(true);
    expect(await fse.pathExists(path.join(legacyDir, 'teamai.yaml'))).toBe(true);
    for (const d of ['rules', 'docs', 'learnings', 'agents', 'hooks', 'mcp']) {
      expect(await fse.pathExists(path.join(legacyDir, d))).toBe(true);
    }

    // The .teamai/ dir itself is NEVER renamed (no .bak), and the worktree stays.
    expect(await fse.pathExists(legacyDir)).toBe(true);
    expect(await fse.pathExists(`${legacyDir}.bak`)).toBe(false);
    expect(await fse.pathExists(path.join(legacyDir, 'reports-wt'))).toBe(true);
  });

  it('does NOT rebase self repo.localPath (it is the class-B knowledge anchor)', async () => {
    await seedSelfLayout();
    await runMigration((await planMigration(repoRoot))!);
    const migrated = YAML.parse(
      await fse.readFile(path.join(projectDataHome(repoRoot), 'config.yaml'), 'utf-8'),
    );
    // localPath must still point at <repo>/.teamai, where the knowledge lives.
    expect(migrated.repo.localPath).toBe(legacyDir);
  });

  it('is idempotent and finishes an interrupted relocation without clobbering the partition', async () => {
    await seedSelfLayout();
    const partition = projectDataHome(repoRoot);
    // Simulate a prior partial run: config already in the partition (authoritative),
    // but a stale copy also lingers in the repo.
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(partition, 'config.yaml'), 'repo:\n  kind: self\nAUTHORITATIVE: true\n');

    await runMigration((await planMigration(repoRoot))!);
    // The authoritative partition config was NOT overwritten by the repo's copy.
    expect(await fse.readFile(path.join(partition, 'config.yaml'), 'utf-8')).toContain('AUTHORITATIVE');
    // The stale repo copy was removed.
    expect(await fse.pathExists(path.join(legacyDir, 'config.yaml'))).toBe(false);
    // A second plan is null — nothing left to relocate.
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('merges the workspaces/ tree instead of dropping legacy children when the partition dir already exists', async () => {
    // Interrupted-run + reconcile race: the partition already has workspaces/wsA
    // (moved by a crashed run), and a later reconcile wrote workspaces/wsB into the
    // repo before the retry. A blind remove(src) would drop wsB (data loss); the
    // merge must carry wsB over while leaving the authoritative wsA untouched.
    await seedSelfLayout();
    const partition = projectDataHome(repoRoot);
    // partition already holds wsA (authoritative)
    await fse.ensureDir(path.join(partition, 'workspaces', 'wsA'));
    await fse.writeFile(path.join(partition, 'workspaces', 'wsA', 'managed-mcp.json'), '{"a":1}');
    // legacy holds a DIFFERENT worktree wsB (+ the seed's ws1) that must not be lost
    await fse.ensureDir(path.join(legacyDir, 'workspaces', 'wsB'));
    await fse.writeFile(path.join(legacyDir, 'workspaces', 'wsB', 'managed-mcp.json'), '{"b":2}');
    // also give partition an authoritative config so the run reaches the merge branch
    await fse.writeFile(path.join(partition, 'config.yaml'), 'repo:\n  kind: self\n');

    await runMigration((await planMigration(repoRoot))!);

    // wsB (legacy-only) was carried over — NOT dropped.
    expect(await fse.pathExists(path.join(partition, 'workspaces', 'wsB', 'managed-mcp.json'))).toBe(true);
    expect(JSON.parse(await fse.readFile(path.join(partition, 'workspaces', 'wsB', 'managed-mcp.json'), 'utf-8'))).toEqual({ b: 2 });
    // wsA (partition authoritative) was left untouched.
    expect(JSON.parse(await fse.readFile(path.join(partition, 'workspaces', 'wsA', 'managed-mcp.json'), 'utf-8'))).toEqual({ a: 1 });
    // the seed's ws1 also made it over.
    expect(await fse.pathExists(path.join(partition, 'workspaces', 'ws1', 'managed-mcp.json'))).toBe(true);
    // legacy workspaces drained + removed.
    expect(await fse.pathExists(path.join(legacyDir, 'workspaces'))).toBe(false);
  });

  it('does not overwrite an authoritative partition workspaces child during merge', async () => {
    await seedSelfLayout(); // seeds legacy workspaces/ws1 = {}
    const partition = projectDataHome(repoRoot);
    // partition already has ws1 with authoritative content — merge must keep it.
    await fse.ensureDir(path.join(partition, 'workspaces', 'ws1'));
    await fse.writeFile(path.join(partition, 'workspaces', 'ws1', 'managed-mcp.json'), '{"authoritative":true}');
    await fse.writeFile(path.join(partition, 'config.yaml'), 'repo:\n  kind: self\n');

    await runMigration((await planMigration(repoRoot))!);

    expect(JSON.parse(await fse.readFile(path.join(partition, 'workspaces', 'ws1', 'managed-mcp.json'), 'utf-8'))).toEqual({ authoritative: true });
  });

  it('finishes an interrupted relocation where config.yaml already moved but plaintext env.local lingers (C1)', async () => {
    // The dangerous crash: a partial run relocated config.yaml to the partition
    // but died before moving env.local/env.sh. planMigration must NOT go blind on
    // "no legacy config.yaml" — it must still see the lingering A1 (incl. the
    // plaintext secrets) and finish, or those secrets stay in the repo forever.
    await seedSelfLayout();
    const partition = projectDataHome(repoRoot);
    await fse.ensureDir(partition);
    // config.yaml already in the partition (moved by the crashed run)...
    await fse.move(path.join(legacyDir, 'config.yaml'), path.join(partition, 'config.yaml'));
    // ...but env.local (plaintext secret) + env.sh still in the repo.
    expect(await fse.pathExists(path.join(legacyDir, 'env.local'))).toBe(true);

    const plan = await planMigration(repoRoot);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('self');
    await runMigration(plan!);

    // The stranded secrets got relocated and removed from the repo.
    expect(await fse.pathExists(path.join(partition, 'env.local'))).toBe(true);
    expect(await fse.pathExists(path.join(legacyDir, 'env.local'))).toBe(false);
    expect(await fse.pathExists(path.join(legacyDir, 'env.sh'))).toBe(false);
    expect(await fse.pathExists(path.join(legacyDir, 'search-index.json'))).toBe(false);
    // Class-B knowledge untouched throughout.
    expect(await fse.pathExists(path.join(legacyDir, 'skills', 'team-skill.md'))).toBe(true);
    expect(await planMigration(repoRoot)).toBeNull();
  });

  it('dry-run relocates nothing', async () => {
    await seedSelfLayout();
    const result = await runMigration((await planMigration(repoRoot))!, { dryRun: true });
    expect(result).toBe('dry-run');
    expect(await fse.pathExists(projectDataHome(repoRoot))).toBe(false);
    expect(await fse.pathExists(path.join(legacyDir, 'config.yaml'))).toBe(true);
  });

  it('refuses to rename a .teamai holding self knowledge, even via the git-mode path (M2 guard)', async () => {
    // Pathological mix: config.yaml says kind: git (so planMigration takes the
    // git-mode branch), but the dir also holds committed self knowledge
    // (teamai.yaml mode: self + skills). The git-mode retire would rename .teamai
    // to .bak and wipe the knowledge — the guard must refuse instead.
    await fse.ensureDir(legacyDir);
    await fse.writeFile(
      path.join(legacyDir, 'config.yaml'),
      YAML.stringify({ repo: { localPath: path.join(legacyDir, 'team-repo'), remote: 'r', kind: 'git' }, username: 'u', scope: 'project' }),
    );
    await fse.writeFile(path.join(legacyDir, 'teamai.yaml'), 'team: t\nmode: self\n');
    await fse.ensureDir(path.join(legacyDir, 'skills'));
    await fse.writeFile(path.join(legacyDir, 'skills', 'team-skill.md'), '# committed knowledge\n');
    // Partition already built → git-mode plan is 'retire-only' → calls retireLegacy.
    const partition = projectDataHome(repoRoot);
    await fse.ensureDir(partition);
    await fse.writeFile(path.join(partition, 'config.yaml'), 'repo:\n  kind: git\n');

    const plan = await planMigration(repoRoot);
    expect(plan!.mode).toBe('retire-only');
    await expect(runMigration(plan!)).rejects.toThrow(/holds single-repo team knowledge/);
    // Knowledge and the dir are intact — nothing was renamed away.
    expect(await fse.pathExists(path.join(legacyDir, 'skills', 'team-skill.md'))).toBe(true);
    expect(await fse.pathExists(`${legacyDir}.bak`)).toBe(false);
  });
});

describe('maybeMigrate', () => {
  it('is a no-op when there is nothing to migrate', async () => {
    // No legacy layout; must not throw.
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    try {
      await expect(maybeMigrate()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

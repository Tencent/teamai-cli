import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { detectProjectConfig, resolveDataHomeForScope } from '../config.js';
import { getDataHome, getTeamaiHome } from '../types.js';
import { projectDataHome } from '../utils/partition.js';

// ─── detectProjectConfig subdirectory / worktree awareness (issue #374 P0) ──
//
// Before this change detectProjectConfig only inspected the given dir's own
// .teamai/config.yaml, so running teamai from a repo subdirectory found nothing.
// Now it walks up to the git workspace root (per-worktree), which is exactly
// where project-scope resources should land.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeProjectConfig(root: string, projectRoot: string): void {
  const dir = path.join(root, '.teamai');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    YAML.stringify({
      repo: { localPath: path.join(root, '.teamai', 'team-repo'), remote: 'https://example.com/x.git' },
      username: 'test',
      scope: 'project',
      projectRoot,
    }),
  );
}

let base: string;
let repoRoot: string;
let worktreeRoot: string;

beforeAll(() => {
  base = realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-detect-')));
  repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot);
  git(repoRoot, 'init', '-q');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'commit', '--allow-empty', '-q', '-m', 'init');
  writeProjectConfig(repoRoot, repoRoot);

  worktreeRoot = path.join(base, 'wt');
  git(repoRoot, 'worktree', 'add', '-q', worktreeRoot, 'HEAD');
  // Each checkout carries its own machine-local .teamai (gitignored). The
  // worktree's config points projectRoot at the worktree itself.
  writeProjectConfig(worktreeRoot, worktreeRoot);
});

afterAll(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('detectProjectConfig — subdirectory / worktree', () => {
  it('finds the project config when run from the repo root', async () => {
    const cfg = await detectProjectConfig(repoRoot);
    expect(cfg).not.toBeNull();
    expect(cfg!.projectRoot).toBe(repoRoot);
  });

  it('finds the project config when run from a nested subdirectory', async () => {
    const sub = path.join(repoRoot, 'packages', 'app', 'src');
    fs.mkdirSync(sub, { recursive: true });
    const cfg = await detectProjectConfig(sub);
    expect(cfg).not.toBeNull();
    expect(cfg!.scope).toBe('project');
    expect(cfg!.projectRoot).toBe(repoRoot);
  });

  it('resolves a worktree subdirectory to the worktree, not the main checkout', async () => {
    const sub = path.join(worktreeRoot, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const cfg = await detectProjectConfig(sub);
    expect(cfg).not.toBeNull();
    expect(cfg!.projectRoot).toBe(worktreeRoot);
    expect(cfg!.projectRoot).not.toBe(repoRoot);
  });

  it('overrides a STALE projectRoot copied from the main checkout into a worktree', async () => {
    // Simulate a .teamai/ copied from main into the worktree: its config still
    // names the MAIN checkout. detectProjectConfig must correct projectRoot to
    // the worktree it was actually found in, or resources would go to main.
    writeProjectConfig(worktreeRoot, repoRoot); // stale: projectRoot = main
    const cfg = await detectProjectConfig(path.join(worktreeRoot, 'src'));
    expect(cfg).not.toBeNull();
    expect(cfg!.projectRoot).toBe(worktreeRoot);
    expect(cfg!.projectRoot).not.toBe(repoRoot);
    writeProjectConfig(worktreeRoot, worktreeRoot); // restore for other tests
  });

  it('returns null for a non-git directory with no config (unchanged behavior)', async () => {
    const plain = path.join(base, 'plain');
    fs.mkdirSync(plain);
    expect(await detectProjectConfig(plain)).toBeNull();
  });
});

// resolveDataHomeForScope must agree with getDataHome(detectProjectConfig(...))
// for every scope — otherwise the local-agent side (which only carries
// scope+projectRoot) and the reconcile side (which holds a full LocalConfig)
// would resolve managed-mcp.json / the resource cache to different directories
// and desync (issue #374 P1-2C).
describe('resolveDataHomeForScope — desync guard', () => {
  it('matches getDataHome(detected) for a legacy project install', async () => {
    const detected = await detectProjectConfig(repoRoot);
    expect(detected).not.toBeNull();
    const viaConfig = getDataHome(detected!);
    const viaScope = await resolveDataHomeForScope('project', repoRoot);
    expect(viaScope).toBe(viaConfig);
    expect(viaScope).toBe(path.join(repoRoot, '.teamai'));
  });

  it('matches from a subdirectory of the project', async () => {
    const sub = path.join(repoRoot, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    const detected = await detectProjectConfig(sub);
    expect(await resolveDataHomeForScope('project', sub)).toBe(getDataHome(detected!));
  });

  it('resolves user scope to ~/.teamai', async () => {
    expect(await resolveDataHomeForScope('user')).toBe(getTeamaiHome('user'));
  });

  it('falls back to legacy <projectRoot>/.teamai for a non-git dir with no config', async () => {
    const plain = path.join(base, 'plain2');
    fs.mkdirSync(plain, { recursive: true });
    expect(await resolveDataHomeForScope('project', plain)).toBe(path.join(plain, '.teamai'));
  });

  it('matches getDataHome(detected) for a PARTITIONED install (config in ~/.teamai/projects/<slug>)', async () => {
    // Point HOME at a tmp home, write the project config into the partition, and
    // confirm both resolvers land on the partition (not the workspace).
    const home = path.join(base, 'part-home');
    fs.mkdirSync(home, { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const pRepo = path.join(base, 'prepo');
      fs.mkdirSync(pRepo);
      git(pRepo, 'init', '-q');
      git(pRepo, 'config', 'user.email', 't@e');
      git(pRepo, 'config', 'user.name', 'T');
      git(pRepo, 'commit', '--allow-empty', '-q', '-m', 'init');
      const anchorReal = realpathSync(pRepo);
      const partition = projectDataHome(anchorReal);
      fs.mkdirSync(partition, { recursive: true });
      fs.writeFileSync(path.join(partition, 'config.yaml'), YAML.stringify({
        repo: { localPath: path.join(partition, 'team-repo'), remote: 'https://example.com/x.git', kind: 'git' },
        username: 'test', scope: 'project', projectRoot: anchorReal, additionalRoles: [],
      }));
      const detected = await detectProjectConfig(pRepo);
      expect(detected).not.toBeNull();
      expect(getDataHome(detected!)).toBe(partition);
      expect(await resolveDataHomeForScope('project', pRepo)).toBe(partition);
    } finally {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    }
  });
});

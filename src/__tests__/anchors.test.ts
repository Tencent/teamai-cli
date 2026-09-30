import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAnchors, listWorktrees } from '../utils/git.js';
import { defaultProjectSlug } from '../codebase-extract.js';

// ─── Real-git tests for resolveAnchors (issue #374 P0) ──────────────────────
//
// Uses a real git repository + a real `git worktree add` in a temp dir, so the
// distinction the two-anchor model rests on is genuinely exercised:
//   - workspaceRoot = the CURRENT checkout (per-worktree)
//   - projectAnchor = the MAIN checkout (shared by repo + all worktrees)
// It also covers the `--path-format=absolute` trap: without it, `--git-common-dir`
// returns a RELATIVE `.git` in the main repo, which would resolve the anchor
// against the wrong base.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

let base: string;
let repoRoot: string;
let worktreeRoot: string;
let nonGitDir: string;

beforeAll(() => {
  // realpath so macOS /tmp -> /private/tmp matches resolveAnchors' own realpath.
  base = realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-anchors-')));
  repoRoot = path.join(base, 'main-repo');
  fs.mkdirSync(repoRoot);
  git(repoRoot, 'init', '-q');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  git(repoRoot, 'commit', '--allow-empty', '-q', '-m', 'init');

  // A worktree lives OUTSIDE the main repo tree to prove the anchor is shared.
  worktreeRoot = path.join(base, 'wt');
  git(repoRoot, 'worktree', 'add', '-q', worktreeRoot, 'HEAD');

  nonGitDir = path.join(base, 'plain');
  fs.mkdirSync(nonGitDir);
});

afterAll(() => {
  try {
    fs.rmSync(path.dirname(repoRoot), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('resolveAnchors', () => {
  it('returns workspace === anchor === repo root for a plain repository', async () => {
    const a = await resolveAnchors(repoRoot);
    expect(a).not.toBeNull();
    expect(a!.workspaceRoot).toBe(repoRoot);
    expect(a!.projectAnchor).toBe(repoRoot);
  });

  it('resolves a subdirectory of the main repo up to the repo root', async () => {
    const sub = path.join(repoRoot, 'src', 'nested');
    fs.mkdirSync(sub, { recursive: true });
    const a = await resolveAnchors(sub);
    expect(a).not.toBeNull();
    expect(a!.workspaceRoot).toBe(repoRoot);
    expect(a!.projectAnchor).toBe(repoRoot);
  });

  it('gives a worktree its own workspaceRoot but the shared main-checkout anchor', async () => {
    const a = await resolveAnchors(worktreeRoot);
    expect(a).not.toBeNull();
    // The current checkout is the worktree itself...
    expect(a!.workspaceRoot).toBe(worktreeRoot);
    // ...but the anchor points back at the MAIN checkout, shared with the repo.
    expect(a!.projectAnchor).toBe(repoRoot);
    expect(a!.workspaceRoot).not.toBe(a!.projectAnchor);
  });

  it('resolves a subdirectory of a worktree to that worktree, anchored at main', async () => {
    const sub = path.join(worktreeRoot, 'deep', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    const a = await resolveAnchors(sub);
    expect(a!.workspaceRoot).toBe(worktreeRoot);
    expect(a!.projectAnchor).toBe(repoRoot);
  });

  it('returns null for a directory that is not inside any git repository', async () => {
    expect(await resolveAnchors(nonGitDir)).toBeNull();
  });

  it('handles --separate-git-dir without colliding on a shared gitdir parent', async () => {
    // Reviewer #374: dirname(--git-common-dir) would return the shared `gitdirs`
    // parent for BOTH repos → identical anchors → P1 partition collision. Using
    // the main-worktree path keeps them distinct, and workspaceRoot stays correct.
    const gitdirs = path.join(base, 'gitdirs');
    fs.mkdirSync(gitdirs, { recursive: true });
    const mk = (name: string) => {
      const ws = path.join(base, name);
      fs.mkdirSync(ws);
      git(ws, 'init', '-q', '--separate-git-dir', path.join(gitdirs, `${name}.git`));
      git(ws, 'config', 'user.email', 'test@example.com');
      git(ws, 'config', 'user.name', 'Test');
      git(ws, 'commit', '--allow-empty', '-q', '-m', 'init');
      return ws;
    };
    const wsA = mk('sepA');
    const wsB = mk('sepB');
    const a = await resolveAnchors(wsA);
    const b = await resolveAnchors(wsB);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.workspaceRoot).toBe(wsA);
    expect(b!.workspaceRoot).toBe(wsB);
    // The two repos must NOT share an anchor (no partition collision).
    expect(a!.projectAnchor).not.toBe(b!.projectAnchor);
    // And neither anchor is the shared parent directory.
    expect(a!.projectAnchor).not.toBe(gitdirs);
    expect(b!.projectAnchor).not.toBe(gitdirs);
  });
});

describe('resolveAnchors memo (#809)', () => {
  const freshRepo = (name: string) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
    return dir;
  };

  it('answers a directory it resolved before without running git again', async () => {
    const dir = freshRepo('memo-hit');
    const first = await resolveAnchors(dir);
    expect(first).not.toBeNull();
    // With .git gone, git would find no repository here.
    fs.renameSync(path.join(dir, '.git'), path.join(dir, 'git-moved'));
    expect(await resolveAnchors(dir)).toEqual(first);
  });

  it('does not remember a directory that was not a repository', async () => {
    const dir = path.join(base, 'memo-miss');
    fs.mkdirSync(dir);
    expect(await resolveAnchors(dir)).toBeNull();
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'init');
    expect(await resolveAnchors(dir)).toEqual({ workspaceRoot: dir, projectAnchor: dir });
  });

  it('keeps one entry per directory', async () => {
    const a = freshRepo('memo-a');
    const b = freshRepo('memo-b');
    expect((await resolveAnchors(a))?.projectAnchor).toBe(a);
    expect((await resolveAnchors(b))?.projectAnchor).toBe(b);
    const sub = path.join(worktreeRoot, 'memo-sub');
    fs.mkdirSync(sub);
    expect((await resolveAnchors(sub))?.workspaceRoot).toBe(worktreeRoot);
  });
});

describe('defaultProjectSlug (#809)', () => {
  it('names a linked worktree\'s root after its main checkout', async () => {
    expect(await defaultProjectSlug(worktreeRoot)).toBe('main-repo');
  });

  it('names the main checkout after itself when it is opened through a differently named symlink (#823)', async () => {
    const alias = path.join(base, 'alias-to-main');
    fs.symlinkSync(repoRoot, alias);
    // The same slug its worktrees get, so the repo's evidence is not split.
    expect(await defaultProjectSlug(alias)).toBe('main-repo');
    // A subdirectory keeps its own name, whatever path leads to it.
    fs.mkdirSync(path.join(repoRoot, 'pkg', 'cli'), { recursive: true });
    expect(await defaultProjectSlug(path.join(alias, 'pkg', 'cli'))).toBe('cli');
  });

  it('keeps the directory\'s own name everywhere else', async () => {
    const mainSub = path.join(repoRoot, 'pkg', 'api');
    const worktreeSub = path.join(worktreeRoot, 'pkg', 'web');
    fs.mkdirSync(mainSub, { recursive: true });
    fs.mkdirSync(worktreeSub, { recursive: true });
    expect(await defaultProjectSlug(repoRoot)).toBe('main-repo');
    expect(await defaultProjectSlug(mainSub)).toBe('api');
    expect(await defaultProjectSlug(worktreeSub)).toBe('web');
    expect(await defaultProjectSlug(nonGitDir)).toBe('plain');
    const file = path.join(repoRoot, 'README.md');
    fs.writeFileSync(file, '# readme\n');
    expect(await defaultProjectSlug(file)).toBe('README.md');
  });

  it('names every worktree of a bare repo after the repo, not its git directory', async () => {
    // repo/.bare + repo/<worktree>
    const bare = path.join(base, 'bare-layout', '.bare');
    execFileSync('git', ['clone', '-q', '--bare', repoRoot, bare]);
    for (const wt of ['main', 'feature']) {
      const checkout = path.join(base, 'bare-layout', wt);
      git(bare, 'worktree', 'add', '-q', checkout);
      expect((await resolveAnchors(checkout))?.projectAnchor).toBe(bare);
      expect(await defaultProjectSlug(checkout)).toBe('bare-layout');
    }
    const sub = path.join(base, 'bare-layout', 'main', 'pkg');
    fs.mkdirSync(sub);
    expect(await defaultProjectSlug(sub)).toBe('pkg');

    // proj.git + a worktree beside it
    const dotGit = path.join(base, 'proj.git');
    const checkout = path.join(base, 'proj-wt');
    execFileSync('git', ['clone', '-q', '--bare', repoRoot, dotGit]);
    git(dotGit, 'worktree', 'add', '-q', checkout);
    expect(await defaultProjectSlug(checkout)).toBe('proj');
  });
});

describe('listWorktrees', () => {
  it('lists the main checkout and every linked worktree (realpath\'d)', async () => {
    const roots = await listWorktrees(repoRoot);
    expect(roots).toContain(repoRoot);
    expect(roots).toContain(worktreeRoot);
    // From a subdirectory of a worktree, the full set is still returned.
    const sub = path.join(worktreeRoot, 'nested');
    fs.mkdirSync(sub, { recursive: true });
    const fromSub = await listWorktrees(sub);
    expect(fromSub).toContain(repoRoot);
    expect(fromSub).toContain(worktreeRoot);
  });

  it('returns [] outside a git repo', async () => {
    const plain = realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-nogit-')));
    expect(await listWorktrees(plain)).toEqual([]);
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it('returns [] for a directory that no longer exists', async () => {
    expect(await listWorktrees(path.join(os.tmpdir(), 'teamai-gone-', String(process.pid), 'project'))).toEqual([]);
  });
});

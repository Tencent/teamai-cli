import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAnchors, listWorktrees, parseWorktreeList, isDedicatedRepoRoot, gitCommonDir } from '../utils/git.js';
import { gitExcludeFile } from '../git-exclude.js';
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
  it('keeps a submodule identity separate from its main checkout', async () => {
    const parent = path.join(base, 'submodule-parent');
    fs.mkdirSync(parent);
    git(parent, 'init', '-q');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repoRoot, 'service');
    const checkout = path.join(parent, 'service');
    expect(await resolveAnchors(checkout)).toEqual({
      workspaceRoot: checkout,
      projectAnchor: path.join(parent, '.git', 'modules', 'service'),
      mainCheckout: checkout,
    });
  });

  it('keeps a nested clone worktree anchored at the child clone', async () => {
    const nested = path.join(repoRoot, 'child');
    git(repoRoot, 'clone', '-q', repoRoot, nested);
    const linked = path.join(repoRoot, 'child-worktree');
    git(nested, 'worktree', 'add', '-q', '--detach', linked);
    expect(await resolveAnchors(linked)).toEqual({ workspaceRoot: linked, projectAnchor: nested, mainCheckout: nested });
  });

  it('returns workspace === anchor === repo root for a plain repository', async () => {
    const a = await resolveAnchors(repoRoot);
    expect(a).not.toBeNull();
    expect(a!.workspaceRoot).toBe(repoRoot);
    expect(a!.projectAnchor).toBe(repoRoot);
    expect(a!.mainCheckout).toBe(repoRoot);
  });

  it('resolves a subdirectory of the main repo up to the repo root', async () => {
    const sub = path.join(repoRoot, 'src', 'nested');
    fs.mkdirSync(sub, { recursive: true });
    const a = await resolveAnchors(sub);
    expect(a).not.toBeNull();
    expect(a!.workspaceRoot).toBe(repoRoot);
    expect(a!.projectAnchor).toBe(repoRoot);
    expect(a!.mainCheckout).toBe(repoRoot);
  });

  it('gives a worktree its own workspaceRoot but the shared main-checkout anchor', async () => {
    const a = await resolveAnchors(worktreeRoot);
    expect(a).not.toBeNull();
    // The current checkout is the worktree itself...
    expect(a!.workspaceRoot).toBe(worktreeRoot);
    // ...but the anchor points back at the MAIN checkout, shared with the repo.
    expect(a!.projectAnchor).toBe(repoRoot);
    expect(a!.mainCheckout).toBe(repoRoot);
    expect(a!.workspaceRoot).not.toBe(a!.projectAnchor);
  });

  it('resolves a subdirectory of a worktree to that worktree, anchored at main', async () => {
    const sub = path.join(worktreeRoot, 'deep', 'dir');
    fs.mkdirSync(sub, { recursive: true });
    const a = await resolveAnchors(sub);
    expect(a!.workspaceRoot).toBe(worktreeRoot);
    expect(a!.projectAnchor).toBe(repoRoot);
    expect(a!.mainCheckout).toBe(repoRoot);
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
    expect(a!.mainCheckout).toBe(wsA);
    expect(b!.mainCheckout).toBe(wsB);
    const linked = path.join(base, 'separate-linked');
    git(wsA, 'worktree', 'add', '-q', '--detach', linked);
    expect(await resolveAnchors(linked)).toEqual({ workspaceRoot: linked, projectAnchor: a!.projectAnchor, mainCheckout: null });
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
    expect(await resolveAnchors(dir)).toEqual({ workspaceRoot: dir, projectAnchor: dir, mainCheckout: dir });
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
      expect((await resolveAnchors(checkout))?.mainCheckout).toBeNull();
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

  it('leaves out the git directory a --separate-git-dir repo lists as its main entry (#993)', async () => {
    const checkout = path.join(base, 'sep');
    const gitDir = path.join(base, 'sep-git', 'proj.git');
    fs.mkdirSync(checkout);
    fs.mkdirSync(path.dirname(gitDir));
    git(checkout, 'init', '-q', `--separate-git-dir=${gitDir}`);
    git(checkout, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init');
    const linked = path.join(base, 'sep-wt');
    git(checkout, 'worktree', 'add', '-q', linked, 'HEAD');

    expect(await listWorktrees(checkout)).toEqual([linked]);
  });

  it('follows worktrees added, moved, and deleted after an earlier call', async () => {
    const repo = path.join(base, 'changing');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-q', '-m', 'init');
    expect(await listWorktrees(repo)).toEqual([repo]);

    const added = path.join(base, 'changing-wt');
    git(repo, 'worktree', 'add', '-q', added, 'HEAD');
    expect(await listWorktrees(repo)).toEqual([repo, added]);

    const moved = path.join(base, 'changing-moved');
    git(repo, 'worktree', 'move', added, moved);
    expect(await listWorktrees(repo)).toEqual([repo, moved]);

    // Deleted without `git worktree remove`: git lists it as prunable.
    fs.rmSync(moved, { recursive: true, force: true });
    expect(await listWorktrees(repo)).toEqual([repo]);
  });
});

describe('what git says of a directory, asked again', () => {
  it('follows a repository created later inside a directory git answered for before', async () => {
    const outer = path.join(base, 'outer');
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner, { recursive: true });
    git(outer, 'init', '-q');
    expect((await gitExcludeFile(inner))?.root).toBe(outer);
    expect(await isDedicatedRepoRoot(inner)).toBe(false);

    git(inner, 'init', '-q');
    expect(await gitExcludeFile(inner)).toEqual({ root: inner, prefix: '', excludeFile: path.join(inner, '.git', 'info', 'exclude') });
    expect(await isDedicatedRepoRoot(inner)).toBe(true);
    expect(await gitCommonDir(inner)).toBe(path.join(inner, '.git'));
  });

  it('stops taking a clone root for its own repository once its .git is gone', async () => {
    const outer = path.join(base, 'enclosing');
    const clone = path.join(outer, 'clone');
    fs.mkdirSync(clone, { recursive: true });
    git(outer, 'init', '-q');
    git(clone, 'init', '-q');
    expect(await isDedicatedRepoRoot(clone)).toBe(true);

    fs.rmSync(path.join(clone, '.git'), { recursive: true, force: true });
    expect(await isDedicatedRepoRoot(clone)).toBe(false);
    expect((await gitExcludeFile(clone))?.prefix).toBe('clone/');
  });
});

describe('parseWorktreeList (#993)', () => {
  // `git worktree list --porcelain -z`: NUL ends each attribute, an empty field each entry.
  const z = (...entries: string[][]): string => entries.map((fields) => `${fields.join('\0')}\0\0`).join('');

  it('keeps a path that contains a newline whole', () => {
    const output = z(
      ['worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
      ['worktree /work/odd\nname', 'HEAD 2222222222222222222222222222222222222222', 'detached'],
    );
    expect(parseWorktreeList(output).map((entry) => entry.path)).toEqual(['/repo', '/work/odd\nname']);
  });

  it('marks bare and prunable entries, whatever the prunable reason says', () => {
    const output = z(
      ['worktree /srv/proj.git', 'bare'],
      ['worktree /work/gone', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable gitdir file points to non-existent location'],
      ['worktree /work/live', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/live', 'locked reason\nwith a newline'],
    );
    expect(parseWorktreeList(output)).toEqual([
      { path: '/srv/proj.git', bare: true, prunable: false },
      { path: '/work/gone', bare: false, prunable: true },
      { path: '/work/live', bare: false, prunable: false },
    ]);
  });
});

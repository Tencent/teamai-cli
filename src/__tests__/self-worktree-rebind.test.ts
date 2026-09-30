import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

import { detectProjectConfig } from '../config.js';
import { getKnowledgeDir, getDataHome } from '../types.js';
import { projectDataHome } from '../utils/partition.js';

// ─── P2 cross-worktree self regression (issue #374) ─────────────────────────
//
// After P2 a self install's config lives in the SHARED partition (keyed on the
// main checkout's projectAnchor), read by every worktree. Its persisted
// repo.localPath / businessRepoRoot name the checkout that first migrated (main).
// getKnowledgeDir === repo.localPath, so without rebinding, a feature worktree
// would read MAIN's knowledge and inject it into the FEATURE tree. detection must
// re-anchor localPath/businessRepoRoot to the current workspace (self's invariant
// is localPath === <workspaceRoot>/.teamai, businessRepoRoot === <workspaceRoot>).

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

let base: string, main: string, home: string;

beforeEach(() => {
  base = realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'self-wt-')));
  main = path.join(base, 'main-repo');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'config', 'user.email', 't@e.com');
  git(main, 'config', 'user.name', 'T');
  git(main, 'commit', '--allow-empty', '-q', '-m', 'init');
  home = path.join(base, 'home');
  fs.mkdirSync(home);
  vi.stubEnv('HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Write a migrated self config into the shared partition, localPath = MAIN. */
function seedSharedSelfConfig(): string {
  const partition = projectDataHome(main);
  fs.mkdirSync(partition, { recursive: true });
  fs.writeFileSync(path.join(partition, 'config.yaml'), YAML.stringify({
    repo: { localPath: path.join(main, '.teamai'), remote: 'r', kind: 'self', businessRepoRoot: main },
    username: 'e2e', scope: 'project',
  }));
  fse.ensureDirSync(path.join(main, '.teamai'));
  return partition;
}

describe('P2 self cross-worktree rebind', () => {
  it('rebinds self repo.localPath/businessRepoRoot to a feature worktree', async () => {
    const partition = seedSharedSelfConfig();
    const feat0 = path.join(base, 'feature-wt');
    git(main, 'worktree', 'add', '-q', feat0, '-b', 'feature');
    const feat = realpathSync.native(feat0);
    fse.ensureDirSync(path.join(feat, '.teamai'));

    const detected = await detectProjectConfig(feat);
    expect(detected).not.toBeNull();
    expect(detected!.projectRoot).toBe(feat);
    // Knowledge + business root track the CURRENT worktree, not main.
    expect(getKnowledgeDir(detected!)).toBe(path.join(feat, '.teamai'));
    expect(detected!.repo.businessRepoRoot).toBe(feat);
    // Machine data still shares the partition across worktrees.
    expect(getDataHome(detected!)).toBe(partition);
  });

  it('still resolves correctly from the main checkout', async () => {
    seedSharedSelfConfig();
    const detected = await detectProjectConfig(main);
    expect(detected).not.toBeNull();
    expect(getKnowledgeDir(detected!)).toBe(path.join(main, '.teamai'));
    expect(detected!.repo.businessRepoRoot).toBe(main);
  });

  it('does NOT rebind localPath for a non-self (git-mode) config', async () => {
    // git-mode localPath is the team-repo clone path (shared across worktrees on
    // purpose) — it must NOT be rewritten to <workspace>/.teamai.
    const partition = projectDataHome(main);
    fs.mkdirSync(partition, { recursive: true });
    const clonePath = path.join(partition, 'team-repo');
    fs.writeFileSync(path.join(partition, 'config.yaml'), YAML.stringify({
      repo: { localPath: clonePath, remote: 'r', kind: 'git' },
      username: 'e2e', scope: 'project',
    }));
    const feat0 = path.join(base, 'feature-wt');
    git(main, 'worktree', 'add', '-q', feat0, '-b', 'feature');
    const feat = realpathSync.native(feat0);

    const detected = await detectProjectConfig(feat);
    expect(detected!.repo.localPath).toBe(clonePath);
  });
});

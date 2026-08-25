import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredBranch, cleanupOrphanSkills, recordInstalledSkills, pinCloneToBranch, ensureBranchState } from '../utils/branch-manager.js';
import { createGit } from '../utils/git.js';

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-branch-'));
}

function configFor(root: string, branch?: string) {
  return { repo: { localPath: path.join(root, 'team-repo'), kind: 'git', branch } };
}

describe('configuredBranch', () => {
  it('returns null when branch is unset', () => {
    expect(configuredBranch(configFor('/x'))).toBeNull();
    expect(configuredBranch(configFor('/x', '  '))).toBeNull();
  });
  it('returns the branch for git kind', () => {
    expect(configuredBranch(configFor('/x', 'develop/vdr-gps'))).toBe('develop/vdr-gps');
  });
  it('returns null for self and http kinds', () => {
    expect(configuredBranch({ repo: { localPath: '/x', kind: 'self', branch: 'b' } })).toBeNull();
    expect(configuredBranch({ repo: { localPath: '/x', kind: 'http', branch: 'b' } })).toBeNull();
  });
});

describe('ledger orphan cleanup', () => {
  it('removes ledger entries absent from the current install set', () => {
    const root = tmpProject();
    const skillA = path.join(root, 'claude-skills', 'skill-a');
    const skillB = path.join(root, 'claude-skills', 'skill-b');
    fs.mkdirSync(skillA, { recursive: true });
    fs.mkdirSync(skillB, { recursive: true });
    const cfg = configFor(root, 'develop/x');
    recordInstalledSkills(cfg, [
      { tool: 'claude', name: 'skill-a', dir: skillA },
      { tool: 'claude', name: 'skill-b', dir: skillB },
    ]);
    // Next branch keeps only skill-a.
    const removed = cleanupOrphanSkills(cfg, [
      { tool: 'claude', name: 'skill-a', dir: skillA },
    ]);
    expect(removed).toBe(1);
    expect(fs.existsSync(skillB)).toBe(false);
    expect(fs.existsSync(skillA)).toBe(true);
  });

  it('never touches directories not recorded in the ledger', () => {
    const root = tmpProject();
    const personal = path.join(root, 'claude-skills', 'my-own-skill');
    fs.mkdirSync(personal, { recursive: true });
    const cfg = configFor(root, 'develop/x');
    // Empty ledger → nothing eligible for removal.
    const removed = cleanupOrphanSkills(cfg, []);
    expect(removed).toBe(0);
    expect(fs.existsSync(personal)).toBe(true);
  });
});

// ─── Real-git integration: pin + divergence self-heal ─────────────

async function commitFile(git: any, repoPath: string, file: string, content: string, msg: string): Promise<void> {
  fs.writeFileSync(path.join(repoPath, file), content);
  await git.add(file);
  await git.commit(msg);
}

async function buildFixture(): Promise<{ clonePath: string; originPath: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pin-'));
  const originPath = path.join(root, 'origin.git');
  const seedPath = path.join(root, 'seed');
  const clonePath = path.join(root, 'clone');
  fs.mkdirSync(seedPath, { recursive: true });
  const git = createGit(seedPath);
  await git.raw(['init', '-b', 'master']);
  await git.raw(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
  await git.raw(['checkout', '-b', 'develop/line', 'master']);
  await git.raw(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'branch-only commit']);
  // Back to the default branch BEFORE the bare clone so the origin HEAD is
  // master — a fresh clone then lands on master, like a real teamai init.
  await git.raw(['checkout', 'master']);
  await git.raw(['clone', '--bare', seedPath, originPath]);
  await git.raw(['clone', originPath, clonePath]);
  return { clonePath, originPath };
}

describe('pinCloneToBranch (real git)', () => {
  it('creates the local branch FROM the remote ref, not the default-branch HEAD', async () => {
    const { clonePath } = await buildFixture();
    await pinCloneToBranch(clonePath, 'develop/line');
    const git = createGit(clonePath);
    expect((await git.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('develop/line');
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toContain('branch-only commit');
    const mergeRef = (await git.raw(['config', 'branch.develop/line.merge'])).trim();
    expect(mergeRef).toBe('refs/heads/develop/line');
    const pushRemote = (await git.raw(['config', 'branch.develop/line.remote'])).trim();
    expect(pushRemote).toBe('origin');
    await expect(git.pull()).resolves.toBeTruthy();
  });
});

describe('ensureBranchState (real git)', () => {
  it('heals a diverged branch by realigning to the remote tip', async () => {
    const { clonePath, originPath } = await buildFixture();
    await pinCloneToBranch(clonePath, 'develop/line');
    const git = createGit(clonePath);
    const other = path.join(path.dirname(clonePath), 'other');
    await createGit(clonePath).raw(['clone', originPath, other]);
    const og = createGit(other);
    await og.raw(['checkout', 'develop/line']);
    await commitFile(og, other, 'remote.txt', 'x', 'remote advances');
    await og.raw(['push', 'origin', 'develop/line']);
    await commitFile(git, clonePath, 'local.txt', 'y', 'local diverges');
    fs.rmSync(other, { recursive: true, force: true });
    const cfg = { repo: { localPath: clonePath, kind: 'git', branch: 'develop/line' } };
    await expect(ensureBranchState(cfg)).resolves.toBe(true);
    expect((await git.log({ maxCount: 1 })).latest?.message).toContain('remote advances');
    await expect(git.pull()).resolves.toBeTruthy();
  });

  it('throws BranchVanishedError when the configured branch is gone from the remote', async () => {
    const { clonePath, originPath } = await buildFixture();
    await pinCloneToBranch(clonePath, 'develop/line');
    // Delete the branch on the "remote" (rename scenario).
    const tmp = path.join(path.dirname(clonePath), 'rm');
    await createGit(clonePath).raw(['clone', originPath, tmp]);
    const rg = createGit(tmp);
    await rg.raw(['push', 'origin', '--delete', 'develop/line']);
    fs.rmSync(tmp, { recursive: true, force: true });
    const cfg = { repo: { localPath: clonePath, kind: 'git', branch: 'develop/line' } };
    await expect(ensureBranchState(cfg)).rejects.toThrow(/does not exist on the remote/);
  });
});

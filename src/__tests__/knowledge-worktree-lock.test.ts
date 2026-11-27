/**
 * The knowledge worktree is one shared checkout: push, remove, manifest edits
 * and promotion all remove it with --force on entry and in `finally`. Two of
 * them running together used to delete each other's checkout mid-write, so a
 * command's changes landed in another command's PR or disappeared entirely.
 * A dedicated lock beside the checkout must serialize them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { KNOWLEDGE_LOCK_FILENAME, KNOWLEDGE_WORKTREE_DIRNAME, type LocalConfig } from '../types.js';

const state = vi.hoisted(() => ({
  acquired: [] as string[],
  released: [] as string[],
  held: false,
  refuse: false,
}));

// Delegate to the real lock so its parent directory exists for `worktree add`,
// but make the outcome controllable and record every transition.
vi.mock('../update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../update.js')>();
  return {
    ...actual,
    acquireLock: async (lockPath?: string) => {
      state.acquired.push(lockPath ?? '');
      if (state.refuse) return false;
      const ok = await actual.acquireLock(lockPath);
      if (ok) state.held = true;
      return ok;
    },
    releaseLock: async (lockPath?: string) => {
      state.released.push(lockPath ?? '');
      state.held = false;
      await actual.releaseLock(lockPath);
    },
  };
});

const { withKnowledgeWorktree } = await import('../utils/reports-branch.js');
const { CheckoutRefusedError } = await import('../utils/branch-worktree.js');

let tmp: string;
let config: LocalConfig;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-knowledge-lock-'));
  state.acquired = [];
  state.released = [];
  state.held = false;
  state.refuse = false;

  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  await seedGit.add(['.']);
  await seedGit.commit('init');
  const origin = path.join(tmp, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const clone = path.join(tmp, 'team-repo');
  await simpleGit().clone(origin, clone);
  config = { repo: { localPath: clone, remote: origin, kind: 'git' }, username: 'alice', scope: 'user', additionalRoles: [] };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('withKnowledgeWorktree holds a dedicated lock', () => {
  it('refuses before touching the checkout when another command holds the lock', async () => {
    state.refuse = true;
    const body = vi.fn(async () => 'never');

    await expect(withKnowledgeWorktree(config, body)).rejects.toBeInstanceOf(CheckoutRefusedError);

    expect(body).not.toHaveBeenCalled();
    expect(state.acquired).toHaveLength(1);
    expect(path.basename(state.acquired[0])).toBe(KNOWLEDGE_LOCK_FILENAME);
    // The lock sits beside the checkout, never inside it: `worktree remove
    // --force` would delete a lock held inside while it is still held.
    const wt = path.join(path.dirname(state.acquired[0]), KNOWLEDGE_WORKTREE_DIRNAME);
    expect(fs.existsSync(wt)).toBe(false);
    expect(state.released).toHaveLength(0);
  });

  it('holds the lock across the callback and releases it after cleanup', async () => {
    const heldDuringBody: boolean[] = [];

    const result = await withKnowledgeWorktree(config, async () => {
      heldDuringBody.push(state.held);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(heldDuringBody).toEqual([true]);
    expect(state.acquired).toHaveLength(1);
    expect(state.released).toEqual(state.acquired);
    expect(state.held).toBe(false);
  });

  it('releases the lock even when the callback throws', async () => {
    await expect(withKnowledgeWorktree(config, async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(state.released).toEqual(state.acquired);
    expect(state.held).toBe(false);
  });
});

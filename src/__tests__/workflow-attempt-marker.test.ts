import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nestedCall, nestedStart } from '../workflow/attempt-marker.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkout(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-attempt-marker-')));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
  return root;
}

describe('nested workflow starts', () => {
  it('lets a start run in a checkout on a branch of its own, with no marker', async () => {
    expect(await nestedStart({}, checkout())).toBeUndefined();
  });

  it('refuses a start inside an attempt, whatever the directory', async () => {
    expect(await nestedStart({ TEAMAI_WORKFLOW_ATTEMPT: 'r0123456789abcdef/a0000000a' }, checkout()))
      .toEqual({ kind: 'marker', attempt: 'r0123456789abcdef/a0000000a' });
  });

  it('refuses a start in a workflow worktree, which need not exist any more', async () => {
    const main = checkout();
    const dir = path.join(main, '.teamai', 'workflow-worktrees', 'teamai-r0123456789abcdef-work-p1-3f2a91c0d4e5', 'src');
    expect(await nestedStart({}, dir)).toEqual({ kind: 'worktree-path', dir, checkout: main });
  });

  it('refuses a start in a checkout on a workflow branch, as a place the host made is, and not on a branch that only looks like one', async () => {
    const main = checkout();
    execFileSync('git', ['switch', '-q', '-c', 'teamai/r0123456789abcdef/work/p1'], { cwd: main });
    expect(await nestedStart({}, main)).toEqual({ kind: 'workflow-branch', dir: main, branch: 'teamai/r0123456789abcdef/work/p1' });
    execFileSync('git', ['switch', '-q', '-c', 'teamai/release/notes'], { cwd: main });
    expect(await nestedStart({}, main)).toBeUndefined();
  });

  it('refuses a call on a run that exists only on the marker, not in a workflow place', () => {
    expect(nestedCall({})).toBeUndefined();
    expect(nestedCall({ TEAMAI_WORKFLOW_ATTEMPT: 'r0123456789abcdef/a0000000a' })).toEqual({ kind: 'marker', attempt: 'r0123456789abcdef/a0000000a' });
  });
});

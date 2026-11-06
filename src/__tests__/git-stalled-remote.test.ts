/**
 * Real git against an `ssh://` team repo whose ssh command accepts the
 * connection and then never writes (#1749). The stand-in ignores SIGINT, as an
 * ssh git cannot interrupt does: git forwards the SIGINT simple-git sends it
 * and waits for its ssh, so ending git alone would leave both running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { createGitWithBlockTimeout, GitStalledError, pullRepo } from '../utils/git.js';
import { fetchTrackingRef } from '../utils/branch-worktree.js';

let tmp: string;
let pidFile: string;
let stallFlag: string;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** The stand-in ssh and the git that started it, once the stand-in ran. */
function standInTree(): number[] {
  return fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number) : [];
}

async function expectTreeEnded(): Promise<void> {
  const tree = standInTree();
  expect(tree).toHaveLength(2);
  await vi.waitFor(() => expect(tree.filter(alive)).toEqual([]), { timeout: 3_000, interval: 50 });
}

async function identify(dir: string): Promise<void> {
  await simpleGit(dir).addConfig('user.email', 't@t.com').addConfig('user.name', 't');
}

/** A clone of a bare origin, with origin moved to an `ssh://` URL that the stand-in serves from the bare path. */
async function sshClone(): Promise<{ clone: string; origin: string }> {
  const seed = path.join(tmp, 'seed');
  const origin = path.join(tmp, 'origin.git');
  const clone = path.join(tmp, 'clone');
  fs.mkdirSync(seed);
  await simpleGit(seed).init(['--initial-branch=main']);
  await identify(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  await simpleGit(seed).add(['.']).commit('seed');
  await simpleGit().clone(seed, origin, ['--bare']);
  await simpleGit().clone(origin, clone);

  const sshCommand = path.join(tmp, 'stall-ssh');
  fs.writeFileSync(sshCommand, `#!/bin/sh
echo "$$ $PPID" > '${pidFile}'
trap '' INT
if [ -f '${stallFlag}' ]; then
  while [ -f '${stallFlag}' ]; do sleep 1; done
  exit 1
fi
exec sh -c "$2"
`, { mode: 0o755 });
  const git = simpleGit(clone, { unsafe: { allowUnsafeSshCommand: true } });
  await git.remote(['set-url', 'origin', `ssh://git@stall.invalid${origin}`]);
  await git.addConfig('core.sshCommand', sshCommand);
  await git.addConfig('ssh.variant', 'simple');

  return { clone, origin };
}

describe.skipIf(process.platform === 'win32')('team repo git calls against a stalled ssh remote', () => {
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-stalled-ssh-')));
    pidFile = path.join(tmp, 'stand-in.pid');
    stallFlag = path.join(tmp, 'stall');
  });

  afterEach(() => {
    // Removing the stall flag lets a stand-in that outlived its test exit within a second.
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('still pulls through the ssh remote while it answers', async () => {
    const { clone, origin } = await sshClone();
    const other = path.join(tmp, 'other');
    await simpleGit().clone(origin, other);
    await identify(other);
    fs.writeFileSync(path.join(other, 'notes.md'), 'hello\n');
    await simpleGit(other).add(['notes.md']).commit('add notes').push(['origin', 'main']);

    await expect(pullRepo(clone)).resolves.toBe('1 file(s) changed');
  });

  it('ends a stalled pull with the git fetch and ssh under it, naming the pull', async () => {
    const { clone } = await sshClone();
    fs.writeFileSync(stallFlag, '');
    vi.stubEnv('TEAMAI_INIT_PUSH_TIMEOUT_MS', '1000');

    const start = Date.now();
    const pulled = pullRepo(clone);

    await expect(pulled).rejects.toBeInstanceOf(GitStalledError);
    await expect(pulled).rejects.toThrow(/^git pull --ff-only --progress stalled: no output for 1s/);
    // One stall: a stalled pull is not retried as a fetch + reset.
    expect(Date.now() - start).toBeLessThan(5_000);
    await expectTreeEnded();
  }, 10_000);

  it('ends the whole tree when the caller aborts the pull', async () => {
    const { clone } = await sshClone();
    fs.writeFileSync(stallFlag, '');

    await expect(pullRepo(clone, AbortSignal.timeout(500))).rejects.toThrow();
    await expectTreeEnded();
  }, 10_000);

  it('ends a stalled side-branch fetch with its ssh, naming the fetch', async () => {
    const { clone } = await sshClone();
    fs.writeFileSync(stallFlag, '');
    vi.stubEnv('TEAMAI_INIT_PUSH_TIMEOUT_MS', '1000');

    await expect(fetchTrackingRef(createGitWithBlockTimeout(clone), 'main'))
      .rejects.toThrow(/^git fetch --progress origin \+refs\/heads\/main:refs\/remotes\/origin\/main stalled/);
    await expectTreeEnded();
  }, 10_000);
});

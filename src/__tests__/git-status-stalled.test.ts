/**
 * The team-repo remote calls #1777 bounded cover `pull`, the pull/push
 * helpers and the side-branch worktree. These are the same class left on plain
 * `createGit`: `teamai status`'s fetch, the promotion fetch, and the
 * `ls-remote` that decides whether a recorded push branch is still open.
 *
 * Each one talks to `origin`; with an ssh that accepts the connection and then
 * never writes, plain `createGit` has no block timeout and the command hangs
 * forever, holding the sync lock where one is held.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';

import { GitStalledError, getRepoStatus, remoteBranchExists } from '../utils/git.js';
import { fetchPromotionRefs } from '../maintenance/promote.js';

let tmp: string;
let stallFlag: string;

async function identify(dir: string): Promise<void> {
  await simpleGit(dir).addConfig('user.email', 't@t.com').addConfig('user.name', 't');
}

/** A clone whose origin is an `ssh://` URL served by a stand-in that stalls on demand. */
async function sshClone(): Promise<string> {
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

  return clone;
}

describe.skipIf(process.platform === 'win32')('team-repo remote calls outside #1777', () => {
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-remote-stalled-')));
    stallFlag = path.join(tmp, 'stall');
    vi.stubEnv('TEAMAI_INIT_PUSH_TIMEOUT_MS', '1000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ends the fetch `teamai status` runs instead of hanging', async () => {
    const clone = await sshClone();
    fs.writeFileSync(stallFlag, '');

    const start = Date.now();
    await expect(getRepoStatus(clone)).rejects.toBeInstanceOf(GitStalledError);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);

  it('ends the promotion fetch that holds the sync lock', async () => {
    const clone = await sshClone();
    fs.writeFileSync(stallFlag, '');

    const start = Date.now();
    await expect(fetchPromotionRefs(clone)).rejects.toBeInstanceOf(GitStalledError);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);

  it('answers "unknown" for a stalled ls-remote instead of hanging', async () => {
    const clone = await sshClone();
    fs.writeFileSync(stallFlag, '');

    const start = Date.now();
    await expect(remoteBranchExists(clone, 'teamai/push/t/one')).resolves.toBeNull();
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);
});

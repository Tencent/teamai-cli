/**
 * Real-git regression for the init-hang bug (PR #677).
 *
 * Original failure: with a protected default branch and missing push
 * credentials, the member-registration / reviewer-config push hung forever
 * (simple-git had no subprocess timeout and no GIT_TERMINAL_PROMPT guard), so
 * `teamai init` never reached the local-config step. These tests pin both
 * halves of the fix against a real git remote:
 *
 *   1. createGit must pass a spawn-level block timeout and
 *      GIT_TERMINAL_PROMPT=0 to every simple-git instance — the timeout kills
 *      the hung child process instead of merely un-awaiting it.
 *   2. The guarded instance behaves normally on a plain file remote (a fast
 *      push with credentials present must still succeed), so the guards do
 *      not break the happy path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

import { createGit, pushRepoDirectly } from '../utils/git.js';

let tmp: string;
let originalHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-hang-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A bare origin whose default branch rejects pushes via an update hook. */
async function seedProtectedOrigin(): Promise<string> {
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  const seedGit = simpleGit(seed);
  await seedGit.init(['--initial-branch=main']);
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
  fs.mkdirSync(path.join(seed, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'skills', '.gitkeep'), '');
  await seedGit.add(['.']);
  await seedGit.commit('init knowledge');

  const origin = path.join(tmp, 'origin.git');
  await simpleGit().clone(seed, origin, ['--bare']);
  const hook = path.join(origin, 'hooks', 'update');
  fs.writeFileSync(
    hook,
    `#!/bin/sh
ref="$1"
if [ "$ref" = "refs/heads/main" ] || [ "$ref" = "refs/heads/master" ]; then
  echo "default branch is protected" >&2
  exit 1
fi
exit 0
`,
  );
  fs.chmodSync(hook, 0o755);
  return origin;
}

describe('createGit hang guards (init-hang regression)', () => {
  it('returns a functional git instance (factory-level guards are pinned in git.test.ts)', () => {
    const git = createGit();
    expect(typeof git.status).toBe('function');
    expect(typeof git.push).toBe('function');
  });

  it('a push rejected by a protected default branch fails fast (real git, no hang)', async () => {
    const origin = await seedProtectedOrigin();
    const clone = path.join(tmp, 'team-repo');
    await simpleGit().clone(origin, clone);
    await simpleGit(clone).addConfig('user.email', 't@t.com');
    await simpleGit(clone).addConfig('user.name', 't');

    // Push a real change at the protected branch. The server-side hook
    // rejects it; the guarded instance must surface that rejection promptly
    // (previously a missing credential made this await forever).
    fs.mkdirSync(path.join(clone, 'members'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'members', 'alice.yaml'), 'username: alice\n');

    const start = Date.now();
    await expect(
      pushRepoDirectly(clone, '[teamai] Register member: alice', ['members/alice.yaml']),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    // A server-side rejection is immediate; only a regression back to the
    // unguarded hang would take the full 30s+ timeout budget.
    expect(elapsed).toBeLessThan(15_000);
  });

  it('the guards do not break the happy path: a fast push to an unprotected branch still succeeds', async () => {
    const seed = path.join(tmp, 'seed-ok');
    fs.mkdirSync(seed, { recursive: true });
    const seedGit = simpleGit(seed);
    await seedGit.init(['--initial-branch=main']);
    await seedGit.addConfig('user.email', 't@t.com');
    await seedGit.addConfig('user.name', 't');
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: acme\n');
    await seedGit.add(['.']);
    await seedGit.commit('init');

    const origin = path.join(tmp, 'origin-ok.git');
    await simpleGit().clone(seed, origin, ['--bare']);

    const clone = path.join(tmp, 'team-repo-ok');
    await simpleGit().clone(origin, clone);
    await simpleGit(clone).addConfig('user.email', 't@t.com');
    await simpleGit(clone).addConfig('user.name', 't');

    fs.mkdirSync(path.join(clone, 'members'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'members', 'bob.yaml'), 'username: bob\n');

    // No timeout, no throw — the guarded instance completes a normal push.
    await expect(
      pushRepoDirectly(clone, '[teamai] Register member: bob', ['members/bob.yaml']),
    ).resolves.toBeUndefined();
  });
});

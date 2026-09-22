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
import http from 'node:http';
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
      pushRepoDirectly(clone, '[teamai] Register member: alice', ['members/alice.yaml'], { initPush: true }),
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
      pushRepoDirectly(clone, '[teamai] Register member: bob', ['members/bob.yaml'], { initPush: true }),
    ).resolves.toBeUndefined();
  });
});

describe('credential-prompt guard (init-hang regression)', () => {
  // Reproduces the original bug precisely: a push to a remote that requires
  // credentials, with NO credential helper available. Without
  // GIT_TERMINAL_PROMPT=0, git opens an interactive username/password prompt
  // on the tty — and since teamai runs git with no tty, the push hangs
  // forever. With the guard, git fails immediately with "terminal prompts
  // disabled" / "could not read Username".
  //
  // We stand up a local HTTP git endpoint that always answers 401 Unauthorized
  // (demanding Basic auth), then push to it with every credential source
  // stripped: empty HOME, no GIT_CONFIG_GLOBAL, no credential helper. The push
  // must fail fast rather than block on a prompt.
  let server: http.Server;
  let remoteUrl: string;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      // Always require authentication — git will look for a credential, find
      // none, and (without the guard) try to prompt.
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="teamai-test"' });
      res.end('Unauthorized');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
    remoteUrl = `http://127.0.0.1:${addr.port}/team.git`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('a credential-less push to a 401 HTTP remote fails fast instead of prompting', async () => {
    const clone = path.join(tmp, 'credless-clone');
    fs.mkdirSync(clone, { recursive: true });
    const git = simpleGit(clone);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.email', 't@t.com');
    await git.addConfig('user.name', 't');
    await git.addRemote('origin', remoteUrl);
    // An initial commit so `main` exists; pushRepoDirectly then stages and
    // commits the member file itself (otherwise it sees nothing to commit and
    // returns without pushing).
    fs.writeFileSync(path.join(clone, 'README.md'), 'seed\n');
    await git.add(['README.md']);
    await git.commit('seed');
    fs.mkdirSync(path.join(clone, 'members'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'members', 'alice.yaml'), 'username: alice\n');

    // Isolate credentials so git reaches the terminal-prompt path rather than
    // a credential helper: point GIT_CONFIG_GLOBAL at a temp config that clears
    // every helper (`[credential]\thelper =`), plus an empty HOME so no
    // user-level helper is discovered. This is the state that made the old push
    // hang — and the state GIT_TERMINAL_PROMPT=0 exists to rescue.
    const prevHome = process.env.HOME;
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const prevPrompt = process.env.GIT_TERMINAL_PROMPT;
    const isolatedConfig = path.join(tmp, 'no-helper.gitconfig');
    fs.writeFileSync(
      isolatedConfig,
      '[credential]\n\thelper =\n[user]\n\tname = t\n\temail = t@t.com\n',
    );
    process.env.HOME = path.join(tmp, 'empty-home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    process.env.GIT_CONFIG_GLOBAL = isolatedConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    // The CLI sets this process-wide at startup (disableGitTerminalPrompt).
    // This test imports pushRepoDirectly directly, so simulate that here.
    process.env.GIT_TERMINAL_PROMPT = '0';
    // Shrink the init-push block timeout so a hung push is killed in a couple
    // seconds instead of the default 30 (keeps the test fast). initPush:true
    // routes through createGitForInitPush, whose timeout.block actually
    // terminates the spawned git process — the real fix for a push that hangs
    // on a credential prompt or helper.
    const prevInitTimeout = process.env.TEAMAI_INIT_PUSH_TIMEOUT_MS;
    process.env.TEAMAI_INIT_PUSH_TIMEOUT_MS = '3000';

    const start = Date.now();
    try {
      // initPush:true uses createGitForInitPush (spawn-level block timeout),
      // mirroring how init actually calls this. The push must reject within
      // the timeout budget — a regression to no spawn timeout would hang
      // forever (a credential helper/401 can block past any await-only guard).
      await expect(
        pushRepoDirectly(clone, '[teamai] Register member: alice', ['members/alice.yaml'], { initPush: true }),
      ).rejects.toThrow();
    } finally {
      process.env.HOME = prevHome;
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = prevSystem;
      if (prevPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = prevPrompt;
      if (prevInitTimeout === undefined) delete process.env.TEAMAI_INIT_PUSH_TIMEOUT_MS;
      else process.env.TEAMAI_INIT_PUSH_TIMEOUT_MS = prevInitTimeout;
    }
    const elapsed = Date.now() - start;

    // The spawn-level block timeout (3s here) kills the hung push; without it
    // the push would block indefinitely. Allow headroom for git startup.
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);
});

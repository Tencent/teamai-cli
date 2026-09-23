/**
 * Built-CLI repro for the learnings-sync cluster:
 *  - #704: an ordinary `pull` (no --force) must surface a teammate's
 *    contribution even though it never moved the default branch's revision.
 *  - #705: right after `contribute`, the contributor's own `recall` must return
 *    a File path that exists on disk (not the deleted pending-queue path).
 *
 * Real CLI, real git: a local bare origin, two isolated HOMEs. No mocks of the
 * units under test — these bugs only surface through the real pull/contribute/
 * recall wiring (an in-process test would not reproduce them).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(root, 'dist/index.js');
let sandbox: string;

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
}

function machineEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'member',
    GIT_AUTHOR_EMAIL: 'member@example.invalid',
    GIT_COMMITTER_NAME: 'member',
    GIT_COMMITTER_EMAIL: 'member@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    FORCE_COLOR: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: 'always',
  };
}

function runCli(home: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  const env = machineEnv(home);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out\n${output}`));
    }, 45_000);
    const capture = (data: Buffer) => { output += data.toString(); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-learnsync-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('real CLI learnings sync (#704, #705)', () => {
  it('surfaces a teammate contribution on an ordinary pull, and the contributor recall path exists', async () => {
    if (!fs.existsSync(cli)) {
      throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-learnsync-'));
    const origin = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    const homeAlice = path.join(sandbox, 'home-alice');
    const homeBob = path.join(sandbox, 'home-bob');
    const env = machineEnv(homeAlice);

    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'acme',
      repo: origin,
      provider: 'git',
      usageReport: false,
    }));
    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '.'], seed, env);
    git(['commit', '-q', '-m', 'fixture'], seed, env);
    git(['clone', '-q', '--bare', seed, origin], sandbox, env);

    const setupHome = (home: string, username: string) => {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.gitconfig'),
        [
          '[user]',
          `\tname = ${username}`,
          `\temail = ${username}@example.invalid`,
          '[protocol "file"]',
          '\tallow = always',
          '',
        ].join('\n'),
      );
      const clone = path.join(home, '.teamai', 'team-repo');
      git(['clone', '-q', origin, clone], sandbox, env);
      git(['config', 'user.name', username], clone, machineEnv(home));
      git(['config', 'user.email', `${username}@example.invalid`], clone, machineEnv(home));
      git(['config', 'protocol.file.allow', 'always'], clone, machineEnv(home));
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: clone, remote: origin, kind: 'git' },
        username,
        scope: 'user',
        updatePolicy: 'skip',
        enabledAgents: ['claude'],
        additionalRoles: [],
      }));
    };

    setupHome(homeAlice, 'alice');
    setupHome(homeBob, 'bob');

    // Alice pulls first so her state records main's revision (arms the #704 fast
    // path: her next pull sees main unchanged and would short-circuit).
    const alicePull0 = await runCli(homeAlice, ['pull'], sandbox);
    expect(alicePull0.code, alicePull0.output).toBe(0);

    // Bob contributes. The contribution is published to teamai-learnings, which
    // does NOT change main.
    const note = path.join(sandbox, 'note.md');
    fs.writeFileSync(
      note,
      '# Zirconquartz deployment\n\nZirconquartz deployment requires violet-cache validation before restarting workers.\n',
    );
    const bobContribute = await runCli(homeBob, ['contribute', '--file', note, '--title', 'zirconquartz'], sandbox);
    expect(bobContribute.code, bobContribute.output).toBe(0);
    expect(bobContribute.output).toContain('Contributed');

    // #705: Bob's own recall right after contribute must return an existing File.
    const bobRecall = await runCli(homeBob, ['recall', 'zirconquartz'], sandbox);
    expect(bobRecall.code, bobRecall.output).toBe(0);
    const bobFile = bobRecall.output.match(/^File: (.+)$/m)?.[1];
    expect(bobFile, `recall returned no File line:\n${bobRecall.output}`).toBeDefined();
    expect(fs.existsSync(bobFile!), `recall File does not exist: ${bobFile}`).toBe(true);
    // It must NOT be the deleted pending-queue path.
    expect(bobFile).not.toContain(`${path.sep}pending-learnings${path.sep}`);

    // #704: Alice's ORDINARY pull (no --force) must surface Bob's contribution,
    // even though main is unchanged and the pull reports "Already synced".
    const alicePull1 = await runCli(homeAlice, ['pull'], sandbox);
    expect(alicePull1.code, alicePull1.output).toBe(0);
    expect(alicePull1.output).toContain('Already synced');

    const aliceRecall = await runCli(homeAlice, ['recall', 'zirconquartz'], sandbox);
    expect(aliceRecall.code, aliceRecall.output).toBe(0);
    const aliceFile = aliceRecall.output.match(/^File: (.+)$/m)?.[1];
    expect(
      aliceFile,
      `Alice's ordinary pull did not surface Bob's contribution:\n${aliceRecall.output}`,
    ).toBeDefined();
    expect(fs.existsSync(aliceFile!), `Alice recall File does not exist: ${aliceFile}`).toBe(true);
  }, 90_000);
});

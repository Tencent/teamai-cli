/**
 * Built-CLI repro for #1027: `teamai doctor` reports lock files left behind by
 * dead processes, and `teamai doctor --fix` removes exactly those — never a
 * lock a live process still holds, never one that names no owner.
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
    GIT_AUTHOR_NAME: 'alice',
    GIT_AUTHOR_EMAIL: 'alice@example.invalid',
    GIT_COMMITTER_NAME: 'alice',
    GIT_COMMITTER_EMAIL: 'alice@example.invalid',
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

const CHECK_NAME = 'No lock files are left behind by dead processes';

function zombieCheckOf(reportJson: string): { name: string; ok: boolean } | undefined {
  const start = reportJson.indexOf('{');
  const report = JSON.parse(reportJson.slice(start)) as { checks: { name: string; ok: boolean }[] };
  return report.checks.find((c) => c.name === CHECK_NAME);
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-1027-lock-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('real CLI doctor zombie lock cleanup (#1027)', () => {
  it('reports dead-process locks and --fix removes only them', async () => {
    if (!fs.existsSync(cli)) {
      throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1027-lock-'));
    const origin = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    const home = path.join(sandbox, 'home');
    const env = machineEnv(home);

    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'acme',
      repo: origin,
      provider: 'git',
    }));
    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '.'], seed, env);
    git(['commit', '-q', '-m', 'fixture'], seed, env);
    git(['clone', '-q', '--bare', seed, origin], sandbox, env);

    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      [
        '[user]',
        '\tname = alice',
        '\temail = alice@example.invalid',
        '[protocol "file"]',
        '\tallow = always',
        '',
      ].join('\n'),
    );
    const clone = path.join(home, '.teamai', 'team-repo');
    git(['clone', '-q', origin, clone], sandbox, env);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
      repo: { localPath: clone, remote: origin, kind: 'git' },
      username: 'alice',
      scope: 'user',
      updatePolicy: 'skip',
      enabledAgents: ['claude'],
      additionalRoles: [],
    }));

    // A zombie each for a named lock and a per-file lock, a live lock this test
    // process holds, and an ownerless lock nothing may remove (#760).
    const teamai = path.join(home, '.teamai');
    fs.mkdirSync(path.join(teamai, 'user-votes'), { recursive: true });
    const dead1 = path.join(teamai, '.update-lock');
    const dead2 = path.join(teamai, 'user-votes', 'alice.yaml.lock');
    const live = path.join(teamai, '.sync-lock');
    const ownerless = path.join(teamai, 'dashboard', 'events.jsonl.lock');
    fs.mkdirSync(path.join(teamai, 'dashboard'), { recursive: true });
    fs.writeFileSync(dead1, JSON.stringify({ pid: 999999, owner: 'gone', startedAt: 'x' }));
    fs.writeFileSync(dead2, JSON.stringify({ pid: 999999, owner: 'gone', startedAt: 'x' }));
    fs.writeFileSync(live, JSON.stringify({ pid: process.pid, owner: 'me', startedAt: 'x' }));
    fs.writeFileSync(ownerless, '');

    const before = await runCli(home, ['doctor', '--json'], sandbox);
    expect(before.code, before.output).toBe(1);
    const failing = zombieCheckOf(before.output);
    expect(failing?.ok).toBe(false);

    const fixed = await runCli(home, ['doctor', '--fix'], sandbox);
    expect(fixed.output).toContain('Removed 2 lock file(s) left behind by dead processes');

    expect(fs.existsSync(dead1)).toBe(false);
    expect(fs.existsSync(dead2)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(ownerless)).toBe(true);

    const after = await runCli(home, ['doctor', '--json'], sandbox);
    expect(zombieCheckOf(after.output)?.ok).toBe(true);
  }, 120_000);
});

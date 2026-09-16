/**
 * Built-CLI repro for #561: the same member on two machines must not lose
 * session-save entries when machine A already has a reports worktree (from
 * `teamai members`) that is stale relative to origin.
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

function seedSession(home: string, sessionId: string, timestamp: string): void {
  const dashboard = path.join(home, '.teamai', 'dashboard');
  fs.mkdirSync(dashboard, { recursive: true });
  fs.appendFileSync(
    path.join(dashboard, 'events.jsonl'),
    `${JSON.stringify({ type: 'session_start', timestamp, sessionId, tool: 'claude', cwd: sandbox })}\n`,
  );
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-561-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('real CLI reports writer sync (#561)', () => {
  it('keeps every session save from two machines of the same member', async () => {
    if (!fs.existsSync(cli)) {
      throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-561-'));
    const origin = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    const homeA = path.join(sandbox, 'home-a');
    const homeB = path.join(sandbox, 'home-b');
    const env = machineEnv(homeA);

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

    const setupHome = (home: string) => {
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
      git(['config', 'user.name', 'alice'], clone, machineEnv(home));
      git(['config', 'user.email', 'alice@example.invalid'], clone, machineEnv(home));
      git(['config', 'protocol.file.allow', 'always'], clone, machineEnv(home));
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: clone, remote: origin, kind: 'git' },
        username: 'alice',
        scope: 'user',
        updatePolicy: 'skip',
        enabledAgents: ['claude'],
        additionalRoles: [],
      }));
    };

    setupHome(homeA);
    setupHome(homeB);

    // Required precondition: machine A already has a reports worktree.
    const members = await runCli(homeA, ['members'], sandbox);
    expect(members.code, members.output).toBe(0);
    expect(fs.existsSync(path.join(homeA, '.teamai', 'reports-wt', '.git'))).toBe(true);

    const timestamp = '2026-09-16T12:00:00.000Z';
    const save = (home: string, sessionId: string) =>
      runCli(home, ['session', 'save', '--session-id', sessionId, '--push', '--force', '--scope', 'user'], sandbox);

    seedSession(homeB, 'alice-b0', timestamp);
    const b0 = await save(homeB, 'alice-b0');
    expect(b0.code, b0.output).toBe(0);

    seedSession(homeA, 'alice-a1', timestamp);
    const a1 = await save(homeA, 'alice-a1');
    expect(a1.code, a1.output).toBe(0);

    seedSession(homeB, 'alice-b1', timestamp);
    const b1 = await save(homeB, 'alice-b1');
    expect(b1.code, b1.output).toBe(0);

    const monthLog = git(['show', 'teamai-reports:sessions/alice/2026-09.md'], origin, env);
    expect(monthLog).toContain('<!-- teamai:session alice-b0 -->');
    expect(monthLog).toContain('<!-- teamai:session alice-a1 -->');
    expect(monthLog).toContain('<!-- teamai:session alice-b1 -->');
  }, 60_000);
});

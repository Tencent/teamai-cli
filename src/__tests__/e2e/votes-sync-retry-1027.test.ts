/**
 * Built-CLI repro for #1027: when every push of the reports branch fails, the
 * local vote deltas must stay pending (the old code cleared them before the
 * push, so votes never auto-synced again), and the retry after the host
 * recovers must deliver each delta exactly once.
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

function localVotes(home: string): Record<string, unknown> {
  const file = path.join(home, '.teamai', 'user-votes', 'alice.yaml');
  return YAML.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-1027-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('real CLI votes sync retry (#1027)', () => {
  it('keeps vote deltas pending across a failed push and delivers them exactly once on retry', async () => {
    if (!fs.existsSync(cli)) {
      throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-1027-'));
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

    // Pending local votes: one recall + one upvote for doc-a.
    const votesDir = path.join(home, '.teamai', 'user-votes');
    fs.mkdirSync(votesDir, { recursive: true });
    fs.writeFileSync(path.join(votesDir, 'alice.yaml'), YAML.stringify({
      version: 2,
      votes: {
        'doc-a': { recalled_count: 1, upvoted_count: 1, last_recalled_at: '2026-10-01T00:00:00Z' },
      },
      deltas: {
        'doc-a': { recalled_delta: 1, upvoted_delta: 1 },
      },
    }));

    // The team host refuses reports pushes while this flag exists.
    const rejectFlag = path.join(origin, 'reject-reports');
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, `#!/bin/sh
if [ -f "$(dirname "$0")/../reject-reports" ]; then
  echo "reports push rejected" >&2
  exit 1
fi
exit 0
`);
    fs.writeFileSync(rejectFlag, '');
    fs.chmodSync(hook, 0o755);

    // Pull 1: the auto-report's votes push fails. Pull itself still succeeds
    // (the report is best-effort), but the deltas must stay pending (#1027)
    // instead of being cleared by a push that never landed.
    const pull1 = await runCli(home, ['pull'], sandbox);
    expect(pull1.code, pull1.output).toBe(0);
    expect(localVotes(home).deltas).toEqual({
      'doc-a': { recalled_delta: 1, upvoted_delta: 1 },
    });

    // The host recovers; the next pull retries the same deltas…
    fs.rmSync(rejectFlag);
    const pull2 = await runCli(home, ['pull'], sandbox);
    expect(pull2.code, pull2.output).toBe(0);

    // …delivers them exactly once (not doubled by the failed first attempt)…
    const originVotes = YAML.parse(git(['show', 'teamai-reports:votes/alice.yaml'], origin, env));
    expect(originVotes.votes['doc-a']).toMatchObject({ recalled_count: 1, upvoted_count: 1 });
    // …and only then clears the local deltas.
    expect(localVotes(home).deltas).toEqual({});
  }, 120_000);
});

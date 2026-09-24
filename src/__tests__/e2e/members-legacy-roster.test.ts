/**
 * Built-CLI repro for #735: a team whose roster was committed to the default
 * branch by a pre-#489 CLI loses every member from `members list` once the CLI
 * switches to the teamai-reports orphan branch. The default-branch copy must
 * stay readable as an inherited root (the learnings pattern, #485): listed,
 * never copied, never published.
 *
 * Real CLI, real git: a local bare origin, an isolated HOME. No mocks — the
 * bug only surfaces through the real members-list wiring.
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

async function originBranches(origin: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  return (await execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
    cwd: origin, env, encoding: 'utf8', windowsHide: true,
  })).split('\n').filter(Boolean);
}

afterEach(() => {
  if (sandbox && path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('teamai-members-')) {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

describe('real CLI inherited member roster (#735)', () => {
  it('lists the pre-switch roster from the default branch, then the union once reports exist', async () => {
    if (!fs.existsSync(cli)) {
      throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-members-'));
    const origin = path.join(sandbox, 'origin.git');
    const seed = path.join(sandbox, 'seed');
    const home = path.join(sandbox, 'home-alice');
    const env = machineEnv(home);

    // A pre-#489 team: knowledge AND the roster live on the default branch.
    fs.mkdirSync(path.join(seed, 'members'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'acme',
      repo: origin,
      provider: 'git',
      usageReport: false,
    }));
    fs.writeFileSync(path.join(seed, 'members', 'carol.yaml'), YAML.stringify({
      username: 'carol',
      displayName: 'Carol Pre',
      registeredAt: '2025-01-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(seed, 'members', 'dan.yaml'), YAML.stringify({
      username: 'dan',
      registeredAt: '2025-01-02T00:00:00.000Z',
    }));
    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '.'], seed, env);
    git(['commit', '-q', '-m', 'fixture'], seed, env);
    git(['clone', '-q', '--bare', seed, origin], sandbox, env);

    // Alice's machine: clone + local config, no reports branch anywhere yet.
    const clone = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      ['[user]', '\tname = alice', '\temail = alice@example.invalid', '[protocol "file"]', '\tallow = always', ''].join('\n'),
    );
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

    // The #735 repro: the roster exists on main, the reports branch does not.
    const list1 = await runCli(home, ['members', 'list'], sandbox);
    expect(list1.code, list1.output).toBe(0);
    expect(list1.output).toContain('Team members (2)');
    expect(list1.output).toContain('carol');
    expect(list1.output).toContain('Carol Pre');
    expect(list1.output).toContain('dan');
    // Read-only: listing must not publish a reports branch...
    expect(await originBranches(origin, env)).toEqual(['main']);
    // ...and must not copy the roster into the reports worktree.
    const wt = path.join(home, '.teamai', 'reports-wt');
    expect(fs.existsSync(path.join(wt, 'members', 'carol.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(clone, 'members', 'carol.yaml'))).toBe(true);

    // A teammate registers with the new CLI: origin grows a teamai-reports
    // branch carrying bob plus a newer copy of carol than the one on main.
    const reports = path.join(sandbox, 'reports-seed');
    fs.mkdirSync(path.join(reports, 'members'), { recursive: true });
    fs.writeFileSync(path.join(reports, 'members', 'bob.yaml'), YAML.stringify({
      username: 'bob',
      registeredAt: '2025-06-01T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(reports, 'members', 'carol.yaml'), YAML.stringify({
      username: 'carol',
      displayName: 'Carol Branch',
      registeredAt: '2025-01-01T00:00:00.000Z',
    }));
    git(['init', '-q', '-b', 'teamai-reports'], reports, env);
    git(['add', '.'], reports, env);
    git(['commit', '-q', '-m', 'register bob'], reports, env);
    git(['push', '-q', origin, 'teamai-reports'], reports, env);

    // Alice now sees the union, with the reports-branch copy winning for carol.
    const list2 = await runCli(home, ['members', 'list'], sandbox);
    expect(list2.code, list2.output).toBe(0);
    expect(list2.output).toContain('Team members (3)');
    expect(list2.output).toContain('bob');
    expect(list2.output).toContain('dan');
    expect(list2.output).toContain('Carol Branch');
    expect(list2.output).not.toContain('Carol Pre');
  }, 90_000);
});

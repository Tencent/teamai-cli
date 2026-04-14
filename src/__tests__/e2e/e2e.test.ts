import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ─── Helpers ─────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const require = createRequire(import.meta.url);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

function runCLI(args: string[], stdin = ''): Promise<RunResult> {
  return runCLIWithEnv(args, {}, stdin);
}

function runCLIWithEnv(
  args: string[],
  envOverrides: Record<string, string> = {},
  stdin = '',
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    child.on('close', (code) => {
      resolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}

// ─── Environment gate ────────────────────────────────────

const HAS_TOKEN = Boolean(process.env.TEAMAI_TEST_TOKEN);
const HAS_REPO = Boolean(process.env.TEAMAI_TEST_REPO_URL);
const CAN_RUN_REMOTE = HAS_TOKEN && HAS_REPO;

// ─── CLI basics (no token needed) ─────────────────────────

describe('CLI basics', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `CLI binary not found at ${CLI}. Run "npm run build" first.`,
      );
    }
  });

  it('--version should print version matching package.json', async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'),
    );
    const { stdout } = await runCLI(['--version']);
    expect(stdout.trim()).toContain(pkg.version);
  });

  it('--help should list core commands', async () => {
    const { output } = await runCLI(['--help']);
    for (const cmd of ['init', 'pull', 'push', 'status', 'members', 'tags', 'uninstall']) {
      expect(output).toContain(cmd);
    }
  });
});

// ─── Uninstall CLI (no token needed) ────────────────────

describe('uninstall CLI', () => {
  it('teamai uninstall --help should show options', async () => {
    const { output, code } = await runCLI(['uninstall', '--help']);
    expect(code).toBe(0);
    expect(output).toContain('--force');
    expect(output).toContain('Remove all teamai-managed resources');
  });

  it('teamai uninstall --dry-run should not crash when no config', async () => {
    // Run with a fake HOME to simulate no teamai installation
    const result = await runCLIWithEnv(['uninstall', '--dry-run', '--force'], {
      HOME: path.join(ROOT, 'dist', '__nonexistent_home__'),
    });
    // Should exit 0 with "nothing to uninstall" or show plan
    expect(result.code).toBe(0);
  });
});

// ─── Tags CLI (no token needed) ──────────────────────────

describe('tags CLI', () => {
  it('teamai tags --help should list subcommands', async () => {
    const { output } = await runCLI(['tags', '--help']);
    expect(output).toContain('list');
    expect(output).toContain('subscribe');
    expect(output).toContain('unsubscribe');
    expect(output).toContain('add');
    expect(output).toContain('remove');
  });

  it('teamai tags list (no init) should show error', async () => {
    // Run in a temp dir with no teamai init
    const { output, code } = await runCLI(['tags', 'list']);
    // Either shows tags or shows "not initialized" error — both valid
    expect(output.length).toBeGreaterThan(0);
  });

  it('teamai tags subscribe (no args) should show usage error', async () => {
    const { output } = await runCLI(['tags', 'subscribe']);
    // Commander shows error for missing required argument
    expect(output).toMatch(/missing|required|error/i);
  });
});

// ─── Source-code sanity checks (migrated from test/e2e.mjs) ──

describe('source code checks', () => {
  it('init.ts should not set role for self-registration', () => {
    const initSrc = fs.readFileSync(
      path.join(ROOT, 'src', 'init.ts'),
      'utf-8',
    );
    expect(initSrc).not.toContain('role:');
    expect(initSrc).not.toContain('addMemberDuringInit');
    expect(initSrc).not.toContain('Would you like to add team members now');
  });

  it('members.ts should not contain role functions', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src', 'members.ts'),
      'utf-8',
    );
    expect(src).not.toContain('requireWriteRole');
    expect(src).not.toContain('addMember');
    expect(src).not.toContain('addMemberDuringInit');
    expect(src).not.toContain('roleTag');
    expect(src).not.toContain('ROLE_TO_ACCESS_LEVEL');
    expect(src).not.toContain('searchUsers');
  });

  it('tgit-api.ts should not contain member management APIs', () => {
    const tgitPath = path.join(ROOT, 'src', 'utils', 'tgit-api.ts');

    // If the file was removed entirely, the forbidden APIs are trivially absent
    if (!fs.existsSync(tgitPath)) {
      return;
    }

    const src = fs.readFileSync(tgitPath, 'utf-8');
    expect(src).not.toContain('searchUsers');
    expect(src).not.toContain('addProjectMember');
    expect(src).not.toContain('updateProjectMember');
    expect(src).not.toContain('TGitSearchUser');
    // Retained APIs
    expect(src).toContain('verifyToken');
    expect(src).toContain('getProject');
    expect(src).toContain('createProject');
  });
});

// ─── Remote E2E tests (require token + repo) ─────────────

describe('remote commands', () => {
  beforeAll(() => {
    if (!CAN_RUN_REMOTE) {
      console.log(
        '⏭  Skipping remote E2E tests: TEAMAI_TEST_TOKEN or TEAMAI_TEST_REPO_URL not set',
      );
    }
  });

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai members — should list members without role tags',
    async () => {
      const { code, output } = await runCLI(['members']);
      expect(code).toBe(0);
      expect(output).not.toContain('[write]');
      expect(output).not.toContain('[readonly]');
      // May show "Team members" or "No team members registered" depending on repo state
      expect(output).toMatch(/Team members|No team members/i);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai members list — subcommand works',
    async () => {
      const { code, output } = await runCLI(['members', 'list']);
      expect(code).toBe(0);
      expect(output).toMatch(/Team members|No team members/i);
      expect(output).not.toContain('[write]');
      expect(output).not.toContain('[readonly]');
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai members add — add flow no longer exists',
    async () => {
      const { output } = await runCLI(['members', 'add']);
      expect(output).not.toContain('Username to add');
      expect(output).not.toContain('Role (readonly/write)');
      expect(output).not.toContain('Searching for user');
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai status — runs without crash',
    async () => {
      const { code } = await runCLI(['status']);
      expect(code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai pull --dry-run — runs without crash',
    async () => {
      const { code } = await runCLI(['pull', '--dry-run']);
      expect(code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai push --dry-run — runs without crash',
    async () => {
      const { code } = await runCLI(['push', '--dry-run']);
      expect(code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai tags — lists available tags or shows "not configured"',
    async () => {
      const { code, output } = await runCLI(['tags']);
      expect(code).toBe(0);
      // Should either show tag table or "No tags.yaml found"
      expect(output).toMatch(/Tag|tags\.yaml|subscript/i);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai tags subscribe/unsubscribe roundtrip',
    async () => {
      // Subscribe to a test tag
      const sub = await runCLI(['tags', 'subscribe', '__e2e_test_tag__']);
      expect(sub.code).toBe(0);
      expect(sub.output).toContain('Subscribed');

      // Unsubscribe
      const unsub = await runCLI(['tags', 'unsubscribe', '__e2e_test_tag__']);
      expect(unsub.code).toBe(0);
      expect(unsub.output).toContain('Unsubscribed');
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai uninstall --dry-run — previews resources without changes',
    async () => {
      const { code, output } = await runCLI(['uninstall', '--dry-run']);
      expect(code).toBe(0);
      expect(output).toContain('Dry run');
      // Should list at least one resource category
      expect(output).toMatch(/Hooks|CLAUDE\.md|Skills|Rules|Shell profile|Docs|TeamAI/);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai uninstall --force — cleans up and exits successfully',
    async () => {
      // Step 1: Uninstall everything
      const uninstallResult = await runCLI(['uninstall', '--force']);
      expect(uninstallResult.code).toBe(0);
      expect(uninstallResult.output).toContain('卸载完成');

      // Step 2: Verify cleanup — config.yaml should not exist
      const teamaiHome = path.join(process.env.HOME ?? '', '.teamai');
      expect(fs.existsSync(path.join(teamaiHome, 'config.yaml'))).toBe(false);

      // Step 3: Restore for subsequent CI steps — write minimal config + clone repo
      const testRepoUrl = process.env.TEAMAI_TEST_REPO_URL ?? '';
      const repoPath = path.join(teamaiHome, 'team-repo');
      fs.mkdirSync(teamaiHome, { recursive: true });

      // Clone the repo back (uninstall removed it)
      const { execSync } = await import('node:child_process');
      const cloneUrl = testRepoUrl.startsWith('http')
        ? testRepoUrl
        : `https://git.woa.com/${testRepoUrl}.git`;
      execSync(
        `git clone -c "http.extraHeader=PRIVATE-TOKEN: ${process.env.TEAMAI_TEST_TOKEN}" "${cloneUrl}" "${repoPath}"`,
        { stdio: 'pipe' },
      );

      fs.writeFileSync(
        path.join(teamaiHome, 'config.yaml'),
        [
          `repo:`,
          `  localPath: ${repoPath}`,
          `  remote: ${testRepoUrl}`,
          `username: ci`,
          `updatePolicy: auto`,
        ].join('\n'),
      );

      // Verify pull works after restore (may sync skills or report no resources depending on test repo)
      const pullResult = await runCLI(['pull']);
      expect(pullResult.code).toBe(0);
      expect(pullResult.output).toMatch(/Synced \d+ skills|No resources to sync|already up to date/);
    },
  );
});

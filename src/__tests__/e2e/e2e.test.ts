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
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0' },
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
    for (const cmd of ['init', 'pull', 'push', 'status', 'members']) {
      expect(output).toContain(cmd);
    }
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
});

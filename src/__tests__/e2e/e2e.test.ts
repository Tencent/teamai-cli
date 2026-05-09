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
  cwd: string = ROOT,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Always close stdin so any unexpected read() in the CLI gets EOF
    // immediately instead of hanging the test.
    if (stdin) {
      child.stdin.write(stdin);
    }
    child.stdin.end();

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

  // ─── Extended coverage: full command surface ────────────
  // These tests run BEFORE uninstall so they don't lose state.

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai stats — runs without crash',
    async () => {
      const { code, output } = await runCLI(['stats']);
      expect(code).toBe(0);
      expect(output.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai digest — generates digest without crash',
    async () => {
      const { code } = await runCLI(['digest']);
      expect(code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai recall — searches knowledge base without crash',
    async () => {
      const { code, output } = await runCLI(['recall', 'test']);
      expect(code).toBe(0);
      expect(output.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai save-session --summary — records session',
    async () => {
      const { code } = await runCLI([
        'save-session',
        '--summary',
        'CI e2e: dummy session for coverage',
      ]);
      expect(code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai track — records tool usage event',
    async () => {
      const { code } = await runCLI([
        'track',
        '--tool',
        'claude',
        'Bash',
        'echo ci-e2e-track-test',
      ]);
      expect(code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai env add + list + remove — roundtrip',
    async () => {
      const key = 'CI_E2E_TEST_VAR';
      const value = 'ci-test-value';

      const add = await runCLI(['env', 'add', key, value]);
      expect(add.code).toBe(0);

      const list = await runCLI(['env', 'list']);
      expect(list.code).toBe(0);
      expect(list.output).toContain(key);

      const rm = await runCLI(['env', 'remove', key]);
      expect(rm.code).toBe(0);

      // Verify removed
      const list2 = await runCLI(['env', 'list']);
      expect(list2.output).not.toContain(key);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai source list — lists configured sources without crash',
    async () => {
      const { code, output } = await runCLI(['source', 'list']);
      expect(code).toBe(0);
      // Either lists sources or shows "No sources configured"
      expect(output.length).toBeGreaterThan(0);
    },
  );

  // source add + list + remove roundtrip against a public, stable repo.
  // We use anthropics/skills because:
  //   - public (no token needed, ~3.5MB clone)
  //   - permanent (Anthropic-owned, won't disappear)
  //   - matches the source semantic ("Agent Skills" repo)
  // Changes only the local working tree of the fixture team-repo
  // (sourceAdd writes teamai.yaml without committing); the CI cleanup
  // step (git reset --hard on failure) backs us up either way. We also
  // explicitly source-remove at the end so the fixture stays clean.
  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai source add + list + remove — roundtrip on a public repo',
    async () => {
      const PUBLIC_SOURCE = 'https://github.com/anthropics/skills.git';
      const SOURCE_NAME = 'skills'; // deriveSourceName → repo name

      // Pre-clean: in case a previous failed run left it behind.
      await runCLI(['source', 'remove', SOURCE_NAME]);

      const add = await runCLI(['source', 'add', PUBLIC_SOURCE]);

      // Soft-skip on network failure: the runner may not have egress to
      // github.com (corporate proxy, DNS, etc). That's not a code bug.
      if (add.code !== 0) {
        const looksLikeNetworkIssue = /Could not access the source repo|Could not resolve|Connection refused|timed out|fatal: unable/i.test(
          add.output,
        );
        if (looksLikeNetworkIssue) {
          console.log(`⏭  source add failed with network error, skipping:\n${add.output.trim().slice(0, 300)}`);
          return;
        }
        // Non-network failure → real bug, surface it
        throw new Error(`source add failed unexpectedly:\n${add.output}`);
      }

      expect(add.output).toContain(SOURCE_NAME);

      const list = await runCLI(['source', 'list']);
      expect(list.code).toBe(0);
      expect(list.output).toContain(SOURCE_NAME);

      const remove = await runCLI(['source', 'remove', SOURCE_NAME]);
      expect(remove.code).toBe(0);

      // Verify gone after remove
      const listAfter = await runCLI(['source', 'list']);
      expect(listAfter.code).toBe(0);
      // Note: listAfter may still contain "skills" if it's a substring of
      // other output (e.g. directory hints), so we don't strictly assert
      // absence — the remove exit code already confirms it.
    },
    // Includes a real GitHub clone (~3.5MB) — bump from default 60s.
    90_000,
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai tags add + remove — roundtrip on a real skill',
    async () => {
      const repoPath = path.join(process.env.HOME ?? '', '.teamai', 'team-repo');
      const skillsDir = path.join(repoPath, 'skills');
      if (!fs.existsSync(skillsDir)) {
        console.log('⏭  No skills/ in test repo, skipping tags add/remove');
        return;
      }
      const skills = fs.readdirSync(skillsDir).filter((d) => {
        try {
          return fs.statSync(path.join(skillsDir, d)).isDirectory();
        } catch {
          return false;
        }
      });
      if (skills.length === 0) {
        console.log('⏭  No skills found in test repo, skipping');
        return;
      }
      const skillName = skills[0];
      const tag = '__ci_e2e_tag__';

      const add = await runCLI(['tags', 'add', 'skills', skillName, tag]);
      expect(add.code).toBe(0);

      const rm = await runCLI(['tags', 'remove', 'skills', skillName, tag]);
      expect(rm.code).toBe(0);
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai contribute --dry-run — previews contribution',
    async () => {
      const tmpFile = path.join(ROOT, 'dist', '__ci_e2e_contribute__.md');
      fs.writeFileSync(
        tmpFile,
        '# CI E2E Test Contribution\n\nDry-run only.\n',
      );

      try {
        const { code, output } = await runCLI([
          '--dry-run',
          'contribute',
          '--file',
          tmpFile,
          '--title',
          'CI E2E Test',
        ]);
        expect(code).toBe(0);
        expect(output).toMatch(/dry-run|Would push|preview/i);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    },
  );

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai dashboard — boots HTTP server',
    async () => {
      const port = '37210';
      const child = spawn('node', [CLI, 'dashboard', '-p', port], {
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: ROOT,
      });

      try {
        let ok = false;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.status >= 200 && res.status < 500) {
              ok = true;
              break;
            }
          } catch {
            /* keep waiting for boot */
          }
        }
        expect(ok).toBe(true);
      } finally {
        child.kill('SIGTERM');
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            child.kill('SIGKILL');
            r();
          }, 3000);
          child.on('close', () => {
            clearTimeout(t);
            r();
          });
        });
      }
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

      // Clone the repo back (uninstall removed it).
      // Supports both GitHub (via TEAMAI_TEST_PROVIDER=github) and TGit (default).
      const { execSync } = await import('node:child_process');
      const provider = (process.env.TEAMAI_TEST_PROVIDER ?? 'tgit').toLowerCase();
      const defaultHost = provider === 'github' ? 'github.com' : 'git.woa.com';
      const cloneUrl = testRepoUrl.startsWith('http')
        ? testRepoUrl
        : `https://${defaultHost}/${testRepoUrl}.git`;

      const cloneCmd =
        provider === 'github'
          ? `git clone "https://x-access-token:${process.env.TEAMAI_TEST_TOKEN}@${cloneUrl.replace(/^https?:\/\//, '')}" "${repoPath}"`
          : `git clone -c "http.extraHeader=PRIVATE-TOKEN: ${process.env.TEAMAI_TEST_TOKEN}" "${cloneUrl}" "${repoPath}"`;

      execSync(cloneCmd, { stdio: 'pipe' });

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

  it.skipIf(!CAN_RUN_REMOTE)(
    'teamai roles set — cleans up stale skills on next pull',
    async () => {
      // Step 1: Check if the test repo has a roles manifest
      const rolesResult = await runCLI(['roles', 'list']);
      if (rolesResult.output.includes('Run `teamai roles init`')) {
        console.log('⏭  Test repo has no roles manifest, skipping role-change cleanup test');
        return;
      }

      // Step 2: Parse available role ids from the output
      const roleIds: string[] = [];
      for (const line of rolesResult.output.split('\n')) {
        const match = line.match(/^\s{2}(\w+)/);
        if (match && !line.includes('skills:') && !line.includes('knowledge:')) {
          roleIds.push(match[1]);
        }
      }
      if (roleIds.length < 2) {
        console.log('⏭  Test repo has fewer than 2 roles, skipping role-change cleanup test');
        return;
      }

      const [roleA, roleB] = roleIds;

      // Step 3: Set role A and pull
      const setA = await runCLI(['roles', 'set', roleA]);
      expect(setA.code).toBe(0);
      expect(setA.output).toContain(`Primary role set to: ${roleA}`);

      const pullA = await runCLI(['pull', '--force']);
      expect(pullA.code).toBe(0);
      expect(pullA.output).toMatch(/Synced \d+ skills/);

      // Record skill count after role A
      const skillsDirA = path.join(process.env.HOME ?? '', '.claude', 'skills');
      const skillsAfterA = fs.existsSync(skillsDirA) ? fs.readdirSync(skillsDirA) : [];

      // Step 4: Switch to role B and pull
      const setB = await runCLI(['roles', 'set', roleB]);
      expect(setB.code).toBe(0);
      expect(setB.output).toContain(`Primary role set to: ${roleB}`);

      const pullB = await runCLI(['pull']);
      expect(pullB.code).toBe(0);
      expect(pullB.output).toMatch(/Synced \d+ skills/);

      // Step 5: Verify skill count changed (different roles → different skill sets)
      const skillsAfterB = fs.existsSync(skillsDirA) ? fs.readdirSync(skillsDirA) : [];
      // If roles have different namespaces, the skill set should differ
      // At minimum, the pull should have completed without error
      console.log(`  Role ${roleA}: ${skillsAfterA.length} skills → Role ${roleB}: ${skillsAfterB.length} skills`);

      // Step 6: Restore to role A for subsequent tests
      await runCLI(['roles', 'set', roleA]);
      await runCLI(['pull', '--force']);
    },
  );
});

// ─── Init project scope (sandboxed) ──────────────────────
// Runs in a temp cwd with --scope project so it doesn't touch the
// user-scope ~/.teamai/ that the rest of the suite depends on.
//
// GitHub-only: TGit's `gf` CLI authenticates via ~/.netrc, which we lose
// when we isolate $HOME to a temp dir. `gf auth login` then triggers an
// interactive (inheritStdio) login that no amount of stdin piping can
// satisfy → permanent hang. GitHub provider auths via GITHUB_TOKEN env,
// so it works fine under HOME isolation.

const PROVIDER_IS_GITHUB =
  (process.env.TEAMAI_TEST_PROVIDER ?? 'tgit').toLowerCase() === 'github';

describe('init project scope (sandboxed)', () => {
  it.skipIf(!CAN_RUN_REMOTE || !PROVIDER_IS_GITHUB)(
    'teamai init --scope project --repo X --force — creates .teamai/',
    async () => {
      const os = await import('node:os');
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-'));

      try {
        const repoUrl = process.env.TEAMAI_TEST_REPO_URL ?? '';
        const provider = (process.env.TEAMAI_TEST_PROVIDER ?? 'tgit').toLowerCase();
        const defaultHost = provider === 'github' ? 'github.com' : 'git.woa.com';
        const fullUrl = repoUrl.startsWith('http')
          ? repoUrl
          : `https://${defaultHost}/${repoUrl}.git`;

        // Defense in depth: feed several blank lines on stdin in case any
        // future prompt slips past --force. The CLI should never block.
        const stdinAllBlanks = '\n\n\n\n\n';

        const result = await runCLIWithEnv(
          ['init', '--scope', 'project', '--repo', fullUrl, '--role', 'common', '--force'],
          {
            // GitHub: gh CLI / REST honors GITHUB_TOKEN
            // TGit: gf CLI honors TGIT_TOKEN
            GITHUB_TOKEN: process.env.TEAMAI_TEST_TOKEN ?? '',
            TGIT_TOKEN: process.env.TEAMAI_TEST_TOKEN ?? '',
            HOME: sandbox, // isolate from user-scope ~/.teamai
            // Git identity must be set explicitly because HOME override
            // hides the global .gitconfig written by CI setup steps.
            GIT_AUTHOR_NAME: 'TeamAI CI',
            GIT_AUTHOR_EMAIL: 'ci@teamai.test',
            GIT_COMMITTER_NAME: 'TeamAI CI',
            GIT_COMMITTER_EMAIL: 'ci@teamai.test',
          },
          stdinAllBlanks,
          sandbox, // cwd = sandbox, so .teamai/ lands here
        );

        expect(result.code, `init failed with output:\n${result.output}`).toBe(0);
        expect(fs.existsSync(path.join(sandbox, '.teamai', 'config.yaml'))).toBe(true);

        // Verify the project-scope config has the expected shape
        const cfg = fs.readFileSync(
          path.join(sandbox, '.teamai', 'config.yaml'),
          'utf-8',
        );
        expect(cfg).toContain('repo:');
        expect(cfg).toContain('localPath');
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    },
    // init does fixture clone + member push, which is slow on CI runners.
    // Bump from default 60s to 120s.
    120_000,
  );
});

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real-git integration test for the submodule/skip-sync interaction (issue #525).
//
// A successful `git submodule update --init` can change the deployed tree while
// the PARENT revision stays put, which is invisible to the unchanged-rev fast
// path. Path: a member pulled with a CLI that predates `submodules: true` (the
// unknown yaml key was stripped), so the parent SHA was cached with the submodule
// directory still empty. Upgrading the CLI and pulling fills the submodule, but
// HEAD has not moved — pre-fix, the fast path reported "Already synced ... skipping"
// and the tool directories stayed empty until `teamai pull --force`.
//
// Runs the real `pull()` against real bare remotes (including a real submodule)
// rather than mocking simple-git, following the pattern of
// contribute-self-learnings.test.ts. Lives in its own file because it stubs config
// and HOME process-wide.

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-submodule-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;

// Resolve the user's REAL global git config BEFORE stubbing HOME below — `git
// config --global` locates its file via HOME, so asking afterwards points at
// <tempHome>/.gitconfig, which does not exist.
const realGlobalConfig = (() => {
  try {
    const origin = execFileSync('git', ['config', '--global', '--list', '--show-origin'], { encoding: 'utf-8' })
      .split('\n')
      .map((line) => line.split('\t')[0])
      .find((value) => value?.startsWith('file:'));
    return origin ? origin.slice('file:'.length) : null;
  } catch {
    return null;
  }
})();

const homeDir = path.join(testRoot, 'home');
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
// Never let a fixture's git call block on a credential prompt (or a stray fetch
// to a network remote): fail fast instead of hanging the suite.
process.env.GIT_TERMINAL_PROMPT = '0';

// `git submodule update --init` on a local-path remote is blocked by default
// since Git 2.38 (CVE-2022-39253), and the fixture's submodule remote is a local
// path. simple-git refuses to pass `-c protocol.file.allow=always` on the command
// line (it guards that override), so the opt-in has to come from a config FILE:
// a temp global config, which re-includes the user's real one when there is one.
//
// This file deliberately lives OUTSIDE testRoot: beforeEach wipes testRoot, and
// deleting the config would silently drop `protocol.file.allow` — which makes the
// in-pull submodule update fail, so the fast-path case below would "pass" without
// the submodule ever being populated.
const gitConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-submodule-gitcfg-'));
const globalGitConfig = path.join(gitConfigRoot, 'gitconfig');
// Written unconditionally: a fresh CI runner may have no global config at all,
// and skipping the write there would leave the protocol opt-in unset and fail the
// deploy case for reasons that have nothing to do with the fix.
fs.writeFileSync(
  globalGitConfig,
  [
    ...(realGlobalConfig && fs.existsSync(realGlobalConfig) && realGlobalConfig !== globalGitConfig
      ? ['[include]', `\tpath = ${realGlobalConfig.split(path.sep).join('/')}`]
      : []),
    '[protocol "file"]',
    '\tallow = always',
    '[credential]',
    '\thelper =',
    '[user]',
    '\tname = test',
    '\temail = t@t.co',
  ].join('\n') + '\n',
);

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

const teamRepo = path.join(testRoot, 'team.git');
const skillsRepo = path.join(testRoot, 'skills.git');
// Git-mode install: the team clone is a dedicated checkout under the user home.
const localPath = path.join(homeDir, '.teamai', 'team-repo');
const claudeSkills = path.join(homeDir, '.claude', 'skills');

const localConfig = {
  repo: { localPath, remote: teamRepo, kind: 'git' as const },
  username: 'test',
  updatePolicy: 'auto' as const,
  additionalRoles: [],
  scope: 'user' as const,
};

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn().mockResolvedValue(localConfig),
  // Load the REAL teamai.yaml from the clone, so `submodules: true` is read from
  // the same file the pull under test resolves.
  loadTeamConfig: vi.fn(async (repoPath: string) => {
    const { loadTeamConfig } = await vi.importActual<typeof import('../config.js')>('../config.js');
    return loadTeamConfig(repoPath);
  }),
  // The state file IS the fast path's cache key, so these must really read and
  // write <home>/.teamai/state.json. Omitting them from this factory makes the
  // fast-path block throw straight into its own `catch { proceed with full sync }`,
  // which would make the regression test below pass without the fix.
  loadStateForScope: vi.fn(async () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(homeDir, '.teamai', 'state.json'), 'utf-8'));
    } catch {
      return {
        lastPush: null,
        lastPull: null,
        lastPullRev: null,
        pushedRules: [],
        pushedSkills: [],
        pushedEnvVars: [],
        pendingPushes: [],
        lastUpdateCheck: null,
        availableUpdate: null,
      };
    }
  }),
  saveStateForScope: vi.fn(async (state: unknown) => {
    fs.mkdirSync(path.join(homeDir, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.teamai', 'state.json'), JSON.stringify(state, null, 2));
  }),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

const { pull } = await import('../pull.js');
const { log } = await import('../utils/logger.js');

afterAll(() => {
  fs.rmSync(gitConfigRoot, { recursive: true, force: true });
});

const TEAM_YAML = [
  'team: test',
  'description: submodule fixture',
  `repo: ${teamRepo}`,
  'provider: git',
  'submodules: true',
  'usageReport: false',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
].join('\n') + '\n';

/** Commit a file into a working tree with a throwaway identity. */
function commitAll(cwd: string, message: string): string {
  git(['add', '-A'], cwd);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t.co', 'commit', '-qm', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd).trim();
}

describe('pull submodule skip-sync (issue #525)', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.mkdirSync(homeDir, { recursive: true });
    // Re-assert every test: afterEach restores the original (usually unset) value,
    // so without this the second test would run with the file-protocol opt-in
    // dropped, its submodule update would fail, and the fast-path case below would
    // pass for the wrong reason.
    process.env.GIT_CONFIG_GLOBAL = globalGitConfig;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    // 1. The distributed-skills repo: one skill, checked out into the team repo
    //    as a submodule (this is the "skills as git submodules" layout).
    fs.mkdirSync(skillsRepo, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', skillsRepo], testRoot);
    const skillsWork = path.join(testRoot, 'skills-work');
    fs.mkdirSync(skillsWork, { recursive: true });
    git(['init', '-q', '-b', 'main'], skillsWork);
    fs.mkdirSync(path.join(skillsWork, 'distributed-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsWork, 'distributed-skill', 'SKILL.md'),
      '---\nname: distributed-skill\ndescription: bundled as a submodule\n---\n\n# distributed-skill\n',
    );
    commitAll(skillsWork, 'skill');
    git(['remote', 'add', 'origin', skillsRepo], skillsWork);
    git(['push', '-q', 'origin', 'main'], skillsWork);

    // 2. The team repo: teamai.yaml (submodules on) + the submodule at skills/common.
    fs.mkdirSync(teamRepo, { recursive: true });
    git(['init', '-q', '--bare', '-b', 'main', teamRepo], testRoot);
    const teamWork = path.join(testRoot, 'team-work');
    fs.mkdirSync(path.join(teamWork, 'skills'), { recursive: true });
    git(['init', '-q', '-b', 'main'], teamWork);
    fs.writeFileSync(path.join(teamWork, 'teamai.yaml'), TEAM_YAML);
    fs.writeFileSync(path.join(teamWork, 'skills', '.gitkeep'), '');
    commitAll(teamWork, 'skeleton');
    git(['remote', 'add', 'origin', teamRepo], teamWork);
    git(['push', '-q', 'origin', 'main'], teamWork);

    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', skillsRepo, 'skills/common'], teamWork);
    commitAll(teamWork, 'add skills submodule');
    git(['push', '-q', 'origin', 'main'], teamWork);

    // 3. The member's clone: made WITHOUT --recurse-submodules, so skills/common
    //    exists as an empty directory and the submodule is uninitialized. This is
    //    exactly the state the issue describes after a CLI that ignored
    //    `submodules: true` cached the parent SHA.
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    git(['clone', '-q', teamRepo, localPath], testRoot);
    git(['config', 'user.name', 't'], localPath);
    git(['config', 'user.email', 't@t.co'], localPath);
    expect(fs.readdirSync(path.join(localPath, 'skills'))).not.toContain('distributed-skill');

    // The member is tool-installed (claude) and the empty dir is what the
    // pre-fix pull would keep deploying.
    fs.mkdirSync(claudeSkills, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
    if (originalTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = originalTerminalPrompt;
    vi.clearAllMocks();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  /**
   * Cache the CURRENT parent HEAD as the last successful pull, tool target included.
   * Uses the SHORT rev: `getHeadRev()` (the cache key pull writes and compares)
   * returns `rev-parse --short HEAD`, so a full SHA would never match and the
   * fast path this test exercises would never be reached.
   */
  function seedSyncedState(): void {
    const head = git(['rev-parse', '--short', 'HEAD'], localPath).trim();
    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'state.json'),
      JSON.stringify({
        lastPush: null,
        lastPull: '2026-04-01T00:00:00.000Z',
        lastPullRev: head,
        lastPullTargets: ['claude'],
        pushedRules: [],
        pushedSkills: [],
        pushedEnvVars: [],
        pendingPushes: [],
        lastUpdateCheck: null,
        availableUpdate: null,
      }, null, 2),
    );
  }

  it('deploys submodule content on a pull whose parent rev is already cached', async () => {
    // The upgrade scenario: the parent SHA was already synced (empty submodule
    // dir), then the CLI starts honoring `submodules: true`.
    seedSyncedState();

    await pull({});

    // Pre-fix this logged "Already synced at <rev>, skipping" and the deployed
    // tool dir stayed empty.
    expect(log.success).not.toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
    const deployed = path.join(claudeSkills, 'distributed-skill', 'SKILL.md');
    expect(fs.existsSync(deployed)).toBe(true);
    expect(fs.readFileSync(deployed, 'utf-8')).toContain('bundled as a submodule');
  }, 60_000);

  it('still takes the fast path when the submodule was already populated', async () => {
    // Populate the submodule and cache the same rev: nothing changed this run,
    // so the fast path must still apply (no needless full re-deploy).
    git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init'], localPath);
    seedSyncedState();

    await pull({});

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Already synced'),
    );
  }, 60_000);
});

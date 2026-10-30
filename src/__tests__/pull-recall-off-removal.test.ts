import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  // The history proof of an unrecorded copy reads the team repo (#993).
  createGit: (await importOriginal<typeof import('../utils/git.js')>()).createGit,
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig } from '../config.js';
import { log } from '../utils/logger.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

// Each test walks real pull()s. Under CI's parallel load one pull can take
// seconds, so every test carries its own generous timeout instead of the
// 15s default (#1501).
const SLOW = 120_000;

describe('pull removes the recall agent and rule once recall resolves off (#1501)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let recallEnabled: boolean | undefined;
  let teamRecallEnabled: boolean;

  function configFor(): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: undefined,
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      recallEnabled,
    } as LocalConfig;
  }

  function teamConfigFor(): TeamaiConfig {
    return {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
        recall: { enabled: teamRecallEnabled },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', agents: '.claude/agents' },
        codex: { skills: '.codex/skills', rules: '.codex/rules', agents: '.codex/agents' },
      },
    } as TeamaiConfig;
  }

  const claudeRule = (): string => path.join(homeDir, '.claude', 'rules', 'teamai-recall.md');
  const claudeAgent = (): string => path.join(homeDir, '.claude', 'agents', 'teamai-recall.md');
  const codexRule = (): string => path.join(homeDir, '.codex', 'rules', 'teamai-recall.md');

  /** A recall-on pull, asserted to install both, so a later miss points at removal. */
  async function pullWithRecallOn(): Promise<void> {
    await pull({});
    expect(await fse.pathExists(claudeRule())).toBe(true);
    expect(await fse.pathExists(claudeAgent())).toBe(true);
  }

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-recall-off-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'noop.md'), '# noop\n');

    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));

    recallEnabled = undefined;
    teamRecallEnabled = true;
    delete process.env.TEAMAI_RECALL_DISABLED;

    vi.stubEnv('HOME', homeDir);
    vi.mocked(loadLocalConfigForScope).mockImplementation(async () => configFor());
    vi.mocked(loadTeamConfig).mockImplementation(async () => teamConfigFor());
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.TEAMAI_RECALL_DISABLED;
    await fse.remove(tmpDir).catch(() => undefined);
  });

  it('the member switch recallEnabled: false removes both, and recall on again writes both back', async () => {
    await pullWithRecallOn();

    recallEnabled = false;
    await pull({});
    expect(await fse.pathExists(claudeRule())).toBe(false);
    expect(await fse.pathExists(claudeAgent())).toBe(false);
    expect(await fse.pathExists(codexRule())).toBe(false);

    recallEnabled = true;
    await pull({});
    expect(await fse.pathExists(claudeRule())).toBe(true);
    expect(await fse.pathExists(claudeAgent())).toBe(true);
  }, SLOW);

  it('the environment switch TEAMAI_RECALL_DISABLED=1 removes both', async () => {
    await pullWithRecallOn();

    process.env.TEAMAI_RECALL_DISABLED = '1';
    await pull({});
    expect(await fse.pathExists(claudeRule())).toBe(false);
    expect(await fse.pathExists(claudeAgent())).toBe(false);
  }, SLOW);

  it('the team switch sharing.recall.enabled: false, member key unset, removes both', async () => {
    await pullWithRecallOn();

    teamRecallEnabled = false;
    await pull({});
    expect(await fse.pathExists(claudeRule())).toBe(false);
    expect(await fse.pathExists(claudeAgent())).toBe(false);
  }, SLOW);

  it('keeps a member-edited copy and says so once', async () => {
    await pullWithRecallOn();
    await fse.appendFile(claudeRule(), '\nA member note.\n');
    await fse.appendFile(claudeAgent(), '\nA member note.\n');

    recallEnabled = false;
    vi.mocked(log.info).mockClear();
    await pull({});

    // The edited copies stay, each named once.
    expect(await fse.pathExists(claudeRule())).toBe(true);
    expect(await fse.pathExists(claudeAgent())).toBe(true);
    const keptLines = vi.mocked(log.info).mock.calls.map((c) => c.join(' ')).filter((t) => t.startsWith('Kept '));
    expect(keptLines.some((t) => t.includes(claudeRule()))).toBe(true);
    expect(keptLines.some((t) => t.includes(claudeAgent()))).toBe(true);
    for (const file of [claudeRule(), claudeAgent()]) {
      expect(keptLines.filter((t) => t.includes(file))).toHaveLength(1);
    }

    // The unedited rule of the other tool is gone.
    expect(await fse.pathExists(codexRule())).toBe(false);
  }, SLOW);
});

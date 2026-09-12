import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

const mockAutoDetectInit = vi.fn();
const mockSaveLocalConfigForScope = vi.fn();

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  saveLocalConfigForScope: (...args: unknown[]) => mockSaveLocalConfigForScope(...args),
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
}));

import { recallDisable, recallEnable } from '../recall-toggle.js';
import { TEAMAI_RECALL_RULES_START } from '../types.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('recall toggle native agent cleanup', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-toggle-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
    vi.stubEnv('HOME', homeDir);

    const localConfig: LocalConfig = {
      repo: {
        localPath: path.join(tmpDir, 'team-repo'),
        remote: 'https://example.com/test/repo.git',
      },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };
    const teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        codex: { agents: '.codex/agents' },
      },
    } as TeamaiConfig;
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('enable then disable removes the Codex TOML recall agent without leaving an orphan', async () => {
    const tomlAgent = path.join(homeDir, '.codex', 'agents', 'teamai-recall.toml');
    const legacyMarkdownAgent = path.join(homeDir, '.codex', 'agents', 'teamai-recall.md');

    await recallEnable({});
    expect(await fse.pathExists(tomlAgent)).toBe(true);
    await fse.writeFile(legacyMarkdownAgent, 'legacy recall agent');

    await recallDisable({});
    expect(await fse.pathExists(tomlAgent)).toBe(false);
    expect(await fse.pathExists(legacyMarkdownAgent)).toBe(false);
  });

  it('disable preserves non-agent files that only share the recall stem', async () => {
    const backup = path.join(homeDir, '.codex', 'agents', 'teamai-recall.backup');
    await fse.writeFile(backup, 'user backup');

    await recallDisable({});

    expect(await fse.readFile(backup, 'utf8')).toBe('user backup');
  });
});

// `enabledAgents` (from `teamai init --agent`) is documented as gating the CLI
// built-in skills/rules/agents and CLAUDE.md-class injects. recallEnable deploys
// all four, but only the first three went through the whitelist — the CLAUDE.md
// recall block was still injected into excluded tools. Same loop and guard as
// injectRecallBlockIntoTools (src/pull.ts).
describe('recall toggle honors the enabledAgents whitelist', () => {
  let tmpDir: string;
  let homeDir: string;
  let claudeMd: string;
  let teamConfig: TeamaiConfig;

  const claudePaths = {
    skills: '.claude/skills',
    rules: '.claude/rules',
    agents: '.claude/agents',
    claudemd: '.claude/CLAUDE.md',
  };

  /** Stub autoDetectInit for a given whitelist, Claude installed either way. */
  function stubWhitelist(enabledAgents: string[]): void {
    const localConfig: LocalConfig = {
      repo: {
        localPath: path.join(tmpDir, 'team-repo'),
        remote: 'https://example.com/test/repo.git',
      },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents,
      recallEnabled: true,
    };
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-whitelist-'));
    homeDir = path.join(tmpDir, 'home');
    // An already-installed Claude: the root exists, so only the whitelist can
    // keep recall out of it.
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    vi.stubEnv('HOME', homeDir);
    claudeMd = path.join(homeDir, '.claude', 'CLAUDE.md');

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://example.com/test/repo.git',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: { claude: claudePaths },
    } as unknown as TeamaiConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('does not inject the recall block into a tool outside enabledAgents', async () => {
    stubWhitelist(['codex']);

    await recallEnable({});

    const content = await fse.pathExists(claudeMd)
      ? await fse.readFile(claudeMd, 'utf8')
      : '';
    expect(content).not.toContain(TEAMAI_RECALL_RULES_START);
  });

  it('injects the recall block for a tool inside enabledAgents', async () => {
    // Same harness, Claude opted in — so the case above skips for the right
    // reason rather than the fixture never injecting at all.
    stubWhitelist(['claude']);

    await recallEnable({});

    expect(await fse.readFile(claudeMd, 'utf8')).toContain(TEAMAI_RECALL_RULES_START);
  });
});

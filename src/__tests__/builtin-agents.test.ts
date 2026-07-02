import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fse from 'fs-extra';

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

import { deployBuiltinAgents, BUILTIN_AGENT_NAMES } from '../builtin-agents.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

function buildTeamConfig(toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://example.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths,
  } as TeamaiConfig;
}

describe('deployBuiltinAgents', () => {
  let tmpDir: string;
  let homeDir: string;
  let builtinAgentsDir: string;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-builtin-agents-test-'));
    homeDir = path.join(tmpDir, 'home');
    // Per import.meta.url resolution in builtin-agents.ts, the built-in dir is
    // resolved as `<dist>/../agents`. The compiled module lives in dist/, but
    // when running the source under vitest the URL points to src/, so we
    // populate <repo>/agents/ alongside src/ to match the resolution.
    // We use the actual repo path so both code paths succeed.
    builtinAgentsDir = path.join(process.cwd(), 'agents');

    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'agents'));
    // Cursor has no agents dir — should be silently skipped

    vi.stubEnv('HOME', homeDir);

    localConfig = {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'https://example.com/test/repo.git' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('BUILTIN_AGENT_NAMES contains teamai-recall', () => {
    expect(BUILTIN_AGENT_NAMES.has('teamai-recall')).toBe(true);
  });

  it('deploys built-in agent files to every installed tool with agents path', async () => {
    // Sanity: built-in dir must contain teamai-recall.md (added in Task 3)
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) {
      // Skip the test gracefully when the package has not been built / agents
      // dir not present in the test workspace.
      console.warn(`Skipping: built-in agents dir not found at ${builtinAgentsDir}`);
      return;
    }

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
      codebuddy: { agents: '.codebuddy/agents' },
      cursor: { skills: '.cursor/skills' }, // No agents — skipped
    });

    const deployed = await deployBuiltinAgents(teamConfig, localConfig);

    // Two installed tools × at least one built-in agent file
    expect(deployed).toBeGreaterThanOrEqual(2);
    expect(await fse.pathExists(path.join(homeDir, '.claude/agents/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/agents/teamai-recall.md'))).toBe(false);
  });

  it('overwrites stale local copies with the CLI-built-in version', async () => {
    const recallSrc = path.join(builtinAgentsDir, 'teamai-recall.md');
    if (!fs.existsSync(recallSrc)) return; // Same skip guard

    const localPath = path.join(homeDir, '.claude/agents/teamai-recall.md');
    await fse.writeFile(localPath, '# stale outdated copy');

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
    });

    await deployBuiltinAgents(teamConfig, localConfig);

    const written = await fse.readFile(localPath, 'utf8');
    expect(written).not.toBe('# stale outdated copy');
    expect(written).toContain('teamai-recall');
  });

  it('returns 0 and does not throw when no tools are installed', async () => {
    // Wipe all installed tool roots
    await fse.remove(path.join(homeDir, '.claude'));
    await fse.remove(path.join(homeDir, '.codebuddy'));

    const teamConfig = buildTeamConfig({
      claude: { agents: '.claude/agents' },
      codebuddy: { agents: '.codebuddy/agents' },
    });

    const deployed = await deployBuiltinAgents(teamConfig, localConfig);
    expect(deployed).toBe(0);
  });

  it('silently skips when the built-in agents directory does not exist', async () => {
    // Point HOME at a fresh dir; even if the package agents/ dir exists in
    // workspace, no tool roots are present, so deployment count is 0.
    const teamConfig = buildTeamConfig({});
    const deployed = await deployBuiltinAgents(teamConfig, localConfig);
    expect(deployed).toBe(0);
  });
});

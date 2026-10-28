import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { shipped, shippedSkillDigestsMock } from './helpers/shipped-skills.js';

// A CLI-owned file is one whose content a release shipped; `shipped()` is it here.
vi.mock('../packaged-skill-digests.js', () => shippedSkillDigestsMock());

const mockAutoDetectInit = vi.fn();
const mockSaveLocalConfigForScope = vi.fn();

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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

import { recallDisable, recallEnable, recallStatus } from '../recall-toggle.js';
import { loadStateForScope, saveStateForScope } from '../config.js';
import { isRecallEnabled, TeamaiConfigSchema, TEAMAI_RECALL_RULES_START } from '../types.js';
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

  it('disable removes the legacy share skill an earlier release deployed, and nothing beside it', async () => {
    const { localConfig, teamConfig } = await mockAutoDetectInit();
    mockAutoDetectInit.mockResolvedValue({
      localConfig,
      teamConfig: { ...teamConfig, toolPaths: { codex: { agents: '.codex/agents', skills: '.codex/skills' } } },
    });
    const skillsDir = path.join(homeDir, '.codex', 'skills');
    for (const name of ['teamai-share-learnings', 'team-wiki-codebase', 'teamai', 'my-own']) {
      await fse.ensureDir(path.join(skillsDir, name));
      await fse.writeFile(path.join(skillsDir, name, 'SKILL.md'), name === 'my-own' ? '# mine' : shipped(name, 'SKILL.md'));
    }

    await recallDisable({});

    // Upgrade, then `recall disable` before the first pull: the old share
    // workflow must not stay discoverable. The stub and the user's skills are
    // not recall artifacts; the wiki tree is pull's to remove.
    expect(await fse.pathExists(path.join(skillsDir, 'teamai-share-learnings'))).toBe(false);
    for (const kept of ['team-wiki-codebase', 'teamai', 'my-own']) {
      expect(await fse.pathExists(path.join(skillsDir, kept, 'SKILL.md')), kept).toBe(true);
    }
  });

  it('disable preserves non-agent files that only share the recall stem', async () => {
    const backup = path.join(homeDir, '.codex', 'agents', 'teamai-recall.backup');
    await fse.writeFile(backup, 'user backup');

    await recallDisable({});

    expect(await fse.readFile(backup, 'utf8')).toBe('user backup');
  });

  it('keeps OpenCode registered when malformed recall markers block an edit of a file with other instructions', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const configFile = path.join(projectRoot, '.opencode', 'opencode.json');
    const entry = '.opencode/teamai-context.md';
    const contextFile = path.join(projectRoot, entry);
    const original = `<!-- [teamai:culture:start] -->\nCulture\n<!-- [teamai:culture:end] -->\n${TEAMAI_RECALL_RULES_START}\nIncomplete recall\n`;
    await fse.outputFile(contextFile, original);
    await fse.outputJson(configFile, { instructions: [entry] });
    const localConfig = { repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'https://example.invalid/t.git' },
      username: 'u', scope: 'project', projectRoot, enabledAgents: ['opencode'], additionalRoles: [],
    } as LocalConfig;
    const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/t.git' });
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });
    await saveStateForScope({ ...await loadStateForScope(localConfig), opencodeContextEntries: [{ config: configFile, entry }] }, localConfig);
    await recallDisable({});
    expect(await fse.readFile(contextFile, 'utf8')).toBe(original);
    expect((await fse.readJson(configFile)).instructions).toEqual([entry]);
    expect((await loadStateForScope(localConfig)).opencodeContextEntries).toEqual([{ config: configFile, entry }]);
  });

  it('uses custom COPILOT_HOME for recall injection and cleanup', async () => {
    const copilotHome = path.join(tmpDir, 'copilot-home');
    const instructionPath = path.join(copilotHome, 'copilot-instructions.md');
    const userInstructions = '# Personal Copilot instructions\n';
    vi.stubEnv('COPILOT_HOME', copilotHome);
    await fse.ensureDir(path.join(copilotHome, 'agents'));
    await fse.ensureDir(path.join(copilotHome, 'instructions'));
    await fse.ensureDir(path.join(copilotHome, 'skills'));
    await fse.writeFile(instructionPath, userInstructions);

    const localConfig: LocalConfig = {
      repo: {
        localPath: path.join(tmpDir, 'team-repo'),
        remote: 'https://github.com/example/team.git',
      },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['copilot'],
      recallEnabled: true,
    };
    const teamConfig = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://github.com/example/team.git',
    });
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await recallEnable({});
    const enabled = await fse.readFile(instructionPath, 'utf8');
    expect(enabled).toContain(userInstructions.trim());
    expect(enabled).toContain(TEAMAI_RECALL_RULES_START);
    await expect(fse.pathExists(path.join(
      copilotHome,
      'instructions',
      'teamai-recall.instructions.md',
    ))).resolves.toBe(true);
    await expect(fse.pathExists(path.join(
      copilotHome,
      'agents',
      'teamai-recall.agent.md',
    ))).resolves.toBe(true);
    await expect(fse.pathExists(path.join(
      copilotHome,
      'skills',
      'teamai',
      'SKILL.md',
    ))).resolves.toBe(true);

    await recallDisable({});
    const disabled = await fse.readFile(instructionPath, 'utf8');
    expect(disabled).toBe(userInstructions);
    await expect(fse.pathExists(path.join(
      copilotHome,
      'instructions',
      'teamai-recall.instructions.md',
    ))).resolves.toBe(false);
    await expect(fse.pathExists(path.join(
      copilotHome,
      'agents',
      'teamai-recall.agent.md',
    ))).resolves.toBe(false);
    // The deployed stub routes to every workflow, recall-dependent or not, so
    // disabling recall no longer removes a skill directory.
    await expect(fse.pathExists(path.join(
      copilotHome,
      'skills',
      'teamai',
      'SKILL.md',
    ))).resolves.toBe(true);
  });
});

// `enabledAgents` (from `teamai init --agent`) is documented as gating the CLI
// built-in skills/rules/agents and CLAUDE.md-class injects. recallEnable deploys
// all four, but only the first three went through the whitelist — the CLAUDE.md
// recall block was still injected into excluded tools. Same targets as pull
// (resolveInstructionTargets, src/instruction-targets.ts).
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

// Codex reads instructions from AGENTS.md only (#938): the recall block has to
// land there, and `recall off` has to take it out again.
describe('recall toggle reaches Codex AGENTS.md with the default tool paths', () => {
  let tmpDir: string;
  let homeDir: string;
  let projectRoot: string;
  const teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });

  function stub(scope: 'user' | 'project'): void {
    const localConfig = {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'https://example.invalid/x/team.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope,
      ...(scope === 'project' ? { projectRoot } : {}),
      enabledAgents: ['codex'],
    } as LocalConfig;
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-recall-codex-'));
    homeDir = path.join(tmpDir, 'home');
    projectRoot = path.join(tmpDir, 'project');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('user scope: on writes the block to ~/.codex/AGENTS.md, off removes the file it created', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex'));
    stub('user');
    const agentsMd = path.join(homeDir, '.codex', 'AGENTS.md');

    await recallEnable({});
    expect(await fse.readFile(agentsMd, 'utf8')).toContain(TEAMAI_RECALL_RULES_START);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'rules'))).toBe(false);

    await recallDisable({});
    expect(await fse.pathExists(agentsMd)).toBe(false);
  });

  it('project scope: on and off leave <project>/AGENTS.md as it was, since the session-start hook adds recall there', async () => {
    await fse.ensureDir(path.join(projectRoot, '.codex'));
    const agentsMd = path.join(projectRoot, 'AGENTS.md');
    await fse.writeFile(agentsMd, '# Project notes\n');
    stub('project');

    await recallEnable({});
    expect(await fse.readFile(agentsMd, 'utf8')).toBe('# Project notes\n');

    await recallDisable({});
    expect(await fse.readFile(agentsMd, 'utf8')).toBe('# Project notes\n');
  });
});

describe('TEAMAI_RECALL_DISABLED turns recall off (#1457)', () => {
  const off = { TEAMAI_RECALL_DISABLED: '1' } as NodeJS.ProcessEnv;
  const teamOn = { sharing: { recall: { enabled: true } } };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('wins over the user override and the team config', () => {
    expect(isRecallEnabled({ recallEnabled: true }, {}, off)).toBe(false);
    expect(isRecallEnabled({}, teamOn, off)).toBe(false);
    expect(isRecallEnabled({ recallEnabled: true }, teamOn, off)).toBe(false);
  });

  it('is read from process.env when no env is passed, as pull calls it', () => {
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '1');
    expect(isRecallEnabled({ recallEnabled: true }, {})).toBe(false);
    expect(isRecallEnabled({}, teamOn)).toBe(false);
  });

  it('leaves the config layers in charge when unset or not 1', () => {
    for (const env of [{}, { TEAMAI_RECALL_DISABLED: '0' }, { TEAMAI_RECALL_DISABLED: '' }, { TEAMAI_RECALL_DISABLED: 'true' }] as NodeJS.ProcessEnv[]) {
      expect(isRecallEnabled({ recallEnabled: true }, {}, env)).toBe(true);
      expect(isRecallEnabled({}, teamOn, env)).toBe(true);
      expect(isRecallEnabled({ recallEnabled: false }, teamOn, env)).toBe(false);
      expect(isRecallEnabled({}, {}, env)).toBe(false);
    }
  });

  const statusLines = async (localConfig: { recallEnabled?: boolean } = { recallEnabled: true }): Promise<string[]> => {
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig: teamOn });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    await recallStatus({});
    return lines;
  };

  it('recall status reports disabled and names the variable', async () => {
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '1');
    const lines = await statusLines();
    expect(lines[0]).toBe('Recall: disabled');
    expect(lines).toContain('  Env override (TEAMAI_RECALL_DISABLED=1): disabled');
  });

  it('recall status does not mention the variable when it is unset', async () => {
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '');
    const lines = await statusLines();
    expect(lines[0]).toBe('Recall: enabled');
    expect(lines.join('\n')).not.toContain('TEAMAI_RECALL_DISABLED');
  });

  it('recall status does not name the variable when the user override is what turns recall off', async () => {
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '');
    const lines = await statusLines({ recallEnabled: false });
    expect(lines[0]).toBe('Recall: disabled');
    expect(lines.join('\n')).not.toContain('TEAMAI_RECALL_DISABLED');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { detectInstalledAgents } from '../known-agents.js';
import {
  getHookStatus,
  hasTeamaiHooks,
  reconcileHooks,
  reconcileTeamHooksForConfig,
} from '../hooks.js';
import { _resetShellCache } from '../builtin-hooks.js';
import { RulesHandler } from '../resources/rules.js';
import { SkillsHandler } from '../resources/skills.js';
import { teamRuleToCopilotInstructions } from '../resources/copilot-instructions.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { TeamaiConfigSchema } from '../types.js';
import type { HookDef, LocalConfig, ResourceItem, TeamaiConfig } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(),
  },
}));

const COPILOT_HOOK_FILE = 'teamai.json';
const COPILOT_SETTINGS_FILE = 'settings.json';
const TEAM_RULE_NAME = 'guardrails';
const TEAM_SKILL_NAME = 'review';

describe('GitHub Copilot adapter', () => {
  let root: string;
  let home: string;
  let copilotHome: string;
  let project: string;
  let repo: string;
  let teamConfig: TeamaiConfig;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-copilot-'));
    home = path.join(root, 'home');
    copilotHome = path.join(root, 'custom-copilot-home');
    project = path.join(root, 'project');
    repo = path.join(root, 'team-repo');
    await Promise.all([
      fse.ensureDir(home),
      fse.ensureDir(copilotHome),
      fse.ensureDir(path.join(project, '.github')),
      fse.ensureDir(path.join(repo, 'rules')),
      fse.ensureDir(path.join(repo, 'skills')),
    ]);
    vi.stubEnv('HOME', home);
    vi.stubEnv('COPILOT_HOME', copilotHome);
    teamConfig = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://github.com/example/team.git',
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  function localConfig(scope: 'user' | 'project'): LocalConfig {
    return {
      repo: { localPath: repo, remote: 'https://github.com/example/team.git' },
      username: 'tester',
      scope,
      projectRoot: scope === 'project' ? project : undefined,
      enabledAgents: ['copilot'],
      additionalRoles: [],
    } as LocalConfig;
  }

  it('detects Copilot through COPILOT_HOME and exposes official scope paths', async () => {
    const copilot = teamConfig.toolPaths.copilot;
    expect(copilot).toEqual(expect.objectContaining({
      skills: '.github/skills',
      rules: '.github/instructions',
      hooks: '.github/hooks/teamai.json',
      claudemd: '.github/copilot-instructions.md',
      userScope: expect.objectContaining({
        skills: 'skills',
        rules: 'instructions',
        hooks: 'hooks/teamai.json',
        claudemd: 'copilot-instructions.md',
      }),
    }));

    const agents = await detectInstalledAgents(localConfig('user'), teamConfig);
    const detected = agents.find((agent) => agent.id === 'copilot');
    expect(detected?.installed).toBe(true);
    expect(detected?.absoluteSkillsPath).toBe(path.join(copilotHome, 'skills'));
  });

  it('does not infer Copilot installation from a project .github directory', async () => {
    await fse.remove(copilotHome);
    const config = localConfig('project');
    config.enabledAgents = undefined;

    const agents = await detectInstalledAgents(config, teamConfig);
    expect(agents.find((agent) => agent.id === 'copilot')?.installed).toBe(false);

    const source = path.join(repo, 'skills', TEAM_SKILL_NAME);
    await fse.ensureDir(source);
    await fse.writeFile(path.join(source, 'SKILL.md'), '# Review\n');
    await new SkillsHandler().pullItem({
      name: TEAM_SKILL_NAME,
      type: 'skills',
      sourcePath: source,
      relativePath: `skills/${TEAM_SKILL_NAME}`,
    }, teamConfig, config);
    expect(await fse.pathExists(path.join(project, '.github', 'skills', TEAM_SKILL_NAME))).toBe(false);
  });

  it('reports explicitly selected project Copilot as installed without COPILOT_HOME', async () => {
    await fse.remove(copilotHome);

    const agents = await detectInstalledAgents(localConfig('project'), teamConfig);
    const detected = agents.find((agent) => agent.id === 'copilot');

    expect(detected?.installed).toBe(true);
    expect(detected?.absoluteSkillsPath).toBe(path.join(project, '.github', 'skills'));
  });

  it('requires Copilot installation or explicit selection before writing project hooks', async () => {
    await fse.remove(copilotHome);
    const config = localConfig('project');
    config.enabledAgents = undefined;
    const hookPath = path.join(project, '.github', 'hooks', COPILOT_HOOK_FILE);

    await reconcileTeamHooksForConfig(teamConfig, config);
    expect(await fse.pathExists(hookPath)).toBe(false);

    config.disabledAgents = ['claude'];
    await reconcileTeamHooksForConfig(teamConfig, config);
    expect(await fse.pathExists(hookPath)).toBe(false);

    config.enabledAgents = ['copilot'];
    await reconcileTeamHooksForConfig(teamConfig, config);
    expect(await fse.pathExists(hookPath)).toBe(true);
  });

  it.each([
    ['user', () => path.join(copilotHome, 'skills', TEAM_SKILL_NAME)],
    ['project', () => path.join(project, '.github', 'skills', TEAM_SKILL_NAME)],
  ] as const)('pulls and pushes Copilot skills in %s scope', async (scope, expectedPath) => {
    const source = path.join(repo, 'skills', TEAM_SKILL_NAME);
    await fse.ensureDir(source);
    await fse.writeFile(path.join(source, 'SKILL.md'), '# Review\n');
    const item: ResourceItem = {
      name: TEAM_SKILL_NAME,
      type: 'skills',
      sourcePath: source,
      relativePath: `skills/${TEAM_SKILL_NAME}`,
    };

    const handler = new SkillsHandler();
    await handler.pullItem(item, teamConfig, localConfig(scope));
    expect(await fse.readFile(path.join(expectedPath(), 'SKILL.md'), 'utf8')).toContain('# Review');

    await fse.writeFile(path.join(expectedPath(), 'SKILL.md'), '# Updated review\n');
    const pushable = await handler.scanLocalForPush(teamConfig, localConfig(scope));
    expect(pushable).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: TEAM_SKILL_NAME, status: 'modified', sourcePath: expectedPath() }),
    ]));
  });

  it.each([
    ['user', () => path.join(copilotHome, 'instructions', `${TEAM_RULE_NAME}.instructions.md`)],
    ['project', () => path.join(project, '.github', 'instructions', `${TEAM_RULE_NAME}.instructions.md`)],
  ] as const)('round-trips native Copilot instruction rules in %s scope', async (scope, expectedPath) => {
    const source = path.join(repo, 'rules', `${TEAM_RULE_NAME}.md`);
    await fse.writeFile(source, '---\npaths:\n  - "src/**/*.ts"\n---\n\n# Guardrails\n');
    const item: ResourceItem = {
      name: TEAM_RULE_NAME,
      type: 'rules',
      sourcePath: source,
      relativePath: `rules/${TEAM_RULE_NAME}.md`,
    };

    const handler = new RulesHandler();
    await handler.pullItem(item, teamConfig, localConfig(scope));
    const native = await fse.readFile(expectedPath(), 'utf8');
    expect(parseFrontmatter(native).data).toEqual(expect.objectContaining({ applyTo: 'src/**/*.ts' }));
    expect(native).toContain('# Guardrails');

    await fse.writeFile(expectedPath(), native.replace('# Guardrails', '# Updated guardrails'));
    const [modified] = await handler.scanLocalForPush(teamConfig, localConfig(scope));
    expect(modified).toEqual(expect.objectContaining({
      name: TEAM_RULE_NAME,
      status: 'modified',
      sourcePath: expectedPath(),
    }));
    await handler.pushItem(modified, teamConfig, localConfig(scope));
    const pushed = await fse.readFile(source, 'utf8');
    expect(parseFrontmatter(pushed).data).toEqual({ paths: ['src/**/*.ts'] });
    expect(pushed).toContain('# Updated guardrails');
    expect(pushed).not.toContain('applyTo:');
  });

  it.each([
    ['user', () => path.join(copilotHome, 'hooks', COPILOT_HOOK_FILE)],
    ['project', () => path.join(project, '.github', 'hooks', COPILOT_HOOK_FILE)],
  ] as const)('writes idempotent versioned Copilot hooks in %s scope without settings.json', async (scope, hookPath) => {
    const settingsPath = path.join(copilotHome, COPILOT_SETTINGS_FILE);
    const settings = '{"theme":"dark"}\n';
    await fse.writeFile(settingsPath, settings);

    await reconcileTeamHooksForConfig(teamConfig, localConfig(scope));
    const first = await fse.readFile(hookPath(), 'utf8');
    await reconcileTeamHooksForConfig(teamConfig, localConfig(scope));
    const second = await fse.readFile(hookPath(), 'utf8');
    const parsed = JSON.parse(second) as {
      version: number;
      hooks: Record<string, Array<Record<string, unknown>>>;
    };

    expect(second).toBe(first);
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.sessionStart).toBeUndefined();
    expect(parsed.hooks.UserPromptSubmit).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(parsed.hooks.Stop).toBeDefined();
    expect(parsed.hooks.SessionStart[0]).toEqual(expect.objectContaining({
      type: 'command',
      bash: expect.stringContaining('teamai hook-dispatch session-start --tool copilot'),
      powershell: expect.stringContaining('teamai hook-dispatch session-start --tool copilot'),
      command: expect.stringContaining('teamai hook-dispatch session-start --tool copilot'),
      timeoutSec: expect.any(Number),
    }));
    expect(parsed.hooks.PostToolUse).toEqual(expect.arrayContaining([
      expect.objectContaining({ matcher: 'Skill' }),
      expect.objectContaining({ matcher: 'TodoWrite' }),
    ]));
    expect(parsed.hooks.PostToolUse.some((entry) => entry.matcher === undefined)).toBe(true);
    expect(await fse.readFile(settingsPath, 'utf8')).toBe(settings);
  });

  it('preserves team-defined Copilot hook matchers', async () => {
    const hookPath = path.join(copilotHome, 'hooks', COPILOT_HOOK_FILE);
    const manifestPath = path.join(copilotHome, 'hooks', 'managed-hooks.json');
    const teamHook: HookDef = {
      source: 'team',
      key: 'check-bash',
      event: 'PostToolUse',
      matcher: 'Bash',
      command: 'echo check-bash',
      description: '[teamai:hook:check-bash] check bash commands',
    };

    await reconcileHooks(hookPath, 'copilot', [teamHook], { manifestPath });

    const parsed = await fse.readJson(hookPath) as {
      hooks: Record<string, Array<{ command: string; matcher?: string }>>;
    };
    expect(parsed.hooks.PostToolUse.find((entry) => entry.command === teamHook.command)?.matcher).toBe('Bash');
  });

  it('normalizes comma-separated and absent rule paths into native applyTo frontmatter', () => {
    const scoped = teamRuleToCopilotInstructions('---\npaths: "src/**/*.ts, test/**/*.ts"\n---\nRule\n');
    const global = teamRuleToCopilotInstructions('Global rule\n');

    expect(parseFrontmatter(scoped).data).toEqual({ applyTo: 'src/**/*.ts, test/**/*.ts' });
    expect(parseFrontmatter(global).data).toEqual({ applyTo: '**' });
  });

  it('upgrades and reconciles existing Copilot hook files while preserving user hooks', async () => {
    const hookPath = path.join(copilotHome, 'hooks', COPILOT_HOOK_FILE);
    const userCommand = 'echo user-hook';
    await fse.ensureDir(path.dirname(hookPath));
    await fse.writeJson(hookPath, {
      version: 0,
      hooks: {
        legacyEvent: [{
          type: 'command',
          bash: 'teamai hook-dispatch session-start --tool copilot',
          powershell: 'teamai hook-dispatch session-start --tool copilot',
          command: 'teamai hook-dispatch session-start --tool copilot',
        }],
        SessionStart: [{
          type: 'command', bash: userCommand, powershell: userCommand, command: userCommand,
        }],
      },
    });

    await reconcileHooks(hookPath, 'copilot');
    const reconciled = await fse.readJson(hookPath) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };

    expect(reconciled.version).toBe(1);
    expect(reconciled.hooks.legacyEvent).toBeUndefined();
    expect(reconciled.hooks.SessionStart.map((entry) => entry.command)).toEqual([
      userCommand,
      expect.stringContaining('teamai hook-dispatch session-start --tool copilot'),
    ]);
    expect(await getHookStatus(hookPath, 'copilot')).toBe('installed');
    expect(await hasTeamaiHooks(hookPath, 'copilot')).toBe(true);

    const skillHook = reconciled.hooks.PostToolUse.find((entry) => entry.command.includes('--matcher Skill')) as {
      command: string;
      matcher?: string;
    };
    delete skillHook.matcher;
    await fse.writeJson(hookPath, reconciled);
    expect(await getHookStatus(hookPath, 'copilot')).toBe('missing');

    await reconcileHooks(hookPath, 'copilot');
    expect(await getHookStatus(hookPath, 'copilot')).toBe('installed');

    reconciled.version = 0;
    await fse.writeJson(hookPath, reconciled);
    expect(await getHookStatus(hookPath, 'copilot')).toBe('missing');
  });

  it('does not create a Copilot hook file when removing from a clean installation', async () => {
    const hookPath = path.join(copilotHome, 'hooks', COPILOT_HOOK_FILE);
    await fse.remove(path.dirname(hookPath));

    await reconcileHooks(hookPath, 'copilot', [], { removeAll: true });

    expect(await fse.pathExists(hookPath)).toBe(false);
    expect(await fse.pathExists(path.dirname(hookPath))).toBe(false);
  });

  it('never replaces a Copilot rule with empty content when its source is unreadable', async () => {
    const handler = new RulesHandler();
    const missingInstructions: ResourceItem = {
      name: TEAM_RULE_NAME,
      type: 'rules',
      sourcePath: path.join(copilotHome, 'instructions', `${TEAM_RULE_NAME}.instructions.md`),
      relativePath: `rules/${TEAM_RULE_NAME}.md`,
    };
    await expect(handler.pushItem(missingInstructions, teamConfig, localConfig('user')))
      .rejects.toThrow(`Cannot read rule source ${missingInstructions.sourcePath}`);

    const missingTeamRule: ResourceItem = {
      ...missingInstructions,
      sourcePath: path.join(repo, 'rules', `${TEAM_RULE_NAME}.md`),
    };
    const destination = path.join(copilotHome, 'instructions', `${TEAM_RULE_NAME}.instructions.md`);
    await handler.pullItem(missingTeamRule, teamConfig, localConfig('user'));
    expect(await fse.pathExists(destination)).toBe(false);
  });

  describe('Windows Git Bash launcher rendering', () => {
    let fakeGitRoot: string;

    beforeEach(async () => {
      // A host may carry a real Git for Windows under ProgramFiles; point every
      // candidate at the fake tree so the resolved launcher is deterministic.
      fakeGitRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-copilot-gitbash-'));
      const bin = path.join(fakeGitRoot, 'Programs', 'Git', 'bin');
      await fse.ensureDir(bin);
      await fse.writeFile(path.join(bin, 'bash.exe'), '');
      vi.stubEnv('ProgramFiles', path.join(fakeGitRoot, 'missing-pf'));
      vi.stubEnv('ProgramFiles(x86)', path.join(fakeGitRoot, 'missing-pf86'));
      vi.stubEnv('LOCALAPPDATA', fakeGitRoot);
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      _resetShellCache();
    });

    afterEach(async () => {
      _resetShellCache();
      vi.restoreAllMocks();
      await fse.remove(fakeGitRoot);
    });

    it('renders the powershell field with the call operator when Git Bash is found', async () => {
      await reconcileTeamHooksForConfig(teamConfig, localConfig('user'));
      const hookPath = path.join(copilotHome, 'hooks', COPILOT_HOOK_FILE);
      const first = await fse.readFile(hookPath, 'utf8');
      await reconcileTeamHooksForConfig(teamConfig, localConfig('user'));
      const second = await fse.readFile(hookPath, 'utf8');
      expect(second).toBe(first);

      const parsed = JSON.parse(second) as {
        hooks: Record<string, Array<{ bash: string; powershell: string; command: string }>>;
      };
      const entry = parsed.hooks.SessionStart[0];
      const bashExe = path.join(fakeGitRoot, 'Programs', 'Git', 'bin', 'bash.exe').split(path.sep).join('/');
      const dispatch = 'teamai hook-dispatch session-start --tool copilot';
      expect(entry.bash).toBe(`"${bashExe}" -lc "${dispatch} 2>/dev/null" || true`);
      expect(entry.powershell).toBe(`& "${bashExe}" -lc "${dispatch} 2>/dev/null"; exit 0`);
      expect(entry.command).toBe(entry.bash);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';

import {
  LocalConfigSchema,
  TeamaiConfigSchema,
  applyToolRoots,
  detectClaudeConfigRoot,
  resolveHookScope,
  resolveToolRootDir,
  scopedToolPaths,
  toolInstallRoot,
  type LocalConfig,
  type TeamaiConfig,
} from '../types.js';
import { log } from '../utils/logger.js';

const teamConfig: TeamaiConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'r' });

function localConfig(overrides: Partial<LocalConfig> = {}): LocalConfig {
  return {
    repo: { localPath: '/team-repo', remote: 'git@example.com:t/r.git' },
    username: 'u',
    scope: 'user',
    additionalRoles: [],
    ...overrides,
  };
}

/** `toolPaths` as every hook injector resolves them: at the hook scope, not the config's. */
function hookScopedPaths(config: LocalConfig): ReturnType<typeof scopedToolPaths> {
  return scopedToolPaths(teamConfig, { ...config, scope: resolveHookScope(config).scope });
}

describe('toolRoots — re-rooting a relocated tool', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tool-roots-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fse.remove(home);
    vi.restoreAllMocks();
  });

  it('moves every path of the listed tool and nothing else', () => {
    const paths = scopedToolPaths(teamConfig, localConfig({
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));

    expect(paths.claude).toEqual({
      skills: '.claude-work/skills',
      rules: '.claude-work/rules',
      settings: '.claude-work/settings.json',
      claudemd: '.claude-work/CLAUDE.md',
      agents: '.claude-work/agents',
      // The user data dir moves as a whole, so the MCP file travels inside it.
      mcp: '.claude-work/.claude.json',
      // Project scope is anchored on the project root, not on the member's root.
      mcpProject: '.mcp.json',
    });
    expect(paths.codex).toEqual(teamConfig.toolPaths.codex);
    expect(paths.tclaude).toEqual(teamConfig.toolPaths.tclaude);
    expect(paths.copilot).toEqual(scopedToolPaths(teamConfig, localConfig()).copilot);
  });

  it('expands a leading ~/ in the configured root', () => {
    const paths = scopedToolPaths(teamConfig, localConfig({ toolRoots: { claude: '~/.claude-work' } }));
    expect(paths.claude.settings).toBe('.claude-work/settings.json');
  });

  it('accepts a ~/.config/<name> root, which the installed-tool gate can express', () => {
    const paths = scopedToolPaths(teamConfig, localConfig({
      toolRoots: { claude: path.join(home, '.config', 'claude-work') },
    }));
    expect(paths.claude.skills).toBe('.config/claude-work/skills');
    expect(toolInstallRoot('.config/claude-work/settings.json')).toBe('.config/claude-work');
  });

  it('refuses a root nested deeper than the gate can look for', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const nested = path.join(home, 'configs', 'claude');

    const paths = scopedToolPaths(teamConfig, localConfig({ toolRoots: { claude: nested } }));

    expect(paths.claude).toEqual(teamConfig.toolPaths.claude);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('toolRoots.claude');
    expect(warn.mock.calls[0][0]).toContain(nested);
    expect(warn.mock.calls[0][0]).toContain('~/.config/<name>');
  });

  it('moves the MCP companion file inside a root equal to the default one', () => {
    // CLAUDE_CONFIG_DIR=~/.claude is not the same as leaving it unset: Claude
    // Code then reads ~/.claude/.claude.json instead of ~/.claude.json.
    const paths = scopedToolPaths(teamConfig, localConfig({
      toolRoots: { claude: path.join(home, '.claude') },
    }));
    expect(paths.claude).toEqual({
      ...teamConfig.toolPaths.claude,
      mcp: '.claude/.claude.json',
    });
  });

  it('moves a bare file name the team declared beside the root inside the new one', () => {
    // `.claude.json` is the usual case, but the promise is every user-scope
    // Claude path, so a customized `settings: settings.json` follows too.
    const bare = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      toolPaths: { claude: { skills: '.claude/skills', settings: 'settings.json', mcp: '.claude.json', mcpProject: '.mcp.json' } },
    });
    const paths = scopedToolPaths(bare, localConfig({
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));
    expect(paths.claude.settings).toBe('.claude-work/settings.json');
    expect(paths.claude.mcp).toBe('.claude-work/.claude.json');
  });

  it('adds no key for a field the team did not declare', () => {
    const sparse = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      toolPaths: { claude: { skills: '.claude/skills', mcpProject: '.mcp.json' } },
    });
    const paths = scopedToolPaths(sparse, localConfig({
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));
    expect(Object.keys(paths.claude).sort()).toEqual(['mcpProject', 'skills']);
  });

  it('moves fields the team spread over several roots, every one of them', () => {
    // A customized `toolPaths.claude` need not keep every field under one
    // directory. The feature promises that every user-scope Claude path moves,
    // so each field's own root counts, not just the first populated one.
    const spread = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude-settings/settings.json',
          agents: '.claude-agents/agents',
          mcp: '.claude.json',
          mcpProject: '.mcp.json',
        },
      },
    });

    const paths = scopedToolPaths(spread, localConfig({
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));

    expect(paths.claude).toEqual({
      skills: '.claude-work/skills',
      rules: '.claude-work/rules',
      settings: '.claude-work/settings.json',
      agents: '.claude-work/agents',
      mcp: '.claude-work/.claude.json',
      mcpProject: '.mcp.json',
    });
  });

  it('moves a user-scope MCP file that sits beside a customized root inside the new one', () => {
    // CLAUDE_CONFIG_DIR makes Claude Code read .claude.json from inside the
    // directory whatever the resource root was called, so the companion file
    // follows even when its name does not echo that root.
    const custom = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      toolPaths: {
        claude: {
          skills: '.claude-custom/skills',
          settings: '.claude-custom/settings.json',
          mcp: '.claude.json',
          mcpProject: '.mcp.json',
        },
      },
    });

    const paths = scopedToolPaths(custom, localConfig({
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));

    expect(paths.claude.mcp).toBe('.claude-work/.claude.json');
    expect(paths.claude.settings).toBe('.claude-work/settings.json');
  });

  it('takes a user-scope layout at a second root along with the move', () => {
    // `toolPaths` is team-declared, so a team can give a tool a `userScope`
    // block that hangs off a different root (the way OpenCode's does). The move
    // has to take both roots, or half the resources stay where nothing reads
    // them. Declared for claude, the one id a member may relocate.
    const twoRooted = TeamaiConfigSchema.parse({
      team: 't',
      repo: 'r',
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          agents: '.claude/agents',
          mcp: '.config/claude/claude.json',
          mcpProject: '.mcp.json',
          userScope: { skills: '.config/claude/skills', rules: '.config/claude/rules' },
        },
      },
    });

    const paths = scopedToolPaths(twoRooted, localConfig({
      toolRoots: { claude: path.join(home, '.claude-work') },
    }));

    expect(paths.claude).toEqual({
      skills: '.claude-work/skills',
      rules: '.claude-work/rules',
      agents: '.claude-work/agents',
      mcp: '.claude-work/claude.json',
      // Project scope is anchored on the project root.
      mcpProject: '.mcp.json',
      userScope: { skills: '.claude-work/skills', rules: '.claude-work/rules' },
    });
    // Rebuilt without the fields the tool does not declare.
    expect(Object.keys(paths.claude.userScope ?? {})).toEqual(['skills', 'rules']);
  });

  // Every tool except claude still writes somewhere teamai does not resolve
  // through toolPaths — Codex and Cursor co-author files, OMP's extension dir,
  // $COPILOT_HOME, OpenCode's plugin dir — so a root would move half a layout.
  it.each(['codex', 'omp', 'cursor', 'copilot', 'opencode'])(
    'refuses to relocate %s, which teamai does not address through toolPaths alone',
    (tool) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      const withRoot = localConfig({ toolRoots: { [tool]: path.join(home, `.${tool}-work`) } });

      const paths = scopedToolPaths(teamConfig, withRoot);

      expect(paths[tool]).toEqual(scopedToolPaths(teamConfig, localConfig())[tool]);
      expect(resolveToolRootDir(tool, `.${tool}`, withRoot.toolRoots))
        .toBe(path.join(home, `.${tool}`));
      // Once per tool, however many times the paths are resolved during a pull.
      scopedToolPaths(teamConfig, withRoot);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`toolRoots.${tool}`);
      expect(warn.mock.calls[0][0]).toContain('supports claude only');
      if (tool === 'copilot') expect(warn.mock.calls[0][0]).toContain('COPILOT_HOME');
    },
  );

  it('refuses ~/.config itself, which the installed-tool gate would read as a file', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const paths = scopedToolPaths(teamConfig, localConfig({
      toolRoots: { claude: path.join(home, '.config') },
    }));

    expect(paths.claude).toEqual(teamConfig.toolPaths.claude);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('~/.config itself');
  });

  it('refuses a root outside the home directory and says so', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const outside = path.join(os.tmpdir(), `teamai-outside-${Date.now()}`);

    const paths = scopedToolPaths(teamConfig, localConfig({ toolRoots: { claude: outside } }));

    expect(paths.claude).toEqual(teamConfig.toolPaths.claude);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('toolRoots.claude');
    expect(warn.mock.calls[0][0]).toContain(outside);
  });

  it('ignores a tool the team declares no paths for', () => {
    const paths = scopedToolPaths(teamConfig, localConfig({
      toolRoots: { 'not-a-tool': path.join(home, '.somewhere') },
    }));
    expect(paths).toEqual(scopedToolPaths(teamConfig, localConfig()));
  });

  it('leaves a config without toolRoots exactly as it was', () => {
    expect(applyToolRoots(teamConfig.toolPaths, undefined)).toBe(teamConfig.toolPaths);
    expect(applyToolRoots(teamConfig.toolPaths, {})).toBe(teamConfig.toolPaths);
    expect(scopedToolPaths(teamConfig, localConfig())).toEqual(
      scopedToolPaths(teamConfig, localConfig({ toolRoots: {} })),
    );
  });

  it('keeps project-scope resource paths on the project root, while hooks follow the member root', () => {
    const project = localConfig({
      scope: 'project',
      projectRoot: '/work/app',
      toolRoots: { claude: path.join(home, '.claude-work') },
    });

    // Resources land under <projectRoot>/.claude — a HOME-relative member root
    // means nothing there.
    expect(scopedToolPaths(teamConfig, project).claude.skills).toBe('.claude/skills');
    // Hooks for a non-self project scope are injected into HOME (resolveHookScope),
    // and every injector resolves its paths at that scope.
    expect(hookScopedPaths(project).claude.settings).toBe('.claude-work/settings.json');
  });

  it('keeps self single-repo hooks on the business repo', () => {
    const self = localConfig({
      scope: 'project',
      projectRoot: '/work/app',
      repo: { localPath: '/work/app/.teamai', remote: 'r', kind: 'self', businessRepoRoot: '/work/app' },
      toolRoots: { claude: path.join(home, '.claude-work') },
    });
    expect(hookScopedPaths(self).claude.settings).toBe('.claude/settings.json');
  });

  it('resolves a tool root directory for writers that address it directly', () => {
    expect(resolveToolRootDir('claude', '.claude', undefined)).toBe(path.join(home, '.claude'));
    expect(resolveToolRootDir('claude', '.claude', { claude: '~/.claude-work' }))
      .toBe(path.join(home, '.claude-work'));
  });
});

describe('toolRoots — local config schema', () => {
  it('parses a config that predates the field', () => {
    const parsed = LocalConfigSchema.parse({
      repo: { localPath: '/x', remote: '' },
      username: 'u',
    });
    expect(parsed.toolRoots).toBeUndefined();
  });

  it('round-trips through save and load', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tool-roots-io-'));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { saveLocalConfig, loadLocalConfig } = await import('../config.js');
      const saved = localConfig({ toolRoots: { claude: path.join(home, '.claude-work') } });
      await fse.ensureDir(path.join(home, '.teamai'));
      await saveLocalConfig(saved);

      const raw = YAML.parse(await fse.readFile(path.join(home, '.teamai', 'config.yaml'), 'utf8'));
      expect(raw.toolRoots).toEqual({ claude: path.join(home, '.claude-work') });
      const loaded = await loadLocalConfig();
      expect(loaded?.toolRoots).toEqual({ claude: path.join(home, '.claude-work') });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await fse.remove(home);
    }
  });
});

describe('detectClaudeConfigRoot', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-claude-env-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fse.remove(home);
  });

  it('is null only when the variable is unset or blank', () => {
    expect(detectClaudeConfigRoot({} as NodeJS.ProcessEnv)).toBeNull();
    expect(detectClaudeConfigRoot({ CLAUDE_CONFIG_DIR: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('answers with the default root when the variable names it explicitly', () => {
    // Setting the variable changes where Claude Code reads .claude.json, even
    // when its value is the directory it would have used anyway.
    expect(detectClaudeConfigRoot({ CLAUDE_CONFIG_DIR: '~/.claude' } as NodeJS.ProcessEnv))
      .toBe(path.join(home, '.claude'));
  });

  it('resolves a relocated root to an absolute path', () => {
    expect(detectClaudeConfigRoot({ CLAUDE_CONFIG_DIR: '~/.claude-work' } as NodeJS.ProcessEnv))
      .toBe(path.join(home, '.claude-work'));
    expect(detectClaudeConfigRoot(
      { CLAUDE_CONFIG_DIR: `${path.join(home, '.claude-work')}/` } as NodeJS.ProcessEnv,
    )).toBe(path.join(home, '.claude-work'));
  });
});

describe('hook injection with a relocated root', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tool-roots-hooks-'));
    process.env.HOME = home;
    // Only the relocated root exists: the injector writes to installed tools only.
    await fse.ensureDir(path.join(home, '.claude-work'));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fse.remove(home);
  });

  it('writes settings into the member root and never creates the default one', async () => {
    const { injectHooksToAllTools } = await import('../hooks.js');
    const config = localConfig({ toolRoots: { claude: path.join(home, '.claude-work') } });

    await injectHooksToAllTools(hookScopedPaths(config), home, ['claude']);

    const settings = await fse.readJson(path.join(home, '.claude-work', 'settings.json'));
    expect(JSON.stringify(settings)).toContain('teamai hook-dispatch');
    expect(await fse.pathExists(path.join(home, '.claude'))).toBe(false);
  });
});

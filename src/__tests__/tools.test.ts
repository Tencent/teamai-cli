import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { installedBuiltinHookDefs } from '../builtin-hooks.js';
import { KNOWN_AGENTS, SELF_MODE_AGENT_CHOICES } from '../known-agents.js';
import { ModelAgentSchema, type ModelAgent } from '../models/profile.js';
import { EXTRAS_BASE_TOOL, type ToolName } from '../resources/agent-format.js';
import { AGENT_TOOLS, isToolId, TOOLS, type Support, type ToolDescriptor } from '../tools.js';
import { DEFAULT_TOOL_PATHS, scopedToolPaths, TeamaiConfigSchema, type ToolId } from '../types.js';
import { CODEX_TOOL_IDS, normalizeAgentType } from '../utils/tool-names.js';
import { LAUNCH_ADAPTERS } from '../tool-launch/adapters.js';
import type { LaunchTool } from '../tool-launch/tools.js';

const TOOL_IDS = Object.keys(DEFAULT_TOOL_PATHS).filter(isToolId);
const USER_PATHS = scopedToolPaths(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.com/t.git' }), { scope: 'user' });

/** User-scope paths keyed by field, `$HOME`-relative. Copilot's are relative to its own home. */
function userPaths(tool: ToolId): Array<[field: string, relPath: string]> {
  const { mcpProject: _project, userScope: _userScope, ...fields } = USER_PATHS[tool];
  return Object.entries(fields)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([field, relPath]) => [field, tool === 'copilot' ? path.posix.join(TOOLS.copilot.home.dir, relPath) : relPath]);
}

type IsSubset<TSub, TSuper> = [TSub] extends [TSuper] ? true : false;

describe('ToolId', () => {
  it('covers every typed tool list', () => {
    const lists: true[] = [
      true satisfies IsSubset<ToolName, ToolId>,
      true satisfies IsSubset<ModelAgent, ToolId>,
      true satisfies IsSubset<LaunchTool, ToolId>,
    ];
    expect(lists).toHaveLength(3);
  });

  it('covers every runtime tool list and alias table', () => {
    const ids = [
      ...AGENT_TOOLS,
      ...ModelAgentSchema.options,
      ...SELF_MODE_AGENT_CHOICES,
      ...CODEX_TOOL_IDS,
      ...Object.entries(EXTRAS_BASE_TOOL).flat(),
      ...TOOL_IDS.map(normalizeAgentType),
    ];
    expect(ids.filter((id) => !isToolId(id))).toEqual([]);
  });

  // KNOWN_AGENTS.skillsPath is also the no-config project root (project-agent-root.ts),
  // so these keep their project path; home detection reads TOOLS[tool].home instead.
  const PROJECT_SKILLS_PATH: ToolId[] = ['omp', 'opencode', 'pi'];

  it('gives each built-in tool the user skills path KNOWN_AGENTS reports, apart from the project-path ones', () => {
    const disagreements = TOOL_IDS.flatMap((tool) => {
      const fromDefaults = Object.fromEntries(userPaths(tool)).skills;
      const known = KNOWN_AGENTS.find((agent) => agent.id === tool)?.skillsPath;
      return fromDefaults === known ? [] : [tool];
    });
    expect(disagreements.sort()).toEqual(PROJECT_SKILLS_PATH);
    for (const tool of PROJECT_SKILLS_PATH) {
      expect(KNOWN_AGENTS.find((agent) => agent.id === tool)?.skillsPath).toBe(DEFAULT_TOOL_PATHS[tool].skills);
    }
  });
});

describe('TOOLS home', () => {
  // User-scope paths that sit outside the tool's home, each for a reason.
  const OUTSIDE_HOME: Record<string, string> = {
    'claude.mcp': 'Claude Code keeps its user MCP servers in ~/.claude.json, beside ~/.claude',
    'hermes.claudemd': 'retired ~/AGENTS.md, kept only so cleanup can find it; Hermes reads SOUL.md',
    'workbuddy.claudemd': 'retired ~/AGENTS.md, kept only so cleanup can find it',
  };

  it('holds every user-scope path of the tool, apart from the listed exceptions', () => {
    const outside = TOOL_IDS.flatMap((tool) => userPaths(tool)
      .filter(([, relPath]) => !relPath.startsWith(`${TOOLS[tool].home.dir}/`))
      .map(([field, relPath]) => ({ key: `${tool}.${field}`, relPath })));
    expect(outside.map(({ key }) => key).sort()).toEqual(Object.keys(OUTSIDE_HOME).sort());
  });
});

describe('TOOLS skillLoad', () => {
  const WILDCARD_POST_TOOL_USE = 'Hook dispatch post-tool-use wildcard';

  /** Whether teamai installs the wildcard post-tool-use hook for this tool, the pass that sees its skill loads. */
  function hasWildcardPostToolUse(tool: ToolId): boolean {
    const paths = DEFAULT_TOOL_PATHS[tool];
    // dsh-hooks.ts renders builtinHookDefs('dsh') into dsh's Claude-format bridge file.
    const settingsDriven = tool === 'dsh' || 'settings' in paths || 'hooks' in paths;
    return installedBuiltinHookDefs(tool, settingsDriven)
      .some((def) => def.key === WILDCARD_POST_TOOL_USE && def.matcher === '*');
  }

  it('is known exactly for the tools that receive the wildcard post-tool-use hook', () => {
    const known = TOOL_IDS.filter((tool) => TOOLS[tool].skillLoad !== 'unknown');
    expect(known).toEqual(TOOL_IDS.filter(hasWildcardPostToolUse));
  });

  it('stays unknown for Hermes and OpenClaw, so none of their tool calls is credited', () => {
    expect(TOOLS.hermes.skillLoad).toBe('unknown');
    expect(TOOLS.openclaw.skillLoad).toBe('unknown');
  });

  it('is required on every descriptor', () => {
    const tools = {
      ...TOOLS,
      // @ts-expect-error a tool whose skill loading nobody has observed says 'unknown'
      pi: { home: { dir: '.pi' } },
    } satisfies Record<ToolId, ToolDescriptor>;
    expect(tools.pi.home.dir).toBe('.pi');
  });
});

describe('TOOLS features', () => {
  /** Whether the cell says teamai builds the feature: it works, works with a catch, or is broken. */
  const builds = (support: Support) => /^[✓◐✗]/u.test(typeof support === 'string' ? support : support.cell);
  const hasProfile = (tool: ToolId, profile: 'call' | 'step') => {
    const adapter = TOOLS[tool].launch;
    return adapter !== 'none' && profile in LAUNCH_ADAPTERS[adapter];
  };

  it('marks workflows built exactly for the tools whose launch adapter runs steps', () => {
    expect(TOOL_IDS.filter((tool) => builds(TOOLS[tool].features.workflows))).toEqual(TOOL_IDS.filter((tool) => hasProfile(tool, 'step')));
  });

  it("marks teamai's own AI calls built exactly for the tools teamai launches", () => {
    expect(TOOL_IDS.filter((tool) => builds(TOOLS[tool].features.aiBackend))).toEqual(TOOL_IDS.filter((tool) => hasProfile(tool, 'call')));
  });
});

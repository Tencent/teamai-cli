import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  agentFileExtensionForTool,
  ALL_SUPPORTED_TOOLS,
  renderForTool,
  reverseFromClaude,
} from '../resources/agent-format.js';
import type { AgentSpec } from '../resources/agent-format.js';
import { isToolInstalledForConfig } from '../resources/base.js';
import { KNOWN_AGENTS, normalizeAgentList } from '../known-agents.js';
import { normalizeToolId } from '../utils/tool-names.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { renderRuleForTool } from '../resources/rule-format.js';
import {
  TEAMAI_ANTIGRAVITY_HOOKS_KEY,
  mergeTeamaiAntigravityHooks,
  readAntigravityHooks,
  reconcileAntigravityHooks,
  removeTeamaiAntigravityHooks,
  renderAntigravityHooks,
} from '../antigravity-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { builtinHookDefs, getAntigravityDispatchCommand } from '../builtin-hooks.js';
import { TeamaiConfigSchema } from '../types.js';
import type { HookDef, LocalConfig } from '../types.js';
import type { AntigravityHookConfig } from '../antigravity-hooks.js';

const AGY = 'antigravity';

/** A user-authored block that must survive every inject and removal. */
const USER_BLOCK = {
  'dangerous-commands-guard': {
    enabled: true,
    PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'guard.sh', type: 'command' }] }],
  },
};

function hookDef(overrides: Partial<HookDef> = {}): HookDef {
  return {
    source: 'builtin',
    key: 'Hook dispatch session-start',
    event: 'SessionStart',
    matcher: '*',
    command: 'bash -lc "teamai hook-dispatch session-start --tool antigravity 2>/dev/null" || true',
    description: '[teamai] Hook dispatch session-start',
    ...overrides,
  };
}

describe('Antigravity CLI (agy) support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Antigravity resource paths for project and user scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths[AGY]).toEqual({
      skills: '.agents/skills',
      rules: '.agents/rules',
      settings: '.agents/hooks.json',
      claudemd: 'GEMINI.md',
      agents: '.agents/agents',
      mcp: '.gemini/config/mcp_config.json',
      mcpProject: '.agents/mcp_config.json',
      userScope: {
        skills: '.gemini/config/skills',
        rules: '.gemini/config/rules',
        settings: '.gemini/config/hooks.json',
        claudemd: '.gemini/config/GEMINI.md',
        agents: '.gemini/config/agents',
      },
    });
  });

  it('registers Antigravity for discovery and native resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === AGY)).toMatchObject({
      displayName: 'Antigravity CLI',
      skillsPath: '.gemini/config/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain(AGY);
    // Antigravity subagents are Markdown, the extension agent-format's default
    // already returns.
    expect(agentFileExtensionForTool(AGY)).toBe('.md');
    expect(detectMcpFormat(AGY)).toBe('claude');
  });

  it('resolves the agy and gemini aliases to antigravity', () => {
    expect(normalizeToolId('agy')).toBe(AGY);
    expect(normalizeToolId('gemini')).toBe(AGY);
    expect(normalizeToolId('antigravity')).toBe(AGY);
    expect(normalizeToolId('claude')).toBe('claude');
    expect(normalizeAgentList(['agy', 'gemini,claude'])).toEqual([AGY, 'claude']);
  });

  it('accepts the Antigravity roots and the --agent bootstrap, and still honours the path probe (#945)', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-antigravity-install-'));
    try {
      const home = path.join(tmp, 'home');
      const projectRoot = path.join(tmp, 'project');
      vi.stubEnv('HOME', home);
      // This machine may genuinely have the CLI installed (its `agy` binary on
      // PATH), so pin the PATH off to isolate the signals under test.
      vi.stubEnv('PATH', '');
      const localConfig = (enabledAgents?: string[]) => ({
        repo: { localPath: path.join(tmp, 'repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'project',
        projectRoot,
        additionalRoles: [],
        ...(enabledAgents ? { enabledAgents } : {}),
      }) as unknown as LocalConfig;

      await fse.ensureDir(home);
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig())).toBe(false);

      // The shared `.agents/` tree is NOT evidence: the central Agent Skills
      // entry uses it, so accepting it would hand Antigravity's targets to every
      // project that merely has `.agents/` (the #882 MCP assertions catch that).
      await fse.ensureDir(path.join(projectRoot, '.agents', 'skills'));
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig())).toBe(false);

      // The CLI's own hooks file inside that tree is evidence: it is the
      // project-scope customization root's hooks.json, and nothing else
      // declares that path.
      await fse.outputJson(path.join(projectRoot, '.agents', 'hooks.json'), {});
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig())).toBe(true);
      await fse.remove(path.join(projectRoot, '.agents', 'hooks.json'));
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig())).toBe(false);

      // Antigravity's OWN files are evidence — the contract the upstream #945
      // suite sets up before asserting delivery (its fixture creates
      // `hooks.json`, `GEMINI.md` and `.gemini/` next to `.agents/`).
      await fse.ensureDir(path.join(projectRoot, '.gemini'));
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig())).toBe(true);
      await fse.remove(path.join(projectRoot, '.gemini'));
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig())).toBe(false);

      // `--agent antigravity` bootstraps a project-only init before the app ran.
      expect(await isToolInstalledForConfig(AGY, '.agents/skills', localConfig([AGY]))).toBe(true);

      // The product's own roots count with no project evidence at all: probe a
      // path whose project root is absent, so only the machine signal can answer.
      const noProjectEvidence = '.gemini/config/skills';
      await fse.ensureDir(path.join(home, '.gemini', 'antigravity-cli'));
      expect(await isToolInstalledForConfig(AGY, noProjectEvidence, localConfig())).toBe(true);

      await fse.remove(path.join(home, '.gemini', 'antigravity-cli'));
      await fse.ensureDir(path.join(home, '.gemini', 'config'));
      expect(await isToolInstalledForConfig(AGY, noProjectEvidence, localConfig())).toBe(true);

      await fse.remove(path.join(home, '.gemini', 'config'));
      expect(await isToolInstalledForConfig(AGY, noProjectEvidence, localConfig())).toBe(false);
    } finally {
      await fse.remove(tmp);
    }
  });

  it('takes team rules verbatim, as plain Markdown', () => {
    const teamRule = '---\ndescription: team rule\n---\n\nAlways run the tests.\n';

    expect(renderRuleForTool(AGY, teamRule)).toBe(teamRule);
  });

  it('renders and reverses an Antigravity subagent as Markdown frontmatter', () => {
    const spec: AgentSpec = {
      name: 'reviewer',
      description: 'Reviews changes',
      instructions: 'Review the diff carefully.',
      model: 'gemini-2.5-pro',
      tools: ['read'],
      tool_extras: { [AGY]: { temperature: 0.2 } },
    };

    const rendered = renderForTool(spec, AGY);
    expect(rendered.ext).toBe('.md');
    expect(rendered.content).toContain('name: reviewer');
    expect(rendered.content).toContain('model: gemini-2.5-pro');
    expect(rendered.content).toContain('temperature: 0.2');

    // The parser is the Claude one, which is what `reverseByTool` uses and
    // re-keys to `tool_extras.antigravity`.
    const reversed = reverseFromClaude('reviewer.md', rendered.content);
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.spec).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      instructions: 'Review the diff carefully.',
      model: 'gemini-2.5-pro',
      tools: ['read'],
      tool_extras: { claude: { temperature: 0.2 } },
    });
  });

  describe('hooks adapter', () => {
    it('maps Claude events onto the Antigravity blocks and drops unknown ones', () => {
      const block = renderAntigravityHooks([
        hookDef(),
        hookDef({ key: 'prompt', event: 'UserPromptSubmit', command: 'teamai hook-dispatch prompt-submit --tool antigravity' }),
        hookDef({ key: 'stop', event: 'Stop', command: 'teamai hook-dispatch stop --tool antigravity' }),
        hookDef({
          key: 'post',
          event: 'PostToolUse',
          matcher: 'Skill',
          command: 'teamai hook-dispatch post-tool-use --tool antigravity --matcher Skill',
          timeout: 10,
        }),
        // Antigravity has no session-end event: the def is dropped, never
        // written under a guessed name.
        hookDef({ key: 'session-end', event: 'SessionEnd', command: 'nope' }),
      ]);

      expect(block.enabled).toBe(true);
      // SessionStart rides the CLI's own SessionStart event, not PreInvocation
      // (which fires before every model call): see EVENT_TO_BLOCK.
      expect(block.SessionStart).toEqual([
        { command: 'bash -lc "teamai hook-dispatch session-start --tool antigravity 2>/dev/null" || true', type: 'command' },
      ]);
      expect(block.PreInvocation).toEqual([
        { command: 'teamai hook-dispatch prompt-submit --tool antigravity', type: 'command' },
      ]);
      expect(block.Stop).toEqual([{ command: 'teamai hook-dispatch stop --tool antigravity', type: 'command' }]);
      expect(block.PostToolUse).toEqual([
        { matcher: 'Skill', hooks: [{ command: 'teamai hook-dispatch post-tool-use --tool antigravity --matcher Skill', type: 'command', timeout: 10 }] },
      ]);
      expect(JSON.stringify(block)).not.toContain('nope');
    });

    it('uses a dispatch command the CLI can actually run on this platform', () => {
      // agy runs hook commands through cmd /c on Windows, where the POSIX
      // `"<bash>" -lc "…"` wrapper's quotes arrive backslash-escaped and the
      // command never starts (verified against agy 1.3.4); the bare form runs.
      const expected = process.platform === 'win32'
        ? 'teamai hook-dispatch session-start --tool antigravity'
        : 'bash -lc "teamai hook-dispatch session-start --tool antigravity 2>/dev/null" || true';
      expect(getAntigravityDispatchCommand('session-start', AGY)).toBe(expected);

      // The built-in defs the adapter writes go through the same builder.
      const commands = builtinHookDefs(AGY).map((def) => def.command);
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        if (process.platform === 'win32') {
          expect(command).toMatch(/^teamai hook-dispatch [a-z-]+ --tool antigravity(?: --matcher \S+)?$/);
        } else {
          expect(command).toContain('bash -lc "teamai hook-dispatch ');
        }
      }
    });

    it('merges into the teamai-hooks key only, never mutating its input', () => {
      const existing: AntigravityHookConfig = { ...USER_BLOCK };
      const merged = mergeTeamaiAntigravityHooks(existing, [hookDef()]);

      expect(merged[TEAMAI_ANTIGRAVITY_HOOKS_KEY]).toBeDefined();
      expect(merged['dangerous-commands-guard']).toEqual(USER_BLOCK['dangerous-commands-guard']);
      expect(existing[TEAMAI_ANTIGRAVITY_HOOKS_KEY]).toBeUndefined();
    });

    it('removes only its own key, keeping every user block', () => {
      const merged = mergeTeamaiAntigravityHooks(USER_BLOCK, [hookDef()]);
      const removed = removeTeamaiAntigravityHooks(merged);

      expect(removed[TEAMAI_ANTIGRAVITY_HOOKS_KEY]).toBeUndefined();
      expect(removed).toEqual(USER_BLOCK);
    });

    it('reads a missing or malformed file as an empty config', async () => {
      const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-antigravity-hooks-read-'));
      try {
        expect(await readAntigravityHooks(path.join(tmp, 'missing.json'))).toEqual({});

        const broken = path.join(tmp, 'broken.json');
        await fse.writeFile(broken, '{ not json');
        expect(await readAntigravityHooks(broken)).toEqual({});

        const array = path.join(tmp, 'array.json');
        await fse.writeFile(array, '[]');
        expect(await readAntigravityHooks(array)).toEqual({});
      } finally {
        await fse.remove(tmp);
      }
    });

    it('injects idempotently and uninstalls cleanly, preserving user hooks', async () => {
      const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-antigravity-hooks-'));
      try {
        const file = path.join(tmp, 'hooks.json');
        await fse.outputJson(file, USER_BLOCK);

        expect(await reconcileAntigravityHooks(file, [hookDef()])).toBe(true);
        const injected = JSON.parse(await fse.readFile(file, 'utf8')) as Record<string, unknown>;
        expect(injected[TEAMAI_ANTIGRAVITY_HOOKS_KEY]).toBeDefined();
        expect(injected['dangerous-commands-guard']).toEqual(USER_BLOCK['dangerous-commands-guard']);

        // A second pass over a current file writes nothing.
        const bytes = await fse.readFile(file, 'utf8');
        expect(await reconcileAntigravityHooks(file, [hookDef()])).toBe(false);
        expect(await fse.readFile(file, 'utf8')).toBe(bytes);

        expect(await reconcileAntigravityHooks(file, [], { removeAll: true })).toBe(true);
        expect(JSON.parse(await fse.readFile(file, 'utf8'))).toEqual(USER_BLOCK);
      } finally {
        await fse.remove(tmp);
      }
    });

    it('does not create a hooks.json just to uninstall from a machine that has none', async () => {
      const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-antigravity-hooks-empty-'));
      try {
        const file = path.join(tmp, 'hooks.json');
        expect(await reconcileAntigravityHooks(file, [], { removeAll: true })).toBe(false);
        expect(await fse.pathExists(file)).toBe(false);
      } finally {
        await fse.remove(tmp);
      }
    });
  });

  describe('hook injection through the pull pipeline', () => {
    const toolPaths = () => ({ [AGY]: { skills: '.agents/skills', settings: '.agents/hooks.json' } }) as Record<string, { settings?: string }>;

    it('writes the teamai-hooks block into the project hooks.json the user already has', async () => {
      const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-antigravity-pull-'));
      try {
        const projectRoot = path.join(tmp, 'project');
        const file = path.join(projectRoot, '.agents', 'hooks.json');
        await fse.outputJson(file, USER_BLOCK);

        await reconcileHooksToAllTools(toolPaths(), projectRoot, [], path.join(tmp, 'managed-hooks.json'));

        const written = JSON.parse(await fse.readFile(file, 'utf8')) as Record<string, Record<string, unknown>>;
        expect(written['dangerous-commands-guard']).toEqual(USER_BLOCK['dangerous-commands-guard']);
        expect(JSON.stringify(written)).toContain('--tool antigravity');
        expect(written[TEAMAI_ANTIGRAVITY_HOOKS_KEY]!['SessionStart']).toBeDefined();

        // Idempotent across a second pull.
        const bytes = await fse.readFile(file, 'utf8');
        await reconcileHooksToAllTools(toolPaths(), projectRoot, [], path.join(tmp, 'managed-hooks.json'));
        expect(await fse.readFile(file, 'utf8')).toBe(bytes);

        await reconcileHooksToAllTools(toolPaths(), projectRoot, [], path.join(tmp, 'managed-hooks.json'), { removeAll: true });
        expect(JSON.parse(await fse.readFile(file, 'utf8'))).toEqual(USER_BLOCK);
      } finally {
        await fse.remove(tmp);
      }
    });

    it('leaves a project without an Antigravity hooks.json untouched', async () => {
      const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-antigravity-nofile-'));
      try {
        const projectRoot = path.join(tmp, 'project');
        await fse.ensureDir(projectRoot);

        await reconcileHooksToAllTools(toolPaths(), projectRoot, [], path.join(tmp, 'managed-hooks.json'));

        expect(await fse.pathExists(path.join(projectRoot, '.agents', 'hooks.json'))).toBe(false);
        expect(await fse.pathExists(path.join(projectRoot, 'hooks.json'))).toBe(false);
      } finally {
        await fse.remove(tmp);
      }
    });
  });
});

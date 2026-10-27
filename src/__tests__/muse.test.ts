import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileHooks } from '../hooks.js';
import { loadMcpManifest, mcpRelocated, reconcileMcpForConfig } from '../mcp-reconcile.js';
import { buildMcpDeliveryChecks, mcpTransportNotes } from '../doctor-delivery.js';
import { isInstalled } from './helpers/install-gate.js';
import { AgentsHandler } from '../resources/agents.js';
import { museAgentDrops, renderForTool, type AgentSpec } from '../resources/agent-format.js';
import matter from 'gray-matter';
import { TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

// The hooks contract of Muse Code 1.4.6, observed with the real binary and
// its SDK docs: a group carries only `matcher` and `hooks` (a group with any
// other key, such as Claude's `description`, is dropped with a warning), a
// handler only the keys below, and UserPromptSubmit and Stop accept no
// matcher other than `*`.
const MUSE_GROUP_KEYS = new Set(['matcher', 'hooks']);
const MUSE_HANDLER_KEYS = new Set([
  'type', 'command', 'timeout', 'statusMessage', 'async', 'onFailure', 'commandWindows', 'command_windows', 'outputCapabilities',
]);

interface MuseHookGroup { matcher?: string; hooks: Record<string, unknown>[] }
interface MuseSettings { schema_version?: number; hooks?: Record<string, MuseHookGroup[]>; [key: string]: unknown }

describe('Muse Code hooks', () => {
  let home: string;
  let settingsPath: string;

  beforeEach(async () => {
    home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-muse-hooks-'));
    settingsPath = path.join(home, '.config', 'muse', 'settings.json');
    await fse.ensureDir(path.dirname(settingsPath));
  });

  afterEach(async () => {
    await fse.remove(home);
  });

  it('writes a settings.json Muse Code loads: schema_version 1 and only the hook keys it accepts', async () => {
    await reconcileHooks(settingsPath, 'muse');

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    expect(settings.schema_version).toBe(1);
    const events = settings.hooks ?? {};
    expect(Object.keys(events)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']));
    for (const [event, groups] of Object.entries(events)) {
      for (const group of groups) {
        expect(Object.keys(group).every((key) => MUSE_GROUP_KEYS.has(key)), `${event} group ${JSON.stringify(group)}`).toBe(true);
        if (event === 'UserPromptSubmit' || event === 'Stop') expect(group.matcher ?? '*').toBe('*');
        for (const handler of group.hooks) {
          expect(Object.keys(handler).every((key) => MUSE_HANDLER_KEYS.has(key)), JSON.stringify(handler)).toBe(true);
          expect(handler.command).toMatch(/teamai hook-dispatch \S+ --tool muse\b/);
        }
      }
    }
  });

  it("runs the skill-usage hook on Muse's read_skill tool through the wildcard pass", async () => {
    await reconcileHooks(settingsPath, 'muse');

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    const groups = settings.hooks?.PostToolUse ?? [];
    expect(groups.some((group) => group.hooks.some((handler) => String(handler.command).includes('--matcher Skill')))).toBe(false);
    expect(groups.map((group) => group.matcher)).toEqual([undefined, 'TodoWrite']);
  });

  it('keeps the rest of an existing settings.json and its schema_version', async () => {
    await fse.writeJson(settingsPath, {
      schema_version: 1,
      model: 'muse-spark-1.3',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });

    await reconcileHooks(settingsPath, 'muse');
    const first = await fse.readFile(settingsPath, 'utf8');
    await reconcileHooks(settingsPath, 'muse');

    expect(await fse.readFile(settingsPath, 'utf8')).toBe(first);
    const settings = JSON.parse(first) as MuseSettings;
    expect(settings.model).toBe('muse-spark-1.3');
    expect(settings.hooks?.SessionStart?.[0]).toEqual({ hooks: [{ type: 'command', command: 'echo mine' }] });
  });

  it('removeAll strips only the teamai entries', async () => {
    await fse.writeJson(settingsPath, {
      schema_version: 1,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });
    await reconcileHooks(settingsPath, 'muse');

    await reconcileHooks(settingsPath, 'muse', [], { removeAll: true });

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    expect(settings.schema_version).toBe(1);
    expect(JSON.stringify(settings)).not.toContain('teamai hook-dispatch');
    expect(settings.hooks?.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  });
});

// Muse Code 1.4.6 loads `mcpServers` from its settings.json with `type: stdio`
// or `type: http`; a single `type: sse` server fails startup validation and
// disables every MCP server.
describe('Muse Code MCP', () => {
  let root: string;
  let home: string;
  let settingsPath: string;
  let team: TeamaiConfig;
  let config: LocalConfig;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-muse-mcp-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    settingsPath = path.join(home, '.config', 'muse', 'settings.json');
    await fse.outputFile(path.join(root, 'repo', 'mcp', 'mcp.yaml'), `servers:
  - name: local
    transport: stdio
    command: node
    args: [server.mjs]
    env: { MODE: test }
  - name: remote
    transport: http
    url: https://example.com/mcp
    headers: { Authorization: 'Bearer public-fixture' }
  - name: legacy
    transport: sse
    url: https://example.com/sse
`);
    team = TeamaiConfigSchema.parse({ team: 'fixture', repo: 'fixture', provider: 'git' });
    config = {
      repo: { localPath: path.join(root, 'repo'), remote: 'fixture' },
      username: 'tester', scope: 'user', enabledAgents: ['muse'], additionalRoles: [],
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  it.each(['add', 'update', 'remove'])('preserves foreign Muse-saved entries when a pull must %s team servers', async (operation) => {
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const settings = await fse.readJson(settingsPath);
    const foreign = { command: 'my-server', args: ['--local'], env: { B: 'two', A: 'one' } };
    settings.mcpServers.personal = foreign;
    delete settings.mcpServers.local.type;
    const savedLocal = structuredClone(settings.mcpServers.local);
    if (operation === 'add') delete settings.mcpServers.remote;
    if (operation === 'update') {
      const file = path.join(root, 'repo', 'mcp', 'mcp.yaml');
      await fse.writeFile(file, (await fse.readFile(file, 'utf8')).replace('command: node', 'command: new-node'));
    }
    await fse.writeJson(settingsPath, settings);

    await reconcileMcpForConfig(team, config, { removeAll: operation === 'remove' });

    const after = await fse.readJson(settingsPath);
    expect(JSON.stringify(after.mcpServers.personal)).toBe(JSON.stringify(foreign));
    if (operation === 'add') expect(after.mcpServers.local).toEqual(savedLocal);
    if (operation === 'update') expect(after.mcpServers.local.command).toBe('new-node');
    if (operation === 'remove') expect(after.mcpServers).not.toHaveProperty('local');
  });

  it.each(['local', 'remote'])('removes the managed %s server after Muse reorders its object keys', async (name) => {
    const file = path.join(root, 'repo', 'mcp', 'mcp.yaml');
    await fse.writeFile(file, (await fse.readFile(file, 'utf8')).replace('env: { MODE: test }', 'env: { MODE: test, EXTRA: value }'));
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const settings = await fse.readJson(settingsPath);
    const server = settings.mcpServers[name];
    if (name === 'local') {
      delete server.type;
      server.env = Object.fromEntries(Object.entries(server.env).reverse());
    }
    settings.mcpServers[name] = Object.fromEntries(Object.entries(server).reverse());
    await fse.writeJson(settingsPath, settings);

    const context = { localConfig: config, teamConfig: team, toolPaths: team.toolPaths, hookToolPaths: team.toolPaths, baseDir: home };
    const check = (await buildMcpDeliveryChecks(context)).find(item => item.name === 'MCP servers delivered to muse');
    expect(await check!.check()).toBe(true);
    await reconcileMcpForConfig(team, config, { removeAll: true });
    expect((await fse.readJson(settingsPath)).mcpServers).not.toHaveProperty(name);
  });

  it.each(['command', 'args', 'env'])('keeps a reordered Muse server with a real %s edit', async (field) => {
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const settings = await fse.readJson(settingsPath);
    const server = settings.mcpServers.local;
    delete server.type;
    server[field] = field === 'command' ? 'my-node' : field === 'args' ? ['my-server.mjs'] : { MODE: 'personal' };
    settings.mcpServers.local = Object.fromEntries(Object.entries(server).reverse());
    await fse.writeJson(settingsPath, settings);

    await reconcileMcpForConfig(team, config, { removeAll: true });
    expect((await fse.readJson(settingsPath)).mcpServers.local[field]).toEqual(server[field]);
  });

  it.each([false, true])('uses the legacy hash to distinguish reordering from a different historical value (edited=%s)', async (edited) => {
    const repo = path.join(root, 'repo');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: repo });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'original MCP');
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const { manifestPath, manifest } = await loadMcpManifest(config, true);
    for (const record of manifest.muse) delete record.valueHash;
    await fse.writeJson(manifestPath, manifest);
    const file = path.join(repo, 'mcp', 'mcp.yaml');
    await fse.writeFile(file, (await fse.readFile(file, 'utf8')).replace('command: node', 'command: different-node'));
    git('add', '.');
    git('commit', '-q', '-m', 'new MCP');
    const settings = await fse.readJson(settingsPath);
    const server = settings.mcpServers.local;
    delete server.type;
    if (edited) server.command = 'different-node';
    settings.mcpServers.local = Object.fromEntries(Object.entries(server).reverse());
    await fse.writeJson(settingsPath, settings);

    await reconcileMcpForConfig(team, config, { removeAll: true });
    expect((await fse.readJson(settingsPath)).mcpServers.local !== undefined).toBe(edited);
  });

  it('keeps an unverifiable reordered legacy server when team history is unavailable', async () => {
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const { manifestPath, manifest } = await loadMcpManifest(config, true);
    for (const record of manifest.muse) delete record.valueHash;
    await fse.writeJson(manifestPath, manifest);
    const settings = await fse.readJson(settingsPath);
    settings.mcpServers.local = Object.fromEntries(Object.entries(settings.mcpServers.local).reverse());
    await fse.writeJson(settingsPath, settings);
    await reconcileMcpForConfig(team, config, { removeAll: true });
    expect((await fse.readJson(settingsPath)).mcpServers.local).toEqual(settings.mcpServers.local);
  });

  it('preserves a member-edited stdio server after Muse omits type', async () => {
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const settings = await fse.readJson(settingsPath);
    delete settings.mcpServers.local.type;
    settings.mcpServers.local.command = 'my-node';
    await fse.writeJson(settingsPath, settings);

    await reconcileMcpForConfig(team, config, { removeAll: true });
    expect((await fse.readJson(settingsPath)).mcpServers.local.command).toBe('my-node');
  });

  it('keeps a stdio server managed after Muse saves it without type', async () => {
    await fse.outputJson(settingsPath, { schema_version: 1 });
    await reconcileMcpForConfig(team, config);
    const settings = await fse.readJson(settingsPath);
    delete settings.mcpServers.local.type;
    await fse.writeJson(settingsPath, settings);
    const context = { localConfig: config, teamConfig: team, toolPaths: team.toolPaths, hookToolPaths: team.toolPaths, baseDir: home };
    const checks = await buildMcpDeliveryChecks(context);
    const delivery = checks.find(check => check.name === 'MCP servers delivered to muse');
    expect(await delivery!.check()).toBe(true);
    await reconcileMcpForConfig(team, config, { removeAll: true });
    expect((await fse.readJson(settingsPath)).mcpServers).not.toHaveProperty('local');
  });

  it('writes stdio and http servers into settings.json, keeping its schema_version and hooks, and leaves sse out', async () => {
    const hooks = { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] };
    await fse.outputJson(settingsPath, { schema_version: 1, hooks });

    const result = await reconcileMcpForConfig(team, config);

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    expect(settings.schema_version).toBe(1);
    expect(settings.hooks).toEqual(hooks);
    expect(settings.mcpServers).toEqual({
      local: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { MODE: 'test' } },
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer public-fixture' } },
    });
    expect(result.changes).toContainEqual(expect.objectContaining({
      tool: 'muse', server: 'legacy', action: 'skipped', reason: 'muse does not support sse transport',
    }));
  });

  describe('doctor, in a project whose .mcp.json Claude Code shares', () => {
    const projectChecks = async (agents: string[] | undefined, { claudeDir = true } = {}) => {
      const projectRoot = path.join(root, 'project');
      if (claudeDir) await fse.ensureDir(path.join(projectRoot, '.claude'));
      else await fse.ensureDir(projectRoot);
      await fse.ensureDir(path.join(home, '.config', 'muse'));
      const local: LocalConfig = { ...config, scope: 'project', projectRoot, enabledAgents: agents };
      const result = await reconcileMcpForConfig(team, local);
      const context = { localConfig: local, teamConfig: team, toolPaths: team.toolPaths, hookToolPaths: team.toolPaths, baseDir: home };
      const checks = await buildMcpDeliveryChecks(context);
      return { file: path.join(projectRoot, '.mcp.json'), checks, result, notes: await mcpTransportNotes(context) };
    };

    it("names the sse server Claude Code's render left there, which stops Muse Code loading any", async () => {
      const { file, checks } = await projectChecks(['claude', 'muse']);

      expect((await fse.readJson(file)).mcpServers.legacy).toEqual({ type: 'sse', url: 'https://example.com/sse' });
      const loads = checks.find((check) => check.name === 'MCP servers load in muse');
      expect(loads).toBeDefined();
      expect(await loads!.check()).toBe(false);
      expect(loads!.fix).toContain(`In ${file}, legacy uses the sse transport`);
    });

    it('writes .mcp.json for a Muse-only whitelist without the sse server, which no Claude Code reads there', async () => {
      const { file, checks, result } = await projectChecks(['muse']);

      expect(Object.keys((await fse.readJson(file)).mcpServers)).toEqual(['local', 'remote']);
      expect(result.changes).toContainEqual(expect.objectContaining({
        server: 'legacy', action: 'skipped', reason: 'muse does not support sse transport',
      }));
      const loads = checks.find((check) => check.name === 'MCP servers load in muse');
      expect(await loads!.check()).toBe(true);
      const names = checks.map((check) => check.name);
      expect(names).toContain('MCP servers delivered to muse');
      expect(names).not.toContain('MCP servers delivered to claude');
    });

    // The team cannot fix an sse server for Muse from Muse: doctor names it, and passes delivery.
    it('notes the sse server Muse Code cannot use instead of failing its delivery', async () => {
      const { file, checks, notes } = await projectChecks(['muse']);

      const delivered = checks.find((check) => check.name === 'MCP servers delivered to muse');
      expect(await delivered!.check()).toBe(true);
      expect(notes).toEqual([`MCP servers muse cannot use: legacy (sse) in ${file}, over a transport muse does not support.`]);
    });

    it('writes .mcp.json for Muse Code in a project with no .claude directory', async () => {
      const { file } = await projectChecks(undefined, { claudeDir: false });

      expect(Object.keys((await fse.readJson(file)).mcpServers)).toEqual(['local', 'remote']);
    });

    it('says nothing when only Claude Code reads the file', async () => {
      const { checks } = await projectChecks(['claude']);

      expect(checks.map((check) => check.name)).not.toContain('MCP servers load in muse');
    });

    // A server the team limits to Muse Code goes in the file Muse reads, shared with Claude Code or not.
    it.each([[['muse']], [['claude', 'muse']]])('writes a server limited to muse into .mcp.json for %j', async (agents) => {
      await fse.appendFile(path.join(root, 'repo', 'mcp', 'mcp.yaml'), `  - name: muse-only
    transport: stdio
    command: node
    tools: [muse]
`);
      const { file, checks } = await projectChecks(agents);

      expect(Object.keys((await fse.readJson(file)).mcpServers)).toContain('muse-only');
      for (const check of checks.filter((item) => item.name.startsWith('MCP servers delivered to'))) {
        expect((await check.check()) || check.fix).toBe(true);
      }
    });
  });

  // Muse Code reads only <root>/.mcp.json, so a claude mapping elsewhere is not a file Muse reads.
  it.each([['without', false], ['with', true]])('does not take a Claude Code project MCP file mapped elsewhere for one Muse Code reads, %s a .claude directory', async (_name, claudeDir) => {
    const projectRoot = path.join(root, 'project');
    await fse.ensureDir(claudeDir ? path.join(projectRoot, '.claude') : projectRoot);
    await fse.ensureDir(path.join(home, '.config', 'muse'));
    const mapped = TeamaiConfigSchema.parse({
      team: 'fixture', repo: 'fixture', provider: 'git',
      toolPaths: { ...team.toolPaths, claude: { ...team.toolPaths.claude, mcpProject: '.claude/mcp.json' } },
    });
    const local: LocalConfig = { ...config, scope: 'project', projectRoot, enabledAgents: ['muse'] };

    await reconcileMcpForConfig(mapped, local);

    expect(await fse.pathExists(path.join(projectRoot, '.claude', 'mcp.json'))).toBe(false);
  });

  // Muse Code reads a project's servers from the .mcp.json the claude target
  // writes, as tclaude does, so that file stays while Muse is installed.
  it.each([
    ['moves Claude Code\'s project servers to its local scope without Muse Code', false, true],
    ['keeps them in .mcp.json while Muse Code is installed', true, false],
  ])('with sharing.gitExclude on, %s', async (_name, museInstalled, relocated) => {
    const projectRoot = path.join(root, 'project');
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    if (museInstalled) await fse.ensureDir(path.join(home, '.config', 'muse'));
    const local: LocalConfig = { ...config, scope: 'project', projectRoot, gitExcludeEnabled: true, enabledAgents: undefined };

    expect(await mcpRelocated(team, local, 'claude')).toBe(relocated);
  });

  it('creates a settings.json Muse Code loads when none exists', async () => {
    await fse.ensureDir(path.dirname(settingsPath));

    await reconcileMcpForConfig(team, config);

    const settings = await fse.readJson(settingsPath) as MuseSettings;
    expect(settings.schema_version).toBe(1);
    expect(Object.keys(settings.mcpServers as object)).toEqual(['local', 'remote']);
  });
});

// Every project path Muse Code reads (.agents/skills, .agents/agents, .mcp.json)
// is shared with other tools, so only its HOME root says the member runs it.
describe('Muse Code detection', () => {
  let root: string;
  let home: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-muse-detect-'));
    home = path.join(root, 'home');
    projectRoot = path.join(root, 'project');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    await fse.ensureDir(path.join(projectRoot, '.agents', 'skills'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  const projectConfig = (enabledAgents?: string[]): LocalConfig => ({
    repo: { localPath: path.join(root, 'repo'), remote: 'fixture' },
    username: 'tester', scope: 'project', projectRoot, additionalRoles: [], ...(enabledAgents ? { enabledAgents } : {}),
  });

  it('finds Muse Code in a project scope by ~/.config/muse', async () => {
    await fse.ensureDir(path.join(home, '.config', 'muse'));

    expect(await isInstalled('muse', 'skills', projectConfig())).toBe(true);
  });

  it('does not take a project .agents directory for Muse Code', async () => {
    expect(await isInstalled('muse', 'skills', projectConfig())).toBe(false);
  });
});

// Muse Code 1.4.6 agent definitions: a closed frontmatter (name, description,
// model, tools; any other key, such as effort, rejects the definition), and
// `tools` naming Muse's own tools: a Claude name such as `Read` rejects the
// definition with `tools: unknown_tool`, and the child never starts.
describe('Muse Code agents', () => {
  const spec: AgentSpec = {
    name: 'reviewer',
    description: 'Reviews a change',
    instructions: 'Review the diff.',
    model: 'muse-spark-1.3',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'NotebookEdit', 'web_fetch'],
  };
  const frontmatter = (content: string) => matter(content).data;

  it('writes only the keys Muse Code accepts, with tools in its own names', () => {
    const { ext, content } = renderForTool(spec, 'muse', { model: 'muse-spark-1.3', effort: 'high' });

    expect(ext).toBe('.md');
    expect(frontmatter(content)).toEqual({
      name: 'reviewer',
      description: 'Reviews a change',
      model: 'muse-spark-1.3',
      tools: ['read_file', 'search', 'bash', 'edit_file', 'web_fetch'],
    });
    expect(matter(content).content.trim()).toBe('Review the diff.');
  });

  it('keeps from tool_extras.muse only the keys Muse Code accepts', () => {
    const { content } = renderForTool({ ...spec, tool_extras: { muse: { tools: ['Read'], color: 'blue', effort: 'max' } } }, 'muse');

    expect(frontmatter(content).tools).toEqual(['read_file']);
    expect(frontmatter(content)).not.toHaveProperty('color');
    expect(frontmatter(content)).not.toHaveProperty('effort');
  });

  // Muse Code gives an agent with no `tools` every tool; `tools: []` leaves it only its subagent controls.
  it('keeps an agent whose tools Muse Code has none of restricted, rather than giving it every tool', () => {
    const { content } = renderForTool({ ...spec, tools: ['NotebookEdit'] }, 'muse');

    expect(frontmatter(content).tools).toEqual([]);
  });

  it.each([
    ['tools: []', { tools: [] }],
    ['tool_extras.muse.tools: []', { tool_extras: { muse: { tools: [] } } }],
  ])('keeps an explicit %s as no tools', (_name, fields) => {
    const { content } = renderForTool({ ...spec, ...fields }, 'muse');

    expect(frontmatter(content).tools).toEqual([]);
  });

  it('leaves tools out for an agent that limits none', () => {
    const { content } = renderForTool({ ...spec, tools: undefined }, 'muse');

    expect(frontmatter(content)).not.toHaveProperty('tools');
  });

  it('names what the render drops', () => {
    expect(museAgentDrops({ ...spec, tool_extras: { muse: { color: 'blue' } } })).toEqual({
      tools: ['NotebookEdit'], extras: ['color'],
    });
  });

  // Muse Code's tool names (`read_file`) mean nothing to other tools, so a pushed Muse copy keeps them in tool_extras.muse.
  describe('push', () => {
    let root: string;
    let teamRepo: string;
    let agentsDir: string;
    const teamConfig = TeamaiConfigSchema.parse({ team: 'muse-agents', repo: 'fixture', provider: 'git' });
    const localConfig = (): LocalConfig => ({
      repo: { localPath: teamRepo, remote: 'fixture' }, username: 'tester', scope: 'user', enabledAgents: ['muse'], additionalRoles: [],
    });

    beforeEach(async () => {
      root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-muse-agents-'));
      teamRepo = path.join(root, 'repo');
      agentsDir = path.join(root, 'home', '.config', 'muse', 'agents');
      vi.stubEnv('HOME', path.join(root, 'home'));
      vi.stubEnv('USERPROFILE', path.join(root, 'home'));
      await fse.ensureDir(agentsDir);
      await fse.ensureDir(path.join(teamRepo, 'agents'));
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fse.remove(root);
    });

    it.each([
      { change: 'an edited tool list', team: true, expected: { tools: ['Read', 'Grep'], tool_extras: { muse: { tools: ['read_file', 'search', 'write_file'] } } } },
      { change: 'a new agent', team: false, expected: { tools: undefined, tool_extras: { muse: { tools: ['read_file', 'search', 'write_file'] } } } },
    ])('pushes $change in Muse Code names to tool_extras.muse, never to tools', async ({ team, expected }) => {
      const handler = new AgentsHandler();
      const deployed = path.join(agentsDir, 'reviewer.md');
      if (team) {
        const sourcePath = path.join(teamRepo, 'agents', 'reviewer.yaml');
        await fse.writeFile(sourcePath, 'name: reviewer\ndescription: Reviews a change\ninstructions: Review the diff.\ntools: [Read, Grep]\n');
        await handler.pullItem({ name: 'reviewer', type: 'agents', sourcePath, relativePath: 'agents/reviewer.yaml' }, teamConfig, localConfig());
        await fse.writeFile(deployed, (await fse.readFile(deployed, 'utf8')).replace('  - search\n', '  - search\n  - write_file\n'));
      } else {
        await fse.writeFile(deployed, '---\nname: reviewer\ndescription: Reviews a change\ntools:\n  - read_file\n  - search\n  - write_file\n---\nReview the diff.\n');
      }

      const pushed = (await handler.scanLocalForPush(teamConfig, localConfig())).find((candidate) => candidate.name === 'reviewer');

      expect(pushed?.mergedSpec?.tools).toEqual(expected.tools);
      expect(pushed?.mergedSpec?.tool_extras).toEqual(expected.tool_extras);
      expect(frontmatter(renderForTool(pushed!.mergedSpec!, 'muse').content).tools).toEqual(['read_file', 'search', 'write_file']);
    });
  });
});

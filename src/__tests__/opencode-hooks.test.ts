import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import fse from 'fs-extra';

/** Compile the generated module without rewriting its exports. */
function assertValidJs(src: string): void {
  expect(() => loadPluginDefinition(src)).not.toThrow();
}

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  resolveOpencodePluginDir,
  injectOpencodeHooks,
  removeOpencodeHooks,
  applyOpencodeAgentHook,
  removeOpencodeAgentHook,
  buildPluginSource,
  buildAgentHookPluginSource,
  OPENCODE_HOOK_FILE,
} from '../opencode-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { loadOpencodePlugin, loadPluginDefinition, loadV2Plugin } from './helpers/opencode-plugin.js';
import { log } from '../utils/logger.js';

describe('resolveOpencodePluginDir', () => {
  it('project scope → <base>/.opencode/plugin', () => {
    expect(resolveOpencodePluginDir('/repo', 'project')).toBe(path.join('/repo', '.opencode', 'plugin'));
  });
  it('user scope → <base>/.config/opencode/plugin', () => {
    expect(resolveOpencodePluginDir('/home/u', 'user')).toBe(path.join('/home/u', '.config', 'opencode', 'plugin'));
  });
});

describe('buildPluginSource', () => {
  const src = buildPluginSource();
  it('loads as a default plugin definition for both OpenCode APIs', async () => {
    const plugin = loadPluginDefinition(src);
    expect(plugin.id).toBe('teamai.hooks');
    expect(typeof plugin.server).toBe('function');
    expect(typeof plugin.setup).toBe('function');
    const hooks = await plugin.server({ directory: '/work/proj' });
    expect(typeof hooks.event).toBe('function');
  });
  it('maps the four Claude built-in events to OpenCode events and teamai dispatch', () => {
    expect(src).toContain("event.type === 'session.created'");
    expect(src).toContain("dispatch('session-start',");
    expect(src).toContain("event.type === 'session.idle'");
    expect(src).toContain("dispatch('stop',");
    expect(src).toContain("'chat.message'");
    expect(src).toContain("'prompt-submit'");
    expect(src).toContain("'tool.execute.after'");
    expect(src).toContain("'post-tool-use'");
  });
  it('spawns teamai hook-dispatch with hidden Windows consoles and swallowed errors', () => {
    expect(src).toContain("'hook-dispatch'");
    expect(src).toContain("'--tool', 'opencode'");
    expect(src).toContain("import('node:child_process')");
    expect(src).toContain('windowsHide: true');
    expect(src).not.toContain('.quiet().nothrow()');
  });
  it('forwards a STDIN payload (cwd + per-event fields) through child_process', () => {
    // cwd comes from the plugin ctx (directory / worktree), fed on STDIN so the
    // provider-config gate and track/hint handlers work.
    expect(src).toContain('directory');
    expect(src).toContain('worktree');
    expect(src).toContain('JSON.stringify({ cwd');
    expect(src).toContain('child.stdin.write(stdin)');
    expect(src).not.toContain('new Response(stdin)');
  });
  it('maps lowercase OpenCode tool ids back to PascalCase matchers', () => {
    // OpenCode passes `skill` / `todowrite`; the handler registry keys matchers
    // on `Skill` / `TodoWrite`.
    expect(src).toContain("skill: 'Skill'");
    expect(src).toContain("todowrite: 'TodoWrite'");
    expect(src).toContain('TOOL_MATCHER[tool]');
    // The dead PascalCase id comparison must be gone.
    expect(src).not.toContain("tool === 'Skill'");
  });
  it('forwards tool_name / tool_input on post-tool-use and prompt on chat.message', () => {
    expect(src).toContain('tool_name');
    expect(src).toContain('tool_input');
    expect(src).toContain('prompt');
  });
  it('is syntactically valid JavaScript', () => {
    assertValidJs(src);
  });

  it('does not retain child-process listeners across repeated dispatches', async () => {
    const spawns: Array<{ child: any; options: any }> = [];
    const fakeSpawn = vi.fn((_command: string, _args: string[], options: any) => {
      const child = new EventEmitter() as any;
      child.stdin = {
        write: vi.fn(),
        end: vi.fn(() => Promise.resolve().then(() => child.emit('close', 0))),
      };
      spawns.push({ child, options });
      return child;
    });
    const plugin = loadPluginDefinition(src, {
      __childProcess: { spawn: fakeSpawn },
      process: { platform: 'win32' },
    });
    const hooks = await plugin.server({ directory: 'C:/workspace' });

    for (let i = 0; i < 12; i += 1) {
      await hooks.event({ event: { type: 'session.created' } });
    }

    expect(fakeSpawn).toHaveBeenCalledTimes(12);
    expect(spawns.every(({ options }) => options.windowsHide === true)).toBe(true);
    expect(spawns.every(({ options }) => options.stdio[0] === 'pipe')).toBe(true);
    expect(spawns.every(({ child }) => child.listenerCount('close') === 0)).toBe(true);
    expect(spawns.every(({ child }) => child.listenerCount('error') === 0)).toBe(true);
  });
});

// #884: every dispatch carries the host session, so recall attribution joins
// the OpenCode session instead of a pid fallback.
describe('OpenCode plugin: bridge payloads (#884)', () => {
  const PARENT = 'ses_parent';
  const CHILD = 'ses_child';

  it('sends the host session id on session start, prompt submission and Stop', async () => {
    const { hooks, dispatches } = await loadOpencodePlugin({ directory: '/work/proj' });
    await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT, info: { id: PARENT } } } });
    // Older hosts: session.created carries only the session info.
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: CHILD, parentID: PARENT } } } });
    await hooks['chat.message']({ sessionID: PARENT }, { parts: [{ type: 'text', text: '/retry now' }] });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });

    expect(dispatches.map((d) => [d.args[1], d.payload])).toEqual([
      ['session-start', { cwd: '/work/proj', session_id: PARENT }],
      ['session-start', { cwd: '/work/proj', session_id: CHILD }],
      ['prompt-submit', { cwd: '/work/proj', session_id: PARENT, prompt: '/retry now' }],
      ['stop', { cwd: '/work/proj', session_id: PARENT }],
    ]);
  });

  it('sends PostToolUse with the session, the tool output and a status normalized from what the host reports', async () => {
    const { hooks, dispatches } = await loadOpencodePlugin({ directory: '/work/proj' });
    const after = hooks['tool.execute.after'];
    await after({ tool: 'bash', sessionID: PARENT, callID: 'c1', args: { command: 'cat a.md' } },
      { title: 'cat a.md', output: 'hello', metadata: { exit: 0, output: 'hello' } });
    await after({ tool: 'bash', sessionID: PARENT, callID: 'c2', args: { command: 'cat b.md' } },
      { title: 'cat b.md', output: 'cat: b.md: No such file', metadata: { exit: 1 } });
    // Only bash reports an exit code; the other tools have no status to read.
    await after({ tool: 'read', sessionID: PARENT, callID: 'c3', args: { filePath: '/kb/a.md' } },
      { title: 'a.md', output: '<path>/kb/a.md</path>', metadata: {} });

    expect(dispatches.map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: PARENT, tool_name: 'bash', tool_input: { command: 'cat a.md' }, tool_response: 'hello', tool_status: 'success' },
      { cwd: '/work/proj', session_id: PARENT, tool_name: 'bash', tool_input: { command: 'cat b.md' }, tool_response: 'cat: b.md: No such file', tool_status: 'failure' },
      { cwd: '/work/proj', session_id: PARENT, tool_name: 'read', tool_input: { filePath: '/kb/a.md' }, tool_response: '<path>/kb/a.md</path>', tool_status: 'unknown' },
    ]);
  });

  it('still dispatches when the host passes no output or session (older OpenCode)', async () => {
    const { hooks, dispatches } = await loadOpencodePlugin({ directory: '/work/proj' });
    await hooks['tool.execute.after']({ tool: 'bash' });
    await hooks.event({ event: { type: 'session.idle' } });
    expect(dispatches.map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', tool_name: 'bash', tool_input: {}, tool_status: 'unknown' },
      { cwd: '/work/proj' },
    ]);
  });

  it('turns a task completion into a link from the child session to its parent', async () => {
    const { hooks, dispatches } = await loadOpencodePlugin({ directory: '/work/proj' });
    await hooks['tool.execute.after']({ tool: 'task', sessionID: PARENT, callID: 'c1', args: { prompt: 'find docs' } },
      { title: 'find docs', output: '<task id="ses_child" state="completed">', metadata: { sessionId: CHILD, parentSessionId: PARENT, model: {} } });
    // Older hosts: the metadata names only the child; the task ran in the parent.
    await hooks['tool.execute.after']({ tool: 'task', sessionID: PARENT, callID: 'c2', args: {} },
      { title: 'x', output: '', metadata: { sessionId: 'ses_child2' } });
    // No child id: no link.
    await hooks['tool.execute.after']({ tool: 'task', sessionID: PARENT, callID: 'c3', args: {} }, { title: 'x', output: '', metadata: {} });

    expect(dispatches.map((d) => d.payload.session_link)).toEqual([
      { child: CHILD, parent: PARENT },
      { child: 'ses_child2', parent: PARENT },
      undefined,
    ]);
  });

  it('sets TEAMAI_AGENT_SESSION_ID in the bash environment to the session the command runs in', async () => {
    const { hooks } = await loadOpencodePlugin({ directory: '/work/proj' });
    const output = { env: { KEEP: '1' } as Record<string, string> };
    await hooks['shell.env']({ cwd: '/work/proj', sessionID: CHILD, callID: 'c1' }, output);
    expect(output.env).toEqual({ KEEP: '1', TEAMAI_AGENT_SESSION_ID: CHILD });

    // A terminal with no session: nothing to name.
    const pty = { env: {} as Record<string, string> };
    await hooks['shell.env']({ cwd: '/work/proj' }, pty);
    expect(pty.env).toEqual({});
  });
});

describe('buildAgentHookPluginSource is valid JS across event kinds and tricky commands', () => {
  it('session event', () => assertValidJs(buildAgentHookPluginSource('s', 'session.created', 'echo hi')));
  it('chat event with quotes in command', () => assertValidJs(buildAgentHookPluginSource('c', 'chat.message', `do "q" and 'q'`)));
  it('tool event with backtick in command', () => assertValidJs(buildAgentHookPluginSource('t', 'tool.execute.after', 'run `x`')));
  it('slug with hyphens produces a valid identifier', () => {
    const s = buildAgentHookPluginSource('my-cool-hook', 'session.idle', 'x');
    expect(s).toContain('TeamaiAgentHook_my_cool_hook');
    assertValidJs(s);
  });
});

describe('injectOpencodeHooks / removeOpencodeHooks', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-hooks-')); });
  afterEach(async () => { await fse.remove(tmp); });

  it('project scope writes .opencode/plugin/teamai-hooks.ts', async () => {
    await injectOpencodeHooks(tmp, 'project');
    const file = path.join(tmp, '.opencode', 'plugin', OPENCODE_HOOK_FILE);
    expect(await fse.pathExists(file)).toBe(true);
    expect(await fse.readFile(file, 'utf8')).toContain('[teamai] hooks plugin');
  });

  it('user scope writes .config/opencode/plugin/teamai-hooks.ts', async () => {
    await injectOpencodeHooks(tmp, 'user');
    const file = path.join(tmp, '.config', 'opencode', 'plugin', OPENCODE_HOOK_FILE);
    expect(await fse.pathExists(file)).toBe(true);
  });

  it('is idempotent — re-inject produces identical bytes', async () => {
    await injectOpencodeHooks(tmp, 'project');
    const file = path.join(tmp, '.opencode', 'plugin', OPENCODE_HOOK_FILE);
    const first = await fse.readFile(file, 'utf8');
    await injectOpencodeHooks(tmp, 'project');
    expect(await fse.readFile(file, 'utf8')).toBe(first);
  });

  it('reports the injection only when the plugin changes', async () => {
    await injectOpencodeHooks(tmp, 'project');
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai OpenCode hook'));
    vi.mocked(log.success).mockClear();

    await injectOpencodeHooks(tmp, 'project');
    expect(log.success).not.toHaveBeenCalled();
  });

  it('remove deletes the plugin file; safe when absent', async () => {
    await removeOpencodeHooks(tmp, 'project'); // no-op, no throw
    await injectOpencodeHooks(tmp, 'project');
    const file = path.join(tmp, '.opencode', 'plugin', OPENCODE_HOOK_FILE);
    expect(await fse.pathExists(file)).toBe(true);
    await removeOpencodeHooks(tmp, 'project');
    expect(await fse.pathExists(file)).toBe(false);
  });
});

describe('agent-hook plugins', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-ah-')); });
  afterEach(async () => { await fse.remove(tmp); });

  it('installs a named plugin file for a supported event', async () => {
    await applyOpencodeAgentHook({ slug: 'my-hook', event: 'SessionStart', command: 'echo hi', baseDir: tmp, scope: 'user' });
    const file = path.join(tmp, '.config', 'opencode', 'plugin', 'teamai-agent-my-hook.ts');
    expect(await fse.pathExists(file)).toBe(true);
    const content = await fse.readFile(file, 'utf8');
    expect(content).toContain('event.type === "session.created"');
    expect(content).toContain('echo hi');
  });

  it('routes prompt / tool events to their named hooks', async () => {
    await applyOpencodeAgentHook({ slug: 'p', event: 'UserPromptSubmit', command: 'x', baseDir: tmp, scope: 'user' });
    const content = await fse.readFile(path.join(tmp, '.config', 'opencode', 'plugin', 'teamai-agent-p.ts'), 'utf8');
    expect(content).toContain('"chat.message": async');
  });

  it('skips events with no OpenCode equivalent', async () => {
    await applyOpencodeAgentHook({ slug: 'bad', event: 'PreToolUse', command: 'x', baseDir: tmp, scope: 'user' });
    expect(await fse.pathExists(path.join(tmp, '.config', 'opencode', 'plugin', 'teamai-agent-bad.ts'))).toBe(false);
  });

  it('remove deletes the agent-hook plugin', async () => {
    await applyOpencodeAgentHook({ slug: 'gone', event: 'Stop', command: 'x', baseDir: tmp, scope: 'user' });
    const file = path.join(tmp, '.config', 'opencode', 'plugin', 'teamai-agent-gone.ts');
    expect(await fse.pathExists(file)).toBe(true);
    await removeOpencodeAgentHook({ slug: 'gone', baseDir: tmp, scope: 'user' });
    expect(await fse.pathExists(file)).toBe(false);
  });

  it('gates a matcher-scoped tool hook on the tool id (case-insensitive)', async () => {
    await applyOpencodeAgentHook({ slug: 'scoped', event: 'PostToolUse', command: 'x', baseDir: tmp, scope: 'user', matcher: 'Bash' });
    const content = await fse.readFile(path.join(tmp, '.config', 'opencode', 'plugin', 'teamai-agent-scoped.ts'), 'utf8');
    // Compares the lowercase OpenCode id against the lowercased matcher.
    expect(content).toContain("tool.toLowerCase() === \"bash\"");
  });

  it('runs a tool hook unconditionally when matcher is absent or *', async () => {
    await applyOpencodeAgentHook({ slug: 'wild', event: 'PostToolUse', command: 'x', baseDir: tmp, scope: 'user', matcher: '*' });
    const content = await fse.readFile(path.join(tmp, '.config', 'opencode', 'plugin', 'teamai-agent-wild.ts'), 'utf8');
    expect(content).toContain('"tool.execute.after": async () => { await run(); }');
    expect(content).not.toContain('toLowerCase()');
  });

  it('rejects a slug with path-traversal (../) — no file escapes the plugin dir', async () => {
    await expect(
      applyOpencodeAgentHook({ slug: '../../evil', event: 'PostToolUse', command: 'x', baseDir: tmp, scope: 'user' }),
    ).rejects.toThrow(/Invalid agent-hook slug/);
    // Nothing was written outside the plugin dir.
    expect(await fse.pathExists(path.join(tmp, '.config', 'evil.ts'))).toBe(false);
  });
});

describe('reconcileHooksToAllTools routes opencode to the plugin adapter', () => {
  let tmp: string;
  let home: string;
  let projectRoot: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-recon-'));
    home = path.join(tmp, 'home');
    projectRoot = path.join(tmp, 'project');
    await fse.ensureDir(home);
    await fse.ensureDir(projectRoot);
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fse.remove(tmp);
  });

  const toolPaths = { opencode: { skills: '.opencode/skills' } } as Record<string, { settings?: string }>;
  const manifest = () => path.join(tmp, 'managed-hooks.json');
  const userPlugin = () => path.join(home, '.config', 'opencode', 'plugin', OPENCODE_HOOK_FILE);
  const projectPlugin = () => path.join(projectRoot, '.opencode', 'plugin', OPENCODE_HOOK_FILE);

  it('does nothing when OpenCode is not installed (no user config dir)', async () => {
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(userPlugin())).toBe(false);
    expect(await fse.pathExists(projectPlugin())).toBe(false);
  });

  it('injects into the user plugin dir when ~/.config/opencode exists', async () => {
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(userPlugin())).toBe(true);
  });

  it('keeps a single copy when reconciling a project-scope base dir', async () => {
    // OpenCode loads BOTH ~/.config/opencode/plugin and <project>/.opencode/plugin,
    // so a project copy next to the user one would dispatch every event twice.
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    await fse.ensureDir(path.join(projectRoot, '.opencode'));
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(userPlugin())).toBe(true);
    expect(await fse.pathExists(projectPlugin())).toBe(false);
  });

  it('deletes a project-scope plugin left by an earlier layout', async () => {
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    await injectOpencodeHooks(projectRoot, 'project');
    expect(await fse.pathExists(projectPlugin())).toBe(true);
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(projectPlugin())).toBe(false);
    expect(await fse.pathExists(userPlugin())).toBe(true);
  });

  it('removeAll deletes the plugin in both locations', async () => {
    await fse.ensureDir(path.join(home, '.config', 'opencode'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    await injectOpencodeHooks(projectRoot, 'project');
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(userPlugin())).toBe(false);
    expect(await fse.pathExists(projectPlugin())).toBe(false);
  });
});

// #719 review: the PR claimed the Stop hint "reaches the user" on OpenCode. It
// does not. The generated plugin spawns hook-dispatch with stdout ignored, so
// neither the Stop payload nor the UserPromptSubmit payload ever gets back into
// the session — a gap that predates #719 and is tracked separately. Pinning it
// here means the next change that starts relying on OpenCode stdout has to come
// through this test, instead of the claim being made again from a hook-dispatch
// run that never went through the adapter.
describe('OpenCode plugin: hook stdout is discarded (#719 review)', () => {
  it('spawns hook-dispatch with stdout and stderr ignored', () => {
    expect(buildPluginSource()).toContain("stdio: ['pipe', 'ignore', 'ignore']");
  });

  it('says so in the generated file, so a reader is not misled', () => {
    expect(buildPluginSource()).toContain('cannot inject a hook');
  });
});


describe('OpenCode V2 built-in plugin', () => {
  it('dispatches lifecycle only for its location and aborts on unload', async () => {
    const host = await loadV2Plugin();
    await host.emit('session.created', { sessionID: 'ses_v2', location: { directory: '/work/proj' } });
    await host.emit('session.created', { sessionID: 'ses_other' }, { directory: '/other' });
    await host.emit('session.status', { sessionID: 'ses_v2', status: { type: 'idle' } });
    await host.emit('session.idle', { sessionID: 'ses_v2' });
    expect(host.dispatches.map((d) => [d.args[1], d.payload])).toEqual([
      ['session-start', { cwd: '/work/proj', session_id: 'ses_v2' }],
      ['stop', { cwd: '/work/proj', session_id: 'ses_v2' }],
    ]);
    await host.cleanup?.();
    expect(host.aborted()).toBe(true);
    expect(Object.keys(host.callbacks)).toEqual([]);
  });

  it('forwards prompt and tool results through shared dispatch, with aliases and exactly one matcher pass', async () => {
    const host = await loadV2Plugin();
    await host.callbacks['session.prompt']({ sessionID: 'ses_v2', prompt: { text: '/retry now' } });
    await host.callbacks['tool.execute.after']({ tool: 'skill', sessionID: 'ses_v2', input: { name: 'review' }, status: 'completed', result: { content: [{ type: 'text', text: 'loaded' }, { type: 'file', filename: 'skip' }, { type: 'text', text: 'next' }] } });
    await host.callbacks['tool.execute.after']({ tool: 'shell', sessionID: 'ses_v2', input: { command: 'false' }, status: 'completed', result: { content: 'failed', metadata: { exit: 1 } } });
    await host.callbacks['tool.execute.after']({ tool: 'shell', sessionID: 'ses_v2', input: {}, status: 'error', error: { message: 'denied' } });
    await host.callbacks['tool.execute.after']({ tool: 'subagent', sessionID: 'ses_v2', input: {}, status: 'completed', result: { content: 'child done', metadata: { sessionID: 'ses_child' } } });
    expect(host.dispatches.map((d) => d.args)).toEqual([
      ['hook-dispatch', 'prompt-submit', '--tool', 'opencode'],
      ['hook-dispatch', 'post-tool-use', '--tool', 'opencode'],
      ['hook-dispatch', 'post-tool-use', '--tool', 'opencode', '--matcher', 'Skill'],
      ['hook-dispatch', 'post-tool-use', '--tool', 'opencode'],
      ['hook-dispatch', 'post-tool-use', '--tool', 'opencode'],
      ['hook-dispatch', 'post-tool-use', '--tool', 'opencode'],
    ]);
    expect(host.dispatches[0].payload).toEqual({ cwd: '/work/proj', session_id: 'ses_v2', prompt: '/retry now' });
    expect(host.dispatches[1].payload).toMatchObject({ tool_name: 'Skill', tool_input: { name: 'review' }, tool_response: 'loaded\nnext', tool_status: 'success' });
    expect(host.dispatches[3].payload).toMatchObject({ tool_name: 'bash', tool_response: 'failed', tool_status: 'failure' });
    expect(host.dispatches[4].payload).toMatchObject({ tool_response: 'denied', tool_status: 'failure' });
    expect(host.dispatches[5].payload).toMatchObject({ tool_name: 'task', session_link: { child: 'ses_child', parent: 'ses_v2' } });
    await host.cleanup?.();
    expect(host.disposed.sort()).toEqual(['session.compaction', 'session.context', 'session.prompt', 'tool.execute.after']);
  });
});

// #915: on OpenCode V2 the team MCP servers reach a project through the plugin,
// from the `.opencode/teamai-mcp.json` pull writes, not through opencode.json.
describe('OpenCode V2 plugin: team MCP servers', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-mcp-'))); });
  afterEach(async () => { await fse.remove(tmp); });

  const MEMBER = { type: 'local', command: ['mine'] };

  it('adds the servers of the nearest project in the form V2 reads, and none outside it', async () => {
    const project = path.join(tmp, 'proj');
    await fse.outputJson(path.join(project, '.opencode', 'teamai-mcp.json'), { mcp: {
      local: { type: 'local', command: ['srv', '--flag'], environment: { TOKEN: 'abc' }, enabled: true },
      remote: { type: 'remote', url: 'https://api.example.com/mcp', enabled: false },
    } });
    const deep = path.join(project, 'src', 'deep');
    await fse.ensureDir(deep);

    const host = await loadV2Plugin(buildPluginSource(path.join(tmp, 'user')), {}, deep);
    expect(host.mcpServers({ mine: MEMBER })).toEqual({
      mine: MEMBER,
      local: { type: 'local', command: ['srv', '--flag'], environment: { TOKEN: 'abc' } },
      remote: { type: 'remote', url: 'https://api.example.com/mcp', disabled: true },
    });
    await host.cleanup?.();
    expect(host.disposed).toContain('mcp.transform');

    const outside = await loadV2Plugin(buildPluginSource(path.join(tmp, 'user')), {}, tmp);
    expect(outside.mcpServers({ mine: MEMBER })).toEqual({ mine: MEMBER });
    await outside.cleanup?.();
  });

  it('finds a project whose .opencode holds only its MCP file, and reads no context from a project above it', async () => {
    const outer = path.join(tmp, 'outer');
    await fse.outputFile(path.join(outer, '.opencode', 'teamai-context.md'), 'OUTER-CONTEXT\n');
    const inner = path.join(outer, 'inner');
    await fse.outputJson(path.join(inner, '.opencode', 'teamai-mcp.json'), { mcp: { api: { type: 'remote', url: 'https://inner.example.com', enabled: true } } });
    await fse.ensureDir(path.join(inner, 'src'));

    const host = await loadV2Plugin(buildPluginSource(path.join(tmp, 'user')), {}, path.join(inner, 'src'));
    expect(host.mcpServers()).toEqual({ api: { type: 'remote', url: 'https://inner.example.com' } });
    const event = { sessionID: 'ses', system: [] as Array<{ type: string; text: string }> };
    await host.callbacks['session.context'](event);
    expect(event.system.map((part) => part.text).join('\n')).not.toContain('OUTER-CONTEXT');
    await host.cleanup?.();
  });

  it('passes a nested .opencode that holds only the member\'s rules, to reach the teamai project above it', async () => {
    const root = path.join(tmp, 'mono');
    await fse.outputFile(path.join(root, '.opencode', 'teamai-context.md'), 'ROOT-CONTEXT\n');
    await fse.outputJson(path.join(root, '.opencode', 'teamai-mcp.json'), { mcp: { api: { type: 'remote', url: 'https://root.example.com', enabled: true } } });
    const pkg = path.join(root, 'packages', 'web');
    await fse.outputFile(path.join(pkg, '.opencode', 'rules', 'mine.md'), 'MEMBER-RULE\n');
    await fse.ensureDir(path.join(pkg, 'src'));

    const host = await loadV2Plugin(buildPluginSource(path.join(tmp, 'user')), {}, path.join(pkg, 'src'));
    expect(host.mcpServers()).toEqual({ api: { type: 'remote', url: 'https://root.example.com' } });
    const event = { sessionID: 'ses', system: [] as Array<{ type: string; text: string }> };
    await host.callbacks['session.context'](event);
    const texts = event.system.map((part) => part.text).join('\n');
    expect(texts).toContain('ROOT-CONTEXT');
    expect(texts).not.toContain('MEMBER-RULE');
    await host.cleanup?.();
  });

  it('with no teamai file above, reads every rules directory up, so a nested package\'s own rules do not hide the team\'s', async () => {
    const root = path.join(tmp, 'mono');
    await fse.outputFile(path.join(root, '.opencode', 'rules', 'team.md'), 'TEAM-RULE\n');
    const pkg = path.join(root, 'packages', 'web');
    await fse.outputFile(path.join(pkg, '.opencode', 'rules', 'mine.md'), 'MEMBER-RULE\n');
    await fse.ensureDir(path.join(pkg, 'src'));

    const host = await loadV2Plugin(buildPluginSource(path.join(tmp, 'user')), {}, path.join(pkg, 'src'));
    const event = { sessionID: 'ses', system: [] as Array<{ type: string; text: string }> };
    await host.callbacks['session.context'](event);
    const texts = event.system.map((part) => part.text);
    expect(texts.findIndex((text) => text.includes('TEAM-RULE'))).toBeGreaterThanOrEqual(0);
    expect(texts.findIndex((text) => text.includes('MEMBER-RULE'))).toBeGreaterThan(texts.findIndex((text) => text.includes('TEAM-RULE')));
    expect(host.mcpServers()).toEqual({});
    await host.cleanup?.();
  });

  it('adds nothing from an agent-hook plugin, so the servers are set once', async () => {
    await fse.outputJson(path.join(tmp, '.opencode', 'teamai-mcp.json'), { mcp: { api: { type: 'remote', url: 'https://x.example.com', enabled: true } } });
    const host = await loadV2Plugin(buildAgentHookPluginSource('s', 'session.created', 'echo hi'), {}, tmp);
    expect(host.mcpServers()).toEqual({});
    await host.cleanup?.();
  });
});

describe('enterprise dual-host dispatch', () => {
  it.each(['session.created', 'session.idle', 'chat.message', 'tool.execute.after'])('runs %s once through each matching entrypoint', async (event) => {
    const source = buildAgentHookPluginSource('enterprise', event, 'echo enterprise');
    for (const version of ['V1', 'V2']) {
      const spawn = vi.fn(() => {
        const child = new EventEmitter();
        void Promise.resolve().then(() => child.emit('close', 1));
        return child;
      });
      const globals = { __childProcess: { spawn } };
      if (version === 'V1') {
        const plugin = loadPluginDefinition(source, globals);
        expect(plugin.id).toBe('teamai.agent.enterprise');
        const hooks = await plugin.server({ directory: '/work/proj' });
        if (event.startsWith('session.')) await hooks.event({ event: { type: event } });
        else await hooks[event]({ tool: 'bash' });
      } else {
        const host = await loadV2Plugin(source, globals);
        if (event.startsWith('session.')) await host.emit(event, { sessionID: 'ses_v2' });
        else if (event === 'chat.message') await host.callbacks['session.prompt']({ sessionID: 'ses_v2', prompt: { text: 'hello' } });
        else await host.callbacks['tool.execute.after']({ tool: 'shell', status: 'completed', input: {}, result: {} });
        // Only teamai's own plugin adds the team context; one per agent hook would repeat it.
        expect(host.callbacks['session.context']).toBeUndefined();
        await host.cleanup?.();
      }
      expect(spawn).toHaveBeenCalledExactlyOnceWith('sh', ['-c', 'echo enterprise'], expect.objectContaining({ cwd: '/work/proj', stdio: 'ignore' }));
    }
  });

  it('runs the command through cmd.exe on Windows', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      void Promise.resolve().then(() => child.emit('close', 0));
      return child;
    });
    const plugin = loadPluginDefinition(buildAgentHookPluginSource('win', 'chat.message', 'echo enterprise'), {
      __childProcess: { spawn },
      process: { platform: 'win32' },
    });
    const hooks = await plugin.server({ directory: 'C:\\work\\proj' });
    await hooks['chat.message']({});
    expect(spawn).toHaveBeenCalledExactlyOnceWith('cmd.exe', ['/d', '/s', '/c', 'echo enterprise'], expect.objectContaining({ cwd: 'C:\\work\\proj', windowsHide: true }));
  });

  it.each([undefined, '*', 'BaSh'])('matches V2 tools with matcher %s', async (matcher) => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      void Promise.resolve().then(() => child.emit('close', 0));
      return child;
    });
    const host = await loadV2Plugin(buildAgentHookPluginSource('matcher', 'tool.execute.after', 'echo matched', matcher), { __childProcess: { spawn } });
    await host.callbacks['tool.execute.after']({ tool: 'shell', status: 'completed', result: {} });
    await host.callbacks['tool.execute.after']({ tool: 'skill', status: 'completed', result: {} });
    expect(spawn).toHaveBeenCalledTimes(matcher === 'BaSh' ? 1 : 2);
    await host.cleanup?.();
  });

  it('replaces an enterprise hook in place, then removes it', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-update-'));
    try {
      const def = { slug: 'update', event: 'SessionStart', baseDir: tmp, scope: 'user' as const };
      await applyOpencodeAgentHook({ ...def, command: 'echo old' });
      await applyOpencodeAgentHook({ ...def, command: 'echo new' });
      const dir = resolveOpencodePluginDir(tmp, 'user');
      expect(await fse.readdir(dir)).toEqual(['teamai-agent-update.ts']);
      expect(await fse.readFile(path.join(dir, 'teamai-agent-update.ts'), 'utf8')).not.toContain('echo old');
      await removeOpencodeAgentHook(def);
      expect(await fse.readdir(dir)).toEqual([]);
    } finally { await fse.remove(tmp); }
  });
});


describe('OpenCode subprocess failures', () => {
  it.each(['builtin', 'enterprise'])('keeps %s spawn errors non-fatal in V2', async (kind) => {
    const children: EventEmitter[] = [];
    const spawn = () => {
      const child = new EventEmitter() as EventEmitter & { stdin: { write: () => void; end: () => void } };
      child.stdin = { write: () => {}, end: () => {} };
      children.push(child);
      void Promise.resolve().then(() => child.emit('error', new Error('missing executable')));
      return child;
    };
    const source = kind === 'builtin' ? buildPluginSource() : buildAgentHookPluginSource('missing', 'chat.message', 'missing-command');
    const host = await loadV2Plugin(source, { __childProcess: { spawn } });
    await expect(host.callbacks['session.prompt']({ sessionID: 'ses_v2', prompt: { text: 'hello' } })).resolves.toBeUndefined();
    expect(children[0].listenerCount('error')).toBe(0);
    expect(children[0].listenerCount('close')).toBe(0);
    await host.cleanup?.();
  });
});

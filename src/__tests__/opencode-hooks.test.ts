import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import fse from 'fs-extra';

/** Assert a generated ESM plugin body parses as valid JS (strip `export`). */
function assertValidJs(src: string): void {
  expect(() => new vm.Script(src.replace(/export const /g, 'const '))).not.toThrow();
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
  it('maps the four Claude built-in events to OpenCode events and teamai dispatch', () => {
    expect(src).toContain("event.type === 'session.created'");
    expect(src).toContain("dispatch('session-start')");
    expect(src).toContain("event.type === 'session.idle'");
    expect(src).toContain("dispatch('stop')");
    expect(src).toContain("'chat.message'");
    expect(src).toContain("'prompt-submit'");
    expect(src).toContain("'tool.execute.after'");
    expect(src).toContain("'post-tool-use'");
  });
  it('shells out to teamai hook-dispatch --tool opencode, swallowing errors', () => {
    expect(src).toContain("'hook-dispatch'");
    expect(src).toContain("'--tool', 'opencode'");
    expect(src).toContain('.quiet().nothrow()');
  });
  it('forwards a STDIN payload (cwd + per-event fields) via a Response', () => {
    // cwd comes from the plugin ctx (directory / worktree), fed on STDIN so the
    // provider-config gate and track/hint handlers work.
    expect(src).toContain('directory');
    expect(src).toContain('worktree');
    expect(src).toContain('JSON.stringify({ cwd');
    expect(src).toContain('new Response(stdin)');
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

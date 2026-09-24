import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import fse from 'fs-extra';

function assertValidJs(src: string): void {
  const body = src.replace(/^import .*;$/gm, '').replace(/export default /g, 'const __x = ');
  expect(() => new vm.Script(body)).not.toThrow();
}

async function runSessionStartWithBrokenStdin(src: string): Promise<void> {
  const handlers = new Map<string, (event: unknown, ctx: { cwd: string }) => Promise<void>>();
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: (value: string) => void };
    kill: () => void;
  };
  const stdin = new EventEmitter() as EventEmitter & { end: (value: string) => void };
  stdin.end = () => {
    stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    queueMicrotask(() => child.emit('close', 1));
  };
  child.stdin = stdin;
  child.kill = () => undefined;
  const body = src.replace(/^import .*;$/gm, '').replace(/export default /g, 'const __x = ');
  const extension = vm.runInNewContext(`${body}\n__x`, {
    spawn: () => child,
    process: { platform: 'linux' },
    setTimeout,
    clearTimeout,
  }) as (pi: { on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => Promise<void>) => void }) => void;
  extension({ on: (event, handler) => handlers.set(event, handler) });
  await handlers.get('session_start')?.({}, { cwd: '/tmp/project' });
}

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  resolvePiExtensionsDir,
  resolvePiProjectExtensionsDir,
  injectPiHooks,
  removePiHooks,
  buildPiExtensionSource,
  buildPiAgentHookExtensionSource,
  applyPiAgentHook,
  removePiAgentHook,
  hasPiAgentHook,
  PI_HOOK_FILE,
} from '../pi-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { log } from '../utils/logger.js';
import type { HookDef } from '../types.js';

describe('Pi hook extension', () => {
  let tmp: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pi-hooks-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fse.remove(tmp);
  });

  it('resolves global and project extension directories', () => {
    expect(resolvePiExtensionsDir()).toBe(path.join(tmp, '.pi', 'agent', 'extensions'));
    expect(resolvePiProjectExtensionsDir('/repo')).toBe(path.join('/repo', '.pi', 'extensions'));
  });

  it('maps Pi lifecycle events to TeamAI dispatch events', () => {
    const src = buildPiExtensionSource();
    expect(src).toContain('pi.on("session_start"');
    expect(src).toContain('dispatch("session-start"');
    expect(src).toContain('pi.on("agent_settled"');
    expect(src).toContain('dispatch("stop"');
    expect(src).toContain('pi.on("before_agent_start"');
    expect(src).toContain('dispatch("prompt-submit"');
    expect(src).toContain('pi.on("tool_execution_end"');
    expect(src).toContain('dispatch("post-tool-use"');
    expect(src).toContain('toolInputs.get(event.toolCallId)');
  });

  it('forwards cwd, prompt and tool payload through a child stdin pipe', () => {
    const src = buildPiExtensionSource();
    expect(src).toContain('["hook-dispatch", event, "--tool", "pi"]');
    expect(src).toContain('shell: process.platform === "win32"');
    expect(src).toContain('JSON.stringify({ cwd');
    expect(src.indexOf('child.stdin?.on("error"')).toBeLessThan(src.indexOf('child.stdin?.end(stdin)'));
    expect(src).toContain('child.stdin?.end(stdin)');
    expect(src).toContain('event.prompt');
    expect(src).toContain('tool_name');
    expect(src).toContain('tool_input');
    expect(src).toContain('catch {');
  });

  it('is syntactically valid JavaScript', () => {
    assertValidJs(buildPiExtensionSource());
  });

  it('swallows asynchronous EPIPE from lifecycle and HTTP hook stdin', async () => {
    await expect(runSessionStartWithBrokenStdin(buildPiExtensionSource())).resolves.toBeUndefined();
    await expect(runSessionStartWithBrokenStdin(
      buildPiAgentHookExtensionSource('start', 'SessionStart', 'echo start'),
    )).resolves.toBeUndefined();
  });

  it('renders supported HTTP-source agent hooks as Pi extensions', () => {
    const src = buildPiAgentHookExtensionSource('scan', 'PreToolUse', 'echo hooked', 'Bash');
    expect(src).toContain('pi.on("tool_execution_start"');
    expect(src).toContain('echo hooked');
    expect(src).toContain('toolName');
    expect(src.indexOf('child.stdin?.on("error"')).toBeLessThan(
      src.indexOf('child.stdin?.end(JSON.stringify({ cwd'),
    );
    expect(src).toContain('child.stdin?.end(JSON.stringify({ cwd');
    assertValidJs(src);
    expect(buildPiAgentHookExtensionSource('scan', 'SessionStart', 'echo started'))
      .toContain('pi.on("session_start"');
    const postTool = buildPiAgentHookExtensionSource('post', 'PostToolUse', 'echo post');
    expect(postTool).toContain('toolInputs.set(event.toolCallId, event.args || {})');
    expect(postTool).toContain('tool_input: toolInputs.get(event.toolCallId) || {}');
    expect(postTool).toContain('toolInputs.delete(event.toolCallId)');
    assertValidJs(postTool);
    const matchedPostTool = buildPiAgentHookExtensionSource('matched', 'PostToolUse', 'echo post', 'Bash');
    expect(matchedPostTool).toContain(
      'if (String(event.toolName || \'\').toLowerCase() !== "bash") { toolInputs.delete(event.toolCallId); return; }',
    );
    expect(buildPiAgentHookExtensionSource('scan', 'UnknownEvent', 'echo nope')).toBe('');
  });

  it('installs and removes a Pi agent-hook extension safely', async () => {
    await applyPiAgentHook({ slug: 'scan', event: 'PostToolUse', command: 'echo hooked', matcher: 'Bash' });
    const file = path.join(tmp, '.pi', 'agent', 'extensions', 'teamai-agent-scan.ts');
    expect(await fse.pathExists(file)).toBe(true);
    await removePiAgentHook('scan');
    expect(await fse.pathExists(file)).toBe(false);
    await expect(applyPiAgentHook({ slug: '../escape', event: 'Stop', command: 'echo nope' }))
      .rejects.toThrow('Invalid Pi agent-hook slug');
  });

  it('does not overwrite or delete a same-named agent-hook file without the TeamAI marker, and rejects instead of skipping silently', async () => {
    const file = path.join(tmp, '.pi', 'agent', 'extensions', 'teamai-agent-scan.ts');
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, '// user-owned extension');

    expect(await hasPiAgentHook('scan')).toBe(false);

    await expect(applyPiAgentHook({ slug: 'scan', event: 'PostToolUse', command: 'echo hooked' }))
      .rejects.toThrow('without the TeamAI marker');
    expect(await fse.readFile(file, 'utf8')).toBe('// user-owned extension');

    await removePiAgentHook('scan');
    expect(await fse.readFile(file, 'utf8')).toBe('// user-owned extension');
  });

  it('rejects instead of skipping silently when Pi has no equivalent for the requested event', async () => {
    await expect(applyPiAgentHook({ slug: 'scan', event: 'UnknownEvent', command: 'echo nope' }))
      .rejects.toThrow('Pi does not support event "UnknownEvent"');
    const file = path.join(tmp, '.pi', 'agent', 'extensions', 'teamai-agent-scan.ts');
    expect(await fse.pathExists(file)).toBe(false);
  });

  it('injects and removes an idempotent global extension', async () => {
    const file = path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE);
    await injectPiHooks();
    const first = await fse.readFile(file, 'utf8');
    expect(first).toContain('[teamai] hooks extension');
    await injectPiHooks();
    expect(await fse.readFile(file, 'utf8')).toBe(first);
    await removePiHooks();
    expect(await fse.pathExists(file)).toBe(false);
  });

  it('preserves a same-named global extension without the TeamAI marker', async () => {
    const file = path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, '// user-owned extension');
    await removePiHooks();
    expect(await fse.readFile(file, 'utf8')).toBe('// user-owned extension');
  });

  it('does not overwrite a same-named global extension without the TeamAI marker', async () => {
    const file = path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE);
    await fse.ensureDir(path.dirname(file));
    await fse.writeFile(file, '// user-owned extension');
    await injectPiHooks();
    expect(await fse.readFile(file, 'utf8')).toBe('// user-owned extension');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('without the TeamAI marker'));
  });

  it('does not create a Pi directory when the tool is not installed', async () => {
    await reconcileHooksToAllTools({ pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>, tmp, [], path.join(tmp, 'manifest.json'));
    expect(await fse.pathExists(path.join(tmp, '.pi'))).toBe(false);
  });

  it('injects the global extension when the Pi root is installed', async () => {
    await fse.ensureDir(path.join(tmp, '.pi', 'agent'));
    await reconcileHooksToAllTools({ pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>, tmp, [], path.join(tmp, 'manifest.json'));
    expect(await fse.pathExists(path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE))).toBe(true);
  });

  it('uses one global extension for self-mode style bases', async () => {
    const project = path.join(tmp, 'project');
    await fse.ensureDir(path.join(project, '.pi'));
    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      project,
      [],
      path.join(tmp, 'manifest.json'),
      { scope: 'project', installedBaseDir: project },
    );
    expect(await fse.pathExists(path.join(project, '.pi', 'extensions', PI_HOOK_FILE))).toBe(false);
    expect(await fse.pathExists(path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE))).toBe(true);
  });

  it('removes a managed project copy before installing the global extension', async () => {
    const project = path.join(tmp, 'project');
    const legacy = path.join(project, '.pi', 'extensions', PI_HOOK_FILE);
    await fse.ensureDir(path.dirname(legacy));
    await fse.writeFile(legacy, buildPiExtensionSource());
    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      project,
      [],
      path.join(tmp, 'manifest.json'),
    );
    expect(await fse.pathExists(legacy)).toBe(false);
    expect(await fse.pathExists(path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE))).toBe(true);
  });

  it('project removal deletes both the legacy project copy and the global extension', async () => {
    // Mirrors OMP: Pi has no way to scope a shared file to one project, so a
    // removeAll pass — scoped uninstall or explicit `hooks remove` — deletes
    // the single global copy outright rather than pretending to preserve it
    // for other projects while it keeps firing for this one anyway.
    const project = path.join(tmp, 'project');
    const global = path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE);
    const legacy = path.join(project, '.pi', 'extensions', PI_HOOK_FILE);
    await injectPiHooks();
    await fse.ensureDir(path.dirname(legacy));
    await fse.writeFile(legacy, buildPiExtensionSource());

    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      tmp,
      [],
      path.join(tmp, 'manifest.json'),
      { removeAll: true, scope: 'project', installedBaseDir: project },
    );

    expect(await fse.pathExists(legacy)).toBe(false);
    expect(await fse.pathExists(global)).toBe(false);
  });

  it('user removal owns and deletes the global extension', async () => {
    const global = path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE);
    await injectPiHooks();

    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      tmp,
      [],
      path.join(tmp, 'manifest.json'),
      { removeAll: true, scope: 'user' },
    );

    expect(await fse.pathExists(global)).toBe(false);
  });

  it('refreshes an existing global TeamAI extension from project scope', async () => {
    const project = path.join(tmp, 'project');
    await fse.ensureDir(path.join(tmp, '.pi', 'agent', 'extensions'));
    await fse.writeFile(
      path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE),
      `${buildPiExtensionSource()}\n// stale`,
    );
    await fse.ensureDir(path.join(project, '.pi'));
    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      project,
      [],
      path.join(tmp, 'manifest.json'),
    );
    const global = await fse.readFile(path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE), 'utf8');
    expect(global).toBe(buildPiExtensionSource());
    expect(await fse.pathExists(path.join(project, '.pi', 'extensions', PI_HOOK_FILE))).toBe(false);
  });

  it('skips custom team hooks and reports the built-in-only boundary', async () => {
    await fse.ensureDir(path.join(tmp, '.pi', 'agent'));
    const customHook: HookDef = {
      source: 'team',
      key: 'custom-stop',
      event: 'Stop',
      command: 'echo custom-team-hook',
      description: '[teamai:hook:custom-stop] custom stop',
    };
    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      tmp,
      [customHook],
      path.join(tmp, 'manifest.json'),
      {
        scope: 'user',
        builtinOverride: { disabled: ['Hook dispatch stop'] },
      },
    );
    const source = await fse.readFile(path.join(tmp, '.pi', 'agent', 'extensions', PI_HOOK_FILE), 'utf8');
    expect(source).not.toContain(customHook.command);
    expect(log.warn).toHaveBeenCalledWith(
      'Pi supports built-in lifecycle hooks only; skipping 1 custom team hook(s) from hooks/hooks.yaml',
    );
    expect(log.warn).toHaveBeenCalledWith(
      'Pi supports built-in lifecycle hooks only; skipping 1 built-in hook override(s) from hooks/hooks.yaml',
    );
  });

  it('does not warn about skipped team hooks when Pi is not installed', async () => {
    // No .pi directory anywhere — a teammate who never uses Pi must not see
    // this warning just because the team defines a Pi-targeted hook.
    const customHook: HookDef = {
      source: 'team',
      key: 'custom-stop',
      event: 'Stop',
      command: 'echo custom-team-hook',
      description: '[teamai:hook:custom-stop] custom stop',
    };
    await reconcileHooksToAllTools(
      { pi: { skills: '.pi/skills' } } as Record<string, { settings?: string }>,
      tmp,
      [customHook],
      path.join(tmp, 'manifest.json'),
      {
        scope: 'user',
        builtinOverride: { disabled: ['Hook dispatch stop'] },
      },
    );
    expect(await fse.pathExists(path.join(tmp, '.pi'))).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('renders the configured HTTP agent-hook timeout in milliseconds', () => {
    expect(buildPiAgentHookExtensionSource('slow', 'SessionStart', 'echo slow', undefined, 45))
      .toContain('}, 45000);');
    expect(buildPiAgentHookExtensionSource('default', 'SessionStart', 'echo default'))
      .toContain('}, 10000);');
  });
});

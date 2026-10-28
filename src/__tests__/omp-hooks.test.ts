import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import fse from 'fs-extra';

/** Assert a generated ESM extension body parses as valid JS (strip the bun
 *  import — vm.Script is not an ESM context — and `export default`). */
function assertValidJs(src: string): void {
  const body = src.replace(/^import .*;$/gm, '').replace(/export default /g, 'const __x = ');
  expect(() => new vm.Script(body)).not.toThrow();
}

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import {
  injectOmpHooks,
  removeOmpHooks,
  buildOmpExtensionSource,
  OMP_HOOK_FILE,
} from '../omp-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { log } from '../utils/logger.js';
import { loadOmpExtension, type ExtensionDispatch } from './helpers/pi-extensions.js';
import { hookAdapterDir } from '../locate.js';

describe('the OMP extension directory', () => {
  it('always targets the user agent dir (single-copy policy)', () => {
    expect(hookAdapterDir('omp-extension')).toBe(
      path.join(os.homedir(), '.omp', 'agent', 'extensions'),
    );
  });
});

describe('buildOmpExtensionSource', () => {
  const src = buildOmpExtensionSource();
  it('maps the four Claude built-in events to OMP events and teamai dispatch', () => {
    expect(src).toContain('pi.on("session_start"');
    expect(src).toContain('dispatch("session-start"');
    expect(src).toContain('pi.on("session_stop"');
    expect(src).toContain('dispatch("stop"');
    expect(src).toContain('pi.on("before_agent_start"');
    expect(src).toContain('dispatch("prompt-submit"');
    expect(src).toContain('pi.on("tool_result"');
    expect(src).toContain('dispatch("post-tool-use"');
  });
  it('shells out to teamai hook-dispatch --tool omp, swallowing errors', () => {
    expect(src).toContain('"hook-dispatch"');
    expect(src).toContain('"--tool", "omp"');
    expect(src).toContain('.quiet().nothrow()');
    expect(src).toContain('} catch {');
  });
  it('forwards a STDIN payload (cwd + per-event fields) via a Response', () => {
    // cwd comes from the extension ctx, fed on STDIN so the provider-config
    // gate and track/hint handlers work.
    expect(src).toContain('JSON.stringify({ cwd');
    expect(src).toContain('new Response(stdin)');
    expect(src).toContain('ctx.cwd');
    expect(src).toContain('event.prompt');
    expect(src).toContain('tool_name');
    expect(src).toContain('tool_input');
  });
  it('returns nothing from session_stop (never forces a continuation)', () => {
    // SessionStopEventResult's `continue` / `decision: "block"` fields would
    // change OMP's own stop semantics — the handler must stay side-effect only.
    expect(src).not.toContain('continue:');
    expect(src).not.toContain('decision:');
    expect(src).toContain('session_stop');
  });
  it('runs no matcher-scoped pass (no PascalCase tool mapping)', () => {
    // OMP tool ids are lowercase (bash / read / …) and it has no Skill /
    // TodoWrite tool; the TodoWrite hint's STDOUT has no way back into OMP.
    expect(src).not.toContain('--matcher');
    expect(src).not.toContain("'Skill'");
    expect(src).not.toContain("'TodoWrite'");
  });
  it('carries the [teamai] marker for doctor / uninstall recognition', () => {
    expect(src).toContain('// [teamai] hooks extension');
  });
  it('is syntactically valid JavaScript', () => {
    assertValidJs(src);
  });


});

describe('injectOmpHooks / removeOmpHooks', () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-hooks-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fse.remove(tmp);
  });
  const extFile = () => path.join(tmp, '.omp', 'agent', 'extensions', OMP_HOOK_FILE);

  it('writes ~/.omp/agent/extensions/teamai-hooks.ts with the marker', async () => {
    await injectOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(true);
    expect(await fse.readFile(extFile(), 'utf8')).toContain('[teamai] hooks extension');
  });

  it('is idempotent — re-inject produces identical bytes', async () => {
    await injectOmpHooks();
    const first = await fse.readFile(extFile(), 'utf8');
    await injectOmpHooks();
    expect(await fse.readFile(extFile(), 'utf8')).toBe(first);
  });

  it('reports the injection only when the extension changes', async () => {
    await injectOmpHooks();
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai OMP hook'));
    vi.mocked(log.success).mockClear();

    await injectOmpHooks();
    expect(log.success).not.toHaveBeenCalled();
  });

  it('remove deletes the extension file; safe when absent', async () => {
    await removeOmpHooks(); // no-op, no throw
    await injectOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(true);
    await removeOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(false);
  });

  it('leaves a same-named extension teamai did not write alone on inject and remove', async () => {
    await fse.outputFile(extFile(), 'export default function mine() {}\n');

    await injectOmpHooks();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`${extFile()} exists without the TeamAI marker`));
    await removeOmpHooks();

    expect(await fse.readFile(extFile(), 'utf8')).toBe('export default function mine() {}\n');
  });
});

describe('reconcileHooksToAllTools routes omp to the extension adapter', () => {
  let tmp: string;
  let home: string;
  let projectRoot: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-recon-'));
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

  const toolPaths = { omp: { skills: '.omp/skills' } } as Record<string, { settings?: string }>;
  const manifest = () => path.join(tmp, 'managed-hooks.json');
  const extFile = () => path.join(home, '.omp', 'agent', 'extensions', OMP_HOOK_FILE);

  it('does nothing when OMP is not installed (no ~/.omp)', async () => {
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(path.join(home, '.omp'))).toBe(false);
  });

  it('injects the single user-root extension when ~/.omp exists', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
  });

  it('injects into the user root even when reconciling a project-scope base dir', async () => {
    // OMP would load a project copy (~/.omp aside, <project>/.omp/extensions)
    // alongside the user one and dispatch every event twice — the adapter must
    // keep exactly one copy, in HOME.
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
    expect(await fse.pathExists(path.join(projectRoot, '.omp', 'extensions', OMP_HOOK_FILE))).toBe(false);
  });

  it('preserves a project extension beside the global TeamAI extension', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    const projectExtension = path.join(projectRoot, '.omp/extensions/member.ts');
    await fse.outputFile(projectExtension, 'export default function member() {}');
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
    await reconcileHooksToAllTools(toolPaths, projectRoot, [], manifest(), { removeAll: true });
    expect(await fse.readFile(projectExtension, 'utf8')).toBe('export default function member() {}');
  });

  it('removeAll deletes the extension', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(extFile())).toBe(false);
  });

  it('injects into the named profile\'s agent dir under PI_CONFIG_DIR, with no ~/.omp', async () => {
    vi.stubEnv('PI_CONFIG_DIR', '.omp-alt');
    vi.stubEnv('OMP_PROFILE', 'work');
    const agentDir = path.join(home, '.omp-alt', 'profiles', 'work', 'agent');
    await fse.ensureDir(agentDir);
    try {
      await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await fse.pathExists(path.join(agentDir, 'extensions', OMP_HOOK_FILE))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.omp'))).toBe(false);
  });

  it('keeps OMP\'s extension in ~/.omp/agent when PI_CODING_AGENT_DIR moves Pi, so each pull leaves both unchanged (#1221)', async () => {
    const piAgent = path.join(tmp, 'pi-agent');
    vi.stubEnv('PI_CODING_AGENT_DIR', piAgent);
    await fse.ensureDir(piAgent);
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    const both = { pi: { skills: '.pi/skills' }, omp: { skills: '.omp/skills' } } as Record<string, { settings?: string }>;
    const piFile = path.join(piAgent, 'extensions', 'teamai-hooks.ts');
    const read = async () => [await fse.readFile(piFile, 'utf8'), await fse.readFile(extFile(), 'utf8')];
    try {
      await reconcileHooksToAllTools(both, home, [], manifest());
      const first = await read();
      await reconcileHooksToAllTools(both, home, [], manifest());
      expect(first[0]).toContain('"--tool", "pi"');
      expect(first[1]).toContain('"--tool", "omp"');
      expect(await read()).toEqual(first);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('writes the extension into the OMP_PROFILE agent dir and leaves the default profile\'s in ~/.omp/agent (#1221)', async () => {
    vi.stubEnv('OMP_PROFILE', 'work');
    await fse.outputFile(extFile(), '// [teamai] hooks extension');
    const profileFile = path.join(home, '.omp', 'profiles', 'work', 'agent', 'extensions', OMP_HOOK_FILE);
    try {
      await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await fse.pathExists(profileFile)).toBe(true);
    expect(await fse.pathExists(extFile())).toBe(true);
  });

  it('settingsOnly skips the omp adapter', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { settingsOnly: true });
    expect(await fse.pathExists(extFile())).toBe(false);
  });
});

// Team instructions (#945): the extension adds hook-dispatch's context to the prompt.
describe('OMP extension: team instructions in the system prompt (#945)', () => {
  const ctx = { cwd: '/work/proj/src', sessionManager: { getSessionId: () => 'omp-main' } };
  const context = (text: string) => (args: string[]) => args[1] === 'instructions'
    ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
    : '';

  it('appends the blocks to each turn\'s system prompt, asking hook-dispatch once per session', async () => {
    const { on, dispatches } = loadOmpExtension(context('TEAM-BLOCKS'));
    await on.session_start({}, ctx);
    const first = await on.before_agent_start({ prompt: 'one', systemPrompt: ['BASE'] }, ctx);
    const second = await on.before_agent_start({ prompt: 'two', systemPrompt: ['BASE'] }, ctx);
    expect(first).toEqual({ systemPrompt: ['BASE', 'TEAM-BLOCKS'] });
    expect(second).toEqual({ systemPrompt: ['BASE', 'TEAM-BLOCKS'] });
    expect(dispatches.filter((d) => d.args[1] === 'instructions')).toHaveLength(1);
    expect(dispatches.find((d) => d.args[1] === 'instructions')?.payload).toEqual({ cwd: '/work/proj/src', session_id: 'omp-main' });
  });

  it('waits for session-start HTTP sync before reading the first prompt cache', async () => {
    let synced = false;
    const { on } = loadOmpExtension((args) => {
      if (args[1] === 'session-start') synced = true;
      return args[1] === 'instructions' ? context(synced ? 'FRESH-HTTP-PROMPT' : '')(args) : '';
    });
    await on.session_start({}, ctx);
    expect(await on.before_agent_start({ prompt: 'one', systemPrompt: ['BASE'] }, ctx))
      .toEqual({ systemPrompt: ['BASE', 'FRESH-HTTP-PROMPT'] });
  });

  it('leaves the system prompt alone when there are no blocks (user scope, or teamai unavailable)', async () => {
    const { on } = loadOmpExtension();
    await on.session_start({}, ctx);
    expect(await on.before_agent_start({ prompt: 'one', systemPrompt: ['BASE'] }, ctx)).toBeUndefined();
  });
});

// Recall attribution (#884): the extension evaluated in `vm`, with a fake host.
/** The lifecycle dispatches, without the team-instructions request (#945), which has its own tests. */
const lifecycle = (dispatches: ExtensionDispatch[]) => dispatches.filter((d) => d.args[1] !== 'instructions');

describe('OMP extension: bridge payloads (#884)', () => {
  const main = { cwd: '/work/proj', sessionManager: { getSessionId: () => 'omp-main' }, agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 } };
  const sub = {
    cwd: '/work/proj', sessionManager: { getSessionId: () => 'omp-sub' },
    agent: { kind: 'sub' as const, id: '0-TeamaiRecall', name: 'teamai-recall', depth: 1, parentId: 'Main' },
  };

  it('sends the host session id on every lifecycle event, and no agent fields for the main agent', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.session_start({}, main);
    await on.before_agent_start({ prompt: 'hi' }, main);
    await on.session_stop({}, main);
    expect(lifecycle(dispatches).map((d) => [d.args[1], d.payload])).toEqual([
      ['session-start', { cwd: '/work/proj', session_id: 'omp-main' }],
      ['prompt-submit', { cwd: '/work/proj', session_id: 'omp-main', prompt: 'hi' }],
      ['stop', { cwd: '/work/proj', session_id: 'omp-main' }],
    ]);
    expect(lifecycle(dispatches).every((d) => d.args.join(' ').endsWith('--tool omp'))).toBe(true);
  });

  it('sends the text output and the status on post-tool-use', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.tool_result({ type: 'tool_result', toolCallId: 'c1', toolName: 'bash', input: { command: 'ls' },
      content: [{ type: 'text', text: 'a.md' }, { type: 'image', data: 'AAAA' }, { type: 'text', text: 'b.md' }], isError: false }, main);
    await on.tool_result({ type: 'tool_result', toolCallId: 'c2', toolName: 'bash', input: { command: 'false' },
      content: [{ type: 'text', text: 'Command exited with code 1' }], isError: true }, main);
    expect(lifecycle(dispatches).map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: 'omp-main', tool_name: 'bash', tool_input: { command: 'ls' }, tool_response: 'a.md\nb.md', tool_status: 'success' },
      { cwd: '/work/proj', session_id: 'omp-main', tool_name: 'bash', tool_input: { command: 'false' }, tool_response: 'Command exited with code 1', tool_status: 'failure' },
    ]);
  });

  it('sends a subagent\'s agent id and type on its events', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.session_start({}, sub);
    await on.tool_result({ type: 'tool_result', toolCallId: 'c1', toolName: 'read', input: { path: 'x.md' }, content: [], isError: false }, sub);
    await on.session_stop({}, sub);
    expect(lifecycle(dispatches).map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: 'omp-sub', agent_id: '0-TeamaiRecall', agent_type: 'teamai-recall' },
      { cwd: '/work/proj', session_id: 'omp-sub', agent_id: '0-TeamaiRecall', agent_type: 'teamai-recall', tool_name: 'read', tool_input: { path: 'x.md' }, tool_response: '', tool_status: 'success' },
      { cwd: '/work/proj', session_id: 'omp-sub', agent_id: '0-TeamaiRecall', agent_type: 'teamai-recall' },
    ]);
  });

  it('still dispatches on an older host with no ctx.agent (below 18.3.2), no session manager and no result fields', async () => {
    const { on, dispatches } = loadOmpExtension();
    await on.session_start({}, { cwd: '/work/proj', sessionManager: { getSessionId: () => 'omp-old' } });
    await on.tool_result({ toolName: 'read', input: { path: 'x.md' } }, { cwd: '/work/proj' });
    expect(lifecycle(dispatches).map((d) => d.payload)).toEqual([
      { cwd: '/work/proj', session_id: 'omp-old' },
      { cwd: '/work/proj', tool_name: 'read', tool_input: { path: 'x.md' }, tool_status: 'unknown' },
    ]);
  });
});

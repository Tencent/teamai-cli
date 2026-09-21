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
  resolveOmpExtensionsDir,
  injectOmpHooks,
  removeOmpHooks,
  buildOmpExtensionSource,
  OMP_HOOK_FILE,
} from '../omp-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';

describe('resolveOmpExtensionsDir', () => {
  it('always targets the user agent dir (single-copy policy)', () => {
    expect(resolveOmpExtensionsDir()).toBe(
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

  it('remove deletes the extension file; safe when absent', async () => {
    await removeOmpHooks(); // no-op, no throw
    await injectOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(true);
    await removeOmpHooks();
    expect(await fse.pathExists(extFile())).toBe(false);
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

  it('removeAll deletes the extension', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest());
    expect(await fse.pathExists(extFile())).toBe(true);
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { removeAll: true });
    expect(await fse.pathExists(extFile())).toBe(false);
  });

  it('settingsOnly skips the omp adapter', async () => {
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await reconcileHooksToAllTools(toolPaths, home, [], manifest(), { settingsOnly: true });
    expect(await fse.pathExists(extFile())).toBe(false);
  });
});

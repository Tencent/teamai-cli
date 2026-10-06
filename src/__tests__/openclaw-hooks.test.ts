import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { parseDocument } from 'yaml';
import {
  applyOpenClawAgentHook, removeOpenClawAgentHook, injectOpenClawHooks, removeOpenClawHooks, resolveOpenclawWorkspaceDir, OPENCLAW_HOOK_DIR,
} from '../openclaw-hooks.js';
import { reconcileHooksToAllTools } from '../hooks.js';
import { log } from '../utils/logger.js';
import { OPENCLAW_EVENT_KEYS, openclawEvents, type OpenClawHookEvent } from './fixtures/openclaw/events.js';

let tmpDir: string;
let wsDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-test-'));
  // OPENCLAW_STATE_DIR holds openclaw.json; the engine workspace lives under it.
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'openclaw.json'),
    JSON.stringify({ agents: { defaults: { workspace: wsDir } } }, null, 2),
  );
  origStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(() => {
  if (origStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = origStateDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectOpenClawHooks', () => {
  it('writes HOOK.md + handler.ts under <workspace>/hooks/teamai-status-report', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');

    // Hooks land in the resolved workspace dir, where the engine reads them.
    const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
    const hookMd = fs.readFileSync(path.join(dir, 'HOOK.md'), 'utf-8');
    const handler = fs.readFileSync(path.join(dir, 'handler.ts'), 'utf-8');

    expect(hookMd).toContain('metadata:');
    expect(hookMd).toContain('"openclaw"');
    expect(handler).toContain('hook-dispatch');
    expect(handler).toContain('openclaw');
  });


  it('is idempotent (re-inject overwrites cleanly)', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');
    await injectOpenClawHooks(wsDir, 'openclaw');
    const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
    expect(fs.existsSync(path.join(dir, 'HOOK.md'))).toBe(true);
  });

  it('reports the injection only when the hook files change', async () => {
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});
    try {
      await injectOpenClawHooks(wsDir, 'openclaw');
      expect(success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai OpenClaw hook'));
      success.mockClear();

      await injectOpenClawHooks(wsDir, 'openclaw');
      expect(success).not.toHaveBeenCalled();
    } finally {
      success.mockRestore();
    }
  });
});

/** HOOK.md's frontmatter, parsed the way OpenClaw's loader parses it (YAML core schema). */
function readHookFrontmatter(dir: string): { errors: string[]; data: Record<string, unknown> } {
  const raw = fs.readFileSync(path.join(dir, 'HOOK.md'), 'utf-8');
  const block = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? '';
  const doc = parseDocument(block, { schema: 'core', prettyErrors: false });
  return { errors: doc.errors.map((e) => e.message), data: (doc.toJS() ?? {}) as Record<string, unknown> };
}

describe('injectOpenClawHooks enables the hook in openclaw.json', () => {
  const cfgPath = (): string => path.join(tmpDir, 'openclaw.json');
  const writeCfg = (cfg: unknown): void => fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));
  const readCfg = (): Record<string, any> => JSON.parse(fs.readFileSync(cfgPath(), 'utf-8'));

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(log, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('adds the entry when the config has no master flag, keeping every other field', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');

    const cfg = readCfg();
    // Workspace hooks load only with their own entry enabled.
    expect(cfg.hooks.internal.entries['teamai-status-report']).toEqual({ enabled: true });
    // The entry alone enables it; the master flag stays unset so removing the
    // entry restores the config exactly.
    expect(cfg.hooks.internal.enabled).toBeUndefined();
    expect(cfg.agents.defaults.workspace).toBe(wsDir);
    expect(warn).not.toHaveBeenCalled();
  });

  it('adds the entry beside existing named entries', async () => {
    writeCfg({
      agents: { defaults: { workspace: wsDir } },
      hooks: { internal: { enabled: true, entries: { 'session-memory': { enabled: true, env: { A: '1' } } } } },
    });

    await injectOpenClawHooks(wsDir, 'openclaw');

    expect(readCfg().hooks.internal).toEqual({
      enabled: true,
      entries: {
        'session-memory': { enabled: true, env: { A: '1' } },
        'teamai-status-report': { enabled: true },
      },
    });
  });

  it('is a no-op once the entry is enabled', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');
    const before = fs.readFileSync(cfgPath(), 'utf-8');
    const mtime = fs.statSync(cfgPath()).mtimeMs;

    await injectOpenClawHooks(wsDir, 'openclaw');

    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe(before);
    expect(fs.statSync(cfgPath()).mtimeMs).toBe(mtime);
  });

  it.each([
    ['open-ended discovery (master flag on, no named entries)', { enabled: true }, 'allowlist'],
    ['the entry disabled', { entries: { 'teamai-status-report': { enabled: false } } }, 'disabled'],
    ['internal hooks switched off', { enabled: false }, 'switched off'],
  ])('leaves the config unchanged and warns with %s', async (_label, internal, wording) => {
    writeCfg({ agents: { defaults: { workspace: wsDir } }, hooks: { internal } });
    const before = fs.readFileSync(cfgPath(), 'utf-8');

    await injectOpenClawHooks(wsDir, 'openclaw');

    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(wording));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openclaw hooks enable teamai-status-report'));
  });

  it('leaves a config it cannot parse unchanged and warns', async () => {
    const json5 = '{\n  // comment\n  agents: { defaults: { workspace: "x" } },\n}\n';
    fs.writeFileSync(cfgPath(), json5);

    await injectOpenClawHooks(wsDir, 'openclaw');

    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe(json5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openclaw hooks enable teamai-status-report'));
  });

  it('creates no state dir that OpenClaw does not have', async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, 'missing-state');

    await injectOpenClawHooks(wsDir, 'openclaw');

    expect(fs.existsSync(path.join(tmpDir, 'missing-state'))).toBe(false);
  });
});

describe('the OpenClaw workspace and state dir follow OpenClaw\'s resolution', () => {
  let home: string;
  beforeEach(() => {
    home = path.join(tmpDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    vi.stubEnv('HOME', home);
    delete process.env.OPENCLAW_STATE_DIR;
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses ~/.openclaw-<profile> for OPENCLAW_PROFILE, for the hook and its entry', async () => {
    vi.stubEnv('OPENCLAW_PROFILE', 'work');
    const state = path.join(home, '.openclaw-work');
    fs.mkdirSync(path.join(state, 'workspace'), { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });

    expect(await resolveOpenclawWorkspaceDir()).toBe(path.join(state, 'workspace'));
    await injectOpenClawHooks(undefined, 'openclaw');

    expect(fs.existsSync(path.join(state, 'workspace', 'hooks', OPENCLAW_HOOK_DIR, 'handler.ts'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(state, 'openclaw.json'), 'utf-8'));
    expect(cfg.hooks.internal.entries['teamai-status-report'].enabled).toBe(true);
    expect(fs.existsSync(path.join(home, '.openclaw', 'openclaw.json'))).toBe(false);
  });

  it('treats the "default" profile as no profile', async () => {
    vi.stubEnv('OPENCLAW_PROFILE', 'default');
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });

    expect(await resolveOpenclawWorkspaceDir()).toBe(path.join(home, '.openclaw', 'workspace'));
  });

  it('uses OPENCLAW_WORKSPACE_DIR over the state dir default', async () => {
    const custom = path.join(tmpDir, 'custom-ws');
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', custom);

    expect(await resolveOpenclawWorkspaceDir()).toBe(custom);
  });

  it('uses agents.defaults.workspace from the config over OPENCLAW_WORKSPACE_DIR, as OpenClaw does', async () => {
    const configured = path.join(tmpDir, 'configured-ws');
    const custom = path.join(tmpDir, 'custom-ws');
    fs.mkdirSync(configured, { recursive: true });
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace: configured } } }));
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', custom);

    expect(await resolveOpenclawWorkspaceDir()).toBe(configured);
  });

  it('uses <OPENCLAW_STATE_DIR>/workspace when the state dir is set', async () => {
    const state = path.join(tmpDir, 'state');
    fs.mkdirSync(path.join(state, 'workspace'), { recursive: true });
    vi.stubEnv('OPENCLAW_STATE_DIR', state);
    vi.stubEnv('OPENCLAW_PROFILE', 'work');

    expect(await resolveOpenclawWorkspaceDir()).toBe(path.join(state, 'workspace'));
  });

  it('returns null when the workspace OpenClaw would use does not exist', async () => {
    // Another workspace existing does not make it the one OpenClaw reads.
    vi.stubEnv('OPENCLAW_PROFILE', 'work');
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });

    expect(await resolveOpenclawWorkspaceDir()).toBeNull();
  });
});

describe('HOOK.md', () => {
  it('parses as YAML and subscribes only to events OpenClaw emits', async () => {
    await injectOpenClawHooks(wsDir, 'openclaw');
    const { errors, data } = readHookFrontmatter(path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR));

    // A frontmatter error marks the hook's metadata invalid, and OpenClaw then
    // refuses to load it.
    expect(errors).toEqual([]);
    const openclaw = (data.metadata as { openclaw: { events: string[]; hookKey: string } }).openclaw;
    expect(openclaw.events.length).toBeGreaterThan(0);
    for (const key of openclaw.events) expect(OPENCLAW_EVENT_KEYS).toContain(key);
    expect(openclaw.events).not.toContain('session:start');
    // The key `hooks.internal.entries.<hookKey>` enables it under.
    expect(openclaw.hookKey).toBe('teamai-status-report');
  });
});

describe('the generated handler', () => {
  let binDir: string;
  let logFile: string;
  let origPath: string | undefined;

  beforeEach(() => {
    // A `teamai` first on PATH that records its argv and stdin, one line each call.
    binDir = path.join(tmpDir, 'bin');
    logFile = path.join(tmpDir, 'teamai-calls.log');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'teamai'),
      `#!/bin/sh\nstdin=$(cat)\nprintf '%s\\t%s\\n' "$*" "$stdin" >> "${logFile}"\n`,
      { mode: 0o755 },
    );
    origPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${origPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = origPath;
  });

  /** Transpile handler.ts the way a TypeScript-stripping loader would, beside the original. */
  async function loadHandler(): Promise<(event: unknown) => Promise<void>> {
    await injectOpenClawHooks(wsDir, 'openclaw');
    const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
    const { code } = transformSync(fs.readFileSync(path.join(dir, 'handler.ts'), 'utf-8'), { loader: 'ts', format: 'esm' });
    const out = path.join(dir, 'handler.test-build.mjs');
    fs.writeFileSync(out, code);
    const mod = await import(pathToFileURL(out).href) as { default: (event: unknown) => Promise<void> };
    return mod.default;
  }

  function calls(): Array<{ argv: string; stdin: Record<string, unknown> }> {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((line) => {
      const [argv, stdin] = line.split('\t');
      return { argv, stdin: JSON.parse(stdin) as Record<string, unknown> };
    });
  }

  /** Wait until the shim has logged `n` calls, then a little longer to catch extras. */
  async function settle(n: number): Promise<void> {
    await vi.waitFor(() => expect(calls().length).toBeGreaterThanOrEqual(n), { timeout: 5000, interval: 25 });
    await new Promise((r) => setTimeout(r, 200));
  }

  const workspace = (): string => path.join(tmpDir, 'agent-ws');

  it.each([
    ['command:new', 'session-start'],
    ['command:reset', 'session-start'],
    ['session:auto-reset', 'session-start'],
    ['gateway:startup', 'session-start'],
  ])('runs hook-dispatch for %s in the event\'s workspace', async (key, dispatch) => {
    const handler = await loadHandler();
    const event = openclawEvents(workspace())[key];

    await handler(event);
    await settle(1);

    expect(calls()).toEqual([{
      argv: `hook-dispatch ${dispatch} --tool openclaw`,
      stdin: { cwd: workspace(), session_id: event.sessionKey },
    }]);
  });

  it('runs prompt-submit for message:received in the hook\'s own workspace, which the event does not carry', async () => {
    const handler = await loadHandler();

    await handler(openclawEvents(workspace())['message:received']);
    await settle(1);

    const [call] = calls();
    expect(calls()).toHaveLength(1);
    expect(call.argv).toBe('hook-dispatch prompt-submit --tool openclaw');
    expect(fs.realpathSync(call.stdin.cwd as string)).toBe(fs.realpathSync(wsDir));
  });

  it('runs nothing for unmapped events or an event without type and action', async () => {
    const handler = await loadHandler();
    const events = openclawEvents(workspace());
    const ignored: unknown[] = [events['command:stop'], events['message:sent'], {}, { context: {} }, undefined];

    for (const event of ignored) await handler(event as OpenClawHookEvent);
    // A mapped event last, so the wait proves the earlier ones had their chance.
    await handler(events['command:new']);
    await settle(1);

    expect(calls().map((c) => c.argv)).toEqual(['hook-dispatch session-start --tool openclaw']);
  });
});

describe('applyOpenClawAgentHook', () => {
  it.each([
    ['SessionStart', ['command:new', 'command:reset']],
    ['UserPromptSubmit', ['message:received']],
  ])('subscribes a %s hook to the events OpenClaw emits for it', async (event, expected) => {
    await applyOpenClawAgentHook({ slug: 'team-check', event, command: 'echo hi' });

    // Server-pushed hooks are managed hooks, under <state dir>/hooks.
    const { errors, data } = readHookFrontmatter(path.join(tmpDir, 'hooks', 'team-check'));
    expect(errors).toEqual([]);
    expect((data.metadata as { openclaw: { events: string[] } }).openclaw.events).toEqual(expected);
  });

  it('selects the hook in openclaw.json, so the teamai entry does not leave it out of the allowlist', async () => {
    const cfgPath = path.join(tmpDir, 'openclaw.json');
    await injectOpenClawHooks(wsDir, 'openclaw');
    await applyOpenClawAgentHook({ slug: 'team-check', event: 'SessionStart', command: 'echo hi' });

    const { data } = readHookFrontmatter(path.join(tmpDir, 'hooks', 'team-check'));
    const hookKey = (data.metadata as { openclaw: { hookKey: string } }).openclaw.hookKey;
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).hooks.internal.entries).toEqual({
      'teamai-status-report': { enabled: true },
      [hookKey]: { enabled: true },
    });

    await removeOpenClawAgentHook({ slug: 'team-check' });
    expect(fs.existsSync(path.join(tmpDir, 'hooks', 'team-check'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).hooks.internal.entries).toEqual({
      'teamai-status-report': { enabled: true },
    });
  });

  it('adds no entry where OpenClaw already loads every managed hook it discovers', async () => {
    const cfgPath = path.join(tmpDir, 'openclaw.json');
    const cfg = { agents: { defaults: { workspace: wsDir } }, hooks: { internal: { enabled: true } } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      await applyOpenClawAgentHook({ slug: 'team-check', event: 'SessionStart', command: 'echo hi' });
      expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))).toEqual(cfg);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('removeOpenClawHooks', () => {
  it('removes the injected hook dir and is a no-op when absent', async () => {
    const hooksDir = path.join(wsDir, 'hooks');
    await injectOpenClawHooks(wsDir, 'openclaw');
    // removeOpenClawHooks removes the passed-in hooks dir's teamai-status-report.
    await removeOpenClawHooks(hooksDir);
    expect(fs.existsSync(path.join(hooksDir, OPENCLAW_HOOK_DIR))).toBe(false);
    // second removal does not throw
    await expect(removeOpenClawHooks(hooksDir)).resolves.toBeUndefined();
  });

  it('also removes the copy in the state dir a profile selects', async () => {
    const home = path.join(tmpDir, 'home');
    const profileHook = path.join(home, '.openclaw-work', 'hooks', OPENCLAW_HOOK_DIR);
    fs.mkdirSync(profileHook, { recursive: true });
    delete process.env.OPENCLAW_STATE_DIR;
    vi.stubEnv('HOME', home);
    vi.stubEnv('OPENCLAW_PROFILE', 'work');
    try {
      await removeOpenClawHooks(path.join(wsDir, 'hooks'));
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(profileHook)).toBe(false);
  });
});

describe('reconcileHooksToAllTools routes the OpenClaw family to its adapter', () => {
    // `hooks inject` / `init` / `pull` all go through this path. Without an
    // OpenClaw branch it skipped the claw variants for lack of a `settings`
    // path, so their hooks were only ever written by the legacy migration.
    const toolPaths = { openclaw: { skills: '.openclaw/skills' } } as Record<string, { settings?: string }>;

    it('injects, then removeAll deletes, the workspace hook dir', async () => {
        const manifest = path.join(tmpDir, 'managed-hooks.json');
        const hookDir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], manifest);
        expect(fs.existsSync(path.join(hookDir, 'handler.ts'))).toBe(true);

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], manifest, { removeAll: true });
        expect(fs.existsSync(hookDir)).toBe(false);
    });

    it('removeAll takes the hook entry back out of openclaw.json', async () => {
        const cfgPath = path.join(tmpDir, 'openclaw.json');
        const manifest = path.join(tmpDir, 'managed-hooks.json');
        const original = { agents: { defaults: { workspace: wsDir } }, hooks: { internal: { entries: { other: { enabled: true } } } } };
        fs.writeFileSync(cfgPath, JSON.stringify(original));

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], manifest);
        expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).hooks.internal.entries['teamai-status-report']).toEqual({ enabled: true });

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], manifest, { removeAll: true });
        expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))).toEqual(original);
    });

    it('removeAll keeps the entry when removing it would turn on every discovered hook', async () => {
        // Master flag on with this as the only named entry: without it OpenClaw
        // would load every hook it discovers.
        const cfgPath = path.join(tmpDir, 'openclaw.json');
        const cfg = { agents: { defaults: { workspace: wsDir } }, hooks: { internal: { enabled: true, entries: { 'teamai-status-report': { enabled: true } } } } };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg));

        await reconcileHooksToAllTools(toolPaths, tmpDir, [], path.join(tmpDir, 'managed-hooks.json'), { removeAll: true });

        expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))).toEqual(cfg);
    });

    it('does nothing when the workspace cannot be resolved', async () => {
        delete process.env.OPENCLAW_STATE_DIR;
        const home = path.join(tmpDir, 'empty-home');
        fs.mkdirSync(home, { recursive: true });
        const prevHome = process.env.HOME;
        process.env.HOME = home;
        try {
            await reconcileHooksToAllTools(toolPaths, home, [], path.join(tmpDir, 'managed-hooks.json'));
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
        }
        expect(fs.existsSync(path.join(home, '.openclaw'))).toBe(false);
    });
});

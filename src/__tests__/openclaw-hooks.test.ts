import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { parseDocument } from 'yaml';
import {
  removeOpenClawAgentHook, injectOpenClawHooks, removeOpenClawHookEntry, removeOpenClawHooks, OPENCLAW_HOOK_DIR,
} from '../openclaw-hooks.js';
import { injectHooksToAllTools, reconcileHooksToAllTools } from '../hooks.js';
import { openclawWorkspaceDir } from '../locate.js';
import { bridgedTeamHookFile } from '../bridged-team-hooks.js';
import type { HookDef } from '../types.js';
import { log } from '../utils/logger.js';
import * as builtinHooks from '../builtin-hooks.js';
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
    await injectOpenClawHooks('openclaw');

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
    await injectOpenClawHooks('openclaw');
    await injectOpenClawHooks('openclaw');
    const dir = path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR);
    expect(fs.existsSync(path.join(dir, 'HOOK.md'))).toBe(true);
  });

  it('reports the injection only when the hook files change', async () => {
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});
    try {
      await injectOpenClawHooks('openclaw');
      expect(success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai OpenClaw hook'));
      success.mockClear();

      await injectOpenClawHooks('openclaw');
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
    await injectOpenClawHooks('openclaw');

    const cfg = readCfg();
    // Workspace hooks load only with their own entry enabled.
    expect(cfg.hooks.internal.entries['teamai-status-report']).toEqual({ enabled: true });
    // The entry alone enables it; the master flag stays unset so removing the
    // entry restores the config exactly.
    expect(cfg.hooks.internal.enabled).toBeUndefined();
    expect(cfg.agents.defaults.workspace).toBe(wsDir);
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes a symlinked openclaw.json at its target and keeps the link, on enable and on removal', async () => {
    const target = path.join(tmpDir, 'dotfiles', 'openclaw.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(cfgPath(), target);
    fs.symlinkSync(target, cfgPath());

    await injectOpenClawHooks('openclaw');

    expect(fs.lstatSync(cfgPath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf-8')).hooks.internal.entries['teamai-status-report']).toEqual({ enabled: true });

    await removeOpenClawHookEntry();

    expect(fs.lstatSync(cfgPath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ agents: { defaults: { workspace: wsDir } } });
  });

  it('adds the entry beside existing named entries', async () => {
    writeCfg({
      agents: { defaults: { workspace: wsDir } },
      hooks: { internal: { enabled: true, entries: { 'session-memory': { enabled: true, env: { A: '1' } } } } },
    });

    await injectOpenClawHooks('openclaw');

    expect(readCfg().hooks.internal).toEqual({
      enabled: true,
      entries: {
        'session-memory': { enabled: true, env: { A: '1' } },
        'teamai-status-report': { enabled: true },
      },
    });
  });

  it('is a no-op once the entry is enabled', async () => {
    await injectOpenClawHooks('openclaw');
    const before = fs.readFileSync(cfgPath(), 'utf-8');
    const mtime = fs.statSync(cfgPath()).mtimeMs;

    await injectOpenClawHooks('openclaw');

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

    await injectOpenClawHooks('openclaw');

    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(wording));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openclaw hooks enable teamai-status-report'));
  });

  it('leaves a config it cannot parse unchanged and warns', async () => {
    const json5 = '{\n  // comment\n  agents: { defaults: { workspace: "x" } },\n}\n';
    fs.writeFileSync(cfgPath(), json5);

    await injectOpenClawHooks('openclaw');

    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe(json5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('openclaw hooks enable teamai-status-report'));
  });

  it('creates no state dir that OpenClaw does not have', async () => {
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, 'missing-state');

    await injectOpenClawHooks('openclaw');

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

    expect(await openclawWorkspaceDir()).toBe(path.join(state, 'workspace'));
    await injectOpenClawHooks('openclaw');

    expect(fs.existsSync(path.join(state, 'workspace', 'hooks', OPENCLAW_HOOK_DIR, 'handler.ts'))).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(state, 'openclaw.json'), 'utf-8'));
    expect(cfg.hooks.internal.entries['teamai-status-report'].enabled).toBe(true);
    expect(fs.existsSync(path.join(home, '.openclaw', 'openclaw.json'))).toBe(false);
  });

  it('treats the "default" profile as no profile', async () => {
    vi.stubEnv('OPENCLAW_PROFILE', 'default');
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });

    expect(await openclawWorkspaceDir()).toBe(path.join(home, '.openclaw', 'workspace'));
  });

  it('uses OPENCLAW_WORKSPACE_DIR over the state dir default', async () => {
    const custom = path.join(tmpDir, 'custom-ws');
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', custom);

    expect(await openclawWorkspaceDir()).toBe(custom);
  });

  it('uses agents.defaults.workspace from the config over OPENCLAW_WORKSPACE_DIR, as OpenClaw does', async () => {
    const configured = path.join(tmpDir, 'configured-ws');
    const custom = path.join(tmpDir, 'custom-ws');
    fs.mkdirSync(configured, { recursive: true });
    fs.mkdirSync(custom, { recursive: true });
    fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace: configured } } }));
    vi.stubEnv('OPENCLAW_WORKSPACE_DIR', custom);

    expect(await openclawWorkspaceDir()).toBe(configured);
  });

  it('uses <OPENCLAW_STATE_DIR>/workspace when the state dir is set', async () => {
    const state = path.join(tmpDir, 'state');
    fs.mkdirSync(path.join(state, 'workspace'), { recursive: true });
    vi.stubEnv('OPENCLAW_STATE_DIR', state);
    vi.stubEnv('OPENCLAW_PROFILE', 'work');

    expect(await openclawWorkspaceDir()).toBe(path.join(state, 'workspace'));
  });

  it('returns null when the workspace OpenClaw would use does not exist', async () => {
    // Another workspace existing does not make it the one OpenClaw reads.
    vi.stubEnv('OPENCLAW_PROFILE', 'work');
    fs.mkdirSync(path.join(home, '.openclaw', 'workspace'), { recursive: true });

    expect(await openclawWorkspaceDir()).toBeNull();
  });
});

describe('HOOK.md', () => {
  it('parses as YAML and subscribes only to events OpenClaw emits', async () => {
    await injectOpenClawHooks('openclaw');
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
    // A Node entry point records argv and stdin, including when PATH is empty.
    binDir = path.join(tmpDir, 'bin');
    logFile = path.join(tmpDir, 'teamai-calls.log');
    fs.mkdirSync(binDir, { recursive: true });
    const entry = path.join(binDir, 'teamai entry.mjs');
    fs.writeFileSync(entry, `import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\t' + input + '\\n');
`);
    vi.spyOn(builtinHooks, 'resolveCliEntry').mockReturnValue(entry);
    origPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    vi.restoreAllMocks();
  });

  /** Transpile handler.ts the way a TypeScript-stripping loader would, beside the original. */
  async function loadHandler(): Promise<(event: unknown) => Promise<void>> {
    await injectOpenClawHooks('openclaw');
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

  /** Wait until the entry has logged `n` calls, then a little longer to catch extras. */
  async function settle(n: number): Promise<void> {
    await vi.waitFor(() => expect(calls().length).toBeGreaterThanOrEqual(n), { timeout: 5000, interval: 25 });
    await new Promise((r) => setTimeout(r, 200));
  }

  const workspace = (): string => path.join(tmpDir, 'agent-ws');

  it('dispatches with no teamai or node on the gateway PATH', async () => {
    const handler = await loadHandler();
    process.env.PATH = '';
    await handler(openclawEvents(workspace())['command:new']);
    await settle(1);
    expect(calls()[0].argv).toBe('hook-dispatch session-start --tool openclaw');
  });

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

describe('removeOpenClawAgentHook', () => {
  it('removes the agent hook directory and openclaw.json entry an earlier release installed', async () => {
    const cfgPath = path.join(tmpDir, 'openclaw.json');
    await injectOpenClawHooks('openclaw');
    const dir = path.join(tmpDir, 'hooks', 'team-check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HOOK.md'), '---\nname: "[teamai] team-check"\n---\n');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfg.hooks.internal.entries['teamai-agent-team-check'] = { enabled: true };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    await removeOpenClawAgentHook({ slug: 'team-check' });

    expect(fs.existsSync(dir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).hooks.internal.entries).toEqual({ 'teamai-status-report': { enabled: true } });
  });
});

describe('removeOpenClawHooks', () => {
  it('removes the injected hook dir and is a no-op when absent', async () => {
    const hooksDir = path.join(wsDir, 'hooks');
    await injectOpenClawHooks('openclaw');
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

describe('injectHooksToAllTools with an OpenClaw variant beside OpenClaw', () => {
    it('leaves OpenClaw\'s handler dispatching for openclaw', async () => {
        const toolPaths = { openclaw: { skills: '.openclaw/skills' }, qclaw: { skills: '.qclaw/skills' } } as Record<string, { settings?: string }>;

        await injectHooksToAllTools(toolPaths, tmpDir);

        const handler = fs.readFileSync(path.join(wsDir, 'hooks', OPENCLAW_HOOK_DIR, 'handler.ts'), 'utf-8');
        expect(handler).toContain('"openclaw"');
        expect(handler).not.toContain('qclaw');
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

    it('loads the team-hook plugin for a team hook OpenClaw gets, and removeAll takes it out', async () => {
        const cfgPath = path.join(tmpDir, 'openclaw.json');
        const manifest = path.join(tmpDir, 'managed-hooks.json');
        const teamHook: HookDef = {
          source: 'team', key: 'no-force-push', event: 'PreToolUse', matcher: 'Bash', command: 'true',
          description: '[teamai:hook:no-force-push] Refuse a force push',
        };
        vi.spyOn(log, 'success').mockImplementation(() => {});

        await reconcileHooksToAllTools(toolPaths, tmpDir, [teamHook], manifest);
        const [plugin] = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).plugins.load.paths as string[];
        expect(fs.readFileSync(plugin, 'utf-8')).toContain('"--team-hooks"');

        await reconcileHooksToAllTools(toolPaths, tmpDir, [teamHook], manifest, { removeAll: true });
        expect(fs.existsSync(plugin)).toBe(false);
        expect(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).plugins).toBeUndefined();
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

describe('OpenClaw: the team\'s hooks', () => {
  const savedHome = process.env.HOME;
  const cfgPath = (): string => path.join(tmpDir, 'openclaw.json');
  const readCfg = (): Record<string, any> => JSON.parse(fs.readFileSync(cfgPath(), 'utf-8'));
  let logFile: string;

  beforeEach(() => {
    process.env.HOME = path.join(tmpDir, 'home');
    vi.spyOn(log, 'success').mockImplementation(() => {});
    // Answers as `teamai hook-dispatch <Event> --tool openclaw --team-hooks` does.
    logFile = path.join(tmpDir, 'team-calls.log');
    const entry = path.join(tmpDir, 'teamai.mjs');
    fs.writeFileSync(entry, `import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: JSON.parse(input) }) + '\\n');
const replies = {
  PreToolUse: { block: 'Use --force-with-lease' },
  SessionStart: { context: 'On call this week: ana' },
  UserPromptSubmit: { context: 'Release freeze until Friday' },
};
if (process.argv.includes('--team-hooks') && replies[process.argv[3]]) process.stdout.write(JSON.stringify(replies[process.argv[3]]));
if (process.argv.includes('--team-hooks') && process.argv[3] === 'Stop') process.stderr.write('teamai: team hook lint timed out after 60s\\n');
`);
    vi.spyOn(builtinHooks, 'resolveCliEntry').mockReturnValue(entry);
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    vi.restoreAllMocks();
  });

  const teamHooksOn = (events: string[]): void => {
    const file = bridgedTeamHookFile('openclaw');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: Object.fromEntries(events.map((event) =>
      [event, [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }]])) }));
  };
  const teamCalls = (): Array<{ argv: string[]; cwd: string; stdin: Record<string, unknown> }> =>
    fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line)) : [];

  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  /** Load the plugin openclaw.json points at, as the gateway does, and collect what it registers. */
  async function loadPlugin(): Promise<{ handlers: Map<string, Handler>; options: Map<string, unknown> }> {
    const [file] = readCfg().plugins.load.paths as string[];
    const mod = await import(`${pathToFileURL(file).href}?${Date.now()}`) as { default: { id: string; register: (api: unknown) => void } };
    expect(mod.default.id).toBe(path.basename(file, path.extname(file)));
    const handlers = new Map<string, Handler>();
    const options = new Map<string, unknown>();
    mod.default.register({ on: (name: string, handler: Handler, opts?: unknown) => { handlers.set(name, handler); options.set(name, opts); } });
    return { handlers, options };
  }

  it('loads a plugin that blocks the tool call a PreToolUse hook refuses, in the session\'s workspace', async () => {
    teamHooksOn(['PreToolUse']);
    await injectOpenClawHooks('openclaw');

    const cfg = readCfg();
    expect(cfg.plugins.entries['teamai-team-hooks']).toEqual({ enabled: true, hooks: { allowConversationAccess: true } });
    expect(cfg.agents.defaults.workspace).toBe(wsDir);
    const { handlers, options } = await loadPlugin();
    // OpenClaw fails a slow before_tool_call closed at 15 s unless the plugin asks for longer.
    expect(options.get('before_tool_call')).toEqual({ timeoutMs: 600000 });

    const project = path.join(tmpDir, 'project');
    fs.mkdirSync(project);
    await handlers.get('before_prompt_build')?.({ prompt: 'ship it', messages: [] }, { sessionKey: 'main', workspaceDir: project });
    const decision = await handlers.get('before_tool_call')?.(
      { toolName: 'exec', params: { command: 'git push -f origin main' } }, { sessionKey: 'main', toolName: 'exec' });

    expect(decision).toEqual({ block: true, blockReason: 'Use --force-with-lease' });
    expect(teamCalls()).toEqual([{
      argv: ['hook-dispatch', 'PreToolUse', '--tool', 'openclaw', '--team-hooks'],
      cwd: fs.realpathSync(project),
      stdin: { cwd: project, session_id: 'main', tool_name: 'exec', tool_input: { command: 'git push -f origin main' } },
    }]);
  });

  it('adds what SessionStart hooks print to the first prompt, and UserPromptSubmit hooks to each', async () => {
    teamHooksOn(['SessionStart', 'UserPromptSubmit']);
    await injectOpenClawHooks('openclaw');
    const { handlers } = await loadPlugin();
    const prompt = (text: string) => handlers.get('before_prompt_build')?.({ prompt: text, messages: [] }, { sessionKey: 'main', workspaceDir: wsDir });

    expect(await prompt('deploy')).toEqual({ prependContext: 'On call this week: ana\n\nRelease freeze until Friday' });
    expect(await prompt('deploy again')).toEqual({ prependContext: 'Release freeze until Friday' });
    expect(teamCalls().map((call) => call.argv[1])).toEqual(['SessionStart', 'UserPromptSubmit', 'UserPromptSubmit']);
    expect(teamCalls()[1].stdin).toEqual({ cwd: wsDir, session_id: 'main', prompt: 'deploy' });
  });

  it('gives a UserPromptSubmit hook the request the member sent, not the history OpenClaw rebuilt around it', async () => {
    teamHooksOn(['UserPromptSubmit']);
    await injectOpenClawHooks('openclaw');
    const { handlers } = await loadPlugin();
    await handlers.get('before_prompt_build')?.(
      { prompt: 'earlier: deploy\n\nnow: fix the build', currentUserMessage: 'fix the build', messages: [] },
      { sessionKey: 'main', workspaceDir: wsDir },
    );
    expect(teamCalls()[0].stdin).toEqual({ cwd: wsDir, session_id: 'main', prompt: 'fix the build' });
  });

  it('shows what a team hook wrote on stderr in OpenClaw\'s console', async () => {
    teamHooksOn(['Stop']);
    await injectOpenClawHooks('openclaw');
    const { handlers } = await loadPlugin();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handlers.get('agent_end')?.({ messages: [], success: true }, { sessionKey: 'main', workspaceDir: wsDir });

    expect(error).toHaveBeenCalledWith('teamai: team hook lint timed out after 60s');
  });

  it('spawns nothing for an event the team has no hook on', async () => {
    teamHooksOn(['Stop']);
    await injectOpenClawHooks('openclaw');
    const { handlers } = await loadPlugin();

    expect(await handlers.get('before_tool_call')?.({ toolName: 'read', params: {} }, { sessionKey: 'main', toolName: 'read' })).toBeUndefined();
    await handlers.get('agent_end')?.({ messages: [], success: true }, { sessionKey: 'main', workspaceDir: wsDir });
    expect(teamCalls().map((call) => call.argv[1])).toEqual(['Stop']);
  });

  it.each([
    [{ allow: ['memory-core'] }, 'plugins.allow does not list teamai-team-hooks; add it'],
    [{ enabled: false }, 'plugins are switched off (plugins.enabled: false); turn them on'],
    [{ deny: ['teamai-team-hooks'] }, 'plugins.deny lists teamai-team-hooks; take it out'],
    [{ entries: { 'teamai-team-hooks': { enabled: false } } }, 'plugins.entries.teamai-team-hooks.enabled is false; set it to true'],
  ])('leaves plugins %j as the member set them, and says how to run the team\'s hooks', async (plugins, fix) => {
    fs.writeFileSync(cfgPath(), JSON.stringify({ ...readCfg(), plugins }));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    teamHooksOn(['PreToolUse']);

    await injectOpenClawHooks('openclaw');

    expect(readCfg().plugins).toEqual(plugins);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(fix));
  });

  it('leaves an openclaw.json that is not plain JSON alone, and names the path to add', async () => {
    fs.writeFileSync(cfgPath(), '{ // JSON5\n  agents: {} }\n');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    teamHooksOn(['PreToolUse']);

    await injectOpenClawHooks('openclaw');

    expect(fs.readFileSync(cfgPath(), 'utf-8')).toBe('{ // JSON5\n  agents: {} }\n');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/team's hooks do not run\. Add .*teamai-team-hooks\.mjs to plugins\.load\.paths by hand/));
  });

  it('takes the plugin and its config back out once the team has no hooks for OpenClaw', async () => {
    const original = readCfg();
    teamHooksOn(['PreToolUse']);
    await injectOpenClawHooks('openclaw');
    const [file] = readCfg().plugins.load.paths as string[];

    teamHooksOn([]);
    await injectOpenClawHooks('openclaw');

    expect(fs.existsSync(file)).toBe(false);
    const { hooks: _status, ...rest } = readCfg();
    expect(rest).toEqual(original);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import * as builtinHooks from '../builtin-hooks.js';
import { injectHermesHooks, removeHermesHooks, hasHermesHooks, getReportScriptPath, getInstructionsPluginDir, getTeamHookScriptPath } from '../hermes-hooks.js';
import { bridgedTeamHookFile } from '../bridged-team-hooks.js';
import { shellQuoteValue } from '../utils/shell-profile.js';
import { log } from '../utils/logger.js';
import { channelReadiness } from '../instruction-targets.js';

let tmpDir: string;
let savedHermesHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-hooks-test-'));
  savedHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = tmpDir;
});

afterEach(() => {
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHermesHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('injectHermesHooks', () => {
  it('warns and keeps the installed files when the CLI entry cannot be resolved', async () => {
    await injectHermesHooks();
    const files = [getReportScriptPath(), path.join(tmpDir, 'config.yaml'), path.join(tmpDir, 'shell-hooks-allowlist.json'),
      path.join(getInstructionsPluginDir(), 'plugin.yaml'), path.join(getInstructionsPluginDir(), '__init__.py')];
    const before = files.map(file => fs.readFileSync(file, 'utf8'));
    const resolver = vi.spyOn(builtinHooks, 'resolveCliEntry').mockReturnValue(null);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      await injectHermesHooks();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot resolve the teamai CLI entry'));
      expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
    } finally {
      resolver.mockRestore();
      warn.mockRestore();
    }
  });

  it('migrates a raw command and its approval without removing member hooks', async () => {
    process.env.HERMES_HOME = path.join(tmpDir, 'Hermes home');
    fs.mkdirSync(process.env.HERMES_HOME);
    const raw = getReportScriptPath();
    const configPath = path.join(process.env.HERMES_HOME, 'config.yaml');
    const allowlistPath = path.join(process.env.HERMES_HOME, 'shell-hooks-allowlist.json');
    fs.writeFileSync(configPath, YAML.stringify({ hooks: { on_session_start: [{ command: raw }, { command: 'echo mine' }] } }));
    fs.writeFileSync(allowlistPath, JSON.stringify({ approvals: [{ event: 'on_session_start', command: raw }, { event: 'on_session_start', command: 'echo mine' }] }));
    await injectHermesHooks();
    const entries = YAML.parse(fs.readFileSync(configPath, 'utf8')).hooks.on_session_start;
    expect(entries).toHaveLength(2);
    expect(entries.some((entry: { command: string }) => entry.command === raw)).toBe(false);
    expect(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')).approvals).toEqual(entries.map((entry: { command: string }) => ({ event: 'on_session_start', command: entry.command })));
    const before = fs.readFileSync(configPath, 'utf8');
    await injectHermesHooks();
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
    await removeHermesHooks();
    expect(YAML.parse(fs.readFileSync(configPath, 'utf8')).hooks.on_session_start).toEqual([{ command: 'echo mine' }]);
    expect(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')).approvals).toEqual([{ event: 'on_session_start', command: 'echo mine' }]);
  });

  it('reports the injection only when the script, hook entry or allowlist changes', async () => {
    const success = vi.spyOn(log, 'success').mockImplementation(() => {});
    try {
      await injectHermesHooks();
      expect(fs.existsSync(getReportScriptPath())).toBe(true);
      expect(success).toHaveBeenCalledWith(expect.stringContaining('Injected teamai Hermes hook'));
      success.mockClear();

      await injectHermesHooks();
      expect(success).not.toHaveBeenCalled();
    } finally {
      success.mockRestore();
    }
  });
});

describe('hasHermesHooks', () => {
  const configPath = () => path.join(tmpDir, 'config.yaml');
  const allowlistPath = () => path.join(tmpDir, 'shell-hooks-allowlist.json');

  beforeEach(async () => {
    vi.spyOn(log, 'success').mockImplementation(() => {});
    await injectHermesHooks();
    fs.rmSync(getReportScriptPath());
    fs.rmSync(getInstructionsPluginDir(), { recursive: true });
  });

  it('is false for a Hermes home teamai never wrote to', async () => {
    process.env.HERMES_HOME = fs.mkdtempSync(path.join(tmpDir, 'fresh-'));
    expect(await hasHermesHooks()).toBe(false);
  });

  it('counts a hook registration left without its script or approval', async () => {
    fs.rmSync(allowlistPath());
    expect(await hasHermesHooks()).toBe(true);
    await removeHermesHooks();
    expect(await hasHermesHooks()).toBe(false);
  });

  it('counts an approval left without its script or hook registration', async () => {
    fs.writeFileSync(configPath(), YAML.stringify({ hooks: { on_session_start: [{ command: 'echo mine' }] } }));
    expect(await hasHermesHooks()).toBe(true);
    await removeHermesHooks();
    expect(await hasHermesHooks()).toBe(false);
  });
});

describe('the teamai-instructions plugin (#945)', () => {
  const config = () => fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8');

  it('installs the plugin and enables it beside the member\'s own plugins, then removes both', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), '# mine\nplugins:\n  enabled:\n    - disk-cleanup\n');
    vi.spyOn(log, 'success').mockImplementation(() => {});

    await injectHermesHooks();
    expect(fs.readFileSync(path.join(getInstructionsPluginDir(), '__init__.py'), 'utf8')).toContain('register_system_prompt_section');
    expect(fs.readFileSync(path.join(getInstructionsPluginDir(), 'plugin.yaml'), 'utf8')).toContain('name: teamai-instructions');
    expect(config()).toContain('# mine');
    expect(config()).toMatch(/- disk-cleanup\n\s+- teamai-instructions/);

    await removeHermesHooks();
    expect(fs.existsSync(getInstructionsPluginDir())).toBe(false);
    expect(config()).toContain('- disk-cleanup');
    expect(config()).not.toContain('teamai-instructions');
  });

  it('leaves the plugin off when the member disabled it', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'plugins:\n  disabled:\n    - teamai-instructions\n');
    vi.spyOn(log, 'success').mockImplementation(() => {});

    await injectHermesHooks();

    expect(config()).not.toMatch(/enabled:/);
  });

  it('leaves a same-named plugin teamai did not write alone on inject and remove', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'plugins:\n  enabled:\n    - teamai-instructions\n');
    const dir = getInstructionsPluginDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.yaml'), 'name: teamai-instructions\n');
    fs.writeFileSync(path.join(dir, '__init__.py'), 'def register(ctx): pass\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine\n');
    vi.spyOn(log, 'success').mockImplementation(() => {});
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    await injectHermesHooks();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${dir} exists without the TeamAI marker`));
    expect(fs.readFileSync(path.join(dir, '__init__.py'), 'utf8')).toBe('def register(ctx): pass\n');
    expect(fs.existsSync(getReportScriptPath())).toBe(true);
    expect(await channelReadiness('hermes', 'hermes-plugin')).toEqual({ ready: false, fix: expect.stringContaining(`${dir} holds a plugin teamai did not write`) });

    await removeHermesHooks();
    expect(fs.readdirSync(dir).sort()).toEqual(['__init__.py', 'notes.txt', 'plugin.yaml']);
    expect(config()).toContain('- teamai-instructions');
  });
});

describe('Hermes: the team\'s hooks', () => {
  const savedHome = process.env.HOME;
  beforeEach(() => { process.env.HOME = path.join(tmpDir, 'home'); });
  afterEach(() => { process.env.HOME = savedHome; });

  const teamHooksOn = (hooks: Record<string, number | undefined>) => {
    const file = bridgedTeamHookFile('hermes');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks: Object.fromEntries(Object.entries(hooks).map(([event, timeout]) =>
      [event, [{ matcher: '*', hooks: [{ type: 'command', command: 'true', ...(timeout ? { timeout } : {}) }] }]])) }));
  };
  const hooks = () => YAML.parse(fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf8')).hooks as Record<string, { command: string; timeout: number }[]>;
  const approvals = () => JSON.parse(fs.readFileSync(path.join(tmpDir, 'shell-hooks-allowlist.json'), 'utf8')).approvals as { event: string; command: string }[];

  it('gives a first turn time for its SessionStart and UserPromptSubmit hooks, which run one after the other', async () => {
    vi.spyOn(log, 'success').mockImplementation(() => {});
    teamHooksOn({ SessionStart: 90, UserPromptSubmit: undefined });
    await injectHermesHooks();
    expect(hooks().pre_llm_call).toEqual([expect.objectContaining({ timeout: 150 })]);
  });

  it('gives each Hermes event the team has hooks on one approved entry that runs them through teamai', async () => {
    vi.spyOn(log, 'success').mockImplementation(() => {});
    teamHooksOn({ PreToolUse: 400, SessionStart: undefined, Stop: 20 });
    await injectHermesHooks();
    const script = getTeamHookScriptPath();
    // Hermes tokenizes the command itself, so on Windows the path is double-quoted.
    const quoted = process.platform === 'win32' ? `"${script}"` : shellQuoteValue(script);
    const command = (event: string) => `${quoted} ${event}`;
    expect(hooks()).toMatchObject({
      pre_tool_call: [{ command: command('PreToolUse'), timeout: 300 }],
      pre_llm_call: [{ command: command('UserPromptSubmit'), timeout: 60 }],
      on_session_end: [{ command: command('Stop'), timeout: 20 }],
    });
    expect(approvals()).toEqual(expect.arrayContaining([
      { event: 'pre_tool_call', command: command('PreToolUse') },
      { event: 'pre_llm_call', command: command('UserPromptSubmit') },
      { event: 'on_session_end', command: command('Stop') },
    ]));
    expect(fs.readFileSync(script, 'utf8')).toContain('hook-dispatch "$1" --tool hermes --team-hooks');

    teamHooksOn({ PreToolUse: 10 });
    await injectHermesHooks();
    expect(Object.keys(hooks()).sort()).toEqual(['on_session_start', 'pre_tool_call']);
    expect(approvals().map((a) => a.event).sort()).toEqual(['on_session_start', 'pre_tool_call']);

    await removeHermesHooks();
    expect(hooks()).toBeUndefined();
    expect(fs.existsSync(script)).toBe(false);
  });
});

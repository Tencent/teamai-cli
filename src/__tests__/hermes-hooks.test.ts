import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { injectHermesHooks, removeHermesHooks, getReportScriptPath, getInstructionsPluginDir } from '../hermes-hooks.js';
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

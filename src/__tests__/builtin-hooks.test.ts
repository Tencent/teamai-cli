import { describe, it, expect, vi, afterEach } from 'vitest';
import { builtinHookDefs, applyBuiltinOverride } from '../builtin-hooks.js';

describe('builtinHookDefs — unified built-in hook model', () => {
  it('returns 7 built-in defs for Claude in canonical order, all tagged source=builtin', () => {
    const defs = builtinHookDefs('claude');
    expect(defs).toHaveLength(7);
    expect(defs.every((d) => d.source === 'builtin')).toBe(true);
    expect(defs.map((d) => d.event)).toEqual([
      'SessionStart', 'Stop',
      'PostToolUse', 'PostToolUse', 'PostToolUse',
      'UserPromptSubmit', 'SubagentStop',
    ]);
  });

  it('adds SubagentStop only for the agents that fire it (#884)', () => {
    const subagentStop = (tool: string) => builtinHookDefs(tool).filter((d) => d.event === 'SubagentStop');
    for (const tool of ['claude', 'claude-internal', 'tclaude', 'codex', 'codex-internal', 'tcodex', 'codebuddy', 'qoder', 'qoder-cn']) {
      expect(subagentStop(tool)).toEqual([expect.objectContaining({
        key: 'Hook dispatch subagent-stop',
        matcher: '*',
        command: expect.stringContaining(`hook-dispatch subagent-stop --tool ${tool}`),
      })]);
    }
    // Cursor and Copilot run a subagent in a session of its own that no hook links to its parent;
    // ZCode has no such event and rejects the whole hooks block on an unknown key.
    for (const tool of ['cursor', 'copilot', 'zcode', 'workbuddy']) expect(subagentStop(tool)).toEqual([]);
  });

  it('lets the Codex family\'s session-start hook pass the team rules whole (#938)', () => {
    // Codex keeps only the start and end of additionalContext past 2,500 tokens; 0 turns that off.
    const sessionStart = (tool: string) => builtinHookDefs(tool).find((d) => d.event === 'SessionStart');
    for (const tool of ['codex', 'codex-internal', 'tcodex']) expect(sessionStart(tool)?.additionalContextLimit).toBe(0);
    for (const tool of ['claude', 'cursor', 'copilot', 'codebuddy']) expect(sessionStart(tool)?.additionalContextLimit).toBeUndefined();
  });

  it('adds SubagentStart, with the same limit, only for the Codex family, whose fresh subagents fire no SessionStart (#938)', () => {
    const subagentStart = (tool: string) => builtinHookDefs(tool).filter((d) => d.event === 'SubagentStart');
    for (const tool of ['codex', 'codex-internal', 'tcodex']) {
      expect(subagentStart(tool)).toEqual([expect.objectContaining({
        key: 'Hook dispatch subagent-start',
        matcher: '*',
        command: expect.stringContaining(`hook-dispatch subagent-start --tool ${tool}`),
        additionalContextLimit: 0,
      })]);
    }
    for (const tool of ['claude', 'cursor', 'copilot', 'codebuddy', 'qoder', 'zcode']) expect(subagentStart(tool)).toEqual([]);
  });

  it('adds a lifecycle-complete SessionEnd hook only for Copilot', () => {
    const defs = builtinHookDefs('copilot');
    expect(defs).toHaveLength(7);
    expect(defs.at(-1)).toEqual(expect.objectContaining({
      event: 'SessionEnd',
      matcher: '*',
      timeout: 15,
      command: expect.stringContaining('hook-dispatch session-end --tool copilot'),
    }));
    expect(builtinHookDefs('claude').some((d) => d.event === 'SessionEnd')).toBe(false);
  });

  it('Claude defs carry no timeout; Cursor defs carry per-hook timeouts', () => {
    expect(builtinHookDefs('claude').every((d) => d.timeout === undefined)).toBe(true);
    const cursor = builtinHookDefs('cursor');
    expect(cursor.find((d) => d.key === 'Hook dispatch session-start')?.timeout).toBe(15);
    expect(cursor.find((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')?.timeout).toBe(3);
  });

  it('embeds the --tool identifier and [teamai] description marker', () => {
    const def = builtinHookDefs('codebuddy')[0];
    expect(def.command).toContain('--tool codebuddy');
    expect(def.description.startsWith('[teamai] ')).toBe(true);
  });
});

// DSH's Windows hook runner is PowerShell (@deepseek-ai/dsh-pwsh-local), so the
// POSIX `bash -lc "…"` wrapper is a ParserError there and every dsh hook failed
// silently (issue #1005). The rendered command has to be PowerShell syntax on
// Windows and keep the bash form everywhere else.
describe('builtinHookDefs — dsh shell syntax by platform (#1005)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a bare PowerShell dispatch on Windows, not the bash wrapper', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const defs = builtinHookDefs('dsh');
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.command).toMatch(/^teamai hook-dispatch \S+ --tool dsh(?: --matcher \S+)? 2>\$null; exit 0$/);
      // Nothing the PowerShell parser would reject, and no second PowerShell.
      expect(def.command).not.toContain('-lc');
      expect(def.command).not.toContain('2>/dev/null');
      expect(def.command).not.toContain('|| true');
      expect(def.command).not.toContain('bash');
    }
  });

  it('differs from the POSIX form only in the shell contract', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const posix = builtinHookDefs('dsh');
    platform.mockReturnValue('win32');
    const windows = builtinHookDefs('dsh');
    expect(windows.map((d) => d.key)).toEqual(posix.map((d) => d.key));
    windows.forEach((def, i) => {
      const dispatch = posix[i].command.replace(/^bash -lc "(.+) 2>\/dev\/null" \|\| true$/, '$1');
      expect(dispatch).not.toBe(posix[i].command);
      expect(def.command).toBe(`${dispatch} 2>$null; exit 0`);
    });
  });

  it('keeps the bash form on non-Windows platforms', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const defs = builtinHookDefs('dsh');
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.command).toContain('-lc');
      expect(def.command).toContain('2>/dev/null');
      expect(def.command).toContain('|| true');
      expect(def.command).not.toContain('2>$null');
    }
  });
});

describe('applyBuiltinOverride (§4.8)', () => {
  it('is a no-op for an absent or empty override', () => {
    const defs = builtinHookDefs('cursor');
    expect(applyBuiltinOverride(defs)).toBe(defs);
    expect(applyBuiltinOverride(defs, { disabled: [], overrides: {} })).toEqual(defs);
  });

  it('drops disabled built-in keys', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('claude'), {
      disabled: ['Hook dispatch post-tool-use TodoWrite'],
    });
    expect(defs).toHaveLength(builtinHookDefs('claude').length - 1);
    expect(defs.some((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')).toBe(false);
  });

  it('applies a whitelisted timeout override', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('cursor'), {
      overrides: { 'Hook dispatch stop': { timeout: 99 } },
    });
    expect(defs.find((d) => d.key === 'Hook dispatch stop')?.timeout).toBe(99);
  });
});

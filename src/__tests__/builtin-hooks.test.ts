import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { builtinHookDefs, builtinHookForm, applyBuiltinOverride, recognisedBuiltinHookDefs, _resetShellCache } from '../builtin-hooks.js';
import { getAgentVersion } from '../agent-version.js';
import { channelsOf } from '../tool-registry.js';

vi.mock('../agent-version.js', () => ({ getAgentVersion: vi.fn(async () => '') }));

// The real facts, which a case below extends for one tool.
vi.mock('../tool-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tool-registry.js')>();
  return { ...actual, channelsOf: vi.fn(actual.channelsOf) };
});

beforeEach(() => _resetShellCache());
afterEach(() => _resetShellCache());

describe('builtinHookDefs — unified built-in hook model', () => {
  it('returns 5 built-in defs for Claude in canonical order, all tagged source=builtin', () => {
    const defs = builtinHookDefs('claude');
    expect(defs).toHaveLength(5);
    expect(defs.every((d) => d.source === 'builtin')).toBe(true);
    expect(defs.map((d) => d.event)).toEqual([
      'SessionStart', 'Stop',
      'PostToolUse',
      'UserPromptSubmit', 'SubagentStop',
    ]);
  });

  it('installs no matcher-scoped pass: the wildcard post-tool-use pass tracks skill use (#1221) and gives the TodoWrite hint (#1788)', () => {
    for (const tool of ['claude', 'cursor', 'copilot', 'codex', 'muse', 'zcode']) {
      const defs = builtinHookDefs(tool);
      expect(defs.some((d) => d.command.includes('--matcher'))).toBe(false);
      expect(defs.filter((d) => d.event === 'PostToolUse').map((d) => d.matcher)).toEqual(['*']);
    }
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
    expect(defs).toHaveLength(5);
    expect(defs.at(-1)).toEqual(expect.objectContaining({
      event: 'SessionEnd',
      matcher: '*',
      timeout: 15,
      command: expect.stringContaining('hook-dispatch session-end --tool copilot'),
    }));
    expect(builtinHookDefs('claude').some((d) => d.event === 'SessionEnd')).toBe(false);
  });

  it('Claude defs carry no timeout; Cursor and the Codex family carry per-hook timeouts (#1070)', () => {
    expect(builtinHookDefs('claude').every((d) => d.timeout === undefined)).toBe(true);
    const cursor = builtinHookDefs('cursor');
    expect(cursor.find((d) => d.key === 'Hook dispatch session-start')?.timeout).toBe(15);
    expect(cursor.find((d) => d.key === 'Hook dispatch post-tool-use wildcard')?.timeout).toBe(10);
    for (const tool of ['codex', 'codex-internal', 'tcodex']) {
      const codex = builtinHookDefs(tool);
      expect(codex.find((d) => d.key === 'Hook dispatch session-start')?.timeout).toBe(15);
      expect(codex.find((d) => d.key === 'Hook dispatch post-tool-use wildcard')?.timeout).toBe(10);
    }
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
// Windows and use the PATH wrapper on POSIX.
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
      const dispatch = posix[i].command.replace(/^PATH="\$HOME\/\.teamai\/bin:\$PATH" (.+) 2>\/dev\/null \|\| true$/, '$1');
      expect(dispatch).not.toBe(posix[i].command);
      expect(def.command).toBe(`${dispatch} 2>$null; exit 0`);
    });
  });

  it('uses the managed PATH wrapper without a login shell on POSIX', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const defs = builtinHookDefs('dsh');
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.command).not.toContain('-lc');
      expect(def.command).toContain('PATH="$HOME/.teamai/bin:$PATH" teamai');
      expect(def.command).toContain('2>/dev/null');
      expect(def.command).toContain('|| true');
      expect(def.command).not.toContain('2>$null');
    }
  });
});

describe('builtinHookDefs — codex command is the POSIX form on every platform (#1074)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The PowerShell form Codex needs on Windows lives in the entry's commandWindows
  // (toCodexEntry in hooks.ts), so the committed project hooks.json reads the same
  // after a Windows pull and after a Linux pull.
  it('renders the same bare bash dispatch on Windows and on Linux for the codex family', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    for (const tool of ['codex', 'codex-internal', 'tcodex']) {
      platform.mockReturnValue('linux');
      const posix = builtinHookDefs(tool);
      platform.mockReturnValue('win32');
      const windows = builtinHookDefs(tool);
      expect(posix.length).toBeGreaterThan(0);
      expect(windows.map((d) => d.command)).toEqual(posix.map((d) => d.command));
      for (const def of windows) {
        expect(def.command).toMatch(new RegExp(`^bash -lc "teamai hook-dispatch \\S+ --tool ${tool}(?: --matcher \\S+)? 2>/dev/null" \\|\\| true$`));
        expect(def.command).not.toContain('bash.exe');
        expect(def.command).not.toContain('2>$null');
      }
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
      disabled: ['Hook dispatch stop'],
    });
    expect(defs).toHaveLength(builtinHookDefs('claude').length - 1);
    expect(defs.some((d) => d.key === 'Hook dispatch stop')).toBe(false);
  });

  it('applies a whitelisted timeout override', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('cursor'), {
      overrides: { 'Hook dispatch stop': { timeout: 99 } },
    });
    expect(defs.find((d) => d.key === 'Hook dispatch stop')?.timeout).toBe(99);
  });
});

describe('builtinHookForm', () => {
  const real = channelsOf;

  /** `claude` with the hook facts `facts` added, every other tool as it is. */
  const withFacts = async (facts: { unwaitedSince?: string; loginDeferrable?: true }) => {
    const actual = (await vi.importActual<typeof import('../tool-registry.js')>('../tool-registry.js')).channelsOf;
    vi.mocked(real).mockImplementation((tool) => (tool === 'claude' ? { ...actual(tool), hooks: { ...actual(tool).hooks, unwaitedSince: undefined, loginDeferrable: undefined, ...facts } } : actual(tool)));
  };

  afterEach(async () => {
    vi.mocked(real).mockImplementation((await vi.importActual<typeof import('../tool-registry.js')>('../tool-registry.js')).channelsOf);
    vi.mocked(getAgentVersion).mockReset().mockResolvedValue('');
    vi.restoreAllMocks();
  });

  it('keeps the waited login-shell form for a tool with neither fact, and starts no tool to read its version', async () => {
    for (const tool of ['cursor', 'qoder']) {
      expect(await builtinHookForm(tool, 'user')).toEqual({ unwaited: false, loginDeferred: false });
    }
    expect(getAgentVersion).not.toHaveBeenCalled();
  });

  it('defers the login shell of each internal variant as its original does, with no version floor, and starts no tool', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    for (const tool of ['claude-internal', 'tclaude', 'codex-internal', 'tcodex']) {
      expect(await builtinHookForm(tool, 'user')).toEqual({ unwaited: false, loginDeferred: true });
    }
    expect(getAgentVersion).not.toHaveBeenCalled();
  });

  it.each([
    { version: '2.1.119', unwaited: true },
    { version: '2.1.322', unwaited: true },
    { version: '2.1.118', unwaited: false },
    { version: '', unwaited: false },
    { version: 'not a version', unwaited: false },
  ])('unwaits the member\'s own file of a tool at $version against a floor of 2.1.119: $unwaited', async ({ version, unwaited }) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await withFacts({ unwaitedSince: '2.1.119' });
    vi.mocked(getAgentVersion).mockResolvedValue(version);

    expect(await builtinHookForm('claude', 'user')).toEqual({ unwaited, loginDeferred: false });
  });

  it('keeps the member\'s own file waited on Windows past the floor, and starts no tool to read its version', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await withFacts({ unwaitedSince: '2.1.119', loginDeferrable: true });
    vi.mocked(getAgentVersion).mockResolvedValue('2.1.322');

    expect(await builtinHookForm('claude', 'user')).toEqual({ unwaited: false, loginDeferred: false });
    expect(getAgentVersion).not.toHaveBeenCalled();
  });

  it('defers the login shell in the member\'s own file on POSIX only', async () => {
    await withFacts({ loginDeferrable: true });

    expect(await builtinHookForm('claude', 'user')).toEqual({ unwaited: false, loginDeferred: process.platform !== 'win32' });
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await builtinHookForm('claude', 'user')).toEqual({ unwaited: false, loginDeferred: false });
  });

  it('keeps a project file a repository may commit in the waited login-shell form, whatever the facts and the version', async () => {
    await withFacts({ unwaitedSince: '2.1.119', loginDeferrable: true });
    vi.mocked(getAgentVersion).mockResolvedValue('2.1.322');

    expect(await builtinHookForm('claude', 'project')).toEqual({ unwaited: false, loginDeferred: false });
  });

  it('marks only the PostToolUse entry of the unwaited form async, and recognises the entries of every form', () => {
    const unwaited = builtinHookDefs('codex', { unwaited: true, loginDeferred: false });

    expect(unwaited.filter((def) => def.async).map((def) => def.event)).toEqual(['PostToolUse']);
    expect(unwaited.map(({ async: _async, ...def }) => def)).toEqual(builtinHookDefs('codex'));
    expect(recognisedBuiltinHookDefs('codex')).toEqual(expect.arrayContaining([...builtinHookDefs('codex'), ...unwaited]));
  });
});

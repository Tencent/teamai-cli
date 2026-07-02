import { describe, it, expect } from 'vitest';
import { builtinHookDefs, applyBuiltinOverride } from '../builtin-hooks.js';

describe('builtinHookDefs — unified built-in hook model', () => {
  it('returns 6 built-in defs in canonical order, all tagged source=builtin', () => {
    const defs = builtinHookDefs('claude');
    expect(defs).toHaveLength(6);
    expect(defs.every((d) => d.source === 'builtin')).toBe(true);
    expect(defs.map((d) => d.event)).toEqual([
      'SessionStart', 'Stop',
      'PostToolUse', 'PostToolUse', 'PostToolUse',
      'UserPromptSubmit',
    ]);
  });

  it('Claude defs carry no timeout; Cursor defs carry per-hook timeouts', () => {
    expect(builtinHookDefs('claude').every((d) => d.timeout === undefined)).toBe(true);
    const cursor = builtinHookDefs('cursor');
    expect(cursor.find((d) => d.key === 'Hook dispatch session-start')?.timeout).toBe(60);
    expect(cursor.find((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')?.timeout).toBe(3);
  });

  it('embeds the --tool identifier and [teamai] description marker', () => {
    const def = builtinHookDefs('codebuddy')[0];
    expect(def.command).toContain('--tool codebuddy');
    expect(def.description.startsWith('[teamai] ')).toBe(true);
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
    expect(defs).toHaveLength(5);
    expect(defs.some((d) => d.key === 'Hook dispatch post-tool-use TodoWrite')).toBe(false);
  });

  it('applies a whitelisted timeout override', () => {
    const defs = applyBuiltinOverride(builtinHookDefs('cursor'), {
      overrides: { 'Hook dispatch stop': { timeout: 99 } },
    });
    expect(defs.find((d) => d.key === 'Hook dispatch stop')?.timeout).toBe(99);
  });
});

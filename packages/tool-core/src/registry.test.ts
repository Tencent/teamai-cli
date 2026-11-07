import { describe, expect, expectTypeOf, it } from 'vitest';

import { makeToolRegistry, type RegisteredTool } from './registry.js';

const TOOLS = {
  claude: { sessions: ['claude-code'], command: 'claude' },
  tclaude: { sessions: ['tclaude'], command: 'tclaude' },
  codebuddy: { sessions: ['codebuddy', 'codebuddy-ide'], command: 'codebuddy' },
  copilot: { sessions: 'none', command: 'copilot' },
  kiro: { sessions: 'unknown', command: 'kiro-cli' },
} as const satisfies Record<string, RegisteredTool & { command: string }>;

const registry = makeToolRegistry(TOOLS);

describe('makeToolRegistry', () => {
  it('lists the tools in the order the table declares them', () => {
    expect(registry.ids).toEqual(['claude', 'tclaude', 'codebuddy', 'copilot', 'kiro']);
  });

  it('knows only the tools the table declares, not names an object inherits', () => {
    expect(registry.isToolId('tclaude')).toBe(true);
    expect(registry.isToolId('acme-claude')).toBe(false);
    expect(registry.isToolId('toString')).toBe(false);
    expect(registry.isToolId('__proto__')).toBe(false);
  });

  it('hands back the definition a tool declares', () => {
    expect(registry.definitionOf('kiro').command).toBe('kiro-cli');
  });

  it('reads a tool\'s session platforms in order, first the one its launched sessions write', () => {
    expect(registry.sessionPlatformsOf('codebuddy')).toEqual(['codebuddy', 'codebuddy-ide']);
    expect(registry.sessionPlatformsOf('tclaude')).toEqual(['tclaude']);
  });

  it('reads no session platform for a tool without an adapter, with an unknown store, or unknown to it', () => {
    expect(registry.sessionPlatformsOf('copilot')).toEqual([]);
    expect(registry.sessionPlatformsOf('kiro')).toEqual([]);
    expect(registry.sessionPlatformsOf('acme-claude')).toEqual([]);
  });

  it('credits a session platform to the tool that lists it, and no platform to a tool that only shares its format', () => {
    expect(registry.sessionPlatformOwner('codebuddy-ide')).toBe('codebuddy');
    expect(registry.sessionPlatformOwner('tclaude')).toBe('tclaude');
    expect(registry.sessionPlatformOwner('claude-code')).toBe('claude');
    expect(registry.sessionPlatformOwner('qoder')).toBeUndefined();
  });

  it('keeps tool ids and session platforms literal', () => {
    expectTypeOf(registry.ids).toEqualTypeOf<readonly ('claude' | 'tclaude' | 'codebuddy' | 'copilot' | 'kiro')[]>();
    expectTypeOf(registry.sessionPlatformsOf('claude')).toEqualTypeOf<readonly ('claude-code' | 'tclaude' | 'codebuddy' | 'codebuddy-ide')[]>();
    expectTypeOf(registry.definitionOf('kiro').command).toEqualTypeOf<'kiro-cli'>();
    // @ts-expect-error a tool the table does not declare has no definition
    registry.definitionOf('acme-claude');
    const tool: string = 'claude';

    if (registry.isToolId(tool)) expectTypeOf(tool).toEqualTypeOf<'claude' | 'tclaude' | 'codebuddy' | 'copilot' | 'kiro'>();
  });
});

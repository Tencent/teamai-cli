import { describe, expect, expectTypeOf, it } from 'vitest';

import type { InstancePlatform, ToolInstance } from './instance.js';
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
    expectTypeOf(registry.sessionPlatformsOf('claude')).toEqualTypeOf<readonly ('claude-code' | 'tclaude' | 'codebuddy' | 'codebuddy-ide' | InstancePlatform)[]>();
    expectTypeOf(registry.definitionOf('kiro').command).toEqualTypeOf<'kiro-cli'>();
    // @ts-expect-error a tool the table does not declare has no definition
    registry.definitionOf('acme-claude');
    const tool: string = 'claude';

    if (registry.isToolId(tool)) expectTypeOf(tool).toEqualTypeOf<'claude' | 'tclaude' | 'codebuddy' | 'copilot' | 'kiro'>();
  });
});

describe('makeToolRegistry with instances', () => {
  const instances = new Map<string, ToolInstance<keyof typeof TOOLS>>([
    ['acme-claude', { name: 'acme-claude', extends: 'claude', command: 'acme-claude', home: { dir: '.acme-claude', env: 'ACME_CLAUDE_CONFIG_DIR' } }],
    ['acme-copilot', { name: 'acme-copilot', extends: 'copilot' }],
    ['claude', { name: 'claude', extends: 'claude', command: 'claude-wrapper' }],
    ['acme-buddy', { name: 'acme-buddy', extends: 'codebuddy', command: 'acme-buddy', home: { dir: '.acme-buddy' } }],
    ['review-claude', { name: 'review-claude', extends: 'claude' }],
  ]);
  const withInstances = makeToolRegistry(TOOLS, () => instances, (platform) => platform !== 'codebuddy');

  it('resolves a shipped tool, an instance, and an instance that adjusts a shipped tool, to the definition each runs as', () => {
    expect(withInstances.toolOf('tclaude')).toEqual({ name: 'tclaude', base: 'tclaude' });
    expect(withInstances.toolOf('acme-claude')).toEqual({ name: 'acme-claude', base: 'claude', instance: instances.get('acme-claude') });
    expect(withInstances.toolOf('claude')).toEqual({ name: 'claude', base: 'claude', instance: instances.get('claude') });
    expect(withInstances.toolOf('nobody')).toBeUndefined();
    expect(withInstances.toolOf('toString')).toBeUndefined();
  });

  it('keeps the shipped ids only shipped', () => {
    expect(withInstances.ids).toEqual(registry.ids);
    expect(withInstances.isToolId('acme-claude')).toBe(false);
  });

  it('gives an instance its own session platform, credited to it, and none when the tool it extends keeps none', () => {
    expect(withInstances.sessionPlatformsOf('acme-claude')).toEqual(['acme-claude']);
    expect(withInstances.sessionPlatformOwner('acme-claude')).toBe('acme-claude');
    expect(withInstances.sessionPlatformsOf('acme-copilot')).toEqual([]);
    expect(withInstances.sessionPlatformOwner('acme-copilot')).toBeUndefined();
  });

  it('gives an instance no session platform when the format of the tool it extends cannot carry its id', () => {
    expect(withInstances.sessionPlatformsOf('acme-buddy')).toEqual([]);
    expect(withInstances.instancePlatform('acme-buddy')).toBeUndefined();
    expect(withInstances.toolOf('acme-buddy')?.base).toBe('codebuddy');
  });

  it('gives an instance that keeps the home of the tool it extends that tool\'s session platforms, still credited to that tool', () => {
    expect(withInstances.sessionPlatformsOf('review-claude')).toEqual(['claude-code']);
    expect(withInstances.sessionPlatformOwner('claude-code')).toBe('claude');
    expect(withInstances.sessionPlatformOwner('review-claude')).toBeUndefined();
    expect(withInstances.instancePlatform('review-claude')).toBeUndefined();
  });

  it('keeps the shipped platform of a shipped tool an instance adjusts', () => {
    expect(withInstances.sessionPlatformsOf('claude')).toEqual(['claude-code']);
    expect(withInstances.sessionPlatformOwner('claude-code')).toBe('claude');
  });

  it('reads the platform an instance platform is a copy of', () => {
    expect(withInstances.instancePlatform('acme-claude')).toEqual({ instance: instances.get('acme-claude'), platform: 'claude-code' });
    expect(withInstances.instancePlatform('claude-code')).toBeUndefined();
    expect(withInstances.instancePlatform('acme-copilot')).toBeUndefined();
  });
});

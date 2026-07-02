import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────

let mockFiles: Record<string, unknown> = {};

vi.mock('../utils/fs.js', () => ({
  readJson: vi.fn(async (filePath: string) => mockFiles[filePath] ?? null),
  writeJson: vi.fn(async (filePath: string, data: unknown) => {
    mockFiles[filePath] = JSON.parse(JSON.stringify(data));
  }),
  expandHome: (p: string) => p,
  ensureDir: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getHookStatus, injectHooks, removeHooks, injectHooksToAllTools, TEAMAI_HOOK_SUBCOMMANDS, TEAMAI_LEGACY_HOOK_SUBCOMMANDS, CLAUDE_TO_CURSOR_EVENTS } from '../hooks.js';

// ── Helpers ──────────────────────────────────────────────

function extractCommands(hooks: Record<string, unknown[]>): string[] {
  const cmds: string[] = [];
  for (const entries of Object.values(hooks)) {
    for (const entry of entries as Array<Record<string, unknown>>) {
      if (entry.command) {
        cmds.push(entry.command as string);
      } else if (entry.hooks) {
        for (const h of entry.hooks as Array<Record<string, string>>) {
          cmds.push(h.command);
        }
      }
    }
  }
  return cmds;
}

function extractTeamaiSubcommands(hooks: Record<string, unknown[]>): string[] {
  const cmds = extractCommands(hooks);
  const subcmds = new Set<string>();
  for (const cmd of cmds) {
    const match = cmd.match(/teamai\s+([\w-]+)/);
    if (match) subcmds.add(match[1]);
  }
  return [...subcmds].sort();
}

// ── Tests ────────────────────────────────────────────────

describe('hooks', () => {
  beforeEach(() => {
    mockFiles = {};
    vi.clearAllMocks();
  });

  describe('inject — empty file', () => {
    it('Claude format: injects 4 events with 6 dispatch hooks into empty settings.json', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      expect(result.hooks).toBeDefined();

      const events = Object.keys(result.hooks);
      expect(events).toEqual(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit']);

      // Merged dispatch format: one dispatch entry per event+matcher.
      // SessionStart(*:1), Stop(*:1),
      // PostToolUse(*:1, Skill:1, TodoWrite:1), UserPromptSubmit(*:1)
      expect(result.hooks['SessionStart']).toHaveLength(1);
      expect(result.hooks['Stop']).toHaveLength(1);
      expect(result.hooks['PostToolUse']).toHaveLength(3);
      expect(result.hooks['UserPromptSubmit']).toHaveLength(1);
    });

    it('Cursor format: injects 4 events with 6 dispatch hooks into empty hooks.json', async () => {
      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { version: number; hooks: Record<string, unknown[]> };
      expect(result.version).toBe(1);
      expect(result.hooks).toBeDefined();

      const events = Object.keys(result.hooks);
      expect(events).toEqual(['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt']);

      // Same merged structure (with TodoWrite dispatch entry)
      expect(result.hooks['sessionStart']).toHaveLength(1);
      expect(result.hooks['stop']).toHaveLength(1);
      expect(result.hooks['postToolUse']).toHaveLength(3);
      expect(result.hooks['beforeSubmitPrompt']).toHaveLength(1);
    });

    it('Codex format: injects PascalCase events into hooks.json', async () => {
      await injectHooks('/test/codex-hooks.json', 'codex');

      const result = mockFiles['/test/codex-hooks.json'] as { hooks: Record<string, Array<{ matcher?: string; description?: string; hooks: Array<{ command: string }> }>> };
      expect(result.hooks).toBeDefined();
      expect(Object.keys(result.hooks)).toEqual(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit']);
      expect(result.hooks.PostToolUse).toHaveLength(3);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('--tool codex');
      expect(result.hooks.SessionStart[0].description).toBeUndefined();
    });

    it('Claude uses PascalCase event names', async () => {
      await injectHooks('/test/settings.json', 'claude');
      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      for (const event of Object.keys(result.hooks)) {
        expect(event[0]).toBe(event[0].toUpperCase());
      }
    });

    it('Cursor uses camelCase event names', async () => {
      await injectHooks('/test/hooks.json', 'cursor');
      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      for (const event of Object.keys(result.hooks)) {
        expect(event[0]).toBe(event[0].toLowerCase());
      }
    });
  });

  describe('inject — idempotency', () => {
    it('double inject does not duplicate hooks', async () => {
      await injectHooks('/test/settings.json', 'claude');
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      expect(result.hooks['SessionStart']).toHaveLength(1);
      expect(result.hooks['Stop']).toHaveLength(1);
      expect(result.hooks['PostToolUse']).toHaveLength(3);
      expect(result.hooks['UserPromptSubmit']).toHaveLength(1);
    });

    it('double inject for Cursor does not duplicate hooks', async () => {
      await injectHooks('/test/hooks.json', 'cursor');
      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      expect(result.hooks['sessionStart']).toHaveLength(1);
      expect(result.hooks['stop']).toHaveLength(1);
      expect(result.hooks['postToolUse']).toHaveLength(3);
      expect(result.hooks['beforeSubmitPrompt']).toHaveLength(1);
    });

    it('updates command when content changes (Claude)', async () => {
      // Simulate legacy hook that will be cleaned up and replaced with dispatch
      mockFiles['/test/settings.json'] = {
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'bash -lc "teamai pull --silent" 2>/dev/null || true' }],
              description: '[teamai] Auto-pull team resources on session start',
            },
          ],
        },
      };

      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      const sessionStart = result.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
      // Legacy format cleaned up, replaced with hook-dispatch
      expect(sessionStart[0].hooks[0].command).toContain('hook-dispatch');
    });

    it('updates command when content changes (Cursor)', async () => {
      // Simulate legacy hook
      mockFiles['/test/hooks.json'] = {
        version: 1,
        hooks: {
          sessionStart: [
            { command: 'bash -lc "teamai pull --silent" 2>/dev/null || true', timeout: 30 },
          ],
        },
      };

      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, Array<{ command: string }>> };
      // Legacy format cleaned up, replaced with hook-dispatch
      expect(result.hooks.sessionStart[0].command).toContain('hook-dispatch');
    });
  });

  describe('inject — preserves non-teamai hooks', () => {
    it('Claude format: preserves user hooks', async () => {
      const userHook = {
        matcher: '*',
        hooks: [{ type: 'command', command: 'echo "my custom hook"' }],
        description: 'My custom hook',
      };
      mockFiles['/test/settings.json'] = {
        hooks: { SessionStart: [userHook] },
        language: 'en',
      };

      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as {
        hooks: Record<string, unknown[]>;
        language: string;
      };
      // User hook + 1 dispatch entry
      expect(result.hooks.SessionStart).toHaveLength(2);
      expect(result.hooks.SessionStart[0]).toEqual(userHook);
      expect(result.language).toBe('en');
    });

    it('Cursor format: preserves user hooks', async () => {
      const userHook = { command: 'echo "my custom hook"', timeout: 5 };
      mockFiles['/test/hooks.json'] = {
        version: 1,
        hooks: { sessionStart: [userHook] },
      };

      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      // User hook + 1 dispatch entry
      expect(result.hooks.sessionStart).toHaveLength(2);
      expect(result.hooks.sessionStart[0]).toEqual(userHook);
    });
  });

  describe('remove', () => {
    it('Claude format: removes all teamai hooks, preserves others', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const userHook = {
        matcher: '*',
        hooks: [{ type: 'command', command: 'echo "keep me"' }],
        description: 'User hook',
      };
      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      result.hooks.SessionStart.push(userHook);
      mockFiles['/test/settings.json'] = result;

      await removeHooks('/test/settings.json', 'claude');

      const after = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      expect(after.hooks.SessionStart).toHaveLength(1);
      expect(after.hooks.SessionStart[0]).toEqual(userHook);
      expect(after.hooks.Stop).toHaveLength(0);
      expect(after.hooks.PostToolUse).toHaveLength(0);
      expect(after.hooks.UserPromptSubmit).toHaveLength(0);
    });

    it('Cursor format: removes all teamai hooks, preserves others', async () => {
      await injectHooks('/test/hooks.json', 'cursor');

      const userHook = { command: 'echo "keep me"', timeout: 5 };
      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      result.hooks.sessionStart.push(userHook);
      mockFiles['/test/hooks.json'] = result;

      await removeHooks('/test/hooks.json', 'cursor');

      const after = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      expect(after.hooks.sessionStart).toHaveLength(1);
      expect(after.hooks.sessionStart[0]).toEqual(userHook);
      expect(after.hooks.stop).toHaveLength(0);
      expect(after.hooks.postToolUse).toHaveLength(0);
      expect(after.hooks.beforeSubmitPrompt).toHaveLength(0);
    });
  });

  describe('inject — stale event key cleanup', () => {
    it('Cursor inject removes stale teamai event keys (e.g. userPromptSubmit)', async () => {
      mockFiles['/test/hooks.json'] = {
        version: 1,
        hooks: {
          userPromptSubmit: [
            { command: 'bash -lc "teamai track-slash --stdin --tool cursor 2>/dev/null" || true', timeout: 10 },
            { command: 'bash -lc "teamai dashboard-report --stdin --tool cursor 2>/dev/null" || true', timeout: 10 },
          ],
        },
      };

      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      expect(result.hooks['userPromptSubmit']).toBeUndefined();
      // New merged format: single dispatch entry
      expect(result.hooks['beforeSubmitPrompt']).toHaveLength(1);
    });

    it('Cursor inject preserves user hooks in stale event keys', async () => {
      mockFiles['/test/hooks.json'] = {
        version: 1,
        hooks: {
          userPromptSubmit: [
            { command: 'bash -lc "teamai track-slash --stdin --tool cursor 2>/dev/null" || true', timeout: 10 },
            { command: 'echo "user custom hook"', timeout: 5 },
          ],
        },
      };

      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      expect(result.hooks['userPromptSubmit']).toHaveLength(1);
      expect((result.hooks['userPromptSubmit'][0] as { command: string }).command).toBe('echo "user custom hook"');
    });
  });

  describe('inject — tool parameterization', () => {
    it('Claude hooks contain --tool parameter matching the tool name', async () => {
      await injectHooks('/test/settings.json', 'claude');
      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      const cmds = extractCommands(result.hooks);
      const toolCmds = cmds.filter((c) => c.includes('--tool'));
      expect(toolCmds.length).toBeGreaterThan(0);
      for (const cmd of toolCmds) {
        expect(cmd).toContain('--tool claude');
      }
    });

    it('Cursor hooks contain --tool cursor', async () => {
      await injectHooks('/test/hooks.json', 'cursor');
      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      const cmds = extractCommands(result.hooks);
      const toolCmds = cmds.filter((c) => c.includes('--tool'));
      expect(toolCmds.length).toBeGreaterThan(0);
      for (const cmd of toolCmds) {
        expect(cmd).toContain('--tool cursor');
      }
    });

    it('codebuddy hooks contain --tool codebuddy', async () => {
      await injectHooks('/test/settings.json', 'codebuddy');
      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      const cmds = extractCommands(result.hooks);
      const toolCmds = cmds.filter((c) => c.includes('--tool'));
      for (const cmd of toolCmds) {
        expect(cmd).toContain('--tool codebuddy');
      }
    });

    it('codex hooks contain --tool codex', async () => {
      await injectHooks('/test/hooks.json', 'codex');
      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      const cmds = extractCommands(result.hooks);
      const toolCmds = cmds.filter((c) => c.includes('--tool'));
      expect(toolCmds.length).toBeGreaterThan(0);
      for (const cmd of toolCmds) {
        expect(cmd).toContain('--tool codex');
      }
    });
  });

  describe('injectHooksToAllTools', () => {
    it('injects into all configured settings paths including Codex hooks.json', async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = '/test-home';

      try {
        await injectHooksToAllTools({
          claude: { settings: '.claude/settings.json' },
          codex: { settings: '.codex/hooks.json' },
          cursor: { settings: '.cursor/hooks.json' },
        });

        expect(mockFiles[path.join('/test-home', '.claude/settings.json')]).toBeDefined();
        expect(mockFiles[path.join('/test-home', '.codex/hooks.json')]).toBeDefined();
        expect(mockFiles[path.join('/test-home', '.cursor/hooks.json')]).toBeDefined();
        expect(Object.keys(mockFiles)).toHaveLength(3);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe('format alignment', () => {
    it('Claude and Cursor inject the same set of teamai subcommands (except Claude-only hooks)', async () => {
      await injectHooks('/test/claude.json', 'claude');
      await injectHooks('/test/cursor.json', 'cursor');

      const claudeResult = mockFiles['/test/claude.json'] as { hooks: Record<string, unknown[]> };
      const cursorResult = mockFiles['/test/cursor.json'] as { hooks: Record<string, unknown[]> };

      const claudeSubcmds = extractTeamaiSubcommands(claudeResult.hooks);
      const cursorSubcmds = extractTeamaiSubcommands(cursorResult.hooks);

      // Both Claude and Cursor should have the same subcommands
      expect(claudeSubcmds).toEqual([...TEAMAI_HOOK_SUBCOMMANDS].sort());
      // Cursor should also have all subcommands (contribute-check moved to Stop, supported by both)
      expect(cursorSubcmds).toEqual([...TEAMAI_HOOK_SUBCOMMANDS].sort());
    });

    it('Claude PascalCase events map 1:1 to Cursor camelCase events', async () => {
      await injectHooks('/test/claude.json', 'claude');
      await injectHooks('/test/cursor.json', 'cursor');

      const claudeResult = mockFiles['/test/claude.json'] as { hooks: Record<string, unknown[]> };
      const cursorResult = mockFiles['/test/cursor.json'] as { hooks: Record<string, unknown[]> };

      const claudeEvents = Object.keys(claudeResult.hooks).sort();
      const cursorEvents = Object.keys(cursorResult.hooks).sort();

      expect(claudeEvents).toHaveLength(cursorEvents.length);

      for (const claudeEvent of claudeEvents) {
        const expectedCursorEvent = CLAUDE_TO_CURSOR_EVENTS[claudeEvent];
        expect(expectedCursorEvent).toBeDefined();
        expect(cursorEvents).toContain(expectedCursorEvent);
      }
    });

    it('Claude and Cursor have the same number of hooks per event', async () => {
      await injectHooks('/test/claude.json', 'claude');
      await injectHooks('/test/cursor.json', 'cursor');

      const claudeResult = mockFiles['/test/claude.json'] as { hooks: Record<string, unknown[]> };
      const cursorResult = mockFiles['/test/cursor.json'] as { hooks: Record<string, unknown[]> };

      for (const [claudeEvent, cursorEvent] of Object.entries(CLAUDE_TO_CURSOR_EVENTS)) {
        // Cursor has same hooks per event as Claude (contribute-check now in Stop for both)
        expect(cursorResult.hooks[cursorEvent].length).toEqual(
          claudeResult.hooks[claudeEvent].length
        );
      }
    });

    it('PostToolUse/postToolUse Skill matcher dispatch hook exists in both formats', async () => {
      await injectHooks('/test/claude.json', 'claude');
      await injectHooks('/test/cursor.json', 'cursor');

      const claudeResult = mockFiles['/test/claude.json'] as { hooks: Record<string, Array<{ matcher: string }>> };
      const cursorResult = mockFiles['/test/cursor.json'] as { hooks: Record<string, Array<{ matcher?: string; command: string }>> };

      const claudeSkill = claudeResult.hooks.PostToolUse.find((h) => h.matcher === 'Skill');
      expect(claudeSkill).toBeDefined();

      const cursorSkill = cursorResult.hooks.postToolUse.find(
        (h) => h.matcher === 'Skill'
      );
      expect(cursorSkill).toBeDefined();
      expect(cursorSkill!.command).toContain('hook-dispatch');
    });

    it('Cursor hooks have timeout values', async () => {
      await injectHooks('/test/hooks.json', 'cursor');
      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, Array<{ timeout?: number }>> };
      for (const entries of Object.values(result.hooks)) {
        for (const entry of entries) {
          expect(entry.timeout).toBeGreaterThan(0);
        }
      }
    });

    it('Claude hooks have [teamai] description prefix', async () => {
      await injectHooks('/test/settings.json', 'claude');
      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, Array<{ description?: string }>> };
      for (const entries of Object.values(result.hooks)) {
        for (const entry of entries) {
          expect(entry.description).toMatch(/^\[teamai\]/);
        }
      }
    });

    it('no hardcoded tool names in commands — commands are parameterized', async () => {
      await injectHooks('/test/a.json', 'tool-alpha');
      await injectHooks('/test/b.json', 'tool-beta');

      const resultA = mockFiles['/test/a.json'] as { hooks: Record<string, unknown[]> };
      const resultB = mockFiles['/test/b.json'] as { hooks: Record<string, unknown[]> };

      const cmdsA = extractCommands(resultA.hooks).filter((c) => c.includes('--tool'));
      const cmdsB = extractCommands(resultB.hooks).filter((c) => c.includes('--tool'));

      for (const cmd of cmdsA) {
        expect(cmd).toContain('--tool tool-alpha');
        expect(cmd).not.toContain('--tool tool-beta');
      }
      for (const cmd of cmdsB) {
        expect(cmd).toContain('--tool tool-beta');
        expect(cmd).not.toContain('--tool tool-alpha');
      }
    });
  });

  describe('TEAMAI_HOOK_SUBCOMMANDS export', () => {
    it('contains hook-dispatch as the unified subcommand', () => {
      expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('hook-dispatch');
      expect(TEAMAI_HOOK_SUBCOMMANDS).toHaveLength(1);
    });

    it('TEAMAI_LEGACY_HOOK_SUBCOMMANDS contains all old subcommands for cleanup', () => {
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('pull');
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('update');
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('track');
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('track-slash');
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('dashboard-report');
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('contribute-check');
      expect(TEAMAI_LEGACY_HOOK_SUBCOMMANDS).toContain('auto-recall');
    });
  });

  describe('getHookStatus', () => {
    it('reports installed for current Claude hooks', async () => {
      await injectHooks('/test/settings.json', 'claude');

      await expect(getHookStatus('/test/settings.json', 'claude')).resolves.toBe('installed');
    });

    it('reports installed for current Cursor hooks', async () => {
      await injectHooks('/test/hooks.json', 'cursor');

      await expect(getHookStatus('/test/hooks.json', 'cursor')).resolves.toBe('installed');
    });

    it('reports missing when settings exist without teamai hooks', async () => {
      mockFiles['/test/settings.json'] = { hooks: {} };

      await expect(getHookStatus('/test/settings.json', 'claude')).resolves.toBe('missing');
    });
  });

  describe('edge cases', () => {
    it('handles settings.json with non-hooks fields', async () => {
      mockFiles['/test/settings.json'] = {
        language: '中文',
        model: 'GLM5',
        skipDangerousModePermissionPrompt: true,
      };

      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as Record<string, unknown>;
      expect(result.language).toBe('中文');
      expect(result.model).toBe('GLM5');
      expect(result.hooks).toBeDefined();
    });

    it('second inject leaves settings JSON semantically equivalent (idempotent)', async () => {
      await injectHooks('/test/settings.json', 'claude');
      const afterFirst = JSON.stringify(mockFiles['/test/settings.json']);

      await injectHooks('/test/settings.json', 'claude');
      const afterSecond = JSON.stringify(mockFiles['/test/settings.json']);

      expect(afterSecond).toBe(afterFirst);
    });
  });
});

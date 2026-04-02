import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { injectHooks, removeHooks, injectHooksToAllTools, TEAMAI_HOOK_SUBCOMMANDS, CLAUDE_TO_CURSOR_EVENTS } from '../hooks.js';

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
    it('Claude format: injects 4 events with 10 hooks into empty settings.json', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, unknown[]> };
      expect(result.hooks).toBeDefined();

      const events = Object.keys(result.hooks);
      expect(events).toEqual(['SessionStart', 'Stop', 'PostToolUse', 'UserPromptSubmit']);

      // PostToolUse has 4 hooks (track-skill, dashboard-tool, contribute-check, auto-recall)
      // Others have 2 each
      expect(result.hooks['SessionStart']).toHaveLength(2);
      expect(result.hooks['Stop']).toHaveLength(2);
      expect(result.hooks['PostToolUse']).toHaveLength(4);
      expect(result.hooks['UserPromptSubmit']).toHaveLength(2);
    });

    it('Cursor format: injects 4 events with 10 hooks into empty hooks.json', async () => {
      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { version: number; hooks: Record<string, unknown[]> };
      expect(result.version).toBe(1);
      expect(result.hooks).toBeDefined();

      const events = Object.keys(result.hooks);
      expect(events).toEqual(['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt']);

      // postToolUse has 4 hooks (track, dashboard, contribute-check, auto-recall), others have 2
      expect(result.hooks['sessionStart']).toHaveLength(2);
      expect(result.hooks['stop']).toHaveLength(2);
      expect(result.hooks['postToolUse']).toHaveLength(4);
      expect(result.hooks['beforeSubmitPrompt']).toHaveLength(2);
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
      // PostToolUse has 4 hooks, others have 2
      expect(result.hooks['SessionStart']).toHaveLength(2);
      expect(result.hooks['Stop']).toHaveLength(2);
      expect(result.hooks['PostToolUse']).toHaveLength(4);
      expect(result.hooks['UserPromptSubmit']).toHaveLength(2);
    });

    it('double inject for Cursor does not duplicate hooks', async () => {
      await injectHooks('/test/hooks.json', 'cursor');
      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, unknown[]> };
      // postToolUse has 4 hooks, others have 2
      expect(result.hooks['sessionStart']).toHaveLength(2);
      expect(result.hooks['stop']).toHaveLength(2);
      expect(result.hooks['postToolUse']).toHaveLength(4);
      expect(result.hooks['beforeSubmitPrompt']).toHaveLength(2);
    });

    it('updates command when content changes (Claude)', async () => {
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
      expect(sessionStart[0].hooks[0].command).toContain('teamai pull');
      expect(sessionStart[0].hooks[0].command).not.toContain('--silent');
    });

    it('updates command when content changes (Cursor)', async () => {
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
      const pullHook = result.hooks.sessionStart.find((h) => h.command.includes('teamai pull'));
      expect(pullHook?.command).not.toContain('--silent');
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
      expect(result.hooks.SessionStart).toHaveLength(3);
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
      expect(result.hooks.sessionStart).toHaveLength(3);
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
  });

  describe('injectHooksToAllTools', () => {
    it('injects into tools with settings path, skips those without', async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = '/test-home';

      await injectHooksToAllTools({
        claude: { settings: '.claude/settings.json' },
        codex: {},
        cursor: { settings: '.cursor/hooks.json' },
      });

      expect(mockFiles['/test-home/.claude/settings.json']).toBeDefined();
      expect(mockFiles['/test-home/.cursor/hooks.json']).toBeDefined();
      expect(Object.keys(mockFiles)).toHaveLength(2);

      process.env.HOME = originalHome;
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

      // Claude has contribute-check (STDOUT hint) which Cursor doesn't support
      expect(claudeSubcmds).toEqual([...TEAMAI_HOOK_SUBCOMMANDS].sort());
      // Cursor is a subset of Claude (without Claude-only hooks like contribute-check)
      for (const cmd of cursorSubcmds) {
        expect(claudeSubcmds).toContain(cmd);
      }
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

    it('Cursor hooks are a subset of Claude hooks per event (Claude may have extra hooks)', async () => {
      await injectHooks('/test/claude.json', 'claude');
      await injectHooks('/test/cursor.json', 'cursor');

      const claudeResult = mockFiles['/test/claude.json'] as { hooks: Record<string, unknown[]> };
      const cursorResult = mockFiles['/test/cursor.json'] as { hooks: Record<string, unknown[]> };

      for (const [claudeEvent, cursorEvent] of Object.entries(CLAUDE_TO_CURSOR_EVENTS)) {
        // Cursor has <= Claude hooks per event (Claude may have extra like contribute-check)
        expect(cursorResult.hooks[cursorEvent].length).toBeLessThanOrEqual(
          claudeResult.hooks[claudeEvent].length
        );
      }
    });

    it('PostToolUse/postToolUse track hook uses Skill matcher in both formats', async () => {
      await injectHooks('/test/claude.json', 'claude');
      await injectHooks('/test/cursor.json', 'cursor');

      const claudeResult = mockFiles['/test/claude.json'] as { hooks: Record<string, Array<{ matcher: string }>> };
      const cursorResult = mockFiles['/test/cursor.json'] as { hooks: Record<string, Array<{ matcher?: string; command: string }>> };

      const claudeTrack = claudeResult.hooks.PostToolUse.find((h) => h.matcher === 'Skill');
      expect(claudeTrack).toBeDefined();

      const cursorTrack = cursorResult.hooks.postToolUse.find(
        (h) => h.command.includes('teamai track') && !h.command.includes('track-slash')
      );
      expect(cursorTrack?.matcher).toBe('Skill');
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
    it('contains all expected subcommands', () => {
      expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('pull');
      expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('update');
      expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('track');
      expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('track-slash');
      expect(TEAMAI_HOOK_SUBCOMMANDS).toContain('dashboard-report');
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

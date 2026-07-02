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

import { injectHooks } from '../hooks.js';

// ── Helpers ──────────────────────────────────────────────

interface ClaudeHookEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface ClaudeHookMatcher {
  matcher: string;
  hooks: ClaudeHookEntry[];
  description?: string;
}

interface CursorHookEntry {
  command: string;
  timeout?: number;
  matcher?: string;
}

// ── Tests ────────────────────────────────────────────────

describe('hooks — merged dispatch format', () => {
  beforeEach(() => {
    mockFiles = {};
    vi.clearAllMocks();
  });

  describe('Claude format', () => {
    it('uses hook-dispatch commands instead of individual subcommands', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const allCommands: string[] = [];
      for (const matchers of Object.values(result.hooks)) {
        for (const m of matchers) {
          for (const h of m.hooks) {
            allCommands.push(h.command);
          }
        }
      }

      // All commands should use hook-dispatch
      const dispatchCommands = allCommands.filter((c) => c.includes('teamai hook-dispatch'));
      expect(dispatchCommands.length).toBe(allCommands.length);
      // No individual subcommands like "teamai pull", "teamai track", etc.
      const legacyCommands = allCommands.filter(
        (c) => c.includes('teamai pull') || c.includes('teamai track') || c.includes('teamai dashboard-report'),
      );
      expect(legacyCommands).toHaveLength(0);
    });

    it('produces fewer hook entries than the old format (13 → merged)', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      let totalEntries = 0;
      for (const matchers of Object.values(result.hooks)) {
        totalEntries += matchers.length;
      }

      // Should have: SessionStart(1) + Stop(1) + PostToolUse(*:1, Skill:1, TodoWrite:1) + UserPromptSubmit(1) = 6
      expect(totalEntries).toBeLessThanOrEqual(6);
    });

    it('SessionStart has exactly one entry with wildcard matcher', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const sessionStart = result.hooks.SessionStart;
      expect(sessionStart).toHaveLength(1);
      expect(sessionStart[0].matcher).toBe('*');
      expect(sessionStart[0].hooks[0].command).toContain('hook-dispatch session-start');
    });

    it('Stop has exactly one entry with wildcard matcher', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const stop = result.hooks.Stop;
      expect(stop).toHaveLength(1);
      expect(stop[0].matcher).toBe('*');
      expect(stop[0].hooks[0].command).toContain('hook-dispatch stop');
    });

    it('PostToolUse has entries for each distinct matcher', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const postToolUse = result.hooks.PostToolUse;
      const matchers = postToolUse.map((m: ClaudeHookMatcher) => m.matcher).sort();
      expect(matchers).toEqual(['*', 'Skill', 'TodoWrite']);
    });

    it('UserPromptSubmit has exactly one entry with wildcard matcher', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const promptSubmit = result.hooks.UserPromptSubmit;
      expect(promptSubmit).toHaveLength(1);
      expect(promptSubmit[0].matcher).toBe('*');
      expect(promptSubmit[0].hooks[0].command).toContain('hook-dispatch prompt-submit');
    });

    it('includes --tool parameter in dispatch commands', async () => {
      await injectHooks('/test/settings.json', 'claude-internal');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const cmd = result.hooks.SessionStart[0].hooks[0].command;
      expect(cmd).toContain('--tool claude-internal');
    });

    it('includes --matcher parameter for non-wildcard PostToolUse entries', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const skillEntry = result.hooks.PostToolUse.find((m: ClaudeHookMatcher) => m.matcher === 'Skill');
      expect(skillEntry!.hooks[0].command).toContain('--matcher Skill');
    });

    it('does not include --matcher for wildcard entries', async () => {
      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const wildcardEntry = result.hooks.SessionStart[0];
      expect(wildcardEntry.hooks[0].command).not.toContain('--matcher');
    });
  });

  describe('Cursor format', () => {
    it('uses hook-dispatch commands', async () => {
      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, CursorHookEntry[]> };
      const allCommands: string[] = [];
      for (const entries of Object.values(result.hooks)) {
        for (const entry of entries) {
          allCommands.push(entry.command);
        }
      }

      const dispatchCommands = allCommands.filter((c) => c.includes('teamai hook-dispatch'));
      expect(dispatchCommands.length).toBe(allCommands.length);
    });

    it('Cursor hooks have correct camelCase event names in commands', async () => {
      await injectHooks('/test/hooks.json', 'cursor');

      const result = mockFiles['/test/hooks.json'] as { hooks: Record<string, CursorHookEntry[]> };
      expect(result.hooks.sessionStart).toBeDefined();
      expect(result.hooks.stop).toBeDefined();
      expect(result.hooks.postToolUse).toBeDefined();
      expect(result.hooks.beforeSubmitPrompt).toBeDefined();
    });
  });

  describe('migration — legacy cleanup', () => {
    it('removes old-format hooks and replaces with dispatch format', async () => {
      // Pre-populate with legacy format
      mockFiles['/test/settings.json'] = {
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'bash -lc "teamai pull 2>/dev/null" || true' }],
              description: '[teamai] Auto-pull team resources on session start',
            },
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'bash -lc "teamai dashboard-report --stdin --tool claude 2>/dev/null" || true' }],
              description: '[teamai] Dashboard report on session start',
            },
          ],
        },
      };

      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      // Legacy entries should be cleaned up and replaced with single dispatch entry
      expect(result.hooks.SessionStart).toHaveLength(1);
      expect(result.hooks.SessionStart[0].hooks[0].command).toContain('hook-dispatch');
    });

    it('preserves non-teamai hooks during migration', async () => {
      mockFiles['/test/settings.json'] = {
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'bash -lc "teamai pull 2>/dev/null" || true' }],
              description: '[teamai] Auto-pull team resources on session start',
            },
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo "custom hook"' }],
              description: 'My custom hook',
            },
          ],
        },
      };

      await injectHooks('/test/settings.json', 'claude');

      const result = mockFiles['/test/settings.json'] as { hooks: Record<string, ClaudeHookMatcher[]> };
      const customHook = result.hooks.SessionStart.find(
        (m: ClaudeHookMatcher) => m.description === 'My custom hook',
      );
      expect(customHook).toBeDefined();
    });
  });
});

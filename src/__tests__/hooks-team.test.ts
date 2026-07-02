import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reconcileHooks } from '../hooks.js';
import type { HookDef } from '../types.js';

const SETTINGS = '/test/settings.json';
const CURSOR = '/test/hooks.json';
const MANIFEST = '/test/managed-hooks.json';

function teamDef(over: Partial<HookDef> = {}): HookDef {
  return {
    source: 'team',
    key: 'block-secret',
    event: 'PostToolUse',
    matcher: 'Bash',
    command: 'bash -lc "~/.teamai/team-scripts/scan.sh" || true',
    timeout: 15,
    description: '[teamai:hook:block-secret] scan secrets before bash',
    ...over,
  };
}

function claudeHooks(): Record<string, Array<{ matcher?: string; description?: string; hooks: Array<{ command: string }> }>> {
  return (mockFiles[SETTINGS] as { hooks: Record<string, never> }).hooks as never;
}
function cursorHooks(): Record<string, Array<{ command: string; matcher?: string; timeout?: number }>> {
  return (mockFiles[CURSOR] as { hooks: Record<string, never> }).hooks as never;
}
function manifest(): Record<string, Array<{ id: string; event: string; matcher?: string; command: string }>> {
  return (mockFiles[MANIFEST] as Record<string, never>) ?? {};
}

describe('reconcileHooks — team (B) hooks', () => {
  beforeEach(() => {
    mockFiles = {};
    vi.clearAllMocks();
  });

  describe('Claude format', () => {
    it('injects a team hook after the built-in hooks in its event', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });

      const postToolUse = claudeHooks().PostToolUse;
      expect(postToolUse).toHaveLength(4); // 3 built-in + 1 team
      const team = postToolUse[postToolUse.length - 1];
      expect(team.description).toBe('[teamai:hook:block-secret] scan secrets before bash');
      expect(team.matcher).toBe('Bash');
      expect(team.hooks[0].command).toContain('scan.sh');
    });

    it('records the team hook in the manifest', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      expect(manifest().claude).toEqual([
        { id: 'block-secret', event: 'PostToolUse', matcher: 'Bash', command: expect.stringContaining('scan.sh') },
      ]);
    });

    it('removes a team hook when it disappears from the desired set, leaving built-in intact', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(SETTINGS, 'claude', [], { manifestPath: MANIFEST });

      expect(claudeHooks().PostToolUse).toHaveLength(3); // built-in only
      const descs = claudeHooks().PostToolUse.map((h) => h.description);
      expect(descs.every((d) => d?.startsWith('[teamai] '))).toBe(true);
      expect(manifest().claude).toBeUndefined();
    });

    it('updates a team hook when its command changes', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(SETTINGS, 'claude', [teamDef({ command: 'echo changed' })], { manifestPath: MANIFEST });

      const team = claudeHooks().PostToolUse.find((h) => h.description?.startsWith('[teamai:hook:block-secret]'));
      expect(team?.hooks[0].command).toBe('echo changed');
      expect(claudeHooks().PostToolUse).toHaveLength(4);
    });

    it('does not touch user-authored hooks', async () => {
      mockFiles[SETTINGS] = {
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user' }], description: 'mine' }],
        },
      };
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });

      expect(claudeHooks().PostToolUse[0]).toEqual({
        matcher: '*', hooks: [{ type: 'command', command: 'echo user' }], description: 'mine',
      });
      expect(claudeHooks().PostToolUse).toHaveLength(5); // user + 3 built-in + 1 team
    });

    it('is idempotent with team hooks present', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      const first = JSON.stringify(mockFiles[SETTINGS]);
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      expect(JSON.stringify(mockFiles[SETTINGS])).toBe(first);
    });
  });

  describe('Cursor format (manifest-tracked)', () => {
    it('injects a team hook and records it in the manifest', async () => {
      await reconcileHooks(CURSOR, 'cursor', [teamDef()], { manifestPath: MANIFEST });

      expect(cursorHooks().postToolUse).toHaveLength(4);
      const team = cursorHooks().postToolUse.find((h) => h.command.includes('scan.sh'));
      expect(team).toMatchObject({ matcher: 'Bash', timeout: 15 });
      expect(manifest().cursor?.[0].id).toBe('block-secret');
    });

    it('removes a stale team hook using the manifest (command carries no teamai marker)', async () => {
      await reconcileHooks(CURSOR, 'cursor', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(CURSOR, 'cursor', [], { manifestPath: MANIFEST });

      expect(cursorHooks().postToolUse).toHaveLength(3); // built-in only
      expect(cursorHooks().postToolUse.some((h) => h.command.includes('scan.sh'))).toBe(false);
      expect(manifest().cursor).toBeUndefined();
    });
  });

  describe('tool filtering', () => {
    it('skips a team hook whose tools list excludes the tool', async () => {
      const claudeOnly = teamDef({ tools: ['claude'] });
      await reconcileHooks(CURSOR, 'cursor', [claudeOnly], { manifestPath: MANIFEST });
      expect(cursorHooks().postToolUse).toHaveLength(3);
      expect(manifest().cursor).toBeUndefined();

      await reconcileHooks(SETTINGS, 'claude', [claudeOnly], { manifestPath: MANIFEST });
      expect(claudeHooks().PostToolUse).toHaveLength(4);
    });

    it('skips a team hook for an event Cursor does not support, but injects it for Claude', async () => {
      const preToolUse = teamDef({ key: 'pre', event: 'PreToolUse', description: '[teamai:hook:pre] x' });
      await reconcileHooks(CURSOR, 'cursor', [preToolUse], { manifestPath: MANIFEST });
      // No PreToolUse mapping for cursor → nothing injected, only built-in events present
      expect(Object.keys(cursorHooks())).toEqual(['sessionStart', 'stop', 'postToolUse', 'beforeSubmitPrompt']);

      await reconcileHooks(SETTINGS, 'claude', [preToolUse], { manifestPath: MANIFEST });
      expect(claudeHooks().PreToolUse).toHaveLength(1);
    });
  });

  describe('coexistence (§5 mixed-version safety)', () => {
    it('a built-in-only refresh (no manifest) preserves existing team hooks', async () => {
      // Team pass injects A + B.
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      expect(claudeHooks().PostToolUse).toHaveLength(4);

      // An old/builtin-only injector runs (no team context): must NOT drop the team hook.
      await reconcileHooks(SETTINGS, 'claude', []);

      const team = claudeHooks().PostToolUse.find((h) => h.description?.startsWith('[teamai:hook:block-secret]'));
      expect(team).toBeDefined();
      expect(claudeHooks().PostToolUse).toHaveLength(4);
    });

    it('Cursor: a built-in-only refresh preserves team hooks (manifest-tracked)', async () => {
      await reconcileHooks(CURSOR, 'cursor', [teamDef()], { manifestPath: MANIFEST });
      expect(cursorHooks().postToolUse).toHaveLength(4);

      await reconcileHooks(CURSOR, 'cursor', []);
      expect(cursorHooks().postToolUse.some((h) => h.command.includes('scan.sh'))).toBe(true);
      expect(cursorHooks().postToolUse).toHaveLength(4);
    });
  });

  describe('removeAll', () => {
    it('removes both built-in and team hooks and clears the manifest', async () => {
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { manifestPath: MANIFEST });
      await reconcileHooks(SETTINGS, 'claude', [teamDef()], { removeAll: true, manifestPath: MANIFEST });

      for (const entries of Object.values(claudeHooks())) {
        expect(entries).toHaveLength(0);
      }
      expect(manifest().claude).toBeUndefined();
    });
  });
});
